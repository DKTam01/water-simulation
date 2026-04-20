import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { setupEnvironment, sampleBaseplateY } from './environment.js';
import { setupGUI } from './guicontrols.js';
import { ParticleFluid } from './particles.js';
import { FluidRenderer } from './render/fluidPasses.js';

const container = document.getElementById('canvas-wrapper');

/** `#canvas-wrapper` lives under a hidden window until login; size is often 0 at module load. */
function getContainerDrawingSize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    return {
        w: Math.max(1, w),
        h: Math.max(1, h),
    };
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);

const _initialSize = getContainerDrawingSize();
const camera = new THREE.PerspectiveCamera(75, _initialSize.w / _initialSize.h, 0.1, 1000);
camera.position.set(0, 72, 155);

const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
});
renderer.setSize(_initialSize.w, _initialSize.h);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2.5));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
const clock = new THREE.Clock();

const hemiLight = new THREE.HemisphereLight(0x88bbee, 0x445544, 0.85);
scene.add(hemiLight);

const ambientLight = new THREE.AmbientLight(0xffffff, 0.45);
scene.add(ambientLight);

const dirLight = new THREE.DirectionalLight(0xfff4e0, 1.45);
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(2048, 2048);
dirLight.shadow.camera.near = 1;
dirLight.shadow.camera.far = 650;
const sh = 240;
dirLight.shadow.camera.left = -sh;
dirLight.shadow.camera.right = sh;
dirLight.shadow.camera.top = sh;
dirLight.shadow.camera.bottom = -sh;
dirLight.shadow.bias = -0.00025;
dirLight.position.set(95, 115, 72);
dirLight.target.position.set(0, 0, 0);
scene.add(dirLight);
scene.add(dirLight.target);

const skyDomeMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
        u_sunDir: { value: dirLight.position.clone().normalize() },
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
    baseplateSize: 80,
    baseplateSeg: 240,
    baseplateYOffset: 0,
    baseplateBumpAmp: 0.15,
    baseplateBumpFreq: 0.055,
    baseplateTiltX: 0,
    baseplateTiltZ: 0.0,

    fluidRegionWidth: 20,
    fluidRegionLength: 85,
    fluidHeadroom: 14,
    fluidContainerLift: 1.25,

    waterColor: '#0099cc',
    loopRiver: true,
    flowAccel: 0.35,

    particleResolution: 64,
};

const savedRes = localStorage.getItem('particleResolution');
if (savedRes) uiSettings.particleResolution = parseInt(savedRes, 10);

const environmentTools = setupEnvironment(scene, uiSettings);

const ballMesh = new THREE.Mesh(
    new THREE.SphereGeometry(1.5, 32, 32),
    new THREE.MeshStandardMaterial({ color: 0xff3333, roughness: 0.4 })
);
ballMesh.position.set(0, 16, 0);
ballMesh.castShadow = true;
ballMesh.receiveShadow = true;
scene.add(ballMesh);

const ballKeys = {};
document.addEventListener('keydown', (e) => { ballKeys[e.code] = true; });
document.addEventListener('keyup', (e) => { ballKeys[e.code] = false; });

const ballTracker = document.createElement('div');
ballTracker.style.position = 'absolute';
ballTracker.style.top = '15px';
ballTracker.style.left = '15px';
ballTracker.style.color = '#fff';
ballTracker.style.background = 'rgba(0, 0, 0, 0.6)';
ballTracker.style.padding = '8px 12px';
ballTracker.style.borderRadius = '6px';
ballTracker.style.fontFamily = 'monospace';
ballTracker.style.fontSize = '14px';
ballTracker.style.pointerEvents = 'none';
ballTracker.style.zIndex = '100';
ballTracker.style.border = '1px solid rgba(255, 255, 255, 0.2)';
ballTracker.innerText = 'Ball XYZ: 0.00, 0.00, 0.00';
document.getElementById('canvas-wrapper').appendChild(ballTracker);

