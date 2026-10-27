import './style.css';
import { refreshIcons } from './icons.js';
import { generateTerrain, generateForestRiver, terrainFromImage } from './terrainData.js';
import { Viewer, fmt } from './viewer.js';
import { ProfileChart, ScatterChart } from './charts.js';
import { Pipeline, landCover } from './pipeline.js';
import { Hazards } from './hazards.js';
import { JourneyMap } from './journey.js';

refreshIcons();

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
let data = null;
const nowTime = () => new Date().toLocaleTimeString('en-GB');

/* ------------------------------ routing ------------------------------ */
const PAGES = { ingest: 'Ingest', processing: 'Processing', viewer: '3D Viewer', journey: 'Journey' };
let userCollapsed = false;

function route() {
  const page = PAGES[location.hash.slice(1)] ? location.hash.slice(1) : 'ingest';
  for (const id of Object.keys(PAGES)) $(`#page-${id}`).hidden = id !== page;
  $$('.sb-item[data-page]').forEach((a) => {
    const on = a.dataset.page === page;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  $('#crumbPage').textContent = PAGES[page];
  document.body.classList.toggle('on-viewer', page === 'viewer');
  syncJourney(page === 'journey');
  // The 3D viewer wants every pixel: collapse the sidebar to an icon rail there.
  $('#shell').classList.toggle('collapsed', userCollapsed || page === 'viewer' || page === 'journey');
  if (page !== 'viewer' && viewer.fly) viewer.stopFly();
}
let journey = null;
function syncJourney(on) {
  if (!on) return journey?.stop();
  if (!journey) {
    const status = $('#journeyStatus');
    journey = new JourneyMap($('#journeyHost'), $('#journeyLabels'), {
      onStatus: (msg, err) => { status.textContent = msg; status.hidden = !msg; status.classList.toggle('err', !!err); },
    });
  }
  journey.start();
}
window.addEventListener('hashchange', route);
function go(page) {
  if (location.hash !== `#${page}`) history.pushState(null, '', `#${page}`);
  route();
}

$('#sbCollapse').addEventListener('click', () => {
  userCollapsed = !$('#shell').classList.contains('collapsed');
  $('#shell').classList.toggle('collapsed', userCollapsed);
  $('#sbCollapse').setAttribute('aria-label', userCollapsed ? 'Expand sidebar' : 'Collapse sidebar');
});
$('#sbSearch').addEventListener('click', () => toast('Scene search is not part of this demo'));

/* ------------------------------ clock + status ------------------------------ */
function tickClock() {
  const d = new Date();
  $('#clock').textContent = `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}  ${d.toLocaleTimeString('en-GB')}`;
}
tickClock();
setInterval(tickClock, 1000);

function setPipeState(state, name) {
  const led = state === 'running' ? 'busy' : state === 'done' ? '' : 'idle';
  const label = state === 'running' ? 'Running' : state === 'done' ? 'Completed' : 'Idle';
  $('#stPipe').innerHTML = `<i class="led ${led}"></i>${label}`;
  $('#sbProcBadge').hidden = state !== 'running';
  if (name) $('#stScene').textContent = name;
  $('#stUpdate').textContent = nowTime();
}

/* ------------------------------ recent scenes ------------------------------ */
const makeScene = (kind, seed, satSize) =>
  kind === 'forest' ? generateForestRiver(seed, satSize) : generateTerrain(seed, satSize);

const SCENES = [
  { name: 'scene_01.tif', sensor: 'Cartosat-3 MX', area: 'Upper Beas valley', date: '14 Sep 2026', size: '287.4 MB', status: 'Ready', seed: 11, color: '#3ddc97' },
  { name: 'scene_02.tif', sensor: 'Cartosat-3 MX', area: 'Barak valley forest', date: '09 Sep 2026', size: '264.1 MB', status: 'Ready', seed: 29, kind: 'forest', color: '#22c55e' },
  { name: 'kedarnath_ms_0826.tif', sensor: 'Cartosat-3 MX', area: 'Mandakini basin', date: '26 Aug 2026', size: '412.9 MB', status: 'Ready', seed: 23, color: '#5aa9ff' },
  { name: 'wayanad_s2_0730.tif', sensor: 'Sentinel-2 MSI', area: 'Chooralmala slopes', date: '30 Jul 2026', size: '198.2 MB', status: 'Ready', seed: 37, color: '#f5b544' },
  { name: 'teesta_liss4_0612.tif', sensor: 'Resourcesat-2 LISS-IV', area: 'Teesta corridor', date: '12 Jun 2026', size: '356.0 MB', status: 'Archived', seed: 51, color: '#c084fc' },
];
const thumbs = {};
function sceneThumb(sc) {
  const key = `${sc.kind || 'valley'}-${sc.seed}`;
  if (!thumbs[key]) thumbs[key] = thumbURL(makeScene(sc.kind, sc.seed, 136).satCanvas, 104);
  return thumbs[key];
}
function renderScenes() {
  $('#sceneCount').textContent = `${SCENES.length} scenes`;
  $('#sceneTable').innerHTML = SCENES.map((sc, i) => `
    <tr>
      <td><div class="scene-cell"><span class="scene-thumb" style="background-image:url(${sceneThumb(sc)})"></span>${sc.name}</div></td>
      <td>${sc.sensor}</td><td>${sc.area}</td><td>${sc.date}</td><td>${sc.size}</td>
      <td><span class="tag ${sc.status === 'Ready' ? '' : 'tag-muted'}">${sc.status}</span></td>
      <td><button type="button" class="btn btn-secondary" data-scene="${i}">Open<i data-lucide="arrow-right"></i></button></td>
    </tr>`).join('');
  $$('[data-thumb]').forEach((el) => {
    el.style.backgroundImage = `url(${sceneThumb(el.dataset.thumb === 'forest' ? SCENES[1] : SCENES[0])})`;
  });
  $('#sbScenes').innerHTML = SCENES.slice(0, 4).map((sc, i) => `
    <button type="button" class="sb-item sb-scene" data-scene="${i}" title="${sc.name}"><i class="dot" style="background:${sc.color}"></i><span>${sc.name}</span></button>`).join('');
  refreshIcons();
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-scene]');
  if (!b) return;
  const sc = SCENES[Number(b.dataset.scene)];
  const d = makeScene(sc.kind, sc.seed);
  d.name = sc.name;
  go('viewer');
  loadScene(d);
});

