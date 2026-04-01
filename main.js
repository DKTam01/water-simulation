import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import GUI from 'lil-gui'; // ** Using lil-gui for the UI controls

// 1. Scene Setup
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87CEEB); 

// 2. Camera Setup
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 10, 20); // ** Camera positioned to look down at the riverbed

// 3. Renderer Setup
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);

// 4. Lighting Setup
const ambientLight = new THREE.AmbientLight(0x404040, 2); // Global ambient light
scene.add(ambientLight); 

const dirLight = new THREE.DirectionalLight(0xffffff, 1.5); // ** Simulate sunlight to add depth and shadows
dirLight.position.set(10, 20, 10);
scene.add(dirLight);

// ** gui setup 
const gui = new GUI({ title: 'Scene Controls' });

// ** intial gui settings
const uiSettings = {
    showWireframe: false,
    timeOfDay: 'Day',
    planeWidth: 60,
    planeLength: 60,
    riverDepth: 3,
    riverWidth: 20,
    cliffHeight: 3.5,
    flowSlope: 0.05,

    waterColor: '#0088ff',
    waterOpacity: 0.7,
    waterIOR: 1.33
};

// initialize the terrain material with green
const terrainMaterial = new THREE.MeshStandardMaterial({ 
    color: 0x3E8E41, 
    wireframe: false,   
    roughness: 0.95
});

let ground; // declare ground to keep updating based on user input

function generateTerrain() {

    //if ground already exists, remove it before creating a new one to avoid memory leaks
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

        //riverbed height calculation using a Gaussian function to create a smooth riverbed shape, with the depth controlled by uiSettings.riverDepth and width by uiSettings.riverWidth
        let height = -uiSettings.riverDepth * Math.exp(-(x * x) / uiSettings.riverWidth); 

        const dropOffCurve = (1 - Math.tanh(z * 0.8)) * uiSettings.cliffHeight; 
        height += dropOffCurve;

        height -= z * uiSettings.flowSlope;

        positionAttribute.setY(i, height);          
    }
    geometry.computeVertexNormals();                        

    ground = new THREE.Mesh(geometry, terrainMaterial);
    scene.add(ground);
}
generateTerrain();


// temporary water generation
const waterGeometry = new THREE.PlaneGeometry(uiSettings.planeWidth, uiSettings.planeLength);
waterGeometry.rotateX(-Math.PI / 2);

const waterMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x0088ff,
    transparent: true,
    opacity: 0.7,
    roughness: 0.1,       
    transmission: 0.9,    
    ior: 1.33             
});

const water = new THREE.Mesh(waterGeometry, waterMaterial);
water.position.y = -0.5; 
water.rotation.x -= uiSettings.flowSlope; 

scene.add(water);


// wireframe toggle
const environmentFolder = gui.addFolder('Environment');
environmentFolder.add(uiSettings, 'showWireframe').name('Terrain Wireframe').onChange((value) => {
    terrainMaterial.wireframe = value;
});

//terain control
const terrainFolder = gui.addFolder('Terrain Shape');
terrainFolder.add(uiSettings, 'planeWidth', 20, 100).name('Map Width').onChange(generateTerrain);
terrainFolder.add(uiSettings, 'planeLength', 20, 100).name('Map Length').onChange(generateTerrain);
terrainFolder.add(uiSettings, 'riverDepth', 0, 10).name('River Depth').onChange(generateTerrain);
terrainFolder.add(uiSettings, 'riverWidth', 1, 50).name('River Width').onChange(generateTerrain);
terrainFolder.add(uiSettings, 'cliffHeight', 0, 10).name('Waterfall Height').onChange(generateTerrain);
terrainFolder.add(uiSettings, 'flowSlope', 0, 0.5).name('Global Tilt').onChange(generateTerrain);

//water control
const waterFolder = gui.addFolder('Water Appearance');
waterFolder.addColor(uiSettings, 'waterColor').name('Water Color').onChange((color) => {
    waterMaterial.color.set(color);
});
waterFolder.add(uiSettings, 'waterOpacity', 0, 1).name('Opacity').onChange((opacity) => {
    waterMaterial.opacity = opacity;
});

waterFolder.add(uiSettings, 'waterIOR', 1.0, 2.0).name('Index of Refraction').onChange((ior) => {
    waterMaterial.ior = ior;
});

// time of day dropdown
environmentFolder.add(uiSettings, 'timeOfDay', ['Morning', 'Day', 'Evening', 'Night']).name('Time Settings').onChange((time) => {
    console.log(`Scene changed to: ${time} - Lighting logic goes here.`);
});


// 8. Animation Loop
function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}
animate();

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});