const tankGeo = new THREE.BoxGeometry(1, 1, 1);
const tankMesh = new THREE.Mesh(
    tankGeo,
    new THREE.MeshBasicMaterial({
        color: 0xff2d6b,
        wireframe: true,
        transparent: true,
        opacity: 0.88,
    })
);
const tankOutline = new THREE.LineSegments(
    new THREE.EdgesGeometry(tankGeo),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 })
);
tankMesh.add(tankOutline);
scene.add(tankMesh);

const fluid = new ParticleFluid(renderer, scene, uiSettings);

const staticRockData = [
    { pos: [5.6, 'yy', 5.0], r: 3.0 },
    { pos: [-4.80, 'yy', 14.40], r: 3.0 },
    { pos: [1.5, 'yy', 33.60], r: 3.0 }
];
const rockMat = new THREE.MeshStandardMaterial({ color: 0x4a4f54, roughness: 0.95 });
const rockGeo = new THREE.SphereGeometry(1, 32, 32);
const rockObstacles = staticRockData.map(data => {
    let y = data.pos[1];
    if (y === 'yy') {
        const x = data.pos[0];
        const z = data.pos[2];
        const amp = uiSettings.baseplateBumpAmp;
        const freq = uiSettings.baseplateBumpFreq;
        const ripple = amp * Math.sin(x * freq) * Math.cos(z * freq);
        y = uiSettings.baseplateYOffset + ripple - x * uiSettings.baseplateTiltX - z * uiSettings.baseplateTiltZ;
    }
    const mesh = new THREE.Mesh(rockGeo, rockMat);
    mesh.scale.setScalar(data.r);
    mesh.position.set(data.pos[0], y, data.pos[2]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    return { position: mesh.position, radius: data.r };
});
fluid.setRocks(rockObstacles);

let envCubeTexture = null;
{
    const envScene = new THREE.Scene();
    const envSky = new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), skyDomeMat.clone());
    envSky.material.side = THREE.BackSide;
    envScene.add(envSky);
    const cubeRT = new THREE.WebGLCubeRenderTarget(512);
    const cubeCam = new THREE.CubeCamera(0.1, 100, cubeRT);
    cubeCam.update(renderer, envScene);
    envCubeTexture = cubeRT.texture;
}

const fluidRenderer = new FluidRenderer(renderer, fluid);
if (envCubeTexture) fluidRenderer.setEnvMap(envCubeTexture);

const sunDirScratch = new THREE.Vector3();
function applyTimeOfDay() {
    const t = uiSettings.timeOfDay;
    if (t === 'Morning') {
        hemiLight.intensity = 0.72;
        ambientLight.intensity = 0.38;
        dirLight.intensity = 1.05;
        sunDirScratch.set(40, 26, 72).normalize();
    } else if (t === 'Evening') {
        hemiLight.intensity = 0.58;
        ambientLight.intensity = 0.34;
        dirLight.intensity = 1.0;
        sunDirScratch.set(-55, 14, 48).normalize();
    } else if (t === 'Night') {
        hemiLight.intensity = 0.32;
        ambientLight.intensity = 0.2;
        dirLight.intensity = 0.32;
        sunDirScratch.set(14, 5, -6).normalize();
    } else {
        hemiLight.intensity = 0.88;
        ambientLight.intensity = 0.46;
        dirLight.intensity = 1.45;
        sunDirScratch.set(95, 115, 72).normalize();
    }
    dirLight.position.copy(sunDirScratch).multiplyScalar(200);
    skyDomeMat.uniforms.u_sunDir.value.copy(sunDirScratch);
    if (typeof fluidRenderer.setWorldLightDirection === 'function') {
        fluidRenderer.setWorldLightDirection(sunDirScratch);
    } else if (fluidRenderer._worldLightDir) {
        fluidRenderer._worldLightDir.copy(sunDirScratch).normalize();
    }
}
applyTimeOfDay();

function applyWaterColorFromUI() {
    const c = new THREE.Color(uiSettings.waterColor);
    fluidRenderer.setWaterColor(c.r, c.g, c.b);
}

