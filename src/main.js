import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { ParticleFluid } from './particles.js';
import { FluidRenderer } from './render/fluidPasses.js';
import { createSceneManager } from './scenes/sceneManager.js';
import GUI from 'lil-gui';

// ---------------------------------------------------------------------------
// 1. Scene / Camera / Renderer
// ---------------------------------------------------------------------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87CEEB);
scene.fog = new THREE.Fog(0x9ec5e8, 60, 180);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(25, 20, 25);

const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
const clock    = new THREE.Clock();

// ---------------------------------------------------------------------------
// 2. Lights + procedural sky dome
// ---------------------------------------------------------------------------
const hemiLight = new THREE.HemisphereLight(0x88bbee, 0x445544, 1.0);
scene.add(hemiLight);

const dirLight = new THREE.DirectionalLight(0xfff4e0, 1.6);
dirLight.position.set(8, 20, 10);
scene.add(dirLight);

// Sky dome — a large inverted sphere with a vertical gradient + sun disc.
// Built from a custom ShaderMaterial so it's cheap and always behind everything.
const skyDomeMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
        u_sunDir: { value: new THREE.Vector3(8, 20, 10).normalize() },
    },
    vertexShader: /* glsl */`
        varying vec3 vWorldPos;
        void main() {
            vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: /* glsl */`
        uniform vec3 u_sunDir;
        varying vec3 vWorldPos;
        void main() {
            vec3 dir = normalize(vWorldPos);
            float y = dir.y;

            // Sky gradient: ground -> horizon -> zenith
            vec3 ground  = vec3(0.42, 0.48, 0.36);
            vec3 horizon = vec3(0.72, 0.82, 0.92);
            vec3 zenith  = vec3(0.32, 0.56, 0.88);
            float tSky = smoothstep(-0.02, 0.45, y);
            float tGnd = smoothstep(0.0, -0.08, y);
            vec3 sky = mix(horizon, zenith, pow(tSky, 0.5));
            sky = mix(sky, ground, tGnd);

            // Sun disc + glow
            float sunDot = max(dot(dir, u_sunDir), 0.0);
            vec3 sunCol = vec3(1.0, 0.95, 0.82);
            sky += sunCol * pow(sunDot, 256.0) * 2.0;  // sharp disc
            sky += sunCol * pow(sunDot, 8.0)   * 0.25; // soft glow

            gl_FragColor = vec4(sky, 1.0);
        }
    `,
});
const skyDome = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), skyDomeMat);
skyDome.renderOrder = -1;
scene.add(skyDome);

// ---------------------------------------------------------------------------
// 3. Interaction ball
// ---------------------------------------------------------------------------
const ballMesh = new THREE.Mesh(
    new THREE.SphereGeometry(1.5, 32, 32),
    new THREE.MeshStandardMaterial({ color: 0xff3333, roughness: 0.4 })
);
ballMesh.position.set(0, 10, 0);
scene.add(ballMesh);

// ---------------------------------------------------------------------------
// 5. Fluid simulation
// ---------------------------------------------------------------------------
const particleSettings = { particleResolution: 128 };
// Restore saved particle resolution from localStorage (set by the GUI dropdown)
const savedRes = localStorage.getItem('particleResolution');
if (savedRes) particleSettings.particleResolution = parseInt(savedRes, 10);
const fluid = new ParticleFluid(renderer, scene, particleSettings);

// ---------------------------------------------------------------------------
// 6. Tank wireframe (synced to boxSize slider every frame)
// ---------------------------------------------------------------------------
const tankMesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color: 0x444444, wireframe: true })
);
scene.add(tankMesh);

// ---------------------------------------------------------------------------
// 6b. Transform gizmos (tank + ball)
// ---------------------------------------------------------------------------
const tankControls = new TransformControls(camera, renderer.domElement);
tankControls.attach(tankMesh);
tankControls.setMode('scale'); // default: resize tank
scene.add(tankControls);

const ballControls = new TransformControls(camera, renderer.domElement);
ballControls.attach(ballMesh);
ballControls.setMode('translate'); // default: drag ball
scene.add(ballControls);

// Keep orbit controls from fighting with transform gizmos.
const onDraggingChanged = (e) => { controls.enabled = !e.value; };
tankControls.addEventListener('dragging-changed', onDraggingChanged);
ballControls.addEventListener('dragging-changed', onDraggingChanged);

// Active gizmo selection + mode hotkeys.
let activeControls = tankControls;
const setActiveControls = (c) => {
    activeControls = c;
    tankControls.visible = c === tankControls;
    ballControls.visible = c === ballControls;
};
setActiveControls(tankControls);

window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === '1') setActiveControls(tankControls);
    if (k === '2') setActiveControls(ballControls);
    if (k === 'r') activeControls.setMode('rotate');
    if (k === 's') activeControls.setMode('scale');
    if (k === 't') activeControls.setMode('translate');
});

// ---------------------------------------------------------------------------
// 7. Environment cubemap for water reflections (rendered from the sky dome)
// ---------------------------------------------------------------------------
let envCubeTexture = null;
{
    const envScene = new THREE.Scene();
    const envSky = new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), skyDomeMat.clone());
    envSky.material.side = THREE.BackSide;
    envScene.add(envSky);

    const cubeRT  = new THREE.WebGLCubeRenderTarget(256);
    const cubeCam = new THREE.CubeCamera(0.1, 100, cubeRT);
    cubeCam.update(renderer, envScene);
    envCubeTexture = cubeRT.texture;
}

// ---------------------------------------------------------------------------
// 8. Screen-space fluid renderer
// ---------------------------------------------------------------------------
const fluidRenderer = new FluidRenderer(renderer, fluid);
if (envCubeTexture) fluidRenderer.setEnvMap(envCubeTexture);

// ---------------------------------------------------------------------------
// 8b. Demo scene manager (Lake / River / Waterfall)
// ---------------------------------------------------------------------------
const sceneManager = createSceneManager({
    scene,
    camera,
    controls,
    fluid,
    tankMesh,
    ballMesh,
    dirLight,
    hemiLight,
});
sceneManager.setScene('Lake');

// ---------------------------------------------------------------------------
// 9. GUI
// ---------------------------------------------------------------------------
const gui = new GUI();

const sceneFolder = gui.addFolder('Scene');
const sceneState = { scene: sceneManager.activeName || 'Lake' };
sceneFolder.add(sceneState, 'scene', sceneManager.names).name('Preset')
    .onChange((name) => sceneManager.setScene(name));
sceneFolder.open();

// -- Interaction ball --------------------------------------------------------
const ballFolder = gui.addFolder('Interaction Ball');
ballFolder.add(ballMesh.position, 'x', -10, 10).name('Move X');
ballFolder.add(ballMesh.position, 'y',   0, 18).name('Move Y');
ballFolder.add(ballMesh.position, 'z', -10, 10).name('Move Z');

// -- SPH Physics -------------------------------------------------------------
const sphFolder = gui.addFolder('SPH Physics');
const uniforms  = fluid.sphUniforms;

// Smoothing radius needs to rebuild the spatial hash grid when changed.
sphFolder.add(uniforms.u_smoothingRadius, 'value', 0.3, 2.0).name('Smoothing Radius')
    .onChange(v => fluid.rebuildSpatialHash(v));

// Tank Size slider now synchronizes the tank mesh ON CHANGE (not every frame),
// so that TransformControls can override the tank transform interactively.
const tankSizeCtrl = sphFolder.add(uniforms.u_boxSize, 'value', 5.0, 20.0).name('Tank Size')
    .onChange((v) => {
        tankMesh.scale.set(v * 2, v * 2, v * 2);
        tankMesh.position.set(0, v, 0);
        tankMesh.updateMatrixWorld();
    });

sphFolder.add(uniforms.u_targetDensity,          'value', 10.0, 300.0).name('Target Density');
sphFolder.add(uniforms.u_pressureMultiplier,     'value',  1.0, 200.0).name('Pressure');
sphFolder.add(uniforms.u_nearPressureMultiplier, 'value',  1.0,  50.0).name('Near Pressure');
sphFolder.add(uniforms.u_viscosityMultiplier,    'value',  0.0,   1.0).name('Viscosity');
sphFolder.add(uniforms.u_gravity,                'value', -40.0,  0.0).name('Gravity');
sphFolder.add(uniforms.u_collisionDamping,       'value',  0.0,   1.0).name('Wall Damping');
sphFolder.add(uniforms.u_agitation,              'value',  0.0,   5.0).name('Agitation');

// -- Fluid Rendering ---------------------------------------------------------
const rp = fluidRenderer.params;
const renderFolder = gui.addFolder('Fluid Rendering');

renderFolder.add(rp, 'enabled').name('Screen-Space Fluid');
renderFolder.add(rp, 'showParticles').name('Show Particles (debug)');

renderFolder.add(rp, 'particleRadius', 0.2, 1.5, 0.01).name('Blob Radius')
    .onChange(v => fluidRenderer.setParticleRadius(v));

renderFolder.add(rp, 'blurRadius', 0.5, 8.0, 0.1).name('Blur Radius')
    .onChange(v => fluidRenderer.setBlurRadius(v));

renderFolder.add(rp, 'blurDepthFalloff', 1.0, 50.0, 0.5).name('Blur Edge Sharpness')
    .onChange(v => fluidRenderer.setBlurFalloff(v));

renderFolder.add(rp, 'blurIterations', 1, 4, 1).name('Blur Iterations')
    .onChange(v => fluidRenderer.setBlurIterations(v));

renderFolder.add(rp, 'normalScale', 0.5, 30.0, 0.5).name('Normal Scale')
    .onChange(v => fluidRenderer.setNormalScale(v));

renderFolder.add(rp, 'absorptionStrength', 0.0, 2.0, 0.01).name('Absorption')
    .onChange(v => fluidRenderer.setAbsorptionStrength(v));

renderFolder.add(rp, 'ior', 1.0, 2.5, 0.01).name('IOR (refraction index)')
    .onChange(v => fluidRenderer.setIOR(v));

renderFolder.add(rp, 'refractionStrength', 0.0, 30.0, 0.5).name('Refraction Scale')
    .onChange(v => fluidRenderer.setRefractionStrength(v));

renderFolder.add(rp, 'specularStrength', 0.0, 5.0, 0.1).name('Specular')
    .onChange(v => fluidRenderer.setSpecularStrength(v));

renderFolder.add(rp, 'thicknessScale', 0.01, 0.5, 0.01).name('Thickness Scale')
    .onChange(v => fluidRenderer.setThicknessScale(v));

renderFolder.add(rp, 'detailNormalBlend', 0.0, 1.0, 0.01).name('Detail Normals')
    .onChange(v => fluidRenderer.setDetailNormalBlend(v));

renderFolder.add(rp, 'envMapIntensity', 0.0, 3.0, 0.05).name('Env Reflection')
    .onChange(v => fluidRenderer.setEnvMapIntensity(v));

renderFolder.add(rp, 'tintMix', 0.0, 1.0, 0.01).name('Water Tint Mix')
    .onChange(v => fluidRenderer.setTintMix(v));
renderFolder.add(rp, 'scatterStrength', 0.0, 1.2, 0.02).name('Volume Brightness')
    .onChange(v => fluidRenderer.setScatterStrength(v));
renderFolder.add(rp, 'surfaceExposure', 0.8, 1.5, 0.01).name('Surface Exposure')
    .onChange(v => fluidRenderer.setSurfaceExposure(v));

renderFolder.add(rp, 'causticsStrength', 0.0, 2.0, 0.05).name('Floor Caustics')
    .onChange(v => fluidRenderer.setCausticsStrength(v));

renderFolder.add(rp, 'foamScale', 0.0, 3.0, 0.05).name('Foam Intensity')
    .onChange(v => fluidRenderer.setFoamScale(v));
renderFolder.add(rp, 'foamSpeedMin', 0.0, 10.0, 0.5).name('Foam Speed Min')
    .onChange(v => fluidRenderer.setFoamSpeedMin(v));
renderFolder.add(rp, 'foamSpeedMax', 1.0, 30.0, 0.5).name('Foam Speed Max')
    .onChange(v => fluidRenderer.setFoamSpeedMax(v));

renderFolder.add(rp, 'densityRadiusStrength', 0.0, 1.0, 0.01).name('Adaptive Splats')
    .onChange(v => fluidRenderer.setDensityRadiusStrength(v));

renderFolder.add(rp, 'fluidScale', 0.25, 1.0, 0.05).name('Fluid Resolution')
    .onChange(v => fluidRenderer.setFluidScale(v));

renderFolder.add(rp, 'debugMode', { 'Final': 0.0, 'Depth': 1.0, 'Thickness': 2.0, 'Normals': 3.0, 'Foam': 4.0 })
    .name('Debug View')
    .onChange(v => fluidRenderer.setDebugMode(parseFloat(v)));

// -- Presets -----------------------------------------------------------------
const presets = {
    'Choppy Waves'() {
        fluidRenderer.setParticleRadius(0.52);
        fluidRenderer.setBlurRadius(1.4);
        fluidRenderer.setBlurFalloff(6.0);
        fluidRenderer.setBlurIterations(2);
        fluidRenderer.setNormalScale(8.0);
        fluidRenderer.setIOR(1.33);
        fluidRenderer.setRefractionStrength(6.0);
        fluidRenderer.setDetailNormalBlend(0.35);
        fluidRenderer.setEnvMapIntensity(1.5);
        fluidRenderer.setTintMix(0.64);
        fluidRenderer.setScatterStrength(0.58);
        fluidRenderer.setSurfaceExposure(1.18);
        fluidRenderer.setFoamScale(1.2);
        fluidRenderer.setFoamSpeedMin(2.5);
        fluidRenderer.setFoamSpeedMax(10.0);
        fluidRenderer.setFluidScale(0.5);
        fluidRenderer.setDensityRadiusStrength(1.0);
        uniforms.u_agitation.value = 1.65;
        uniforms.u_viscosityMultiplier.value = 0.12;
        renderFolder.controllersRecursive().forEach(c => c.updateDisplay());
        sphFolder.controllersRecursive().forEach(c => c.updateDisplay());
    },
    Balanced() {
        fluidRenderer.setParticleRadius(0.62);
        fluidRenderer.setBlurRadius(2.5);
        fluidRenderer.setBlurFalloff(12.0);
        fluidRenderer.setBlurIterations(3);
        fluidRenderer.setNormalScale(6.0);
        fluidRenderer.setIOR(1.33);
        fluidRenderer.setRefractionStrength(8.0);
        fluidRenderer.setDetailNormalBlend(0.15);
        fluidRenderer.setEnvMapIntensity(1.35);
        fluidRenderer.setTintMix(0.58);
        fluidRenderer.setScatterStrength(0.48);
        fluidRenderer.setSurfaceExposure(1.14);
        fluidRenderer.setFoamScale(1.0);
        fluidRenderer.setFoamSpeedMin(3.0);
        fluidRenderer.setFoamSpeedMax(12.0);
        fluidRenderer.setFluidScale(0.5);
        fluidRenderer.setDensityRadiusStrength(1.0);
        uniforms.u_agitation.value = 1.15;
        uniforms.u_viscosityMultiplier.value = 0.22;
        renderFolder.controllersRecursive().forEach(c => c.updateDisplay());
        sphFolder.controllersRecursive().forEach(c => c.updateDisplay());
    },
    'Calm Pool'() {
        fluidRenderer.setParticleRadius(0.75);
        fluidRenderer.setBlurRadius(4.5);
        fluidRenderer.setBlurFalloff(18.0);
        fluidRenderer.setBlurIterations(3);
        fluidRenderer.setNormalScale(4.0);
        fluidRenderer.setIOR(1.33);
        fluidRenderer.setRefractionStrength(10.0);
        fluidRenderer.setDetailNormalBlend(0.05);
        fluidRenderer.setEnvMapIntensity(1.1);
        fluidRenderer.setTintMix(0.42);
        fluidRenderer.setScatterStrength(0.28);
        fluidRenderer.setSurfaceExposure(1.06);
        fluidRenderer.setFoamScale(0.4);
        fluidRenderer.setFoamSpeedMin(5.0);
        fluidRenderer.setFoamSpeedMax(15.0);
        fluidRenderer.setFluidScale(0.75);
        fluidRenderer.setDensityRadiusStrength(1.0);
        uniforms.u_agitation.value = 0.25;
        uniforms.u_viscosityMultiplier.value = 0.48;
        renderFolder.controllersRecursive().forEach(c => c.updateDisplay());
        sphFolder.controllersRecursive().forEach(c => c.updateDisplay());
    },
};

const presetsFolder = gui.addFolder('Quality Presets');
presetsFolder.add(presets, 'Choppy Waves').name('Choppy Waves');
presetsFolder.add(presets, 'Balanced').name('Balanced (default)');
presetsFolder.add(presets, 'Calm Pool').name('Calm Pool');
presetsFolder.open();

// -- Simulation presets / demos -----------------------------------------------
const simPresets = {
    'Reset (default)'()  { fluid.resetParticles('default'); },
    'Dam Break'()        { fluid.resetParticles('dam-break'); },
    'Breaking Wave'()    { fluid.resetParticles('wave'); },
};
const simFolder = gui.addFolder('Simulation Presets');
simFolder.add(simPresets, 'Reset (default)');
simFolder.add(simPresets, 'Dam Break');
simFolder.add(simPresets, 'Breaking Wave');
simFolder.add(particleSettings, 'particleResolution', { '128×128 (16k)': 128, '192×192 (37k)': 192, '256×256 (65k)': 256 })
    .name('Particle Count')
    .onChange(() => {
        if (confirm('Changing particle count requires a page reload. Reload now?')) {
            // Store setting and reload
            localStorage.setItem('particleResolution', particleSettings.particleResolution);
            location.reload();
        }
    });
simFolder.open();

renderFolder.open();

// Initial tank transform from the slider, so collisions match visuals at start.
{
    const v = uniforms.u_boxSize.value;
    tankMesh.scale.set(v * 2, v * 2, v * 2);
    tankMesh.position.set(0, v, 0);
    tankMesh.updateMatrixWorld();
}

// When the tank is resized using the gizmo, keep SPH `u_boxSize` in sync.
tankControls.addEventListener('objectChange', () => {
    // Keep scaling within spatial-hash limits (u_maxBoxSize is half-size in world units).
    const maxScale = uniforms.u_maxBoxSize.value * 2.0;
    const minScale = 2.0;
    tankMesh.scale.x = THREE.MathUtils.clamp(tankMesh.scale.x, minScale, maxScale);
    tankMesh.scale.y = THREE.MathUtils.clamp(tankMesh.scale.y, minScale, maxScale);
    tankMesh.scale.z = THREE.MathUtils.clamp(tankMesh.scale.z, minScale, maxScale);

    const inferredBoxSize = tankMesh.scale.y * 0.5;
    uniforms.u_boxSize.value = inferredBoxSize;
    tankSizeCtrl.updateDisplay();
});

// ---------------------------------------------------------------------------
// 10. Render loop
// ---------------------------------------------------------------------------
function animate() {
    requestAnimationFrame(animate);
    const delta = Math.min(clock.getDelta(), 0.032);

    // Ensure transforms are up to date before simulation step.
    tankMesh.updateMatrixWorld();
    ballMesh.updateMatrixWorld();

    // Step the SPH simulation.
    fluid.update(ballMesh.position, clock.getElapsedTime(), delta, tankMesh);

    // Run the full screen-space fluid rendering pipeline.
    // Pass tankMesh so the renderer can derive the world-space bounding box
    // for edge normal smoothing.
    fluidRenderer.render(scene, camera, tankMesh);

    controls.update();
}

// ---------------------------------------------------------------------------
// 11. Resize handling
// ---------------------------------------------------------------------------
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);

    const size = new THREE.Vector2();
    renderer.getDrawingBufferSize(size);
    fluidRenderer.onResize(size.x, size.y);
});

animate();
