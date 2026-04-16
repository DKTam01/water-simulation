import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Terrain / tank layout constants — centralised here so any change propagates
// to both the JS terrain mesh and the GPU shader that uses the same formula.
// ---------------------------------------------------------------------------

/** Fraction of planeLength at which the cliff step falls (upstream end = -L/2). */
export const CLIFF_Z_RATIO = 0.35;

/** Sigma multiplier used to derive tank half-width from sqrt(riverWidth). */
export const TANK_WIDTH_SIGMA = 1.72;

/** Extra flat margin (world units) added to tank half-width beyond the Gaussian fit. */
export const TANK_WIDTH_MARGIN = 1.4;

/** Number of Z samples when computing terrain height range for OBB height. */
export const TERRAIN_SAMPLE_STEPS = 48;

/** Vertical headroom (world units) above the tallest riverbed point inside the OBB. */
export const TANK_HEADROOM = 13.5;

/** Spawn Z margin from the upstream OBB wall — kept as a safety net fallback. */
export const SPAWN_Z_MARGIN = 6.0;

/**
 * World-Z offset added to riverCliffZ to place spawn in the calm flat section
 * downstream of the waterfall. Particles settle here first and only reach the
 * cliff after wrapping through the periodic loop — preventing the mass-dump
 * of all particles falling simultaneously at startup.
 */
export const SPAWN_CLIFF_OFFSET = 12.0;

/** Vertical spawn offset as a fraction of OBB half-height. */
export const SPAWN_Y_FRACTION = 0.1;

/**
 * Cliff tanh transition sharpness.  Lower = softer cliff lip.
 * Must match the literal value used in the GLSL terrainHeight functions in particles.js.
 */
export const CLIFF_SHARPNESS = 0.45;

// ---------------------------------------------------------------------------

/**
 * World-Z position of the cliff/waterfall transition.
 * Placing it at -L*CLIFF_Z_RATIO gives an upper channel of (1-CLIFF_Z_RATIO)*100%
 * and a lower channel — a long downstream run that lets water spread before looping.
 */
export function riverCliffZ(s) {
    return -s.planeLength * CLIFF_Z_RATIO;
}

/** Terrain height (riverbed) at (x, z) — same formula as the procedural ground mesh. */
export function sampleRiverBedY(x, z, s) {
    let h = -s.riverDepth * Math.exp(-(x * x) / s.riverWidth);
    h += (1 - Math.tanh((z - riverCliffZ(s)) * CLIFF_SHARPNESS)) * s.cliffHeight;
    h -= z * s.flowSlope;
    return h;
}

/** Nominal water surface height along the channel (used to place the fluid tank). */
export function sampleRiverWaterlineY(x, z, s) {
    let h = -s.riverDepth * Math.exp(-(x * x) / s.riverWidth);
    h += (1 - Math.tanh((z - riverCliffZ(s)) * CLIFF_SHARPNESS)) * s.cliffHeight;
    h -= z * s.flowSlope;
    h += -s.riverDepth * 0.35;
    return h;
}

/**
 * Aligns the SPH collision box (unit cube scaled on tankMesh) with the carved river:
 * long axis = world Z (flow), narrow on X (matches Gaussian channel), tall enough for fluid.
 * Updates sphUniforms.u_boxSize / u_flowPeriodWorld when provided.
 */
