import * as THREE from 'three';
import { depthVertex,     depthFragment     } from './shaders/fluidDepth.glsl.js';
import { thicknessVertex, thicknessFragment } from './shaders/fluidThickness.glsl.js';
import { blurVertex,      blurFragment      } from './shaders/fluidBlur.glsl.js';
import { compositeVertex, compositeFragment } from './shaders/fluidComposite.glsl.js';
import { foamVertex,      foamFragment      } from './shaders/fluidFoam.glsl.js';

// ---------------------------------------------------------------------------
// Minimal fullscreen-quad renderer used for all post-processing passes.
// ---------------------------------------------------------------------------
class FullscreenPass {
    constructor(material) {
        this._cam   = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this._scene = new THREE.Scene();
        const mesh  = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
        mesh.frustumCulled = false;
        this._scene.add(mesh);
    }

    render(renderer, target) {
        renderer.setRenderTarget(target !== undefined ? target : null);
        renderer.render(this._scene, this._cam);
    }
}

// ---------------------------------------------------------------------------
// FluidRenderer — multi-pass screen-space fluid rendering pipeline.
//
//   Pass 1:  Opaque scene         → sceneRT         (colour + hw depth)
//   Pass 2:  Fluid depth          → depthRT          (linear depth in R)
//   Pass 3:  Fluid thickness      → thicknessRT      (additive flat constant)
//   Pass 4…: Depth blur H+V       × blurIterations   (bilateral, ping-pong)
//   Pass N…: Thickness blur H+V   × blurIterations   (bilateral, ping-pong)
//   Final:   Composite            → screen
// ---------------------------------------------------------------------------
export class FluidRenderer {
    constructor(renderer, particleFluid) {
        this.renderer = renderer;
        this.fluid    = particleFluid;

        const size = new THREE.Vector2();
        renderer.getDrawingBufferSize(size);
        this.width  = size.x;
        this.height = size.y;

        // Art / quality knobs — exposed to GUI in main.js
        this.params = {
            enabled:            true,
            showParticles:      false,
            particleRadius:     0.55,
            blurRadius:         2.5,
            blurDepthFalloff:   12.0,
            blurIterations:     2,       // how many H+V passes to run
            normalScale:        6.0,
            waterR:             0.02,
            waterG:             0.15,
            waterB:             0.55,
            shallowR:           0.10,
            shallowG:           0.55,
            shallowB:           0.65,
            absorbR:            0.45,
            absorbG:            0.08,
            absorbB:            0.02,
            absorptionStrength: 0.22,
            ior:                1.33,    // index of refraction for water
            refractionStrength: 8.0,    // scale for physical refraction ray
            envMapIntensity:    1.0,    // environment reflection brightness
            specularStrength:   1.6,
            thicknessScale:     0.10,
            detailNormalBlend:  0.15,   // 0 = smooth only, 1 = raw detail only
            foamScale:          1.0,
            foamSpeedMin:       3.0,    // speed below which no foam appears
            foamSpeedMax:       12.0,   // speed above which foam is fully white
            causticsStrength:   0.6,    // fake floor caustics intensity
            fluidScale:         0.5,    // fluid RT resolution multiplier (0.5 = half-res)
            debugMode:          0.0,
        };

        this._initRTs();
        this._initBillboards();
        this._initDepthPass();
        this._initThicknessPass();
        this._initFoamPass();
        this._initBlurPass();
        this._initCompositePass();
    }

    // -----------------------------------------------------------------------
    // Render targets
    // -----------------------------------------------------------------------
    _initRTs() {
        const w = this.width, h = this.height;
        const s = this.params.fluidScale;
        const fw = Math.max(1, Math.round(w * s));
        const fh = Math.max(1, Math.round(h * s));
        this.fluidWidth  = fw;
        this.fluidHeight = fh;

        this.sceneRT = new THREE.WebGLRenderTarget(w, h, {
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            format:    THREE.RGBAFormat,
            type:      THREE.UnsignedByteType,
        });
        this.sceneRT.depthTexture      = new THREE.DepthTexture(w, h);
        this.sceneRT.depthTexture.type = THREE.UnsignedIntType;

        const mkFloat = (depthBuf, useLinear) => new THREE.WebGLRenderTarget(fw, fh, {
            minFilter: useLinear ? THREE.LinearFilter : THREE.NearestFilter,
            magFilter: useLinear ? THREE.LinearFilter : THREE.NearestFilter,
            format:    THREE.RGBAFormat,
            type:      THREE.FloatType,
            depthBuffer: depthBuf,
        });

        this.depthRT      = mkFloat(true,  false);  // hw depth for correct sorting
        this.thicknessRT  = mkFloat(false, false);   // additive, no depth test
        this.blurHRT      = mkFloat(false, true);    // bilinear for upsample
        this.blurVRT      = mkFloat(false, true);
        this.thickBlurHRT = mkFloat(false, true);
        this.thickBlurVRT = mkFloat(false, true);
        this.foamRT       = mkFloat(false, true);
    }

