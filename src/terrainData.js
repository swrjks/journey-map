import { makeNoise, hash2 } from './noise.js';

export const EXTENT = 3600; // metres per side
export const N = 320;       // grid segments per side (vertices = N + 1)
export const R = N + 1;

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a + (b - a) * t;

// The valley runs diagonally from the SW corner (a = 0) to the NE corner (a = 1).
// a = position along the diagonal, across = signed offset perpendicular to it.
const D = Math.SQRT1_2;
export const wiggle = (a) => 0.11 * Math.sin(a * 4.4 + 0.4) + 0.045 * Math.sin(a * 10.7 + 1.3);
export const toValley = (u, v) => [(u + v) / 2, (u - v) * D];
export const fromValley = (a, across) => [a + across * D, a - across * D];
export const centerUV = (a) => fromValley(a, wiggle(a));

export function sampleGrid(arr, u, v) {
  const x = clamp01(u) * (R - 1), y = clamp01(v) * (R - 1);
  const i = Math.min(Math.floor(x), R - 2), j = Math.min(Math.floor(y), R - 2);
  const fx = x - i, fy = y - j;
  const a = arr[j * R + i], b = arr[j * R + i + 1];
  const c = arr[(j + 1) * R + i], d = arr[(j + 1) * R + i + 1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/* ---------- Procedural demo scene: Himalayan-style glacial valley ---------- */
export function generateTerrain(seed = 11, satSize = 1024) {
  const nz = makeNoise(seed), nz2 = makeNoise(seed + 99);
  const h = new Float32Array(R * R);
  const valley = new Float32Array(R * R);
  const town = new Uint8Array(R * R);
  const townZone = new Uint8Array(R * R);
  const ground = new Float32Array(R * R); // terrain height under buildings
  const lakeLevel = 250;

  for (let j = 0; j < R; j++) {
    const v = j / N;
    for (let i = 0; i < R; i++) {
      const u = i / N;
      const [a, across] = toValley(u, v);
      const lake = Math.exp(-Math.pow((a - 0.62) / 0.14, 2));
      const w = 0.06 + 0.08 * lake + 0.014 * Math.sin(a * 7.1);
      const wa = across + 0.03 * nz.fbm(u * 3.1 + 5, v * 3.1, 3);
      const off = wa - wiggle(a);
      const d0 = Math.abs(off);
      const d = d0 + 0.05 * nz2.fbm(u * 8, v * 8, 4) * smooth(0, w * 1.2, d0); // gullies on the valley walls
      const ridge = nz.ridged(u * 2.7 + 2.1, v * 2.7 + 7.3, 6);
      const broad = 0.5 + 0.5 * nz2.fbm(u * 1.4, v * 1.4, 4);
      const m = 0.62 * ridge + 0.38 * broad;
      const mtn = 380 + m * 980 + 22 * nz.fbm(u * 14, v * 14, 3);
      const t = smooth(w * 0.55, w * 3.2, d);

      let floor = 254 + 7 * a + 2.2 * nz2.fbm(u * 22, v * 22, 2);
      floor -= 30 * lake * (1 - smooth(0, w * 0.95, d));   // lake basin
      floor -= 11 * (1 - smooth(0.004, 0.012, d));         // river channel

      let e = floor + (mtn - floor) * Math.pow(t, 1.35);
      e += 140 * 4 * t * (1 - t) * (nz.ridged(u * 8 + 1, v * 8 + 4, 4) - 0.45);

      // Built-up area on the east bank – the DSM includes building heights.
      const inTown = a > 0.12 && a < 0.44 && off > 0.016 && off < w * 1.4 && t < 0.3;
      if (inTown) {
        townZone[j * R + i] = 1;
        const bi = Math.floor(i / 2), bj = Math.floor(j / 2);
        const r = hash2(bi, bj);
        if (r > 0.42 && bi % 5 !== 0 && bj % 4 !== 0) {
          ground[j * R + i] = e;
          e += 5 + r * 13;
          town[j * R + i] = 1;
        }
      }
      h[j * R + i] = e;
      valley[j * R + i] = t;
    }
  }

  const flyPath = [];
  for (let k = 0; k <= 60; k++) {
    flyPath.push(centerUV(0.04 + (k / 60) * 0.92));
  }

  const data = finalize({
    heights: h, valley, town, townZone, ground, lakeLevel, seed,
    flyPath,
    profilePath: [[0.06, 0.86], [0.28, 0.66], [0.48, 0.46], [0.68, 0.3], [0.9, 0.08]],
    name: 'scene_01.tif', source: 'demo',
  });
  data.satCanvas = renderSatellite(data, satSize);
  return data;
}

/* ---------- Procedural demo scene 2: forested hills with a meandering river ---------- */
// River runs west → east; centreline northing as a function of easting.
const riverV = (u) => 0.5 + 0.16 * Math.sin(u * 6.2 + 0.3) + 0.045 * Math.sin(u * 15 + 1);
const riverDV = (u) => 0.16 * 6.2 * Math.cos(u * 6.2 + 0.3) + 0.045 * 15 * Math.cos(u * 15 + 1);
const tribU = (v) => 0.63 + 0.045 * Math.sin(v * 9 + 0.5);

export function generateForestRiver(seed = 29, satSize = 1024) {
  const nz = makeNoise(seed), nz2 = makeNoise(seed + 41);
  const h = new Float32Array(R * R);
  const valley = new Float32Array(R * R);
  const river = new Float32Array(R * R);  // perpendicular distance to the main channel
  const town = new Uint8Array(R * R);
  const townZone = new Uint8Array(R * R);
  const ground = new Float32Array(R * R); // terrain height under buildings
  const lakeLevel = 62;
  const ponds = [[0.3, 0.052, 0.024, 0.009], [0.74, -0.06, 0.02, 0.008]]; // [u, offset, ru, rv] oxbow lakes

  for (let j = 0; j < R; j++) {
    const v = j / N;
    for (let i = 0; i < R; i++) {
      const u = i / N;
      const vc = riverV(u);
      const off = (v - vc) / Math.sqrt(1 + riverDV(u) ** 2);
      const d0 = Math.abs(off);
      const w = 0.11 + 0.03 * Math.sin(u * 5.3 + 1);
      const d = d0 + 0.05 * nz2.fbm(u * 9, v * 9, 4) * smooth(0, w, d0);
      const ridge = nz.ridged(u * 3.1 + 4, v * 3.1 + 1, 6);
      const broad = 0.5 + 0.5 * nz2.fbm(u * 1.7 + 3, v * 1.7, 4);
      const m = 0.55 * ridge + 0.45 * broad;
      const hill = 100 + m * 360 + 14 * nz.fbm(u * 16, v * 16, 3);
      let t = smooth(w * 0.9, w * 3.2, d);

      let floor = 64 + 6 * u + 1.2 * nz2.fbm(u * 25, v * 25, 2);
      floor -= 10 * (1 - smooth(0.016, 0.03, d0));                   // main channel (~120–220 m wide)
      for (const [pu, po, ru, rv] of ponds) {                         // oxbow ponds
        const du = (u - pu) / ru, dv = (v - (riverV(pu) + po)) / rv;
        floor -= 7 * Math.exp(-(du * du + dv * dv) * 1.6);
      }

      // Tributary joining from the north hills
      const vcT = riverV(tribU(v));
      const dt0 = Math.abs(u - tribU(v));
      const north = smooth(vcT, vcT + 0.06, v) * (1 - smooth(0.05, 0.14, dt0));
      if (north > 0) {
        const dt = dt0 + 0.012 * nz.fbm(u * 20, v * 20, 2);
        const tt = smooth(0.006, 0.06, dt);
        t = Math.min(t, 1 - north + north * tt);
        floor += (v - vcT) * 60 * north;
        floor -= 4 * north * (1 - smooth(0.002, 0.006, dt));
      }

      let e = floor + (hill - floor) * Math.pow(t, 1.6);

      // Small riverside village on the south bank
      const inTown = u > 0.1 && u < 0.24 && off < -0.034 && off > -w * 1.1 && t < 0.3;
      if (inTown) {
        townZone[j * R + i] = 1;
        const bi = Math.floor(i / 2), bj = Math.floor(j / 2);
        const r = hash2(bi + 7, bj + 3);
        if (r > 0.55 && bi % 4 !== 0 && bj % 3 !== 0) {
          ground[j * R + i] = e;
          e += 4 + r * 7;
          town[j * R + i] = 1;
        }
      }
      h[j * R + i] = e;
      valley[j * R + i] = t;
      river[j * R + i] = d0;
    }
  }

  const flyPath = [];
  for (let k = 0; k <= 60; k++) {
    const u = 0.03 + (k / 60) * 0.94;
    flyPath.push([u, riverV(u)]);
  }

  const data = finalize({
    heights: h, valley, town, townZone, ground, lakeLevel, seed, river,
    flyPath,
    profilePath: [[0.36, 0.03], [0.38, 0.5], [0.42, 0.97]],
    name: 'scene_02.tif', source: 'forest', ve: 2.3, baseE: 0,
  });
  data.satCanvas = renderForestSatellite(data, satSize);
  return data;
}

function renderForestSatellite(d, size = 1024) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const px = img.data;
  const nz = makeNoise(17), nz2 = makeNoise(61);
  const paddy = [[118, 150, 72], [98, 138, 60], [140, 160, 88], [126, 140, 70], [84, 120, 56]];
  const roofPal = [[168, 88, 64], [150, 146, 140], [190, 180, 160], [120, 104, 96], [96, 110, 130]];

  for (let py = 0; py < size; py++) {
    const v = 1 - (py + 0.5) / size;
    for (let pxi = 0; pxi < size; pxi++) {
      const u = (pxi + 0.5) / size;
      const e = sampleGrid(d.heights, u, v);
      const t = sampleGrid(d.valley, u, v);
      const s = sampleGrid(d.slope, u, v);
      const dr = sampleGrid(d.river, u, v);
      const k = Math.round(v * N) * R + Math.round(u * N);
      const n1 = nz.fbm(u * 50, v * 50, 3);
      const crown = nz2.noise(u * 520, v * 520) * 0.6 + nz2.noise(u * 260, v * 260) * 0.4; // tree crowns
      let r, g, b;

      if (e < d.lakeLevel) {
        const depth = clamp01((d.lakeLevel - e) / 9);
        r = mix(80, 30, depth); g = mix(118, 84, depth); b = mix(112, 96, depth);
        r += n1 * 6; g += n1 * 6; b += n1 * 5;
      } else if (e < d.lakeLevel + 1.8 && dr < 0.04) {
        r = 184 + n1 * 12; g = 172 + n1 * 12; b = 140 + n1 * 10;                       // sandbars
      } else if (d.town[k]) {
        [r, g, b] = roofPal[Math.floor(hash2(Math.floor(u * N * 2), Math.floor(v * N * 2)) * roofPal.length)];
        r += crown * 8; g += crown * 8; b += crown * 8;
      } else if (d.townZone[k]) {
        const tree = hash2(Math.floor(u * N * 3), Math.floor(v * N * 3)) > 0.55;
        r = tree ? 44 : 132; g = tree ? 78 : 124; b = tree ? 38 : 104;
        r += crown * 10; g += crown * 10; b += crown * 8;
      } else if (t < 0.34 && s < 7 && nz.fbm(u * 14 + 3, v * 14, 3) < 0.18) {
        const fu = Math.floor((u + 0.008 * n1) * 90), fv = Math.floor((v + 0.008 * n1) * 70);
        [r, g, b] = paddy[Math.floor(hash2(fu, fv) * paddy.length)];                   // paddy fields
        r += n1 * 8; g += n1 * 10; b += n1 * 6;
      } else {
        // Dense broadleaf canopy with crown texture; lighter on ridges, darker in gullies.
        const tone = 0.5 + 0.5 * nz.fbm(u * 6 + 9, v * 6, 4);
        const ridge = smooth(0.55, 0.95, t) * smooth(250, 520, e);
        r = mix(26, 50, tone) + ridge * 14;
        g = mix(56, 88, tone) + ridge * 12;
        b = mix(26, 38, tone);
        const c2 = crown * 18;
        r += c2 * 0.7; g += c2; b += c2 * 0.5;
        if (nz2.fbm(u * 9 + 5, v * 9 + 2, 3) > 0.5 && s < 22) {                        // clearings
          r = mix(r, 104, 0.7); g = mix(g, 120, 0.7); b = mix(b, 64, 0.7);
        }
        const riparian = 1 - smooth(0.024, 0.05, dr);                                  // lush river banks
        r = mix(r, 34, riparian * 0.6); g = mix(g, 82, riparian * 0.6); b = mix(b, 38, riparian * 0.6);
      }
      const p = (py * size + pxi) * 4;
      px[p] = r; px[p + 1] = g; px[p + 2] = b; px[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Dirt road along the south bank, bridge at the village.
  const toPx = (u, v) => [u * size, (1 - v) * size];
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(196, 176, 140, 0.9)';
  ctx.lineWidth = size / 520;
  ctx.beginPath();
  for (let k = 0; k <= 240; k++) {
    const u = k / 240;
    const [x, y] = toPx(u, riverV(u) - 0.1 - 0.03 * Math.sin(u * 5.3 + 1));
    k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.stroke();
  ctx.lineWidth = size / 600;
  ctx.strokeStyle = 'rgba(214, 206, 188, 0.95)';
  ctx.beginPath();
  const [bx1, by1] = toPx(0.17, riverV(0.17) - 0.1);
  const [bx2, by2] = toPx(0.17, riverV(0.17) + 0.07);
  ctx.moveTo(bx1, by1); ctx.lineTo(bx2, by2); ctx.stroke();
  return c;
}

/* ---------- Scene from a user-supplied image (optional DEM) ---------- */
export function terrainFromImage(img, demImg, name) {
  const nz = makeNoise(3);
  const lum = imageLuminance(demImg || img, R, !demImg);
  const h = new Float32Array(R * R);
  if (demImg) {
    for (let k = 0; k < h.length; k++) h[k] = 200 + lum[k] * 1100;
  } else {
    // Pseudo monocular depth: smoothed brightness + ridged detail.
    let b = lum;
    for (let pass = 0; pass < 4; pass++) b = boxBlur(b, R, 4);
    for (let j = 0; j < R; j++) {
      for (let i = 0; i < R; i++) {
        const k = j * R + i, u = i / N, v = j / N;
        const base = Math.pow(b[k], 1.15);
        h[k] = 230 + base * 700 + nz.ridged(u * 4, v * 4, 6) * 380 * (0.3 + base) + lum[k] * 25;
      }
    }
  }
  let minE = Infinity, maxE = -Infinity;
  for (const e of h) { minE = Math.min(minE, e); maxE = Math.max(maxE, e); }
  const valley = new Float32Array(R * R);
  for (let k = 0; k < h.length; k++) valley[k] = (h[k] - minE) / (maxE - minE);

  const flyPath = [];
  for (let k = 0; k <= 60; k++) {
    const a = (k / 60) * Math.PI * 1.6 + 0.3;
    flyPath.push([0.5 + 0.32 * Math.cos(a), 0.5 + 0.32 * Math.sin(a)]);
  }

  const data = finalize({
    heights: h, valley, town: new Uint8Array(R * R), townZone: new Uint8Array(R * R),
    lakeLevel: minE + (maxE - minE) * 0.03, seed: 3, flyPath,
    profilePath: [[0.08, 0.2], [0.5, 0.5], [0.92, 0.78]],
    name, source: 'upload',
  });
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, 1024, 1024);
  data.satCanvas = c;
  return data;
}

function imageLuminance(img, size, waterLow = false) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, size, size);
  const px = ctx.getImageData(0, 0, size, size).data;
  const out = new Float32Array(size * size);
  // canvas row 0 is north (j = N)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = (y * size + x) * 4;
      let l = (0.299 * px[p] + 0.587 * px[p + 1] + 0.114 * px[p + 2]) / 255;
      if (waterLow) {
        // Water / flood pixels (blue-dominant) are pushed to the valley floor.
        const blue = Math.max(0, px[p + 2] - Math.max(px[p], px[p + 1])) / 255;
        l = Math.max(0, l - blue * 2.2);
      }
      out[(size - 1 - y) * size + x] = l;
    }
  }
  return out;
}

