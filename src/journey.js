import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Convoy } from './journeyVehicles.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { HorizontalTiltShiftShader } from 'three/addons/shaders/HorizontalTiltShiftShader.js';
import { VerticalTiltShiftShader } from 'three/addons/shaders/VerticalTiltShiftShader.js';

/* Journey map, styled as a paper-map diorama: Las Vegas → New York → (ship) → Rotterdam → Frankfurt.
   The map is a printed sheet; only a corridor around the route stands up as moss, rock, snow and
   forest built from real elevation (AWS Terrain Tiles). Rivers, roads, towns and hand-modelled
   landmarks sit on top, and a tilt-shift pass gives the miniature depth-of-field. Country outlines
   come from Natural Earth via world-atlas. */

// ---------------------------------------------------------------- data
const BOX = { lon0: -124, lon1: 16, lat0: 27, lat1: 58 };
const KX = Math.cos((((BOX.lat0 + BOX.lat1) / 2) * Math.PI) / 180); // 1° lon is narrower than 1° lat
const GW = 1500; // terrain grid
const GH = Math.round((GW * (BOX.lat1 - BOX.lat0)) / ((BOX.lon1 - BOX.lon0) * KX));

// Authored for a 1°-tall world unit, then scaled so props stay legible on a 140°-wide map.
const S = 5;
const EXAG = 0.24 * S; // world units per 1000 m
const LIFT = 0.05 * S; // the raised ground stands this far above the printed paper
const RADIUS_FULL = 0.7 * S; // full relief within this distance of the route
const RADIUS_FADE = 1.3 * S; // relief has faded out by here
const SEA_Y = 0;

const COUNTRIES = { 'United States of America': '#ecd29c', Netherlands: '#f0d9a6', Germany: '#e6cd96' };
const NEIGHBOR = '#e8dcbb';
const OCEAN = '#8cc3c2';
const SHALLOW = '#bfe2d9';
const PAPER = '#f1e9d4';
const ROCK = new THREE.Color('#8a7e70');

// [lat, lon, name?]  a name marks a stop with a pin; the rest shape the road
const ROUTE = [
  [36.17, -115.14, 'Las Vegas'],
  [37.1, -113.6],
  [38.57, -109.55],
  [39.55, -107.3],
  [39.74, -104.99, 'Denver'],
  [39.4, -99.0],
  [39.1, -94.58],
  [39.8, -91.4],
  [40.7, -89.6],
  [41.88, -87.63, 'Chicago'],
  [41.5, -84.5],
  [41.5, -81.7],
  [40.44, -80.0],
  [40.8, -76.9],
  [40.71, -74.0, 'New York'],
  [41.5, -68.0],
  [44.0, -50.0],
  [48.0, -30.0],
  [50.3, -12.0],
  [49.6, -5.0],
  [50.3, 0.5],
  [51.5, 2.6],
  [51.95, 4.14, 'Rotterdam'],
  [51.2, 6.8],
  [50.11, 8.68, 'Frankfurt'],
];

// the 50m country shapes have no lakes, so the big ones are cut out by hand
const LAKES = [
  [[46.6, -92.1], [47.4, -91.0], [48.0, -89.5], [48.7, -88.4], [47.9, -85.0], [46.6, -84.6], [46.5, -85.8], [46.9, -88.0], [46.8, -90.5]],
  [[41.65, -87.3], [42.5, -87.8], [43.5, -87.9], [44.5, -87.4], [45.3, -87.0], [45.9, -86.5], [45.8, -85.0], [45.0, -85.5], [44.0, -86.5], [43.0, -86.3], [42.0, -86.5]],
  [[43.0, -82.4], [44.0, -81.7], [45.2, -81.3], [45.9, -83.0], [46.0, -84.2], [45.7, -84.7], [44.9, -83.3], [44.0, -83.5], [43.6, -82.7]],
  [[41.7, -83.4], [42.0, -82.5], [42.6, -81.0], [42.9, -79.5], [42.6, -78.9], [42.2, -79.9], [41.5, -81.7], [41.4, -82.7]],
  [[43.3, -79.8], [43.8, -78.5], [44.1, -76.6], [43.5, -76.2], [43.3, -77.6], [43.2, -79.0]],
  [[36.0, -114.8], [36.2, -114.4], [36.5, -114.0], [36.3, -113.95], [36.05, -114.4]], // Lake Mead
];

const RIVERS = [
  ['Mississippi', 0.1, [[47.2, -95.2], [45.0, -93.2], [43.5, -91.2], [41.5, -90.5], [39.7, -91.4], [38.6, -90.2], [37.0, -89.2], [35.1, -90.1], [32.3, -91.0], [30.0, -91.2], [29.2, -89.3]]],
  ['Missouri', 0.07, [[48.0, -104.0], [46.8, -100.8], [44.3, -100.4], [42.5, -96.4], [41.2, -95.9], [39.1, -94.6], [38.7, -92.5], [38.7, -90.2]]],
  ['Ohio', 0.07, [[40.5, -80.1], [39.3, -81.5], [38.4, -82.6], [38.0, -85.7], [37.1, -88.1], [37.0, -89.2]]],
  ['Colorado', 0.07, [[40.4, -106.0], [39.1, -108.5], [38.5, -109.6], [37.1, -110.8], [36.1, -112.1], [36.0, -114.7], [35.2, -114.6], [33.0, -114.6], [32.0, -114.8]]],
  ['Hudson', 0.06, [[42.65, -73.75], [41.8, -73.95], [40.71, -74.02]]],
  ['St Lawrence', 0.08, [[43.5, -76.2], [44.2, -76.2], [45.0, -74.8], [45.5, -73.5], [46.8, -71.2]]],
  ['Niagara', 0.05, [[42.9, -78.9], [43.08, -79.07], [43.26, -79.05]]],
  ['Rhine', 0.07, [[47.56, 7.59], [48.58, 7.8], [49.5, 8.4], [50.0, 8.27], [50.36, 7.6], [50.94, 6.96], [51.45, 6.7], [51.85, 5.9], [51.9, 4.4]]],
  ['Main', 0.05, [[49.79, 9.93], [50.0, 9.1], [50.11, 8.68], [50.0, 8.3]]],
  ['Danube', 0.07, [[48.4, 9.9], [48.7, 11.4], [48.8, 13.4], [48.2, 15.9]]],
];

// [name, lat, lon, size 1-3]
const CITIES = [
  ['San Francisco', 37.77, -122.42, 2], ['Los Angeles', 34.05, -118.24, 3], ['Las Vegas', 36.17, -115.14, 2], ['Phoenix', 33.45, -112.07, 2],
  ['Salt Lake City', 40.76, -111.89, 2], ['Denver', 39.74, -104.99, 2], ['Dallas', 32.78, -96.8, 2], ['Houston', 29.76, -95.37, 2],
  ['Kansas City', 39.1, -94.58, 1], ['Minneapolis', 44.98, -93.27, 2], ['St Louis', 38.63, -90.2, 1], ['Chicago', 41.88, -87.63, 3],
  ['Detroit', 42.33, -83.05, 1], ['Atlanta', 33.75, -84.39, 2], ['Washington', 38.9, -77.04, 2], ['Philadelphia', 39.95, -75.17, 1],
  ['New York', 40.71, -74.0, 3], ['Boston', 42.36, -71.06, 2], ['Toronto', 43.65, -79.38, 2], ['Montreal', 45.5, -73.57, 2],
  ['Pittsburgh', 40.44, -80.0, 1], ['Cleveland', 41.5, -81.69, 1], ['Seattle', 47.6, -122.33, 1],
  ['London', 51.5, -0.12, 3], ['Paris', 48.86, 2.35, 3], ['Amsterdam', 52.37, 4.9, 2], ['Rotterdam', 51.92, 4.48, 2], ['Brussels', 50.85, 4.35, 1],
  ['Cologne', 50.94, 6.96, 2], ['Frankfurt', 50.11, 8.68, 3], ['Stuttgart', 48.78, 9.18, 1], ['Munich', 48.14, 11.58, 2], ['Berlin', 52.52, 13.4, 3],
  ['Hamburg', 53.55, 9.99, 2], ['Zurich', 47.37, 8.54, 1], ['Prague', 50.08, 14.44, 2], ['Dublin', 53.35, -6.26, 1],
];
const ROADS = [
  ['San Francisco', 'Los Angeles'], ['Los Angeles', 'Las Vegas'], ['Las Vegas', 'Salt Lake City'], ['Las Vegas', 'Phoenix'], ['Los Angeles', 'Phoenix'],
  ['Salt Lake City', 'Denver'], ['Denver', 'Kansas City'], ['Kansas City', 'St Louis'], ['St Louis', 'Chicago'], ['Kansas City', 'Dallas'],
  ['Dallas', 'Houston'], ['Minneapolis', 'Chicago'], ['Minneapolis', 'Kansas City'], ['Chicago', 'Detroit'], ['Detroit', 'Cleveland'],
  ['Cleveland', 'Pittsburgh'], ['Pittsburgh', 'Philadelphia'], ['Philadelphia', 'New York'], ['New York', 'Boston'], ['Washington', 'Philadelphia'],
  ['Atlanta', 'Washington'], ['Atlanta', 'St Louis'], ['Detroit', 'Toronto'], ['Toronto', 'Montreal'], ['Montreal', 'Boston'], ['San Francisco', 'Seattle'],
  ['Paris', 'Brussels'], ['Brussels', 'Amsterdam'], ['Amsterdam', 'Rotterdam'], ['Rotterdam', 'Cologne'], ['Brussels', 'Cologne'], ['Cologne', 'Frankfurt'],
  ['Frankfurt', 'Stuttgart'], ['Stuttgart', 'Munich'], ['Frankfurt', 'Hamburg'], ['Hamburg', 'Berlin'], ['Berlin', 'Prague'], ['Stuttgart', 'Zurich'],
  ['Munich', 'Prague'], ['Paris', 'Frankfurt'], ['Frankfurt', 'Berlin'],
];

