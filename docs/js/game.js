// The simulation: agents, units, fields, economy, end conditions. No
// rendering or input code (a port of the reference `Game` class).
import * as K from "./consts.js";
import {
  Rng, bfs, flowField, box3, cellOf, cellIndex, cellX, cellY, discCells, segmentCells, pointSegmentDist,
  clampSegment, pointInPoly, clamp,
} from "./grid.js";

const { GW, GH, N_CELLS, CELL, FAR, HW, HH, HC, N_HASH, WORLD_W, WORLD_H, CIV, ZOMBIE, RESCUED, DEAD, IN_CAR } = K;
const NEIGHBOURS9 = [];
for (const dy of [-1, 0, 1]) for (const dx of [-1, 0, 1]) NEIGHBOURS9.push(dy * GW + dx);
const TAU = 2 * Math.PI;
const hypot = (x, y) => Math.sqrt(x * x + y * y);

// ---- progression (Endless dynamic difficulty) ------------------------------

export class Progression {
  constructor(data, onChange) {
    this.level = data?.level | 0;
    this.history = Array.isArray(data?.history) ? data.history : [];
    this.onChange = onChange;
  }
  params(level = this.level) {
    return {
      infected: clamp(K.INFECTED_FRACTION + 0.025 * level, 0.05, 0.35),
      population: clamp(K.POPULATION + 400 * level, 3000, 8000),
      cp: clamp(K.START_CP - 35 * level, 175, 560),
    };
  }
  record(mapName, evacPct, difficulty = "medium") {
    const old = this.level;
    if (evacPct >= 75) this.level += 2;
    else if (evacPct >= 50) this.level += 1;
    else if (evacPct < 20) this.level -= 1;
    this.level = clamp(this.level, -3, 6);
    this.history.push({ map: mapName, evacuated_pct: Math.round(evacPct * 10) / 10, level: old, difficulty,
      date: new Date().toISOString().slice(0, 10) });
    this.history = this.history.slice(-50);
    this.onChange?.();
    return this.level - old;
  }
  toJSON() { return { level: this.level, history: this.history }; }
}

// ---- transient objects ------------------------------------------------------

function makeUnit(id, kind, x, y, cost, kw) {
  const spec = K.UNIT_SPECS[kind];
  return Object.assign({
    id, kind, x, y, cost, spec, range: spec.range || 0, cooldown: 0, hp: null, max_hp: null, cells: null, zone: null,
    aim: null, order: null, order_flow: null, blocked_t: 0, dest: null, retreating: false, support: 0, built: true,
    progress: 0, claimed: null, job: null, job_flow: null, escort: null, screening: false, drop_t: 0, defended: false,
    last_hit: -1, guarded: false,
  }, kw);
}

class Drone {
  constructor(pts) {
    this.pts = pts;
    this.cum = [0];
    for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1] + hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    this.length = this.cum[this.cum.length - 1];
    this.dist = 0;
    this.hover = 0;
  }
  segment(d) {
    let i = 0;
    while (i < this.cum.length - 2 && this.cum[i + 1] <= d) i++;
    return i;
  }
  get pos() {
    const d = Math.min(this.dist, this.length), i = this.segment(d);
    const seg = this.cum[i + 1] - this.cum[i], t = seg <= 0 ? 0 : (d - this.cum[i]) / seg;
    const a = this.pts[i], b = this.pts[i + 1];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }
}

class Train {
  constructor(pts, rs) {
    this.pts = pts;
    this.cum = [0];
    for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1] + hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    this.length = this.cum[this.cum.length - 1];
    this.dir = rs.random() < 0.5 ? 1 : -1;
    this.head = null;
    this.wait = rs.uniform(...K.TRAIN_FIRST);
  }
  at(d) {
    d = clamp(d, 0, this.length);
    let i = 0;
    while (i < this.cum.length - 2 && this.cum[i + 1] <= d) i++;
    const seg = this.cum[i + 1] - this.cum[i], t = seg > 0 ? (d - this.cum[i]) / seg : 0;
    const a = this.pts[i], b = this.pts[i + 1];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }
  body(step = 3.0) {
    const out = [];
    for (let k = 0; k <= K.TRAIN_LENGTH + 1e-9; k += step) {
      const d = this.head - this.dir * k;
      if (d >= 0 && d <= this.length) out.push(this.at(d));
    }
    return out;
  }
}

// ---- the game ---------------------------------------------------------------

export class Game {
  constructor({ city, seed, progress, mission = null, difficulty = "medium" }) {
    this.progress = progress;
    this.difficulty = difficulty;
    this.lastResult = null;
    this.setCity(city, seed, mission);
  }

  setCity(city, seed = null, mission = null) {
    this.city = city;
    this.mission = mission;
    this.seed = seed ?? city.seed;
    this.reset();
  }

  newOutbreak() {
    this.seed = Math.floor(Math.random() * 2 ** 30);
    this.reset();
  }

  regionOk(x, y, spec) {
    if ("x_min" in spec && !(x >= spec.x_min)) return false;
    if ("x_max" in spec && !(x <= spec.x_max)) return false;
    if ("y_min" in spec && !(y >= spec.y_min)) return false;
    if ("y_max" in spec && !(y <= spec.y_max)) return false;
    const r = hypot(x - K.MAP_CENTER[0], y - K.MAP_CENTER[1]);
    if ("r_min" in spec && r < spec.r_min) return false;
    if ("r_max" in spec && r > spec.r_max) return false;
    if (spec.side && !this.waterSide(x, y, spec.side)) return false;
    const polys = spec.polys || (spec.poly ? [spec.poly] : []);
    if (polys.length && !polys.some(p => pointInPoly(x, y, p))) return false;
    return true;
  }

  waterSide(x, y, side, margin = 15) {
    const { ns, ew } = this.city.sides();
    if (side === "north" || side === "south") {
      const ref = ns[clamp((x / CELL) | 0, 0, GW - 1)];
      return side === "north" ? y < ref - margin : y > ref + margin;
    }
    const ref = ew[clamp((y / CELL) | 0, 0, GH - 1)];
    return side === "west" ? x < ref - margin : x > ref + margin;
  }

  reset() {
    const c = this.city;
    c.restore();
    const rs = new Rng(this.seed);
    const m = this.mission;
    const base = m ? { population: m.population, infected: m.infected, cp: m.cp } : this.progress.params();
    this.params = K.applyDifficulty(base, this.difficulty);
    this.goal = m ? K.scaledGoal(m.goal, this.difficulty) : {};
    const diff = K.DIFFICULTY[this.difficulty] || K.DIFFICULTY.medium;
    const P = this.P = this.params.population;
    const nInf = Math.floor(P * this.params.infected);
    const streets = c.streetCells;
    const sx = streets.map(cellX), sy = streets.map(cellY);
    this.zombieSpeed = m?.zombie_speed_mult ? K.ZOMBIE_SPEED.map(v => v * m.zombie_speed_mult) : K.ZOMBIE_SPEED;

    // Ground zeros: away from the edges and each other (story: per mission).
    const nGz = m ? m.ground_zeros : rs.int(K.GROUND_ZEROS[0], K.GROUND_ZEROS[1] + 1);
    let inner = [];
    streets.forEach((cell, i) => {
      let ok = m?.gz_region ? this.regionOk(sx[i], sy[i], m.gz_region)
        : sx[i] > 150 && sx[i] < WORLD_W - 150 && sy[i] > 150 && sy[i] < WORLD_H - 150;
      if (ok && m?.gz_min_dist) ok = hypot(sx[i] - K.MAP_CENTER[0], sy[i] - K.MAP_CENTER[1]) > m.gz_min_dist;
      if (ok) inner.push(cell);
    });
    if (!inner.length) inner = streets;
    const sep = m?.gz_sep ?? 300;
    this.groundZeros = [];
    for (let n = 0; n < 400; n++) {
      const i = rs.pick(inner), x = cellX(i), y = cellY(i);
      if (this.groundZeros.every(([gx, gy]) => hypot(x - gx, y - gy) > sep)) {
        this.groundZeros.push([x, y]);
        if (this.groundZeros.length === nGz) break;
      }
    }

    // Buildings: per-footprint cells, sizes and centres.
    const nb = c.nBldg + 1;
    const size = new Float64Array(nb), bcx = new Float64Array(nb), bcy = new Float64Array(nb);
    const bcells = Array.from({ length: nb }, () => []);
    for (let cell = 0; cell < N_CELLS; cell++) {
      const b = c.label[cell];
      if (b) { bcells[b].push(cell); size[b]++; bcx[b] += cellX(cell); bcy[b] += cellY(cell); }
    }
    const real = new Uint8Array(nb);
    for (let b = 1; b < nb; b++) if (size[b]) { real[b] = 1; bcx[b] /= size[b]; bcy[b] /= size[b]; }
    const inBuildings = (ids, w, n) => rs.weighted(ids, w, n).map(b => bcells[b][Math.floor(rs.random() * size[b])]);
    const scatter = cell => [(cell % GW + rs.random()) * CELL, (Math.floor(cell / GW) + rs.random()) * CELL];
    const R2 = (3 * K.GZ_SPREAD) ** 2;

    // Infected: each outbreak has overrun the buildings nearest its epicentre.
    const zpos = [], overrun = new Uint8Array(nb);
    const nz = this.groundZeros.length;
    for (let g = 0; g < nz; g++) {
      const [gx, gy] = this.groundZeros[g];
      const n = Math.floor((g + 1) * nInf / nz) - Math.floor(g * nInf / nz);
      const cand = [];
      for (let b = 1; b < nb; b++) if (real[b]) cand.push([hypot(bcx[b] - gx, bcy[b] - gy), b]);
      cand.sort((a, b) => a[0] - b[0]);
      const own = cand.slice(0, K.ZOMBIE_BUILDINGS).filter(([d]) => d < 3 * K.GZ_SPREAD + 40).map(([, b]) => b);
      own.forEach(b => { overrun[b] = 1; });
      const nIn = own.length ? Math.floor(n * K.ZOMBIE_INDOOR) : 0;
      const w = streets.map((_, i) => {
        const d2 = (sx[i] - gx) ** 2 + (sy[i] - gy) ** 2;
        return d2 > R2 ? 0 : Math.exp(-d2 / (2 * K.GZ_SPREAD ** 2));
      });
      let cells = rs.weighted(streets, w, n - nIn);
      if (nIn) cells = cells.concat(inBuildings(own, own.map(b => size[b]), nIn));
      for (const cell of cells) zpos.push(scatter(cell));
    }
    // Civilians: most shelter in buildings away from ground zero (some
    // buildings empty), the rest out on the streets.
    let far = [];
    streets.forEach((cell, i) => {
      if (this.groundZeros.every(([gx, gy]) => (sx[i] - gx) ** 2 + (sy[i] - gy) ** 2 > R2)) far.push(i);
    });
    let safe = [];
    for (let b = 1; b < nb; b++) {
      if (real[b] && !overrun[b] && this.groundZeros.every(([gx, gy]) => (bcx[b] - gx) ** 2 + (bcy[b] - gy) ** 2 > R2)) safe.push(b);
    }
    if (m?.civ_region) {
      const region = far.filter(i => this.regionOk(sx[i], sy[i], m.civ_region));
      if (region.length) far = region;
      const inside = safe.filter(b => this.regionOk(bcx[b], bcy[b], m.civ_region));
      if (inside.length) safe = inside;
    }
    if (!far.length) far = streets.map((_, i) => i);
    const occupied = safe.filter(() => rs.random() >= K.EMPTY_BUILDING_SHARE);
    const nCiv = P - nInf;
    const nIn = occupied.length ? Math.floor(nCiv * K.CIV_INDOOR) : 0;
    let cells = [];
    for (let k = 0; k < nCiv - nIn; k++) cells.push(streets[far[Math.floor(rs.random() * far.length)]]);
    if (nIn) cells = cells.concat(inBuildings(occupied, occupied.map(b => size[b] * rs.lognormal(0, 0.8)), nIn));
    const cpos = rs.shuffle(cells).map(scatter);

    // VIPs: civilians sheltering close to the mission's VIP point.
    const nVip = m?.vips || 0;
    this.vip = new Uint8Array(P);
    if (nVip) {
      let near = [];
      for (let cell = 0; cell < N_CELLS; cell++) {
        if (!c.open[cell]) continue;
        const x = cellX(cell), y = cellY(cell);
        if (!this.regionOk(x, y, m.vip_region || {})) continue;
        if (this.groundZeros.some(([gx, gy]) => hypot(x - gx, y - gy) <= K.VIP_GZ_CLEARANCE)) continue;
        near.push(cell);
      }
      if (!near.length) near = streets;
      for (let k = 0; k < nVip; k++) { cpos[k] = scatter(rs.pick(near)); this.vip[k] = 1; }
    }
    this.vipTotal = nVip; this.vipRescued = 0; this.vipLost = 0;
    this.infectRate = K.INFECT_RATE * (m?.infect_mult ?? 1) * diff.infect_rate;
    this.lzRate = K.LZ_RATE * (m?.lz_rate_mult ?? 1);
    this.barricadeCost = K.UNIT_SPECS.barricade.cost * (m?.barricade_cost_mult ?? 1);
    this.disabled = new Set(m?.disabled || []);
    this.buildZones = {};
    const zones = { ...(m?.build_zones || {}) };
    if (m?.lz_region && !zones.evac) zones.evac = m.lz_region;
    for (const [kind, spec] of Object.entries(zones)) {
      const z = new Uint8Array(N_CELLS);
      for (let cell = 0; cell < N_CELLS; cell++) z[cell] = this.regionOk(cellX(cell), cellY(cell), spec) ? 1 : 0;
      this.buildZones[kind] = z;
    }

    // Agents: struct of arrays.
    const all = cpos.concat(zpos);
    this.px = new Float64Array(P); this.py = new Float64Array(P);
    for (let i = 0; i < P; i++) { this.px[i] = all[i][0]; this.py[i] = all[i][1]; }
    this.state = new Int8Array(P);
    this.state.fill(ZOMBIE, P - nInf);
    this.speed = new Float64Array(P);
    for (let i = 0; i < P; i++) {
      this.speed[i] = i < P - nInf ? rs.uniform(...K.CIV_SPEED) * diff.civ_speed : rs.uniform(...this.zombieSpeed);
    }
    this.vx = new Float64Array(P); this.vy = new Float64Array(P);
    this.angle = new Float64Array(P).map(() => rs.uniform(0, TAU));
    this.busy = new Float32Array(P);
    this.incubate = new Float32Array(P);
    this.panic = new Float32Array(P);
    this.ammo = new Int8Array(P);
    const civ = [];
    for (let i = 0; i < P - nInf; i++) if (!this.vip[i]) civ.push(i);
    const armed = rs.shuffle(civ.slice()).slice(0, Math.max(1, Math.floor(civ.length * K.ARMED_FRACTION)));
    for (const i of armed) this.ammo[i] = rs.int(1, 3);
    this.aimHold = new Float32Array(P);
    this.traits = new Uint8Array(P);
    this.swim = c.hasWater && (m ? m.swimmers !== false : true);
    if (this.swim) {
      for (const i of civ) {
        if (rs.random() < K.SWIMMER_FRACTION) {
          this.traits[i] |= K.T_SWIMMER;
          if (rs.random() < K.DROWNER_FRACTION) this.traits[i] |= K.T_DROWNER;
        }
      }
    }
    for (const i of civ) if (rs.random() < K.CLUMSY_FRACTION) this.traits[i] |= K.T_CLUMSY;
    for (let i = P - nInf; i < P; i++) this.traits[i] = this.zombieTraits(rs);
    this.drownAt = new Float32Array(P).map(() => rs.uniform(...K.DROWN_AFTER));
    this.swimT = new Float32Array(P);
    this.episode = new Float32Array(P);
    this.episodeKind = new Int8Array(P);
    this.episodeCd = new Float32Array(P);
    this.rng = new Rng();
    this.totalHealthy = P - nInf;

    this.obst = new Int32Array(N_CELLS).fill(-1);
    this.lzOwner = new Int32Array(N_CELLS).fill(-1);
    this.contactOwner = new Int32Array(N_CELLS).fill(-1);
    this.walk = c.walk.slice();
    this.checkpoint = new Uint8Array(N_CELLS);
    this.evacFlow = this.evacDist = null;
    this.swimFlow = this.swimDist = null;
    this.swimWalk = new Uint8Array(N_CELLS).fill(1);
    this.swimBlock = new Uint8Array(N_CELLS);
    this.evacDirty = false;
    this.terrainDirty = false;
    this.lastRepath = 0;
    this.assist = new Uint8Array(N_CELLS);
    this.initTraffic(rs);
    this.trains = c.rails.map(pts => new Train(pts, rs));
    this.trainKills = 0;
    this.scentFlow = new Float32Array(2 * N_CELLS);
    this.nearScent = new Float32Array(2 * N_CELLS);
    this.farFlow = new Float32Array(2 * N_CELLS);
    this.scentRange = m?.scent_range || null;
    this.fleeFlow = new Float32Array(2 * N_CELLS);
    this.fieldTimer = 0;
    this.farTimer = 0;
    this.zdens = new Float32Array(N_HASH);
    this.cdens = new Float32Array(N_HASH);

    // per-step scratch
    this.ci = new Int32Array(P);
    this.hi = new Int32Array(P);
    this.velX = new Float64Array(P);
    this.velY = new Float64Array(P);
    this.exempt = new Uint8Array(P);
    this.occupancy = new Float32Array(N_CELLS);
    this.zcell = new Float32Array(N_CELLS);
    this.owner = new Int32Array(N_CELLS).fill(-1);
    this.carAt = new Int32Array(N_CELLS).fill(-1);

    this.units = new Map();
    this.nextId = 0;
    this.shells = []; this.bombers = []; this.effects = []; this.fires = []; this.drones = [];
    this.result = null;
    this.history = [];
    this.cp = m?.unlimited_cp ? 1e9 : this.params.cp;   // (finite, so spending still shows up as a change)
    this.rescued = this.infected = this.casualties = this.kills = 0;
    this.trojans = this.drowned = this.drownedZ = this.carriedOut = this.screened = 0;
    this.sheltered = 0;
    this.phase = "setup";
    this.paused = false;
    this.timeScale = 1;
    this.accum = 0;
    this.runTime = 0;
    this.quiet = 0;
    this.lastSig = null;
    this.message = ""; this.messageT = 0;
    this.soundEvents = [];
    this.resetId = (this.resetId || 0) + 1;
  }

