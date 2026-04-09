import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { setupEnvironment } from './environment.js';
import { ParticleFluid } from './particles.js';
import { surfaceShader } from './surface.js';
import { blurShader } from './blur.js';
import GUI from 'lil-gui';

// 1. Scene Setup
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a0a); 

const loader = new THREE.CubeTextureLoader();
// You can find free "cube maps" online (formatted as px, nx, py, ny, pz, nz)
const envMap = loader.load([
    'path/to/posx.jpg', 'path/to/negx.jpg',
    'path/to/posy.jpg', 'path/to/negy.jpg',
    'path/to/posz.jpg', 'path/to/negz.jpg'
]);

scene.background = envMap; // This makes the world look like the skybox
scene.environment = envMap; // This makes the red ball reflect the skybox

// Pulled back to view the larger 20x20x20 tank
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(25, 20, 25); 

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
const pixelRatio = window.devicePixelRatio;
renderer.setPixelRatio(pixelRatio);

// Force Float extensions for Safari/Mobile compatibility
const gl = renderer.getContext();
if (gl) {
    gl.getExtension('OES_texture_float');
    gl.getExtension('EXT_color_buffer_half_float');
    gl.getExtension('WEBGL_color_buffer_float'); 
} else {
    console.error("WebGL Context failed to initialize.");
}

document.body.appendChild(renderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement);
const clock = new THREE.Clock(); 

// 2. Render Targets (High-DPI aware)
const targetConfig = { 
    minFilter: THREE.NearestFilter, 
    magFilter: THREE.NearestFilter, 
    type: THREE.FloatType 
};
const w = window.innerWidth * pixelRatio;
const h = window.innerHeight * pixelRatio;

const opaqueTarget = new THREE.WebGLRenderTarget(w, h, targetConfig);
const depthTarget = new THREE.WebGLRenderTarget(w, h, targetConfig);
const thicknessTarget = new THREE.WebGLRenderTarget(w, h, targetConfig);
const blurTargetX = new THREE.WebGLRenderTarget(w, h, targetConfig);
const blurTargetY = new THREE.WebGLRenderTarget(w, h, targetConfig);

// 3. Post-Processing Materials
const blurMatX = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.clone(blurShader.uniforms),
    vertexShader: blurShader.vertexShader,
    fragmentShader: blurShader.fragmentShader
});
blurMatX.uniforms.uDirection.value.set(1.0, 0.0);
blurMatX.uniforms.uResolution.value.set(w, h);

const blurMatY = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.clone(blurShader.uniforms),
    vertexShader: blurShader.vertexShader,
    fragmentShader: blurShader.fragmentShader
});
blurMatY.uniforms.uDirection.value.set(0.0, 1.0);
blurMatY.uniforms.uResolution.value.set(w, h);

// 4. World Objects
scene.add(new THREE.AmbientLight(0xffffff, 0.4));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
dirLight.position.set(5, 10, 7);
scene.add(dirLight);

const ballMesh = new THREE.Mesh(
    new THREE.SphereGeometry(1.5, 32, 32),
    new THREE.MeshStandardMaterial({ color: 0x00ffaa, emissive: 0x002211 })
);
ballMesh.position.set(0, 3, 0); 
scene.add(ballMesh);

setupEnvironment(scene);
const fluid = new ParticleFluid(renderer, scene, {});

// 5. Post Processing Scene Setup
const postScene = new THREE.Scene();
const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const surfaceMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial(surfaceShader));
surfaceMesh.material.transparent = true; 
postScene.add(surfaceMesh);

// 6. UI Controls
const gui = new GUI();
const ballFolder = gui.addFolder('Interaction Ball');
ballFolder.add(ballMesh.position, 'x', -10, 10).name('Move X');
ballFolder.add(ballMesh.position, 'y', 0, 18).name('Move Y');
ballFolder.add(ballMesh.position, 'z', -10, 10).name('Move Z');

const sphFolder = gui.addFolder('SPH Physics');
const uniforms = fluid.sphUniforms;
sphFolder.add(uniforms.u_smoothingRadius, 'value', 0.5, 3.0).name('Smoothing Radius').onChange((val) => {
    // Tell the fluid class to recalculate its grid size
    fluid.cellSize = val;
    fluid.gridSize = Math.ceil((fluid.sphUniforms.u_boxSize.value * 2.0) / val);
    fluid.totalCells = fluid.gridSize * fluid.gridSize * fluid.gridSize;
    // Note: To be perfect, you'd also need to resize fluid.cellTexture here
});
sphFolder.add(uniforms.u_surfaceTension, 'value', 0.0, 100.0).name('Surface Tension');
sphFolder.add(uniforms.u_targetDensity, 'value', 1.0, 20.0).name('Target Density');
sphFolder.add(uniforms.u_pressureMultiplier, 'value', 1.0, 200.0).name('Pressure');
sphFolder.add(uniforms.u_viscosityMultiplier, 'value', 0.0, 50.0).name('Viscosity');
sphFolder.add(uniforms.u_gravity, 'value', -30.0, 0.0).name('Gravity');

