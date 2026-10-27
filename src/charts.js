// Lightweight canvas charts – no dependencies.
const FONT = '500 11px Geist, Inter, system-ui, sans-serif';
const MUTED = '#7c7c86';
const GRID = 'rgba(255, 255, 255, 0.06)';

function setupCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function niceStep(range, target) {
  const raw = range / target;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * pow;
}

export class ProfileChart {
  constructor(canvas, { onHover } = {}) {
    this.canvas = canvas;
    this.onHover = onHover;
    this.samples = null;
    this.hover = null;
    this.progress = 1;
    new ResizeObserver(() => this.draw()).observe(canvas);
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerleave', () => {
      this.hover = null;
      this.onHover?.(null);
      this.draw();
    });
  }

  setData(samples) {
    this.samples = samples;
    const lo = Math.min(...samples.map((s) => s.e)), hi = Math.max(...samples.map((s) => s.e));
    const pad = (hi - lo) * 0.12 + 5;
    this.yMin = Math.max(0, lo - pad);
    this.yMax = hi + pad;
    this.progress = 0;
    const t0 = performance.now();
    const step = () => {
      this.progress = Math.min(1, (performance.now() - t0) / 900);
      this.draw();
      if (this.progress < 1) requestAnimationFrame(step);
    };
    step();
  }

  layout(w, h) {
    return { l: 48, r: 14, t: 12, b: 24, W: w - 62, H: h - 36 };
  }

  move(e) {
    if (!this.samples) return;
    const rect = this.canvas.getBoundingClientRect();
    const { l, W } = this.layout(rect.width, rect.height);
    const x = (e.clientX - rect.left - l) / W;
    if (x < 0 || x > 1) {
      this.hover = null;
      this.onHover?.(null);
    } else {
      this.hover = Math.round(x * (this.samples.length - 1));
      this.onHover?.(this.hover);
    }
    this.draw();
  }

  draw() {
    const { ctx, w, h } = setupCanvas(this.canvas);
    if (!w || !h) return;
    const { l, t, W, H } = this.layout(w, h);
    ctx.font = FONT;

    if (!this.samples) {
      ctx.fillStyle = MUTED;
      ctx.textAlign = 'center';
      ctx.fillText('Load a scene to see an elevation profile', w / 2, h / 2);
      return;
    }
    const s = this.samples;
    const total = s[s.length - 1].d;
    const X = (d) => l + (d / total) * W;
    const Y = (e) => t + H - ((e - this.yMin) / (this.yMax - this.yMin)) * H;

    // grid + y labels
    const ys = niceStep(this.yMax - this.yMin, 4);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let v = Math.ceil(this.yMin / ys) * ys; v <= this.yMax; v += ys) {
      ctx.strokeStyle = GRID;
      ctx.beginPath(); ctx.moveTo(l, Y(v)); ctx.lineTo(l + W, Y(v)); ctx.stroke();
      ctx.fillStyle = MUTED;
      ctx.fillText(`${Math.round(v)}`, l - 8, Y(v));
    }
    const xs = niceStep(total, 8);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let v = 0; v <= total; v += xs) {
      ctx.fillStyle = MUTED;
      ctx.fillText(v >= 1000 ? `${(v / 1000).toFixed(1)} km` : `${Math.round(v)} m`, X(v), t + H + 7);
    }

    // area (revealed left→right)
    const n = Math.max(2, Math.floor(s.length * this.progress));
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(X(s[0].d), Y(s[0].e));
    for (let i = 1; i < n; i++) ctx.lineTo(X(s[i].d), Y(s[i].e));
    const grad = ctx.createLinearGradient(0, t, 0, t + H);
    grad.addColorStop(0, 'rgba(220, 232, 245, 0.42)');
    grad.addColorStop(1, 'rgba(220, 232, 245, 0.02)');
    ctx.lineTo(X(s[n - 1].d), t + H);
    ctx.lineTo(X(s[0].d), t + H);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(X(s[0].d), Y(s[0].e));
    for (let i = 1; i < n; i++) ctx.lineTo(X(s[i].d), Y(s[i].e));
    ctx.strokeStyle = '#eef4fb';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.restore();

    // hover or peak marker
    let idx = this.hover;
    if (idx == null && this.progress === 1) {
      idx = s.reduce((m, p, i) => (p.e > s[m].e ? i : m), 0);
    }
    if (idx != null && idx < n) {
      const p = s[idx];
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(X(p.d), t); ctx.lineTo(X(p.d), t + H); ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(X(p.d), Y(p.e), 4, 0, Math.PI * 2); ctx.fill();
      const label = `${p.e.toFixed(1)} m  ·  ${Math.round(p.d)} m`;
      ctx.font = '600 11px Geist, Inter, system-ui, sans-serif';
      const tw = ctx.measureText(label).width + 16;
      let bx = X(p.d) + 10;
      if (bx + tw > l + W) bx = X(p.d) - tw - 10;
      const by = Math.max(t, Y(p.e) - 30);
      ctx.fillStyle = 'rgba(27, 27, 31, 0.95)';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
      roundRect(ctx, bx, by, tw, 22, 6);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#e6eef7';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, bx + 8, by + 11);
    }
  }
}

export class ScatterChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.points = [];
    this.shown = 0;
    new ResizeObserver(() => this.draw()).observe(canvas);
    this.draw();
  }

  setPoints(points, range, dur = 1800) {
    this.points = points;
    this.range = range;
    const t0 = performance.now();
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / dur);
      this.shown = Math.floor(points.length * (1 - Math.pow(1 - t, 2)));
      this.draw();
      if (t < 1) requestAnimationFrame(step);
    };
    step();
  }

  draw() {
    const { ctx, w, h } = setupCanvas(this.canvas);
    if (!w || !h) return;
    const l = 34, r = 8, t = 8, b = 22;
    const W = w - l - r, H = h - t - b;
    const [lo, hi] = this.range || [200, 1300];
    const X = (v) => l + ((v - lo) / (hi - lo)) * W;
    const Y = (v) => t + H - ((v - lo) / (hi - lo)) * H;

    ctx.font = '500 10px Geist, Inter, system-ui, sans-serif';
    ctx.strokeStyle = GRID;
    ctx.fillStyle = MUTED;
    const st = niceStep(hi - lo, 4);
    for (let v = Math.ceil(lo / st) * st; v <= hi; v += st) {
      ctx.beginPath(); ctx.moveTo(l, Y(v)); ctx.lineTo(l + W, Y(v)); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(X(v), t); ctx.lineTo(X(v), t + H); ctx.stroke();
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(Math.round(v), l - 5, Y(v));
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(Math.round(v), X(v), t + H + 6);
    }
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.strokeRect(l, t, W, H);

    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = 'rgba(230, 238, 247, 0.6)';
    ctx.beginPath(); ctx.moveTo(X(lo), Y(lo)); ctx.lineTo(X(hi), Y(hi)); ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = 'rgba(61, 220, 151, 0.7)';
    for (let i = 0; i < this.shown; i++) {
      const [a, p] = this.points[i];
      ctx.beginPath();
      ctx.arc(X(a), Y(p), 1.7, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