  zombieTraits(rng) {
    let b = 0;
    if (rng.random() < K.LUNGER_FRACTION) b |= K.T_LUNGER;
    if (rng.random() < K.DISTRACTED_FRACTION) b |= K.T_DISTRACTED;
    return b;
  }

  // ---- traffic -----------------------------------------------------------

  initTraffic(rs) {
    const cells = this.city.cars, n = cells.length, P = this.P;
    this.nCars = n;
    const routes = n ? this.city.carRoutes() : null;
    this.carX = new Float64Array(n); this.carY = new Float64Array(n);
    this.carEdge = new Int8Array(n);
    this.carState = new Int8Array(n);
    this.carWait = new Float64Array(n).fill(Infinity);
    this.carSpeed = new Float64Array(n);
    this.carHeading = new Float64Array(n);
    this.carStuck = new Float64Array(n); this.carJam = new Float64Array(n); this.carUturn = new Float64Array(n);
    this.carClaim = new Int32Array(n).fill(-1);
    this.inCar = new Int32Array(P).fill(-1);
    this.runnerCar = new Int32Array(P).fill(-1);
    this.carSlow = new Uint8Array(N_CELLS);
    this.carsEscaped = this.carCrashes = this.roadkill = this.carEvacuated = 0;
    for (let k = 0; k < n; k++) {
      const cell = cells[k];
      this.carX[k] = cellX(cell); this.carY[k] = cellY(cell);
      let e = rs.int(0, 4);
      if (routes.dists[e][cell] >= FAR) {
        e = [0, 1, 2, 3].find(s => routes.dists[s][cell] < FAR) ?? -1;
      }
      this.carEdge[k] = e;
      this.carState[k] = e >= 0 ? K.CAR_PARKED : K.CAR_WRECK;
      this.carSpeed[k] = rs.uniform(...K.CAR_SPEED);
      this.carHeading[k] = rs.uniform(0, TAU);
      if (e >= 0) {
        const f = routes.flows[e];
        if (f[2 * cell] || f[2 * cell + 1]) this.carHeading[k] = Math.atan2(f[2 * cell + 1], f[2 * cell]);
      }
    }
    if (n) {
      let outdoor = [];
      for (let i = 0; i < P; i++) {
        if (this.state[i] === CIV && !this.vip[i] && this.ammo[i] === 0 && !this.city.indoor[cellOf(this.px[i], this.py[i])]) outdoor.push(i);
      }
      outdoor = rs.shuffle(outdoor);
      const usable = [];
      for (let k = 0; k < n; k++) if (this.carState[k] === K.CAR_PARKED) usable.push(k);
      const full = usable.filter(() => rs.random() < K.CAR_OCCUPIED);
      let seats = [];
      for (const k of full) { const r = rs.int(K.CAR_RIDERS[0], K.CAR_RIDERS[1] + 1); for (let j = 0; j < r; j++) seats.push(k); }
      seats = seats.slice(0, outdoor.length);
      const riders = outdoor.slice(0, seats.length);
      outdoor = outdoor.slice(seats.length);
      riders.forEach((i, j) => {
        this.state[i] = IN_CAR;
        this.inCar[i] = seats[j];
        this.px[i] = this.carX[seats[j]]; this.py[i] = this.carY[seats[j]];
      });
      const taken = new Set(seats);
      for (const k of [...taken].sort((a, b) => a - b)) this.carWait[k] = rs.uniform(...K.CAR_START);
      const empty = usable.filter(k => !taken.has(k));
      const runners = outdoor.slice(0, Math.floor(outdoor.length * K.RUNNER_FRACTION));
      if (runners.length && empty.length) {
        const d = runners.map(i => empty.map(k => hypot(this.px[i] - this.carX[k], this.py[i] - this.carY[k])));
        const order = runners.map((_, r) => r).sort((a, b) => Math.min(...d[a]) - Math.min(...d[b]));
        for (const r of order) {
          let j = 0;
          for (let q = 1; q < empty.length; q++) if (d[r][q] < d[r][j]) j = q;
          if (d[r][j] <= K.RUNNER_RANGE) {
            this.runnerCar[runners[r]] = empty[j];
            this.carClaim[empty[j]] = runners[r];
            for (const row of d) row[j] = Infinity;
          }
        }
      }
    }
    this.updateCarSlow();
  }

  updateCarSlow() {
    this.carVersion = (this.carVersion || 0) + 1;
    this.carSlow.fill(0);
    for (let k = 0; k < this.nCars; k++) {
      const s = this.carState[k];
      if (s === K.CAR_PARKED || s === K.CAR_WRECK || s === K.CAR_BURNT) this.carSlow[cellOf(this.carX[k], this.carY[k])] = 1;
    }
  }

  boardRunners() {
    for (let i = 0; i < this.P; i++) {
      const k = this.runnerCar[i];
      if (k < 0) continue;
      if (this.state[i] !== CIV || this.carState[k] !== K.CAR_PARKED) {
        this.carClaim[k] = -1;
        this.runnerCar[i] = -1;
        continue;
      }
      if (hypot(this.px[i] - this.carX[k], this.py[i] - this.carY[k]) < K.BOARD_RANGE) {
        this.state[i] = IN_CAR;
        this.inCar[i] = k;
        this.runnerCar[i] = -1;
        this.carClaim[k] = -1;
        this.carWait[k] = 0;
      }
    }
  }

  unload(cars, die = 0) {
    const set = new Set(cars), out = [];
    for (let i = 0; i < this.P; i++) {
      if (this.state[i] !== IN_CAR || !set.has(this.inCar[i])) continue;
      const k = this.inCar[i];
      this.state[i] = CIV;
      this.px[i] = clamp(this.carX[k] + this.rng.uniform(-2, 2), 0.01, WORLD_W - 0.01);
      this.py[i] = clamp(this.carY[k] + this.rng.uniform(-2, 2), 0.01, WORLD_H - 0.01);
      this.inCar[i] = -1;
      out.push(i);
    }
    if (die) for (const i of out) if (this.rng.random() < die) this.kill(i, true);
    return out;
  }

  evacuateByCar(cars) {
    const set = new Set(cars);
    let healthy = 0;
    for (let i = 0; i < this.P; i++) {
      if (this.state[i] !== IN_CAR || !set.has(this.inCar[i])) continue;
      if (this.incubate[i] > 0) this.carriedOut++;
      else healthy++;
      this.state[i] = RESCUED;
      this.incubate[i] = 0;
      this.inCar[i] = -1;
    }
    this.rescued += healthy;
    this.carEvacuated += healthy;
    this.cp += healthy * K.RESCUE_BONUS;
  }

