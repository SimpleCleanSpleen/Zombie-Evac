// Zombie Evac - constants, unit specs, campaign and palette.
// Ported from zombie_evac.py (the reference implementation); names and
// values match it so the two can be compared line by line.

export const WORLD_W = 1200, WORLD_H = 900;
export const CELL = 5;
export const GW = WORLD_W / CELL, GH = WORLD_H / CELL;
export const N_CELLS = GW * GH;
export const HASH = 20;
export const HC = HASH / CELL;
export const HW = WORLD_W / HASH, HH = WORLD_H / HASH;
export const N_HASH = HW * HH;
export const FAR = 1 << 20;

export const SIM_DT = 1 / 30;
export const FAST_SIM_DT = 1 / 15;
export const MAX_STEPS_PER_FRAME = 8;
export const SPEEDS = [1, 2, 4, 8];

export const CIV = 0, ZOMBIE = 1, RESCUED = 2, DEAD = 3, IN_CAR = 4;

export const POPULATION = 5000;
export const INFECTED_FRACTION = 0.15;
export const START_CP = 350;
export const GROUND_ZEROS = [1, 3];

export const DIFFICULTY = {
  easy: { cp: 1.25, infected: 0.75, infect_rate: 0.85, civ_speed: 1.10, goal: 0.85 },
  medium: { cp: 1.0, infected: 1.0, infect_rate: 1.0, civ_speed: 1.0, goal: 1.0 },
  hard: { cp: 0.8, infected: 1.25, infect_rate: 1.15, civ_speed: 0.92, goal: 1.1 },
};

export function scaledGoal(goal, difficulty) {
  const k = (DIFFICULTY[difficulty] || DIFFICULTY.medium).goal;
  const out = { ...goal };
  if ("save_pct" in out) out.save_pct = Math.min(100, Math.round(out.save_pct * k));
  if ("save_count" in out) out.save_count = Math.round(out.save_count * k / 100) * 100;
  if ("hold_min" in out) out.hold_min = Math.min(0.95, Math.round(out.hold_min * k * 100) / 100);
  return out;
}

export function applyDifficulty(params, difficulty) {
  const d = DIFFICULTY[difficulty] || DIFFICULTY.medium;
  return { ...params, infected: Math.min(0.5, params.infected * d.infected), cp: Math.round(params.cp * d.cp) };
}

export const CIV_INDOOR = 0.7;
export const EMPTY_BUILDING_SHARE = 0.35;
export const ZOMBIE_INDOOR = 0.35;
export const ZOMBIE_BUILDINGS = 2;
export const GZ_SPREAD = 30.0;
export const CIV_SPEED = [12.0, 17.0];
export const ZOMBIE_SPEED = [7.0, 11.0];
export const INFECT_RATE = 1.5;
export const INCUBATION = [4.0, 12.0];
export const LONG_INCUBATION = [15.0, 25.0];
export const LONG_INCUBATOR_CHANCE = 0.05;
export const SYMPTOM_TIME = 6.0;
export const TURN_TIME = 1.0;
export const FEED_TIME = 3.0;

export const INDOOR_SPEED = 0.35;
export const INDOOR_COST = 20;

export const CELL_CAPACITY = 3.0;
export const CROWD_MIN = 0.2;
export const CIV_SPREAD = 0.5;
export const CIV_FEAR = 0.35;
export const FLEE_RANGE = 24;
export const IDLE_WANDER = 0.15;

export const SCENT_RANGE = 40;
export const FIELD_REFRESH = 0.5;
export const FAR_SCENT_REFRESH = 2.0;       // far-scent field rebuilt this often (the reference time-slices it)
export const BOID_SEEK = 1.0, BOID_ALIGN = 0.6, BOID_COHESION = 0.35, BOID_SEPARATION = 0.5, BOID_WANDER = 0.3;
export const BOID_STEER = 3.0;
export const HORDE_SURGE = 0.5, HORDE_SIZE = 12;
export const ZOMBIE_DPS = 0.6;
export const CHECKPOINT_SPEED = 0.3;
export const CONTACT_RADIUS = 10;

