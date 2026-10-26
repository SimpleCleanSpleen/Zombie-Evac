// Training: six short guided lessons played on quiet procedural cities.
// Each lesson is a mission (same fields as CAMPAIGN entries, plus `tutorial`)
// with a list of steps. A step with `done` waits for the player to do
// something; a step without one is read and dismissed with ENTER / a click.
// `focus` names the panel control to flash: a unit kind, "play", "speed" or "undo".
// `fail` returns a reason when the step can no longer be completed.
// `begin` snapshots game state when the step starts; `done` gets it as its third argument.
import { REINFORCE_RADIUS } from "./consts.js";
import { hypot } from "./grid.js";

const units = (g, kind) => [...g.units.values()].filter(u => u.kind === kind);
const count = (g, kind) => units(g, kind).length;
const running = g => g.phase === "running";
const zombiesLeft = g => g.counts()[1];
const used = (g, what) => g.history.some(h => h[0] === what);
const evacTarget = n => ({ progress: g => `EVACUATED ${Math.min(g.rescued, n)}/${n}`, done: g => g.rescued >= n,
  fail: g => g.counts()[0] === 0 && "NO CIVILIANS LEFT TO EVACUATE" });

export const TUTORIALS = [
  {
    id: "t1_evac", title: "EVACUATION BASICS", map: "proc_1037232204",
    summary: "LANDING ZONES, THE CLOCK, GAME SPEED",
    population: 1500, infected: 0.03, ground_zeros: 1, cp: 300, goal: {},
    disabled: ["barricade", "mine", "infantry", "engineer", "sniper", "artillery", "chopper", "airstrike", "bombing", "lure"],
    steps: [
      { say: ["WELCOME, COMMANDER. THIS IS A LIVE CCTV FEED OF A CITY IN THE FIRST MINUTES OF AN OUTBREAK.",
        "GREEN DOTS ARE CIVILIANS. RED DOTS ARE THE INFECTED. EVERY CIVILIAN A ZOMBIE TOUCHES BECOMES ONE."] },
      { say: ["THE CLOCK IS STOPPED. NOTHING MOVES UNTIL YOU PRESS PLAY, SO TAKE YOUR TIME.",
        "YOUR BUDGET IS CP (COMMAND POINTS), TOP OF THE PANEL. EVERY TOOL COSTS CP."] },
      { say: ["PEOPLE ONLY SURVIVE IF A HELICOPTER TAKES THEM OUT.",
        "WITH 1 EVAC LZ SELECTED, CLICK OPEN GROUND - A ROAD, PLAZA OR PARK - AWAY FROM THE RED DOTS."],
        focus: "evac", done: g => count(g, "evac") >= 1 },
      { say: ["THE BLUE PAD IS A LANDING ZONE. CIVILIANS RUN TO THE NEAREST ONE AND HELICOPTERS LIFT THEM OUT.",
        "PLACE A SECOND LZ IN ANOTHER PART OF THE CITY SO NOBODY HAS TO RUN TOO FAR."],
        focus: "evac", done: g => count(g, "evac") >= 2 },
      { say: ["START THE CLOCK: PRESS SPACE OR CLICK THE PAUSE/PLAY BUTTON IN THE PANEL."],
        focus: "play", done: running },
      { say: ["SPEED THINGS UP: PRESS F, OR CLICK 2X, 4X OR 8X. SPACE PAUSES AT ANY TIME."],
        focus: "speed", done: g => running(g) && g.timeScale > 1 },
      { say: ["WATCH THE EVACUATED COUNT IN THE PANEL. GET 150 PEOPLE OUT."],
        ...evacTarget(150) },
      { say: ["GOOD WORK. ONE WARNING: A BITTEN CIVILIAN LOOKS HEALTHY FOR A WHILE BEFORE TURNING.",
        "IF ONE BOARDS A HELICOPTER IT CAN TURN IN FLIGHT AND BRING THE CHOPPER DOWN. YOU WILL LEARN TO SCREEN THEM."] },
    ],
  },
  {
    id: "t2_barricades", title: "BARRICADES AND UNDO", map: "proc_393421960",
    summary: "BLOCK STREETS, TAKE BACK MISTAKES",
    population: 1800, infected: 0.05, ground_zeros: 1, cp: 450, goal: {},
    disabled: ["mine", "infantry", "engineer", "sniper", "artillery", "chopper", "airstrike", "bombing", "lure"],
    steps: [
      { say: ["THE INFECTED FOLLOW THE SCENT OF THE LIVING THROUGH THE STREETS.",
        "A BARRICADE BLOCKS A STREET AND SEALS THE BUILDINGS ALONG IT. THE HORDE HAS TO GO AROUND - OR BREAK THROUGH."] },
      { say: ["FIRST, PLACE AN EVAC LZ."], focus: "evac", done: g => count(g, "evac") >= 1 },
      { say: ["SELECT 2 BARRICADE. CLICK ONE END OF THE LINE, THEN CLICK THE OTHER END.",
        "DRAW IT ACROSS A STREET. THE COST IS PER CELL OF STREET IT COVERS."],
        focus: "barricade", done: g => count(g, "barricade") >= 1 },
      { say: ["MISTAKES ARE FREE BEFORE THE CLOCK STARTS. PRESS CTRL+Z OR CLICK UNDO TO TAKE THE BARRICADE BACK.",
        "(RIGHT-CLICKING AN ITEM ALSO REMOVES IT, WITH A FULL REFUND UNTIL YOU PRESS PLAY.)"],
        focus: "undo", begin: g => count(g, "barricade"), done: (g, ui, before) => count(g, "barricade") < before },
      { say: ["NOW BUILD TWO BARRICADES ON STREETS BETWEEN THE RED OUTBREAK AND YOUR LZ."],
        focus: "barricade", done: g => count(g, "barricade") >= 2 },
      { say: ["START THE CLOCK. ONCE IT RUNS, NEW BARRICADES ARE ONLY BLUEPRINTS UNTIL ENGINEERS BUILD THEM."],
        focus: "play", done: running },
      { say: ["A BARRICADE FLASHES YELLOW WHEN IT IS UNDER ATTACK AND DIMS AS IT WEARS DOWN.",
        "HOLD THE LINE UNTIL 150 PEOPLE ARE OUT."],
        ...evacTarget(150) },
    ],
  },
  {
    id: "t3_infantry", title: "INFANTRY", map: "proc_12429725",
    summary: "DEPLOY, LINK AND MOVE SQUADS",
    population: 1800, infected: 0.08, ground_zeros: 1, cp: 450, goal: {},
    disabled: ["mine", "engineer", "sniper", "artillery", "chopper", "airstrike", "bombing", "lure"],
    steps: [
      { say: ["INFANTRY SQUADS SHOOT ANY INFECTED IN RANGE. THEY ARE YOUR MAIN WAY TO FIGHT BACK."] },
      { say: ["PLACE AN EVAC LZ."], focus: "evac", done: g => count(g, "evac") >= 1 },
      { say: ["SELECT 4 INFANTRY AND CLICK A STREET TO DEPLOY A SQUAD.",
        "A SQUAD NEXT TO AN LZ ALSO SCREENS OUT BITTEN CIVILIANS BEFORE THEY BOARD."],
        focus: "infantry", done: g => count(g, "infantry") >= 1 },
      { say: ["DEPLOY A SECOND SQUAD CLOSE TO THE FIRST. SQUADS WITHIN REACH LINK UP (A BLUE LINE)",
        "AND SUPPORT EACH OTHER: MORE FIREPOWER, MORE ARMOR."],
        focus: "infantry", done: g => {
          const sq = units(g, "infantry");
          return sq.some((a, i) => sq.some((b, j) => j > i && hypot(a.x - b.x, a.y - b.y) < REINFORCE_RADIUS));
        } },
      { say: ["CLICK ONE OF YOUR SQUADS ON THE MAP TO SELECT IT."],
        done: (g, ui) => [...ui.sel].some(id => g.units.get(id)?.kind === "infantry") },
      { say: ["NOW CLICK SOMEWHERE ELSE ON THE MAP TO ORDER IT THERE.",
        "RIGHT-CLICK OR ESC DESELECTS. A WOUNDED SQUAD FLASHES YELLOW AND FALLS BACK ON ITS OWN."],
        done: g => units(g, "infantry").some(u => u.order) },
      { say: ["CTRL+A SELECTS EVERY MOVABLE UNIT AT ONCE. TRY IT."],
        done: (g, ui) => ui.sel.size >= 2 },
      { say: ["PRESS ESC TO DESELECT, THEN START THE CLOCK."], focus: "play", done: running },
      { say: ["SEND YOUR SQUADS TOWARD THE RED DOTS AND BRING DOWN 25 INFECTED.",
        "KEEP THEM TOGETHER: A LONE SQUAD CAN BE OVERRUN."],
        progress: g => `ZOMBIES DOWN ${Math.min(g.kills, 25)}/25`, done: g => g.kills >= 25 || zombiesLeft(g) === 0 },
    ],
  },
  {
    id: "t4_support", title: "SNIPERS, MINES, ENGINEERS", map: "proc_732417712",
    summary: "SUPPORT TROOPS AND LIVE BUILDING",
    population: 2000, infected: 0.06, ground_zeros: 1, cp: 600, goal: {}, unlock_all: true,
    disabled: ["artillery", "chopper", "airstrike", "bombing", "lure"],
    steps: [
      { say: ["IN A REAL OPERATION, SNIPERS AND ENGINEERS ARRIVE AT 0:30 AND MINES AT 1:00 (WATCH THE STBY TIMERS).",
        "FOR THIS DRILL EVERYTHING IS AVAILABLE FROM THE START."] },
      { say: ["PLACE AN EVAC LZ."], focus: "evac", done: g => count(g, "evac") >= 1 },
      { say: ["6 SNIPER: LONG RANGE BUT FRAGILE. PLACED ON A ROOFTOP (INSIDE A BUILDING) IT GETS +25% RANGE.",
        "PUT ONE ON A ROOF OVERLOOKING YOUR LZ."],
        focus: "sniper", done: g => count(g, "sniper") >= 1 },
      { say: ["3 INCENDIARY MINE: A FIRE TRAP ON THE STREET. IT BURNS EVERYONE NEARBY - CIVILIANS TOO.",
        "PLACE ONE WHERE THE HORDE WILL WALK, NOT WHERE YOUR PEOPLE ARE."],
        focus: "mine", done: g => count(g, "mine") >= 1 },
      { say: ["START THE CLOCK."], focus: "play", done: running },
      { say: ["FROM NOW ON, MINES AND BARRICADES ARRIVE AS BLUEPRINTS. 5 ENGINEERS BUILD THEM (AND REPAIR BARRICADES).",
        "DEPLOY AN ENGINEER TEAM, THEN PLACE ANOTHER MINE."],
        focus: "engineer", done: g => count(g, "engineer") >= 1 && count(g, "mine") >= 2 },
      { say: ["THE ENGINEERS WALK TO THE BLUEPRINT AND BUILD IT - WATCH THE YELLOW PROGRESS BAR.",
        "THEY CARRY NO GUNS: KEEP THEM AWAY FROM THE HORDE."],
        done: g => units(g, "mine").every(u => u.built) },
      { say: ["HOLD THE AREA UNTIL 150 PEOPLE ARE OUT."],
        ...evacTarget(150) },
    ],
  },
  {
    id: "t5_fire", title: "FIRE SUPPORT", map: "proc_408797457",
    summary: "ARTILLERY, AIRSTRIKES, BOMB RUNS, LURES",
    population: 2200, infected: 0.12, ground_zeros: 2, cp: 900, goal: {}, unlock_all: true,
    disabled: ["barricade", "mine", "engineer", "sniper", "chopper"],
    steps: [
      { say: ["MAGENTA TOOLS ARE EXPLOSIVE. THEY HIT HARD, BUT THEY KILL CIVILIANS TOO.",
        "EVERY INNOCENT THEY KILL COUNTS AS COLLATERAL. SOME MISSIONS END IF COLLATERAL GETS TOO HIGH."] },
      { say: ["PLACE AN EVAC LZ."], focus: "evac", done: g => count(g, "evac") >= 1 },
      { say: ["7 ARTILLERY: FIRES ON ITS OWN AT THE THICKEST HORDE IN RANGE (THE BIG RING).",
        "PLACE IT, AND KEEP ITS TARGETS AWAY FROM YOUR LZ."],
        focus: "artillery", done: g => count(g, "artillery") >= 1 },
      { say: ["START THE CLOCK."], focus: "play", done: running },
      { say: ["9 AIRSTRIKE: ONE HEAVY BLAST TWO SECONDS AFTER YOU CLICK. AIM AT A CLUSTER OF RED."],
        focus: "airstrike", done: g => used(g, "shell") },
      { say: ["0 BOMB RUN: PRESS, DRAG A LINE AND RELEASE. BOMBS FALL ALL ALONG IT.",
        "GREAT FOR A HORDE MARCHING DOWN A LONG STREET."],
        focus: "bombing", done: g => used(g, "bomber") },
      { say: ["L LURE DRONE: PRESS AND DRAG ITS FLIGHT PATH. IT HOVERS AT THE END, DRAWS THE HORDE IN, THEN DETONATES.",
        "USE IT TO PULL ZOMBIES AWAY FROM PEOPLE."],
        focus: "lure", done: g => used(g, "drone") },
      { say: ["FINISH THE JOB: BRING DOWN 150 INFECTED."],
        progress: g => `ZOMBIES DOWN ${Math.min(g.kills, 150)}/150`, done: g => g.kills >= 150 || zombiesLeft(g) === 0 },
    ],
  },
  {
    id: "t6_choppers", title: "CHOPPERS AND VIPS", map: "proc_1037232204",
    summary: "GUNSHIPS, ESCORTS, PROTECTING VIPS",
    population: 1800, infected: 0.03, ground_zeros: 1, cp: 500, goal: {}, unlock_all: true,
    vips: 2, vip_region: { r_max: 200 },
    disabled: ["barricade", "mine", "engineer", "sniper", "artillery", "airstrike", "bombing", "lure"],
    steps: [
      { say: ["CYAN DOTS ARE VIPS - PEOPLE COMMAND NEEDS ALIVE. SOME MISSIONS FAIL IF EVEN ONE IS LOST.",
        "THERE ARE TWO IN THIS CITY."] },
      { say: ["PLACE AN EVAC LZ NEAR THE VIPS SO THEY HAVE A SHORT, SAFE RUN."], focus: "evac", done: g => count(g, "evac") >= 1 },
      { say: ["8 CHOPPER: A GUNSHIP THAT CIRCLES A POINT AND FIRES ON THE INFECTED BELOW.",
        "CLICK TO SET THE CENTRE OF ITS ORBIT."],
        focus: "chopper", done: g => count(g, "chopper") >= 1 },
      { say: ["CLICK THE CHOPPER TO SELECT IT, THEN CLICK A CYAN VIP. THE CHOPPER WILL FOLLOW AND GUARD THEM.",
        "(IT CAN ESCORT YOUR GROUND UNITS THE SAME WAY.)"],
        done: g => units(g, "chopper").some(u => u.escort) },
      { say: ["START THE CLOCK."], focus: "play", done: running },
      { say: ["GET BOTH VIPS TO AN LZ. IF THE INFECTED REACH ONE, THE LESSON FAILS - PRESS R TO TRY AGAIN."],
        progress: g => `VIPS OUT ${g.vipRescued}/${g.vipTotal}`, done: g => g.vipRescued >= g.vipTotal,
        fail: g => g.vipLost > 0 && "VIP LOST" },
      { say: ["THAT IS EVERYTHING, COMMANDER. THE STORY CAMPAIGN WILL TEST ALL OF IT.",
        "THE CONTROLS PAGE IN THE MAIN MENU LISTS EVERY SHORTCUT. GOOD LUCK."] },
    ],
  },
];
for (const t of TUTORIALS) { t.tutorial = true; t.location = `TRAINING: ${t.title}`; }

