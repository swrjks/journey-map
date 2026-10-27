// Seeded 2D Perlin noise with fbm / ridged helpers.
export function makeNoise(seed = 1) {
  let s = (seed * 2654435761) >>> 0 || 1;
  const rnd = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  const perm = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  const p = new Uint8Array(512);
  for (let i = 0; i < 512; i++) p[i] = perm[i & 255];

  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (a, b, t) => a + (b - a) * t;
  const grad = (h, x, y) => {
    switch (h & 7) {
      case 0: return x + y;
      case 1: return -x + y;
      case 2: return x - y;
      case 3: return -x - y;
      case 4: return x;
      case 5: return -x;
      case 6: return y;
      default: return -y;
    }
  };

  function noise(x, y) {
    const xf = Math.floor(x), yf = Math.floor(y);
    const X = xf & 255, Y = yf & 255;
    x -= xf; y -= yf;
    const u = fade(x), v = fade(y);
    const a = p[X] + Y, b = p[X + 1] + Y;
    return lerp(
      lerp(grad(p[a], x, y), grad(p[b], x - 1, y), u),
      lerp(grad(p[a + 1], x, y - 1), grad(p[b + 1], x - 1, y - 1), u),
      v
    ) * 0.9;
  }

  // Roughly -1..1
  function fbm(x, y, oct = 5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let i = 0; i < oct; i++) {
      sum += amp * noise(x * freq, y * freq);
      norm += amp; amp *= 0.5; freq *= 2.03;
    }
    return sum / norm;
  }

  // Roughly 0..1, sharp crests
  function ridged(x, y, oct = 6) {
    let amp = 0.5, freq = 1, sum = 0, weight = 1, norm = 0;
    for (let i = 0; i < oct; i++) {
      let n = 1 - Math.abs(noise(x * freq, y * freq));
      n *= n;
      n *= weight;
      weight = Math.min(1, Math.max(0, n * 1.6));
      sum += n * amp; norm += amp;
      amp *= 0.5; freq *= 2.1;
    }
    return sum / norm;
  }

  return { noise, fbm, ridged, rnd };
}

export function hash2(i, j) {
  let h = (i * 374761393 + j * 668265263) >>> 0;
  h = ((h ^ (h >>> 13)) * 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
