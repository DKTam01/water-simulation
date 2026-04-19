# Water Simulation Suite

A real-time 3D water simulation built for **CS 335** (Computer Graphics).  
The demo uses GPU-based SPH particle hydrodynamics and a multi-pass screen-space fluid renderer, wrapped in a Windows Vista–style desktop UI. The scene is a large high-resolution four-quadrant baseplate (vertex-colored regions) with lighting and shadows on the plate, obstacles, and water.

## Team members

- Lauren Camper
- Emily Tutt
- Rudwika Manne
- Danielle M. McIntyre
- Daniel Kee Tam

## How to run

**A local HTTP server is required.** The project uses ES modules and loads assets (sounds, images) which browsers block over `file://` URLs.

```bash
# Python 3 (recommended)
cd water-simulation
python3 -m http.server 8765
# Then open http://localhost:8765/
```

Any static file server works (`npx serve`, VS Code Live Server, etc.).

## Controls

| Input | Action |
|-------|--------|
| Left-drag | Orbit camera |
| Right-drag / two-finger drag | Pan |
| Scroll wheel | Zoom |
| Enter (on login screen) | Begin session |
| Speaker button (taskbar) | Toggle audio |
| Minimize button (`_`) | Hide window + mute |
| Close button (`X`) | Close window + pause |

## Dependencies (pinned via import map in `index.html`)

| Library | Version |
|---------|---------|
| [three.js](https://threejs.org/) | `0.160.0` |
| [lil-gui](https://lil-gui.georgealways.com/) | `0.19.1` |

No `npm install` needed — everything loads from CDN (`unpkg.com`).

## Project structure

```
water-simulation/
├── index.html              # Entry point, Vista OS shell, import map
├── src/
│   ├── main.js             # Scene setup, animation loop, adaptive quality
│   ├── environment.js      # Four-quadrant baseplate, tank alignment
│   ├── particles.js        # GPU SPH simulation (GPUComputationRenderer)
│   ├── guicontrols.js      # lil-gui panels, login flow, window chrome
│   └── render/
│       ├── fluidPasses.js  # Multi-pass screen-space fluid renderer
│       └── shaders/        # GLSL shaders (depth, blur, thickness, foam, composite)
├── backgrounds/            # Desktop and login background images
├── icons/                  # UI icons (taskbar, desktop, login)
└── sounds/                 # Background music and sound effects
```
