// Seedable RNG and nav-grid helpers (wavefront searches, flow fields).
import { GW, GH, N_CELLS, CELL, FAR, WORLD_W, WORLD_H } from "./consts.js";

// ---- RNG ------------------------------------------------------------------

export class Rng {
  /** sfc32 seeded through splitmix32: same seed, same sequence. */
  constructor(seed = Math.floor(Math.random() * 2 ** 32)) {
    let s = seed >>> 0;
    const sm = () => {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.a = sm(); this.b = sm(); this.c = sm(); this.d = sm();
    for (let i = 0; i < 12; i++) this.random();
    this.spare = null;
  }
  random() {
    let { a, b, c, d } = this;
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + t) >>> 0;
    this.a = a; this.b = b; this.c = c; this.d = d;
    return t / 4294967296;
  }
  uniform(lo, hi) { return lo + (hi - lo) * this.random(); }
  int(lo, hi) { return lo + Math.floor(this.random() * (hi - lo)); }   // [lo, hi)
  normal(mu = 0, sd = 1) {
    if (this.spare !== null) { const v = this.spare; this.spare = null; return mu + sd * v; }
    let u, v, r;
    do { u = 2 * this.random() - 1; v = 2 * this.random() - 1; r = u * u + v * v; } while (r >= 1 || r === 0);
    const k = Math.sqrt(-2 * Math.log(r) / r);
    this.spare = v * k;
    return mu + sd * u * k;
  }
  lognormal(mu, sd) { return Math.exp(this.normal(mu, sd)); }
  pick(arr) { return arr[Math.floor(this.random() * arr.length)]; }
  /** n draws from arr with probabilities proportional to weights. */
  weighted(arr, weights, n) {
    const cum = new Float64Array(arr.length);
    let t = 0;
    for (let i = 0; i < arr.length; i++) { t += Math.max(0, weights[i]); cum[i] = t; }
    const out = new Array(n);
    for (let k = 0; k < n; k++) {
      const r = this.random() * t;
      let lo = 0, hi = arr.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] > r) hi = m; else lo = m + 1; }
      out[k] = arr[lo];
    }
    return out;
  }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
}

// ---- geometry -------------------------------------------------------------

export const OFFSETS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const OFFSET_VEC = OFFSETS.map(([dx, dy]) => { const n = Math.sqrt(dx * dx + dy * dy); return [dx / n, dy / n]; });

export const hypot = (x, y) => Math.sqrt(x * x + y * y);
export const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
export function cellIndex(x, y) {
  const cx = clamp(Math.floor(x / CELL), 0, GW - 1), cy = clamp(Math.floor(y / CELL), 0, GH - 1);
  return cy * GW + cx;
}
export function cellOf(x, y) {     // truncation like numpy astype(int) (positions are >= 0)
  const cx = clamp((x * (1 / CELL)) | 0, 0, GW - 1), cy = clamp((y * (1 / CELL)) | 0, 0, GH - 1);
  return cy * GW + cx;
}
export const cellX = c => (c % GW + 0.5) * CELL;
export const cellY = c => (Math.floor(c / GW) + 0.5) * CELL;

export function discCells(x, y, r) {
  const gx0 = Math.max(0, Math.floor((x - r) / CELL)), gx1 = Math.min(GW - 1, Math.floor((x + r) / CELL));
  const gy0 = Math.max(0, Math.floor((y - r) / CELL)), gy1 = Math.min(GH - 1, Math.floor((y + r) / CELL));
  const out = [];
  for (let gy = gy0; gy <= gy1; gy++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      const dx = (gx + 0.5) * CELL - x, dy = (gy + 0.5) * CELL - y;
      if (dx * dx + dy * dy <= r * r) out.push(gy * GW + gx);
    }
  }
  return out;
}

export function segmentCells(x0, y0, x1, y1, hw) {
  const gx0 = Math.max(0, Math.floor((Math.min(x0, x1) - hw) / CELL)), gx1 = Math.min(GW - 1, Math.floor((Math.max(x0, x1) + hw) / CELL));
  const gy0 = Math.max(0, Math.floor((Math.min(y0, y1) - hw) / CELL)), gy1 = Math.min(GH - 1, Math.floor((Math.max(y0, y1) + hw) / CELL));
  const dx = x1 - x0, dy = y1 - y0, L2 = Math.max(dx * dx + dy * dy, 1e-9), out = [];
  for (let gy = gy0; gy <= gy1; gy++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      const px = (gx + 0.5) * CELL, py = (gy + 0.5) * CELL;
      const t = clamp(((px - x0) * dx + (py - y0) * dy) / L2, 0, 1);
      const ex = px - (x0 + t * dx), ey = py - (y0 + t * dy);
      if (ex * ex + ey * ey <= hw * hw) out.push(gy * GW + gx);
    }
  }
  return out;
}

