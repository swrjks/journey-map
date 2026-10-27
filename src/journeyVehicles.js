import * as THREE from 'three';

/* The cargo run: a Maersk truck, then a container ship, then a second truck.
   Everything is simulated with a little physics rather than keyframed:
   - trucks accelerate and brake with limits, slow for bends and hills, and have a spring-damper
     suspension (heave / pitch / roll) driven by the terrain under each axle, braking load transfer,
     cornering lean and road bumps; the trailer is articulated and swings out through turns;
     wheels spin with true rolling speed and the front wheels steer.
   - the ship rides a sum-of-sines wave field, pitching and rolling on soft springs, with rudder-limited
     turning and a foam wake.
   - dust, exhaust smoke, wake and bow spray are particles with drag and buoyancy. */

const TS = 4.2; // truck model → world units
const SS = 5.0; // ship model → world units
const BLUE = '#42b0d5';
const NAVY = '#1d3557';
const V_TRUCK = 3.4; // cruising speed, world units per second
const V_SHIP = 4.6;
const A_MAX = 1.5, A_BRAKE = 2.2;

const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const ease = (t) => t * t * (3 - 2 * t);
const rnd = (a, b) => a + Math.random() * (b - a);

class Spring {
  constructor(k, c) { this.k = k; this.c = c; this.x = 0; this.v = 0; }
  step(target, dt) { this.v += (this.k * (target - this.x) - this.c * this.v) * dt; this.x += this.v * dt; }
}

const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.7, ...extra });
function bx(w, h, d, c, x = 0, y = 0, z = 0, extra) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(c, extra));
  m.position.set(x, y + h / 2, z);
  m.castShadow = m.receiveShadow = true;
  return m;
}
function cyl(r, h, c, x, y, z, extra, seg = 12) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), mat(c, extra));
  m.position.set(x, y + h / 2, z);
  m.castShadow = true;
  return m;
}

// ---------------------------------------------------------------- Maersk container artwork
function maerskTexture() {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 256;
  const x = c.getContext('2d');
  x.fillStyle = BLUE; x.fillRect(0, 0, 1024, 256);
  x.fillStyle = 'rgba(25,100,140,.35)';
  for (let i = 0; i < 40; i++) x.fillRect(i * 25.6 + 6, 12, 4, 232); // corrugation
  x.strokeStyle = '#2f86b5'; x.lineWidth = 10; x.strokeRect(5, 5, 1014, 246);
  // eight-pointed star in a thin square (brand mark approximation)
  x.strokeStyle = '#fff'; x.lineWidth = 6; x.strokeRect(34, 56, 150, 150);
  x.fillStyle = '#fff'; x.beginPath();
  for (let k = 0; k < 16; k++) {
    const a = (k * Math.PI) / 8 - Math.PI / 2, r = k % 2 ? 14 : (k % 4 ? 58 : 66);
    x.lineTo(109 + r * Math.cos(a), 131 + r * Math.sin(a));
  }
  x.fill();
  x.font = 'bold 150px Arial, Helvetica, sans-serif';
  x.textBaseline = 'middle'; x.textAlign = 'left';
  x.fillText('MAERSK', 250, 136, 700);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
function hullTexture() {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 128;
  const x = c.getContext('2d');
  x.font = 'bold 100px Arial, Helvetica, sans-serif';
  x.fillStyle = '#12263a'; x.textBaseline = 'middle'; x.textAlign = 'center';
  x.fillText('MAERSK', 512, 66, 900);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makeContainer(tex) {
  const side = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, metalness: 0.15 });
  const plain = mat('#3aa0c6', { roughness: 0.55 });
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.22, 0.8), [side, side, plain, plain, plain, plain]);
  m.castShadow = m.receiveShadow = true;
  return m;
}

// ---------------------------------------------------------------- models
function wheel(r, w) {
  const g = new THREE.Group();
  const tire = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 18), mat('#17181b', { roughness: 0.95 }));
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.55, r * 0.55, w * 1.04, 14), mat('#aeb4bb', { metalness: 0.8, roughness: 0.3 }));
  const nut = new THREE.Mesh(new THREE.BoxGeometry(w * 1.1, r * 0.18, r * 0.18), mat('#6b7078'));
  for (const m of [tire, hub, nut]) { m.rotation.z = m === nut ? 0 : Math.PI / 2; m.castShadow = true; g.add(m); }
  return g;
}