export const SQUAD_SPEED = 16.0, RETREAT_SPEED = 5.0, RETREAT_RADIUS = 16;
export const REINFORCE_RADIUS = 45, REINFORCE_MAX = 3, REINFORCE_FIRE = 0.2, REINFORCE_ARMOR = 0.15;
export const ROOFTOP_RANGE = 1.25;
export const SEAL_SNAP = 15, SEAL_MAX = 100;
export const DEFEND_RADIUS = 40, DEFEND_ARMOR = 0.5;
export const BARRICADE_ATTACKERS = 30;
export const MOVABLE = ["infantry", "engineer", "chopper"];
export const ESCORTABLE = ["infantry", "engineer", "sniper", "artillery", "evac"];
export const FORMATION_SPACING = 17;
export const CHOPPER_SPEED = 45.0;

export const ENGINEER_FLEE_SPEED = 12.0;
export const BUILD_TIME = 2.5, BUILD_RANGE = 12;
export const REPAIR_RADIUS = 20, REPAIR_RATE = 10.0;
export const ASSIST_RADIUS = 25, CHECKPOINT_ASSISTED = 0.7;

export const MINE_TRIGGER = 5, MINE_BLAST = 6;
export const FIRE_RADIUS = 16, FIRE_TIME = 10.0, FIRE_KILL_RATE = 2.0;
export const DRONE_SPEED = 12.0, DRONE_HOVER = 4.0, DRONE_BLAST = 30, DRONE_MAX_PATH = 600;
export const LURE_RADIUS = 110, LURE_WEIGHT = 2.5;
export const ESCORT_ORBIT = 25;
export const VIP_GZ_CLEARANCE = 150;

export const DROP_TIME = 4.0;
export const DROP_KINDS = ["evac", "infantry", "engineer", "sniper", "artillery", "chopper"];
export const UNLOCK_TIMES = { sniper: 30, engineer: 30, mine: 60, lure: 60, artillery: 90, chopper: 90, airstrike: 90, bombing: 90 };
export const UNLOCK_NEWS = [[30, "SNIPERS + ENGINEERS"], [60, "MINES + LURE DRONES"], [90, "ARTILLERY + AIR SUPPORT"]];
export const ARMED_FRACTION = 0.01, ARMED_RANGE = 14, ARMED_PAUSE = 0.8, ARMED_FLEE_TIME = 6.0, ARMED_FLEE_BOOST = 1.3;

export const T_SWIMMER = 1, T_DROWNER = 2, T_CLUMSY = 4, T_LUNGER = 8, T_DISTRACTED = 16;
export const SWIMMER_FRACTION = 0.40, DROWNER_FRACTION = 0.10, DROWN_AFTER = [3.0, 10.0];
export const SWIM_SPEED = 0.3, SWIM_COST = 6;
export const CLUMSY_FRACTION = 0.03, CLUMSY_RATE = 0.08;
export const STUMBLE_TIME = [1.0, 2.0], STUMBLE_SPEED = 0.25, CONFUSED_TIME = [2.0, 4.0];
export const LUNGER_FRACTION = 0.03, LUNGE_RATE = 0.5, LUNGE_TIME = 0.6, LUNGE_SPEED = 2.2, LUNGE_COOLDOWN = 3.0;
export const DISTRACTED_FRACTION = 0.05, DISTRACT_RATE = 0.05, DISTRACT_TIME = [3.0, 6.0];
export const EP_STUMBLE = 1, EP_CONFUSED = 2, EP_LUNGE = 3, EP_DISTRACTED = 4;
export const DROWN_PRESSURE = 6, HORDE_DROWN_RATE = 0.6, DROWN_PINNED = 0.35;

export const CAR_COUNT = 500;
export const CAR_PARKED = 0, CAR_DRIVING = 1, CAR_WRECK = 2, CAR_BURNT = 3, CAR_GONE = 4;
export const CAR_OCCUPIED = 0.5, CAR_RIDERS = [1, 3];
export const RUNNER_FRACTION = 0.03, RUNNER_RANGE = 60, RUNNER_SPEED = 1.2, BOARD_RANGE = 3.0;
export const CAR_START = [0.0, 20.0], CAR_SPEED = [9.0, 14.0], CAR_TURN = 5.0;
export const CAR_LOOKAHEAD = 3, CAR_LANE = 1.5;
export const CAR_SLOWDOWN_CROWD = 3, CAR_CRAWL = 0.3, CAR_CRASH_CROWD = 9, CAR_RAM_BOOST = 1.4;
export const CAR_OVERRUN = 8, CAR_UTURN_COOLDOWN = 6.0, CAR_JAM_ABANDON = 25.0;
export const CAR_HIT_RADIUS = 2.5, CAR_HIT_RATE = 1.5, CAR_CRASH_RADIUS = 5, CAR_CRASH_KILL = 0.25, CAR_RAM_DAMAGE = 80;
export const CAR_STUCK_TIME = 3.0, CAR_SLOW = 0.6, CAR_BLAST = 10, CAR_FUSE = [0.25, 0.8];

