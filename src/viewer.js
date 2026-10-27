import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { EXTENT, sampleGrid } from './terrainData.js';

const S = 100;              // world units per side
const K = S / EXTENT;       // world units per metre (horizontal)
let VE = 1.6;               // vertical exaggeration (per scene)
let BASE_E = 150;           // elevation of the box floor (per scene)
export const eToY = (e) => (e - BASE_E) * K * VE;
export const uvToXZ = (u, v) => [u * S - S / 2, S / 2 - v * S];
const xzToUV = (x, z) => [(x + S / 2) / S, (S / 2 - z) / S];

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

const terrainVert = /* glsl */ `
  attribute float aElev;
  attribute float aUnc;
  attribute float aDisp;   // landslide displacement (m)
  attribute float aDispT;  // arrival time of the displacement (0..1)
  uniform float uSlide;
  uniform float uYScale;
  varying vec3 vN;
  varying vec2 vUv;
  varying float vElev;
  varying float vUnc;
  varying vec3 vWorld;
  void main() {
    float k = smoothstep(aDispT, aDispT + 0.18, uSlide);
    vec3 p = position;
    p.y += aDisp * k * uYScale;
    vUv = uv; vElev = aElev + aDisp * k; vUnc = aUnc; vN = normal;
    vec4 w = modelMatrix * vec4(p, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const terrainFrag = /* glsl */ `
  uniform sampler2D uSat;
  uniform float uUseSat, uSlope, uUnc, uContours, uGrid;
  uniform float uMinE, uMaxE, uLake, uWaterE, uContourStep;
  uniform vec3 uLight;
  uniform vec3 uHover;
  uniform float uHoverOn;
  uniform sampler2D uHaz;
  uniform float uHazMode, uHazRadius, uHazRing, uHazOverlay, uTime;
  uniform vec2 uHazCenter;
  uniform vec3 uHazRingColor;
  varying vec3 vN;
  varying vec2 vUv;
  varying float vElev;
  varying float vUnc;
  varying vec3 vWorld;

  float gridLine(float v, float w) {
    float f = abs(fract(v - 0.5) - 0.5) / max(fwidth(v), 1e-4);
    return 1.0 - clamp(f / w, 0.0, 1.0);
  }
  vec3 slopeRamp(float t) {
    vec3 a = vec3(0.10, 0.55, 0.35), b = vec3(0.95, 0.85, 0.25), c = vec3(0.90, 0.22, 0.18);
    return t < 0.5 ? mix(a, b, t * 2.0) : mix(b, c, t * 2.0 - 1.0);
  }
  vec3 uncRamp(float t) {
    vec3 a = vec3(0.13, 0.10, 0.45), b = vec3(0.80, 0.25, 0.55), c = vec3(0.98, 0.85, 0.30);
    return t < 0.5 ? mix(a, b, t * 2.0) : mix(b, c, t * 2.0 - 1.0);
  }

  void main() {
    vec3 n = normalize(vN);
    float diff = max(dot(n, normalize(uLight)), 0.0);
    float slope = acos(clamp(n.y, 0.0, 1.0));
    float e = clamp((vElev - uMinE) / (uMaxE - uMinE), 0.0, 1.0);

    // "Engraved" DSM look
    vec3 base = mix(vec3(0.05, 0.065, 0.085), vec3(0.64, 0.68, 0.73), pow(diff, 1.5));
    base *= 0.78 + 0.35 * e;
    float hatch = gridLine(vElev / 16.0, 0.8) * smoothstep(0.3, 0.9, sin(slope));
    float grid = max(gridLine(vWorld.x / 0.78, 0.8), gridLine(vWorld.z / 0.78, 0.8));
    vec3 dsm = base + vec3(0.62, 0.70, 0.80) * hatch * 0.16 * (0.35 + diff) + vec3(0.45, 0.56, 0.68) * grid * 0.10 * uGrid;

    vec3 sat = texture2D(uSat, vUv).rgb;
    vec3 satLit = sat * (0.38 + 0.95 * diff);
    vec3 col = mix(dsm, satLit, uUseSat);

    float sd = clamp(degrees(slope) / 60.0, 0.0, 1.0);
    col = mix(col, slopeRamp(sd) * (0.45 + 0.7 * diff), uSlope * 0.78);
    col = mix(col, uncRamp(vUnc) * (0.45 + 0.7 * diff), uUnc * 0.78);

    // Water: permanent (lake / river) and flood extent
    if (vElev < uWaterE) {
      float depth = uWaterE - vElev;
      vec3 lakeC = mix(vec3(0.22, 0.40, 0.50), vec3(0.08, 0.22, 0.32), clamp((uLake - vElev) / 20.0, 0.0, 1.0));
      vec3 floodC = mix(vec3(0.32, 0.66, 1.0), vec3(0.06, 0.26, 0.72), clamp(depth / 12.0, 0.0, 1.0));
      vec3 w = vElev < uLake ? lakeC : floodC;
      col = mix(col, w * (0.8 + 0.3 * diff), clamp(0.62 + depth / 12.0, 0.0, 0.92));
    }
    float shore = 1.0 - smoothstep(0.0, fwidth(vElev) * 1.4, abs(vElev - uWaterE));
    col = mix(col, vec3(0.75, 0.9, 1.0), shore * 0.7 * step(uLake + 0.05, uWaterE));

    // Hazard overlays (rain runoff, wildfire, landslide)
    if (uHazMode > 0.5) {
      vec4 hz = texture2D(uHaz, vUv);
      if (uHazMode < 1.5) {
        col *= 1.0 - 0.3 * hz.g;                                             // wet ground under the storm
        col = mix(col, vec3(0.32, 0.66, 1.0) * (0.75 + 0.45 * diff), hz.r * 0.92); // runoff streams
      } else if (uHazMode < 2.5) {
        col = mix(col, vec3(0.055, 0.05, 0.045) * (0.6 + 0.6 * diff), hz.g * 0.9);  // burn scar
        float fl = 0.6 + 0.4 * sin(uTime * 13.0 + vWorld.x * 3.1) * sin(uTime * 9.0 - vWorld.z * 2.7);
        vec3 fire = mix(vec3(1.0, 0.22, 0.02), vec3(1.0, 0.82, 0.28), fl);
        col = mix(col, fire * 1.5, hz.r * 0.95);
        col += vec3(1.0, 0.32, 0.04) * hz.b * 0.45 * (1.0 - hz.g * 0.5);     // glow around the front
      } else {
        float s = hz.r;
        vec3 sus = s < 0.5 ? mix(vec3(0.16, 0.62, 0.36), vec3(0.98, 0.82, 0.22), s * 2.0)
                           : mix(vec3(0.98, 0.82, 0.22), vec3(0.93, 0.22, 0.16), s * 2.0 - 1.0);
        col = mix(col, sus * (0.5 + 0.6 * diff), smoothstep(0.08, 0.35, s) * 0.62 * uHazOverlay);
        float grain = 0.85 + 0.3 * fract(sin(dot(floor(vUv * 900.0), vec2(12.9898, 78.233))) * 43758.5453);
        col = mix(col, vec3(0.72, 0.58, 0.40) * grain * (0.5 + 0.65 * diff), smoothstep(0.05, 0.4, hz.g) * 0.95);  // fresh debris
        col = mix(col, vec3(0.58, 0.33, 0.20) * grain * (0.45 + 0.65 * diff), smoothstep(0.05, 0.4, hz.b) * 0.95); // exposed scar
        float edge = max(hz.g, hz.b);
        float outline = smoothstep(0.08, 0.2, edge) * (1.0 - smoothstep(0.2, 0.42, edge));
        col = mix(col, vec3(1.0, 0.82, 0.45), outline * 0.85);
      }
      float dd = length(vUv - uHazCenter);
      float ring = 1.0 - smoothstep(0.0, fwidth(dd) * 1.6, abs(dd - uHazRadius));
      float pin = 1.0 - smoothstep(0.0, fwidth(dd) * 1.6, dd - 0.0035);
      col = mix(col, uHazRingColor, max(ring, pin) * uHazRing);
    }

    float c1 = gridLine(vElev / uContourStep, 0.9);
    float c5 = gridLine(vElev / (uContourStep * 5.0), 1.3);
    col = mix(col, vec3(1.0, 0.86, 0.52), uContours * max(c1 * 0.42, c5 * 0.9));

    float dh = length(vWorld.xz - uHover.xz);
    float ring = uHoverOn * (1.0 - smoothstep(0.0, 0.12, abs(dh - 0.9)));
    col = mix(col, vec3(0.35, 0.75, 1.0), ring);

    gl_FragColor = vec4(col, 1.0);
  }