// where landmarks stand: [lat, lon, pad radius]
const SITES = [
  [36.17, -115.14, 3.2], [36.016, -114.737, 2], [41.88, -87.63, 2.6], [40.71, -74.0, 2.6], [38.63, -90.19, 2],
  [50.94, 6.96, 2], [50.11, 8.68, 2.8], [51.93, 4.75, 2.4], [43.08, -79.07, 2], [47.68, 8.62, 1.8],
];

const LABELS = [
  ['UNITED STATES', 38.2, -100.0], ['CANADA', 52.5, -100.0], ['MEXICO', 28.2, -106.0], ['GERMANY', 51.6, 10.6],
  ['FRANCE', 47.2, 1.5], ['UNITED KINGDOM', 54.2, -2.8], ['ATLANTIC OCEAN', 38.0, -42.0],
];

const lonToX = (lon) => (lon - BOX.lon0) * KX;
const latToZ = (lat) => BOX.lat1 - lat;
const xToLon = (x) => BOX.lon0 + x / KX;
const zToLat = (z) => BOX.lat1 - z;
const W = lonToX(BOX.lon1);
const H = BOX.lat1 - BOX.lat0;

const smooth = (a, b, x) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};
const seeded = (seed) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

// hypsometric ramp for the 3D corridor (moss → rock → snow)
const RAMP = [
  [0, '#86a02f'], [300, '#93b036'], [900, '#6f8e2a'], [1500, '#7c7a52'], [1900, '#8e857a'], [2500, '#b9b2a8'], [3000, '#f6f6f4'],
].map(([m, c]) => [m, new THREE.Color(c)]);
const _c = new THREE.Color();
function ramp(m, out) {
  if (m <= RAMP[0][0]) return out.copy(RAMP[0][1]);
  for (let i = 1; i < RAMP.length; i++) {
    if (m <= RAMP[i][0]) {
      const [m0, c0] = RAMP[i - 1], [m1, c1] = RAMP[i];
      return out.copy(c0).lerp(c1, (m - m0) / (m1 - m0));
    }
  }
  return out.copy(RAMP[RAMP.length - 1][1]);
}

const hash = (x, y) => { const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return h - Math.floor(h); };
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  return (hash(xi, yi) * (1 - u) + hash(xi + 1, yi) * u) * (1 - v) + (hash(xi, yi + 1) * (1 - u) + hash(xi + 1, yi + 1) * u) * v;
}

