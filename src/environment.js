import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Large four-quadrant baseplate + fluid tank layout
// ---------------------------------------------------------------------------

/** Default vertical headroom (world units) above terrain under the fluid footprint. */
export const DEFAULT_FLUID_HEADROOM = 14.0;

/** Number of samples per axis when computing terrain height range for OBB height. */
export const TERRAIN_SAMPLE_STEPS = 48;

/** Vertical spawn offset as a fraction of OBB half-height. */
export const SPAWN_Y_FRACTION = 0.12;

/**
 * Baseplate height at (x, z) — must match `terrainHeight` in particles.js GLSL.
 */
export function sampleBaseplateY(x, z, s) {
    const amp = s.baseplateBumpAmp;
    const freq = s.baseplateBumpFreq;
    const ripple = amp * Math.sin(x * freq) * Math.cos(z * freq);
    return s.baseplateYOffset + ripple - x * s.baseplateTiltX - z * s.baseplateTiltZ;
}

/**
 * Vertex colors for the four quadrants (visual only): +X/+Z, -X/+Z, -X/-Z, +X/-Z.
 */
function quadrantColor(x, z) {
    if (x >= 0 && z >= 0) return new THREE.Color(0xc75b39);
    if (x < 0 && z >= 0) return new THREE.Color(0x3d6b9e);
    if (x < 0 && z < 0) return new THREE.Color(0x6b3d8e);
    return new THREE.Color(0x2d8f6f);
}

/**
 * Fluid simulation OBB: horizontal size from `fluidRegionWidth` / `fluidRegionLength` (clamped
 * inside the square baseplate). Vertical extent follows terrain under that footprint + headroom.
 * Baseplate size is not changed.
 */
export function syncFluidTank(tankMesh, uiSettings, sphUniforms, fluid) {
    const maxBoxHalf = sphUniforms ? sphUniforms.u_maxBoxSize.value : 25.0;
    const plateHalf = uiSettings.baseplateSize * 0.5;
    const maxHalfOnPlate = Math.max(2, plateHalf - 1);

    const wantHalfW = uiSettings.fluidRegionWidth * 0.5;
    const wantHalfLen = uiSettings.fluidRegionLength * 0.5;
    const halfW = Math.min(Math.max(4, wantHalfW), maxHalfOnPlate, maxBoxHalf - 0.5);
    const halfLen = Math.min(Math.max(4, wantHalfLen), maxHalfOnPlate, maxBoxHalf - 1.0);

    const headroom = Math.max(4, uiSettings.fluidHeadroom);

    let minBedY = Infinity;
    let maxBedY = -Infinity;
    const steps = TERRAIN_SAMPLE_STEPS;
    for (let iz = 0; iz <= steps; iz++) {
        const z = -halfLen + (halfLen * 2 * iz) / steps;
        for (let ix = 0; ix <= steps; ix++) {
            const x = -halfW + (halfW * 2 * ix) / steps;
            const y = sampleBaseplateY(x, z, uiSettings);
            if (y < minBedY) minBedY = y;
            if (y > maxBedY) maxBedY = y;
        }
    }

    const halfH = Math.min((maxBedY - minBedY) * 0.5 + headroom, maxBoxHalf - 0.5);
    const centerY = minBedY + halfH;
    const centerZ = 0;
    const lift = Math.max(0, uiSettings.fluidContainerLift ?? 0);

    tankMesh.rotation.set(0, 0, 0);
    tankMesh.scale.set(halfW * 2, halfH * 2, halfLen * 2);
    tankMesh.position.set(0, centerY + lift, centerZ);
    tankMesh.updateMatrixWorld();

    if (sphUniforms) {
        sphUniforms.u_boxSize.value = Math.max(halfW, halfH, halfLen);
        sphUniforms.u_flowPeriodWorld.value = tankMesh.scale.z;
    }

    if (fluid) {
        const spawnX = 0;
        const spawnZ = 0;
        const bedYSpawn = sampleBaseplateY(spawnX, spawnZ, uiSettings);
        fluid.spawnOrigin.set(spawnX, bedYSpawn + halfH * SPAWN_Y_FRACTION + lift, spawnZ);
    }
}

export function setupEnvironment(scene, uiSettings) {
    const terrainMaterial = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.9,
        metalness: 0.02,
    });

    let ground;

    function generateTerrain() {
        if (ground) {
            scene.remove(ground);
            ground.geometry.dispose();
        }

        const seg = Math.max(8, Math.floor(uiSettings.baseplateSeg));
        const L = uiSettings.baseplateSize;

        const geometry = new THREE.PlaneGeometry(L, L, seg, seg);
        geometry.rotateX(-Math.PI / 2);

        const positionAttribute = geometry.attributes.position;
        const colors = new Float32Array(positionAttribute.count * 3);

        for (let i = 0; i < positionAttribute.count; i++) {
            const x = positionAttribute.getX(i);
            const z = positionAttribute.getZ(i);
            const y = sampleBaseplateY(x, z, uiSettings);
            positionAttribute.setY(i, y);

            const c = quadrantColor(x, z);
            colors[i * 3 + 0] = c.r;
            colors[i * 3 + 1] = c.g;
            colors[i * 3 + 2] = c.b;
        }

        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        geometry.computeVertexNormals();

        ground = new THREE.Mesh(geometry, terrainMaterial);
        ground.receiveShadow = true;
        scene.add(ground);
    }

    generateTerrain();

    return {
        generateTerrain,
        setWireframe: (value) => {
            terrainMaterial.wireframe = value;
        },
        syncFluidTank: (tankMesh, sphUniforms, fluid) =>
            syncFluidTank(tankMesh, uiSettings, sphUniforms, fluid),
    };
}
