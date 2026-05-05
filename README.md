# Water Simulation Suite

A real-time 3D water simulation built for **CS 335** (Computer Graphics).

The demo pairs **GPU SPH** (smoothed particle hydrodynamics via Three.js `GPUComputationRenderer`) with a **multi-pass screen-space fluid renderer** (depth/thickness splats, bilateral blur, normal reconstruction, Fresnel + absorption composite, screen-space foam). Everything runs inside a deliberate **retro Windows Vista / Frutiger Aero** “desktop OS” shell—glossy window chrome, taskbar, and stylised presentation. The look is **art-directed and era-inspired**, not aimed at photorealistic water: we use physically motivated shading where it helps, but tune colour, foam, and reflections for readability and cohesion.

## Team members

- Lauren Camper
- Emily Tutt
- Rudwika Manne
- Danielle M. McIntyre
- Daniel Kee Tam

## How to run

**A local HTTP server is required.** The project uses ES modules and loads assets (sounds, images) which browsers block over `file://` URLs.

```bash
cd water-simulation
# Python 3
python3 -m http.server 8765
# Windows (if python3 is not on PATH): py -m http.server 8765
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
| W A S D | Move the interaction ball (when debug mode is on, ball is also visible for stirring the fluid) |
| Q / E | Move the ball down / up |
| Speaker button (taskbar) | Toggle background music mute |
| Minimize button (`_`) | Hide window + mute |
| Close button (`X`) | Close window + pause simulation |
| **Debug** button (title bar) | Toggle **debug mode** (see below) |

## Debug mode and tuning panels

**Debug mode** is toggled with the **Debug** control in the simulated window title bar. It is persisted in `localStorage` under `debugMode`.

When debug mode is **on**:

- The **settings sidebar** appears with four **lil-gui** panels: Environment, Terrain, Fluid rendering, and Particles.
- The **interaction ball** is visible; a small overlay shows **Ball XYZ** coordinates.
- The **fluid tank** wireframe stays visible for aligning the simulation volume.

When debug mode is **off**, the sidebar is hidden, the ball is hidden, and the ball’s collision radius in the solver is set to **0** so it does not affect the fluid (your last radius is restored when you turn debug back on).

### Fluid rendering panel

- **Screen-space fluid** on/off, **Show particles (debug)** (draw raw SPH spheres instead of the SSFR surface).
- **Water tint** (colour picker), blob radius, blur controls, normals, absorption, IOR, refraction, specular, thickness, env reflection, tint/scatter/exposure, floor caustics, foam, adaptive splats, **fluid resolution** (internal RT scale).
- **Debug view** (composite shader): **Final**, **Depth**, **Thickness**, **Normals**, **Foam**—useful for understanding each SSFR stage.

### Environment & terrain

- Baseplate **wireframe** overlay.
- **Terrain**: baseplate size, subdivisions, height offset, ripple amplitude/frequency, X/Z tilt (downstream slope). Terrain uses a **grass texture** and procedural **hills**; height must stay consistent with the SPH `terrainHeight` logic in `particles.js`.

### Particles panel

- **Fluid container**: width, length, ceiling headroom, lift above terrain; **Periodic wrap (Z)** and **Flow along +Z** for looping river behaviour.
- **SPH physics**: smoothing radius (rebuilds spatial hash), target density, pressure / near-pressure, viscosity, gravity, wall damping, agitation, cohesion.
- **Interaction ball**: position sliders, ball radius/scale (affects mesh and `u_ballRadius` in the solver).
- **Simulation presets**: reset blob, breaking-wave preset; **Particle count** (32² / 64² / 128² texels) — changing this **reloads the page** after confirmation and saves choice in `localStorage`.
- **White particles (foam / spray / bubbles)**: enable, spawn rate, opacity, lifetimes, neighbour thresholds, bubble buoyancy (CPU billboard layer on top of SPH).

## Adaptive performance

The animation loop runs **`checkAdaptiveFPS`**: over a rolling ~3 s window it estimates average FPS and automatically **lowers or raises** the fluid renderer’s internal resolution scale (`fluidScale`) so weaker laptops stay interactive. You can still override **Fluid resolution** manually in the Fluid rendering panel.

## Features (summary)

| Area | What it does |
|------|----------------|
| **GPU SPH** | Predicted positions → density → pressure → viscosity → integration; CPU spatial hash; adaptive substeps. |
| **SSFR** | Depth + thickness splats, bilateral blur, normals, refraction/absorption/Fresnel, env reflection, foam pass, debug views. |
| **Whitewater** | Optional CPU foam/spray/bubble particles. |
| **Terrain** | Textured procedural riverbed + rocks; tank OBB synced in `environment.js`. |
| **UI** | Vista-style window, taskbar clock, draggable title bar, login flow, BGM. |

## Dependencies (pinned via import map in `index.html`)

| Library | Version |
|---------|---------|
| [three.js](https://threejs.org/) | `0.160.0` |
| [lil-gui](https://lil-gui.georgealways.com/) | `0.19.1` |

No `npm install` needed — everything loads from CDN (`unpkg.com`).

## Project structure

```
water-simulation/
├── index.html              # Entry point, Vista-style shell, import map
├── src/
│   ├── main.js             # Scene, animation loop, adaptive FPS, debug mode, ball input
│   ├── environment.js      # Grass terrain, hills, fluid tank sync
│   ├── particles.js        # GPU SPH + optional CPU whitewater particles
│   ├── guicontrols.js      # lil-gui panels, login flow, window chrome
│   └── render/
│       ├── fluidPasses.js  # Multi-pass screen-space fluid renderer
│       └── shaders/        # GLSL: depth, thickness, blur, foam, composite
├── textures/               # e.g. grass texture for terrain
├── backgrounds/            # Desktop and login background images
├── icons/                  # UI icons (taskbar, desktop, login)
└── sounds/
    ├── background music/   # e.g. BGM loop
    └── sound effects/      # e.g. login / UI cues
```