function boxBlur(src, size, r) {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let s = 0, n = 0;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        if (xx >= 0 && xx < size) { s += src[y * size + xx]; n++; }
      }
      tmp[y * size + x] = s / n;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let s = 0, n = 0;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        if (yy >= 0 && yy < size) { s += tmp[yy * size + x]; n++; }
      }
      out[y * size + x] = s / n;
    }
  }
  return out;
}

/* ---------- Derived rasters: slope, uncertainty, stats ---------- */
function finalize(d) {
  const { heights: h } = d;
  const cell = EXTENT / N;
  const slope = new Float32Array(R * R);
  const unc = new Float32Array(R * R);
  const nz = makeNoise(d.seed + 7);
  let minE = Infinity, maxE = -Infinity;
  for (let j = 0; j < R; j++) {
    for (let i = 0; i < R; i++) {
      const k = j * R + i;
      const e = h[k];
      minE = Math.min(minE, e); maxE = Math.max(maxE, e);
      const hl = h[j * R + Math.max(i - 1, 0)], hr = h[j * R + Math.min(i + 1, N)];
      const hd = h[Math.max(j - 1, 0) * R + i], hu = h[Math.min(j + 1, N) * R + i];
      const gx = (hr - hl) / (2 * cell), gy = (hu - hd) / (2 * cell);
      const s = (Math.atan(Math.hypot(gx, gy)) * 180) / Math.PI;
      slope[k] = s;
      const u = i / N, v = j / N;
      unc[k] = clamp01(0.08 + 0.62 * smooth(5, 45, s) + 0.28 * (0.5 + 0.5 * nz.fbm(u * 9, v * 9, 3)) + (d.town[k] ? 0.25 : 0));
    }
  }
  return { ...d, slope, unc, minE, maxE, N, R, extent: EXTENT, gsd: 0.6 };
}

