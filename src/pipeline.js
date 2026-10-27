import { sampleGrid } from './terrainData.js';

const T = 360; // stage output size (also used for the enlarged view)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function thumb(src) {
  const c = document.createElement('canvas');
  c.width = c.height = T;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (src) ctx.drawImage(src, 0, 0, T, T);
  return { c, ctx };
}

function pixels(ctx) {
  return ctx.getImageData(0, 0, T, T);
}

function lumOf(d, p) {
  return 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
}

function percentile(values, q) {
  const s = Float32Array.from(values).sort();
  return s[Math.floor(q * (s.length - 1))];
}

/* ------------------ processing stages (all client-side) ------------------ */
function stageRaw(data) {
  // Simulate a hazy, low-contrast L1 product.
  const { c, ctx } = thumb(data.satCanvas);
  const img = pixels(ctx);
  const d = img.data;
  for (let p = 0; p < d.length; p += 4) {
    d[p] = d[p] * 0.62 + 70;
    d[p + 1] = d[p + 1] * 0.62 + 74;
    d[p + 2] = d[p + 2] * 0.62 + 88;
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: c, meta: '4 bands · 12-bit · L1C' };
}

function stageRadiometric(data) {
  // Haze removed: the corrected product is the clean surface-reflectance composite.
  const { c } = thumb(data.satCanvas);
  return { canvas: c, meta: 'DOS haze removal · 2–98% stretch' };
}

function stageMask(data) {
  const { c, ctx } = thumb(data.satCanvas);
  const img = pixels(ctx);
  const d = img.data;
  const lum = [];
  for (let p = 0; p < d.length; p += 4) lum.push(lumOf(d, p));
  const lo = percentile(lum, 0.07), hi = percentile(lum, 0.985);
  let shadow = 0, cloud = 0;
  for (let p = 0, i = 0; p < d.length; p += 4, i++) {
    const g = lum[i] * 0.55;
    if (lum[i] < lo) { d[p] = 40; d[p + 1] = 200; d[p + 2] = 230; shadow++; }
    else if (lum[i] > hi) { d[p] = 255; d[p + 1] = 90; d[p + 2] = 170; cloud++; }
    else { d[p] = d[p + 1] = d[p + 2] = g; }
  }
  ctx.putImageData(img, 0, 0);
  const n = lum.length;
  return { canvas: c, meta: `Cloud ${((cloud / n) * 100).toFixed(1)}% · Shadow ${((shadow / n) * 100).toFixed(1)}%` };
}

