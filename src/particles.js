import * as THREE from 'three';
import { GPUComputationRenderer } from 'three/addons/misc/GPUComputationRenderer.js';

export class ParticleFluid {
    constructor(renderer, scene, uiSettings) {
        this.renderer = renderer;
        this.uiSettings = uiSettings;

        // 1. Basic Dimensions
        this.WIDTH = 128; 
        this.particleCount = this.WIDTH * this.WIDTH; 

        // 2. High-Energy Physics Constants
        this.sphUniforms = {
            u_smoothingRadius: { value: 1.2 },
            u_targetDensity: { value: 35.0 },         // Lowered: Makes fluid want to expand
            u_pressureMultiplier: { value: 3.0 },  // Cranked: Violent splash
            u_viscosityMultiplier: { value: 4.0 },   // Lowered: Flows more easily
            u_surfaceTension: { value: 25.0 },
            u_mass: { value: 1.0 },
            u_resolution: { value: new THREE.Vector2(this.WIDTH, this.WIDTH) },
            u_boxSize: { value: 11.0 },              // Doubled: Massive 20x20x20 tank
            u_ballPosition: { value: new THREE.Vector3(0, 0, 0) },
            u_ballRadius: { value: 1.5 },
            u_time: { value: 0.0 },
            u_deltaTime: { value: 0.016 },
            u_gravity: { value: -25.0 }              // Harder drop
        };

        // 3. Setup Grid Architecture
        this.cellSize = this.sphUniforms.u_smoothingRadius.value;
        this.gridSize = Math.ceil((this.sphUniforms.u_boxSize.value * 2.0) / this.cellSize);
        this.totalCells = this.gridSize * this.gridSize * this.gridSize;
        
        this.particleHashes = new Uint32Array(this.particleCount * 2);
        this.cellOffsets = new Uint32Array(this.totalCells);
        this.cellTextureData = new Float32Array(this.totalCells * 4); 
        this.sortedIndicesData = new Float32Array(this.particleCount * 4);
        this.gpuReadBuffer = new Uint16Array(this.particleCount * 4); 

        this.initGPGPU();
        this.depthMaterial = this.getDepthMaterial();
        this.thicknessMaterial = this.getThicknessMaterial();
        this.initParticles(scene);
    }

    initGPGPU() {
        this.gpuCompute = new GPUComputationRenderer(this.WIDTH, this.WIDTH, this.renderer);
        this.gpuCompute.setDataType(THREE.HalfFloatType);

        const dtPosition = this.gpuCompute.createTexture();
        const dtVelocity = this.gpuCompute.createTexture();
        const dtDensity = this.gpuCompute.createTexture();
        
        this.fillPositionTexture(dtPosition);
        this.fillVelocityTexture(dtVelocity);

        this.densityVariable = this.gpuCompute.addVariable('textureDensity', this.getDensityShader(), dtDensity);
        this.velocityVariable = this.gpuCompute.addVariable('textureVelocity', this.getVelocityShader(), dtVelocity);
        this.positionVariable = this.gpuCompute.addVariable('texturePosition', this.getPositionShader(), dtPosition);

        this.gpuCompute.setVariableDependencies(this.densityVariable, [this.positionVariable]);
        this.gpuCompute.setVariableDependencies(this.velocityVariable, [this.positionVariable, this.velocityVariable, this.densityVariable]);
        this.gpuCompute.setVariableDependencies(this.positionVariable, [this.positionVariable, this.velocityVariable]);

        this.cellTexture = new THREE.DataTexture(this.cellTextureData, this.totalCells, 1, THREE.RGBAFormat, THREE.FloatType);
        this.sortedIndicesTexture = new THREE.DataTexture(this.sortedIndicesData, this.particleCount, 1, THREE.RGBAFormat, THREE.FloatType);

        Object.assign(this.sphUniforms, {
            u_gridSize: { value: this.gridSize },
            u_cellSize: { value: this.cellSize },
            u_cellTexture: { value: this.cellTexture },
            u_sortedIndices: { value: this.sortedIndicesTexture }
        });

        [this.densityVariable, this.velocityVariable, this.positionVariable].forEach(v => {
            Object.assign(v.material.uniforms, this.sphUniforms);
        });

        const error = this.gpuCompute.init();
        if (error !== null) console.error("GPU Compute Shader Error:", error);
    }

