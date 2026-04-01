// baseline code that sets up camera, renders
// starts out with flat ground as a base

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// 1. Scene Setup
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87CEEB); // Sky blue background

// 2. Camera Setup
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 5, 15); // Move camera up and back so we can see the ground

// 3. Renderer Setup
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

// 4. Add Orbit Controls
// (Lets you click and drag to look around)
const controls = new OrbitControls(camera, renderer.domElement);

// 5. Create the Base Ground
// PlaneGeometry with many segments (50x50)
const geometry = new THREE.PlaneGeometry(30, 30, 50, 50);
geometry.rotateX(-Math.PI / 2); // Rotate so it lays flat on the floor

// Using a wireframe material right now
const material = new THREE.MeshBasicMaterial({ color: 0x228B22, wireframe: true });
const ground = new THREE.Mesh(geometry, material);
scene.add(ground);

// 6. Animation Loop
function animate()
{
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}
animate();

// Handle Window Resize
window.addEventListener('resize', () =>
    {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});