// ---------------------------------------------------------------- elevation tiles
const TILE_Z = 5;
const tileUrl = (x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${TILE_Z}/${x}/${y}.png`;
const mercY = (lat) => (1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2;

async function loadElevation() {
  const n = 2 ** TILE_Z;
  const tx0 = Math.floor(((BOX.lon0 + 180) / 360) * n) - 1;
  const tx1 = Math.floor(((BOX.lon1 + 180) / 360) * n) + 1;
  const ty0 = Math.floor(mercY(BOX.lat1) * n) - 1;
  const ty1 = Math.floor(mercY(BOX.lat0) * n) + 1;
  const w = (tx1 - tx0 + 1) * 256, h = (ty1 - ty0 + 1) * 256;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      jobs.push(
        fetch(tileUrl(tx, ty))
          .then((r) => { if (!r.ok) throw new Error(`tile ${tx}/${ty} → HTTP ${r.status}`); return r.blob(); })
          .then(createImageBitmap)
          .then((img) => ctx.drawImage(img, (tx - tx0) * 256, (ty - ty0) * 256))
      );
    }
  }
  await Promise.all(jobs);
  const px = ctx.getImageData(0, 0, w, h).data;
  const data = new Float32Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
  return (lat, lon) => {
    const fx = Math.min(Math.max(((lon + 180) / 360) * n * 256 - tx0 * 256 - 0.5, 0), w - 1.001);
    const fy = Math.min(Math.max(mercY(lat) * n * 256 - ty0 * 256 - 0.5, 0), h - 1.001);
    const x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0, i = y0 * w + x0;
    const a = data[i], b = data[i + 1], c = data[i + w], d = data[i + w + 1];
    return a + (b - a) * ax + (c - a) * ay + (a - b - c + d) * ax * ay;
  };
}

// ---------------------------------------------------------------- country outlines (TopoJSON)
function decodeCountries(topo) {
  const { scale, translate } = topo.transform;
  const arcs = topo.arcs.map((arc) => {
    let x = 0, y = 0;
    return arc.map(([dx, dy]) => [(x += dx) * scale[0] + translate[0], (y += dy) * scale[1] + translate[1]]);
  });
  const ring = (idxs) => {
    const pts = [];
    for (const i of idxs) {
      const a = i < 0 ? arcs[~i].slice().reverse() : arcs[i];
      for (let k = pts.length ? 1 : 0; k < a.length; k++) pts.push(a[k]);
    }
    return pts;
  };
  const out = [];
  for (const g of topo.objects.countries.geometries) {
    const polys = g.type === 'Polygon' ? [g.arcs] : g.type === 'MultiPolygon' ? g.arcs : [];
    const rings = polys.map((p) => p.map(ring));
    const inside = rings.some((p) => p[0].some(([lo, la]) => lo > BOX.lon0 - 1 && lo < BOX.lon1 + 1 && la > BOX.lat0 - 1 && la < BOX.lat1 + 1));
    if (inside) out.push({ name: g.properties.name, polys: rings });
  }
  return out;
}

// ---------------------------------------------------------------- little modelling kit
const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, ...extra });
const shade = (o) => { o.traverse((m) => { if (m.isMesh) m.castShadow = m.receiveShadow = true; }); return o; };
function bx(w, h, d, c, x = 0, y = 0, z = 0, extra) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(c, extra));
  m.position.set(x, y + h / 2, z);
  return m;
}
function cyl(r0, r1, h, c, x = 0, y = 0, z = 0, seg = 14, extra) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, h, seg), mat(c, extra));
  m.position.set(x, y + h / 2, z);
  return m;
}
function cone(r, h, c, x = 0, y = 0, z = 0, seg = 14, extra) {
  const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, seg), mat(c, extra));
  m.position.set(x, y + h / 2, z);
  return m;
}
function ball(r, c, x, y, z) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), mat(c));
  m.position.set(x, y, z);
  return m;
}

// Each landmark is modelled about 1 unit tall and scaled when placed.
const GLASS = { metalness: 0.65, roughness: 0.16 };
const STEEL = { metalness: 0.9, roughness: 0.22 };
const PATINA = { metalness: 0.25, roughness: 0.5 };
const lathe = (pts, c, extra, x = 0, y = 0, z = 0, seg = 28) => {
  const m = new THREE.Mesh(new THREE.LatheGeometry(pts.map(([r, h]) => new THREE.Vector2(r, h)), seg), mat(c, extra));
  m.position.set(x, y, z);
  return m;
};
const prism = (pts, depth, c, extra) => { // gable-roof style: 2D profile extruded along +Z
  const sh = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  return new THREE.Mesh(new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: false }), mat(c, extra));
};

const LANDMARKS = {
  vegas() {
    const g = new THREE.Group();
    // Luxor: black glass pyramid with its sky beam
    const lux = cone(0.36, 0.46, '#2d3643', -0.55, 0, 0, 4, { metalness: 0.5, roughness: 0.3 }); lux.rotation.y = Math.PI / 4;
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.03, 1.4, 12, 1, true), new THREE.MeshBasicMaterial({ color: '#ffeab0', transparent: true, opacity: 0.4, depthWrite: false }));
    beam.position.set(-0.55, 1.16, 0);
    g.add(lux, cone(0.04, 0.06, '#f4d36b', -0.55, 0.46, 0, 4, { emissive: '#d9a520', emissiveIntensity: 0.8 }), beam);
    // Stratosphere
    g.add(lathe([[0.034, 0], [0.026, 0.3], [0.018, 0.72], [0, 0.72]], '#e9e5db', { roughness: 0.5 }, 0.5));
    g.add(lathe([[0, 0], [0.1, 0], [0.115, 0.018], [0.1, 0.055], [0.06, 0.085], [0.03, 0.115], [0, 0.115]], '#d7d2c4', STEEL, 0.5, 0.7), cone(0.009, 0.32, '#f0ede6', 0.5, 0.82, 0, 8, STEEL));
    // casinos with domes and gold towers
    g.add(bx(0.3, 0.2, 0.16, '#d6b25e', -0.05, 0, 0.32, { roughness: 0.4, metalness: 0.4 }), bx(0.2, 0.46, 0.14, '#b8864a', 0.22, 0, 0.34, GLASS), bx(0.26, 0.26, 0.16, '#6fae9f', -0.3, 0, 0.36, GLASS));
    g.add(lathe([[0, 0], [0.09, 0], [0.085, 0.04], [0.05, 0.085], [0, 0.1]], '#e8d9a9', { roughness: 0.4 }, -0.05, 0.2, 0.32));
    return shade(g);
  },
  hoover() {
    const g = new THREE.Group();
    const R = 0.5, a0 = Math.PI / 2 - 0.65, a1 = Math.PI / 2 + 0.65;
    const arch = (t, depth, y) => {
      const sh = new THREE.Shape();
      sh.absarc(0, 0, R, a0, a1, false);
      sh.absarc(0, 0, R - t, a1, a0, true);
      sh.closePath();
      const m = new THREE.Mesh(new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: false }), mat('#e3ded1', { roughness: 0.9 }));
      m.rotation.x = -Math.PI / 2; // depth becomes height
      m.position.set(0, y, -R * 0.5);
      return m;
    };
    g.add(arch(0.14, 0.12, 0), arch(0.06, 0.26, 0.12));
    for (const a of [-0.35, -0.12, 0.12, 0.35]) {
      const ang = Math.PI / 2 + a;
      g.add(cyl(0.028, 0.028, 0.15, '#cfc9ba', Math.cos(ang) * (R - 0.05), 0.26, -Math.sin(ang) * (R - 0.05) - R * 0.5, 12));
    }
    return shade(g);
  },
  chicago() {
    const g = new THREE.Group();
    // Willis Tower: nine bundled tubes that drop away at different heights
    const hs = [[0.62, 0.84, 1.12], [0.84, 1.0, 0.84], [1.12, 0.84, 0.62]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) g.add(bx(0.088, hs[i][j], 0.088, '#343a43', (i - 1) * 0.092, 0, (j - 1) * 0.092, GLASS));
    for (const [i, j] of [[0, 2], [2, 0]]) g.add(cyl(0.006, 0.004, 0.24, '#eeeeee', (i - 1) * 0.092, 1.12, (j - 1) * 0.092, 6));
    // John Hancock Center: tapered with a pair of masts
    const hc = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.095, 0.95, 4), mat('#2a2e35', GLASS));
    hc.rotation.y = Math.PI / 4; hc.position.set(0.42, 0.475, 0.12);
    g.add(hc, cyl(0.005, 0.004, 0.2, '#ddd', 0.4, 0.95, 0.12, 6), cyl(0.005, 0.004, 0.2, '#ddd', 0.44, 0.95, 0.12, 6));
    g.add(bx(0.14, 0.62, 0.14, '#8ea2b6', -0.42, 0, 0.1, GLASS), bx(0.16, 0.45, 0.14, '#a9b7c5', -0.2, 0, 0.36, GLASS), bx(0.12, 0.5, 0.12, '#778ca3', 0.15, 0, 0.38, GLASS));
    return shade(g);
  },
  newyork() {
    const g = new THREE.Group();
    // Empire State Building: Art Deco setbacks, mast
    const lime = '#d9d2c0';
    g.add(bx(0.3, 0.3, 0.3, lime), bx(0.24, 0.2, 0.24, lime, 0, 0.3, 0), bx(0.18, 0.15, 0.18, lime, 0, 0.5, 0), bx(0.12, 0.1, 0.12, lime, 0, 0.65, 0), bx(0.07, 0.09, 0.07, lime, 0, 0.75, 0));
    g.add(cone(0.012, 0.3, '#d8d8d8', 0, 0.84, 0, 8, STEEL));
    for (const s of [-1, 1]) g.add(bx(0.01, 0.3, 0.31, '#b8b19f', s * 0.1, 0, 0), bx(0.31, 0.3, 0.01, '#b8b19f', 0, 0, s * 0.1));
    // One World Trade Center: tapering glass shaft + spire
    const wtc = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.1, 1.1, 4), mat('#a9c3d6', GLASS));
    wtc.rotation.y = Math.PI / 4; wtc.position.set(0.5, 0.65, 0.25);
    g.add(bx(0.2, 0.1, 0.2, '#c9c9c9', 0.5, 0, 0.25), wtc, cone(0.008, 0.32, '#f2f2f2', 0.5, 1.2, 0.25, 8, STEEL));
    // midtown fill
    g.add(bx(0.15, 0.5, 0.15, '#8da2b8', -0.32, 0, 0.12, GLASS), bx(0.17, 0.36, 0.17, '#a9b7c5', -0.28, 0, -0.18, GLASS), bx(0.14, 0.44, 0.14, '#7a8fa5', 0.22, 0, 0.42, GLASS), bx(0.2, 0.26, 0.15, '#b7c2cd', 0.0, 0, 0.45, GLASS), bx(0.14, 0.58, 0.14, '#6e8296', -0.05, 0, -0.38, GLASS));
    return shade(g);
  },
  liberty() {
    const g = new THREE.Group();
    const stone = '#c6c1b2';
    // Fort Wood: eleven-pointed star base
    const star = new THREE.Shape();
    for (let i = 0; i < 22; i++) {
      const a = (i / 22) * Math.PI * 2, r = i % 2 ? 0.2 : 0.32;
      i ? star.lineTo(Math.cos(a) * r, Math.sin(a) * r) : star.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    const fort = new THREE.Mesh(new THREE.ExtrudeGeometry(star, { depth: 0.05, bevelEnabled: false }), mat('#a8a291'));
    fort.rotation.x = -Math.PI / 2;
    g.add(fort);
    g.add(bx(0.2, 0.05, 0.2, stone, 0, 0.05), bx(0.15, 0.15, 0.15, stone, 0, 0.1), bx(0.18, 0.02, 0.18, '#b4af9f', 0, 0.25), bx(0.12, 0.06, 0.12, stone, 0, 0.27));
    // robed figure, 0.33 up from the ground
    g.add(lathe([[0, 0], [0.058, 0], [0.062, 0.04], [0.052, 0.12], [0.046, 0.2], [0.04, 0.27], [0.03, 0.33], [0.02, 0.37], [0, 0.37]], '#79b6a0', PATINA, 0, 0.33));
    g.add(ball(0.025, '#79b6a0', 0, 0.72, 0));
    for (let i = 0; i < 7; i++) { // crown rays
      const a = (i / 7) * Math.PI * 1.35 - Math.PI * 0.68;
      const ray = cone(0.004, 0.04, '#79b6a0', 0, 0, 0, 5, PATINA);
      ray.position.set(Math.sin(a) * 0.026, 0.755, Math.cos(a) * 0.026 * 0.6);
      ray.rotation.set(Math.cos(a) * 0.9, 0, -Math.sin(a) * 0.9);
      g.add(ray);
    }
    const arm = cyl(0.011, 0.01, 0.3, '#79b6a0', 0.05, 0.6, 0, 10, PATINA); arm.rotation.z = -0.14;
    g.add(arm);
    g.add(cyl(0.017, 0.011, 0.03, '#f2c14e', 0.073, 0.89, 0, 10, { metalness: 0.7, roughness: 0.3 }), cone(0.014, 0.06, '#ffd45a', 0.073, 0.92, 0, 10, { emissive: '#e69a10', emissiveIntensity: 1.1 }));
    const tab = bx(0.03, 0.05, 0.01, '#79b6a0', -0.04, 0.6, 0.02, PATINA); tab.rotation.z = 0.25;
    g.add(tab);
    return shade(g);
  },
  arch() {
    const pts = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24, u = 2 * t - 1;
      pts.push(new THREE.Vector3(u * 0.32, 0.64 * Math.pow(1 - u * u, 0.78), 0));
    }
    const m = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 60, 0.02, 10), mat('#d9dce0', STEEL));
    return shade(new THREE.Group().add(m));
  },
  windmill() {
    const g = new THREE.Group();
    g.add(lathe([[0.13, 0], [0.12, 0.06], [0.095, 0.4], [0.07, 0.56], [0, 0.56]], '#efe8d6', { roughness: 0.9 }));
    g.add(cyl(0.125, 0.125, 0.014, '#6b4c33', 0, 0.2, 0, 20));
    g.add(lathe([[0.09, 0], [0.1, 0.01], [0.06, 0.08], [0, 0.13]], '#4e3322', { roughness: 1 }, 0, 0.55), bx(0.04, 0.08, 0.01, '#5b3b26', 0, 0, 0.125));
    const blades = new THREE.Group();
    blades.position.set(0, 0.47, 0.11);
    blades.add(cyl(0.012, 0.012, 0.04, '#3e2a1d', 0, -0.02, 0, 8));
    for (let i = 0; i < 4; i++) {
      const sail = new THREE.Group();
      sail.add(bx(0.012, 0.4, 0.01, '#6b4c33', 0, 0.02, 0));
      for (let k = 0; k < 6; k++) sail.add(bx(0.07, 0.006, 0.006, '#6b4c33', 0.035, 0.08 + k * 0.055, 0));
      sail.add(bx(0.07, 0.3, 0.003, '#efe6cf', 0.04, 0.08, 0, { transparent: true, opacity: 0.85 }));
      sail.add(bx(0.07, 0.006, 0.006, '#6b4c33', 0.035, 0.42, 0));
      const holder = new THREE.Group(); holder.rotation.z = (i * Math.PI) / 2; holder.add(sail); blades.add(holder);
    }
    g.add(blades);
    shade(g);
    return { group: g, blades };
  },
  cranes() {
    const g = new THREE.Group();
    for (const x of [-0.5, 0.5]) {
      g.add(bx(0.03, 0.45, 0.03, '#c43d2e', x, 0, -0.1), bx(0.03, 0.45, 0.03, '#c43d2e', x, 0, 0.1), bx(0.04, 0.03, 0.34, '#c43d2e', x, 0.44, 0), bx(0.04, 0.03, 0.5, '#c43d2e', x, 0.44, 0.2));
    }
    const cols = ['#c8452f', '#3f6fa8', '#e0883a', '#2f5d8f', '#3c8fb8', '#c9a06a'];
    for (let i = 0; i < 9; i++) g.add(bx(0.14, 0.07, 0.08, cols[i % 6], -0.4 + (i % 5) * 0.2, 0, 0.35 - Math.floor(i / 5) * 0.1), bx(0.14, 0.07, 0.08, cols[(i + 2) % 6], -0.4 + (i % 5) * 0.2, 0.07, 0.35 - Math.floor(i / 5) * 0.1));
    return shade(g);
  },
  ship() {
    const g = new THREE.Group();
    g.add(bx(1.0, 0.1, 0.24, '#1d3557'), bx(1.0, 0.025, 0.245, '#cf3b2a', 0, 0, 0), bx(0.16, 0.2, 0.2, '#efe6cf', -0.38, 0.1, 0));
    const cols = ['#c8452f', '#3f6fa8', '#e0883a', '#2f5d8f', '#3c8fb8', '#c9a06a'];
    for (let i = 0; i < 9; i++) for (let l = 0; l < 3; l++) g.add(bx(0.07, 0.05, 0.18, cols[(i * 3 + l) % 6], -0.2 + i * 0.075, 0.1 + l * 0.05, 0));
    return shade(g);
  },
  frankfurt() {
    const g = new THREE.Group();
    // Commerzbank Tower: triangular plan + mast
    const cb = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 1.15, 3), mat('#b3c8d8', GLASS));
    cb.rotation.y = Math.PI / 6; cb.position.set(0, 0.575, 0);
    g.add(cb, cyl(0.007, 0.004, 0.22, '#e6e6e6', 0, 1.15, 0, 6));
    // Messeturm: square shaft under a pink-granite pyramid
    g.add(bx(0.13, 0.88, 0.13, '#c9a79a', 0.32, 0, 0.0, GLASS), cone(0.1, 0.17, '#c98a76', 0.32, 0.88, 0, 4, { roughness: 0.4 }));
    g.add(bx(0.11, 0.8, 0.11, '#7aa4c4', -0.3, 0, 0.05, GLASS), bx(0.12, 0.6, 0.12, '#9fb8c9', 0.1, 0, 0.34, GLASS), bx(0.12, 0.7, 0.12, '#a6bccb', -0.12, 0, -0.32, GLASS), bx(0.16, 0.34, 0.14, '#c7d6e0', 0.45, 0, 0.34, GLASS));
    // old-town gables at the foot
    for (let i = 0; i < 5; i++) {
      const h = new THREE.Group();
      const roof = prism([[-0.055, 0], [0, 0.055], [0.055, 0]], 0.09, '#a24a35');
      roof.position.set(0, 0.07, -0.045);
      h.add(bx(0.1, 0.07, 0.09, ['#efe3c8', '#e4cfa8', '#d9c4a0'][i % 3], 0, 0, 0), roof);
      h.position.set(-0.35 + i * 0.16, 0, 0.55);
      g.add(h);
    }
    return shade(g);
  },
  cologne() {
    const g = new THREE.Group();
    const stone = '#615c53';
    g.add(bx(0.15, 0.2, 0.6, stone, 0, 0, 0.05), bx(0.46, 0.17, 0.12, stone, 0, 0, 0.1));
    const roof = prism([[-0.085, 0], [0, 0.1], [0.085, 0]], 0.6, '#4d4943'); roof.position.set(0, 0.2, -0.25);
    const roof2 = prism([[-0.075, 0], [0, 0.085], [0.075, 0]], 0.46, '#4d4943'); roof2.rotation.y = Math.PI / 2; roof2.position.set(-0.23, 0.17, 0.1);
    g.add(roof, roof2);
    for (const x of [-0.055, 0.055]) { // twin west towers + openwork spires
      g.add(bx(0.085, 0.52, 0.085, stone, x, 0, -0.34), cone(0.06, 0.4, '#58544c', x, 0.52, -0.34, 4), cone(0.012, 0.07, '#58544c', x, 0.92, -0.34, 4));
      for (const [cx, cz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) g.add(cone(0.008, 0.08, stone, x + cx * 0.045, 0.52, -0.34 + cz * 0.045, 4));
    }
    g.add(cone(0.022, 0.26, '#58544c', 0, 0.28, 0.02, 4));
    return shade(g);
  },
};

// white curtain of water with streaks that scroll downward
function fallsTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 256;
  const x = c.getContext('2d');
  const r = seeded(5);
  x.fillStyle = '#d9f1f5'; x.fillRect(0, 0, 64, 256);
  for (let i = 0; i < 60; i++) {
    x.fillStyle = `rgba(255,255,255,${0.4 + r() * 0.6})`;
    x.fillRect(r() * 64, r() * 256, 1 + r() * 3, 30 + r() * 90);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------- the view
export class JourneyMap {
  constructor(host, labelHost, { onStatus } = {}) {
    this.host = host;
    this.labelHost = labelHost;
    this.onStatus = onStatus || (() => {});
    this.running = false;
    this.labels = [];
    this.anim = []; // per-frame callbacks (windmill, waterfalls)
    this.last = performance.now();

    this.renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    host.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#6f5239');
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.5, 600);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = THREE.MathUtils.degToRad(76);
    this.controls.screenSpacePanning = false;

    // soft studio reflections so glass and steel catch light
    this.scene.environment = new THREE.PMREMGenerator(this.renderer).fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.3;
    this.scene.add(new THREE.HemisphereLight(0xfff1dc, 0x8a6a4c, 0.75));
    const sun = new THREE.DirectionalLight(0xffd9a8, 3.2); // warm low sun from the front-left
    const mid = new THREE.Vector3(W / 2, 0, H / 2);
    sun.position.copy(mid).add(new THREE.Vector3(-30, 60, 55));
    sun.target.position.copy(mid);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    Object.assign(sun.shadow.camera, { left: -78, right: 78, top: 40, bottom: -40, near: 1, far: 220 });
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.05;
    sun.shadow.radius = 3;
    this.scene.add(sun, sun.target);

    // miniature look: render to a multisampled target, then tilt-shift blur toward the top and bottom
    const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.tiltH = new ShaderPass(HorizontalTiltShiftShader);
    this.tiltV = new ShaderPass(VerticalTiltShiftShader);
    this.tiltH.uniforms.h.value = this.tiltV.uniforms.v.value = 0.0018;
    this.tiltH.uniforms.r.value = this.tiltV.uniforms.r.value = 0.5;
    this.composer.addPass(this.tiltH);
    this.composer.addPass(this.tiltV);
    this.composer.addPass(new OutputPass());

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize(true);
    this.ready = this.build().catch((e) => {
      console.error(e);
      this.onStatus(`Could not load map data: ${e.message}`, true);
    });
  }

  fitCamera() {
    const vf = THREE.MathUtils.degToRad(this.camera.fov);
    const dH = (H * 0.75) / Math.tan(vf / 2);
    const dW = (W * 0.6) / (Math.tan(vf / 2) * this.camera.aspect);
    return Math.max(dH, dW) * 1.04;
  }

  homeCamera() {
    const d = this.fitCamera();
    const tilt = THREE.MathUtils.degToRad(34); // from straight down
    const target = new THREE.Vector3(W / 2, 0, H / 2);
    this.controls.target.copy(target);
    this.camera.position.set(target.x, d * Math.cos(tilt), target.z + d * Math.sin(tilt));
    // ?focus=lat,lon,distance opens zoomed in on a spot (handy for sharing a view of one stop)
    const focus = new URLSearchParams(location.search).get('focus');
    if (focus && this.heightAt) {
      const [la, lo, dist] = focus.split(',').map(Number);
      target.set(lonToX(lo), this.heightAt(lo, la), latToZ(la));
      this.controls.target.copy(target);
      this.camera.position.set(target.x, target.y + dist * Math.cos(tilt), target.z + dist * Math.sin(tilt));
    }
    this.controls.minDistance = d * 0.015;
    this.controls.maxDistance = d * 1.5;
    this.controls.update();
  }

  resize(first) {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.composer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (first || !this.built) this.homeCamera();
  }

  async build() {
    this.onStatus('Loading borders and elevation…');
    const [topo, elev] = await Promise.all([fetch('./countries-50m.json').then((r) => r.json()), loadElevation()]);
    const countries = decodeCountries(topo);
    this.onStatus('Building terrain…');
    await new Promise((r) => setTimeout(r, 30)); // let the status paint

    // ---- route curve
    const curve = new THREE.CatmullRomCurve3(ROUTE.map(([la, lo]) => new THREE.Vector3(lonToX(lo), 0, latToZ(la))), false, 'centripetal');
    curve.arcLengthDivisions = 2000;
    this.curve = curve;
    const samples = curve.getSpacedPoints(360);

    // ---- which country owns each grid cell (0 = water)
    const owner = new Uint8Array(GW * GH);
    const names = [];
    const mask = document.createElement('canvas');
    mask.width = GW; mask.height = GH;
    const mctx = mask.getContext('2d', { willReadFrequently: true });
    const px = (lon) => ((lon - BOX.lon0) / (BOX.lon1 - BOX.lon0)) * (GW - 1);
    const py = (lat) => ((BOX.lat1 - lat) / (BOX.lat1 - BOX.lat0)) * (GH - 1);
    countries.forEach((c, ci) => {
      names.push(c.name);
      mctx.clearRect(0, 0, GW, GH);
      mctx.beginPath();
      for (const poly of c.polys) for (const r of poly) r.forEach(([lo, la], k) => (k ? mctx.lineTo(px(lo), py(la)) : mctx.moveTo(px(lo), py(la))));
      mctx.fillStyle = '#000';
      mctx.fill('evenodd');
      const a = mctx.getImageData(0, 0, GW, GH).data;
      for (let i = 0; i < owner.length; i++) if (a[i * 4 + 3] > 127) owner[i] = ci + 1;
    });
    mctx.clearRect(0, 0, GW, GH);
    mctx.beginPath();
    for (const lake of LAKES) lake.forEach(([la, lo], k) => (k ? mctx.lineTo(px(lo), py(la)) : mctx.moveTo(px(lo), py(la))));
    mctx.fill();
    const lk = mctx.getImageData(0, 0, GW, GH).data;
    for (let i = 0; i < owner.length; i++) if (lk[i * 4 + 3] > 127) owner[i] = 0;

    // ---- rivers and roads, rasterised so trees leave them clear
    const blocked = new Uint8Array(GW * GH);
    const byName = Object.fromEntries(CITIES.map(([n, la, lo]) => [n, [la, lo]]));
    mctx.clearRect(0, 0, GW, GH);
    mctx.strokeStyle = '#000';
    mctx.lineWidth = 5;
    for (const [, , pts] of RIVERS) { mctx.beginPath(); pts.forEach(([la, lo], k) => (k ? mctx.lineTo(px(lo), py(la)) : mctx.moveTo(px(lo), py(la)))); mctx.stroke(); }
    mctx.lineWidth = 4;
    for (const [a, b] of ROADS) { mctx.beginPath(); mctx.moveTo(px(byName[a][1]), py(byName[a][0])); mctx.lineTo(px(byName[b][1]), py(byName[b][0])); mctx.stroke(); }
    const bl = mctx.getImageData(0, 0, GW, GH).data;
    for (let i = 0; i < blocked.length; i++) blocked[i] = bl[i * 4 + 3] > 40 ? 1 : 0;

    // ---- distance to coast (chamfer) so shallow water hugs the shore
    const coast = new Float32Array(GW * GH);
    for (let k = 0; k < coast.length; k++) coast[k] = owner[k] ? 0 : 1e6;
    for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
      const k = j * GW + i;
      let v = coast[k];
      if (i > 0) v = Math.min(v, coast[k - 1] + 1);
      if (j > 0) {
        v = Math.min(v, coast[k - GW] + 1);
        if (i > 0) v = Math.min(v, coast[k - GW - 1] + 1.41);
        if (i < GW - 1) v = Math.min(v, coast[k - GW + 1] + 1.41);
      }
      coast[k] = v;
    }
    for (let j = GH - 1; j >= 0; j--) for (let i = GW - 1; i >= 0; i--) {
      const k = j * GW + i;
      let v = coast[k];
      if (i < GW - 1) v = Math.min(v, coast[k + 1] + 1);
      if (j < GH - 1) {
        v = Math.min(v, coast[k + GW] + 1);
        if (i < GW - 1) v = Math.min(v, coast[k + GW + 1] + 1.41);
        if (i > 0) v = Math.min(v, coast[k + GW - 1] + 1.41);
      }
      coast[k] = v;
    }

    // ---- vertex data
    const pos = new Float32Array(GW * GH * 3);
    const col = new Float32Array(GW * GH * 3);
    const heights = new Float32Array(GW * GH);
    const reliefMask = new Float32Array(GW * GH);
    const liftMask = new Float32Array(GW * GH);
    const routeDist = new Float32Array(GW * GH);
    const elevM = new Float32Array(GW * GH);
    const base = new Map([['', new THREE.Color(NEIGHBOR)]]);
    for (const [n, c] of Object.entries(COUNTRIES)) base.set(n, new THREE.Color(c));
    const ocean = new THREE.Color(OCEAN), shallow = new THREE.Color(SHALLOW);

    for (let j = 0; j < GH; j++) {
      const lat = BOX.lat1 - (j / (GH - 1)) * (BOX.lat1 - BOX.lat0);
      const z = latToZ(lat);
      for (let i = 0; i < GW; i++) {
        const k = j * GW + i;
        const lon = BOX.lon0 + (i / (GW - 1)) * (BOX.lon1 - BOX.lon0);
        const x = lonToX(lon);
        const land = owner[k] > 0;
        let d = 1e3;
        if (land) {
          let d2 = Infinity;
          for (let s = 0; s < samples.length; s++) {
            const dx = samples[s].x - x, dz = samples[s].z - z;
            const dd = dx * dx + dz * dz;
            if (dd < d2) d2 = dd;
          }
          d = Math.sqrt(d2);
        }
        routeDist[k] = d;
        const m = 1 - smooth(RADIUS_FULL, RADIUS_FADE, d);
        reliefMask[k] = m;
        // the raised ground has a fairly sharp edge so it reads as a cut-out diorama
        const lm = 1 - smooth(0.95 * S, 1.12 * S, d);
        liftMask[k] = lm;
        const meters = land && m > 0 ? Math.max(elev(lat, lon), 0) : 0;
        elevM[k] = meters;
        const y = land ? 0.004 + lm * LIFT + m * (meters / 1000) * EXAG : SEA_Y;
        heights[k] = y;
        pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;

        if (land) {
          // printed paper map: sand with faint hairline cracks
          _c.copy(base.get(names[owner[k] - 1]) || base.get(''));
          const crack = Math.abs(vnoise(i * 0.03 + 11, j * 0.03) - 0.5) < 0.01 ? 0.9 : 1;
          _c.multiplyScalar((0.95 + 0.1 * vnoise(i * 0.1, j * 0.1)) * crack);
        } else {
          _c.copy(shallow).lerp(ocean, smooth(1, 11, coast[k]));
          _c.multiplyScalar(0.96 + 0.08 * vnoise(i * 0.08, j * 0.08));
        }
        col[k * 3] = _c.r; col[k * 3 + 1] = _c.g; col[k * 3 + 2] = _c.b;
      }
    }
    // level a pad under each landmark; the coarse elevation data would otherwise bury them in hills
    const cw = W / (GW - 1), ch = H / (GH - 1);
    for (const [la, lo, R] of SITES) {
      const ci = Math.round(px(lo)), cj = Math.round(py(la));
      const ri = Math.ceil(R / cw), rj = Math.ceil(R / ch);
      let pad = Infinity;
      for (let j = Math.max(cj - rj, 0); j <= Math.min(cj + rj, GH - 1); j++) {
        for (let i = Math.max(ci - ri, 0); i <= Math.min(ci + ri, GW - 1); i++) {
          const k = j * GW + i;
          if (owner[k] && Math.hypot((i - ci) * cw, (j - cj) * ch) <= R * 0.5) pad = Math.min(pad, heights[k]);
        }
      }
      if (!isFinite(pad)) continue;
      for (let j = Math.max(cj - rj, 0); j <= Math.min(cj + rj, GH - 1); j++) {
        for (let i = Math.max(ci - ri, 0); i <= Math.min(ci + ri, GW - 1); i++) {
          const k = j * GW + i;
          if (!owner[k]) continue;
          const w = 1 - smooth(R * 0.55, R, Math.hypot((i - ci) * cw, (j - cj) * ch));
          if (w <= 0) continue;
          heights[k] = pos[k * 3 + 1] = heights[k] * (1 - w) + pad * w;
        }
      }
    }
    this.heightAt = (lon, lat) => {
      const fx = Math.min(Math.max(((lon - BOX.lon0) / (BOX.lon1 - BOX.lon0)) * (GW - 1), 0), GW - 1.001);
      const fy = Math.min(Math.max(((BOX.lat1 - lat) / (BOX.lat1 - BOX.lat0)) * (GH - 1), 0), GH - 1.001);
      const x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0, i = y0 * GW + x0;
      const a = heights[i], b = heights[i + 1], c = heights[i + GW], d = heights[i + GW + 1];
      return a + (b - a) * ax + (c - a) * ay + (a - b - c + d) * ax * ay;
    };
    this.hxz = (x, z) => this.heightAt(xToLon(x), zToLat(z));

    const index = new Uint32Array((GW - 1) * (GH - 1) * 6);
    let q = 0;
    for (let j = 0; j < GH - 1; j++) {
      for (let i = 0; i < GW - 1; i++) {
        const a = j * GW + i, b = a + 1, c = a + GW, d = c + 1;
        index[q++] = a; index[q++] = c; index[q++] = b;
        index[q++] = b; index[q++] = c; index[q++] = d;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.computeVertexNormals();

    // second pass (needs normals): moss on gentle ground, bare rock on steep faces, snow up high
    const nrm = geo.attributes.normal;
    const rock = new THREE.Color(), cur = new THREE.Color();
    for (let j = 0; j < GH; j++) {
      for (let i = 0; i < GW; i++) {
        const k = j * GW + i;
        const t = Math.max(liftMask[k], reliefMask[k] * 0.9);
        if (!owner[k] || t < 0.01) continue;
        const e = elevM[k];
        const n = vnoise(i * 0.1, j * 0.1) * 0.6 + vnoise(i * 0.4, j * 0.4) * 0.4;
        ramp(e, _c).multiplyScalar(0.8 + 0.4 * n);
        const steep = 1 - nrm.getY(k);
        const rm = smooth(0.1, 0.3, steep) * (1 - smooth(2300, 2900, e));
        rock.copy(ROCK).multiplyScalar(0.8 + 0.4 * vnoise(i * 0.3 + 5, j * 0.3));
        _c.lerp(rock, rm);
        cur.setRGB(col[k * 3], col[k * 3 + 1], col[k * 3 + 2]).lerp(_c, smooth(0, 0.3, t));
        col[k * 3] = cur.r; col[k * 3 + 1] = cur.g; col[k * 3 + 2] = cur.b;
      }
    }
    geo.attributes.color.needsUpdate = true;
    const terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }));
    terrain.castShadow = terrain.receiveShadow = true;
    this.scene.add(terrain);
    this.scene.add(this.makeSkirt(pos));
    this.addTable();

    this.onStatus('Placing rivers, roads and landmarks…');
    await new Promise((r) => setTimeout(r, 30));
    this.addBorders(countries);
    this.addRivers();
    this.addRoads();
    this.addTrees(pos, owner, elevM, reliefMask, routeDist, blocked);
    this.addCities();
    this.addRoute(curve);
    this.addLandmarks();
    this.addLabels();

    this.built = true;
    this.homeCamera();
    this.onStatus('');

    // the cargo run: truck → ship → truck, with a camera that tracks the carrier
    const stopXZ = (name) => { const r = ROUTE.find((q) => q[2] === name); return [lonToX(r[1]), latToZ(r[0])]; };
    this.convoy = new Convoy({ scene: this.scene, hxz: (x, z) => this.hxz(x, z), curve, stops: { ny: stopXZ('New York'), rot: stopXZ('Rotterdam') } });
    this.fp = new THREE.Vector3();
    this.buildControls();
    // ?skip=N fast-forwards the run by N seconds (handy for sharing or checking a later leg)
    const skip = +new URLSearchParams(location.search).get('skip') || 0;
    for (let t = 0; t < skip; t += 1 / 30) this.convoy.update(1 / 30, this.camera, 900);
    const still = new URLSearchParams(location.search).get('focus');
    if (still) this.convoy.playing = false;
    else this.follow = false; // the camera only moves when you move it or press Follow
  }

  // thin paper edge round the printed sheet
  makeSkirt(pos) {
    const edge = [];
    for (let i = 0; i < GW; i++) edge.push(i);
    for (let j = 1; j < GH; j++) edge.push(j * GW + GW - 1);
    for (let i = GW - 2; i >= 0; i--) edge.push((GH - 1) * GW + i);
    for (let j = GH - 2; j >= 0; j--) edge.push(j * GW);
    const p = [], idx = [];
    edge.forEach((k, n) => {
      p.push(pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2], pos[k * 3], -0.06 * S, pos[k * 3 + 2]);
      if (n < edge.length - 1) idx.push(n * 2, n * 2 + 1, n * 2 + 2, n * 2 + 2, n * 2 + 1, n * 2 + 3);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: PAPER, side: THREE.DoubleSide, roughness: 1 }));
  }

  // the sheet's white margin, lying on a warm brown table
  addTable() {
    const sheet = new THREE.Mesh(new THREE.BoxGeometry(W + 1.4 * S, 0.06 * S, H + 1.4 * S), new THREE.MeshStandardMaterial({ color: PAPER, roughness: 1 }));
    sheet.position.set(W / 2, -0.034 * S, H / 2);
    sheet.castShadow = sheet.receiveShadow = true;
    const table = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), new THREE.MeshStandardMaterial({ color: '#8b6a4a', roughness: 1 }));
    table.rotation.x = -Math.PI / 2;
    table.position.set(W / 2, -0.065 * S, H / 2);
    table.receiveShadow = true;
    this.scene.add(sheet, table);
  }

  addBorders(countries) {
    const v = [];
    const inBox = ([lo, la]) => lo > BOX.lon0 && lo < BOX.lon1 && la > BOX.lat0 && la < BOX.lat1;
    for (const c of countries) {
      for (const poly of c.polys) {
        for (const r of poly) {
          for (let i = 1; i < r.length; i++) {
            const a = r[i - 1], b = r[i];
            if (!inBox(a) || !inBox(b)) continue;
            const ya = this.heightAt(a[0], a[1]), yb = this.heightAt(b[0], b[1]);
            if (ya < 0.002 && yb < 0.002) continue; // coastline of the sheet, not a border
            v.push(lonToX(a[0]), ya + 0.012 * S, latToZ(a[1]), lonToX(b[0]), yb + 0.012 * S, latToZ(b[1]));
          }
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    this.scene.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x8a6f4c, transparent: true, opacity: 0.6 })));
  }

  // a ribbon laid on the terrain along lat/lon points; quads over open water are skipped
  ribbonGeo(points, width, yoff, bow = 0) {
    let pts = points.map(([la, lo]) => new THREE.Vector3(lonToX(lo), 0, latToZ(la)));
    if (bow && pts.length === 2) { // give plain city-to-city roads a gentle bend
      const [a, b] = pts, mid = a.clone().lerp(b, 0.5), dir = b.clone().sub(a), len = dir.length();
      mid.x += (-dir.z / len) * len * bow; mid.z += (dir.x / len) * len * bow;
      pts = [a, mid, b];
    }
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const n = Math.max(6, Math.ceil(curve.getLength() / 0.3));
    const line = curve.getSpacedPoints(n);
    const p = [], idx = [], ok = [];
    line.forEach((pt, i) => {
      const a = line[Math.max(i - 1, 0)], b = line[Math.min(i + 1, n)];
      const tx = b.x - a.x, tz = b.z - a.z, l = Math.hypot(tx, tz) || 1;
      const nx = -tz / l, nz = tx / l;
      const lx = pt.x + (nx * width) / 2, lz = pt.z + (nz * width) / 2, rx = pt.x - (nx * width) / 2, rz = pt.z - (nz * width) / 2;
      const yl = this.hxz(lx, lz), yr = this.hxz(rx, rz);
      p.push(lx, yl + yoff, lz, rx, yr + yoff, rz);
      ok.push(yl > 0.002 && yr > 0.002);
    });
    for (let i = 0; i < n; i++) if (ok[i] && ok[i + 1]) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 2, i * 2 + 1, i * 2 + 3);
    if (!idx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  addRivers() {
    const parts = RIVERS.map(([, w, pts]) => this.ribbonGeo(pts, w * S * 1.8, 0.03 * S)).filter(Boolean);
    const m = new THREE.Mesh(mergeGeometries(parts), new THREE.MeshStandardMaterial({ color: '#63b6cc', roughness: 0.25, metalness: 0.1, emissive: '#1c5a70', emissiveIntensity: 0.25 }));
    m.receiveShadow = true;
    this.scene.add(m);
  }

  addRoads() {
    const byName = Object.fromEntries(CITIES.map(([n, la, lo]) => [n, [la, lo]]));
    const casing = [], fill = [];
    ROADS.forEach(([a, b], i) => {
      const bow = (i % 2 ? 1 : -1) * 0.04;
      const c = this.ribbonGeo([byName[a], byName[b]], 0.09 * S, 0.034 * S, bow);
      const f = this.ribbonGeo([byName[a], byName[b]], 0.06 * S, 0.037 * S, bow);
      if (c) casing.push(c);
      if (f) fill.push(f);
    });
    const a = new THREE.Mesh(mergeGeometries(casing), new THREE.MeshStandardMaterial({ color: '#a98d5f', roughness: 1 }));
    const b = new THREE.Mesh(mergeGeometries(fill), new THREE.MeshStandardMaterial({ color: '#f7f0dc', roughness: 1 }));
    a.receiveShadow = b.receiveShadow = true;
    this.scene.add(a, b);
  }

  // towns: scattered blocks that rise toward the centre
  addCities() {
    const rnd = seeded(31);
    const stops = new Set(ROUTE.filter((r) => r[2]).map((r) => r[2]));
    const palette = ['#efe3c8', '#e8d9b9', '#d6c7a8', '#c9b79a', '#b8664a', '#f6f1e6', '#d9a98a'].map((c) => new THREE.Color(c));
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.85 }), 9000);
    mesh.castShadow = mesh.receiveShadow = true;
    const d = new THREE.Object3D();
    let n = 0;
    for (const [name, lat, lon, size] of CITIES) {
      const cx = lonToX(lon), cz = latToZ(lat);
      const count = [0, 45, 120, 240][size];
      const sigma = [0, 0.5, 0.8, 1.15][size];
      const keepOut = stops.has(name) ? 2.2 : 0;
      for (let i = 0; i < count && n < 9000; i++) {
        const ang = rnd() * Math.PI * 2, r = Math.abs(rnd() + rnd() + rnd() - 1.5) * sigma * 1.6;
        if (r < keepOut) continue;
        const x = cx + Math.cos(ang) * r, z = cz + Math.sin(ang) * r;
        const y = this.hxz(x, z);
        if (y < 0.002) continue;
        const core = Math.exp(-(r * r) / (sigma * sigma));
        const h = (0.07 + rnd() * 0.12) * (1 + core * size * 1.3);
        d.position.set(x, y - 0.005, z);
        d.scale.set(0.09 + rnd() * 0.11, h, 0.09 + rnd() * 0.11);
        d.rotation.y = rnd() * 0.6;
        d.updateMatrix();
        mesh.setMatrixAt(n, d.matrix);
        mesh.setColorAt(n, palette[Math.floor(rnd() * palette.length)]);
        n++;
      }
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    this.scene.add(mesh);
  }

  addTrees(pos, owner, elevM, reliefMask, routeDist, blocked) {
    // two stacked cones + a stub of trunk
    const lower = new THREE.ConeGeometry(0.045, 0.1, 7); lower.translate(0, 0.07, 0);
    const upper = new THREE.ConeGeometry(0.032, 0.09, 7); upper.translate(0, 0.12, 0);
    const trunk = new THREE.CylinderGeometry(0.008, 0.01, 0.03, 5); trunk.translate(0, 0.015, 0);
    const geo = mergeGeometries([lower, upper, trunk]);
    const max = 60000;
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }), max);
    mesh.castShadow = true;
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    const rnd = seeded(7);
    const pads = SITES.map(([la, lo, R]) => [lonToX(lo), latToZ(la), R * 0.85]);
    const padNear = (x, z) => pads.some(([px, pz, R]) => Math.abs(x - px) < R && Math.abs(z - pz) < R && Math.hypot(x - px, z - pz) < R);
    let n = 0;
    for (let j = 1; j < GH - 1 && n < max; j++) {
      for (let i = 1; i < GW - 1 && n < max; i++) {
        const k = j * GW + i;
        if (!owner[k] || blocked[k]) continue;
        if (padNear(pos[k * 3], pos[k * 3 + 2])) continue;
        const m = reliefMask[k], e = elevM[k];
        if (m < 0.25 || e < 40 || e > 2100 || routeDist[k] < 0.16 * S) continue;
        const density = 0.3 * smooth(40, 700, e) * (1 - smooth(1500, 2100, e)) * smooth(0.25, 0.8, m);
        if (rnd() > density) continue;
        const s = (0.55 + rnd() * 0.6) * (0.6 + 0.4 * m) * S * 0.7;
        dummy.position.set(pos[k * 3] + (rnd() - 0.5) * 0.12, pos[k * 3 + 1] - 0.006 * S, pos[k * 3 + 2] + (rnd() - 0.5) * 0.12);
        dummy.scale.set(s, s * (0.9 + rnd() * 0.6), s);
        dummy.rotation.y = rnd() * 6.28;
        dummy.updateMatrix();
        mesh.setMatrixAt(n, dummy.matrix);
        color.setHSL(0.27 + rnd() * 0.06, 0.45 + rnd() * 0.15, 0.17 + rnd() * 0.1);
        mesh.setColorAt(n, color);
        n++;
      }
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.scene.add(mesh);
  }

  // little cottages: box walls + pyramid roof
  makeHouse(wallColor, roofColor) {
    const g = new THREE.Group();
    const roof = cone(0.068, 0.05, roofColor, 0, 0.06, 0, 4);
    roof.rotation.y = Math.PI / 4;
    roof.scale.set(1.15, 1, 0.82);
    g.add(bx(0.085, 0.06, 0.06, wallColor), roof);
    return shade(g);
  }

  addHouses(curve) {
    const rnd = seeded(99);
    const styles = [['#b23a2c', '#5a2a22'], ['#c14a38', '#4a2a22'], ['#8a5a3a', '#3e2a20'], ['#d9c9a6', '#8a3b2c']];
    const N = 90;
    for (let n = 0; n < N; n++) {
      const p = curve.getPointAt((n + 0.5 + (rnd() - 0.5) * 0.6) / N);
      const ang = rnd() * Math.PI * 2, r = (0.16 + rnd() * 0.3) * S;
      const x = p.x + Math.cos(ang) * r, z = p.z + Math.sin(ang) * r;
      const y = this.hxz(x, z);
      const e = ((y - 0.004 - LIFT) / EXAG) * 1000;
      if (y < 0.01 || e > 900 || e < -5) continue; // on land, and not up on a peak
      const [w, rf] = styles[Math.floor(rnd() * styles.length)];
      const h = this.makeHouse(w, rf);
      h.position.set(x, y - 0.004 * S, z);
      h.rotation.y = rnd() * Math.PI;
      h.scale.setScalar((1.3 + rnd() * 0.6) * S * 0.8);
      this.scene.add(h);
    }
  }

  addRoute(curve) {
    // dashed path: short boxes laid along the curve, each tilted to follow the ground
    const dash = 0.24 * S, period = 0.4 * S;
    const len = curve.getLength();
    const count = Math.floor(len / period);
    const unit = new THREE.BoxGeometry(1, 1, 1);
    const dashes = new THREE.InstancedMesh(unit, new THREE.MeshStandardMaterial({ color: 0xe4572e, emissive: 0x6a1a08, roughness: 0.4 }), count + 1);
    const edges = new THREE.InstancedMesh(unit, new THREE.MeshStandardMaterial({ color: 0xfff6e6, roughness: 0.6 }), count + 1);
    dashes.castShadow = edges.castShadow = true;
    const o = new THREE.Object3D();
    const lift = (p) => new THREE.Vector3(p.x, this.hxz(p.x, p.z) + 0.045 * S, p.z);
    for (let n = 0; n <= count; n++) {
      const t0 = Math.min((n * period) / len, 1), t1 = Math.min((n * period + dash) / len, 1);
      const a0 = lift(curve.getPointAt(t0)), a1 = lift(curve.getPointAt(t1));
      o.position.copy(a0).lerp(a1, 0.5);
      o.lookAt(a1); // +Z points along the dash
      const L = a0.distanceTo(a1);
      o.scale.set(0.05 * S, 0.035 * S, L);
      o.updateMatrix();
      dashes.setMatrixAt(n, o.matrix);
      o.scale.set(0.075 * S, 0.03 * S, L + 0.03 * S);
      o.position.y -= 0.006 * S;
      o.updateMatrix();
      edges.setMatrixAt(n, o.matrix);
    }
    this.scene.add(edges, dashes);
    this.addHouses(curve);

    // stops get a name tag floating over their landmarks
    for (const [lat, lon, name] of ROUTE) {
      if (!name) continue;
      const x = lonToX(lon), z = latToZ(lat);
      this.addLabel(name, new THREE.Vector3(x, this.hxz(x, z) + 1.0 * S, z), 'city');
    }
  }

  place(obj, lat, lon, scale, rotY = 0, dx = 0, dz = 0) {
    const x = lonToX(lon) + dx, z = latToZ(lat) + dz;
    obj.position.set(x, this.hxz(x, z) - 0.004 * S, z);
    obj.scale.setScalar(scale * S);
    obj.rotation.y = rotY;
    this.scene.add(obj);
  }

  addLandmarks() {
    const L = LANDMARKS;
    const k = 0.95;
    this.place(L.vegas(), 36.17, -115.14, k, 0);
    this.place(L.hoover(), 36.016, -114.737, 0.5, 0.5);
    this.place(L.chicago(), 41.88, -87.63, k, 0);
    this.place(L.newyork(), 40.71, -74.0, k, 0);
    this.place(L.liberty(), 40.71, -74.0, 1.0, 0.6, 2.6, 1.0); // Liberty Island, out in the harbour
    this.place(L.arch(), 38.63, -90.19, 0.7, 0.3);
    this.place(L.cologne(), 50.94, 6.96, 0.6, 0.2);
    this.place(L.frankfurt(), 50.11, 8.68, k, 0);
    const wm = L.windmill();
    this.place(wm.group, 51.93, 4.75, 0.7, -0.4, 2.2, -0.6);
    this.place(L.cranes(), 51.92, 4.3, 0.5, 0.2, -3.2, 1.4);
    const ship = L.ship();
    this.place(ship, 52.1, 2.6, 0.7, 0.3);
    ship.position.y = SEA_Y + 0.01 * S;
    this.anim.push((dt) => { wm.blades.rotation.z -= dt * 0.9; });

    // Niagara: a ledge of rock with a scrolling curtain of white water and mist
    const falls = (tex) => {
      const fl = new THREE.Group();
      fl.add(bx(1.2, 0.34, 0.5, '#8f9488', 0, 0, -0.35), bx(1.2, 0.16, 0.5, '#7f857a', 0, 0, 0.55));
      const curtain = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.34), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.92 }));
      curtain.position.set(0, 0.17, -0.09);
      const pool = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.01, 24), mat('#63b6cc'));
      pool.position.set(0, 0.01, 0.3);
      fl.add(curtain, pool);
      for (let i = 0; i < 5; i++) {
        const mist = ball(0.09 + i * 0.01, '#ffffff', -0.35 + i * 0.18, 0.06, 0.02 + (i % 2) * 0.06);
        mist.material.transparent = true; mist.material.opacity = 0.55;
        fl.add(mist);
      }
      return fl;
    };
    const tex = fallsTexture();
    this.place(falls(tex), 43.08, -79.07, 0.3, 0.1);
    this.anim.push((dt) => { tex.offset.y -= dt * 0.9; });
    const tex2 = fallsTexture(); // Rhine Falls
    this.place(falls(tex2), 47.68, 8.62, 0.25, 0.4);
    this.anim.push((dt) => { tex2.offset.y -= dt * 0.9; });
  }

  addLabels() {
    for (const [name, lat, lon] of LABELS) {
      this.addLabel(name, new THREE.Vector3(lonToX(lon), Math.max(this.heightAt(lon, lat), 0) + 0.03 * S, latToZ(lat)), 'country');
    }
  }

  addLabel(text, position, kind) {
    const el = document.createElement('div');
    el.className = `j-label j-${kind}`;
    el.textContent = text;
    this.labelHost.appendChild(el);
    this.labels.push({ el, position });
  }

  updateLabels() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    const v = new THREE.Vector3();
    for (const { el, position } of this.labels) {
      v.copy(position).project(this.camera);
      const on = v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
      el.style.display = on ? '' : 'none';
      if (on) el.style.transform = `translate(-50%, -50%) translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px)`;
    }
  }

  buildControls() {
    const bar = document.createElement('div');
    bar.className = 'j-controls';
    const mk = (text, title, fn) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = text; b.title = title;
      b.addEventListener('click', fn);
      bar.appendChild(b);
      return b;
    };
    this.btnPlay = mk('❚❚', 'Pause / play', () => {
      this.convoy.playing = !this.convoy.playing;
      this.btnPlay.textContent = this.convoy.playing ? '❚❚' : '▶';
    });
    mk('↻', 'Restart the run', () => this.convoy.reset());
    this.btnFollow = mk('Follow', 'Track the vehicle', () => this.setFollow(!this.follow));
    const sel = document.createElement('select');
    sel.title = 'Playback speed';
    for (const v of ['0.5', '1', '2', '4']) sel.add(new Option(`${v}×`, v));
    sel.value = '1';
    sel.addEventListener('change', () => { this.convoy.speed = +sel.value; });
    bar.appendChild(sel);
    this.hud = document.createElement('span');
    this.hud.className = 'j-hud';
    bar.appendChild(this.hud);
    this.host.appendChild(bar);
  }

  setFollow(on) {
    this.follow = on;
    this.followT = 0;
    this.btnFollow?.classList.toggle('on', on);
    if (on) this.fp.copy(this.convoy.focus);
    else this.homeCamera();
  }

  // chase camera: eases toward the carrier and keeps the orbit offset you choose
  followCamera(dt) {
    this.fp.lerp(this.convoy.focus, 1 - Math.exp(-4.5 * dt));
    const delta = new THREE.Vector3().copy(this.fp).sub(this.controls.target);
    this.camera.position.add(delta);
    this.controls.target.copy(this.fp);
    if (this.followT < 1.6) { // first ease into a high, top-down tracking angle
      this.followT += dt;
      const tilt = THREE.MathUtils.degToRad(26), D = 12;
      const want = new THREE.Vector3(this.fp.x, this.fp.y + D * Math.cos(tilt), this.fp.z + D * Math.sin(tilt));
      this.camera.position.lerp(want, 1 - Math.exp(-2.6 * dt));
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.resize();
    this.last = performance.now();
    const loop = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      const now = performance.now(), dt = Math.min((now - this.last) / 1000, 0.1);
      this.last = now;
      for (const f of this.anim) f(dt);
      if (this.convoy) {
        this.convoy.update(dt, this.camera, this.host.clientHeight * Math.min(devicePixelRatio, 2));
        if (this.follow) this.followCamera(dt);
        this.hud.textContent = `${this.convoy.label} · ${this.convoy.speedText}`;
      }
      this.controls.update();
      this.composer.render();
      this.updateLabels();
    };
    loop();
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }
}
