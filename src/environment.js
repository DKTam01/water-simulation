//environment file to handle terrain and water generation, as well as material updates based on user input from the GUI

import * as THREE from 'three';

export function setupEnvironment(scene, uiSettings) {
    // initialize the terrain material with green
    const terrainMaterial = new THREE.MeshStandardMaterial({ 
        color: 0x3E8E41, 
        wireframe: false,   
        roughness: 0.95
    });

    let ground; // declare ground to keep updating based on user input
    let water;  // declare water here so it can be destroyed and remade too

    const waterMaterial = new THREE.MeshPhysicalMaterial({
        color: uiSettings.waterColor,
        transparent: true,
        opacity: uiSettings.waterOpacity,
        roughness: 0.1,       
        transmission: 0.9,    
        ior: uiSettings.waterIOR             
    });

    function generateTerrain() {

        //if ground already exists, remove it before creating a new one to avoid memory leaks
        if (ground) {
            scene.remove(ground);
            ground.geometry.dispose(); 
        }
        if (water) {
            scene.remove(water);
            water.geometry.dispose();
        }

        const geometry = new THREE.PlaneGeometry(uiSettings.planeWidth, uiSettings.planeLength, 100, 100);
        geometry.rotateX(-Math.PI / 2); 

        const positionAttribute = geometry.attributes.position; 
        for (let i = 0; i < positionAttribute.count; i++) {     
            const x = positionAttribute.getX(i);                
            const z = positionAttribute.getZ(i); 

            //riverbed height calculation using a Gaussian function to create a smooth riverbed shape, with the depth controlled by uiSettings.riverDepth and width by uiSettings.riverWidth
            let height = -uiSettings.riverDepth * Math.exp(-(x * x) / uiSettings.riverWidth); 

            const dropOffCurve = (1 - Math.tanh(z * 0.8)) * uiSettings.cliffHeight; 
            height += dropOffCurve;

            height -= z * uiSettings.flowSlope;

            positionAttribute.setY(i, height);          
        }
        geometry.computeVertexNormals();                        

        ground = new THREE.Mesh(geometry, terrainMaterial);
        scene.add(ground);

        // ----------------------------------------------------------------------
        // 2. GENERATE THE CONSTRAINED WATER STRIP
        // ----------------------------------------------------------------------
        // * MODIFIED: Calculate a safe width for the water so it stays inside the trench
        const waterWidth = Math.sqrt(uiSettings.riverWidth) * 3.5; 
        
        // * MODIFIED: We need 100 segments on the length to smoothly bend over the waterfall, 
        // but only a few segments on the width since it lays flat horizontally.
        const waterGeometry = new THREE.PlaneGeometry(waterWidth, uiSettings.planeLength, 10, 100);
        waterGeometry.rotateX(-Math.PI / 2);

        const waterPos = waterGeometry.attributes.position;
        for (let i = 0; i < waterPos.count; i++) {
            const z = waterPos.getZ(i);

            // A. Set the baseline water level inside the trench
            // By multiplying the depth by 0.4, the water fills up about 60% of the channel
            let waterHeight = -uiSettings.riverDepth * 0.4; 

            // B. Apply the EXACT same waterfall curve as the terrain!
            const dropOffCurve = (1 - Math.tanh(z * 0.8)) * uiSettings.cliffHeight; 
            waterHeight += dropOffCurve;

            // C. Apply the EXACT same global tilt as the terrain!
            waterHeight -= z * uiSettings.flowSlope;

            waterPos.setY(i, waterHeight);
        }
        waterGeometry.computeVertexNormals();

        water = new THREE.Mesh(waterGeometry, waterMaterial);
        // * MODIFIED: We no longer manually position or rotate the water mesh here,
        // because the exact heights and slopes are baked directly into the vertices above.
        scene.add(water);
    }
    generateTerrain();

    return {
        generateTerrain,
        setWireframe: (value) => { terrainMaterial.wireframe = value; },
        updateWater: () => {
            waterMaterial.color.set(uiSettings.waterColor);
            waterMaterial.opacity = uiSettings.waterOpacity;
            waterMaterial.ior = uiSettings.waterIOR;
        }
    };
}