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

    // Disable mouse wheel scrolling on Lil-GUI sliders to prevent accidental changes
    document.addEventListener('wheel', (e) => {
        if (e.target.closest('.lil-gui input')) {
            e.stopPropagation();
        }
    }, { capture: true });

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
    const btnDebug = document.getElementById('btn-debug');
    const taskbarApp = document.getElementById('taskbar-app');

    if (btnDebug && callbacks.toggleDebugMode) {
        btnDebug.addEventListener('click', () => {
            callbacks.toggleDebugMode();
        });
    }

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
    guiEnv.add(uiSettings, 'showWireframe').name('Baseplate wireframe').onChange(callbacks.setWireframe);
    guiEnv
        .add(uiSettings, 'timeOfDay', ['Morning', 'Day', 'Evening', 'Night'])
        .name('Time of day')
        .onChange(() => {
            if (typeof callbacks.applyTimeOfDay === 'function') callbacks.applyTimeOfDay();
        });

    const terrainContainer = document.getElementById('gui-terrain-container');
    const guiTerrain = new GUI({ container: terrainContainer });
    guiTerrain.add(uiSettings, 'baseplateSize', 20, 80, 1).name('Baseplate size').onChange(callbacks.generateTerrain);
    guiTerrain.add(uiSettings, 'baseplateSeg', 32, 400, 1).name('Baseplate subdivisions').onChange(callbacks.generateTerrain);
    guiTerrain.add(uiSettings, 'baseplateYOffset', -8, 8, 0.05).name('Plate height offset').onChange(callbacks.generateTerrain);
    guiTerrain.add(uiSettings, 'baseplateBumpAmp', 0, 2.5, 0.01).name('Surface ripple amp').onChange(callbacks.generateTerrain);
    guiTerrain.add(uiSettings, 'baseplateBumpFreq', 0.01, 0.25, 0.005).name('Ripple frequency').onChange(callbacks.generateTerrain);
    guiTerrain.add(uiSettings, 'baseplateTiltX', -0.02, 0.02, 0.0005).name('Tilt along X').onChange(callbacks.generateTerrain);
    guiTerrain.add(uiSettings, 'baseplateTiltZ', -0.02, 0.02, 0.0005).name('Tilt along Z').onChange(callbacks.generateTerrain);

    const { fluid, fluidRenderer, ballMesh, applyWaterColorFromUI, resizeFluid } = callbacks;

    const rp = fluidRenderer.params;
    const uniforms = fluid.sphUniforms;

    const waterContainer = document.getElementById('gui-water-container');
    const guiWater = new GUI({ container: waterContainer });
    const renderFolder = guiWater.addFolder('Fluid rendering');
    renderFolder.add(rp, 'enabled').name('Screen-space fluid');
    renderFolder.add(rp, 'showParticles').name('Show particles (debug)');
    renderFolder.addColor(uiSettings, 'waterColor').name('Water tint').onChange(() => applyWaterColorFromUI());
    renderFolder
        .add(rp, 'particleRadius', 0.2, 1.5, 0.01)
        .name('Blob radius')
        .onChange((v) => fluidRenderer.setParticleRadius(v));
    renderFolder
        .add(rp, 'blurRadius', 0.5, 8.0, 0.1)
        .name('Blur radius')
        .onChange((v) => fluidRenderer.setBlurRadius(v));
    renderFolder
        .add(rp, 'blurDepthFalloff', 1.0, 50.0, 0.5)
        .name('Blur edge sharpness')
        .onChange((v) => fluidRenderer.setBlurFalloff(v));
    renderFolder
        .add(rp, 'blurIterations', 1, 4, 1)
        .name('Blur iterations')
        .onChange((v) => fluidRenderer.setBlurIterations(v));
    renderFolder
        .add(rp, 'normalScale', 0.5, 30.0, 0.5)
        .name('Normal scale')
        .onChange((v) => fluidRenderer.setNormalScale(v));
    renderFolder
        .add(rp, 'absorptionStrength', 0.0, 2.0, 0.01)
        .name('Absorption')
        .onChange((v) => fluidRenderer.setAbsorptionStrength(v));
    renderFolder
        .add(rp, 'ior', 1.0, 2.5, 0.01)
        .name('IOR (refraction index)')
        .onChange((v) => fluidRenderer.setIOR(v));
    renderFolder
        .add(rp, 'refractionStrength', 0.0, 30.0, 0.5)
        .name('Refraction scale')
        .onChange((v) => fluidRenderer.setRefractionStrength(v));
    renderFolder
        .add(rp, 'specularStrength', 0.0, 5.0, 0.1)
        .name('Specular')
        .onChange((v) => fluidRenderer.setSpecularStrength(v));
    renderFolder
        .add(rp, 'thicknessScale', 0.01, 0.5, 0.01)
        .name('Thickness scale')
        .onChange((v) => fluidRenderer.setThicknessScale(v));
    renderFolder
        .add(rp, 'detailNormalBlend', 0.0, 1.0, 0.01)
        .name('Detail normals')
        .onChange((v) => fluidRenderer.setDetailNormalBlend(v));
    renderFolder
        .add(rp, 'envMapIntensity', 0.0, 3.0, 0.05)
        .name('Env reflection')
        .onChange((v) => fluidRenderer.setEnvMapIntensity(v));
    renderFolder
        .add(rp, 'tintMix', 0.0, 1.0, 0.01)
        .name('Water tint mix')
        .onChange((v) => fluidRenderer.setTintMix(v));
    renderFolder
        .add(rp, 'scatterStrength', 0.0, 1.2, 0.02)
        .name('Volume brightness')
        .onChange((v) => fluidRenderer.setScatterStrength(v));
    renderFolder
        .add(rp, 'surfaceExposure', 0.8, 1.5, 0.01)
        .name('Surface exposure')
        .onChange((v) => fluidRenderer.setSurfaceExposure(v));
    renderFolder
        .add(rp, 'causticsStrength', 0.0, 2.0, 0.05)
        .name('Floor caustics')
        .onChange((v) => fluidRenderer.setCausticsStrength(v));
    renderFolder
        .add(rp, 'foamScale', 0.0, 3.0, 0.05)
        .name('Foam intensity')
        .onChange((v) => fluidRenderer.setFoamScale(v));
    renderFolder
        .add(rp, 'foamSpeedMin', 0.0, 10.0, 0.5)
        .name('Foam speed min')
        .onChange((v) => fluidRenderer.setFoamSpeedMin(v));
    renderFolder
        .add(rp, 'foamSpeedMax', 1.0, 30.0, 0.5)
        .name('Foam speed max')
        .onChange((v) => fluidRenderer.setFoamSpeedMax(v));
    renderFolder
        .add(rp, 'densityRadiusStrength', 0.0, 1.0, 0.01)
        .name('Adaptive splats')
        .onChange((v) => fluidRenderer.setDensityRadiusStrength(v));
    renderFolder
        .add(rp, 'fluidScale', 0.25, 1.0, 0.05)
        .name('Fluid resolution')
        .onChange((v) => {
            fluidRenderer.setFluidScale(v);
            if (typeof callbacks.resizeFluid === 'function') callbacks.resizeFluid();
        });
    renderFolder
        .add(rp, 'debugMode', { Final: 0, Depth: 1, Thickness: 2, Normals: 3, Foam: 4 })
        .name('Debug view')
        .onChange((v) => fluidRenderer.setDebugMode(Number(v)));
    renderFolder.open();

    const particleContainer = document.getElementById('gui-particle-container');
    const guiParticle = new GUI({ container: particleContainer });

    const fluidVol = guiParticle.addFolder('Fluid container (SPH volume)');
    const onFluidVolumeChange = () => {
        if (typeof callbacks.syncFluidVolume === 'function') callbacks.syncFluidVolume();
    };
    fluidVol
        .add(uiSettings, 'fluidRegionWidth', 10, 20, 1)
        .name('Width (world X)')
        .onChange(onFluidVolumeChange);
    fluidVol
        .add(uiSettings, 'fluidRegionLength', 10, 100, 1)
        .name('Length (world Z)')
        .onChange(onFluidVolumeChange);
    fluidVol
        .add(uiSettings, 'fluidHeadroom', 4, 40, 0.5)
        .name('Ceiling headroom')
        .onChange(onFluidVolumeChange);
    fluidVol
        .add(uiSettings, 'fluidContainerLift', 0, 12, 0.05)
        .name('Lift above terrain')
        .onChange(onFluidVolumeChange);
    fluidVol.open();

    guiParticle
        .add(uiSettings, 'loopRiver')
        .name('Periodic wrap (Z)')
        .onChange((v) => {
            uniforms.u_periodicFlow.value = v ? 1.0 : 0.0;
        });
    guiParticle.add(uiSettings, 'flowAccel', 0, 14, 0.25).name('Flow along +Z').onChange((v) => {
        uniforms.u_flowAccel.value = v;
    });

    const sphFolder = guiParticle.addFolder('SPH physics');
    sphFolder
        .add(uniforms.u_smoothingRadius, 'value', 0.5, 3.0)
        .name('Smoothing radius')
        .onChange((v) => fluid.rebuildSpatialHash(v));
    sphFolder.add(uniforms.u_targetDensity, 'value', 1.0, 100.0).name('Target density');
    sphFolder.add(uniforms.u_pressureMultiplier, 'value', 1.0, 200.0).name('Pressure');
    sphFolder.add(uniforms.u_nearPressureMultiplier, 'value', 1.0, 50.0).name('Near pressure');
    sphFolder.add(uniforms.u_viscosityMultiplier, 'value', 0.0, 1.0).name('Viscosity');
    sphFolder.add(uniforms.u_gravity, 'value', -40.0, 0.0).name('Gravity');
    sphFolder.add(uniforms.u_collisionDamping, 'value', 0.0, 1.0).name('Wall damping');
    sphFolder.add(uniforms.u_agitation, 'value', 0.0, 5.0).name('Agitation');
    sphFolder.add(uniforms.u_cohesionStrength, 'value', 0.0, 1.0, 0.01)
        .name('Cohesion (surface tension)')
        .title('0 = repulsion only (no clumping). Raise slowly — >0.1 may cause instability.');
    sphFolder.open();

    const ballFolder = guiParticle.addFolder('Interaction ball');
    ballFolder.add(ballMesh.position, 'x', -35, 35).name('Ball X').listen();
    ballFolder.add(ballMesh.position, 'y', -5, 55).name('Ball Y').listen();
    ballFolder.add(ballMesh.position, 'z', -90, 90).name('Ball Z').listen();
    const ballRadiusProxy = { radius: 1.5 };
    ballFolder.add(ballRadiusProxy, 'radius', 0.5, 40.0, 0.1).name('Ball Scale (Radius)').onChange((v) => {
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

    // ── White Particles (Foam / Spray / Bubbles) ─────────────────────────────
    const wp = fluid.whiteParticleParams;
    const foamFolder = guiParticle.addFolder('White Particles (Foam)');
    foamFolder.add(wp, 'enabled').name('Enable foam/spray/bubbles')
        .onChange((v) => { if (!v) fluid._wpMesh.count = 0; });
    foamFolder.add(wp, 'spawnRate', 0.0, 20.0, 0.1).name('Spawn rate');
    foamFolder.add(wp, 'opacity', 0.0, 1.0, 0.01).name('Opacity')
        .onChange((v) => { if (fluid._wpMat) fluid._wpMat.uniforms.u_opacity.value = v; });
    foamFolder.add(wp, 'lifetimeMin', 0.5, 10.0, 0.1).name('Lifetime min (s)');
    foamFolder.add(wp, 'lifetimeMax', 1.0, 30.0, 0.5).name('Lifetime max (s)');
    foamFolder.add(wp, 'sprayMaxNbrs', 1, 20, 1).name('Spray threshold (nbrs ≤)');
    foamFolder.add(wp, 'bubbleMinNbrs', 5, 40, 1).name('Bubble threshold (nbrs ≥)');
    foamFolder.add(wp, 'bubbleBuoyancy', 0.0, 1.0, 0.01).name('Bubble buoyancy');
    foamFolder.open();

}