export function pointSegmentDist(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const t = clamp(((px - x0) * dx + (py - y0) * dy) / Math.max(dx * dx + dy * dy, 1e-9), 0, 1);
  return hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

export function clampSegment(x0, y0, x1, y1, maxLen) {
  const d = hypot(x1 - x0, y1 - y0);
  if (d > maxLen) { const k = maxLen / d; return [x0 + (x1 - x0) * k, y0 + (y1 - y0) * k]; }
  return [x1, y1];
}

export function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---- fields ---------------------------------------------------------------

const BUCKETS = 32;                       // > the largest path cost (INDOOR_COST)
const _tent = new Int32Array(N_CELLS);
const _done = new Uint8Array(N_CELLS);

/**
 * Multi-source wavefront distance over a walkable mask (`bfs_field` in the
 * reference): a bucketed Dial's algorithm where a cell reached from the ring
 * settled at `it` settles at `it + cost`. Diagonal steps are only taken from
 * odd rings, which approximates Euclidean distance (octagonal metric).
 */
export function bfs(walk, sources, maxIter = FAR, cost = null) {
  const dist = new Int32Array(N_CELLS).fill(FAR);
  const tent = _tent.fill(FAR), done = _done.fill(0);
  const buckets = Array.from({ length: BUCKETS }, () => []);
  let front = [], pending = 0;
  for (const c of sources) {
    if (walk[c] && !done[c]) { done[c] = 1; dist[c] = 0; front.push(c); }
  }
  let it = 0;
  while (it < maxIter) {
    const diag = it & 1;
    for (let f = 0; f < front.length; f++) {
      const c = front[f], x = c % GW, y = (c - x) / GW;
      for (let k = 0; k < (diag ? 8 : 4); k++) {
        const nx = x + OFFSETS[k][0], ny = y + OFFSETS[k][1];
        if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
        const n = ny * GW + nx;
        if (!walk[n] || done[n]) continue;
        const t = it + (cost ? cost[n] : 1);
        if (t < tent[n]) { tent[n] = t; buckets[t % BUCKETS].push(n); pending++; }
      }
    }
    const b = buckets[(it + 1) % BUCKETS];
    front = [];
    for (let i = 0; i < b.length; i++) {
      const c = b[i];
      if (!done[c] && tent[c] === it + 1) { done[c] = 1; dist[c] = it + 1; front.push(c); }
    }
    pending -= b.length;
    b.length = 0;
    if (!front.length && pending <= 0) break;
    it++;
  }
  return dist;
}

/** Per-cell unit vector toward the lowest neighbour (ties: OFFSETS order). */
const FLAT = OFFSETS.map(([dx, dy]) => dy * GW + dx);
export function flowField(cost, out = new Float32Array(N_CELLS * 2)) {
  for (let y = 0; y < GH; y++) {
    const edgeY = y === 0 || y === GH - 1;
    for (let x = 0; x < GW; x++) {
      const c = y * GW + x;
      let best = Infinity, bk = -1;
      if (edgeY || x === 0 || x === GW - 1) {
        for (let k = 0; k < 8; k++) {
          const nx = x + OFFSETS[k][0], ny = y + OFFSETS[k][1];
          const v = (nx < 0 || ny < 0 || nx >= GW || ny >= GH) ? FAR : cost[ny * GW + nx];
          if (v < best) { best = v; bk = k; }
        }
      } else {
        for (let k = 0; k < 8; k++) {
          const v = cost[c + FLAT[k]];
          if (v < best) { best = v; bk = k; }
        }
      }
      if (best < cost[c]) { out[2 * c] = OFFSET_VEC[bk][0]; out[2 * c + 1] = OFFSET_VEC[bk][1]; }
      else { out[2 * c] = 0; out[2 * c + 1] = 0; }
    }
  }
  return out;
}

/** 3x3 box sum of a w x h grid. */
const _box = new Map();
export function box3(a, w, h, out = new Float32Array(w * h)) {
  if (!_box.has(w * h)) _box.set(w * h, new Float32Array(w * h));
  const r = _box.get(w * h), n = w * h;
  for (let i = 0; i < w; i++) r[i] = a[i] + a[i + w];                       // top row
  for (let i = w; i < n - w; i++) r[i] = a[i - w] + a[i] + a[i + w];
  for (let i = n - w; i < n; i++) r[i] = a[i - w] + a[i];                   // bottom row
  for (let y = 0; y < n; y += w) {
    out[y] = r[y] + r[y + 1];
    for (let i = y + 1; i < y + w - 1; i++) out[i] = r[i - 1] + r[i] + r[i + 1];
    out[y + w - 1] = r[y + w - 2] + r[y + w - 1];
  }
  return out;
}

/** Decode a baked run-length list into a typed array. */
export function unrle(runs, Type = Uint8Array, n = N_CELLS) {
  const out = new Type(n);
  let p = 0;
  for (let i = 0; i < runs.length; i += 2) {
    const v = runs[i], k = runs[i + 1];
    if (v) out.fill(v, p, p + k);
    p += k;
  }
  return out;
}

export const inWorld = (x, y) => x >= 0 && x < WORLD_W && y >= 0 && y < WORLD_H;