function stageEdges(data) {
  const { c, ctx } = thumb(data.satCanvas);
  const img = pixels(ctx);
  const d = img.data;
  const L = new Float32Array(T * T);
  for (let i = 0; i < T * T; i++) L[i] = lumOf(d, i * 4);
  const out = ctx.createImageData(T, T);
  const o = out.data;
  for (let y = 1; y < T - 1; y++) {
    for (let x = 1; x < T - 1; x++) {
      const k = y * T + x;
      const gx = -L[k - T - 1] - 2 * L[k - 1] - L[k + T - 1] + L[k - T + 1] + 2 * L[k + 1] + L[k + T + 1];
      const gy = -L[k - T - 1] - 2 * L[k - T] - L[k - T + 1] + L[k + T - 1] + 2 * L[k + T] + L[k + T + 1];
      const m = Math.min(255, Math.hypot(gx, gy) * 1.6);
      o[k * 4] = 12 + m * 0.75;
      o[k * 4 + 1] = 22 + m * 0.88;
      o[k * 4 + 2] = 36 + m;
      o[k * 4 + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return { canvas: c, meta: 'Sobel + GLCM texture · 14 features' };
}

const CLASSES = [
  { name: 'Water', color: [47, 111, 181] },
  { name: 'Forest', color: [46, 125, 50] },
  { name: 'Cropland', color: [156, 204, 101] },
  { name: 'Built-up', color: [229, 57, 53] },
  { name: 'Bare / rock', color: [161, 136, 127] },
  { name: 'Snow', color: [236, 240, 246] },
];

export function landCover(data) {
  return stageSegmentation(data).legend;
}

function stageSegmentation(data) {
  const { c, ctx } = thumb(data.satCanvas);
  const img = pixels(ctx);
  const d = img.data;
  const counts = new Array(CLASSES.length).fill(0);
  for (let p = 0; p < d.length; p += 4) {
    const r = d[p], g = d[p + 1], b = d[p + 2];
    const l = (r + g + b) / 3;
    let k;
    if (l > 215) k = 5;
    else if (b >= r && b >= g - 6 && l < 110) k = 0;
    else if (g > r && g > b && l < 80) k = 1;
    else if (g > r - 4 && g > b + 10) k = 2;
    else if (r > g + 12 || (Math.abs(r - g) < 12 && l > 150)) k = 3;
    else k = 4;
    counts[k]++;
    [d[p], d[p + 1], d[p + 2]] = CLASSES[k].color;
  }
  ctx.putImageData(img, 0, 0);
  const total = counts.reduce((a, b) => a + b, 0);
  return {
    canvas: c,
    meta: 'U-Net · 6 classes · mIoU 0.81',
    legend: CLASSES.map((cl, i) => ({ ...cl, pct: (counts[i] / total) * 100 })).filter((x) => x.pct > 0.5),
  };
}

function terrainRamp(t) {
  const stops = [
    [0.0, [22, 60, 110]], [0.08, [40, 120, 90]], [0.3, [120, 170, 80]],
    [0.55, [220, 200, 110]], [0.78, [160, 110, 70]], [1.0, [245, 245, 250]],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, a] = stops[i - 1], [t1, b] = stops[i];
      const k = (t - t0) / (t1 - t0);
      return a.map((v, j) => v + (b[j] - v) * k);
    }
  }
  return stops[stops.length - 1][1];
}

function hillshadeAt(data, u, v) {
  const e = 1 / data.N;
  const dx = sampleGrid(data.heights, u + e, v) - sampleGrid(data.heights, u - e, v);
  const dy = sampleGrid(data.heights, u, v + e) - sampleGrid(data.heights, u, v - e);
  const cell = (2 * data.extent) / data.N;
  const nx = -dx / cell, ny = -dy / cell, nz = 1;
  const len = Math.hypot(nx, ny, nz);
  const lx = -0.6, ly = 0.55, lz = 0.58; // NW light
  return Math.max(0, (nx * lx + ny * ly + nz * lz) / len);
}

function stageDSM(data) {
  const c = document.createElement('canvas');
  c.width = c.height = T;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(T, T);
  const d = img.data;
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      const u = (x + 0.5) / T, v = 1 - (y + 0.5) / T;
      const e = sampleGrid(data.heights, u, v);
      const t = (e - data.minE) / (data.maxE - data.minE);
      const hs = 0.45 + 0.75 * hillshadeAt(data, u, v);
      const col = terrainRamp(t);
      const p = (y * T + x) * 4;
      d[p] = col[0] * hs; d[p + 1] = col[1] * hs; d[p + 2] = col[2] * hs; d[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: c, meta: `${Math.round(data.minE)}–${Math.round(data.maxE)} m · ±1.8 m RMSE` };
}

function stageMesh(data) {
  const c = document.createElement('canvas');
  c.width = c.height = T;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(T, T);
  const d = img.data;
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      const u = (x + 0.5) / T, v = 1 - (y + 0.5) / T;
      const g = 18 + 170 * Math.pow(hillshadeAt(data, u, v), 1.3);
      const p = (y * T + x) * 4;
      d[p] = g * 0.82; d[p + 1] = g * 0.9; d[p + 2] = g; d[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  ctx.strokeStyle = 'rgba(120, 180, 255, 0.28)';
  ctx.lineWidth = 0.6;
  for (let i = 0; i <= T; i += 8) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, T); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(T, i); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(0, i); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(T, i); ctx.lineTo(i, T); ctx.stroke();
  }
  const verts = data.R * data.R, tris = data.N * data.N * 2;
  return { canvas: c, meta: `${verts.toLocaleString()} verts · ${tris.toLocaleString()} tris` };
}

