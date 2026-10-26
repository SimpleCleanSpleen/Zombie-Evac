// Static city layout (baked by tools/bake_maps.py from the reference City).
import { GW, GH, N_CELLS, CELL, FAR, WORLD_W, WORLD_H, INDOOR_COST, BRIDGE_MIN_CELLS, COL, mix, rgb } from "./consts.js";
import { bfs, flowField, unrle } from "./grid.js";

const mapCache = new Map();

export async function loadCity(slug) {
  if (!mapCache.has(slug)) {
    const res = await fetch(`maps/${slug}.json`);
    if (!res.ok) throw new Error(`map ${slug}: HTTP ${res.status}`);
    mapCache.set(slug, await res.json());
  }
  return new City(mapCache.get(slug));
}

export class City {
  constructor(d) {
    this.name = d.name;
    this.slug = d.slug;
    this.kind = d.kind;
    this.seed = d.seed;
    this.indoor0 = unrle(d.indoor);
    this.indoor = this.indoor0.slice();
    this.water = unrle(d.water);
    this.waterFull = unrle(d.water_full);
    this.street = unrle(d.street);
    this.label = unrle(d.label, Int32Array);
    this.nBldg = d.n_bldg;
    this.mainWater = d.main_water ? unrle(d.main_water) : new Uint8Array(N_CELLS);
    this.hasWater = this.water.some(v => v);
    this.cars = d.cars;
    this.polys = d.polys;
    this.roads = d.roads;
    this.waterPolys = d.water_polys;
    this.parks = d.parks;
    this.lots = d.lots;
    this.rails = d.rails;
    this.walk = new Uint8Array(N_CELLS);
    this.open = new Uint8Array(N_CELLS);
    this.cost = new Int32Array(N_CELLS);
    for (let c = 0; c < N_CELLS; c++) {
      this.walk[c] = this.water[c] ? 0 : 1;
      this.open[c] = !this.indoor[c] && this.walk[c] ? 1 : 0;
      this.cost[c] = this.indoor[c] ? INDOOR_COST : 1;
    }
    this.streetCells = [];
    for (let c = 0; c < N_CELLS; c++) if (this.street[c]) this.streetCells.push(c);
    this.rubble = new Uint8Array(N_CELLS);
    this.rubbleNew = [];
    this.surfaceDirty = true;
    this._carRoutes = null;
    this._sides = null;
  }

  /** Road-only routes to each map edge (west, east, north, south). */
  carRoutes() {
    if (!this._carRoutes) {
      const flows = [], dists = [];
      for (let side = 0; side < 4; side++) {
        const src = [];
        for (let i = 0; i < (side < 2 ? GH : GW); i++) {
          const c = side === 0 ? i * GW : side === 1 ? i * GW + GW - 1 : side === 2 ? i : (GH - 1) * GW + i;
          if (this.street[c]) src.push(c);
        }
        const d = bfs(this.street, src);
        flows.push(flowField(d));
        dists.push(d);
      }
      this._carRoutes = { flows, dists };
    }
    return this._carRoutes;
  }

  /** Mean river row per column and column per row (for north/south/east/west of the water). */
  sides() {
    if (!this._sides) {
      const w = this.mainWater;
      const lineFor = (n, m, at) => {
        const mean = new Float64Array(n).fill(NaN);
        let tot = 0, cnt = 0;
        for (let i = 0; i < n; i++) {
          let s = 0, k = 0;
          for (let j = 0; j < m; j++) if (w[at(i, j)]) { s += j; k++; }
          if (k) { mean[i] = s / k; tot += mean[i]; cnt++; }
        }
        const fill = cnt ? tot / cnt : m / 2;
        return Array.from(mean, v => ((Number.isNaN(v) ? fill : v) + 0.5) * CELL);
      };
      this._sides = {
        ns: lineFor(GW, GH, (x, y) => y * GW + x),       // per column: mean water y
        ew: lineFor(GH, GW, (y, x) => y * GW + x),       // per row: mean water x
      };
    }
    return this._sides;
  }

  /** Turn building cells into rubble (open ground). Returns how many. */
  destroy(cells) {
    let n = 0;
    for (const c of cells) {
      if (!this.indoor[c]) continue;
      this.indoor[c] = 0;
      this.open[c] = this.walk[c];
      this.cost[c] = 1;
      this.rubble[c] = 1;
      this.rubbleNew.push(c);
      n++;
    }
    return n;
  }