/* ------------------------------ toast ------------------------------ */

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/* ------------------------------ charts ------------------------------ */
const profile = new ProfileChart($('#profile'), { onHover: (i) => viewer.profileCursor(i) });
const scatter = new ScatterChart($('#scatter'));
profile.draw();

/* ------------------------------ viewer ------------------------------ */
const viewer = new Viewer($('#canvasHost'), {
  onHover(hit) {
    if (!hit) return;
    $('#roE').textContent = `${fmt(hit.E)} m`;
    $('#roN').textContent = `${fmt(hit.N)} m`;
    $('#roZ').textContent = `${hit.Z.toFixed(1)} m`;
  },
  onCamera(az) {
    $('#needle').style.transform = `rotate(${az}rad)`;
  },
  onProfile(samples, fromUser) {
    profile.setData(samples);
    const es = samples.map((s) => s.e);
    let gain = 0;
    for (let i = 1; i < es.length; i++) gain += Math.max(0, es[i] - es[i - 1]);
    $('#profileStats').innerHTML = `
      <span>Length<b>${fmt(samples[samples.length - 1].d)} m</b></span>
      <span>Min<b>${Math.min(...es).toFixed(0)} m</b></span>
      <span>Max<b>${Math.max(...es).toFixed(0)} m</b></span>
      <span>Gain<b>+${fmt(gain)} m</b></span>`;
    if (fromUser) setProfileMode('p2p');
  },
  onProbe(hit) {
    toast(`Height ${hit.Z.toFixed(1)} m at E ${fmt(hit.E)}, N ${fmt(hit.N)}`);
  },
  onDistance(r) {
    toast(`Horizontal ${fmt(r.horiz)} m · surface ${fmt(r.surface)} m`);
  },
  onReady() {
    $('#readout').hidden = false;
  },
});

/* ------------------------------ pipeline ------------------------------ */
const SAMPLES = {
  valley: {
    id: 'valley', name: 'scene_01.tif', size: '287.4 MB',
    // SW corner of the 3.6 km tile, Upper Beas valley (Himachal Pradesh)
    origin: [32.2140, 77.1580], rot: -7,
    meta: { sensor: 'Cartosat-3 MX', crs: 'EPSG:32643 · UTM 43N', acquired: '14 Sep 2026 · 05:31 UTC', sun: '52.4°', path: '0118 / 0046', cloud: '1.5 %', look: '+4.2° across-track' },
  },
  forest: {
    id: 'forest', name: 'scene_02.tif', size: '264.1 MB',
    // Barak valley (Assam)
    origin: [24.8120, 92.7340], rot: 6,
    meta: { sensor: 'Cartosat-3 MX', crs: 'EPSG:32646 · UTM 46N', acquired: '09 Sep 2026 · 04:12 UTC', sun: '58.9°', path: '0231 / 0059', cloud: '3.8 %', look: '−2.7° across-track' },
  },
};

const pipeline = new Pipeline({
  onSelect: (file) => showFile(file),
  buildData(img, dem, name, sampleId) {
    if (img) return terrainFromImage(img, dem, name);
    const d = sampleId === 'forest' ? generateForestRiver() : generateTerrain();
    d.name = name;
    return d;
  },
  onStart() {
    go('processing');
  },
  onState: setPipeState,
  onComplete(d) {
    go('viewer');
    if (d !== data) loadScene(d);
  },
});

