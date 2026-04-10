import * as THREE from 'three';

export const lakeScene = {
  build() {
    const g = new THREE.Group();

    // Sandy ground plane
    const floorGeom = new THREE.PlaneGeometry(140, 140);
    floorGeom.rotateX(-Math.PI / 2);
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x8B7355,
      roughness: 0.92,
      metalness: 0.0,
    });
    const floor = new THREE.Mesh(floorGeom, floorMat);
    floor.position.y = -0.02;
    g.add(floor);

    // Grass ring around the "lake" area
    const grassGeom = new THREE.RingGeometry(22, 50, 64);
    grassGeom.rotateX(-Math.PI / 2);
    const grassMat = new THREE.MeshStandardMaterial({
      color: 0x5a7a3a,
      roughness: 0.95,
      metalness: 0.0,
    });
    const grass = new THREE.Mesh(grassGeom, grassMat);
    grass.position.y = 0.01;
    g.add(grass);

    // Shoreline rocks — 3 size tiers, varied colors
    const rockColors = [0x6B6357, 0x7a7060, 0x5e5850];
    const mossColors = [0x4a5a3a, 0x3d4e30];
    const rockGeo = new THREE.DodecahedronGeometry(1.0, 0);
    for (let i = 0; i < 24; i++) {
      const isMoss = i % 5 === 0;
      const col = isMoss
        ? mossColors[i % mossColors.length]
        : rockColors[i % rockColors.length];
      const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.92 });
      const rock = new THREE.Mesh(rockGeo, mat);
      const a = (i / 24) * Math.PI * 2;
      const r = 18 + Math.sin(i * 2.3) * 3.5;
      const tier = (i % 3);
      const s = tier === 0 ? 0.6 : tier === 1 ? 1.1 : 1.6;
      rock.position.set(Math.cos(a) * r, s * 0.55, Math.sin(a) * r);
      rock.rotation.set(i * 0.4, i * 0.7, i * 0.3);
      rock.scale.setScalar(s);
      g.add(rock);
    }

    // Simple trees (cylinder trunk + icosahedron foliage)
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6B4226, roughness: 0.88 });
    const foliageMat = new THREE.MeshStandardMaterial({ color: 0x3a6b28, roughness: 0.82 });
    const trunkGeo = new THREE.CylinderGeometry(0.25, 0.35, 4, 8);
    const foliageGeo = new THREE.IcosahedronGeometry(2.0, 1);
    const treePositions = [
      [-25, 32], [-22, 28], [-18, 34],
      [26, 30], [22, 34], [30, 26],
      [-30, -24], [-26, -30], [28, -28],
    ];
    for (const [x, z] of treePositions) {
      const trunk = new THREE.Mesh(trunkGeo, trunkMat);
      trunk.position.set(x, 2, z);
      g.add(trunk);
      const foliage = new THREE.Mesh(foliageGeo, foliageMat.clone());
      foliage.material.color.setHex(0x3a6b28 + Math.floor(Math.random() * 0x101010));
      foliage.position.set(x, 5.5 + Math.random() * 0.5, z);
      const fs = 0.8 + Math.random() * 0.5;
      foliage.scale.set(fs, fs * 0.8, fs);
      g.add(foliage);
    }

    // Subtle grid for spatial reference
    const grid = new THREE.GridHelper(140, 70, 0x988868, 0x887858);
    grid.position.y = 0.005;
    grid.material.opacity = 0.15;
    grid.material.transparent = true;
    g.add(grid);

    return g;
  },

  defaults: {
    fog: { color: 0x9ec5e8, near: 50, far: 150 },
    background: 0x87CEEB,
    camera: { position: new THREE.Vector3(28, 18, 28) },
    controls: { target: new THREE.Vector3(0, 8, 0) },
    dirLight: { position: new THREE.Vector3(8, 20, 10), intensity: 1.6 },
  },
};
