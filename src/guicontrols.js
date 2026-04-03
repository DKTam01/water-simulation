import GUI from 'lil-gui';

export function setupGUI(uiSettings, callbacks) {
    
    // --- 0. LOAD UI SOUND EFFECTS ---
    const transitionSound = new Audio('./sounds/sound effects/simulation start.mp3');
    transitionSound.volume = 0.3; 

    // --- 1. LOGIN & BOOT SEQUENCE ---
    const loginScreen = document.getElementById('login-screen');
    const startBtn = document.getElementById('start-btn');
    const loginStatus = document.getElementById('login-status');
    const appWindow = document.getElementById('app-window');
    const taskbar = document.getElementById('vista-taskbar');
    const desktop = document.getElementById('desktop-layer');

        startBtn.addEventListener('click', () => {
        transitionSound.play();
        
        loginStatus.innerText = "Welcome...";
        // Removed the scale(0.95) line!
        // Just turn the button green to indicate success
        startBtn.style.background = "radial-gradient(circle at center, #33aa55 0%, #008822 100%)";
        
        // Wait for chime, then boot to desktop
        setTimeout(() => {
            loginScreen.classList.add('hidden');
            // ... the rest of the code stays exactly the same
            
            // Show the desktop elements
            appWindow.style.display = 'flex';
            taskbar.style.display = 'flex';
            desktop.style.display = 'flex';
            
            // Trigger a window resize event so Three.js calculates the canvas size correctly!
            window.dispatchEvent(new Event('resize'));
            
            // Start the BGM
            callbacks.playBGM();
            
            // Cleanup login screen and restore normal cursor after fade
            setTimeout(() => {
                loginScreen.style.display = 'none';
                document.body.style.cursor = 'default';
            }, 1500); 

            console.log("Logged into Vista Environment.");
        }, 800); 
    });

    // --- 2. WINDOW MOVEMENT LOGIC ---
    const titleBar = document.getElementById('window-titlebar');
    let isDragging = false;
    let offsetX, offsetY;

    titleBar.addEventListener('mousedown', (e) => {
        isDragging = true;
        
        appWindow.style.transition = 'none';
        
        const rect = appWindow.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        
        offsetX = e.clientX - centerX;
        offsetY = e.clientY - centerY;
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        appWindow.style.left = (e.clientX - offsetX) + 'px';
        appWindow.style.top = (e.clientY - offsetY) + 'px';
    });

    document.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            appWindow.style.transition = 'opacity 0.3s, transform 0.3s';
        }
    });

    // --- 3. WINDOW CONTROLS LOGIC (Min/Close) ---
    const btnMin = document.getElementById('btn-min');
    const btnClose = document.getElementById('btn-close');
    const taskbarApp = document.getElementById('taskbar-app');

    btnMin.addEventListener('click', () => {
        appWindow.classList.add('minimized');
    });

    taskbarApp.addEventListener('click', () => {
        appWindow.classList.remove('minimized');
    });

    btnClose.addEventListener('click', () => {
        appWindow.style.display = 'none';
        taskbarApp.style.display = 'none';
    });

    // Simple OS Clock for the system tray
    setInterval(() => {
        const now = new Date();
        document.getElementById('os-clock').innerText = now.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    }, 1000);


    // --- 4. INJECTING LIL-GUI INTO THE APP WINDOW ---
    const envContainer = document.getElementById('gui-env-container');
    const guiEnv = new GUI({ container: envContainer });
    guiEnv.add(uiSettings, 'showWireframe').name('Terrain Wireframe').onChange(callbacks.setWireframe);
    guiEnv.add(uiSettings, 'timeOfDay', ['Morning', 'Day', 'Evening', 'Night']).name('Time Settings').onChange((time) => {
        console.log(`Scene changed to: ${time}`);
    });

    const terrainContainer = document.getElementById('gui-terrain-container');
    const guiTerrain = new GUI({ container: terrainContainer });
    guiTerrain.add(uiSettings, 'planeWidth', 20, 100).name('Map Width').onChange(callbacks.generateTerrain);
    guiTerrain.add(uiSettings, 'planeLength', 20, 100).name('Map Length').onChange(callbacks.generateTerrain);
    guiTerrain.add(uiSettings, 'riverDepth', 0, 10).name('River Depth').onChange(callbacks.generateTerrain);
    guiTerrain.add(uiSettings, 'riverWidth', 1, 50).name('River Width').onChange(callbacks.generateTerrain);
    guiTerrain.add(uiSettings, 'cliffHeight', 0, 10).name('Waterfall Height').onChange(callbacks.generateTerrain);
    guiTerrain.add(uiSettings, 'flowSlope', 0, 0.5).name('Global Tilt').onChange(callbacks.generateTerrain);

    const waterContainer = document.getElementById('gui-water-container');
    const guiWater = new GUI({ container: waterContainer });
    guiWater.addColor(uiSettings, 'waterColor').name('Water Color').onChange(callbacks.updateWater);
    guiWater.add(uiSettings, 'waterOpacity', 0, 1).name('Opacity').onChange(callbacks.updateWater);
    guiWater.add(uiSettings, 'waterIOR', 1.0, 2.0).name('Index of Refraction').onChange(callbacks.updateWater);
}