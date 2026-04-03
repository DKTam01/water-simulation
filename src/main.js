//baseline code to set up the scene, camera, renderer, controls, and lighting

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { setupEnvironment } from './environment.js';
import { setupGUI } from './guicontrols.js';

// ** CRITICAL FIX: Target the new 70% left column wrapper instead of the old full-screen container
const container = document.getElementById('canvas-wrapper');

// 1. Scene Setup
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87CEEB); 

// 2. Camera Setup
const camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 1000);
camera.position.set(0, 10, 20); // ** Camera positioned to look down at the riverbed

// 3. Renderer Setup
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(container.clientWidth, container.clientHeight);
container.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);

// 4. Lighting Setup
const ambientLight = new THREE.AmbientLight(0x404040, 2); // Global ambient light
scene.add(ambientLight); 

const dirLight = new THREE.DirectionalLight(0xffffff, 1.5); // ** Simulate sunlight to add depth and shadows
dirLight.position.set(10, 20, 10);
scene.add(dirLight);

// 5. Audio Setup
const listener = new THREE.AudioListener();
camera.add(listener);

const bgMusic = new THREE.Audio(listener);
const audioLoader = new THREE.AudioLoader();

// Load your tasteful background music
audioLoader.load('./sounds/background music/bgm.mp3', function(buffer) {
    bgMusic.setBuffer(buffer);
    bgMusic.setLoop(true);
    bgMusic.setVolume(0.15); // Kept very quiet so it's not annoying
});

const startBGM = () => {
    if (bgMusic.buffer && !bgMusic.isPlaying) {
        bgMusic.play();
    }
};

// ** initial gui settings
const uiSettings = {
    showWireframe: false,
    timeOfDay: 'Day',
    planeWidth: 60,
    planeLength: 60,
    riverDepth: 3,
    riverWidth: 20,
    cliffHeight: 3.5,
    flowSlope: 0.05,

    waterColor: '#0088ff',
    waterOpacity: 0.7,
    waterIOR: 1.33
};

const environmentTools = setupEnvironment(scene, uiSettings);

setupGUI(uiSettings, { 
    ...environmentTools, 
    playBGM: startBGM 
});

// 8. Animation Loop
function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}
animate();

// ** ANIMATION FIX: This ensures the 3D canvas recalculates its size 
// continuously if the window is resizing or animating.
const resizeObserver = new ResizeObserver(() => {
    if (container.clientWidth > 0 && container.clientHeight > 0) {
        camera.aspect = container.clientWidth / container.clientHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(container.clientWidth, container.clientHeight);
    }
});
resizeObserver.observe(container);