  updateTraffic(dt, crowd, zcrowd, ci) {
    const n = this.nCars;
    if (!n) return;
    const st = this.carState, before = st.slice();
    this.boardRunners();
    for (let k = 0; k < n; k++) {
      if (st[k] === K.CAR_PARKED) {
        this.carWait[k] -= dt;
        if (this.carWait[k] <= 0) st[k] = K.CAR_DRIVING;
      }
      this.carUturn[k] = Math.max(this.carUturn[k] - dt, 0);
    }
    const drive = [];
    for (let k = 0; k < n; k++) if (st[k] === K.CAR_DRIVING) drive.push(k);
    if (drive.length) {
      const { flows, dists } = this.city.carRoutes();
      const m = drive.length;
      const cell = new Int32Array(m), ahead = new Int32Array(m), ahead2 = new Int32Array(m);
      const dX = new Float64Array(m), dY = new Float64Array(m), eOld = new Int8Array(m);
      let screech = false;
      for (let j = 0; j < m; j++) {
        const k = drive[j], x = this.carX[k], y = this.carY[k];
        const c = cellOf(x, y), cx = c % GW, cy = (c - cx) / GW;
        cell[j] = c;
        const e = eOld[j] = this.carEdge[k];
        const fl = flows[e];
        let tx = cx, ty = cy;
        for (let s = 0; s < K.CAR_LOOKAHEAD; s++) {
          const t = ty * GW + tx;
          tx = clamp(tx + Math.round(fl[2 * t]), 0, GW - 1);
          ty = clamp(ty + Math.round(fl[2 * t + 1]), 0, GH - 1);
        }
        let ax = (tx + 0.5) * CELL - x, ay = (ty + 0.5) * CELL - y;
        const an = hypot(ax, ay);
        if (an > 1e-6) { ax /= an; ay /= an; } else { ax = 0; ay = 0; }
        const aimX = ax * 4 * CELL - ay * K.CAR_LANE, aimY = ay * 4 * CELL + ax * K.CAR_LANE;
        const has = fl[2 * c] !== 0 || fl[2 * c + 1] !== 0;
        let h = this.carHeading[k];
        if (has) {
          const turn = ((Math.atan2(aimY, aimX) - h + Math.PI) % TAU + TAU) % TAU - Math.PI;
          h += clamp(turn, -K.CAR_TURN * dt, K.CAR_TURN * dt);
        }
        let ddx = Math.cos(h), ddy = Math.sin(h);
        let a1 = cellOf(x + ddx * CELL, y + ddy * CELL), a2 = cellOf(x + ddx * 2 * CELL, y + ddy * 2 * CELL);
        // Turn back from an overrun road: a route out the other way.
        if (zcrowd[a2] >= K.CAR_OVERRUN && this.carUturn[k] <= 0) {
          let best = -1, bv = Infinity;
          for (let s = 0; s < 4; s++) {
            const v = dists[s][c] >= FAR ? 1.0 : flows[s][2 * c] * ddx + flows[s][2 * c + 1] * ddy;
            if (v < bv) { bv = v; best = s; }
          }
          if (bv < -0.2) {
            this.carEdge[k] = best;
            h += Math.PI;
            ddx = -ddx; ddy = -ddy;
            this.carUturn[k] = K.CAR_UTURN_COOLDOWN;
            a1 = a2 = c;
            screech = true;
          }
        }
        this.carHeading[k] = h;
        dX[j] = ddx; dY[j] = ddy; ahead[j] = a1; ahead2[j] = a2;
      }
      if (screech) this.sound("tire_screech");
      const occ = new Map();
      for (let j = 0; j < m; j++) occ.set(cell[j], (occ.get(cell[j]) || 0) + 1);
      const gone = [], quit = [], crashes = [], fast = [];
      let horn = false;
      for (let j = 0; j < m; j++) {
        const k = drive[j], c = cell[j], a1 = ahead[j], a2 = ahead2[j];
        const nearCar = (occ.get(a1) || 0) - (a1 === c ? 1 : 0) > 0;
        const nextCar = (occ.get(a2) || 0) - (a2 === c ? 1 : 0) > 0;
        const squeeze = this.carSlow[a1] && !nearCar;
        const everyone = crowd[a1], zeds = zcrowd[a1], people = everyone - zeds;
        const crawl = people >= K.CAR_SLOWDOWN_CROWD;
        if (crawl) horn = true;
        const boost = zeds > 0 && people < 1;
        let speed = this.carSpeed[k] * (crawl ? K.CAR_CRAWL : boost ? K.CAR_RAM_BOOST : 1);
        speed = nearCar ? 0 : (nextCar || squeeze) ? speed * 0.4 : speed;
        const nx = this.carX[k] + dX[j] * speed * dt, ny = this.carY[k] + dY[j] * speed * dt;
        const out = nx < 0 || nx >= WORLD_W || ny < 0 || ny >= WORLD_H;
        const road = out || this.city.open[cellOf(nx, ny)];
        const fl = flows[eOld[j]];
        if (!road && (fl[2 * c] !== 0 || fl[2 * c + 1] !== 0)) this.carHeading[k] = Math.atan2(fl[2 * c + 1], fl[2 * c]);
        const crash = (everyone >= K.CAR_CRASH_CROWD || this.obst[a1] >= 0) && !out && !nearCar;
        const moved = road && !crash && speed > 0;
        if (moved) { this.carX[k] = nx; this.carY[k] = ny; }
        this.carJam[k] = nearCar && !crash ? this.carJam[k] + dt : 0;
        this.carStuck[k] = !road && !crash ? this.carStuck[k] + dt : 0;
        if (moved && out) gone.push(k);
        if (this.carStuck[k] > K.CAR_STUCK_TIME || this.carJam[k] > K.CAR_JAM_ABANDON) quit.push(k);
        if (crash) crashes.push([k, a1]);
        if (moved && !out && speed >= this.carSpeed[k] * 0.99) fast.push(k);
      }
      if (horn) this.sound("car_horn");
      if (gone.length) {
        for (const k of gone) st[k] = K.CAR_GONE;
        this.carsEscaped += gone.length;
        this.evacuateByCar(gone);
      }
      if (quit.length) {
        for (const k of quit) st[k] = K.CAR_WRECK;
        this.unload(quit);
      }
      for (const [k, c] of crashes) this.crashCar(k, c);
      this.runOver(fast, dt, ci);
    }
    for (let i = 0; i < this.P; i++) {
      if (this.state[i] === IN_CAR) { this.px[i] = this.carX[this.inCar[i]]; this.py[i] = this.carY[this.inCar[i]]; }
    }
    for (let k = 0; k < n; k++) if (st[k] !== before[k]) { this.updateCarSlow(); break; }
  }

  runOver(fast, dt, ci) {
    if (!fast.length) return;
    const carAt = this.carAt, touched = [];
    for (const k of fast) {
      const base = cellOf(this.carX[k], this.carY[k]);
      for (const off of NEIGHBOURS9) {
        const c = clamp(base + off, 0, N_CELLS - 1);
        carAt[c] = k;
        touched.push(c);
      }
    }
    const p = 1 - Math.exp(-K.CAR_HIT_RATE * dt);
    for (let i = 0; i < this.P; i++) {
      const k = carAt[ci[i]];
      if (k < 0 || this.state[i] > ZOMBIE) continue;
      const dx = this.px[i] - this.carX[k], dy = this.py[i] - this.carY[k];
      if (dx * dx + dy * dy < K.CAR_HIT_RADIUS ** 2 && this.rng.random() < p) this.kill(i, true);
    }
    for (const c of touched) carAt[c] = -1;
  }

  crashCar(k, cell) {
    this.carState[k] = K.CAR_WRECK;
    this.carCrashes++;
    this.unload([k]);
    const x = this.carX[k], y = this.carY[k];
    for (let i = 0; i < this.P; i++) {
      if (this.state[i] > ZOMBIE) continue;
      if ((this.px[i] - x) ** 2 + (this.py[i] - y) ** 2 < K.CAR_CRASH_RADIUS ** 2 && this.rng.random() < K.CAR_CRASH_KILL) this.kill(i, true);
    }
    const u = this.units.get(this.obst[cell]);
    if (u && u.hp !== null) {
      u.hp -= K.CAR_RAM_DAMAGE;
      u.last_hit = this.runTime;
      if (u.hp <= 0) {
        this.removeUnit(u);
        this.effect("ring", u.x, u.y, 0.9, { r: 25 });
        this.flashMessage(`${u.spec.name} wrecked by a car!`);
        this.sound("unit_destroyed");
      }
    }
    this.effect("ring", x, y, 0.6, { r: 8 });
    this.sound("tire_screech", "car_crash");
  }

  updateTrains(dt, ci) {
    for (const tr of this.trains) {
      if (tr.head === null) {
        tr.wait -= dt;
        if (tr.wait > 0) continue;
        tr.head = tr.dir > 0 ? 0 : tr.length;
        this.sound("train_horn");
      }
      tr.head += tr.dir * K.TRAIN_SPEED * dt;
      const tail = tr.head - tr.dir * K.TRAIN_LENGTH;
      if ((tr.dir > 0 && tail > tr.length) || (tr.dir < 0 && tail < 0)) {
        tr.head = null; tr.dir = -tr.dir; tr.wait = this.rng.uniform(...K.TRAIN_GAP);
        continue;
      }
      const body = tr.body();
      if (!body.length) continue;
      const hit = new Set();
      for (const [bx, by] of body) {
        const b = cellOf(bx, by);
        for (const off of NEIGHBOURS9) hit.add(clamp(b + off, 0, N_CELLS - 1));
      }
      const touching = (x, y) => body.some(([bx, by]) => (x - bx) ** 2 + (y - by) ** 2 < K.TRAIN_HALF_WIDTH ** 2);
      for (let i = 0; i < this.P; i++) {
        if (this.state[i] > ZOMBIE || !hit.has(ci[i])) continue;
        if (touching(this.px[i], this.py[i])) { this.trainKills++; this.kill(i, true); }
      }
      let smashed = false;
      for (let k = 0; k < this.nCars; k++) {
        const s = this.carState[k];
        if (s !== K.CAR_PARKED && s !== K.CAR_DRIVING && s !== K.CAR_WRECK) continue;
        if (!hit.has(cellOf(this.carX[k], this.carY[k])) || !touching(this.carX[k], this.carY[k])) continue;
        this.unload([k], 1.0);
        this.carState[k] = K.CAR_WRECK;
        this.effect("ring", this.carX[k], this.carY[k], 0.6, { r: 8 });
        this.sound("car_crash");
        smashed = true;
      }
      if (smashed) this.updateCarSlow();
      for (const u of [...this.units.values()]) {
        if (u.drop_t > 0 || u.kind === "chopper") continue;
        const pts = u.kind === "barricade" && u.cells ? u.cells.map(c => [cellX(c), cellY(c)]) : [[u.x, u.y]];
        if (pts.some(([x, y]) => touching(x, y))) {
          this.removeUnit(u);
          this.effect("ring", u.x, u.y, 0.9, { r: 25 });
          this.flashMessage(`${u.spec.name} hit by a train!`);
          this.sound("unit_destroyed");
        }
      }
    }
  }

  // ---- player actions ------------------------------------------------------

  effect(kind, x, y, life, kw = {}) {
    this.effects.push({ kind, x, y, life, t: life, x2: kw.x2 ?? 0, y2: kw.y2 ?? 0, r: kw.r ?? 0 });
  }

  flashMessage(text, t = 2.5, sound = "ui_alert") {
    this.message = text; this.messageT = t;
    this.sound(sound);
  }

  sound(...events) {
    if (this.soundEvents.length < 64) this.soundEvents.push(...events);
  }

  get lzs() { return [...this.units.values()].filter(u => u.kind === "evac"); }

  start() { if (this.phase === "setup") this.phase = "running"; }

  setSpeed(mult) {
    this.sound("ui_speed");
    this.timeScale = mult;
    this.paused = false;
    this.start();
  }

  togglePause() {
    if (this.phase === "setup") this.start();
    else if (this.phase === "running") {
      this.paused = !this.paused;
      this.sound(this.paused ? "ui_pause" : "ui_resume");
    }
  }

  addUnit(kind, x, y, cost, kw = {}) {
    const u = makeUnit(this.nextId++, kind, x, y, cost, kw);
    this.units.set(u.id, u);
    this.cp -= cost;
    this.history.push(["unit", u, cost]);
    if (K.DROP_KINDS.includes(kind) && this.phase !== "setup") {
      u.drop_t = K.DROP_TIME;
      this.sound("paradrop");
      return u;
    }
    if (kind === "evac") this.sound("vo_lz_established");
    this.register(u);
    return u;
  }

  register(u) {
    if (u.cells) {
      for (const c of u.cells) this.obst[c] = u.id;
      this.ejectZombies(u.cells);
      this.refreshObstacles();
    }
    if (u.zone) {
      for (const c of u.zone) this.lzOwner[c] = u.id;
      this.evacDirty = true;
    }
    if (u.hp !== null) this.rebuildContacts();
  }

  land(u) {
    u.drop_t = 0;
    const ci = cellIndex(u.x, u.y);
    if (u.kind === "infantry") u.cells = this.squadCells(ci, u.id);
    else if (u.kind === "evac") u.zone = this.lzCells(u.x, u.y);
    this.register(u);
    this.effect("ring", u.x, u.y, 0.5, { r: 10 });
    this.sound("paradrop_land", ...(u.kind === "evac" ? ["vo_lz_established"] : []));
  }

  refreshObstacles() {
    const w = this.city.walk;
    for (let c = 0; c < N_CELLS; c++) {
      this.walk[c] = this.obst[c] < 0 && w[c] ? 1 : 0;
      this.checkpoint[c] = this.obst[c] >= 0 ? 1 : 0;
    }
  }