/* ---------- Synthetic Sentinel/Maxar-style RGB for the demo scene ---------- */
export function renderSatellite(d, size = 1024) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const px = img.data;
  const nz = makeNoise(5);
  const fieldPal = [[98, 122, 62], [126, 138, 78], [150, 136, 96], [84, 112, 58], [168, 158, 108], [110, 130, 70]];
  const roofPal = [[172, 96, 72], [150, 150, 150], [196, 186, 168], [124, 112, 102], [206, 196, 176], [140, 80, 60]];

  for (let py = 0; py < size; py++) {
    const v = 1 - (py + 0.5) / size;
    for (let pxi = 0; pxi < size; pxi++) {
      const u = (pxi + 0.5) / size;
      const e = sampleGrid(d.heights, u, v);
      const t = sampleGrid(d.valley, u, v);
      const s = sampleGrid(d.slope, u, v);
      const ci = Math.round(u * N), cj = Math.round(v * N);
      const k = cj * R + ci;
      const n1 = nz.fbm(u * 60, v * 60, 3);
      const n2 = nz.noise(u * 380, v * 380);
      let r, g, b;

      if (e < d.lakeLevel) {
        const depth = clamp01((d.lakeLevel - e) / 22);
        r = mix(52, 16, depth); g = mix(88, 42, depth); b = mix(96, 62, depth);
        r += n1 * 4; g += n1 * 5; b += n1 * 6;
      } else if (d.town[k]) {
        const pal = roofPal[Math.floor(hash2(Math.floor(u * N * 2), Math.floor(v * N * 2)) * roofPal.length)];
        [r, g, b] = pal;
        r += n2 * 10; g += n2 * 10; b += n2 * 10;
      } else if (d.townZone[k]) {
        r = 138 + n2 * 14; g = 130 + n2 * 14; b = 116 + n2 * 12;
        if (hash2(Math.floor(u * N * 3), Math.floor(v * N * 3)) > 0.7) { r -= 40; g -= 20; b -= 38; } // trees in gardens
      } else if (t < 0.3 && s < 9) {
        const fu = Math.floor((u + 0.012 * n1) * 64), fv = Math.floor((v + 0.01 * n1) * 48);
        const pal = fieldPal[Math.floor(hash2(fu, fv) * fieldPal.length)];
        [r, g, b] = pal;
        r += n2 * 8 + n1 * 10; g += n2 * 8 + n1 * 10; b += n2 * 6;
      } else {
        const rock = Math.max(smooth(40, 62, s + n1 * 8), smooth(1080, 1260, e));
        const meadow = smooth(0.25, 0.5, t) * (1 - smooth(0.6, 0.9, t)) * 0.4;
        let fr = 38 + n1 * 16, fg = 64 + n1 * 20, fb = 32 + n1 * 10;
        fr = mix(fr, 96, meadow); fg = mix(fg, 116, meadow); fb = mix(fb, 62, meadow);
        const rr = 122 + n2 * 22, rg = 112 + n2 * 20, rb = 98 + n2 * 18;
        r = mix(fr, rr, rock); g = mix(fg, rg, rock); b = mix(fb, rb, rock);
        const snow = smooth(1235, 1320, e + n1 * 30) * (1 - smooth(38, 55, s));
        r = mix(r, 236, snow); g = mix(g, 240, snow); b = mix(b, 246, snow);
      }
      const p = (py * size + pxi) * 4;
      px[p] = r; px[p + 1] = g; px[p + 2] = b; px[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  if (d.source === 'demo') {
    // Valley road + bridges
    const toPx = (u, v) => [u * size, (1 - v) * size];
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(222, 212, 192, 0.92)';
    ctx.lineWidth = size / 420;
    ctx.beginPath();
    for (let k = 0; k <= 200; k++) {
      const a = k / 200;
      const lake = Math.exp(-Math.pow((a - 0.62) / 0.14, 2));
      const [x, y] = toPx(...fromValley(a, wiggle(a) + 0.028 + 0.09 * lake));
      k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
    ctx.lineWidth = size / 700;
    ctx.strokeStyle = 'rgba(210, 200, 180, 0.75)';
    for (const a of [0.18, 0.3, 0.4]) {
      ctx.beginPath();
      const [x1, y1] = toPx(...fromValley(a, wiggle(a) - 0.08));
      const [x2, y2] = toPx(...fromValley(a, wiggle(a) + 0.03));
      ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
  }
  return c;
}
