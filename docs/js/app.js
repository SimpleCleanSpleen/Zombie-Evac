// Window, layout, input, rendering, menus (a port of the reference `App`).
import * as K from "./consts.js";
import { COL, rgb, mix, UNIT_SPECS, UNIT_ORDER, UNIT_KEYS, CAMPAIGN, SPEEDS, OPTION_ITEMS, CONTROLS } from "./consts.js";
import { loadCity } from "./city.js";
import { Game, Progression } from "./game.js";
import { cellIndex, clamp, hypot } from "./grid.js";
import { Audio } from "./audio.js";
import { TUTORIALS, Tutor } from "./tutorial.js";

const { GW, CELL, WORLD_W, WORLD_H, CIV, ZOMBIE, DEAD } = K;
const FONT = '"DejaVu Sans Mono", "Noto Sans Mono", "Liberation Mono", "Ubuntu Mono", Consolas, Menlo, "Courier New", monospace';
const BASE_W = 1280, BASE_H = 720, PANEL_MIN = 380, PANEL_MAX = 620;
const TAU = 2 * Math.PI;
const c = (name, a = 1) => rgb(COL[name], a);
const ci = Math.floor;

function canvas(w, h) {
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, w); cv.height = Math.max(1, h);
  return cv;
}

// ---- drawing primitives (pygame-like: outlines drawn inside the shape) -----

function ring(g, x, y, r, color, lw = 0) {
  g.beginPath();
  if (lw) {
    g.arc(x, y, Math.max(0.5, r - lw / 2), 0, TAU);
    g.strokeStyle = color; g.lineWidth = lw; g.stroke();
  } else {
    g.arc(x, y, Math.max(0.5, r), 0, TAU);
    g.fillStyle = color; g.fill();
  }
}
function seg(g, x0, y0, x1, y1, color, lw = 1) {
  g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1);
  g.strokeStyle = color; g.lineWidth = lw; g.stroke();
}
function box(g, x, y, w, h, color, lw = 0) {
  if (lw) { g.strokeStyle = color; g.lineWidth = lw; g.strokeRect(x + lw / 2, y + lw / 2, w - lw, h - lw); }
  else { g.fillStyle = color; g.fillRect(x, y, w, h); }
}
function polygon(g, pts, color, lw = 0) {
  g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
  if (lw) { g.strokeStyle = color; g.lineWidth = lw; g.stroke(); } else { g.fillStyle = color; g.fill(); }
}

/** Tactical map symbols for each item type. */
function drawSymbol(g, kind, x, y, size, color, lw) {
  const k = Math.max(3, size);
  g.lineJoin = "miter";
  if (kind === "evac") {
    ring(g, x, y, k, color, lw);
    const h = ci(k * 0.5);
    seg(g, x - h, y - h, x - h, y + h, color, lw); seg(g, x + h, y - h, x + h, y + h, color, lw); seg(g, x - h, y, x + h, y, color, lw);
  } else if (kind === "sniper") {
    polygon(g, [[x, y - k], [x - k, y + ci(k * 0.8)], [x + k, y + ci(k * 0.8)]], color, lw);
    ring(g, x, y + ci(k * 0.2), Math.max(1, ci(k / 4)), color);
  } else if (kind === "artillery") {
    box(g, x - k, y - k, 2 * k, 2 * k, color, lw);
    ring(g, x, y, Math.max(1, ci(k / 3)), color);
  } else if (kind === "infantry") {
    const h = ci(k * 0.7);
    box(g, x - k, y - h, 2 * k, 2 * h, color, lw);
    seg(g, x - k, y - h, x + k - 1, y + h - 1, color, lw); seg(g, x - k, y + h - 1, x + k - 1, y - h, color, lw);
  } else if (kind === "barricade") {
    seg(g, x - k, y + ci(k / 2), x + k, y - ci(k / 2), color, Math.max(lw, ci(k / 2)));
  } else if (kind === "chopper") {
    ring(g, x, y, Math.max(2, ci(k / 2)), color, lw);
    seg(g, x - k, y - k, x + k, y + k, color, lw); seg(g, x - k, y + k, x + k, y - k, color, lw);
  } else if (kind === "airstrike") {
    ring(g, x, y, k, color, lw);
    seg(g, x - k - 2, y, x + k + 2, y, color, lw); seg(g, x, y - k - 2, x, y + k + 2, color, lw);
  } else if (kind === "bombing") {
    polygon(g, [[x + k, y], [x - k, y - ci(k * 0.8)], [x - ci(k / 3), y], [x - k, y + ci(k * 0.8)]], color, lw);
  } else if (kind === "engineer") {
    const h = ci(k * 0.7);
    box(g, x - k, y - h, 2 * k, 2 * h, color, lw);
    seg(g, x - ci(k / 2), y + ci(h / 3), x + ci(k / 2), y + ci(h / 3), color, lw);
    for (const dx of [-ci(k / 2), 0, ci(k / 2)]) seg(g, x + dx, y - ci(h / 3), x + dx, y + ci(h / 3), color, lw);
  } else if (kind === "mine") {
    polygon(g, [[x, y - k], [x + k, y], [x, y + k], [x - k, y]], color, lw);
    ring(g, x, y, Math.max(1, ci(k / 3)), color);
  } else if (kind === "lure") {
    const a = ci(k * 0.6);
    for (const [dx, dy] of [[-a, -a], [a, -a], [-a, a], [a, a]]) ring(g, x + dx, y + dy, Math.max(2, ci(k / 3)), color, Math.max(1, lw - 1));
    seg(g, x - a, y - a, x + a, y + a, color, lw); seg(g, x - a, y + a, x + a, y - a, color, lw);
  }
}

function crosshair(g, color, x, y, r, lw) {
  ring(g, x, y, r, color, lw);
  const q = Math.max(2, ci(r / 3));
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) seg(g, x + dx * q, y + dy * q, x + dx * (r + q), y + dy * (r + q), color, lw);
}

export class App {
  constructor(cv, store) {
    this.cv = cv;
    this.ctx = cv.getContext("2d");
    this.store = store;
    this.audio = new Audio(ch => this.store.options[ch] ?? 0.8);
    this.mode = "loading";
    this.inGame = false;
    this.menuIndex = 0;
    this.menuRects = [];
    this.optionBars = {};
    this.sliderDrag = null;
    this.selected = "evac";
    this.drag = null; this.sel = new Set(); this.lurePath = null;
    this.dragInfo = null;
    this.t = 0; this.animT = 0; this.frameNo = 0;
    this.storyIndex = null;
    this.tutorialIndex = null; this.tutor = null; this.tutorBox = null;
    this.loading = null;
    this.briefingError = null;
    this.handledResult = null;
    this.confirmNew = false;
    this.mouse = null;
    this.overButtons = [];
    this.index = null;
    this.colorblind = !!store.options.colorblind;
    K.setPalette(this.colorblind);
    this.progress = new Progression(store.progress, () => { store.data.progress = this.progress.toJSON(); store.save(); });
    store.onChange(() => this.storeChanged());
  }

  storeChanged() {
    const p = this.store.progress;
    if (p.history.length !== this.progress.history.length || p.level !== this.progress.level) {
      this.progress.level = p.level; this.progress.history = p.history;
    }
    const cb = !!this.store.options.colorblind;
    if (cb !== this.colorblind) {
      this.colorblind = cb;
      K.setPalette(cb);
      if (this.game) this.game.city.surfaceDirty = true;
    }
    if (this.game && this.game.difficulty !== this.store.options.difficulty) {
      this.game.difficulty = this.store.options.difficulty;
      if (this.game.phase === "setup") this.game.reset();
    }
  }

  async init() {
    this.resize();
    window.addEventListener("resize", () => this.resize());
    this.bindInput();
    requestAnimationFrame(t => this.frame(t));
    this.index = await (await fetch("maps/index.json")).json();
    const city = await loadCity(this.randomProcedural());
    this.game = new Game({ city, seed: Math.floor(Math.random() * 2 ** 30), progress: this.progress, difficulty: this.store.options.difficulty });
    this.relayout();
    this.openMenu();
  }

  randomProcedural(not = null) {
    const list = this.index.procedural.filter(s => s !== not);
    return list[Math.floor(Math.random() * list.length)];
  }

  // ---- maps and modes -----------------------------------------------------

  loadMap(slug, mission = null, name = "") {
    if (this.loading) return;
    this.loading = name || slug;
    this.briefingError = null;
    // A story map that hasn't been baked yet falls back to a procedural city.
    const load = mission ? loadCity(slug).catch(() => loadCity(this.index.procedural[0]).then(city => {
      city.name = `${mission.location} (SIMULATED)`;
      return city;
    })) : loadCity(slug);
    load.then(city => {
      this.loading = null;
      if (mission?.tutorial) city.name = mission.location;
      this.setCity(city, mission, mission ? null : Math.floor(Math.random() * 2 ** 30));
    }).catch(e => {
      this.loading = null;
      this.briefingError = String(e.message || e).slice(0, 60);
      this.game.flashMessage(`Map load failed: ${this.briefingError}`, 6);
    });
  }

  setCity(city, mission = null, seed = null) {
    this.game.difficulty = this.store.options.difficulty;
    this.game.setCity(city, seed, mission);
    this.cancel();
    city.render(this.s);
  }

  startEndless() {
    this.storyIndex = null; this.tutorialIndex = null; this.tutor = null;
    this.mode = "game"; this.inGame = true;
    this.loadMap(this.randomProcedural(this.game.city.slug), null, "PROCEDURAL");
  }

  startStory(i) {
    const m = CAMPAIGN[i];
    this.storyIndex = i; this.tutorialIndex = null; this.tutor = null;
    this.mode = "briefing";
    this.uiSound("ui_briefing");
    if (this.game.mission !== m) this.loadMap(m.map, m, m.location);
  }

  briefingReady() {
    return this.storyIndex !== null && !this.loading && this.game.mission === CAMPAIGN[this.storyIndex];
  }

  startTutorial(i) {
    const m = TUTORIALS[i];
    this.storyIndex = null;
    this.tutorialIndex = i; this.tutor = new Tutor(m);
    this.mode = "game"; this.inGame = true;
    this.selected = "evac";
    if (this.game.mission === m) { this.game.reset(); this.cancel(); }
    else this.loadMap(m.map, m, m.location);
  }

  /** Run the current lesson's steps; the lesson ends the match when it is done or can't be. */
  updateTutor() {
    const g = this.game, tu = this.tutor;
    if (!tu || g.mission !== tu.lesson || g.phase === "over" || this.loading) return;
    const fail = tu.update(g, this, this.t);
    if (fail) return g.finish(false, fail);
    if (tu.finished) return g.finish(true, "LESSON COMPLETE");
    if (tu.justDone) this.uiSound("ui_unlock");
    if (tu.shownAt === this.t) this.uiSound("ui_briefing");
  }

  tutorNext() {
    const tu = this.tutor;
    if (!tu || !tu.next(this.game, this.t)) return false;
    this.uiSound("ui_select");
    if (tu.finished) this.game.finish(true, "LESSON COMPLETE");
    else this.uiSound("ui_briefing");
    return true;
  }

  tutorActive() {
    const tu = this.tutor, g = this.game;
    return !!tu && g.mission === tu.lesson && !this.loading && g.phase !== "over" && !tu.finished;
  }

  newStory() {
    this.store.campaign = { mission: 0, completed: [] };
    this.startStory(0);
  }

  openMenu() {
    const g = this.game;
    if (g.phase === "running") g.paused = true;
    this.cancel();
    this.confirmNew = false;
    this.mode = "menu";
    this.menuIndex = this.firstEnabled();
  }

  handleMissionResult() {
    const g = this.game;
    this.handledResult = g.result;
    if (g.mission.tutorial) {
      if (g.result && g.result.success) this.store.completeTutorial(g.mission.id);
      return;
    }
    if (g.result && g.result.success) {
      const save = this.store.campaign || { mission: 0, completed: [] };
      if (!save.completed.includes(g.mission.id)) save.completed.push(g.mission.id);
      save.mission = Math.min(this.storyIndex + 1, CAMPAIGN.length - 1);
      if (this.storyIndex + 1 === CAMPAIGN.length) this.uiSound("campaign_complete");
      this.store.campaign = save;
    }
  }

  // ---- layout -------------------------------------------------------------

