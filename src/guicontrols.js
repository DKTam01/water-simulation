import GUI from 'lil-gui';

export function setupGUI(uiSettings, callbacks) {
    
    // --- 1. START BUTTON LOGIC ---
    const startBtn = document.getElementById('start-btn');
    const infoPanel = document.getElementById('info-panel'); 

    startBtn.addEventListener('click', () => {
        startBtn.innerText = "Initializing Environment...";
        startBtn.style.background = "linear-gradient(180deg, #33aa55 0%, #008822 100%)";
        setTimeout(() => {
            infoPanel.classList.add('hidden');
            console.log("Fluid simulation initialized. Focus mode active.");
        }, 300); 
    });

    // --- 2. SLIDING PANEL LOGIC ---
    const icons = document.querySelectorAll('.aero-icon');
    const sidePanels = document.querySelectorAll('.aero-side-panel');
    const backBtns = document.querySelectorAll('.back-btn');
    const sidebarDock = document.getElementById('sidebar-dock');

    // Helper to close all panels and show the dock again
    function returnToDock() {
        sidePanels.forEach(panel => panel.classList.remove('open'));
        sidebarDock.classList.remove('dock-hidden');
    }

    // When an icon is clicked: Hide dock, open specific panel
    icons.forEach(icon => {
        icon.addEventListener('click', () => {
            // Hide the desktop icons
            sidebarDock.classList.add('dock-hidden');
            
            // Open the target right-column panel
            const targetId = icon.getAttribute('data-target');
            document.getElementById(targetId).classList.add('open');
        });
    });

    // Wire up the glossy Back buttons
    backBtns.forEach(btn => {
        btn.addEventListener('click', returnToDock);
    });

    // --- 3. INJECTING LIL-GUI INTO THE SIDE PANELS ---
    // (Your existing GUI logic stays exactly the same)
    
    // A. Environment
    const envContainer = document.getElementById('gui-env-container');
    const guiEnv = new GUI({ container: envContainer });
    guiEnv.add(uiSettings, 'showWireframe').name('Terrain Wireframe').onChange(callbacks.setWireframe);
    guiEnv.add(uiSettings, 'timeOfDay', ['Morning', 'Day', 'Evening', 'Night']).name('Time Settings').onChange((time) => {
        console.log(`Scene changed to: ${time}`);
    });

    // B. Terrain
    const terrainContainer = document.getElementById('gui-terrain-container');
    const guiTerrain = new GUI({ container: terrainContainer });
    guiTerrain.add(uiSettings, 'planeWidth', 20, 100).name('Map Width').onChange(callbacks.generateTerrain);
    guiTerrain.add(uiSettings, 'planeLength', 20, 100).name('Map Length').onChange(callbacks.generateTerrain);
    guiTerrain.add(uiSettings, 'riverDepth', 0, 10).name('River Depth').onChange(callbacks.generateTerrain);
    guiTerrain.add(uiSettings, 'riverWidth', 1, 50).name('River Width').onChange(callbacks.generateTerrain);
    guiTerrain.add(uiSettings, 'cliffHeight', 0, 10).name('Waterfall Height').onChange(callbacks.generateTerrain);
    guiTerrain.add(uiSettings, 'flowSlope', 0, 0.5).name('Global Tilt').onChange(callbacks.generateTerrain);

    // C. Water Optics
    const waterContainer = document.getElementById('gui-water-container');
    const guiWater = new GUI({ container: waterContainer });
    guiWater.addColor(uiSettings, 'waterColor').name('Water Color').onChange(callbacks.updateWater);
    guiWater.add(uiSettings, 'waterOpacity', 0, 1).name('Opacity').onChange(callbacks.updateWater);
    guiWater.add(uiSettings, 'waterIOR', 1.0, 2.0).name('Index of Refraction').onChange(callbacks.updateWater);
}