`;

const waterVert = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;
const waterFrag = /* glsl */ `
  uniform float uTime;
  uniform float uFlood;
  varying vec3 vWorld;
  void main() {
    vec3 viewDir = normalize(cameraPosition - vWorld);
    float fres = pow(1.0 - clamp(viewDir.y, 0.0, 1.0), 3.0);
    float ripple = sin(vWorld.x * 2.1 + uTime * 1.3) * sin(vWorld.z * 1.7 - uTime * 1.1);
    vec3 c = mix(vec3(0.18, 0.40, 0.62), vec3(0.30, 0.62, 1.0), uFlood);
    c += ripple * 0.025 + fres * 0.25;
    gl_FragColor = vec4(c, 0.18 + fres * 0.35);
  }
`;

export class Viewer {
  constructor(container, cb = {}) {
    this.container = container;
    this.cb = cb;
    this.data = null;
    this.tool = null;
    this.toolPts = [];
    this.annotations = [];
    this.rise = 0;
    this.floodOffset = 0;
    this.relief = { value: 1 };
    this.frameHooks = [];
    this.resizeHooks = [];
    this.lastFrame = performance.now();
    this.hazTexture = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat);
    this.hazTexture.needsUpdate = true;

    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }));
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.outputColorSpace = THREE.LinearSRGBColorSpace;
    r.setClearColor(0x0b1622, 1);
    container.appendChild(r.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'label-layer';
    container.appendChild(this.labels.domElement);

    this.scene = new THREE.Scene();
    const sky = document.createElement('canvas');
    sky.width = 2; sky.height = 256;
    const sctx = sky.getContext('2d');
    const grad = sctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, '#0c0d0f');
    grad.addColorStop(0.55, '#141519');
    grad.addColorStop(1, '#22252b');
    sctx.fillStyle = grad;
    sctx.fillRect(0, 0, 2, 256);
    this.scene.background = new THREE.CanvasTexture(sky);
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.5, 2000);
    this.camera.position.set(-122, 122, 122);

    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.48;
    this.controls.minDistance = 25;
    this.controls.maxDistance = 360;
    this.controls.target.set(0, 12, 0);
    this.controls.autoRotateSpeed = 0.6;

    this.world = new THREE.Group();   // scales in Y for the "rise" animation
    this.scene.add(this.world);
    this.axes = new THREE.Group();
    this.scene.add(this.axes);
    this.overlay = new THREE.Group(); // annotations
    this.scene.add(this.overlay);

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.lineMats = [];

    this.cursor = new THREE.Mesh(
      new THREE.SphereGeometry(0.75, 20, 14),
      new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false })
    );
    this.cursor.renderOrder = 10;
    this.cursor.visible = false;
    this.scene.add(this.cursor);

    this.bindEvents();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(container);
    this.clock = new THREE.Clock();
    r.setAnimationLoop(() => this.frame());
  }

  /* ------------------------------ scene build ------------------------------ */
  load(data) {
    this.clearAnnotations();
    this.world.clear();
    this.axes.clear();
    this.data = data;
    VE = data.ve ?? 1.6;
    BASE_E = data.baseE ?? 150;
    const { R, N, heights, unc } = data;

    const pos = new Float32Array(R * R * 3);
    const uv = new Float32Array(R * R * 2);
    const elev = new Float32Array(R * R);
    const aUnc = new Float32Array(R * R);
    for (let j = 0; j < R; j++) {
      for (let i = 0; i < R; i++) {
        const k = j * R + i;
        const [x, z] = uvToXZ(i / N, j / N);
        pos.set([x, eToY(heights[k]), z], k * 3);
        uv.set([i / N, j / N], k * 2);
        elev[k] = heights[k];
        aUnc[k] = unc[k];
      }
    }
    const idx = new Uint32Array(N * N * 6);
    let p = 0;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const a = j * R + i, b = a + 1, c = a + R, d = c + 1;
        idx.set([a, b, c, b, d, c], p);
        p += 6;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('aElev', new THREE.BufferAttribute(elev, 1));
    geo.setAttribute('aUnc', new THREE.BufferAttribute(aUnc, 1));
    geo.setAttribute('aDisp', new THREE.BufferAttribute(new Float32Array(R * R), 1));
    geo.setAttribute('aDispT', new THREE.BufferAttribute(new Float32Array(R * R), 1));
    this.hasDisplacement = false;
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    const tex = new THREE.CanvasTexture(data.satCanvas);
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    tex.colorSpace = THREE.NoColorSpace;

    this.uniforms = {
      uSat: { value: tex },
      uUseSat: { value: this.uniforms?.uUseSat.value ?? 0 },
      uSlope: { value: this.uniforms?.uSlope.value ?? 0 },
      uUnc: { value: this.uniforms?.uUnc.value ?? 0 },
      uContours: { value: this.uniforms?.uContours.value ?? 0 },
      uGrid: { value: 1 },
      uMinE: { value: data.minE },
      uMaxE: { value: data.maxE },
      uLake: { value: data.lakeLevel },
      uWaterE: { value: data.lakeLevel + this.floodOffset },
      uContourStep: { value: 20 },
      uLight: { value: new THREE.Vector3(-0.55, 0.62, -0.35).normalize() },
      uHover: { value: new THREE.Vector3() },
      uHoverOn: { value: 0 },
      uHaz: { value: this.hazTexture },
      uHazMode: { value: 0 },
      uHazCenter: { value: new THREE.Vector2(0.5, 0.5) },
      uHazRadius: { value: 0.1 },
      uHazRing: { value: 0 },
      uHazRingColor: { value: new THREE.Vector3(1, 1, 1) },
      uHazOverlay: { value: 1 },
      uTime: { value: 0 },
      uSlide: { value: 0 },
      uYScale: { value: K * VE },
    };
    this.terrain = new THREE.Mesh(
      geo,
      new THREE.ShaderMaterial({ vertexShader: terrainVert, fragmentShader: terrainFrag, uniforms: this.uniforms })
    );
    this.world.add(this.terrain);
    this.world.add(this.buildSkirt(data));

    this.waterUniforms = { uTime: { value: 0 }, uFlood: { value: 0 } };
    this.water = new THREE.Mesh(
      new THREE.PlaneGeometry(S, S).rotateX(-Math.PI / 2),
      new THREE.ShaderMaterial({
        vertexShader: waterVert, fragmentShader: waterFrag, uniforms: this.waterUniforms,
        transparent: true, depthWrite: false,
      })
    );
    this.world.add(this.water);
    this.setFlood(this.floodOffset);

    this.buildAxes(data);

    // Rise animation
    this.rise = 0;
    this.riseStart = performance.now();
    this.world.scale.y = 0.001;
    this.axes.traverse((o) => { if (o.material) o.material.opacity = 0; });
    this.labelsVisible(false);
    this.flyTo(new THREE.Vector3(-122, 122, 122), new THREE.Vector3(0, 6, 0), 2600);
  }

  /* ------------------------------ terrain edits (landslide) ------------------------------ */
  setDisplacement(disp, arrive) {
    const g = this.terrain.geometry;
    g.attributes.aDisp.array.set(disp);
    g.attributes.aDispT.array.set(arrive);
    g.attributes.aDisp.needsUpdate = true;
    g.attributes.aDispT.needsUpdate = true;
    this.uniforms.uSlide.value = 0;
    this.uniforms.uHazOverlay.value = 1;
    this.hasDisplacement = true;
  }

  bakeDisplacement() {
    const disp = this.terrain.geometry.attributes.aDisp.array;
    const h = Float32Array.from(this.data.heights);
    for (let k = 0; k < h.length; k++) h[k] += disp[k];
    this.setHeights(h);
  }

  // Rewrites the terrain surface (positions, elevations, normals) and clears any displacement.
  setHeights(heights) {
    const g = this.terrain.geometry;
    this.data.heights.set(heights);
    const pos = g.attributes.position.array, elev = g.attributes.aElev.array;
    for (let k = 0; k < heights.length; k++) {
      pos[k * 3 + 1] = eToY(heights[k]);
      elev[k] = heights[k];
    }
    g.attributes.aDisp.array.fill(0);
    g.attributes.aDispT.array.fill(0);
    for (const a of ['position', 'aElev', 'aDisp', 'aDispT']) g.attributes[a].needsUpdate = true;
    g.computeVertexNormals();
    g.computeBoundingSphere();
    this.uniforms.uSlide.value = 0;
    this.hasDisplacement = false;
  }

  buildSkirt(data) {
    const { R, heights } = data;
    const verts = [];
    const edge = (getK, getUV) => {
      for (let t = 0; t < R - 1; t++) {
        const [u0, v0] = getUV(t), [u1, v1] = getUV(t + 1);
        const [x0, z0] = uvToXZ(u0, v0), [x1, z1] = uvToXZ(u1, v1);
        const y0 = eToY(heights[getK(t)]), y1 = eToY(heights[getK(t + 1)]);
        verts.push(x0, y0, z0, x1, y1, z1, x0, 0, z0, x1, y1, z1, x1, 0, z1, x0, 0, z0);
      }
    };
    const N = R - 1;
    edge((t) => t, (t) => [t / N, 0]);
    edge((t) => N * R + t, (t) => [t / N, 1]);
    edge((t) => t * R, (t) => [0, t / N]);
    edge((t) => t * R + N, (t) => [1, t / N]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x1a1c20, side: THREE.DoubleSide }));
  }

  buildAxes(data) {
    const mat = () => new THREE.LineBasicMaterial({ color: 0xaab0b8, transparent: true, opacity: 0.35 });
    const eStep = data.maxE - BASE_E > 800 ? 200 : 100;
    const topY = eToY(Math.ceil(data.maxE / eStep) * eStep);
    const h = S / 2;
    const seg = (pts) => {
      const g = new THREE.BufferGeometry().setFromPoints(pts.map((q) => new THREE.Vector3(...q)));
      return new THREE.LineSegments(g, mat());
    };
    const lines = [
      [-h, 0, h], [h, 0, h], [h, 0, h], [h, 0, -h], [h, 0, -h], [-h, 0, -h], [-h, 0, -h], [-h, 0, h],
      [-h, 0, -h], [-h, topY, -h],
    ];
    this.axes.add(seg(lines));

    // Floor grid outside the model for context
    const grid = [];
    for (let m = 400; m < EXTENT; m += 400) {
      const x = m * K - h;
      grid.push([x, 0, h], [x, 0, h + 2.2], [-h, 0, h - m * K], [-h - 2.2, 0, h - m * K]);
    }
    const eTicks = [];
    for (let e = Math.floor(BASE_E / eStep) * eStep + eStep; e <= data.maxE + eStep / 2; e += eStep) {
      const y = eToY(e);
      eTicks.push(e);
      grid.push([-h, y, -h], [-h - 2.2, y, -h]);
    }
    this.axes.add(seg(grid));

    this.axisLabels = [];
    const label = (text, x, y, z, cls = 'axis-tick') => {
      const el = document.createElement('div');
      el.className = cls;
      el.textContent = text;
      const o = new CSS2DObject(el);
      o.position.set(x, y, z);
      this.axes.add(o);
      this.axisLabels.push(o);
    };
    for (let m = 400; m < EXTENT; m += 400) {
      label(String(m), m * K - h, -1.5, h + 5.5);          // Easting along the south edge
      label(String(m), -h - 5.5, -1.5, h - m * K);          // Northing along the west edge
    }
    for (const e of eTicks) label(String(e), -h - 6, eToY(e), -h);
    label('Easting (m)', 8, -6, h + 13, 'axis-title');
    label('Northing (m)', -h - 14, -6, 8, 'axis-title');
    label('Elevation (m)', -h - 6, topY + 6, -h, 'axis-title');
  }

  labelsVisible(on) {
    this.axisLabels?.forEach((o) => (o.element.style.opacity = on ? 1 : 0));
  }

  /* ------------------------------ layers ------------------------------ */
  setLayer(name, on) {
    if (!this.uniforms) return;
    const map = { satellite: 'uUseSat', slope: 'uSlope', uncertainty: 'uUnc', contours: 'uContours' };
    if (name === 'dsm') {
      this.animateUniform(this.relief, on ? 1 : 0.04, 900);
      return;
    }
    const key = map[name];
    if (!key) return;
    this.animateUniform(this.uniforms[key], on ? 1 : 0, 450);
  }

  animateUniform(u, to, dur) {
    const from = u.value, t0 = performance.now();
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / dur);
      u.value = from + (to - from) * easeInOut(t);
      if (t < 1) requestAnimationFrame(step);
    };
    step();
  }

  setFlood(offset) {
    this.floodOffset = offset;
    if (!this.data) return;
    const level = this.data.lakeLevel + offset;
    this.uniforms.uWaterE.value = level;
    this.water.position.y = eToY(level) + 0.02;
    this.waterUniforms.uFlood.value = Math.min(1, offset / 3);
  }

  floodStats(offset) {
    const d = this.data;
    const level = d.lakeLevel + offset;
    const cellArea = (EXTENT / d.N) ** 2;
    let flooded = 0, maxDepth = 0, buildings = 0;
    for (let k = 0; k < d.heights.length; k++) {
      const e = d.heights[k];
      if (e < level && e >= d.lakeLevel) flooded++;
      // A structure is affected once water reaches its footing, not its roof.
      if (d.town[k] && d.ground && d.ground[k] < level) buildings++;
      if (e < level) maxDepth = Math.max(maxDepth, level - Math.max(e, d.lakeLevel - 0.0001));
    }
    return {
      areaKm2: (flooded * cellArea) / 1e6,
      maxDepth: offset > 0 ? Math.min(maxDepth, offset + 11) : 0,
      structures: Math.round(buildings / 2), // ~2 grid cells per building
    };
  }

  /* ------------------------------ camera ------------------------------ */
  flyTo(pos, target, dur = 1400) {
    this.stopFly();
    this.tween = {
      p0: this.camera.position.clone(), p1: pos.clone(),
      t0: this.controls.target.clone(), t1: target.clone(),
      start: performance.now(), dur,
    };
  }

  view(name) {
    this.controls.autoRotate = false;
    if (name === 'top') this.flyTo(new THREE.Vector3(0, 175, 0.01), new THREE.Vector3(0, 0, 0));
    if (name === 'home') this.flyTo(new THREE.Vector3(-122, 122, 122), new THREE.Vector3(0, 6, 0));
  }

  // Glide the camera to look at (u, v) from the current bearing at `dist` world units.
  focusOn(u, v, dist = 80) {
    this.controls.autoRotate = false;
    const [x, z] = uvToXZ(u, v);
    const target = new THREE.Vector3(x, eToY(sampleGrid(this.data.heights, u, v)), z);
    const dir = this.camera.position.clone().sub(this.controls.target);
    dir.y = 0;
    dir.setLength(dist * 0.72);
    const pos = target.clone().add(dir).add(new THREE.Vector3(0, dist * 0.7, 0));
    this.flyTo(pos, target, 1500);
  }

  zoom(factor) {
    const off = this.camera.position.clone().sub(this.controls.target).multiplyScalar(factor);
    const len = THREE.MathUtils.clamp(off.length(), this.controls.minDistance, this.controls.maxDistance);
    off.setLength(len);
    this.flyTo(this.controls.target.clone().add(off), this.controls.target.clone(), 450);
  }

  setAutoRotate(on) {
    this.stopFly();
    this.controls.autoRotate = on;
  }

  startFlythrough(onEnd) {
    if (!this.data) return;
    this.controls.autoRotate = false;
    this.tween = null;
    this.cursor.visible = false;
    const path = this.data.flyPath;
    const AHEAD = 22;
    const pts = [], look = [];
    let lastY = null;
    path.slice(0, path.length - AHEAD).forEach(([u, v], idx) => {
      const [x, z] = uvToXZ(u, v);
      let y = eToY(sampleGrid(this.data.heights, u, v)) + 20;
      // keep altitude smooth and above nearby terrain
      for (const du of [-0.06, 0, 0.06]) {
        y = Math.max(y, eToY(sampleGrid(this.data.heights, u + du, v)) + 12);
      }
      y = lastY === null ? y : lastY * 0.7 + y * 0.3;
      lastY = y;
      pts.push(new THREE.Vector3(x, y, z));
      const [lu, lv] = path[idx + AHEAD];
      const [lx, lz] = uvToXZ(lu, lv);
      const ahead = new THREE.Vector3(lx, eToY(sampleGrid(this.data.heights, lu, lv)), lz);
      const flat = ahead.clone().sub(new THREE.Vector3(x, ahead.y, z));
      if (flat.length() < 40) ahead.add(flat.setLength(40 - flat.length()));
      look.push(ahead);
    });
    this.fly = {
      pos: new THREE.CatmullRomCurve3(pts),
      look: new THREE.CatmullRomCurve3(look),
      start: performance.now(), dur: 16000, onEnd,
    };
    this.controls.enabled = false;
  }

  stopFly() {
    if (!this.fly) return;
    const end = this.fly.onEnd;
    this.fly = null;
    this.controls.enabled = true;
    end?.();
  }

  /* ------------------------------ tools ------------------------------ */
  setTool(tool) {
    this.tool = tool;
    this.toolPts = [];
    this.renderer.domElement.style.cursor = tool ? 'crosshair' : '';
  }

  bindEvents() {
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener('pointerdown', (e) => {
      down = [e.clientX, e.clientY];
      if (this.fly) this.stopFly();
      this.tween = null;
    });
    el.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]);
      down = null;
      if (moved < 5) this.onClick(e);
    });
    el.addEventListener('pointermove', (e) => {
      this.lastPointer = e;
      this.needsPick = true;
    });
    el.addEventListener('pointerleave', () => {
      this.lastPointer = null;
      if (this.uniforms) this.uniforms.uHoverOn.value = 0;
      this.cb.onHover?.(null);
    });
  }

  pick(e) {
    if (!this.terrain || this.rise < 1) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObject(this.terrain, false)[0];
    if (!hit) return null;
    const [u, v] = xzToUV(hit.point.x, hit.point.z);
    const elev = sampleGrid(this.data.heights, u, v);
    return { point: hit.point, u, v, E: u * EXTENT, N: v * EXTENT, Z: elev };
  }

  onClick(e) {
    if (!this.tool) return;
    const hit = this.pick(e);
    if (!hit) return;
    if (this.tool === 'hazard') {
      this.cb.onHazardPick?.(hit);
      return;
    }
    if (this.tool === 'probe') {
      this.addPin(hit, `${hit.Z.toFixed(1)} m`, `E ${fmt(hit.E)} · N ${fmt(hit.N)}`);
      this.cb.onProbe?.(hit);
      return;
    }
    this.toolPts.push(hit);
    this.addDot(hit.point, this.tool === 'profile' ? 0x4da3ff : 0xffb020);
    if (this.toolPts.length === 2) {
      const [a, b] = this.toolPts;
      this.toolPts = [];
      if (this.tool === 'distance') {
        const res = this.drawPath([[a.u, a.v], [b.u, b.v]], 0xffb020);
        const horiz = Math.hypot(b.E - a.E, b.N - a.N);
        const mid = res.points[Math.floor(res.points.length / 2)];
        this.addLabel(mid, `${fmt(horiz)} m`, `surface ${fmt(res.surface)} m · Δh ${(b.Z - a.Z).toFixed(1)} m`, 'measure');
        this.cb.onDistance?.({ horiz, surface: res.surface, dh: b.Z - a.Z });
      } else if (this.tool === 'profile') {
        this.showProfile([[a.u, a.v], [b.u, b.v]], true);
      }
    }
  }

  showProfile(uvPts, fromUser = false) {
    if (this.profileObj) {
      this.overlay.remove(this.profileObj);
      this.profileObj = null;
    }
    const res = this.drawPath(uvPts, 0x4da3ff, !fromUser);
    this.profileObj = res.line;
    this.profileSamples = res;
    this.cb.onProfile?.(res.samples, fromUser);
  }

  drawPath(uvPts, color, keep = false) {
    const d = this.data;
    const segs = [];
    let total = 0;
    for (let i = 0; i < uvPts.length - 1; i++) {
      const [u0, v0] = uvPts[i], [u1, v1] = uvPts[i + 1];
      const len = Math.hypot(u1 - u0, v1 - v0) * EXTENT;
      segs.push({ u0, v0, u1, v1, len, start: total });
      total += len;
    }
    const n = 240;
    const points = [], samples = [], flat = [];
    let surface = 0, prev = null;
    for (let s = 0; s <= n; s++) {
      const dist = (s / n) * total;
      const sg = segs.find((g) => dist <= g.start + g.len + 1e-6) || segs[segs.length - 1];
      const t = sg.len ? (dist - sg.start) / sg.len : 0;
      const u = sg.u0 + (sg.u1 - sg.u0) * t, v = sg.v0 + (sg.v1 - sg.v0) * t;
      const e = sampleGrid(d.heights, u, v);
      const [x, z] = uvToXZ(u, v);
      const pt = new THREE.Vector3(x, eToY(e) + 0.35, z);
      points.push(pt);
      flat.push(pt.x, pt.y, pt.z);
      samples.push({ d: dist, e, u, v });
      if (prev) surface += Math.hypot(dist - prev.d, e - prev.e);
      prev = { d: dist, e };
    }
    const g = new LineGeometry();
    g.setPositions(flat);
    const m = new LineMaterial({ color, linewidth: 3, depthTest: false, transparent: true });
    m.resolution.set(this.width, this.height);
    this.lineMats.push(m);
    const line = new Line2(g, m);
    line.renderOrder = 5;
    this.overlay.add(line);
    if (!keep) this.annotations.push(line);
    return { line, points, samples, surface, total };
  }

  profileCursor(i) {
    if (i == null || !this.profileSamples) {
      this.cursor.visible = false;
      return;
    }
    this.cursor.position.copy(this.profileSamples.points[i]);
    this.cursor.visible = true;
  }

  addDot(p, color) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.6, 16, 12),
      new THREE.MeshBasicMaterial({ color, depthTest: false })
    );
    m.renderOrder = 6;
    m.position.copy(p).add(new THREE.Vector3(0, 0.3, 0));
    this.overlay.add(m);
    this.annotations.push(m);
  }

  addPin(hit, title, sub) {
    const top = hit.point.clone().add(new THREE.Vector3(0, 7, 0));
    const g = new THREE.BufferGeometry().setFromPoints([hit.point, top]);
    const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false }));
    line.renderOrder = 6;
    this.overlay.add(line);
    this.annotations.push(line);
    this.addDot(hit.point, 0x4da3ff);
    this.addLabel(top, title, sub, 'pin');
  }

  addLabel(p, title, sub, kind) {
    const el = document.createElement('div');
    el.className = `map-label ${kind}`;
    el.innerHTML = `<strong>${title}</strong><span>${sub}</span>`;
    const o = new CSS2DObject(el);
    o.position.copy(p);
    this.overlay.add(o);
    this.annotations.push(o);
  }

  clearAnnotations() {
    for (const o of this.annotations) {
      this.overlay.remove(o);
      if (o.element) o.element.remove();
    }
    this.annotations = [];
    this.toolPts = [];
  }

  /* ------------------------------ loop ------------------------------ */
  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.width = w; this.height = h;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.lineMats.forEach((m) => m.resolution.set(w, h));
    this.resizeHooks.forEach((fn) => fn(h * this.renderer.getPixelRatio()));
  }

  frame() {
    const now = performance.now();
    const dt = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    const time = this.clock.getElapsedTime();
    if (this.waterUniforms) this.waterUniforms.uTime.value = time;
    if (this.uniforms) this.uniforms.uTime.value = time;
    this.frameHooks.forEach((fn) => fn(dt));

    if (this.data && this.rise < 1) {
      const t = Math.min(1, (now - this.riseStart - 500) / 2200);
      this.rise = t < 0 ? 0 : t;
      const a = Math.max(0, Math.min(1, (now - this.riseStart - 1800) / 900));
      this.axes.traverse((o) => { if (o.material) o.material.opacity = 0.35 * a; });
      if (a > 0) this.labelsVisible(true);
      this.axisLabels?.forEach((o) => (o.element.style.opacity = a));
      if (this.rise >= 1) this.cb.onReady?.();
    }

    if (this.data) this.world.scale.y = Math.max(0.001, easeOut(this.rise) * this.relief.value);

    if (this.tween) {
      const tw = this.tween;
      const t = Math.min(1, (now - tw.start) / tw.dur);
      const k = easeInOut(t);
      this.camera.position.lerpVectors(tw.p0, tw.p1, k);
      this.controls.target.lerpVectors(tw.t0, tw.t1, k);
      if (t >= 1) this.tween = null;
    }

    if (this.fly) {
      const t = Math.min(1, (now - this.fly.start) / this.fly.dur);
      const k = easeInOut(t);
      this.camera.position.copy(this.fly.pos.getPoint(k));
      const target = this.fly.look.getPoint(Math.min(1, k));
      this.controls.target.copy(target);
      this.camera.lookAt(target);
      if (t >= 1) {
        const end = this.fly.onEnd;
        this.fly = null;
        this.controls.enabled = true;
        this.flyTo(new THREE.Vector3(-122, 122, 122), new THREE.Vector3(0, 6, 0), 2400);
        end?.();
      }
    } else {
      this.controls.update();
    }

    if (this.needsPick && this.lastPointer) {
      this.needsPick = false;
      const hit = this.pick(this.lastPointer);
      if (this.uniforms) {
        this.uniforms.uHoverOn.value = hit ? 1 : 0;
        if (hit) this.uniforms.uHover.value.copy(hit.point);
      }
      this.cb.onHover?.(hit);
    }

    this.cb.onCamera?.(this.controls.getAzimuthalAngle());
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }

  snapshot() {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }
}

export const fmt = (n) => Math.round(n).toLocaleString('en-US');
