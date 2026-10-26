# ZOMBIE EVAC — Game Design Document & Porting Specification

**Document version:** 3.5 (2026-10-12)
**What's new in 3.5:** people start inside buildings (some empty, some overrun) and in cars (§5); 500 cars with riders, runners, look-ahead steering, queues, U-turns, and evacuation by car (§12.11); trains on procedural maps (§12.11, §15.1); scent/flee fields are time-sliced (no 45 ms hitch, §7.3); Endless is procedural-only (no M key); symptoms and the Trojan flight window are both 6 s and guarded LZs check every boarder (§12.1).
**What's new in 3.4:** organic road-network procedural cities (§15.1); moving traffic that flees to the map edge, runs people over, crashes into crowds and leaves wrecks (§12.11); a Trojan horse crash now takes the LZ offline for 20 s instead of destroying it, and infantry posted at an LZ screen out the visibly sick (§12.1); horde drowning only takes zombies pinned against the water (§9.1); Overpass lz4 instance and per-map query timeout (§15.2).
**What's new in 3.3:** economy nerf (starting CP −30%, rescue income 0.15) and a global EASY / MEDIUM / HARD difficulty (§11, §14.3); the Trojan horse only downs a helicopter if the passenger turns within the 10 s flight, otherwise they are flown out as "infected" (§12.1); agent traits: swimmers and drowners, clumsy civilians, lunging and distracted zombies, and hordes shoving zombies into water (§9.1); the audio event system with `_TEMP_AI` placeholder assets (§16.9); EFFECTS volume and DIFFICULTY options (§1.1).
**What's new in 3.2:** variable incubation with infected civilians who keep walking, and the "Trojan horse" helicopter crash (§6, §12.1); armed civilians flee after shooting (§12.11); river bridges are crossable on real maps and Mission 8 hordes track prey across the river with a time-sliced long-range scent (§7.3, §15.2); build zones for any tool, including polygon regions (§14.4); the headless check script `zombie_evac_bench.py` (§20).
**What's new in 3.1:** mid-match paradrops, time-locked unit unlocks, street-preferring movement (indoor path cost 20), armed civilians, friendly fire on player units, abandoned cars (§12.11).
**What's new in 3.0:** the 11-mission global Story campaign with a data-driven objective/rule system (§14.4), a CONTROLS screen in the main and pause menus (§1.1) replacing the in-game hotkey text, mission regions (rings, river banks) and LZ-only zones.
**What's new in 2.0:** main menu and options (§1.1), Story Mode with VIPs (§14.4), environmental destruction (§7.4), Combat Engineers and blueprint construction (§12.8), Incendiary Mines (§12.7), Lure Drones (§12.9), Chopper Escort (§12.10), pause now freezes all sim-driven animation (§4), Overpass mirror fallback and map scaling (§15.2).
**Reference implementation:** `zombie_evac.py` (single file, Python 3.14, pygame-ce 2.5, numpy 2.x, optional osmnx 2.1)
**Audience:** an engineer or AI agent porting the game to (a) a web browser, (b) an Android app, or (c) a full Steam PC release.

> **How to use this document.** Sections 1–14 are the *rules* of the game: implement them exactly and the port will play the same. Section 15 covers presentation (exact colours, layers, effects). Section 16 is the control scheme. Section 17 is the planned tutorial system (not yet implemented). Section 18 is platform-specific porting guidance, and Section 19 is a parity checklist of measured numbers to validate a port against the reference. When this document and the Python source disagree, the **source is authoritative** — and please fix the document.

---

## Table of contents

1. Game overview
2. Architecture of the reference implementation
3. World, grids and coordinate systems
4. Simulation loop and time control
5. Population, outbreak setup and determinism
6. Agent state machine and infection
7. Terrain, pathfinding and flow fields
8. Civilian behaviour
9. Zombie behaviour (boids hordes)
10. Movement and collision rules
11. Economy: Command Points, refunds and undo
12. Units and abilities (full stats)
13. Unit health, damage and defence
14. Match end, scoring and dynamic difficulty
15. Maps: procedural generator and OpenStreetMap pipeline
16. Visual design: palette, layers, effects, HUD and panel
17. Controls and input
18. Tutorial system plan
19. Porting guide (Web / Android / Steam)
20. Parity checklist and known quirks
21. Appendix: complete constants table, data schemas, glossary

---

## 1. Game overview

**Genre:** real-time strategy / crowd-simulation sandbox, top-down, single player.
**Inspirations:** *Atom Zombie Smasher*, *Zombies Aren't Real*.
**Fantasy:** you are a remote commander watching a city through a glowing retro CCTV/CRT feed. An outbreak has just started. Thousands of civilians (green dots) are in the streets and 15% of the population (red dots) is already infected and clustered at 1–3 "ground zero" epicentres. You spend Command Points (CP) on helicopter landing zones, barricades, troops and air support to evacuate as many people as possible.

**Core loop (one match ≈ 1–4 minutes of simulated time):**

1. **Deploy phase (clock stopped).** Survey the outbreak and spend CP: place EVAC LZs, draw barricades, deploy troops and queue strikes.
2. **Live phase.** Start the clock (1×/2×/4×/8×; pause any time). Civilians run for the nearest LZ (or panic if none exist). Hordes flock toward people, infect them, and batter your defences. You keep deploying, moving troops and calling strikes, earning CP for every evacuee.
3. **Debrief.** The match ends when no civilians or no zombies remain, or nothing has changed for 25 s. You get a verdict, and the next outbreak's difficulty adapts to how many people you evacuated. In Story Mode the match instead ends on the mission's win or fail condition (§14.4).

### 1.1 Game modes, main menu and options

The game launches into a **main menu** drawn over the dimmed CCTV feed. Items appear top to bottom; disabled items are dimmed and skipped by the keyboard cursor.

| Item | Shown / enabled when | Action |
|---|---|---|
| RESUME | a match has been entered this session | return to the paused match |
| CONTINUE - M*n* *TITLE* | a valid campaign save exists (`zombie_evac_save.json`, §21.2) | open the briefing for the saved mission |
| NEW GAME - STORY MODE | always | reset the campaign save to mission 1 and open its briefing |
| ENDLESS MODE | always | a fresh procedural city with dynamic difficulty (§14.3) |
| CONTROLS | always | full keyboard / mouse reference (§17.1); Esc, Enter or a click returns |
| OPTIONS | always | options screen |
| QUIT | always | exit |

**Endless Mode** is the sandbox: organic procedural cities only (N rerolls; real-world presets are reachable only via the `--map` / `--place` command-line flags, for testing), dynamic difficulty, a debrief verdict, no win condition. **Story Mode** is a campaign of authored missions with fixed populations, VIPs and win/fail conditions; dynamic difficulty is disabled and N is disabled.

During a match, **Esc** (with nothing to cancel) pauses and opens the menu (the **pause menu**: the same list with RESUME first, including CONTROLS); RESUME or Esc returns. The in-game panel no longer prints hotkeys; the CONTROLS screen is the reference. The briefing screen shows the mission while its map loads or downloads in the background, with "ENTER: DEPLOY" once ready, or "MAP LOAD FAILED: … ENTER: RETRY" if the OpenStreetMap servers are unreachable.

**Options** (saved to `zombie_evac_options.json` when leaving the screen; applied immediately):

| Option | Type / range | Effect |
|---|---|---|
| DIFFICULTY | choice EASY / MEDIUM / HARD (default MEDIUM) | global multipliers on the match's base stats (§14.3); applies from the next match (immediately if the current match hasn't started) |
| COLOR-BLIND PALETTE | toggle (default off) | zombies `#fe8019` (orange), civilians `#83a598` (blue) instead of red/green (§16.1) |
| CRT FLICKER / NOISE | toggle (default on) | off = no rolling bar and no film grain; a static vignette + scanline overlay remains |
| SCREEN BRIGHTNESS | slider 50–150 % (default 100 %) | final full-screen multiply (< 100 %) or add (> 100 %) |
| MUSIC VOLUME | slider 0–100 % (default 80 %) | music tracks and stings (§16.9) |
| EFFECTS VOLUME | slider 0–100 % (default 80 %) | sound effects, ambience loops and UI blips |
| SPEECH VOLUME | slider 0–100 % (default 80 %) | radio voice lines |

Controls: Up/Down (or W/S) select, Left/Right (or A/D) adjust sliders and cycle choices, Enter/Space toggle or activate, mouse click (click or drag on a slider bar to set it), Esc back.

**Win condition:** there is no binary win. Success is measured as `saved = evacuated + sheltered` as a percentage of the initially healthy population (Section 14).

**Distinctive systems** (all must survive a port):

- 3,000–8,000 simulated agents with emergent crowd behaviour: bottlenecks, flocking hordes, panic.
- Real-world cities from OpenStreetMap, with building interiors passable but slow, and water impassable.
- A heavy CCTV/CRT presentation built on an exact 8-colour Gruvbox-style palette.
- Instant restart: R reseeds the same outbreak on the same map in milliseconds.

---

## 2. Architecture of the reference implementation

All of the code is in `zombie_evac.py`. The main pieces are:

| Component | Responsibility |
|---|---|
| Grid helpers (`bfs_field`, `flow_field`, `box3`, `unit`, `cells_of`, `disc_cells`, `segment_cells`, …) | Vectorised pathfinding and geometry on the nav grid (numpy). |
| `fetch_osm()` | Downloads/caches OpenStreetMap data and converts it to world coordinates. Pure data out (JSON-able). |
| `City` | Static map: terrain masks, cost grid, street cells, pre-rendered surface. Built by `City.procedural(seed)` or `City.from_osm(data)`. Never mutated during play. |
| `Progression` | Dynamic difficulty: threat level, match history, JSON persistence. |
| `Unit`, `Effect`, `Shell`, `Bomber`, `Fire`, `Drone` | Player objects (including unbuilt blueprints), visual effects, in-flight ordnance, incendiary fire pools, lure drones. |
| `CAMPAIGN` | Story mission definitions (pure data, §14.4). |
| `Game` | The entire simulation state and rules: agents (struct-of-arrays), units, fields, economy, undo stack, end conditions. **No rendering or input code.** |
| `App` | Window, layout, input, rendering, background map loading, main loop. Screen modes: `menu`, `options`, `briefing`, `game`. Owns options, campaign save and the animation clock. |

**Data-oriented design.** Agents are not objects. They are parallel arrays indexed `0..P-1`:

| Array | Type | Meaning |
|---|---|---|
| `pos` | float64 (P,2) | world position (metres) |
| `state` | int8 (P) | 0 CIV, 1 ZOMBIE, 2 RESCUED, 3 DEAD |
| `speed` | float64 (P) | personal base speed (m/s) |
| `vel` | float64 (P,2) | zombie velocity memory (used for alignment/steering) |
| `angle` | float64 (P) | wander heading (radians) |
| `busy` | float32 (P) | seconds remaining incubating (new zombie) or feeding (biter) |
| `vip` | bool (P) | this civilian is a VIP (Story Mode) |

Grid-level state lives in flat arrays of length `N_CELLS`:

| Array | Meaning |
|---|---|
| `obst` | id of the unit blocking each cell (barricades, infantry), or −1 |
| `lz_owner` | id of the LZ that owns each cell, or −1 |
| `contact_owner` | id of the unit that zombies standing in this cell attack, or −1 |
| `walk` | zombie-walkable mask: not water and no obstacle |
| `checkpoint` | cells where civilians are slowed (any obstacle cell) |
| `assist` | cells within 25 m of a Combat Engineer: civilians cross checkpoints there faster |

**Porting recommendation:** keep this split exactly. The `Game` layer should be a headless, deterministic-at-setup module (Section 5) testable without graphics. Rendering only *reads* game state.

---

## 3. World, grids and coordinate systems

| Space | Size | Notes |
|---|---|---|
| **World** | 1200 × 900 units | 1 unit = 1 metre on real maps. Origin top-left, +x right, **+y down** (screen convention). |
| **Nav grid** | 240 × 180 cells (`CELL` = 5 m), 43,200 cells | Flat index `i = cy * GW + cx`. All pathfinding, terrain, occupancy and obstacles live here. |
| **Spatial hash** | 60 × 45 buckets (`HASH` = 20 m = 4×4 cells) | Coarse aggregation: zombie/civilian density, boid neighbour sums, artillery targeting, fear gradients. |
| **Screen** | window-dependent | Map drawn at uniform scale `s` (pixels per metre); see Section 16.6. |

Helper conversions:

- `cells_of(pos)`: `cx = clip(int(x/5), 0, 239)` and `cy = clip(int(y/5), 0, 179)`.
- `cell_center(i)`: `((i % GW + 0.5) * 5, (i // GW + 0.5) * 5)`.
- `disc_cells(x, y, r)`: cells whose centre is within distance `r`.
- `segment_cells(x0, y0, x1, y1, hw)`: cells whose centre is within `hw` of the segment.

**Neighbourhood:** an 8-neighbourhood with offsets `(1,0) (−1,0) (0,1) (0,−1) (1,1) (1,−1) (−1,1) (−1,−1)`, in that order. Order matters for tie-breaking in flow fields (Section 7.2).

---

## 4. Simulation loop and time control

- **Render rate:** target 60 FPS. `real_dt` is clamped to ≤ 0.1 s.
- **Fixed simulation step:** `SIM_DT = 1/30 s` at 1× and 2×; `FAST_SIM_DT = 1/15 s` at 4× and 8×. Agents still move less than one 5 m cell per step at that rate.
- **Accumulator:** `accum += real_dt × time_scale`. Then repeat `step(dt)` while `accum ≥ dt`, at most 8 steps per frame. If the cap is hit, `accum` is reset to 0. Dropping the backlog avoids a death spiral, so effective speed can fall below the nominal 8× on slow machines.
- **Visual effects** (tracers, explosions, rings) age in **real time**, not sim time, so they stay readable at 8×. They only age while the match is running and unpaused.
- **Pause freezes everything sim-driven.** Rotor blades, chopper and LZ-helicopter bobbing, the LZ helicopters' fly-in/fly-out cycle, LZ ring rotation and fire flicker all use an **animation clock** that advances by `real_dt × time_scale` only while running and unpaused. Only UI elements (blinking banners, menu cursor) use real time.
- **Phases:**
  - `setup`: the clock is stopped and deployment is allowed.
  - `running`: may also be `paused`.
  - `over`: the debrief.

  Any speed button or Space starts the match.
- **Speeds:** `[1, 2, 4, 8]`. Choosing a speed also un-pauses.

### 4.1 Order of operations inside `step(dt)`

1. If LZs changed, rebuild the civilian **evac field** (Section 7.3). If buildings were destroyed, rebuild it too, but at most once per `TERRAIN_REPATH` = 1 s.
2. `run_time += dt`.
3. Compute cell indices and civilian/zombie index lists.
4. **Spatial hash:**
   - Per-bucket zombie counts `zc` and civilian counts `cc`.
   - `zdens = box3(zc)` and `cdens = box3(cc)`, where `box3` is a 3×3 neighbourhood sum.
   - Per-cell `occupancy` (civilians + zombies) and `crowd = box3(occupancy)`.
5. Every `FIELD_REFRESH` = 0.5 s, refresh the **scent** and **flee** fields (Section 7.3).
6. Build the engineer **assist** mask, then compute civilian velocities (Section 8) and zombie velocities (Section 9, including lure-drone pull).
7. Move civilians over `city.walk_flat` (only water blocks them), then zombies over `walk` (water and obstacles block them). Zombie `vel` is set to the *actual* displacement ÷ dt.
8. **Infection** (Section 6), then `busy -= dt`, floored at 0.
9. **Unit damage** from adjacent zombies (Section 13).
10. **Evacuation** at LZs (Section 12.1).
11. **Units update:** squad support, barricade defence, targeting, firing, movement, engineers (building, repairing, fleeing), mine triggers, chopper escort (Section 12).
12. **Ordnance update:** shells, airstrikes, bombers, fire pools, lure drones (Section 12).
13. **End check** (Section 14; Story Mode uses the mission rules in §14.4).

---

## 5. Population, outbreak setup and determinism

`reset()` builds a fresh outbreak on the *current* city without touching geometry. It runs in about 4 ms.