/** Walks the player through one lesson's steps. */
export class Tutor {
  constructor(lesson) {
    this.lesson = lesson;
    this.resetId = null;
    this.restart();
  }

  restart() { this.step = -1; this.justDone = false; this.enter(0, 0, null); }

  get current() { return this.lesson.steps[this.step] ?? null; }
  get finished() { return this.step >= this.lesson.steps.length; }
  get waiting() { const s = this.current; return !!s && !s.done; }   // read-and-continue step

  enter(step, t, g) {
    this.step = step; this.shownAt = t;
    this.base = g && this.current?.begin ? this.current.begin(g) : undefined;
  }

  /** Advance past a completed step; returns a failure reason if the current step can't be done. */
  update(g, ui, t) {
    if (this.resetId !== g.resetId) { this.resetId = g.resetId; this.restart(); this.enter(0, t, g); }
    this.justDone = false;
    const s = this.current;
    if (!s) return null;
    if (s.done && s.done(g, ui, this.base)) { this.enter(this.step + 1, t, g); this.justDone = true; }
    else if (s.fail) return s.fail(g) || null;
    return null;
  }

  /** Dismiss a read-and-continue step. */
  next(g, t) {
    if (!this.waiting) return false;
    this.enter(this.step + 1, t, g);
    return true;
  }
}
