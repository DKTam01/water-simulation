import * as THREE from 'three';
import { GPUComputationRenderer } from 'three/addons/misc/GPUComputationRenderer.js';

// ============================================================================
// Phase 2: White Particle (Foam / Spray / Bubble) System Constants
// ============================================================================
const MAX_WHITE_PARTICLES = 16384;  // fixed pool — large enough for splash-heavy scenes
const WP_LIFETIME_MIN = 2.0;    // seconds — faster dissolve for surface foam
const WP_LIFETIME_MAX = 8.0;    // cap keeps memory turnover fast
const WP_SPRAY_MAX_NBRS = 5;      // <= this many neighbours → spray (airborne)
const WP_BUBBLE_MIN_NBRS = 20;     // >= this many neighbours → bubble (submerged)
const WP_TRAPPED_AIR_SCALE = 2.5;   // spawn rate — lower = sparser, higher = denser foam
const WP_TRAPPED_AIR_MIN = 0.2;
const WP_TRAPPED_AIR_MAX = 4.0;
const WP_KE_MIN = 9.0;   // speed² floor — only fast particles (v > 3 m/s) spawn
const WP_KE_MAX = 100.0; // speed² ceiling (v = 10 m/s = fully active)
const WP_BUBBLE_BUOYANCY = 0.55;  // fraction of gravity cancelled for bubbles
const WP_DRAG_MULT = 0.035;

export class ParticleFluid {
    constructor(renderer, scene, uiSettings) {
        this.renderer = renderer;
        this.uiSettings = uiSettings;

        this.WIDTH = uiSettings.particleResolution || 64;
        this.particleCount = this.WIDTH * this.WIDTH;

        // --- SPH Parameters tuned for calm creek ---
        this.sphUniforms = {
            u_smoothingRadius: { value: 1.5 },
            u_targetDensity: { value: 5.0 },
            u_pressureMultiplier: { value: 18.0 },
            u_nearPressureMultiplier: { value: 8.0 },
            u_viscosityMultiplier: { value: 1.00 },  // higher for gentle laminar flow
            u_mass: { value: 1.0 },
            u_resolution: { value: new THREE.Vector2(this.WIDTH, this.WIDTH) },
            u_boxSize: { value: 11.0 },
            u_maxBoxSize: { value: 128.0 },
            u_ballPosition: { value: new THREE.Vector3(0, 0, 0) },
            u_ballRadius: { value: 1.5 },
            u_time: { value: 0.0 },
            u_deltaTime: { value: 0.016 },
            u_gravity: { value: -9.8 },
            u_collisionDamping: { value: 0.55 },     // more energy absorbed on terrain bounce

            u_agitation: { value: 0.0 },            // zero at startup — set via GUI

            u_tankMatrixWorld: { value: new THREE.Matrix4() },
            u_tankMatrixWorldInverse: { value: new THREE.Matrix4() },

            u_periodicFlow: { value: 0.0 },
            u_flowPeriodWorld: { value: 40.0 },
            u_flowAccel: { value: 0.0 },

            u_baseYOffset: { value: 0.0 },
            u_baseBumpAmp: { value: 0.12 },
            u_baseBumpFreq: { value: 0.06 },
            u_baseTiltX: { value: 0.0 },
            u_baseTiltZ: { value: 0.0 },

            u_rockPositions: {
                value: [
                    new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(),
                    new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(),
                ]
            },
            u_rockRadii: { value: [0, 0, 0, 0, 0, 0] },

            // Local-Z (OBB space) landing point when periodic Z wrap teleports particles.
            u_wrapDestLocalZ: { value: 0.0 },

            // Cohesion: 0.0 = repulsion-only (stable), 1.0 = full Unity-style
            // negative pressure. Values 0.0–0.15 are recommended to prevent clumping.
            u_cohesionStrength: { value: 0.0 },
        };

        this.cellTextureWidth = 1024;
        this.sortedIndicesData = new Float32Array(this.particleCount * 4);
        this.gpuReadBuffer = new Float32Array(this.particleCount * 4);

        // World-space tank centre used to seed particle spawn on the baseplate.
        // Set by syncFluidTank (environment.js) before resetParticles is called.
        this.spawnOrigin = new THREE.Vector3(0, 0, 0);

        // Performance: track max speed across frames without full velocity readback.
        this._estimatedMaxSpeed = 5.0;
        this._hashStagger = 1;     // rebuild hash every N frames (1 = every frame)
        this._frameCounter = 0;

        // Build spatial hash grid arrays — extracted so we can rebuild live when
        // the smoothing radius slider changes.
        this._buildGrid(this.sphUniforms.u_smoothingRadius.value);

        // ── White particle CPU-side pool ──────────────────────────────────────
        // Each slot: Float32 layout = [px, py, pz, vx, vy, vz, lifetime, maxLifetime, type, scale, 0, 0]
        //   type: 0 = inactive, 1 = foam, 2 = spray, 3 = bubble
        this._wpPool = new Float32Array(MAX_WHITE_PARTICLES * 12);
        this._wpActive = 0;   // number of active white particles this frame
        this._wpReadBuffer = new Float32Array(this.particleCount * 4); // velocity readback
        // Expose params for GUI tuning
        this.whiteParticleParams = {
            enabled: false,
            spawnRate: WP_TRAPPED_AIR_SCALE,
            lifetimeMin: WP_LIFETIME_MIN,
            lifetimeMax: WP_LIFETIME_MAX,
            sprayMaxNbrs: WP_SPRAY_MAX_NBRS,
            bubbleMinNbrs: WP_BUBBLE_MIN_NBRS,
            bubbleBuoyancy: WP_BUBBLE_BUOYANCY,
            opacity: 0.82,   // slightly opaque — additive blending keeps it subtle
        };

        this.initGPGPU();
        this.initParticles(scene);
        this.initWhiteParticles(scene);
    }

    // ========================================================================
    // SPATIAL HASH GRID — can be rebuilt at runtime when smoothingRadius changes
    // ========================================================================
    _buildGrid(smoothingRadius) {
        const maxBoxSize = this.sphUniforms.u_maxBoxSize.value;
        this.cellSize = smoothingRadius;
        this.gridSize = Math.ceil((maxBoxSize * 2.0) / this.cellSize);
        this.totalCells = this.gridSize * this.gridSize * this.gridSize;
        this.cellTextureHeight = Math.ceil(this.totalCells / this.cellTextureWidth);

        this.cellOffsets = new Uint32Array(this.totalCells);
        this.cellCounts = new Uint32Array(this.totalCells);
        this.cellTextureData = new Float32Array(
            this.cellTextureWidth * this.cellTextureHeight * 4
        );
    }

    // Called from the GUI's smoothingRadius onChange handler in main.js.
    // Rebuilds all grid structures and synchronises shader uniforms.
    rebuildSpatialHash(newRadius) {
        this.sphUniforms.u_smoothingRadius.value = newRadius;
        this._buildGrid(newRadius);

        // Dispose the old cell texture so GPU memory is freed.
        if (this.cellTexture) this.cellTexture.dispose();

        this.cellTexture = new THREE.DataTexture(
            this.cellTextureData,
            this.cellTextureWidth,
            this.cellTextureHeight,
            THREE.RGBAFormat,
            THREE.FloatType
        );
        this.cellTexture.minFilter = THREE.NearestFilter;
        this.cellTexture.magFilter = THREE.NearestFilter;

        // Push updated values to all SPH shader variables.
        const patch = {
            u_smoothingRadius: { value: newRadius },
            u_cellSize: { value: this.cellSize },
            u_gridSize: { value: this.gridSize },
            u_cellTexHeight: { value: this.cellTextureHeight },
            u_cellTexture: { value: this.cellTexture },
        };
        [
            this.predictedPositionVariable,
            this.densityVariable,
            this.pressureVelocityVariable,
            this.viscosityVelocityVariable,
            this.positionVariable,
        ].forEach(v => Object.assign(v.material.uniforms, patch));

        // Keep sphUniforms in sync so the GUI's live display is correct.
        Object.assign(this.sphUniforms, patch);
    }

