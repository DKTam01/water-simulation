import * as THREE from 'three';

export const waterfallScene = {
  build() {
    const g = new THREE.Group();

    // Basin floor — gravel
    const floorGeom = new THREE.PlaneGeometry(100, 100);
    floorGeom.rotateX(-Math.PI / 2);
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x6e6355,
      roughness: 0.92,
      metalness: 0.0,
    });
    const floor = new THREE.Mesh(floorGeom, floorMat);
    floor.position.y = -0.05;
    g.add(floor);

    // Cliff wall — dark stone with height variation
    const cliffBase = new THREE.MeshStandardMaterial({
      color: 0x5a5a60,
      roughness: 0.96,
      metalness: 0.05,
    });
    const cliff = new THREE.Mesh(new THREE.BoxGeometry(42, 26, 7), cliffBase);
    cliff.position.set(0, 13, -18);
    g.add(cliff);

    // Accent layer on the cliff (slightly different color for visual break)
    const accentMat = new THREE.MeshStandardMaterial({
      color: 0x4a4a50,
      roughness: 0.98,
    });
    const accent = new THREE.Mesh(new THREE.BoxGeometry(40, 4, 7.2), accentMat);
    accent.position.set(0, 8, -18);
    g.add(accent);
    const accent2 = new THREE.Mesh(new THREE.BoxGeometry(38, 3, 7.1), accentMat);
    accent2.position.set(0, 18, -18);
    g.add(accent2);

    // Moss patches on the cliff face (flat green planes)
    const mossMat = new THREE.MeshStandardMaterial({
      color: 0x4a6b38,
      roughness: 0.88,
      side: THREE.DoubleSide,
    });
    const mossPositions = [
      [-12, 15, -14.3], [-6, 10, -14.3], [4, 12, -14.3],
      [10, 17, -14.3], [-8, 20, -14.3], [8, 8, -14.3],
    ];
    for (const [x, y, z] of mossPositions) {
      const mossGeo = new THREE.PlaneGeometry(
        2.5 + Math.random() * 2,
        1.5 + Math.random() * 2,
      );
      const moss = new THREE.Mesh(mossGeo, mossMat);
      moss.position.set(x, y, z);
      moss.rotation.y = Math.random() * 0.3 - 0.15;
      g.add(moss);
    }

    // Basin rocks — varied sizes, some partially submerged
    const rockColors = [0x6a6a6a, 0x5e5e5e, 0x7a7570];
    const rockGeo = new THREE.DodecahedronGeometry(1.3, 0);
    for (let i = 0; i < 18; i++) {
      const col = rockColors[i % rockColors.length];
      const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.92 });
      const rock = new THREE.Mesh(rockGeo, mat);
      const angle = (i / 18) * Math.PI * 1.2 - Math.PI * 0.6;
      const radius = 8 + Math.random() * 14;
      rock.position.set(
        Math.sin(angle) * radius,
        0.5 + Math.random() * 1.2,
        -8 + Math.cos(angle) * radius * 0.4 + Math.random() * 3,
      );
      rock.rotation.set(Math.random() * 2, Math.random() * 3, Math.random());
      rock.scale.setScalar(0.6 + Math.random() * 1.0);
      g.add(rock);
    }

    // Side cliff extensions
    const sideMat = new THREE.MeshStandardMaterial({ color: 0x555560, roughness: 0.95 });
    const leftWall = new THREE.Mesh(new THREE.BoxGeometry(8, 20, 24), sideMat);
    leftWall.position.set(-23, 10, -10);
    g.add(leftWall);
    const rightWall = new THREE.Mesh(new THREE.BoxGeometry(8, 20, 24), sideMat);
    rightWall.position.set(23, 10, -10);
    g.add(rightWall);

    // Subtle grid
    const grid = new THREE.GridHelper(100, 50, 0x8a7e6e, 0x7a6e5e);
    grid.position.y = 0.005;
    grid.material.opacity = 0.1;
    grid.material.transparent = true;
    g.add(grid);

    return g;
  },

  defaults: {
    fog: { color: 0x8ab8d8, near: 20, far: 90 },
    background: 0x87CEEB,
    camera: { position: new THREE.Vector3(30, 18, 26) },
    controls: { target: new THREE.Vector3(0, 7.5, -6) },
    dirLight: { position: new THREE.Vector3(6, 22, 10), intensity: 1.6 },
  },

  onEnter({ fluid, tankMesh, ballMesh }) {
    const boxSize = 10.0;
    fluid.sphUniforms.u_boxSize.value = boxSize;
    tankMesh.scale.set(boxSize * 2, boxSize * 2, boxSize * 2);
    tankMesh.position.set(0, boxSize, 0);
    tankMesh.updateMatrixWorld();

    ballMesh.position.set(0, 8, -6);
    fluid.resetParticles('wave');
  },
};
