import * as THREE from 'three';

export const riverScene = {
  build() {
    const g = new THREE.Group();

    // River bed — sand / gravel color
    const bedGeom = new THREE.PlaneGeometry(100, 50, 1, 1);
    bedGeom.rotateX(-Math.PI / 2);
    const bedMat = new THREE.MeshStandardMaterial({
      color: 0x7a6e5d,
      roughness: 0.94,
      metalness: 0.0,
    });
    const bed = new THREE.Mesh(bedGeom, bedMat);
    bed.position.y = -0.05;
    bed.rotation.y = Math.PI * 0.5;
    g.add(bed);

    // Banks — earthy brown raised boxes
    const bankMat = new THREE.MeshStandardMaterial({
      color: 0x5a4e3e,
      roughness: 0.92,
      metalness: 0.0,
    });
    const bankGeom = new THREE.BoxGeometry(100, 6, 8);
    const leftBank = new THREE.Mesh(bankGeom, bankMat);
    leftBank.position.set(-14, 2.5, 0);
    g.add(leftBank);
    const rightBank = new THREE.Mesh(bankGeom, bankMat);
    rightBank.position.set(14, 2.5, 0);
    g.add(rightBank);

    // Green grass strips on top of banks
    const grassMat = new THREE.MeshStandardMaterial({
      color: 0x5a7a3a,
      roughness: 0.9,
    });
    const grassGeo = new THREE.BoxGeometry(100, 0.3, 8);
    const leftGrass = new THREE.Mesh(grassGeo, grassMat);
    leftGrass.position.set(-14, 5.6, 0);
    g.add(leftGrass);
    const rightGrass = new THREE.Mesh(grassGeo, grassMat);
    rightGrass.position.set(14, 5.6, 0);
    g.add(rightGrass);

    // Rocks in the river bed — lighter gray, varied
    const rockColors = [0x6a6a6a, 0x7a7570, 0x5e5e5e];
    const rockGeo = new THREE.IcosahedronGeometry(1.2, 0);
    for (let i = 0; i < 16; i++) {
      const col = rockColors[i % rockColors.length];
      const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.9 });
      const rock = new THREE.Mesh(rockGeo, mat);
      rock.position.set(
        (Math.random() - 0.5) * 12,
        0.5 + Math.random() * 0.6,
        -30 + i * 4.0 + Math.random() * 2,
      );
      rock.rotation.set(Math.random() * 2, Math.random() * 3, Math.random() * 2);
      rock.scale.setScalar(0.5 + Math.random() * 0.8);
      g.add(rock);
    }

    // Bushes on banks (small spheres)
    const bushMat = new THREE.MeshStandardMaterial({ color: 0x4a7a30, roughness: 0.85 });
    const bushGeo = new THREE.SphereGeometry(1.2, 8, 6);
    const bushPositions = [
      [-16, 6.4, -15], [-16, 6.4, 0], [-16, 6.4, 12],
      [16, 6.4, -10], [16, 6.4, 8], [16, 6.4, 20],
    ];
    for (const [x, y, z] of bushPositions) {
      const bush = new THREE.Mesh(bushGeo, bushMat);
      bush.position.set(x, y, z);
      bush.scale.set(1.0 + Math.random() * 0.4, 0.7 + Math.random() * 0.3, 1.0 + Math.random() * 0.4);
      g.add(bush);
    }

    // Subtle grid
    const grid = new THREE.GridHelper(120, 60, 0x8a7e6e, 0x7a6e5e);
    grid.position.y = 0.0;
    grid.material.opacity = 0.12;
    grid.material.transparent = true;
    g.add(grid);

    return g;
  },

  defaults: {
    fog: { color: 0x9ec5e8, near: 35, far: 130 },
    background: 0x87CEEB,
    camera: { position: new THREE.Vector3(32, 16, 20) },
    controls: { target: new THREE.Vector3(0, 6.5, 0) },
    dirLight: { position: new THREE.Vector3(10, 20, 6), intensity: 1.6 },
  },

  onEnter({ fluid, ballMesh }) {
    fluid.sphUniforms.u_agitation.value = Math.max(fluid.sphUniforms.u_agitation.value, 1.2);
    ballMesh.position.set(0, 10, -8);
  },
};