    initGPGPU() {
        this.gpuCompute = new GPUComputationRenderer(this.WIDTH, this.WIDTH, this.renderer);
        this.gpuCompute.setDataType(THREE.FloatType);

        // Create initial data textures
        const dtPosition = this.gpuCompute.createTexture();
        const dtPredictedPosition = this.gpuCompute.createTexture();
        const dtPressureVelocity = this.gpuCompute.createTexture();
        const dtViscosityVelocity = this.gpuCompute.createTexture();
        const dtDensity = this.gpuCompute.createTexture();

        this.fillPositionTexture(dtPosition);
        this.fillPositionTexture(dtPredictedPosition); // seed predicted = raw positions
        this.fillVelocityTexture(dtPressureVelocity);
        this.fillVelocityTexture(dtViscosityVelocity); // seed viscosity vel = initial vel

        // Variables are added in pipeline execution order. GPUComputationRenderer
        // processes them sequentially in compute(), so a variable added earlier
        // provides current-frame values to variables added later in the same call.
        //
        // Pipeline order matches Unity:
        //   ExternalForces/Predict → Density → PressureForce → Viscosity → UpdatePositions
        this.predictedPositionVariable = this.gpuCompute.addVariable(
            'texturePredictedPosition', this.getPredictedPositionShader(), dtPredictedPosition
        );
        this.densityVariable = this.gpuCompute.addVariable(
            'textureDensity', this.getDensityShader(), dtDensity
        );
        this.pressureVelocityVariable = this.gpuCompute.addVariable(
            'texturePressureVelocity', this.getPressureVelocityShader(), dtPressureVelocity
        );
        this.viscosityVelocityVariable = this.gpuCompute.addVariable(
            'textureViscosityVelocity', this.getViscosityShader(), dtViscosityVelocity
        );
        this.positionVariable = this.gpuCompute.addVariable(
            'texturePosition', this.getPositionShader(), dtPosition
        );

        // Dependency graph — defines which sampler uniforms are auto-injected.
        // Variables with a lower add-index than the current variable supply
        // current-frame values; higher-index (or self) supply previous-frame values.
        this.gpuCompute.setVariableDependencies(this.predictedPositionVariable, [
            this.positionVariable,          // texturePosition        (prev frame)
            this.viscosityVelocityVariable, // textureViscosityVelocity (prev frame)
        ]);
        this.gpuCompute.setVariableDependencies(this.densityVariable, [
            this.predictedPositionVariable, // texturePredictedPosition (current frame)
        ]);
        this.gpuCompute.setVariableDependencies(this.pressureVelocityVariable, [
            this.predictedPositionVariable, // texturePredictedPosition (current frame)
            this.densityVariable,           // textureDensity           (current frame)
            this.viscosityVelocityVariable, // textureViscosityVelocity (prev frame final vel)
        ]);
        this.gpuCompute.setVariableDependencies(this.viscosityVelocityVariable, [
            this.predictedPositionVariable, // texturePredictedPosition (current frame)
            this.pressureVelocityVariable,  // texturePressureVelocity  (current frame)
            this.densityVariable,           // textureDensity           (current frame)
        ]);
        this.gpuCompute.setVariableDependencies(this.positionVariable, [
            this.positionVariable,          // texturePosition          (prev frame, self)
            this.viscosityVelocityVariable, // textureViscosityVelocity (current frame final vel)
        ]);

        // Spatial hash textures
        this.cellTexture = new THREE.DataTexture(
            this.cellTextureData,
            this.cellTextureWidth,
            this.cellTextureHeight,
            THREE.RGBAFormat,
            THREE.FloatType
        );
        this.cellTexture.minFilter = THREE.NearestFilter;
        this.cellTexture.magFilter = THREE.NearestFilter;

        this.sortedIndicesTexture = new THREE.DataTexture(
            this.sortedIndicesData, this.particleCount, 1, THREE.RGBAFormat, THREE.FloatType
        );
        this.sortedIndicesTexture.minFilter = THREE.NearestFilter;
        this.sortedIndicesTexture.magFilter = THREE.NearestFilter;

        Object.assign(this.sphUniforms, {
            u_gridSize: { value: this.gridSize },
            u_cellSize: { value: this.cellSize },
            u_cellTexture: { value: this.cellTexture },
            u_sortedIndices: { value: this.sortedIndicesTexture },
            u_cellTexWidth: { value: this.cellTextureWidth },
            u_cellTexHeight: { value: this.cellTextureHeight },
        });

        // Push all shared uniforms to every variable. Because Object.assign copies
        // object references (shallow), updating sphUniforms.u_xxx.value later will
        // automatically update all shader variables simultaneously.
        [
            this.predictedPositionVariable,
            this.densityVariable,
            this.pressureVelocityVariable,
            this.viscosityVelocityVariable,
            this.positionVariable,
        ].forEach(v => Object.assign(v.material.uniforms, this.sphUniforms));

        const error = this.gpuCompute.init();
        if (error !== null) {
            console.error('GPUComputationRenderer init error:', error);
        }
    }

    fillPositionTexture(texture, preset = 'default') {
        const data = texture.image.data;
        const boxSize = this.sphUniforms.u_boxSize.value;

        if (preset === 'wave') {
            // Angled water slab for a curling wave — particles on the left,
            // tilted up so the top-left is high and the bottom-right is low.
            const edgeX = 16, edgeZ = 24, spacing = 0.45;
            const offsetZ = -(edgeZ - 1) / 2.0 * spacing;
            for (let i = 0; i < this.particleCount; i++) {
                const idx = i * 4;
                const x = i % edgeX;
                const z = Math.floor(i / edgeX) % edgeZ;
                const y = Math.floor(i / (edgeX * edgeZ));
                const jitter = () => (Math.random() - 0.5) * 0.1;
                const tiltY = (1.0 - x / edgeX) * boxSize * 0.5;
                data[idx + 0] = -boxSize + 1.0 + x * spacing + jitter();
                data[idx + 1] = 0.5 + y * spacing + tiltY + jitter();
                data[idx + 2] = offsetZ + z * spacing + jitter();
                data[idx + 3] = 1.0;
            }
        } else {
            // Spawn a compact blob at the upstream end of the upper channel.
            // Z layout starts AT oz (upstream edge) and extends downstream — no
            // particles are placed behind the spawn origin, preventing any particle
            // from landing outside the OBB and wrapping to the far (lower) end.
            const edgeX = 22, edgeZ = 32, spacing = 0.52;
            const offsetX = (edgeX - 1) / 2.0;   // centre X on spawnOrigin.x
            const ox = this.spawnOrigin.x;
            const oy = this.spawnOrigin.y;
            const oz = this.spawnOrigin.z;         // oz is the upstream START of the blob
            for (let i = 0; i < this.particleCount; i++) {
                const idx = i * 4;
                const x = i % edgeX;
                const z = Math.floor(i / edgeX) % edgeZ;
                const y = Math.floor(i / (edgeX * edgeZ));
                const jitter = () => (Math.random() - 0.5) * 0.12;
                data[idx + 0] = ox + (x - offsetX) * spacing + jitter();
                data[idx + 1] = oy + y * spacing + jitter();
                data[idx + 2] = oz + z * spacing + jitter();   // all particles at oz or downstream
                data[idx + 3] = 1.0;
            }
        }
    }

    fillVelocityTexture(texture, preset = 'default') {
        const data = texture.image.data;
        if (preset === 'wave') {
            for (let k = 0; k < data.length; k += 4) {
                data[k + 0] = 12.0 + (Math.random() - 0.5) * 3.0;  // strong rightward surge
                data[k + 1] = 3.0 + (Math.random() - 0.5) * 2.0;  // slight upward lift
                data[k + 2] = (Math.random() - 0.5) * 2.0;
                data[k + 3] = 1.0;
            }
        } else {
            // Near-zero initial velocity so the spawn blob settles onto the baseplate
            // under gravity/pressure without blasting particles into the lower channel.
            for (let k = 0; k < data.length; k += 4) {
                data[k + 0] = (Math.random() - 0.5) * 0.5;
                data[k + 1] = -(Math.random() * 1.0);  // small downward component
                data[k + 2] = (Math.random() - 0.5) * 0.5;
                data[k + 3] = 1.0;
            }
        }
    }

    // Re-initialise particle positions and velocities from a preset without
    // re-creating the entire GPGPU pipeline.
    resetParticles(preset = 'default') {
        const posTexture = this.gpuCompute.createTexture();
        const velTexture = this.gpuCompute.createTexture();
        this.fillPositionTexture(posTexture, preset);
        this.fillVelocityTexture(velTexture, preset);

        // Reset raw and predicted position render targets
        this.gpuCompute.renderTexture(posTexture,
            this.gpuCompute.getCurrentRenderTarget(this.positionVariable));
        this.gpuCompute.renderTexture(posTexture,
            this.gpuCompute.getCurrentRenderTarget(this.predictedPositionVariable));

        // Reset all velocity-stage render targets so the first frame computes correctly
        this.gpuCompute.renderTexture(velTexture,
            this.gpuCompute.getCurrentRenderTarget(this.viscosityVelocityVariable));
        this.gpuCompute.renderTexture(velTexture,
            this.gpuCompute.getCurrentRenderTarget(this.pressureVelocityVariable));
    }