function buildTruck(tex) {
  const root = new THREE.Group(); // cab: position + yaw/pitch/roll
  const model = new THREE.Group(); model.scale.setScalar(TS); root.add(model);
  const glass = { metalness: 0.6, roughness: 0.12 };
  model.add(bx(0.12, 0.03, 0.55, '#25282e', 0, 0.07, -0.12));
  model.add(bx(0.17, 0.2, 0.2, '#f3f5f7', 0, 0.1, 0.04, { roughness: 0.4 }), bx(0.15, 0.04, 0.17, '#e6eaee', 0, 0.3, 0.0), bx(0.172, 0.035, 0.202, BLUE, 0, 0.15, 0.04));
  const ws = bx(0.15, 0.09, 0.012, '#16202c', 0, 0.185, 0.143, glass); ws.rotation.x = -0.25;
  model.add(ws, bx(0.005, 0.075, 0.1, '#16202c', 0.086, 0.17, 0.04, glass), bx(0.005, 0.075, 0.1, '#16202c', -0.086, 0.17, 0.04, glass));
  model.add(bx(0.16, 0.09, 0.014, '#2c2f35', 0, 0.075, 0.147), bx(0.17, 0.025, 0.02, '#bfc4ca', 0, 0.045, 0.155, { metalness: 0.7, roughness: 0.3 }));
  for (const s of [-1, 1]) {
    model.add(bx(0.03, 0.02, 0.01, '#fff7d6', s * 0.06, 0.1, 0.152, { emissive: '#fff2b0', emissiveIntensity: 1.6 }));
    model.add(bx(0.01, 0.05, 0.02, '#222', s * 0.1, 0.2, 0.12));
    model.add(cyl(0.008, 0.22, '#d5d9de', s * 0.092, 0.12, -0.07, { metalness: 0.9, roughness: 0.25 }));
    model.add(bx(0.04, 0.05, 0.14, '#b9bec4', s * 0.085, 0.045, -0.12, { metalness: 0.8, roughness: 0.35 }));
  }
  model.add(bx(0.11, 0.015, 0.1, '#1a1c20', 0, 0.1, -0.12));
  const wheels = { front: [], drive: [] };
  for (const s of [-1, 1]) {
    const f = wheel(0.05, 0.035); f.position.set(s * 0.085, 0.05, 0.1); model.add(f); wheels.front.push(f);
    for (const z of [-0.18, -0.3]) { const d = wheel(0.05, 0.04); d.position.set(s * 0.085, 0.05, z); model.add(d); wheels.drive.push(d); }
  }

  const trailer = new THREE.Group(); // pivots on the kingpin
  const tModel = new THREE.Group(); tModel.scale.setScalar(TS); trailer.add(tModel);
  tModel.add(bx(0.14, 0.03, 0.74, '#25282e', 0, 0.07, -0.38), bx(0.17, 0.02, 0.01, '#bbb', 0, 0.07, -0.77));
  for (const s of [-1, 1]) tModel.add(bx(0.01, 0.05, 0.01, '#555', s * 0.05, 0.02, -0.15));
  const tWheels = [];
  for (const z of [-0.5, -0.6, -0.7]) for (const s of [-1, 1]) { const w = wheel(0.05, 0.04); w.position.set(s * 0.085, 0.05, z); tModel.add(w); tWheels.push(w); }
  const slot = new THREE.Object3D(); slot.position.set(0, 0.21, -0.35); tModel.add(slot); // where the container sits
  return { root, model, wheels, trailer, tWheels, slot, smoke: [[0.092, 0.34, -0.07], [-0.092, 0.34, -0.07]] };
}