  restore() {
    if (!this.rubble.some(v => v)) return;
    this.indoor.set(this.indoor0);
    for (let c = 0; c < N_CELLS; c++) {
      this.open[c] = !this.indoor[c] && this.walk[c] ? 1 : 0;
      this.cost[c] = this.indoor[c] ? INDOOR_COST : 1;
    }
    this.rubble.fill(0);
    this.rubbleNew = [];
    this.surfaceDirty = true;
  }

  // ---- rendering ------------------------------------------------------

  /** Pre-render the static city at scale s (pixels per metre) with a baked glow. */
  render(s) {
    const w = Math.max(1, Math.floor(WORLD_W * s)), h = Math.max(1, Math.floor(WORLD_H * s));
    const cv = this.surface && this.surface.width === w && this.surface.height === h ? this.surface : document.createElement("canvas");
    cv.width = w; cv.height = h;
    const g = cv.getContext("2d");
    g.fillStyle = rgb(COL.BG);
    g.fillRect(0, 0, w, h);
    const step = Math.max(4, Math.round(100 * s));
    g.fillStyle = rgb(COL.GRIDLINE);
    for (let x = 0; x < w; x += step) g.fillRect(x, 0, 1, h);
    for (let y = 0; y < h; y += step) g.fillRect(0, y, w, 1);
    const lw = Math.min(5, Math.max(3, Math.round(4 * s)));
    this.renderGeometry(g, s, lw);
    this.paintRubble(g, s, this.rubbleAll());
    this.rubbleNew = [];
    this.surfaceDirty = false;
    // Bake a heavy static phosphor glow into the city layer.
    const sw = Math.max(1, Math.floor(w / 6)), sh = Math.max(1, Math.floor(h / 6));
    const small = document.createElement("canvas");
    small.width = sw; small.height = sh;
    const sg = small.getContext("2d");
    sg.imageSmoothingQuality = "high";
    sg.drawImage(cv, 0, 0, sw, sh);
    g.save();
    g.globalCompositeOperation = "lighter";
    g.globalAlpha = 70 / 255;
    g.imageSmoothingEnabled = true;
    g.drawImage(small, 0, 0, w, h);
    g.restore();
    this.surface = cv;
    this.surfaceScale = s;
    return cv;
  }

  rubbleAll() {
    const out = [];
    for (let c = 0; c < N_CELLS; c++) if (this.rubble[c]) out.push(c);
    return out;
  }

  paintRubble(g, s, cells) {
    const k = Math.max(1, Math.ceil(CELL * s)), q = Math.max(1, Math.floor(k / 4));
    const base = rgb(mix(COL.BG, COL.WHITE, 0.10)), chip = rgb(mix(COL.BG, COL.WHITE, 0.32));
    for (const c of cells) {
      const x = Math.floor((c % GW) * CELL * s), y = Math.floor(Math.floor(c / GW) * CELL * s);
      g.fillStyle = base;
      g.fillRect(x, y, k, k);
      const hsh = Number((BigInt(c) * 2654435761n) & 0xffffn);
      g.fillStyle = chip;
      for (let n = 0; n < 3; n++) g.fillRect(x + (hsh >> (n * 4)) % k, y + (hsh >> (n * 4 + 2)) % k, q, q);
    }
  }