  resize() {
    const css = this.cv.getBoundingClientRect();
    const W = Math.max(1, css.width), H = Math.max(1, css.height);
    const dpr = Math.min(window.devicePixelRatio || 1, Math.sqrt(3.2e6 / (W * H)), 2);
    this.cv.width = Math.round(W * dpr);
    this.cv.height = Math.round(H * dpr);
    this.relayout();
  }

  fontPx(size) { return Math.max(10, ci(size)); }
  lineSize(px) { return Math.round(px * 1.17); }

  relayout() {
    const W = this.cv.width, H = this.cv.height;
    this.size = [W, H];
    let u = Math.max(0.4, Math.min(H / BASE_H, W / BASE_W)), s, mapW, mapH;
    for (;;) {
      this.u = u;
      this.big = this.fontPx(36 * u); this.med = this.fontPx(25 * u); this.small = this.fontPx(21 * u);
      const panelMin = ci(PANEL_MIN * u);
      s = Math.max(0.1, Math.min(H / WORLD_H, (W - panelMin) / WORLD_W));
      mapW = ci(WORLD_W * s); mapH = ci(WORLD_H * s);
      this.panelW = Math.min(W - mapW, ci(PANEL_MAX * u));
      this.panelX = W - this.panelW;
      if (this.layoutPanel(H) <= H || u <= 0.4) break;
      u *= 0.95;
    }
    this.s = s;
    this.lw = Math.max(1, Math.round(s));
    this.mapRect = { x: ci((this.panelX - mapW) / 2), y: ci((H - mapH) / 2), w: mapW, h: mapH };
    this.mapCv = canvas(mapW, mapH);
    this.dyn = canvas(mapW, mapH);
    this.glow = null;
    this.stillKey = null;
    this.zoneKey = null;
    this.buildBackdrop(W, H);
    if (this.game) this.game.city.render(s);
  }

  layoutPanel(H) {
    const u = this.u;
    const pad = this.pad = ci(14 * u);
    const gap = this.gap = Math.max(2, ci(5 * u));
    this.uiLw = Math.max(3, Math.round(3 * u));
    const x = this.panelX + pad + this.uiLw, w = this.panelX + this.panelW - pad - x;
    const big = this.lineSize(this.big), med = this.lineSize(this.med), small = this.lineSize(this.small);
    let y = pad;
    this.titleY = y; y += big;
    this.cpY = y; y += med + gap;
    this.sepY = y; y += 2 * gap;
    const rowH = small + gap;
    this.unitButtons = {};
    for (const k of UNIT_ORDER) { this.unitButtons[k] = { x, y, w, h: rowH }; y += rowH + Math.max(1, ci(gap / 3)); }
    y += gap;
    this.infoY = y; y += 2 * small + 2 * gap;
    const unitW = (w - 5 * gap) / 6.6;
    this.timeButtons = [];
    let bx = x;
    for (const val of ["undo", "pause", ...SPEEDS]) {
      const bw = ci(unitW * (val === "undo" ? 1.6 : 1));
      this.timeButtons.push([val, { x: bx, y, w: bw, h: med + 2 * gap }]);
      bx += bw + gap;
    }
    y += med + 4 * gap;
    this.statsY = y; y += 7 * small;
    this.helpY = H - pad - small;
    return y + 2 * gap + small + pad;
  }

  buildBackdrop(W, H) {
    const bg = canvas(W, H), g = bg.getContext("2d"), mr = this.mapRect;
    g.fillStyle = c("BG"); g.fillRect(0, 0, W, H);
    const step = Math.max(8, ci(40 * this.s));
    g.fillStyle = c("GRIDLINE");
    for (let y = mr.y % step; y < H; y += step) for (let x = mr.x % step; x < this.panelX; x += step) g.fillRect(x, y, 1, 1);
    const f = this.uiLw + 1;
    box(g, mr.x - f, mr.y - f, mr.w + 2 * f, mr.h + 2 * f, c("CYAN"), this.uiLw);
    this.backdrop = bg;
    // CRT: vignette + scanlines (static), plus grain tiles cycled per frame.
    const crt = canvas(W, H), cg = crt.getContext("2d"), img = cg.createImageData(W, H), a = img.data;
    for (let y = 0; y < H; y++) {
      const ys = (y - H / 2) / (H / 2), scan = y % 3 === 0 ? 60 : y % 3 === 1 ? 25 : 0;
      for (let x = 0; x < W; x++) {
        const xs = (x - W / 2) / (W / 2), r = Math.sqrt(xs * xs + ys * ys);
        const v = clamp((r - 0.65) / 0.75, 0, 1);
        a[4 * (y * W + x) + 3] = Math.min(255, v * v * 170 + scan);
      }
    }
    cg.putImageData(img, 0, 0);
    this.crtStatic = crt;
    if (!this.grain) {
      this.grain = [];
      for (let k = 0; k < 3; k++) {
        const t = canvas(256, 256), tg = t.getContext("2d"), im = tg.createImageData(256, 256);
        for (let i = 0; i < 256 * 256; i++) {
          const n = (Math.random() + Math.random() + Math.random() + Math.random() - 2) * 14 * 1.73;
          im.data[4 * i + 3] = clamp(n, 0, 255);
        }
        tg.putImageData(im, 0, 0);
        this.grain.push(this.ctx.createPattern(t, "repeat"));
      }
    }
    this.rollH = Math.max(8, ci(H / 10));
  }

  screenToWorld(p, clampIt = false) {
    if (!p) return null;
    const mr = this.mapRect;
    if (!clampIt && !(p[0] >= mr.x && p[0] < mr.x + mr.w && p[1] >= mr.y && p[1] < mr.y + mr.h)) return null;
    return [clamp((p[0] - mr.x) / this.s, 0, WORLD_W - 0.01), clamp((p[1] - mr.y) / this.s, 0, WORLD_H - 0.01)];
  }

  selectedUnits() {
    const units = this.game.units;
    for (const id of [...this.sel]) if (!units.has(id)) this.sel.delete(id);
    return [...this.sel].sort((a, b) => a - b).map(id => units.get(id));
  }

  cancel() { this.drag = null; this.sel = new Set(); this.lurePath = null; }

  uiSound(ev) { this.audio.play(ev); }

  // ---- menu ---------------------------------------------------------------

  inMenu() { return this.mode === "menu" || this.mode === "options" || this.mode === "tutorials"; }

  menuItems() {
    if (this.mode === "tutorials") {
      const done = this.store.tutorials;
      return [...TUTORIALS.map((t, i) => [`${done.includes(t.id) ? "[X]" : "[ ]"} ${i + 1}. ${t.title}`, `lesson:${i}`, true]),
        ["BACK", "back", true]];
    }
    const save = this.store.campaign, items = [];
    if (this.inGame) items.push(["RESUME", "resume", true]);
    if (save) items.push([`CONTINUE - M${save.mission + 1} ${CAMPAIGN[save.mission].title}`, "continue", true]);
    else items.push(["CONTINUE", "continue", false]);
    items.push([this.confirmNew ? "CONFIRM: ERASE STORY SAVE?" : "NEW GAME - STORY MODE", "story", true]);
    const fresh = !save && !this.store.tutorials.length;
    items.push(["ENDLESS MODE", "endless", true], [fresh ? "TUTORIALS - START HERE" : "TUTORIALS", "tutorials", true],
      ["CONTROLS", "controls", true], ["OPTIONS", "options", true]);
    const st = this.store;
    if (st.user) items.push(["SIGN OUT", "signout", true]);
    else items.push(["SIGN IN WITH GOOGLE", "signin", st.ready]);
    return items;
  }

  firstEnabled() { return Math.max(0, this.menuItems().findIndex(it => it[2])); }

  menuActivate(action) {
    this.uiSound("ui_select");
    if (action !== "story") this.confirmNew = false;
    if (action === "resume") this.mode = "game";
    else if (action === "continue") this.startStory(this.store.campaign.mission);
    else if (action === "story") {
      if (this.store.campaign && !this.confirmNew) { this.confirmNew = true; return; }
      this.confirmNew = false;
      this.newStory();
    } else if (action === "endless") this.startEndless();
    else if (action === "options") { this.mode = "options"; this.menuIndex = 0; }
    else if (action === "controls") this.mode = "controls";
    else if (action === "tutorials") {
      this.mode = "tutorials";
      const next = TUTORIALS.findIndex(t => !this.store.tutorials.includes(t.id));
      this.menuIndex = Math.max(0, next);
    } else if (action === "back") { this.mode = "menu"; this.menuIndex = this.firstEnabled(); }
    else if (action.startsWith("lesson:")) this.startTutorial(Number(action.slice(7)));
    else if (action === "signin") this.store.signIn();
    else if (action === "signout") this.store.signOut();
  }

  setOption(key, value) {
    this.store.options[key] = value;
    if (key === "colorblind") { this.colorblind = value; K.setPalette(value); this.game.city.surfaceDirty = true; }
    if (key === "difficulty") {
      this.game.difficulty = value;
      if (this.game.phase === "setup") this.game.reset();
    }
  }

  optionStep(i, dir) {
    const [key, , kind, range] = OPTION_ITEMS[i];
    this.uiSound("ui_select");
    if (kind === "toggle") this.setOption(key, !this.store.options[key]);
    else if (kind === "choice") {
      const j = range.indexOf(this.store.options[key]);
      this.setOption(key, range[(j + dir + range.length) % range.length]);
    } else if (kind === "slider") {
      this.setOption(key, Math.round(clamp(this.store.options[key] + 0.1 * dir, range[0], range[1]) * 100) / 100);
    } else if (key === "back") this.leaveOptions();
  }

  leaveOptions() {
    this.store.save();
    this.mode = "menu";
    this.menuIndex = this.firstEnabled();
  }

  sliderSet(i, mx) {
    const [key, , , [lo, hi]] = OPTION_ITEMS[i], bar = this.optionBars[i];
    if (!bar) return;
    const t = clamp((mx - bar.x) / Math.max(1, bar.w), 0, 1);
    this.setOption(key, Math.round((lo + (hi - lo) * t) * 100) / 100);
  }

  menuKey(e) {
    const options = this.mode === "options";
    const items = options ? OPTION_ITEMS : this.menuItems();
    const enabled = options ? items.map(() => true) : items.map(it => it[2]);
    const k = e.key, before = this.menuIndex;
    if (["ArrowUp", "w", "W", "ArrowDown", "s", "S"].includes(k)) {
      const d = ["ArrowUp", "w", "W"].includes(k) ? -1 : 1;
      for (let n = 0; n < items.length; n++) {
        this.menuIndex = (this.menuIndex + d + items.length) % items.length;
        if (enabled[this.menuIndex]) break;
      }
    } else if (options && ["ArrowLeft", "a", "A", "ArrowRight", "d", "D"].includes(k)) {
      this.optionStep(this.menuIndex, ["ArrowLeft", "a", "A"].includes(k) ? -1 : 1);
    } else if (k === "Enter" || k === " ") {
      if (options) this.optionStep(this.menuIndex, 1);
      else if (enabled[this.menuIndex]) this.menuActivate(items[this.menuIndex][1]);
    } else if (k === "Escape") {
      this.uiSound("ui_back");
      if (options) this.leaveOptions();
      else if (this.mode === "tutorials") { this.mode = "menu"; this.menuIndex = this.firstEnabled(); }
      else if (this.inGame) this.mode = "game";
    }
    if (this.menuIndex !== before) this.uiSound("ui_hover");
  }

  menuPointer(type, p) {
    const options = this.mode === "options";
    const items = options ? OPTION_ITEMS : this.menuItems();
    const enabled = options ? items.map(() => true) : items.map(it => it[2]);
    const hit = this.menuRects.findIndex(r => p[0] >= r.x && p[0] < r.x + r.w && p[1] >= r.y && p[1] < r.y + r.h);
    if (type === "move") {
      if (hit >= 0 && enabled[hit] && hit !== this.menuIndex) { this.menuIndex = hit; this.uiSound("ui_hover"); }
      if (this.sliderDrag !== null) this.sliderSet(this.sliderDrag, p[0]);
    } else if (type === "down" && hit >= 0 && enabled[hit]) {
      this.menuIndex = hit;
      if (options && OPTION_ITEMS[hit][2] === "slider") { this.sliderDrag = hit; this.sliderSet(hit, p[0]); }
      else if (options) this.optionStep(hit, 1);
      else this.menuActivate(items[hit][1]);
    } else if (type === "up") this.sliderDrag = null;
  }