export const TRAIN_SPEED = 22.0, TRAIN_LENGTH = 72.0, TRAIN_HALF_WIDTH = 2.5;
export const TRAIN_FIRST = [5.0, 25.0], TRAIN_GAP = [12.0, 30.0];
export const BRIDGE_MIN_CELLS = 2;
export const TERRAIN_REPATH = 1.0;

export const STALEMATE_TIME = 25.0;
export const RESCUE_BONUS = 0.15;
export const LZ_LIFT_TIME = 4.0, TROJAN_PENALTY = 50, TROJAN_FLIGHT_TIME = SYMPTOM_TIME, LZ_REPLACE_TIME = 20.0;
export const SCREEN_LZ_RANGE = 40, SCREEN_RADIUS = 25;
export const LZ_RADIUS = 18, LZ_RATE = 12.0, LZ_MIN_CELLS = 8;

const C = [WORLD_W / 2, WORLD_H / 2];
export { C as MAP_CENTER };

// Story campaign: 11 missions played in order. `map` is a baked map slug
// (docs/maps/<slug>.json).
export const CAMPAIGN = [
  { id: "m1_clarksville", title: "FIRST CONTACT", location: "CLARKSVILLE, TENNESSEE", map: "clarksville_tn",
    population: 2000, infected: 0.10, ground_zeros: 1, cp: 315, goal: { save_pct: 40 },
    briefing: ["AN OUTBREAK HAS STARTED IN DOWNTOWN CLARKSVILLE.", "IT IS SMALL. KEEP IT THAT WAY.",
      "SET UP LANDING ZONES AND GET PEOPLE OUT."] },
  { id: "m2_baltimore", title: "SCALE UP", location: "BALTIMORE, MARYLAND", map: "baltimore_md",
    population: 6000, infected: 0.15, ground_zeros: 3, cp: 1120, infect_mult: 1.3, goal: { save_pct: 50 },
    briefing: ["THE STRAIN HAS MUTATED: IT SPREADS FASTER NOW.", "DOWNTOWN BALTIMORE IS PACKED. COMMAND HAS",
      "TRIPLED YOUR BUDGET. USE ALL OF IT."] },
  { id: "m3_glen_burnie", title: "PRECISION EXTRACTION", location: "GLEN BURNIE, MARYLAND", map: "glen_burnie_md",
    population: 3500, infected: 0.13, ground_zeros: 2, cp: 455, vips: 4, vip_region: { r_max: 420 }, goal: {},
    briefing: ["FOUR VIROLOGISTS ARE TRAPPED ACROSS GLEN BURNIE.", "THEY ARE OUR BEST CHANCE AT A CURE.",
      "ALL FOUR COME HOME, OR NONE OF THIS MATTERS."] },
  { id: "m4_white_house", title: "OPERATION EAGLE'S NEST", location: "THE WHITE HOUSE, WASHINGTON DC", map: "white_house_dc",
    population: 3000, infected: 0.12, ground_zeros: 2, gz_min_dist: 200, cp: 490, vips: 14, vip_region: { r_max: 240 },
    goal: { save_pct: 30 },
    briefing: ["0300 HRS. THE OUTBREAK HAS REACHED THE NATIONAL MALL.", "14 VIPS ARE SCATTERED ACROSS THE WHITE HOUSE COMPLEX.",
      "EVERY VIP GETS OUT - AND SO DO 30% OF THE PUBLIC."] },
  { id: "m5_times_square", title: "HOLD THE LINE", location: "TIMES SQUARE, NEW YORK CITY", map: "times_square_nyc",
    population: 8000, infected: 0.12, ground_zeros: 3, cp: 770, lz_rate_mult: 1 / 1.5, goal: { survive: 120, hold_min: 0.35 },
    briefing: ["MIDTOWN IS GRIDLOCKED. HELICOPTERS ARE SLOW TO", "LOAD - LZS PROCESS PEOPLE 50% SLOWER HERE.",
      "HOLD FOR TWO MINUTES UNTIL THE NAVY ARRIVES.", "IF FEWER THAN 35% REMAIN ALIVE OR EVACUATED, NYC FALLS."] },
  { id: "m6_shibuya", title: "ZERO COLLATERAL", location: "SHIBUYA CROSSING, TOKYO", map: "shibuya_crossing_tokyo",
    population: 8000, infected: 0.12, ground_zeros: 2, cp: 700, disabled: ["artillery", "bombing"],
    goal: { save_pct: 60, max_collateral: 100 },
    briefing: ["THE BUSIEST CROSSING ON EARTH, AT RUSH HOUR.", "ARTILLERY AND BOMB RUNS ARE NOT AUTHORISED.",
      "PRECISION ONLY: INFANTRY, SNIPERS, CHOPPERS.", "MORE THAN 100 CIVILIAN CASUALTIES ENDS THE MISSION."] },
  { id: "m7_arc_de_triomphe", title: "THE ALAMO", location: "ARC DE TRIOMPHE, PARIS", map: "arc_de_triomphe_paris",
    population: 5000, infected: 0.15, ground_zeros: 12, gz_region: { r_min: 300, r_max: 430 }, gz_sep: 70,
    cp: 910, lz_region: { r_max: 110 }, goal: { save_pct: 45 },
    briefing: ["TWELVE AVENUES MEET AT THE ETOILE. THE HORDE IS", "COMING DOWN ALL TWELVE.",
      "LZS CAN ONLY LAND ON THE CENTRAL ROUNDABOUT.", "BARRICADE, BUILD, REPAIR. HOLD EVERY APPROACH."] },
  { id: "m8_thames", title: "BRIDGE DEFENSE", location: "RIVER THAMES, LONDON", map: "river_thames_london",
    population: 6000, infected: 0.12, ground_zeros: 3, gz_region: { side: "south" }, gz_sep: 200,
    civ_region: { side: "north" }, cp: 910, scent_range: 250, swimmers: false, goal: { save_pct: 50 },
    briefing: ["THE OUTBREAK IS CONFINED TO THE SOUTH BANK.", "THE CITY IS NORTH OF THE RIVER. ONLY THE BRIDGES",
      "CONNECT THEM. MINE THEM. SHELL THEM. HOLD THEM."] },
  { id: "m9_venice", title: "ERADICATION", location: "VENICE, ITALY", map: "venice_italy",
    population: 3000, infected: 0.10, ground_zeros: 2, cp: 2100, swimmers: false, disabled: ["evac"],
    goal: { eradicate: true, hold_min: 0.40 },
    briefing: ["NO HELICOPTER CAN LAND IN THESE ALLEYS.", "THERE IS NO EVACUATION. THERE IS ONLY THE CURE:",
      "KILL EVERY INFECTED BEFORE IT SPREADS.", "IF FEWER THAN 40% OF RESIDENTS SURVIVE, VENICE IS LOST."] },
  { id: "m10_pyongyang", title: "MONUMENTAL DEFENSE", location: "KIM IL SUNG SQUARE, PYONGYANG", map: "kim_il_sung_square_pyongyang",
    population: 5000, infected: 0.15, ground_zeros: 3, cp: 980, barricade_cost_mult: 6, goal: { save_pct: 50 },
    briefing: ["THE AVENUES HERE ARE BUILT FOR PARADES, NOT DEFENSE.", "BARRICADES COST SIX TIMES AS MUCH ACROSS THESE GAPS.",
      "LAY DEEP MINEFIELDS. SET UP SNIPER CROSSFIRE."] },
  { id: "m11_shanghai", title: "MEGACITY", location: "THE BUND, SHANGHAI", map: "the_bund_shanghai",
    population: 12000, infected: 0.15, ground_zeros: 3, cp: 1750, infect_mult: 1.3, zombie_speed_mult: 1.15,
    vips: 8, vip_region: { side: "north" }, lz_region: { side: "south" }, goal: { save_count: 5000 },
    briefing: ["THE FINAL OUTBREAK. TEN THOUSAND PEOPLE, ONE RIVER.", "LZS CAN ONLY OPERATE SOUTH OF SUZHOU CREEK. 8 VIPS",
      "ARE TRAPPED NORTH OF IT: ESCORT THEM OVER THE BRIDGES.", "EVACUATE 5,000 PEOPLE AND EVERY VIP."] },
];