    // -----------------------------------------------------------------------
    // Billboard geometry shared by depth and thickness passes.
    // -----------------------------------------------------------------------
    _initBillboards() {
        const { particleCount, WIDTH } = this.fluid;

        const geom = new THREE.PlaneGeometry(2, 2);

        const uvs = new Float32Array(particleCount * 2);
        for (let i = 0; i < particleCount; i++) {
            uvs[i * 2 + 0] = ((i % WIDTH) + 0.5) / WIDTH;
            uvs[i * 2 + 1] = (Math.floor(i / WIDTH) + 0.5) / WIDTH;
        }
        geom.setAttribute('particleUV', new THREE.InstancedBufferAttribute(uvs, 2));
        this._billboardGeom = geom;
        this._identity = new THREE.Matrix4();
    }

    _setIdentityMatrices(mesh) {
        for (let i = 0; i < this.fluid.particleCount; i++) {
            mesh.setMatrixAt(i, this._identity);
        }
        mesh.instanceMatrix.needsUpdate = true;
    }

    // -----------------------------------------------------------------------
    // Pass 2: fluid depth
    // -----------------------------------------------------------------------
    _initDepthPass() {
        const p = this.params;

        this._depthMat = new THREE.ShaderMaterial({
            vertexShader:   depthVertex,
            fragmentShader: depthFragment,
            uniforms: {
                texturePosition:  { value: null },
                u_particleRadius: { value: p.particleRadius },
                u_near:           { value: 0.1 },
                u_far:            { value: 1000.0 },
                u_sceneDepth:     { value: null },
                u_resolution:     { value: new THREE.Vector2(this.fluidWidth, this.fluidHeight) },
            },
            side:       THREE.DoubleSide,
            depthTest:  true,
            depthWrite: true,
        });

        this._depthMesh = new THREE.InstancedMesh(
            this._billboardGeom, this._depthMat, this.fluid.particleCount
        );
        this._depthMesh.frustumCulled = false;
        this._setIdentityMatrices(this._depthMesh);

        this._depthScene = new THREE.Scene();
        this._depthScene.add(this._depthMesh);
    }

    // -----------------------------------------------------------------------
    // Pass 3: fluid thickness (additive, flat constant per particle)
    // -----------------------------------------------------------------------
    _initThicknessPass() {
        const p = this.params;

        this._thickMat = new THREE.ShaderMaterial({
            vertexShader:   thicknessVertex,
            fragmentShader: thicknessFragment,
            uniforms: {
                texturePosition:  { value: null },
                u_particleRadius: { value: p.particleRadius },
                u_thicknessScale: { value: p.thicknessScale },
            },
            blending:    THREE.AdditiveBlending,
            transparent: true,
            depthTest:   false,
            depthWrite:  false,
        });

        this._thickMesh = new THREE.InstancedMesh(
            this._billboardGeom, this._thickMat, this.fluid.particleCount
        );
        this._thickMesh.frustumCulled = false;
        this._setIdentityMatrices(this._thickMesh);

        this._thickScene = new THREE.Scene();
        this._thickScene.add(this._thickMesh);
    }

    // -----------------------------------------------------------------------
    // Foam pass: velocity-based foam intensity (additive)
    // -----------------------------------------------------------------------
    _initFoamPass() {
        const p = this.params;

        this._foamMat = new THREE.ShaderMaterial({
            vertexShader:   foamVertex,
            fragmentShader: foamFragment,
            uniforms: {
                texturePosition:  { value: null },
                textureVelocity:  { value: null },
                u_particleRadius: { value: p.particleRadius },
                u_foamSpeedMin:   { value: p.foamSpeedMin },
                u_foamSpeedMax:   { value: p.foamSpeedMax },
                u_foamScale:      { value: p.foamScale },
            },
            blending:    THREE.AdditiveBlending,
            transparent: true,
            depthTest:   false,
            depthWrite:  false,
        });

        this._foamMesh = new THREE.InstancedMesh(
            this._billboardGeom, this._foamMat, this.fluid.particleCount
        );
        this._foamMesh.frustumCulled = false;
        this._setIdentityMatrices(this._foamMesh);

        this._foamScene = new THREE.Scene();
        this._foamScene.add(this._foamMesh);
    }