export function syncFluidTankToRiver(tankMesh, uiSettings, sphUniforms, fluid) {
    const maxBoxHalf = sphUniforms ? sphUniforms.u_maxBoxSize.value : 25.0;

    // Width: Gaussian trough plus extra margin so dense SPH does not slam the ±X walls.
    const halfW = Math.min(
        Math.sqrt(Math.max(uiSettings.riverWidth, 0.5)) * TANK_WIDTH_SIGMA + TANK_WIDTH_MARGIN,
        maxBoxHalf - 0.5
    );

    // Length: span the full terrain — from the top of the waterfall (-planeLength/2)
    // to the flat exit (+planeLength/2).  Particles that exit the +Z end are
    // toroidally wrapped back to -Z, where the terrain-floor clamp pushes them
    // back up to the cliff height, creating a continuous waterfall → river loop.
    const rawHalfLen = uiSettings.planeLength * 0.5;   // = planeLength / 2
    const halfLen    = Math.min(rawHalfLen, maxBoxHalf - 1.0);

    // Tank is centred at z = 0 (cliff face at the middle, waterfall above, flat below).
    const centerZ = 0;

    // Y: sample the actual terrain height range along the river centre (x=0) so the
    // OBB never sits above the riverbed downstream — which would cause the box-wall
    // bounce to block particles before the terrain-floor clamp can seat them properly.
    let minBedY = Infinity, maxBedY = -Infinity;
    const zSteps = TERRAIN_SAMPLE_STEPS;
    for (let i = 0; i <= zSteps; i++) {
        const z = -halfLen + (halfLen * 2 * i / zSteps);
        const y = sampleRiverBedY(0, z, uiSettings);
        if (y < minBedY) minBedY = y;
        if (y > maxBedY) maxBedY = y;
    }
    // OBB covers the full height range, plus generous headroom so splashes and pressure
    // spikes do not hit the roof; extra floor margin keeps the OBB below the terrain mesh.
    const halfH   = Math.min((maxBedY - minBedY) * 0.5 + TANK_HEADROOM, maxBoxHalf - 0.5);
    // Bias the center Y toward minBedY so the OBB floor never sits above the flat
    // downstream riverbed. Without this the large upstream cliff skews the mid-point high,
    // which causes the downstream OBB floor to clip through the terrain and produce a
    // hard wall that particles pile against instead of wrapping forward.
    const centerY = minBedY + halfH;

    tankMesh.rotation.set(0, 0, 0);
    tankMesh.scale.set(halfW * 2, halfH * 2, halfLen * 2);
    tankMesh.position.set(0, centerY, centerZ);
    tankMesh.updateMatrixWorld();

    if (sphUniforms) {
        sphUniforms.u_boxSize.value = Math.max(halfW, halfH, halfLen);
        sphUniforms.u_flowPeriodWorld.value = tankMesh.scale.z;
    }

    // Spawn in the flat section just downstream of the cliff so all particles begin
    // in calm water rather than on top of the waterfall. They flow down through the
    // periodic loop and arrive at the cliff gradually, preventing the startup mass-dump.
    if (fluid) {
        const cliffZ = riverCliffZ(uiSettings);
        const spawnZ = Math.min(cliffZ + SPAWN_CLIFF_OFFSET, halfLen - SPAWN_Z_MARGIN);
        const bedYSpawn = sampleRiverBedY(0, spawnZ, uiSettings);
        fluid.spawnOrigin.set(0, bedYSpawn + halfH * SPAWN_Y_FRACTION, spawnZ);
    }
}

export function setupEnvironment(scene, uiSettings) {
    const terrainMaterial = new THREE.MeshStandardMaterial({
        color: 0x3e8e41,
        wireframe: false,
        roughness: 0.95,
    });

    let ground;

    function generateTerrain() {
        if (ground) {
            scene.remove(ground);
            ground.geometry.dispose();
        }

        const geometry = new THREE.PlaneGeometry(uiSettings.planeWidth, uiSettings.planeLength, 100, 100);
        geometry.rotateX(-Math.PI / 2);

        const positionAttribute = geometry.attributes.position;
        for (let i = 0; i < positionAttribute.count; i++) {
            const x = positionAttribute.getX(i);
            const z = positionAttribute.getZ(i);
            let height = sampleRiverBedY(x, z, uiSettings);
            positionAttribute.setY(i, height);
        }
        geometry.computeVertexNormals();

        ground = new THREE.Mesh(geometry, terrainMaterial);
        scene.add(ground);
    }

    generateTerrain();

    return {
        generateTerrain,
        setWireframe: (value) => {
            terrainMaterial.wireframe = value;
        },
        syncFluidTankToRiver: (tankMesh, sphUniforms, fluid) =>
            syncFluidTankToRiver(tankMesh, uiSettings, sphUniforms, fluid),
    };
}
