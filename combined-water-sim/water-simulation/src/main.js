import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { setupEnvironment, CLIFF_Z_RATIO, SPAWN_CLIFF_OFFSET, sampleRiverBedY } from './environment.js';
import { setupGUI } from './guicontrols.js';
import { ParticleFluid } from './particles.js';
import { FluidRenderer } from './render/fluidPasses.js';

const container = document.getElementById('canvas-wrapper');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
scene.fog = new THREE.Fog(0x9ec5e8, 90, 320);

const camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 1000);
camera.position.set(0, 58, 115);

const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
});
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
container.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
const clock = new THREE.Clock();

const hemiLight = new THREE.HemisphereLight(0x88bbee, 0x445544, 0.85);
scene.add(hemiLight);

const ambientLight = new THREE.AmbientLight(0xffffff, 0.45);
scene.add(ambientLight);

const dirLight = new THREE.DirectionalLight(0xfff4e0, 1.35);
dirLight.position.set(10, 22, 8);
scene.add(dirLight);

const skyDomeMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
        u_sunDir: { value: new THREE.Vector3(8, 20, 10).normalize() },
    },
    vertexShader: /* glsl */ `
        varying vec3 vWorldPos;
        void main() {
            vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: /* glsl */ `
        uniform vec3 u_sunDir;
        varying vec3 vWorldPos;
        void main() {
            vec3 dir = normalize(vWorldPos);
            float y = dir.y;
            vec3 ground  = vec3(0.42, 0.48, 0.36);
            vec3 horizon = vec3(0.72, 0.82, 0.92);
            vec3 zenith  = vec3(0.32, 0.56, 0.88);
            float tSky = smoothstep(-0.02, 0.45, y);
            float tGnd = smoothstep(0.0, -0.08, y);
            vec3 sky = mix(horizon, zenith, pow(tSky, 0.5));
            sky = mix(sky, ground, tGnd);
            float sunDot = max(dot(dir, u_sunDir), 0.0);
            vec3 sunCol = vec3(1.0, 0.95, 0.82);
            sky += sunCol * pow(sunDot, 256.0) * 2.0;
            sky += sunCol * pow(sunDot, 8.0)   * 0.25;
            gl_FragColor = vec4(sky, 1.0);
        }
    `,
});
const skyDome = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), skyDomeMat);
skyDome.renderOrder = -1;
scene.add(skyDome);

const listener = new THREE.AudioListener();
camera.add(listener);

const bgMusic = new THREE.Audio(listener);
const audioLoader = new THREE.AudioLoader();
audioLoader.load('./sounds/background music/LEASE.mp3', function (buffer) {
    bgMusic.setBuffer(buffer);
    bgMusic.setLoop(true);
    bgMusic.setVolume(0.15);
});

const startBGM = () => {
    if (bgMusic.buffer && !bgMusic.isPlaying) {
        bgMusic.play();
    }
};

let simPaused = false;
let audioMuted = false;

const pauseSim = () => {
    simPaused = true;
    audioMuted = true;
    if (bgMusic.isPlaying) bgMusic.pause();
};

const muteAudio = () => {
    audioMuted = true;
    if (bgMusic.isPlaying) bgMusic.pause();
};

const resumeAudio = () => {
    audioMuted = false;
    if (!simPaused) startBGM();
};

const uiSettings = {
    showWireframe: false,
    timeOfDay: 'Day',
    planeWidth: 200,
    planeLength: 280,
    riverDepth: 3.5,
    riverWidth: 30,
    cliffHeight: 14,     // tall waterfall
    flowSlope: 0.008,    // nearly flat downstream — gentle creek pool

    waterColor: '#0099cc',
    loopRiver: true,
    flowAccel: 1.6,      // enough momentum to wrap through periodic boundary without pooling

    particleResolution: 128,
};

const savedRes = localStorage.getItem('particleResolution');
if (savedRes) uiSettings.particleResolution = parseInt(savedRes, 10);

const environmentTools = setupEnvironment(scene, uiSettings);

const ballMesh = new THREE.Mesh(
    new THREE.SphereGeometry(1.5, 32, 32),
    new THREE.MeshStandardMaterial({ color: 0xff3333, roughness: 0.4 })
);
ballMesh.position.set(0, 12, 0);
scene.add(ballMesh);

// Accent rocks — low-poly rounded boulders scattered through the creek channel.
// Each entry drives both the visible mesh and the SPH collision sphere.
const ROCK_DEFS = [
    { pos: [-5.5,  0,  15], r: 2.2 },
    { pos: [  4,   0,  28], r: 2.8 },
    { pos: [ -2,   0,  42], r: 1.8 },
    { pos: [  7,   0,  10], r: 1.5 },
    { pos: [ -8,   0,  55], r: 3.0 },
    { pos: [  3,   0,  68], r: 2.0 },
];

const rockMat = new THREE.MeshStandardMaterial({
    color: 0x7a7060,
    roughness: 0.92,
    metalness: 0.0,
});

const rockMeshes = ROCK_DEFS.map(({ pos, r }) => {
    const m = new THREE.Mesh(
        new THREE.DodecahedronGeometry(r, 1),
        rockMat
    );
    m.position.set(...pos);
    m.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    scene.add(m);
    return { mesh: m, radius: r };
});

const tankMesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color: 0x444444, wireframe: true })
);
scene.add(tankMesh);

const fluid = new ParticleFluid(renderer, scene, uiSettings);

let envCubeTexture = null;
{
    const envScene = new THREE.Scene();
    const envSky = new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), skyDomeMat.clone());
    envSky.material.side = THREE.BackSide;
    envScene.add(envSky);
    const cubeRT = new THREE.WebGLCubeRenderTarget(256);
    const cubeCam = new THREE.CubeCamera(0.1, 100, cubeRT);
    cubeCam.update(renderer, envScene);
    envCubeTexture = cubeRT.texture;
}

const fluidRenderer = new FluidRenderer(renderer, fluid);
if (envCubeTexture) fluidRenderer.setEnvMap(envCubeTexture);

function applyWaterColorFromUI() {
    const c = new THREE.Color(uiSettings.waterColor);
    fluidRenderer.setWaterColor(c.r, c.g, c.b);
}

function syncPeriodicFromUI() {
    fluid.sphUniforms.u_periodicFlow.value = uiSettings.loopRiver ? 1.0 : 0.0;
    fluid.sphUniforms.u_flowAccel.value = uiSettings.flowAccel;
}

function syncTankAndFluidUniforms() {
    environmentTools.syncFluidTankToRiver(tankMesh, fluid.sphUniforms, fluid);
    syncPeriodicFromUI();
    fluid.sphUniforms.u_riverDepth.value  = uiSettings.riverDepth;
    fluid.sphUniforms.u_riverWidth.value  = uiSettings.riverWidth;
    fluid.sphUniforms.u_cliffHeight.value = uiSettings.cliffHeight;
    fluid.sphUniforms.u_flowSlope.value   = uiSettings.flowSlope;
    const cliffZ = -uiSettings.planeLength * CLIFF_Z_RATIO;
    fluid.sphUniforms.u_riverCliffZ.value = cliffZ;

    // Compute the wrap-destination Z in local OBB space so the position shader
    // can land teleported particles in the calm flat section instead of the cliff top.
    const wrapWorldZ  = Math.min(cliffZ + SPAWN_CLIFF_OFFSET, tankMesh.scale.z * 0.5 - 6.0);
    const tankHalfLen = tankMesh.scale.z * 0.5;
    fluid.sphUniforms.u_wrapDestLocalZ.value = tankHalfLen > 0
        ? (wrapWorldZ - tankMesh.position.z) / tankMesh.scale.z
        : 0.0;
}

syncTankAndFluidUniforms();
applyWaterColorFromUI();
fluid.resetParticles('default');

const origGenerateTerrain = environmentTools.generateTerrain.bind(environmentTools);
environmentTools.generateTerrain = () => {
    origGenerateTerrain();
    syncTankAndFluidUniforms();
    rockMeshes.forEach(({ mesh, radius }) => {
        const { x, z } = mesh.position;
        mesh.position.y = sampleRiverBedY(x, z, uiSettings) + radius * 0.45;
    });
};

const resizeFluid = () => {
    const size = new THREE.Vector2();
    renderer.getDrawingBufferSize(size);
    fluidRenderer.onResize(size.x, size.y);
};

// Exposed for the inline login fallback (runs before this assignment on first paint, then undefined until module loads).
window.__resizeFluid = resizeFluid;

// Always resize fluid RT when the window resizes — registered here so it runs even if setupGUI throws later.
window.addEventListener('resize', resizeFluid);

try {
    setupGUI(uiSettings, {
        ...environmentTools,
        playBGM: startBGM,
        fluid,
        fluidRenderer,
        ballMesh,
        applyWaterColorFromUI,
        resizeFluid,
        pauseSim,
        muteAudio,
        resumeAudio,
    });
} catch (err) {
    console.error('[Whitewater] setupGUI failed:', err);
}

// Adaptive FPS quality: track real wall-clock time over a rolling window
let _fpsFrames = 0, _fpsWindowStart = performance.now();
const FPS_WINDOW_MS = 3000;
const FPS_LOW = 28, FPS_HIGH = 52;

function checkAdaptiveFPS() {
    const now = performance.now();
    const elapsed = now - _fpsWindowStart;
    if (elapsed >= FPS_WINDOW_MS) {
        const avgFps = (_fpsFrames / elapsed) * 1000;
        const scale = fluidRenderer.params.fluidScale;
        if (avgFps < FPS_LOW && scale > 0.25) {
            fluidRenderer.setFluidScale(Math.max(0.25, scale - 0.15));
            resizeFluid();
        } else if (avgFps > FPS_HIGH && scale < 1.0) {
            fluidRenderer.setFluidScale(Math.min(1.0, scale + 0.1));
            resizeFluid();
        }
        _fpsFrames = 0;
        _fpsWindowStart = now;
    }
    _fpsFrames++;
}

// Sink rocks so their bases sit on the riverbed.
rockMeshes.forEach(({ mesh, radius }) => {
    const { x, z } = mesh.position;
    mesh.position.y = sampleRiverBedY(x, z, uiSettings) + radius * 0.45;
});

// Live rock list for SPH (positions update if terrain re-generates).
function buildRockList() {
    return rockMeshes.map(({ mesh, radius }) => ({ position: mesh.position, radius }));
}

function animate() {
    requestAnimationFrame(animate);
    if (simPaused) return;

    const delta = Math.min(clock.getDelta(), 0.032);
    checkAdaptiveFPS();

    tankMesh.updateMatrixWorld();
    ballMesh.updateMatrixWorld();

    fluid.setRocks(buildRockList());
    fluid.update(ballMesh.position, clock.getElapsedTime(), delta, tankMesh);
    fluidRenderer.render(scene, camera, tankMesh);

    controls.update();
}
animate();

const resizeObserver = new ResizeObserver(() => {
    if (container.clientWidth > 0 && container.clientHeight > 0) {
        camera.aspect = container.clientWidth / container.clientHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(container.clientWidth, container.clientHeight);
        resizeFluid();
    }
});
resizeObserver.observe(container);