  renderGeometry(g, s, lw) {
    const line = (pts, color, width) => {
      if (pts.length < 2) return;
      g.strokeStyle = color;
      g.lineWidth = Math.max(1, Math.round(width));
      g.beginPath();
      g.moveTo(pts[0][0] * s, pts[0][1] * s);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0] * s, pts[i][1] * s);
      g.stroke();
    };
    const poly = (pts) => {
      g.beginPath();
      g.moveTo(pts[0][0] * s, pts[0][1] * s);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0] * s, pts[i][1] * s);
      g.closePath();
    };
    g.lineJoin = "round";
    g.lineCap = "round";
    const roads = this.roads.filter(r => r[2] !== "bridge" && r[2] !== "rail");
    for (const [w, pts] of roads) if (w <= 4) line(pts, rgb(COL.GRIDLINE), 1);
    const main = roads.filter(r => r[0] > 4);
    for (const [w, pts] of main) line(pts, rgb(COL.CYAN), w * s + 2 * lw);
    for (const [w, pts] of main) line(pts, rgb(COL.BG), w * s);
    for (const pts of this.waterPolys) {
      poly(pts);
      g.fillStyle = rgb(mix(COL.BG, COL.BLUE, 0.25));
      g.fill();
      g.strokeStyle = rgb(mix(COL.BG, COL.BLUE, 0.7));
      g.lineWidth = Math.max(1, Math.round(s));
      g.stroke();
    }
    for (const [w, pts, lyr] of this.roads) {
      if (lyr !== "bridge") continue;
      const deck = Math.max(BRIDGE_MIN_CELLS * CELL, w) * s;
      line(pts, rgb(COL.CYAN), deck + 2 * lw);
      line(pts, rgb(COL.BG), deck);
    }
    g.lineCap = "butt";
    for (const pts of this.rails) {          // two rails on sleepers
      const segs = [];
      let total = 0;
      for (let i = 0; i + 1 < pts.length; i++) {
        const dx = (pts[i + 1][0] - pts[i][0]) * s, dy = (pts[i + 1][1] - pts[i][1]) * s, L = Math.hypot(dx, dy);
        segs.push({ x: pts[i][0] * s, y: pts[i][1] * s, dx, dy, L, nx: -dy / Math.max(L, 1e-6), ny: dx / Math.max(L, 1e-6), at: total });
        total += L;
      }
      g.strokeStyle = rgb(COL.WHITE_DIM);
      g.lineWidth = Math.max(1, Math.round(s));
      g.beginPath();
      let i = 0;
      for (let d = 0; d < total; d += 4 * s) {
        while (i < segs.length - 1 && segs[i + 1].at <= d) i++;
        const sg = segs[i], t = (d - sg.at) / Math.max(sg.L, 1e-6);
        const qx = sg.x + sg.dx * t, qy = sg.y + sg.dy * t;
        g.moveTo(qx + sg.nx * 3 * s, qy + sg.ny * 3 * s);
        g.lineTo(qx - sg.nx * 3 * s, qy - sg.ny * 3 * s);
      }
      g.stroke();
      for (const side of [-1, 1]) {
        g.strokeStyle = rgb(mix(COL.BG, COL.WHITE, 0.8));
        g.beginPath();
        segs.forEach((sg, k) => {
          const px = sg.x + sg.nx * side * 1.8 * s, py = sg.y + sg.ny * side * 1.8 * s;
          if (k === 0) g.moveTo(px, py); else g.lineTo(px, py);
        });
        const last = pts[pts.length - 1], sg = segs[segs.length - 1];
        if (sg) g.lineTo(last[0] * s + sg.nx * side * 1.8 * s, last[1] * s + sg.ny * side * 1.8 * s);
        g.stroke();
      }
    }
    g.lineCap = "round";
    for (const pts of this.parks) {
      poly(pts);
      g.fillStyle = rgb(COL.PARK);
      g.fill();
      g.strokeStyle = rgb(COL.GREEN);
      g.lineWidth = Math.max(1, Math.round(s));
      g.stroke();
    }
    g.fillStyle = rgb(COL.BUILDING);
    for (const pts of this.polys) { poly(pts); g.fill(); }
    if (this.lots.length) {                  // lot lines, clipped to the footprints
      g.save();
      g.beginPath();
      for (const pts of this.polys) {
        g.moveTo(pts[0][0] * s, pts[0][1] * s);
        for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0] * s, pts[i][1] * s);
        g.closePath();
      }
      g.clip();
      g.strokeStyle = rgb(COL.LOT_LINE);
      g.lineWidth = 1;
      g.beginPath();
      for (const [a, b] of this.lots) { g.moveTo(a[0] * s, a[1] * s); g.lineTo(b[0] * s, b[1] * s); }
      g.stroke();
      g.restore();
    }
    g.strokeStyle = rgb(COL.CYAN);
    g.lineWidth = Math.max(1, Math.round(1.5 * s));
    g.lineJoin = "miter";
    for (const pts of this.polys) { poly(pts); g.stroke(); }
  }
}

export { FAR };
