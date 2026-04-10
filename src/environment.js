import * as THREE from 'three';

export function setupEnvironment(scene) {
    // NOTE: The wireframe tank container is now dynamic and managed by main.js
    // (previously we had a hardcoded 10x10x10 box here that conflicted with the dynamic one)

    // 1. THE VISUAL FLOOR
    const floorGeom = new THREE.PlaneGeometry(40, 40);
    floorGeom.rotateX(-Math.PI / 2);
    const floor = new THREE.Mesh(
        floorGeom,
        new THREE.MeshStandardMaterial({ color: 0x3a4558, roughness: 0.75, metalness: 0.05 })
    );
    // Move it a tiny bit down to prevent Z-fighting with the grid
    floor.position.y = -0.01; 
    scene.add(floor);

    // 2. GRID HELPER — gives a fixed reference frame to see particles moving
    const grid = new THREE.GridHelper(40, 40, 0x444444, 0x222222);
    scene.add(grid);

    // 3. LIGHTING
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);

    const pointLight = new THREE.PointLight(0xffffff, 1);
    pointLight.position.set(5, 10, 5);
    scene.add(pointLight);

    return { 
        generateTerrain: () => {}, 
        updateWater: () => {} 
    };
}