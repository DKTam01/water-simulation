import * as THREE from 'three';

export function setupEnvironment(scene) {
    // 1. THE PHYSICS CONTAINER
    // Since our u_boxSize is 5, the box needs to be 10 units wide/tall
    const boxSize = 10;
    const boxGeom = new THREE.BoxGeometry(boxSize, boxSize, boxSize);
    const edges = new THREE.EdgesGeometry(boxGeom);
    
    // Using a bright white for the cage so it's clearly visible against the dark sky
    const container = new THREE.LineSegments(
        edges, 
        new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 })
    );
    
    // Lift the box so the bottom face sits exactly at Y = 0
    container.position.y = 5; 
    scene.add(container);

    // 2. THE VISUAL FLOOR
    // We make the floor slightly larger than the box
    const floorGeom = new THREE.PlaneGeometry(20, 20);
    floorGeom.rotateX(-Math.PI / 2);
    const floor = new THREE.Mesh(
        floorGeom, 
        new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.8 })
    );
    // Move it a tiny bit down to prevent "Z-fighting" with the grid
    floor.position.y = -0.01; 
    scene.add(floor);

    // 3. GRID HELPER
    // This is the most important part for debugging "slow" movement.
    // It gives your eyes a fixed point to see the particles moving against.
    const grid = new THREE.GridHelper(20, 20, 0x444444, 0x222222);
    scene.add(grid);

    // 4. LIGHTING (Ensures the environment isn't pitch black)
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