    fillPositionTexture(texture) {
        const data = texture.image.data;
        const edge = 16;
        const spacing = 0.4; 
        for (let i = 0; i < this.particleCount; i++) {
            const idx = i * 4;
            const x = i % edge;
            const y = Math.floor(i / edge) % edge;
            const z = Math.floor(i / (edge * edge));
            const jitterX = (Math.random() - 0.5) * 0.02;
            const jitterZ = (Math.random() - 0.5) * 0.02;

            data[idx + 0] = THREE.DataUtils.toHalfFloat((x - 8) * spacing + jitterX);
            // Spawn high up near the ceiling of the new massive tank
            data[idx + 1] = THREE.DataUtils.toHalfFloat(16.0 + (y * spacing)); 
            data[idx + 2] = THREE.DataUtils.toHalfFloat((z - 8) * spacing + jitterZ);
            data[idx + 3] = THREE.DataUtils.toHalfFloat(1.0);
        }
    }

    fillVelocityTexture(texture) {
        const data = texture.image.data;
        for (let k = 0; k < data.length; k += 4) {
            data[k + 0] = THREE.DataUtils.toHalfFloat(0.0);
            data[k + 1] = THREE.DataUtils.toHalfFloat(0.0);
            data[k + 2] = THREE.DataUtils.toHalfFloat(0.0);
            data[k + 3] = THREE.DataUtils.toHalfFloat(1.0); 
        }
    }

    getDepthMaterial() {
        return new THREE.ShaderMaterial({
            uniforms: {
                texturePosition: { value: null }
            },
            vertexShader: `
                uniform sampler2D texturePosition;
                attribute vec2 particleUV;
                varying float vDepth;

                void main() {
                    vec4 posData = texture2D(texturePosition, particleUV);
                    vec4 mvPosition = modelViewMatrix * vec4(posData.xyz + position, 1.0);
                    gl_Position = projectionMatrix * mvPosition;
                    vDepth = -mvPosition.z; 
                }
            `,
            fragmentShader: `
                varying float vDepth;
                void main() {
                    gl_FragColor = vec4(vDepth, 0.0, 0.0, 1.0);
                }
            `,
            transparent: true
        });
    }

    initParticles(scene) {
        const geometry = new THREE.SphereGeometry(0.4, 8, 8);
        const uvs = new Float32Array(this.particleCount * 2);
        for (let i = 0; i < this.particleCount; i++) {
            uvs[i * 2 + 0] = ((i % this.WIDTH) + 0.5) / this.WIDTH;
            uvs[i * 2 + 1] = (Math.floor(i / this.WIDTH) + 0.5) / this.WIDTH;
        }
        geometry.setAttribute('particleUV', new THREE.InstancedBufferAttribute(uvs, 2));

        const material = new THREE.MeshStandardMaterial({ color: 0x00aaff, roughness: 0.2 });        
        
        this.commonUniforms = {
            texturePosition: { value: null }
        };

        material.onBeforeCompile = (shader) => {
            shader.uniforms.texturePosition = this.commonUniforms.texturePosition;
            shader.vertexShader = `
                uniform sampler2D texturePosition;
                attribute vec2 particleUV;
                ${shader.vertexShader}
            `.replace(
                `#include <begin_vertex>`,
                `#include <begin_vertex>
                vec4 posData = texture2D(texturePosition, particleUV);
                transformed = posData.xyz + position;`
            );
        };

        this.depthMaterial.uniforms.texturePosition = this.commonUniforms.texturePosition;

        this.mesh = new THREE.InstancedMesh(geometry, material, this.particleCount);
        this.mesh.frustumCulled = false;
        scene.add(this.mesh);
    }