/* ------------------------------ sample scene menu ------------------------------ */
const menuBtn = $('#useSample'), menu = $('#sampleMenu');
const menuItems = () => [...menu.querySelectorAll('.menu-item')];
function setMenu(open, focusFirst = false) {
  menu.hidden = !open;
  menuBtn.setAttribute('aria-expanded', String(open));
  if (open && focusFirst) menuItems()[0].focus();
}
menuBtn.addEventListener('click', () => setMenu(menu.hidden));
menuBtn.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); setMenu(true, true); }
});
menu.addEventListener('keydown', (e) => {
  const items = menuItems(), i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  if (e.key === 'Escape') { setMenu(false); menuBtn.focus(); }
});
menu.addEventListener('click', (e) => {
  const item = e.target.closest('[data-sample]');
  if (!item) return;
  setMenu(false);
  showSample(item.dataset.sample);
});

/* ------------------------------ input scene preview ------------------------------ */
// What "Process scene" will run on: a sample id, or an uploaded File.
let selected = { sample: 'valley', file: null };
const sampleCache = {};
const sampleData = (id) => (sampleCache[id] ||= id === 'forest' ? generateForestRiver() : generateTerrain());

// Render a scene like a raw L1 product: slight haze, rotated swath footprint with no-data corners.
function drawProduct(src, rot) {
  const c = $('#pvCanvas'), ctx = c.getContext('2d');
  const S = c.width;
  ctx.fillStyle = '#050506';
  ctx.fillRect(0, 0, S, S);
  ctx.save();
  ctx.translate(S / 2, S / 2);
  ctx.rotate((rot * Math.PI) / 180);
  const k = 1.18; // swath is larger than the tile; the tile sits inside it
  ctx.filter = 'contrast(0.9) saturate(0.88) brightness(1.04)';
  ctx.drawImage(src, (-S * k) / 2, (-S * k) / 2, S * k, S * k);
  ctx.filter = 'none';
  ctx.fillStyle = 'rgba(170, 185, 205, 0.07)'; // atmospheric haze
  ctx.fillRect((-S * k) / 2, (-S * k) / 2, S * k, S * k);
  ctx.restore();
  // Mask to the rotated swath so the corners read as no-data.
  ctx.save();
  ctx.globalCompositeOperation = 'destination-in';
  ctx.translate(S / 2, S / 2);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.fillRect((-S * 0.49), (-S * 0.49), S * 0.98, S * 0.98);
  ctx.restore();
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = '#050506';
  ctx.fillRect(0, 0, S, S);
  ctx.globalCompositeOperation = 'source-over';
  // Tile footprint the DSM will be generated for
  ctx.strokeStyle = 'rgba(61, 220, 151, 0.9)';
  ctx.lineWidth = 2;
  ctx.setLineDash([10, 8]);
  ctx.strokeRect(S * (0.5 - 0.5 / k), S * (0.5 - 0.5 / k), S / k, S / k);
  ctx.setLineDash([]);
  const cv = $('#pvCanvas');
  cv.classList.remove('swap');
  void cv.offsetWidth;
  cv.classList.add('swap');
}

const DEG_LAT = 3600 / 111320; // tile extent in degrees
function drawGraticule(origin) {
  const [lat0, lon0] = origin;
  const dLon = 3600 / (111320 * Math.cos((lat0 * Math.PI) / 180));
  const step = 0.01;
  const k = 1.18, pad = 500 - 500 / k;
  let out = '';
  // Graticule covers the tile footprint (the swath is drawn larger around it)
  for (let lon = Math.ceil(lon0 / step) * step; lon < lon0 + dLon; lon += step) {
    const x = pad + ((lon - lon0) / dLon) * (1000 / k);
    out += `<line x1="${x}" y1="0" x2="${x}" y2="1000"/><text x="${x + 6}" y="24">${lon.toFixed(2)}°E</text>`;
  }
  for (let lat = Math.ceil(lat0 / step) * step; lat < lat0 + DEG_LAT; lat += step) {
    const y = 1000 - pad - ((lat - lat0) / DEG_LAT) * (1000 / k);
    out += `<line x1="0" y1="${y}" x2="1000" y2="${y}"/><text x="${1000 - 8}" y="${y - 6}" text-anchor="end">${lat.toFixed(2)}°N</text>`;
  }
  $('#pvGrid').innerHTML = out;
}