    // -----------------------------------------------------------------------
    // Blur pass — single ShaderMaterial, reused for both depth and thickness
    // blur by swapping the u_depthTexture uniform.
    // -----------------------------------------------------------------------
    _initBlurPass() {
        const p = this.params;

        this._blurMat = new THREE.ShaderMaterial({
            vertexShader:   blurVertex,
            fragmentShader: blurFragment,
            uniforms: {
                u_depthTexture:    { value: null },
                u_direction:       { value: new THREE.Vector2(1, 0) },
                u_resolution:      { value: new THREE.Vector2(this.fluidWidth, this.fluidHeight) },
                u_blurRadius:      { value: p.blurRadius },
                u_blurDepthFalloff:{ value: p.blurDepthFalloff },
            },
        });
        this._blurPass = new FullscreenPass(this._blurMat);
    }

    // -----------------------------------------------------------------------
    // Final composite pass
    // -----------------------------------------------------------------------
    _initCompositePass() {
        const p = this.params;

        this._compMat = new THREE.ShaderMaterial({
            vertexShader:   compositeVertex,
            fragmentShader: compositeFragment,
            uniforms: {
                u_sceneColor:         { value: null },
                u_fluidDepth:         { value: null },
                u_fluidDepthRaw:      { value: null },
                u_fluidThickness:     { value: null },
                u_detailNormalBlend:  { value: p.detailNormalBlend },
                u_resolution:         { value: new THREE.Vector2(this.width, this.height) },
                u_near:               { value: 0.1 },
                u_far:                { value: 1000.0 },
                u_inverseProjection:  { value: new THREE.Matrix4() },
                u_inverseView:        { value: new THREE.Matrix4() },
                u_cameraProjection:   { value: new THREE.Matrix4() },
                u_waterColor:         { value: new THREE.Vector3(p.waterR, p.waterG, p.waterB) },
                u_shallowColor:       { value: new THREE.Vector3(p.shallowR, p.shallowG, p.shallowB) },
                u_absorptionColor:    { value: new THREE.Vector3(p.absorbR, p.absorbG, p.absorbB) },
                u_absorptionStrength: { value: p.absorptionStrength },
                u_ior:                { value: p.ior },
                u_refractionStrength: { value: p.refractionStrength },
                u_specularStrength:   { value: p.specularStrength },
                u_normalScale:        { value: p.normalScale },
                u_lightDirView:       { value: new THREE.Vector3(0, 1, 0) },
                u_boundsCenter:       { value: new THREE.Vector3(0, 0, 0) },
                u_boundsHalfSize:     { value: new THREE.Vector3(5, 5, 5) },
                u_envMap:             { value: null },
                u_envMapIntensity:    { value: p.envMapIntensity },
                u_foamTexture:        { value: null },
                u_causticsStrength:   { value: p.causticsStrength },
                u_debugMode:          { value: 0.0 },
            },
        });
        this._compPass = new FullscreenPass(this._compMat);
    }

    // -----------------------------------------------------------------------
    // Per-frame camera + bounds uniforms
    // -----------------------------------------------------------------------
    _updateCamera(camera, tankMesh) {
        const near = camera.near, far = camera.far;

        this._depthMat.uniforms.u_near.value = near;
        this._depthMat.uniforms.u_far.value  = far;
        this._compMat.uniforms.u_near.value  = near;
        this._compMat.uniforms.u_far.value   = far;

        this._compMat.uniforms.u_inverseProjection.value.copy(camera.projectionMatrixInverse);
        this._compMat.uniforms.u_inverseView.value.copy(camera.matrixWorld);
        this._compMat.uniforms.u_cameraProjection.value.copy(camera.projectionMatrix);

        // World-space light → view space for Blinn-Phong.
        const worldLight = new THREE.Vector3(0.35, 0.80, 0.50).normalize();
        const mat3view   = new THREE.Matrix3().setFromMatrix4(camera.matrixWorldInverse);
        const viewLight  = worldLight.clone().applyMatrix3(mat3view).normalize();
        this._compMat.uniforms.u_lightDirView.value.copy(viewLight);

        // Tank bounding box — tank is a unit cube scaled and offset in main.js.
        if (tankMesh) {
            this._compMat.uniforms.u_boundsCenter.value.copy(tankMesh.position);
            this._compMat.uniforms.u_boundsHalfSize.value.set(
                tankMesh.scale.x * 0.5,
                tankMesh.scale.y * 0.5,
                tankMesh.scale.z * 0.5,
            );
        }
    }