  // ---- game input ---------------------------------------------------------

  gameKey(e) {
    const g = this.game, story = g.mission !== null, k = e.key, ctrl = e.ctrlKey || e.metaKey;
    const toolIdx = UNIT_KEYS.findIndex(t => t === k.toUpperCase());
    if (k === "Escape") {
      if (this.drag || this.sel.size || this.lurePath) this.cancel(); else this.openMenu();
    } else if (ctrl && (k === "z" || k === "Z")) { e.preventDefault(); g.undo(); this.selectedUnits(); }
    else if (ctrl && (k === "a" || k === "A")) {
      e.preventDefault();
      this.drag = null;
      this.sel = new Set(g.movables().map(u => u.id));
      if (!this.sel.size) g.flashMessage("No movable units deployed");
    } else if (toolIdx >= 0 && !ctrl) { this.selected = UNIT_ORDER[toolIdx]; this.cancel(); this.uiSound("ui_select"); }
    else if (k === " ") { e.preventDefault(); g.togglePause(); }
    else if (["f", "F", "=", "+"].includes(k)) {
      const i = SPEEDS.indexOf(g.timeScale);
      g.setSpeed(k === "f" || k === "F" ? SPEEDS[(i + 1) % SPEEDS.length] : SPEEDS[Math.min(i + 1, SPEEDS.length - 1)]);
    } else if (k === "-" || k === "_") g.setSpeed(SPEEDS[Math.max(SPEEDS.indexOf(g.timeScale) - 1, 0)]);
    else if ((k === "r" || k === "R") && !ctrl) { g.reset(); this.cancel(); }
    else if (k === "Enter" && g.phase !== "over" && this.tutorActive() && this.tutor.waiting) this.tutorNext();
    else if (k === "Enter" && story && g.phase === "over") this.nextOrRetry();
    else if ((k === "n" || k === "N") && !story && !ctrl) this.newCity();
  }

  nextOrRetry() {
    const g = this.game;
    if (this.tutorialIndex !== null) {
      if (g.result && g.result.success && this.tutorialIndex + 1 < TUTORIALS.length) this.startTutorial(this.tutorialIndex + 1);
      else { g.reset(); this.cancel(); }
      return;
    }
    if (g.result && g.result.success && this.storyIndex + 1 < CAMPAIGN.length) this.startStory(this.storyIndex + 1);
    else { g.reset(); this.cancel(); }
  }

  newCity() {
    if (this.game.city.kind === "procedural") this.loadMap(this.randomProcedural(this.game.city.slug), null, "PROCEDURAL");
    else { this.game.newOutbreak(); this.cancel(); }
  }

  deploy(fn, ...args) {
    const g = this.game;
    const sig = () => `${g.cp},${g.units.size},${g.shells.length},${g.bombers.length},${g.drones.length}`;
    const before = sig(), n = g.soundEvents.length;
    fn.apply(g, args);
    if (sig() !== before) this.uiSound("ui_deploy_ok");
    else if (g.soundEvents.length > n) {
      const fresh = g.soundEvents.slice(n).filter(e => e !== "ui_alert");
      g.soundEvents.splice(n, g.soundEvents.length - n, ...fresh);
      if (!fresh.includes("ui_tool_locked")) this.uiSound("ui_deny");
    }
  }

  leftClick(w) {
    const g = this.game;
    if (this.drag && this.selected === "barricade") {
      this.deploy(g.deployLine, "barricade", ...this.drag, ...w);
      this.drag = null;
      return;
    }
    const movers = this.selectedUnits(), choppers = movers.filter(u => u.kind === "chopper");
    if (choppers.length) {
      const tgt = g.escortTargetAt(...w);
      if (tgt) {
        g.setEscort(choppers, tgt);
        const others = movers.filter(u => u.kind !== "chopper");
        if (others.length) g.groupMove(others, ...g.escortPos(tgt));
        return;
      }
    }
    const here = g.movableAt(...w);
    if (here) this.sel = this.sel.size === 1 && this.sel.has(here.id) ? new Set() : new Set([here.id]);
    else if (movers.length) g.groupMove(movers, ...w);
    else if (UNIT_SPECS[this.selected].mode === "path") this.lurePath = [w];
    else if (UNIT_SPECS[this.selected].mode === "drag") this.drag = w;
    else this.deploy(g.deployPoint, this.selected, ...w);
  }

  rightClick(w) {
    if (this.drag || this.sel.size || this.lurePath) this.cancel();
    else if (w) this.game.removeNear(...w);
  }

  inRect(p, r) { return p[0] >= r.x && p[0] < r.x + r.w && p[1] >= r.y && p[1] < r.y + r.h; }

  clickPanel(p) {
    const g = this.game;
    if (p[1] < this.cpY) { this.openMenu(); return; }        // the title opens the pause menu
    for (const k of UNIT_ORDER) {
      if (this.inRect(p, this.unitButtons[k])) { this.selected = k; this.cancel(); this.uiSound("ui_select"); }
    }
    for (const [val, r] of this.timeButtons) {
      if (!this.inRect(p, r)) continue;
      if (val === "undo") { g.undo(); this.selectedUnits(); }
      else if (val === "pause") {
        if (g.phase === "running" && !g.paused) { g.paused = true; g.sound("ui_pause"); }
        else if (g.phase !== "over") g.togglePause();
      } else g.setSpeed(val);
    }
  }

