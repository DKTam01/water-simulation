import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { setupEnvironment } from './environment.js';
import { ParticleFluid } from './particles.js';
import { FluidRenderer } from './render/fluidPasses.js';
import GUI from 'lil-gui';

// ---------------------------------------------------------------------------
// 1. Scene / Camera / Renderer
// ---------------------------------------------------------------------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a0a);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(25, 20, 25);

const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
const clock    = new THREE.Clock();

// ---------------------------------------------------------------------------
// 2. Lights
// ---------------------------------------------------------------------------
scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
dirLight.position.set(5, 15, 7);
scene.add(dirLight);

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
// 4. Environment (floor, grid, lights)
// ---------------------------------------------------------------------------
setupEnvironment(scene);

// ---------------------------------------------------------------------------
// 5. Fluid simulation
// ---------------------------------------------------------------------------
const fluid = new ParticleFluid(renderer, scene, {});

// ---------------------------------------------------------------------------
// 6. Tank wireframe (synced to boxSize slider every frame)
// ---------------------------------------------------------------------------
const tankMesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color: 0x444444, wireframe: true })
);
scene.add(tankMesh);

// ---------------------------------------------------------------------------
// 7. Procedural environment cubemap for water reflections
// ---------------------------------------------------------------------------
let envCubeTexture = null;
{
    const envScene = new THREE.Scene();
    // Top hemisphere — sky blue
    const skyGeo = new THREE.SphereGeometry(50, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2);
    const skyMat = new THREE.MeshBasicMaterial({ color: 0x5588cc, side: THREE.BackSide });
    envScene.add(new THREE.Mesh(skyGeo, skyMat));
    // Bottom hemisphere — dark ground
    const gndGeo = new THREE.SphereGeometry(50, 32, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
    const gndMat = new THREE.MeshBasicMaterial({ color: 0x222222, side: THREE.BackSide });
    envScene.add(new THREE.Mesh(gndGeo, gndMat));
    // Horizon band — brighter, wider for a nice gradient transition
    const bandGeo = new THREE.CylinderGeometry(49.5, 49.5, 10, 64, 1, true);
    const bandMat = new THREE.MeshBasicMaterial({ color: 0x99bbdd, side: THREE.BackSide });
    envScene.add(new THREE.Mesh(bandGeo, bandMat));

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
// 9. GUI
// ---------------------------------------------------------------------------
const gui = new GUI();

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

sphFolder.add(uniforms.u_boxSize,               'value',  5.0, 20.0).name('Tank Size');
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

renderFolder.add(rp, 'debugMode', { 'Final': 0.0, 'Depth': 1.0, 'Thickness': 2.0, 'Normals': 3.0 })
    .name('Debug View')
    .onChange(v => fluidRenderer.setDebugMode(parseFloat(v)));

// -- Presets -----------------------------------------------------------------
const presets = {
    'Choppy Waves'() {
        fluidRenderer.setParticleRadius(0.45);
        fluidRenderer.setBlurRadius(1.2);
        fluidRenderer.setBlurFalloff(6.0);
        fluidRenderer.setBlurIterations(1);
        fluidRenderer.setNormalScale(8.0);
        fluidRenderer.setIOR(1.33);
        fluidRenderer.setRefractionStrength(6.0);
        fluidRenderer.setDetailNormalBlend(0.35);
        fluidRenderer.setEnvMapIntensity(1.2);
        uniforms.u_agitation.value = 1.5;
        uniforms.u_viscosityMultiplier.value = 0.15;
        renderFolder.controllersRecursive().forEach(c => c.updateDisplay());
        sphFolder.controllersRecursive().forEach(c => c.updateDisplay());
    },
    Balanced() {
        fluidRenderer.setParticleRadius(0.55);
        fluidRenderer.setBlurRadius(2.5);
        fluidRenderer.setBlurFalloff(12.0);
        fluidRenderer.setBlurIterations(2);
        fluidRenderer.setNormalScale(6.0);
        fluidRenderer.setIOR(1.33);
        fluidRenderer.setRefractionStrength(8.0);
        fluidRenderer.setDetailNormalBlend(0.15);
        fluidRenderer.setEnvMapIntensity(1.0);
        uniforms.u_agitation.value = 0.8;
        uniforms.u_viscosityMultiplier.value = 0.3;
        renderFolder.controllersRecursive().forEach(c => c.updateDisplay());
        sphFolder.controllersRecursive().forEach(c => c.updateDisplay());
    },
    'Calm Pool'() {
        fluidRenderer.setParticleRadius(0.70);
        fluidRenderer.setBlurRadius(4.5);
        fluidRenderer.setBlurFalloff(18.0);
        fluidRenderer.setBlurIterations(3);
        fluidRenderer.setNormalScale(4.0);
        fluidRenderer.setIOR(1.33);
        fluidRenderer.setRefractionStrength(10.0);
        fluidRenderer.setDetailNormalBlend(0.05);
        fluidRenderer.setEnvMapIntensity(1.0);
        uniforms.u_agitation.value = 0.2;
        uniforms.u_viscosityMultiplier.value = 0.5;
        renderFolder.controllersRecursive().forEach(c => c.updateDisplay());
        sphFolder.controllersRecursive().forEach(c => c.updateDisplay());
    },
};

const presetsFolder = gui.addFolder('Quality Presets');
presetsFolder.add(presets, 'Choppy Waves').name('Choppy Waves');
presetsFolder.add(presets, 'Balanced').name('Balanced (default)');
presetsFolder.add(presets, 'Calm Pool').name('Calm Pool');
presetsFolder.open();

renderFolder.open();

// ---------------------------------------------------------------------------
// 10. Render loop
// ---------------------------------------------------------------------------
function animate() {
    requestAnimationFrame(animate);
    const delta = Math.min(clock.getDelta(), 0.032);

    // Sync tank wireframe to the boxSize slider.
    const boxSize = fluid.sphUniforms.u_boxSize.value;
    tankMesh.scale.set(boxSize * 2, boxSize * 2, boxSize * 2);
    tankMesh.position.set(0, boxSize, 0);
    tankMesh.rotation.set(0, 0, 0);
    tankMesh.updateMatrixWorld();

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