    // -----------------------------------------------------------------------
    // Helpers: run H then V blur N times on a source texture,
    // ping-ponging between rtH and rtV.  Returns the texture of the last V pass.
    // -----------------------------------------------------------------------
    _runBlurPasses(srcTexture, rtH, rtV, iterations) {
        let current = srcTexture;
        for (let i = 0; i < iterations; i++) {
            this._blurMat.uniforms.u_depthTexture.value = current;
            this._blurMat.uniforms.u_direction.value.set(1, 0);
            this._blurPass.render(this.renderer, rtH);

            this._blurMat.uniforms.u_depthTexture.value = rtH.texture;
            this._blurMat.uniforms.u_direction.value.set(0, 1);
            this._blurPass.render(this.renderer, rtV);

            current = rtV.texture;
        }
        return current;
    }

    // -----------------------------------------------------------------------
    // Main render entry point — called once per frame from main.js.
    // tankMesh is forwarded so we can extract the bounding box in world space.
    // -----------------------------------------------------------------------
    render(mainScene, camera, tankMesh) {
        const renderer   = this.renderer;
        const posTexture = this.fluid.commonUniforms.texturePosition.value;

        if (!this.params.enabled || !posTexture) {
            this.fluid.mesh.visible = this.params.showParticles || !this.params.enabled;
            renderer.setRenderTarget(null);
            renderer.render(mainScene, camera);
            return;
        }

        this._updateCamera(camera, tankMesh);

        const velTexture = this.fluid.commonUniforms.textureVelocity.value;

        this._depthMat.uniforms.texturePosition.value = posTexture;
        this._thickMat.uniforms.texturePosition.value = posTexture;
        this._foamMat.uniforms.texturePosition.value  = posTexture;
        this._foamMat.uniforms.textureVelocity.value  = velTexture;

        const savedColor = new THREE.Color();
        renderer.getClearColor(savedColor);
        const savedAlpha = renderer.getClearAlpha();

        // Pass 1: opaque scene
        const wasVisible       = this.fluid.mesh.visible;
        this.fluid.mesh.visible = this.params.showParticles;
        renderer.setRenderTarget(this.sceneRT);
        renderer.clear();
        renderer.render(mainScene, camera);
        this.fluid.mesh.visible = wasVisible;

        // Pass 2: fluid depth
        this._depthMat.uniforms.u_sceneDepth.value = this.sceneRT.depthTexture;
        renderer.setRenderTarget(this.depthRT);
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
        renderer.render(this._depthScene, camera);

        // Pass 3: fluid thickness (additive)
        renderer.setRenderTarget(this.thicknessRT);
        renderer.clear();
        renderer.render(this._thickScene, camera);

        // Pass 3b: foam intensity (additive)
        renderer.setRenderTarget(this.foamRT);
        renderer.clear();
        renderer.render(this._foamScene, camera);

        // Passes 4+: bilateral blur on depth (N iterations)
        const iters     = Math.max(1, Math.round(this.params.blurIterations));
        const blurredDepth    = this._runBlurPasses(this.depthRT.texture,    this.blurHRT,      this.blurVRT,      iters);
        const blurredThickness = this._runBlurPasses(this.thicknessRT.texture, this.thickBlurHRT, this.thickBlurVRT, iters);

        // Final composite
        this._compMat.uniforms.u_sceneColor.value     = this.sceneRT.texture;
        this._compMat.uniforms.u_fluidDepth.value     = blurredDepth;
        this._compMat.uniforms.u_fluidDepthRaw.value  = this.depthRT.texture;
        this._compMat.uniforms.u_fluidThickness.value = blurredThickness;
        this._compMat.uniforms.u_foamTexture.value    = this.foamRT.texture;
        this._compPass.render(renderer, null);

        renderer.setClearColor(savedColor, savedAlpha);
    }