  bindInput() {
    const pos = e => {
      const r = this.cv.getBoundingClientRect();
      return [(e.clientX - r.left) * this.cv.width / r.width, (e.clientY - r.top) * this.cv.height / r.height];
    };
    this.cv.addEventListener("contextmenu", e => e.preventDefault());
    this.cv.addEventListener("pointerdown", e => {
      this.audio.unlock();
      const p = pos(e);
      this.mouse = p;
      this.cv.setPointerCapture?.(e.pointerId);
      if (!this.game) return;
      if (this.inMenu()) return this.menuPointer("down", p);
      if (this.mode === "controls") { this.mode = "menu"; return; }
      if (this.mode === "briefing") {
        if (this.briefingReady()) { this.mode = "game"; this.inGame = true; }
        else if (this.briefingError && !this.loading) this.startStory(this.storyIndex);
        return;
      }
      if (this.mode !== "game") return;
      if (this.game.phase === "over") {
        const b = this.overButtons.find(b => this.inRect(p, b.rect));
        if (b) { this.uiSound("ui_select"); b.action(); }
        return;
      }
      if (this.tutorBox && this.tutorActive() && this.tutor.waiting && this.inRect(p, this.tutorBox)) { this.tutorNext(); return; }
      if (p[0] >= this.panelX) { if (e.button === 0) this.clickPanel(p); return; }
      const w = this.screenToWorld(p);
      if (!w) return;
      if (e.button === 2) return this.rightClick(w);
      if (e.button !== 0) return;
      if (e.pointerType === "touch") {
        const starter = (this.selected === "bombing" || this.selected === "lure") && !this.drag && !this.sel.size
          && !this.lurePath && !this.game.movableAt(...w);
        if (starter) return this.leftClick(w);
        clearTimeout(this.press?.timer);
        this.press = { w, p, timer: setTimeout(() => { this.press = null; this.rightClick(w); if (navigator.vibrate) navigator.vibrate(30); }, 550) };
        return;
      }
      this.leftClick(w);
    });
    this.cv.addEventListener("pointermove", e => {
      const p = pos(e);
      this.mouse = p;
      if (this.inMenu()) return this.menuPointer("move", p);
      if (this.press && hypot(p[0] - this.press.p[0], p[1] - this.press.p[1]) > 14 * this.u) { clearTimeout(this.press.timer); this.press = null; }
      if (this.lurePath) {
        const w = this.screenToWorld(p, true), last = this.lurePath[this.lurePath.length - 1];
        if (hypot(w[0] - last[0], w[1] - last[1]) > 8) this.lurePath.push(w);
      }
    });
    const up = e => {
      const p = pos(e);
      if (this.inMenu()) return this.menuPointer("up", p);
      if (!this.game || this.mode !== "game") return;
      if (this.press) { clearTimeout(this.press.timer); const w = this.press.w; this.press = null; this.leftClick(w); }
      if (e.button !== 0 && e.pointerType !== "touch") return;
      if (this.drag && this.selected === "bombing") {
        this.deploy(this.game.deployLine, this.selected, ...this.drag, ...this.screenToWorld(p, true));
        this.drag = null;
      } else if (this.lurePath) {
        this.deploy(this.game.deployPath, "lure", this.lurePath);
        this.lurePath = null;
      }
      if (e.pointerType === "touch") this.mouse = null;
    };
    this.cv.addEventListener("pointerup", up);
    this.cv.addEventListener("pointercancel", e => { if (this.press) { clearTimeout(this.press.timer); this.press = null; } up(e); });
    this.cv.addEventListener("pointerleave", e => { if (e.pointerType === "mouse") this.mouse = null; });
    window.addEventListener("keydown", e => {
      this.audio.unlock();
      if (!this.game) return;
      if (e.key === "F11") { e.preventDefault(); this.toggleFullscreen(); return; }
      if (e.key === " " || (e.ctrlKey && ["a", "z", "A", "Z"].includes(e.key))) e.preventDefault();
      if (this.mode === "controls") {
        if (["Escape", "Enter", " ", "Backspace"].includes(e.key)) this.mode = "menu";
      } else if (this.inMenu()) this.menuKey(e);
      else if (this.mode === "briefing") {
        if (e.key === "Escape") this.openMenu();
        else if (e.key === "Enter" || e.key === " ") {
          if (this.briefingReady()) { this.mode = "game"; this.inGame = true; }
          else if (this.briefingError && !this.loading) this.startStory(this.storyIndex);
        }
      } else if (this.mode === "game") this.gameKey(e);
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && this.game && this.game.phase === "running") this.game.paused = true;
    });
  }

  toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }

  // ---- main loop ------------------------------------------------------------

  frame(now) {
    const dt = Math.min((now - (this.lastNow ?? now)) / 1000, 0.1);
    this.lastNow = now;
    this.t += dt;
    const g = this.game;
    if (g && this.mode === "game") {
      g.advance(dt);
      if (g.phase === "running" && !g.paused) this.animT += dt * g.timeScale;
      this.updateTutor();
      if (g.phase === "over" && g.mission && g.result !== this.handledResult) this.handleMissionResult();
    }
    if (g) {
      for (const ev of g.soundEvents) this.audio.play(ev);
      g.soundEvents.length = 0;
    }
    this.audio.update();
    try { this.draw(); } catch (e) { console.error(e); }
    requestAnimationFrame(t => this.frame(t));
  }

  blink(hz = 2) { return (this.t * hz) % 1 < 0.5; }

  text(s, x, y, px, color, anchor = "topleft", bg = null) {
    const g = this.ctx;
    g.font = `bold ${px}px ${FONT}`;
    const w = g.measureText(s).width, h = this.lineSize(px);
    let left = x, top = y;
    if (anchor.includes("right")) left = x - w;
    else if (anchor.startsWith("mid") && anchor !== "midleft" || anchor === "center") left = x - w / 2;
    if (anchor === "center" || anchor === "midleft" || anchor === "midright") top = y - h / 2;
    else if (anchor.startsWith("bottom") || anchor === "midbottom") top = y - h;
    if (bg) { g.fillStyle = bg; g.fillRect(left, top, w, h); }
    g.fillStyle = color;
    g.textBaseline = "middle";
    g.fillText(s, left, top + h / 2 + px * 0.04);
    return { x: left, y: top, w, h };
  }

  textWidth(s, px) { this.ctx.font = `bold ${px}px ${FONT}`; return this.ctx.measureText(s).width; }

  draw() {
    this.frameNo++;
    const g = this.ctx, [W, H] = this.size;
    if (!this.game) {
      g.fillStyle = c("BG"); g.fillRect(0, 0, W, H);
      this.text("ZOMBIE EVAC", W / 2, H * 0.4, this.fontPx(70 * this.u), c("WHITE"), "center");
      this.text("ESTABLISHING CCTV LINK" + ".".repeat(ci(this.t * 3) % 4), W / 2, H * 0.4 + 80 * this.u, this.small, c("YELLOW"), "center");
      this.drawCrt();
      return;
    }
    g.drawImage(this.backdrop, 0, 0);
    this.drawMap();
    this.drawCctvHud();
    this.drawPanel();
    const mr = this.mapRect, gm = this.game;
    if (this.mode === "game" && gm.phase !== "over" && this.tutorActive()) this.drawTutor();
    else this.tutorBox = null;
    if (this.inMenu() || this.mode === "controls" || this.mode === "briefing") {
      g.fillStyle = c("BG", 215 / 255); g.fillRect(0, 0, W, H);
      if (this.mode === "controls") this.drawControls();
      else if (this.mode === "briefing") this.drawBriefing();
      else this.drawMenu();
    } else if (gm.phase === "over") this.drawGameOver();
    else if (gm.paused && this.blink(1.5)) this.text("// PAUSED //", mr.x + mr.w / 2, mr.y + mr.h / 2, this.big, c("YELLOW"), "center");
    this.drawCrt();
  }

  drawCrt() {
    const g = this.ctx, [W, H] = this.size, o = this.store.options;
    if (o.crt) {
      const y = ci((this.t * 0.12 % 1) * (H + this.rollH)) - this.rollH;
      const grad = g.createLinearGradient(0, y, 0, y + this.rollH);
      grad.addColorStop(0, c("WHITE", 0)); grad.addColorStop(0.5, c("WHITE", 14 / 255)); grad.addColorStop(1, c("WHITE", 0));
      g.fillStyle = grad; g.fillRect(0, y, W, this.rollH);
      g.drawImage(this.crtStatic, 0, 0);
      g.save();
      g.fillStyle = this.grain[this.frameNo % 3];
      g.translate((this.frameNo * 37) % 256, (this.frameNo * 91) % 256);
      g.fillRect(-256, -256, W + 256, H + 256);
      g.restore();
    } else g.drawImage(this.crtStatic, 0, 0);
    const b = o.brightness;
    if (b < 0.99) {
      g.save(); g.globalCompositeOperation = "multiply";
      const m = ci(255 * b); g.fillStyle = `rgb(${m},${m},${m})`; g.fillRect(0, 0, W, H); g.restore();
    } else if (b > 1.01) {
      g.save(); g.globalCompositeOperation = "lighter";
      const k = ci(90 * (b - 1)); g.fillStyle = `rgb(${k},${k},${k})`; g.fillRect(0, 0, W, H); g.restore();
    }
  }

  // ---- menus --------------------------------------------------------------

  drawMenu() {
    const [W, H] = this.size, u = this.u, cx = W / 2, options = this.mode === "options";
    const title = this.fontPx(70 * u);
    let y = ci(H * 0.1);
    this.text("ZOMBIE EVAC", cx, y, title, c("WHITE"), "midtop");
    y += this.lineSize(title);
    const training = this.mode === "tutorials", heading = options ? "OPTIONS" : training ? "TRAINING" : null;
    this.text(heading || "OUTBREAK RESPONSE COMMAND // CCTV LINK", cx, y, heading ? this.med : this.small,
      heading ? c("YELLOW") : c("WHITE_DIM"), "midtop");
    y += ci(this.lineSize(this.med) * 1.8);
    const bw = Math.min(ci(560 * u), W - 20), bh = this.lineSize(this.med) + ci(14 * u), gap = ci(10 * u);
    this.menuRects = []; this.optionBars = {};
    const g = this.ctx;
    let hint, note;
    if (options) {
      OPTION_ITEMS.forEach(([key, label, kind, range], i) => {
        const r = { x: cx - bw / 2, y, w: bw, h: bh };
        this.menuRects.push(r);
        const sel = i === this.menuIndex;
        box(g, r.x, r.y, r.w, r.h, sel ? c("YELLOW") : c("CYAN"), this.uiLw);
        const col = sel ? c("YELLOW") : c("WHITE");
        this.text((sel ? "> " : "  ") + label, r.x + ci(14 * u), r.y + r.h / 2, this.small, col, "midleft");
        const v = this.store.options[key];
        if (kind === "toggle") this.text(v ? "[ON]" : "[OFF]", r.x + r.w - ci(14 * u), r.y + r.h / 2, this.small, v ? c("YELLOW") : c("WHITE_DIM"), "midright");
        else if (kind === "choice") this.text(`< ${v.toUpperCase()} >`, r.x + r.w - ci(14 * u), r.y + r.h / 2, this.small, c("YELLOW"), "midright");
        else if (kind === "slider") {
          const t = (v - range[0]) / (range[1] - range[0]);
          const bar = { x: r.x + ci(bw * 0.55), y: r.y + r.h / 2 - ci(6 * u), w: ci(bw * 0.3), h: ci(12 * u) };
          this.optionBars[i] = bar;
          box(g, bar.x, bar.y, bar.w, bar.h, c("GRIDLINE"));
          box(g, bar.x, bar.y, ci(bar.w * t), bar.h, c("BLUE"));
          box(g, bar.x, bar.y, bar.w, bar.h, col, Math.max(1, this.uiLw - 1));
          this.text(`${Math.round(v * 100)}%`, r.x + r.w - ci(14 * u), r.y + r.h / 2, this.small, col, "midright");
        }
        y += bh + gap;
      });
      hint = "UP/DOWN SELECT   LEFT/RIGHT ADJUST   ESC BACK";
      note = "DIFFICULTY APPLIES FROM THE NEXT MATCH";
    } else {
      this.menuItems().forEach(([label, , enabled], i) => {
        const r = { x: cx - bw / 2, y, w: bw, h: bh };
        this.menuRects.push(r);
        const sel = i === this.menuIndex && enabled;
        if (sel) box(g, r.x, r.y, r.w, r.h, rgb(mix(COL.BG, COL.YELLOW, 0.18)));
        box(g, r.x, r.y, r.w, r.h, sel ? c("YELLOW") : enabled ? c("CYAN") : c("GRIDLINE"), this.uiLw);
        const col = sel ? c("YELLOW") : enabled ? c("WHITE") : c("WHITE_DIM");
        this.text(label, r.x + r.w / 2, r.y + r.h / 2, label.length < 28 ? this.med : this.small, col, "center");
        y += bh + gap;
      });
      if (training) {
        const t = TUTORIALS[this.menuIndex];
        if (t) this.text(t.summary, cx, y + gap, this.small, c("CYAN"), "midtop");
        this.text("UP/DOWN SELECT   ENTER START   ESC BACK", cx, H - ci(60 * u), this.small, c("WHITE_DIM"), "midbottom");
        this.text(`${this.store.tutorials.length}/${TUTORIALS.length} LESSONS COMPLETE`, cx, H - ci(30 * u), this.small, c("WHITE_DIM"), "midbottom");
        return;
      }
      const st = this.store;
      const who = st.user ? `SIGNED IN: ${st.user.name.toUpperCase()}` : "GUEST - PROGRESS SAVED ON THIS DEVICE ONLY";
      this.text(who + (st.status && st.user ? `  // ${st.status}` : ""), cx, y + gap, this.small, st.user ? c("CYAN") : c("WHITE_DIM"), "midtop");
      if (st.status && !st.user) this.text(st.status, cx, y + gap + this.lineSize(this.small), this.small, c("YELLOW"), "midtop");
      hint = "UP/DOWN SELECT   ENTER CONFIRM" + (this.inGame ? "   ESC RESUME" : "");
      note = "MAP DATA (C) OPENSTREETMAP CONTRIBUTORS (ODBL)";
    }
    this.text(hint, cx, H - ci(60 * u), this.small, c("WHITE_DIM"), "midbottom");
    this.text(note, cx, H - ci(30 * u), this.small, c("WHITE_DIM"), "midbottom");
  }

  drawControls() {
    const [W, H] = this.size, u = this.u, cx = W / 2, g = this.ctx;
    const title = this.fontPx(52 * u);
    let y = ci(H * 0.05);
    this.text("CONTROLS", cx, y, title, c("WHITE"), "midtop");
    y += this.lineSize(title) + ci(10 * u);
    const small = this.small, med = this.med;
    const keyW = Math.max(...CONTROLS.filter(r => r[1]).map(([k]) => this.textWidth(k, small))) + ci(30 * u);
    const actW = Math.max(...CONTROLS.filter(r => r[1]).map(([, a]) => this.textWidth(a, small)));
    const rowsH = CONTROLS.reduce((s, [, a]) => s + this.lineSize(a === null ? med : small), 0);
    const bw = Math.min(keyW + actW + 4 * this.pad, W - 10), bx = cx - bw / 2;
    box(g, bx, y, bw, rowsH + 2 * this.pad, c("BG"));
    box(g, bx, y, bw, rowsH + 2 * this.pad, c("CYAN"), this.uiLw);
    let yy = y + this.pad;
    for (const [keys, action] of CONTROLS) {
      if (action === null) { this.text(keys, bx + 2 * this.pad, yy, med, c("CYAN")); yy += this.lineSize(med); }
      else {
        this.text(keys, bx + 2 * this.pad, yy, small, c("YELLOW"));
        this.text(action, bx + 2 * this.pad + keyW, yy, small, c("WHITE"));
        yy += this.lineSize(small);
      }
    }
    this.text("ESC / ENTER / CLICK: BACK", cx, Math.min(H - ci(20 * u), y + rowsH + 2 * this.pad + ci(28 * u)), small, c("WHITE_DIM"), "midbottom");
  }

  drawBriefing() {
    const m = CAMPAIGN[this.storyIndex], [W, H] = this.size, u = this.u, g = this.ctx;
    const { big, med, small } = this, diff = this.store.options.difficulty;
    const lines = [[`MISSION ${this.storyIndex + 1} OF ${CAMPAIGN.length}`, small, c("WHITE_DIM")], [m.title, big, c("WHITE")],
      [m.location, small, c("CYAN")], ["", small], ...m.briefing.map(t => [t, small, c("WHITE")]), ["", small]];
    const [goals, rules] = K.missionObjectives(m, diff);
    lines.push(["OBJECTIVES", med, c("YELLOW")], ...goals.map(t => ["> " + t, small, c("YELLOW")]), ...rules.map(t => [t, small, c("WHITE")]));
    const eff = K.applyDifficulty(m, diff);
    lines.push([`POPULATION ${m.population.toLocaleString("en-US")}   INFECTED ${Math.round(eff.infected * 100)}%   CP ${eff.cp.toLocaleString("en-US")}`
      + (m.vips ? `   VIPS ${m.vips}` : "") + `   ${diff.toUpperCase()}`, small, c("WHITE_DIM")]);
    let status;
    if (this.loading) status = ["LOADING MAP DATA" + ".".repeat(ci(this.t * 3) % 4), c("YELLOW")];
    else if (this.briefingError) status = [`MAP LOAD FAILED: ${this.briefingError.toUpperCase()} - ENTER: RETRY`, c("RED")];
    else if (this.briefingReady()) status = ["ENTER / CLICK: DEPLOY        ESC: MENU", this.blink(1) ? c("YELLOW") : c("WHITE")];
    else status = ["PREPARING...", c("WHITE_DIM")];
    lines.push(["", small], [status[0], small, status[1]]);
    const gap = ci(6 * u);
    const width = Math.min(Math.max(...lines.map(([t, f]) => this.textWidth(t, f))) + 6 * this.pad, W - 20);
    const height = lines.reduce((s, [, f]) => s + this.lineSize(f) + gap, 0) + 3 * this.pad;
    const bx = W / 2 - width / 2, by = Math.max(0, H / 2 - height / 2);
    box(g, bx, by, width, height, c("BG"));
    box(g, bx, by, width, height, c("YELLOW"), this.uiLw);
    let y = by + ci(1.5 * this.pad);
    for (const [t, f, col] of lines) {
      if (t) this.text(t, W / 2, y, f, col, "midtop");
      y += this.lineSize(f) + gap;
    }
  }

  drawCctvHud() {
    const g = this.game, mr = this.mapRect, u = this.u, pad = ci(10 * u), small = this.small;
    const stamp = new Date().toISOString().slice(0, 10);
    const rt = g.runTime;
    const clock = `${String(ci(rt / 3600)).padStart(2, "0")}:${String(ci(rt / 60) % 60).padStart(2, "0")}:${String(ci(rt) % 60).padStart(2, "0")}`;
    this.text(` CAM-${String(g.seed % 100).padStart(2, "0")}  ${g.city.name} `, mr.x + pad, mr.y + pad, small, c("WHITE"), "topleft", c("BG"));
    const r = this.text(" REC ", mr.x + mr.w - pad, mr.y + pad, small, c("WHITE"), "topright", c("BG"));
    if ((g.phase === "running" && !g.paused && this.blink(1)) || g.phase !== "running") {
      ring(this.ctx, r.x + ci(6 * u), r.y + r.h / 2, Math.max(3, ci(5 * u)), c("RED"));
    }
    this.text(` ${stamp} ${clock} `, mr.x + pad, mr.y + mr.h - pad, small, c("WHITE"), "bottomleft", c("BG"));
    let msg = null;
    if (this.loading) msg = `LOADING MAP: ${this.loading}` + ".".repeat(ci(this.t * 3) % 4);
    else if (g.phase === "setup") msg = "STANDBY - DEPLOY, THEN PLAY";
    else if (g.phase === "running" && !g.lzs.length && !g.disabled.has("evac")) msg = "NO EVAC LZ - CIVILIANS PANICKING";
    if (msg && (this.loading || this.blink(0.8))) {
      const r2 = this.text(` ${msg} `, mr.x + mr.w / 2, mr.y + 2 * pad + this.lineSize(small), this.med, c("YELLOW"), "midtop", c("BG"));
      box(this.ctx, r2.x - 3, r2.y - 3, r2.w + 6, r2.h + 6, c("YELLOW"), this.uiLw);
    }
  }

  // ---- the map ---------------------------------------------------------------

  drawMap() {
    const gm = this.game, s = this.s, lw = this.lw, city = gm.city;
    const ms = this.mapCv.getContext("2d");
    if (city.surfaceDirty || !city.surface || city.surfaceScale !== s) city.render(s);
    else if (city.rubbleNew.length) { city.paintRubble(city.surface.getContext("2d"), s, city.rubbleNew); city.rubbleNew = []; }
    ms.drawImage(city.surface, 0, 0);
    const riders = new Int32Array(gm.nCars);
    for (let i = 0; i < gm.P; i++) if (gm.state[i] === K.IN_CAR) riders[gm.inCar[i]]++;
    const key = `${gm.resetId},${gm.carVersion},${s},${K.COL.GREEN}`;
    if (this.stillKey !== key || this.stillGame !== gm) {
      this.still = canvas(this.mapCv.width, this.mapCv.height);
      const lg = this.still.getContext("2d");
      for (const [st, col] of [[K.CAR_PARKED, mix(COL.BG, COL.WHITE, 0.6)], [K.CAR_WRECK, mix(COL.BG, COL.WHITE, 0.4)], [K.CAR_BURNT, mix(COL.BG, COL.WHITE, 0.2)]]) {
        this.drawCars(lg, st, rgb(col), riders);
      }
      this.stillKey = key; this.stillGame = gm;
    }
    ms.drawImage(this.still, 0, 0);
    const P = (x, y) => [ci(x * s), ci(y * s)];
    const R = (r, lo = 1) => Math.max(lo, ci(r * s));
    const hover = this.screenToWorld(this.mouse);
    const chosen = this.selectedUnits();

    // translucent range rings, LZ pads, squad links (not bloomed)
    for (const u of gm.units.values()) {
      if (!u.range) continue;
      if (!(gm.phase === "setup" || chosen.includes(u) || (hover && hypot(hover[0] - u.x, hover[1] - u.y) < 15))) continue;
      const r = R(u.range + (u.spec.orbit || 0)), [x, y] = P(u.x, u.y), col = COL[u.spec.color];
      ring(ms, x, y, r, rgb(col, 16 / 255));
      ring(ms, x, y, r, rgb(col, 90 / 255), lw);
    }
    const k = Math.max(1, Math.round(CELL * s));
    const allowed = gm.buildZones[this.selected];
    if (allowed) {
      if (this.zoneKey !== `${gm.resetId},${this.selected},${s}`) {
        this.zoneCv = canvas(this.mapCv.width, this.mapCv.height);
        const zg = this.zoneCv.getContext("2d");
        zg.fillStyle = c("BLUE", 60 / 255);
        for (let cl = 0; cl < K.N_CELLS; cl++) {
          if (allowed[cl] && city.walk[cl]) zg.fillRect(ci((cl % GW) * CELL * s), ci(ci(cl / GW) * CELL * s), k, k);
        }
        this.zoneKey = `${gm.resetId},${this.selected},${s}`;
      }
      ms.drawImage(this.zoneCv, 0, 0);
    }
    ms.fillStyle = c("BLUE", 70 / 255);
    for (const u of gm.lzs) for (const cl of u.zone || []) ms.fillRect(ci((cl % GW) * CELL * s), ci(ci(cl / GW) * CELL * s), k, k);
    for (const f of gm.fires) {
      const flick = 0.75 + 0.25 * Math.sin(this.animT * 9 + f.x), fade = Math.min(1, f.t / 2);
      const [x, y] = P(f.x, f.y);
      ring(ms, x, y, R(f.r), c("YELLOW", 70 * flick * fade / 255));
      ring(ms, x, y, R(f.r * 0.6), c("RED", 110 * flick * fade / 255));
    }
    if (gm.phase === "running") {
      for (const d of gm.drones) {
        const pulse = 0.5 + 0.5 * Math.sin(this.animT * 4), [x, y] = P(...d.pos);
        ring(ms, x, y, R(K.LURE_RADIUS), c("YELLOW", (14 + 16 * pulse) / 255));
        ring(ms, x, y, R(K.LURE_RADIUS), c("YELLOW", 120 / 255), lw);
      }
    }
    const squads = [...gm.units.values()].filter(u => u.kind === "infantry");
    for (const u of squads) if (u.screening) ring(ms, ...P(u.x, u.y), R(K.SCREEN_RADIUS), c("BLUE", 110 / 255), 1);
    for (let i = 0; i < squads.length; i++) {
      for (let j = i + 1; j < squads.length; j++) {
        const a = squads[i], b = squads[j];
        if (hypot(a.x - b.x, a.y - b.y) < K.REINFORCE_RADIUS) seg(ms, ...P(a.x, a.y), ...P(b.x, b.y), c("BLUE", 150 / 255), lw);
      }
    }

    // Everything that glows goes on a dark layer, bloomed and added over the city.
    const dg = this.dyn.getContext("2d");
    dg.fillStyle = "#000"; dg.fillRect(0, 0, this.dyn.width, this.dyn.height);
    const uw = Math.max(2, Math.round(1.5 * s));
    for (const u of gm.units.values()) {
      const frac = u.hp === null ? 1 : Math.max(0, u.hp / u.max_hp);
      let col = rgb(mix(COL.BLACK, COL[u.spec.color], 0.45 + 0.55 * frac));
      if (u.drop_t > 0) {                     // paradrop: shrinking crosshair + falling shadow
        const f = u.drop_t / K.DROP_TIME, [x, y] = P(u.x, u.y);
        crosshair(dg, c("YELLOW"), x, y, R(4 + 12 * f, 4), 1);
        dg.beginPath(); dg.ellipse(x, y, R(5, 3), R(2, 1), 0, 0, TAU);
        dg.strokeStyle = rgb(mix(COL.BLACK, COL.WHITE, 0.35 * (1 - f))); dg.lineWidth = 1; dg.stroke();
        drawSymbol(dg, u.kind, x, y - R(40 * f), R(5, 4), rgb(mix(COL.BLACK, COL[u.spec.color], 0.6)), 1);
        continue;
      }
      if (!u.built) {                         // blueprint: dashed outline + build progress
        const bp = rgb(mix(COL.BLACK, COL.WHITE, 0.6)), kk = Math.max(2, Math.round(CELL * s));
        if (u.kind === "barricade") {
          u.street.forEach((cl, n) => {
            if (n % 2 === 0 || this.blink(2)) box(dg, ci((cl % GW) * CELL * s), ci(ci(cl / GW) * CELL * s), kk, kk, bp, 1);
          });
        } else drawSymbol(dg, u.kind, ...P(u.x, u.y), R(5, 4), bp, 1);
        const [x, y] = P(...u.site), bw = R(18, 12), bh = Math.max(3, R(2.5));
        box(dg, x - ci(bw / 2), y - R(9, 7), bw, bh, rgb(mix(COL.BLACK, COL.WHITE, 0.3)));
        box(dg, x - ci(bw / 2), y - R(9, 7), ci(bw * u.progress), bh, c("YELLOW"));
        continue;
      }
      if (u.kind === "evac") this.drawLz(dg, u);
      else if (u.kind === "mine") drawSymbol(dg, "mine", ...P(u.x, u.y), R(3.5, 3), c("MAGENTA"), Math.max(1, lw));
      else if (u.kind === "barricade") {
        if (gm.runTime - u.last_hit < 0.4 && this.blink(6)) col = c("YELLOW");
        const kk = Math.max(2, Math.round(CELL * s));
        dg.fillStyle = col;
        for (const cl of u.street) dg.fillRect(ci((cl % GW) * CELL * s), ci(ci(cl / GW) * CELL * s), kk, kk);
        dg.fillStyle = c("WHITE");
        for (const cl of u.street) dg.fillRect(ci((cl % GW) * CELL * s) + ci(kk / 2), ci(ci(cl / GW) * CELL * s) + ci(kk / 2), 1, 1);
        const dim = gm.runTime - u.last_hit < 0.4 && this.blink(6) ? rgb(mix(COL.BLACK, COL.YELLOW, 0.55))
          : rgb(mix(COL.BLACK, mix(COL.BLACK, COL[u.spec.color], 0.45 + 0.55 * frac), 0.55));
        for (const cl of u.seal) box(dg, ci((cl % GW) * CELL * s), ci(ci(cl / GW) * CELL * s), kk, kk, dim, 1);
      } else if (u.kind !== "chopper") {
        if ((u.kind === "infantry" && u.retreating || u.kind === "engineer" && u.state === "fleeing") && this.blink(4)) col = c("YELLOW");
        drawSymbol(dg, u.kind, ...P(u.x, u.y), R(6, 4), col, uw);
        if (u.kind === "infantry" && u.support) {
          const [x, y] = P(u.x, u.y);
          for (let n = 0; n < u.support; n++) box(dg, x - R(6, 4) + n * R(4, 3), y + R(6, 5), R(2.5, 2), R(2.5, 2), c("BLUE"));
        }
      }
    }
    this.drawCars(dg, K.CAR_DRIVING, c("WHITE"), riders);
    for (const tr of gm.trains) {             // trains: a chain of carriages
      if (tr.head === null) continue;
      for (let j = 0; j < 4; j++) {
        const a = tr.at(tr.head - tr.dir * (j * K.TRAIN_LENGTH / 4 + 1)), b = tr.at(tr.head - tr.dir * ((j + 1) * K.TRAIN_LENGTH / 4 - 1));
        if (hypot(b[0] - a[0], b[1] - a[1]) > 1) seg(dg, ...P(...a), ...P(...b), j ? c("MAGENTA") : c("YELLOW"), Math.max(3, R(4.5)));
      }
    }
    this.plotAgents(dg);
    for (let i = 0; i < gm.P; i++) if (gm.vip[i] && gm.state[i] === CIV) ring(dg, ...P(gm.px[i], gm.py[i]), R(6, 5), c("VIP"), 1);

    for (const u of gm.units.values()) {      // health bars on damaged units
      if (u.hp === null || u.hp >= u.max_hp) continue;
      let x, y;
      if (u.kind === "barricade") { [x, y] = P((u.x + u.x2) / 2, (u.y + u.y2) / 2); y -= R(8, 6); }
      else if (u.kind === "evac") [x, y] = P(u.x, u.y - K.LZ_RADIUS - 4);
      else [x, y] = P(u.x, u.y - 10);
      const bw = u.kind === "barricade" ? R(24, 14) : R(16, 10), bh = Math.max(3, R(2.5));
      box(dg, x - ci(bw / 2), y - bh, bw, bh, c("RED"));
      box(dg, x - ci(bw / 2), y - bh, ci(bw * Math.max(0, u.hp / u.max_hp)), bh, c("BLUE"));
      if (u.kind === "barricade" && u.defended) box(dg, x - ci(bw / 2) - 2, y - bh - 2, bw + 4, bh + 4, c("WHITE"), 1);
    }

    // effects, ordnance and targeting sights
    for (const e of gm.effects) {
      const a = e.t / e.life;
      if (e.kind === "tracer") seg(dg, ...P(e.x, e.y), ...P(e.x2, e.y2), c("YELLOW", a), 1);
      else if (e.kind === "boom") {
        const r = R(e.r * (1.15 - 0.45 * a), 2), [x, y] = P(e.x, e.y);
        ring(dg, x, y, r, c("MAGENTA", 110 * a / 255));
        ring(dg, x, y, r, c("YELLOW", 200 * a / 255), Math.max(2, 3 * lw));
      } else if (e.kind === "ring") ring(dg, ...P(e.x, e.y), R(e.r * (1.6 - a), 3), c("YELLOW", 230 * a / 255), 2 * lw);
      else if (e.kind === "splash") ring(dg, ...P(e.x, e.y), R(e.r * (1.6 - a), 2), c("WHITE", 200 * a / 255), lw);
    }
    for (const u of gm.units.values()) if (u.kind === "sniper" && u.aim) crosshair(dg, c("YELLOW", 230 / 255), ...P(...u.aim), R(5, 5), Math.max(1, lw));
    for (const sh of gm.shells) {
      if (sh.source === "car") continue;
      const a = sh.t / sh.total, [x, y] = P(sh.x, sh.y);
      if (sh.source === "artillery") {
        ring(dg, x, y, R(sh.radius), c("YELLOW", 40 / 255));
        ring(dg, x, y, R(sh.radius), c("YELLOW", 230 / 255), 2 * lw);
        ring(dg, x, y, R(sh.radius * a, 2), c("YELLOW", 160 / 255), lw);
        const px = sh.sx + (sh.x - sh.sx) * (1 - a), py = sh.sy + (sh.y - sh.sy) * (1 - a) - Math.sin((1 - a) * Math.PI) * 60;
        ring(dg, ...P(px, py), R(3, 2), c("MAGENTA"));
      } else {
        ring(dg, x, y, R(sh.radius), c("MAGENTA", 170 / 255), 2 * lw);
        ring(dg, x, y, R(sh.radius * a, 2), c("MAGENTA", 230 / 255), lw);
        const q = R(sh.radius * 0.5);
        seg(dg, x - q, y, x + q, y, c("MAGENTA", 190 / 255), 2 * lw); seg(dg, x, y - q, x, y + q, c("MAGENTA", 190 / 255), 2 * lw);
      }
    }
    for (const b of gm.bombers) seg(dg, ...P(b.x0, b.y0), ...P(b.x0 + b.ux * b.length, b.y0 + b.uy * b.length), c("MAGENTA", 120 / 255), 2 * lw);
    for (const d of gm.drones) {
      const i = d.cum.findIndex(v => v > d.dist);
      const route = [d.pos, ...(i < 0 ? [] : d.pts.slice(i))];
      if (route.length >= 2) this.polyline(dg, route.map(q => P(...q)), c("MAGENTA", 140 / 255), lw);
      if (d.dist >= d.length) {
        const f = 1 - d.hover / K.DRONE_HOVER, [x, y] = P(...d.pos);
        dg.beginPath(); dg.arc(x, y, R(12, 8), 0, -TAU * f, true);
        dg.strokeStyle = c("YELLOW"); dg.lineWidth = 2; dg.stroke();
      }
    }
    if (this.lurePath && this.lurePath.length >= 2) {
      this.polyline(dg, this.lurePath.map(q => P(...q)), c("MAGENTA", 230 / 255), 2 * lw);
      let L = 0;
      for (let i = 1; i < this.lurePath.length; i++) L += hypot(this.lurePath[i][0] - this.lurePath[i - 1][0], this.lurePath[i][1] - this.lurePath[i - 1][1]);
      this.dragInfo = `ROUTE ${Math.round(Math.min(L, K.DRONE_MAX_PATH))}/${K.DRONE_MAX_PATH}M`;
    }
    for (const u of gm.units.values()) {
      if (u.kind === "chopper" && u.escort) {
        const tgt = gm.escortPos(u.escort);
        if (tgt) { seg(dg, ...P(u.px, u.py), ...P(...tgt), c("BLUE", 110 / 255), lw); ring(dg, ...P(...tgt), R(9, 7), c("BLUE", 200 / 255), lw); }
      }
    }
    for (const u of chosen) {                 // selection brackets
      const [x, y] = P(...(u.kind === "chopper" ? [u.px, u.py] : [u.x, u.y])), b = R(11, 9);
      for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        seg(dg, x + sx * b, y + sy * b, x + sx * ci(b / 2), y + sy * b, c("YELLOW"), 2);
        seg(dg, x + sx * b, y + sy * b, x + sx * b, y + sy * ci(b / 2), c("YELLOW"), 2);
      }
    }
    for (const u of gm.movables()) {          // standing move orders
      const goal = u.kind === "chopper" ? (u.escort ? null : u.dest) : u.order;
      if (!goal) continue;
      seg(dg, ...P(u.x, u.y), ...P(...goal), c("BLUE", 170 / 255), lw);
      const [tx, ty] = P(...goal), q = R(4, 4);
      seg(dg, tx - q, ty - q, tx + q, ty + q, c("BLUE"), 2); seg(dg, tx - q, ty + q, tx + q, ty - q, c("BLUE"), 2);
    }
    this.drawPreviews(dg, hover, chosen);
    for (const d of gm.drones) drawSymbol(dg, "lure", ...P(...d.pos), R(5, 4), c("MAGENTA"), Math.max(1, lw));
    for (const u of gm.units.values()) if (u.kind === "chopper" && u.drop_t <= 0) this.drawHelicopter(dg, u.px, u.py, 0.8, u.angle + Math.PI / 2, c("BLUE"));
    for (const b of gm.bombers) {
      if (b.delay > 0) continue;
      const [x, y] = P(b.x0 + b.ux * b.dist, b.y0 + b.uy * b.dist), ang = Math.atan2(b.uy, b.ux), q = R(10, 6);
      polygon(dg, [[x + Math.cos(ang) * q, y + Math.sin(ang) * q], [x + Math.cos(ang + 2.5) * q, y + Math.sin(ang + 2.5) * q],
        [x - Math.cos(ang) * q * 0.3, y - Math.sin(ang) * q * 0.3], [x + Math.cos(ang - 2.5) * q, y + Math.sin(ang - 2.5) * q]], c("MAGENTA"));
    }

    ms.save();
    ms.globalCompositeOperation = "lighter";
    ms.drawImage(this.dyn, 0, 0);
    this.bloom(ms);
    ms.restore();
    this.ctx.drawImage(this.mapCv, this.mapRect.x, this.mapRect.y);
  }

  polyline(g, pts, color, lw) {
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.strokeStyle = color; g.lineWidth = lw; g.lineJoin = "round"; g.stroke();
  }

  drawCars(g, state, col, riders, length = 7.5, width = 3.8) {
    const gm = this.game, s = this.s;
    g.beginPath();
    let any = false;
    const dots = [];
    for (let k = 0; k < gm.nCars; k++) {
      if (gm.carState[k] !== state) continue;
      any = true;
      const x = gm.carX[k], y = gm.carY[k], fx = Math.cos(gm.carHeading[k]), fy = Math.sin(gm.carHeading[k]);
      const sx = -fy, sy = fx;
      const corner = (a, b) => [Math.round((x + fx * a * length / 2 + sx * b * width / 2) * s), Math.round((y + fy * a * length / 2 + sy * b * width / 2) * s)];
      const p = [corner(1, 1), corner(1, -1), corner(-1, -1), corner(-1, 1)];
      g.moveTo(p[0][0] + 0.5, p[0][1] + 0.5);
      for (let i = 1; i < 4; i++) g.lineTo(p[i][0] + 0.5, p[i][1] + 0.5);
      g.closePath();
      const n = Math.min(riders[k], 3);
      for (let j = 0; j < n; j++) {
        const o = (j - (n - 1) / 2) * 2;
        dots.push([ci((x + fx * o) * s), ci((y + fy * o) * s)]);
      }
    }
    if (!any) return;
    g.strokeStyle = col; g.lineWidth = 1; g.stroke();
    g.fillStyle = c("GREEN");
    for (const [x, y] of dots) g.fillRect(x, y, 1, 1);
  }

  dotSize() { return Math.max(2, Math.round(2.6 * this.s)); }

  plotAgents(g) {
    const gm = this.game, s = this.s, w = this.dyn.width, h = this.dyn.height, size = this.dotSize(), half = ci(size / 2);
    const st = gm.state, inc = gm.incubate, sick = this.blink(4);
    const groups = [
      [i => st[i] === DEAD, "DEAD", size - 1],
      [i => st[i] === CIV, "GREEN", size],
      [i => st[i] === ZOMBIE, "RED", size],
      [i => sick && st[i] === CIV && inc[i] > 0 && inc[i] < K.SYMPTOM_TIME, "RED", size],
      [i => st[i] === ZOMBIE && gm.episodeKind[i] === K.EP_LUNGE, "RED", size + 1],
      [i => st[i] === CIV && gm.vip[i], "VIP", size + 1],
    ];
    for (const [test, col, sz] of groups) {
      g.fillStyle = c(col);
      g.beginPath();
      for (let i = 0; i < gm.P; i++) {
        if (!test(i)) continue;
        const x = clamp(ci(gm.px[i] * s) - half, 0, w - sz), y = clamp(ci(gm.py[i] * s) - half, 0, h - sz);
        g.rect(x, y, sz, sz);
      }
      g.fill();
    }
    g.fillStyle = c("WHITE");
    for (let i = 0; i < gm.P; i++) {          // concealed carry: white centre
      if (st[i] === CIV && gm.ammo[i] > 0 && !gm.vip[i]) g.fillRect(clamp(ci(gm.px[i] * s), 0, w - 1), clamp(ci(gm.py[i] * s), 0, h - 1), 1, 1);
    }
  }

  /** Heavy CRT bloom of the glowing layer: average down 8x, amplify, scale back up. */
  bloom(ms) {
    const w = this.dyn.width, h = this.dyn.height;
    if (!this.glow || this.frameNo % 2 === 0) {
      if (!this.glow) { this.glowA = canvas(ci(w / 4), ci(h / 4)); this.glow = canvas(ci(w / 8), ci(h / 8)); }
      const a = this.glowA.getContext("2d"), b = this.glow.getContext("2d");
      a.imageSmoothingQuality = "high"; b.imageSmoothingQuality = "high";
      a.clearRect(0, 0, this.glowA.width, this.glowA.height);
      a.drawImage(this.dyn, 0, 0, this.glowA.width, this.glowA.height);
      b.clearRect(0, 0, this.glow.width, this.glow.height);
      b.drawImage(this.glowA, 0, 0, this.glow.width, this.glow.height);
    }
    let k = 4 / this.dotSize() ** 2;
    ms.imageSmoothingEnabled = true;
    while (k > 0.01) {
      ms.globalAlpha = Math.min(1, k);
      ms.drawImage(this.glow, 0, 0, w, h);
      k -= 1;
    }
    ms.globalAlpha = 1;
  }

  drawPreviews(g, hover, chosen) {
    const gm = this.game, s = this.s, lw = this.lw;
    const P = (x, y) => [ci(x * s), ci(y * s)];
    const spec = UNIT_SPECS[this.selected];
    if (!this.lurePath) this.dragInfo = null;
    if (this.lurePath) return;
    const k = Math.max(1, Math.round(CELL * s));
    const cellBox = (cl, color, fill) => box(g, ci((cl % GW) * CELL * s), ci(ci(cl / GW) * CELL * s), k, k, color, fill ? 0 : 1);
    if (this.drag) {
      const [x0, y0] = this.drag, end = this.screenToWorld(this.mouse, true) || this.drag;
      const [cost, [x1, y1]] = gm.dragCost(this.selected, x0, y0, ...end);
      let ok = cost > 0 && cost <= gm.cp && gm.inZone(this.selected, cellIndex(x0, y0));
      let col = ok ? COL[spec.color] : COL.YELLOW;
      if (this.selected === "barricade") {
        const { placed, seal, skipped, ends: [a, b] } = gm.barricadeLine(x0, y0, x1, y1);
        if (!gm.inZone("barricade", placed)) { ok = false; col = COL.YELLOW; }
        for (const cl of skipped) cellBox(cl, c("YELLOW", 120 / 255), false);
        for (const cl of seal) cellBox(cl, rgb(col, 150 / 255), false);
        for (const cl of placed) cellBox(cl, rgb(col, 170 / 255), true);
        seg(g, ...P(...a), ...P(...b), rgb(col, 120 / 255), lw);
        crosshair(g, c("BLUE"), ...P(x0, y0), Math.max(4, ci(3 * s)), Math.max(1, lw));
        this.dragInfo = `${placed.length} ST+${seal.length} SEAL: ${cost}CP` + (ok ? "" : " NO");
        return;
      }
      const L = hypot(x1 - x0, y1 - y0);
      seg(g, ...P(x0, y0), ...P(x1, y1), rgb(col, 230 / 255), 2 * lw);
      for (let d = 0; L > 0 && d <= L; d += spec.spacing) {
        ring(g, ...P(x0 + (x1 - x0) * d / L, y0 + (y1 - y0) * d / L), ci(spec.blast * s), rgb(col, 90 / 255), lw);
      }
      this.dragInfo = `COST ${cost} CP` + (ok ? "" : " - DENIED");
      return;
    }
    if (!hover || gm.phase === "over") return;
    const [x, y] = hover;
    if (chosen.length) {
      for (const u of chosen) seg(g, ...P(u.x, u.y), ...P(x, y), c("BLUE", 90 / 255), lw);
      ring(g, ...P(x, y), ci((12 + 6 * chosen.length) * s), c("BLUE", 200 / 255), lw);
      return;
    }
    let ok = spec.cost <= gm.cp && gm.inZone(this.selected, cellIndex(x, y));
    if (this.selected === "evac") {
      const zone = gm.lzCells(x, y);
      ok = ok && zone.length >= K.LZ_MIN_CELLS && gm.city.open[cellIndex(x, y)] && !gm.disabled.has("evac");
      for (const cl of zone) cellBox(cl, ok ? c("BLUE", 110 / 255) : c("YELLOW", 110 / 255), true);
    } else if (this.selected === "mine") {
      const col = ok ? "MAGENTA" : "YELLOW";
      ring(g, ...P(x, y), ci(K.FIRE_RADIUS * s), c(col, 40 / 255));
      ring(g, ...P(x, y), ci(K.FIRE_RADIUS * s), c(col, 170 / 255), lw);
    } else if (this.selected === "lure") {
      ring(g, ...P(x, y), ci(K.LURE_RADIUS * s), c("YELLOW", 25 / 255));
      ring(g, ...P(x, y), ci(K.LURE_RADIUS * s), c("YELLOW", 120 / 255), lw);
    } else if (spec.mode === "point" && (spec.range || spec.blast)) {
      const col = ok ? "BLUE" : "YELLOW";
      let r = (spec.range || spec.blast) + (spec.orbit || 0);
      if ((this.selected === "sniper" || this.selected === "artillery") && gm.city.indoor[cellIndex(x, y)]) r *= K.ROOFTOP_RANGE;
      ring(g, ...P(x, y), ci(r * s), c(col, 30 / 255));
      ring(g, ...P(x, y), ci(r * s), c(col, 170 / 255), 2 * lw);
    }
    drawSymbol(g, this.selected, ...P(x, y), Math.max(4, ci(6 * s)), rgb(ok ? COL[spec.color] : COL.YELLOW, 230 / 255), Math.max(2, lw));
  }

  drawLz(g, u) {
    const s = this.s, lw = this.lw, x = ci(u.x * s), y = ci(u.y * s), r = ci(K.LZ_RADIUS * s);
    if (u.offline > 0) {                      // chopper down: countdown ring, no helicopter
      const frac = 1 - u.offline / K.LZ_REPLACE_TIME;
      g.beginPath(); g.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 - TAU * frac, true);
      g.strokeStyle = c("YELLOW"); g.lineWidth = Math.max(3, 3 * lw); g.stroke();
      drawSymbol(g, "evac", x, y, Math.max(4, ci(7 * s)), this.blink(2) ? c("YELLOW") : c("BLUE"), Math.max(2, lw));
      return;
    }
    const off = this.animT * 0.8 + u.id;
    g.strokeStyle = c("BLUE"); g.lineWidth = Math.max(3, 3 * lw);
    for (let k = 0; k < 10; k++) {
      const a0 = off + k * Math.PI / 5;
      g.beginPath(); g.arc(x, y, r - g.lineWidth / 2, -a0, -(a0 + Math.PI / 8), true); g.stroke();
    }
    drawSymbol(g, "evac", x, y, Math.max(4, ci(7 * s)), c("BLUE"), Math.max(2, lw));
    const phase = (this.animT * 0.25 + u.id * 0.37) % 1, lift = Math.abs(phase - 0.5) * 2;
    this.drawHelicopter(g, u.x + 4 + lift * 60, u.y - 6 - lift * 40, 1.0, 0, c("WHITE"));
  }

  drawHelicopter(g, wx, wy, scale, heading, color) {
    const s = this.s * scale, bob = Math.sin(this.animT * 2 + wx) * 1.5;
    const x = wx * this.s, y = (wy + bob) * this.s, ch = Math.cos(heading), sh = Math.sin(heading);
    const P = (dx, dy) => [x + (dx * ch - dy * sh) * s, y + (dx * sh + dy * ch) * s];
    const w = Math.max(2, Math.round(2 * s));
    seg(g, ...P(4, 0), ...P(16, -1), color, w + 1);
    seg(g, ...P(16, -5), ...P(16, 3), color, w);
    ring(g, ...P(-2, 0), Math.max(2, ci(6 * s)), color, w);
    const ang = this.animT * 18 + wx;
    for (let k = 0; k < 2; k++) {
      const a = ang + k * Math.PI / 2, dx = Math.cos(a) * 13, dy = Math.sin(a) * 13;
      seg(g, ...P(-2 - dx, -dy), ...P(-2 + dx, dy), c("WHITE"), Math.max(1, Math.round(s)));
    }
  }

  // ---- panel ------------------------------------------------------------------

  drawPanel() {
    const gm = this.game, g = this.ctx, u = this.u, pad = this.pad, gap = this.gap, blw = this.uiLw;
    const x0 = this.panelX, pw = this.panelW, H = this.size[1];
    box(g, x0, 0, pw, H, c("BG"));
    seg(g, x0 + blw / 2, 0, x0 + blw / 2, H, c("CYAN"), blw);
    const left = x0 + pad + blw, right = x0 + pw - pad;
    const { big, med, small } = this;
    this.text("ZOMBIE EVAC", left, this.titleY, big, c("WHITE"));
    const lv = this.progress.level, diff = gm.difficulty === "medium" ? "" : gm.difficulty.toUpperCase() + " ";
    const level = gm.mission ? (gm.mission.tutorial ? "TRAINING" : "") : (lv ? `LV${lv > 0 ? "+" : ""}${lv}` : "LV 0");
    this.text((diff + level).trim() || "MENU", right, this.titleY + this.lineSize(big) / 2, small, c("YELLOW"), "midright");
    this.text(gm.mission?.unlimited_cp ? "CP UNLIMITED" : `CP ${ci(gm.cp)}`, left, this.cpY, med, c("YELLOW"));
    this.text(`T+${ci(gm.runTime / 60)}:${String(ci(gm.runTime % 60)).padStart(2, "0")}`, right, this.cpY, med, c("WHITE"), "topright");
    seg(g, left, this.sepY, right, this.sepY, c("CYAN"), blw);

    UNIT_ORDER.forEach((k, n) => {
      const spec = UNIT_SPECS[k], r = this.unitButtons[k];
      const cost = k === "barricade" ? gm.barricadeCost : spec.cost;
      const locked = gm.disabled.has(k), wait = gm.standby(k);
      const affordable = cost <= gm.cp && !locked && wait <= 0;
      let fg, icon;
      if (this.selected === k && !this.sel.size) {
        box(g, r.x, r.y, r.w, r.h, c(spec.color));
        fg = icon = c("BG");
      } else {
        box(g, r.x, r.y, r.w, r.h, affordable ? c(spec.color) : c("GRIDLINE"), blw);
        fg = affordable ? c("WHITE") : c("WHITE_DIM");
        icon = affordable ? c(spec.color) : c("WHITE_DIM");
      }
      const iconW = ci(34 * u);
      drawSymbol(g, k, r.x + ci(iconW / 2), r.y + r.h / 2, ci(7 * u), icon, Math.max(1, Math.round(1.5 * u)));
      const name = `${UNIT_KEYS[n]} ${spec.name}`;
      this.text(name, r.x + iconW, r.y + r.h / 2, small, fg, "midleft");
      let label = locked ? "LOCKED" : wait > 0 ? `STBY ${ci(Math.ceil(wait) / 60)}:${String(ci(Math.ceil(wait)) % 60).padStart(2, "0")}`
        : k === "barricade" ? `${cost}/CELL` : String(cost);
      if (wait > 0 && iconW + this.textWidth(name, small) + this.textWidth(label, small) + 3 * gap > r.w) label = label.slice(5);
      this.text(label, r.x + r.w - gap - blw, r.y + r.h / 2, small, fg, "midright");
    });

    const chosen = this.selectedUnits();
    let line1, line2, col2 = c("YELLOW");
    if (chosen.length === 1 && chosen[0].kind === "infantry") {
      const sq = chosen[0];
      const st = sq.retreating ? "RETREATING" : sq.order ? "MOVING" : sq.screening ? "SCREENING LZ" : "HOLDING";
      line1 = `SQUAD ${st} +${sq.support} SUPPORT`; line2 = "CLICK MAP: MOVE  RMB: OFF";
    } else if (chosen.length === 1 && chosen[0].kind === "engineer") {
      line1 = `ENGINEERS ${chosen[0].state.toUpperCase()}`; line2 = "CLICK MAP: MOVE  RMB: OFF";
    } else if (chosen.length) {
      const nCh = chosen.filter(u2 => u2.kind === "chopper").length;
      line1 = `${chosen.length - nCh} GROUND + ${nCh} CHOPPERS`;
      line2 = nCh ? "CLICK UNIT/VIP: ESCORT" : "CLICK MAP: GROUP MOVE";
    } else {
      const spec = UNIT_SPECS[this.selected];
      line1 = spec.desc;
      if (this.dragInfo) line2 = this.dragInfo; else { line2 = "> " + spec.how; col2 = c("WHITE_DIM"); }
    }
    this.text(line1, left, this.infoY, small, c("WHITE"));
    this.text(line2, left, this.infoY + this.lineSize(small), small, col2);

    for (const [val, r] of this.timeButtons) {
      if (val === "undo") {
        const usable = gm.canUndo() && gm.history.length > 0;
        box(g, r.x, r.y, r.w, r.h, usable ? c("YELLOW") : c("GRIDLINE"), blw);
        this.text("UNDO", r.x + r.w / 2, r.y + r.h / 2, small, usable ? c("YELLOW") : c("WHITE_DIM"), "center");
        continue;
      }
      const active = val === "pause" ? gm.paused || gm.phase === "setup" : gm.phase === "running" && !gm.paused && gm.timeScale === val;
      if (active) box(g, r.x, r.y, r.w, r.h, c("WHITE"));
      box(g, r.x, r.y, r.w, r.h, active ? c("WHITE") : c("CYAN"), blw);
      const fg = active ? c("BG") : c("WHITE"), cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      if (val === "pause") {
        const q = ci(r.h * 0.22), bw = Math.max(3, ci(q / 2));
        box(g, cx - q + 1, cy - q, bw, 2 * q, fg); box(g, cx + q - bw, cy - q, bw, 2 * q, fg);
      } else this.text(`${val}X`, cx, cy, small, fg, "center");
    }

    const [nCiv, nZ] = gm.counts();
    const stats = gm.objectiveProgress().concat([
      ["CIVILIANS", nCiv, "GREEN"], ["EVACUATED", gm.rescued, "BLUE"], ["ZOMBIES", nZ, "RED"],
      ["NEW INFECTED", gm.infected, "RED"], ["COLLATERAL", gm.casualties, "MAGENTA"], ["ZOMBIES DOWN", gm.kills, "WHITE"],
    ]);
    let y = this.statsY;
    for (const [label, val, col] of stats.slice(0, 7)) {
      this.text(label, left, y, small, c("WHITE_DIM"));
      this.text(String(val), right, y, small, c(col), "topright");
      y += this.lineSize(small);
    }
    y = this.helpY;
    seg(g, left, y - gap - blw, right, y - gap - blw, c("CYAN"), blw);
    if (gm.messageT > 0) { if (this.blink(3)) this.text("! " + gm.message.toUpperCase(), left, y, small, c("YELLOW")); }
    else this.text(gm.city.name, left, y, small, c("WHITE_DIM"));
  }

  // ---- training -------------------------------------------------------------------

  /** Split text into lines no wider than `w` at font size `px`. */
  wrap(text, px, w) {
    const out = [];
    let line = "";
    for (const word of text.split(" ")) {
      const next = line ? line + " " + word : word;
      if (line && this.textWidth(next, px) > w) { out.push(line); line = word; } else line = next;
    }
    if (line) out.push(line);
    return out;
  }

  /** The instructor's terminal at the foot of the map, typed out, plus a flashing frame on the control to use. */
  drawTutor() {
    const tu = this.tutor, step = tu.current, gm = this.game, g = this.ctx, mr = this.mapRect, u = this.u;
    const { small, pad } = this, gap = ci(6 * u), lh = this.lineSize(small);
    const width = Math.min(mr.w - 2 * pad, ci(900 * u)), inner = width - 2 * pad;
    const [civ, zed] = this.colorblind ? ["BLUE-GREY", "ORANGE"] : ["YELLOW", "RED"];
    const body = step.say.flatMap(t => this.wrap(t.replaceAll("{CIV}", civ).replaceAll("{ZED}", zed), small, inner));
    const typed = Math.floor((this.t - tu.shownAt) * 160);
    let footer, footCol = c("YELLOW");
    if (typed < body.join("").length) footer = "";
    else if (!step.done) { footer = "ENTER / CLICK HERE: CONTINUE"; footCol = this.blink(1.5) ? c("YELLOW") : c("WHITE"); }
    else footer = step.progress ? "> " + step.progress(gm) : "> AWAITING ORDERS_";
    const height = 2 * pad + lh + gap + body.length * lh + gap + lh;
    const r = { x: mr.x + (mr.w - width) / 2, y: mr.y + mr.h - height - pad - lh, w: width, h: height };
    this.tutorBox = r;
    box(g, r.x, r.y, r.w, r.h, c("BG", 235 / 255));
    box(g, r.x, r.y, r.w, r.h, c("YELLOW"), this.uiLw);
    let y = r.y + pad;
    const n = this.tutorialIndex;
    this.text(`TRAINING ${n + 1}/${TUTORIALS.length} // ${tu.lesson.title}`, r.x + pad, y, small, c("CYAN"));
    this.text(`STEP ${tu.step + 1}/${tu.lesson.steps.length}`, r.x + r.w - pad, y, small, c("WHITE_DIM"), "topright");
    y += lh + gap;
    let left = typed;
    for (const line of body) {
      const shown = line.slice(0, Math.max(0, left));
      left -= line.length;
      const cursor = left < 0 && left > -line.length && this.blink(3) ? "_" : "";
      if (shown || cursor) this.text(shown + cursor, r.x + pad, y, small, c("WHITE"));
      y += lh;
    }
    if (footer) this.text(footer, r.x + pad, y + gap, small, footCol);
    if (step.focus && this.blink(2)) {
      const rects = step.focus === "play" ? this.timeButtons.filter(([v]) => v === "pause").map(([, b]) => b)
        : step.focus === "speed" ? this.timeButtons.filter(([v]) => typeof v === "number").map(([, b]) => b)
        : step.focus === "undo" ? this.timeButtons.filter(([v]) => v === "undo").map(([, b]) => b)
        : this.unitButtons[step.focus] ? [this.unitButtons[step.focus]] : [];
      if (rects.length) {
        const x0 = Math.min(...rects.map(b => b.x)), y0 = Math.min(...rects.map(b => b.y));
        const x1 = Math.max(...rects.map(b => b.x + b.w)), y1 = Math.max(...rects.map(b => b.y + b.h)), m = this.uiLw + 2;
        box(g, x0 - m, y0 - m, x1 - x0 + 2 * m, y1 - y0 + 2 * m, c("YELLOW"), this.uiLw);
      }
    }
  }

  // ---- debrief ------------------------------------------------------------------

  drawGameOver() {
    const gm = this.game, mr = this.mapRect, g = this.ctx;
    box(g, mr.x, mr.y, mr.w, mr.h, c("BG", 190 / 255));
    const saved = gm.rescued + gm.sheltered, pct = 100 * saved / Math.max(1, gm.totalHealthy);
    const verdict = pct >= 60 ? "OUTBREAK CONTAINED" : pct >= 40 ? "CITY PARTIALLY SAVED" : pct >= 20 ? "HEAVY CASUALTIES" : "THE CITY HAS FALLEN";
    const { big, med, small } = this;
    const infectedOut = `INFECTED FLOWN OUT ${gm.carriedOut}  CHOPPERS LOST ${gm.trojans}  SICK STOPPED AT LZS ${gm.screened}`;
    const traffic = `CARS ESCAPED ${gm.carsEscaped}  CRASHED ${gm.carCrashes}  RUN OVER ${gm.roadkill}  DROWNED ${gm.drowned}`;
    let lines, buttons;
    if (gm.mission?.tutorial) {
      const ok = gm.result && gm.result.success, i = this.tutorialIndex, more = i !== null && i + 1 < TUTORIALS.length;
      lines = [[`LESSON ${i + 1}: ` + (ok ? "COMPLETE" : "FAILED"), big, ok ? c("YELLOW") : c("RED")],
        [ok ? gm.mission.title : gm.result ? gm.result.reason : "", med, c("WHITE")],
        [`EVACUATED ${gm.rescued}  INFECTED ${gm.infected}  COLLATERAL ${gm.casualties}  ZOMBIES DOWN ${gm.kills}`, small, c("WHITE_DIM")]];
      if (ok && more) {
        lines.push([`NEXT: ${TUTORIALS[i + 1].title}`, small, c("CYAN")], ["ENTER: NEXT LESSON   R: REPLAY   ESC: MENU", small, c("YELLOW")]);
        buttons = [["NEXT LESSON", () => this.nextOrRetry()], ["REPLAY", () => { gm.reset(); this.cancel(); }]];
      } else if (ok) {
        lines.push(["TRAINING COMPLETE - STORY MODE IS WAITING", small, c("YELLOW")], ["R: REPLAY   ESC: MENU", small, c("WHITE_DIM")]);
        buttons = [["REPLAY", () => { gm.reset(); this.cancel(); }]];
      } else {
        lines.push(["R / ENTER: RETRY   ESC: MENU", small, c("YELLOW")]);
        buttons = [["RETRY", () => { gm.reset(); this.cancel(); }]];
      }
      buttons.push(["LESSONS", () => { this.openMenu(); this.menuActivate("tutorials"); }]);
    } else if (gm.mission) {
      const ok = gm.result && gm.result.success, more = this.storyIndex !== null && this.storyIndex + 1 < CAMPAIGN.length;
      lines = [[`MISSION ${this.storyIndex + 1}: ` + (ok ? "COMPLETE" : "FAILED"), big, ok ? c("YELLOW") : c("RED")],
        [gm.result ? gm.result.reason : "", med, c("WHITE")],
        ...gm.objectiveProgress().map(([l, v, col]) => [`${l} ${v}`, small, c(col)]),
        [`EVACUATED ${gm.rescued}  INFECTED ${gm.infected}  COLLATERAL ${gm.casualties}  ZOMBIES DOWN ${gm.kills}`, small, c("WHITE_DIM")]];
      if (gm.carriedOut || gm.trojans || gm.screened) lines.push([infectedOut, small, c("RED")]);
      lines.push([traffic, small, c("WHITE_DIM")]);
      if (ok && more) { lines.push(["ENTER: NEXT MISSION   R: REPLAY   ESC: MENU", small, c("YELLOW")]); buttons = [["NEXT MISSION", () => this.nextOrRetry()], ["REPLAY", () => { gm.reset(); this.cancel(); }]]; }
      else if (ok) { lines.push(["CAMPAIGN COMPLETE - THE WORLD THANKS YOU", small, c("YELLOW")], ["R: REPLAY   ESC: MENU", small, c("WHITE_DIM")]); buttons = [["REPLAY", () => { gm.reset(); this.cancel(); }]]; }
      else { lines.push(["R / ENTER: RETRY   ESC: MENU", small, c("YELLOW")]); buttons = [["RETRY", () => { gm.reset(); this.cancel(); }]]; }
    } else {
      lines = [[verdict, big, c("YELLOW")], [`SAVED ${saved}/${gm.totalHealthy} (${pct.toFixed(0)}%)`, med, c("WHITE")],
        [`EVACUATED ${gm.rescued}  SHELTERED ${gm.sheltered}`, small, c("BLUE")], [`INFECTED ${gm.infected}  COLLATERAL ${gm.casualties}`, small, c("RED")]];
      if (gm.carriedOut || gm.trojans || gm.screened) lines.push([infectedOut, small, c("RED")]);
      lines.push([traffic, small, c("WHITE_DIM")]);
      const res = gm.lastResult;
      if (res) {
        const trend = { 1: "THREAT RISING", 2: "THREAT RISING FAST", [-1]: "THREAT EASING" }[res.change] || "THREAT HOLDING";
        lines.push([`${trend}: LV${res.level >= 0 ? "+" : ""}${res.level}`, med, c("YELLOW")],
          [`NEXT: ${(res.next.infected * 100).toFixed(1)}% INFECTED  POP ${res.next.population}  CP ${res.next.cp}`, small, c("WHITE")]);
      }
      lines.push(["R RESTART   N NEW CITY   ESC MENU", small, c("WHITE_DIM")]);
      buttons = [["RESTART", () => { gm.reset(); this.cancel(); }], ["NEW CITY", () => this.newCity()]];
    }
    buttons.push(["MENU", () => this.openMenu()]);
    this.drawBox(lines, buttons);
  }

  drawBox(lines, buttons) {
    const mr = this.mapRect, g = this.ctx, gap = ci(8 * this.u);
    const bh = this.lineSize(this.small) + 2 * gap;
    const total = lines.reduce((s, [, f]) => s + this.lineSize(f), 0) + gap * (lines.length - 1) + bh + 2 * gap;
    const width = Math.min(Math.max(...lines.map(([t, f]) => this.textWidth(t, f))) + 4 * this.pad, mr.w - 8);
    const bx = mr.x + mr.w / 2 - width / 2, by = mr.y + mr.h / 2 - (total + 3 * this.pad) / 2;
    box(g, bx, by, width, total + 3 * this.pad, c("BG"));
    box(g, bx, by, width, total + 3 * this.pad, c("YELLOW"), this.uiLw);
    let y = by + ci(1.5 * this.pad);
    for (const [t, f, col] of lines) { this.text(t, mr.x + mr.w / 2, y, f, col, "midtop"); y += this.lineSize(f) + gap; }
    y += gap;
    const widths = buttons.map(([t]) => this.textWidth(t, this.small) + 4 * gap);
    let x = mr.x + mr.w / 2 - (widths.reduce((a, b) => a + b, 0) + gap * 2 * (buttons.length - 1)) / 2;
    this.overButtons = buttons.map(([t, action], i) => {
      const rect = { x, y, w: widths[i], h: bh };
      const hot = this.mouse && this.inRect(this.mouse, rect);
      if (hot) box(g, rect.x, rect.y, rect.w, rect.h, rgb(mix(COL.BG, COL.YELLOW, 0.18)));
      box(g, rect.x, rect.y, rect.w, rect.h, hot ? c("YELLOW") : c("CYAN"), Math.max(2, this.uiLw - 1));
      this.text(t, rect.x + rect.w / 2, rect.y + rect.h / 2, this.small, hot ? c("YELLOW") : c("WHITE"), "center");
      x += widths[i] + 2 * gap;
      return { rect, action };
    });
  }
}
