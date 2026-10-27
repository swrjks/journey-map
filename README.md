# TerraVue: Single Satellite Image to 3D Terrain

**Smart India Hackathon 2026 · ISRO "DepthWizard" problem statement · Team SynapSixx**

TerraVue takes one optical satellite image, runs it through an 8-stage pipeline that estimates a
digital surface model (DSM), and renders the result as an interactive 3D terrain. On that terrain
you can probe heights, measure distances, draw elevation profiles, check accuracy against a
reference DEM, and run flood, rainfall, wildfire and landslide simulations.

## Demo video

[![TerraVue demo video](https://img.youtube.com/vi/EiVrUoSKwKY/maxresdefault.jpg)](https://www.youtube.com/watch?v=EiVrUoSKwKY)

▶ **Watch on YouTube:** https://www.youtube.com/watch?v=EiVrUoSKwKY

The video shows the prototype on two scenes: a Himalayan valley and a forest river basin.

![TerraVue 3D viewer](docs/preview.jpg)

> **Note:** This repository is a **frontend-only MVP prototype**. The ML model, validation metrics
> and hazard inputs are simulated in the browser so the full user flow can be shown end to end.
> See [What's real vs simulated](#whats-real-vs-simulated).

## Features

- **Ingest:** drag and drop a satellite image (PNG/JPG), optionally with a reference DEM, or pick a
  built-in sample scene.
- **8-stage processing pipeline** with live KPIs, a stage stepper, stage output thumbnails,
  scene metadata and a console log:
  1. Ingest & metadata
  2. Radiometric correction
  3. Cloud & shadow mask
  4. Feature extraction
  5. Land-cover segmentation
  6. Height estimation (DSM)
  7. Uncertainty estimation
  8. 3D mesh generation
- **3D viewer (Three.js):** orbit, top and fly-through camera modes; layers for DSM shading,
  satellite drape, slope, uncertainty and contours.
- **Analysis tools:** height probe (`H`), distance (`D`), point-to-point elevation profile linked
  to a marker on the terrain.
- **Validation:** RMSE, MAE, LE90 and correlation against a reference, with a scatter plot.
- **Hazard simulation:**
  - **Flood:** raise the water level and see inundated area, max depth and structures affected.
  - **Localized rainfall:** a storm cell with D8 flow routing on the DSM, so runoff follows the terrain.
  - **Wildfire:** cell-by-cell spread driven by fuel (land cover), wind and slope.
  - **Landslide:** susceptibility map (slope × wetness × concavity), then the slope fails,
    the terrain deforms and debris runs out.
- **Export:** save a PNG of the current view.

## Tech stack

- [Vite](https://vitejs.dev/) with vanilla JavaScript (ES modules)
- [Three.js](https://threejs.org/) for the 3D terrain, water, particles and camera
- [Lucide](https://lucide.dev/) icons
- Canvas 2D for the pipeline image operations and charts

## Getting started

Requires Node.js 18 or newer.

```bash
git clone https://github.com/swrjks/terravue.git
cd terravue
npm install
npm run dev        # http://localhost:5173
```

- Open `http://localhost:5173/?demo` to skip the upload and load the sample scene directly.
- `npm run build` writes a static build to `dist/` that can be hosted anywhere
  (GitHub Pages, Netlify, Vercel). Use `npm run preview` to serve it locally.

## Project structure

```
terravue/
├── index.html          # App shell: ingest, processing and viewer pages
├── src/
│   ├── main.js         # Page flow, UI wiring, sample scenes
│   ├── pipeline.js     # 8-stage processing pipeline and stage outputs
│   ├── terrainData.js  # Terrain generation and image-to-height conversion
│   ├── viewer.js       # Three.js scene, layers, camera modes, tools
│   ├── hazards.js      # Flood, rainfall, wildfire, landslide simulations
│   ├── charts.js       # Elevation profile and validation charts
│   ├── noise.js        # Seeded noise for synthetic terrain
│   ├── icons.js        # Lucide icon setup
│   └── style.css
├── brag-output/        # Launch video (brag.mp4) and the scripts that render it
├── dist/               # Prebuilt static site
├── sih-materials/      # SIH submission: pitch decks, LLD and architecture diagrams,
│                       # solution write-up, problem statement, UI mockups, references
└── docs/preview.jpg
```

## What's real vs simulated

| Feature | Status |
|---|---|
| 3D terrain, lighting, layers, orbit/fly/top views | Real (Three.js) |
| Height probe, distance, elevation profile, flood extent | Real computations on the loaded height grid |
| Rainfall runoff, wildfire spread, landslide deformation | Real simulations on the height grid, with scripted inputs |
| Pipeline thumbnails (stretch, mask, Sobel, segmentation, DSM, σ, mesh) | Real image operations on the input; model names and log lines are scripted |
| Heights from an uploaded PNG/JPG | Pseudo-depth heuristic (brightness plus noise, water pushed low), standing in for the model |
| Heights from an uploaded reference DEM PNG | Used directly (grayscale mapped to 200–1300 m) |
| `.tif` GeoTIFF upload | Browsers can't decode it, so it falls back to the sample scene |
| RMSE / MAE / LE90 / r | Computed on synthetic predicted-vs-reference points |

## Roadmap

A real backend plugs in at `terrainFromImage` / `generateTerrain` in
[src/terrainData.js](src/terrainData.js): replace the heuristic with a monocular height-estimation
model served from an API, add GeoTIFF decoding, and validate against CartoDEM / SRTM reference tiles.

## Team

**SynapSixx**, Smart India Hackathon 2026.
