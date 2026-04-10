import * as THREE from 'three';
import { GPUComputationRenderer } from 'three/addons/misc/GPUComputationRenderer.js';

export class ParticleFluid {
    constructor(renderer, scene, uiSettings) {
        this.renderer = renderer;
        this.uiSettings = uiSettings;

        this.WIDTH = 128; 
        this.particleCount = this.WIDTH * this.WIDTH; 

        // --- SPH Parameters (recalibrated for proper kernel math) ---
        this.sphUniforms = {
            u_smoothingRadius: { value: 0.8 },
            u_targetDensity: { value: 20.0 },
            u_pressureMultiplier: { value: 20.0 },
            u_nearPressureMultiplier: { value: 10.0 },
            u_viscosityMultiplier: { value: 0.22 },
            u_mass: { value: 1.0 },
            u_resolution: { value: new THREE.Vector2(this.WIDTH, this.WIDTH) },
            u_boxSize: { value: 11.0 },         
            u_maxBoxSize: { value: 20.0 },   
            u_ballPosition: { value: new THREE.Vector3(0, 0, 0) },
            u_ballRadius: { value: 1.5 },
            u_time: { value: 0.0 },
            u_deltaTime: { value: 0.016 },
            u_gravity: { value: -18.0 },
            u_collisionDamping: { value: 0.44 },
            
            u_agitation: { value: 1.15 },

            u_tankMatrixWorld: { value: new THREE.Matrix4() },
            u_tankMatrixWorldInverse: { value: new THREE.Matrix4() }
        };

        this.cellTextureWidth = 512;
        this.sortedIndicesData = new Float32Array(this.particleCount * 4);
        this.gpuReadBuffer     = new Float32Array(this.particleCount * 4);

        // Performance: track max speed across frames without full velocity readback.
        this._estimatedMaxSpeed = 5.0;
        this._hashStagger       = 1;     // rebuild hash every N frames (1 = every frame)
        this._frameCounter      = 0;

        // Build spatial hash grid arrays — extracted so we can rebuild live when
        // the smoothing radius slider changes.
        this._buildGrid(this.sphUniforms.u_smoothingRadius.value);
        
        this.initGPGPU();
        this.initParticles(scene);
    }

    // ========================================================================
    // SPATIAL HASH GRID — can be rebuilt at runtime when smoothingRadius changes
    // ========================================================================
    _buildGrid(smoothingRadius) {
        const maxBoxSize = this.sphUniforms.u_maxBoxSize.value;
        this.cellSize   = smoothingRadius;
        this.gridSize   = Math.ceil((maxBoxSize * 2.0) / this.cellSize);
        this.totalCells = this.gridSize * this.gridSize * this.gridSize;
        this.cellTextureHeight = Math.ceil(this.totalCells / this.cellTextureWidth);

        this.cellOffsets   = new Uint32Array(this.totalCells);
        this.cellCounts    = new Uint32Array(this.totalCells);
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
            u_cellSize:        { value: this.cellSize },
            u_gridSize:        { value: this.gridSize },
            u_cellTexHeight:   { value: this.cellTextureHeight },
            u_cellTexture:     { value: this.cellTexture },
        };
        [this.densityVariable, this.velocityVariable, this.positionVariable].forEach(v => {
            Object.assign(v.material.uniforms, patch);
        });