    // -----------------------------------------------------------------------
    // Resize
    // -----------------------------------------------------------------------
    onResize(width, height) {
        this.width  = width;
        this.height = height;
        const s  = this.params.fluidScale;
        const fw = Math.max(1, Math.round(width  * s));
        const fh = Math.max(1, Math.round(height * s));
        this.fluidWidth  = fw;
        this.fluidHeight = fh;

        this.sceneRT.setSize(width, height);
        [
            this.depthRT, this.thicknessRT,
            this.blurHRT, this.blurVRT, this.thickBlurHRT, this.thickBlurVRT,
            this.foamRT,
        ].forEach(rt => rt.setSize(fw, fh));

        const fluidRes = new THREE.Vector2(fw, fh);
        this._depthMat.uniforms.u_resolution.value.copy(fluidRes);
        this._blurMat.uniforms.u_resolution.value.copy(fluidRes);

        const fullRes = new THREE.Vector2(width, height);
        this._compMat.uniforms.u_resolution.value.copy(fullRes);
    }

    // -----------------------------------------------------------------------
    // Setters called by GUI onChange callbacks
    // -----------------------------------------------------------------------
    setParticleRadius(v) {
        this.params.particleRadius = v;
        this._depthMat.uniforms.u_particleRadius.value = v;
        this._thickMat.uniforms.u_particleRadius.value = v;
        this._foamMat.uniforms.u_particleRadius.value  = v;
    }
    setBlurRadius(v)          { this.params.blurRadius = v;       this._blurMat.uniforms.u_blurRadius.value      = v; }
    setBlurFalloff(v)         { this.params.blurDepthFalloff = v; this._blurMat.uniforms.u_blurDepthFalloff.value = v; }
    setBlurIterations(v)      { this.params.blurIterations = Math.max(1, Math.round(v)); }
    setNormalScale(v)         { this._compMat.uniforms.u_normalScale.value      = v; }
    setAbsorptionStrength(v)  { this._compMat.uniforms.u_absorptionStrength.value = v; }
    setIOR(v)                 { this._compMat.uniforms.u_ior.value               = v; }
    setRefractionStrength(v)  { this._compMat.uniforms.u_refractionStrength.value = v; }
    setSpecularStrength(v)    { this._compMat.uniforms.u_specularStrength.value   = v; }
    setThicknessScale(v)      { this._thickMat.uniforms.u_thicknessScale.value    = v; }
    setDetailNormalBlend(v)   { this._compMat.uniforms.u_detailNormalBlend.value  = v; }
    setEnvMap(cubeTexture)    { this._compMat.uniforms.u_envMap.value              = cubeTexture; }
    setEnvMapIntensity(v)     { this._compMat.uniforms.u_envMapIntensity.value     = v; }
    setDebugMode(v)           { this._compMat.uniforms.u_debugMode.value           = v; }

    setWaterColor(r, g, b) {
        this._compMat.uniforms.u_waterColor.value.set(r, g, b);
    }
    setShallowColor(r, g, b) {
        this._compMat.uniforms.u_shallowColor.value.set(r, g, b);
    }
    setAbsorptionColor(r, g, b) {
        this._compMat.uniforms.u_absorptionColor.value.set(r, g, b);
    }

    setFluidScale(v) {
        this.params.fluidScale = v;
        this.onResize(this.width, this.height);
    }
    setFoamScale(v)    { this.params.foamScale    = v; this._foamMat.uniforms.u_foamScale.value    = v; }
    setFoamSpeedMin(v) { this.params.foamSpeedMin = v; this._foamMat.uniforms.u_foamSpeedMin.value = v; }
    setFoamSpeedMax(v) { this.params.foamSpeedMax = v; this._foamMat.uniforms.u_foamSpeedMax.value = v; }
    setCausticsStrength(v) { this.params.causticsStrength = v; this._compMat.uniforms.u_causticsStrength.value = v; }

    dispose() {
        [
            this.sceneRT, this.depthRT, this.thicknessRT,
            this.blurHRT, this.blurVRT, this.thickBlurHRT, this.thickBlurVRT,
            this.foamRT,
        ].forEach(rt => rt.dispose());
        this._billboardGeom.dispose();
        [this._depthMat, this._thickMat, this._foamMat, this._blurMat, this._compMat]
            .forEach(m => m.dispose());
    }
}