function syncPeriodicFromUI() {
    fluid.sphUniforms.u_periodicFlow.value = uiSettings.loopRiver ? 1.0 : 0.0;
    fluid.sphUniforms.u_flowAccel.value = uiSettings.flowAccel;
}

function syncTankAndFluidUniforms() {
    environmentTools.syncFluidTank(tankMesh, fluid.sphUniforms, fluid);
    syncPeriodicFromUI();
    fluid.sphUniforms.u_baseYOffset.value = uiSettings.baseplateYOffset;
    fluid.sphUniforms.u_baseBumpAmp.value = uiSettings.baseplateBumpAmp;
    fluid.sphUniforms.u_baseBumpFreq.value = uiSettings.baseplateBumpFreq;
    fluid.sphUniforms.u_baseTiltX.value = uiSettings.baseplateTiltX;
    fluid.sphUniforms.u_baseTiltZ.value = uiSettings.baseplateTiltZ;
    fluid.sphUniforms.u_wrapDestLocalZ.value = -0.25; // Map to the spawnZ (-z section halfway)
}

syncTankAndFluidUniforms();
applyWaterColorFromUI();
fluid.resetParticles('default');

const origGenerateTerrain = environmentTools.generateTerrain.bind(environmentTools);
environmentTools.generateTerrain = () => {
    origGenerateTerrain();
    syncTankAndFluidUniforms();
};

function resizeFluid() {
    const { w, h } = getContainerDrawingSize();
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    const size = new THREE.Vector2();
    renderer.getDrawingBufferSize(size);
    fluidRenderer.onResize(size.x, size.y);
}

resizeFluid();

// Exposed for the inline login fallback (runs before this assignment on first paint, then undefined until module loads).
window.__resizeFluid = resizeFluid;

// Match drawing buffer to the canvas wrapper whenever the window or layout changes.
window.addEventListener('resize', resizeFluid);

try {
    setupGUI(uiSettings, {
        ...environmentTools,
        playBGM: startBGM,
        fluid,
        fluidRenderer,
        ballMesh,
        applyWaterColorFromUI,
        applyTimeOfDay,
        syncFluidVolume: syncTankAndFluidUniforms,
        resizeFluid,
        pauseSim,
        muteAudio,
        resumeAudio,
    });
} catch (err) {
    console.error('[WaterSim] setupGUI failed:', err);
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

function animate() {
    requestAnimationFrame(animate);
    if (simPaused) return;

    const delta = Math.min(clock.getDelta(), 0.032);
    checkAdaptiveFPS();

    const ballSpeed = 25.0 * delta;
    if (ballKeys['KeyW']) ballMesh.position.z -= ballSpeed;
    if (ballKeys['KeyS']) ballMesh.position.z += ballSpeed;
    if (ballKeys['KeyA']) ballMesh.position.x -= ballSpeed;
    if (ballKeys['KeyD']) ballMesh.position.x += ballSpeed;
    if (ballKeys['KeyE']) ballMesh.position.y += ballSpeed;
    if (ballKeys['KeyQ']) ballMesh.position.y -= ballSpeed;

    tankMesh.updateMatrixWorld();
    ballMesh.updateMatrixWorld();

    ballTracker.innerText = `Ball XYZ: ${ballMesh.position.x.toFixed(2)}, ${ballMesh.position.y.toFixed(2)}, ${ballMesh.position.z.toFixed(2)}`;

    fluid.update(ballMesh.position, clock.getElapsedTime(), delta, tankMesh);
    fluidRenderer.render(scene, camera, tankMesh);

    controls.update();
}
animate();

const resizeObserver = new ResizeObserver(() => {
    resizeFluid();
});
resizeObserver.observe(container);

// Login reveals the window after layout — catch the first non-zero size (ResizeObserver can be one frame late).
requestAnimationFrame(() => {
    resizeFluid();
    requestAnimationFrame(() => resizeFluid());
});