  ejectZombies(cells) {
    const blocked = new Set(cells), walk = this.city.walk;
    const free = j => this.obst[j] < 0 && walk[j];
    for (let i = 0; i < this.P; i++) {
      if (this.state[i] !== ZOMBIE) continue;
      const zc = cellOf(this.px[i], this.py[i]);
      if (!blocked.has(zc)) continue;
      const cx = zc % GW, cy = (zc - cx) / GW;
      for (const r of [1, 2, 3]) {
        let best = -1, bd = Infinity;
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (cx + dx < 0 || cx + dx >= GW || cy + dy < 0 || cy + dy >= GH) continue;
            const j = (cy + dy) * GW + cx + dx;
            if (free(j) && dx * dx + dy * dy < bd) { bd = dx * dx + dy * dy; best = j; }
          }
        }
        if (best >= 0) { this.px[i] = cellX(best); this.py[i] = cellY(best); break; }
      }
    }
  }

  contactCells(u) {
    if (u.kind === "evac") return u.zone;
    if (u.cells) {
      const m = new Set(u.cells), ring = new Set();
      for (const c of u.cells) {
        const x = c % GW, y = (c - x) / GW;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (x + dx < 0 || x + dx >= GW || y + dy < 0 || y + dy >= GH) continue;
          const n = (y + dy) * GW + x + dx;
          if (!m.has(n)) ring.add(n);
        }
      }
      return [...ring].sort((a, b) => a - b);
    }
    return discCells(u.x, u.y, K.CONTACT_RADIUS);
  }

  rebuildContacts() {
    this.contactOwner.fill(-1);
    for (const u of this.units.values()) {
      if (u.hp !== null && u.built && u.drop_t <= 0) for (const c of this.contactCells(u) || []) this.contactOwner[c] = u.id;
    }
  }

  liveBuild() { return this.phase !== "setup"; }

  blueprintPlaced() {
    if (![...this.units.values()].some(u => u.kind === "engineer")) this.flashMessage("Blueprint placed - deploy ENGINEERS to build it", 4);
  }

  activate(u) {
    u.built = true; u.progress = 1; u.claimed = null;
    this.sound(u.kind === "barricade" ? "barricade_place" : "mine_arm");
    if (u.kind === "barricade") {
      u.cells = u.plan_cells.filter(c => this.obst[c] < 0 && this.lzOwner[c] < 0);
      for (const c of u.cells) this.obst[c] = u.id;
      this.ejectZombies(u.cells);
      this.refreshObstacles();
      this.rebuildContacts();
    }
    this.effect("ring", u.site[0], u.site[1], 0.6, { r: 14 });
  }

  sealExtension(x, y, ux, uy) {
    const indoor = this.city.indoor, walk = this.city.walk, step = CELL / 2;
    let t = 0;
    for (;;) {
      const px = x + ux * t, py = y + uy * t;
      if (t > K.SEAL_SNAP || !(px >= 0 && px < WORLD_W && py >= 0 && py < WORLD_H)) return null;
      const c = cellIndex(px, py);
      if (!walk[c]) return null;
      if (indoor[c]) break;
      t += step;
    }
    const limit = t + K.SEAL_MAX;
    while (t < limit) {
      const px = x + ux * (t + step), py = y + uy * (t + step);
      if (!(px >= 0 && px < WORLD_W && py >= 0 && py < WORLD_H) || !indoor[cellIndex(px, py)]) break;
      t += step;
    }
    return [x + ux * t, y + uy * t];
  }

  barricadeLine(x0, y0, x1, y1) {
    const L = hypot(x1 - x0, y1 - y0);
    const [ux, uy] = L > 1e-6 ? [(x1 - x0) / L, (y1 - y0) / L] : [1, 0];
    const a = this.sealExtension(x0, y0, -ux, -uy) || [x0, y0];
    const b = this.sealExtension(x1, y1, ux, uy) || [x1, y1];
    const cells = [...new Set(segmentCells(a[0], a[1], b[0], b[1], CELL * 1.05))].sort((p, q) => p - q);
    const placed = [], seal = [], skipped = [];
    const c = this.city;
    for (const cell of cells) {
      const free = this.lzOwner[cell] < 0 && this.obst[cell] < 0 && c.walk[cell];
      if (free && c.open[cell]) placed.push(cell);
      else if (free && c.indoor[cell]) seal.push(cell);
      else if (!free && c.walk[cell]) skipped.push(cell);
    }
    return { placed, seal, skipped, ends: [a, b] };
  }

  standby(kind) { return this.mission?.unlock_all ? 0 : Math.max(0, (K.UNLOCK_TIMES[kind] || 0) - this.runTime); }

  toolLocked(kind) {
    const wait = this.standby(kind);
    if (wait > 0 && !this.disabled.has(kind)) {
      this.flashMessage(`${K.UNIT_SPECS[kind].name} on standby - ${Math.ceil(wait)}s`);
      this.sound("ui_tool_locked");
      return true;
    }
    if (this.disabled.has(kind)) {
      this.flashMessage(`${K.UNIT_SPECS[kind].name} not ${this.mission?.tutorial ? "part of this lesson" : "authorised in this mission"}`);
      return true;
    }
    return false;
  }

  inZone(kind, cells) {
    const zone = this.buildZones[kind];
    if (!zone) return true;
    return Array.isArray(cells) ? cells.every(c => zone[c]) : !!zone[cells];
  }

  zoneRefused(kind) {
    const name = kind === "evac" ? "LZs" : K.UNIT_SPECS[kind].name[0] + K.UNIT_SPECS[kind].name.slice(1).toLowerCase() + "s";
    this.flashMessage(`${name} only inside the marked area`);
  }

  deployLine(kind, x0, y0, x1, y1) {
    if (this.phase === "over" || this.toolLocked(kind)) return;
    const spec = K.UNIT_SPECS[kind];
    [x1, y1] = clampSegment(x0, y0, x1, y1, spec.max_len);
    if (kind === "barricade") {
      const { placed, seal, ends } = this.barricadeLine(x0, y0, x1, y1);
      if (!placed.length) return this.flashMessage("No open street under that line");
      if (!this.inZone(kind, placed)) return this.zoneRefused(kind);
      const cost = Math.floor(placed.length * this.barricadeCost);
      if (cost > this.cp) return this.flashMessage(`Need ${cost} CP`);
      const hp = spec.hp + spec.hp_per_cell * placed.length;
      const cells = placed.concat(seal);
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      let mid = placed[0], bd = Infinity;
      for (const c of placed) { const d = hypot(cellX(c) - mx, cellY(c) - my); if (d < bd) { bd = d; mid = c; } }
      const kw = { x2: x1, y2: y1, ends, street: placed, seal, plan_cells: cells, hp, max_hp: hp, site: [cellX(mid), cellY(mid)] };
      if (this.liveBuild()) {
        this.addUnit(kind, x0, y0, cost, { ...kw, built: false });
        this.blueprintPlaced();
      } else {
        this.addUnit(kind, x0, y0, cost, { ...kw, cells });
        this.sound("barricade_place");
      }
    } else {
      if (hypot(x1 - x0, y1 - y0) < 20) return this.flashMessage("Drag a longer flight path");
      if (!this.inZone(kind, cellIndex(x0, y0))) return this.zoneRefused(kind);
      if (spec.cost > this.cp) return this.flashMessage(`Need ${spec.cost} CP`);
      this.cp -= spec.cost;
      const L = Math.max(1, hypot(x1 - x0, y1 - y0));
      const b = { x0, y0, length: L, ux: (x1 - x0) / L, uy: (y1 - y0) / L, spec, delay: spec.delay, dist: -90, next_drop: 0 };
      this.bombers.push(b);
      this.sound("bomber_flyby");
      this.history.push(["bomber", b, spec.cost]);
    }
  }

  lzCells(x, y) {
    return discCells(x, y, K.LZ_RADIUS).filter(c => this.city.open[c] && this.obst[c] < 0 && this.lzOwner[c] < 0);
  }

  squadCells(ci, uid = -1) {
    const cx = ci % GW, cy = (ci - cx) / GW, out = [];
    for (const dy of [-1, 0, 1]) for (const dx of [-1, 0, 1]) {
      if (cx + dx < 0 || cx + dx >= GW || cy + dy < 0 || cy + dy >= GH) continue;
      const c = (cy + dy) * GW + cx + dx;
      if (this.lzOwner[c] < 0 && (this.obst[c] < 0 || this.obst[c] === uid)) out.push(c);
    }
    return out;
  }

  deployPoint(kind, x, y) {
    if (this.phase === "over" || this.toolLocked(kind)) return;
    const spec = K.UNIT_SPECS[kind], cost = spec.cost;
    if (cost > this.cp) return this.flashMessage(`Need ${cost} CP`);
    const ci = cellIndex(x, y);
    if (!this.city.walk[ci] && kind !== "chopper" && kind !== "airstrike") return this.flashMessage("Can't deploy on water");
    if (!this.inZone(kind, ci)) return this.zoneRefused(kind);
    if (kind === "evac") {
      const zone = this.lzCells(x, y);
      if (!this.city.open[ci] || zone.length < K.LZ_MIN_CELLS) return this.flashMessage("LZ needs open ground");
      this.addUnit(kind, x, y, cost, { zone, credit: 0, lift_t: 0, load: [], offline: 0, hp: spec.hp, max_hp: spec.hp });
    } else if (kind === "airstrike") {
      this.cp -= cost;
      const s = { sx: x, sy: y - 400, x, y, t: spec.delay, total: spec.delay, radius: spec.blast, source: "airstrike" };
      this.shells.push(s);
      this.sound("airstrike_jet");
      this.history.push(["shell", s, cost]);
    } else if (kind === "infantry") {
      if (this.obst[ci] >= 0 || this.lzOwner[ci] >= 0) return this.flashMessage("Square is occupied");
      this.addUnit(kind, cellX(ci), cellY(ci), cost, { cells: this.squadCells(ci), hp: spec.hp, max_hp: spec.hp });
    } else if (kind === "chopper") {
      this.addUnit(kind, x, y, cost, { angle: Math.random() * TAU, px: x, py: y });
    } else if (kind === "mine") {
      const live = this.liveBuild();
      this.addUnit(kind, x, y, cost, { built: !live, site: [x, y] });
      if (live) this.blueprintPlaced();
    } else if (kind === "engineer") {
      this.addUnit(kind, x, y, cost, { hp: spec.hp, max_hp: spec.hp, state: "idle" });
    } else {
      const roof = !!this.city.indoor[ci];
      const u = this.addUnit(kind, x, y, cost, { hp: spec.hp, max_hp: spec.hp, rooftop: roof });
      if (roof) u.range = spec.range * K.ROOFTOP_RANGE;
    }
  }

  deployPath(kind, pts) {
    if (this.phase === "over" || this.toolLocked(kind)) return;
    const spec = K.UNIT_SPECS[kind];
    const route = [pts[0]];
    let total = 0;
    for (const p of pts.slice(1)) {
      const last = route[route.length - 1], d = hypot(p[0] - last[0], p[1] - last[1]);
      if (total + d > K.DRONE_MAX_PATH) break;
      route.push(p);
      total += d;
    }
    if (total < 20) return this.flashMessage("Drag a longer flight path");
    if (!this.inZone(kind, cellIndex(route[0][0], route[0][1]))) return this.zoneRefused(kind);
    if (spec.cost > this.cp) return this.flashMessage(`Need ${spec.cost} CP`);
    this.cp -= spec.cost;
    const d = new Drone(route);
    this.drones.push(d);
    this.sound("drone_launch");
    this.history.push(["drone", d, spec.cost]);
  }

  escortTargetAt(x, y) {
    let best = null, bd = 12;
    for (const u of this.units.values()) {
      if (K.ESCORTABLE.includes(u.kind) && u.built) {
        const d = hypot(x - u.x, y - u.y);
        if (d < bd) { best = ["unit", u.id]; bd = d; }
      }
    }
    let vj = -1, vd = Infinity;
    for (let i = 0; i < this.P; i++) {
      if (!this.vip[i] || this.state[i] !== CIV) continue;
      const d = hypot(this.px[i] - x, this.py[i] - y);
      if (d < vd) { vd = d; vj = i; }
    }
    if (vj >= 0 && vd < Math.min(bd, 10)) best = ["vip", vj];
    return best;
  }

  escortPos([kind, ref]) {
    if (kind === "unit") { const u = this.units.get(ref); return u ? [u.x, u.y] : null; }
    return this.state[ref] === CIV ? [this.px[ref], this.py[ref]] : null;
  }

  setEscort(choppers, target) {
    for (const u of choppers) { u.escort = target; u.dest = null; }
    if (choppers.length) this.flashMessage(choppers.length === 1 ? "Chopper escorting" : "Choppers escorting");
  }

  movables() { return [...this.units.values()].filter(u => K.MOVABLE.includes(u.kind)); }

  movableAt(x, y, radius = 12) {
    let best = null, bd = radius;
    for (const u of this.movables()) {
      const [ux, uy] = u.kind === "chopper" ? [u.px, u.py] : [u.x, u.y];
      const d = Math.min(hypot(x - ux, y - uy), hypot(x - u.x, y - u.y));
      if (d < bd) { best = u; bd = d; }
    }
    return best;
  }

  formationSlots(x, y, n, movers) {
    const ids = new Set(movers.map(u => u.id));
    const cells = discCells(x, y, 40 + 12 * n).filter(c => this.city.walk[c] && this.lzOwner[c] < 0
      && (this.obst[c] < 0 || ids.has(this.obst[c])));
    const scored = cells.map(c => [hypot(cellX(c) - x, cellY(c) - y) + 8 * this.city.indoor[c], c]);
    scored.sort((a, b) => a[0] - b[0]);
    const slots = [];
    for (const [, c] of scored) {
      const cx = cellX(c), cy = cellY(c);
      if (slots.every(([sx, sy]) => hypot(cx - sx, cy - sy) >= K.FORMATION_SPACING)) {
        slots.push([cx, cy]);
        if (slots.length === n) break;
      }
    }
    return slots;
  }

  groupMove(movers, x, y) {
    movers = movers.filter(u => this.units.has(u.id));
    if (!movers.length) return;
    const slots = this.formationSlots(x, y, movers.length, movers);
    if (!slots.length) return this.flashMessage("No room to form up there");
    let flow = null;
    if (movers.some(u => u.kind === "infantry")) {
      flow = flowField(bfs(this.city.walk, [cellIndex(...slots[0])], FAR, this.city.cost));
    }
    movers.sort((a, b) => hypot(a.x - x, a.y - y) - hypot(b.x - x, b.y - y));
    const free = slots.slice();
    for (const u of movers) {
      let j = 0;
      for (let q = 1; q < free.length; q++) {
        if (hypot(free[q][0] - u.x, free[q][1] - u.y) < hypot(free[j][0] - u.x, free[j][1] - u.y)) j = q;
      }
      const [sx, sy] = free[j];
      if (free.length > 1) free.splice(j, 1);
      if (u.kind === "chopper") { u.dest = [sx, sy]; u.escort = null; }
      else { u.order = [sx, sy]; u.order_flow = flow; u.blocked_t = 0; }
    }
  }

  canUndo() { return this.phase === "setup" || (this.phase === "running" && this.paused); }

  undo() {
    if (!this.canUndo()) return this.flashMessage("Undo: deploy phase or paused only");
    while (this.history.length) {
      const [kind, obj, cost] = this.history.pop();
      let name;
      if (kind === "unit" && this.units.has(obj.id)) { this.removeUnit(obj); name = obj.spec.name; }
      else if (kind === "shell" && this.shells.includes(obj)) { this.shells.splice(this.shells.indexOf(obj), 1); name = "AIRSTRIKE"; }
      else if (kind === "bomber" && this.bombers.includes(obj) && obj.next_drop === 0) { this.bombers.splice(this.bombers.indexOf(obj), 1); name = "BOMB RUN"; }
      else if (kind === "drone" && this.drones.includes(obj) && obj.dist === 0) { this.drones.splice(this.drones.indexOf(obj), 1); name = "LURE DRONE"; }
      else continue;
      this.cp += cost;
      return this.flashMessage(`Undo ${name} +${cost} CP`, 2.5, "ui_undo");
    }
    this.flashMessage("Nothing to undo");
  }

  removeNear(x, y) {
    let best = null, bd = 12;
    for (const u of this.units.values()) {
      let d;
      if (u.kind === "barricade") d = pointSegmentDist(x, y, u.x, u.y, u.x2, u.y2);
      else if (u.kind === "evac") d = Math.max(0, hypot(x - u.x, y - u.y) - K.LZ_RADIUS + 6);
      else d = hypot(x - u.x, y - u.y);
      if (d < bd) { best = u; bd = d; }
    }
    if (!best) return;
    this.removeUnit(best);
    if (this.phase === "setup") this.cp += best.cost;
    else this.flashMessage(`${best.spec.name} withdrawn (no refund)`);
  }

  removeUnit(u) {
    this.units.delete(u.id);
    if (u.cells) {
      for (const c of u.cells) if (this.obst[c] === u.id) this.obst[c] = -1;
      this.refreshObstacles();
    }
    if (u.zone) {
      for (const c of u.zone) if (this.lzOwner[c] === u.id) this.lzOwner[c] = -1;
      this.evacDirty = true;
    }
    if (u.hp !== null) this.rebuildContacts();
  }

  rebuildEvac() {
    const src = [];
    for (let c = 0; c < N_CELLS; c++) if (this.lzOwner[c] >= 0) src.push(c);
    if (src.length) {
      this.evacDist = bfs(this.city.walk, src, FAR, this.city.cost);
      this.evacFlow = flowField(this.evacDist);
      if (this.swim) {
        const cost = this.city.cost.slice();
        for (let c = 0; c < N_CELLS; c++) {
          if (this.city.water[c]) cost[c] = K.SWIM_COST;
          this.swimBlock[c] = this.city.indoor[c] || this.city.water[c] ? 1 : 0;
        }
        this.swimDist = bfs(this.swimWalk, src, FAR, cost);
        this.swimFlow = flowField(this.swimDist);
      }
    } else {
      this.evacDist = this.evacFlow = this.swimDist = this.swimFlow = null;
    }
    this.evacDirty = false;
  }

  // ---- simulation ------------------------------------------------------------

  advance(realDt) {
    if (this.messageT > 0) this.messageT -= realDt;
    if (this.phase === "setup" || this.paused) return;
    for (const fx of this.effects) fx.t -= realDt;
    this.effects = this.effects.filter(fx => fx.t > 0);
    if (this.phase !== "running") return;
    this.accum += Math.min(realDt, 0.1) * this.timeScale;
    const dt = this.timeScale >= 4 ? K.FAST_SIM_DT : K.SIM_DT;
    let steps = 0;
    while (this.accum >= dt && this.phase === "running") {
      this.step(dt);
      this.accum -= dt;
      if (++steps >= K.MAX_STEPS_PER_FRAME) { this.accum = 0; break; }
    }
  }

  refreshFields(healthy, zom) {
    const c = this.city, ci = this.ci;
    const scent = bfs(c.walk, healthy.map(i => ci[i]), K.SCENT_RANGE, c.cost);
    flowField(scent, this.nearScent);
    const d = bfs(c.walk, zom.map(i => ci[i]), K.FLEE_RANGE, c.cost);
    const cost = new Int32Array(N_CELLS);
    for (let k = 0; k < N_CELLS; k++) cost[k] = c.walk[k] ? -Math.min(d[k], K.FLEE_RANGE + 1) : FAR;
    flowField(cost, this.fleeFlow);
    this.mergeScent();
  }

  mergeScent() {
    if (!this.scentRange) { this.scentFlow = this.nearScent; return; }
    if (this.scentFlow === this.nearScent) this.scentFlow = new Float32Array(2 * N_CELLS);
    const n = this.nearScent, f = this.farFlow, out = this.scentFlow;
    for (let c = 0; c < N_CELLS; c++) {
      const near = n[2 * c] !== 0 || n[2 * c + 1] !== 0;
      out[2 * c] = near ? n[2 * c] : f[2 * c];
      out[2 * c + 1] = near ? n[2 * c + 1] : f[2 * c + 1];
    }
  }

  step(dt) {
    if (this.evacDirty || (this.terrainDirty && this.runTime - this.lastRepath >= K.TERRAIN_REPATH)) {
      this.rebuildEvac();
      this.terrainDirty = false;
      this.lastRepath = this.runTime;
    }
    if (!this.mission?.tutorial) for (const [t, what] of K.UNLOCK_NEWS) {
      if (this.runTime < t && t <= this.runTime + dt) {
        this.flashMessage(`${what} NOW AVAILABLE`, 4);
        this.sound("ui_unlock", `vo_unlock_${t}`);
      }
    }
    this.runTime += dt;
    const P = this.P, st = this.state, px = this.px, py = this.py, ci = this.ci, hi = this.hi;
    const civ = [], healthy = [], zom = [];
    const zc = new Float32Array(N_HASH), cc = new Float32Array(N_HASH);
    const occ = this.occupancy.fill(0);
    for (let i = 0; i < P; i++) {
      const c = cellOf(px[i], py[i]);
      ci[i] = c;
      const cx = c % GW, cy = (c - cx) / GW;
      const h = hi[i] = ((cy / HC) | 0) * HW + ((cx / HC) | 0);
      if (st[i] === CIV) {
        civ.push(i);
        if (this.incubate[i] <= 0) healthy.push(i);
        cc[h]++; occ[c]++;
      } else if (st[i] === ZOMBIE) {
        zom.push(i);
        zc[h]++; occ[c]++;
      }
    }
    box3(zc, HW, HH, this.zdens);
    box3(cc, HW, HH, this.cdens);
    const crowd = box3(occ, GW, GH);

    this.fieldTimer -= dt;
    if (this.fieldTimer <= 0) {               // zombies only smell the uninfected
      this.refreshFields(healthy, zom);
      this.fieldTimer = K.FIELD_REFRESH;
    }
    if (this.scentRange) {
      this.farTimer -= dt;
      if (this.farTimer <= 0) {
        flowField(bfs(this.city.walk, healthy.map(i => ci[i]), this.scentRange, this.city.cost), this.farFlow);
        this.mergeScent();
        this.farTimer = K.FAR_SCENT_REFRESH;
      }
    }
    this.updateTraits(civ, zom, dt);

    this.assist.fill(0);
    for (const u of this.units.values()) {
      if (u.kind === "engineer") for (const c of discCells(u.x, u.y, K.ASSIST_RADIUS)) this.assist[c] = 1;
    }
    if (civ.length) this.civilianVelocity(civ, crowd, dt);
    if (zom.length) this.zombieVelocity(zom, zc, crowd, dt);

    // Civilians pass checkpoints (slowly) and keep to the streets unless
    // their route leads indoors; swimmers enter water only on their route.
    const city = this.city, velX = this.velX, velY = this.velY, ex = this.exempt;
    for (const i of civ) {
      if (this.swim && (this.traits[i] & K.T_SWIMMER)) this.moveAgent(i, velX[i] * dt, velY[i] * dt, this.swimWalk, this.swimBlock, ex[i]);
      else this.moveAgent(i, velX[i] * dt, velY[i] * dt, city.walk, city.indoor, ex[i] & 1);
    }
    // Zombies stick to streets: they enter a building only when their scent path leads in.
    const sf = this.scentFlow;
    for (const i of zom) {
      const c = ci[i], fx = sf[2 * c], fy = sf[2 * c + 1];
      const cx = c % GW, cy = (c - cx) / GW;
      const t = clamp(cy + Math.round(fy), 0, GH - 1) * GW + clamp(cx + Math.round(fx), 0, GW - 1);
      const pathIn = city.indoor[t] && (fx !== 0 || fy !== 0);
      const bx = px[i], by = py[i];
      this.moveAgent(i, velX[i] * dt, velY[i] * dt, this.walk, city.indoor, pathIn);
      this.vx[i] = (px[i] - bx) / dt;
      this.vy[i] = (py[i] - by) / dt;
    }
    this.waterHazards(civ, zom, dt);
    const zcell = this.zcell.fill(0);
    for (const i of zom) zcell[ci[i]]++;
    const zcrowd = box3(zcell, GW, GH);
    this.updateTraffic(dt, crowd, zcrowd, ci);
    if (this.trains.length) this.updateTrains(dt, ci);

    // Infection: civilians sharing a nav cell with an active zombie.
    for (let i = 0; i < P; i++) ci[i] = cellOf(px[i], py[i]);
    let active = zom.filter(i => this.busy[i] <= 0);
    for (let i = 0; i < P; i++) if (this.aimHold[i] > 0) this.aimHold[i] = Math.max(this.aimHold[i] - dt, 0);
    if (active.length) {
      let shot = false;
      for (const i of civ) {
        if (this.ammo[i] <= 0 || st[i] !== CIV || this.zdens[hi[i]] <= 0) continue;
        let j = -1, bd = Infinity;
        for (const z of active) {
          const d2 = (px[z] - px[i]) ** 2 + (py[z] - py[i]) ** 2;
          if (d2 < bd) { bd = d2; j = z; }
        }
        if (j >= 0 && bd < K.ARMED_RANGE ** 2 && st[j] === ZOMBIE) {     // concealed carry
          this.kill(j);
          this.ammo[i]--;
          this.aimHold[i] = K.ARMED_PAUSE;
          this.panic[i] = K.ARMED_PAUSE + K.ARMED_FLEE_TIME;
          shot = true;
          this.effect("tracer", px[i], py[i], 0.1, { x2: px[j], y2: py[j] });
        }
      }
      if (shot) this.sound("pistol_shot");
      active = active.filter(z => st[z] === ZOMBIE);
    }
    for (let i = 0; i < P; i++) if (this.panic[i] > 0) this.panic[i] = Math.max(this.panic[i] - dt, 0);
    let turned = 0;
    for (const i of civ) {                    // incubating civilians turn when their timer runs out
      if (this.incubate[i] <= 0) continue;
      this.incubate[i] -= dt;
      if (this.incubate[i] <= 0) {
        st[i] = ZOMBIE;
        this.incubate[i] = 0;
        this.speed[i] = this.rng.uniform(...this.zombieSpeed);
        this.busy[i] = K.TURN_TIME;
        this.vx[i] = this.vy[i] = 0;
        this.traits[i] = this.zombieTraits(this.rng);
        this.episode[i] = 0; this.episodeKind[i] = 0;
        turned++;
      }
    }
    if (turned) this.sound("zombie_turn");
    const owner = this.owner;
    for (const z of active) owner[ci[z]] = z;
    const p = 1 - Math.exp(-this.infectRate * dt);
    let bitten = 0;
    for (const i of healthy) {
      const o = owner[ci[i]];
      if (o < 0 || st[i] !== CIV) continue;
      if (this.rng.random() < p) {
        if (this.vip[i]) this.vipLost++;
        this.incubate[i] = this.incubationTime();
        this.busy[o] = K.FEED_TIME;
        bitten++;
      }
    }
    for (const z of active) owner[ci[z]] = -1;
    this.infected += bitten;
    if (bitten) this.sound("civilian_scream");
    for (let i = 0; i < P; i++) if (this.busy[i] > 0) this.busy[i] = Math.max(this.busy[i] - dt, 0);

    this.damageUnits(active, dt);
    this.evacuate(civ, dt);
    this.updateUnits(dt);
    this.updateOrdnance(dt);
    this.checkEnd(dt);
  }

  updateTraits(civ, zom, dt) {
    const ep = this.episode, kind = this.episodeKind, cd = this.episodeCd, tr = this.traits, rng = this.rng;
    for (let i = 0; i < this.P; i++) {
      if (ep[i] > 0) ep[i] = Math.max(ep[i] - dt, 0);
      if (cd[i] > 0) cd[i] = Math.max(cd[i] - dt, 0);
      if (ep[i] <= 0) kind[i] = 0;
    }
    const onset = rate => rng.random() < 1 - Math.exp(-rate * dt);
    for (const i of civ) {
      if (ep[i] > 0 || !(tr[i] & K.T_CLUMSY) || !onset(K.CLUMSY_RATE)) continue;
      if (rng.random() < 0.5) { kind[i] = K.EP_STUMBLE; ep[i] = rng.uniform(...K.STUMBLE_TIME); }
      else { kind[i] = K.EP_CONFUSED; ep[i] = rng.uniform(...K.CONFUSED_TIME); }
    }
    const ns = this.nearScent, ci = this.ci;
    for (const i of zom) {
      if (ep[i] > 0) continue;
      const c = ci[i];
      if ((tr[i] & K.T_LUNGER) && cd[i] <= 0 && (ns[2 * c] !== 0 || ns[2 * c + 1] !== 0) && onset(K.LUNGE_RATE)) {
        kind[i] = K.EP_LUNGE; ep[i] = K.LUNGE_TIME; cd[i] = K.LUNGE_TIME + K.LUNGE_COOLDOWN;
        continue;
      }
      if ((tr[i] & K.T_DISTRACTED) && kind[i] === 0 && onset(K.DISTRACT_RATE)) {
        kind[i] = K.EP_DISTRACTED; ep[i] = rng.uniform(...K.DISTRACT_TIME);
      }
    }
  }

  incubationTime() {
    return this.rng.random() < K.LONG_INCUBATOR_CHANCE ? this.rng.uniform(...K.LONG_INCUBATION) : this.rng.uniform(...K.INCUBATION);
  }

  civilianVelocity(idx, crowd, dt) {
    const ci = this.ci, hi = this.hi, occ = this.occupancy, city = this.city;
    const ff = this.fleeFlow, sd = 1.5 * Math.sqrt(dt), rng = this.rng;
    const evac = this.evacDist !== null;
    let zgx = null, zgy = null;
    if (evac) [zgx, zgy] = gradient(this.zdens, HW, HH);
    const n = N_CELLS;
    for (const i of idx) {
      const c = ci[i];
      const a = this.angle[i] += rng.normal(0, sd);
      const wx = Math.cos(a), wy = Math.sin(a);
      let fx = ff[2 * c], fy = ff[2 * c + 1];
      const fleeing = fx !== 0 || fy !== 0;
      let bx = fleeing ? fx : wx * K.IDLE_WANDER, by = fleeing ? fy : wy * K.IDLE_WANDER;
      const running = this.panic[i] > 0 && fleeing;
      let rx = fx, ry = fy;                      // where this agent's path leads (for the indoor rule)
      if (evac) {
        const swimmer = this.swimFlow && (this.traits[i] & K.T_SWIMMER);
        const flow = swimmer ? this.swimFlow : this.evacFlow, dist = swimmer ? this.swimDist : this.evacDist;
        const reach = dist[c] < FAR;
        if (reach) { rx = flow[2 * c]; ry = flow[2 * c + 1]; }
        if (reach && !running) {
          const h = hi[i];
          let fearX = -zgx[h], fearY = -zgy[h];
          const fn = hypot(fearX, fearY);
          if (fn > 1e-6) { fearX /= fn; fearY /= fn; } else { fearX = fearY = 0; }
          if (this.lzOwner[c] >= 0) { bx = wx * K.IDLE_WANDER; by = wy * K.IDLE_WANDER; }
          else {
            let ex = flow[2 * c] + K.CIV_FEAR * fearX, ey = flow[2 * c + 1] + K.CIV_FEAR * fearY;
            const en = hypot(ex, ey);
            if (en > 1e-6) { ex /= en; ey /= en; } else { ex = ey = 0; }
            bx = ex; by = ey;
          }
        }
      }
      // spread out down the crowd gradient
      let gx = -(crowd[Math.min(c + 1, n - 1)] - crowd[Math.max(c - 1, 0)]);
      let gy = -(crowd[Math.min(c + GW, n - 1)] - crowd[Math.max(c - GW, 0)]);
      const gn = hypot(gx, gy);
      if (gn > 1e-6) { gx /= gn; gy /= gn; } else { gx = gy = 0; }
      const k = K.CIV_SPREAD * Math.min(1, occ[c] / K.CELL_CAPACITY);
      let dx = bx + k * gx, dy = by + k * gy;
      const dn = Math.max(hypot(dx, dy), 1);
      dx /= dn; dy /= dn;
      const ep = this.episodeKind[i];
      if (ep === K.EP_CONFUSED) { dx = -dx; dy = -dy; }
      const rc = this.runnerCar[i];
      if (rc >= 0) {
        dx = this.carX[rc] - this.px[i]; dy = this.carY[rc] - this.py[i];
        const r = hypot(dx, dy);
        if (r > 1e-6) { dx /= r; dy /= r; } else { dx = dy = 0; }
      }
      let factor = clamp(K.CELL_CAPACITY / Math.max(occ[c], 1), K.CROWD_MIN, 1);
      if (ep === K.EP_STUMBLE) factor *= K.STUMBLE_SPEED;
      if (rc >= 0) factor = Math.max(factor, 0.6) * K.RUNNER_SPEED;
      if (city.water[c]) factor *= K.SWIM_SPEED;
      if (this.checkpoint[c]) factor *= this.assist[c] ? K.CHECKPOINT_ASSISTED : K.CHECKPOINT_SPEED;
      if (city.indoor[c]) factor *= K.INDOOR_SPEED;
      if (this.carSlow[c]) factor *= K.CAR_SLOW;
      if (this.aimHold[i] > 0) factor = 0;
      if (running) factor *= K.ARMED_FLEE_BOOST;
      this.velX[i] = dx * this.speed[i] * factor;
      this.velY[i] = dy * this.speed[i] * factor;
      // may this agent step into a building / the water? only if its route leads there
      const cx = c % GW, cy = (c - cx) / GW;
      const t = clamp(cy + Math.round(ry), 0, GH - 1) * GW + clamp(cx + Math.round(rx), 0, GW - 1);
      const heading = rx !== 0 || ry !== 0;
      const inside = (city.indoor[t] && heading) || rc >= 0;
      this.exempt[i] = (inside ? 1 : 0) | (inside || (city.water[t] && heading) ? 2 : 0);
    }
    if (this.swim) for (const i of idx) if (this.traits[i] & K.T_SWIMMER) this.exempt[i] = this.exempt[i] >> 1;
  }

  zombieVelocity(idx, zc, crowd, dt) {
    const ci = this.ci, hi = this.hi, occ = this.occupancy, city = this.city, rng = this.rng;
    const svx = new Float32Array(N_HASH), svy = new Float32Array(N_HASH), spx = new Float32Array(N_HASH), spy = new Float32Array(N_HASH);
    for (const i of idx) {
      const h = hi[i];
      svx[h] += this.vx[i]; svy[h] += this.vy[i]; spx[h] += this.px[i]; spy[h] += this.py[i];
    }
    const bvx = box3(svx, HW, HH), bvy = box3(svy, HW, HH), bpx = box3(spx, HW, HH), bpy = box3(spy, HW, HH);
    const nbs = this.zdens, sf = this.scentFlow, sd = 2.0 * Math.sqrt(dt), n = N_CELLS;
    const drones = this.phase === "running" ? this.drones.map(d => d.pos) : [];
    const steer = Math.min(1, K.BOID_STEER * dt);
    for (const i of idx) {
      const h = hi[i], c = ci[i], x = this.px[i], y = this.py[i];
      const nb = nbs[h];
      let ax = bvx[h], ay = bvy[h];
      const an = hypot(ax, ay);
      if (an > 1e-6) { ax /= an; ay /= an; } else { ax = ay = 0; }
      let hx = (bpx[h] / nb - x) / (K.HASH * 1.5), hy = (bpy[h] / nb - y) / (K.HASH * 1.5);
      const hn = Math.max(hypot(hx, hy), 1);
      hx /= hn; hy /= hn;
      let gx = -(crowd[Math.min(c + 1, n - 1)] - crowd[Math.max(c - 1, 0)]);
      let gy = -(crowd[Math.min(c + GW, n - 1)] - crowd[Math.max(c - GW, 0)]);
      const gn = hypot(gx, gy);
      const sk = Math.min(1, occ[c] / K.CELL_CAPACITY);
      if (gn > 1e-6) { gx = gx / gn * sk; gy = gy / gn * sk; } else { gx = gy = 0; }
      const a = this.angle[i] += rng.normal(0, sd);
      const wx = Math.cos(a), wy = Math.sin(a);
      const ep = this.episodeKind[i];
      let kx = sf[2 * c], ky = sf[2 * c + 1];
      if (ep === K.EP_DISTRACTED) kx = ky = 0;
      for (const [dx, dy] of drones) {         // lure drones out-rank the smell of people
        const ox = dx - x, oy = dy - y, on = hypot(ox, oy);
        if (on < K.LURE_RADIUS) {
          if (on > 1e-6) { kx = ox / on * K.LURE_WEIGHT; ky = oy / on * K.LURE_WEIGHT; } else { kx = ky = 0; }
        }
      }
      let qx = K.BOID_SEEK * kx + K.BOID_ALIGN * ax + K.BOID_COHESION * hx + K.BOID_SEPARATION * gx + K.BOID_WANDER * wx;
      let qy = K.BOID_SEEK * ky + K.BOID_ALIGN * ay + K.BOID_COHESION * hy + K.BOID_SEPARATION * gy + K.BOID_WANDER * wy;
      const qn = hypot(qx, qy);
      if (qn > 1e-6) { qx /= qn; qy /= qn; } else { qx = qy = 0; }
      const surge = 1 + K.HORDE_SURGE * Math.min(1, (nb - 1) / K.HORDE_SIZE);
      let speed = this.busy[i] <= 0 ? this.speed[i] * surge : 0;
      if (ep === K.EP_LUNGE) speed *= K.LUNGE_SPEED;
      let factor = clamp(K.CELL_CAPACITY * 1.5 / Math.max(occ[c], 1), K.CROWD_MIN, 1);
      if (city.indoor[c]) factor *= K.INDOOR_SPEED;
      if (this.carSlow[c]) factor *= K.CAR_SLOW;
      const tx = qx * speed * factor, ty = qy * speed * factor;
      this.velX[i] = this.vx[i] + (tx - this.vx[i]) * steer;
      this.velY[i] = this.vy[i] + (ty - this.vy[i]) * steer;
    }
  }

  /** Move an agent over a walkable mask, sliding along walls. Cells in
   *  `noEnter` can't be entered from outside them unless `exempt`. */
  moveAgent(i, dx, dy, walk, noEnter, exempt) {
    const x0 = this.px[i], y0 = this.py[i];
    const nx = clamp(x0 + dx, 0.01, WORLD_W - 0.01), ny = clamp(y0 + dy, 0.01, WORLD_H - 0.01);
    const cur = cellOf(x0, y0), free = noEnter[cur] || exempt;   // free: may enter noEnter cells
    let c = cellOf(nx, ny);
    if (!walk[cur] || (walk[c] && (free || !noEnter[c]))) { this.px[i] = nx; this.py[i] = ny; return; }
    c = cellOf(nx, y0);
    if (walk[c] && (free || !noEnter[c])) { this.px[i] = nx; return; }
    c = cellOf(x0, ny);
    if (walk[c] && (free || !noEnter[c])) { this.py[i] = ny; return; }
    this.angle[i] = this.rng.uniform(0, TAU);
  }

  waterHazards(civ, zom, dt) {
    const water = this.city.water;
    if (this.swim) {
      let splash = false;
      const gone = [];
      for (const i of civ) {
        if (this.state[i] !== CIV || !water[this.ci[i]]) continue;
        if (this.swimT[i] === 0) splash = true;
        this.swimT[i] += dt;
        if ((this.traits[i] & K.T_DROWNER) && this.swimT[i] >= this.drownAt[i]) gone.push(i);
      }
      if (splash) this.sound("splash");
      if (gone.length) {
        for (const i of gone) {
          this.drowned++;
          if (this.vip[i]) this.vipLost++;
          this.state[i] = DEAD;
          this.incubate[i] = 0;
        }
        this.splash(gone);
      }
    }
    if (!zom.length || !this.city.hasWater) return;
    const p = 1 - Math.exp(-K.HORDE_DROWN_RATE * dt), fall = [];
    for (const i of zom) {
      if (this.state[i] !== ZOMBIE || this.occupancy[this.ci[i]] < K.DROWN_PRESSURE) continue;
      const vx = this.velX[i], vy = this.velY[i], want = hypot(vx, vy);
      if (want <= 0.5) continue;
      const got = hypot(this.vx[i], this.vy[i]);
      if (got >= K.DROWN_PINNED * want) continue;
      const ax = this.px[i] + vx / want * CELL, ay = this.py[i] + vy / want * CELL;
      if (!water[cellOf(ax, ay)] || this.rng.random() >= p) continue;
      this.px[i] = clamp(ax, 0, WORLD_W - 0.01);
      this.py[i] = clamp(ay, 0, WORLD_H - 0.01);
      fall.push(i);
    }
    if (fall.length) {
      this.drownedZ += fall.length;
      for (const i of fall) this.kill(i);
      this.splash(fall);
    }
  }

  splash(idx) {
    for (const i of idx.slice(0, 6)) this.effect("splash", this.px[i], this.py[i], 0.8, { r: 6 });
    this.sound("drown");
  }

  evacuate(civ, dt) {
    const ci = this.ci, byLz = new Map();
    for (const i of civ) {
      if (this.state[i] !== CIV) continue;
      const o = this.lzOwner[ci[i]];
      if (o >= 0) { if (!byLz.has(o)) byLz.set(o, []); byLz.get(o).push(i); }
    }
    for (const u of this.lzs) {
      if (u.offline > 0) {                   // chopper down: the crowd waits for a new one
        u.offline -= dt;
        u.credit = 0;
        if (u.offline <= 0) {
          this.flashMessage("Replacement helicopter on station");
          this.effect("ring", u.x, u.y, 0.8, { r: K.LZ_RADIUS });
          this.sound("lz_lift");
        }
        continue;
      }
      u.lift_t += dt;
      if (u.lift_t >= K.LZ_LIFT_TIME) { u.lift_t = 0; u.load = []; }
      u.credit = Math.min(u.credit + this.lzRate * dt, this.lzRate);
      const here = byLz.get(u.id) || [];
      let k = Math.min(Math.floor(u.credit), here.length);
      if (!k) continue;
      let lifted = this.rng.shuffle(here.slice()).slice(0, k);
      if (u.guarded && lifted.some(i => this.incubate[i] > 0 && this.incubate[i] < K.SYMPTOM_TIME)) {
        const keep = [];
        for (const i of lifted) {            // the squad stops them at the door
          const inc = this.incubate[i];
          if (inc > 0 && inc < K.SYMPTOM_TIME) {
            this.state[i] = DEAD; this.incubate[i] = 0;
            this.screened++;
            this.effect("tracer", u.x, u.y, 0.1, { x2: this.px[i], y2: this.py[i] });
          } else keep.push(i);
        }
        this.sound("infantry_fire");
        lifted = keep;
        k = lifted.length;
        if (!k) continue;
      }
      if (lifted.some(i => this.incubate[i] > 0 && this.incubate[i] <= K.TROJAN_FLIGHT_TIME)) {
        this.trojanHorse(u, lifted);
        continue;
      }
      const healthy = [];
      for (const i of lifted) {
        if (this.incubate[i] > 0) this.carriedOut++;   // turns after landing: out, but infected
        else { healthy.push(i); if (this.vip[i]) this.vipRescued++; }
        this.state[i] = RESCUED;
        this.incubate[i] = 0;
      }
      u.credit -= k;
      u.load.push(healthy);
      this.rescued += healthy.length;
      this.cp += healthy.length * K.RESCUE_BONUS;
      if (healthy.length) this.sound("lz_lift");
    }
  }

  trojanHorse(u, lifted) {
    const boarded = u.load.flat();
    this.rescued -= boarded.length;
    this.cp -= boarded.length * K.RESCUE_BONUS;
    for (const i of boarded) if (this.vip[i]) this.vipRescued--;
    const victims = boarded.concat(lifted);
    for (const i of victims) {
      this.state[i] = DEAD; this.incubate[i] = 0;
      if (this.vip[i]) this.vipLost++;
    }
    this.casualties += victims.length;
    this.cp = Math.max(0, this.cp - K.TROJAN_PENALTY);
    this.trojans++;
    u.offline = K.LZ_REPLACE_TIME; u.load = []; u.lift_t = 0; u.credit = 0;
    this.effect("boom", u.x, u.y, 1.2, { r: K.LZ_RADIUS });
    this.effect("ring", u.x, u.y, 1.2, { r: 40 });
    this.flashMessage(`TROJAN HORSE - chopper down! Replacement inbound ${K.LZ_REPLACE_TIME}s, -${K.TROJAN_PENALTY} CP`, 5);
    this.sound("trojan_crash", "vo_trojan");
  }

  damageUnits(active, dt) {
    const counts = new Map();
    for (const z of active) {
      const id = this.contactOwner[this.ci[z]];
      if (id >= 0) counts.set(id, (counts.get(id) || 0) + 1);
    }
    for (const [uid, cnt] of counts) {
      const u = this.units.get(uid);
      if (!u || u.hp === null) continue;
      const armor = u.kind === "infantry" ? 1 - K.REINFORCE_ARMOR * u.support
        : u.kind === "barricade" && u.defended ? K.DEFEND_ARMOR : 1;
      const n = u.kind === "barricade" ? Math.min(cnt, K.BARRICADE_ATTACKERS) : cnt;
      u.hp -= n * K.ZOMBIE_DPS * armor * dt;
      u.last_hit = this.runTime;
      if (u.hp <= 0) {
        this.removeUnit(u);
        if (u.kind === "barricade") {
          const [[ax, ay], [bx, by]] = u.ends;
          this.effect("ring", (ax + bx) / 2, (ay + by) / 2, 1.2, { r: 40 });
          this.flashMessage("Barricade breached!", 4);
          this.sound("barricade_breach", "vo_barricade_breached");
        } else {
          this.effect("ring", u.x, u.y, 0.9, { r: 25 });
          this.flashMessage(`${u.spec.name} destroyed!`);
          this.sound("unit_destroyed");
        }
      }
    }
  }

  /** Kill one agent (zombie or civilian). Civilians are collateral, or roadkill. */
  kill(i, roadkill = false) {
    const s = this.state[i];
    if (s > ZOMBIE) return;
    if (s === ZOMBIE) this.kills++;
    else {
      if (roadkill) this.roadkill++; else this.casualties++;
      if (this.vip[i]) this.vipLost++;
    }
    this.state[i] = DEAD;
    this.incubate[i] = 0;
  }

  explode(x, y, r, destroy = true) {
    const r2 = r * r;
    for (let i = 0; i < this.P; i++) {
      if (this.state[i] <= ZOMBIE && (this.px[i] - x) ** 2 + (this.py[i] - y) ** 2 < r2) this.kill(i);
    }
    this.effect("boom", x, y, 0.8, { r });
    this.sound(r >= 20 ? "explosion_large" : "explosion_small");
    let lost = 0;
    for (const u of [...this.units.values()]) {      // friendly fire hits your own units too
      if (u.drop_t > 0 || u.kind === "barricade") continue;
      const [ux, uy] = u.kind === "chopper" ? [u.px, u.py] : [u.x, u.y];
      if ((ux - x) ** 2 + (uy - y) ** 2 < r2) {
        this.removeUnit(u);
        if (u.kind === "mine" && u.built) this.fires.push({ x: u.x, y: u.y, r: K.FIRE_RADIUS, t: K.FIRE_TIME });
        else if (u.kind !== "mine") { lost++; this.effect("ring", ux, uy, 0.9, { r: 20 }); }
      }
    }
    if (lost) {
      this.flashMessage(`Friendly fire: ${lost} unit${lost > 1 ? "s" : ""} lost`, 3);
      this.sound("unit_destroyed", "vo_friendly_fire");
    }
    const hit = [];
    for (let k = 0; k < this.nCars; k++) {           // cars cook off (and can chain)
      const s = this.carState[k];
      if ((s === K.CAR_PARKED || s === K.CAR_DRIVING || s === K.CAR_WRECK) && (this.carX[k] - x) ** 2 + (this.carY[k] - y) ** 2 < r2) hit.push(k);
    }
    if (hit.length) {
      const set = new Set(hit);
      for (let i = 0; i < this.P; i++) {
        if (this.state[i] === IN_CAR && set.has(this.inCar[i])) {
          this.state[i] = DEAD; this.inCar[i] = -1; this.incubate[i] = 0;
          this.casualties++;
        }
      }
      for (const k of hit) {
        this.carState[k] = K.CAR_BURNT;
        const t = this.rng.uniform(...K.CAR_FUSE);
        this.shells.push({ sx: this.carX[k], sy: this.carY[k], x: this.carX[k], y: this.carY[k], t, total: t, radius: K.CAR_BLAST, source: "car" });
      }
      this.sound("car_alarm");
      this.updateCarSlow();
    }
    if (destroy && this.city.destroy(discCells(x, y, r))) {
      this.terrainDirty = true;
      this.sound("building_collapse");
      for (const u of this.units.values()) {         // roofs gone: lose the rooftop bonus
        if (u.rooftop && !this.city.indoor[cellIndex(u.x, u.y)]) { u.rooftop = false; u.range = u.spec.range; }
      }
    }
  }

  updateUnits(dt) {
    const zom = [];
    for (let i = 0; i < this.P; i++) if (this.state[i] === ZOMBIE) zom.push(i);
    const zx = new Float64Array(zom.length), zy = new Float64Array(zom.length);
    for (let q = 0; q < zom.length; q++) { zx[q] = this.px[zom[q]]; zy[q] = this.py[zom[q]]; }
    const zalive = new Uint8Array(zom.length).fill(1);
    const nearest = (x, y, rng) => {
      let j = -1, bd = rng * rng;
      for (let q = 0; q < zom.length; q++) {
        if (!zalive[q]) continue;
        const d2 = (zx[q] - x) ** 2 + (zy[q] - y) ** 2;
        if (d2 < bd) { bd = d2; j = q; }
      }
      return j;
    };
    const Z = { zx, zy, zalive, n: zom.length };
    const units = [...this.units.values()];
    const squads = units.filter(u => u.kind === "infantry");
    const lzs = units.filter(u => u.kind === "evac" && u.drop_t <= 0);
    for (const u of squads) u.screening = u.drop_t <= 0 && lzs.some(z => hypot(u.x - z.x, u.y - z.y) < K.SCREEN_LZ_RANGE);
    for (const z of lzs) z.guarded = squads.some(q => q.screening && hypot(q.x - z.x, q.y - z.y) < K.SCREEN_LZ_RANGE);
    const sick = [];
    for (let i = 0; i < this.P; i++) {
      if (this.state[i] === CIV && this.incubate[i] > 0 && this.incubate[i] < K.SYMPTOM_TIME) sick.push(i);
    }
    for (const u of squads) {
      u.support = Math.min(K.REINFORCE_MAX, squads.filter(o => o !== u && hypot(o.x - u.x, o.y - u.y) < K.REINFORCE_RADIUS).length);
    }
    for (const u of units) {
      if (u.kind === "barricade") {
        const [[ax, ay], [bx, by]] = u.ends;
        u.defended = squads.some(q => pointSegmentDist(q.x, q.y, ax, ay, bx, by) < K.DEFEND_RADIUS);
      }
    }
    for (const u of units) {
      if (!this.units.has(u.id)) continue;
      const k = u.kind, spec = u.spec;
      if (u.drop_t > 0) {                    // still descending: inactive
        u.drop_t -= dt;
        if (u.drop_t <= 0) this.land(u);
        continue;
      }
      if (k === "barricade" || k === "evac" || !u.built) continue;
      if (k === "engineer") { this.updateEngineer(u, dt, Z); continue; }
      if (k === "mine") {
        if (zom.length && zx.some((x, q) => zalive[q] && (x - u.x) ** 2 + (zy[q] - u.y) ** 2 < K.MINE_TRIGGER ** 2)) {
          this.removeUnit(u);
          this.sound("mine_ignite");
          this.explode(u.x, u.y, K.MINE_BLAST, false);
          this.fires.push({ x: u.x, y: u.y, r: K.FIRE_RADIUS, t: K.FIRE_TIME });
        }
        continue;
      }
      if (k === "chopper") {
        if (u.escort) {                      // follow the escorted unit / VIP
          const tgt = this.escortPos(u.escort);
          if (!tgt) { u.escort = null; this.flashMessage("Escort target lost - chopper holding"); }
          else u.dest = tgt;
        }
        if (u.dest) {
          const dx = u.dest[0] - u.x, dy = u.dest[1] - u.y, d = hypot(dx, dy), step = K.CHOPPER_SPEED * dt;
          if (d <= step) { u.x = u.dest[0]; u.y = u.dest[1]; u.dest = null; }
          else { u.x += dx / d * step; u.y += dy / d * step; }
        }
        u.angle += dt * 1.6;
        const orbit = u.escort ? K.ESCORT_ORBIT : spec.orbit;
        u.px = u.x + Math.cos(u.angle) * orbit;
        u.py = u.y + Math.sin(u.angle) * orbit;
      }
      if (k === "infantry") this.moveSquad(u, dt, Z);
      if (k === "sniper") {
        const j = nearest(u.x, u.y, u.range);
        u.aim = j >= 0 ? [zx[j], zy[j]] : null;
      }
      u.cooldown -= dt;
      if (u.cooldown > 0) continue;
      if (k === "infantry" && u.screening && sick.length) {     // LZ checkpoint: stop the sick
        let j = -1, bd = Infinity;
        for (const i of sick) {
          const d2 = (this.px[i] - u.x) ** 2 + (this.py[i] - u.y) ** 2;
          if (d2 < bd) { bd = d2; j = i; }
        }
        if (bd < K.SCREEN_RADIUS ** 2 && this.state[j] === CIV) { this.screenOut(u, j); continue; }
      }
      if (k === "sniper" || k === "infantry" || k === "chopper") {
        const [sx, sy] = k === "chopper" ? [u.px, u.py] : [u.x, u.y];
        let j;
        if (k === "chopper") {
          const cand = [];
          for (let q = 0; q < zom.length; q++) if (zalive[q] && (zx[q] - sx) ** 2 + (zy[q] - sy) ** 2 < u.range ** 2) cand.push(q);
          j = cand.length ? this.rng.pick(cand) : -1;
        } else j = nearest(sx, sy, u.range);
        if (j < 0) continue;
        u.cooldown = spec.cooldown;
        if (k === "infantry") u.cooldown /= 1 + K.REINFORCE_FIRE * u.support;
        let tx, ty;
        if (k === "chopper" && this.rng.random() > spec.hit_chance) {
          tx = zx[j] + this.rng.normal(0, 4); ty = zy[j] + this.rng.normal(0, 4);
        } else {
          zalive[j] = 0;
          this.kill(zom[j]);
          tx = zx[j]; ty = zy[j];
        }
        this.sound({ sniper: "sniper_shot", chopper: "minigun" }[k] || "infantry_fire");
        this.effect("tracer", sx, sy, k === "sniper" ? 0.12 : 0.06, { x2: tx, y2: ty });
      } else if (k === "artillery") {
        const tgt = this.artilleryTarget(u);
        if (tgt) {
          this.shells.push({ sx: u.x, sy: u.y, x: tgt[0], y: tgt[1], t: spec.shell_time, total: spec.shell_time, radius: spec.blast, source: "artillery" });
          this.sound("artillery_launch");
          u.cooldown = spec.cooldown;
        }
      }
    }
  }

  screenOut(u, i) {
    this.state[i] = DEAD; this.incubate[i] = 0;
    this.screened++;
    u.cooldown = u.spec.cooldown;
    this.effect("tracer", u.x, u.y, 0.1, { x2: this.px[i], y2: this.py[i] });
    this.sound("infantry_fire");
  }

  walkUnit(u, dx, dy, speed, dt) {
    const w = this.city.walk;
    const terrain = this.city.indoor[cellIndex(u.x, u.y)] ? K.INDOOR_SPEED : 1;
    const nx = clamp(u.x + dx * speed * terrain * dt, 0.5, WORLD_W - 0.5), ny = clamp(u.y + dy * speed * terrain * dt, 0.5, WORLD_H - 0.5);
    if (w[cellIndex(nx, ny)]) { u.x = nx; u.y = ny; }
    else if (w[cellIndex(nx, u.y)]) u.x = nx;
    else if (w[cellIndex(u.x, ny)]) u.y = ny;
  }

  headFor(u, flow, [gx, gy]) {
    const left = hypot(gx - u.x, gy - u.y) || 1e-6;
    const c = cellIndex(u.x, u.y);
    let dx = flow ? flow[2 * c] : 0, dy = flow ? flow[2 * c + 1] : 0;
    if (left < 30 || (dx === 0 && dy === 0)) { dx = (gx - u.x) / left; dy = (gy - u.y) / left; }
    return [dx, dy, left];
  }

  claimJob(u) {
    const open = [...this.units.values()].filter(b => !b.built && (b.claimed === null || !this.units.has(b.claimed) || b.claimed === u.id));
    if (!open.length) { u.job = u.job_flow = null; return null; }
    let job = open[0];
    for (const b of open) if (hypot(b.site[0] - u.x, b.site[1] - u.y) < hypot(job.site[0] - u.x, job.site[1] - u.y)) job = b;
    job.claimed = u.id; u.job = job.id;
    u.job_flow = flowField(bfs(this.city.walk, [cellIndex(...job.site)], FAR, this.city.cost));
    return job;
  }

  closeZombies(u, Z) {
    let n = 0, mx = 0, my = 0;
    for (let q = 0; q < Z.n; q++) {
      if (Z.zalive[q] && (Z.zx[q] - u.x) ** 2 + (Z.zy[q] - u.y) ** 2 < K.RETREAT_RADIUS ** 2) { n++; mx += Z.zx[q]; my += Z.zy[q]; }
    }
    return n ? [mx / n, my / n] : null;
  }

  updateEngineer(u, dt, Z) {
    const close = this.closeZombies(u, Z);
    if (close) {
      const n = hypot(u.x - close[0], u.y - close[1]) || 1;
      this.walkUnit(u, (u.x - close[0]) / n, (u.y - close[1]) / n, K.ENGINEER_FLEE_SPEED, dt);
      u.state = "fleeing";
      return;
    }
    if (u.order) {
      const [dx, dy, left] = this.headFor(u, u.order_flow, u.order);
      if (left < 1.5) u.order = u.order_flow = null;
      else { this.walkUnit(u, dx, dy, Math.min(K.SQUAD_SPEED, left / dt), dt); u.state = "moving"; return; }
    }
    let job = u.job !== null ? this.units.get(u.job) : null;
    if (!job || job.built) job = this.claimJob(u);
    u.state = "idle";
    if (job) {
      const [dx, dy, left] = this.headFor(u, u.job_flow, job.site);
      if (left > K.BUILD_RANGE) { this.walkUnit(u, dx, dy, K.SQUAD_SPEED, dt); u.state = "moving"; return; }
      u.state = "building";
      this.sound("engineer_build");
      job.progress += dt / K.BUILD_TIME;
      if (job.progress >= 1) { this.activate(job); u.job = u.job_flow = null; }
    }
    for (const b of this.units.values()) {   // patch up a damaged barricade nearby
      if (b.kind === "barricade" && b.built && b.hp < b.max_hp) {
        const [[ax, ay], [bx, by]] = b.ends;
        if (pointSegmentDist(u.x, u.y, ax, ay, bx, by) <= K.REPAIR_RADIUS) {
          b.hp = Math.min(b.max_hp, b.hp + K.REPAIR_RATE * dt);
          this.sound("engineer_repair");
          if (u.state === "idle") u.state = "repairing";
          break;
        }
      }
    }
  }

  moveSquad(u, dt, Z) {
    u.retreating = false;
    const ci = cellIndex(u.x, u.y);
    const terrain = this.city.indoor[ci] ? K.INDOOR_SPEED : 1;
    const close = this.closeZombies(u, Z);
    let dx, dy, speed;
    if (close) {
      dx = u.x - close[0]; dy = u.y - close[1];
      const n = hypot(dx, dy) || 1;
      dx /= n; dy /= n; speed = K.RETREAT_SPEED;
      u.retreating = true;
    } else if (u.order) {
      const [ox, oy] = u.order, left = hypot(ox - u.x, oy - u.y);
      if (left < 1.5) { u.order = u.order_flow = null; return; }
      dx = u.order_flow ? u.order_flow[2 * ci] : 0; dy = u.order_flow ? u.order_flow[2 * ci + 1] : 0;
      if (left < 30 || (dx === 0 && dy === 0)) { dx = (ox - u.x) / left; dy = (oy - u.y) / left; }
      speed = K.SQUAD_SPEED;
      if (left < speed * terrain * dt) speed = left / (terrain * dt);
    } else return;
    const step = speed * terrain * dt;
    let nx = clamp(u.x + dx * step, 0.5, WORLD_W - 0.5), ny = clamp(u.y + dy * step, 0.5, WORLD_H - 0.5);
    let nc = cellIndex(nx, ny);
    if (!this.city.walk[nc]) { u.blocked_t += dt; return; }
    if (this.obst[nc] >= 0 && this.obst[nc] !== u.id) {
      const sx = -dy * step, sy = dx * step, alt = cellIndex(u.x + sx, u.y + sy);
      if (this.city.walk[alt] && (this.obst[alt] === -1 || this.obst[alt] === u.id)) { nx = u.x + sx; ny = u.y + sy; nc = alt; }
      else {
        u.blocked_t += dt;
        if (u.blocked_t > 1.5 && !u.retreating) u.order = u.order_flow = null;
        return;
      }
    }
    u.blocked_t = 0;
    u.x = nx; u.y = ny;
    if (nc !== ci) this.relocateSquad(u, nc);
  }

  relocateSquad(u, ci) {
    for (const c of u.cells) if (this.obst[c] === u.id) this.obst[c] = -1;
    u.cells = this.squadCells(ci, u.id);
    for (const c of u.cells) this.obst[c] = u.id;
    this.ejectZombies(u.cells);
    this.refreshObstacles();
    this.rebuildContacts();
  }

  artilleryTarget(u) {
    let best = -Infinity, bk = -1;
    for (let k = 0; k < N_HASH; k++) {
      const hx = (k % HW + 0.5) * K.HASH, hy = (Math.floor(k / HW) + 0.5) * K.HASH;
      if ((hx - u.x) ** 2 + (hy - u.y) ** 2 >= u.range ** 2) continue;
      const score = this.zdens[k] - 3 * this.cdens[k];
      if (score > best) { best = score; bk = k; }
    }
    if (bk < 0 || best < 4) return null;
    return [(bk % HW + 0.5) * K.HASH, (Math.floor(bk / HW) + 0.5) * K.HASH];
  }

  updateOrdnance(dt) {
    const shells = this.shells;
    this.shells = [];                         // (explosions may queue new car cook-offs here)
    for (const s of shells) {
      if (s.source !== "car" && s.t > 0.8 && 0.8 >= s.t - dt) this.sound("shell_whistle");
      s.t -= dt;
      if (s.t > 0) this.shells.push(s);
      else {
        if (s.source === "car") this.sound("car_cookoff");
        this.explode(s.x, s.y, s.radius, s.source !== "car");
      }
    }
    let keep = [];
    for (const b of this.bombers) {
      if (b.delay > 0) { b.delay -= dt; keep.push(b); continue; }
      b.dist += b.spec.plane_speed * dt;
      if (b.next_drop === 0 && b.dist >= 0) this.sound("bomb_chain");
      while (b.next_drop <= Math.min(b.dist, b.length)) {
        this.explode(b.x0 + b.ux * b.next_drop, b.y0 + b.uy * b.next_drop, b.spec.blast);
        b.next_drop += b.spec.spacing;
      }
      if (b.dist < b.length + 120) keep.push(b);
    }
    this.bombers = keep;
    const p = 1 - Math.exp(-K.FIRE_KILL_RATE * dt);
    for (const f of this.fires) {             // incendiary pools burn anyone inside
      f.t -= dt;
      const r2 = f.r * f.r;
      for (let i = 0; i < this.P; i++) {
        if (this.state[i] <= ZOMBIE && (this.px[i] - f.x) ** 2 + (this.py[i] - f.y) ** 2 < r2 && this.rng.random() < p) this.kill(i);
      }
    }
    this.fires = this.fires.filter(f => f.t > 0);
    keep = [];
    for (const d of this.drones) {            // lure drones: fly, hover, detonate
      if (d.dist < d.length) d.dist = Math.min(d.length, d.dist + K.DRONE_SPEED * dt);
      else {
        d.hover += dt;
        if (d.hover >= K.DRONE_HOVER) {
          this.sound("drone_detonate");
          this.explode(...d.pos, K.DRONE_BLAST, false);
          continue;
        }
      }
      keep.push(d);
    }
    this.drones = keep;
  }

  checkEnd(dt) {
    if (this.phase === "over") return;
    const [nCiv, nZ] = this.counts();
    // (zombies drowning on their own isn't progress: it mustn't hold off the stalemate)
    const sig = `${this.rescued},${this.infected},${this.casualties},${this.kills - this.drownedZ}`;
    if (sig !== this.lastSig) { this.lastSig = sig; this.quiet = 0; }
    else this.quiet += dt;
    if (this.mission) return this.checkMission(nCiv, nZ);
    if (nCiv === 0 || nZ === 0 || this.quiet > K.STALEMATE_TIME) {
      this.finish(null, "");
      const evacPct = 100 * this.rescued / Math.max(1, this.totalHealthy);
      const change = this.progress.record(this.city.name, evacPct, this.difficulty);
      if (change) this.sound(change > 0 ? "threat_up" : "threat_down");
      this.lastResult = { evacPct, change, next: K.applyDifficulty(this.progress.params(), this.difficulty), level: this.progress.level };
    }
  }

  saveTarget() {
    const g = this.goal;
    if ("save_count" in g) return g.save_count;
    return Math.ceil((g.save_pct || 0) / 100 * this.totalHealthy);
  }

  checkMission(nCiv, nZ) {
    const g = this.goal, need = this.saveTarget(), vipsOk = this.vipRescued >= this.vipTotal;
    if (this.vipTotal && this.vipLost) return this.finish(false, "VIP LOST");
    if (this.mission.tutorial) return;   // the lesson's steps decide the outcome
    if ("max_collateral" in g && this.casualties > g.max_collateral) return this.finish(false, "COLLATERAL LIMIT EXCEEDED");
    if ("hold_min" in g && nCiv + this.rescued < g.hold_min * this.totalHealthy) return this.finish(false, "THE CITY HAS FALLEN");
    if ("survive" in g) {
      if (this.runTime >= g.survive) return this.finish(true, "THE LINE HELD");
      if (nCiv === 0) return this.finish(false, "THE CITY HAS FALLEN");
      return;
    }
    if (g.eradicate) {
      if (nZ === 0) return this.finish(true, "INFECTION ERADICATED");
      if (nCiv === 0 || this.quiet > K.STALEMATE_TIME) return this.finish(false, "THE INFECTION SPREAD");
      return;
    }
    if (vipsOk && this.rescued >= need && (need || this.vipTotal)) return this.finish(true, "EVACUATION COMPLETE");
    if (nZ === 0 && !this.vipTotal) {
      const ok = this.rescued + nCiv >= need;
      return this.finish(ok, ok ? "OUTBREAK CONTAINED" : "TOO FEW SURVIVORS");
    }
    if (nCiv === 0 || this.quiet > K.STALEMATE_TIME) return this.finish(false, vipsOk ? "EVACUATION TARGET MISSED" : "VIPS NOT EVACUATED");
  }

  objectiveProgress() {
    if (!this.mission) return [];
    const g = this.goal, rows = [];
    const [nCiv, nZ] = this.counts();
    if ("survive" in g) {
      const left = Math.max(0, g.survive - this.runTime);
      rows.push(["HOLD FOR", `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, "0")}`, "YELLOW"]);
    }
    if ("hold_min" in g) {
      const pct = 100 * (nCiv + this.rescued) / Math.max(1, this.totalHealthy);
      rows.push(["CITY ALIVE", `${pct.toFixed(0)}%/${(g.hold_min * 100).toFixed(0)}%`, "YELLOW"]);
    }
    if (g.eradicate) rows.push(["INFECTED LEFT", nZ, "RED"]);
    const need = this.saveTarget();
    if (need) rows.push(["EVAC TARGET", `${this.rescued}/${need}`, "YELLOW"]);
    if (this.vipTotal) rows.push(["VIPS OUT", `${this.vipRescued}/${this.vipTotal}`, "VIP"]);
    if ("max_collateral" in g) rows.push(["COLLAT LIMIT", `${this.casualties}/${g.max_collateral}`, "MAGENTA"]);
    return rows;
  }

  finish(success, reason) {
    this.sheltered = this.counts()[0];
    this.phase = "over";
    this.result = { success, reason };
    if (success === null) success = 100 * (this.rescued + this.sheltered) / Math.max(1, this.totalHealthy) >= 40;
    this.sound(...(success ? ["victory", "vo_mission_complete"] : ["defeat", "vo_city_fallen"]));
  }

  /** [healthy civilians, infected] - incubating civilians count as infected. */
  counts() {
    let civ = 0, z = 0, sick = 0;
    for (let i = 0; i < this.P; i++) {
      const s = this.state[i];
      if (s === CIV || s === IN_CAR) civ++;
      else if (s === ZOMBIE) z++;
      if (this.incubate[i] !== 0) sick++;
    }
    return [civ - sick, z + sick];
  }

  dragCost(kind, x0, y0, x1, y1) {
    const spec = K.UNIT_SPECS[kind];
    [x1, y1] = clampSegment(x0, y0, x1, y1, spec.max_len);
    if (kind === "barricade") return [Math.floor(this.barricadeLine(x0, y0, x1, y1).placed.length * this.barricadeCost), [x1, y1]];
    return [spec.cost, [x1, y1]];
  }
}

/** numpy.gradient of a w x h grid: [d/dx, d/dy]. */
function gradient(a, w, h) {
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      gx[i] = x === 0 ? a[i + 1] - a[i] : x === w - 1 ? a[i] - a[i - 1] : (a[i + 1] - a[i - 1]) / 2;
      gy[i] = y === 0 ? a[i + w] - a[i] : y === h - 1 ? a[i] - a[i - w] : (a[i + w] - a[i - w]) / 2;
    }
  }
  return [gx, gy];
}