1. `rs = numpy.random.default_rng(seed)`. The same seed always gives the same starting outbreak, which is what makes R a fair rematch. Live gameplay randomness uses a separate unseeded RNG, so matches diverge after the start.
2. **Parameters:** in Endless they come from the difficulty system (Section 14.3): `population P`, `infected fraction f`, `starting CP`. At level 0 these are `P = 5000`, `f = 0.15`, `CP = 500`. In Story Mode they come from the mission (§14.4). Then `n_inf = int(P × f)`. Before anything else, `reset()` also restores every building destroyed in the previous match (§7.4).
3. **Street cells:** `city.street_cells`, the open road cells reachable from the map edge.
4. **Ground zeros:**
   - Count: `n_gz = rs.integers(1, 4)`, so 1–3 (Story: the mission's `ground_zeros`).
   - Candidates are street cells at least 150 m from every map edge (Story: also more than `gz_min_dist` from the mission's VIP centre).
   - Draw a random candidate and accept it if it is more than 300 m from every accepted one. Try up to 200 times.
5. **Buildings:** every footprint has an id (`City.bldg_label`, from the rasteriser), so each building's cells, size and centre are known.
6. **Infected placement:**
   - Split `n_inf` evenly across ground zeros.
   - Each outbreak has **overrun** the `ZOMBIE_BUILDINGS` = 2 buildings nearest its epicentre (centre within 130 m): `ZOMBIE_INDOOR` = 35% of its infected start inside them (uniform over their cells).
   - The rest crowd the streets around it: street cells sampled with weight `exp(−d² / (2 × 30²))`, 0 where `d > 90 m`. So zombies are much likelier than civilians to start outdoors.
   - Every agent is placed at a uniform random point inside its cell.
7. **Civilian placement:**
   - Buildings more than 90 m from every ground zero (and inside `civ_region`, if the mission has one), not overrun: `EMPTY_BUILDING_SHARE` = 35% of them are left empty.
   - `CIV_INDOOR` = 70% of civilians start inside the occupied buildings, each building weighted by `size × lognormal(0, 0.8)` so some are packed and some nearly empty.
   - The rest are uniform over street cells more than 90 m from every ground zero (and in `civ_region`).
   - Story missions use the same rules within their spawn regions (with few or no buildings in the region, everyone starts on the street).
8. **Cars:** see §12.11 — half the parked cars are given 1–3 street civilians as riders, and 3% of the remaining street civilians become runners.
7. **Speeds:**
   - Civilians: uniform 12–17 m/s.
   - Zombies: uniform 7–11 m/s.

   These are game metres, deliberately brisk.
9. **VIPs (Story only):** the first `vips` civilians are moved to open-ground cells within `vip_radius` of `vip_center`, excluding cells within `VIP_GZ_CLEARANCE` = 150 of any ground zero, and flagged `vip = True`.
10. All other state resets: no units, no fires or drones, CP from params, empty undo stack, `phase = setup`, speed 1×.

---

## 6. Agent state machine and infection

```
CIV ──(bitten)──► CIV, incubating (incubate > 0: walks, evacuates, boards helicopters)
                   └──(timer runs out)──► ZOMBIE (staggers TURN_TIME = 1 s) ──► ZOMBIE (active)
CIV ──(reaches LZ and is lifted)──► RESCUED   (removed from play)
CIV, incubating ──(boards a helicopter)──► Trojan horse: the whole load DEAD, LZ destroyed (§12.1)
CIV/ZOMBIE ──(explosion / gunfire / fire)──► DEAD   (drawn as a dim corpse dot)
```

**VIPs** are civilians with `vip = True`: identical behaviour (they evacuate, panic and crowd like everyone else), drawn in cyan `#689d6a` one pixel larger with a cyan ring. A VIP that is bitten, blown up or burned counts as **VIP lost** (`vip_lost += 1`), which fails a Story mission immediately. VIPs lifted from an LZ count toward `vip_rescued`.

**Infection rule (per step):**

1. **Turning:** every incubating civilian's `incubate` timer counts down by `dt`. At 0 it becomes ZOMBIE with a new zombie speed, `vel = 0` and `busy = TURN_TIME` = 1 s (it staggers before moving).
2. Build an owner map from every **active** zombie (`busy ≤ 0`) to the cell it stands in. Last write wins.
3. Every **healthy** civilian (`incubate == 0`) standing in a cell that has an owner is bitten with probability `p = 1 − exp(−INFECT_RATE × dt)`, where `INFECT_RATE = 1.5 /s`.
4. When bitten:
   - The civilian **stays a civilian** with `incubate` = uniform 4–12 s (`INCUBATION`), or uniform 15–25 s for the 5% long incubators (`LONG_INCUBATION`, `LONG_INCUBATOR_CHANCE`).
   - The biting zombie gets `busy = FEED_TIME` = 3 s and stops to feed.
5. `infected` counter += number bitten.

**Incubating civilians** move, panic, crowd, evacuate and shoot exactly like healthy ones, but zombies ignore them: they are not scent sources and can't be bitten again. Civilians don't fear them. They count as **infected** in every tally (`Game.counts()` returns healthy civilians and zombies + incubating), so the HUD, end conditions, `hold_min` and `eradicate` all treat them as lost. Drawn as normal civilians, they flicker red in their last `SYMPTOM_TIME` = 6 s. An incubating civilian killed by ordnance is collateral; one who boards a helicopter triggers the Trojan horse (§12.1).

Incubation and feeding are essential to balance. Without them the infection doubles every 2–3 s and the city falls in about 15 s, whatever the player does.

---

## 7. Terrain, pathfinding and flow fields

### 7.1 Terrain classes (per nav cell)

| Class | Walkable | Path cost | Speed factor | Notes |
|---|---|---|---|---|
| Open ground / street | yes | 1 | 1.0 | Streets are a subset of open ground: `street` cells are where people spawn. |
| Building interior / roof (`indoor`) | yes | `INDOOR_COST` = 20 (last resort) | `INDOOR_SPEED` = 0.35 | Everyone can enter buildings, just slowly. Snipers and artillery on indoor cells are "on the roof". |
| Water | **no** | — | — | Real maps only. Blocks everyone except air units. Bridge decks are carved out of it (§15.2). |
| Obstacle (barricade/infantry cell) | zombies: **no**; civilians: yes | — | civilians × 0.3 (× 0.7 within 25 m of an Engineer) | A "checkpoint". |
| Rubble (destroyed building cell) | yes | 1 | 1.0 | Created by heavy ordnance (§7.4); behaves exactly like open ground. |

### 7.2 Weighted wavefront (`bfs_field`)

This is a vectorised Dial's algorithm on the nav grid, the workhorse for every field.

```
dist[sources] = 0;  done = sources;  front = sources;  tent = FAR everywhere
for it = 0, 1, 2, ... while it < max_iter:
    nb = 4-neighbours(front) ∪ (diagonal neighbours(front) if it is odd)
    nb &= walkable & ~done
    tent[nb] = min(tent[nb], it + cost[nb])          # (unweighted: front = nb)
    front = (tent == it + 1) & ~done
    if front empty and no pending (tent < FAR & ~done): stop
    done |= front;  dist[front] = it + 1
```

- **Diagonals on alternate rings only.** This approximates Euclidean distance with an octagonal metric, without square roots.
- **`max_iter`** caps the search radius in cost units. Unreached cells keep `FAR = 2²⁰`.
- **Cost:** a full-grid weighted search takes about 80–110 ms in numpy. Range-limited fields are much cheaper.

**`flow_field(cost)`:** for each cell, pick the 8-neighbour with the minimum cost, padding outside the map with FAR. Ties go to the first neighbour in the offset order of Section 3. The result is that neighbour's unit vector if it is strictly lower than the cell itself, else (0,0). Agents simply look up `flow[cell]`.

### 7.3 The fields

| Field | Sources | Range | Walk mask | Refresh | Used by |
|---|---|---|---|---|---|
| **Evac** | all LZ cells | unlimited | static terrain (ignores barricades; civilians can pass them) | when LZs are added or removed | civilians |
| **Scent** | cells containing healthy (not incubating) civilians | 40 cost units | static terrain (**ignores barricades**, so hordes pile up against them) | every 0.5 s, time-sliced (below) | zombies (seek) |
| **Far scent** | same as scent | mission `scent_range` (M8: see §14.4) | static terrain | continuously, time-sliced: `FAR_SCENT_SLICE` = 4 wavefront rings per step (a 250-unit search finishes about every 2 s) | zombies with no near scent |
| **Flee** | cells containing zombies | 24 cost units | static terrain | every 0.5 s | civilians with no reachable LZ |
| **Squad order** | the group's first formation slot | unlimited | static terrain | per move order | infantry |

**Time slicing.** Scent and flee are restarted every `FIELD_REFRESH` = 0.5 s from a snapshot of the sources (`start_fields`) and then advanced `ceil(64 × dt / 0.5) + 2` wavefront rings per step (`advance_fields`); each finished field replaces the previous one, so fields lag by at most 0.5 s. The very first step of a match computes them in full. Measured worst step at 5,000 agents: 80.6 ms → 25.2 ms (p99 65.6 → 23.1 ms).

Zombies seek with the near scent field where it is non-zero and fall back to the far-scent field elsewhere (`merge_scent`). The far field exists only in missions that set `scent_range`: a full search that wide costs ~85 ms, so it is advanced a few rings per step (`bfs_iter`, a generator version of `bfs_field`) and swapped in when complete. Ports with threads can run it on a worker instead.

The **flee field** is computed as `flow_field(where(walkable, −min(d, 25), FAR))`. Descending this field moves an agent *away* from zombies. Water must be set to FAR, or panicking civilians will "flee" into the harbour.

### 7.4 Environmental destruction

Artillery shells, airstrikes and every bomb of a bomb run call `explode(x, y, r, destroy=True)`:

1. Kill every agent within `r` (as before).
2. Every **indoor** cell whose centre lies within `r` of the impact (`disc_cells`) becomes **rubble**: `indoor = False`, `cost = 1`, `open = True`. Rubble is permanent for the rest of the match and fully passable at full speed for civilians and zombies alike. Water is never affected.
3. Snipers/artillery whose own cell is no longer indoor lose their rooftop range bonus.
4. The civilian evac field is re-pathed at most once per `TERRAIN_REPATH` = 1 s (a bomb run's 20+ blasts cause one re-path, not twenty). Scent/flee fields pick the change up on their normal 0.5 s refresh.

Mine flashes and lure-drone detonations use `destroy=False`. Units and barricades are not damaged by any blast.

**Rendering:** destroyed cells are painted over the pre-rendered city with rubble (`mix(BG, white, 0.10)` base plus three deterministic `mix(BG, white, 0.32)` chips per cell), erasing the building fill and its outline there, so the original footprint is visibly cut along the blast circle.

**Reset:** the `City` keeps a pristine copy of the building mask (`indoor0`) and a per-match `rubble` mask. `Game.reset()` calls `City.restore()`, which restores the mask, costs and open-ground flags and flags the surface for a full re-render.

---

## 8. Civilian behaviour

Each civilian picks one of three modes. Apply these per agent, using cell `c`:

1. **Evacuate.** Used when at least one LZ exists and `evac_dist[c] < FAR`:
   `dir = unit(evac_flow[c] + 0.35 × fear)`.
   `fear` is the unit vector of `−∇ zdens` at the agent's hash bucket, computed with `numpy.gradient` on the 60×45 grid. Civilians already standing on an LZ pad use `wander × 0.15` instead, so they mill about while waiting for the helicopter.
2. **Panic / flee.** Used when there is no reachable LZ and `flee_flow[c] ≠ 0`, meaning a zombie is within 24 cost units: `dir = flee_flow[c]`.
3. **Idle.** Otherwise: `dir = wander × 0.15`.

`wander` is the unit vector of `angle`, which does a random walk: `angle += N(0, 1.5 × √dt)`.

**Crowding and bottlenecks** apply in every mode:

- `spread` is the unit vector down the crowd gradient, using finite differences of `crowd` at `c ± 1` and `c ± GW`.
- `dir = cap_length(dir + 0.5 × spread × min(1, occupancy[c] / 3), 1)`.
- `factor = clip(3 / max(occupancy[c], 1), 0.2, 1)`.
- Then `factor × 0.3` if `checkpoint[c]` (`× 0.7` instead if an Engineer is within 25 m, the `assist` mask), and `factor × 0.35` if `indoor[c]`.
- `velocity = dir × speed × factor`.

The result: crowds spread across a street, then slow to a crawl in narrow alleys, at checkpoints, inside buildings and on crowded pads. These bottlenecks are an intended mechanic.

---

## 9. Zombie behaviour (boids hordes)

Neighbour sums use the spatial hash with a 3×3 bucket neighbourhood (`box3`), about 60 m across. For each zombie in bucket `h`:

| Term | Formula | Weight |
|---|---|---|
| seek | `scent_flow[c]` | `BOID_SEEK` 1.0 |
| align | `unit(Σ vel of zombies in neighbourhood)` | `BOID_ALIGN` 0.6 |
| cohere | `cap_length((centroid − pos) / 30, 1)` (centroid = Σ pos ÷ count) | `BOID_COHESION` 0.35 |
| separate | `unit(−∇crowd at c) × min(1, occupancy[c] / 3)` | `BOID_SEPARATION` 0.5 |
| wander | unit(angle), `angle += N(0, 2√dt)` | `BOID_WANDER` 0.3 |

Combining the terms:

```
desired = unit(Σ weight × term)
surge   = 1 + 0.5 × min(1, (neighbours − 1) / 12)          # big hordes move up to 50% faster
speed   = base_speed × surge × (busy ≤ 0 ? 1 : 0)
factor  = clip(4.5 / max(occupancy[c], 1), 0.2, 1) × (indoor ? 0.35 : 1)
target  = desired × speed × factor
vel     = vel + (target − vel) × min(1, 3 × dt)              # steering inertia (BOID_STEER = 3/s)
```

After movement, `vel` is replaced by the zombie's actual displacement, so hordes blocked by a wall lose momentum and alignment. Zombies outside scent range drift with the horde.

**Lure drones override the seek term.** While the match is running, every zombie within `LURE_RADIUS` = 110 of a lure drone replaces `seek` with `unit(drone − pos) × LURE_WEIGHT` (2.5), so the drone out-ranks the smell of nearby people. Alignment and cohesion then pull the rest of the horde along.

---

### 9.1 Traits (breaking the "ant colony")

A small share of agents carries **trait bits** (`Game.traits`, uint8). VIPs never get any. Everything is vectorised: per-agent episode timers (`episode`, `episode_kind`, `episode_cd`) start at random with a per-second onset rate (`p = 1 − exp(−rate × dt)`) in `Game.update_traits`, and the velocity functions read them.

| Trait | Who | Share | Behaviour |
|---|---|---|---|
| **Swimmer** | civilians, maps with water, unless the mission sets `swimmers: False` (M8 Thames, M9 Venice) | 40% | Uses a second evac field in which water is walkable at path cost `SWIM_COST` = 6 per cell (rebuilt with the normal evac field, so LZ changes cost a second full search on water maps). Swims at `SWIM_SPEED` = 0.3×. Like buildings, water is only *entered* when the swimmer's own route leads into it; panicking or idle swimmers stay ashore. |
| **Drowner** | swimmers | 10% of them | Overestimated themselves: after 3–10 s (`DROWN_AFTER`, per agent) in the water they go under (DEAD, `drowned`; not collateral; a VIP would count as lost). |
| **Clumsy** | civilians | 3% | Episodes at 0.08/s: half **stumble** (1–2 s at 0.25× speed), half **confused** (2–4 s running the opposite way). |
| **Lunger** | zombies (spawned, and rolled again for every civilian who turns) | 3% | While it has a near scent, bursts at 0.5/s: 0.6 s at 2.2× speed (faster than any civilian), then 3 s cooldown. Drawn one pixel larger while lunging. |
| **Distracted** | zombies | 5% | Episodes at 0.05/s for 3–6 s: ignores the scent field (wander and flocking only; lure drones still work). |

**Horde drowning.** Zombies can't swim. Each step, a zombie whose cell holds at least `DROWN_PRESSURE` = 6 agents, whose desired velocity points at a water cell one cell ahead, and which is **pinned** there (it actually moved less than `DROWN_PINNED` = 35% of what it wanted) falls in at `HORDE_DROWN_RATE` = 0.6/s: it dies there (counts as a zombie kill and `drowned_z`). Drownings draw a white splash ring. Measured: a lure drone hovering 30 m offshore in Baltimore drowns ~18–21 of 300 packed zombies in 20 s; a procedural river city (seed 7) loses ~36 zombies per minute (without the pinned rule it was ~600, because zombies merely walking along a crowded bank fell in). Bridges crowded by hordes now shed zombies over the sides.

## 10. Movement and collision rules

`move(idx, displacement, walk_mask)`:

1. Clamp each new position to the world rectangle.
2. If the destination cell is walkable, **or** the agent is currently inside a non-walkable cell (it is allowed to escape), accept the move.
3. Otherwise try **axis-separated sliding**: an x-only move, then a y-only move.
4. If both fail, the agent stays put and gets a random new wander angle.

| Who | Blocked by |
|---|---|
| Civilians | water only (they pass barricades and squads as slow checkpoints, and buildings slowly) |
| Zombies | water, barricade cells (including sealed building cells), infantry cells |
| Infantry squads | water, cells of *other* units (Section 12.3) |
| Combat engineers | water only (they squeeze through friendly barricades and squads) |
| Lure drones | nothing (air) |
| Choppers, airstrikes, bombers | nothing (air) |

When a barricade or squad is placed or moves onto zombies, those zombies are **ejected**. Each moves to the nearest free walkable cell, searching rings of radius 1, 2, then 3 cells. Without this, zombies trapped inside a wall could walk along it.

---

## 11. Economy: Command Points, refunds and undo

- **Starting CP:** 350 at threat level 0 (`START_CP`; 500 before v3.3's −30% nerf). Each threat level changes it by −35, clamped to 175–560. Story missions use their own CP (also cut 30%, §14.4). Then × the difficulty's CP multiplier (§14.3).
- **Income:** +0.15 CP per evacuated civilian (`RESCUE_BONUS`). There is no other income. Infected passengers flown out earn nothing.
- **Costs:** see Section 12. Barricades charge 1 CP per **street** cell placed.
- **Blueprints are paid for when placed**, not when built. Undoing or removing an unbuilt blueprint in the deploy phase refunds it like any other item.
- **Removal (right-click):** removes the unit nearest the cursor within 12 m. Barricades measure distance to their segment; LZs measure distance to their edge. Removal gives a full refund **only during the deploy phase**. During live play it says "withdrawn (no refund)".
- **Undo (Ctrl+Z / UNDO button):** allowed only in the deploy phase or while paused. It pops the undo stack until it finds an entry that still exists:
  - a live unit (removed),
  - an airstrike shell still in flight,
  - a bomber that hasn't dropped its first bomb yet,
  - a lure drone that hasn't launched yet,
  - an unbuilt blueprint (barricade or mine) or a mine that hasn't been triggered.

  That entry is removed and the **exact** CP it cost is refunded. Entries already destroyed or spent are skipped silently. Messages: `Undo SNIPER +40 CP`, `Nothing to undo`, `Undo: deploy phase or paused only`.

---

## 12. Units and abilities (full stats)

Hotkeys `1`–`9`, `0` and `L` select tools in this order. The panel shows the cost label.

| # | Name | Key | Cost | HP | Range | Fire / cadence | Other | Colour |
|---|---|---|---|---|---|---|---|---|
| Key | Name | Id | Cost | HP | Range | Fire / cadence | Other | Colour |
|---|---|---|---|---|---|---|---|---|
| 1 | **EVAC LZ** | `evac` | 100 | 300 | — | lifts 12 civilians/s | radius 18 m; needs ≥ 8 open-ground cells, and the click itself must be on open ground | Blue |
| 2 | **BARRICADE** | `barricade` | 1 per street cell | 400 + 30 × street cells | — | — | two-click line, max 220 m; seals buildings for free; at most 30 attackers at once; **blueprint once live** (§12.8) | Blue |
| 3 | **INCENDIARY MINE** | `mine` | 25 | — (triggered, not attacked) | trigger 5 m | one detonation | fire pool r 16 m for 10 s; friendly fire; **blueprint once live** (§12.7) | Magenta |
| 4 | **INFANTRY** | `infantry` | 30 | 120 | 32 m | cooldown 0.35 s ÷ (1 + 0.2 × support), always hits nearest | blocks a 3×3 cell area; movable; fighting retreat; reinforcement | Blue |
| 5 | **ENGINEERS** | `engineer` | 40 | 60 | — | none (non-combatant) | builds blueprints, repairs barricades, speeds checkpoints; movable (§12.8) | Blue |
| 6 | **SNIPER** | `sniper` | 40 | 25 (frail) | 110 m (137.5 m on roof) | cooldown 0.9 s, always hits nearest | yellow crosshair on current target | Blue |
| 7 | **ARTILLERY** | `artillery` | 80 | 35 (frail) | 360 m (450 m on roof) | every 6.0 s if a target exists; shell flight 1.2 s; blast 26 m | **friendly fire**; yellow blast-radius sight; **destroys buildings** | Magenta |
| 8 | **CHOPPER** | `chopper` | 120 | invulnerable | 55 m from its orbit position | cooldown 0.15 s, 70% hit chance, random target in range | orbits radius 45 m at 1.6 rad/s; movable at 45 m/s; **escort** (§12.10) | Blue |
| 9 | **AIRSTRIKE** | `airstrike` | 60 | — | anywhere | one shot after a 2.0 s delay | blast 42 m, friendly fire; **destroys buildings** | Magenta |
| 0 | **BOMB RUN** | `bombing` | 150 | — | drag path, 20–480 m | starts after 1.0 s; plane 220 m/s; a bomb every 22 m | blast 20 m each, friendly fire; **destroys buildings** | Magenta |
| L | **LURE DRONE** | `lure` | 50 | — | lure radius 110 m | detonates once | freehand route ≤ 600 m at 12 m/s, hovers 4 s, blast 30 m (no building damage) (§12.9) | Magenta |

**All blasts kill everything inside the radius,** civilians included. Civilians killed this way count as `casualties` (shown as "COLLATERAL"). Gunfire only targets zombies.

**Placement validity:** nothing except choppers and airstrikes can be placed on water. Infantry cannot be placed on an occupied or LZ cell. Snipers, artillery, mines and engineers can go anywhere on land; for snipers and artillery an indoor cell counts as a rooftop.

### 12.1 EVAC LZ

- **Zone:** all open-ground cells within 18 m that aren't already obstacle or LZ cells.
- **Throughput:** each LZ keeps a credit, `credit = min(credit + 12 × dt, 12)`. Each step it lifts `min(int(credit), waiting)` civilians at random from those standing on its cells, then subtracts the number lifted. Each one counts as RESCUED and earns +0.15 CP.
- **Helicopter loads:** everyone lifted within one `LZ_LIFT_TIME` = 4 s window is one load (`u.load`); the window restarts when it expires (that load is away safely).
- **Infected passengers:** an **incubating** civilian whose timer has more than `TROJAN_FLIGHT_TIME` = 6 s (= `SYMPTOM_TIME`) left survives the flight: they leave play like everyone in the batch but count as infected, not rescued (`carried_out`, no CP).
- **LZ screening:** an Infantry squad within `SCREEN_LZ_RANGE` = 40 m of an LZ is **screening** it (panel: "SQUAD SCREENING LZ", a thin blue ring). Whenever its weapon is ready, it shoots the nearest *visibly sick* civilian (last `SYMPTOM_TIME` = 6 s of incubation, flickering red) within `SCREEN_RADIUS` = 25 m, before shooting zombies. The LZ itself is then **guarded**: anyone visibly sick in a batch about to board is shot at the door instead of boarding, so a guarded LZ never suffers a Trojan crash (passengers with more than 6 s left still fly out as infected). They were infected, so this is not collateral (`screened`).
- **Trojan horse:** if a batch about to be lifted contains an incubating civilian who would turn **within** `TROJAN_FLIGHT_TIME`, the helicopter crashes on its pad: the LZ goes **offline** for `LZ_REPLACE_TIME` = 20 s (no lifts; its crowd keeps waiting; boom + ring effects, a yellow countdown ring on the pad, "Replacement helicopter on station" when it's back), the player loses `TROJAN_PENALTY` = 50 CP (not below 0), and everyone in the current load plus that batch is DEAD (casualties). Those already counted are taken back off `rescued` / `vip_rescued` along with their +0.15 CP bonus; VIPs among them count as lost. HUD: "TROJAN HORSE - chopper down! Replacement inbound 20s, -50 CP".
- **Pathing:** adding or removing an LZ rebuilds the evac field. Civilians always head for the *nearest* LZ by weighted path cost.
- **Health:** zombies standing on the pad attack it (300 HP). When it's destroyed, civilians re-route to the next LZ.
- **Design intent:** throughput, not distance, limits a single LZ. One LZ saves about 15–24% at baseline; two save about 30–45%.

### 12.2 Barricade (two-click checkpoint line)

1. The first click anchors the start, and the second click places the line. Right-click or Esc cancels. The line is clamped to 220 m.
2. **Seal extension** runs at each end, outward along the line's own direction:
   1. Walk up to `SEAL_SNAP` = 15 m across open ground looking for a building. If the walk leaves the map, hits water, or finds no building, there is no extension at that end.
   2. Otherwise continue through the building in steps of 2.5 m until the next cell is no longer indoor (the building's far wall), or until `SEAL_MAX` = 100 m.
3. **Cells:** `segment_cells(extended line, half-width 5.25 m)`. Of these, the *free* ones are walkable, not LZ, and not occupied.
   - `street` = free ∩ open ground. These are built and **charged at 1 CP each**.
   - `seal` = free ∩ indoor. These are built for **free**.
   - The line needs at least one street cell, or it fails with "No open street under that line".
4. All street and seal cells become obstacle cells: zombies can't pass, and civilians pass at 0.3× speed.
5. **Health:** 400 + 30 × street cells. Damage comes from every active zombie in the ring of cells surrounding the barricade, street or indoor, **capped at 30 attackers**. Damage is halved while any infantry squad is within 40 m of the extended segment (`defended`). When the barricade breaks: "BARRICADE BREACHED!" alert and the cells reopen.
6. **Limit:** a barricade is a wall, not a ring. Zombies route around the whole block via other streets, so enclosing an area takes several barricades.

### 12.3 Infantry squads

- **Footprint:** blocks the 3×3 cells around its centre cell, except cells already occupied or LZ. Its position snaps to the cell centre on deployment.
- **Targeting:** the nearest zombie within 32 m, a guaranteed kill, with a yellow tracer.
- **Reinforcement:** a squad's `support` is the number of other squads within 45 m, capped at 3.
  - Fire cooldown is divided by `1 + 0.2 × support`.
  - Damage taken is multiplied by `1 − 0.15 × support`.
  - Supported squads show blue pips under their symbol and blue link lines to their neighbours.
- **Fighting retreat:** if any zombie is within 16 m, the squad moves *away from the centroid of those zombies* at 5 m/s while still firing. Retreat overrides move orders. The symbol flashes yellow.
- **Move orders:**
  - The squad follows the order's flow field at 16 m/s (× terrain factor).
  - Within 30 m of its slot, or when the flow field is zero, it heads straight for its slot. It arrives when within 1.5 m.
  - If its next cell belongs to another unit, it tries a sidestep perpendicular to its heading. If it stays blocked for 1.5 s (and isn't retreating), it abandons the order and holds where it is.
- **Relocation:** whenever the squad's centre cell changes, its obstacle footprint and contact cells move with it, and zombies are ejected from the new footprint.

### 12.4 Choppers

- **Orbit:** the position orbits the orbit centre at radius 45 m, `angle += 1.6 × dt`.
- **Firing:** every 0.15 s it picks a *random* zombie within 55 m of its current position. It kills it 70% of the time; otherwise it fires a tracer at a point scattered by `N(0, 4)` m.
- **Moving:** a move order flies the orbit centre straight to the new spot at 45 m/s. A move order cancels escort.

### 12.5 Artillery targeting

Every 6 s, the battery evaluates every hash bucket centre within range:

```
score = zdens − 3 × cdens                  # densest horde, avoiding civilians
```

If the best score is at least 4, it fires a shell at that bucket's centre. The shell flies in a visual arc 60 m high for 1.2 s, then explodes with a 26 m blast. On a rooftop the range is 450 m.

### 12.6 Group selection and formations (Ctrl+A)

- **Selection:** Ctrl+A selects every movable unit (infantry and choppers). Clicking one unit selects only that unit; clicking it again deselects it.
- **Issuing the order:** with a selection active, a left-click on the map issues a group move.
- **Formation slots:**
  - Candidates are walkable, non-LZ cells within `40 + 12n` m of the target, where n is the group size.
  - Cells occupied by units outside the group are excluded.
  - Candidates are sorted by distance to the target, plus an 8 m penalty for indoor cells (open ground is preferred).
  - Slots are chosen greedily, each at least 17 m (`FORMATION_SPACING`) from every slot already chosen, until there are n.
- **Assignment:** movers are sorted by distance to the target, and each claims the nearest free slot. If there are more units than slots, the last slot is shared.
- **Pathing:** one weighted path search from the first slot serves the whole group (about 0.1 s regardless of group size). Each unit uses it, then makes a straight final approach to its own slot. Choppers fly straight to their slot. Engineers are movable too and take part in group moves.

### 12.7 Incendiary mine

- **Placement:** click anywhere on land. In the deploy phase it is armed instantly; once the clock has started it is placed as a **blueprint** that an Engineer must build (§12.8).
- **Trigger:** when any active zombie comes within `MINE_TRIGGER` = 5 m of an armed mine, the mine is removed and detonates: a small flash (`MINE_BLAST` = 6 m, kills, no building damage) and a **fire pool**.
- **Fire pool:** radius `FIRE_RADIUS` = 16 m, lasts `FIRE_TIME` = 10 s. Each step, every civilian or zombie inside dies with probability `1 − exp(−FIRE_KILL_RATE × dt)`, `FIRE_KILL_RATE` = 2.0/s. Hordes flowing into it are thinned out, and it denies the area for its duration. **Friendly fire:** civilians (and VIPs) burn too.
- Mines have no HP and can't be attacked; they can be undone/refunded until triggered.

### 12.8 Combat Engineers and mid-match construction

**Blueprints.** In the deploy phase, barricades and mines are placed instantly. After the clock starts (running or paused), placing either creates an unbuilt **blueprint**: it costs CP immediately, is drawn as a dashed white outline with a yellow progress bar, does **not** block zombies or slow civilians, and can't be attacked. If no Engineers are deployed, the player gets "Blueprint placed - deploy ENGINEERS to build it".

**Engineers** (`engineer`, 40 CP, 60 HP, movable, non-combatant). Each step, in priority order:

1. **Flee:** if any zombie is within 16 m, run directly away from their centroid at `ENGINEER_FLEE_SPEED` = 12 m/s (symbol flashes yellow). Construction pauses.
2. **Manual order:** if the player gave a move or group-move order, follow it (same flow-field + final-approach logic as squads, 16 m/s, 35% indoors).
3. **Build:** otherwise claim the nearest unclaimed blueprint (one engineer per blueprint), compute a weighted path to its **site** (barricade: the street cell nearest the middle of the line; mine: its position), walk there, and work while within `BUILD_RANGE` = 12 m. Progress advances by `dt / BUILD_TIME` (2.5 s). At 100% the blueprint **activates**: a barricade claims its planned cells that are still free, ejects any zombies standing there, starts blocking and gains its HP; a mine arms.
4. **Repair:** when idle or building, heal one damaged built barricade whose extended segment is within `REPAIR_RADIUS` = 20 m by `REPAIR_RATE` = 10 HP/s (per engineer, stacking).

**Checkpoint assist.** Civilians on checkpoint cells (barricades, squads) within `ASSIST_RADIUS` = 25 m of any Engineer cross at `CHECKPOINT_ASSISTED` = 0.7× instead of 0.3×.

Engineers move through friendly barricades and squads (only water blocks them), can be attacked from cells within 10 m, and show their state in the panel when selected (IDLE / MOVING / BUILDING / REPAIRING / FLEEING).

### 12.9 Lure drone

- **Input:** select the tool and **drag a freehand route** on the map (points are recorded every 8 m while the mouse is held; release to launch). Routes are clipped to `DRONE_MAX_PATH` = 600 m; under 20 m is rejected.
- **Flight:** once the clock is running, the drone flies the route at `DRONE_SPEED` = 12 m/s (deliberately slow so hordes can keep up), then **hovers** at the end for `DRONE_HOVER` = 4 s (a yellow countdown arc), then **detonates**: `DRONE_BLAST` = 30 m, kills everything inside, **no building damage**.
- **Lure:** throughout, zombies within `LURE_RADIUS` = 110 m steer toward it (§9). A pulsing yellow ring shows the lure radius and a magenta line shows the remaining route.
- Undo refunds it only before it launches.

### 12.10 Chopper escort

- Select one or more choppers (click, or Ctrl+A), then **click any friendly unit** (infantry, engineers, sniper, artillery, LZ) **or a VIP**. The selected choppers break their static orbit and escort the target: every step their orbit centre's destination is set to the target's position, flying at 45 m/s, with a tighter orbit (`ESCORT_ORBIT` = 25 m) for close air cover. Any non-chopper units in the same selection group-move to the target's position.
- If the target is destroyed, evacuated or killed, the chopper holds at its last position ("Escort target lost - chopper holding").
- A normal move order cancels escort. A blue tether line and ring mark the escorted target.


### 12.11 Escalation and hazards

**Paradrop.** Any EVAC LZ, Infantry, Engineers, Sniper, Artillery or Chopper placed after the clock starts (running or paused) is charged immediately but **lands after `DROP_TIME` = 4 s**. Until then it is completely inactive: no obstacle cells, no LZ pad, no contact cells (can't be attacked), no firing or moving, and it is ignored by blasts. On landing (`Game.land`) it claims the ground as it is at that moment (infantry footprint and LZ pad recomputed), then registers like a setup-phase unit. Visual: a yellow crosshair that shrinks from radius 16 to 4, a shadow ellipse that darkens, and the unit's dim glyph descending from 40 m above. Units placed during the deploy phase arrive instantly.

**Unlocks (escalation).** Every match starts with only **EVAC LZ, Barricade and Infantry**. Tools unlock on the match clock (`run_time`, so they are all locked during the deploy phase): Snipers and Engineers at **0:30**, Incendiary Mines and Lure Drones at **1:00**, Artillery, Chopper, Airstrike and Bomb Run at **1:30** (`UNLOCK_TIMES`). Locked tools show `STBY m:ss` (just `m:ss` if the row is tight) in place of their cost and are dimmed; trying to place one says "<NAME> on standby - Ns". At each threshold the HUD announces "SNIPERS + ENGINEERS / MINES + LURE DRONES / ARTILLERY + AIR SUPPORT NOW AVAILABLE". Mission `disabled` tools stay LOCKED.

**Street-preferring movement.** Indoor cells cost 20 in every path search, so routes avoid buildings unless there is no other way. In addition, an agent standing on open ground may only step **into** a building cell if its own path field points into that building: zombies use the scent field, civilians use the evac field (or the flee field without a reachable LZ). Wander, cohesion, separation and crowd spreading can no longer push anyone through walls. Agents already inside may always leave. Measured on a procedural city after 25 s with an LZ: 0% of zombies and civilians indoors (73% before). Without an LZ, about 40% of panicking civilians flee into buildings when that is the only way away from zombies, and hordes follow the scent in.

**Armed civilians (concealed carry).** 1% of non-VIP civilians (`ARMED_FRACTION`) carry 1–2 rounds (`ammo`). Each step, an armed civilian in a bucket with zombie density shoots the nearest active zombie within `ARMED_RANGE` = 14 m: a guaranteed kill, one round, and the civilian stops for `ARMED_PAUSE` = 0.8 s. Each shot also sets `panic = ARMED_PAUSE + ARMED_FLEE_TIME` (6 s): while it lasts and zombies are within flee range, they run down the flee field (even if an LZ is reachable) at `ARMED_FLEE_BOOST` = 1.3× speed, then resume evacuating. With no ammo they are ordinary civilians. Drawn with a white centre pixel. (Measured: 42 armed of 4,250, killing about 20 zombies in 40 s without any player units.)

**Friendly fire on player units.** Every explosion (artillery, airstrike, bomb run, lure drone, mine flash, car cook-off) kills all civilians and zombies in its radius **and destroys every player unit inside it**: infantry, engineers, snipers, artillery, LZs, and choppers (judged at their current orbit position). Mines caught in a blast go up into a fire pool. Barricades and units still paradropping are unaffected. HUD: "Friendly fire: n unit(s) lost".

**Traffic.** `CAR_COUNT` = 500 cars (at most one per 8 street cells) start **parked** on random street cells (same spots every match, seeded by the city). All car state is in arrays on `Game` (`car_pos`, `car_heading`, `car_speed`, `car_state`, `car_edge`, …), updated vectorised in `Game.update_traffic` once per step after agents move. Cars never trigger a re-path.

- **Who drives:** at reset, `CAR_OCCUPIED` = 50% of the cars get 1–3 riders taken from the street civilians (never VIPs or armed civilians): those agents switch to state `IN_CAR` (`in_car` = their car), are hidden, ride along, can't be bitten, and pull out `CAR_START` = 0–20 s after the clock starts. Empty cars stay parked unless a **runner** claims them: `RUNNER_FRACTION` = 3% of the other street civilians each claim the nearest unclaimed empty car within `RUNNER_RANGE` = 60 m and sprint straight at it (no flow field; 1.2× speed, may cut through buildings); within `BOARD_RANGE` = 3 m they get in and the car leaves at once. A runner who dies, turns or loses the car gives up.
- **Routes:** `City.car_routes()` computes, once per map and cached, an unweighted road-only (`street` mask) wavefront from each map edge: four flow fields. Each car picks a random edge it can reach (another one if not; none: it is abandoned and starts as a wreck).
- **Steering:** the car looks `CAR_LOOKAHEAD` = 3 cells ahead along its route and steers (≤ `CAR_TURN` = 5 rad/s) at that point offset `CAR_LANE` = 1.5 m to the right, which gives smooth curves and keep-right lanes. It may use any open ground; if the next position isn't open ground it turns straight onto its route; `CAR_STUCK_TIME` = 3 s without moving = abandoned.
- **Queues:** a moving car in the next cell stops it; one two cells ahead, or a parked car / wreck ahead, slows it to 0.4×. Nose-to-tail for `CAR_JAM_ABANDON` = 25 s: everyone gets out and walks, and the car is left as a wreck.
- **Crowds and hordes:** people (civilians) ≥ `CAR_SLOWDOWN_CROWD` = 3 in the 3×3 cells ahead: crawl at 0.3× and honk. Only zombies ahead: floor it at `CAR_RAM_BOOST` = 1.4×. Anyone ≥ `CAR_CRASH_CROWD` = 9 ahead, or a barricade / squad cell: **crash**. Zombies ≥ `CAR_OVERRUN` = 8 around the road two cells ahead: **U-turn** onto another exit route that leads back the way it came (at most every 6 s; no multi-point turns).
- **Run-overs:** a car at full speed kills anyone within `CAR_HIT_RADIUS` = 2.5 m at `CAR_HIT_RATE` = 1.5 per second. Per-cell lookup: each agent is only tested against the car whose 3×3 neighbourhood its cell is in.
- **Crash:** the car becomes a wreck, its riders spill out, everyone within `CAR_CRASH_RADIUS` = 5 m dies with chance `CAR_CRASH_KILL` = 0.25, and a barricade or unit it hits loses `CAR_RAM_DAMAGE` = 80 HP. Civilians killed by traffic (and trains) are `roadkill`, not collateral; zombies count as kills.
- **Escape:** a car that drives off the map is gone; its riders count as **evacuated** (`rescued`, +0.15 CP each, `car_evacuated`), infected riders as carried out.
- **Wrecks and parked cars** slow anyone crossing their cell to `CAR_SLOW` = 0.6× (`car_slow`, recomputed only when a car changes state). They never block movement.
- **Volatile:** any blast covering a parked, moving or wrecked car queues a secondary explosion there after 0.25–0.8 s (`CAR_BLAST` = 10 m, no building damage, full friendly fire), which can chain into neighbouring cars; anyone still inside dies (collateral). Blown cars stay as burnt wrecks (still slow).
- **Drawn** as hollow boxes 7.5 × 3.8 m (larger than life, to read on the map) with a green dot per rider: parked light grey, wrecks dimmer, burnt dark (map layer); moving cars white on the glow layer.

**Trains (procedural maps only).** Each railway (§15.1) has one train, `TRAIN_LENGTH` = 72 m (4 carriages, yellow nose), at `TRAIN_SPEED` = 22 m/s. It enters `TRAIN_FIRST` = 5–25 s after the clock starts, crosses the whole map, waits off-map `TRAIN_GAP` = 12–30 s, then comes back the other way, and so on. Anything within `TRAIN_HALF_WIDTH` = 2.5 m of its body is destroyed: people and zombies (`train_kills`, counted as roadkill / kills), cars (riders included), and ground units and barricades. Real-world maps carry no rail data yet, so they have no trains.


---

## 13. Unit health, damage and defence

- **Contact map:** for every unit with HP, mark the cells from which zombies can attack it:
  - LZ: its own pad cells.
  - Barricade or infantry: the 1-cell ring around its footprint, which includes indoor cells.
  - Sniper or artillery: all cells within 10 m (`CONTACT_RADIUS`), so zombies inside the building can reach a rooftop unit.

  The map is rebuilt whenever units are added, removed or moved. Where contact zones overlap, the last unit written wins.
- **Damage per step:** count active zombies (`busy ≤ 0`) per contact owner, then

  `hp −= n × ZOMBIE_DPS(0.6) × armour × dt`

  - Barricades: `n = min(n, 30)`.
  - `armour` = `1 − 0.15 × support` for infantry, 0.5 for a defended barricade, and 1 otherwise.

  The unit's `last_hit` time is stored for the "under attack" flash.
- **Destruction:** the unit is removed, its cells reopen, and an expanding yellow ring plays. The message is "SNIPER destroyed!" and so on, or "Barricade breached!" for barricades.
- **Engineers** (60 HP) use the 10 m disc contact zone, like snipers. **Blueprints** have no contact zone and can't be damaged until built. **Mines** have no HP.
- **Repairs:** Engineers restore barricade HP (§12.8).
- **Health bars** appear only on damaged units: a red track with a blue fill. Barricade bars are wider and get a white outline when defended.

---

## 14. Match end, scoring and dynamic difficulty

### 14.1 End conditions (checked each step, only while not already over)

The match ends when **any** of these is true:

- no civilians remain;
- no zombies remain;
- `quiet > 25 s`, where `quiet` is the time since any of (rescued, infected, casualties, kills) last changed. This covers a stalemate: a contained horde or sheltered survivors.

At the end, `sheltered` = the civilians still alive. The match result is recorded **exactly once**. These rules apply to Endless Mode; Story missions use §14.4 instead.

### 14.2 Debrief

- `saved = evacuated + sheltered`.
- `pct = saved / total_healthy`, where `total_healthy` is the initial civilian count.

| pct | Verdict |
|---|---|
| ≥ 60% | OUTBREAK CONTAINED |
| ≥ 40% | CITY PARTIALLY SAVED |
| ≥ 20% | HEAVY CASUALTIES |
| < 20% | THE CITY HAS FALLEN |

The debrief box shows: the verdict; `SAVED x/y (pct)`; `EVACUATED a SHELTERED b`; `INFECTED c COLLATERAL d`; the threat trend and next-match parameters; and `R RESTART N NEW M MAP`.

### 14.3 Dynamic difficulty (`Progression`)

Difficulty adapts using **evacuated %** only, meaning `rescued / total_healthy`, not counting sheltered survivors:

| Evacuated % | Threat level change |
|---|---|
| ≥ 75 | +2 ("THREAT RISING FAST") |
| ≥ 50 | +1 ("THREAT RISING") |
| < 20 | −1 ("THREAT EASING") |
| otherwise | 0 ("THREAT HOLDING") |

The level is clamped to −3…+6. The next match uses:

```
infected   = clip(0.15 + 0.025 × level, 0.05, 0.35)
population = clip(5000 + 400 × level, 3000, 8000)
start CP   = clip(350 − 35 × level, 175, 560)
```

**Global difficulty** (Options; `DIFFICULTY`, `apply_difficulty`) is then applied on top, to Endless *and* Story base stats alike, at every reset:

| | starting CP | infected share | infection rate | civilian speed |
|---|---|---|---|---|
| EASY | × 1.25 | × 0.75 | × 0.85 | × 1.10 |
| MEDIUM | × 1 | × 1 | × 1 | × 1 |
| HARD | × 0.8 | × 1.25 (max 50%) | × 1.15 | × 0.92 |

Story **goals** scale with the difficulty's `goal` multiplier (EASY 0.85, MEDIUM 1, HARD 1.1): `save_pct` (rounded), `save_count` (to the nearest 100) and `hold_min` (`scaled_goal`); the briefing and HUD show the scaled targets. Without this, EASY's smaller infected share raised percentage targets (more healthy people to save at the same helicopter throughput) and EASY lost missions MEDIUM won.

The threat level itself is unaffected; each progression history entry records the `difficulty` it was played at. The debrief's NEXT line, the briefing stats and the panel (`HARD LV+1`; MEDIUM shows no label) show the scaled values.

Progress is persisted to `zombie_evac_progress.json` next to the executable (schema in Section 21.2), keeping the last 50 matches. Pressing R mid-match does *not* record a result. Ports should store this in the platform's save location (Steam Cloud, Android app storage, browser `localStorage`/IndexedDB). Story missions never change the threat level.

### 14.4 Story Mode: the 11-mission campaign

**Progression.** Missions are played in order; winning one unlocks the next (the save's `mission` index advances). CONTINUE always opens the furthest unlocked mission; NEW GAME restarts at mission 1. Losing offers R/Enter to retry. Story missions never touch the Endless threat level. After mission 11 the debrief reads "CAMPAIGN COMPLETE - THE WORLD THANKS YOU".

**Data-driven missions.** Every mission is one dictionary in `CAMPAIGN` (schema §21.2) with three groups of keys. One generic checker (`Game.check_mission`) and one HUD helper (`Game.objective_progress`) drive all eleven.

| Group | Key | Meaning |
|---|---|---|
| goal | `save_pct` | evacuate this % of the initially healthy civilians |
| | `save_count` | evacuate this many civilians (absolute) |
| | `vips` (top-level) | spawn this many VIPs; **all** must be evacuated; losing one fails |
| | `survive` | win when the mission clock reaches this many seconds |
| | `hold_min` | fail if (alive + evacuated civilians) < this fraction of the healthy population ("THE CITY HAS FALLEN") |
| | `eradicate` | win when no infected (incubating included) remain |
| | `max_collateral` | fail when civilian casualties from your ordnance exceed this |
| rules | `disabled` | tool ids that can't be selected for placement ("… not authorised in this mission"; shown as LOCKED) |
| | `build_zones` | `{tool id: region}`: that tool may only be placed inside the region (point tools: the clicked cell; barricades: every charged street cell; bomb runs and lure drones: the start point). Refused placements say "<Tools> only inside the marked area"; the zone of the selected tool is drawn as a blue tint, and the briefing lists "<TOOLS> ONLY INSIDE THE MARKED AREA" |
| | `lz_region` | shorthand for `build_zones["evac"]` |
| | `scent_range` | long-range horde tracking in path-cost units (far scent, §7.3) |
| | `swimmers` | `False`: no civilian swims (§9.1), keeping water a hard choke point |
| | `lz_rate_mult` | multiplies `LZ_RATE` (lift speed) |
| | `infect_mult` | multiplies `INFECT_RATE` |
| | `zombie_speed_mult` | multiplies zombie speeds (spawned and newly turned) |
| | `barricade_cost_mult` | multiplies the CP per street cell of barricades |
| spawn | `population`, `infected`, `cp`, `ground_zeros` | as in Endless, but fixed |
| | `gz_region`, `gz_sep`, `gz_min_dist` | where ground zeros may be, their minimum spacing (default 300), and minimum distance from the map centre |
| | `civ_region` | restrict civilian spawns |
| | `vip_region` | where VIPs spawn (open ground; never within 150 of a ground zero) |

**Regions** are dicts combining `x_min/x_max/y_min/y_max` (world units), `r_min/r_max` (distance from the map centre = the mission's lat/lon), `side` = `north/south/east/west` of the map's **main river**, and `poly` (one world-space polygon `[[x, y], ...]`) or `polys` (several), rasterised to nav cells. All given conditions must hold. The main river is the largest connected water body (`City.main_water`), measured on the water *before* bridges are carved out so bridges don't split it. For north/south, a point is compared with the river's mean y in its column (east/west: mean x in its row), with a 15-unit margin. Ponds and harbours don't skew it.

**Objective evaluation order** (each step while running): VIP lost → collateral exceeded → city fallen → (survive missions: win at the timer, fail if no civilians) → (eradicate missions: win at zero infected, fail if no civilians or 25 s stalemate) → win if every VIP is out and `rescued ≥ target` → if the horde is wiped out (no VIP mission): win if `rescued + survivors ≥ target` → fail on no civilians / stalemate.

**The campaign**

| # | Title | Location (map) | Population / infected / CP | Goals | Rules & spawn |
|---|---|---|---|---|---|
| 1 | FIRST CONTACT | Clarksville, TN | 2,000 / 10% / 315 | evacuate 40% | 1 ground zero |
| 2 | SCALE UP | Baltimore, MD | 6,000 / 15% / 1,120 | evacuate 50% | infection ×1.3; 3 ground zeros |
| 3 | PRECISION EXTRACTION | Glen Burnie, MD | 3,500 / 13% / 455 | all 4 VIPs | VIPs within 420 of centre (scattered) |
| 4 | OPERATION EAGLE'S NEST | White House, DC (±800 m) | 3,000 / 12% / 490 | all 14 VIPs **and** 30% | VIPs within 240 of the White House; ground zeros ≥ 200 away |
| 5 | HOLD THE LINE | Times Square, NYC | 8,000 / 12% / 770 | survive 2:00; keep ≥ 35% alive or evacuated | LZs lift 50% slower (`lz_rate_mult = 1/1.5`) |
| 6 | ZERO COLLATERAL | Shibuya Crossing, Tokyo | 8,000 / 12% / 700 | evacuate 60%; ≤ 100 collateral | artillery and bomb runs locked |
| 7 | THE ALAMO | Arc de Triomphe, Paris | 5,000 / 15% / 910 | evacuate 45% | 12 ground zeros on a ring r 300–430 (the avenues), spacing 70; LZs only within r 110 (the Étoile roundabout) |
| 8 | BRIDGE DEFENSE | River Thames, London (±800 m) | 6,000 / 12% / 910 | evacuate 50% | ground zeros on the south bank, civilians on the north bank; `scent_range = 250` so the south-bank hordes find the bridges; no swimmers |
| 9 | ERADICATION | Venice (Rialto) | 3,000 / 10% / 2,100 | kill every infected; keep ≥ 40% alive | EVAC LZ locked (no evacuation); no swimmers |
| 10 | MONUMENTAL DEFENSE | Kim Il Sung Square, Pyongyang (±800 m) | 5,000 / 15% / 980 | evacuate 50% | barricades cost 6× per cell |
| 11 | MEGACITY | The Bund, Shanghai (±800 m) | 12,000 / 15% / 1,750 | evacuate 5,000 **and** all 8 VIPs | infection ×1.3, hordes ×1.15 faster; VIPs north of Suzhou Creek, LZs only south of it |

The briefing lists the goals (yellow, "> …") and rules (white) generated from the mission data by `mission_objectives(m)`, plus population, infected %, CP and VIP count. The debrief shows MISSION n: COMPLETE/FAILED, the reason, each objective row, and EVACUATED / INFECTED / COLLATERAL / ZOMBIES DOWN, plus INFECTED FLOWN OUT / CHOPPERS LOST TO INFECTED when either happened (also in the Endless debrief).

**Win/fail reasons:** EVACUATION COMPLETE, THE LINE HELD, INFECTION ERADICATED, OUTBREAK CONTAINED / VIP LOST, COLLATERAL LIMIT EXCEEDED, THE CITY HAS FALLEN, THE INFECTION SPREAD, TOO FEW SURVIVORS, VIPS NOT EVACUATED, EVACUATION TARGET MISSED.

**Map availability.** Missions 1–4 reuse maps already used by Endless presets; missions 5–11 download their map the first time the briefing opens (then load from cache in ~0.2 s). If every OpenStreetMap server refuses, the briefing shows the error and Enter retries.

---

## 15. Maps

Every map produces the same `City` contract:

| Field | Type | Meaning |
|---|---|---|
| `name` | str | Display name ("PROCEDURAL", "BALTIMORE, MD", …) |
| `cars` | int array | street cells where cars start parked (seeded by the city) |
| `seed` | int | Outbreak seed: random for procedural maps, `crc32(name)` for real ones |
| `indoor` | bool (GH,GW) | building interior / roof cells |
| `water` | bool (GH,GW) | impassable (real maps); bridge decks excluded |
| `water_full` | bool (GH,GW) | all water including under bridges (river-bank tests only) |
| `bridge` | bool (GH,GW) | bridge-deck cells carved out of the water |
| `street` | bool (GH,GW) | spawnable road cells, reachable from the map edge |
| `cost` | int (GH,GW) | 1 open, `INDOOR_COST` = 20 indoor |
| `walk_all` | bool (GH,GW) | `~water` |
| `open_flat` | bool (N) | open ground that isn't water (LZs, barricade street cells) |
| geometry | rects or polygons | used only for rendering |

### 15.1 Procedural generator (`City.procedural(seed)`)

Organic cities in the style of real OpenStreetMap data: a **road network first**, buildings in whatever is left. Uses `random.Random(seed)` in world units (m); the result is fed through the same rasteriser as real maps (`City._rasterize`), so procedural and real cities share one code path. The old rectangular grid generator is gone.

1. **Districts:** 3–6 seed points. Each cell of the map belongs to the nearest seed, with a `35 × sin(x/a + p) × cos(y/b + q)` per-district wobble so borders curve. Every district has its own grid angle (0–90°) and block size: streets along the grid every 55–85 m (9, 10 or 12 m wide) and across it every 40–65 m (7 or 9 m).
2. **District streets:** sampled every 15 m, each street wobbles sideways (amplitude 0–7 m, wavelength 60–160 m) and keeps only the runs inside its own district, extended one sample past the border so neighbouring grids stitch together at odd angles. Per run: 8% dropped (superblock), 22% cut short with a gap (dead ends, T-junctions).
3. **Arterials** (16–22 m): curved quadratic Béziers along a spanning tree of the district seeds plus 1–2 extra links; up to 3 from seeds out to the nearest map edge; 1–2 cross-town routes edge to edge. 60%: a roundabout (r 28–40 m, 12 m wide) on one district seed.
4. **River (30% of seeds):** a meandering band 44–80 m wide right across the map (two summed sines). The cross-town routes run across it, and every arterial is also emitted as a `"bridge"` road, so the standard bridge carving (§15.2 step 9) turns exactly the arterial crossings into bridges. District streets simply end at the water.
5. **Blocks:** rasterise roads and water; the remaining free cells, eroded by one cell (the pavement), are split into 8-connected components (`pygame.mask`). Components under 14 cells are plazas / pavement. Of the rest, 7% of those over 40 cells become **parks** (open, drawn green); the others become **building footprints**: the component outline simplified with Douglas–Peucker (ε = 0.9 cells, `simplify_ring`).
6. **Lot lines** (render only, clipped to footprints): cuts across each footprint's long axis (PCA of its outline) every 12–22 m (±30%), plus a spine along the axis for footprints deeper than 28 m.
7. **Railways:** 0 lines (35%), 1 (40%) or 2 (25%), each a gently curving Bézier edge to edge, `RAIL_WIDTH` = 6 m. They are emitted as `"rail"` roads: blocks stop at them, they are carved out of rivers like bridges, but they are not streets (no spawns). Drawn as two rails on sleepers.
8. Typical result: 100–160 roads, ~200–260 footprints, 6–15 parks, 37–50% indoor, ~11,000–14,000 street cells. Build takes ~0.33 s, plus ~0.2 s the first time traffic routes are needed (§12.11).

### 15.2 Real-world maps via OpenStreetMap (`fetch_osm` + `City.from_osm`)

**Library:** `osmnx` ≥ 2.0. Install with `pip install osmnx`, which brings in geopandas, shapely, networkx and pyproj. Every call goes through the public Overpass API.

**Presets** (latitude/longitude of the view centre):

| Name | Lat | Lon | CLI alias |
|---|---|---|---|
| CLARKSVILLE, TN | 36.5298 | −87.3595 | `clarksville` |
| WASHINGTON, DC | 38.9000 | −77.0290 | `dc`, `washington` |
| BALTIMORE, MD | 39.2900 | −76.6150 | `baltimore` |
| ANNAPOLIS, MD | 38.9790 | −76.4935 | `annapolis` |
| GLEN BURNIE, MD | 39.1626 | −76.6247 | `glenburnie`, `glen-burnie` |
| **Story-only maps** (cached under `map_cache/` on first play) | | | |
| WHITE HOUSE, DC (M4) | 38.8977 | −77.0366 | `half_width = 800` |
| TIMES SQUARE, NYC (M5) | 40.7580 | −73.9855 | default |
| SHIBUYA CROSSING, TOKYO (M6) | 35.6595 | 139.7005 | default |
| ARC DE TRIOMPHE, PARIS (M7) | 48.8738 | 2.2950 | default |
| RIVER THAMES, LONDON (M8) | 51.5085 | −0.0943 | `half_width = 800` (Millennium, Southwark, Cannon St and London bridges) |
| VENICE, ITALY (M9) | 45.4380 | 12.3358 | default (Rialto) |
| KIM IL SUNG SQUARE, PYONGYANG (M10) | 39.0194 | 125.7530 | `half_width = 800` |
| THE BUND, SHANGHAI (M11) | 31.2443 | 121.4865 | `half_width = 800` (Suzhou Creek / Huangpu confluence) |

Arbitrary places can be loaded with `--place "Nashville, Tennessee"`, which calls `ox.geocode(name)` to get a lat/lon.

**Pipeline:**

1. **Cache check:** `map_cache/<slug>.json`, where slug is the lowercased name with non-alphanumeric runs replaced by `_`. Use it if it has a `water` key and either `road_tags: true` or no water at all. Otherwise it's an older cache: re-fetch the roads (with bridge/tunnel layers; usually instant from the osmnx HTTP cache) and the water layer if missing, and rewrite the file. If osmnx or every server is unavailable, the old cache is used as-is (playable, but bridges over mapped rivers stay blocked).
2. osmnx settings: `use_cache = True`, `cache_folder = map_cache/osmnx`, `log_console = False`.
3. **Scale and fetch radius:** `fetch_osm(name, latlon, half_width=None)`. The scale is `k = half_width / 600` (default `k = 1`, so 1 world unit = 1 m). The crop half-extents in metres are `hw = 600k`, `hh = 450k`, and `dist = max(hw, hh) + 40` with `dist_type="bbox"` (640 m by default; 840 m for the White House mission).
   **Timeout:** `ox.settings.requests_timeout` (also sent as the Overpass `[timeout:…]`) is 180 s, or the mission map's `timeout` (Thames: 300 s). It is part of the osmnx cache key.
   **Servers:** the download is attempted against each Overpass endpoint in `OVERPASS_URLS` in turn (`overpass-api.de`, `lz4.overpass-api.de`, `overpass.private.coffee`, `overpass.kumi.systems`) until one succeeds; the last error is raised if all fail. Public servers regularly refuse or rate-limit clients, which is one more reason ports should pre-bake maps.
4. **Street graph:**
   ```
   ox.graph_from_point((lat, lon), dist=640, dist_type="bbox", network_type="all",
                       simplify=True, retain_all=True, truncate_by_edge=True)
   ```
   Then project it with `ox.project_graph(G)` to the local UTM CRS (units are metres) and convert the edges with `ox.graph_to_gdfs(G, nodes=False)`.
5. **Frame:**
   - Project the centre point into the same CRS: `(cx, cy)`.
   - Crop box: `[cx ± hw] × [cy ± hh]`.
   - World transform: `x_w = (X − cx) / k + 600` and `y_w = 450 − (Y − cy) / k`. The y flip puts north at the top. Road widths are divided by `k` and stored in world units; the bundle records `"scale": k`.
6. **Polygons:** `polygons(tags)` calls `ox.features_from_point((lat, lon), tags, dist=640)`.
   - Keep only Polygon and MultiPolygon geometries, reprojected to the CRS.
   - Intersect each with the crop box and split multi-part results.
   - Drop parts smaller than 12 m².
   - Apply `simplify(0.6)`, take the exterior ring, and transform it to world coordinates.
   - Only osmnx's `InsufficientResponseError` (no matching features) gives an empty list. Network errors propagate so the next server is tried (a dropped connection must never silently produce a map without buildings).
   - **Buildings:** `{"building": True}`.
   - **Water:** `{"natural": ["water", "bay"], "water": True, "waterway": "riverbank"}`.
7. **Roads:**
   - For each edge, take the `highway` tag (the first value if it's a list), and its layer: `"bridge"` if the OSM `bridge` tag is set and not `no`, else `"tunnel"` likewise, else `""`.
   - Width comes from the table below, defaulting to 7 m.
   - Intersect the geometry with the crop box buffered by 30 m, and keep the LineString parts.

   | highway tag | width (m) |
   |---|---|
   | motorway | 22 |
   | trunk | 18 |
   | primary | 16 |
   | secondary | 14 |
   | tertiary | 12 |
   | motorway_link, trunk_link, primary_link | 10 |
   | secondary_link, residential, unclassified | 9 |
   | living_street | 7 |
   | service, pedestrian | 6 |
   | track | 4 |
   | footway, path, cycleway, steps | 3 |
   | anything else | 7 |
8. **Save:** write the JSON cache (schema in Section 21.2).
9. **Rasterise** (`City.from_osm`) on a 240×180 surface, where 1 pixel is one cell (world coordinates ÷ 5):
   1. Fill building polygons to get `indoor`.
   2. Fill water polygons to get `water_full`. Rivers are mapped as one area running under their bridges, so draw every **bridge** road `max(BRIDGE_MIN_CELLS = 2, width / 5)` cells wide and carve it out: `bridge = deck & water_full`, `water = water_full & ~bridge`. Then `indoor &= ~water_full`.
   3. Draw every non-**tunnel** road as polylines `max(1, width / 5)` cells wide, with round joins (a circle at every vertex). Then `street = road & ~indoor & ~water`.
   4. If fewer than 3,000 street cells result (sparse mapping), fall back to `street = all open ground`.
   5. Restrict `street` to cells reachable from the map edge by a weighted search.
10. **Threading:** downloads run in a background thread. The current city stays playable, and the HUD shows `DOWNLOADING OSM: <NAME>...`. Errors appear as "Map load failed: …" (6 s). If osmnx is missing, the message tells the player to `pip install osmnx`.

**Measured:**
- First downloads took 65–180 s each; the Overpass server is the bottleneck.
- Cached reloads take about 15 ms, and building the City takes about 25 ms.
- Example sizes: Annapolis 1,318 buildings and 2,790 road segments; Baltimore 408 and 4,301 (Inner Harbor = 3,093 water cells); DC 332 and 5,732; Clarksville 277 and 5,289 (Cumberland River = 4,351 water cells).

**Known data limitations:**
- Sea and bay areas that OSM defines only by *coastline* ways (not water polygons) won't appear as water.
- Buildings under about 5 m wide may vanish when rasterised.
- Large building footprints (common in DC) make big indoor zones.

**Licensing — mandatory for any release:** OpenStreetMap data is © OpenStreetMap contributors and licensed under the **ODbL**. A shipped game must display attribution ("Map data © OpenStreetMap contributors") wherever map data is shown, and any distributed *derived database* (such as the baked JSON files) falls under ODbL share-alike. Overpass and Nominatim usage policies forbid heavy or commercial bulk use from clients. **Ports should pre-bake maps offline** (Section 19) rather than query Overpass from every player's device.

---

## 16. Visual design

### 16.1 Exact palette (do not substitute)

| Role | Hex | RGB | Used for |
|---|---|---|---|
| Background black | `#282828` | 40, 40, 40 | everything's base; text backing boxes |
| Zombies red | `#cc241d` | 204, 36, 29 | zombie dots, health-bar track, REC dot, zombie stats |
| Civilians green | `#98971a` | 152, 151, 26 | civilian dots, parks outline, civilian stat |
| UI alerts yellow | `#d79921` | 215, 153, 33 | alerts, CP, sniper crosshairs, artillery blast sights, tracers, selection brackets, retreat/attack flashes, debrief frame |
| Placement / evac blue | `#458588` | 69, 133, 136 | LZs, barricades, infantry, snipers, choppers, placement previews, move orders, health-bar fill, water tint |
| Infrastructure cyan | `#689d6a` | 104, 157, 106 | street/block outlines, building outlines, panel frame and dividers |
| Text / grids white | `#a89984` | 168, 153, 132 | all body text, surveillance grid, rotor blades, LZ helicopters |
| Artillery / special magenta | `#b16286` | 177, 98, 134 | artillery, airstrike, bomb run, mine and lure drone tools, shells, bombers, drones, explosion fill |

**VIPs** use the infrastructure cyan `#689d6a` (as specified), one pixel larger than other dots and ringed.

**Colour-blind palette (option).** The only off-palette colours in the game, used only when the option is on: zombies `#fe8019` (orange) and civilians `#83a598` (blue) replace red and green everywhere they appear (dots, stats, health-bar track, REC dot). Orange/blue is distinguishable under the common red-green deficiencies; VIPs keep cyan plus their ring.

**Derived tints.** These are the only non-palette colours: a palette colour blended toward the background with `mix(a, b, t) = a + (b − a) × t`.

| Name | Formula | Use |
|---|---|---|
| building fill | mix(BG, cyan, 0.10) | building interiors |
| lot line | mix(BG, cyan, 0.40) | 1 px procedural lot divisions |
| park fill | mix(BG, green, 0.12) | parks |
| grid line | mix(BG, white, 0.16) | surveillance grid, footpaths, disabled outlines |
| dead | mix(BG, white, 0.30) | corpse dots |
| dim text | mix(BG, white, 0.55) | secondary text, stat labels |
| water fill / edge | mix(BG, blue, 0.25) / mix(BG, blue, 0.7) | water |
| rubble base / chips | mix(BG, white, 0.10) / mix(BG, white, 0.32) | destroyed buildings |
| blueprint outline | mix(black, white, 0.6) on the glow layer | unbuilt barricades and mines |

**Font:** a bold monospace. The fallback chain is DejaVu Sans Mono, Noto Sans Mono, Liberation Mono, Ubuntu Mono, Consolas, Menlo, Courier New. Base sizes are big 36, medium 25 and small 21 px, all scaled by `u` (Section 16.6). All UI text is upper-case.

### 16.2 Render layers (per frame, in order)

1. **Backdrop** (static, rebuilt on resize):
   - Background fill.
   - A dot grid in the margins, every `max(8, 40·s)` px.
   - A chunky cyan frame around the map, `ui_lw = max(3, round(3u))` px.
2. **City surface** (static, pre-rendered per scale `s`). Each item below is drawn on top of the previous one:
   - Background.
   - A surveillance grid every 100 m (grid-line colour).
   - Procedural maps:
     - park fills with a green outline;
     - building fills with 1 px lot lines;
     - every block outlined in **cyan at `clamp(round(4s), 3, 5)` px**, the "chunky street outlines".
   - Real maps:
     - footpaths (≤ 4 m) as 1 px grid-line traces;
     - roads drawn cyan at `width × s + 2·lw`, then overdrawn in background colour at `width × s`, which leaves chunky cyan curbs;
     - water polygons;
     - building polygons with fill and a cyan outline of `max(1, round(1.5s))` px.
   - **Baked glow:** downscale by ÷6 with smoothing, multiply by 70/255, upscale with smoothing, and add back on top.
3. **Translucent pass** (alpha surface, *not* bloomed):
   - Range rings for the units being shown: all units in the deploy phase, plus selected or hovered units. Each is the unit colour at alpha 16 fill and alpha 90 outline.
   - LZ pad cells in blue at alpha 70.
   - Squad reinforcement links in blue at alpha 150.
4. **Dynamic glowing layer** (an opaque *black* surface, later added on top):
   - LZs: rotating dashed blue ring (10 arcs at 0.8 rad/s), the H symbol, and a white helicopter cycling in and out.
   - Barricades: street cells as solid blue squares with a white centre pixel; sealed cells as dim blue outlines; the whole barricade flashes yellow while attacked.
   - Unit symbols, dimmed by HP: colour = `mix(black, colour, 0.45 + 0.55 × hp_fraction)`.
   - **Agents**, written directly into the pixel buffer. Square size = `max(2, round(2.6 s))` px; corpses are 1 px smaller. Colours: dead, then civilians (green), then zombies (red). Incubating zombies blink green at 4 Hz.
   - Health bars.
   - The effects/ordnance/sights alpha pass (Section 16.3) and placement previews.
   - Choppers (blue helicopter glyphs) and bombers (magenta arrowheads).
5. **Composite:**
   - `map = city + dynamic layer` (additive).
   - **Bloom:**
     1. Take the dynamic layer, downscale ÷4 then ÷8, and subtract 2.
     2. Multiply by `255 / dot_size²` so bigger dots don't glow more.
     3. Double it twice (×4).
     4. Upscale with smoothing and add to the map.
   - Bloom is recomputed every other frame.
6. **CCTV HUD on the map:**
   - Top-left: `CAM-NN <CITY NAME>`.
   - Top-right: `REC` with a red dot that blinks at 1 Hz while running and is solid otherwise.
   - Bottom-left: `YYYY-MM-DD HH:MM:SS` (sim clock).
   - All on solid background boxes.
   - Centre banner, yellow text in a yellow 3 px box blinking at 0.8 Hz: `STANDBY - DEPLOY, THEN PLAY`, `NO EVAC LZ - CIVILIANS PANICKING`, or `DOWNLOADING OSM: …` (static, with animated dots).
7. **Side panel** (Section 16.5) and overlays: `// PAUSED //` blinking at 1.5 Hz, and the debrief box (map darkened with the background colour at alpha 190).
8. **CRT post-process over the whole screen:**
   - A rolling white band, alpha ≤ 14 and height H/10, scrolling down at 0.12 screen heights per second.
   - Then one of 3 pre-generated overlay frames, cycled every frame. Each frame's alpha is: vignette `clip((r − 0.65) / 0.75, 0, 1)² × 170`, plus 60 on every 3rd row and 25 on the following row (scanlines), plus Gaussian noise with σ = 14 (grain).

### 16.3 Effects and targeting sights

| Effect | Look | Life |
|---|---|---|
| Tracer | 1 px yellow line, fading | 0.12 s (sniper), 0.06 s (others) |
| Explosion ("boom") | magenta disc (alpha 110 fading) + yellow ring, growing from 0.70× to 1.15× the radius | 0.8 s |
| Destroyed-unit ring | yellow ring expanding to 1.6× | 0.9 s (1.2 s, radius 40, for barricades) |
| **Sniper sight** | **yellow crosshair**: a ring of radius `max(5, 5s)` with 4 ticks and an open centre, on the sniper's current nearest target every frame | continuous |
| **Artillery sight** | **yellow blast-radius circle** at the impact point (fill alpha 40 + outline) and a shrinking inner ring showing time to impact; magenta shell dot on an arc 60 m high | shell flight |
| Airstrike marker | magenta circle + magenta crosshair + shrinking ring | 2.0 s |
| Bomb run | magenta flight-path line; magenta arrowhead plane | flight |

### 16.4 Unit symbols (tactical-map glyphs)

| Unit | Glyph |
|---|---|
| EVAC LZ | circle with an "H" |
| Barricade (icon) | thick diagonal bar |
| Infantry | NATO infantry box: rectangle with an X |
| Sniper | triangle with a centre dot |
| Artillery | square with a centre dot |
| Chopper (icon) | small circle with an X (on the map: body circle, tail boom, two-blade rotor spinning at 18 rad/s) |
| Airstrike | circle with a crosshair |
| Bomb run | arrowhead |
| Engineers | NATO engineer box: rectangle with an "E"-bridge (three uprights on a bar) |
| Incendiary mine | diamond with a centre dot |
| Lure drone | quad-rotor: four small circles on an X |

Selected movable units get four yellow corner brackets. Move orders show a blue line to a blue × target.

### 16.5 Side panel (top to bottom)

1. `ZOMBIE EVAC` (big, white). Threat level `LV+n` (small, yellow) right-aligned.
2. `CP nnn` (medium, yellow) and `T+m:ss` (white) right-aligned. Then a cyan divider.
3. **11 tool rows** (small font): `key NAME` (keys 1–9, 0, L) and the cost right-aligned, with a 3 px border in the tool colour. The selected row is filled with the tool colour and drawn with background-coloured text. Rows you can't afford are dimmed.
4. **Info lines** (2):
   - Normal: the tool description, then `> how to use`.
   - Placing a barricade or bomb run: the live cost, e.g. `24 ST+36 SEAL: 24CP`.
   - One squad selected: `SQUAD HOLDING/MOVING/RETREATING +n SUPPORT`.
   - One engineer selected: `ENGINEERS IDLE/MOVING/BUILDING/REPAIRING/FLEEING`.
   - Several units selected: `n GROUND + m CHOPPERS / CLICK MAP: GROUP MOVE`, or `CLICK UNIT/VIP: ESCORT` if the selection includes a chopper.
   - Drawing a lure route: `ROUTE n/600M`.
5. **Time row:** `UNDO` (1.6× wide; yellow when usable, dim otherwise), `❚❚`, `1X`, `2X`, `4X`, `8X`. The active button is filled white.
6. **Stats** (label dim, value coloured, at most 7 rows): in Story Mode first the mission's objective rows from `Game.objective_progress()` (`HOLD FOR m:ss`, `CITY ALIVE x%/y%`, `INFECTED LEFT n`, `EVAC TARGET a/b`, `VIPS OUT a/b`, `COLLAT LIMIT a/b`); then CIVILIANS (green), EVACUATED (blue), ZOMBIES (red), NEW INFECTED (red), COLLATERAL (magenta), ZOMBIES DOWN (white).
7. A divider, then one line: the flash message (yellow, blinking at 3 Hz) or the city name. (Hotkey help moved to the CONTROLS screen.)

### 16.7 New in-map visuals

| Element | Look |
|---|---|
| Blueprint | Dashed white outline of the planned street cells (or a white mine glyph), with a yellow progress bar at its site |
| Fire pool | Flickering translucent yellow disc (alpha ≤ 70) with a red core at 0.6 r (alpha ≤ 110), fading in its last 2 s; flicker uses the animation clock |
| Lure drone | Magenta quad-rotor glyph; magenta line along the remaining route; pulsing yellow ring at `LURE_RADIUS`; yellow countdown arc while hovering |
| Escort | Blue tether from chopper to target, blue ring around the target |
| Rubble | See §7.4 |
| VIPs | Cyan squares one pixel larger than other dots, each with a 1 px cyan ring |

### 16.8 Menu, options and briefing screens

- Drawn over the live CCTV frame (map, HUD and panel) darkened by a full-screen background-colour layer at alpha 215; CRT overlay and brightness still apply on top.
- **Main menu:** `ZOMBIE EVAC` (70u bold mono, white), subtitle `OUTBREAK RESPONSE COMMAND // CCTV LINK` (dim), a column of 560u-wide buttons with 3 px borders (cyan; yellow + yellow-tinted fill when selected; grid colour when disabled), a controls hint, and the attribution line `MAP DATA (C) OPENSTREETMAP CONTRIBUTORS (ODBL)`.
- **Options:** same frame, subtitle `OPTIONS` (yellow); toggles show `[ON]`/`[OFF]`; sliders are a grid-colour bar filled blue to the value, with a percentage.
- **Briefing:** a centred box with a 3 px yellow border: `MISSION n`, title (big), location (cyan), briefing lines, `OBJECTIVE: …` (yellow), mission stats, and a status line (download progress, failure + retry, or a blinking `ENTER / CLICK: DEPLOY`).
- **Brightness** is the last operation of every frame: `BLEND_RGB_MULT` by `255 × b` below 100 %, `BLEND_RGB_ADD` of `90 × (b − 1)` above.
- **CRT off:** the rolling band and the three grain frames are replaced by one static overlay (vignette + scanlines, no noise).

### 16.9 Audio

**Placeholders.** Every audio file is an AI-generated alpha placeholder named with `_TEMP_AI` (e.g. `mus_menu_TEMP_AI.ogg`) so they can all be found and replaced before release: `grep -rn _TEMP_AI zombie_evac.py audio/`. The bench check `audio.temp_ai_names` fails if any audio filename in the source lacks the tag. Files go in `./audio/`; missing files (or no audio device) are silently skipped.

**Architecture.** The simulation never touches the mixer. `Game.sound(*events)` queues event names (keys of `SOUNDS`, at most 64 per frame); `App.update_audio()` drains the queue each frame, picks the music track and sets the ambience levels, and `Audio` plays them. One-shots have a per-event minimum gap so 5,000 agents can't machine-gun a sample. Volumes: `music` (tracks and stings), `sfx` (effects, ambience, and UI blips), `speech` (radio lines).

| Group | Contents | Driven by |
|---|---|---|
| Music (`MUSIC_TRACKS`, streamed) | menu, briefing, deploy, match_low / mid / high, hold_timer | screen; while running, the infected share of the living (< 25% / < 50% / more); last 30 s of a survive mission |
| Stings (`SOUNDS`, music volume) | victory, defeat, campaign_complete, threat_up / down | `finish()` (Endless: ≥ 40% saved = victory), campaign end, threat change |
| Ambience (`AMBIENCE_LOOPS`, looped on reserved channels) | city, sirens, crowd, horde, water, fire, LZ rotor, gunship, drone, barricade_hit, cctv | live counts (infected share, civilians, zombies, fires, LZs, choppers, drones, barricades hit in the last 0.5 s), CRT option; sim loops are silent while paused |
| Combat / units | shots per weapon, artillery launch + shell whistle (0.8 s before impact), explosions (≥ 20 m large), airstrike jet, bomber + bomb chain, building collapse, barricade place / breach, engineer build / repair, mine arm / ignite, drone launch / detonate, car alarm / cook-off, paradrop / landing, unit destroyed, Trojan crash, zombie turning, civilian scream, splash / drowning | the matching sim event |
| UI | hover, select, back, deploy ok, deny, tool locked, unlock, pause / resume / speed, undo, alert (any HUD message), VIP lost, briefing, REC blip (once a second while running) | input handlers; a refused deployment plays *deny* instead of the generic alert |
| Radio (speech) | LZ established, barricade breached, unlocks at 0:30 / 1:00 / 1:30, friendly fire, VIP down, infected on board, mission complete, city has fallen | the matching event |
| Reserved (Phase 5 cars) | car engine, tire screech, car crash, horn | not triggered yet |

### 16.6 Responsive layout

- **Base design:** 1280×720. Minimum window 800×450. Resizable, with F11 for fullscreen.
- **UI scale:** `u = max(0.4, min(H/720, W/1280))`.
- **Panel width:** at least `380u` and at most `620u`.
- **Map scale:** `s = min(H/900, (W − 380u)/1200)`. The map is centred in the space left of the panel; the panel absorbs extra width.
- **Fit check:** if the panel content doesn't fit vertically, multiply `u` by 0.95 and repeat.
- **Resize:** every font, line width, symbol and the pre-rendered city are rebuilt at the new size, so nothing is stretched as a bitmap.

---

## 17. Controls and input

### 17.1 Keyboard and mouse (reference PC build)

| Input | Action |
|---|---|
| `1`–`9`, `0`, `L` | Select tool: LZ, Barricade, Incendiary mine, Infantry, Engineers, Sniper, Artillery, Chopper, Airstrike, Bomb run, Lure drone (clears selection) |
| LMB on map | Context-sensitive; see the precedence list below |
| LMB drag (bomb run) | Press at the path start, release at the end |
| LMB drag (lure drone) | Draw the freehand route; release to launch |
| LMB on a friendly unit / VIP with chopper(s) selected | Escort it |
| RMB | Cancel the barricade anchor or selection; otherwise remove the nearest unit (refund only in the deploy phase) |
| `Space` | Start (deploy phase) / pause and resume |
| `F` | Cycle speed 1→2→4→8→1 (starts or unpauses) |
| `+` / `=` / keypad `+`, `-` / keypad `-` | Speed up / down |
| `Ctrl`/`Cmd` + `Z` | Undo the last deployment (deploy phase or paused) |
| `Ctrl`/`Cmd` + `A` | Select all infantry, engineers and choppers |
| `R` | Instant restart: same map, same outbreak, full CP (Story: retry the mission) |
| `Enter` | Story debrief: next mission after a win, retry after a loss |
| `N` | Endless only: new procedural city, or a new outbreak (new seed) on a real map |
| `M` | Endless only: cycle map presets (downloads in the background on first use) |
| `F11` | Toggle fullscreen |
| `Esc` | Cancel the anchor / route / selection; otherwise pause and open the main menu |
| Panel clicks | Tool rows; UNDO, pause and speed buttons |

**LMB precedence** on the map (the first rule that applies wins):

1. A barricade anchor is active: place the barricade.
1b. Chopper(s) are selected and the click is on a friendly unit or VIP: escort it (non-chopper units in the selection group-move there).
2. The click is within 12 m of a movable unit: select only that unit, or deselect it if it was already the sole selection.
3. There is a selection: issue a group move.
4. The tool is a line tool (barricade, bomb run): set the anchor or start point; the lure drone starts recording a route.
5. Otherwise: deploy the selected tool at the cursor.

**Command line:** `--map {procedural, clarksville, dc, washington, baltimore, annapolis, glenburnie, glen-burnie}` and `--place "<any place>"`.

### 17.2 Recommended mappings for ports

| Action | Touch (Android/web mobile) | Gamepad (Steam Deck / Steam Input) |
|---|---|---|
| Select tool | Bottom tool bar (8 large buttons) | LB/RB cycle tools; radial menu on hold |
| Deploy / place | Tap | A at the virtual cursor (left stick moves the cursor) |
| Barricade | Tap the start, tap the end (already two-tap) | A, A |
| Bomb run | Drag | Hold A, release |
| Remove | Long-press on a unit, then confirm | Y on a unit |
| Select squad / chopper | Tap the unit | A on the unit |
| Select all movables | "ALL" button | View/Back button |
| Group move | Tap the map with a selection | A with a selection |
| Undo | UNDO button | B (deploy phase or paused) |
| Pause / speed | On-screen time row | Start = pause; D-pad up/down = speed |
| Pan / zoom | Two-finger pan and pinch (recommended: mobile screens can't show 1200×900 m legibly) | Right stick pan, triggers zoom |

---

## 18. Tutorial system plan (not yet implemented)

> **Status:** deliberately deferred. When it is built, extend the lesson sequence below with: *Breaking ground* (artillery/airstrike destruction opening shortcuts), *Sappers* (blueprints, engineers, repair, checkpoint assist), *Trip wires* (incendiary mines and fire), *Pied piper* (lure drone routes and hover), and *Top cover* (chopper escort of a VIP). Story Mode's briefing screen is the natural host for lesson captions.

### 18.1 Goals

- Teach every mechanic in roughly 15–20 minutes, one concept per lesson, in an order where each lesson needs only what came before.
- Use small, **authored, deterministic** scenarios: fixed seed, fixed map, restricted tools. The player always succeeds by applying the lesson, never by luck.
- Never block experienced players: every lesson can be skipped, and the whole tutorial can be skipped from the main menu.
- Reuse the real simulation unchanged. A tutorial is just *scenario data* plus *triggers* plus *UI hints*.

### 18.2 Architecture

Add a `Scenario` (data) layer and a `TutorialDirector` (logic) that sits between the input layer and the `Game`:

```jsonc
// tutorial/lesson_03_barricades.json
{
  "id": "barricades",
  "title": "HOLD THE LINE",
  "map": {"type": "procedural", "seed": 4417},           // or {"type":"osm","name":"ANNAPOLIS, MD"}
  "population": 1500, "infected": 0.08, "ground_zeros": [[380, 450]],
  "start_cp": 120,
  "allowed_tools": ["evac", "barricade"],
  "prebuilt": [{"tool": "evac", "x": 980, "y": 450}],
  "time_controls": {"allowed": [1, 2], "start_paused": true},
  "steps": [
    {"say": "Hordes chase people. Barricades stop zombies but let civilians through slowly.",
     "highlight": "tool:barricade", "until": {"tool_selected": "barricade"}},
    {"say": "Click once on one side of the avenue, then again on the other side.",
     "ghost_line": [[520, 380], [520, 520]], "until": {"unit_placed": "barricade"}},
    {"say": "Only the street is charged. The line also seals the buildings at each end.",
     "highlight": "map:last_barricade", "until": {"seconds": 4}},
    {"say": "Press PLAY.", "highlight": "button:1x", "until": {"phase": "running"}},
    {"say": "Barricades take damage from zombies. Keep them busy until the evac finishes.",
     "until": {"any": [{"evacuated_pct_gte": 60}, {"barricades_alive": 0}]}}
  ],
  "success": {"evacuated_pct_gte": 60},
  "fail": {"barricades_alive": 0, "retry_hint": "Draw the line across the whole avenue."}
}
```

- **Step fields:**
  - `say`: text for a boxed, typed-out CCTV radio caption; optionally voiced.
  - `highlight`: a pulsing yellow 3 px box around a panel element or a map target.
  - `ghost_line` / `ghost_point`: a dashed blue preview of where to act.
  - `until`: the trigger that advances the step.
  - `lock_input`: optional; allow only the highlighted action.
- **Trigger vocabulary:** `tool_selected`, `unit_placed{kind}`, `unit_destroyed{kind}`, `phase`, `paused`, `speed_set`, `seconds`, `evacuated_pct_gte`, `infected_gte`, `selection_size_gte`, `order_issued`, `undo_used`, `any` / `all`.
  - Implement these as event hooks the `Game` already has natural points for: `add_unit`, `remove_unit`, `undo`, `check_end`, `group_move`, speed changes.
- **Time:** the director may force a pause while text is up (`"pause": true`). Sim time inside lessons should be at most about 90 s.
- **Persistence:** store completed lesson ids with the progression save. Unlock "real-world maps" after lesson 9, or allow skipping.
- **Telemetry (optional, opt-in):** time per step, retries, and where players quit. Use it to tune the text.

### 18.3 Lesson sequence

| # | Lesson | Concepts taught | Scenario sketch | Success |
|---|---|---|---|---|
| 0 | **Camera feed** | Reading the CCTV view: green = people, red = infected, blue = yours, yellow = alerts; ground zero | Tiny city, 1 ground zero, no tools; the player only presses PLAY and watches 15 s, with captions pointing things out | Watched to the end |
| 1 | **Get them out** | EVAC LZ placement; open-ground rule; civilians route to the nearest LZ; panic without an LZ | Start running with no LZ (show the "PANICKING" banner), then pause; prompt to place 1 LZ on a plaza (ghost point); try an invalid spot first to show the "LZ needs open ground" message | 40% evacuated |
| 2 | **Clock control** | Pause, 1×–8×, Space, the deploy-phase concept | Same map; require pausing, then switching to 4× | Uses pause and 4× |
| 3 | **Throughput** | LZ lift rate (12/s), queues, why a second LZ helps; CP income from rescues | One LZ jams; enough CP is earned mid-lesson to afford a second; prompt to place it | 55% evacuated |
| 4 | **Hold the line** | Two-click barricades; street-only cost; free building seals; civilians pass slowly; HP and breach | The JSON example above | 60% evacuated |
| 5 | **Boots on the ground** | Infantry deploy; selecting a squad and moving it; fighting retreat; defending a barricade halves damage | A pre-built barricade under siege; deploy 1 squad, then move it within 40 m (the white outline appears) | Barricade survives 45 s |
| 6 | **Strength in numbers** | Reinforcement (pips and links); Ctrl+A (or the ALL button) group move into a formation | 3 squads spread out; a horde approaches; group-move them together | All 3 squads survive |
| 7 | **Overwatch** | Snipers, rooftop range bonus (+25%), frailty (25 HP), the yellow crosshair | Place a sniper on a roof, compare range rings with a street placement, then lose an exposed one to zombies | Sniper kills 15 |
| 8 | **Danger close** | Artillery auto-targeting, the yellow blast sight, friendly fire, airstrike timing, bomb run drag | A horde next to a civilian queue: teach waiting for separation; airstrike a cluster; bomb a straight avenue | ≥ 150 kills, ≤ 20 collateral |
| 9 | **Command decisions** | Undo (deploy phase or paused only), refund rules, choppers, budgeting | A deliberately misplaced unit; undo it; then place a chopper orbit over the LZ | Uses undo; 60% evacuated |
| 10 | **Real city** (graduation) | Everything; real-world map traits: water, building interiors, irregular streets | Annapolis (bundled map, no download), 2 ground zeros, full tool set, baseline difficulty | Any verdict ≥ HEAVY CASUALTIES; unlocks the progression system |

### 18.4 Contextual hints in normal play

Hints fire once per profile and can be dismissed. They appear as small yellow lines over the HUD.

- 10 s of running with no LZ: "Civilians are panicking. Deploy an EVAC LZ (1)."
- A barricade at 30% HP with no squad within 40 m: "Barricade failing. Move a squad within 40 m to halve damage."
- Artillery collateral over 20 in one match: "Artillery kills civilians too. Place it where hordes and crowds separate."
- CP ≥ 300 unspent for 30 s: "Unspent CP. More LZs mean more people lifted per second."
- First undo attempted while running: "Pause first (Space), then undo."

---

## 19. Porting guide

### 19.1 Universal requirements

1. **Separate the simulation from presentation.** Port the `Game` rules first as a headless module, then validate them against Section 20 before writing any rendering.
2. **Struct-of-arrays agents and flat grids.** Don't make 5,000 agent objects. Per-step cost in the reference is about 8–10 ms on a laptop CPU in numpy. A compiled language should reach 1–3 ms single-threaded.
3. **Hot paths and their budgets** (per sim step at 5,000 agents):

   | Operation | Budget |
   |---|---|
   | Spatial hash and occupancy (bincount) | O(P) |
   | Zombie boids neighbour sums | O(P + buckets) |
   | Civilian/zombie velocity | O(P) |
   | Movement and collision | O(P) |
   | Scent and flee fields (range-limited weighted wavefront) | O(cells × range); every 0.5 s |
   | Evac / order field (full wavefront) | O(cells × path length); only on LZ change or orders; ≤ 100 ms acceptable; run on a worker thread in ports |

4. **Rendering agents:** one instanced draw, or a pixel-buffer write, of coloured squares. Never thousands of individual draw calls. Bloom = downsample, blur, threshold, add, which is cheap on a GPU.
5. **Randomness:** setup must be reproducible from the seed (for R and for tutorials). Use a seedable PRNG such as PCG32. Exact cross-language bit-equality with numpy is *not* required, only equivalent distributions.
6. **Maps:** ship pre-baked map bundles using the JSON schema in Section 21.2. Do **not** run osmnx or Overpass on players' devices for presets. Build an offline "map baker" (the existing `fetch_osm` is that tool) and optionally a server endpoint for user-requested places. Add the ODbL attribution string to the HUD or credits.
7. **Saves:** progression JSON (Section 21.2) plus completed tutorial lessons, stored in platform storage.
8. **Accessibility:** the reference now has a colour-blind palette, a CRT flicker/noise toggle and a brightness slider (§1.1). Ports should keep those and add a UI scale slider, remappable keys, and an option to stop UI blinking.
9. **Audio** (absent in the reference; the options screen already stores music/speech volumes and `App.volume(channel)` is the hook to read them): a radio static bed, a helicopter loop per LZ, suppressed rifle cracks, artillery whistle and impact, horde murmur scaled by on-screen zombie density, alert pings tied to yellow UI events.

### 19.2 Web browser

- **Stack:** TypeScript + PixiJS/WebGL2 or WebGPU. Run the simulation in a **Web Worker** with `Float32Array`/`Int8Array` buffers transferred or shared via `SharedArrayBuffer`, which needs COOP/COEP headers. Alternatively compile a Rust/C++ simulation to WASM.
- **Rendering:** draw agents as instanced points from a GPU buffer. Bake the city to a texture per zoom level. Implement CRT effects as one fragment shader (vignette, scanlines, noise, roll bar) plus a bloom pass.
- **Maps:** ship `maps/*.json` (about 0.2–0.35 MB each; gzip helps). A custom-place feature needs a backend that runs the baker; don't let browsers hit Overpass directly.
- **Input:** pointer events (mouse and touch), keyboard shortcuts; prevent the browser's own Ctrl+A/Ctrl+Z defaults inside the canvas.
- **Persistence:** `localStorage` for progression, IndexedDB for cached maps.

### 19.3 Android

- **Stack options:**
  - Godot 4 (GDScript or C# with C++ GDExtension for the sim).
  - Unity (Burst + Jobs + ECS for the sim, `Graphics.RenderMeshInstanced` for dots).
  - Native Kotlin + Rust via JNI.
- **Performance scaling:** default population 3,000 on low-end devices; a quality preset scales `POPULATION` and the bloom resolution. Keep the sim tick off the UI thread.
- **Layout:** portrait is a poor fit. Lock landscape. Move the side panel to a bottom tool bar plus a collapsible stats drawer. Add **pan and zoom**: at phone sizes the full 1200×900 m map makes dots about 1 px.
- **Touch rules:** see Section 17.2. Make hit targets at least 48 dp. The two-tap barricade already suits touch.
- **Lifecycle:** auto-pause on `onPause`. Save progression on match end.
- **Maps:** bundle the presets in the APK/AAB as assets.

### 19.4 Steam PC release

- **Stack:** Godot 4, Unity, or a Rust/C++ engine (Bevy, raylib + custom). The single-file Python prototype isn't a shipping architecture.
- **Steamworks:**
  - Achievements, e.g. "Evacuate 75% at threat +3", "Hold a barricade for 2 minutes", "Win on every preset city", "Zero collateral match".
  - Steam Cloud for saves.
  - Steam Input with an action-set manifest (Section 17.2).
  - Rich presence ("Defending BALTIMORE, MD — 54% evacuated").
- **Steam Deck:** 1280×800 is close to the 1280×720 base layout, so verify panel text at `u ≈ 1.0`. Gamepad cursor required.
- **Settings menu:**
  - Resolution, fullscreen and borderless.
  - UI scale.
  - CRT effect intensity, from off to heavy, including the flicker toggle.
  - Bloom quality.
  - Population cap.
  - Colour-blind palette.
  - Key remapping.
  - Audio levels.
- **Content roadmap:** a campaign of preset cities with authored ground zeros; a city editor or custom place (via a hosted baker); challenge seeds; daily outbreak.
- **Compliance:** the ODbL attribution screen; third-party licence notices (osmnx MIT; numpy BSD-3; pygame-ce LGPL-2.1, relevant only if any of these is shipped).

---

## 20. Parity checklist and known quirks

Measured on the reference build, headless. A faithful port should land in the same ranges. Run `python zombie_evac_bench.py` (quick, ~1 min) or `--full` (adds the long outcome runs) to re-measure the reference; it never writes the player's progression, save or options files. Rows marked † predate v3.2's incubation changes and need re-measuring with `--full`.

| Check | Expected |
|---|---|
| City build: procedural / OSM from cache | ~0.34 s (+0.2 s traffic routes) / ~0.025 s; `reset()` ~10 ms (indoor spawns, cars) |
| `reset()` (R) | ≤ 10 ms |
| Step cost at 5,000 agents (numpy reference), idle machine | 13.0–14.0 ms after v3.5 (12.4 ms in v3.4; 500 cars cost ~2.2 ms). 8× needs ~1.6 s of work per second, so it runs at ~5×. Worst single step 19.6 ms (80.6 ms before the scent/flee time-slicing). Breakdown on a river map: civilian velocity 3.5, traffic 2.2, movement 2.1, zombie velocity 1.3, water 0.4, traits 0.3 ms |
| Frame draw at 1280×720, ~490 cars on screen | 13.1 ms (12.6 ms in v3.4 with ~190 cars): parked cars and wrecks are cached on a layer redrawn only when a car changes state (`car_version`); moving cars are drawn vectorised |
| No LZ, no defences, procedural seeds 1/2/3 † | 0% saved; everyone infected within ~210–245 s |
| One LZ at a reasonable spot † | 15–24% saved, match ~115–160 s |
| Two LZs † | 30–45% saved, match ~105–190 s |
| Indoor traversal sanity: procedural seed 1, two LZs, after 5 s | several hundred agents inside buildings (≈680 civilians, ≈280 zombies measured) |
| Barricade: 14 m line across a 15 m street between buildings | ≈ 11 street cells charged (11 CP), ≈ 90 sealed cells, sealed extent ≈ 164 m |
| Zombie path cost across that line | 8 → 48 (must go around the block) |
| Siege, 200 zombies on that barricade, undefended / squad defending | breach ≈ 43 s / ≈ 83 s |
| Zombies ever standing on obstacle cells after placement | 0 |
| Group move: 6 squads + 2 choppers | all within ~35 m of the target, closest pair ≥ 17 m, ~0.1 s to issue |
| Undo after LZ/sniper/airstrike in the deploy phase | refunds 100/40/60 exactly; refused while running unpaused |
| Rooftop sniper / artillery range | 137.5 m / 450 m |
| Progression from level 0: evac 80% → 60% → 10% → 30% | level 2, 3, 2, 2 |
| Airstrike (42 m) on a building block | ~168 indoor cells → rubble; 0 indoor cells left inside the radius; cost 1 there; buildings just outside untouched; R restores all |
| Mine/drone blasts | no building damage |
| Blueprint barricade placed live, 1 engineer ~100 m away, no zombies | becomes active ~27 s later; a mine blueprint next ~44 s |
| Engineer repair | +50 HP in 5 s (10 HP/s) |
| Lure drone, 93 m route at a ground zero | reaches end ~7.8 s, detonates ~11.8 s, kills ~140 |
| Chopper escorting a moving squad | orbit centre on top of the squad within ~5 s and stays there |
| Mission 1 settings, VIP spawn | all 12 within 240 of centre, none within 150 of a ground zero |
| Mission 1 outcomes (6 procedural seeds) | 1 LZ: 3/6 wins; 2 LZs: 4/6; 2 LZs + barricades + squads: 6/6 |
| Pause | animation clock and effect timers do not advance |
| Agents on water cells after 20 s (Baltimore, Annapolis) | 0 |
| Thames (M8) bridges | 295 bridge segments → 747 deck cells; 100% of south-bank streets connect to the north bank |
| Thames (M8) original horde on the north bank after 60 s, seed 1 | 63% without far scent; 100% with `scent_range = 250` (step cost 13.9 → 16.4 ms). Measured without building footprints (Overpass refused the buildings query); re-measure with them |
| Trojan horse (v3.2), procedural seeds 1/2/3 | one LZ is downed in every run with LZs; 1 LZ saves 6–8% (was 14–16%), 2 LZs 2–4% (was 14–20%), no-LZ city falls in 162–198 s (was 207–218 s) |
| v3.3 balance (economy nerf, 10 s flight window, traits), procedural seeds 1/2/3, LZ at the map centre | no LZ: city falls in 178–192 s; 1 LZ: 6–9% saved (EASY 7–8%, HARD 6–8%); 2 LZs: 1–5%. A Trojan crash downs an LZ in every run with LZs |
| Trojan flight window sweep, 1 LZ, MEDIUM | 0 s (never crash): 10–12% saved, 24–68 infected flown out; 3 s: 6–9% (1 crash each); 6 s: 6–7%; 10 s: 6–9%. Any window > 0 eventually catches someone, and a crash ends that LZ |
| v3.4 balance (organic maps, traffic, LZ offline instead of destroyed), seeds 1/2/3, LZ nearest the map centre, MEDIUM | no LZ: falls in 169–190 s; 1 LZ: 2/2/8% saved (2/2/1 crashes); 2 LZs: 11/10/7% (2–3 crashes); EASY 1 LZ 1–8%, HARD 1–9% |
| v3.4 LZ screening, 1 LZ + 1 squad 22 m away, seeds 1/2/3 | 58–73 sick civilians screened per match, but crashes unchanged (2/2/1) and saves 2/2/10% (vs 1/1/10% unguarded): screening only saw the last 3 s, while a crash needed only the 10 s flight window, so most crashing passengers still looked healthy at the pad. Fixed in v3.5: both windows are 6 s and guarded LZs check every boarder |
| v3.5 balance, **bot opening** (`bot_deploy`: up to 3 LZs ≥ 200 m from ground zeros where civilians are densest, a squad beside each, leftover CP as squads 45 m out toward the nearest ground zero; no other tools), 3 outbreak seeds per row, `--full` | **Story wins (M1–M5, cached maps):** EASY 15/15; MEDIUM 14/15 (M4 lost a VIP once); HARD 3/15 (M1 only; M2 41–43% of a 55% target, M3/M4 VIP lost, M5 falls). **Endless saved (evacuated + sheltered):** EASY 42–53%, MEDIUM 30–43%, HARD 23–42%. The bot plays a fixed opening with perfect knowledge and no mid-match tools, so a player should beat these on MEDIUM and can on HARD |

**Known quirks and design debts:**

- Fixed in v3.5: agents drawn with bigger dots (lunging zombies, VIPs) at the right / bottom map edge wrote one pixel past the dynamic layer and crashed `plot_agents` (IndexError). Dots are now clamped per dot size; `render.map_edges` draws every dot kind on every edge at 5 window sizes.

- `contact_owner` uses last-writer-wins: when two units' contact zones overlap, only one takes damage from zombies there.
- Infantry blocked by another unit sidesteps once, then gives up after 1.5 s, so a formation can end slightly off its slots.
- Evac and order fields are full-grid searches (~0.1 s) on the main thread, which causes a hitch on LZ placement and move orders. Move them to a worker in ports.
- At 8× on slow machines the step cap (8 per frame) drops time, so effective speed can be about 6–7×.
- Stalemate detection (25 s with nothing changing) can end a match while civilians are still walking a long route if nothing else is happening. This is rare.
- Coastline-defined sea is not treated as water (Section 15.2).
- An engineer's job path is computed when the job is claimed (~0.1 s hitch); the path isn't updated if buildings are later destroyed (the final approach is a straight line, so it still arrives).
- Barricade blueprints that overlap another unit's cells lose those cells when activated.
- Story mission maps must be downloaded on first play; if every Overpass server refuses, the briefing offers a retry but the mission can't start.
- The reference has no audio, no accessibility options and no save slots beyond progression.

---

## 21. Appendix

### 21.1 Complete constants

| Constant | Value | Meaning |
|---|---|---|
| WORLD_W × WORLD_H | 1200 × 900 | world size (m) |
| CELL | 5 | nav cell size (m) |
| HASH | 20 | spatial-hash bucket (m) |
| FPS | 60 | target frame rate |
| SIM_DT / FAST_SIM_DT | 1/30, 1/15 | step at 1–2× / 4–8× |
| MAX_STEPS_PER_FRAME | 8 | catch-up cap |
| SPEEDS | 1, 2, 4, 8 | time scales |
| POPULATION | 5000 | baseline agents |
| INFECTED_FRACTION | 0.15 | baseline infected share |
| START_CP | 350 | baseline CP (−35 per threat level, 175–560) |
| DIFFICULTY | easy / medium / hard | see §14.3 |
| GROUND_ZEROS | 1–3 | epicentres |
| GZ_SPREAD | 30 | epicentre σ (m), truncated at 3σ |
| CIV_SPEED | 12–17 | m/s |
| ZOMBIE_SPEED | 7–11 | m/s |
| INFECT_RATE | 1.5 | bites/s while sharing a cell |
| INCUBATION / LONG_INCUBATION / LONG_INCUBATOR_CHANCE | 4–12 s / 15–25 s / 0.05 | bitten → turned |
| SYMPTOM_TIME / TURN_TIME | 6 s / 1 s | red flicker before turning / stagger after |
| FEED_TIME | 3.0 | s |
| INDOOR_SPEED / INDOOR_COST | 0.35 / 20 | building traversal (buildings are a last resort) |
| CELL_CAPACITY | 3.0 | agents per cell before crowding |
| CROWD_MIN | 0.2 | minimum crowd speed factor |
| CIV_SPREAD | 0.5 | crowd-avoidance weight |
| CIV_FEAR | 0.35 | zombie-avoidance weight while evacuating |
| FLEE_RANGE | 24 | panic detection range (cost units) |
| IDLE_WANDER | 0.15 | idle/pad milling speed factor |
| SCENT_RANGE | 40 | zombie tracking range (cost units) |
| FIELD_REFRESH | 0.5 | s between scent/flee updates |
| BOID_SEEK / ALIGN / COHESION / SEPARATION / WANDER | 1.0 / 0.6 / 0.35 / 0.5 / 0.3 | boid weights |
| BOID_STEER | 3.0 | 1/s steering rate |
| HORDE_SURGE / HORDE_SIZE | 0.5 / 12 | horde speed bonus |
| ZOMBIE_DPS | 0.6 | damage/s per attacking zombie |
| CHECKPOINT_SPEED | 0.3 | civilian factor on obstacle cells |
| CONTACT_RADIUS | 10 | m, attack range vs. snipers/artillery |
| SQUAD_SPEED / RETREAT_SPEED / RETREAT_RADIUS | 16 / 5 / 16 | infantry movement |
| REINFORCE_RADIUS / MAX / FIRE / ARMOR | 45 / 3 / 0.2 / 0.15 | squad support |
| ROOFTOP_RANGE | 1.25 | sniper/artillery roof bonus |
| SEAL_SNAP / SEAL_MAX | 15 / 100 | barricade building seal (m) |
| DEFEND_RADIUS / DEFEND_ARMOR | 40 / 0.5 | defended barricade |
| BARRICADE_ATTACKERS | 30 | attacker cap per barricade |
| FORMATION_SPACING | 17 | m between grouped units |
| CHOPPER_SPEED | 45 | m/s orbit-centre relocation |
| STALEMATE_TIME | 25 | s without change ends the match |
| RESCUE_BONUS | 0.15 | CP per evacuee |
| LZ_RADIUS / LZ_RATE / LZ_MIN_CELLS | 18 / 12 / 8 | landing zones |
| LZ_LIFT_TIME / TROJAN_PENALTY / TROJAN_FLIGHT_TIME | 4 s / 50 CP / 6 s (= SYMPTOM_TIME) | helicopter load window / infected-passenger crash / turning within the flight |
| SWIMMER_FRACTION / DROWNER_FRACTION / DROWN_AFTER | 0.40 / 0.10 of swimmers / 3–10 s | swimmers |
| SWIM_SPEED / SWIM_COST | 0.3 / 6 | in water |
| CLUMSY_FRACTION / CLUMSY_RATE | 0.03 / 0.08 per s | stumble (1–2 s, ×0.25) or confused (2–4 s, reversed) |
| LUNGER_FRACTION / LUNGE_RATE / LUNGE_TIME / LUNGE_SPEED / LUNGE_COOLDOWN | 0.03 / 0.5 per s / 0.6 s / ×2.2 / 3 s | lunging zombies |
| DISTRACTED_FRACTION / DISTRACT_RATE / DISTRACT_TIME | 0.05 / 0.05 per s / 3–6 s | distracted zombies |
| DROWN_PRESSURE / HORDE_DROWN_RATE | 6 agents in the cell / 0.6 per s | horde shoving zombies into water |
| FAR_SCENT_SLICE | 4 | far-scent wavefront rings per step |
| BRIDGE_MIN_CELLS | 2 | narrowest bridge deck (cells) |
| BASE_W × BASE_H / MIN_W × MIN_H | 1280×720 / 800×450 | layout |
| PANEL_MIN / PANEL_MAX | 380 / 620 | panel width at u = 1 |
| ENGINEER_FLEE_SPEED | 12 | m/s |
| BUILD_TIME / BUILD_RANGE | 2.5 s / 12 m | blueprint construction |
| REPAIR_RADIUS / REPAIR_RATE | 20 m / 10 HP/s | engineer repairs |
| ASSIST_RADIUS / CHECKPOINT_ASSISTED | 25 m / 0.7 | engineer checkpoint help |
| MINE_TRIGGER / MINE_BLAST | 5 / 6 m | mine |
| FIRE_RADIUS / FIRE_TIME / FIRE_KILL_RATE | 16 m / 10 s / 2.0 per s | fire pool |
| DRONE_SPEED / DRONE_HOVER / DRONE_BLAST / DRONE_MAX_PATH | 12 m/s / 4 s / 30 m / 600 m | lure drone |
| LURE_RADIUS / LURE_WEIGHT | 110 / 2.5 | lure pull |
| ESCORT_ORBIT | 25 | chopper escort orbit radius |
| VIP_GZ_CLEARANCE | 150 | VIP spawn clearance from ground zeros |
| TERRAIN_REPATH | 1.0 s | min interval between evac re-paths after destruction |
| OVERPASS_URLS | 3 endpoints | tried in order |
| DROP_TIME | 4 s | paradrop delay after the clock starts |
| UNLOCK_TIMES | sniper/engineer 30 s, mine/lure 60 s, artillery/chopper/airstrike/bomb run 90 s | escalation |
| ARMED_FRACTION / ARMED_RANGE / ARMED_PAUSE | 0.01 / 14 m / 0.8 s | concealed carry (1–2 rounds) |
| ARMED_FLEE_TIME / ARMED_FLEE_BOOST | 6 s / 1.3 | run after shooting |
| CAR_DENSITY / CAR_SLOW / CAR_BLAST / CAR_FUSE | 1/70 street cells / 0.6 / 10 m / 0.25–0.8 s | cars, wrecks, cook-off |
| CAR_START / CAR_SPEED / CAR_TURN / CAR_STUCK_TIME | 0–20 s / 9–14 m/s / 5 rad/s / 3 s | driving |
| CAR_SLOWDOWN_CROWD / CAR_CRAWL / CAR_CRASH_CROWD | 3 / 0.3 / 9 agents in the 3×3 ahead | crowds |
| CAR_COUNT / CAR_OCCUPIED / CAR_RIDERS / RUNNER_FRACTION / RUNNER_RANGE | 500 / 0.5 / 1–3 / 0.03 / 60 m | traffic volume and people in cars |
| CAR_LOOKAHEAD / CAR_LANE / CAR_RAM_BOOST / CAR_OVERRUN / CAR_JAM_ABANDON | 3 cells / 1.5 m / 1.4 / 8 / 25 s | driving |
| CAR_HIT_RADIUS / CAR_HIT_RATE / CAR_CRASH_RADIUS / CAR_CRASH_KILL / CAR_RAM_DAMAGE | 2.5 m / 1.5 per s / 5 m / 0.25 / 80 HP | run-overs and crashes |
| TRAIN_SPEED / TRAIN_LENGTH / TRAIN_HALF_WIDTH / TRAIN_FIRST / TRAIN_GAP | 22 m/s / 72 m / 2.5 m / 5–25 s / 12–30 s | trains |
| CIV_INDOOR / EMPTY_BUILDING_SHARE / ZOMBIE_INDOOR / ZOMBIE_BUILDINGS | 0.7 / 0.35 / 0.35 / 2 | spawns |
| LZ_REPLACE_TIME / SCREEN_LZ_RANGE / SCREEN_RADIUS | 20 s / 40 m / 25 m | Trojan crash downtime, LZ screening |
| DROWN_PINNED | 0.35 | horde drowning: only zombies moving < 35% of their intent |

### 21.2 Data schemas

**Map bundle** (`map_cache/<slug>.json`; coordinates in world metres, y down):

```json
{
  "name": "BALTIMORE, MD",
  "lat": 39.29, "lon": -76.615,
  "buildings": [[[x, y], [x, y], ...], ...],
  "water":     [[[x, y], ...], ...],
  "roads":     [[width_m, [[x, y], [x, y], ...], "bridge" | "tunnel" | ""], ...],
  "road_tags": true
}
```

**Progression save** (`zombie_evac_progress.json`):

```json
{
  "level": 1,
  "history": [
    {"map": "ANNAPOLIS, MD", "evacuated_pct": 52.3, "level": 0, "difficulty": "medium", "date": "2026-10-10"}
  ]
}
```

(`history` keeps the last 50 entries; `level` in each entry is the level the match was *played at*.)

**Campaign save** (`zombie_evac_save.json`). Valid only if `mission` is an integer index into `CAMPAIGN`:

```json
{"mission": 0, "completed": ["m1_white_house"]}
```

**Options** (`zombie_evac_options.json`):

```json
{"colorblind": false, "crt": true, "brightness": 1.0, "music": 0.8, "sfx": 0.8, "speech": 0.8, "difficulty": "medium"}
```

**Mission definition** (one entry of `CAMPAIGN`; world units for positions; optional keys omitted when unused):

```jsonc
{
  "id": "m7_arc_de_triomphe",
  "title": "THE ALAMO",
  "location": "ARC DE TRIOMPHE, PARIS",
  "map": {"name": "ARC DE TRIOMPHE, PARIS", "latlon": [48.8738, 2.2950], "half_width": null},
  "population": 5000, "infected": 0.15, "cp": 1300,
  "ground_zeros": 12, "gz_region": {"r_min": 300, "r_max": 430}, "gz_sep": 70,
  "lz_region": {"r_max": 110},
  "goal": {"save_pct": 45},
  "briefing": ["TWELVE AVENUES MEET AT THE ETOILE. THE HORDE IS", "..."]
}
```

Other optional keys: `vips`, `vip_region`, `civ_region`, `gz_min_dist`, `disabled`, `build_zones`, `scent_range`, `swimmers`, `lz_rate_mult`, `infect_mult`, `zombie_speed_mult`, `barricade_cost_mult`, and goal keys `save_count`, `survive`, `hold_min`, `eradicate`, `max_collateral` (§14.4).

The **map bundle** also carries `"scale": k` (world unit = k metres) when produced with `half_width`.

### 21.3 Glossary

- **CP:** Command Points, the currency.
- **Ground zero:** an outbreak epicentre.
- **Evacuated:** lifted out from an LZ.
- **Sheltered:** alive at match end.
- **Collateral:** civilians killed by your ordnance.
- **Checkpoint:** an obstacle cell. Impassable for zombies; civilians cross at 0.3× speed.
- **Seal:** building cells added free to a barricade so hordes can't bypass it through buildings.
- **Contact cells:** cells from which zombies damage a given unit.
- **Field:** a per-cell distance or direction grid (evac, scent, flee, order).
- **Threat level:** the dynamic-difficulty level, −3…+6 (Endless only).
- **VIP:** a flagged civilian whose evacuation is the Story objective; losing one fails the mission.
- **Blueprint:** a barricade or mine placed after the clock starts; inert until an Engineer builds it.
- **Rubble:** a destroyed building cell; open ground for the rest of the match.
- **Lure:** a drone's attraction radius that overrides zombie seek behaviour.
- **Escort:** a chopper following a friendly unit or VIP with a tight orbit.