    getThicknessMaterial() {
        return new THREE.ShaderMaterial({
            uniforms: {
                texturePosition: { value: null }
            },
            vertexShader: `
                uniform sampler2D texturePosition;
                attribute vec2 particleUV;
                varying vec2 vUv;
                void main() {
                    vUv = uv; // Use the default sphere UVs for the soft glow
                    vec4 posData = texture2D(texturePosition, particleUV);
                    vec4 mvPosition = modelViewMatrix * vec4(posData.xyz + position, 1.0);
                    gl_Position = projectionMatrix * mvPosition;
                }
            `,
            fragmentShader: `
                varying vec2 vUv;
                void main() {
                    // Create a soft, radial gradient for each particle
                    float dist = length(vUv - vec2(0.5));
                    float alpha = smoothstep(0.5, 0.1, dist);
                    
                    // Output a small amount of "thickness" per particle
                    gl_FragColor = vec4(alpha * 0.1, 0.0, 0.0, 1.0);
                }
            `,
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false, // Don't let particles hide each other
            depthTest: false   // Count every particle, even if it's behind another
        });
    }

    getDensityShader() {
        return `
            uniform float u_smoothingRadius;
            uniform float u_mass;
            uniform vec2 u_resolution;
            uniform float u_boxSize;
            uniform float u_gridSize;
            uniform float u_cellSize;
            uniform sampler2D u_cellTexture;
            uniform sampler2D u_sortedIndices;

            void main() {
                vec2 uv = gl_FragCoord.xy / resolution.xy;
                vec3 pos1 = texture2D(texturePosition, uv).xyz;
                float density = 0.0;

                ivec3 cellCoords = ivec3(floor((pos1 + vec3(u_boxSize, 0.0, u_boxSize)) / u_cellSize));

                for (int z = -1; z <= 1; z++) {
                    for (int y = -1; y <= 1; y++) {
                        for (int x = -1; x <= 1; x++) {
                            ivec3 neighbor = cellCoords + ivec3(x, y, z);
                            if (neighbor.x < 0 || neighbor.x >= int(u_gridSize) || neighbor.y < 0 || neighbor.y >= int(u_gridSize) || neighbor.z < 0 || neighbor.z >= int(u_gridSize)) continue;
                            
                            int hash = neighbor.x + (neighbor.y * int(u_gridSize)) + (neighbor.z * int(u_gridSize) * int(u_gridSize));
                            uint startIndex = uint(texelFetch(u_cellTexture, ivec2(hash, 0), 0).r);
                            if (startIndex == 4294967295u) continue;

                            for (uint i = 0u; i < 100u; i++) {
                                uint sortedIdx = startIndex + i;
                                if (sortedIdx >= uint(u_resolution.x * u_resolution.y)) break;
                                float origId = texelFetch(u_sortedIndices, ivec2(sortedIdx, 0), 0).r;
                                vec2 uv2 = vec2((mod(origId, u_resolution.x) + 0.5) / u_resolution.x, (floor(origId / u_resolution.x) + 0.5) / u_resolution.y);
                                
                                vec3 pos2 = texture2D(texturePosition, uv2).xyz;
                                float dst = distance(pos1, pos2);
                                if (dst < u_smoothingRadius) {
                                    float r2 = u_smoothingRadius * u_smoothingRadius;
                                    density += u_mass * (315.0 / (64.0 * 3.14159 * pow(u_smoothingRadius, 9.0))) * pow(r2 - dst * dst, 3.0);
                                }
                            }
                        }
                    }
                }
                gl_FragColor = vec4(max(density, 0.01), 0.0, 0.0, 1.0);
            }
        `;
    }