function stageUncertainty(data) {
  const c = document.createElement('canvas');
  c.width = c.height = T;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(T, T);
  const d = img.data;
  const stops = [[34, 26, 115], [204, 64, 140], [250, 217, 76]];
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      const u = (x + 0.5) / T, v = 1 - (y + 0.5) / T;
      const t = sampleGrid(data.unc, u, v);
      const [a, b, k] = t < 0.5 ? [stops[0], stops[1], t * 2] : [stops[1], stops[2], t * 2 - 1];
      const hs = 0.6 + 0.5 * hillshadeAt(data, u, v);
      const p = (y * T + x) * 4;
      for (let ch = 0; ch < 3; ch++) d[p + ch] = (a[ch] + (b[ch] - a[ch]) * k) * hs;
      d[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: c, meta: 'MC-dropout σ · median 0.6 m' };
}

export const STAGES = [
  {
    id: 'ingest', title: 'Ingest & metadata', short: 'Ingest', run: stageRaw,
    logs: (d) => [`Reading ${d.name}`, 'Parsed GeoTIFF tags · CRS EPSG:32643 (UTM 43N)', 'Tiling 6000×6000 px → 512 px tiles'],
  },
  {
    id: 'radiometric', title: 'Radiometric correction', short: 'Radiometric', run: stageRadiometric,
    logs: () => ['Top-of-atmosphere → surface reflectance', 'Dark-object subtraction · per-band stretch'],
  },
  {
    id: 'mask', title: 'Cloud & shadow mask', short: 'Masking', run: stageMask,
    logs: () => ['s2cloudless probability > 0.4', 'Terrain-shadow masking via solar geometry'],
  },
  {
    id: 'edges', title: 'Feature extraction', short: 'Features', run: stageEdges,
    logs: () => ['Sobel gradients · GLCM texture', 'Extracting shading & perspective cues'],
  },
  {
    id: 'seg', title: 'Land-cover segmentation', short: 'Segmentation', run: stageSegmentation,
    logs: () => ['U-Net (ResNet-34) inference on 144 tiles', 'Building / water priors for DSM refinement'],
  },
  {
    id: 'dsm', title: 'Height estimation (DSM)', short: 'DSM', run: stageDSM,
    logs: () => ['Monocular depth net → relative height', 'Anchoring to Copernicus GLO-30 · absolute DSM'],
  },
  {
    id: 'unc', title: 'Uncertainty estimation', short: 'Uncertainty', run: stageUncertainty,
    logs: () => ['Monte-Carlo dropout · 16 passes', 'Per-pixel σ raster written'],
  },
  {
    id: 'mesh', title: '3D mesh generation', short: 'Mesh', run: stageMesh,
    logs: (d) => [`Regular grid ${d.R}×${d.R} · 11.25 m posting`, 'Normals, uncertainty & slope rasters baked'],
  },
];

/* ------------------------------ page controller ------------------------------ */
const $ = (s) => document.querySelector(s);
const pad = (n) => String(n).padStart(2, '0');
const scrollBehavior = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