        // Keep sphUniforms in sync so the GUI's live display is correct.
        Object.assign(this.sphUniforms, patch);
    }

    initGPGPU() {
        this.gpuCompute = new GPUComputationRenderer(this.WIDTH, this.WIDTH, this.renderer);
        this.gpuCompute.setDataType(THREE.FloatType);

        const dtPosition = this.gpuCompute.createTexture();
        const dtVelocity = this.gpuCompute.createTexture();
        const dtDensity = this.gpuCompute.createTexture();
        
        this.fillPositionTexture(dtPosition);
        this.fillVelocityTexture(dtVelocity);

        this.densityVariable = this.gpuCompute.addVariable('textureDensity', this.getDensityShader(), dtDensity);
        this.velocityVariable = this.gpuCompute.addVariable('textureVelocity', this.getVelocityShader(), dtVelocity);
        this.positionVariable = this.gpuCompute.addVariable('texturePosition', this.getPositionShader(), dtPosition);

        // Keep dependencies simple and non-circular (same as original)
        this.gpuCompute.setVariableDependencies(this.densityVariable, [this.positionVariable]);
        this.gpuCompute.setVariableDependencies(this.velocityVariable, [this.positionVariable, this.velocityVariable, this.densityVariable]);
        this.gpuCompute.setVariableDependencies(this.positionVariable, [this.positionVariable, this.velocityVariable]);

        // cellTextureData was already allocated by _buildGrid().
        this.cellTexture = new THREE.DataTexture(
            this.cellTextureData,
            this.cellTextureWidth,
            this.cellTextureHeight,
            THREE.RGBAFormat,
            THREE.FloatType
        );
        this.cellTexture.minFilter = THREE.NearestFilter;
        this.cellTexture.magFilter = THREE.NearestFilter;

        this.sortedIndicesTexture = new THREE.DataTexture(this.sortedIndicesData, this.particleCount, 1, THREE.RGBAFormat, THREE.FloatType);
        this.sortedIndicesTexture.minFilter = THREE.NearestFilter;
        this.sortedIndicesTexture.magFilter = THREE.NearestFilter;

        Object.assign(this.sphUniforms, {
            u_gridSize: { value: this.gridSize },
            u_cellSize: { value: this.cellSize },
            u_cellTexture: { value: this.cellTexture },
            u_sortedIndices: { value: this.sortedIndicesTexture },
            u_cellTexWidth: { value: this.cellTextureWidth },
            u_cellTexHeight: { value: this.cellTextureHeight }
        });

        [this.densityVariable, this.velocityVariable, this.positionVariable].forEach(v => {
            Object.assign(v.material.uniforms, this.sphUniforms);
        });

        const error = this.gpuCompute.init();
        if (error !== null) {
            console.error('GPUComputationRenderer init error:', error);
        }
    }

    fillPositionTexture(texture, preset = 'default') {
        const data = texture.image.data;
        const boxSize = this.sphUniforms.u_boxSize.value;

        if (preset === 'dam-break') {
            // Pack all particles into the left third of the tank, stacked high
            const edgeX = 12, edgeZ = 24, spacing = 0.45;
            const offsetX = -boxSize + 2.0;
            const offsetZ = -(edgeZ - 1) / 2.0 * spacing;
            for (let i = 0; i < this.particleCount; i++) {
                const idx = i * 4;
                const x = i % edgeX;
                const z = Math.floor(i / edgeX) % edgeZ;
                const y = Math.floor(i / (edgeX * edgeZ));
                const jitter = () => (Math.random() - 0.5) * 0.1;
                data[idx + 0] = offsetX + x * spacing + jitter();
                data[idx + 1] = 0.5 + y * spacing + jitter();
                data[idx + 2] = offsetZ + z * spacing + jitter();
                data[idx + 3] = 1.0;
            }
        } else if (preset === 'wave') {
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
            const edgeX = 26, edgeZ = 26, spacing = 0.5;
            const offsetX = (edgeX - 1) / 2.0;
            const offsetZ = (edgeZ - 1) / 2.0;
            const ceiling = (boxSize * 2.0) - 1.0;
            for (let i = 0; i < this.particleCount; i++) {
                const idx = i * 4;
                const x = i % edgeX;
                const z = Math.floor(i / edgeX) % edgeZ;
                const y = Math.floor(i / (edgeX * edgeZ));
                const jitter = () => (Math.random() - 0.5) * 0.15;
                data[idx + 0] = (x - offsetX) * spacing + jitter();
                data[idx + 1] = ceiling - (y * spacing);
                data[idx + 2] = (z - offsetZ) * spacing + jitter();
                data[idx + 3] = 1.0;
            }
        }
    }

    fillVelocityTexture(texture, preset = 'default') {
        const data = texture.image.data;
        if (preset === 'dam-break') {
            for (let k = 0; k < data.length; k += 4) {
                data[k + 0] = 8.0 + (Math.random() - 0.5) * 2.0;  // strong rightward push
                data[k + 1] = (Math.random() - 0.5) * 1.0;
                data[k + 2] = (Math.random() - 0.5) * 2.0;
                data[k + 3] = 1.0;
            }
        } else if (preset === 'wave') {
            for (let k = 0; k < data.length; k += 4) {
                data[k + 0] = 12.0 + (Math.random() - 0.5) * 3.0;  // strong rightward surge
                data[k + 1] = 3.0  + (Math.random() - 0.5) * 2.0;  // slight upward lift
                data[k + 2] = (Math.random() - 0.5) * 2.0;
                data[k + 3] = 1.0;
            }
        } else {
            for (let k = 0; k < data.length; k += 4) {
                data[k + 0] = (Math.random() - 0.5) * 4.0;
                data[k + 1] = (Math.random() - 0.5) * 2.0;
                data[k + 2] = (Math.random() - 0.5) * 4.0;
                data[k + 3] = 1.0;
            }
        }
    }

    // Re-initialise particle positions and velocities from a preset without
    // re-creating the entire GPGPU pipeline.
    resetParticles(preset = 'default') {
        const posRT = this.gpuCompute.getCurrentRenderTarget(this.positionVariable);
        const velRT = this.gpuCompute.getCurrentRenderTarget(this.velocityVariable);

        const posTexture = this.gpuCompute.createTexture();
        const velTexture = this.gpuCompute.createTexture();
        this.fillPositionTexture(posTexture, preset);
        this.fillVelocityTexture(velTexture, preset);

        this.gpuCompute.renderTexture(posTexture, posRT);
        this.gpuCompute.renderTexture(velTexture, velRT);
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
            textureDensity:  { value: null }
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
    // DENSITY SHADER
    // Fixed: proper SPH kernels with 3D normalization constants
    // ========================================================================
    getDensityShader() {
        return `
            uniform float u_smoothingRadius;
            uniform float u_mass;
            uniform vec2 u_resolution;
            uniform float u_boxSize;
            uniform float u_maxBoxSize;
            uniform float u_gridSize;
            uniform float u_cellSize;
            uniform float u_cellTexWidth;
            uniform float u_cellTexHeight;
            uniform sampler2D u_cellTexture;
            uniform sampler2D u_sortedIndices;

            // --- SPH Kernel: Spiky Pow2 (3D normalized) ---
            float SpikyKernelPow2(float dst, float h) {
                if (dst >= h) return 0.0;
                float v = h - dst;
                return v * v * (15.0 / (2.0 * 3.14159265 * h * h * h * h * h));
            }

            // --- SPH Kernel: Spiky Pow3 (3D normalized) ---
            // Correct 3D normalization: 15/(pi * h^6)
            float SpikyKernelPow3(float dst, float h) {
                if (dst >= h) return 0.0;
                float v = h - dst;
                return v * v * v * (15.0 / (3.14159265 * h * h * h * h * h * h));
            }

            void main() {
                vec2 uv = gl_FragCoord.xy / resolution.xy;
                vec3 pos1 = texture2D(texturePosition, uv).xyz;
                float density = 0.0;
                float nearDensity = 0.0;

                ivec3 cellCoords = ivec3(floor((pos1 + vec3(u_maxBoxSize, 0.0, u_maxBoxSize)) / u_cellSize));

                for (int z = -1; z <= 1; z++) {
                    for (int y = -1; y <= 1; y++) {
                        for (int x = -1; x <= 1; x++) {
                            ivec3 neighbor = cellCoords + ivec3(x, y, z);
                            if (neighbor.x < 0 || neighbor.x >= int(u_gridSize) || neighbor.y < 0 || neighbor.y >= int(u_gridSize) || neighbor.z < 0 || neighbor.z >= int(u_gridSize)) continue;
                            
                            int hash = neighbor.x + (neighbor.y * int(u_gridSize)) + (neighbor.z * int(u_gridSize) * int(u_gridSize));
                            
                            float ty = floor(float(hash) / u_cellTexWidth);
                            float tx = mod(float(hash), u_cellTexWidth);
                            vec2 cellUV = vec2((tx + 0.5) / u_cellTexWidth, (ty + 0.5) / u_cellTexHeight);
                            
                            float startFloat = texture2D(u_cellTexture, cellUV).r;
                            if (startFloat > 999998.0) continue;
                            uint startIndex = uint(startFloat);

                            // Phase 2: read endIndex from .g channel — only visit THIS cell's particles
                            float endFloat = texture2D(u_cellTexture, cellUV).g;
                            uint endIndex = uint(endFloat);

                            for (uint i = startIndex; i < endIndex; i++) {
                                float origId = texelFetch(u_sortedIndices, ivec2(int(i), 0), 0).r;
                                vec2 uv2 = vec2((mod(origId, u_resolution.x) + 0.5) / u_resolution.x, (floor(origId / u_resolution.x) + 0.5) / u_resolution.y);
                                
                                vec3 pos2 = texture2D(texturePosition, uv2).xyz;
                                float dst = distance(pos1, pos2);
                                if (dst < u_smoothingRadius) {
                                    density += u_mass * SpikyKernelPow2(dst, u_smoothingRadius);
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
    // VELOCITY SHADER
    // Fixed: proper kernel derivatives, negative pressure allowed, Poly6 viscosity
    // ========================================================================
    getVelocityShader() {
        return `
            uniform float u_smoothingRadius;
            uniform float u_targetDensity;
            uniform float u_pressureMultiplier;
            uniform float u_nearPressureMultiplier;
            uniform float u_viscosityMultiplier;
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

            uniform float u_time;
            uniform float u_agitation;

            uniform mat4 u_tankMatrixWorld;
            uniform mat4 u_tankMatrixWorldInverse;

            // --- SPH Kernel DERIVATIVES for pressure gradient ---
            // Derivative of (h-r)^2 kernel: -2(h-r) * 15/(2*pi*h^5) = -(h-r) * 15/(pi*h^5)
            float DerivativeSpikyPow2(float dst, float h) {
                if (dst >= h || dst < 0.001) return 0.0;
                float v = h - dst;
                return -v * (15.0 / (3.14159265 * h * h * h * h * h));
            }

            // Derivative of (h-r)^3 kernel: -3(h-r)^2 * 15/(pi*h^6) = -(h-r)^2 * 45/(pi*h^6)
            float DerivativeSpikyPow3(float dst, float h) {
                if (dst >= h || dst < 0.001) return 0.0;
                float v = h - dst;
                return -v * v * (45.0 / (3.14159265 * h * h * h * h * h * h));
            }

            // --- Poly6 for viscosity (smooth bell curve) ---
            float Poly6Kernel(float dst, float h) {
                if (dst >= h) return 0.0;
                float v = h * h - dst * dst;
                return v * v * v * (315.0 / (64.0 * 3.14159265 * h * h * h * h * h * h * h * h * h));
            }

            void main() {
                vec2 uv = gl_FragCoord.xy / resolution.xy;
                
                vec3 pos1 = texture2D(texturePosition, uv).xyz;
                vec3 vel1 = texture2D(textureVelocity, uv).xyz;

                vec2 densityData = texture2D(textureDensity, uv).rg;
                float dens1 = max(densityData.r, 0.001);
                float nearDens1 = max(densityData.g, 0.001);

                // Cap density ratio to 20× target — prevents extreme pressure
                // spikes when particles are force-compressed by rapid box shrinking.
                float cappedDens1 = min(dens1, u_targetDensity * 20.0);
                
                // Clamp pressure to non-negative — no cohesion, only repulsion.
                float press1 = max(0.0, (cappedDens1 - u_targetDensity) * u_pressureMultiplier);
                float nearPress1 = nearDens1 * u_nearPressureMultiplier; 
                
                vec3 pressureForce = vec3(0.0);
                vec3 viscosityForce = vec3(0.0);

                ivec3 cellCoords = ivec3(floor((pos1 + vec3(u_maxBoxSize, 0.0, u_maxBoxSize)) / u_cellSize));

                for (int z = -1; z <= 1; z++) {
                    for (int y = -1; y <= 1; y++) {
                        for (int x = -1; x <= 1; x++) {
                            ivec3 neighbor = cellCoords + ivec3(x, y, z);
                            if (neighbor.x < 0 || neighbor.x >= int(u_gridSize) || neighbor.y < 0 || neighbor.y >= int(u_gridSize) || neighbor.z < 0 || neighbor.z >= int(u_gridSize)) continue;
                            
                            int hash = neighbor.x + (neighbor.y * int(u_gridSize)) + (neighbor.z * int(u_gridSize) * int(u_gridSize));

                            float ty = floor(float(hash) / u_cellTexWidth);
                            float tx = mod(float(hash), u_cellTexWidth);
                            vec2 cellUV = vec2((tx + 0.5) / u_cellTexWidth, (ty + 0.5) / u_cellTexHeight); 

                            float startFloat = texture2D(u_cellTexture, cellUV).r;
                            if (startFloat > 999998.0) continue;
                            uint startIndex = uint(startFloat);

                            // Phase 2: read endIndex from .g channel — only visit THIS cell's particles
                            float endFloat = texture2D(u_cellTexture, cellUV).g;
                            uint endIndex = uint(endFloat);

                            for (uint i = startIndex; i < endIndex; i++) {
                                float origId = texelFetch(u_sortedIndices, ivec2(int(i), 0), 0).r;
                                vec2 uv2 = vec2((mod(origId, u_resolution.x) + 0.5) / u_resolution.x, (floor(origId / u_resolution.x) + 0.5) / u_resolution.y);
                                
                                if (distance(uv, uv2) < 0.001) continue; // skip self
                                
                                vec3 pos2 = texture2D(texturePosition, uv2).xyz;
                                vec3 vel2 = texture2D(textureVelocity, uv2).xyz;
                                
                                vec3 diff = pos1 - pos2;
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
                                    float dens2 = max(densityData2.r, 0.001);
                                    float nearDens2 = max(densityData2.g, 0.001);
                                    
                                    float press2 = max(0.0, (min(dens2, u_targetDensity * 20.0) - u_targetDensity) * u_pressureMultiplier);
                                    float nearPress2 = nearDens2 * u_nearPressureMultiplier;
                                    
                                    // SPH pressure gradient: F = -∇P
                                    float sharedPressure = (press1 + press2) * 0.5;
                                    pressureForce += dir * (-DerivativeSpikyPow2(dst, u_smoothingRadius)) * sharedPressure / dens2;
                                    
                                    float sharedNearPressure = (nearPress1 + nearPress2) * 0.5;
                                    pressureForce += dir * (-DerivativeSpikyPow3(dst, u_smoothingRadius)) * sharedNearPressure / nearDens2;
                                    
                                    viscosityForce += (vel2 - vel1) * Poly6Kernel(dst, u_smoothingRadius);
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

                // Combine: pressure/density + viscosity + gravity + agitation
                vec3 acceleration = pressureForce / dens1;
                acceleration += viscosityForce * u_viscosityMultiplier;
                acceleration.y += u_gravity;

                // Time-varying agitation (horizontal + vertical) so the pool feels alive
                // and reacts more visibly to the simulation.
                float phase = uv.x * 17.3 + uv.y * 31.7;
                acceleration.x += sin(u_time * 1.85 + phase) * u_agitation;
                acceleration.z += cos(u_time * 2.45 + phase * 0.7) * u_agitation;
                acceleration.y += sin(u_time * 1.35 + phase * 1.2) * u_agitation * 0.42;

                // Clamp acceleration magnitude to prevent single-step explosions
                // when particles are over-compressed by rapid box shrinking.
                float accelLen = length(acceleration);
                if (accelLen > 500.0) acceleration *= 500.0 / accelLen;
                
                vel1 += acceleration * u_deltaTime;

                // Boundary collision in local tank space
                vec3 localPos = (u_tankMatrixWorldInverse * vec4(pos1, 1.0)).xyz;
                vec3 localVel = (u_tankMatrixWorldInverse * vec4(vel1, 0.0)).xyz;

                float wallBounce = -u_collisionDamping; 

                if (localPos.x >= 0.5 && localVel.x > 0.0) localVel.x *= wallBounce;
                if (localPos.x <= -0.5 && localVel.x < 0.0) localVel.x *= wallBounce;
                if (localPos.y >= 0.5 && localVel.y > 0.0) localVel.y *= wallBounce;
                if (localPos.y <= -0.5 && localVel.y < 0.0) localVel.y *= wallBounce;
                if (localPos.z >= 0.5 && localVel.z > 0.0) localVel.z *= wallBounce;
                if (localPos.z <= -0.5 && localVel.z < 0.0) localVel.z *= wallBounce;

                // Conditional wall damping: strong near walls only when moving fast
                // (violent events like rapid box shrink). Gentle slosh is preserved.
                vec3 absLocal = abs(localPos);
                float wallProx = max(max(absLocal.x, absLocal.y), absLocal.z);
                if (wallProx > 0.45) {
                    float speed = length(localVel);
                    float dampStrength = smoothstep(4.0, 12.0, speed);
                    localVel *= mix(1.0, 0.85, dampStrength);
                }

                vel1 = (u_tankMatrixWorld * vec4(localVel, 0.0)).xyz;

                gl_FragColor = vec4(clamp(vel1, vec3(-30.0), vec3(30.0)), 1.0);
            }
        `;
    }

    // ========================================================================
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

            void main() {
                vec2 uv = gl_FragCoord.xy / resolution.xy;
                vec3 worldPos = texture2D(texturePosition, uv).xyz;
                vec3 worldVel = texture2D(textureVelocity, uv).xyz;
                
                worldPos += worldVel * u_deltaTime;
                
                vec3 toBall = worldPos - u_ballPosition;
                float distToBall = length(toBall);
                if (distToBall > 0.0001 && distToBall < u_ballRadius) {
                    worldPos = u_ballPosition + (toBall / distToBall) * u_ballRadius;
                }
                
                vec3 localPos = (u_tankMatrixWorldInverse * vec4(worldPos, 1.0)).xyz;
                localPos.x = clamp(localPos.x, -0.5, 0.5);
                localPos.y = clamp(localPos.y, -0.5, 0.5);
                localPos.z = clamp(localPos.z, -0.5, 0.5);
                
                worldPos = (u_tankMatrixWorld * vec4(localPos, 1.0)).xyz;

                if(worldPos.y < 0.0) {
                    worldPos.y = 0.0;
                }

                gl_FragColor = vec4(worldPos, 1.0);
            }
        `;
    }

    // ========================================================================
    // UPDATE — CPU-side spatial hash sort + GPU compute dispatch
    // ========================================================================
    update(ballPos, time, deltaTime, tankMesh) {
        const fixedDt = 0.004;
        this._frameCounter++;

        this.sphUniforms.u_tankMatrixWorld.value.copy(tankMesh.matrixWorld);
        this.sphUniforms.u_tankMatrixWorldInverse.value.copy(tankMesh.matrixWorld).invert();

        // ------------------------------------------------------------------
        // Spatial hash: only do the expensive CPU readback + sort every
        // _hashStagger frames.  On skipped frames the previous hash is reused.
        // ------------------------------------------------------------------
        if (this._frameCounter % this._hashStagger === 0) {
            const posRenderTarget = this.gpuCompute.getCurrentRenderTarget(this.positionVariable);
            this.renderer.readRenderTargetPixels(posRenderTarget, 0, 0, this.WIDTH, this.WIDTH, this.gpuReadBuffer);

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
                this.cellTextureData[i]     = 999999;
                this.cellTextureData[i + 1] = 0;
                this.cellTextureData[i + 2] = 0;
                this.cellTextureData[i + 3] = 1;
            }
            for (let i = 0; i < this.totalCells; i++) {
                const idx = i * 4;
                const start = this.cellOffsets[i];
                this.cellTextureData[idx]     = start;
                this.cellTextureData[idx + 1] = (start !== 999999) ? start + this.cellCounts[i] : 0;
            }

            this.cellTexture.needsUpdate = true;
            this.sortedIndicesTexture.needsUpdate = true;
        }

        this.velocityVariable.material.uniforms.u_ballPosition.value.copy(ballPos);
        this.velocityVariable.material.uniforms.u_time.value = time;
        this.positionVariable.material.uniforms.u_ballPosition.value.copy(ballPos);

        // Adaptive substeps using a decaying max-speed estimate.
        // No velocity readback — the estimate converges from gravity/damping cues.
        const maxSpeed      = this._estimatedMaxSpeed;
        const baseSubsteps  = Math.max(1, Math.ceil(deltaTime / fixedDt));
        const extraSubsteps = maxSpeed > 8.0 ? Math.min(Math.ceil(maxSpeed / 8.0), 4) : 0;
        const numSubsteps   = baseSubsteps + extraSubsteps;
        const subDt         = deltaTime / numSubsteps;

        for (let step = 0; step < numSubsteps; step++) {
            this.velocityVariable.material.uniforms.u_deltaTime.value = subDt;
            this.positionVariable.material.uniforms.u_deltaTime.value = subDt;
            this.gpuCompute.compute();
        }

        // Decay the speed estimate gently; spikes from box-shrink / impulse are
        // inferred from the acceleration clamp (500) × dt.
        const accelBudget = 500.0 * deltaTime;
        this._estimatedMaxSpeed = Math.max(
            this._estimatedMaxSpeed * 0.955,
            Math.min(this._estimatedMaxSpeed + accelBudget * 1.15, 32.0)
        );
        if (this._estimatedMaxSpeed < 3.2) this._estimatedMaxSpeed = 3.2;

        this.commonUniforms.texturePosition.value = this.gpuCompute.getCurrentRenderTarget(this.positionVariable).texture;
        this.commonUniforms.textureVelocity.value = this.gpuCompute.getCurrentRenderTarget(this.velocityVariable).texture;
        this.commonUniforms.textureDensity.value  = this.gpuCompute.getCurrentRenderTarget(this.densityVariable).texture;
    }
}