    getVelocityShader() {
        return `
            uniform float u_smoothingRadius;
            uniform float u_targetDensity;
            uniform float u_pressureMultiplier;
            uniform float u_viscosityMultiplier;
            uniform float u_mass;
            uniform vec2 u_resolution;
            uniform float u_boxSize;
            uniform vec3 u_ballPosition;
            uniform float u_ballRadius;
            uniform float u_gravity;
            uniform float u_deltaTime;
            uniform float u_gridSize;
            uniform float u_cellSize;
            uniform sampler2D u_cellTexture;
            uniform sampler2D u_sortedIndices;
            uniform float u_surfaceTension;

            void main() {
                vec2 uv = gl_FragCoord.xy / resolution.xy;
                vec3 pos1 = texture2D(texturePosition, uv).xyz;
                vec3 vel1 = texture2D(textureVelocity, uv).xyz;
                float dens1 = max(texture2D(textureDensity, uv).r, 0.1);
                float press1 = max((dens1 - u_targetDensity) * u_pressureMultiplier, 0.0);
                vec3 force = vec3(0.0, u_gravity * u_mass, 0.0);

                ivec3 cellCoords = ivec3(floor((pos1 + vec3(u_boxSize, 0.0, u_boxSize)) / u_cellSize));

                for (int z = -1; z <= 1; z++) {
                    for (int y = -1; y <= 1; y++) {
                        for (int x = -1; x <= 1; x++) {
                            ivec3 neighbor = cellCoords + ivec3(x, y, z);
                            if (neighbor.x < 0 || neighbor.x >= int(u_gridSize) || neighbor.y < 0 || neighbor.y >= int(u_gridSize) || neighbor.z < 0 || neighbor.z >= int(u_gridSize)) continue;
                            
                            int hash = neighbor.x + (neighbor.y * int(u_gridSize)) + (neighbor.z * int(u_gridSize) * int(u_gridSize));
                            uint startIndex = uint(texelFetch(u_cellTexture, ivec2(hash, 0), 0).r);
                            if (startIndex == 4294967295u) continue;

                            for (uint i = 0u; i < 100u; i++) {
                                uint sortedIdx = startIndex + i;
                                if (sortedIdx >= uint(u_resolution.x * u_resolution.y)) break;
                                float origId = texelFetch(u_sortedIndices, ivec2(sortedIdx, 0), 0).r;
                                vec2 uv2 = vec2((mod(origId, u_resolution.x) + 0.5) / u_resolution.x, (floor(origId / u_resolution.x) + 0.5) / u_resolution.y);
                                
                                if (distance(uv, uv2) < 0.001) continue;
                                vec3 pos2 = texture2D(texturePosition, uv2).xyz;
                                vec3 diff = pos1 - pos2;
                                float dst = length(diff);

                                if (dst < u_smoothingRadius) {
                                    if (dst < 0.001) { 
                                        diff = vec3(uv.x - uv2.x, uv.y - uv2.y, (uv.x + uv2.y) - 1.0); 
                                        dst = length(diff); 
                                        if (dst < 0.001) { diff = vec3(0.0, -1.0, 0.0); dst = 1.0; }
                                    }
                                    
                                    float dens2 = max(texture2D(textureDensity, uv2).r, 0.1);
                                    float press2 = max((dens2 - u_targetDensity) * u_pressureMultiplier, 0.0);
                                    vec3 dir = diff / dst;
                                    
                                    // 1. PRESSURE (Pushes neighbors apart if too close)
                                    force += dir * (press1 + press2) * pow(u_smoothingRadius - dst, 2.0);
                                    
                                    // 2. VISCOSITY (Slows neighbors down to match speeds)
                                    vec3 vel2 = texture2D(textureVelocity, uv2).xyz;
                                    force += (vel2 - vel1) * u_viscosityMultiplier * (u_smoothingRadius - dst);
                                    
                                    // 3. SURFACE TENSION / COHESION (Pulls neighbors together!)
                                    // Creates a parabolic weight that peaks at half the smoothing radius
                                    float tensionWeight = dst * (u_smoothingRadius - dst);
                                    force -= dir * u_surfaceTension * tensionWeight; 
                                }
                            }
                        }
                    }
                }

                vec3 toBall = pos1 - u_ballPosition;
                float distToBall = length(toBall);
                if (distToBall > 0.001 && distToBall < u_ballRadius + 0.5) {
                    force += (toBall / distToBall) * 100.0;
                }

                float limit = u_boxSize;
                float padding = 0.5;
                if (pos1.y < padding) force.y += (padding - pos1.y) * 200.0;
                if (pos1.y > limit*2.0 - padding) force.y -= (pos1.y - (limit*2.0 - padding)) * 200.0;
                if (abs(pos1.x) > limit - padding) force.x -= sign(pos1.x) * (abs(pos1.x)-(limit-padding)) * 200.0;
                if (abs(pos1.z) > limit - padding) force.z -= sign(pos1.z) * (abs(pos1.z)-(limit-padding)) * 200.0;

                vel1 += (force / dens1) * u_deltaTime;
                vel1 *= 0.992; 

                float bounce = -0.3;
                if (pos1.x >= limit && vel1.x > 0.0) vel1.x *= bounce;
                if (pos1.x <= -limit && vel1.x < 0.0) vel1.x *= bounce;
                if (pos1.y >= limit * 2.0 && vel1.y > 0.0) vel1.y *= bounce;
                if (pos1.y <= 0.0 && vel1.y < 0.0) vel1.y *= bounce;
                if (pos1.z >= limit && vel1.z > 0.0) vel1.z *= bounce;
                if (pos1.z <= -limit && vel1.z < 0.0) vel1.z *= bounce;

                gl_FragColor = vec4(clamp(vel1, vec3(-15.0), vec3(15.0)), 1.0);
            }
        `;
    }

