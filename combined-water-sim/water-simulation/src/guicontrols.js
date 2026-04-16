import GUI from 'lil-gui';

export function setupGUI(uiSettings, callbacks) {
    const transitionSound = new Audio('./sounds/sound effects/simulation start.mp3');
    transitionSound.volume = 0.3;

    const loginScreen = document.getElementById('login-screen');
    const startBtn = document.getElementById('start-btn');
    const loginStatus = document.getElementById('login-status');
    const appWindow = document.getElementById('app-window');
    const taskbar = document.getElementById('vista-taskbar');
    const desktop = document.getElementById('desktop-layer');

    /** HTML `onclick` calls this; audio failures must not block the UI. */
    function enterSimulationFromLogin() {
        try {
            const p = transitionSound.play();
            if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch {
            /* ignore */
        }

        if (loginStatus) loginStatus.innerText = 'Welcome...';
        if (startBtn) startBtn.style.background = 'radial-gradient(circle at center, #33aa55 0%, #008822 100%)';

        setTimeout(() => {
            try {
                if (loginScreen) loginScreen.classList.add('hidden');
                if (appWindow) appWindow.style.display = 'flex';
                if (taskbar) taskbar.style.display = 'flex';
                if (desktop) desktop.style.display = 'flex';
                window.dispatchEvent(new Event('resize'));
                if (typeof callbacks.playBGM === 'function') callbacks.playBGM();
                requestAnimationFrame(() => {
                    if (typeof callbacks.resizeFluid === 'function') callbacks.resizeFluid();
                });
                setTimeout(() => {
                    if (loginScreen) loginScreen.style.display = 'none';
                    document.body.style.cursor = 'default';

                    const hint = document.getElementById('orbit-hint');
                    if (hint) {
                        hint.classList.add('visible');
                        setTimeout(() => hint.classList.remove('visible'), 5000);
                    }
                }, 1500);
            } catch {
                /* ignore */
            }
        }, 800);
    }

    window.enterSimLogin = enterSimulationFromLogin;

    // Keyboard: Enter triggers login, Escape dismisses the app window
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && loginScreen && !loginScreen.classList.contains('hidden') && loginScreen.style.display !== 'none') {
            enterSimulationFromLogin();
        }
    });

    const titleBar = document.getElementById('window-titlebar');
    let isDragging = false;
    let offsetX;
    let offsetY;

    if (titleBar && appWindow) {
        titleBar.addEventListener('mousedown', (e) => {
            isDragging = true;
            appWindow.style.transition = 'none';
            const rect = appWindow.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            offsetX = e.clientX - centerX;
            offsetY = e.clientY - centerY;
        });
    }

    document.addEventListener('mousemove', (e) => {
        if (!isDragging || !appWindow) return;
        appWindow.style.left = `${e.clientX - offsetX}px`;
        appWindow.style.top = `${e.clientY - offsetY}px`;
    });

    document.addEventListener('mouseup', () => {
        if (isDragging && appWindow) {
            isDragging = false;
            appWindow.style.transition = 'opacity 0.3s, transform 0.3s';
        }
    });

    const btnMin = document.getElementById('btn-min');
    const btnClose = document.getElementById('btn-close');
    const taskbarApp = document.getElementById('taskbar-app');

    if (btnMin && appWindow) {
        btnMin.addEventListener('click', () => {
            appWindow.classList.add('minimized');
            if (typeof callbacks.muteAudio === 'function') callbacks.muteAudio();
        });
    }

    if (taskbarApp && appWindow) {
        taskbarApp.addEventListener('click', () => {
            appWindow.classList.remove('minimized');
            if (typeof callbacks.resumeAudio === 'function') callbacks.resumeAudio();
        });
    }

    if (btnClose && appWindow) {
        btnClose.addEventListener('click', () => {
            appWindow.style.display = 'none';
            if (taskbarApp) taskbarApp.style.display = 'none';
            if (typeof callbacks.pauseSim === 'function') callbacks.pauseSim();
        });
    }

    setInterval(() => {
        const now = new Date();
        document.getElementById('os-clock').innerText = now.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
        });
    }, 1000);

    const muteBtn  = document.getElementById('mute-btn');
    const muteIcon = document.getElementById('mute-icon');
    let _audioMuted = false;
    if (muteBtn) {
        muteBtn.addEventListener('click', () => {
            _audioMuted = !_audioMuted;
            if (_audioMuted) {
                if (typeof callbacks.muteAudio === 'function') callbacks.muteAudio();
                if (muteIcon) { muteIcon.style.opacity = '0.3'; muteIcon.style.filter = 'grayscale(1)'; }
                muteBtn.title = 'Unmute audio';
            } else {
                if (typeof callbacks.resumeAudio === 'function') callbacks.resumeAudio();
                if (muteIcon) { muteIcon.style.opacity = '1'; muteIcon.style.filter = ''; }
                muteBtn.title = 'Mute audio';
            }
        });
    }

    const envContainer = document.getElementById('gui-env-container');
    const guiEnv = new GUI({ container: envContainer });
    guiEnv.add(uiSettings, 'showWireframe').name('Terrain Wireframe').onChange(callbacks.setWireframe);
    guiEnv.add(uiSettings, 'timeOfDay', ['Morning', 'Day', 'Evening', 'Night']).name('Time Settings');

    const terrainContainer = document.getElementById('gui-terrain-container');
    const guiTerrain = new GUI({ container: terrainContainer });
    guiTerrain.add(uiSettings, 'planeWidth', 40, 320).name('Map Width').onChange(callbacks.generateTerrain);
    guiTerrain.add(uiSettings, 'planeLength', 40, 360).name('Map Length').onChange(callbacks.generateTerrain);
    guiTerrain.add(uiSettings, 'riverDepth', 0, 10).name('River Depth').onChange(callbacks.generateTerrain);
    guiTerrain.add(uiSettings, 'riverWidth', 1, 90).name('River Width').onChange(callbacks.generateTerrain);
    guiTerrain.add(uiSettings, 'cliffHeight', 0, 10).name('Waterfall Height').onChange(callbacks.generateTerrain);
    guiTerrain.add(uiSettings, 'flowSlope', 0, 0.5).name('Global Tilt').onChange(callbacks.generateTerrain);

    const { fluid, fluidRenderer, ballMesh, applyWaterColorFromUI, resizeFluid } = callbacks;

    const rp = fluidRenderer.params;
    const uniforms = fluid.sphUniforms;

    const waterContainer = document.getElementById('gui-water-container');
    const guiWater = new GUI({ container: waterContainer });
    guiWater.add(rp, 'enabled').name('Screen-space fluid');
    guiWater.add(rp, 'showParticles').name('Show particles (debug)');
    guiWater.addColor(uiSettings, 'waterColor').name('Water tint').onChange(() => applyWaterColorFromUI());
    guiWater.add(rp, 'ior', 1.0, 2.5, 0.01).name('IOR').onChange((v) => fluidRenderer.setIOR(v));
    guiWater.add(rp, 'tintMix', 0.0, 1.0, 0.01).name('Tint mix').onChange((v) => fluidRenderer.setTintMix(v));
    guiWater.add(rp, 'scatterStrength', 0.0, 1.2, 0.02).name('Volume brightness').onChange((v) =>
        fluidRenderer.setScatterStrength(v)
    );
    guiWater.add(rp, 'particleRadius', 0.2, 1.5, 0.01).name('Blob radius').onChange((v) =>
        fluidRenderer.setParticleRadius(v)
    );
    guiWater.add(rp, 'blurRadius', 0.5, 8.0, 0.1).name('Blur radius').onChange((v) => fluidRenderer.setBlurRadius(v));
    guiWater.add(rp, 'blurDepthFalloff', 1.0, 50.0, 0.5).name('Blur sharpness').onChange((v) =>
        fluidRenderer.setBlurFalloff(v)
    );
    guiWater.add(rp, 'normalScale', 0.5, 30.0, 0.5).name('Normal scale').onChange((v) =>
        fluidRenderer.setNormalScale(v)
    );
    guiWater.add(rp, 'refractionStrength', 0.0, 30.0, 0.5).name('Refraction scale').onChange((v) =>
        fluidRenderer.setRefractionStrength(v)
    );
    guiWater.add(rp, 'envMapIntensity', 0.0, 3.0, 0.05).name('Env reflection').onChange((v) =>
        fluidRenderer.setEnvMapIntensity(v)
    );
    guiWater.add(rp, 'foamScale', 0.0, 3.0, 0.05).name('Foam intensity').onChange((v) =>
        fluidRenderer.setFoamScale(v)
    );
    guiWater.add(rp, 'fluidScale', 0.25, 1.0, 0.05).name('Fluid RT scale').onChange((v) =>
        fluidRenderer.setFluidScale(v)
    );

    const particleContainer = document.getElementById('gui-particle-container');
    const guiParticle = new GUI({ container: particleContainer });

    guiParticle
        .add(uiSettings, 'loopRiver')
        .name('Loop river (periodic Z)')
        .onChange((v) => {
            uniforms.u_periodicFlow.value = v ? 1.0 : 0.0;
        });
    guiParticle.add(uiSettings, 'flowAccel', 0, 14, 0.25).name('Downstream push').onChange((v) => {
        uniforms.u_flowAccel.value = v;
    });

    const sphFolder = guiParticle.addFolder('SPH physics');
    sphFolder
        .add(uniforms.u_smoothingRadius, 'value', 0.5, 3.0)
        .name('Smoothing radius')
        .onChange((v) => fluid.rebuildSpatialHash(v));
    sphFolder.add(uniforms.u_targetDensity, 'value', 10.0, 300.0).name('Target density');
    sphFolder.add(uniforms.u_pressureMultiplier, 'value', 1.0, 200.0).name('Pressure');
    sphFolder.add(uniforms.u_nearPressureMultiplier, 'value', 1.0, 50.0).name('Near pressure');
    sphFolder.add(uniforms.u_viscosityMultiplier, 'value', 0.0, 1.0).name('Viscosity');
    sphFolder.add(uniforms.u_gravity, 'value', -40.0, 0.0).name('Gravity');
    sphFolder.add(uniforms.u_collisionDamping, 'value', 0.0, 1.0).name('Wall damping');
    sphFolder.add(uniforms.u_agitation, 'value', 0.0, 5.0).name('Agitation');
    sphFolder.open();

    const ballFolder = guiParticle.addFolder('Interaction ball');
    ballFolder.add(ballMesh.position, 'x', -35, 35).name('Ball X');
    ballFolder.add(ballMesh.position, 'y', -5, 55).name('Ball Y');
    ballFolder.add(ballMesh.position, 'z', -90, 90).name('Ball Z');
    const ballRadiusProxy = { radius: 1.5 };
    ballFolder.add(ballRadiusProxy, 'radius', 0.5, 8.0, 0.1).name('Ball Radius').onChange((v) => {
        ballMesh.scale.setScalar(v / 1.5);
        fluid.sphUniforms.u_ballRadius.value = v;
    });

    const simFolder = guiParticle.addFolder('Simulation presets');
    const simPresets = {
        'Reset (default)'() {
            fluid.resetParticles('default');
        },
        'Breaking wave'() {
            fluid.resetParticles('wave');
        },
    };
    simFolder.add(simPresets, 'Reset (default)');
    simFolder.add(simPresets, 'Breaking wave');
    simFolder
        .add(uiSettings, 'particleResolution', { '32': 32, '64': 64, '128': 128 })
        .name('Particle count')
        .onChange(() => {
            if (confirm('Reload page to change particle count?')) {
                localStorage.setItem('particleResolution', String(uiSettings.particleResolution));
                location.reload();
            }
        });
    simFolder.open();

}