function buildShip(tex) {
  const root = new THREE.Group();
  const model = new THREE.Group(); model.scale.setScalar(SS); root.add(model);
  const plan = new THREE.Shape();
  [[-0.19, -1.0], [0.19, -1.0], [0.19, 0.75], [0.15, 1.0], [0.06, 1.2], [0, 1.25], [-0.06, 1.2], [-0.15, 1.0], [-0.19, 0.75]].forEach(([x, y], i) => (i ? plan.lineTo(x, y) : plan.moveTo(x, y)));
  const hull = (depth, color, k, y) => {
    const m = new THREE.Mesh(new THREE.ExtrudeGeometry(plan, { depth, bevelEnabled: false }), mat(color, { roughness: 0.5 }));
    m.rotation.x = Math.PI / 2; m.scale.set(k, k, 1); m.position.y = y; m.castShadow = m.receiveShadow = true;
    return m;
  };
  model.add(hull(0.14, BLUE, 1, 0), hull(0.12, '#b8412e', 0.985, -0.14));
  const ht = hullTexture();
  for (const s of [-1, 1]) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.075), new THREE.MeshBasicMaterial({ map: ht, transparent: true }));
    p.position.set(s * 0.1915, -0.07, 0.1); p.rotation.y = s * Math.PI / 2; model.add(p);
  }
  model.add(bx(0.38, 0.012, 1.95, '#5f646b', 0, -0.012, -0.02));
  // stacked containers, taller toward midships
  const cols = ['#c8452f', '#3f6fa8', '#e0883a', '#2f5d8f', '#3c8fb8', '#c9a06a', '#8c4b3a', '#6f8f86', '#d9573b', '#b3452f'].map((c) => new THREE.Color(c));
  const bays = 13, rows = 4, spots = [];
  const cg = new THREE.BoxGeometry(0.068, 0.058, 0.098);
  const inst = new THREE.InstancedMesh(cg, mat('#ffffff', { roughness: 0.6 }), bays * rows * 5);
  inst.castShadow = inst.receiveShadow = true;
  const m4 = new THREE.Matrix4();
  let n = 0, slotTop = 0;
  const ourBay = 7, ourRow = 1;
  for (let b = 0; b < bays; b++) for (let r = 0; r < rows; r++) {
    const z = -0.52 + b * 0.105, x = -0.105 + r * 0.07;
    const h = Math.round(2 + 2.4 * Math.sin((b / (bays - 1)) * Math.PI) + ((b * 7 + r * 3) % 3) * 0.5);
    for (let l = 0; l < h; l++) {
      m4.makeTranslation(x, 0.029 + l * 0.06, z);
      inst.setMatrixAt(n, m4);
      inst.setColorAt(n, cols[(b * 3 + r * 5 + l * 7) % cols.length]);
      n++;
    }
    if (b === ourBay && r === ourRow) { slotTop = 0.029 + h * 0.06; spots.push([x, z]); }
  }
  inst.count = n; inst.instanceMatrix.needsUpdate = true; inst.instanceColor.needsUpdate = true;
  model.add(inst);
  const slot = new THREE.Object3D();
  slot.position.set(spots[0][0], slotTop + 0.029, spots[0][1]);
  slot.scale.set(0.068 / 0.19, 0.058 / 0.22, 0.098 / 0.8);
  model.add(slot);
  // bridge house, funnel, mast
  const cream = '#f3efe2';
  model.add(bx(0.32, 0.26, 0.15, cream, 0, 0, -0.8), bx(0.34, 0.035, 0.17, cream, 0, 0.26, -0.8), bx(0.3, 0.05, 0.1, cream, 0, 0.295, -0.78));
  model.add(bx(0.3, 0.028, 0.012, '#18283a', 0, 0.305, -0.727, { metalness: 0.6, roughness: 0.15 }));
  for (let i = 0; i < 4; i++) model.add(bx(0.3, 0.014, 0.004, '#27425e', 0, 0.05 + i * 0.055, -0.724));
  model.add(cyl(0.045, 0.13, BLUE, 0, 0.26, -0.88), cyl(0.047, 0.03, '#15191f', 0, 0.39, -0.88), cyl(0.004, 0.14, '#ddd', 0, 0.345, -0.78));
  return { root, model, slot, funnel: [0, 0.43, -0.88] };
}