    getPositionShader() {
        return `
            uniform float u_boxSize;
            uniform vec3 u_ballPosition;
            uniform float u_ballRadius;
            uniform float u_deltaTime;
            void main() {
                vec2 uv = gl_FragCoord.xy / resolution.xy;
                vec3 pos = texture2D(texturePosition, uv).xyz;
                vec3 vel = texture2D(textureVelocity, uv).xyz;
                pos += vel * u_deltaTime;
                vec3 toBall = pos - u_ballPosition;
                if (length(toBall) < u_ballRadius) pos = u_ballPosition + normalize(toBall) * u_ballRadius;
                float limit = u_boxSize;
                pos.x = clamp(pos.x, -limit, limit);
                pos.y = clamp(pos.y, 0.0, limit * 2.0);
                pos.z = clamp(pos.z, -limit, limit);
                gl_FragColor = vec4(pos, 1.0);
            }
        `;
    }

    update(ballPos, time, deltaTime) {
        const posRenderTarget = this.gpuCompute.getCurrentRenderTarget(this.positionVariable);
        this.renderer.readRenderTargetPixels(posRenderTarget, 0, 0, this.WIDTH, this.WIDTH, this.gpuReadBuffer);

        const limit = this.sphUniforms.u_boxSize.value;
        const sortedParticles = [];
        for (let i = 0; i < this.particleCount; i++) {
            const idx = i * 4;
            const px = THREE.DataUtils.fromHalfFloat(this.gpuReadBuffer[idx + 0]) + limit;
            const py = THREE.DataUtils.fromHalfFloat(this.gpuReadBuffer[idx + 1]);
            const pz = THREE.DataUtils.fromHalfFloat(this.gpuReadBuffer[idx + 2]) + limit;

            const cx = Math.max(0, Math.min(Math.floor(px / this.cellSize), this.gridSize - 1));
            const cy = Math.max(0, Math.min(Math.floor(py / this.cellSize), this.gridSize - 1));
            const cz = Math.max(0, Math.min(Math.floor(pz / this.cellSize), this.gridSize - 1));

            sortedParticles.push({ hash: cx + (cy * this.gridSize) + (cz * this.gridSize * this.gridSize), id: i });
        }
        sortedParticles.sort((a, b) => a.hash - b.hash);

        this.cellOffsets.fill(0xFFFFFFFF); 
        for (let i = 0; i < this.particleCount; i++) {
            if (i === 0 || sortedParticles[i].hash !== sortedParticles[i - 1].hash) {
                this.cellOffsets[sortedParticles[i].hash] = i;
            }
            this.sortedIndicesData[i * 4] = sortedParticles[i].id; 
        }
        for (let i = 0; i < this.totalCells; i++) this.cellTextureData[i * 4] = this.cellOffsets[i]; 

        this.cellTexture.needsUpdate = true;
        this.sortedIndicesTexture.needsUpdate = true;

        this.velocityVariable.material.uniforms.u_ballPosition.value.copy(ballPos);
        this.velocityVariable.material.uniforms.u_deltaTime.value = deltaTime;
        this.positionVariable.material.uniforms.u_ballPosition.value.copy(ballPos);
        this.positionVariable.material.uniforms.u_deltaTime.value = deltaTime;

        this.gpuCompute.compute();
        this.commonUniforms.texturePosition.value = this.gpuCompute.getCurrentRenderTarget(this.positionVariable).texture;
    }
}