function setPreviewMeta(rows) {
  $('#pvMeta').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd title="${v}">${v}</dd></div>`).join('');
}

function showSample(id) {
  const s = SAMPLES[id];
  selected = { sample: id, file: null };
  drawProduct(sampleData(id).satCanvas, s.rot);
  drawGraticule(s.origin);
  $('#pvGrid').hidden = false;
  $('#pvName').textContent = s.name;
  $('#pvLevel').textContent = 'L1 · Radiometrically corrected';
  $('#pvSub').textContent = `${s.meta.sensor} · 4 bands · 6000 × 6000 px · ${s.size}`;
  $('#pvChip').textContent = `${s.meta.sensor} · Natural colour (B3 B2 B1)`;
  setPreviewMeta([
    ['Acquired', s.meta.acquired], ['Path / Row', s.meta.path], ['Cloud cover', s.meta.cloud], ['View angle', s.meta.look],
  ]);
  pvGeo = { origin: s.origin, rot: s.rot };
}

async function showFile(file) {
  const img = new Image();
  img.src = URL.createObjectURL(file);
  try { await img.decode(); } catch { toast('Preview not available for this format · it will still be processed'); }
  selected = { sample: null, file };
  if (img.naturalWidth) drawProduct(img, 0);
  $('#pvGrid').hidden = true;
  $('#pvName').textContent = file.name;
  $('#pvLevel').textContent = 'User upload';
  $('#pvSub').textContent = `${img.naturalWidth ? `${img.naturalWidth} × ${img.naturalHeight} px · ` : ''}${(file.size / 1e6).toFixed(1)} MB`;
  $('#pvChip').textContent = 'Uploaded image · RGB';
  setPreviewMeta([['Format', file.type || 'GeoTIFF'], ['Georeference', 'Not detected'], ['Bands', '3 (RGB)'], ['Status', 'Ready to process']]);
  pvGeo = null;
}

let pvGeo = null;
$('#dropzone').addEventListener('pointermove', (e) => {
  const cv = $('#pvCanvas').getBoundingClientRect();
  const x = (e.clientX - cv.left) / cv.width, y = (e.clientY - cv.top) / cv.height;
  const cur = $('#pvCursor');
  const inside = x >= 0 && x <= 1 && y >= 0 && y <= 1;
  cur.hidden = !inside;
  if (!inside) return;
  const st = $('#pvStage').getBoundingClientRect();
  cur.style.left = `${e.clientX - st.left}px`;
  cur.style.top = `${e.clientY - st.top}px`;
  if (!pvGeo) { $('#pvCoord').textContent = `px ${Math.round(x * 6000)}, ${Math.round(y * 6000)}`; return; }
  const k = 1.18;
  const u = (x - 0.5) * k + 0.5, v = 1 - ((y - 0.5) * k + 0.5);
  const [lat0, lon0] = pvGeo.origin;
  const dLon = 3600 / (111320 * Math.cos((lat0 * Math.PI) / 180));
  $('#pvCoord').textContent = `${(lat0 + v * DEG_LAT).toFixed(5)}°N  ${(lon0 + u * dLon).toFixed(5)}°E`;
});
$('#dropzone').addEventListener('pointerleave', () => {
  $('#pvCursor').hidden = true;
  $('#pvCoord').textContent = 'Hover to read coordinates';
});
$('#pvReplace').addEventListener('click', () => $('#fileInput').click());
$('#processBtn').addEventListener('click', () => {
  if (selected.file) pipeline.start(selected.file, $('#demInput').files[0]);
  else pipeline.start(null, $('#demInput').files[0], SAMPLES[selected.sample]);
});
// Scale bar: 1 km of the 3.6 km tile, at the drawn scale.
function sizeScaleBar() {
  const w = $('#pvCanvas').getBoundingClientRect().width;
  $('.pv-scale i').style.width = `${(w / 1.18) * (1000 / 3600)}px`;
}
new ResizeObserver(sizeScaleBar).observe($('#pvCanvas'));
document.addEventListener('click', (e) => {
  if (!menu.hidden && !e.target.closest('.menu-wrap')) setMenu(false);
});

function loadScene(d) {
  data = d;
  $('#empty').classList.add('hide');
  $('#viewport').classList.add('loaded');
  viewer.load(d);
  const scene = $('#crumbScene');
  scene.hidden = false;
  scene.textContent = d.name;
  $('#stScene').textContent = d.name;
  $('#stUpdate').textContent = nowTime();
  $('#infoGsd').textContent = `${d.gsd} m`;
  $('#infoExtent').textContent = `${(d.extent / 1000).toFixed(1)} × ${(d.extent / 1000).toFixed(1)} km`;
  $('#infoElev').textContent = `${Math.round(d.minE)} – ${Math.round(d.maxE)} m`;
  ['#btnValidate', '#btnExport', '#floodPlay', '#floodRange'].forEach((s) => ($(s).disabled = false));
  $('#swSat').style.backgroundImage = `url(${thumbURL(d.satCanvas)})`;

  resetValidation();
  $('#floodRange').value = 0;
  hazards.init(d);
  setHazardMode(hzMode);
  setProfileMode('along');
  viewer.showProfile(d.profilePath);
  updateLegend();
  renderLandCover(d);
}

function renderLandCover(d) {
  const classes = landCover(d).sort((a, b) => b.pct - a.pct);
  const ul = $('#landCover');
  ul.innerHTML = classes.map((c) => `
    <li><i style="background:rgb(${c.color})"></i><span>${c.name}</span><b>${c.pct.toFixed(1)}%</b>
      <span class="track"><span class="fill" style="width:0;background:rgb(${c.color})" data-w="${c.pct}"></span></span></li>`).join('');
  requestAnimationFrame(() => ul.querySelectorAll('.fill').forEach((f) => (f.style.width = `${f.dataset.w}%`)));
}

function thumbURL(src, size = 72) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  c.getContext('2d').drawImage(src, 0, 0, size, size);
  return c.toDataURL();
}

// Generic switches (processing options) just toggle their state.
$$('.switch:not([data-layer])').forEach((sw) => {
  sw.addEventListener('click', () => sw.setAttribute('aria-checked', String(sw.getAttribute('aria-checked') !== 'true')));
});

/* ------------------------------ layers ------------------------------ */
const layerState = { satellite: false, dsm: true, slope: false, uncertainty: false, contours: false };
$$('.switch[data-layer]').forEach((sw) => {
  sw.addEventListener('click', () => setLayer(sw.dataset.layer, sw.getAttribute('aria-checked') !== 'true'));
});
function setLayer(name, on) {
  layerState[name] = on;
  $(`.switch[data-layer="${name}"]`).setAttribute('aria-checked', String(on));
  viewer.setLayer(name, on);
  updateLegend();
}
$('#vtLayers').addEventListener('click', () => setLayer('satellite', !layerState.satellite));

function updateLegend() {
  if (!data) return;
  const lg = $('#legend');
  lg.hidden = false;
  const flood = Number($('#floodRange').value);
  let title, min, max, bar;
  if (hzMode === 'rain') {
    title = 'Rainfall runoff';
    min = 'wet'; max = 'runoff';
    bar = 'linear-gradient(90deg, #2f3a44, #3f79b8, #6fb6ff)';
  } else if (hzMode === 'fire') {
    title = 'Wildfire';
    min = 'burnt'; max = 'active';
    bar = 'linear-gradient(90deg, #151311, #4a2a18, #ff4a10, #ffd24a)';
  } else if (hzMode === 'landslide') {
    title = 'Landslide susceptibility';
    min = 'low'; max = 'very high';
    bar = 'linear-gradient(90deg, #29a05c, #f9d138, #ec3829)';
  } else if (flood > 0) {
    title = 'Flood depth';
    min = '0 m'; max = `${Math.ceil(flood + 11)} m`;
    bar = 'linear-gradient(90deg, #52a8ff, #0f42b8)';
  } else if (layerState.uncertainty) {
    title = 'Height uncertainty (1σ)';
    min = '0 m'; max = '2 m';
    bar = 'linear-gradient(90deg, #221a73, #cc408c, #fad94c)';
  } else if (layerState.slope) {
    title = 'Slope';
    min = '0°'; max = '60°';
    bar = 'linear-gradient(90deg, #1a8c59, #f2d940, #e6382e)';
  } else {
    title = layerState.satellite ? 'Elevation · satellite drape' : 'Elevation (DSM)';
    min = `${Math.round(data.minE)} m`; max = `${Math.round(data.maxE)} m`;
    bar = 'linear-gradient(90deg, #121c28, #56687c, #eef2f6)';
  }
  $('#legendTitle').textContent = title;
  $('#legendMin').textContent = min;
  $('#legendMax').textContent = max;
  $('#legendBar').style.background = bar;
}

/* ------------------------------ navigation ------------------------------ */
function setNav(mode) {
  $$('.nav-item').forEach((b) => {
    const on = b.dataset.nav === mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
}
$$('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!data) return toast('Load a scene first');
    const mode = btn.dataset.nav;
    if (mode === 'rotate' && btn.classList.contains('active')) {
      viewer.setAutoRotate(false);
      return setNav('orbit');
    }
    viewer.stopFly();
    viewer.setAutoRotate(false);
    setNav(mode);
    if (mode === 'fly') viewer.startFlythrough(() => setNav('orbit'));
    if (mode === 'top') viewer.view('top');
    if (mode === 'rotate') viewer.setAutoRotate(true);
    if (mode === 'orbit') viewer.view('home');
  });
});

/* ------------------------------ tools ------------------------------ */
const HINTS = {
  probe: 'Click the terrain to probe height',
  distance: 'Click two points to measure distance',
  profile: 'Click two points to draw a profile',
};
function setTool(tool) {
  $$('.tool-item[data-tool]').forEach((b) => {
    const on = b.dataset.tool === tool;
    b.classList.toggle('active', on);
    if (b.dataset.tool !== 'clear') b.setAttribute('aria-pressed', String(on));
  });
  viewer.setTool(tool);
  const hint = $('#hint');
  hint.hidden = !tool;
  hint.textContent = tool ? `${tool === 'hazard' ? HZ[hzMode].place : HINTS[tool]} · Esc to cancel` : '';
  if (tool !== 'hazard') $('#hzPlace')?.setAttribute('aria-pressed', 'false');
}
$$('.tool-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!data) return toast('Load a scene first');
    const tool = btn.dataset.tool;
    if (tool === 'clear') {
      viewer.clearAnnotations();
      setTool(null);
      setProfileMode('along');
      viewer.showProfile(data.profilePath);
      return;
    }
    setTool(viewer.tool === tool ? null : tool);
  });
});
window.addEventListener('keydown', (e) => {
  if (!document.body.classList.contains('on-viewer') || !data) return;
  if (e.target.closest('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'Escape' && viewer.tool) setTool(null);
  const key = { h: 'probe', d: 'distance', p: 'profile' }[e.key.toLowerCase()];
  if (key) setTool(viewer.tool === key ? null : key);
});

function setProfileMode(mode) {
  $('#profAlong').classList.toggle('active', mode === 'along');
  $('#profAlong').setAttribute('aria-pressed', String(mode === 'along'));
  $('#profP2P').classList.toggle('active', mode === 'p2p');
  $('#profP2P').setAttribute('aria-pressed', String(mode === 'p2p'));
}
$('#profAlong').addEventListener('click', () => {
  if (!data) return;
  setProfileMode('along');
  viewer.showProfile(data.profilePath);
});
$('#profP2P').addEventListener('click', () => {
  if (!data) return;
  setProfileMode('p2p');
  setTool('profile');
});

/* ------------------------------ view toolbar ------------------------------ */
$('#vtHome').addEventListener('click', () => { setNav('orbit'); viewer.view('home'); });
$('#vtIn').addEventListener('click', () => viewer.zoom(0.7));
$('#vtOut').addEventListener('click', () => viewer.zoom(1.4));
$('#vtFull').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('#viewport').requestFullscreen();
});

/* ------------------------------ hazards ------------------------------ */
const HZ = {
  flood: { name: 'Flood', desc: 'Water-level rise', icon: 'waves', cls: '' },
  rain: { name: 'Localized rainfall', desc: 'Storm cell · runoff routing', icon: 'cloud-rain', cls: 'hz-rain', place: 'Click the terrain to centre the storm cell' },
  fire: { name: 'Wildfire', desc: 'Fuel · wind · slope spread', icon: 'flame', cls: 'hz-fire', place: 'Click the terrain to set the ignition point' },
  landslide: { name: 'Landslide', desc: 'Susceptibility · debris runout', icon: 'mountain', cls: 'hz-slide', place: 'Click a slope to set the failure source' },
};
let hzMode = 'flood';

function setTiles(tiles) {
  $('#hzStats').innerHTML = tiles.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
}
function setHzTag(text, cls = 'tag-muted') {
  const tag = $('#hzTag');
  tag.className = `tag ${cls}`;
  tag.textContent = text;
}

const hazards = new Hazards(viewer, (s) => {
  if (s.mode !== hzMode || s.mode === 'flood') return;
  $('#hzBig').textContent = s.big;
  $('#hzBigLabel').textContent = s.bigLabel;
  setTiles(s.tiles);
  const running = s.state === 'running';
  const label = { idle: 'Ready', running: 'Running', paused: 'Paused', done: 'Complete' }[s.state];
  setHzTag(label, running ? (s.mode === 'fire' ? 'tag-fire' : 'tag-warn') : s.state === 'done' ? '' : 'tag-muted');
  const play = $('#hzPlay');
  const verb = s.mode === 'landslide' ? 'Trigger' : 'Start';
  const next = running ? ['pause', 'Pause'] : s.state === 'paused' ? ['play', 'Resume'] : s.state === 'done' ? ['rotate-ccw', 'Run again'] : ['play', verb];
  if (play.dataset.state !== next[1]) {
    play.dataset.state = next[1];
    play.innerHTML = `<i data-lucide="${next[0]}"></i><span>${next[1]}</span>`;
    refreshIcons();
  }
  if (s.mode === 'rain') $('#hzStats').children[2].querySelector('b').textContent = `+${viewer.floodOffset.toFixed(1)} m`;
  if (running && s.mode === 'rain') updateLegend();
});

function setHazardMode(mode) {
  hzMode = mode;
  const m = HZ[mode];
  $('#hzName').textContent = m.name;
  $('#hzDesc').textContent = m.desc;
  $('#hzIco').className = `hz-ico ${m.cls}`;
  $('#hzIco').innerHTML = `<i data-lucide="${m.icon}"></i>`;
  $$('.hz-ctrl').forEach((el) => (el.hidden = el.dataset.for !== mode));
  $('#hzActions').hidden = mode === 'flood';
  if (floodAnim) { cancelAnimationFrame(floodAnim); floodAnim = null; }
  if (viewer.tool === 'hazard') setTool(null);
  $('#hzPlace').setAttribute('aria-pressed', 'false');
  $('#floodRange').value = 0;
  if (data) hazards.setMode(mode);
  if (mode === 'flood') setFlood(0);
  refreshIcons();
  updateLegend();
}

// Hazard type dropdown
const hzBtn = $('#hzBtn'), hzMenu = $('#hzMenu');
const hzItems = () => [...hzMenu.querySelectorAll('.menu-item')];
function setHzMenu(open, focus = false) {
  hzMenu.hidden = !open;
  hzBtn.setAttribute('aria-expanded', String(open));
  if (open && focus) (hzItems().find((b) => b.dataset.hz === hzMode) || hzItems()[0]).focus();
}
hzBtn.addEventListener('click', () => setHzMenu(hzMenu.hidden, true));
hzMenu.addEventListener('keydown', (e) => {
  const items = hzItems(), i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  if (e.key === 'Escape') { setHzMenu(false); hzBtn.focus(); }
});
hzMenu.addEventListener('click', (e) => {
  const item = e.target.closest('[data-hz]');
  if (!item) return;
  setHzMenu(false);
  hzBtn.focus();
  if (!data) return toast('Load a scene first');
  setHazardMode(item.dataset.hz);
});
document.addEventListener('click', (e) => {
  if (!hzMenu.hidden && !e.target.closest('.hz-picker')) setHzMenu(false);
});

viewer.cb.onHazardPick = (hit) => {
  hazards.setTarget(hit.u, hit.v);
  setTool(null);
  updateLegend();
  toast(`${HZ[hzMode].name} placed at E ${fmt(hit.E)}, N ${fmt(hit.N)} · press ${hzMode === 'landslide' ? 'Trigger' : 'Start'}`);
};

// Shared actions
$('#hzPlay').addEventListener('click', () => {
  if (!data) return;
  if (viewer.tool === 'hazard') { setTool(null); $('#hzPlace').setAttribute('aria-pressed', 'false'); }
  hazards.toggle();
  updateLegend();
});
$('#hzReset').addEventListener('click', () => {
  if (!data) return;
  hazards.reset();
  updateLegend();
});
$('#hzPlace').addEventListener('click', () => {
  if (!data) return;
  const on = viewer.tool !== 'hazard';
  setTool(on ? 'hazard' : null);
  $('#hzPlace').setAttribute('aria-pressed', String(on));
});

// Rain parameters
$('#rainI').addEventListener('input', (e) => {
  $('#rainIVal').textContent = `${e.target.value} mm/h`;
  hazards.setParam('rain', 'intensity', Number(e.target.value));
});
$('#rainR').addEventListener('input', (e) => {
  $('#rainRVal').textContent = `${e.target.value} m`;
  hazards.setParam('rain', 'radius', Number(e.target.value));
});
// Fire parameters
$('#windGrid').addEventListener('click', (e) => {
  const b = e.target.closest('[data-w]');
  if (!b) return;
  $$('#windGrid [data-w]').forEach((x) => {
    x.classList.toggle('on', x === b);
    x.setAttribute('aria-checked', String(x === b));
  });
  hazards.setParam('fire', 'windFrom', b.dataset.w);
});
$$('#windGrid [data-w]').forEach((x) => {
  x.setAttribute('role', 'radio');
  x.setAttribute('aria-checked', String(x.classList.contains('on')));
});
$('#windS').addEventListener('input', (e) => {
  $('#windSVal').textContent = `${e.target.value} km/h`;
  hazards.setParam('fire', 'windSpeed', Number(e.target.value));
});

/* ------------------------------ flood ------------------------------ */
function setFlood(v) {
  viewer.setFlood(v);
  if (hzMode !== 'flood') return;
  $('#hzBig').textContent = `+${v.toFixed(1)} m`;
  $('#hzBigLabel').textContent = 'water-level rise';
  if (!data) return;
  const s = viewer.floodStats(v);
  setTiles([
    ['Inundated', `${s.areaKm2.toFixed(2)} km²`],
    ['Max depth', `${s.maxDepth.toFixed(1)} m`],
    ['Structures', fmt(s.structures)],
  ]);
  if (v > 0) setHzTag(s.structures > 0 ? 'Structures at risk' : 'Simulating', 'tag-warn');
  else setHzTag('Idle');
  updateLegend();
}
$('#floodRange').addEventListener('input', (e) => setFlood(Number(e.target.value)));
let floodAnim = null;
$('#floodPlay').addEventListener('click', () => {
  if (floodAnim) { cancelAnimationFrame(floodAnim); floodAnim = null; return; }
  const range = $('#floodRange');
  const from = Number(range.value) >= 13.9 ? 0 : Number(range.value);
  const to = 14, dur = 7000 * ((to - from) / to), t0 = performance.now();
  const step = () => {
    const t = Math.min(1, (performance.now() - t0) / dur);
    const v = from + (to - from) * t;
    range.value = v;
    setFlood(v);
    floodAnim = t < 1 ? requestAnimationFrame(step) : null;
  };
  step();
});

/* ------------------------------ validation ------------------------------ */
function resetValidation() {
  ['#mRmse', '#mMae', '#mR'].forEach((s) => ($(s).textContent = '—'));
  $('#valTag').className = 'tag tag-muted';
  $('#valTag').textContent = 'Not run';
  scatter.setPoints([], [data.minE, data.maxE], 1);
}

function gauss() {
  return Math.sqrt(-2 * Math.log(Math.random() + 1e-9)) * Math.cos(2 * Math.PI * Math.random());
}

$('#btnValidate').addEventListener('click', () => {
  if (!data) return;
  const btn = $('#btnValidate');
  btn.disabled = true;
  $('#valTag').className = 'tag tag-warn';
  $('#valTag').textContent = 'Running';
  toast('Validating DSM against Copernicus GLO-30 · 800 check points…');
  const pts = [];
  for (let n = 0; n < 800; n++) {
    const k = Math.floor(Math.random() * data.heights.length);
    const ref = data.heights[k];
    const pred = ref + gauss() * (1.1 + 1.6 * data.unc[k]);
    pts.push([ref, pred]);
  }
  let se = 0, ae = 0, mx = 0, my = 0;
  for (const [a, p] of pts) { se += (a - p) ** 2; ae += Math.abs(a - p); mx += a; my += p; }
  mx /= pts.length; my /= pts.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [a, p] of pts) { sxy += (a - mx) * (p - my); sxx += (a - mx) ** 2; syy += (p - my) ** 2; }
  const rmse = Math.sqrt(se / pts.length), mae = ae / pts.length, r = sxy / Math.sqrt(sxx * syy);
  const absErr = pts.map(([a, p]) => Math.abs(a - p)).sort((x, y) => x - y);
  const le90 = absErr[Math.floor(0.9 * (absErr.length - 1))];

  const lo = Math.floor(data.minE / 100) * 100, hi = Math.ceil(data.maxE / 100) * 100;
  scatter.setPoints(pts, [lo, hi], 1800);
  countUp('#mRmse', rmse, 2, ' m');
  countUp('#mMae', mae, 2, ' m');
  countUp('#mR', le90, 2, ' m');
  setTimeout(() => {
    btn.disabled = false;
    $('#valTag').className = 'tag';
    $('#valTag').textContent = '800 pts · passed';
    $('#stUpdate').textContent = nowTime();
    toast(`Validation complete · RMSE ${rmse.toFixed(2)} m · LE90 ${le90.toFixed(2)} m · 800 check points`);
  }, 1900);
});

function countUp(sel, value, digits, unit) {
  const el = $(sel), t0 = performance.now(), dur = 1600;
  const step = () => {
    const t = Math.min(1, (performance.now() - t0) / dur);
    const k = 1 - Math.pow(1 - t, 3);
    el.textContent = `${(value * k).toFixed(digits)}${unit}`;
    if (t < 1) requestAnimationFrame(step);
  };
  step();
}

/* ------------------------------ export ------------------------------ */
$('#btnExport').addEventListener('click', () => {
  if (!data) return;
  const a = document.createElement('a');
  a.href = viewer.snapshot();
  a.download = `${data.name.replace(/\.[^.]+$/, '')}_3d_view.png`;
  a.click();
  toast('Exported 3D view as PNG');
});

/* ------------------------------ collapsibles ------------------------------ */
$$('.collapsible > .panel-head').forEach((h) => {
  h.addEventListener('click', () => h.setAttribute('aria-expanded', String(h.getAttribute('aria-expanded') !== 'true')));
});

/* ------------------------------ boot ------------------------------ */
route();
// Thumbnails for the recent-scenes list are generated after first paint.
setTimeout(() => {
  showSample('valley');
  renderScenes();
}, 30);

// Shortcut: ?demo jumps straight to the viewer with the sample scene.
// ?demo=forest loads the forest river basin instead.
const demo = new URLSearchParams(location.search).get('demo');
if (demo !== null) {
  go('viewer');
  loadScene(demo === 'forest' ? generateForestRiver() : generateTerrain());
}
if (import.meta.env.DEV) window.__tv = { viewer, hazards, get data() { return data; } };