// ---------------------------------------------------------------- particles
class Puffs {
  constructor(scene, N = 700) {
    this.N = N; this.i = 0;
    this.pos = new Float32Array(N * 3); this.vel = new Float32Array(N * 3);
    this.age = new Float32Array(N).fill(99); this.life = new Float32Array(N).fill(1);
    this.s0 = new Float32Array(N); this.s1 = new Float32Array(N); this.a0 = new Float32Array(N);
    this.drag = new Float32Array(N); this.lift = new Float32Array(N);
    this.size = new Float32Array(N); this.alpha = new Float32Array(N); this.color = new Float32Array(N * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.color, 3));
    this.material = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uScale: { value: 600 } },
      vertexShader: `attribute float aSize; attribute float aAlpha; attribute vec3 aColor; varying float vA; varying vec3 vC; uniform float uScale;
        void main(){ vA=aAlpha; vC=aColor; vec4 mv=modelViewMatrix*vec4(position,1.0); gl_PointSize=aSize*uScale/-mv.z; gl_Position=projectionMatrix*mv; }`,
      fragmentShader: `varying float vA; varying vec3 vC;
        void main(){ float d=length(gl_PointCoord-0.5); float a=smoothstep(0.5,0.1,d)*vA; if(a<0.01) discard; gl_FragColor=vec4(vC,a); }`,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }
  emit(x, y, z, vx, vy, vz, life, s0, s1, color, alpha, drag = 1.5, lift = 0) {
    const i = this.i; this.i = (i + 1) % this.N;
    this.pos.set([x, y, z], i * 3); this.vel.set([vx, vy, vz], i * 3);
    this.age[i] = 0; this.life[i] = life; this.s0[i] = s0; this.s1[i] = s1; this.a0[i] = alpha; this.drag[i] = drag; this.lift[i] = lift;
    const c = new THREE.Color(color); this.color.set([c.r, c.g, c.b], i * 3);
  }
  update(dt, camera, height) {
    this.material.uniforms.uScale.value = (height * 0.5) / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    for (let i = 0; i < this.N; i++) {
      if (this.age[i] >= this.life[i]) { this.alpha[i] = 0; continue; }
      this.age[i] += dt;
      const t = Math.min(this.age[i] / this.life[i], 1), k = Math.exp(-this.drag[i] * dt);
      for (let a = 0; a < 3; a++) { this.vel[i * 3 + a] *= k; this.pos[i * 3 + a] += this.vel[i * 3 + a] * dt; }
      this.vel[i * 3 + 1] += this.lift[i] * dt;
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      this.alpha[i] = this.a0[i] * (1 - t) * Math.min(1, t * 12);
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = g.attributes.aSize.needsUpdate = g.attributes.aAlpha.needsUpdate = g.attributes.aColor.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- vehicles
class Truck {
  constructor(world, parts, puffs) {
    Object.assign(this, { world, puffs }, parts);
    this.s = 0; this.v = 0; this.a = 0; this.yaw = 0; this.tYaw = 0; this.yawRate = 0;
    this.sp = { y: new Spring(60, 15.5), p: new Spring(30, 11), r: new Spring(60, 15.5) };
    this.tsp = { y: new Spring(60, 15.5), p: new Spring(30, 11), r: new Spring(60, 15.5) };
    this.spin = 0; this.bump = 0; this.puffT = 0;
    this.root.rotation.order = 'YXZ'; this.trailer.rotation.order = 'YXZ';
    world.scene.add(this.root, this.trailer);
  }
  setS(s) {
    this.s = s; this.v = 0; this.a = 0;
    const t = this.world.tangent(s);
    this.yaw = this.tYaw = Math.atan2(t.x, t.z);
    for (const sp of [...Object.values(this.sp), ...Object.values(this.tsp)]) { sp.x = 0; sp.v = 0; }
    this.pose(0.016, true);
  }
  ground(x, z) { return this.world.hxz(x, z); }
  curvature(s) {
    const a = this.world.tangent(s), b = this.world.tangent(s + 1.6);
    return Math.abs(wrapPi(Math.atan2(b.x, b.z) - Math.atan2(a.x, a.z))) / 1.6;
  }
  step(dt, sEnd, driving) {
    const w = this.world;
    // target speed: cruise, slower through bends and up grades, and brake to stop at the end
    let vt = driving ? V_TRUCK : 0;
    vt /= 1 + 9 * this.curvature(this.s + 1.5);
    const p0 = w.at(this.s), p1 = w.at(this.s + 2.5);
    const grade = (this.ground(p1.x, p1.z) - this.ground(p0.x, p0.z)) / 2.5;
    vt *= 1 - clamp(grade * 1.6, -0.1, 0.35);
    vt = Math.min(vt, Math.sqrt(Math.max(2 * A_BRAKE * 0.8 * (sEnd - this.s), 0)));
    const a = clamp((vt - this.v) * 1.6, -A_BRAKE, A_MAX);
    this.a = a;
    this.v = Math.max(this.v + a * dt, 0);
    this.s += this.v * dt;
    if (driving && sEnd - this.s < 0.04 && this.v < 0.12) this.v = 0;
    this.pose(dt, false);
  }
  pose(dt, snap) {
    const w = this.world, p = w.at(this.s), t = w.tangent(this.s);
    const tgtYaw = Math.atan2(t.x, t.z);
    const prev = this.yaw;
    this.yaw = snap ? tgtYaw : this.yaw + wrapPi(tgtYaw - this.yaw) * (1 - Math.exp(-14 * dt));
    this.yawRate = snap ? 0 : wrapPi(this.yaw - prev) / dt;
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const at = (lx, lz, x = p.x, z = p.z, c = cy, s = sy) => this.ground(x + lx * c + lz * s, z - lx * s + lz * c);
    // a smooth, level ride: the road is treated as straight and even, so there are no bumps and no
    // rocking. Ride height follows the ground averaged over a long stretch, and the body only
    // tilts gently with that averaged grade through critically-damped springs.
    const avg = (s0) => { let h = 0; for (const o of [-4, -2, 0, 2, 4]) { const q = w.at(s0 + o); h += this.ground(q.x, q.z); } return h / 5; };
    const hHere = avg(this.s), grade = (avg(this.s + 3) - avg(this.s - 3)) / 6;
    const sub = Math.ceil(dt / 0.008);
    for (let i = 0; i < sub; i++) {
      const d = dt / sub;
      this.sp.p.step(-Math.atan(grade) * 0.5, d);
      this.sp.y.step(0, d);
      this.sp.r.step(0, d);
    }
    this.root.position.set(p.x, hHere + this.sp.y.x, p.z);
    this.root.rotation.set(this.sp.p.x, this.yaw, 0);

    // trailer: pivots on the kingpin and swings out in bends (kinematic bicycle)
    const kp = new THREE.Vector3(p.x - sy * 0.12 * TS, 0, p.z - cy * 0.12 * TS);
    const Lt = 0.6 * TS;
    this.tYaw += (this.v / Lt) * Math.sin(this.yaw - this.tYaw) * dt;
    this.trailer.position.set(kp.x, avg(this.s - 1.8) + this.sp.y.x, kp.z);
    this.trailer.rotation.set(this.sp.p.x, this.tYaw, 0);

    // wheels roll at the true ground speed; the front axle steers into the bend
    this.spin += (this.v * dt) / (0.05 * TS);
    const steer = clamp((this.yawRate * 0.4 * TS) / Math.max(this.v, 0.6), -0.5, 0.5);
    for (const wh of [...this.wheels.front, ...this.wheels.drive, ...this.tWheels]) wh.rotation.x = this.spin;
    for (const wh of this.wheels.front) wh.rotation.y = steer;

    // exhaust and road dust
    this.puffT -= dt;
    if (this.puffT <= 0) {
      this.puffT = 0.07;
      this.root.updateMatrixWorld();
      const load = 0.4 + Math.max(this.a, 0) / A_MAX;
      for (const [x, y, z] of this.smoke) {
        const wp = this.root.localToWorld(new THREE.Vector3(x * TS, y * TS, z * TS));
        if (this.v > 0.05 || Math.random() < 0.3) this.puffs.emit(wp.x, wp.y, wp.z, rnd(-0.1, 0.1), rnd(0.5, 0.9), rnd(-0.1, 0.1), rnd(1.2, 2.0), 0.18, 0.75, '#4a4d52', 0.35 * load, 1.2, 0.15);
      }
      if (this.v > 0.8) {
        this.trailer.updateMatrixWorld();
        for (const s of [-1, 1]) {
          const wp = this.trailer.localToWorld(new THREE.Vector3(s * 0.085 * TS, 0.02, -0.72 * TS));
          this.puffs.emit(wp.x, wp.y + 0.05, wp.z, -sy * this.v * 0.25 + rnd(-0.2, 0.2), rnd(0.2, 0.5), -cy * this.v * 0.25 + rnd(-0.2, 0.2), rnd(0.9, 1.5), 0.25, 1.1, '#cdb98f', 0.22, 2.0, 0.1);
        }
      }
    }
  }
  focus() { return this.root.position; }
}

class Ship {
  constructor(world, parts, puffs) {
    Object.assign(this, { world, puffs }, parts);
    this.s = 0; this.v = 0; this.yaw = 0; this.t = 0; this.wakeT = 0;
    this.sp = { y: new Spring(10, 2.2), p: new Spring(9, 2.4), r: new Spring(7, 1.8) };
    this.root.rotation.order = 'YXZ';
    world.scene.add(this.root);
  }
  setS(s) {
    this.s = s; this.v = 0;
    const t = this.world.tangent(s); this.yaw = Math.atan2(t.x, t.z);
    this.pose(0.016, true);
  }
  wave(x, z, t) {
    return 0.11 * Math.sin(0.35 * x + 0.22 * z + 1.3 * t) + 0.06 * Math.sin(0.62 * x - 0.4 * z + 2.1 * t + 1.3) + 0.03 * Math.sin(1.1 * x + 0.9 * z + 3.3 * t);
  }
  step(dt, sEnd, driving) {
    let vt = driving ? V_SHIP : 0;
    vt = Math.min(vt, Math.sqrt(Math.max(2 * 0.8 * (sEnd - this.s), 0)));
    this.v = Math.max(this.v + clamp((vt - this.v) * 0.9, -0.8, 0.6) * dt, 0);
    this.s += this.v * dt;
    if (driving && sEnd - this.s < 0.05 && this.v < 0.1) this.v = 0;
    this.pose(dt, false);
  }
  pose(dt, snap) {
    this.t += dt;
    const w = this.world, p = w.at(this.s), t = w.tangent(this.s);
    const tgt = Math.atan2(t.x, t.z), prev = this.yaw;
    // rudder-limited turn rate
    this.yaw = snap ? tgt : this.yaw + clamp(wrapPi(tgt - this.yaw), -0.5 * dt, 0.5 * dt);
    const rate = snap ? 0 : wrapPi(this.yaw - prev) / dt;
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw), L = 0.9 * SS, B = 0.19 * SS;
    const H = (lx, lz) => this.wave(p.x + lx * cy + lz * sy, p.z - lx * sy + lz * cy, this.t);
    const bow = H(0, L), stern = H(0, -L), port = H(B, 0), star = H(-B, 0);
    const sub = Math.ceil(dt / 0.01);
    for (let i = 0; i < sub; i++) {
      const d = dt / sub;
      this.sp.y.step((bow + stern + port + star) / 4, d);
      this.sp.p.step(-Math.atan((bow - stern) / (2 * L)) * 1.1, d);
      this.sp.r.step(Math.atan((port - star) / (2 * B)) * 0.9 - rate * this.v * 0.05, d);
    }
    this.root.position.set(p.x, 0.19 * SS + 0.01 + this.sp.y.x, p.z);
    this.root.rotation.set(this.sp.p.x, this.yaw, this.sp.r.x);
    // wake and bow spray
    this.wakeT -= dt;
    if (this.wakeT <= 0 && this.v > 0.15) {
      this.wakeT = 0.06;
      for (const s of [-1, 1]) {
        const sx = p.x - sy * L * 0.95 + cy * s * B * 0.8, sz = p.z - cy * L * 0.95 - sy * s * B * 0.8;
        this.puffs.emit(sx, 0.08, sz, cy * s * 0.5 - sy * this.v * 0.3, 0, -sy * s * 0.5 - cy * this.v * 0.3, rnd(3.5, 5), 0.7, 2.6, '#ffffff', 0.5, 0.5, 0);
      }
      this.puffs.emit(p.x - sy * L, 0.08, p.z - cy * L, rnd(-0.2, 0.2), 0, rnd(-0.2, 0.2), 5, 1.2, 3.4, '#e9f6f6', 0.45, 0.4, 0);
      const pitchIn = Math.max(this.sp.p.v, 0);
      if (pitchIn > 0.05) for (let k = 0; k < 2; k++) this.puffs.emit(p.x + sy * L * 1.1, 0.25, p.z + cy * L * 1.1, rnd(-0.6, 0.6) + sy * this.v * 0.2, rnd(0.8, 1.6), rnd(-0.6, 0.6) + cy * this.v * 0.2, 0.9, 0.2, 0.6, '#ffffff', 0.5, 1.5, -2.4);
    }
  }
  focus() { return this.root.position; }
}

// ---------------------------------------------------------------- the run
export class Convoy {
  /** map: { scene, hxz(x,z), curve, stops:{ny:[x,z], rot:[x,z]} } */
  constructor(map) {
    this.map = map;
    const curve = map.curve;
    this.len = curve.getLength();
    const dense = curve.getSpacedPoints(4000);
    const arcOf = ([x, z]) => {
      let best = 0, bd = Infinity;
      dense.forEach((p, i) => { const d = (p.x - x) ** 2 + (p.z - z) ** 2; if (d < bd) { bd = d; best = i; } });
      return (best / 4000) * this.len;
    };
    this.sNY = arcOf(map.stops.ny);
    this.sRot = arcOf(map.stops.rot);
    this.sShipStart = this.sNY + 4.2;
    this.sShipEnd = this.sRot - 3.4;

    const world = {
      scene: map.scene, hxz: map.hxz,
      at: (s) => curve.getPointAt(clamp(s / this.len, 0, 1)),
      tangent: (s) => curve.getTangentAt(clamp(s / this.len, 0, 1)),
    };
    this.puffs = new Puffs(map.scene);
    const tex = maerskTexture();
    this.truck1 = new Truck(world, buildTruck(tex), this.puffs);
    this.truck2 = new Truck(world, buildTruck(tex), this.puffs);
    this.ship = new Ship(world, buildShip(tex), this.puffs);
    this.container = makeContainer(tex);
    map.scene.add(this.container);
    this.marker = new THREE.Mesh(new THREE.ConeGeometry(0.4, 0.9, 4), new THREE.MeshStandardMaterial({ color: '#ffd23f', emissive: '#ff9f1c', emissiveIntensity: 1.2, roughness: 0.3 }));
    this.marker.rotation.x = Math.PI;
    map.scene.add(this.marker);
    this.focus = new THREE.Vector3();
    this.playing = true;
    this.speed = 1;
    this.reset();
  }

  reset() {
    this.phase = 0; this.t = 0;
    this.truck1.setS(0.5);
    this.truck2.setS(this.sRot);
    this.ship.setS(this.sShipStart);
    this.truck1.slot.add(this.container);
    this.container.position.set(0, 0, 0); this.container.quaternion.identity(); this.container.scale.set(1, 1, 1);
    this.carrier = this.truck1;
    this.hoist = null;
    this.label = 'Truck 1 · Las Vegas → New York';
    this.updateFocus(1);
  }

  startHoist(fromSlot, toSlot, dur, nextPhase, label) {
    this.map.scene.attach(this.container);
    this.hoist = {
      toSlot, dur, t: 0, next: nextPhase,
      p0: this.container.getWorldPosition(new THREE.Vector3()),
      q0: this.container.getWorldQuaternion(new THREE.Quaternion()),
      s0: this.container.getWorldScale(new THREE.Vector3()),
    };
    this.label = label;
  }

  stepHoist(dt) {
    const h = this.hoist;
    h.t += dt;
    const k = ease(clamp(h.t / h.dur, 0, 1));
    const p1 = h.toSlot.getWorldPosition(new THREE.Vector3()), q1 = h.toSlot.getWorldQuaternion(new THREE.Quaternion()), s1 = h.toSlot.getWorldScale(new THREE.Vector3());
    const c = this.container;
    c.position.lerpVectors(h.p0, p1, k);
    c.position.y += Math.sin(k * Math.PI) * 5.5; // lifted over the gap
    c.quaternion.slerpQuaternions(h.q0, q1, k);
    c.scale.lerpVectors(h.s0, s1, k);
    if (h.t >= h.dur) {
      h.toSlot.add(c);
      c.position.set(0, 0, 0); c.quaternion.identity(); c.scale.set(1, 1, 1);
      this.hoist = null;
      this.phase = h.next;
    }
  }

  update(dt, camera, viewH) {
    this.puffs.update(dt * (this.playing ? this.speed : 0), camera, viewH);
    if (!this.playing) { this.updateFocus(0); return; }
    dt = Math.min(dt, 0.05) * this.speed;
    const stepT = (d) => {
      const idle1 = this.phase !== 0, idle2 = this.phase !== 4;
      this.truck1.step(d, this.sNY, this.phase === 0);
      this.truck2.step(d, this.len, this.phase === 4);
      this.ship.step(d, this.sShipEnd, this.phase === 2);
      void idle1; void idle2;
    };
    const n = Math.ceil(dt / (1 / 60));
    for (let i = 0; i < n; i++) stepT(dt / n);

    switch (this.phase) {
      case 0:
        if (this.truck1.s > this.sNY - 0.1 && this.truck1.v === 0) { this.phase = 1; this.startHoist(null, this.ship.slot, 3.4, 2, 'Container loaded onto the ship · New York'); }
        break;
      case 1: case 3:
        this.stepHoist(dt);
        if (this.phase === 2) this.label = 'Ship · New York → Rotterdam';
        if (this.phase === 4) this.label = 'Truck 2 · Rotterdam → Frankfurt';
        break;
      case 2:
        if (this.ship.s > this.sShipEnd - 0.1 && this.ship.v === 0) { this.phase = 3; this.startHoist(null, this.truck2.slot, 3.4, 4, 'Container unloaded · Rotterdam'); }
        break;
      case 4:
        if (this.truck2.s > this.len - 0.1 && this.truck2.v === 0) { this.phase = 5; this.t = 0; this.label = 'Delivered · Frankfurt'; }
        break;
      case 5:
        this.t += dt;
        if (this.t > 5) this.reset();
        break;
    }
    if (this.phase === 0) this.label = 'Truck 1 · Las Vegas → New York';
    this.updateFocus(dt);
  }

  get speedText() {
    const a = this.activeVehicle();
    return a === this.ship ? `${(a.v * 4.3).toFixed(0)} kn` : `${(a.v * 26).toFixed(0)} km/h`;
  }

  activeVehicle() {
    return this.phase <= 1 ? this.truck1 : this.phase <= 3 ? this.ship : this.truck2;
  }

  updateFocus(dt) {
    let target;
    if (this.phase === 1) target = this.truck1.root.position.clone().lerp(this.ship.root.position, 0.5);
    else if (this.phase === 3) target = this.ship.root.position.clone().lerp(this.truck2.root.position, 0.5);
    else target = this.activeVehicle().root.position.clone();
    const v = this.activeVehicle();
    if (v.v > 0.1) {
      const t = this.map.curve.getTangentAt(clamp(v.s / this.len, 0, 1));
      target.x += t.x * 1.6; target.z += t.z * 1.6;
    }
    if (dt === 1) this.focus.copy(target); else this.focus.copy(target);
    this.marker.position.copy(this.container.getWorldPosition(new THREE.Vector3()));
    this.marker.position.y += 2.0 + Math.sin(performance.now() / 280) * 0.25;
    this.marker.rotation.y += 0.03;
  }
}
