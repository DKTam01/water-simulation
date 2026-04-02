//baseline code to set up the scene, camera, renderer, controls, and lighting

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { setupEnvironment } from './environment.js';
import { setupGUI } from './guicontrols.js';


//** website setup to contain simulation inside the container on webpage */
const container = document.getElementById('sim-container');

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

// ** intial gui settings
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
setupGUI(uiSettings, environmentTools);

// 8. Animation Loop
function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}
animate();

window.addEventListener('resize', () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
});