// Gruvbox-style CCTV palette (exact colours as specified).
export const COL = {
  BG: [0x28, 0x28, 0x28], RED: [0xcc, 0x24, 0x1d], GREEN: [0x98, 0x97, 0x1a], YELLOW: [0xd7, 0x99, 0x21],
  BLUE: [0x45, 0x85, 0x88], CYAN: [0x68, 0x9d, 0x6a], WHITE: [0xa8, 0x99, 0x84], MAGENTA: [0xb1, 0x62, 0x86],
};
export function mix(a, b, t) {
  return [0, 1, 2].map(i => Math.trunc(a[i] + (b[i] - a[i]) * t));
}
const PALETTE_STD = [COL.RED, COL.GREEN];
const PALETTE_CB = [[0xfe, 0x80, 0x19], [0x83, 0xa5, 0x98]];
export function setPalette(colorblind) {
  [COL.RED, COL.GREEN] = colorblind ? PALETTE_CB : PALETTE_STD;
  COL.PARK = mix(COL.BG, COL.GREEN, 0.12);
}
COL.VIP = COL.CYAN;
COL.BUILDING = mix(COL.BG, COL.CYAN, 0.10);
COL.LOT_LINE = mix(COL.BG, COL.CYAN, 0.40);
COL.PARK = mix(COL.BG, COL.GREEN, 0.12);
COL.GRIDLINE = mix(COL.BG, COL.WHITE, 0.16);
COL.DEAD = mix(COL.BG, COL.WHITE, 0.30);
COL.WHITE_DIM = mix(COL.BG, COL.WHITE, 0.55);
COL.BLACK = [0, 0, 0];
export const rgb = (c, a = 1) => a >= 1 ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${a})`;

export const UNIT_ORDER = ["evac", "barricade", "mine", "infantry", "engineer", "sniper", "artillery", "chopper",
  "airstrike", "bombing", "lure"];
export const UNIT_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "L"];
export const UNIT_SPECS = {
  evac: { name: "EVAC LZ", cost: 100, mode: "point", color: "BLUE", hp: 300, desc: "HELI LANDING ZONE", how: "CLICK OPEN GROUND" },
  barricade: { name: "BARRICADE", cost: 1, mode: "drag", max_len: 220, hp: 400, hp_per_cell: 30, color: "BLUE",
    desc: "SEALS STREET+BUILDINGS", how: "CLICK START, CLICK END" },
  mine: { name: "INCENDIARY MINE", cost: 25, mode: "point", color: "MAGENTA", desc: "FIRE TRAP. FRIENDLY FIRE", how: "CLICK. LIVE: ENGINEER BUILDS" },
  engineer: { name: "ENGINEERS", cost: 40, mode: "point", hp: 60, color: "BLUE", desc: "BUILD, REPAIR. NO GUNS", how: "CLICK TO DEPLOY" },
  lure: { name: "LURE DRONE", cost: 50, mode: "path", color: "MAGENTA", desc: "DRAWS HORDES, THEN BLOWS", how: "DRAG A FLIGHT PATH" },
  infantry: { name: "INFANTRY", cost: 30, mode: "point", range: 32, cooldown: 0.35, hp: 120, color: "BLUE",
    desc: "CLICK SQUAD TO MOVE IT", how: "CLICK TO DEPLOY" },
  sniper: { name: "SNIPER", cost: 40, mode: "point", range: 110, cooldown: 0.9, hp: 25, color: "BLUE", desc: "ROOFTOP: +25% RANGE", how: "CLICK ANYWHERE" },
  artillery: { name: "ARTILLERY", cost: 80, mode: "point", range: 360, cooldown: 6.0, hp: 35, blast: 26, shell_time: 1.2,
    color: "MAGENTA", desc: "AUTO AOE. FRIENDLY FIRE", how: "ROOFTOP: +25% RANGE" },
  chopper: { name: "CHOPPER", cost: 120, mode: "point", range: 55, orbit: 45, cooldown: 0.15, hit_chance: 0.7, color: "BLUE",
    desc: "ORBITING GUNSHIP", how: "CLICK ORBIT CENTER" },
  airstrike: { name: "AIRSTRIKE", cost: 60, mode: "point", blast: 42, delay: 2.0, color: "MAGENTA", desc: "ONE-SHOT HEAVY BLAST", how: "CLICK TARGET" },
  bombing: { name: "BOMB RUN", cost: 150, mode: "drag", max_len: 480, blast: 20, spacing: 22, plane_speed: 220, delay: 1.0,
    color: "MAGENTA", desc: "CARPET-BOMB A LINE", how: "DRAG FLIGHT PATH" },
};

export function missionObjectives(m, difficulty = "medium") {
  const g = scaledGoal(m.goal, difficulty), goals = [], rules = [];
  if ("save_pct" in g) goals.push(`EVACUATE ${g.save_pct}% OF CIVILIANS`);
  if ("save_count" in g) goals.push(`EVACUATE ${g.save_count.toLocaleString("en-US")} CIVILIANS`);
  if (m.vips) goals.push(`EVACUATE ALL ${m.vips} VIPS - LOSE ONE AND YOU FAIL`);
  if ("survive" in g) goals.push(`SURVIVE ${Math.floor(g.survive / 60)}:${String(g.survive % 60).padStart(2, "0")}`);
  if ("hold_min" in g) goals.push(`KEEP ${Math.round(g.hold_min * 100)}% OF CIVILIANS ALIVE OR EVACUATED`);
  if (g.eradicate) goals.push("ERADICATE 100% OF THE INFECTED");
  if ("max_collateral" in g) goals.push(`NO MORE THAN ${g.max_collateral} CIVILIAN CASUALTIES`);
  if (m.disabled) rules.push("LOCKED: " + m.disabled.map(k => UNIT_SPECS[k].name).join(", "));
  const zoned = new Set([...Object.keys(m.build_zones || {}), ...(m.lz_region ? ["evac"] : [])]);
  for (const kind of UNIT_ORDER) {
    if (zoned.has(kind)) rules.push(`${kind === "evac" ? "LZS" : UNIT_SPECS[kind].name + "S"} ONLY INSIDE THE MARKED AREA`);
  }
  if ((m.lz_rate_mult ?? 1) < 1) rules.push(`LZS LOAD ${Math.round((1 / m.lz_rate_mult - 1) * 100)}% SLOWER`);
  if ((m.infect_mult ?? 1) > 1) rules.push(`INFECTION SPREADS ${m.infect_mult}X FASTER`);
  if ((m.zombie_speed_mult ?? 1) > 1) rules.push("FASTER HORDES");
  if ((m.barricade_cost_mult ?? 1) > 1) rules.push(`BARRICADES COST ${m.barricade_cost_mult}X`);
  return [goals, rules];
}

export const CONTROLS = [
  ["MOUSE / TOUCH", null],
  ["LEFT CLICK / TAP", "DEPLOY / SELECT A UNIT / MOVE SELECTION"],
  ["RIGHT CLICK / LONG PRESS", "REMOVE ITEM / CANCEL / DESELECT"],
  ["BARRICADE", "CLICK START POINT, CLICK END POINT"],
  ["BOMB RUN, LURE DRONE", "DRAG THE FLIGHT PATH"],
  ["CHOPPER + CLICK UNIT/VIP", "ESCORT IT"],
  ["CLICK PANEL TITLE", "PAUSE MENU"],
  ["KEYBOARD", null],
  ["1-9, 0, L", "SELECT TOOL"],
  ["SPACE", "PLAY / PAUSE"],
  ["F   +   -", "GAME SPEED 1X-8X"],
  ["CTRL+Z", "UNDO (DEPLOY PHASE OR PAUSED)"],
  ["CTRL+A", "SELECT ALL MOVABLE UNITS"],
  ["R", "RESTART / RETRY MISSION"],
  ["ENTER", "NEXT MISSION (AFTER A WIN)"],
  ["N", "NEW CITY (ENDLESS)"],
  ["F11", "FULL SCREEN"],
  ["ESC", "PAUSE MENU / BACK"],
];

export const OPTION_ITEMS = [
  ["difficulty", "DIFFICULTY", "choice", ["easy", "medium", "hard"]],
  ["colorblind", "COLOR-BLIND PALETTE", "toggle", null],
  ["crt", "CRT FLICKER / NOISE", "toggle", null],
  ["brightness", "SCREEN BRIGHTNESS", "slider", [0.5, 1.5]],
  ["music", "MUSIC VOLUME", "slider", [0.0, 1.0]],
  ["sfx", "EFFECTS VOLUME", "slider", [0.0, 1.0]],
  ["speech", "SPEECH VOLUME", "slider", [0.0, 1.0]],
  ["back", "BACK", "action", null],
];
export const DEFAULT_OPTIONS = { colorblind: false, crt: true, brightness: 1.0, music: 0.8, sfx: 0.8, speech: 0.8, difficulty: "medium" };
