import * as THREE from 'three';
import { lakeScene } from './lake.js';
import { riverScene } from './river.js';
import { waterfallScene } from './waterfall.js';

const SCENES = {
  Lake: lakeScene,
  River: riverScene,
  Waterfall: waterfallScene,
};

export function createSceneManager({
  scene,
  camera,
  controls,
  fluid,
  tankMesh,
  ballMesh,
  dirLight,
  hemiLight,
}) {
  let activeGroup = null;
  let activeName = null;

  function applyDefaults(def) {
    if (def.fog) {
      scene.fog = new THREE.Fog(def.fog.color, def.fog.near, def.fog.far);
    } else {
      scene.fog = new THREE.Fog(0x9ec5e8, 60, 180);
    }

    if (def.background != null) {
      scene.background = new THREE.Color(def.background);
    } else {
      scene.background = new THREE.Color(0x87CEEB);
    }

    if (def.camera) {
      camera.position.copy(def.camera.position);
      camera.updateProjectionMatrix();
    }
    if (def.controls) {
      controls.target.copy(def.controls.target);
      controls.update();
    }
    if (def.dirLight) {
      dirLight.position.copy(def.dirLight.position);
      dirLight.intensity = def.dirLight.intensity ?? 1.6;
    }
    if (def.hemiLight && hemiLight) {
      if (def.hemiLight.skyColor != null) hemiLight.color.set(def.hemiLight.skyColor);
      if (def.hemiLight.groundColor != null) hemiLight.groundColor.set(def.hemiLight.groundColor);
      if (def.hemiLight.intensity != null) hemiLight.intensity = def.hemiLight.intensity;
    }
  }

  function setScene(name) {
    const def = SCENES[name];
    if (!def) return;

    if (activeGroup) {
      scene.remove(activeGroup);
      activeGroup.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose?.();
        if (obj.material) {
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose?.());
          else obj.material.dispose?.();
        }
      });
    }

    activeGroup = def.build();
    activeName = name;
    scene.add(activeGroup);

    applyDefaults(def.defaults || {});
    def.onEnter?.({ fluid, tankMesh, ballMesh, camera, controls });
  }

  return {
    get names() {
      return Object.keys(SCENES);
    },
    get activeName() {
      return activeName;
    },
    setScene,
  };
}
