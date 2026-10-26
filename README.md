# Zombie Evac

A real-time outbreak-evacuation strategy game, rendered as a glowing retro CCTV feed.
Thousands of simulated civilians (green) and zombies (red) on real OpenStreetMap
cities. Spend Command Points on helicopter LZs, barricades, troops and air support
to get as many people out as you can.

**Play:** https://simplecleanspleen.github.io/Zombie-Evac/

- **Story mode:** 11 missions on real cities (Clarksville, Baltimore, Washington DC,
  Times Square, Shibuya, Paris, London, Venice, Pyongyang, Shanghai...).
- **Endless mode:** procedural cities with dynamic difficulty.
- **Tutorials:** six guided lessons (evacuation, barricades, infantry, support troops,
  fire support, choppers and VIPs) that walk through every tool step by step.
- **Sign in with Google** to keep your campaign, threat level and options in the cloud.
  Without signing in, progress is kept in the browser.

## Controls

| Input | Action |
|---|---|
| 1-9, 0, L / click a tool | Select tool |
| Left click / tap | Deploy, select a unit, move the selection |
| Right click / long press | Remove an item (refund before the clock starts), cancel |
| Barricade | Click start, click end |
| Bomb run, lure drone | Drag the flight path |
| Space | Play / pause |
| F, +, - | Game speed 1x-8x |
| Ctrl+Z | Undo (deploy phase or paused) |
| Ctrl+A | Select all movable units |
| R | Restart / retry |
| N | New city (Endless) |
| Esc / click the panel title | Pause menu |

## How it's built

- `zombie_evac.py` is the original Python/pygame reference implementation and
  `zombie_evac_gdd.md` the design document. The web game in `docs/` is a port of it.
- `docs/` is a static site (no build step) served by GitHub Pages:
  - `js/game.js` the simulation (struct-of-arrays agents, flow-field pathfinding,
    boids hordes, traffic, trains, units, economy, missions)
  - `js/app.js` rendering (Canvas 2D, bloom, CRT overlay), panel, menus, input
  - `js/tutorial.js` the training lessons and the step-by-step instructor
  - `js/store.js` saves: localStorage, plus Firestore when signed in
  - `js/audio.js` terminal-style sound: CC0 samples in `sfx/` through a small-speaker
    filter, over a CRT hum (music volume), with synth fallbacks
  - `maps/` pre-baked maps
- `tools/bake_maps.py` builds the maps with the reference `City` class: every real
  map found in `map_cache/` plus a set of procedural cities.
  `python3 tools/bake_maps.py --procedural 40 --cache map_cache`
- `tools/sim_check.mjs` runs a headless match: `node tools/sim_check.mjs`

Run locally: `python3 -m http.server -d docs 8000`, then open http://localhost:8000.

### Firebase (free Spark plan)

Project `zombie-evac-vl6cz`: Authentication (Google provider) and Cloud Firestore.
Each player's save is the document `users/{uid}`; `firestore.rules` only lets a
signed-in player read and write their own document. Deploy rules with
`firebase deploy --only firestore:rules`.

Map data (c) OpenStreetMap contributors, ODbL.
Sound effects by Kenney.nl, CC0 (see `docs/sfx/LICENSE.txt`).
