import * as THREE from 'three';
import { EXTENT } from './terrainData.js';
import { makeNoise } from './noise.js';
import { eToY, uvToXZ } from './viewer.js';

/*
 * Hazard simulations on the DSM grid. Everything runs client-side on the same
 * 321 × 321 height grid the viewer renders:
 *   rain      – storm cell → D8 runoff routing → streams light up, river rises
 *   fire      – cellular automaton driven by fuel, wind and slope
 *   landslide – susceptibility map → source scar + debris runout, terrain deforms
 * Flood (water-level rise) is handled by the viewer's existing water plane.
 */

export const MODES = { flood: 0, rain: 1, fire: 2, landslide: 3 };
// Neighbour offsets (di = east, dj = north) and their lengths.
const NB = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const NB_LEN = NB.map(([a, b]) => Math.hypot(a, b));
export const WIND_DIRS = { N: [0, -1], NE: [-1, -1], E: [-1, 0], SE: [-1, 1], S: [0, 1], SW: [1, 1], W: [1, 0], NW: [1, -1] }; // "blowing from" → travel vector

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/* ------------------------------ particles ------------------------------ */
const puffVert = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  uniform float uScale;
  varying float vA;
  varying vec3 vC;
  void main() {
    vA = aAlpha; vC = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uScale / max(-mv.z, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`;
const puffFrag = /* glsl */ `
  varying float vA;
  varying vec3 vC;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(vC, a * a * vA);
  }
`;

class Particles {
  constructor(cap, additive = false) {
    this.cap = cap;
    this.n = 0;
    this.pos = new Float32Array(cap * 3);
    this.vel = new Float32Array(cap * 3);
    this.life = new Float32Array(cap);
    this.age = new Float32Array(cap);
    this.size0 = new Float32Array(cap);
    this.size1 = new Float32Array(cap);
    this.alpha0 = new Float32Array(cap);
    this.size = new Float32Array(cap);
    this.alpha = new Float32Array(cap);
    this.color = new Float32Array(cap * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.color, 3));
    this.uniforms = { uScale: { value: 600 } };
    this.points = new THREE.Points(g, new THREE.ShaderMaterial({
      vertexShader: puffVert, fragmentShader: puffFrag, uniforms: this.uniforms,
      transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    }));
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 4 : 3;
  }

  spawn(x, y, z, vx, vy, vz, life, s0, s1, a0, [r, g, b]) {
    if (this.n >= this.cap) return;
    const i = this.n++;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.color.set([r, g, b], i * 3);
    this.life[i] = life; this.age[i] = 0;
    this.size0[i] = s0; this.size1[i] = s1; this.alpha0[i] = a0;
  }

  update(dt) {
    let i = 0;
    while (i < this.n) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        const last = --this.n;               // swap-remove
        if (i !== last) {
          this.pos.copyWithin(i * 3, last * 3, last * 3 + 3);
          this.vel.copyWithin(i * 3, last * 3, last * 3 + 3);
          this.color.copyWithin(i * 3, last * 3, last * 3 + 3);
          this.life[i] = this.life[last]; this.age[i] = this.age[last];
          this.size0[i] = this.size0[last]; this.size1[i] = this.size1[last]; this.alpha0[i] = this.alpha0[last];
        }
        continue;
      }
      for (let c = 0; c < 3; c++) this.pos[i * 3 + c] += this.vel[i * 3 + c] * dt;
      this.vel[i * 3 + 1] *= 1 - 0.25 * dt;
      const t = this.age[i] / this.life[i];
      this.size[i] = this.size0[i] + (this.size1[i] - this.size0[i]) * t;
      this.alpha[i] = this.alpha0[i] * Math.min(1, t * 6) * (1 - t);
      i++;
    }
    const g = this.points.geometry;
    g.setDrawRange(0, this.n);
    for (const k of ['position', 'aSize', 'aAlpha', 'aColor']) g.attributes[k].needsUpdate = true;
  }

  clear() {
    this.n = 0;
    this.points.geometry.setDrawRange(0, 0);
  }
}

/* ------------------------------ hazards ------------------------------ */
export class Hazards {
  constructor(viewer, onUpdate) {
    this.viewer = viewer;
    this.onUpdate = onUpdate;
    this.mode = 'flood';
    this.running = false;
    this.params = {
      rain: { intensity: 60, radius: 500 },
      fire: { windFrom: 'SW', windSpeed: 20 },
    };
    this.rnd = makeNoise(5).rnd;

    this.group = new THREE.Group();
    viewer.scene.add(this.group);
    this.puffs = new Particles(2600);
    this.sparks = new Particles(900, true);
    this.group.add(this.puffs.points, this.sparks.points);

    const RAIN = 2400;
    this.rainCap = RAIN;
    this.rainPos = new Float32Array(RAIN * 6);
    this.rainGround = new Float32Array(RAIN);
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3));
    this.rain = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0xbfd9ff, transparent: true, opacity: 0.42, depthWrite: false }));
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    this.group.add(this.rain);

    viewer.frameHooks.push((dt) => this.update(dt));
    viewer.resizeHooks.push((h) => {
      const s = h / (2 * Math.tan(THREE.MathUtils.degToRad(viewer.camera.fov / 2)));
      this.puffs.uniforms.uScale.value = s;
      this.sparks.uniforms.uScale.value = s;
    });
    viewer.resize();
  }

  /* ---------- per-scene precomputation ---------- */
  init(data) {
    this.stop();
    this.data = data;
    const { R, N } = data;
    this.R = R; this.N = N;
    this.cell = EXTENT / N;
    this.cellArea = this.cell * this.cell;
    this.baseHeights = Float32Array.from(data.heights);
    const n = R * R;
    this.tex = new Uint8Array(n * 4);
    this.texture = new THREE.DataTexture(this.tex, R, R, THREE.RGBAFormat);
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.needsUpdate = true;
    this.viewer.uniforms.uHaz.value = this.texture;
    this.computeRouting();
    this.computeFuel();
    this.computeSusceptibility();
    this.setMode(this.mode, true);
  }

  computeRouting() {
    const { R } = this;
    const h = this.data.heights;
    const n = R * R;
    this.down = new Int32Array(n).fill(-1);
    for (let j = 0; j < R; j++) {
      for (let i = 0; i < R; i++) {
        const k = j * R + i;
        let best = 0, bk = -1;
        for (let d = 0; d < 8; d++) {
          const ii = i + NB[d][0], jj = j + NB[d][1];
          if (ii < 0 || jj < 0 || ii >= R || jj >= R) continue;
          const kk = jj * R + ii;
          const s = (h[k] - h[kk]) / NB_LEN[d];
          if (s > best) { best = s; bk = kk; }
        }
        this.down[k] = bk;
      }
    }
    const order = new Uint32Array(n);
    for (let k = 0; k < n; k++) order[k] = k;
    this.order = order.sort((a, b) => h[b] - h[a]);
    // Uniform-rain accumulation → topographic wetness (used by landslide susceptibility)
    const acc = new Float32Array(n).fill(1);
    for (const k of this.order) if (this.down[k] >= 0) acc[this.down[k]] += acc[k];
    this.accAll = acc;
  }

  computeFuel() {
    const d = this.data;
    const nz = makeNoise(d.seed + 3);
    const n = this.R * this.R;
    this.fuel = new Float32Array(n);
    const peak = d.maxE - (d.maxE - d.minE) * 0.08;
    for (let k = 0; k < n; k++) {
      const e = d.heights[k], s = d.slope[k];
      const u = (k % this.R) / this.N, v = Math.floor(k / this.R) / this.N;
      let f;
      if (e < d.lakeLevel + 0.3) f = 0;
      else if (d.town[k]) f = 0.45;
      else if (d.townZone[k]) f = 0.35;
      else if (s > 52 || (d.source === 'demo' && e > peak)) f = 0.06;
      else if (d.valley[k] < 0.3 && s < 9) f = 0.5;                 // crops / grass
      else f = 0.85 + 0.15 * nz.fbm(u * 12, v * 12, 3);             // forest
      this.fuel[k] = clamp01(f);
    }
  }

  computeSusceptibility() {
    const d = this.data;
    const { R } = this;
    const n = R * R;
    const sus = new Float32Array(n);
    const h = d.heights;
    let maxS = 0;
    for (let j = 1; j < R - 1; j++) {
      for (let i = 1; i < R - 1; i++) {
        const k = j * R + i;
        if (h[k] < d.lakeLevel + 0.5) continue;
        const curv = (h[k - 1] + h[k + 1] + h[k - R] + h[k + R] - 4 * h[k]) / this.cell; // >0 = concave hollow
        const wet = smooth(1.5, 7, Math.log(this.accAll[k]));
        const slopeTerm = smooth(24, 48, d.slope[k]) * (1 - smooth(60, 75, d.slope[k]) * 0.6);
        const s = slopeTerm * (0.45 + 0.35 * wet + 0.2 * smooth(-0.1, 0.4, curv)) * (0.75 + 0.25 * (1 - this.fuel[k]));
        sus[k] = s;
        if (s > maxS) maxS = s;
      }
    }
    // Normalise by the 99th percentile so only the most prone hollows read as "very high".
    const sorted = Float32Array.from(sus).sort();
    const p99 = sorted[Math.floor(n * 0.99)] || maxS;
    for (let k = 0; k < n; k++) sus[k] = clamp01(Math.pow(sus[k] / p99, 1.6));
    this.sus = sus;
  }

  /* ---------- mode / target ---------- */
  setMode(mode, keepFlood = false) {
    this.stop();
    this.restoreTerrain();
    this.mode = mode;
    const u = this.viewer.uniforms;
    u.uHazMode.value = MODES[mode];
    this.tex.fill(0);
    if (mode === 'landslide') for (let k = 0; k < this.sus.length; k++) this.tex[k * 4] = this.sus[k] * 255;
    this.texture.needsUpdate = true;
    this.puffs.clear();
    this.sparks.clear();
    this.rain.visible = false;
    if (!keepFlood && mode !== 'flood') this.viewer.setFlood(0);
    this.state = 'idle';
    this.t = 0;
    if (mode !== 'flood') this.setTarget(...this.defaultTarget(mode));
    else u.uHazRing.value = 0;
    this.emit(true);
  }

  defaultTarget(mode) {
    const { R, N } = this;
    if (mode === 'landslide') {
      let best = -1, bk = 0;
      for (let k = 0; k < this.sus.length; k++) {
        const u = (k % R) / N, v = Math.floor(k / R) / N;
        const centre = 1 - smooth(0.25, 0.45, Math.hypot(u - 0.5, v - 0.5));
        const high = smooth(0.3, 0.6, (this.data.heights[k] - this.data.minE) / (this.data.maxE - this.data.minE));
        const s = this.sus[k] * centre * high;
        if (s > best) { best = s; bk = k; }
      }
      return [(bk % R) / N, Math.floor(bk / R) / N];
    }
    const pref = mode === 'fire' ? [0.3, 0.7] : [0.56, 0.72];
    let best = Infinity, bk = 0;
    for (let k = 0; k < this.fuel.length; k++) {
      if (mode === 'fire' ? this.fuel[k] < 0.85 : this.data.heights[k] < this.data.lakeLevel + 20) continue;
      const u = (k % R) / N, v = Math.floor(k / R) / N;
      const dd = (u - pref[0]) ** 2 + (v - pref[1]) ** 2;
      if (dd < best) { best = dd; bk = k; }
    }
    return [(bk % R) / N, Math.floor(bk / R) / N];
  }

  setTarget(u, v) {
    if (this.running || this.state === 'done') this.setMode(this.mode);
    this.target = [u, v];
    const un = this.viewer.uniforms;
    un.uHazCenter.value.set(u, v);
    const radius = this.mode === 'rain' ? this.params.rain.radius / EXTENT : this.mode === 'fire' ? 0.012 : 0.02;
    un.uHazRadius.value = radius;
    un.uHazRing.value = 1;
    un.uHazRingColor.value.set(...({ rain: [0.55, 0.8, 1], fire: [1, 0.6, 0.2], landslide: [1, 0.88, 0.35] }[this.mode]));
    if (this.mode === 'rain') this.prepareRain();
    if (this.mode === 'landslide') this.prepareLandslide();
    this.emit(true);
  }

  setParam(mode, key, value) {
    this.params[mode][key] = value;
    if (mode === 'rain' && this.mode === 'rain' && key === 'radius') {
      this.viewer.uniforms.uHazRadius.value = value / EXTENT;
      if (!this.running) this.prepareRain();
    }
    this.emit(true);
  }

  /* ---------- transport ---------- */
  toggle() {
    if (this.mode === 'flood') return;
    if (this.state === 'done') this.setMode(this.mode);
    if (this.running) { this.running = false; this.state = 'paused'; }
    else {
      this.running = true;
      if (this.state === 'idle') this.begin();
      this.state = 'running';
    }
    this.emit(true);
  }

  stop() {
    this.running = false;
  }

  reset() {
    this.setMode(this.mode);
  }

  begin() {
    this.t = 0;
    if (this.mode === 'landslide' && this.slidePath) {
      // Frame the whole slide: source to toe.
      const a = this.slidePath[0], b = this.slidePath[this.slidePath.length - 1];
      const mid = (i) => ((a % this.R) + (b % this.R)) / 2 / this.N * (i ? 0 : 1) + (Math.floor(a / this.R) + Math.floor(b / this.R)) / 2 / this.N * (i ? 1 : 0);
      this.viewer.focusOn(mid(0), mid(1), 70);
    }
    if (this.mode === 'fire') this.igniteAt(...this.target);
    if (this.mode === 'rain') this.prepareRain();
  }

  finish() {
    this.running = false;
    this.state = 'done';
    this.emit(true);
  }

  restoreTerrain() {
    if (this.slideBaked || this.viewer.hasDisplacement) {
      this.viewer.setHeights(this.baseHeights);
      this.slideBaked = false;
    }
  }

  /* ---------- per-frame ---------- */
  update(dt) {
    if (!this.data) return;
    dt = Math.min(dt, 0.05);
    if (this.running) {
      if (this.mode === 'rain') this.stepRain(dt);
      if (this.mode === 'fire') this.stepFire(dt);
      if (this.mode === 'landslide') this.stepLandslide(dt);
    }
    if (this.mode === 'rain') this.animateRain(dt);
    this.puffs.update(dt);
    this.sparks.update(dt);
    this.emitTimer = (this.emitTimer || 0) + dt;
    if (this.emitTimer > 0.12) { this.emitTimer = 0; this.emit(); }
  }

  cellWorld(k, lift = 0) {
    const i = k % this.R, j = Math.floor(k / this.R);
    const [x, z] = uvToXZ(i / this.N, j / this.N);
    return [x, eToY(this.data.heights[k]) + lift, z];
  }

  /* ================= RAIN ================= */
  prepareRain() {
    const { R, N } = this;
    const d = this.data;
    const [cu, cv] = this.target;
    const rad = this.params.rain.radius / EXTENT;
    const n = R * R;
    const L = new Float32Array(n);
    let rainCells = 0, coefSum = 0;
    for (let k = 0; k < n; k++) {
      const u = (k % R) / N, v = Math.floor(k / R) / N;
      const r = Math.hypot(u - cu, v - cv) / rad;
      if (r >= 1) continue;
      const w = 1 - smooth(0.6, 1, r);
      if (d.heights[k] < d.lakeLevel) continue;
      const coef = 0.3 + 0.55 * smooth(3, 30, d.slope[k]) + (d.town[k] ? 0.25 : 0);
      L[k] = w * coef;
      rainCells += w;
      coefSum += w * coef;
    }
    const acc = Float32Array.from(L);
    const tt = new Float32Array(n).fill(1e9);
    for (let k = 0; k < n; k++) if (L[k] > 0) tt[k] = 0;
    for (const k of this.order) {
      const dn = this.down[k];
      if (dn < 0) continue;
      acc[dn] += acc[k];
      if (tt[k] + 1 < tt[dn]) tt[dn] = tt[k] + 1;
    }
    let maxTT = 1;
    for (let k = 0; k < n; k++) if (acc[k] > 6 && tt[k] < 1e8 && tt[k] > maxTT) maxTT = tt[k];
    // Stream strength, dilated by one cell so channels read at map scale; arrival time = earliest in the 3×3.
    const strength = new Float32Array(n), arrive = new Float32Array(n).fill(1e9);
    for (let k = 0; k < n; k++) {
      if (acc[k] <= 3 || tt[k] >= 1e8) continue;
      const s = clamp01((Math.log2(acc[k]) - 1.4) / 4.5);
      const i = k % R, j = (k - i) / R;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= R || jj >= R) continue;
          const kk = jj * R + ii;
          const f = di || dj ? 0.65 : 1;
          if (s * f > strength[kk]) strength[kk] = s * f;
          if (tt[k] < arrive[kk]) arrive[kk] = tt[k];
        }
      }
    }
    this.rainL = L; this.rainAcc = acc; this.rainTT = arrive; this.rainMaxTT = maxTT; this.rainStream = strength;
    this.rainArea = rainCells * this.cellArea;
    this.rainCoef = coefSum / Math.max(rainCells, 1);
    this.writeRainTexture(0);
    this.seedRainDrops();
  }

  writeRainTexture(p) {
    const tex = this.tex, n = this.R * this.R;
    const front = p * this.rainMaxTT * 1.25;
    const wet = Math.min(1, p * 4);
    const grow = Math.min(1, p * 3);
    for (let k = 0; k < n; k++) {
      const stream = this.rainTT[k] <= front ? this.rainStream[k] * grow : 0;
      tex[k * 4] = stream * 255;
      tex[k * 4 + 1] = Math.min(1, this.rainL[k] * 2) * wet * 255;
    }
    this.texture.needsUpdate = true;
  }

  seedRainDrops() {
    for (let i = 0; i < this.rainCap; i++) this.respawnDrop(i, true);
  }

  respawnDrop(i, anyHeight) {
    const [cu, cv] = this.target;
    const rad = this.params.rain.radius / EXTENT;
    const a = this.rnd() * Math.PI * 2, r = Math.sqrt(this.rnd()) * rad;
    const u = cu + Math.cos(a) * r, v = cv + Math.sin(a) * r;
    const i0 = Math.round(Math.min(1, Math.max(0, u)) * this.N), j0 = Math.round(Math.min(1, Math.max(0, v)) * this.N);
    const [x, z] = uvToXZ(u, v);
    const ground = eToY(this.data.heights[j0 * this.R + i0]);
    const top = eToY(this.data.maxE) + 16;
    const y = anyHeight ? ground + this.rnd() * (top - ground) : top + this.rnd() * 6;
    this.rainGround[i] = ground;
    this.rainPos.set([x, y, z, x + 0.25, y + 1.8, z - 0.15], i * 6);
  }

  animateRain(dt) {
    const raining = this.running && this.mode === 'rain';
    this.rain.visible = raining || (this.state === 'paused' && this.mode === 'rain');
    if (!raining) return;
    const count = Math.floor(this.rainCap * (0.25 + 0.75 * this.params.rain.intensity / 120));
    const fall = 70 * dt;
    for (let i = 0; i < count; i++) {
      const o = i * 6;
      this.rainPos[o + 1] -= fall; this.rainPos[o + 4] -= fall;
      this.rainPos[o] -= fall * 0.14; this.rainPos[o + 3] -= fall * 0.14;
      if (this.rainPos[o + 1] < this.rainGround[i]) this.respawnDrop(i, false);
    }
    this.rain.geometry.setDrawRange(0, count * 2);
    this.rain.geometry.attributes.position.needsUpdate = true;

    // storm cloud + splash mist
    const [cu, cv] = this.target;
    const rad = this.params.rain.radius / EXTENT;
    const top = eToY(this.data.maxE) + 18;
    for (let s = 0; s < 3; s++) {
      const a = this.rnd() * Math.PI * 2, r = Math.sqrt(this.rnd()) * rad * 1.1;
      const [x, z] = uvToXZ(cu + Math.cos(a) * r, cv + Math.sin(a) * r);
      this.puffs.spawn(x, top + this.rnd() * 5, z, -0.6, 0.15, 0.3, 5 + this.rnd() * 3, 16, 26, 0.32, [0.36, 0.38, 0.42]);
    }
  }

  stepRain(dt) {
    const DUR = 15; // seconds of real time for a 3 h storm
    this.t = Math.min(DUR, this.t + dt);
    const p = this.t / DUR;
    this.rainP = p;
    this.writeRainTexture(p);
    const I = this.params.rain.intensity / 1000 / 3600; // m/s
    const Q = this.rainArea * this.rainCoef * I * Math.min(1, p * 1.6);
    this.rainQ = Q;
    this.viewer.setFlood(Math.min(3.2, 0.55 * Math.sqrt(Q)) * smooth(0.15, 1, p));
    if (p >= 1) this.finish();
  }

  /* ================= FIRE ================= */
  igniteAt(u, v) {
    const n = this.R * this.R;
    this.burn = new Float32Array(n);
    this.burnt = new Uint8Array(n);
    this.burning = [];
    this.fireSteps = 0;
    this.fireAcc = 0;
    const ci = Math.round(u * this.N), cj = Math.round(v * this.N);
    for (let dj = -2; dj <= 2; dj++) {
      for (let di = -2; di <= 2; di++) {
        if (di * di + dj * dj > 5) continue;
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= this.R || j >= this.R) continue;
        const k = j * this.R + i;
        if (this.fuel[k] <= 0) continue;
        this.burn[k] = 8 + this.fuel[k] * 10;
        this.burning.push(k);
      }
    }
  }

  stepFire(dt) {
    this.fireAcc += dt;
    const STEP = 0.075; // one CA step = one simulated minute
    let changed = false;
    while (this.fireAcc >= STEP) {
      this.fireAcc -= STEP;
      this.fireStep();
      changed = true;
    }
    if (changed) this.writeFireTexture();
    this.fireParticles(dt);
    if (this.burning.length === 0) this.finish();
  }

  fireStep() {
    const { R, fuel, burn, burnt } = this;
    const h = this.data.heights;
    const [wx, wy] = WIND_DIRS[this.params.fire.windFrom];
    const wl = Math.hypot(wx, wy) || 1;
    const ws = this.params.fire.windSpeed;
    const next = [];
    for (const k of this.burning) {
      const i = k % R, j = (k - i) / R;
      for (let d = 0; d < 8; d++) {
        const ii = i + NB[d][0], jj = j + NB[d][1];
        if (ii < 0 || jj < 0 || ii >= R || jj >= R) continue;
        const kk = jj * R + ii;
        if (burn[kk] > 0 || burnt[kk] || fuel[kk] <= 0.02) continue;
        const cosA = (NB[d][0] * wx + NB[d][1] * wy) / (NB_LEN[d] * wl);
        const windF = Math.exp((ws / 9) * cosA);
        const rise = (h[kk] - h[k]) / (NB_LEN[d] * this.cell);
        const slopeF = Math.exp(Math.max(-1.2, Math.min(2.2, Math.atan(rise) * 3.2)));
        const p = 0.085 * fuel[kk] * windF * slopeF / NB_LEN[d];
        if (this.rnd() < p) {
          burn[kk] = 6 + fuel[kk] * 12 + this.rnd() * 4;
          next.push(kk);
        }
      }
    }
    const still = [];
    for (const k of this.burning) {
      burn[k] -= 1;
      if (burn[k] <= 0) { burn[k] = 0; burnt[k] = 1; }
      else still.push(k);
    }
    this.burning = still.concat(next);
    this.fireSteps++;
  }

  writeFireTexture() {
    const tex = this.tex, n = this.R * this.R, R = this.R;
    for (let k = 0; k < n; k++) {
      tex[k * 4] = this.burn[k] > 0 ? 255 : 0;
      tex[k * 4 + 1] = this.burnt[k] ? 255 : this.burn[k] > 0 ? 90 : 0;
      tex[k * 4 + 2] = 0;
    }
    for (const k of this.burning) {
      const i = k % R, j = (k - i) / R;
      for (let dj = -2; dj <= 2; dj++) {
        for (let di = -2; di <= 2; di++) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= R || jj >= R) continue;
          const o = (jj * R + ii) * 4 + 2;
          tex[o] = Math.max(tex[o], 255 - (Math.abs(di) + Math.abs(dj)) * 50);
        }
      }
    }
    this.texture.needsUpdate = true;
  }

  fireParticles(dt) {
    const b = this.burning;
    if (!b.length) return;
    const [wx, wy] = WIND_DIRS[this.params.fire.windFrom];
    const ws = this.params.fire.windSpeed / 20;
    const drift = [wx * ws * 1.6, -wy * ws * 1.6]; // world x = east, world z = south
    const smokeN = Math.min(14, 2 + b.length / 60);
    for (let s = 0; s < smokeN; s++) {
      const k = b[Math.floor(this.rnd() * b.length)];
      const [x, y, z] = this.cellWorld(k, 0.4);
      const g = 0.16 + this.rnd() * 0.12;
      this.puffs.spawn(x, y, z, drift[0] + (this.rnd() - 0.5), 3.2 + this.rnd() * 2.5, drift[1] + (this.rnd() - 0.5),
        4 + this.rnd() * 3, 2.5, 13 + this.rnd() * 6, 0.5, [g, g * 0.95, g * 0.9]);
    }
    const sparkN = Math.min(16, 3 + b.length / 40);
    for (let s = 0; s < sparkN; s++) {
      const k = b[Math.floor(this.rnd() * b.length)];
      const [x, y, z] = this.cellWorld(k, 0.3);
      this.sparks.spawn(x, y, z, drift[0] * 0.5 + (this.rnd() - 0.5) * 1.5, 1.5 + this.rnd() * 3, drift[1] * 0.5 + (this.rnd() - 0.5) * 1.5,
        0.6 + this.rnd() * 0.8, 1.3, 0.4, 0.9, [1, 0.45 + this.rnd() * 0.3, 0.1]);
    }
  }

  /* ================= LANDSLIDE ================= */
  prepareLandslide() {
    const { R, N } = this;
    const d = this.data;
    const h = this.baseHeights;
    const [cu, cv] = this.target;
    const ci = Math.round(cu * N), cj = Math.round(cv * N);
    const src = cj * R + ci;
    // Runout path: steepest descent until the ground flattens or reaches water.
    const path = [src];
    let k = src, flat = 0;
    const seen = new Set([src]);
    while (path.length < 200) {
      const dn = this.down[k];
      if (dn < 0 || seen.has(dn)) break;
      const s = d.slope[dn];
      flat = s < 7 ? flat + 1 : 0;
      path.push(dn); seen.add(dn);
      k = dn;
      if (flat >= 6 || h[dn] < d.lakeLevel + 0.3) break;
    }
    this.slidePath = path;

    const n = R * R;
    const disp = new Float32Array(n);
    const arrive = new Float32Array(n).fill(2);
    const debris = new Float32Array(n);
    // Source scar
    const SR = 13;
    let volume = 0;
    for (let dj = -SR; dj <= SR; dj++) {
      for (let di = -SR; di <= SR; di++) {
        const r = Math.hypot(di, dj * 1.25) / SR;
        if (r >= 1) continue;
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= R || j >= R) continue;
        const kk = j * R + i;
        const depth = 24 * (1 - r * r) * (0.7 + 0.3 * this.sus[kk]);
        disp[kk] = -depth;
        arrive[kk] = 0;
        volume += depth * this.cellArea;
      }
    }
    // Debris along the path, depositing mostly in the toe fan.
    const L = path.length;
    const toeStart = Math.floor(L * 0.55);
    let depositW = 0;
    const dep = new Float32Array(n);
    for (let p = 1; p < L; p++) {
      const pk = path[p];
      const pi = pk % R, pj = (pk - pi) / R;
      const w = 5 + p * 0.1 + (p > toeStart ? (p - toeStart) * 0.3 : 0);
      const tArr = 0.08 + 0.82 * (p / L);
      const wr = Math.ceil(w);
      for (let dj = -wr; dj <= wr; dj++) {
        for (let di = -wr; di <= wr; di++) {
          const r = Math.hypot(di, dj) / w;
          if (r >= 1) continue;
          const i = pi + di, j = pj + dj;
          if (i < 0 || j < 0 || i >= R || j >= R) continue;
          const kk = j * R + i;
          if (arrive[kk] > tArr) arrive[kk] = tArr;
          debris[kk] = Math.max(debris[kk], 1 - r * 0.4);
          if (p >= toeStart) {
            const wgt = (1 - r * r) * smooth(toeStart, L, p + L * 0.1);
            if (wgt > dep[kk]) dep[kk] = wgt;
          }
        }
      }
    }
    for (let kk = 0; kk < n; kk++) depositW += dep[kk];
    const bulking = 1.25;
    const unit = depositW > 0 ? (volume * bulking) / (depositW * this.cellArea) : 0;
    let structures = 0, area = 0;
    for (let kk = 0; kk < n; kk++) {
      if (dep[kk] > 0 && disp[kk] >= 0) disp[kk] = Math.min(18, dep[kk] * unit);
      if (debris[kk] > 0 || disp[kk] < 0) {
        area += this.cellArea;
        if (d.town[kk]) structures++;
      }
    }
    this.slide = {
      disp, arrive, debris, volume, area, structures: Math.round(structures / 2),
      runout: (L - 1) * this.cell * 1.15, drop: h[src] - h[path[L - 1]], src,
    };
    this.viewer.setDisplacement(disp, arrive);
    // Susceptibility + source marker only
    for (let kk = 0; kk < n; kk++) { this.tex[kk * 4 + 1] = 0; this.tex[kk * 4 + 2] = 0; }
    this.texture.needsUpdate = true;
  }

  stepLandslide(dt) {
    const DUR = 5.5;
    this.t = Math.min(DUR, this.t + dt);
    const p = this.t / DUR;
    const eased = 1 - Math.pow(1 - p, 2.2);
    this.viewer.uniforms.uSlide.value = eased;
    this.viewer.uniforms.uHazOverlay.value = 1 - smooth(0, 0.3, p) * 0.6;
    const { debris, arrive, disp } = this.slide;
    const n = this.R * this.R;
    for (let k = 0; k < n; k++) {
      if (disp[k] < 0) this.tex[k * 4 + 2] = smooth(0, 0.15, eased) * 255;
      if (debris[k] > 0) this.tex[k * 4 + 1] = smooth(arrive[k], arrive[k] + 0.1, eased) * debris[k] * 255;
    }
    this.texture.needsUpdate = true;
    // Dust cloud at the debris front
    const path = this.slidePath;
    const fi = Math.min(path.length - 1, Math.floor(((eased - 0.08) / 0.82) * path.length));
    if (fi >= 0 && p < 0.95) {
      for (let s = 0; s < 6; s++) {
        const k = path[Math.max(0, fi - Math.floor(this.rnd() * 6))];
        const [x, y, z] = this.cellWorld(k, 0.6);
        const g = 0.42 + this.rnd() * 0.1;
        this.puffs.spawn(x + (this.rnd() - 0.5) * 2, y, z + (this.rnd() - 0.5) * 2, (this.rnd() - 0.5) * 2, 1.2 + this.rnd() * 1.6, (this.rnd() - 0.5) * 2,
          2.5 + this.rnd() * 2, 3, 12, 0.55, [g, g * 0.86, g * 0.7]);
      }
    }
    if (p >= 1) {
      this.viewer.bakeDisplacement();
      this.slideBaked = true;
      this.finish();
    }
  }

  /* ---------- stats for the UI ---------- */
  emit(force = false) {
    if (!this.data) return;
    const m = this.mode;
    const fmt = (x) => Math.round(x).toLocaleString('en-US');
    let s = { mode: m, state: this.state };
    if (m === 'rain') {
      const p = this.rainP || 0;
      const hrs = (this.state === 'idle' ? 0 : p) * 3;
      const I = this.params.rain.intensity;
      s.big = `${(I * hrs).toFixed(0)} mm`;
      s.bigLabel = `rainfall · ${hrs.toFixed(1)} h of 3 h`;
      s.tiles = [
        ['Peak runoff', `${(this.state === 'idle' ? 0 : this.rainQ || 0).toFixed(1)} m³/s`],
        ['Storm area', `${((this.rainArea || 0) / 1e6).toFixed(2)} km²`],
        ['River stage', `+${this.viewer.floodOffset.toFixed(1)} m`],
      ];
    } else if (m === 'fire') {
      let burntN = 0, town = 0;
      if (this.burnt) {
        for (let k = 0; k < this.burnt.length; k++) {
          if (this.burnt[k] || this.burn[k] > 0) { burntN++; if (this.data.town[k] || this.data.townZone[k]) town++; }
        }
      }
      const ha = (burntN * this.cellArea) / 1e4;
      const mins = this.fireSteps || 0;
      const radius = Math.sqrt((burntN * this.cellArea) / Math.PI);
      s.big = `${ha.toFixed(1)} ha`;
      s.bigLabel = `burned · ${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m elapsed`;
      s.tiles = [
        ['Active front', `${(((this.burning?.length || 0) * this.cell) / 2500).toFixed(2)} km`],
        ['Spread rate', `${mins ? (radius / mins).toFixed(1) : '0.0'} m/min`],
        ['Structures', fmt(town / 2)],
      ];
    } else if (m === 'landslide') {
      const sl = this.slide;
      const k = sl ? sl.src : 0;
      const sus = this.sus[k];
      const cls = sus > 0.75 ? 'Very high' : sus > 0.55 ? 'High' : sus > 0.35 ? 'Moderate' : 'Low';
      const started = this.state !== 'idle';
      s.big = started ? `${fmt(sl.volume)} m³` : sus.toFixed(2);
      s.bigLabel = started ? 'displaced volume' : `${cls.toLowerCase()} susceptibility at source`;
      s.tiles = [
        ['Runout', `${fmt(sl?.runout || 0)} m`],
        ['Affected', `${((sl?.area || 0) / 1e4).toFixed(1)} ha`],
        ['Structures', started ? fmt(sl.structures) : '—'],
      ];
    }
    this.onUpdate?.(s, force);
  }
}
