//gui controls file to set up the user interface for controlling various aspects of the scene, such as terrain generation and water appearance

import GUI from 'lil-gui'; // ** Using lil-gui for the UI controls

export function setupGUI(uiSettings, callbacks) {
    // ** gui setup 
    const gui = new GUI({ title: 'Scene Controls' });

    // ** wireframe toggle
    const environmentFolder = gui.addFolder('Environment');
    environmentFolder.add(uiSettings, 'showWireframe').name('Terrain Wireframe').onChange(callbacks.setWireframe);

    // ** time of day dropdown
    environmentFolder.add(uiSettings, 'timeOfDay', ['Morning', 'Day', 'Evening', 'Night']).name('Time Settings').onChange((time) => {
        console.log(`Scene changed to: ${time} - Lighting logic goes here.`);
    });

    // **terain control
    const terrainFolder = gui.addFolder('Terrain Shape');
    terrainFolder.add(uiSettings, 'planeWidth', 20, 100).name('Map Width').onChange(callbacks.generateTerrain);
    terrainFolder.add(uiSettings, 'planeLength', 20, 100).name('Map Length').onChange(callbacks.generateTerrain);
    terrainFolder.add(uiSettings, 'riverDepth', 0, 10).name('River Depth').onChange(callbacks.generateTerrain);
    terrainFolder.add(uiSettings, 'riverWidth', 1, 50).name('River Width').onChange(callbacks.generateTerrain);
    terrainFolder.add(uiSettings, 'cliffHeight', 0, 10).name('Waterfall Height').onChange(callbacks.generateTerrain);
    terrainFolder.add(uiSettings, 'flowSlope', 0, 0.5).name('Global Tilt').onChange(callbacks.generateTerrain);

    // ** water control
    const waterFolder = gui.addFolder('Water Appearance');
    waterFolder.addColor(uiSettings, 'waterColor').name('Water Color').onChange(callbacks.updateWater);
    waterFolder.add(uiSettings, 'waterOpacity', 0, 1).name('Opacity').onChange(callbacks.updateWater);

    waterFolder.add(uiSettings, 'waterIOR', 1.0, 2.0).name('Index of Refraction').onChange(callbacks.updateWater);
}