    // ========================================================================
    // WHITE PARTICLES — CPU physics + InstancedMesh rendering
    // ========================================================================

    initWhiteParticles(scene) {
        // Billboard quad (2 triangles, always faces camera in vertex shader)
        const geo = new THREE.PlaneGeometry(1, 1);

        const mat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            vertexShader: /* glsl */ `
                attribute float wp_lifetime;     // remaining / maxLifetime (0..1)
                attribute float wp_type;         // 1=foam, 2=spray, 3=bubble
                attribute float wp_scale;
                varying  float vAlpha;
                varying  float vType;

                void main() {
                    vAlpha = wp_lifetime * wp_lifetime; // quadratic fade
                    vType  = wp_type;

                    // Billboard: ignore model rotation, use camera right/up
                    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
                    vec3 up    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
                    vec3 worldPos = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
                    float sz = wp_scale * 0.28;
                    vec3 vPos = worldPos + right * position.x * sz + up * position.y * sz;
                    gl_Position = projectionMatrix * viewMatrix * vec4(vPos, 1.0);
                }
            `,
            fragmentShader: /* glsl */ `
                uniform float u_opacity;
                varying float vAlpha;
                varying float vType;

                void main() {
                    // Soft circular disc
                    vec2 uv = gl_PointCoord;
                    // Colors by type: 1=foam(white), 2=spray(sky), 3=bubble(aqua)
                    vec3 col = vType < 1.5
                        ? vec3(1.0, 1.0, 1.0)           // foam
                        : vType < 2.5
                            ? vec3(0.8, 0.92, 1.0)       // spray (cool white)
                            : vec3(0.5, 0.85, 1.0);      // bubble (aqua)
                    gl_FragColor = vec4(col, vAlpha * u_opacity);
                }
            `,
            uniforms: {
                u_opacity: { value: this.whiteParticleParams.opacity },
            },
        });

        // Per-instance attributes
        this._wpLifetimeAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_WHITE_PARTICLES), 1);
        this._wpTypeAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_WHITE_PARTICLES), 1);
        this._wpScaleAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_WHITE_PARTICLES), 1);
        geo.setAttribute('wp_lifetime', this._wpLifetimeAttr);
        geo.setAttribute('wp_type', this._wpTypeAttr);
        geo.setAttribute('wp_scale', this._wpScaleAttr);

        this._wpMesh = new THREE.InstancedMesh(geo, mat, MAX_WHITE_PARTICLES);
        this._wpMesh.frustumCulled = false;
        this._wpMesh.count = 0;
        this._wpMesh.name = 'WhiteParticles';
        this._wpMat = mat;
        scene.add(this._wpMesh);

        // Scratch transform for per-instance matrix
        this._wpMatrix = new THREE.Matrix4();
    }

    /**
     * Step the CPU-side white particle pool one frame.
     * Must be called AFTER the SPH spatial hash readback (gpuReadBuffer = positions,
     * _wpReadBuffer = velocities) so we can sample neighbour counts.
     *
     * @param {number} dt           frame delta time (seconds)
     * @param {Float32Array} posBuf predicted-position readback [x,y,z,w, ...]
     * @param {Float32Array} velBuf velocity readback [vx,vy,vz,w, ...]
     * @param {number} gravity      current gravity scalar (negative)
     */
    updateWhiteParticles(dt, posBuf, velBuf, gravity) {
        const wp = this.whiteParticleParams;
        if (!wp.enabled) { this._wpMesh.count = 0; return; }

        const STRIDE = 12;
        const h = this.sphUniforms.u_smoothingRadius.value;
        const hSq = h * h;

        // ------------------------------------------------------------------
        // 1.  STEP existing particles (physics)
        // ------------------------------------------------------------------
        let alive = 0;
        for (let i = 0; i < this._wpActive; i++) {
            const b = i * STRIDE;
            const remaining = this._wpPool[b + 6];
            if (remaining <= 0) continue;  // dead

            const type = this._wpPool[b + 8]; // 1=foam,2=spray,3=bubble

            let vx = this._wpPool[b + 3];
            let vy = this._wpPool[b + 4];
            let vz = this._wpPool[b + 5];

            // Determine neighbour count for this white particle using the spatial hash
            const px = this._wpPool[b + 0];
            const py = this._wpPool[b + 1];
            const pz = this._wpPool[b + 2];

            const limit = this.sphUniforms.u_maxBoxSize.value;
            const cx0 = Math.max(0, Math.min(Math.floor((px + limit) / h), this.gridSize - 1));
            const cy0 = Math.max(0, Math.min(Math.floor((py) / h), this.gridSize - 1));
            const cz0 = Math.max(0, Math.min(Math.floor((pz + limit) / h), this.gridSize - 1));

            let nbrs = 0;
            let velSumX = 0, velSumY = 0, velSumZ = 0, wSum = 0;

            for (let dz = -1; dz <= 1; dz++) {
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const nx = cx0 + dx, ny = cy0 + dy, nz = cz0 + dz;
                        if (nx < 0 || nx >= this.gridSize ||
                            ny < 0 || ny >= this.gridSize ||
                            nz < 0 || nz >= this.gridSize) continue;

                        const hash = nx + ny * this.gridSize + nz * this.gridSize * this.gridSize;
                        const start = this.cellOffsets[hash];
                        if (start === 999999) continue;
                        const end = start + this.cellCounts[hash];

                        for (let si = start; si < end; si++) {
                            const fid = this.sortedIndicesData[si * 4];
                            const fi = fid * 4;
                            const fx = posBuf[fi], fy = posBuf[fi + 1], fz = posBuf[fi + 2];
                            const dx2 = fx - px, dy2 = fy - py, dz2 = fz - pz;
                            const d2 = dx2 * dx2 + dy2 * dy2 + dz2 * dz2;
                            if (d2 < hSq) {
                                const d = Math.sqrt(d2);
                                const w = (h - d) / h;  // linear kernel weight
                                const vi = fid * 4;
                                velSumX += velBuf[vi] * w;
                                velSumY += velBuf[vi + 1] * w;
                                velSumZ += velBuf[vi + 2] * w;
                                wSum += w;
                                nbrs++;
                            }
                        }
                    }
                }
            }

            // Re-classify based on live neighbour count
            let newType;
            if (nbrs <= wp.sprayMaxNbrs) newType = 2; // spray
            else if (nbrs >= wp.bubbleMinNbrs) newType = 3; // bubble
            else newType = 1; // foam

            this._wpPool[b + 8] = newType;

            // Physics per type (matches Unity UpdateWhiteParticles)
            if (newType === 1) {
                // Foam: carried by fluid, dissolves
                if (wSum > 0.001) {
                    vx = velSumX / wSum;
                    vy = velSumY / wSum;
                    vz = velSumZ / wSum;
                }
                this._wpPool[b + 6] = remaining - dt;  // dissolve
            } else if (newType === 3) {
                // Bubble: buoyancy + fluid drag
                const buoyancyY = gravity * (1.0 - wp.bubbleBuoyancy);
                const avgVx = wSum > 0.001 ? velSumX / wSum : 0;
                const avgVy = wSum > 0.001 ? velSumY / wSum : 0;
                const avgVz = wSum > 0.001 ? velSumZ / wSum : 0;
                const fluidAcc = 3.0;
                vx += ((avgVx - vx) * fluidAcc + 0) * dt;
                vy += ((avgVy - vy) * fluidAcc + buoyancyY) * dt;
                vz += ((avgVz - vz) * fluidAcc + 0) * dt;
                this._wpPool[b + 6] = remaining - dt;
            } else {
                // Spray: gravity + drag
                const spSq = vx * vx + vy * vy + vz * vz;
                const spLen = Math.sqrt(spSq) || 1e-6;
                const drag = WP_DRAG_MULT * spSq;
                vx += (-(vx / spLen) * drag) * dt;
                vy += (gravity - (vy / spLen) * drag) * dt;
                vz += (-(vz / spLen) * drag) * dt;
                this._wpPool[b + 6] = remaining - dt;
            }

            this._wpPool[b + 0] += vx * dt;
            this._wpPool[b + 1] += vy * dt;
            this._wpPool[b + 2] += vz * dt;

            // Apply baseplate terrain collision
            const px_new = this._wpPool[b + 0];
            let py_new = this._wpPool[b + 1];
            const pz_new = this._wpPool[b + 2];

            const u = this.sphUniforms;
            const ripple = u.u_baseBumpAmp.value * Math.sin(px_new * u.u_baseBumpFreq.value) * Math.cos(pz_new * u.u_baseBumpFreq.value);
            const floorY = u.u_baseYOffset.value + ripple - px_new * u.u_baseTiltX.value - pz_new * u.u_baseTiltZ.value + 0.15;

            if (py_new < floorY) {
                py_new = floorY;
                if (vy < 0) vy *= -0.5; // dampen and bounce
            }

            this._wpPool[b + 1] = py_new;
            this._wpPool[b + 3] = vx;
            this._wpPool[b + 4] = vy;
            this._wpPool[b + 5] = vz;

            // Compact: move alive particle to front
            if (this._wpPool[b + 6] > 0) {
                const dst = alive * STRIDE;
                if (dst !== b) {
                    for (let k = 0; k < STRIDE; k++) this._wpPool[dst + k] = this._wpPool[b + k];
                }
                alive++;
            }
        }
        this._wpActive = alive;

        // ------------------------------------------------------------------
        // 2.  SPAWN new white particles from fluid particles
        // ------------------------------------------------------------------
        const spawnRate = wp.spawnRate;
        const lifeMin = wp.lifetimeMin;
        const lifeMax = wp.lifetimeMax;
        const rh = 1.0 / h;

        for (let i = 0; i < this.particleCount && this._wpActive < MAX_WHITE_PARTICLES; i++) {
            const fi = i * 4;
            const px2 = posBuf[fi], py2 = posBuf[fi + 1], pz2 = posBuf[fi + 2];
            const vxi = velBuf[fi], vyi = velBuf[fi + 1], vzi = velBuf[fi + 2];
            const speed2 = vxi * vxi + vyi * vyi + vzi * vzi;

            // Kinetic energy factor
            const keFactor = Math.max(0, Math.min(1, (speed2 - WP_KE_MIN) / (WP_KE_MAX - WP_KE_MIN)));
            if (keFactor < 0.001) continue;

            // Trapped air: approximate via speed alone if we haven't computed per-pair WVD
            // (full WVD is expensive on CPU; approximate as keFactor * speed divergence heuristic)
            const nbrsI = this._getNeighbourCount(i, px2, py2, pz2, hSq);
            const airFactor = Math.max(0, Math.min(1, (nbrsI < 12 ? 0.8 : 0.3)));  // fewer nbrs = more air

            const spawnCount = spawnRate * airFactor * keFactor * dt;
            const spawnInt = Math.floor(spawnCount);
            const spawnFrac = spawnCount - spawnInt;
            const n = spawnInt + (Math.random() < spawnFrac ? 1 : 0);

            for (let s = 0; s < n && this._wpActive < MAX_WHITE_PARTICLES; s++) {
                const slot = this._wpActive * STRIDE;
                const life = lifeMin + Math.random() * (lifeMax - lifeMin);
                // Random perpendicular offset within smoothing radius
                const angle = Math.random() * Math.PI * 2;
                const r = Math.sqrt(Math.random()) * h * 0.5;
                this._wpPool[slot + 0] = px2 + Math.cos(angle) * r;
                this._wpPool[slot + 1] = py2 + (Math.random() - 0.5) * h * 0.3;
                this._wpPool[slot + 2] = pz2 + Math.sin(angle) * r;
                this._wpPool[slot + 3] = vxi + (Math.random() - 0.5) * 0.8;
                this._wpPool[slot + 4] = vyi + Math.random() * 0.4;
                this._wpPool[slot + 5] = vzi + (Math.random() - 0.5) * 0.8;
                this._wpPool[slot + 6] = life;  // remaining lifetime
                this._wpPool[slot + 7] = life;  // max lifetime
                this._wpPool[slot + 8] = 2;     // default: spray
                this._wpPool[slot + 9] = 0.6 + Math.random() * 0.8;
                this._wpPool[slot + 10] = 0;
                this._wpPool[slot + 11] = 0;
                this._wpActive++;
            }
        }

        // ------------------------------------------------------------------
        // 3.  Upload to InstancedMesh
        // ------------------------------------------------------------------
        this._wpMesh.count = this._wpActive;
        const dummy = this._wpMatrix;

        for (let i = 0; i < this._wpActive; i++) {
            const b = i * STRIDE;
            dummy.makeTranslation(this._wpPool[b], this._wpPool[b + 1], this._wpPool[b + 2]);
            this._wpMesh.setMatrixAt(i, dummy);

            const lifeFrac = Math.max(0, this._wpPool[b + 6] / this._wpPool[b + 7]);
            this._wpLifetimeAttr.array[i] = lifeFrac;
            this._wpTypeAttr.array[i] = this._wpPool[b + 8];
            this._wpScaleAttr.array[i] = this._wpPool[b + 9];
        }

        if (this._wpActive > 0) {
            this._wpMesh.instanceMatrix.needsUpdate = true;
            this._wpLifetimeAttr.needsUpdate = true;
            this._wpTypeAttr.needsUpdate = true;
            this._wpScaleAttr.needsUpdate = true;
        }
    }

    /** Fast neighbour count (no weighted sum) — for spawn probability only. */
    _getNeighbourCount(selfId, px, py, pz, hSq) {
        const limit = this.sphUniforms.u_maxBoxSize.value;
        const h = Math.sqrt(hSq);
        const cx0 = Math.max(0, Math.min(Math.floor((px + limit) / h), this.gridSize - 1));
        const cy0 = Math.max(0, Math.min(Math.floor((py) / h), this.gridSize - 1));
        const cz0 = Math.max(0, Math.min(Math.floor((pz + limit) / h), this.gridSize - 1));
        let count = 0;
        for (let dz = -1; dz <= 1; dz++)
            for (let dy = -1; dy <= 1; dy++)
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = cx0 + dx, ny = cy0 + dy, nz = cz0 + dz;
                    if (nx < 0 || nx >= this.gridSize || ny < 0 || ny >= this.gridSize || nz < 0 || nz >= this.gridSize) continue;
                    const hash = nx + ny * this.gridSize + nz * this.gridSize * this.gridSize;
                    const start = this.cellOffsets[hash];
                    if (start === 999999) continue;
                    const end = start + this.cellCounts[hash];
                    for (let si = start; si < end; si++) {
                        const fid = this.sortedIndicesData[si * 4];
                        if (fid === selfId) continue;
                        const fi = fid * 4;
                        const ddx = this.gpuReadBuffer[fi] - px;
                        const ddy = this.gpuReadBuffer[fi + 1] - py;
                        const ddz = this.gpuReadBuffer[fi + 2] - pz;
                        if (ddx * ddx + ddy * ddy + ddz * ddz < hSq) count++;
                    }
                }
        return count;
    }

    initParticles(scene) {
        const geometry = new THREE.SphereGeometry(0.2, 8, 8);
        const uvs = new Float32Array(this.particleCount * 2);
        for (let i = 0; i < this.particleCount; i++) {
            uvs[i * 2 + 0] = ((i % this.WIDTH) + 0.5) / this.WIDTH;
            uvs[i * 2 + 1] = (Math.floor(i / this.WIDTH) + 0.5) / this.WIDTH;
        }
        geometry.setAttribute('particleUV', new THREE.InstancedBufferAttribute(uvs, 2));

        const material = new THREE.MeshStandardMaterial({
            roughness: 0.3,
            metalness: 0.1
        });

        this.commonUniforms = {
            texturePosition: { value: null },
            textureVelocity: { value: null },
            textureDensity: { value: null }
        };

        material.onBeforeCompile = (shader) => {
            shader.uniforms.texturePosition = this.commonUniforms.texturePosition;
            shader.uniforms.textureVelocity = this.commonUniforms.textureVelocity;

            shader.vertexShader = `
                uniform sampler2D texturePosition;
                uniform sampler2D textureVelocity;
                attribute vec2 particleUV;
                varying vec3 vParticleColor;
                ${shader.vertexShader}
            `.replace(
                `#include <begin_vertex>`,
                `#include <begin_vertex>
                vec4 posData = texture2D(texturePosition, particleUV);
                vec4 velData = texture2D(textureVelocity, particleUV);
                transformed = posData.xyz + position;
                
                float speed = length(velData.xyz);
                float normSpeed = clamp(speed / 30.0, 0.0, 1.0);
                
                vec3 col1 = vec3(0.0, 0.3, 0.7);
                vec3 col2 = vec3(0.0, 0.6, 0.9);
                vec3 col3 = vec3(0.2, 0.9, 1.0);
                vec3 col4 = vec3(1.0, 1.0, 1.0);
                
                vec3 finalColor;
                if (normSpeed < 0.33) {
                    finalColor = mix(col1, col2, normSpeed / 0.33);
                } else if (normSpeed < 0.66) {
                    finalColor = mix(col2, col3, (normSpeed - 0.33) / 0.33);
                } else {
                    finalColor = mix(col3, col4, (normSpeed - 0.66) / 0.34);
                }
                
                vParticleColor = finalColor;
                `
            );

            shader.fragmentShader = `
                varying vec3 vParticleColor;
                ${shader.fragmentShader}
            `.replace(
                `vec4 diffuseColor = vec4( diffuse, opacity );`,
                `vec4 diffuseColor = vec4( vParticleColor, opacity );`
            );
        };

        this.mesh = new THREE.InstancedMesh(geometry, material, this.particleCount);
        this.mesh.frustumCulled = false;
        scene.add(this.mesh);
    }

    // ========================================================================
    // DENSITY SHADER (matches Unity CalculateDensities kernel)
    // Uses PREDICTED positions for all neighbour lookups — critical for stability.
    // The spatial hash is also built from predicted positions, so lookups match.
    // ========================================================================
    getDensityShader() {
        return `
            uniform float u_smoothingRadius;
            uniform float u_mass;
            uniform vec2 u_resolution;
            uniform float u_maxBoxSize;
            uniform float u_gridSize;
            uniform float u_cellSize;
            uniform float u_cellTexWidth;
            uniform float u_cellTexHeight;
            uniform sampler2D u_cellTexture;
            uniform sampler2D u_sortedIndices;
            uniform float u_periodicFlow;
            uniform float u_flowPeriodWorld;

            // SpikyPow2  (h-r)^2 — density kernel, normalization 15/(2πh^5)
            float SpikyKernelPow2(float dst, float h) {
                if (dst >= h) return 0.0;
                float v = h - dst;
                return v * v * (15.0 / (2.0 * 3.14159265 * h * h * h * h * h));
            }

            // SpikyPow3  (h-r)^3 — near-density kernel, normalization 15/(πh^6)
            float SpikyKernelPow3(float dst, float h) {
                if (dst >= h) return 0.0;
                float v = h - dst;
                return v * v * v * (15.0 / (3.14159265 * h * h * h * h * h * h));
            }

            void main() {
                vec2 uv = gl_FragCoord.xy / resolution.xy;
                // Read PREDICTED position — matches Unity CalculateDensities
                // which reads PredictedPositions, not Positions.
                vec3 pos1 = texture2D(texturePredictedPosition, uv).xyz;
                float density    = 0.0;
                float nearDensity = 0.0;

                ivec3 cellCoords = ivec3(floor((pos1 + vec3(u_maxBoxSize, 0.0, u_maxBoxSize)) / u_cellSize));

                for (int z = -1; z <= 1; z++) {
                    for (int y = -1; y <= 1; y++) {
                        for (int x = -1; x <= 1; x++) {
                            ivec3 neighbor = cellCoords + ivec3(x, y, z);
                            if (neighbor.x < 0 || neighbor.x >= int(u_gridSize) ||
                                neighbor.y < 0 || neighbor.y >= int(u_gridSize) ||
                                neighbor.z < 0 || neighbor.z >= int(u_gridSize)) continue;

                            int hash = neighbor.x + (neighbor.y * int(u_gridSize)) + (neighbor.z * int(u_gridSize) * int(u_gridSize));

                            float ty = floor(float(hash) / u_cellTexWidth);
                            float tx = mod(float(hash), u_cellTexWidth);
                            vec2 cellUV = vec2((tx + 0.5) / u_cellTexWidth, (ty + 0.5) / u_cellTexHeight);

                            float startFloat = texture2D(u_cellTexture, cellUV).r;
                            if (startFloat > 999998.0) continue;
                            uint startIndex = uint(startFloat);

                            float endFloat = texture2D(u_cellTexture, cellUV).g;
                            uint endIndex  = uint(endFloat);

                            for (uint i = startIndex; i < endIndex; i++) {
                                float origId = texelFetch(u_sortedIndices, ivec2(int(i), 0), 0).r;
                                vec2 uv2 = vec2(
                                    (mod(origId, u_resolution.x) + 0.5) / u_resolution.x,
                                    (floor(origId / u_resolution.x) + 0.5) / u_resolution.y
                                );
                                // Read PREDICTED neighbour position
                                vec3 pos2 = texture2D(texturePredictedPosition, uv2).xyz;
                                vec3 d12 = pos1 - pos2;
                                if (u_periodicFlow > 0.5) {
                                    d12.z -= u_flowPeriodWorld * round(d12.z / u_flowPeriodWorld);
                                }
                                float dst = length(d12);
                                if (dst < u_smoothingRadius) {
                                    density     += u_mass * SpikyKernelPow2(dst, u_smoothingRadius);
                                    nearDensity += u_mass * SpikyKernelPow3(dst, u_smoothingRadius);
                                }
                            }
                        }
                    }
                }
                gl_FragColor = vec4(max(density, 0.001), max(nearDensity, 0.001), 0.0, 1.0);
            }
        `;
    }

    // ========================================================================
    // PREDICTED POSITION SHADER (matches Unity ExternalForces kernel)
    // Applies gravity to the previous-frame final velocity, then predicts where
    // each particle will be 1/120 s into the future.  All subsequent passes
    // (density, pressure, viscosity) use these predicted positions for neighbour
    // lookups, which dramatically stabilises the pressure solver.
    // ========================================================================
    getPredictedPositionShader() {
        return `
            uniform float u_gravity;
            uniform float u_deltaTime;

            void main() {
                vec2 uv = gl_FragCoord.xy / resolution.xy;

                // Previous frame's raw position + teleport flag
                vec4 posData       = texture2D(texturePosition, uv);
                vec3 rawPos        = posData.xyz;
                float teleportFlag = posData.w;

                // Previous frame's final velocity (after viscosity)
                vec3 vel = texture2D(textureViscosityVelocity, uv).xyz;

                // Apply gravity first — mirrors Unity ExternalForces:
                //   Velocities[id.x] += float3(0, gravity, 0) * deltaTime;
                vel.y += u_gravity * u_deltaTime;

                // Look-ahead: predict position 1/120 s ahead — matches Unity:
                //   PredictedPositions[id.x] = Positions[id.x] + Velocities[id.x] / 120.0;
                vec3 predictedPos = rawPos + vel * (1.0 / 120.0);

                // Pass teleport flag through in .w so the pressure shader can
                // detect wrap-around events and reset particle velocity.
                gl_FragColor = vec4(predictedPos, teleportFlag);
            }
        `;
    }

    // ========================================================================
    // PRESSURE VELOCITY SHADER (matches Unity CalculatePressureForce kernel)
    // Reads PREDICTED positions for all neighbour lookups.  Gravity is already
    // accounted for by re-applying it to the starting velocity here (mirrors the
    // ExternalForces → PressureForce ordering in Unity).  Viscosity is handled
    // separately in getViscosityShader() which runs after this pass.
    // ========================================================================
    getPressureVelocityShader() {
        return `
            uniform float u_smoothingRadius;
            uniform float u_targetDensity;
            uniform float u_pressureMultiplier;
            uniform float u_nearPressureMultiplier;
            uniform float u_mass;
            uniform vec2 u_resolution;
            uniform float u_gravity;
            uniform float u_deltaTime;
            uniform float u_gridSize;
            uniform float u_cellSize;
            uniform sampler2D u_cellTexture;
            uniform sampler2D u_sortedIndices;
            uniform float u_maxBoxSize;
            uniform float u_cellTexWidth;
            uniform float u_cellTexHeight;
            uniform float u_collisionDamping;

            uniform vec3 u_ballPosition;
            uniform float u_ballRadius;

            // Accent rocks: fixed array of 6 spheres (unused slots have radius 0)
            uniform vec3 u_rockPositions[6];
            uniform float u_rockRadii[6];

            uniform float u_time;
            uniform float u_agitation;
            uniform float u_cohesionStrength;

            uniform mat4 u_tankMatrixWorld;
            uniform mat4 u_tankMatrixWorldInverse;
            uniform float u_periodicFlow;
            uniform float u_flowPeriodWorld;
            uniform float u_flowAccel;
            uniform float u_baseYOffset;
            uniform float u_baseBumpAmp;
            uniform float u_baseBumpFreq;
            uniform float u_baseTiltX;
            uniform float u_baseTiltZ;

            float terrainHeight(float x, float z) {
                float ripple = u_baseBumpAmp * sin(x * u_baseBumpFreq) * cos(z * u_baseBumpFreq);

                // Add hills that blend with the terrain
                float hillHeight = 0.0;

                // Hill positions and properties (must match JavaScript)
                vec3 hills[4];
                hills[0] = vec3(-25.0, -25.0, 8.0);  // x, z, height
                hills[1] = vec3(25.0, -15.0, 6.0);
                hills[2] = vec3(-15.0, 20.0, 7.0);
                hills[3] = vec3(30.0, 25.0, 5.0);

                float hillRadii[4];
                hillRadii[0] = 12.0;
                hillRadii[1] = 10.0;
                hillRadii[2] = 14.0;
                hillRadii[3] = 8.0;

                // Calculate height contribution from each hill
                for (int i = 0; i < 4; i++) {
                    float dx = x - hills[i].x;
                    float dz = z - hills[i].y;
                    float distance = sqrt(dx * dx + dz * dz);

                    if (distance < hillRadii[i]) {
                        float normalizedDist = distance / hillRadii[i];
                        float slopeFactor = 1.0 - normalizedDist * normalizedDist;
                        hillHeight += hills[i].z * slopeFactor;
                    }
                }

                return u_baseYOffset + ripple + hillHeight - x * u_baseTiltX - z * u_baseTiltZ;
            }

            // Derivative of (h-r)^2 — pressure gradient
            float DerivativeSpikyPow2(float dst, float h) {
                if (dst >= h || dst < 0.001) return 0.0;
                float v = h - dst;
                return -v * (15.0 / (3.14159265 * h * h * h * h * h));
            }

            // Derivative of (h-r)^3 — near-pressure gradient
            float DerivativeSpikyPow3(float dst, float h) {
                if (dst >= h || dst < 0.001) return 0.0;
                float v = h - dst;
                return -v * v * (45.0 / (3.14159265 * h * h * h * h * h * h));
            }

            void main() {
                vec2 uv = gl_FragCoord.xy / resolution.xy;

                // Use PREDICTED position for this particle
                vec4 predData = texture2D(texturePredictedPosition, uv);
                vec3 pos1     = predData.xyz;

                // Starting velocity = previous frame's final velocity + gravity.
                // Gravity is applied here to mirror Unity's ExternalForces → PressureForce order.
                vec3 vel1 = texture2D(textureViscosityVelocity, uv).xyz;
                vel1.y += u_gravity * u_deltaTime;

                // Detect periodic Z wrap-around and reset velocity
                if (predData.w < 0.5) {
                    float rng  = fract(sin(dot(uv, vec2(12.9898, 78.233))) * 43758.5453);
                    float rng2 = fract(sin(dot(uv + rng, vec2(39.346, 11.135))) * 24634.6415);
                    vel1 = vec3(
                        (rng - 0.5) * 1.4,
                        -0.55 - rng2 * 0.75,
                        u_flowAccel * 0.16 + rng2 * 0.45
                    );
                }

                vec2 densityData = texture2D(textureDensity, uv).rg;
                float dens1     = max(densityData.r, 0.001);
                float nearDens1 = max(densityData.g, 0.001);

                // Cohesion: negative pressure is gated by u_cohesionStrength (0=off, 1=full).
                // A small negative floor prevents low-density surface particles from clumping.
                float rawPress1  = (dens1 - u_targetDensity) * u_pressureMultiplier;
                float press1     = max(rawPress1, -abs(rawPress1) * u_cohesionStrength);
                float nearPress1 = nearDens1 * u_nearPressureMultiplier;

                vec3 pressureForce = vec3(0.0);
                int neighbourCount = 0;

                // Spatial hash neighbour search using predicted positions
                ivec3 cellCoords = ivec3(floor((pos1 + vec3(u_maxBoxSize, 0.0, u_maxBoxSize)) / u_cellSize));

                for (int z = -1; z <= 1; z++) {
                    for (int y = -1; y <= 1; y++) {
                        for (int x = -1; x <= 1; x++) {
                            ivec3 neighbor = cellCoords + ivec3(x, y, z);
                            if (neighbor.x < 0 || neighbor.x >= int(u_gridSize) ||
                                neighbor.y < 0 || neighbor.y >= int(u_gridSize) ||
                                neighbor.z < 0 || neighbor.z >= int(u_gridSize)) continue;

                            int hash = neighbor.x + (neighbor.y * int(u_gridSize)) + (neighbor.z * int(u_gridSize) * int(u_gridSize));
                            float ty = floor(float(hash) / u_cellTexWidth);
                            float tx = mod(float(hash), u_cellTexWidth);
                            vec2 cellUV = vec2((tx + 0.5) / u_cellTexWidth, (ty + 0.5) / u_cellTexHeight);

                            float startFloat = texture2D(u_cellTexture, cellUV).r;
                            if (startFloat > 999998.0) continue;
                            uint startIndex = uint(startFloat);

                            float endFloat = texture2D(u_cellTexture, cellUV).g;
                            uint endIndex  = uint(endFloat);

                            for (uint i = startIndex; i < endIndex; i++) {
                                float origId = texelFetch(u_sortedIndices, ivec2(int(i), 0), 0).r;
                                vec2 uv2 = vec2(
                                    (mod(origId, u_resolution.x) + 0.5) / u_resolution.x,
                                    (floor(origId / u_resolution.x) + 0.5) / u_resolution.y
                                );
                                if (distance(uv, uv2) < 0.001) continue; // skip self

                                // Read PREDICTED neighbour position
                                vec3 pos2 = texture2D(texturePredictedPosition, uv2).xyz;
                                vec3 diff  = pos1 - pos2;
                                if (u_periodicFlow > 0.5) {
                                    diff.z -= u_flowPeriodWorld * round(diff.z / u_flowPeriodWorld);
                                }
                                float dst = length(diff);

                                if (dst < u_smoothingRadius) {
                                    vec3 dir;
                                    if (dst < 0.001) {
                                        float angle = (uv.x + uv.y) * 6.28318;
                                        dir = normalize(vec3(cos(angle), 0.5, sin(angle)));
                                        dst = 0.001;
                                    } else {
                                        dir = diff / dst;
                                    }

                                    vec2 densityData2 = texture2D(textureDensity, uv2).rg;
                                    float dens2     = max(densityData2.r, 0.001);
                                    float nearDens2 = max(densityData2.g, 0.001);

                                    float rawPress2  = (min(dens2, u_targetDensity * 20.0) - u_targetDensity) * u_pressureMultiplier;
                                    float press2     = max(rawPress2, -abs(rawPress2) * u_cohesionStrength);
                                    float nearPress2 = nearDens2 * u_nearPressureMultiplier;

                                    float sharedPressure     = (press1 + press2) * 0.5;
                                    float sharedNearPressure = (nearPress1 + nearPress2) * 0.5;

                                    pressureForce += dir * (-DerivativeSpikyPow2(dst, u_smoothingRadius)) * sharedPressure / dens2;
                                    pressureForce += dir * (-DerivativeSpikyPow3(dst, u_smoothingRadius)) * sharedNearPressure / nearDens2;

                                    neighbourCount++;
                                }
                            }
                        }
                    }
                }

                // Ball interaction
                vec3 toBall = pos1 - u_ballPosition;
                float distToBall = length(toBall);
                if (distToBall > 0.001 && distToBall < u_ballRadius + 0.5) {
                    pressureForce += (toBall / distToBall) * 165.0;
                }

                // Accent rock interactions
                for (int ri = 0; ri < 6; ri++) {
                    float rr = u_rockRadii[ri];
                    if (rr < 0.001) continue;
                    vec3 toRock = pos1 - u_rockPositions[ri];
                    float dr = length(toRock);
                    if (dr > 0.001 && dr < rr + 0.8) {
                        pressureForce += (toRock / dr) * 80.0;
                    }
                }

                // Pressure acceleration (gravity already applied to vel1 above)
                vec3 acceleration = pressureForce / dens1;

                if (u_periodicFlow > 0.5) {
                    acceleration.z += u_flowAccel;
                }

                // Symmetric agitation: both axes use the same frequency so
                // the net force integrates to zero over the particle population.
                // This keeps the water alive without creating a directional drift.
                float phase = uv.x * 17.3 + uv.y * 31.7;
                float agitX = sin(u_time * 1.85 + phase);
                float agitZ = sin(u_time * 1.85 + phase + 1.5708); // 90° shifted = cos, same freq
                acceleration.x += agitX * u_agitation;
                acceleration.z += agitZ * u_agitation;
                acceleration.y += sin(u_time * 1.35 + phase * 1.2) * u_agitation * 0.25;

                vel1 += acceleration * u_deltaTime;

                // Airborne drag — matches Unity CalculatePressureForce lines 351-354:
                //   if (neighbourCount < 8) Velocities[id.x] -= Velocities[id.x] * deltaTime * 0.75;
                if (neighbourCount < 8) {
                    vel1 -= vel1 * u_deltaTime * 0.75;
                }

                // Boundary collision in local tank space
                vec3 localPos = (u_tankMatrixWorldInverse * vec4(pos1, 1.0)).xyz;
                vec3 localVel = (u_tankMatrixWorldInverse * vec4(vel1, 0.0)).xyz;

                float wallBounce = -u_collisionDamping;

                if (localPos.y <= -0.5 && localVel.y < 0.0) localVel.y *= wallBounce;
                if (u_periodicFlow < 0.5) {
                    if (localPos.z >= 0.5 && localVel.z > 0.0) localVel.z *= wallBounce;
                    if (localPos.z <= -0.5 && localVel.z < 0.0) localVel.z *= wallBounce;
                }

                // Hard boundary reflection for X, matching Unity
                if (localPos.x >= 0.5 && localVel.x > 0.0) localVel.x *= wallBounce;
                if (localPos.x <= -0.5 && localVel.x < 0.0) localVel.x *= wallBounce;

                // Soft Y-ceiling
                const float ySoftZone = 0.06;
                if (localPos.y > (0.5 - ySoftZone)) {
                    float pen = (localPos.y - (0.5 - ySoftZone)) / ySoftZone;
                    localVel.y -= pen * pen * 4.0;
                }

                // Wall-proximity damping
                vec3 absLocal = abs(localPos);
                float wallProx = (u_periodicFlow > 0.5)
                    ? max(absLocal.x, absLocal.y)
                    : max(max(absLocal.x, absLocal.y), absLocal.z);
                if (wallProx > 0.45) {
                    float spd = length(localVel);
                    float dampStrength = smoothstep(4.0, 12.0, spd);
                    localVel *= mix(1.0, 0.80, dampStrength);
                }

                vel1 = (u_tankMatrixWorld * vec4(localVel, 0.0)).xyz;

                // Terrain floor bounce
                float floorY = terrainHeight(pos1.x, pos1.z) + 0.15;
                if (pos1.y <= floorY && vel1.y < 0.0) {
                    vel1.y *= -u_collisionDamping;
                }

                gl_FragColor = vec4(clamp(vel1, vec3(-30.0), vec3(30.0)), 1.0);
            }
        `;
    }

    // ========================================================================
    // VISCOSITY SHADER (matches Unity CalculateViscosity kernel)
    // Runs after the pressure pass.  Reads the pressure-resolved velocity and
    // applies Poly6-weighted velocity smoothing across neighbours.
    // ========================================================================
    getViscosityShader() {
        return `
            uniform float u_smoothingRadius;
            uniform float u_viscosityMultiplier;
            uniform float u_deltaTime;
            uniform vec2 u_resolution;
            uniform float u_gridSize;
            uniform float u_cellSize;
            uniform sampler2D u_cellTexture;
            uniform sampler2D u_sortedIndices;
            uniform float u_maxBoxSize;
            uniform float u_cellTexWidth;
            uniform float u_cellTexHeight;
            uniform float u_periodicFlow;
            uniform float u_flowPeriodWorld;

            // Poly6 smooth bell-curve kernel — used for viscosity weighting
            float Poly6Kernel(float dst, float h) {
                if (dst >= h) return 0.0;
                float v = h * h - dst * dst;
                return v * v * v * (315.0 / (64.0 * 3.14159265 * h * h * h * h * h * h * h * h * h));
            }

            void main() {
                vec2 uv = gl_FragCoord.xy / resolution.xy;

                vec3 pos1 = texture2D(texturePredictedPosition, uv).xyz;
                // Starting from pressure-resolved velocity
                vec3 vel1 = texture2D(texturePressureVelocity, uv).xyz;

                vec3 viscosityForce = vec3(0.0);

                ivec3 cellCoords = ivec3(floor((pos1 + vec3(u_maxBoxSize, 0.0, u_maxBoxSize)) / u_cellSize));

                for (int z = -1; z <= 1; z++) {
                    for (int y = -1; y <= 1; y++) {
                        for (int x = -1; x <= 1; x++) {
                            ivec3 neighbor = cellCoords + ivec3(x, y, z);
                            if (neighbor.x < 0 || neighbor.x >= int(u_gridSize) ||
                                neighbor.y < 0 || neighbor.y >= int(u_gridSize) ||
                                neighbor.z < 0 || neighbor.z >= int(u_gridSize)) continue;

                            int hash = neighbor.x + (neighbor.y * int(u_gridSize)) + (neighbor.z * int(u_gridSize) * int(u_gridSize));
                            float ty = floor(float(hash) / u_cellTexWidth);
                            float tx = mod(float(hash), u_cellTexWidth);
                            vec2 cellUV = vec2((tx + 0.5) / u_cellTexWidth, (ty + 0.5) / u_cellTexHeight);

                            float startFloat = texture2D(u_cellTexture, cellUV).r;
                            if (startFloat > 999998.0) continue;
                            uint startIndex = uint(startFloat);

                            float endFloat = texture2D(u_cellTexture, cellUV).g;
                            uint endIndex  = uint(endFloat);

                            for (uint i = startIndex; i < endIndex; i++) {
                                float origId = texelFetch(u_sortedIndices, ivec2(int(i), 0), 0).r;
                                vec2 uv2 = vec2(
                                    (mod(origId, u_resolution.x) + 0.5) / u_resolution.x,
                                    (floor(origId / u_resolution.x) + 0.5) / u_resolution.y
                                );
                                if (distance(uv, uv2) < 0.001) continue; // skip self

                                vec3 pos2 = texture2D(texturePredictedPosition, uv2).xyz;
                                vec3 diff  = pos1 - pos2;
                                if (u_periodicFlow > 0.5) {
                                    diff.z -= u_flowPeriodWorld * round(diff.z / u_flowPeriodWorld);
                                }
                                float dst = length(diff);

                                if (dst < u_smoothingRadius) {
                                    // Read neighbour's pressure-resolved velocity
                                    vec3 vel2 = texture2D(texturePressureVelocity, uv2).xyz;
                                    // Matches Unity: viscosityForce += (neighbourVelocity - velocity) * Poly6;
                                    viscosityForce += (vel2 - vel1) * Poly6Kernel(dst, u_smoothingRadius);
                                }
                            }
                        }
                    }
                }

                // vel_final = vel_pressure + viscForce * strength * dt
                // Matches Unity: Velocities[id.x] += viscosityForce * viscosityStrength * deltaTime;
                vec3 finalVel = vel1 + viscosityForce * u_viscosityMultiplier * u_deltaTime;
                gl_FragColor = vec4(clamp(finalVel, vec3(-30.0), vec3(30.0)), 1.0);
            }
        `;
    }


    // POSITION SHADER — integrates velocity, clamps to boundaries
    // ========================================================================
    getPositionShader() {
        return `
            uniform float u_boxSize;
            uniform vec3 u_ballPosition;
            uniform float u_ballRadius;
            uniform float u_deltaTime;
            uniform mat4 u_tankMatrixWorld;
            uniform mat4 u_tankMatrixWorldInverse;
            uniform float u_periodicFlow;
            uniform float u_baseYOffset;
            uniform float u_baseBumpAmp;
            uniform float u_baseBumpFreq;
            uniform float u_baseTiltX;
            uniform float u_baseTiltZ;
            uniform float u_wrapDestLocalZ;

            float terrainHeight(float x, float z) {
                float ripple = u_baseBumpAmp * sin(x * u_baseBumpFreq) * cos(z * u_baseBumpFreq);
                return u_baseYOffset + ripple - x * u_baseTiltX - z * u_baseTiltZ;
            }

            void main() {
                vec2 uv = gl_FragCoord.xy / resolution.xy;
                vec3 worldPos = texture2D(texturePosition, uv).xyz;
                vec3 worldVel = texture2D(textureViscosityVelocity, uv).xyz;
                
                worldPos += worldVel * u_deltaTime;
                
                vec3 toBall = worldPos - u_ballPosition;
                float distToBall = length(toBall);
                if (distToBall > 0.0001 && distToBall < u_ballRadius) {
                    worldPos = u_ballPosition + (toBall / distToBall) * u_ballRadius;
                }
                
                vec3 localPos = (u_tankMatrixWorldInverse * vec4(worldPos, 1.0)).xyz;
                // Allow a small soft margin instead of strict mathematical stacking to prevent pressure explosion
                localPos.x = clamp(localPos.x, -0.51, 0.51);
                localPos.y = clamp(localPos.y, -0.51, 0.51);
                float teleported = 0.0;
                if (u_periodicFlow > 0.5) {
                    float wz = localPos.z + 0.5;
                    float wzWrapped = wz - floor(wz);
                    if (abs(wzWrapped - wz) > 0.01) teleported = 1.0;
                    localPos.z = wzWrapped - 0.5;
                } else {
                    localPos.z = clamp(localPos.z, -0.51, 0.51);
                }

                if (teleported > 0.5) {
                    float r1 = fract(sin(dot(uv, vec2(12.9898, 78.233))) * 43758.5453);
                    float r2 = fract(sin(dot(uv + r1, vec2(39.346, 11.135))) * 24634.6415);
                    localPos.x += (r1 - 0.5) * 0.14;
                    localPos.y += (r2 - 0.5) * 0.10;
                    localPos.z = u_wrapDestLocalZ + (r1 - 0.5) * 0.04;
                    localPos.x = clamp(localPos.x, -0.5, 0.5);
                    localPos.y = clamp(localPos.y, -0.5, 0.5);
                    localPos.z = clamp(localPos.z, -0.5, 0.5);
                }
                
                worldPos = (u_tankMatrixWorld * vec4(localPos, 1.0)).xyz;

                float floorY = terrainHeight(worldPos.x, worldPos.z) + 0.15;
                if (worldPos.y < floorY) worldPos.y = floorY;

                // w = 0.0 signals a teleport to the velocity shader this frame.
                gl_FragColor = vec4(worldPos, teleported > 0.5 ? 0.0 : 1.0);
            }
        `;
    }

    // ========================================================================
    // ROCKS — push world-space positions + radii into the velocity shader.
    // rockList: array of { position: THREE.Vector3, radius: number }
    // ========================================================================
    setRocks(rockList) {
        const N = 6;
        for (let i = 0; i < N; i++) {
            const r = rockList[i];
            if (r) {
                this.sphUniforms.u_rockPositions.value[i].copy(r.position);
                this.sphUniforms.u_rockRadii.value[i] = r.radius;
            } else {
                this.sphUniforms.u_rockPositions.value[i].set(0, 0, 0);
                this.sphUniforms.u_rockRadii.value[i] = 0;
            }
        }
        this.pressureVelocityVariable.material.uniforms.u_rockPositions.value =
            this.sphUniforms.u_rockPositions.value;
        this.pressureVelocityVariable.material.uniforms.u_rockRadii.value =
            this.sphUniforms.u_rockRadii.value;
    }

    // ========================================================================
    // UPDATE — CPU-side spatial hash sort + GPU compute dispatch
    // ========================================================================
    update(ballPos, time, deltaTime, tankMesh) {
        const fixedDt = 0.004;
        this._frameCounter++;

        this.sphUniforms.u_tankMatrixWorld.value.copy(tankMesh.matrixWorld);
        this.sphUniforms.u_tankMatrixWorldInverse.value.copy(tankMesh.matrixWorld).invert();
        this.sphUniforms.u_flowPeriodWorld.value = tankMesh.scale.z;

        // ------------------------------------------------------------------
        // Spatial hash: CPU readback from PREDICTED positions, which is what
        // the density and pressure shaders use for their cell lookups.
        // Only rebuild every _hashStagger frames; previous hash reused otherwise.
        // ------------------------------------------------------------------
        if (this._frameCounter % this._hashStagger === 0) {
            const predRT = this.gpuCompute.getCurrentRenderTarget(this.predictedPositionVariable);
            this.renderer.readRenderTargetPixels(predRT, 0, 0, this.WIDTH, this.WIDTH, this.gpuReadBuffer);

            const limit = this.sphUniforms.u_maxBoxSize.value;
            const sortedParticles = [];

            for (let i = 0; i < this.particleCount; i++) {
                const idx = i * 4;
                const px = this.gpuReadBuffer[idx + 0] + limit + 0.00001;
                const py = this.gpuReadBuffer[idx + 1] + 0.00001;
                const pz = this.gpuReadBuffer[idx + 2] + limit + 0.00001;

                const cx = Math.max(0, Math.min(Math.floor(px / this.cellSize), this.gridSize - 1));
                const cy = Math.max(0, Math.min(Math.floor(py / this.cellSize), this.gridSize - 1));
                const cz = Math.max(0, Math.min(Math.floor(pz / this.cellSize), this.gridSize - 1));

                sortedParticles.push({ hash: cx + cy * this.gridSize + cz * this.gridSize * this.gridSize, id: i });
            }
            sortedParticles.sort((a, b) => a.hash - b.hash);

            this.cellOffsets.fill(999999);
            this.cellCounts.fill(0);

            for (let i = 0; i < this.particleCount; i++) {
                const hash = sortedParticles[i].hash;
                if (i === 0 || hash !== sortedParticles[i - 1].hash) {
                    this.cellOffsets[hash] = i;
                }
                this.cellCounts[hash]++;
                this.sortedIndicesData[i * 4] = sortedParticles[i].id;
            }

            for (let i = 0; i < this.cellTextureData.length; i += 4) {
                this.cellTextureData[i] = 999999;
                this.cellTextureData[i + 1] = 0;
                this.cellTextureData[i + 2] = 0;
                this.cellTextureData[i + 3] = 1;
            }
            for (let i = 0; i < this.totalCells; i++) {
                const idx = i * 4;
                const start = this.cellOffsets[i];
                this.cellTextureData[idx] = start;
                this.cellTextureData[idx + 1] = (start !== 999999) ? start + this.cellCounts[i] : 0;
            }

            this.cellTexture.needsUpdate = true;
            this.sortedIndicesTexture.needsUpdate = true;
        }

        // All sphUniforms values are shared object references across every variable,
        // so setting .value here updates all shaders simultaneously.
        this.sphUniforms.u_ballPosition.value.copy(ballPos);
        this.sphUniforms.u_time.value = time;

        // Adaptive substeps using a decaying max-speed estimate
        const maxSpeed = this._estimatedMaxSpeed;
        const baseSubsteps = Math.max(1, Math.ceil(deltaTime / fixedDt));
        const extraSubsteps = maxSpeed > 8.0 ? Math.min(Math.ceil(maxSpeed / 8.0), 4) : 0;
        const numSubsteps = baseSubsteps + extraSubsteps;
        const subDt = deltaTime / numSubsteps;

        for (let step = 0; step < numSubsteps; step++) {
            // sphUniforms.u_deltaTime is shared — one assignment updates all variables
            this.sphUniforms.u_deltaTime.value = subDt;
            this.gpuCompute.compute();
        }

        // Decay the speed estimate gently
        this._estimatedMaxSpeed = Math.max(
            this._estimatedMaxSpeed * 0.955,
            Math.min(this._estimatedMaxSpeed + (500.0 * deltaTime) * 1.15, 32.0)
        );
        if (this._estimatedMaxSpeed < 3.2) this._estimatedMaxSpeed = 3.2;

        // ── White particle update (once per hash-stagger frame) ──────────────
        // Re-use the already-read gpuReadBuffer (predicted positions) plus a fresh
        // velocity readback from the final viscosity render target.
        if (this._frameCounter % this._hashStagger === 0 && this.whiteParticleParams.enabled) {
            const velRT = this.gpuCompute.getCurrentRenderTarget(this.viscosityVelocityVariable);
            this.renderer.readRenderTargetPixels(velRT, 0, 0, this.WIDTH, this.WIDTH, this._wpReadBuffer);
            this.updateWhiteParticles(
                deltaTime,
                this.gpuReadBuffer,     // predicted positions (already read above)
                this._wpReadBuffer,     // final velocities (just read)
                this.sphUniforms.u_gravity.value
            );
        }

        // Expose final render textures: position from positionVariable,
        // velocity from viscosityVelocityVariable (final vel after all forces).
        this.commonUniforms.texturePosition.value = this.gpuCompute.getCurrentRenderTarget(this.positionVariable).texture;
        this.commonUniforms.textureVelocity.value = this.gpuCompute.getCurrentRenderTarget(this.viscosityVelocityVariable).texture;
        this.commonUniforms.textureDensity.value = this.gpuCompute.getCurrentRenderTarget(this.densityVariable).texture;
    }
}