// 7. Core Render Pipeline
function animate() {
    requestAnimationFrame(animate);
    const delta = Math.min(clock.getDelta(), 0.032); 
    fluid.update(ballMesh.position, clock.getElapsedTime(), delta);

    const origMat = fluid.mesh.material;

    // --- PASS 1: Capture the Background AND Render to Screen ---
    fluid.mesh.visible = false;
    scene.children.forEach(c => c.visible = true);
    
    // Render to the refraction texture
    renderer.setRenderTarget(opaqueTarget);
    renderer.clear();
    renderer.render(scene, camera);

    // ALSO render to the actual screen so we have a background
    renderer.setRenderTarget(null); 
    renderer.clear();
    renderer.render(scene, camera);

    // --- PASS 2: Render Fluid Depth ---
    scene.children.forEach(c => c.visible = false);
    fluid.mesh.visible = true;
    fluid.mesh.material = fluid.depthMaterial;
    renderer.setRenderTarget(depthTarget);
    renderer.clear();
    renderer.render(scene, camera);

    // --- PASS 3: Render Fluid Thickness (Beer-Lambert) ---
    fluid.mesh.material = fluid.thicknessMaterial;
    renderer.setRenderTarget(thicknessTarget);
    renderer.clear();
    renderer.render(scene, camera);

    // --- PASS 4: Bilateral Blur Horizontally ---
    surfaceMesh.material = blurMatX;
    blurMatX.uniforms.tDepth.value = depthTarget.texture;
    renderer.setRenderTarget(blurTargetX);
    renderer.render(postScene, postCamera);
    blurMatX.uniforms.uBlurRadius.value = 12.0;

    // --- PASS 5: Bilateral Blur Vertically ---
    surfaceMesh.material = blurMatY;
    blurMatY.uniforms.tDepth.value = blurTargetX.texture;
    renderer.setRenderTarget(blurTargetY);
    renderer.render(postScene, postCamera);
    blurMatY.uniforms.uBlurRadius.value = 12.0;

    // --- PASS 6: Composite Final Surface ---
    // Restore the main surface material and feed it all the maps
    surfaceMesh.material = surfaceMesh.userData.surfaceMat || new THREE.ShaderMaterial(surfaceShader);
    surfaceMesh.userData.surfaceMat = surfaceMesh.material;
    surfaceMesh.material.transparent = true;
    
    surfaceMesh.material.uniforms.tEnvMap.value = scene.background;
    surfaceMesh.material.uniforms.tDepth.value = blurTargetY.texture;
    surfaceMesh.material.uniforms.tOpaque.value = opaqueTarget.texture;
    surfaceMesh.material.uniforms.tThickness.value = thicknessTarget.texture;
    surfaceMesh.material.uniforms.uCameraPosition = { value: camera.position };

    renderer.setRenderTarget(null);
    renderer.autoClear = false; // Don't wipe the background we just photographed!
    renderer.render(postScene, postCamera);
    renderer.autoClear = true;

    // Reset everything for the next frame
    fluid.mesh.material = origMat;
    scene.children.forEach(c => c.visible = true);
    controls.update();
}

// 8. Responsive Window Handling
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);

    const newWidth = window.innerWidth * pixelRatio;
    const newHeight = window.innerHeight * pixelRatio;

    // Resize all hidden targets
    opaqueTarget.setSize(newWidth, newHeight);
    depthTarget.setSize(newWidth, newHeight);
    thicknessTarget.setSize(newWidth, newHeight);
    blurTargetX.setSize(newWidth, newHeight);
    blurTargetY.setSize(newWidth, newHeight);

    // Update shader resolutions
    if (surfaceMesh.userData.surfaceMat) {
        surfaceMesh.userData.surfaceMat.uniforms.uResolution.value.set(newWidth, newHeight);
    }
    blurMatX.uniforms.uResolution.value.set(newWidth, newHeight);
    blurMatY.uniforms.uResolution.value.set(newWidth, newHeight);
});

animate();