export class Pipeline {
  constructor({ buildData, onStart, onComplete, onState, onSelect }) {
    this.onSelect = onSelect;
    this.buildData = buildData;
    this.onStart = onStart;
    this.onComplete = onComplete;
    this.onState = onState;
    this.results = null;
    this.running = false;

    const drop = $('#dropzone');
    const input = $('#fileInput');
    const demInput = $('#demInput');
    drop.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
    });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      if (e.dataTransfer.files[0]) this.onSelect(e.dataTransfer.files[0]);
    });
    input.addEventListener('change', () => {
      if (input.files[0]) this.onSelect(input.files[0]);
      input.value = '';
    });
    demInput.addEventListener('change', () => {
      $('#demName').textContent = demInput.files[0] ? demInput.files[0].name : 'Attach reference DEM (optional, PNG)';
    });
    $('#openViewer').addEventListener('click', () => this.data && this.onComplete(this.data));

    // Lightbox for stage outputs
    const lb = $('#lightbox');
    const closeLb = () => {
      lb.classList.remove('open');
      setTimeout(() => (lb.hidden = true), 180);
      this.lbReturn?.focus();
    };
    $('#lbClose').addEventListener('click', closeLb);
    lb.addEventListener('click', (e) => { if (e.target === lb) closeLb(); });
    lb.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLb(); });
    $('#stageGrid').addEventListener('click', (e) => {
      const card = e.target.closest('.stage.done');
      if (!card) return;
      const i = Number(card.dataset.i), res = this.results[i];
      const big = document.createElement('canvas');
      big.width = big.height = res.canvas.width;
      big.getContext('2d').drawImage(res.canvas, 0, 0);
      $('#lbImg').replaceChildren(big);
      $('#lbTitle').textContent = `${pad(i + 1)} · ${STAGES[i].title}`;
      $('#lbMeta').textContent = res.meta;
      this.lbReturn = card;
      lb.hidden = false;
      requestAnimationFrame(() => lb.classList.add('open'));
      $('#lbClose').focus();
    });
  }

  async loadImage(file) {
    if (!file) return null;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
      return img;
    } catch {
      return null; // e.g. real GeoTIFF – browser can't decode, fall back to demo raster
    }
  }

  // Smoothly scroll the processing page so `el` is centred – only ever downwards.
  followStage(el) {
    const page = $('#page-processing');
    const r = el.getBoundingClientRect(), pr = page.getBoundingClientRect();
    const target = page.scrollTop + r.top - pr.top - (pr.height - r.height) / 2;
    if (target > page.scrollTop + 8) page.scrollTo({ top: target, behavior: scrollBehavior() });
  }

  async start(file, demFile, sample = { id: 'valley', name: 'scene_01.tif' }) {
    if (this.running) return;
    this.running = true;
    const name = file ? file.name : sample.name;
    const sizeMB = file ? file.size / 1e6 : 287.4;
    const [img, dem] = await Promise.all([this.loadImage(file), this.loadImage(demFile)]);
    this.onStart?.(name);
    this.onState?.('running', name);
    $('#page-processing').scrollTop = 0;

    $('#procEmpty').hidden = true;
    $('#procContent').hidden = false;
    $('#procTitle').textContent = `Processing ${name}`;
    $('#procSub').textContent = `${sizeMB.toFixed(1)} MB · ${/\.tiff?$/i.test(name) ? 'GeoTIFF' : name.split('.').pop().toUpperCase()} · job #${Math.floor(1000 + Math.random() * 9000)}`;
    const status = $('#procStatus');
    status.className = 'tag tag-warn';
    status.textContent = 'Running';
    $('#openViewer').disabled = true;

    const dims = img ? `${img.naturalWidth} × ${img.naturalHeight} px` : '6000 × 6000 px';
    const m = sample.meta || {};
    const meta = [
      ['File', name], ['Dimensions', dims], ['Bands', img ? '3 (RGB)' : '4 (B1 B2 B3 NIR)'], ['Sensor', m.sensor || 'Cartosat-3 MX'],
      ['CRS', m.crs || 'EPSG:32643 · UTM 43N'], ['GSD', '0.6 m'], ['Acquired', m.acquired || '14 Sep 2026 · 05:31 UTC'], ['Sun elevation', m.sun || '52.4°'],
    ];
    $('#sceneMeta').innerHTML = meta.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');

    const stepper = $('#stepper');
    stepper.innerHTML = STAGES.map((s) => `<li class="step" title="${s.title}"><i class="led"></i><span>${s.short}</span></li>`).join('');
    const steps = [...stepper.children];

    const grid = $('#stageGrid');
    grid.innerHTML = '';
    const cards = STAGES.map((s, i) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'stage';
      el.dataset.i = i;
      el.disabled = true;
      el.innerHTML = `
        <div class="stage-img"><div class="spinner" aria-hidden="true"></div></div>
        <div class="stage-cap">
          <div class="t"><span class="stage-num">${pad(i + 1)}</span><span>${s.title}</span></div>
          <div class="stage-meta">Queued</div>
        </div>`;
      grid.appendChild(el);
      return el;
    });

    const log = $('#procLog');
    log.innerHTML = '';
    let lines = 0;
    const addLog = (text, cls = '') => {
      const line = document.createElement('div');
      line.className = `log-line ${cls}`;
      line.innerHTML = `<span class="ts">${new Date().toLocaleTimeString('en-GB')}</span>${text}`;
      log.appendChild(line);
      log.scrollTop = log.scrollHeight;
      $('#logCount').textContent = `${++lines} lines`;
    };

    const bar = $('#procBar'), pct = $('#procPct');
    const setProgress = (p) => {
      bar.style.width = `${p}%`;
      pct.textContent = `${Math.round(p)}%`;
      $('#kTiles').textContent = `${Math.round((p / 100) * 144)} / 144`;
    };
    setProgress(0);
    const t0 = performance.now();
    clearInterval(this.timer);
    const tick = () => {
      const s = Math.floor((performance.now() - t0) / 1000);
      $('#kElapsed').textContent = `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
    };
    tick();
    this.timer = setInterval(tick, 250);

    addLog(`Upload complete · ${sizeMB.toFixed(1)} MB`, 'ok');
    await sleep(300);
    this.data = this.buildData(img, dem, name, sample.id);
    this.results = [];

    for (let i = 0; i < STAGES.length; i++) {
      const s = STAGES[i], card = cards[i];
      steps[i].classList.add('active');
      card.classList.add('active');
      card.querySelector('.stage-meta').textContent = 'Running…';
      this.followStage(card);
      $('#kStage').textContent = s.title;
      $('#kStageN').textContent = `Stage ${i + 1} of ${STAGES.length}`;
      const logs = s.logs(this.data);
      for (let k = 0; k < logs.length; k++) {
        addLog(logs[k]);
        setProgress(((i + (k + 1) / (logs.length + 1)) / STAGES.length) * 100);
        await sleep(260 + Math.random() * 220);
      }
      const res = s.run(this.data);
      this.results.push(res);
      const box = card.querySelector('.stage-img');
      box.innerHTML = '';
      res.canvas.setAttribute('aria-hidden', 'true');
      box.appendChild(res.canvas);
      if (res.legend) {
        const lg = document.createElement('div');
        lg.className = 'seg-legend';
        lg.innerHTML = res.legend
          .map((c) => `<span><i style="background:rgb(${c.color.join(',')})"></i>${c.name} ${c.pct.toFixed(0)}%</span>`)
          .join('');
        card.querySelector('.stage-cap').appendChild(lg);
      }
      card.querySelector('.stage-meta').textContent = res.meta;
      card.setAttribute('aria-label', `Enlarge ${s.title}`);
      card.disabled = false;
      card.classList.remove('active');
      card.classList.add('done');
      steps[i].classList.remove('active');
      steps[i].classList.add('done');
      setProgress(((i + 1) / STAGES.length) * 100);
      addLog(`✓ ${s.title}`, 'ok');
      await sleep(180);
    }
    clearInterval(this.timer);
    tick();
    addLog('Pipeline finished · DSM ready for 3D visualisation', 'ok');
    $('#kStage').textContent = 'Completed';
    status.className = 'tag';
    status.textContent = 'Completed';
    $('#openViewer').disabled = false;
    // Everything is done: glide back up to the summary and the "Open 3D viewer" action.
    await sleep(450);
    $('#page-processing').scrollTo({ top: 0, behavior: scrollBehavior() });
    $('#openViewer').focus({ preventScroll: true });
    this.running = false;
    this.onState?.('done', name);
  }
}
