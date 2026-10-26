#!/usr/bin/env python3
"""
ZOMBIE EVAC - a top-down zombie outbreak / evacuation RTS.

Inspired by "Atom Zombie Smasher" and "Zombies Aren't Real". Rendered as a
glowing retro CCTV / CRT feed.

    red dots      = Zombies    (clustered at 1-3 ground zeros)
    green dots    = Civilians  (panic and flee until you deploy an EVAC LZ,
                                then pathfind to the nearest one)
    blue          = your placements: EVAC LZs, barricades, troops
    magenta       = artillery shells, airstrikes, bombing runs
    yellow        = alerts and targeting sights

Spend Command Points (CP) at any time - before starting the clock or while
paused / running:

    1 EVAC LZ     helicopter landing zone; civilians route to the nearest one
    2 Barricade   two clicks: a checkpoint line that stops zombies cold while
                  civilians squeeze through. Only the open-street cells are
                  paid for; the line is also sealed (free) through the
                  buildings it crosses and the buildings at either end, so
                  hordes can't slip around it. Adjacent zombies wear it down
                  until it breaks (400 hp + 30 per street cell, at most 30
                  attackers at a time) - a squad within 40 m halves the damage
    3 Infantry    click a squad to select it, click the map to move it. Squads
                  fall back while firing when zombies close in, and squads
                  near each other reinforce (faster fire, tougher)
    4 Sniper      long range; extra range on a rooftop. Frail.
    5 Artillery   automatic AoE on the densest horde; extra range on a rooftop.
                  Frail, and friendly fire!
    6 Chopper     orbiting gunship
    7 Airstrike   one-shot heavy blast on a target
    8 Bomb run    drag a flight path; carpet-bombs everything under it

Everyone can move through building interiors and onto roofs, just much more
slowly than on the street. LZs, barricades and ground units have health;
zombies next to them attack until they are destroyed.

Difficulty adapts: evacuate a lot of people and the next outbreak is bigger
(more infected, more people to save, fewer CP); struggle and it eases off.
Progress is kept in zombie_evac_progress.json next to this script.

Maps
    Procedural cities, or real street networks and building footprints from
    OpenStreetMap via osmnx (pip install osmnx). Press M to cycle maps, or:
        python zombie_evac.py --map clarksville
        python zombie_evac.py --map dc
        python zombie_evac.py --map baltimore     (also annapolis, glenburnie)
        python zombie_evac.py --place "Nashville, Tennessee"
    Downloads are cached in ./map_cache so each place is fetched only once.

Controls
    1-8           select item             LMB  deploy / select a squad or chopper
    Barricade     click the start point, then click the end point
    Ctrl+A        select all movable units (squads + choppers); click to group-move
    Ctrl+Z        undo the last deployment, full refund (deploy phase / paused)
    RMB           remove an item (refund before the clock starts) / deselect
    Space         play / pause            F or +/-  change speed (1-8x)
    R             instant restart (same map, fresh outbreak, full CP)
    N             new procedural city (or a new outbreak on a real map)
    M             cycle maps (procedural, Clarksville TN, Washington DC,
                  Baltimore MD, Annapolis MD, Glen Burnie MD)
    F11           toggle full screen      Esc  cancel / leave full screen / quit

The window is resizable; everything rescales to fill it.
"""

import argparse
import datetime
import json
import math
import random
import re
import sys
import threading
import warnings
import zlib
from pathlib import Path

import numpy as np
import pygame

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

HERE = Path(__file__).resolve().parent
PROGRESS_FILE = HERE / "zombie_evac_progress.json"   # endless-mode difficulty history
SAVE_FILE = HERE / "zombie_evac_save.json"           # story campaign progress
OPTIONS_FILE = HERE / "zombie_evac_options.json"     # accessibility / audio options
DEFAULT_OPTIONS = dict(colorblind=False, crt=True, brightness=1.0, music=0.8, sfx=0.8, speech=0.8,
                       difficulty="medium")
MAP_CACHE = HERE / "map_cache"

# World space (simulation units; 1 unit = 1 metre on real maps).
WORLD_W, WORLD_H = 1200, 900
CELL = 5                                   # navigation grid resolution
GW, GH = WORLD_W // CELL, WORLD_H // CELL
N_CELLS = GW * GH
HASH = 20                                  # coarse spatial-hash bucket size
HC = HASH // CELL                          # nav cells per hash bucket
HW, HH = WORLD_W // HASH, WORLD_H // HASH
N_HASH = HW * HH
FAR = 1 << 20                              # "unreachable" distance

FPS = 60
SIM_DT = 1 / 30                            # fixed simulation step
FAST_SIM_DT = 1 / 15                       # coarser step at 4x/8x (agents still move < 1 cell)
MAX_STEPS_PER_FRAME = 8
SPEEDS = [1, 2, 4, 8]

CIV, ZOMBIE, RESCUED, DEAD, IN_CAR = 0, 1, 2, 3, 4      # IN_CAR: riding in a car (Game.in_car)

# Population and outbreak (baseline - adjusted by dynamic difficulty)
POPULATION = 5000
INFECTED_FRACTION = 0.15
START_CP = 350                             # (500 before the v3.3 economy nerf: -30%)
GROUND_ZEROS = (1, 3)                      # number of outbreak epicentres
# Global difficulty (Options). Multiplies the match's base stats - a Story
# mission's numbers or the Endless threat level's - when the match starts.
# Story goals (evacuation % / count, hold-out share) scale too: fewer
# infected means more healthy people, which on its own would *raise* a
# percentage target.
DIFFICULTY = {
    "easy": dict(cp=1.25, infected=0.75, infect_rate=0.85, civ_speed=1.10, goal=0.85),
    "medium": dict(cp=1.0, infected=1.0, infect_rate=1.0, civ_speed=1.0, goal=1.0),
    "hard": dict(cp=0.8, infected=1.25, infect_rate=1.15, civ_speed=0.92, goal=1.1),
}


def scaled_goal(goal, difficulty):
    """A mission's goal dict with its targets scaled for a difficulty."""
    k = DIFFICULTY.get(difficulty, DIFFICULTY["medium"])["goal"]
    out = dict(goal)
    if "save_pct" in out:
        out["save_pct"] = min(100, round(out["save_pct"] * k))
    if "save_count" in out:
        out["save_count"] = int(round(out["save_count"] * k, -2))
    if "hold_min" in out:
        out["hold_min"] = min(0.95, round(out["hold_min"] * k, 2))
    return out


def apply_difficulty(params, difficulty):
    """Match params (population, infected, cp) scaled for a difficulty."""
    d = DIFFICULTY.get(difficulty, DIFFICULTY["medium"])
    return dict(params, infected=min(0.5, params["infected"] * d["infected"]),
                cp=int(round(params["cp"] * d["cp"])))
# Where people are when it starts: most civilians shelter inside buildings,
# packed unevenly (some buildings stand empty); at each ground zero the
# infected have overrun a couple of buildings and the rest roam the street.
CIV_INDOOR = 0.7                           # civilians who start inside a building
EMPTY_BUILDING_SHARE = 0.35                # buildings nobody starts in
ZOMBIE_INDOOR = 0.35                       # infected who start inside an overrun building...
ZOMBIE_BUILDINGS = 2                       # ...the nearest this many to each ground zero
GZ_SPREAD = 30.0                           # cluster radius (std-dev, world units)
CIV_SPEED = (12.0, 17.0)                   # world units / second
ZOMBIE_SPEED = (7.0, 11.0)
INFECT_RATE = 1.5                          # per second while sharing a nav cell
# Incubation ("Trojan horse"): a bitten civilian keeps acting like a normal
# civilian - walking, evacuating, boarding helicopters - until they turn.
INCUBATION = (4.0, 12.0)                   # seconds a bitten civilian takes to turn...
LONG_INCUBATION = (15.0, 25.0)             # ...or this long for the rare long incubator
LONG_INCUBATOR_CHANCE = 0.05
SYMPTOM_TIME = 6.0                         # last seconds of incubation: visibly sick (flicker)
TURN_TIME = 1.0                            # a fresh zombie staggers this long before moving
FEED_TIME = 3.0                            # seconds a zombie stops after biting

# Terrain: building interiors / roofs are passable but slow.
INDOOR_SPEED = 0.35                        # speed factor inside buildings
INDOOR_COST = 20                           # path cost of an indoor cell: buildings are a last resort

# Civilian crowd behaviour
CELL_CAPACITY = 3.0                        # agents per nav cell before crowding slows
CROWD_MIN = 0.2                            # slowest crowd speed factor
CIV_SPREAD = 0.5                           # push away from dense crowds
CIV_FEAR = 0.35                            # bias away from zombies while evacuating
FLEE_RANGE = 24                            # path cost at which civilians notice zombies
IDLE_WANDER = 0.15                         # milling speed when nothing is happening

# Zombie horde (boids) behaviour
SCENT_RANGE = 40                           # path cost over which hordes track prey
FIELD_REFRESH = 0.5                        # seconds between scent / flee updates (time-sliced
                                           # over the steps in between: no single-frame hitch)
BOID_SEEK = 1.0
BOID_ALIGN = 0.6
BOID_COHESION = 0.35
BOID_SEPARATION = 0.5
BOID_WANDER = 0.3
BOID_STEER = 3.0                           # how quickly zombies turn (1/s)
HORDE_SURGE = 0.5                          # extra speed inside a big horde
HORDE_SIZE = 12                            # zombies nearby for a full surge
ZOMBIE_DPS = 0.6                           # damage/s per zombie attacking a unit
CHECKPOINT_SPEED = 0.3                     # civilian speed factor crossing barricades / troops
CONTACT_RADIUS = 10                        # zombies this close to a ground unit attack it

# Infantry tactics
SQUAD_SPEED = 16.0                         # repositioning speed
RETREAT_SPEED = 5.0                        # fighting-retreat speed
RETREAT_RADIUS = 16                        # zombies this close trigger a fall-back
REINFORCE_RADIUS = 45                      # squads this close support each other
REINFORCE_MAX = 3                          # neighbours that count
REINFORCE_FIRE = 0.2                       # +20% fire rate per supporting squad
REINFORCE_ARMOR = 0.15                     # -15% damage taken per supporting squad
ROOFTOP_RANGE = 1.25                       # range bonus for snipers / artillery on roofs
SEAL_SNAP = 15                             # barricade ends reach this far across open street to a building
SEAL_MAX = 100                             # ...then seal through that building up to this far
DEFEND_RADIUS = 40                         # a squad this close to a barricade is defending it
DEFEND_ARMOR = 0.5                         # defended barricades take half damage
BARRICADE_ATTACKERS = 30                   # most zombies that can batter one barricade at once
MOVABLE = ("infantry", "engineer", "chopper")   # units that take move orders (Ctrl+A)
ESCORTABLE = ("infantry", "engineer", "sniper", "artillery", "evac")
FORMATION_SPACING = 17                     # metres between units in a group move
CHOPPER_SPEED = 45.0

# Combat engineers and construction
ENGINEER_FLEE_SPEED = 12.0                 # engineers run from zombies (non-combatants)
BUILD_TIME = 2.5                           # seconds on site to finish a blueprint
BUILD_RANGE = 12                           # metres from the site to work on it
REPAIR_RADIUS = 20                         # engineers repair barricades this close
REPAIR_RATE = 10.0                         # hp/s per engineer
ASSIST_RADIUS = 25                         # engineers wave civilians through checkpoints...
CHECKPOINT_ASSISTED = 0.7                  # ...at this speed factor instead of CHECKPOINT_SPEED

# Incendiary mines and lure drones
MINE_TRIGGER = 5                           # a zombie this close sets the mine off
MINE_BLAST = 6                             # initial flash radius (no building damage)
FIRE_RADIUS = 16
FIRE_TIME = 10.0                           # seconds the fire pool burns
FIRE_KILL_RATE = 2.0                       # per second, for anyone standing in the fire
DRONE_SPEED = 12.0                         # slow enough for hordes to follow
DRONE_HOVER = 4.0                          # seconds hovering at the path end before detonating
DRONE_BLAST = 30
DRONE_MAX_PATH = 600
LURE_RADIUS = 110                          # zombies this close chase the drone...
LURE_WEIGHT = 2.5                          # ...in preference to people
ESCORT_ORBIT = 25                          # chopper orbit radius while escorting
VIP_GZ_CLEARANCE = 150                     # VIPs never start this close to a ground zero
# Escalation: mid-match paradrops, time-locked tools, armed civilians, traffic
DROP_TIME = 4.0                            # units called in after the clock starts land after this
DROP_KINDS = ("evac", "infantry", "engineer", "sniper", "artillery", "chopper")
UNLOCK_TIMES = {"sniper": 30, "engineer": 30, "mine": 60, "lure": 60,
                "artillery": 90, "chopper": 90, "airstrike": 90, "bombing": 90}
UNLOCK_NEWS = [(30, "SNIPERS + ENGINEERS"), (60, "MINES + LURE DRONES"), (90, "ARTILLERY + AIR SUPPORT")]
ARMED_FRACTION = 0.01                      # civilians carrying a concealed weapon
ARMED_RANGE = 14                           # they shoot zombies this close (guaranteed kill)...
ARMED_PAUSE = 0.8                          # ...stopping for this long per shot...
ARMED_FLEE_TIME = 6.0                      # ...then run from nearby zombies for this long...
ARMED_FLEE_BOOST = 1.3                     # ...on adrenaline (speed factor)
# Traits: a few % of agents break from the swarm (bit flags in Game.traits;
# VIPs never get any). Each is driven by vectorised per-agent timers.
T_SWIMMER, T_DROWNER, T_CLUMSY, T_LUNGER, T_DISTRACTED = 1, 2, 4, 8, 16
SWIMMER_FRACTION = 0.40                    # civilians who will swim to reach an LZ (water maps)...
DROWNER_FRACTION = 0.10                    # ...of whom this share overestimate themselves...
DROWN_AFTER = (3.0, 10.0)                  # ...and go under after this long in the water
SWIM_SPEED = 0.3                           # speed factor in water
SWIM_COST = 6                              # evac path cost of a water cell (swimmers only)
CLUMSY_FRACTION = 0.03                     # civilians who stumble or panic the wrong way...
CLUMSY_RATE = 0.08                         # ...this often (episodes per second)...
STUMBLE_TIME, STUMBLE_SPEED = (1.0, 2.0), 0.25   # ...tripping: slowed right down
CONFUSED_TIME = (2.0, 4.0)                 # ...or running the wrong way
LUNGER_FRACTION = 0.03                     # zombies that put on bursts of speed...
LUNGE_RATE = 0.5                           # ...this often while they have a scent...
LUNGE_TIME, LUNGE_SPEED, LUNGE_COOLDOWN = 0.6, 2.2, 3.0
DISTRACTED_FRACTION = 0.05                 # zombies that lose interest and wander off...
DISTRACT_RATE = 0.05                       # ...this often...
DISTRACT_TIME = (3.0, 6.0)                 # ...for this long
EP_STUMBLE, EP_CONFUSED, EP_LUNGE, EP_DISTRACTED = 1, 2, 3, 4   # Game.episode_kind
DROWN_PRESSURE = 6                         # agents in a zombie's cell that can shove it into water...
HORDE_DROWN_RATE = 0.6                     # ...where it drowns at this rate (per second)...
DROWN_PINNED = 0.35                        # ...if pinned there (moving < 35% of what it wants)
# Traffic: CAR_COUNT cars start parked on the streets. Those with people in
# them (CAR_OCCUPIED, 1-3 riders), or with a runner sprinting to them, make
# for a map edge along the roads; riders who drive off the map are
# evacuated. Cars steer by looking ahead along their route, queue behind
# each other (jams), floor it to run zombies down, turn back from overrun
# roads, and crash into dense crowds, barricades and squads. Wrecks and
# parked cars slow anyone crossing them and cook off in blasts. Cars never
# trigger a re-path.
CAR_COUNT = 500                            # cars per map (fewer on very small street networks)
CAR_PARKED, CAR_DRIVING, CAR_WRECK, CAR_BURNT, CAR_GONE = range(5)
CAR_OCCUPIED = 0.5                         # cars that start with people inside...
CAR_RIDERS = (1, 3)                        # ...this many
RUNNER_FRACTION = 0.03                     # street civilians who sprint for an empty car...
RUNNER_RANGE = 60                          # ...no further than this...
RUNNER_SPEED = 1.2                         # ...at this speed factor...
BOARD_RANGE = 3.0                          # ...and get in within this distance
CAR_START = (0.0, 20.0)                    # seconds after the clock starts before an occupied car pulls out
CAR_SPEED = (9.0, 14.0)                    # m/s
CAR_TURN = 5.0                             # rad/s steering
CAR_LOOKAHEAD = 3                          # route cells ahead a car steers for (smooth curves)
CAR_LANE = 1.5                             # m right of the route's centre line
CAR_SLOWDOWN_CROWD = 3                     # people in the 3x3 cells ahead: crawl...
CAR_CRAWL = 0.3                            # ...at this speed factor
CAR_CRASH_CROWD = 9                        # anyone (zombies too) this many ahead: ploughs in and crashes
CAR_RAM_BOOST = 1.4                        # only zombies ahead: floor it
CAR_OVERRUN = 8                            # zombies around the road 2 cells ahead: turn back...
CAR_UTURN_COOLDOWN = 6.0                   # ...at most this often
CAR_JAM_ABANDON = 25.0                     # nose-to-tail this long: everyone gets out and walks
CAR_HIT_RADIUS = 2.5                       # agents this close to a car at full speed are run over...
CAR_HIT_RATE = 1.5                         # ...at this rate (per second)
CAR_CRASH_RADIUS = 5                       # a crash kills around it (riders too)...
CAR_CRASH_KILL = 0.25                      # ...with this chance each
CAR_RAM_DAMAGE = 80                        # HP a crash takes off a barricade / squad it hits
CAR_STUCK_TIME = 3.0                       # off the road this long: abandoned (a wreck)
CAR_SLOW = 0.6                             # speed factor through a parked car / wreck cell
CAR_BLAST = 10                             # secondary explosion radius
CAR_FUSE = (0.25, 0.8)                     # seconds before a hit car goes up
# Trains (procedural maps): autonomous hazards on their own tracks. A train
# crosses the whole map, waits off-map, then comes back the other way.
RAIL_LINES = ((0.35, 0), (0.75, 1), (1.0, 2))   # cumulative chance of 0 / 1 / 2 lines (r < p)
RAIL_WIDTH = 6                             # m (rail corridor: open ground, no street)
TRAIN_SPEED = 22.0                         # m/s
TRAIN_LENGTH = 72.0                        # m (4 carriages)
TRAIN_HALF_WIDTH = 2.5                     # anyone / anything this close to the body is hit
TRAIN_FIRST = (5.0, 25.0)                  # first train this long after the clock starts
TRAIN_GAP = (12.0, 30.0)                   # off-map between runs
BRIDGE_MIN_CELLS = 2                       # narrowest bridge deck carved out of a river (nav cells)
TERRAIN_REPATH = 1.0                       # min seconds between evac re-paths after destruction

STALEMATE_TIME = 25.0                      # no change for this long ends the game
RESCUE_BONUS = 0.15                        # CP earned per rescued civilian
LZ_LIFT_TIME = 4.0                         # one helicopter load: everyone boarded in this window
TROJAN_PENALTY = 50                        # CP lost when an infected passenger downs an LZ chopper
TROJAN_FLIGHT_TIME = SYMPTOM_TIME          # ...only if they turn within the flight: i.e. visibly sick...
LZ_REPLACE_TIME = 20.0                     # ...and takes that LZ offline until a new helicopter arrives
SCREEN_LZ_RANGE = 40                       # infantry this close to an LZ screen its crowd:
SCREEN_RADIUS = 25                         # visibly sick civilians this close to the squad are shot
FAR_SCENT_SLICE = 4                        # long-range scent: wavefront rings computed per step
LZ_RADIUS = 18                             # world units
LZ_RATE = 12.0                             # civilians lifted out per second per LZ
LZ_MIN_CELLS = 8                           # open ground needed for a landing zone

# Real-world map presets (lat, lon of the view centre).
MAP_PRESETS = [
    ("PROCEDURAL", None),
    ("CLARKSVILLE, TN", (36.5298, -87.3595)),
    ("WASHINGTON, DC", (38.9000, -77.0290)),
    ("BALTIMORE, MD", (39.2900, -76.6150)),
    ("ANNAPOLIS, MD", (38.9790, -76.4935)),
    ("GLEN BURNIE, MD", (39.1626, -76.6247)),
]
# Story mode campaign: 11 missions played in order (winning one unlocks the
# next). Each mission fixes the map, population and rules; dynamic difficulty
# only applies to Endless mode. Positions / radii are world units (centre of
# the map = the mission's lat/lon = (600, 450)).
#
#   goal keys:  save_pct (evacuate this % of healthy civilians), vips (all must
#               be evacuated), survive (seconds), hold_min (fail if alive +
#               evacuated civilians drop below this fraction), eradicate (kill
#               every infected), max_collateral (fail above this)
#   rule keys:  disabled (tool ids), lz_region, build_zones ({tool id: region}:
#               that tool may only be placed inside the region; lz_region is
#               shorthand for build_zones["evac"]), lz_rate_mult, infect_mult,
#               zombie_speed_mult, barricade_cost_mult, scent_range (long-range
#               horde tracking, path cost; see FAR_SCENT_SLICE), swimmers
#               (False: no civilian swims, keeping water a hard choke point)
#   spawn keys: ground_zeros, gz_region, gz_sep, civ_region, vip_region
#   regions:    dicts of x_min/x_max/y_min/y_max, r_min/r_max (from the map
#               centre), side ("north"/"south"/"east"/"west" of water) and/or
#               poly (a world-space polygon [[x, y], ...]; polys = several)
C = (WORLD_W / 2, WORLD_H / 2)
CAMPAIGN = [
    dict(id="m1_clarksville", title="FIRST CONTACT", location="CLARKSVILLE, TENNESSEE",
         map=dict(name="CLARKSVILLE, TN", latlon=(36.5298, -87.3595), half_width=None),
         population=2000, infected=0.10, ground_zeros=1, cp=315,
         goal=dict(save_pct=40),
         briefing=["AN OUTBREAK HAS STARTED IN DOWNTOWN CLARKSVILLE.",
                   "IT IS SMALL. KEEP IT THAT WAY.",
                   "SET UP LANDING ZONES AND GET PEOPLE OUT."]),
    dict(id="m2_baltimore", title="SCALE UP", location="BALTIMORE, MARYLAND",
         map=dict(name="BALTIMORE, MD", latlon=(39.2900, -76.6150), half_width=None),
         population=6000, infected=0.15, ground_zeros=3, cp=1120, infect_mult=1.3,
         goal=dict(save_pct=50),
         briefing=["THE STRAIN HAS MUTATED: IT SPREADS FASTER NOW.",
                   "DOWNTOWN BALTIMORE IS PACKED. COMMAND HAS",
                   "TRIPLED YOUR BUDGET. USE ALL OF IT."]),
    dict(id="m3_glen_burnie", title="PRECISION EXTRACTION", location="GLEN BURNIE, MARYLAND",
         map=dict(name="GLEN BURNIE, MD", latlon=(39.1626, -76.6247), half_width=None),
         population=3500, infected=0.13, ground_zeros=2, cp=455,
         vips=4, vip_region=dict(r_max=420),
         goal=dict(),
         briefing=["FOUR VIROLOGISTS ARE TRAPPED ACROSS GLEN BURNIE.",
                   "THEY ARE OUR BEST CHANCE AT A CURE.",
                   "ALL FOUR COME HOME, OR NONE OF THIS MATTERS."]),
    dict(id="m4_white_house", title="OPERATION EAGLE'S NEST", location="THE WHITE HOUSE, WASHINGTON DC",
         map=dict(name="WHITE HOUSE, DC", latlon=(38.8977, -77.0366), half_width=800),
         population=3000, infected=0.12, ground_zeros=2, gz_min_dist=200, cp=490,
         vips=14, vip_region=dict(r_max=240),
         goal=dict(save_pct=30),
         briefing=["0300 HRS. THE OUTBREAK HAS REACHED THE NATIONAL MALL.",
                   "14 VIPS ARE SCATTERED ACROSS THE WHITE HOUSE COMPLEX.",
                   "EVERY VIP GETS OUT - AND SO DO 30% OF THE PUBLIC."]),
    dict(id="m5_times_square", title="HOLD THE LINE", location="TIMES SQUARE, NEW YORK CITY",
         map=dict(name="TIMES SQUARE, NYC", latlon=(40.7580, -73.9855), half_width=None),
         population=8000, infected=0.12, ground_zeros=3, cp=770, lz_rate_mult=1 / 1.5,
         goal=dict(survive=120, hold_min=0.35),
         briefing=["MIDTOWN IS GRIDLOCKED. HELICOPTERS ARE SLOW TO",
                   "LOAD - LZS PROCESS PEOPLE 50% SLOWER HERE.",
                   "HOLD FOR TWO MINUTES UNTIL THE NAVY ARRIVES.",
                   "IF FEWER THAN 35% REMAIN ALIVE OR EVACUATED, NYC FALLS."]),
    dict(id="m6_shibuya", title="ZERO COLLATERAL", location="SHIBUYA CROSSING, TOKYO",
         map=dict(name="SHIBUYA CROSSING, TOKYO", latlon=(35.6595, 139.7005), half_width=None),
         population=8000, infected=0.12, ground_zeros=2, cp=700,
         disabled=["artillery", "bombing"],
         goal=dict(save_pct=60, max_collateral=100),
         briefing=["THE BUSIEST CROSSING ON EARTH, AT RUSH HOUR.",
                   "ARTILLERY AND BOMB RUNS ARE NOT AUTHORISED.",
                   "PRECISION ONLY: INFANTRY, SNIPERS, CHOPPERS.",
                   "MORE THAN 100 CIVILIAN CASUALTIES ENDS THE MISSION."]),
    dict(id="m7_arc_de_triomphe", title="THE ALAMO", location="ARC DE TRIOMPHE, PARIS",
         map=dict(name="ARC DE TRIOMPHE, PARIS", latlon=(48.8738, 2.2950), half_width=None),
         population=5000, infected=0.15, ground_zeros=12, gz_region=dict(r_min=300, r_max=430), gz_sep=70,
         cp=910, lz_region=dict(r_max=110),
         goal=dict(save_pct=45),
         briefing=["TWELVE AVENUES MEET AT THE ETOILE. THE HORDE IS",
                   "COMING DOWN ALL TWELVE.",
                   "LZS CAN ONLY LAND ON THE CENTRAL ROUNDABOUT.",
                   "BARRICADE, BUILD, REPAIR. HOLD EVERY APPROACH."]),
    dict(id="m8_thames", title="BRIDGE DEFENSE", location="RIVER THAMES, LONDON",
         map=dict(name="RIVER THAMES, LONDON", latlon=(51.5085, -0.0943), half_width=800, timeout=300),
         population=6000, infected=0.12, ground_zeros=3, gz_region=dict(side="south"), gz_sep=200,
         civ_region=dict(side="north"), cp=910, scent_range=250, swimmers=False,
         goal=dict(save_pct=50),
         briefing=["THE OUTBREAK IS CONFINED TO THE SOUTH BANK.",
                   "THE CITY IS NORTH OF THE RIVER. ONLY THE BRIDGES",
                   "CONNECT THEM. MINE THEM. SHELL THEM. HOLD THEM."]),
    dict(id="m9_venice", title="ERADICATION", location="VENICE, ITALY",
         map=dict(name="VENICE, ITALY", latlon=(45.4380, 12.3358), half_width=None),
         population=3000, infected=0.10, ground_zeros=2, cp=2100, swimmers=False,
         disabled=["evac"],
         goal=dict(eradicate=True, hold_min=0.40),
         briefing=["NO HELICOPTER CAN LAND IN THESE ALLEYS.",
                   "THERE IS NO EVACUATION. THERE IS ONLY THE CURE:",
                   "KILL EVERY INFECTED BEFORE IT SPREADS.",
                   "IF FEWER THAN 40% OF RESIDENTS SURVIVE, VENICE IS LOST."]),
    dict(id="m10_pyongyang", title="MONUMENTAL DEFENSE", location="KIM IL SUNG SQUARE, PYONGYANG",
         map=dict(name="KIM IL SUNG SQUARE, PYONGYANG", latlon=(39.0194, 125.7530), half_width=800),
         population=5000, infected=0.15, ground_zeros=3, cp=980, barricade_cost_mult=6,
         goal=dict(save_pct=50),
         briefing=["THE AVENUES HERE ARE BUILT FOR PARADES, NOT DEFENSE.",
                   "BARRICADES COST SIX TIMES AS MUCH ACROSS THESE GAPS.",
                   "LAY DEEP MINEFIELDS. SET UP SNIPER CROSSFIRE."]),
    dict(id="m11_shanghai", title="MEGACITY", location="THE BUND, SHANGHAI",
         map=dict(name="THE BUND, SHANGHAI", latlon=(31.2443, 121.4865), half_width=800),
         population=12000, infected=0.15, ground_zeros=3, cp=1750,
         infect_mult=1.3, zombie_speed_mult=1.15,
         vips=8, vip_region=dict(side="north"), lz_region=dict(side="south"),
         goal=dict(save_count=5000),
         briefing=["THE FINAL OUTBREAK. TEN THOUSAND PEOPLE, ONE RIVER.",
                   "LZS CAN ONLY OPERATE SOUTH OF SUZHOU CREEK. 8 VIPS",
                   "ARE TRAPPED NORTH OF IT: ESCORT THEM OVER THE BRIDGES.",
                   "EVACUATE 5,000 PEOPLE AND EVERY VIP."]),
]


MAP_ALIASES = {"procedural": 0, "clarksville": 1, "dc": 2, "washington": 2, "baltimore": 3,
               "annapolis": 4, "glenburnie": 5, "glen-burnie": 5}
OVERPASS_URLS = [                          # OpenStreetMap query servers, tried in order
    "https://overpass-api.de/api",
    "https://lz4.overpass-api.de/api",                  # high-capacity instance of the main server
    "https://overpass.private.coffee/api",
    "https://overpass.kumi.systems/api",
]
ROAD_WIDTHS = {                            # metres, by OSM highway tag
    "motorway": 22, "trunk": 18, "primary": 16, "secondary": 14, "tertiary": 12,
    "motorway_link": 10, "trunk_link": 10, "primary_link": 10, "secondary_link": 9,
    "residential": 9, "unclassified": 9, "living_street": 7, "service": 6,
    "pedestrian": 6, "footway": 3, "path": 3, "cycleway": 3, "steps": 3, "track": 4,
}

# Gruvbox-style CCTV palette (exact colours as specified).
COL_BG = (0x28, 0x28, 0x28)                # background black  #282828
COL_RED = (0xcc, 0x24, 0x1d)               # zombies           #cc241d
COL_GREEN = (0x98, 0x97, 0x1a)             # civilians         #98971a
COL_YELLOW = (0xd7, 0x99, 0x21)            # UI alerts         #d79921
COL_BLUE = (0x45, 0x85, 0x88)              # placement / evac  #458588
COL_CYAN = (0x68, 0x9d, 0x6a)              # infrastructure    #689d6a
COL_WHITE = (0xa8, 0x99, 0x84)             # text / grids      #a89984
COL_MAGENTA = (0xb1, 0x62, 0x86)           # artillery/special #b16286


def mix(a, b, t):
    """Blend palette colour a toward b (used only for dim fills and fades)."""
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


COL_VIP = COL_CYAN                         # VIP civilians (infrastructure cyan, as specified)
PALETTE_STD = (COL_RED, COL_GREEN)
PALETTE_CB = ((0xfe, 0x80, 0x19), (0x83, 0xa5, 0x98))   # colour-blind: orange zombies, blue civilians


def set_palette(colorblind):
    """Swap the zombie / civilian colours for a red-green-safe pair."""
    global COL_RED, COL_GREEN
    COL_RED, COL_GREEN = PALETTE_CB if colorblind else PALETTE_STD


COL_BUILDING = mix(COL_BG, COL_CYAN, 0.10)
COL_LOT_LINE = mix(COL_BG, COL_CYAN, 0.40)
COL_PARK = mix(COL_BG, COL_GREEN, 0.12)
COL_GRIDLINE = mix(COL_BG, COL_WHITE, 0.16)
COL_DEAD = mix(COL_BG, COL_WHITE, 0.30)
COL_WHITE_DIM = mix(COL_BG, COL_WHITE, 0.55)

UNIT_ORDER = ["evac", "barricade", "mine", "infantry", "engineer", "sniper", "artillery", "chopper",
              "airstrike", "bombing", "lure"]
UNIT_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "L"]       # hotkey labels
UNIT_SPECS = {
    "evac": dict(name="EVAC LZ", cost=100, mode="point", color=COL_BLUE, hp=300,
                 desc="HELI LANDING ZONE", how="CLICK OPEN GROUND"),
    "barricade": dict(name="BARRICADE", cost=1, cost_label="1/CELL", mode="drag", max_len=220,
                      hp=400, hp_per_cell=30, color=COL_BLUE, desc="SEALS STREET+BUILDINGS",
                      how="CLICK START, CLICK END"),
    "mine": dict(name="INCENDIARY MINE", cost=25, mode="point", color=COL_MAGENTA,
                 desc="FIRE TRAP. FRIENDLY FIRE", how="CLICK. LIVE: ENGINEER BUILDS"),
    "engineer": dict(name="ENGINEERS", cost=40, mode="point", hp=60, color=COL_BLUE,
                     desc="BUILD, REPAIR. NO GUNS", how="CLICK TO DEPLOY"),
    "lure": dict(name="LURE DRONE", cost=50, mode="path", color=COL_MAGENTA,
                 desc="DRAWS HORDES, THEN BLOWS", how="DRAG A FLIGHT PATH"),
    "infantry": dict(name="INFANTRY", cost=30, mode="point", range=32, cooldown=0.35, hp=120,
                     color=COL_BLUE, desc="CLICK SQUAD TO MOVE IT", how="CLICK TO DEPLOY"),
    "sniper": dict(name="SNIPER", cost=40, mode="point", range=110, cooldown=0.9, hp=25,
                   color=COL_BLUE, desc="ROOFTOP: +25% RANGE", how="CLICK ANYWHERE"),
    "artillery": dict(name="ARTILLERY", cost=80, mode="point", range=360, cooldown=6.0, hp=35,
                      blast=26, shell_time=1.2, color=COL_MAGENTA,
                      desc="AUTO AOE. FRIENDLY FIRE", how="ROOFTOP: +25% RANGE"),
    "chopper": dict(name="CHOPPER", cost=120, mode="point", range=55, orbit=45, cooldown=0.15,
                    hit_chance=0.7, color=COL_BLUE, desc="ORBITING GUNSHIP", how="CLICK ORBIT CENTER"),
    "airstrike": dict(name="AIRSTRIKE", cost=60, mode="point", blast=42, delay=2.0,
                      color=COL_MAGENTA, desc="ONE-SHOT HEAVY BLAST", how="CLICK TARGET"),
    "bombing": dict(name="BOMB RUN", cost=150, mode="drag", max_len=480, blast=20, spacing=22,
                    plane_speed=220, delay=1.0, color=COL_MAGENTA,
                    desc="CARPET-BOMB A LINE", how="DRAG FLIGHT PATH"),
}

# Window / layout. UI sizes are authored for BASE_W x BASE_H and scaled.
BASE_W, BASE_H = 1280, 720
MIN_W, MIN_H = 800, 450
PANEL_MIN, PANEL_MAX = 380, 620
FONT_NAMES = ("dejavusansmono,notosansmono,liberationmono,ubuntumono,"
              "consolas,menlo,couriernew,monospace")

# 8-neighbourhood offsets (dx, dy) and their unit vectors.
OFFSETS = [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)]
NEIGHBOURS9 = np.array([dy * GW + dx for dy in (-1, 0, 1) for dx in (-1, 0, 1)])   # flat 3x3 offsets
OFFSET_VEC = np.array([(dx / math.hypot(dx, dy), dy / math.hypot(dx, dy)) for dx, dy in OFFSETS],
                      np.float32)


# --------------------------------------------------------------------------
# Grid / navigation helpers (vectorised with numpy)
# --------------------------------------------------------------------------

def bfs_field(walk, sources, max_iter=FAR, cost=None):
    """Multi-source wavefront distance over a 2D walkable mask.

    With `cost` (an int array >= 1, the price of entering each cell) this is
    a vectorised Dial's algorithm: a cell reached at time t from the frontier
    is settled at t + cost. Diagonal steps are only taken on alternate rings,
    which approximates Euclidean distance (octagonal metric).
    """
    gen = bfs_iter(walk, sources, max_iter, cost)
    while True:
        try:
            next(gen)
        except StopIteration as done:
            return done.value


def bfs_iter(walk, sources, max_iter=FAR, cost=None):
    """`bfs_field` as a generator: yields after every wavefront ring and
    returns the distance grid, so long searches can be time-sliced across
    simulation steps instead of stalling one frame."""
    dist = np.full(walk.shape, FAR, np.int32)
    front = sources & walk
    done = front.copy()
    dist[front] = 0
    tent = None if cost is None else np.full(walk.shape, FAR, np.int32)
    nb = np.empty_like(front)
    it = 0
    while it < max_iter:
        nb[:] = False
        nb[1:] |= front[:-1]
        nb[:-1] |= front[1:]
        nb[:, 1:] |= front[:, :-1]
        nb[:, :-1] |= front[:, 1:]
        if it & 1:
            nb[1:, 1:] |= front[:-1, :-1]
            nb[1:, :-1] |= front[:-1, 1:]
            nb[:-1, 1:] |= front[1:, :-1]
            nb[:-1, :-1] |= front[1:, 1:]
        nb &= walk
        nb &= ~done
        if cost is None:
            if not nb.any():
                break
            front = nb.copy()
        else:
            if nb.any():
                tent[nb] = np.minimum(tent[nb], it + cost[nb])
            front = (tent == it + 1) & ~done
            if not front.any() and not ((tent < FAR) & ~done).any():
                break
        it += 1
        done |= front
        dist[front] = it
        yield
    return dist


def flow_field(cost):
    """Per-cell unit vector toward the neighbour with the lowest cost.

    Blocked cells must hold FAR. Cells already at a local minimum get (0, 0).
    """
    pad = np.pad(cost, 1, constant_values=FAR)
    stack = np.stack([pad[1 + dy:1 + dy + GH, 1 + dx:1 + dx + GW] for dx, dy in OFFSETS])
    k = stack.argmin(0)
    best = np.take_along_axis(stack, k[None], 0)[0]
    flow = OFFSET_VEC[k] * (best < cost)[..., None]
    return flow.reshape(-1, 2)


def box3(a):
    """3x3 box sum (smooths spatial-hash and occupancy grids), separable."""
    r = a.copy()
    r[1:] += a[:-1]
    r[:-1] += a[1:]
    c = r.copy()
    c[:, 1:] += r[:, :-1]
    c[:, :-1] += r[:, 1:]
    return c


def unit(v, cap=False):
    """Normalise rows of v. With cap=True, only shrink vectors longer than 1."""
    n = np.hypot(v[:, 0], v[:, 1])[:, None]
    if cap:
        return v / np.maximum(n, 1.0)
    return np.divide(v, n, out=np.zeros_like(v), where=n > 1e-6)


def cells_of(pos):
    cx = np.clip((pos[:, 0] * (1.0 / CELL)).astype(np.int32), 0, GW - 1)
    cy = np.clip((pos[:, 1] * (1.0 / CELL)).astype(np.int32), 0, GH - 1)
    return cx, cy


def cell_index(x, y):
    cx = min(GW - 1, max(0, int(x // CELL)))
    cy = min(GH - 1, max(0, int(y // CELL)))
    return cy * GW + cx


def cell_center(c):
    return (c % GW + 0.5) * CELL, (c // GW + 0.5) * CELL


def disc_cells(x, y, r):
    """Flat indices of nav cells whose centre lies within r of (x, y)."""
    gx0, gx1 = max(0, int((x - r) // CELL)), min(GW - 1, int((x + r) // CELL))
    gy0, gy1 = max(0, int((y - r) // CELL)), min(GH - 1, int((y + r) // CELL))
    gx, gy = np.meshgrid(np.arange(gx0, gx1 + 1), np.arange(gy0, gy1 + 1))
    m = ((gx + 0.5) * CELL - x) ** 2 + ((gy + 0.5) * CELL - y) ** 2 <= r * r
    return (gy[m] * GW + gx[m]).ravel()


def segment_cells(x0, y0, x1, y1, half_width):
    """Flat indices of nav cells whose centre lies within half_width of a segment."""
    hw = half_width
    gx0 = max(0, int((min(x0, x1) - hw) // CELL))
    gx1 = min(GW - 1, int((max(x0, x1) + hw) // CELL))
    gy0 = max(0, int((min(y0, y1) - hw) // CELL))
    gy1 = min(GH - 1, int((max(y0, y1) + hw) // CELL))
    gx, gy = np.meshgrid(np.arange(gx0, gx1 + 1), np.arange(gy0, gy1 + 1))
    px, py = (gx + 0.5) * CELL, (gy + 0.5) * CELL
    dx, dy = x1 - x0, y1 - y0
    t = np.clip(((px - x0) * dx + (py - y0) * dy) / max(dx * dx + dy * dy, 1e-9), 0, 1)
    d2 = (px - (x0 + t * dx)) ** 2 + (py - (y0 + t * dy)) ** 2
    m = d2 <= hw * hw
    return (gy[m] * GW + gx[m]).ravel()


def point_segment_dist(px, py, x0, y0, x1, y1):
    dx, dy = x1 - x0, y1 - y0
    t = max(0.0, min(1.0, ((px - x0) * dx + (py - y0) * dy) / max(dx * dx + dy * dy, 1e-9)))
    return math.hypot(px - (x0 + t * dx), py - (y0 + t * dy))


def simplify_ring(points, eps):
    """Douglas-Peucker for a closed outline (e.g. a pygame Mask outline):
    drops points within eps of the straight line between their neighbours."""
    pts = np.asarray(list(points) + [points[0]], float)
    keep = np.zeros(len(pts), bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        seg, rel = pts[b] - pts[a], pts[a + 1:b] - pts[a]
        n = math.hypot(*seg)
        d = np.abs(seg[0] * rel[:, 1] - seg[1] * rel[:, 0]) / n if n > 1e-9 else np.hypot(rel[:, 0], rel[:, 1])
        k = int(np.argmax(d))
        if d[k] > eps:
            keep[a + 1 + k] = True
            stack += [(a, a + 1 + k), (a + 1 + k, b)]
    return pts[keep][:-1].tolist()


def clamp_segment(x0, y0, x1, y1, max_len):
    d = math.hypot(x1 - x0, y1 - y0)
    if d > max_len:
        k = max_len / d
        x1, y1 = x0 + (x1 - x0) * k, y0 + (y1 - y0) * k
    return x1, y1


def draw_thick_polyline(surf, color, pts, width):
    """Wide polyline with round joints (pygame leaves gaps at corners)."""
    if len(pts) < 2:
        return
    width = max(1, int(round(width)))
    pygame.draw.lines(surf, color, False, pts, width)
    if width > 2:
        for p in pts:
            pygame.draw.circle(surf, color, p, width // 2)


# --------------------------------------------------------------------------
# Real-world map data (OpenStreetMap via osmnx)
# --------------------------------------------------------------------------

def slugify(name):
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


def fetch_osm(name, latlon=None, half_width=None, timeout=None):
    """Download (or load from cache) the street network and building
    footprints around a place, cropped to the world rectangle and converted
    to world coordinates (y down). Returns plain JSON-able data.

    By default 1 world unit = 1 m (a 1200 x 900 m view). `half_width` (m)
    widens the view: e.g. 800 shows +/-800 m east-west (+/-600 m north-
    south) squeezed into the same world, i.e. 1 unit = 4/3 m. `timeout` (s)
    raises the Overpass query timeout for very dense maps (default 180)."""
    cache = MAP_CACHE / f"{slugify(name)}.json"
    k = half_width / (WORLD_W / 2) if half_width else 1.0
    if cache.exists():
        data = json.loads(cache.read_text())
        if "water" in data and (data.get("road_tags") or not data["water"]):
            return data
        latlon = (data["lat"], data["lon"])     # older cache: water or bridge tags missing
        k = data.get("scale", 1.0)
    else:
        data = None
    try:
        import geopandas as gpd
        import osmnx as ox
        from shapely.geometry import Point, box
    except ImportError as e:
        if data is not None and "water" in data:
            return data                          # old cache, no osmnx: play without bridges
        raise RuntimeError("Real maps need osmnx: pip install osmnx") from e

    MAP_CACHE.mkdir(exist_ok=True)
    ox.settings.use_cache = True
    ox.settings.cache_folder = str(MAP_CACHE / "osmnx")
    ox.settings.log_console = False
    ox.settings.requests_timeout = timeout or 180
    if latlon is None:
        latlon = ox.geocode(name)
    lat, lon = latlon
    hw, hh = WORLD_W / 2 * k, WORLD_H / 2 * k   # crop half-extents in metres
    dist = max(hw, hh) + 40

    def download():
        def to_world(coords):
            return [[round((x - c.x) / k + WORLD_W / 2, 1), round(WORLD_H / 2 - (y - c.y) / k, 1)]
                    for x, y in coords]

        def parts(geom):
            return list(geom.geoms) if hasattr(geom, "geoms") else [geom]

        def polygons(tags, crs):
            try:
                f = ox.features_from_point((lat, lon), tags=tags, dist=dist)
            except ox._errors.InsufficientResponseError:   # nothing with these tags here
                return []
            f = f[f.geometry.geom_type.isin(["Polygon", "MultiPolygon"])].to_crs(crs)
            out = []
            for geom in f.geometry:
                for p in parts(geom.intersection(crop)):
                    if p.geom_type == "Polygon" and not p.is_empty and p.area >= 12:
                        out.append(to_world(p.simplify(0.6).exterior.coords))
            return out

        def layer(tags):
            """OSM bridge / tunnel tag -> "bridge", "tunnel" or ""."""
            for key in ("bridge", "tunnel"):
                v = tags.get(key)
                v = v[0] if isinstance(v, list) else v
                if isinstance(v, str) and v != "no":
                    return key
            return ""

        graph = ox.graph_from_point((lat, lon), dist=dist, dist_type="bbox", network_type="all",
                                    simplify=True, retain_all=True, truncate_by_edge=True)
        graph = ox.project_graph(graph)
        crs = graph.graph["crs"]
        edges = ox.graph_to_gdfs(graph, nodes=False)
        c = gpd.GeoSeries([Point(lon, lat)], crs="EPSG:4326").to_crs(crs).iloc[0]
        crop = box(c.x - hw, c.y - hh, c.x + hw, c.y + hh)
        roads = []
        cols = [col for col in ("bridge", "tunnel") if col in edges.columns]
        for tag, geom, tags in zip(edges["highway"], edges.geometry, edges[cols].to_dict("records")):
            tag = tag[0] if isinstance(tag, list) else tag
            width = round(ROAD_WIDTHS.get(tag, 7) / k, 1)    # stored in world units
            for ln in parts(geom.intersection(crop.buffer(30))):
                if ln.geom_type == "LineString" and not ln.is_empty:
                    roads.append([width, to_world(ln.coords), layer(tags)])
        water_tags = {"natural": ["water", "bay"], "water": True, "waterway": "riverbank"}
        if data is not None:                         # migrate an old cache: water / bridge tags
            if "water" not in data:
                data["water"] = polygons(water_tags, crs)
            data["roads"], data["road_tags"] = roads, True
            cache.write_text(json.dumps(data))
            return data
        buildings = polygons({"building": True}, crs)
        water = polygons(water_tags, crs)
        fresh = dict(name=name, lat=lat, lon=lon, scale=k, buildings=buildings, roads=roads, water=water,
                     road_tags=True)
        cache.write_text(json.dumps(fresh))
        return fresh

    # Public Overpass servers rate-limit or go down; try mirrors in turn.
    errors = []
    for url in OVERPASS_URLS:
        ox.settings.overpass_url = url
        try:
            return download()
        except Exception as e:                   # connection refused, 429, timeouts...
            errors.append(f"{url.split('/')[2]}: {str(e).splitlines()[0][:80] if str(e) else type(e).__name__}")
    if data is not None and "water" in data:
        return data                              # offline: keep the old cache (no bridges)
    raise RuntimeError("all OpenStreetMap servers failed - " + " | ".join(errors))


# --------------------------------------------------------------------------
# Cities
# --------------------------------------------------------------------------

class City:
    """Static city layout. Built once per map; `Game.reset()` reuses it so
    restarts are instant.

    Every cell is passable: `indoor` cells (building interiors / roofs) just
    cost more to path through and slow everyone down. `street` cells are open
    road where civilians and ground zeros spawn."""

    def __init__(self, name, seed):
        self.name, self.seed = name, seed
        self.polys, self.roads, self.water_polys = [], [], []    # geometry (world units)
        self.park_polys, self.lot_lines = [], []                 # procedural extras (render only)
        self.rails = []                                          # railway polylines (procedural only)
        self.surface = None

    @classmethod
    def procedural(cls, seed):
        """An organic city grown from a road network (see _generate), built
        through the same rasteriser as real OpenStreetMap maps."""
        city = cls("PROCEDURAL", seed)
        roads, water, buildings, parks, lots = city._generate(random.Random(seed))
        city.park_polys, city.lot_lines = parks, lots
        city.rails = [pts for w, pts, lyr in roads if lyr == "rail"]
        city._rasterize(buildings, roads, water)
        return city

    @classmethod
    def from_osm(cls, data):
        city = cls(data["name"].upper(), zlib.crc32(data["name"].encode()) % (1 << 30))
        # Roads: (width, points, layer) where layer is "bridge", "tunnel" or ""
        # (caches from before bridge tags have no layer).
        city._rasterize(data["buildings"], [(r[0], r[1], r[2] if len(r) > 2 else "") for r in data["roads"]],
                        data.get("water", []))
        return city

    def _rasterize(self, buildings, roads, water):
        """Building / water polygons and road polylines (world units) ->
        the nav-grid masks."""
        city = self
        city.polys = [[tuple(p) for p in poly] for poly in buildings]
        city.roads = [(w, [tuple(p) for p in pts], lyr) for w, pts, lyr in roads]
        surf = pygame.Surface((GW, GH), 0, 32)
        surf.fill((0, 0, 0))
        for n, poly in enumerate(city.polys, 1):      # each footprint drawn in its own colour = its id
            if len(poly) >= 3:
                pygame.draw.polygon(surf, (n & 255, (n >> 8) & 255, n >> 16), [(x / CELL, y / CELL) for x, y in poly])
        rgb = pygame.surfarray.array3d(surf).astype(np.int32)
        label = (rgb[..., 0] | (rgb[..., 1] << 8) | (rgb[..., 2] << 16)).T
        city.indoor = label > 0
        surf = pygame.Surface((GW, GH))
        city.water_polys = [[tuple(p) for p in poly] for poly in water]
        surf.fill((0, 0, 0))
        for poly in city.water_polys:
            if len(poly) >= 3:
                pygame.draw.polygon(surf, (255, 255, 255), [(x / CELL, y / CELL) for x, y in poly])
        city.water_full = pygame.surfarray.array_red(surf).T > 0    # river including under bridges
        # Bridges: rivers are mapped as one area running under the decks, so
        # carve every bridge back out of the water (at least BRIDGE_MIN_CELLS
        # wide so a footbridge stays crossable). Tunnels run underneath and
        # are left out of the street mask altogether.
        surf.fill((0, 0, 0))
        for w, pts, lyr in city.roads:
            if lyr in ("bridge", "rail"):        # (railway bridges too)
                draw_thick_polyline(surf, (255, 255, 255), [(x / CELL, y / CELL) for x, y in pts],
                                    max(BRIDGE_MIN_CELLS, w / CELL))
        city.bridge = (pygame.surfarray.array_red(surf).T > 0) & city.water_full
        city.water = city.water_full & ~city.bridge
        city.indoor &= ~city.water_full
        city.bldg_label = np.where(city.indoor, label, 0).ravel()   # building id per cell (0 = none)
        city.n_bldg = len(city.polys)
        surf.fill((0, 0, 0))
        for w, pts, lyr in city.roads:
            if lyr not in ("tunnel", "rail"):
                draw_thick_polyline(surf, (255, 255, 255), [(x / CELL, y / CELL) for x, y in pts],
                                    max(1, w / CELL))
        street = (pygame.surfarray.array_red(surf).T > 0) & ~city.indoor & ~city.water
        if street.sum() < 3000:                  # sparse mapping: use all open ground
            street = ~city.indoor & ~city.water
        city._finish(street)

    def _finish(self, street):
        # Water (real maps) is the only thing nobody can cross. Spawns only
        # use streets connected to the map edge.
        self.walk_all = ~self.water
        self.walk_flat = self.walk_all.ravel().copy()
        self.indoor0 = self.indoor.copy()        # pristine buildings (restored on reset)
        self.indoor_flat = self.indoor.reshape(-1)          # view: stays in sync with indoor
        self.open_flat = ~self.indoor_flat & self.walk_flat
        self.cost = np.where(self.indoor, INDOOR_COST, 1).astype(np.int32)
        self.rubble = np.zeros(N_CELLS, bool)
        self.rubble_new = []                     # cells destroyed since the last repaint
        self.surface_dirty = False
        edge = np.zeros((GH, GW), bool)
        edge[0, :] = edge[-1, :] = edge[:, 0] = edge[:, -1] = True
        reach = bfs_field(self.walk_all, edge & self.walk_all, cost=self.cost) < FAR
        self.street = street & reach
        self.street_cells = np.flatnonzero(self.street.ravel())
        rng = np.random.default_rng(self.seed + 7)      # where the cars are parked (same every match)
        n_cars = min(CAR_COUNT, self.street_cells.size // 8)
        self.cars = rng.choice(self.street_cells, n_cars, replace=False) if n_cars else np.zeros(0, int)
        self._car_routes = None

    def car_routes(self):
        """Road-only routes to each map edge (west, east, north, south):
        (flow (4, N, 2), distance (4, N)), computed once per map."""
        if self._car_routes is None:
            flows, dists = [], []
            for side in range(4):
                src = np.zeros((GH, GW), bool)
                src[(slice(None), slice(None), 0, -1)[side], (0, -1, slice(None), slice(None))[side]] = True
                d = bfs_field(self.street, src & self.street)
                flows.append(flow_field(d))
                dists.append(d.ravel())
            self._car_routes = (np.stack(flows).astype(np.float32), np.stack(dists))
        return self._car_routes

    def main_water(self):
        """Largest connected body of water (the river), cached. Used to tell
        which bank a point is on without ponds or harbours skewing it.
        Bridges don't split the river here (uses the uncarved water)."""
        if getattr(self, "_main_water", None) is None:
            left, best = self.water_full.copy(), np.zeros((GH, GW), bool)
            while left.any() and left.sum() > best.sum():
                seed = np.zeros((GH, GW), bool)
                seed.flat[np.flatnonzero(left)[0]] = True
                comp = bfs_field(left, seed) < FAR
                if comp.sum() > best.sum():
                    best = comp
                left &= ~comp
            self._main_water = best
        return self._main_water

    # -- environmental destruction ----------------------------------------

    def destroy(self, cells):
        """Turn building cells into rubble: fully passable open ground for
        everyone. Returns how many cells were destroyed."""
        cells = cells[self.indoor_flat[cells]]
        if cells.size:
            self.indoor_flat[cells] = False
            self.open_flat[cells] = self.walk_flat[cells]
            self.cost.reshape(-1)[cells] = 1
            self.rubble[cells] = True
            self.rubble_new.extend(cells.tolist())
        return cells.size

    def restore(self):
        """Undo all destruction (new match on the same map)."""
        if not self.rubble.any():
            return
        self.indoor[:] = self.indoor0
        self.open_flat[:] = ~self.indoor_flat & self.walk_flat
        self.cost[:] = np.where(self.indoor, INDOOR_COST, 1)
        self.rubble[:] = False
        self.rubble_new = []
        self.surface_dirty = True

    def paint_rubble(self, surf, s, cells):
        """Draw rubble over destroyed cells (on the pre-rendered city)."""
        k = max(1, math.ceil(CELL * s))
        base, chip = mix(COL_BG, COL_WHITE, 0.10), mix(COL_BG, COL_WHITE, 0.32)
        for c in cells:
            x, y = int((c % GW) * CELL * s), int((c // GW) * CELL * s)
            surf.fill(base, (x, y, k, k))
            h = (c * 2654435761) & 0xFFFF            # deterministic speckle
            for n in range(3):
                surf.fill(chip, (x + (h >> (n * 4)) % k, y + (h >> (n * 4 + 2)) % k,
                                 max(1, k // 4), max(1, k // 4)))

    # -- procedural generation -------------------------------------------
    #
    # Organic cities: lay down a road network first, then put buildings in
    # whatever is left between the roads.
    #  1. Districts: 3-6 seeds with wiggly Voronoi borders, each with its own
    #     street-grid angle and block size, so grids meet at odd angles.
    #  2. Each district's streets wobble; some are cut short or dropped
    #     (dead ends, T-junctions, superblocks), and every street pokes one
    #     step past its district border to stitch into the neighbour's grid.
    #  3. Arterials: curved avenues joining the districts (a spanning tree
    #     plus extra links), out to the map edge, and 1-2 cross-town routes;
    #     sometimes a roundabout.
    #  4. Sometimes a meandering river; the arterials cross it on bridges.
    #  5. Blocks = the ground left between roads, set back one cell for the
    #     pavement. Each becomes a building footprint (its simplified
    #     outline), a park or a plaza; footprints get lot lines (render only).

    def _generate(self, rng):
        W, H = WORLD_W, WORLD_H
        n = rng.randint(3, 6)
        seeds = [(rng.uniform(120, W - 120), rng.uniform(100, H - 100)) for _ in range(n)]
        wiggle = [(rng.uniform(80, 140), rng.uniform(0, 6.3), rng.uniform(70, 120), rng.uniform(0, 6.3))
                  for _ in range(n)]

        def owner(x, y):
            d = np.stack([np.hypot(x - sx, y - sy) + 35 * np.sin(x / a + p) * np.cos(y / b + q)
                          for (sx, sy), (a, p, b, q) in zip(seeds, wiggle)])
            return d.argmin(0)

        def curve(p0, p1, bend):
            """Quadratic Bezier from p0 to p1, bowed sideways by `bend`."""
            dx, dy = p1[0] - p0[0], p1[1] - p0[1]
            cx, cy = (p0[0] + p1[0]) / 2 - dy * bend, (p0[1] + p1[1]) / 2 + dx * bend
            t = np.linspace(0, 1, max(4, int(math.hypot(dx, dy) / 20)))
            x = (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * cx + t ** 2 * p1[0]
            y = (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * cy + t ** 2 * p1[1]
            return list(zip(x.tolist(), y.tolist()))

        # River first, so the cross-town arterials can be laid across it.
        water, river_horiz = [], None
        if rng.random() < 0.3:
            river_horiz = rng.random() < 0.5
            t = np.linspace(-80, (W if river_horiz else H) + 80, 90)
            c = (rng.uniform(0.3, 0.7) * (H if river_horiz else W)
                 + rng.uniform(30, 90) * np.sin(t / rng.uniform(250, 450) + rng.uniform(0, 6.3))
                 + rng.uniform(8, 25) * np.sin(t / rng.uniform(80, 140) + rng.uniform(0, 6.3)))
            mid = np.stack([t, c], 1) if river_horiz else np.stack([c, t], 1)
            d = np.gradient(mid, axis=0)
            d /= np.hypot(d[:, 0], d[:, 1])[:, None]
            side = np.stack([-d[:, 1], d[:, 0]], 1) * rng.uniform(22, 40)
            water.append([tuple(p) for p in (mid + side).tolist()] + [tuple(p) for p in (mid - side)[::-1].tolist()])

        roads, arterials = [], []
        # District street grids.
        t = np.arange(-1500, 1500, 15.0)
        inside = None
        for i, (sx, sy) in enumerate(seeds):
            th = rng.uniform(0, math.pi / 2)
            u = (math.cos(th), math.sin(th))
            v = (-u[1], u[0])
            for along, across, spacing, widths in ((u, v, rng.uniform(55, 85), (9, 10, 12)),
                                                   (v, u, rng.uniform(40, 65), (7, 9, 9))):
                amp, lam = rng.uniform(0, 7), rng.uniform(60, 160)
                o = -1500 + rng.uniform(0, spacing)
                while o < 1500:
                    wob = amp * np.sin(t / lam + rng.uniform(0, 6.3))
                    x = sx + across[0] * (o + wob) + along[0] * t
                    y = sy + across[1] * (o + wob) + along[1] * t
                    inside = (x > -40) & (x < W + 40) & (y > -40) & (y < H + 40)
                    keep = inside & (owner(x, y) == i)
                    idx = np.flatnonzero(keep)
                    if idx.size:
                        for run in np.split(idx, np.flatnonzero(np.diff(idx) > 1) + 1):
                            a, b = max(run[0] - 1, 0), min(run[-1] + 1, t.size - 1)   # stitch past the border
                            r = rng.random()
                            if b - a < 2 or r < 0.08:
                                continue                      # dropped: a superblock
                            pieces = [(a, b)]
                            if r < 0.3 and b - a > 10:        # cut short: dead ends / T-junctions
                                k = rng.randint(a + 2, b - 4)
                                g = rng.randint(3, max(3, (b - a) // 3))
                                pieces = [(a, k), (min(k + g, b), b)]
                            w = rng.choice(widths)
                            for p, q in pieces:
                                if q - p >= 1:
                                    roads.append((w, list(zip(x[p:q + 1].tolist(), y[p:q + 1].tolist())), ""))
                    o += spacing * rng.uniform(0.85, 1.15)

        # Arterials: a spanning tree over the district centres plus extra links.
        dist = lambda e: math.hypot(seeds[e[0]][0] - seeds[e[1]][0], seeds[e[0]][1] - seeds[e[1]][1])
        tree, links = {0}, []
        while len(tree) < n:
            e = min(((a, b) for a in tree for b in range(n) if b not in tree), key=dist)
            links.append(e)
            tree.add(e[1])
        for _ in range(rng.randint(1, 2)):
            a, b = rng.sample(range(n), 2)
            if (a, b) not in links and (b, a) not in links:
                links.append((a, b))
        for a, b in links:
            arterials.append((rng.choice([16, 18, 20]), curve(seeds[a], seeds[b], rng.uniform(-0.25, 0.25))))
        for a in rng.sample(range(n), min(n, 3)):            # out to the map edge
            sx, sy = seeds[a]
            edge = min(((-40, sy), (W + 40, sy), (sx, -40), (sx, H + 40)),
                       key=lambda p: math.hypot(p[0] - sx, p[1] - sy))
            edge = (edge[0] + rng.uniform(-80, 80), edge[1]) if edge[1] in (-40, H + 40) \
                else (edge[0], edge[1] + rng.uniform(-80, 80))
            arterials.append((rng.choice([16, 18]), curve((sx, sy), edge, rng.uniform(-0.2, 0.2))))
        for _ in range(rng.randint(1, 2)):                    # cross-town routes (over the river)
            vertical = river_horiz if river_horiz is not None else rng.random() < 0.5
            if vertical:
                p0, p1 = (rng.uniform(100, W - 100), -40), (rng.uniform(100, W - 100), H + 40)
            else:
                p0, p1 = (-40, rng.uniform(100, H - 100)), (W + 40, rng.uniform(100, H - 100))
            arterials.append((rng.choice([18, 22]), curve(p0, p1, rng.uniform(-0.2, 0.2))))
        if rng.random() < 0.6:                                # a roundabout on a district centre
            cx, cy = seeds[rng.randrange(n)]
            r = rng.uniform(28, 40)
            ring = [(cx + r * math.cos(a), cy + r * math.sin(a)) for a in np.linspace(0, 2 * math.pi, 29)]
            arterials.append((12, ring))
        for w, pts in arterials:
            roads.append((w, pts, ""))
            if water:
                roads.append((w, pts, "bridge"))              # carved out of the river where it crosses

        # Railways: 0-2 gently curving lines right across the map, on their
        # own corridor (blocks stop at them; rivers get rail bridges).
        r, lines = rng.random(), 0
        for p, k in RAIL_LINES:
            if r < p:
                lines = k
                break
        for _ in range(lines):
            if rng.random() < 0.5:
                p0, p1 = (-60, rng.uniform(80, H - 80)), (W + 60, rng.uniform(80, H - 80))
            else:
                p0, p1 = (rng.uniform(80, W - 80), -60), (rng.uniform(80, W - 80), H + 60)
            roads.append((RAIL_WIDTH, curve(p0, p1, rng.uniform(-0.12, 0.12)), "rail"))

        # Blocks: open ground between roads (and off the river), less a
        # one-cell pavement all round.
        surf = pygame.Surface((GW, GH))
        surf.fill((0, 0, 0))
        for w, pts, lyr in roads:
            if lyr in ("", "rail"):
                draw_thick_polyline(surf, (255, 255, 255), [(x / CELL, y / CELL) for x, y in pts], max(1, w / CELL))
        for poly in water:
            pygame.draw.polygon(surf, (255, 255, 255), [(x / CELL, y / CELL) for x, y in poly])
        free = pygame.surfarray.array_red(surf) == 0             # (GW, GH)
        block = free.copy()
        block[1:] &= free[:-1]
        block[:-1] &= free[1:]
        block[:, 1:] &= free[:, :-1]
        block[:, :-1] &= free[:, 1:]
        surf.fill((0, 0, 0))
        pix = pygame.surfarray.pixels3d(surf)
        pix[block] = 255
        del pix
        mask = pygame.mask.from_threshold(surf, (255, 255, 255, 255), (1, 1, 1, 255))
        buildings, parks, lots = [], [], []
        for comp in mask.connected_components(minimum=14):    # smaller: plaza / pavement
            outline = comp.outline()
            if len(outline) < 4:
                continue
            poly = [((x + 0.5) * CELL, (y + 0.5) * CELL) for x, y in simplify_ring(outline, 0.9)]
            if len(poly) < 3:
                continue
            count = comp.count()
            if count > 40 and rng.random() < 0.07:
                parks.append(poly)
                continue
            buildings.append(poly)
            pts = (np.array(outline, float) + 0.5) * CELL       # lot lines across the block's long axis
            c = pts.mean(0)
            _, vecs = np.linalg.eigh(np.cov((pts - c).T))
            minor, major = vecs[:, 0], vecs[:, 1]
            a = (pts - c) @ major
            b = (pts - c) @ minor
            step = rng.uniform(12, 22)
            k = a.min() + step
            while k < a.max() - 6:
                lots.append((tuple(c + major * k + minor * b.min()), tuple(c + major * k + minor * b.max())))
                k += step * rng.uniform(0.7, 1.3)
            if b.max() - b.min() > 28:                        # deep blocks: back-to-back lots
                lots.append((tuple(c + major * a.min()), tuple(c + major * a.max())))
        return roads, water, buildings, parks, lots

    # -- rendering -------------------------------------------------------

    def render(self, s):
        """Pre-render the static city at screen scale s, with a baked glow."""
        surf = pygame.Surface((max(1, int(WORLD_W * s)), max(1, int(WORLD_H * s))), 0, 32)
        surf.fill(COL_BG)
        # Surveillance grid, visible on the streets between buildings.
        step = max(4, round(100 * s))
        for gx in range(0, surf.get_width(), step):
            pygame.draw.line(surf, COL_GRIDLINE, (gx, 0), (gx, surf.get_height()))
        for gy in range(0, surf.get_height(), step):
            pygame.draw.line(surf, COL_GRIDLINE, (0, gy), (surf.get_width(), gy))
        lw = min(5, max(3, round(4 * s)))           # chunky street outlines
        self._render_geometry(surf, s, lw)
        self.paint_rubble(surf, s, np.flatnonzero(self.rubble))
        self.rubble_new = []
        self.surface_dirty = False
        # Bake a heavy static phosphor glow into the city layer once.
        w, h = surf.get_size()
        small = pygame.transform.smoothscale(surf, (max(1, w // 6), max(1, h // 6)))
        small.fill((70, 70, 70), special_flags=pygame.BLEND_MULT)
        surf.blit(pygame.transform.smoothscale(small, (w, h)), (0, 0), special_flags=pygame.BLEND_ADD)
        self.surface = surf

    def _render_geometry(self, surf, s, lw):
        roads = [r for r in self.roads if r[2] not in ("bridge", "rail")]
        main = [(w, [(x * s, y * s) for x, y in pts]) for w, pts, _ in roads if w > 4]
        paths = [[(x * s, y * s) for x, y in pts] for w, pts, _ in roads if w <= 4]
        for pts in paths:                             # footpaths: thin grid-white traces
            draw_thick_polyline(surf, COL_GRIDLINE, pts, 1)
        for w, pts in main:                           # roads: chunky cyan kerbs...
            draw_thick_polyline(surf, COL_CYAN, pts, w * s + 2 * lw)
        for w, pts in main:                           # ...with the carriageway cut out
            draw_thick_polyline(surf, COL_BG, pts, w * s)
        for poly in self.water_polys:                 # water: dim blue with wave hatching
            pts = [(x * s, y * s) for x, y in poly]
            if len(pts) >= 3:
                pygame.draw.polygon(surf, mix(COL_BG, COL_BLUE, 0.25), pts)
                pygame.draw.polygon(surf, mix(COL_BG, COL_BLUE, 0.7), pts, max(1, round(s)))
        for w, pts, lyr in self.roads:                # bridges: decks drawn over the water
            if lyr == "bridge":
                pts = [(x * s, y * s) for x, y in pts]
                deck = max(BRIDGE_MIN_CELLS * CELL, w) * s
                draw_thick_polyline(surf, COL_CYAN, pts, deck + 2 * lw)
                draw_thick_polyline(surf, COL_BG, pts, deck)
        for pts in self.rails:                        # railways: two rails and the sleepers
            pts = np.array(pts) * s
            seg = np.diff(pts, axis=0)
            lens = np.hypot(seg[:, 0], seg[:, 1])
            nrm = np.stack([-seg[:, 1], seg[:, 0]], 1) / np.maximum(lens, 1e-6)[:, None]
            nrm = np.vstack([nrm, nrm[-1:]])
            cum = np.concatenate([[0], np.cumsum(lens)])
            for d in np.arange(0, cum[-1], 4 * s):
                i = min(int(np.searchsorted(cum, d, side="right")) - 1, len(seg) - 1)
                q = pts[i] + seg[i] * ((d - cum[i]) / max(lens[i], 1e-6))
                a, b = q + nrm[i] * 3.0 * s, q - nrm[i] * 3.0 * s
                pygame.draw.line(surf, COL_WHITE_DIM, a, b, max(1, round(s)))
            for side in (-1, 1):
                draw_thick_polyline(surf, mix(COL_BG, COL_WHITE, 0.8), [tuple(q) for q in pts + nrm * side * 1.8 * s],
                                    max(1, round(s)))
        bw = max(1, round(1.5 * s))
        for poly in self.park_polys:                  # procedural parks
            pts = [(x * s, y * s) for x, y in poly]
            pygame.draw.polygon(surf, COL_PARK, pts)
            pygame.draw.polygon(surf, COL_GREEN, pts, max(1, round(s)))
        polys = [[(x * s, y * s) for x, y in poly] for poly in self.polys if len(poly) >= 3]
        for pts in polys:
            pygame.draw.polygon(surf, COL_BUILDING, pts)
        if self.lot_lines:                            # lot lines, clipped to the footprints
            lots = pygame.Surface(surf.get_size())
            lots.fill((0, 0, 0))
            for a, b in self.lot_lines:
                pygame.draw.line(lots, COL_LOT_LINE, (a[0] * s, a[1] * s), (b[0] * s, b[1] * s), 1)
            inside = pygame.Surface(surf.get_size())
            inside.fill((0, 0, 0))
            for pts in polys:
                pygame.draw.polygon(inside, (255, 255, 255), pts)
            lots.blit(inside, (0, 0), special_flags=pygame.BLEND_MULT)
            lots.set_colorkey((0, 0, 0))
            surf.blit(lots, (0, 0))
        for pts in polys:
            pygame.draw.polygon(surf, COL_CYAN, pts, bw)


# --------------------------------------------------------------------------
# Dynamic difficulty
# --------------------------------------------------------------------------

class Progression:
    """Tracks results across consecutive matches and sets the next outbreak.

    Evacuating >= 50% of the healthy population raises the threat level
    (>= 75% raises it twice); under 20% lowers it. Each level adds 2.5%
    infected and 400 people, and removes 35 starting CP."""

    MIN_LEVEL, MAX_LEVEL = -3, 6

    def __init__(self, path=None):
        self.path = path
        self.level, self.history = 0, []
        if path and path.exists():
            try:
                d = json.loads(path.read_text())
                self.level, self.history = int(d.get("level", 0)), list(d.get("history", []))
            except (ValueError, OSError):
                pass

    def params(self, level=None):
        lv = self.level if level is None else level
        return dict(
            infected=float(np.clip(INFECTED_FRACTION + 0.025 * lv, 0.05, 0.35)),
            population=int(np.clip(POPULATION + 400 * lv, 3000, 8000)),
            cp=int(np.clip(START_CP - 35 * lv, 175, 560)),
        )

    def record(self, map_name, evac_pct, difficulty="medium"):
        old = self.level
        if evac_pct >= 75:
            self.level += 2
        elif evac_pct >= 50:
            self.level += 1
        elif evac_pct < 20:
            self.level -= 1
        self.level = max(self.MIN_LEVEL, min(self.MAX_LEVEL, self.level))
        self.history.append(dict(map=map_name, evacuated_pct=round(evac_pct, 1), level=old, difficulty=difficulty,
                                 date=datetime.date.today().isoformat()))
        self.history = self.history[-50:]
        if self.path:
            try:
                self.path.write_text(json.dumps(dict(level=self.level, history=self.history), indent=1))
            except OSError:
                pass
        return self.level - old


# --------------------------------------------------------------------------
# Defenses and transient objects
# --------------------------------------------------------------------------

class Unit:
    def __init__(self, uid, kind, x, y, cost, **kw):
        self.id, self.kind, self.x, self.y, self.cost = uid, kind, x, y, cost
        self.spec = UNIT_SPECS[kind]
        self.range = self.spec.get("range", 0)
        self.cooldown = 0.0
        self.hp = self.max_hp = None
        self.cells = None                        # nav cells this unit blocks
        self.zone = None                         # nav cells of an EVAC LZ
        self.aim = None                          # current target (snipers)
        self.order = None                        # move target (infantry)
        self.order_flow = None
        self.order_cell = None
        self.blocked_t = 0.0
        self.dest = None                         # new orbit centre (choppers)
        self.retreating = False
        self.support = 0                         # reinforcing squads nearby
        self.built = True                        # False = blueprint awaiting engineers
        self.progress = 0.0                      # blueprint build progress 0..1
        self.claimed = None                      # engineer id working on this blueprint
        self.job = None                          # blueprint id an engineer is assigned to
        self.job_flow = None
        self.escort = None                       # chopper escort target: ("unit", id) / ("vip", i)
        self.screening = False                   # infantry posted at an LZ (shoots the visibly sick)
        self.drop_t = 0.0                        # >0: still paradropping in (inactive, untouchable)
        self.defended = False                    # barricade has a squad nearby
        self.last_hit = -1.0                     # sim time of the last zombie attack
        self.__dict__.update(kw)


class Effect:
    __slots__ = ("kind", "x", "y", "x2", "y2", "r", "t", "life")

    def __init__(self, kind, x, y, life, x2=0.0, y2=0.0, r=0.0):
        self.kind, self.x, self.y, self.life = kind, x, y, life
        self.x2, self.y2, self.r = x2, y2, r
        self.t = life


class Shell:
    """Artillery shell or airstrike: lands at (x, y) after t seconds."""

    def __init__(self, sx, sy, x, y, t, radius, source):
        self.sx, self.sy, self.x, self.y = sx, sy, x, y
        self.t = self.total = t
        self.radius = radius
        self.source = source                     # "artillery" or "airstrike"


class Bomber:
    def __init__(self, x0, y0, x1, y1, spec):
        self.x0, self.y0 = x0, y0
        self.length = max(1.0, math.hypot(x1 - x0, y1 - y0))
        self.ux, self.uy = (x1 - x0) / self.length, (y1 - y0) / self.length
        self.spec = spec
        self.delay = spec["delay"]
        self.dist = -90.0                        # approach from off-target
        self.next_drop = 0.0

    @property
    def pos(self):
        return self.x0 + self.ux * self.dist, self.y0 + self.uy * self.dist


class Fire:
    """Lingering incendiary pool."""

    def __init__(self, x, y):
        self.x, self.y, self.r = x, y, FIRE_RADIUS
        self.t = FIRE_TIME


class Drone:
    """Lure drone: flies a drawn path, hovers, then detonates."""

    def __init__(self, pts):
        self.pts = pts
        seg = [math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:])]
        self.cum = np.concatenate([[0.0], np.cumsum(seg)])
        self.length = float(self.cum[-1])
        self.dist = 0.0
        self.hover = 0.0

    @property
    def pos(self):
        d = min(self.dist, self.length)
        i = int(np.searchsorted(self.cum, d, side="right") - 1)
        i = min(i, len(self.pts) - 2)
        seg = self.cum[i + 1] - self.cum[i]
        t = 0.0 if seg <= 0 else (d - self.cum[i]) / seg
        (ax, ay), (bx, by) = self.pts[i], self.pts[i + 1]
        return ax + (bx - ax) * t, ay + (by - ay) * t


class Train:
    """A train on one railway: crosses the map end to end at TRAIN_SPEED,
    waits off-map for TRAIN_GAP, then comes back the other way."""

    def __init__(self, pts, rs):
        self.pts = np.asarray(pts, float)
        seg = np.diff(self.pts, axis=0)
        self.cum = np.concatenate([[0.0], np.cumsum(np.hypot(seg[:, 0], seg[:, 1]))])
        self.length = float(self.cum[-1])
        self.dir = 1 if rs.random() < 0.5 else -1
        self.head = None                         # metres along the line (None: off-map)
        self.wait = float(rs.uniform(*TRAIN_FIRST))

    def at(self, d):
        """World points at distances d along the line (clamped to it)."""
        d = np.clip(d, 0, self.length)
        i = np.clip(np.searchsorted(self.cum, d, side="right") - 1, 0, len(self.pts) - 2)
        seg = self.cum[i + 1] - self.cum[i]
        t = np.where(seg > 0, (d - self.cum[i]) / np.maximum(seg, 1e-9), 0)[:, None]
        return self.pts[i] + (self.pts[i + 1] - self.pts[i]) * t

    def body(self, step=3.0):
        """Points along the train from its nose back to its tail."""
        d = self.head - self.dir * np.arange(0, TRAIN_LENGTH + step, step)
        keep = (d >= 0) & (d <= self.length)
        return self.at(d[keep])


# --------------------------------------------------------------------------
# Simulation
# --------------------------------------------------------------------------

class Game:
    def __init__(self, seed=None, progress=None, city=None, mission=None, difficulty="medium"):
        self.progress = progress or Progression()
        self.difficulty = difficulty             # key of DIFFICULTY; applied at every reset
        self.last_result = None
        self.mission = mission                   # story mission dict, or None for Endless
        if city is not None:
            self.set_city(city, mission=mission)
        else:
            self.new_city(seed)

    def new_city(self, seed=None):
        seed = seed if seed is not None else random.randrange(1 << 30)
        self.set_city(City.procedural(seed), seed)

    def set_city(self, city, seed=None, mission=None):
        self.city = city
        self.mission = mission
        self.seed = city.seed if seed is None else seed
        self.reset()

    def new_outbreak(self):
        """Same map, different ground zeros."""
        self.seed = random.randrange(1 << 30)
        self.reset()

    def reset(self):
        """Fresh outbreak on the same map - no geometry is rebuilt."""
        c = self.city
        c.restore()                              # rebuild anything blown up last match
        rs = np.random.default_rng(self.seed)    # identical start every reset
        m = self.mission
        if m:
            base = dict(population=m["population"], infected=m["infected"], cp=m["cp"])
        else:
            base = self.progress.params()
        self.params = apply_difficulty(base, self.difficulty)
        self.goal = scaled_goal(m["goal"], self.difficulty) if m else {}
        diff = DIFFICULTY.get(self.difficulty, DIFFICULTY["medium"])
        P = self.params["population"]
        n_inf = int(P * self.params["infected"])
        streets = c.street_cells
        sx = (streets % GW + 0.5) * CELL
        sy = (streets // GW + 0.5) * CELL

        self.zombie_speed = tuple(v * m.get("zombie_speed_mult", 1.0) for v in ZOMBIE_SPEED) if m else ZOMBIE_SPEED
        # Ground zeros: 1-3 epicentres away from the edges and each other
        # (and, in story missions, away from the VIPs).
        n_gz = m["ground_zeros"] if m else int(rs.integers(GROUND_ZEROS[0], GROUND_ZEROS[1] + 1))
        if m and "gz_region" in m:               # e.g. a ring of avenues, or one river bank
            keep = self.region_mask(sx, sy, m["gz_region"])
        else:
            keep = (sx > 150) & (sx < WORLD_W - 150) & (sy > 150) & (sy < WORLD_H - 150)
        if m and "gz_min_dist" in m:
            keep &= np.hypot(sx - C[0], sy - C[1]) > m["gz_min_dist"]
        inner = streets[keep] if keep.any() else streets
        sep = m.get("gz_sep", 300) if m else 300
        self.ground_zeros = []
        for _ in range(400):
            i = int(rs.choice(inner))
            x, y = cell_center(i)
            if all(math.hypot(x - gx, y - gy) > sep for gx, gy in self.ground_zeros):
                self.ground_zeros.append((x, y))
                if len(self.ground_zeros) == n_gz:
                    break

        # Buildings: per-footprint cell lists, sizes and centres.
        lab = c.bldg_label
        bcells = np.flatnonzero(lab)
        order = np.argsort(lab[bcells], kind="stable")
        bcells = bcells[order]
        blab = lab[bcells]
        size = np.bincount(blab, minlength=c.n_bldg + 1).astype(float)
        first = np.concatenate([[0], np.cumsum(size)[:-1]]).astype(int)    # bcells offset per building
        bx, by = cell_center(bcells)
        bcx = np.bincount(blab, bx, c.n_bldg + 1) / np.maximum(size, 1)
        bcy = np.bincount(blab, by, c.n_bldg + 1) / np.maximum(size, 1)
        real = size > 0
        real[0] = False

        def in_buildings(ids, n):
            """n random cells spread over buildings `ids` in proportion to weights."""
            ids, w = ids
            b = rs.choice(ids, n, p=w / w.sum())
            return bcells[first[b] + (rs.random(n) * size[b]).astype(int)]

        def scatter(cells):
            return np.stack([(cells % GW + rs.random(cells.size)) * CELL,
                             (cells // GW + rs.random(cells.size)) * CELL], 1)

        # Infected: each outbreak has overrun the buildings nearest its
        # epicentre (ZOMBIE_INDOOR start inside them); the rest crowd the
        # streets around it.
        zpos, overrun = [], np.zeros(c.n_bldg + 1, bool)
        shares = np.diff(np.linspace(0, n_inf, len(self.ground_zeros) + 1).astype(int))
        for (gx, gy), n in zip(self.ground_zeros, shares):
            d = np.where(real, np.hypot(bcx - gx, bcy - gy), np.inf)
            own = np.argsort(d)[:ZOMBIE_BUILDINGS]
            own = own[d[own] < 3 * GZ_SPREAD + 40]
            overrun[own] = True
            n_in = int(n * ZOMBIE_INDOOR) if own.size else 0
            d2 = (sx - gx) ** 2 + (sy - gy) ** 2
            w = np.exp(-d2 / (2 * GZ_SPREAD ** 2))
            w[d2 > (3 * GZ_SPREAD) ** 2] = 0
            cells = rs.choice(streets, n - n_in, p=w / w.sum())
            if n_in:
                cells = np.concatenate([cells, in_buildings((own, size[own]), n_in)])
            zpos.append(scatter(cells))
        # Civilians: CIV_INDOOR shelter in buildings away from ground zero,
        # packed unevenly with some buildings left empty; the rest are out on
        # the streets (also away from ground zero).
        far = np.ones(streets.size, bool)
        safe = real & ~overrun
        for gx, gy in self.ground_zeros:
            far &= (sx - gx) ** 2 + (sy - gy) ** 2 > (3 * GZ_SPREAD) ** 2
            safe &= (bcx - gx) ** 2 + (bcy - gy) ** 2 > (3 * GZ_SPREAD) ** 2
        if m and "civ_region" in m:              # e.g. everyone on the north bank
            region = far & self.region_mask(sx, sy, m["civ_region"])
            far = region if region.any() else far
            inside = safe & self.region_mask(bcx, bcy, m["civ_region"])
            safe = inside if inside.any() else safe
        occupied = np.flatnonzero(safe & (rs.random(c.n_bldg + 1) >= EMPTY_BUILDING_SHARE))
        n_civ = P - n_inf
        n_in = int(n_civ * CIV_INDOOR) if occupied.size else 0
        cells = rs.choice(streets[far], n_civ - n_in)
        if n_in:
            crowding = size[occupied] * rs.lognormal(0, 0.8, occupied.size)   # some packed, some not
            cells = np.concatenate([cells, in_buildings((occupied, crowding), n_in)])
        cpos = scatter(rs.permutation(cells))
        self.spawn_indoor = n_in                 # (stats / tests)

        # VIPs: civilians sheltering close to the mission's VIP point.
        n_vip = m.get("vips", 0) if m else 0
        self.vip = np.zeros(P, bool)
        if n_vip:
            near = np.flatnonzero(c.open_flat & c.walk_flat)
            nx_, ny_ = cell_center(near)
            keep = self.region_mask(nx_, ny_, m.get("vip_region", {}))
            near, nx_, ny_ = near[keep], nx_[keep], ny_[keep]
            for gx, gy in self.ground_zeros:        # never start a VIP inside an outbreak
                keep = np.hypot(nx_ - gx, ny_ - gy) > VIP_GZ_CLEARANCE
                near, nx_, ny_ = near[keep], nx_[keep], ny_[keep]
            pick = rs.choice(near, n_vip)
            cpos[:n_vip] = np.stack([(pick % GW + rs.random(n_vip)) * CELL,
                                     (pick // GW + rs.random(n_vip)) * CELL], 1)
            self.vip[:n_vip] = True
        self.vip_total, self.vip_rescued, self.vip_lost = n_vip, 0, 0
        if m and m.get("zombie_speed_mult"):
            self.zombie_speed = tuple(v * m["zombie_speed_mult"] for v in ZOMBIE_SPEED)
        else:
            self.zombie_speed = ZOMBIE_SPEED
        self.infect_rate = INFECT_RATE * (m.get("infect_mult", 1.0) if m else 1.0) * diff["infect_rate"]
        self.lz_rate = LZ_RATE * (m.get("lz_rate_mult", 1.0) if m else 1.0)
        self.barricade_cost = UNIT_SPECS["barricade"]["cost"] * (m.get("barricade_cost_mult", 1) if m else 1)
        self.disabled = set(m.get("disabled", [])) if m else set()
        self.build_zones = {}                    # tool -> flat cell mask it may be placed in
        zones = dict(m.get("build_zones", {})) if m else {}
        if m and "lz_region" in m:
            zones.setdefault("evac", m["lz_region"])
        ax, ay = cell_center(np.arange(N_CELLS))
        for kind, spec in zones.items():
            self.build_zones[kind] = self.region_mask(ax, ay, spec)

        self.pos = np.concatenate([cpos] + zpos)
        self.state = np.full(P, CIV, np.int8)
        self.state[P - n_inf:] = ZOMBIE
        self.speed = rs.uniform(*CIV_SPEED, P) * diff["civ_speed"]
        self.speed[P - n_inf:] = rs.uniform(*self.zombie_speed, n_inf)
        self.vel = np.zeros((P, 2))
        self.angle = rs.uniform(0, 2 * math.pi, P)
        self.busy = np.zeros(P, np.float32)      # feeding / just-turned zombies (can't move)
        self.incubate = np.zeros(P, np.float32)  # >0: bitten civilian, seconds until they turn
        self.panic = np.zeros(P, np.float32)     # >0: armed civilian running after a shootout
        self.ammo = np.zeros(P, np.int8)         # concealed-carry civilians: rounds left
        civ = np.flatnonzero((self.state == CIV) & ~self.vip)
        armed = rs.choice(civ, max(1, int(civ.size * ARMED_FRACTION)), replace=False)
        self.ammo[armed] = rs.integers(1, 3, armed.size)
        self.aim_hold = np.zeros(P, np.float32)
        self.traits = np.zeros(P, np.uint8)
        civ = np.flatnonzero((self.state == CIV) & ~self.vip)
        zom = np.flatnonzero(self.state == ZOMBIE)
        self.swim = bool(c.water.any()) and (m.get("swimmers", True) if m else True)
        if self.swim:
            sw = civ[rs.random(civ.size) < SWIMMER_FRACTION]
            self.traits[sw] |= T_SWIMMER
            self.traits[sw[rs.random(sw.size) < DROWNER_FRACTION]] |= T_DROWNER
        self.traits[civ[rs.random(civ.size) < CLUMSY_FRACTION]] |= T_CLUMSY
        self.traits[zom] |= self.zombie_traits(rs, zom.size)
        self.drown_at = rs.uniform(*DROWN_AFTER, P).astype(np.float32)
        self.swim_t = np.zeros(P, np.float32)    # seconds spent in the water (drowners)
        self.episode = np.zeros(P, np.float32)   # seconds left in a trait episode...
        self.episode_kind = np.zeros(P, np.int8) # ...of this EP_* kind
        self.episode_cd = np.zeros(P, np.float32)
        self.rng = np.random.default_rng()
        self.total_healthy = P - n_inf

        self.obst = np.full(N_CELLS, -1, np.int32)            # cell -> blocking unit
        self.lz_owner = np.full(N_CELLS, -1, np.int32)        # cell -> LZ
        self.contact_owner = np.full(N_CELLS, -1, np.int32)   # cell -> unit zombies there attack
        self.walk = c.walk_flat.copy()                        # zombie walkable mask
        self.checkpoint = np.zeros(N_CELLS, bool)             # civilian slow cells
        self.evac_flow = None
        self.evac_dist = None
        self.swim_flow = self.swim_dist = None   # evac field for swimmers (water costs SWIM_COST)
        self.swim_walk = np.ones(N_CELLS, bool)  # swimmers' walk mask: everywhere...
        self.swim_block = c.indoor_flat | c.water.ravel()   # ...but only enter these on their route
        self.evac_dirty = False
        self.terrain_dirty = False               # buildings destroyed since the last re-path
        self.last_repath = 0.0
        self.assist = np.zeros(N_CELLS, bool)    # checkpoint cells an engineer is manning
        self.init_traffic(rs)
        self.trains = [Train(pts, rs) for pts in c.rails]
        self.train_kills = 0
        self.scent_flow = np.zeros((N_CELLS, 2), np.float32)    # what zombies follow (near + far)
        self.near_scent = np.zeros((N_CELLS, 2), np.float32)    # SCENT_RANGE field
        self.far_flow = np.zeros((N_CELLS, 2), np.float32)      # mission scent_range field
        self.far_job = None                                     # time-sliced far-field search
        self.scent_range = m.get("scent_range") if m else None
        self.flee_flow = np.zeros((N_CELLS, 2), np.float32)
        self.field_timer = 0.0
        self.field_jobs = []                     # time-sliced scent / flee searches in progress
        self.zdens = np.zeros((HH, HW))
        self.cdens = np.zeros((HH, HW))

        self.units = {}
        self.next_id = 0
        self.shells, self.bombers, self.effects = [], [], []
        self.fires, self.drones = [], []
        self.result = None                       # end-of-match outcome
        self.history = []                        # undo stack: (kind, object, CP cost)
        self.cp = float(self.params["cp"])
        self.rescued = self.infected = self.casualties = self.kills = 0
        self.trojans = 0                         # helicopters downed by infected passengers
        self.drowned = 0                         # swimmers lost (not collateral)
        self.drowned_z = 0                       # zombies shoved into the water by their horde
        self.carried_out = 0                     # infected passengers flown out (not rescued)
        self.screened = 0                        # sick civilians shot by squads screening an LZ
        self.sheltered = 0
        self.phase = "setup"
        self.paused = False
        self.time_scale = 1
        self.accum = 0.0
        self.run_time = 0.0
        self.quiet = 0.0
        self.last_sig = None
        self.message, self.message_t = "", 0.0
        self.sound_events = []                   # sound event names for the App to play

    def init_traffic(self, rs):
        """Every car starts parked. CAR_OCCUPIED of them have 1-3 people
        already inside (taken from the street crowd) and pull out once the
        clock has run CAR_START seconds; a few street civilians sprint for
        the nearest empty car (RUNNER_FRACTION) and drive off once aboard.
        Each car makes for a map edge it can reach by road (none: abandoned,
        already a wreck)."""
        cells = self.city.cars
        n, P = cells.size, self.state.size
        flows, dists = self.city.car_routes() if n else (None, None)
        self.car_pos = np.stack(cell_center(cells), 1).astype(float) if n else np.zeros((0, 2))
        edge = rs.integers(0, 4, n)
        if n:
            reach = (dists[:, cells] < FAR).T                   # (n, 4)
            bad = ~reach[np.arange(n), edge]
            edge[bad] = np.where(reach[bad].any(1), reach[bad].argmax(1), -1)
        self.car_edge = edge
        self.car_state = np.where(edge >= 0, CAR_PARKED, CAR_WRECK).astype(np.int8)
        self.car_wait = np.full(n, np.inf)        # parked until someone gets in
        self.car_speed = rs.uniform(*CAR_SPEED, n)
        self.car_heading = rs.uniform(0, 2 * math.pi, n)
        if n:
            f = flows[np.maximum(edge, 0), cells]
            has = (f != 0).any(1) & (edge >= 0)
            self.car_heading[has] = np.arctan2(f[has, 1], f[has, 0])
        self.car_stuck = np.zeros(n)
        self.car_jam = np.zeros(n)
        self.car_uturn = np.zeros(n)
        self.car_claim = np.full(n, -1, np.int64)     # runner heading for this car
        self.in_car = np.full(P, -1, np.int64)        # car each IN_CAR agent rides in
        self.runner_car = np.full(P, -1, np.int64)    # car each runner is sprinting for
        self.car_slow = np.zeros(N_CELLS, bool)
        self.cars_escaped = self.car_crashes = self.roadkill = self.car_evacuated = 0
        if n:
            cx, cy = cells_of(self.pos)
            outdoor = np.flatnonzero((self.state == CIV) & ~self.vip & (self.ammo == 0)
                                     & ~self.city.indoor_flat[cy * GW + cx])
            outdoor = rs.permutation(outdoor)
            usable = np.flatnonzero(self.car_state == CAR_PARKED)
            full = usable[rs.random(usable.size) < CAR_OCCUPIED]
            seats = np.repeat(full, rs.integers(CAR_RIDERS[0], CAR_RIDERS[1] + 1, full.size))
            seats = seats[:outdoor.size]
            riders, outdoor = outdoor[:seats.size], outdoor[seats.size:]
            self.state[riders] = IN_CAR
            self.in_car[riders] = seats
            self.pos[riders] = self.car_pos[seats]
            self.car_wait[np.unique(seats)] = rs.uniform(*CAR_START, np.unique(seats).size)
            empty = np.setdiff1d(usable, seats)
            runners = outdoor[:int(outdoor.size * RUNNER_FRACTION)]
            if runners.size and empty.size:
                d = np.hypot(self.pos[runners, None, 0] - self.car_pos[None, empty, 0],
                             self.pos[runners, None, 1] - self.car_pos[None, empty, 1])
                for i in np.argsort(d.min(1)):                  # closest pairs first, one car each
                    j = int(np.argmin(d[i]))
                    if d[i, j] <= RUNNER_RANGE:
                        self.runner_car[runners[i]] = empty[j]
                        self.car_claim[empty[j]] = runners[i]
                        d[:, j] = np.inf
        self.update_car_slow()

    def update_car_slow(self):
        """Parked cars and wrecks slow anyone crossing their cell. (Called
        whenever a car changes state: also bumps car_version for the
        renderer's cached layer of stationary cars.)"""
        self.car_version = getattr(self, "car_version", 0) + 1
        self.car_slow[:] = False
        still = np.isin(self.car_state, (CAR_PARKED, CAR_WRECK, CAR_BURNT))
        if still.any():
            cx, cy = cells_of(self.car_pos[still])
            self.car_slow[cy * GW + cx] = True

    def board_runners(self):
        """Runners who reach their car get in (and it leaves); runners who
        die, turn or lose their car give up."""
        run = np.flatnonzero(self.runner_car >= 0)
        if not run.size:
            return
        k = self.runner_car[run]
        lost = (self.state[run] != CIV) | (self.car_state[k] != CAR_PARKED)
        self.car_claim[k[lost]] = -1
        self.runner_car[run[lost]] = -1
        run, k = run[~lost], k[~lost]
        d = np.hypot(*(self.pos[run] - self.car_pos[k]).T)
        aboard = d < BOARD_RANGE
        if aboard.any():
            r, k = run[aboard], k[aboard]
            self.state[r] = IN_CAR
            self.in_car[r] = k
            self.runner_car[r] = -1
            self.car_claim[k] = -1
            self.car_wait[k] = 0.0               # drive off right away

    def unload(self, cars, die=0.0):
        """Everyone in `cars` gets out where the car is (some may die)."""
        riders = np.flatnonzero((self.state == IN_CAR) & np.isin(self.in_car, cars))
        if not riders.size:
            return riders
        self.state[riders] = CIV
        self.pos[riders] = self.car_pos[self.in_car[riders]] + self.rng.uniform(-2, 2, (riders.size, 2))
        np.clip(self.pos[riders, 0], 0.01, WORLD_W - 0.01, out=self.pos[riders, 0])
        np.clip(self.pos[riders, 1], 0.01, WORLD_H - 0.01, out=self.pos[riders, 1])
        self.in_car[riders] = -1
        if die:
            self.kill(riders[self.rng.random(riders.size) < die], roadkill=True)
        return riders

    def update_traffic(self, dt, crowd, zcrowd, ci):
        """Drive (look-ahead steering, queues, U-turns), run people over,
        crash; riders who leave the map are evacuated. Vectorised."""
        st = self.car_state
        if not st.size:
            return
        before = st.copy()
        self.board_runners()
        parked = st == CAR_PARKED
        self.car_wait[parked] -= dt
        st[parked & (self.car_wait <= 0)] = CAR_DRIVING
        np.maximum(self.car_uturn - dt, 0, out=self.car_uturn)
        drive = np.flatnonzero(st == CAR_DRIVING)
        if drive.size:
            flows, dists = self.city.car_routes()
            p = self.car_pos[drive]
            cx, cy = cells_of(p)
            cell = cy * GW + cx
            e = self.car_edge[drive]
            tx, ty = cx.copy(), cy.copy()
            for _ in range(CAR_LOOKAHEAD):               # follow the route a few cells ahead...
                f = flows[e, ty * GW + tx]
                tx = np.clip(tx + np.rint(f[:, 0]).astype(int), 0, GW - 1)
                ty = np.clip(ty + np.rint(f[:, 1]).astype(int), 0, GH - 1)
            aim = unit(np.stack([(tx + 0.5) * CELL, (ty + 0.5) * CELL], 1) - p)
            aim = aim * 4 * CELL + np.stack([-aim[:, 1], aim[:, 0]], 1) * CAR_LANE   # ...keeping right
            has = (flows[e, cell] != 0).any(1)
            h = self.car_heading[drive]
            turn = (np.arctan2(aim[:, 1], aim[:, 0]) - h + math.pi) % (2 * math.pi) - math.pi
            h = np.where(has, h + np.clip(turn, -CAR_TURN * dt, CAR_TURN * dt), h)
            d = np.stack([np.cos(h), np.sin(h)], 1)
            ax, ay = cells_of(p + d * CELL)
            ahead = ay * GW + ax
            bx, by = cells_of(p + d * 2 * CELL)
            ahead2 = by * GW + bx
            # Turn back from an overrun road: switch to a route out the other way.
            over = np.flatnonzero((zcrowd[ahead2] >= CAR_OVERRUN) & (self.car_uturn[drive] <= 0))
            if over.size:
                back = np.stack([(flows[s, cell[over]] * d[over]).sum(1) for s in range(4)], 1)
                back[(dists[:, cell[over]] >= FAR).T] = 1.0
                best = back.argmin(1)
                ok = back[np.arange(over.size), best] < -0.2
                k = over[ok]
                self.car_edge[drive[k]] = best[ok]
                h[k] += math.pi
                d[k] *= -1
                self.car_uturn[drive[k]] = CAR_UTURN_COOLDOWN
                ahead[k], ahead2[k] = cell[k], cell[k]
                if k.size:
                    self.sound("tire_screech")
            self.car_heading[drive] = h
            # Queues: brake for a moving car ahead; squeeze past parked cars
            # and wrecks at a crawl.
            occ = np.bincount(cell, minlength=N_CELLS)
            near_car = occ[ahead] - (ahead == cell) > 0
            next_car = occ[ahead2] - (ahead2 == cell) > 0
            squeeze = self.car_slow[ahead] & ~near_car
            everyone, zeds = crowd[ahead], zcrowd[ahead]
            people = everyone - zeds
            crawl = people >= CAR_SLOWDOWN_CROWD
            if crawl.any():
                self.sound("car_horn")
            boost = (zeds > 0) & (people < 1)            # nothing but zombies ahead: floor it
            speed = self.car_speed[drive] * np.where(crawl, CAR_CRAWL, np.where(boost, CAR_RAM_BOOST, 1.0))
            speed = np.where(near_car, 0.0, np.where(next_car | squeeze, speed * 0.4, speed))
            new = p + d * (speed * dt)[:, None]
            out = (new[:, 0] < 0) | (new[:, 0] >= WORLD_W) | (new[:, 1] < 0) | (new[:, 1] >= WORLD_H)
            nx, ny = cells_of(new)
            road = self.city.open_flat[ny * GW + nx] | out              # roads, pavements, plazas
            blocked = ~road & (flows[e, cell] != 0).any(1)              # cut the corner: face the route
            want = flows[e, cell]
            self.car_heading[drive[blocked]] = np.arctan2(want[blocked, 1], want[blocked, 0])
            crash = ((everyone >= CAR_CRASH_CROWD) | (self.obst[ahead] >= 0)) & ~out & ~near_car
            moved = road & ~crash & (speed > 0)
            self.car_pos[drive[moved]] = new[moved]
            self.car_jam[drive] = np.where(near_car & ~crash, self.car_jam[drive] + dt, 0.0)
            self.car_stuck[drive] = np.where(~road & ~crash, self.car_stuck[drive] + dt, 0.0)
            gone = drive[moved & out]
            if gone.size:                                 # off the map: everyone aboard is safe
                st[gone] = CAR_GONE
                self.cars_escaped += gone.size
                self.evacuate_by_car(gone)
            quit_ = drive[(self.car_stuck[drive] > CAR_STUCK_TIME) | (self.car_jam[drive] > CAR_JAM_ABANDON)]
            if quit_.size:                                # stuck or gridlocked: they get out and walk
                st[quit_] = CAR_WRECK
                self.unload(quit_)
            for k, c in zip(drive[crash], ahead[crash]):
                self.crash_car(int(k), int(c))
            fast = drive[moved & ~out & (speed >= self.car_speed[drive] * 0.99)]
            self.run_over(fast, dt, ci)
        riders = np.flatnonzero(self.state == IN_CAR)    # passengers ride along
        self.pos[riders] = self.car_pos[self.in_car[riders]]
        if (st != before).any():                         # parked cars and wrecks never move
            self.update_car_slow()

    def evacuate_by_car(self, cars):
        """Riders of cars that drove off the map count as evacuated (the
        infected among them as carried out)."""
        riders = np.flatnonzero((self.state == IN_CAR) & np.isin(self.in_car, cars))
        sick = self.incubate[riders] > 0
        healthy = riders[~sick]
        self.state[riders] = RESCUED
        self.incubate[riders] = 0
        self.in_car[riders] = -1
        self.rescued += healthy.size
        self.car_evacuated += healthy.size
        self.carried_out += int(sick.sum())
        self.cp += healthy.size * RESCUE_BONUS

    def run_over(self, fast, dt, ci):
        """Anyone (civilian or zombie) within CAR_HIT_RADIUS of a car at
        full speed. Per-cell lookup: each agent is only tested against the
        car whose 3x3 neighbourhood it stands in."""
        if not fast.size:
            return
        car_at = np.full(N_CELLS, -1, np.int64)
        cx, cy = cells_of(self.car_pos[fast])
        base = cy * GW + cx
        for off in NEIGHBOURS9:
            car_at[np.clip(base + off, 0, N_CELLS - 1)] = fast
        cand = np.flatnonzero((car_at[ci] >= 0) & (self.state <= ZOMBIE))
        if not cand.size:
            return
        k = car_at[ci[cand]]
        d2 = ((self.pos[cand] - self.car_pos[k]) ** 2).sum(1)
        hit = cand[d2 < CAR_HIT_RADIUS ** 2]
        hit = hit[self.rng.random(hit.size) < 1 - math.exp(-CAR_HIT_RATE * dt)]
        if hit.size:
            self.kill(hit, roadkill=True)

    def crash_car(self, k, cell):
        """Car k ploughs into a crowd or into the unit holding `cell`: it is
        a wreck now, its riders spill out, people around it die, and a unit
        it rams takes damage."""
        self.car_state[k] = CAR_WRECK
        self.car_crashes += 1
        self.unload([k])
        x, y = self.car_pos[k]
        alive = np.flatnonzero(self.state <= ZOMBIE)
        p = self.pos[alive]
        near = alive[(p[:, 0] - x) ** 2 + (p[:, 1] - y) ** 2 < CAR_CRASH_RADIUS ** 2]
        self.kill(near[self.rng.random(near.size) < CAR_CRASH_KILL], roadkill=True)
        u = self.units.get(int(self.obst[cell]))
        if u is not None and u.hp is not None:
            u.hp -= CAR_RAM_DAMAGE
            u.last_hit = self.run_time
            if u.hp <= 0:
                self.remove_unit(u)
                self.effects.append(Effect("ring", u.x, u.y, 0.9, r=25))
                self.flash_message(f"{u.spec['name']} wrecked by a car!")
                self.sound("unit_destroyed")
        self.effects.append(Effect("ring", x, y, 0.6, r=8))
        self.sound("tire_screech", "car_crash")

    def update_trains(self, dt, ci):
        """Move each train; whatever is on the track in front of it - people,
        zombies, cars, units, barricades - is destroyed."""
        for tr in self.trains:
            if tr.head is None:
                tr.wait -= dt
                if tr.wait > 0:
                    continue
                tr.head = 0.0 if tr.dir > 0 else tr.length
                self.sound("train_horn")
            tr.head += tr.dir * TRAIN_SPEED * dt
            tail = tr.head - tr.dir * TRAIN_LENGTH
            if (tr.dir > 0 and tail > tr.length) or (tr.dir < 0 and tail < 0):   # left the map
                tr.head, tr.dir, tr.wait = None, -tr.dir, float(self.rng.uniform(*TRAIN_GAP))
                continue
            body = tr.body()
            if not len(body):
                continue
            bx, by = cells_of(body)
            hit_cells = np.zeros(N_CELLS, bool)
            hit_cells[np.clip((by * GW + bx)[:, None] + NEIGHBOURS9, 0, N_CELLS - 1)] = True

            def touching(xy):
                d2 = ((xy[:, None, :] - body[None, :, :]) ** 2).sum(-1).min(1)
                return d2 < TRAIN_HALF_WIDTH ** 2

            cand = np.flatnonzero(hit_cells[ci] & (self.state <= ZOMBIE))
            if cand.size:
                hit = cand[touching(self.pos[cand])]
                if hit.size:
                    self.train_kills += hit.size
                    self.kill(hit, roadkill=True)
            live = np.flatnonzero(np.isin(self.car_state, (CAR_PARKED, CAR_DRIVING, CAR_WRECK)))
            if live.size:
                lx, ly = cells_of(self.car_pos[live])
                live = live[hit_cells[ly * GW + lx]]
                smashed = live[touching(self.car_pos[live])] if live.size else live
                for k in smashed:                # flattened, riders and all
                    self.unload([k], die=1.0)
                    self.car_state[k] = CAR_WRECK
                    self.effects.append(Effect("ring", *self.car_pos[k], 0.6, r=8))
                    self.sound("car_crash")
                if smashed.size:
                    self.update_car_slow()
            for u in list(self.units.values()):
                if u.drop_t > 0 or u.kind == "chopper":
                    continue
                pts = np.array([[u.x, u.y]] if u.cells is None or u.kind != "barricade"
                               else np.stack(cell_center(u.cells), 1))
                if touching(pts).any():
                    self.remove_unit(u)
                    self.effects.append(Effect("ring", u.x, u.y, 0.9, r=25))
                    self.flash_message(f"{u.spec['name']} hit by a train!")
                    self.sound("unit_destroyed")

    def region_mask(self, xs, ys, spec):
        """Boolean mask of world points inside a mission region spec."""
        xs, ys = np.asarray(xs, float), np.asarray(ys, float)
        ok = np.ones(xs.shape, bool)
        for key, op in (("x_min", np.greater_equal), ("x_max", np.less_equal),
                        ("y_min", np.greater_equal), ("y_max", np.less_equal)):
            if key in spec:
                ok &= op(xs if key[0] == "x" else ys, spec[key])
        r = np.hypot(xs - C[0], ys - C[1])
        if "r_min" in spec:
            ok &= r >= spec["r_min"]
        if "r_max" in spec:
            ok &= r <= spec["r_max"]
        side = spec.get("side")
        if side:
            ok &= self.water_side(xs, ys, side)
        polys = spec.get("polys") or ([spec["poly"]] if "poly" in spec else [])
        if polys:
            surf = pygame.Surface((GW, GH))
            surf.fill((0, 0, 0))
            for poly in polys:
                pygame.draw.polygon(surf, (255, 255, 255), [(x / CELL, y / CELL) for x, y in poly])
            inside = (pygame.surfarray.array_red(surf).T > 0).ravel()
            cx = np.clip((xs / CELL).astype(int), 0, GW - 1)
            cy = np.clip((ys / CELL).astype(int), 0, GH - 1)
            ok &= inside[cy * GW + cx]
        return ok

    def in_zone(self, kind, cells):
        """True where a mission build zone allows `kind` at these cells."""
        zone = self.build_zones.get(kind)
        return np.ones(np.shape(cells), bool) if zone is None else zone[cells]

    def zone_refused(self, kind):
        name = "LZs" if kind == "evac" else UNIT_SPECS[kind]["name"].title() + "s"
        self.flash_message(f"{name} only inside the marked area")

    def water_side(self, xs, ys, side, margin=15):
        """Which bank of the map's water a point is on: compares each point
        with the mean water position in its column (north/south) or row
        (east/west). Falls back to the map middle if there is no water."""
        water = self.city.main_water()
        if side in ("north", "south"):
            cols = water.any(0)
            mean = np.where(cols, (water * np.arange(GH)[:, None]).sum(0) / np.maximum(water.sum(0), 1), np.nan)
            fill = np.nanmean(mean) if cols.any() else GH / 2
            line = (np.where(np.isnan(mean), fill, mean) + 0.5) * CELL
            ref = line[np.clip((xs / CELL).astype(int), 0, GW - 1)]
            return ys < ref - margin if side == "north" else ys > ref + margin
        rows = water.any(1)
        mean = np.where(rows, (water * np.arange(GW)[None, :]).sum(1) / np.maximum(water.sum(1), 1), np.nan)
        fill = np.nanmean(mean) if rows.any() else GW / 2
        line = (np.where(np.isnan(mean), fill, mean) + 0.5) * CELL
        ref = line[np.clip((ys / CELL).astype(int), 0, GH - 1)]
        return xs < ref - margin if side == "west" else xs > ref + margin

    # ---- player actions -------------------------------------------------

    def flash_message(self, text, t=2.5, sound="ui_alert"):
        self.message, self.message_t = text, t
        self.sound(sound)

    def sound(self, *events):
        """Queue sound events (SOUNDS keys); the App drains them each frame."""
        if len(self.sound_events) < 64:
            self.sound_events.extend(events)

    @property
    def lzs(self):
        return [u for u in self.units.values() if u.kind == "evac"]

    def start(self):
        if self.phase == "setup":
            self.phase = "running"

    def set_speed(self, mult):
        self.sound("ui_speed")
        self.time_scale = mult
        self.paused = False
        self.start()

    def toggle_pause(self):
        if self.phase == "setup":
            self.start()
        elif self.phase == "running":
            self.paused = not self.paused
            self.sound("ui_pause" if self.paused else "ui_resume")

    def add_unit(self, kind, x, y, cost, **kw):
        u = Unit(self.next_id, kind, x, y, cost, **kw)
        self.units[u.id] = u
        self.next_id += 1
        self.cp -= cost
        self.history.append(("unit", u, cost))
        if kind in DROP_KINDS and self.phase != "setup":
            u.drop_t = DROP_TIME                 # paradrop: registers when it lands
            self.sound("paradrop")
            return u
        if kind == "evac":
            self.sound("vo_lz_established")
        self.register(u)
        return u

    def register(self, u):
        if u.cells is not None:
            self.obst[u.cells] = u.id
            self.eject_zombies(u.cells)
            self.refresh_obstacles()
        if u.zone is not None:
            self.lz_owner[u.zone] = u.id
            self.evac_dirty = True
        if u.hp is not None:
            self.rebuild_contacts()

    def land(self, u):
        """Paradrop complete: claim the ground as it is now."""
        u.drop_t = 0.0
        ci = cell_index(u.x, u.y)
        if u.kind == "infantry":
            u.cells = self.squad_cells(ci, u.id)
        elif u.kind == "evac":
            u.zone = self.lz_cells(u.x, u.y)
        self.register(u)
        self.effects.append(Effect("ring", u.x, u.y, 0.5, r=10))
        self.sound("paradrop_land", *(["vo_lz_established"] if u.kind == "evac" else []))

    def refresh_obstacles(self):
        """Barricades and troops are hard walls for zombies but only slow
        checkpoints for civilians (cheap: no re-pathing needed)."""
        self.walk = (self.obst < 0) & self.city.walk_flat
        self.checkpoint = self.obst >= 0

    def eject_zombies(self, cells):
        """Shove zombies caught under a new barricade / squad to the nearest
        free neighbouring cell so the wall can't be walked along."""
        free_mask = (self.obst < 0) & self.city.walk_flat
        blocked = np.zeros(N_CELLS, bool)
        blocked[cells] = True
        zx, zy = cells_of(self.pos)
        zc = zy * GW + zx
        for i in np.flatnonzero((self.state == ZOMBIE) & blocked[zc]):
            cx, cy = zc[i] % GW, zc[i] // GW
            for r in (1, 2, 3):
                ring = [(cy + dy) * GW + cx + dx for dy in range(-r, r + 1) for dx in range(-r, r + 1)
                        if 0 <= cx + dx < GW and 0 <= cy + dy < GH]
                free = [j for j in ring if free_mask[j]]
                if free:
                    j = min(free, key=lambda j: (j % GW - cx) ** 2 + (j // GW - cy) ** 2)
                    self.pos[i] = cell_center(j)
                    break

    def contact_cells(self, u):
        """Cells (street or indoor) from which zombies can attack unit u."""
        if u.kind == "evac":
            return u.zone
        if u.cells is not None:                  # barricade / infantry: ring around it
            m = np.zeros(N_CELLS, bool)
            m[u.cells] = True
            ring = box3(m.reshape(GH, GW).astype(np.int8)).ravel() > 0
            return np.flatnonzero(ring & ~m)
        return disc_cells(u.x, u.y, CONTACT_RADIUS)

    def rebuild_contacts(self):
        self.contact_owner[:] = -1
        for u in self.units.values():
            if u.hp is not None and u.built and u.drop_t <= 0:
                self.contact_owner[self.contact_cells(u)] = u.id

    def live_build(self):
        """After the clock starts, static defences go down as blueprints that
        combat engineers have to walk to and build."""
        return self.phase != "setup"

    def blueprint_placed(self):
        if not any(u.kind == "engineer" for u in self.units.values()):
            self.flash_message("Blueprint placed - deploy ENGINEERS to build it", 4)

    def activate(self, u):
        """A blueprint is finished: it becomes a live defence."""
        u.built, u.progress, u.claimed = True, 1.0, None
        self.sound("barricade_place" if u.kind == "barricade" else "mine_arm")
        if u.kind == "barricade":
            cells = u.plan_cells
            cells = cells[(self.obst[cells] < 0) & (self.lz_owner[cells] < 0)]
            u.cells = cells
            self.obst[cells] = u.id
            self.eject_zombies(cells)
            self.refresh_obstacles()
            self.rebuild_contacts()
        self.effects.append(Effect("ring", *u.site, 0.6, r=14))

    def seal_extension(self, x, y, ux, uy):
        """From a barricade end, reach across open street (up to SEAL_SNAP) to
        the next building, then carry on through it to its far edge (up to
        SEAL_MAX) so zombies can't slip around through the building. Returns
        the extended end point, or None if there's no building to tie into."""
        indoor, walk = self.city.indoor_flat, self.city.walk_flat
        step, t = CELL / 2, 0.0
        while True:
            px, py = x + ux * t, y + uy * t
            if t > SEAL_SNAP or not (0 <= px < WORLD_W and 0 <= py < WORLD_H):
                return None                      # open ground: nothing to tie into
            c = cell_index(px, py)
            if not walk[c]:
                return None                      # water already blocks
            if indoor[c]:
                break
            t += step
        limit = t + SEAL_MAX
        while t < limit:
            px, py = x + ux * (t + step), y + uy * (t + step)
            if not (0 <= px < WORLD_W and 0 <= py < WORLD_H) or not indoor[cell_index(px, py)]:
                break                            # reached the building's far side
            t += step
        return x + ux * t, y + uy * t

    def barricade_line(self, x0, y0, x1, y1):
        """Cells a barricade from (x0, y0) to (x1, y1) would occupy:
        `placed` - open street (built and charged), `seal` - building cells
        under the line and through the buildings at either end (blocked for
        free), `skipped` - cells already taken by LZs / other units.
        Also returns the full extent of the sealed line."""
        L = math.hypot(x1 - x0, y1 - y0)
        ux, uy = ((x1 - x0) / L, (y1 - y0) / L) if L > 1e-6 else (1.0, 0.0)
        a = self.seal_extension(x0, y0, -ux, -uy) or (x0, y0)
        b = self.seal_extension(x1, y1, ux, uy) or (x1, y1)
        cells = np.unique(segment_cells(*a, *b, CELL * 1.05))
        free = (self.lz_owner[cells] < 0) & (self.obst[cells] < 0) & self.city.walk_flat[cells]
        placed = cells[free & self.city.open_flat[cells]]
        seal = cells[free & self.city.indoor_flat[cells]]
        skipped = cells[~free & self.city.walk_flat[cells]]
        return placed, seal, skipped, (a, b)

    def barricade_cells(self, x0, y0, x1, y1):
        return self.barricade_line(x0, y0, x1, y1)[0]

    def standby(self, kind):
        """Seconds until a time-locked tool unlocks (0 = available)."""
        return max(0.0, UNLOCK_TIMES.get(kind, 0) - self.run_time)

    def tool_locked(self, kind):
        wait = self.standby(kind)
        if wait > 0 and kind not in self.disabled:
            self.flash_message(f"{UNIT_SPECS[kind]['name']} on standby - {math.ceil(wait)}s")
            self.sound("ui_tool_locked")
            return True
        if kind in self.disabled:
            self.flash_message(f"{UNIT_SPECS[kind]['name']} not authorised in this mission")
            return True
        return False

    def deploy_line(self, kind, x0, y0, x1, y1):
        if self.phase == "over" or self.tool_locked(kind):
            return
        spec = UNIT_SPECS[kind]
        x1, y1 = clamp_segment(x0, y0, x1, y1, spec["max_len"])
        if kind == "barricade":
            placed, seal, _, (a, b) = self.barricade_line(x0, y0, x1, y1)
            if not placed.size:
                return self.flash_message("No open street under that line")
            if not self.in_zone(kind, placed).all():
                return self.zone_refused(kind)
            cost = int(placed.size * self.barricade_cost)   # sealed building cells are free
            if cost > self.cp:
                return self.flash_message(f"Need {cost} CP")
            hp = spec["hp"] + spec["hp_per_cell"] * placed.size
            cells = np.concatenate([placed, seal])
            mid = placed[np.argmin(np.hypot(*(np.stack(cell_center(placed)) -
                                              np.array([[(x0 + x1) / 2], [(y0 + y1) / 2]]))))]
            site = cell_center(mid)
            if self.live_build():
                self.add_unit(kind, x0, y0, cost, x2=x1, y2=y1, ends=(a, b), street=placed, seal=seal,
                              plan_cells=cells, hp=hp, max_hp=hp, built=False, site=site)
                self.blueprint_placed()
            else:
                self.add_unit(kind, x0, y0, cost, x2=x1, y2=y1, ends=(a, b), street=placed, seal=seal,
                              plan_cells=cells, cells=cells, hp=hp, max_hp=hp, site=site)
                self.sound("barricade_place")
        else:
            if math.hypot(x1 - x0, y1 - y0) < 20:
                return self.flash_message("Drag a longer flight path")
            if not self.in_zone(kind, cell_index(x0, y0)):
                return self.zone_refused(kind)
            if spec["cost"] > self.cp:
                return self.flash_message(f"Need {spec['cost']} CP")
            self.cp -= spec["cost"]
            self.bombers.append(Bomber(x0, y0, x1, y1, spec))
            self.sound("bomber_flyby")
            self.history.append(("bomber", self.bombers[-1], spec["cost"]))

    def lz_cells(self, x, y):
        cells = disc_cells(x, y, LZ_RADIUS)
        return cells[self.city.open_flat[cells] & (self.obst[cells] < 0) & (self.lz_owner[cells] < 0)]

    def squad_cells(self, ci, uid=-1):
        cx, cy = ci % GW, ci // GW
        cells = np.array([(cy + dy) * GW + cx + dx for dy in (-1, 0, 1) for dx in (-1, 0, 1)
                          if 0 <= cx + dx < GW and 0 <= cy + dy < GH])
        return cells[(self.lz_owner[cells] < 0) & ((self.obst[cells] < 0) | (self.obst[cells] == uid))]

    def deploy_point(self, kind, x, y):
        if self.phase == "over" or self.tool_locked(kind):
            return
        spec = UNIT_SPECS[kind]
        cost = spec["cost"]
        if cost > self.cp:
            return self.flash_message(f"Need {cost} CP")
        ci = cell_index(x, y)
        if not self.city.walk_flat[ci] and kind not in ("chopper", "airstrike"):
            return self.flash_message("Can't deploy on water")
        if not self.in_zone(kind, ci):
            return self.zone_refused(kind)
        if kind == "evac":
            zone = self.lz_cells(x, y)
            if not self.city.open_flat[ci] or zone.size < LZ_MIN_CELLS:
                return self.flash_message("LZ needs open ground")
            self.add_unit(kind, x, y, cost, zone=zone, credit=0.0, lift_t=0.0, load=[], offline=0.0,
                          hp=spec["hp"], max_hp=spec["hp"])
        elif kind == "airstrike":
            self.cp -= cost
            self.shells.append(Shell(x, y - 400, x, y, spec["delay"], spec["blast"], "airstrike"))
            self.sound("airstrike_jet")
            self.history.append(("shell", self.shells[-1], cost))
        elif kind == "infantry":
            if self.obst[ci] >= 0 or self.lz_owner[ci] >= 0:
                return self.flash_message("Square is occupied")
            x, y = cell_center(ci)
            self.add_unit(kind, x, y, cost, cells=self.squad_cells(ci), hp=spec["hp"], max_hp=spec["hp"])
        elif kind == "chopper":
            self.add_unit(kind, x, y, cost, angle=random.uniform(0, 2 * math.pi), px=x, py=y)
        elif kind == "mine":
            live = self.live_build()
            self.add_unit(kind, x, y, cost, built=not live, site=(x, y))
            if live:
                self.blueprint_placed()
        elif kind == "engineer":
            self.add_unit(kind, x, y, cost, hp=spec["hp"], max_hp=spec["hp"], state="idle")
        else:
            roof = bool(self.city.indoor_flat[ci])
            u = self.add_unit(kind, x, y, cost, hp=spec["hp"], max_hp=spec["hp"], rooftop=roof)
            if roof:
                u.range = spec["range"] * ROOFTOP_RANGE

    def deploy_path(self, kind, pts):
        """Lure drone along a hand-drawn route (clipped to DRONE_MAX_PATH)."""
        if self.phase == "over" or self.tool_locked(kind):
            return
        spec = UNIT_SPECS[kind]
        route, total = [pts[0]], 0.0
        for p in pts[1:]:
            d = math.hypot(p[0] - route[-1][0], p[1] - route[-1][1])
            if total + d > DRONE_MAX_PATH:
                break
            route.append(p)
            total += d
        if total < 20:
            return self.flash_message("Drag a longer flight path")
        if not self.in_zone(kind, cell_index(*route[0])):
            return self.zone_refused(kind)
        if spec["cost"] > self.cp:
            return self.flash_message(f"Need {spec['cost']} CP")
        self.cp -= spec["cost"]
        self.drones.append(Drone(route))
        self.sound("drone_launch")
        self.history.append(("drone", self.drones[-1], spec["cost"]))

    def escort_target_at(self, x, y):
        """A friendly unit or VIP under the cursor that a chopper can escort."""
        best, bd = None, 12.0
        for u in self.units.values():
            if u.kind in ESCORTABLE and u.built:
                d = math.hypot(x - u.x, y - u.y)
                if d < bd:
                    best, bd = ("unit", u.id), d
        vips = np.flatnonzero(self.vip & (self.state == CIV))
        if vips.size:
            d = np.hypot(self.pos[vips, 0] - x, self.pos[vips, 1] - y)
            j = int(np.argmin(d))
            if d[j] < min(bd, 10.0):
                best = ("vip", int(vips[j]))
        return best

    def escort_pos(self, target):
        kind, ref = target
        if kind == "unit":
            u = self.units.get(ref)
            return (u.x, u.y) if u is not None else None
        return tuple(self.pos[ref]) if self.state[ref] == CIV else None

    def set_escort(self, choppers, target):
        for u in choppers:
            u.escort, u.dest = target, None
        if choppers:
            self.flash_message("Chopper escorting" if len(choppers) == 1 else "Choppers escorting")

    def movables(self):
        return [u for u in self.units.values() if u.kind in MOVABLE]

    def movable_at(self, x, y, radius=12):
        best, bd = None, radius
        for u in self.movables():
            ux, uy = (u.px, u.py) if u.kind == "chopper" else (u.x, u.y)
            d = min(math.hypot(x - ux, y - uy), math.hypot(x - u.x, y - u.y))
            if d < bd:
                best, bd = u, d
        return best

    def formation_slots(self, x, y, n, movers):
        """n spots as close as possible to (x, y), FORMATION_SPACING apart, on
        walkable cells not held by other units (open ground preferred)."""
        ids = {u.id for u in movers}
        cells = disc_cells(x, y, 40 + 12 * n)
        free = self.city.walk_flat[cells] & (self.lz_owner[cells] < 0)
        free &= (self.obst[cells] < 0) | np.isin(self.obst[cells], list(ids))
        cells = cells[free]
        if not cells.size:
            return []
        cx, cy = (cells % GW + 0.5) * CELL, (cells // GW + 0.5) * CELL
        order = np.argsort(np.hypot(cx - x, cy - y) + 8 * self.city.indoor_flat[cells])
        slots = []
        for i in order:
            if all(math.hypot(cx[i] - sx, cy[i] - sy) >= FORMATION_SPACING for sx, sy in slots):
                slots.append((cx[i], cy[i]))
                if len(slots) == n:
                    break
        return slots

    def group_move(self, movers, x, y):
        """Send units to converge on (x, y): one shared path toward the
        target, then each unit peels off to its own formation slot. Squads
        walk (through buildings if quicker); choppers fly straight."""
        movers = [u for u in movers if u.id in self.units]
        if not movers:
            return
        slots = self.formation_slots(x, y, len(movers), movers)
        if not slots:
            return self.flash_message("No room to form up there")
        flow = None
        if any(u.kind == "infantry" for u in movers):
            src = np.zeros(N_CELLS, bool)
            src[cell_index(*slots[0])] = True
            dist = bfs_field(self.city.walk_all, src.reshape(GH, GW), cost=self.city.cost)
            flow = flow_field(dist)
        # Nearest units claim the nearest free slots; extras share the last ring.
        movers.sort(key=lambda u: math.hypot(u.x - x, u.y - y))
        free = list(slots)
        for u in movers:
            sx, sy = min(free, key=lambda p: math.hypot(p[0] - u.x, p[1] - u.y))
            if len(free) > 1:
                free.remove((sx, sy))
            if u.kind == "chopper":
                u.dest, u.escort = (sx, sy), None
            else:
                u.order, u.order_cell, u.order_flow = (sx, sy), cell_index(sx, sy), flow
                u.blocked_t = 0.0

    def can_undo(self):
        return self.phase == "setup" or (self.phase == "running" and self.paused)

    def undo(self):
        """Take back the most recent deployment that still exists and refund
        exactly what it cost. Only while deploying or paused."""
        if not self.can_undo():
            return self.flash_message("Undo: deploy phase or paused only")
        while self.history:
            kind, obj, cost = self.history.pop()
            if kind == "unit" and obj.id in self.units:
                self.remove_unit(obj)
                name = obj.spec["name"]
            elif kind == "shell" and obj in self.shells:
                self.shells.remove(obj)
                name = "AIRSTRIKE"
            elif kind == "bomber" and obj in self.bombers and obj.next_drop == 0:
                self.bombers.remove(obj)
                name = "BOMB RUN"
            elif kind == "drone" and obj in self.drones and obj.dist == 0:
                self.drones.remove(obj)
                name = "LURE DRONE"
            else:
                continue                         # already destroyed / spent
            self.cp += cost
            return self.flash_message(f"Undo {name} +{cost} CP", sound="ui_undo")
        self.flash_message("Nothing to undo")

    def remove_near(self, x, y):
        best, bd = None, 12.0
        for u in self.units.values():
            if u.kind == "barricade":
                d = point_segment_dist(x, y, u.x, u.y, u.x2, u.y2)
            elif u.kind == "evac":
                d = max(0.0, math.hypot(x - u.x, y - u.y) - LZ_RADIUS + 6)
            else:
                d = math.hypot(x - u.x, y - u.y)
            if d < bd:
                best, bd = u, d
        if best is None:
            return
        self.remove_unit(best)
        if self.phase == "setup":
            self.cp += best.cost
        else:
            self.flash_message(f"{best.spec['name']} withdrawn (no refund)")

    def remove_unit(self, u):
        self.units.pop(u.id, None)
        if u.cells is not None:
            self.obst[u.cells[self.obst[u.cells] == u.id]] = -1
            self.refresh_obstacles()
        if u.zone is not None:
            self.lz_owner[u.zone[self.lz_owner[u.zone] == u.id]] = -1
            self.evac_dirty = True
        if u.hp is not None:
            self.rebuild_contacts()

    def rebuild_evac(self):
        """Re-path civilians to the nearest LZ (weighted: indoors is slow)."""
        lz = self.lz_owner >= 0
        if lz.any():
            dist = bfs_field(self.city.walk_all, lz.reshape(GH, GW), cost=self.city.cost)
            self.evac_dist = dist.ravel()
            self.evac_flow = flow_field(dist)
            if self.swim:                        # second field: water is slow but crossable
                cost = self.city.cost.copy()
                cost[self.city.water] = SWIM_COST
                dist = bfs_field(np.ones((GH, GW), bool), lz.reshape(GH, GW), cost=cost)
                self.swim_dist, self.swim_flow = dist.ravel(), flow_field(dist)
        else:
            self.evac_dist = self.evac_flow = None
            self.swim_dist = self.swim_flow = None
        self.evac_dirty = False

    # ---- simulation -----------------------------------------------------

    def advance(self, real_dt):
        if self.message_t > 0:
            self.message_t -= real_dt
        if self.phase == "setup" or self.paused:
            return                               # everything, effects included, freezes
        for fx in self.effects:                  # (effects keep fading on the debrief)
            fx.t -= real_dt
        self.effects = [fx for fx in self.effects if fx.t > 0]
        if self.phase != "running":
            return
        self.accum += min(real_dt, 0.1) * self.time_scale
        dt = FAST_SIM_DT if self.time_scale >= 4 else SIM_DT
        steps = 0
        while self.accum >= dt and self.phase == "running":
            self.step(dt)
            self.accum -= dt
            steps += 1
            if steps >= MAX_STEPS_PER_FRAME:
                self.accum = 0.0                 # drop backlog rather than spiral
                break

    def refresh_fields(self, ci, civ_idx, zom_idx):
        """Zombie scent (toward healthy civilians) and civilian flee field
        (away from zombies), both weighted by terrain, computed in one go.
        Scent ignores barricades so hordes pile up against them."""
        self.start_fields(ci, civ_idx, zom_idx)
        self.advance_fields(FAR)

    def start_fields(self, ci, civ_idx, zom_idx):
        """Snapshot the sources and start both wavefronts (time-sliced)."""
        city = self.city
        src = np.zeros(N_CELLS, bool)
        src[ci[civ_idx]] = True
        scent = bfs_iter(city.walk_all, src.reshape(GH, GW), SCENT_RANGE, city.cost)
        src = np.zeros(N_CELLS, bool)
        src[ci[zom_idx]] = True
        flee = bfs_iter(city.walk_all, src.reshape(GH, GW), FLEE_RANGE, city.cost)
        self.field_jobs = [("scent", scent), ("flee", flee)]

    def advance_fields(self, rings):
        """Run up to `rings` wavefront rings of the pending field searches;
        each finished field replaces the old one."""
        city = self.city
        while rings > 0 and self.field_jobs:
            name, job = self.field_jobs[0]
            try:
                next(job)
                rings -= 1
            except StopIteration as done:
                self.field_jobs.pop(0)
                if name == "scent":
                    self.near_scent = flow_field(done.value)
                    self.merge_scent()
                else:
                    d = done.value
                    self.flee_flow = flow_field(np.where(city.walk_all, -np.minimum(d, FLEE_RANGE + 1), FAR))

    def merge_scent(self):
        """Zombies follow the nearby scent; where there is none, the
        long-range field (missions with scent_range) leads them in."""
        if self.scent_range:
            near = (self.near_scent != 0).any(1)
            self.scent_flow = np.where(near[:, None], self.near_scent, self.far_flow)
        else:
            self.scent_flow = self.near_scent

    def advance_far_scent(self, ci, prey):
        """Long-range scent (e.g. across a river's bridges): a wide search
        is too slow for one frame, so it runs FAR_SCENT_SLICE rings per step
        and the finished field replaces the previous one."""
        if self.far_job is None:
            src = np.zeros(N_CELLS, bool)
            src[ci[prey]] = True
            self.far_job = bfs_iter(self.city.walk_all, src.reshape(GH, GW), self.scent_range, self.city.cost)
        for _ in range(FAR_SCENT_SLICE):
            try:
                next(self.far_job)
            except StopIteration as done:
                self.far_flow = flow_field(done.value)
                self.far_job = None
                self.merge_scent()
                break

    def step(self, dt):
        if self.evac_dirty or (self.terrain_dirty and self.run_time - self.last_repath >= TERRAIN_REPATH):
            self.rebuild_evac()
            self.terrain_dirty, self.last_repath = False, self.run_time
        for t, what in UNLOCK_NEWS:
            if self.run_time < t <= self.run_time + dt:
                self.flash_message(f"{what} NOW AVAILABLE", 4)
                self.sound("ui_unlock", f"vo_unlock_{t}")
        self.run_time += dt
        st, pos = self.state, self.pos
        cx, cy = cells_of(pos)
        ci = cy * GW + cx
        civ_idx = np.flatnonzero(st == CIV)      # includes incubating (they act normal)
        healthy = civ_idx[self.incubate[civ_idx] <= 0]
        zom_idx = np.flatnonzero(st == ZOMBIE)
        alive = np.concatenate([civ_idx, zom_idx])

        # Spatial hashing. Coarse buckets (HASH units) aggregate zombie
        # counts / positions / velocities for flocking, fear and artillery;
        # fine nav-cell occupancy drives crowding, separation and infection.
        hi = (cy // HC) * HW + (cx // HC)
        zh = hi[zom_idx]
        zc = np.bincount(zh, minlength=N_HASH).reshape(HH, HW).astype(float)
        cc = np.bincount(hi[civ_idx], minlength=N_HASH).reshape(HH, HW).astype(float)
        self.zdens, self.cdens = box3(zc), box3(cc)
        occupancy = np.bincount(ci[alive], minlength=N_CELLS).astype(np.float32)
        crowd = box3(occupancy.reshape(GH, GW)).ravel()

        self.field_timer -= dt
        if self.field_timer <= 0 and not self.field_jobs:   # zombies only smell the uninfected
            self.start_fields(ci, healthy, zom_idx)
            self.field_timer = FIELD_REFRESH
        # Spread the rings over the steps until the next refresh (+1 for the
        # rings that settle nothing); the first step of a match does it all.
        rings = FAR if self.run_time <= dt else math.ceil((SCENT_RANGE + FLEE_RANGE) * dt / FIELD_REFRESH) + 2
        self.advance_fields(rings)
        if self.scent_range:
            self.advance_far_scent(ci, healthy)

        self.update_traits(civ_idx, zom_idx, ci, dt)

        self.assist[:] = False                   # checkpoints manned by engineers
        for u in self.units.values():
            if u.kind == "engineer":
                self.assist[disc_cells(u.x, u.y, ASSIST_RADIUS)] = True

        vel = np.zeros_like(pos)
        if civ_idx.size:
            vel[civ_idx] = self.civilian_velocity(civ_idx, ci, hi, occupancy, crowd, dt)
        if zom_idx.size:
            vel[zom_idx] = self.zombie_velocity(zom_idx, ci, zh, zc, occupancy, crowd, dt)

        # Civilians can go anywhere (checkpoints only slow them); zombies are
        # stopped by barricades and squads.
        # Civilians also keep to the streets unless their route leads indoors.
        # Swimmers likewise only enter the water when their route crosses it.
        cc_ = ci[civ_idx]
        f = self.flee_flow[cc_]
        if self.evac_flow is not None:
            route, reach = self.evac_route(civ_idx, cc_)
            f = np.where(reach[:, None], route, f)
        tx = np.clip(cc_ % GW + np.rint(f[:, 0]).astype(int), 0, GW - 1)
        ty = np.clip(cc_ // GW + np.rint(f[:, 1]).astype(int), 0, GH - 1)
        heading = (f[:, 0] != 0) | (f[:, 1] != 0)
        civ_in = (self.city.indoor_flat[ty * GW + tx] & heading) | (self.runner_car[civ_idx] >= 0)
        if self.swim:
            sw = self.traits[civ_idx] & T_SWIMMER > 0
            land = ~sw
            self.move(civ_idx[land], vel[civ_idx[land]] * dt, self.city.walk_flat,
                      no_enter=self.city.indoor_flat, exempt=civ_in[land])
            wet_in = civ_in[sw] | (self.city.water.ravel()[(ty * GW + tx)[sw]] & heading[sw])
            self.move(civ_idx[sw], vel[civ_idx[sw]] * dt, self.swim_walk,
                      no_enter=self.swim_block, exempt=wet_in)
        else:
            self.move(civ_idx, vel[civ_idx] * dt, self.city.walk_flat, no_enter=self.city.indoor_flat,
                      exempt=civ_in)
        before = pos[zom_idx].copy()
        # Zombies stick to streets: they may only step from open ground into a
        # building when their scent path itself leads in (the only route).
        zc = ci[zom_idx]
        f = self.scent_flow[zc]
        tx = np.clip(zc % GW + np.rint(f[:, 0]).astype(int), 0, GW - 1)
        ty = np.clip(zc // GW + np.rint(f[:, 1]).astype(int), 0, GH - 1)
        path_in = self.city.indoor_flat[ty * GW + tx] & ((f[:, 0] != 0) | (f[:, 1] != 0))
        self.move(zom_idx, vel[zom_idx] * dt, self.walk, no_enter=self.city.indoor_flat, exempt=path_in)
        self.vel[zom_idx] = (pos[zom_idx] - before) / dt      # actual motion feeds alignment
        self.water_hazards(civ_idx, zom_idx, ci, occupancy, vel, dt)
        zcrowd = box3(np.bincount(ci[zom_idx], minlength=N_CELLS).astype(np.float32).reshape(GH, GW)).ravel()
        self.update_traffic(dt, crowd, zcrowd, ci)
        if self.trains:
            self.update_trains(dt, ci)

        # Infection: civilians sharing a nav cell with an active zombie.
        cx, cy = cells_of(pos)
        ci = cy * GW + cx
        active = zom_idx[self.busy[zom_idx] <= 0]
        np.maximum(self.aim_hold - dt, 0, out=self.aim_hold)
        armed = civ_idx[(self.ammo[civ_idx] > 0) & (st[civ_idx] == CIV)]
        if armed.size and active.size:
            near = armed[self.zdens.ravel()[hi[armed]] > 0]
            for i in near:                       # concealed carry: one guaranteed kill per round
                d2 = (pos[active, 0] - pos[i, 0]) ** 2 + (pos[active, 1] - pos[i, 1]) ** 2
                j = int(np.argmin(d2))
                if d2[j] < ARMED_RANGE ** 2 and st[active[j]] == ZOMBIE:
                    self.kill(active[j:j + 1])
                    self.ammo[i] -= 1
                    self.aim_hold[i] = ARMED_PAUSE
                    self.panic[i] = ARMED_PAUSE + ARMED_FLEE_TIME    # shoot, then run
                    self.sound("pistol_shot")
                    self.effects.append(Effect("tracer", *pos[i], 0.1, *pos[active[j]]))
            active = active[st[active] == ZOMBIE]
        np.maximum(self.panic - dt, 0, out=self.panic)
        # Incubating civilians turn when their timer runs out.
        sick = civ_idx[self.incubate[civ_idx] > 0]
        self.incubate[sick] -= dt
        turned = sick[self.incubate[sick] <= 0]
        if turned.size:
            st[turned] = ZOMBIE
            self.incubate[turned] = 0
            self.speed[turned] = self.rng.uniform(*self.zombie_speed, turned.size)
            self.busy[turned] = TURN_TIME
            self.vel[turned] = 0
            self.traits[turned] = self.zombie_traits(self.rng, turned.size)
            self.episode[turned], self.episode_kind[turned] = 0, 0
            self.sound("zombie_turn")
        owner = np.full(N_CELLS, -1, np.int64)
        owner[ci[active]] = active
        risk = healthy[(owner[ci[healthy]] >= 0) & (st[healthy] == CIV)]
        if risk.size:
            bitten = risk[self.rng.random(risk.size) < 1 - math.exp(-self.infect_rate * dt)]
            self.vip_lost += int(self.vip[bitten].sum())
            self.incubate[bitten] = self.incubation_times(bitten.size)
            self.busy[owner[ci[bitten]]] = FEED_TIME
            self.infected += bitten.size
            if bitten.size:
                self.sound("civilian_scream")
        np.maximum(self.busy - dt, 0, out=self.busy)

        self.damage_units(active, ci, dt)
        self.evacuate(civ_idx, ci, dt)
        self.update_units(dt)
        self.update_ordnance(dt)
        self.check_end(dt)

    @staticmethod
    def zombie_traits(rng, n):
        """Trait bits for n new zombies (spawned or freshly turned)."""
        bits = np.zeros(n, np.uint8)
        bits[rng.random(n) < LUNGER_FRACTION] |= T_LUNGER
        bits[rng.random(n) < DISTRACTED_FRACTION] |= T_DISTRACTED
        return bits

    def update_traits(self, civ_idx, zom_idx, ci, dt):
        """Start and end trait episodes (stumble / confusion / lunge /
        distraction): random onsets at per-trait rates, all vectorised."""
        np.maximum(self.episode - dt, 0, out=self.episode)
        np.maximum(self.episode_cd - dt, 0, out=self.episode_cd)
        self.episode_kind[self.episode <= 0] = 0
        rng, tr, free = self.rng, self.traits, self.episode <= 0

        def onset(idx, rate):
            return idx[rng.random(idx.size) < 1 - math.exp(-rate * dt)]

        clumsy = onset(civ_idx[free[civ_idx] & (tr[civ_idx] & T_CLUMSY > 0)], CLUMSY_RATE)
        if clumsy.size:
            trip = rng.random(clumsy.size) < 0.5
            self.episode_kind[clumsy] = np.where(trip, EP_STUMBLE, EP_CONFUSED)
            self.episode[clumsy] = np.where(trip, rng.uniform(*STUMBLE_TIME, clumsy.size),
                                            rng.uniform(*CONFUSED_TIME, clumsy.size))
        smell = (self.near_scent[ci[zom_idx]] != 0).any(1)
        ready = free[zom_idx] & (self.episode_cd[zom_idx] <= 0) & (tr[zom_idx] & T_LUNGER > 0) & smell
        lunge = onset(zom_idx[ready], LUNGE_RATE)
        self.episode_kind[lunge], self.episode[lunge] = EP_LUNGE, LUNGE_TIME
        self.episode_cd[lunge] = LUNGE_TIME + LUNGE_COOLDOWN
        idle = onset(zom_idx[free[zom_idx] & (tr[zom_idx] & T_DISTRACTED > 0) & (self.episode_kind[zom_idx] == 0)],
                     DISTRACT_RATE)
        self.episode_kind[idle] = EP_DISTRACTED
        self.episode[idle] = rng.uniform(*DISTRACT_TIME, idle.size)

    def evac_route(self, idx, c):
        """(flow, reachable) of the evac field per agent; swimmers use the
        field that may cross water."""
        flow, dist = self.evac_flow[c], self.evac_dist[c]
        if self.swim_flow is not None:
            sw = self.traits[idx] & T_SWIMMER > 0
            flow = np.where(sw[:, None], self.swim_flow[c], flow)
            dist = np.where(sw, self.swim_dist[c], dist)
        return flow, dist < FAR

    def water_hazards(self, civ_idx, zom_idx, ci, occupancy, vel, dt):
        """Swimmers who overestimated themselves go under; zombies shoved
        toward the water by a packed horde fall in. Neither can swim back."""
        water = self.city.water.ravel()
        if self.swim:
            wet = civ_idx[water[ci[civ_idx]]]
            entered = wet[self.swim_t[wet] == 0]
            if entered.size:
                self.sound("splash")
            self.swim_t[wet] += dt
            gone = wet[(self.traits[wet] & T_DROWNER > 0) & (self.swim_t[wet] >= self.drown_at[wet])]
            if gone.size:
                self.drowned += gone.size
                self.vip_lost += int(self.vip[gone].sum())
                self.state[gone] = DEAD
                self.incubate[gone] = 0
                self.splash(gone)
        if not zom_idx.size or not water.any():
            return
        packed = zom_idx[occupancy[ci[zom_idx]] >= DROWN_PRESSURE]
        if not packed.size:
            return
        v = vel[packed]                          # where the horde wants them to go...
        want = np.hypot(v[:, 0], v[:, 1])
        got = np.hypot(self.vel[packed, 0], self.vel[packed, 1])   # ...and how far they got
        ahead = self.pos[packed] + unit(v) * CELL
        ax, ay = cells_of(ahead)
        push = water[ay * GW + ax] & (want > 0.5) & (got < DROWN_PINNED * want)   # pinned at the edge
        sel = self.rng.random(int(push.sum())) < 1 - math.exp(-HORDE_DROWN_RATE * dt)
        fall = packed[push][sel]
        if fall.size:
            self.drowned_z += fall.size
            self.pos[fall] = ahead[push][sel]    # the body ends up in the water
            self.kill(fall)
            self.splash(fall)

    def splash(self, idx):
        for i in idx[:6]:                        # a few rings are enough to read
            self.effects.append(Effect("splash", *self.pos[i], 0.8, r=6))
        self.sound("drown")

    def incubation_times(self, n):
        """Seconds until each of n bitten civilians turns."""
        t = self.rng.uniform(*INCUBATION, n)
        long_ = self.rng.random(n) < LONG_INCUBATOR_CHANCE
        t[long_] = self.rng.uniform(*LONG_INCUBATION, int(long_.sum()))
        return t.astype(np.float32)

    @staticmethod
    def away_from_crowd(crowd, c):
        """Unit vector down the local crowd-density gradient at cells c."""
        n = crowd.size
        gx = crowd[np.minimum(c + 1, n - 1)] - crowd[np.maximum(c - 1, 0)]
        gy = crowd[np.minimum(c + GW, n - 1)] - crowd[np.maximum(c - GW, 0)]
        return unit(-np.stack([gx, gy], 1))

    def civilian_velocity(self, idx, ci, hi, occupancy, crowd, dt):
        """Evacuate to the nearest LZ if one exists; otherwise panic and flee
        from nearby zombies (or mill about). Crowds spread out and slow down
        in narrow streets, buildings and checkpoints, so they bottleneck."""
        c = ci[idx]
        a = self.angle[idx] + self.rng.normal(0, 1.5 * math.sqrt(dt), idx.size)
        self.angle[idx] = a
        wander = np.stack([np.cos(a), np.sin(a)], 1)
        flee = self.flee_flow[c]
        fleeing = (flee[:, 0] != 0) | (flee[:, 1] != 0)
        base = np.where(fleeing[:, None], flee, wander * IDLE_WANDER)
        running = (self.panic[idx] > 0) & fleeing    # armed civilians after a shootout
        if self.evac_dist is not None:
            route, reach = self.evac_route(idx, c)
            h = hi[idx]
            zgy, zgx = np.gradient(self.zdens)
            fear = unit(np.stack([-zgx.ravel()[h], -zgy.ravel()[h]], 1))
            evac = unit(route + CIV_FEAR * fear)
            on_pad = self.lz_owner[c] >= 0
            evac[on_pad] = wander[on_pad] * IDLE_WANDER
            base = np.where((reach & ~running)[:, None], evac, base)
        spread = self.away_from_crowd(crowd, c)
        d = unit(base + CIV_SPREAD * spread * np.minimum(1.0, occupancy[c] / CELL_CAPACITY)[:, None],
                 cap=True)
        ep = self.episode_kind[idx]
        d[ep == EP_CONFUSED] *= -1                       # clumsy: panicking the wrong way...
        run = np.flatnonzero(self.runner_car[idx] >= 0)  # sprinting for a car: straight at it
        if run.size:
            d[run] = unit(self.car_pos[self.runner_car[idx[run]]] - self.pos[idx[run]])
        factor = np.clip(CELL_CAPACITY / np.maximum(occupancy[c], 1), CROWD_MIN, 1.0)
        factor = np.where(ep == EP_STUMBLE, factor * STUMBLE_SPEED, factor)   # ...or tripping
        factor = np.where(self.runner_car[idx] >= 0, np.maximum(factor, 0.6) * RUNNER_SPEED, factor)
        factor = np.where(self.city.water.ravel()[c], factor * SWIM_SPEED, factor)
        check = np.where(self.assist[c], CHECKPOINT_ASSISTED, CHECKPOINT_SPEED)
        factor = np.where(self.checkpoint[c], factor * check, factor)
        factor = np.where(self.city.indoor_flat[c], factor * INDOOR_SPEED, factor)
        factor = np.where(self.car_slow[c], factor * CAR_SLOW, factor)
        factor = factor * (self.aim_hold[idx] <= 0)      # armed civilians stop to shoot...
        factor = np.where(running, factor * ARMED_FLEE_BOOST, factor)   # ...then run for it
        return d * (self.speed[idx] * factor)[:, None]

    def zombie_velocity(self, idx, ci, zh, zc, occupancy, crowd, dt):
        """Boids: seek prey (scent field), align with and cohere to the local
        horde, separate from crowding, plus some wander. Big hordes surge."""
        p = self.pos[idx]
        v = self.vel[idx]
        nb = box3(zc).ravel()[zh]                # zombies in surrounding buckets
        svx = box3(np.bincount(zh, v[:, 0], N_HASH).reshape(HH, HW)).ravel()[zh]
        svy = box3(np.bincount(zh, v[:, 1], N_HASH).reshape(HH, HW)).ravel()[zh]
        spx = box3(np.bincount(zh, p[:, 0], N_HASH).reshape(HH, HW)).ravel()[zh]
        spy = box3(np.bincount(zh, p[:, 1], N_HASH).reshape(HH, HW)).ravel()[zh]
        align = unit(np.stack([svx, svy], 1))
        cohere = unit(np.stack([spx / nb - p[:, 0], spy / nb - p[:, 1]], 1) / (HASH * 1.5), cap=True)
        c = ci[idx]
        separate = self.away_from_crowd(crowd, c) * np.minimum(1.0, occupancy[c] / CELL_CAPACITY)[:, None]
        a = self.angle[idx] + self.rng.normal(0, 2.0 * math.sqrt(dt), idx.size)
        self.angle[idx] = a
        wander = np.stack([np.cos(a), np.sin(a)], 1)
        seek = self.scent_flow[c]
        ep = self.episode_kind[idx]
        seek = np.where((ep == EP_DISTRACTED)[:, None], 0.0, seek)   # wandered off the trail
        for d in self.drones:                    # lure drones out-rank the smell of people
            if self.phase != "running":
                break
            dx, dy = d.pos
            off = np.stack([dx - p[:, 0], dy - p[:, 1]], 1)
            lured = np.hypot(off[:, 0], off[:, 1]) < LURE_RADIUS
            if lured.any():
                seek = np.where(lured[:, None], unit(off) * LURE_WEIGHT, seek)
        desired = unit(BOID_SEEK * seek + BOID_ALIGN * align + BOID_COHESION * cohere
                       + BOID_SEPARATION * separate + BOID_WANDER * wander)
        surge = 1 + HORDE_SURGE * np.minimum(1.0, (nb - 1) / HORDE_SIZE)
        speed = self.speed[idx] * surge * (self.busy[idx] <= 0)
        speed = np.where(ep == EP_LUNGE, speed * LUNGE_SPEED, speed)
        factor = np.clip(CELL_CAPACITY * 1.5 / np.maximum(occupancy[c], 1), CROWD_MIN, 1.0)
        factor = np.where(self.city.indoor_flat[c], factor * INDOOR_SPEED, factor)
        factor = np.where(self.car_slow[c], factor * CAR_SLOW, factor)
        target = desired * (speed * factor)[:, None]
        return v + (target - v) * min(1.0, BOID_STEER * dt)

    def evacuate(self, civ_idx, ci, dt):
        """Each LZ's helicopter lifts out up to LZ_RATE civilians per second.
        Everyone boarded within one LZ_LIFT_TIME window is one helicopter
        load. An incubating passenger who turns within TROJAN_FLIGHT_TIME
        brings that helicopter down; one who turns later is flown out but
        counts as infected (`carried_out`), not rescued."""
        waiting = civ_idx[(self.state[civ_idx] == CIV) & (self.lz_owner[ci[civ_idx]] >= 0)]
        owners = self.lz_owner[ci[waiting]]
        for u in self.lzs:
            if u.offline > 0:                    # chopper down: the crowd waits for a new one
                u.offline -= dt
                u.credit = 0.0
                if u.offline <= 0:
                    self.flash_message("Replacement helicopter on station")
                    self.effects.append(Effect("ring", u.x, u.y, 0.8, r=LZ_RADIUS))
                    self.sound("lz_lift")
                continue
            u.lift_t += dt
            if u.lift_t >= LZ_LIFT_TIME:         # this load is away safely
                u.lift_t, u.load = 0.0, []
            u.credit = min(u.credit + self.lz_rate * dt, self.lz_rate)
            here = waiting[owners == u.id]
            k = min(int(u.credit), here.size)
            if k:
                lifted = self.rng.permutation(here)[:k]
                inc = self.incubate[lifted]
                if getattr(u, "guarded", False) and ((inc > 0) & (inc < SYMPTOM_TIME)).any():
                    turned_away = (inc > 0) & (inc < SYMPTOM_TIME)    # the squad stops them at the door
                    for i in lifted[turned_away]:
                        self.state[i], self.incubate[i] = DEAD, 0
                        self.screened += 1
                        self.effects.append(Effect("tracer", u.x, u.y, 0.1, *self.pos[i]))
                    self.sound("infantry_fire")
                    lifted, inc = lifted[~turned_away], inc[~turned_away]
                    k = lifted.size
                    if not k:
                        continue
                if ((inc > 0) & (inc <= TROJAN_FLIGHT_TIME)).any():
                    self.trojan_horse(u, lifted)
                    continue
                sick = inc > 0                   # turns after landing: out, but infected
                healthy = lifted[~sick]
                self.vip_rescued += int(self.vip[healthy].sum())
                self.state[lifted] = RESCUED
                self.incubate[lifted] = 0
                u.credit -= k
                u.load.append(healthy)
                self.carried_out += int(sick.sum())
                self.rescued += healthy.size
                self.cp += healthy.size * RESCUE_BONUS
                if healthy.size:
                    self.sound("lz_lift")

    def trojan_horse(self, u, lifted):
        """An infected passenger turns in the air: the helicopter crashes on
        its LZ, taking the whole current load (already counted as rescued)
        with it. The LZ stays (and keeps its crowd) but lifts nobody until a
        replacement arrives LZ_REPLACE_TIME later."""
        boarded = np.concatenate(u.load) if u.load else np.zeros(0, int)
        self.rescued -= boarded.size
        self.cp -= boarded.size * RESCUE_BONUS
        self.vip_rescued -= int(self.vip[boarded].sum())
        victims = np.concatenate([boarded, lifted])
        self.state[victims] = DEAD
        self.incubate[victims] = 0
        self.casualties += victims.size
        self.vip_lost += int(self.vip[victims].sum())
        self.cp = max(0.0, self.cp - TROJAN_PENALTY)
        self.trojans += 1
        u.offline, u.load, u.lift_t, u.credit = LZ_REPLACE_TIME, [], 0.0, 0.0
        self.effects.append(Effect("boom", u.x, u.y, 1.2, r=LZ_RADIUS))
        self.effects.append(Effect("ring", u.x, u.y, 1.2, r=40))
        self.flash_message(f"TROJAN HORSE - chopper down! Replacement inbound "
                           f"{LZ_REPLACE_TIME:.0f}s, -{TROJAN_PENALTY} CP", 5)
        self.sound("trojan_crash", "vo_trojan")

    def move(self, idx, d, walk, no_enter=None, exempt=None):
        """Move agents over a walkable mask, sliding along walls. Cells in
        `no_enter` can't be entered from outside them unless `exempt`."""
        if not idx.size:
            return
        p = self.pos[idx]
        new = p + d
        np.clip(new[:, 0], 0.01, WORLD_W - 0.01, out=new[:, 0])
        np.clip(new[:, 1], 0.01, WORLD_H - 0.01, out=new[:, 1])

        def flat(q):
            qx, qy = cells_of(q)
            return qy * GW + qx

        cur = flat(p)

        def allowed(q, sel=slice(None)):
            cq = flat(q)
            good = walk[cq]
            if no_enter is not None:
                good &= ~(no_enter[cq] & ~no_enter[cur[sel]] & ~exempt[sel])
            return good

        ok = allowed(new) | ~walk[cur]         # anyone caught inside a wall may leave
        out = np.where(ok[:, None], new, p)
        bad = np.flatnonzero(~ok)
        if bad.size:
            px = p[bad].copy()
            px[:, 0] = new[bad, 0]
            py = p[bad].copy()
            py[:, 1] = new[bad, 1]
            okx = allowed(px, bad)
            oky = allowed(py, bad)
            out[bad] = np.where(okx[:, None], px, np.where(oky[:, None], py, p[bad]))
            stuck = idx[bad[~okx & ~oky]]
            self.angle[stuck] = self.rng.uniform(0, 2 * math.pi, stuck.size)
        self.pos[idx] = out

    def damage_units(self, active, ci, dt):
        """Active zombies standing in a unit's contact cells wear it down."""
        ids = self.contact_owner[ci[active]]
        ids = ids[ids >= 0]
        if not ids.size:
            return
        counts = np.bincount(ids)
        for uid in np.flatnonzero(counts):
            u = self.units.get(int(uid))
            if u is None or u.hp is None:
                continue
            if u.kind == "infantry":
                armor = 1 - REINFORCE_ARMOR * u.support
            elif u.kind == "barricade" and u.defended:
                armor = DEFEND_ARMOR
            else:
                armor = 1.0
            n = counts[uid]
            if u.kind == "barricade":
                n = min(n, BARRICADE_ATTACKERS)
            u.hp -= n * ZOMBIE_DPS * armor * dt
            u.last_hit = self.run_time
            if u.hp <= 0:
                self.remove_unit(u)
                if u.kind == "barricade":
                    mx, my = (u.ends[0][0] + u.ends[1][0]) / 2, (u.ends[0][1] + u.ends[1][1]) / 2
                    self.effects.append(Effect("ring", mx, my, 1.2, r=40))
                    self.flash_message("Barricade breached!", 4)
                    self.sound("barricade_breach", "vo_barricade_breached")
                else:
                    self.effects.append(Effect("ring", u.x, u.y, 0.9, r=25))
                    self.flash_message(f"{u.spec['name']} destroyed!")
                    self.sound("unit_destroyed")

    def kill(self, idx, roadkill=False):
        """Kill agents by index (zombies and/or civilians). Civilians count as
        collateral - or as `roadkill` when traffic killed them."""
        idx = idx[self.state[idx] <= ZOMBIE]
        z = int((self.state[idx] == ZOMBIE).sum())
        self.kills += z
        if roadkill:
            self.roadkill += idx.size - z
        else:
            self.casualties += idx.size - z
        self.vip_lost += int((self.vip[idx] & (self.state[idx] == CIV)).sum())
        self.state[idx] = DEAD
        self.incubate[idx] = 0

    def explode(self, x, y, r, destroy=True):
        """Blast: kills everyone inside r. Heavy ordnance (artillery,
        airstrikes, bomb runs) also flattens buildings inside the exact blast
        radius into rubble that anyone can cross at full speed."""
        alive = np.flatnonzero(self.state <= ZOMBIE)
        p = self.pos[alive]
        self.kill(alive[(p[:, 0] - x) ** 2 + (p[:, 1] - y) ** 2 < r * r])
        self.effects.append(Effect("boom", x, y, 0.8, r=r))
        self.sound("explosion_large" if r >= 20 else "explosion_small")
        lost = 0
        for u in list(self.units.values()):      # friendly fire hits your own units too
            if u.drop_t > 0 or u.kind == "barricade":
                continue
            ux, uy = (u.px, u.py) if u.kind == "chopper" else (u.x, u.y)
            if (ux - x) ** 2 + (uy - y) ** 2 < r * r:
                self.remove_unit(u)
                if u.kind == "mine" and u.built:
                    self.fires.append(Fire(u.x, u.y))
                elif u.kind != "mine":
                    lost += 1
                    self.effects.append(Effect("ring", ux, uy, 0.9, r=20))
        if lost:
            self.flash_message(f"Friendly fire: {lost} unit{'s' if lost > 1 else ''} lost", 3)
            self.sound("unit_destroyed", "vo_friendly_fire")
        live = np.flatnonzero(np.isin(self.car_state, (CAR_PARKED, CAR_DRIVING, CAR_WRECK)))
        if live.size:                            # cars cook off (and can chain)
            cx, cy = self.car_pos[live].T
            hit = live[(cx - x) ** 2 + (cy - y) ** 2 < r * r]
            aboard = np.flatnonzero((self.state == IN_CAR) & np.isin(self.in_car, hit))
            if aboard.size:                      # riders go up with their car
                self.state[aboard] = DEAD
                self.in_car[aboard] = -1
                self.incubate[aboard] = 0
                self.casualties += aboard.size
            for k in hit:
                self.car_state[k] = CAR_BURNT
                kx, ky = self.car_pos[k]
                self.shells.append(Shell(kx, ky, kx, ky, float(self.rng.uniform(*CAR_FUSE)), CAR_BLAST, "car"))
                self.sound("car_alarm")
            if hit.size:
                self.update_car_slow()               # a blasted moving car stops where it is
        if destroy and self.city.destroy(disc_cells(x, y, r)):
            self.terrain_dirty = True
            self.sound("building_collapse")
            for u in self.units.values():          # roofs gone: lose the rooftop bonus
                if getattr(u, "rooftop", False) and not self.city.indoor_flat[cell_index(u.x, u.y)]:
                    u.rooftop, u.range = False, u.spec["range"]

    def update_units(self, dt):
        zom = np.flatnonzero(self.state == ZOMBIE)
        zp = self.pos[zom]
        zalive = np.ones(zom.size, bool)

        def dists2(x, y):
            d2 = (zp[:, 0] - x) ** 2 + (zp[:, 1] - y) ** 2
            d2[~zalive] = np.inf
            return d2

        def nearest(x, y, rng):
            if not zom.size:
                return -1
            d2 = dists2(x, y)
            j = int(np.argmin(d2))
            return j if d2[j] < rng * rng else -1

        squads = [u for u in self.units.values() if u.kind == "infantry"]
        lzs = [u for u in self.lzs if u.drop_t <= 0]
        for u in squads:                         # squads posted at an LZ screen its crowd
            u.screening = u.drop_t <= 0 and any(math.hypot(u.x - z.x, u.y - z.y) < SCREEN_LZ_RANGE for z in lzs)
        for z in lzs:                            # ...and check everyone boarding there
            z.guarded = any(q.screening and math.hypot(q.x - z.x, q.y - z.y) < SCREEN_LZ_RANGE for q in squads)
        sick = np.flatnonzero((self.state == CIV) & (self.incubate > 0) & (self.incubate < SYMPTOM_TIME))
        for u in squads:
            u.support = min(REINFORCE_MAX, sum(1 for o in squads if o is not u and
                                               math.hypot(o.x - u.x, o.y - u.y) < REINFORCE_RADIUS))
        for u in self.units.values():            # squads near a barricade shore it up
            if u.kind == "barricade":
                (ax, ay), (bx, by) = u.ends
                u.defended = any(point_segment_dist(q.x, q.y, ax, ay, bx, by) < DEFEND_RADIUS
                                 for q in squads)

        for u in list(self.units.values()):
            k, spec = u.kind, u.spec
            if u.drop_t > 0:                     # still descending: inactive
                u.drop_t -= dt
                if u.drop_t <= 0:
                    self.land(u)
                continue
            if k in ("barricade", "evac") or not u.built:
                continue
            if k == "engineer":
                self.update_engineer(u, dt, zp, zalive)
                continue
            if k == "mine":
                if u.built and zom.size and (dists2(u.x, u.y) < MINE_TRIGGER ** 2).any():
                    self.remove_unit(u)                  # detonate into a fire pool
                    self.sound("mine_ignite")
                    self.explode(u.x, u.y, MINE_BLAST, destroy=False)
                    self.fires.append(Fire(u.x, u.y))
                continue
            if k == "chopper":
                if u.escort is not None:         # follow the escorted unit / VIP
                    tgt = self.escort_pos(u.escort)
                    if tgt is None:
                        u.escort = None
                        self.flash_message("Escort target lost - chopper holding")
                    else:
                        u.dest = tgt
                if u.dest is not None:           # fly the orbit centre to its new spot
                    dx, dy = u.dest[0] - u.x, u.dest[1] - u.y
                    d = math.hypot(dx, dy)
                    step = CHOPPER_SPEED * dt
                    if d <= step:
                        u.x, u.y = u.dest
                        u.dest = None
                    else:
                        u.x, u.y = u.x + dx / d * step, u.y + dy / d * step
                u.angle += dt * 1.6
                orbit = ESCORT_ORBIT if u.escort is not None else spec["orbit"]
                u.px = u.x + math.cos(u.angle) * orbit
                u.py = u.y + math.sin(u.angle) * orbit
            if k == "infantry":
                self.move_squad(u, dt, zp, zalive)
            if k == "sniper":
                j = nearest(u.x, u.y, u.range)
                u.aim = (float(zp[j, 0]), float(zp[j, 1])) if j >= 0 else None
            u.cooldown -= dt
            if u.cooldown > 0:
                continue
            if k == "infantry" and u.screening and sick.size:     # LZ checkpoint: stop the sick
                d2 = (self.pos[sick, 0] - u.x) ** 2 + (self.pos[sick, 1] - u.y) ** 2
                j = int(np.argmin(d2))
                if d2[j] < SCREEN_RADIUS ** 2 and self.state[sick[j]] == CIV:
                    self.screen_out(u, sick[j])
                    continue
            if k in ("sniper", "infantry", "chopper"):
                sx, sy = (u.px, u.py) if k == "chopper" else (u.x, u.y)
                if k == "chopper":
                    cand = np.flatnonzero(dists2(sx, sy) < u.range ** 2) if zom.size else []
                    j = int(self.rng.choice(cand)) if len(cand) else -1
                else:
                    j = nearest(sx, sy, u.range)
                if j < 0:
                    continue
                u.cooldown = spec["cooldown"]
                if k == "infantry":
                    u.cooldown /= 1 + REINFORCE_FIRE * u.support
                if k == "chopper" and self.rng.random() > spec["hit_chance"]:
                    tx, ty = zp[j] + self.rng.normal(0, 4, 2)
                else:
                    zalive[j] = False
                    self.kill(zom[j:j + 1])
                    tx, ty = zp[j]
                self.sound({"sniper": "sniper_shot", "chopper": "minigun"}.get(k, "infantry_fire"))
                self.effects.append(Effect("tracer", sx, sy, 0.12 if k == "sniper" else 0.06,
                                           float(tx), float(ty)))
            elif k == "artillery":
                tgt = self.artillery_target(u)
                if tgt:
                    self.shells.append(Shell(u.x, u.y, tgt[0], tgt[1], spec["shell_time"],
                                             spec["blast"], "artillery"))
                    self.sound("artillery_launch")
                    u.cooldown = spec["cooldown"]

    def screen_out(self, u, i):
        """A squad screening an LZ shoots a visibly sick civilian: they were
        infected, so it isn't collateral."""
        self.state[i] = DEAD
        self.incubate[i] = 0
        self.screened += 1
        u.cooldown = u.spec["cooldown"]
        self.effects.append(Effect("tracer", u.x, u.y, 0.1, *self.pos[i]))
        self.sound("infantry_fire")

    def walk_unit(self, u, dx, dy, speed, dt):
        """Engineer movement: slow indoors, blocked only by water (they can
        squeeze through friendly barricades and squads)."""
        terrain = INDOOR_SPEED if self.city.indoor_flat[cell_index(u.x, u.y)] else 1.0
        nx = min(max(u.x + dx * speed * terrain * dt, 0.5), WORLD_W - 0.5)
        ny = min(max(u.y + dy * speed * terrain * dt, 0.5), WORLD_H - 0.5)
        if self.city.walk_flat[cell_index(nx, ny)]:
            u.x, u.y = nx, ny
        elif self.city.walk_flat[cell_index(nx, u.y)]:
            u.x = nx
        elif self.city.walk_flat[cell_index(u.x, ny)]:
            u.y = ny

    def head_for(self, u, flow, goal):
        """Direction to goal: follow a flow field, straight line when close."""
        gx, gy = goal
        left = math.hypot(gx - u.x, gy - u.y) or 1e-6
        dx, dy = flow[cell_index(u.x, u.y)] if flow is not None else (0.0, 0.0)
        if left < 30 or (dx == 0 and dy == 0):
            dx, dy = (gx - u.x) / left, (gy - u.y) / left
        return dx, dy, left

    def claim_job(self, u):
        """Nearest blueprint nobody is building yet."""
        open_jobs = [b for b in self.units.values() if not b.built and
                     (b.claimed is None or b.claimed not in self.units or b.claimed == u.id)]
        if not open_jobs:
            u.job = u.job_flow = None
            return None
        job = min(open_jobs, key=lambda b: math.hypot(b.site[0] - u.x, b.site[1] - u.y))
        job.claimed, u.job = u.id, job.id
        src = np.zeros(N_CELLS, bool)
        src[cell_index(*job.site)] = True
        u.job_flow = flow_field(bfs_field(self.city.walk_all, src.reshape(GH, GW), cost=self.city.cost))
        return job

    def update_engineer(self, u, dt, zp, zalive):
        """Non-combatant: flee zombies, follow manual orders, otherwise build
        the nearest blueprint, and repair nearby barricades when on station."""
        if zp.size:
            d2 = (zp[:, 0] - u.x) ** 2 + (zp[:, 1] - u.y) ** 2
            close = zalive & (d2 < RETREAT_RADIUS ** 2)
            if close.any():
                mx, my = zp[close].mean(0)
                n = math.hypot(u.x - mx, u.y - my) or 1.0
                self.walk_unit(u, (u.x - mx) / n, (u.y - my) / n, ENGINEER_FLEE_SPEED, dt)
                u.state = "fleeing"
                return
        if u.order is not None:
            dx, dy, left = self.head_for(u, u.order_flow, u.order)
            if left < 1.5:
                u.order = u.order_flow = None
            else:
                self.walk_unit(u, dx, dy, min(SQUAD_SPEED, left / dt), dt)
                u.state = "moving"
                return
        job = self.units.get(u.job) if u.job is not None else None
        if job is None or job.built:
            job = self.claim_job(u)
        u.state = "idle"
        if job is not None:
            dx, dy, left = self.head_for(u, u.job_flow, job.site)
            if left > BUILD_RANGE:
                self.walk_unit(u, dx, dy, SQUAD_SPEED, dt)
                u.state = "moving"
                return
            u.state = "building"
            self.sound("engineer_build")
            job.progress += dt / BUILD_TIME
            if job.progress >= 1.0:
                self.activate(job)
                u.job = u.job_flow = None
        for b in self.units.values():            # patch up a damaged barricade nearby
            if b.kind == "barricade" and b.built and b.hp < b.max_hp:
                (ax, ay), (bx, by) = b.ends
                if point_segment_dist(u.x, u.y, ax, ay, bx, by) <= REPAIR_RADIUS:
                    b.hp = min(b.max_hp, b.hp + REPAIR_RATE * dt)
                    self.sound("engineer_repair")
                    if u.state == "idle":
                        u.state = "repairing"
                    break

    def move_squad(self, u, dt, zp, zalive):
        """Fighting retreat when zombies close in; otherwise follow orders."""
        u.retreating = False
        ci = cell_index(u.x, u.y)
        terrain = INDOOR_SPEED if self.city.indoor_flat[ci] else 1.0
        if zp.size:
            d2 = (zp[:, 0] - u.x) ** 2 + (zp[:, 1] - u.y) ** 2
            close = zalive & (d2 < RETREAT_RADIUS ** 2)
        else:
            close = np.zeros(0, bool)
        if close.any():
            mx, my = zp[close].mean(0)
            dx, dy = u.x - mx, u.y - my
            n = math.hypot(dx, dy) or 1.0
            dx, dy, speed = dx / n, dy / n, RETREAT_SPEED
            u.retreating = True
        elif u.order is not None:
            ox, oy = u.order
            left = math.hypot(ox - u.x, oy - u.y)
            if left < 1.5:
                u.order = u.order_flow = None
                return
            dx, dy = u.order_flow[ci] if u.order_flow is not None else (0.0, 0.0)
            if left < 30 or (dx == 0 and dy == 0):
                dx, dy = (ox - u.x) / left, (oy - u.y) / left   # final approach to own slot
            speed = SQUAD_SPEED
            if left < speed * terrain * dt:
                speed = left / (terrain * dt)
        else:
            return
        step = speed * terrain * dt
        nx = min(max(u.x + dx * step, 0.5), WORLD_W - 0.5)
        ny = min(max(u.y + dy * step, 0.5), WORLD_H - 0.5)
        nc = cell_index(nx, ny)
        if not self.city.walk_flat[nc]:
            u.blocked_t += dt
            return                               # water
        if self.obst[nc] >= 0 and self.obst[nc] != u.id:
            # Another unit is in the way: sidestep, and give up on the exact
            # slot if boxed in for a while (formations converge, not stack).
            sx, sy = -dy * step, dx * step
            alt = cell_index(u.x + sx, u.y + sy)
            if self.city.walk_flat[alt] and self.obst[alt] in (-1, u.id):
                nx, ny, nc = u.x + sx, u.y + sy, alt
            else:
                u.blocked_t += dt
                if u.blocked_t > 1.5 and not u.retreating:
                    u.order = u.order_flow = None
                return
        u.blocked_t = 0.0
        u.x, u.y = nx, ny
        if nc != ci:
            self.relocate_squad(u, nc)

    def relocate_squad(self, u, ci):
        self.obst[u.cells[self.obst[u.cells] == u.id]] = -1
        u.cells = self.squad_cells(ci, u.id)
        self.obst[u.cells] = u.id
        self.eject_zombies(u.cells)
        self.refresh_obstacles()
        self.rebuild_contacts()

    def artillery_target(self, u):
        """Densest horde bucket in range, penalising nearby civilians."""
        hx = (np.arange(HW) + 0.5) * HASH
        hy = (np.arange(HH) + 0.5) * HASH
        d2 = (hx[None, :] - u.x) ** 2 + (hy[:, None] - u.y) ** 2
        score = np.where(d2 < u.range ** 2, self.zdens - 3 * self.cdens, -np.inf)
        k = int(np.argmax(score))
        if score.flat[k] < 4:
            return None
        return (k % HW + 0.5) * HASH, (k // HW + 0.5) * HASH

    def update_ordnance(self, dt):
        remaining = []
        for s in self.shells:
            if s.source != "car" and s.t > 0.8 >= s.t - dt:
                self.sound("shell_whistle")
            s.t -= dt
            if s.t > 0:
                remaining.append(s)
            else:
                if s.source == "car":
                    self.sound("car_cookoff")
                self.explode(s.x, s.y, s.radius, destroy=s.source != "car")
        self.shells = remaining
        remaining = []
        for b in self.bombers:
            if b.delay > 0:
                b.delay -= dt
                remaining.append(b)
                continue
            b.dist += b.spec["plane_speed"] * dt
            if b.next_drop == 0 and b.dist >= 0:
                self.sound("bomb_chain")
            while b.next_drop <= min(b.dist, b.length):
                self.explode(b.x0 + b.ux * b.next_drop, b.y0 + b.uy * b.next_drop, b.spec["blast"])
                b.next_drop += b.spec["spacing"]
            if b.dist < b.length + 120:
                remaining.append(b)
        self.bombers = remaining
        remaining = []
        for f in self.fires:                     # incendiary pools burn anyone inside
            f.t -= dt
            alive = np.flatnonzero(self.state <= ZOMBIE)
            p = self.pos[alive]
            inside = alive[(p[:, 0] - f.x) ** 2 + (p[:, 1] - f.y) ** 2 < f.r * f.r]
            if inside.size:
                self.kill(inside[self.rng.random(inside.size) < 1 - math.exp(-FIRE_KILL_RATE * dt)])
            if f.t > 0:
                remaining.append(f)
        self.fires = remaining
        remaining = []
        for d in self.drones:                    # lure drones: fly, hover, detonate
            if d.dist < d.length:
                d.dist = min(d.length, d.dist + DRONE_SPEED * dt)
            else:
                d.hover += dt
                if d.hover >= DRONE_HOVER:
                    self.sound("drone_detonate")
                    self.explode(*d.pos, DRONE_BLAST, destroy=False)
                    continue
            remaining.append(d)
        self.drones = remaining

    def check_end(self, dt):
        if self.phase == "over":                 # result already recorded
            return
        n_civ, n_z = self.counts()
        # (zombies drowning on their own isn't progress: it mustn't hold off the stalemate)
        sig = (self.rescued, self.infected, self.casualties, self.kills - self.drowned_z)
        if sig != self.last_sig:
            self.last_sig, self.quiet = sig, 0.0
        else:
            self.quiet += dt
        if self.mission:
            return self.check_mission(n_civ, n_z)
        if n_civ == 0 or n_z == 0 or self.quiet > STALEMATE_TIME:
            # Survivors left when the horde is gone or contained are sheltered.
            self.finish(None, "")
            evac_pct = 100 * self.rescued / max(1, self.total_healthy)
            change = self.progress.record(self.city.name, evac_pct, self.difficulty)
            if change:
                self.sound("threat_up" if change > 0 else "threat_down")
            self.last_result = dict(evac_pct=evac_pct, change=change,
                                    next=apply_difficulty(self.progress.params(), self.difficulty),
                                 level=self.progress.level)

    def save_target(self):
        """Civilians that must be evacuated (0 if the mission has no quota)."""
        g = self.goal
        if "save_count" in g:
            return g["save_count"]
        return math.ceil(g.get("save_pct", 0) / 100 * self.total_healthy)

    def check_mission(self, n_civ, n_z):
        """Story objectives: fail conditions first, then wins, then the
        usual end-of-outbreak states judged against the mission goals."""
        g = self.goal
        need = self.save_target()
        vips_ok = self.vip_rescued >= self.vip_total
        if self.vip_total and self.vip_lost:
            return self.finish(False, "VIP LOST")
        if "max_collateral" in g and self.casualties > g["max_collateral"]:
            return self.finish(False, "COLLATERAL LIMIT EXCEEDED")
        if "hold_min" in g and n_civ + self.rescued < g["hold_min"] * self.total_healthy:
            return self.finish(False, "THE CITY HAS FALLEN")
        if "survive" in g:
            if self.run_time >= g["survive"]:
                return self.finish(True, "THE LINE HELD")
            if n_civ == 0:
                return self.finish(False, "THE CITY HAS FALLEN")
            return
        if g.get("eradicate"):
            if n_z == 0:
                return self.finish(True, "INFECTION ERADICATED")
            if n_civ == 0 or self.quiet > STALEMATE_TIME:
                return self.finish(False, "THE INFECTION SPREAD")
            return
        if vips_ok and self.rescued >= need and (need or self.vip_total):
            return self.finish(True, "EVACUATION COMPLETE")
        if n_z == 0 and not self.vip_total:      # horde wiped out: survivors are safe
            ok = self.rescued + n_civ >= need
            return self.finish(ok, "OUTBREAK CONTAINED" if ok else "TOO FEW SURVIVORS")
        if n_civ == 0 or self.quiet > STALEMATE_TIME:
            return self.finish(False, "VIPS NOT EVACUATED" if not vips_ok else "EVACUATION TARGET MISSED")

    def objective_progress(self):
        """(label, value, colour) rows for the HUD, one per mission goal."""
        if not self.mission:
            return []
        g, rows = self.goal, []
        n_civ, n_z = self.counts()
        if "survive" in g:
            left = max(0.0, g["survive"] - self.run_time)
            rows.append(("HOLD FOR", f"{int(left // 60)}:{int(left % 60):02d}", COL_YELLOW))
        if "hold_min" in g:
            pct = 100 * (n_civ + self.rescued) / max(1, self.total_healthy)
            rows.append(("CITY ALIVE", f"{pct:.0f}%/{g['hold_min'] * 100:.0f}%", COL_YELLOW))
        if g.get("eradicate"):
            rows.append(("INFECTED LEFT", n_z, COL_RED))
        need = self.save_target()
        if need:
            rows.append(("EVAC TARGET", f"{self.rescued}/{need}", COL_YELLOW))
        if self.vip_total:
            rows.append(("VIPS OUT", f"{self.vip_rescued}/{self.vip_total}", COL_VIP))
        if "max_collateral" in g:
            rows.append(("COLLAT LIMIT", f"{self.casualties}/{g['max_collateral']}", COL_MAGENTA))
        return rows

    def finish(self, success, reason):
        self.sheltered = self.counts()[0]
        self.phase = "over"
        self.result = dict(success=success, reason=reason)
        if success is None:                      # Endless: judged like the debrief verdict
            success = 100 * (self.rescued + self.sheltered) / max(1, self.total_healthy) >= 40
        self.sound(*(("victory", "vo_mission_complete") if success else ("defeat", "vo_city_fallen")))

    # ---- queries for the UI ---------------------------------------------

    def counts(self):
        """(healthy civilians, infected) - incubating civilians count as infected."""
        b = np.bincount(self.state, minlength=5)
        sick = int(np.count_nonzero(self.incubate))
        return int(b[CIV] + b[IN_CAR]) - sick, int(b[ZOMBIE]) + sick

    def drag_cost(self, kind, x0, y0, x1, y1):
        spec = UNIT_SPECS[kind]
        x1, y1 = clamp_segment(x0, y0, x1, y1, spec["max_len"])
        if kind == "barricade":
            return int(self.barricade_line(x0, y0, x1, y1)[0].size * self.barricade_cost), (x1, y1)
        return spec["cost"], (x1, y1)


# --------------------------------------------------------------------------
# Rendering & input
# --------------------------------------------------------------------------

def draw_unit_symbol(surf, kind, center, size, color, lw):
    """Tactical map symbols for each item type."""
    x, y = center
    k = max(3, size)
    if kind == "evac":
        pygame.draw.circle(surf, color, (x, y), k, lw)
        h = int(k * 0.5)
        pygame.draw.line(surf, color, (x - h, y - h), (x - h, y + h), lw)
        pygame.draw.line(surf, color, (x + h, y - h), (x + h, y + h), lw)
        pygame.draw.line(surf, color, (x - h, y), (x + h, y), lw)
    elif kind == "sniper":
        pts = [(x, y - k), (x - k, y + int(k * 0.8)), (x + k, y + int(k * 0.8))]
        pygame.draw.polygon(surf, color, pts, lw)
        pygame.draw.circle(surf, color, (x, y + int(k * 0.2)), max(1, k // 4))
    elif kind == "artillery":
        pygame.draw.rect(surf, color, (x - k, y - k, 2 * k, 2 * k), lw)
        pygame.draw.circle(surf, color, (x, y), max(1, k // 3))
    elif kind == "infantry":
        h = int(k * 0.7)
        pygame.draw.rect(surf, color, (x - k, y - h, 2 * k, 2 * h), lw)
        pygame.draw.line(surf, color, (x - k, y - h), (x + k - 1, y + h - 1), lw)
        pygame.draw.line(surf, color, (x - k, y + h - 1), (x + k - 1, y - h), lw)
    elif kind == "barricade":
        pygame.draw.line(surf, color, (x - k, y + k // 2), (x + k, y - k // 2), max(lw, k // 2))
    elif kind == "chopper":
        pygame.draw.circle(surf, color, (x, y), max(2, k // 2), lw)
        pygame.draw.line(surf, color, (x - k, y - k), (x + k, y + k), lw)
        pygame.draw.line(surf, color, (x - k, y + k), (x + k, y - k), lw)
    elif kind == "airstrike":
        pygame.draw.circle(surf, color, (x, y), k, lw)
        pygame.draw.line(surf, color, (x - k - 2, y), (x + k + 2, y), lw)
        pygame.draw.line(surf, color, (x, y - k - 2), (x, y + k + 2), lw)
    elif kind == "bombing":
        pts = [(x + k, y), (x - k, y - int(k * 0.8)), (x - k // 3, y), (x - k, y + int(k * 0.8))]
        pygame.draw.polygon(surf, color, pts, lw)
    elif kind == "engineer":                     # NATO engineer box: rectangle with an "E" bridge
        h = int(k * 0.7)
        pygame.draw.rect(surf, color, (x - k, y - h, 2 * k, 2 * h), lw)
        pygame.draw.line(surf, color, (x - k // 2, y + h // 3), (x + k // 2, y + h // 3), lw)
        for dx in (-k // 2, 0, k // 2):
            pygame.draw.line(surf, color, (x + dx, y - h // 3), (x + dx, y + h // 3), lw)
    elif kind == "mine":                         # diamond with a hot core
        pts = [(x, y - k), (x + k, y), (x, y + k), (x - k, y)]
        pygame.draw.polygon(surf, color, pts, lw)
        pygame.draw.circle(surf, color, (x, y), max(1, k // 3))
    elif kind == "lure":                         # quad-rotor with signal arcs
        a = int(k * 0.6)
        for dx, dy in ((-a, -a), (a, -a), (-a, a), (a, a)):
            pygame.draw.circle(surf, color, (x + dx, y + dy), max(2, k // 3), max(1, lw - 1))
        pygame.draw.line(surf, color, (x - a, y - a), (x + a, y + a), lw)
        pygame.draw.line(surf, color, (x - a, y + a), (x + a, y - a), lw)


def draw_crosshair(surf, color, center, r, lw):
    """Sniper sight: ring with four ticks and an open centre."""
    x, y = center
    pygame.draw.circle(surf, color, (x, y), r, lw)
    g = max(2, r // 3)
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        pygame.draw.line(surf, color, (x + dx * g, y + dy * g), (x + dx * (r + g), y + dy * (r + g)), lw)


def read_json(path, default=None):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def write_json(path, data):
    try:
        path.write_text(json.dumps(data, indent=1))
    except OSError:
        pass


def read_save():
    """Campaign save, or None if there isn't a valid one."""
    d = read_json(SAVE_FILE)
    if isinstance(d, dict) and isinstance(d.get("mission"), int) and 0 <= d["mission"] < len(CAMPAIGN):
        d.setdefault("completed", [])
        return d
    return None


def mission_objectives(m, difficulty="medium"):
    """Briefing lines: goals (yellow, scaled for the difficulty) and special
    rules (white)."""
    g, goals, rules = scaled_goal(m["goal"], difficulty), [], []
    if "save_pct" in g:
        goals.append(f"EVACUATE {g['save_pct']}% OF CIVILIANS")
    if "save_count" in g:
        goals.append(f"EVACUATE {g['save_count']:,} CIVILIANS")
    if m.get("vips"):
        goals.append(f"EVACUATE ALL {m['vips']} VIPS - LOSE ONE AND YOU FAIL")
    if "survive" in g:
        goals.append(f"SURVIVE {g['survive'] // 60}:{g['survive'] % 60:02d}")
    if "hold_min" in g:
        goals.append(f"KEEP {g['hold_min'] * 100:.0f}% OF CIVILIANS ALIVE OR EVACUATED")
    if g.get("eradicate"):
        goals.append("ERADICATE 100% OF THE INFECTED")
    if "max_collateral" in g:
        goals.append(f"NO MORE THAN {g['max_collateral']} CIVILIAN CASUALTIES")
    if m.get("disabled"):
        rules.append("LOCKED: " + ", ".join(UNIT_SPECS[k]["name"] for k in m["disabled"]))
    zoned = set(m.get("build_zones", {})) | ({"evac"} if "lz_region" in m else set())
    for kind in UNIT_ORDER:
        if kind in zoned:
            name = "LZS" if kind == "evac" else UNIT_SPECS[kind]["name"] + "S"
            rules.append(f"{name} ONLY INSIDE THE MARKED AREA")
    if m.get("lz_rate_mult", 1) < 1:
        rules.append(f"LZS LOAD {round((1 / m['lz_rate_mult'] - 1) * 100)}% SLOWER")
    if m.get("infect_mult", 1) > 1:
        rules.append(f"INFECTION SPREADS {m['infect_mult']:g}X FASTER")
    if m.get("zombie_speed_mult", 1) > 1:
        rules.append("FASTER HORDES")
    if m.get("barricade_cost_mult", 1) > 1:
        rules.append(f"BARRICADES COST {m['barricade_cost_mult']}X")
    return goals, rules


CONTROLS = [                               # (keys, action); None action = section header
    ("MOUSE", None),
    ("LEFT CLICK", "DEPLOY / SELECT A UNIT / MOVE SELECTION"),
    ("RIGHT CLICK", "REMOVE ITEM / CANCEL / DESELECT"),
    ("BARRICADE", "CLICK START POINT, CLICK END POINT"),
    ("BOMB RUN, LURE DRONE", "DRAG THE FLIGHT PATH"),
    ("CHOPPER + CLICK UNIT/VIP", "ESCORT IT"),
    ("KEYBOARD", None),
    ("1-9, 0, L", "SELECT TOOL"),
    ("SPACE", "PLAY / PAUSE"),
    ("F   +   -", "GAME SPEED 1X-8X"),
    ("CTRL+Z", "UNDO (DEPLOY PHASE OR PAUSED)"),
    ("CTRL+A", "SELECT ALL MOVABLE UNITS"),
    ("R", "RESTART / RETRY MISSION"),
    ("ENTER", "NEXT MISSION (AFTER A WIN)"),
    ("N", "NEW CITY (ENDLESS)"),
    ("F11", "FULL SCREEN"),
    ("ESC", "PAUSE MENU / BACK"),
]


# --------------------------------------------------------------------------
# Audio
# --------------------------------------------------------------------------
#
# Every file below is an AI-generated alpha placeholder. Each name carries
# _TEMP_AI so they can be found and replaced before release:
#     grep -rn _TEMP_AI zombie_evac.py audio/
# Files live in ./audio; any that are missing are silently skipped.

AUDIO_DIR = HERE / "audio"

MUSIC_TRACKS = {                           # streamed one at a time (music volume)
    "menu": "mus_menu_TEMP_AI.ogg",                     # menus: analog drone under CRT hum
    "briefing": "mus_briefing_TEMP_AI.ogg",             # briefing / map loading: radio-room tension
    "deploy": "mus_deploy_TEMP_AI.ogg",                 # setup phase: ticking, held breath
    "match_low": "mus_match_low_TEMP_AI.ogg",           # running, < 25% of the living infected
    "match_mid": "mus_match_mid_TEMP_AI.ogg",           # running, < 50%
    "match_high": "mus_match_high_TEMP_AI.ogg",         # running, the city is falling
    "hold_timer": "mus_hold_timer_TEMP_AI.ogg",         # last 30 s of a survive mission
}

AMBIENCE_LOOPS = {                         # looping beds, volume follows the sim (sfx volume)
    "city": "amb_city_night_TEMP_AI.ogg",               # always: distant traffic, wind
    "sirens": "amb_sirens_far_TEMP_AI.ogg",             # share of the living that is infected
    "crowd": "amb_crowd_panic_TEMP_AI.ogg",             # healthy civilians left
    "horde": "amb_horde_TEMP_AI.ogg",                   # zombies left
    "water": "amb_water_TEMP_AI.ogg",                   # maps with rivers / harbours
    "fire": "amb_fire_loop_TEMP_AI.ogg",                # incendiary pools burning
    "rotor": "sfx_lz_rotor_loop_TEMP_AI.ogg",           # helicopters idling over LZs
    "gunship": "sfx_chopper_gunship_loop_TEMP_AI.ogg",  # gunships orbiting
    "drone": "sfx_drone_loop_TEMP_AI.ogg",              # lure drones in the air
    "barricade_hit": "sfx_barricade_hit_loop_TEMP_AI.ogg",   # barricades under attack
    "traffic": "sfx_car_engine_loop_TEMP_AI.ogg",       # cars on the move
    "train": "sfx_train_rumble_loop_TEMP_AI.ogg",       # a train on the map
    "cctv": "amb_cctv_hum_TEMP_AI.ogg",                 # CRT option on: 60 Hz hum, tape hiss
}

# One-shots: event -> (file, volume channel, minimum seconds between plays).
# Channels: "sfx", "ui", "music" (stings) and "speech" (radio voice lines).
SOUNDS = {
    # stings
    "victory": ("stg_victory_TEMP_AI.ogg", "music", 0),
    "defeat": ("stg_defeat_TEMP_AI.ogg", "music", 0),
    "campaign_complete": ("stg_campaign_complete_TEMP_AI.ogg", "music", 0),
    "threat_up": ("stg_threat_up_TEMP_AI.ogg", "music", 0),
    "threat_down": ("stg_threat_down_TEMP_AI.ogg", "music", 0),
    # units and combat
    "lz_lift": ("sfx_lz_liftoff_TEMP_AI.ogg", "sfx", 3.0),
    "paradrop": ("sfx_paradrop_whoosh_TEMP_AI.ogg", "sfx", 0.3),
    "paradrop_land": ("sfx_paradrop_land_TEMP_AI.ogg", "sfx", 0.3),
    "infantry_fire": ("sfx_infantry_burst_TEMP_AI.ogg", "sfx", 0.25),
    "sniper_shot": ("sfx_sniper_shot_TEMP_AI.ogg", "sfx", 0.3),
    "minigun": ("sfx_minigun_TEMP_AI.ogg", "sfx", 0.4),
    "pistol_shot": ("sfx_pistol_shot_TEMP_AI.ogg", "sfx", 0.2),
    "artillery_launch": ("sfx_artillery_launch_TEMP_AI.ogg", "sfx", 0.5),
    "shell_whistle": ("sfx_shell_whistle_TEMP_AI.ogg", "sfx", 0.5),
    "explosion_large": ("sfx_explosion_large_TEMP_AI.ogg", "sfx", 0.15),
    "explosion_small": ("sfx_explosion_small_TEMP_AI.ogg", "sfx", 0.15),
    "airstrike_jet": ("sfx_airstrike_jet_TEMP_AI.ogg", "sfx", 0.5),
    "bomber_flyby": ("sfx_bomber_flyby_TEMP_AI.ogg", "sfx", 0.5),
    "bomb_chain": ("sfx_bomb_chain_TEMP_AI.ogg", "sfx", 1.0),
    "building_collapse": ("sfx_building_collapse_TEMP_AI.ogg", "sfx", 0.6),
    "barricade_place": ("sfx_barricade_place_TEMP_AI.ogg", "sfx", 0.2),
    "barricade_breach": ("sfx_barricade_breach_TEMP_AI.ogg", "sfx", 0.5),
    "engineer_build": ("sfx_engineer_build_TEMP_AI.ogg", "sfx", 1.5),
    "engineer_repair": ("sfx_engineer_repair_TEMP_AI.ogg", "sfx", 2.0),
    "mine_arm": ("sfx_mine_arm_TEMP_AI.ogg", "sfx", 0.2),
    "mine_ignite": ("sfx_mine_ignite_TEMP_AI.ogg", "sfx", 0.3),
    "drone_launch": ("sfx_drone_beacon_TEMP_AI.ogg", "sfx", 0.3),
    "drone_detonate": ("sfx_drone_detonate_TEMP_AI.ogg", "sfx", 0.3),
    "car_alarm": ("sfx_car_alarm_TEMP_AI.ogg", "sfx", 1.0),
    "car_cookoff": ("sfx_car_cookoff_TEMP_AI.ogg", "sfx", 0.2),
    "unit_destroyed": ("sfx_unit_destroyed_TEMP_AI.ogg", "sfx", 0.5),
    "trojan_crash": ("sfx_trojan_crash_TEMP_AI.ogg", "sfx", 0),
    "zombie_turn": ("sfx_zombie_turn_TEMP_AI.ogg", "sfx", 1.5),
    "civilian_scream": ("sfx_civilian_scream_TEMP_AI.ogg", "sfx", 2.5),
    "splash": ("sfx_splash_swim_TEMP_AI.ogg", "sfx", 1.0),
    "drown": ("sfx_drown_gurgle_TEMP_AI.ogg", "sfx", 1.0),
    # traffic
    "tire_screech": ("sfx_tire_screech_TEMP_AI.ogg", "sfx", 0.5),
    "car_crash": ("sfx_car_crash_TEMP_AI.ogg", "sfx", 0.3),
    "car_horn": ("sfx_car_horn_TEMP_AI.ogg", "sfx", 1.0),
    "train_horn": ("sfx_train_horn_TEMP_AI.ogg", "sfx", 2.0),
    # UI
    "ui_hover": ("ui_hover_TEMP_AI.ogg", "ui", 0.03),
    "ui_select": ("ui_select_TEMP_AI.ogg", "ui", 0.03),
    "ui_back": ("ui_back_TEMP_AI.ogg", "ui", 0.05),
    "ui_deploy_ok": ("ui_deploy_ok_TEMP_AI.ogg", "ui", 0.05),
    "ui_deny": ("ui_deny_TEMP_AI.ogg", "ui", 0.15),
    "ui_tool_locked": ("ui_tool_locked_TEMP_AI.ogg", "ui", 0.2),
    "ui_unlock": ("ui_unlock_TEMP_AI.ogg", "ui", 0),
    "ui_pause": ("ui_pause_TEMP_AI.ogg", "ui", 0.05),
    "ui_resume": ("ui_resume_TEMP_AI.ogg", "ui", 0.05),
    "ui_speed": ("ui_speed_TEMP_AI.ogg", "ui", 0.05),
    "ui_undo": ("ui_undo_TEMP_AI.ogg", "ui", 0.05),
    "ui_alert": ("ui_alert_TEMP_AI.ogg", "ui", 0.6),
    "ui_vip_lost": ("ui_vip_lost_TEMP_AI.ogg", "ui", 0),
    "ui_briefing": ("ui_briefing_type_TEMP_AI.ogg", "ui", 0),
    "ui_rec_blip": ("ui_rec_blip_TEMP_AI.ogg", "ui", 0.5),
    # radio voice lines
    "vo_lz_established": ("vo_lz_established_TEMP_AI.ogg", "speech", 4.0),
    "vo_barricade_breached": ("vo_barricade_breached_TEMP_AI.ogg", "speech", 4.0),
    "vo_unlock_30": ("vo_snipers_engineers_available_TEMP_AI.ogg", "speech", 0),
    "vo_unlock_60": ("vo_mines_drones_available_TEMP_AI.ogg", "speech", 0),
    "vo_unlock_90": ("vo_artillery_air_available_TEMP_AI.ogg", "speech", 0),
    "vo_friendly_fire": ("vo_friendly_fire_TEMP_AI.ogg", "speech", 4.0),
    "vo_vip_down": ("vo_vip_down_TEMP_AI.ogg", "speech", 0),
    "vo_trojan": ("vo_infected_on_board_TEMP_AI.ogg", "speech", 0),
    "vo_mission_complete": ("vo_mission_complete_TEMP_AI.ogg", "speech", 0),
    "vo_city_fallen": ("vo_city_has_fallen_TEMP_AI.ogg", "speech", 0),
}


class Audio:
    """Plays the game's sound events. Everything degrades to silence: no
    mixer (headless / no device), or missing placeholder files."""

    def __init__(self, volume):
        self.volume = volume                    # callable: channel name -> 0..1
        self.ok = False
        try:
            if not pygame.mixer.get_init():
                pygame.mixer.init()
            pygame.mixer.set_num_channels(32)
            pygame.mixer.set_reserved(len(AMBIENCE_LOOPS))
            self.ok = True
        except pygame.error:
            return
        self.cache = {}
        self.last = {}                          # event -> real time last played
        self.track = None
        self.loops = {}                         # ambience name -> (channel, sound)
        for n, (name, fname) in enumerate(AMBIENCE_LOOPS.items()):
            snd = self.load(fname)
            if snd is not None:
                ch = pygame.mixer.Channel(n)
                ch.play(snd, loops=-1)
                ch.set_volume(0.0)
                self.loops[name] = (ch, snd)

    def load(self, fname):
        if fname not in self.cache:
            path = AUDIO_DIR / fname
            snd = None
            if path.exists():
                try:
                    snd = pygame.mixer.Sound(str(path))
                except pygame.error:
                    snd = None
            self.cache[fname] = snd
        return self.cache[fname]

    def play(self, event, now):
        if not self.ok or event not in SOUNDS:
            return
        fname, channel, gap = SOUNDS[event]
        if now - self.last.get(event, -1e9) < gap:
            return
        self.last[event] = now
        snd = self.load(fname)
        if snd is not None:
            snd.set_volume(self.volume(channel))
            snd.play()

    def music(self, key):
        """Switch the streamed music track (None = silence), with fades."""
        if not self.ok or key == self.track:
            return
        self.track = key
        pygame.mixer.music.fadeout(800)
        path = AUDIO_DIR / MUSIC_TRACKS[key] if key else None
        if path is not None and path.exists():
            try:
                pygame.mixer.music.load(str(path))
                pygame.mixer.music.play(-1, fade_ms=1500)
            except pygame.error:
                pass

    def ambience(self, levels):
        """Set each loop's level (0..1) - the sim decides, sfx volume scales."""
        if not self.ok:
            return
        pygame.mixer.music.set_volume(self.volume("music"))
        master = self.volume("sfx")
        for name, (ch, _) in self.loops.items():
            ch.set_volume(master * levels.get(name, 0.0))


OPTION_ITEMS = [                           # key, label, kind, (min, max) / choices
    ("difficulty", "DIFFICULTY", "choice", ("easy", "medium", "hard")),
    ("colorblind", "COLOR-BLIND PALETTE", "toggle", None),
    ("crt", "CRT FLICKER / NOISE", "toggle", None),
    ("brightness", "SCREEN BRIGHTNESS", "slider", (0.5, 1.5)),
    ("music", "MUSIC VOLUME", "slider", (0.0, 1.0)),
    ("sfx", "EFFECTS VOLUME", "slider", (0.0, 1.0)),
    ("speech", "SPEECH VOLUME", "slider", (0.0, 1.0)),
    ("back", "BACK", "action", None),
]


class App:
    def __init__(self, map_index=0, place=None):
        pygame.init()
        pygame.display.set_caption("ZOMBIE EVAC // CCTV")
        self.screen = pygame.display.set_mode((BASE_W, BASE_H), pygame.RESIZABLE)
        self.set_minimum_window_size(MIN_W, MIN_H)
        self.clock = pygame.time.Clock()
        self.fullscreen = False
        self.windowed_size = (BASE_W, BASE_H)
        self.font_cache = {}
        self.options = {**DEFAULT_OPTIONS, **(read_json(OPTIONS_FILE, {}) or {})}
        if self.options["difficulty"] not in DIFFICULTY:
            self.options["difficulty"] = "medium"
        set_palette(self.options["colorblind"])
        self.audio = Audio(self.volume)
        self.vip_lost_seen = 0
        self.dt = 0.0
        self.game = Game(progress=Progression(PROGRESS_FILE), difficulty=self.options["difficulty"])
        self.map_index = 0
        self.loading = None                      # (name, thread, mission) while downloading
        self.load_result = None
        self.mode = "menu"                       # menu / options / briefing / game
        self.in_game = False                     # a match has been entered (RESUME available)
        self.menu_index = 0
        self.slider_drag = None
        self.story_index = None
        self.briefing_error = None
        self.handled_result = None
        self.save_cache = read_save()
        self.anim_t = 0.0                        # sim-driven animation clock (freezes on pause)
        self.lure_path = None
        self.menu_rects, self.option_bars = [], {}
        self.selected = "evac"
        self.sel = set()                         # selected movable unit ids
        self.drag = None                         # world-space drag start
        self.drag_info = None
        self.frame_no = 0
        self.glow = None
        self.t = 0.0
        self.size = None
        self.relayout()
        self.menu_index = self.first_enabled()
        if place or map_index:                   # command-line map: straight into Endless
            self.mode, self.in_game = "game", True
            if place:
                self.load_map(place.upper(), None)
            else:
                self.map_index = map_index
                self.load_map(*MAP_PRESETS[map_index])

    def volume(self, channel):
        """0..1 for an audio channel: "music", "sfx", "speech" ("ui" follows sfx)."""
        return float(self.options.get("sfx" if channel == "ui" else channel, 0.0))

    def ui_sound(self, event):
        self.audio.play(event, self.t)

    def update_audio(self):
        """Play queued sim sounds; pick the music track; mix the ambience."""
        g, a = self.game, self.audio
        if self.mode == "game":
            for ev in g.sound_events:
                a.play(ev, self.t)
            if g.vip_lost > self.vip_lost_seen:
                a.play("ui_vip_lost", self.t)
                a.play("vo_vip_down", self.t)
        g.sound_events.clear()
        self.vip_lost_seen = g.vip_lost
        n_civ, n_z = g.counts()
        live = self.mode == "game" and g.phase == "running" and not g.paused
        if self.mode in ("menu", "options", "controls"):
            track = "menu"
        elif self.mode == "briefing":
            track = "briefing"
        elif g.phase == "setup":
            track = "deploy"
        elif g.phase == "over":
            track = None
        else:
            share = n_z / max(1, n_civ + n_z)
            track = "match_low" if share < 0.25 else ("match_mid" if share < 0.5 else "match_high")
            goal = g.mission["goal"] if g.mission else {}
            if "survive" in goal and goal["survive"] - g.run_time < 30:
                track = "hold_timer"
        a.music(track)
        in_map = self.mode == "game"
        hit = any(u.kind == "barricade" and g.run_time - u.last_hit < 0.5 for u in g.units.values())
        kinds = [u.kind for u in g.units.values() if u.drop_t <= 0]
        a.ambience(dict(
            city=0.5 if in_map else 0.0,
            sirens=min(1.0, n_z / max(1, n_civ + n_z) * 1.5) if live else 0.0,
            crowd=min(1.0, n_civ / 2500) if live else 0.0,
            horde=min(1.0, n_z / 1500) if in_map else 0.0,
            water=0.4 if in_map and g.city.water.any() else 0.0,
            fire=min(1.0, len(g.fires) / 3) if live else 0.0,
            rotor=min(1.0, 0.4 * kinds.count("evac")) if in_map else 0.0,
            gunship=min(1.0, 0.5 * kinds.count("chopper")) if live else 0.0,
            drone=0.6 if live and g.drones else 0.0,
            barricade_hit=0.7 if live and hit else 0.0,
            traffic=min(1.0, int((g.car_state == CAR_DRIVING).sum()) / 30) if live else 0.0,
            train=0.8 if live and any(t.head is not None for t in g.trains) else 0.0,
            cctv=0.25 if self.options["crt"] else 0.0,
        ))
        if live and int(self.t) != int(self.t - self.dt):        # REC light blinks
            a.play("ui_rec_blip", self.t)

    @staticmethod
    def set_minimum_window_size(w, h):
        # pygame-ce exposes the SDL window; older pygame silently skips this.
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", DeprecationWarning)
                pygame.Window.from_display_module().minimum_size = (w, h)
        except Exception:
            pass

    def toggle_fullscreen(self):
        self.fullscreen = not self.fullscreen
        if self.fullscreen:
            self.windowed_size = self.screen.get_size()
            self.screen = pygame.display.set_mode((0, 0), pygame.FULLSCREEN)
        else:
            self.screen = pygame.display.set_mode(self.windowed_size, pygame.RESIZABLE)
            self.set_minimum_window_size(MIN_W, MIN_H)
        self.relayout()

    # ---- maps -----------------------------------------------------------

    def load_map(self, name, latlon, half_width=None, mission=None, timeout=None):
        """Procedural maps build instantly; real maps download in a
        background thread (the current city stays playable meanwhile)."""
        if self.loading:
            return
        if name == "PROCEDURAL":
            self.set_city(City.procedural(random.randrange(1 << 30)))
            return

        def work():
            try:
                self.load_result = ("ok", fetch_osm(name, latlon, half_width, timeout))
            except Exception as e:               # network / geocoding / missing osmnx
                msg = str(e).splitlines()[0] if str(e) else type(e).__name__
                if "Connection" in msg or "Max retries" in msg:
                    msg = "OpenStreetMap server unreachable"
                self.load_result = ("error", msg[:60])

        self.load_result = None
        self.briefing_error = None
        thread = threading.Thread(target=work, daemon=True)
        self.loading = (name, thread, mission)
        thread.start()

    def poll_loading(self):
        if not self.loading or self.load_result is None:
            return
        status, payload = self.load_result
        mission = self.loading[2]
        self.loading = self.load_result = None
        if status == "ok":
            self.set_city(City.from_osm(payload), mission)
        else:
            self.briefing_error = payload
            self.game.flash_message(f"Map load failed: {payload}", 6)

    def set_city(self, city, mission=None):
        self.game.set_city(city, mission=mission)
        self.cancel()
        city.render(self.s)

    # ---- modes ----------------------------------------------------------

    def start_endless(self):
        self.story_index = None
        self.set_city(City.procedural(random.randrange(1 << 30)))
        self.mode, self.in_game = "game", True

    def start_story(self, index):
        """Mission briefing; the mission map loads (or downloads) meanwhile."""
        m = CAMPAIGN[index]
        self.story_index = index
        self.mode = "briefing"
        self.ui_sound("ui_briefing")
        if self.game.mission is not m:
            self.load_map(m["map"]["name"], m["map"]["latlon"], m["map"]["half_width"], mission=m,
                          timeout=m["map"].get("timeout"))

    def briefing_ready(self):
        return (self.story_index is not None and not self.loading
                and self.game.mission is CAMPAIGN[self.story_index])

    def new_story(self):
        write_json(SAVE_FILE, dict(mission=0, completed=[]))
        self.save_cache = read_save()
        self.start_story(0)

    def open_menu(self):
        g = self.game
        if g.phase == "running":
            g.paused = True
        self.cancel()
        self.save_cache = read_save()
        self.mode = "menu"
        self.menu_index = self.first_enabled()

    def handle_mission_result(self):
        """Story: record a completed mission and unlock the next one."""
        g = self.game
        self.handled_result = g.result
        if g.result and g.result["success"]:
            save = read_save() or dict(mission=0, completed=[])
            m = g.mission
            if m["id"] not in save["completed"]:
                save["completed"].append(m["id"])
            save["mission"] = min(self.story_index + 1, len(CAMPAIGN) - 1)
            if self.story_index + 1 == len(CAMPAIGN):
                self.ui_sound("campaign_complete")
            write_json(SAVE_FILE, save)
            self.save_cache = read_save()

    # ---- layout ---------------------------------------------------------

    def font(self, size):
        size = max(10, int(size))
        if size not in self.font_cache:
            self.font_cache[size] = pygame.font.SysFont(FONT_NAMES, size, bold=True)
        return self.font_cache[size]

    def relayout(self):
        """Recompute every screen-space size from the current window size."""
        self.screen = pygame.display.get_surface()
        W, H = self.screen.get_size()
        self.size = (W, H)
        u = max(0.4, min(H / BASE_H, W / BASE_W))
        while True:
            self.u = u
            self.font_big = self.font(36 * u)
            self.font_med = self.font(25 * u)
            self.font_small = self.font(21 * u)
            panel_min = int(PANEL_MIN * u)
            s = max(0.1, min(H / WORLD_H, (W - panel_min) / WORLD_W))
            map_w, map_h = int(WORLD_W * s), int(WORLD_H * s)
            self.panel_w = min(W - map_w, int(PANEL_MAX * u))
            self.panel_x = W - self.panel_w
            if self.layout_panel(H) <= H or u <= 0.4:
                break
            u *= 0.95
        self.s = s
        self.lw = max(1, round(s))
        self.map_rect = pygame.Rect((self.panel_x - map_w) // 2, (H - map_h) // 2, map_w, map_h)
        self.game.city.render(s)
        self.map_surf = pygame.Surface((map_w, map_h)).convert()
        self.dyn = pygame.Surface((map_w, map_h)).convert()     # glowing layer
        self.fx = pygame.Surface((map_w, map_h), pygame.SRCALPHA)
        self.glow = None
        self.shade = pygame.Surface((map_w, map_h), pygame.SRCALPHA)
        self.shade.fill((*COL_BG, 190))
        self.build_backdrop(W, H)

    def layout_panel(self, H):
        """Position panel widgets; returns the height the content needs."""
        u = self.u
        self.pad = pad = int(14 * u)
        gap = self.gap = max(2, int(5 * u))
        self.ui_lw = max(3, round(3 * u))        # chunky UI borders
        x = self.panel_x + pad + self.ui_lw     # clear the panel's divider line
        w = self.panel_x + self.panel_w - pad - x
        big, med, small = (f.get_linesize() for f in (self.font_big, self.font_med, self.font_small))
        y = pad
        self.title_y = y
        y += big
        self.cp_y = y
        y += med + gap
        self.sep_y = y
        y += 2 * gap
        row_h = small + gap
        self.unit_buttons = {}
        for k in UNIT_ORDER:
            self.unit_buttons[k] = pygame.Rect(x, y, w, row_h)
            y += row_h + max(1, gap // 3)
        y += gap
        self.info_y = y
        y += 2 * small + 2 * gap
        unit_w = (w - 5 * gap) / 6.6               # UNDO is 1.6x wider than the others
        self.time_buttons = []
        bx = x
        for val in ["undo", "pause"] + SPEEDS:
            bw = int(unit_w * (1.6 if val == "undo" else 1))
            self.time_buttons.append((val, pygame.Rect(bx, y, bw, med + 2 * gap)))
            bx += bw + gap
        y += med + 4 * gap
        self.stats_y = y
        y += 7 * small
        bottom_h = small
        self.help_y = H - pad - bottom_h
        return y + 2 * gap + bottom_h + pad

    def build_backdrop(self, W, H):
        """Static layers: grid behind the map, chunky frame, and a few CCTV
        overlay frames (scanlines + vignette + noise) cycled for grain."""
        bg = pygame.Surface((W, H))
        bg.fill(COL_BG)
        mr = self.map_rect
        step = max(8, int(40 * self.s))
        for yy in range(mr.y % step, H, step):
            for xx in range(mr.x % step, self.panel_x, step):
                bg.set_at((xx, yy), COL_GRIDLINE)
        self.menu_shade = pygame.Surface((W, H), pygame.SRCALPHA)
        self.menu_shade.fill((*COL_BG, 215))
        frame = mr.inflate(2 * self.ui_lw + 2, 2 * self.ui_lw + 2)
        pygame.draw.rect(bg, COL_CYAN, frame, self.ui_lw)
        self.backdrop = bg

        xs = (np.arange(W) - W / 2) / (W / 2)
        ys = (np.arange(H) - H / 2) / (H / 2)
        r = np.sqrt(xs[:, None] ** 2 + ys[None, :] ** 2)
        base = np.clip((r - 0.65) / 0.75, 0, 1) ** 2 * 170
        base[:, ::3] += 60
        base[:, 1::3] += 25
        rng = np.random.default_rng(1)
        self.crt_static = pygame.Surface((W, H), pygame.SRCALPHA)   # flicker/noise off
        self.crt_static.fill((0, 0, 0, 0))
        a = pygame.surfarray.pixels_alpha(self.crt_static)
        a[:] = np.clip(base, 0, 255).astype(np.uint8)
        del a
        self.crt_frames = []
        for _ in range(3):
            crt = pygame.Surface((W, H), pygame.SRCALPHA)
            crt.fill((0, 0, 0, 0))
            a = pygame.surfarray.pixels_alpha(crt)
            a[:] = np.clip(base + rng.normal(0, 14, (W, H)), 0, 255).astype(np.uint8)
            del a
            self.crt_frames.append(crt)
        self.roll_bar = pygame.Surface((W, max(8, H // 10)), pygame.SRCALPHA)
        bh = self.roll_bar.get_height()
        for yy in range(bh):
            alpha = int(14 * math.sin(math.pi * yy / bh))
            pygame.draw.line(self.roll_bar, (*COL_WHITE, alpha), (0, yy), (W, yy))

    def screen_to_world(self, pos, clamp=False):
        mr = self.map_rect
        if not clamp and not mr.collidepoint(pos):
            return None
        x = min(max((pos[0] - mr.x) / self.s, 0.0), WORLD_W - 0.01)
        y = min(max((pos[1] - mr.y) / self.s, 0.0), WORLD_H - 0.01)
        return x, y

    # ---- input ----------------------------------------------------------

    def selected_units(self):
        units = self.game.units
        self.sel = {i for i in self.sel if i in units}
        return [units[i] for i in sorted(self.sel)]

    def cancel(self):
        self.drag, self.sel, self.lure_path = None, set(), None

    # menu / options / briefing input ------------------------------------

    def menu_items(self):
        save = self.save_cache
        items = []
        if self.in_game:
            items.append(("RESUME", "resume", True))
        if save:
            i = save["mission"]
            items.append((f"CONTINUE - M{i + 1} {CAMPAIGN[i]['title']}", "continue", True))
        else:
            items.append(("CONTINUE", "continue", False))
        items += [("NEW GAME - STORY MODE", "story", True), ("ENDLESS MODE", "endless", True),
                  ("CONTROLS", "controls", True), ("OPTIONS", "options", True), ("QUIT", "quit", True)]
        return items

    def first_enabled(self):
        return next((i for i, it in enumerate(self.menu_items()) if it[2]), 0)

    def menu_activate(self, action):
        self.ui_sound("ui_select")
        if action == "resume":
            self.mode = "game"
        elif action == "continue":
            self.start_story(self.save_cache["mission"])
        elif action == "story":
            self.new_story()
        elif action == "endless":
            self.start_endless()
        elif action == "options":
            self.mode, self.menu_index = "options", 0
        elif action == "controls":
            self.mode = "controls"
        elif action == "quit":
            return False
        return True

    def set_option(self, key, value):
        self.options[key] = value
        if key == "colorblind":
            set_palette(value)
        if key == "difficulty":                  # next match (right away if nothing's started)
            self.game.difficulty = value
            if self.game.phase == "setup":
                self.game.reset()

    def option_step(self, index, direction):
        key, _, kind, rng = OPTION_ITEMS[index]
        self.ui_sound("ui_select")
        if kind == "toggle":
            self.set_option(key, not self.options[key])
        elif kind == "choice":
            i = rng.index(self.options[key])
            self.set_option(key, rng[(i + direction) % len(rng)])
        elif kind == "slider":
            lo, hi = rng
            self.set_option(key, round(min(hi, max(lo, self.options[key] + 0.1 * direction)), 2))
        elif key == "back":
            self.leave_options()

    def leave_options(self):
        write_json(OPTIONS_FILE, self.options)
        self.mode = "menu"
        self.menu_index = self.first_enabled()

    def slider_set(self, index, mx):
        key, _, _, (lo, hi) = OPTION_ITEMS[index]
        bar = self.option_bars[index]
        t = min(1.0, max(0.0, (mx - bar.x) / max(1, bar.w)))
        self.set_option(key, round(lo + (hi - lo) * t, 2))

    def handle_menu_event(self, ev):
        before, mode = self.menu_index, self.mode
        keep = self.menu_event(ev)
        if self.mode == mode and self.menu_index != before:
            self.ui_sound("ui_hover")
        return keep

    def menu_event(self, ev):
        options = self.mode == "options"
        items = OPTION_ITEMS if options else self.menu_items()
        enabled = [True] * len(items) if options else [it[2] for it in items]
        if ev.type == pygame.KEYDOWN:
            if ev.key in (pygame.K_UP, pygame.K_w, pygame.K_DOWN, pygame.K_s):
                d = -1 if ev.key in (pygame.K_UP, pygame.K_w) else 1
                for _ in range(len(items)):
                    self.menu_index = (self.menu_index + d) % len(items)
                    if enabled[self.menu_index]:
                        break
            elif options and ev.key in (pygame.K_LEFT, pygame.K_a, pygame.K_RIGHT, pygame.K_d):
                self.option_step(self.menu_index, -1 if ev.key in (pygame.K_LEFT, pygame.K_a) else 1)
            elif ev.key in (pygame.K_RETURN, pygame.K_KP_ENTER, pygame.K_SPACE):
                if options:
                    self.option_step(self.menu_index, 1)
                elif enabled[self.menu_index]:
                    return self.menu_activate(items[self.menu_index][1])
            elif ev.key == pygame.K_ESCAPE:
                self.ui_sound("ui_back")
                if options:
                    self.leave_options()
                elif self.in_game:
                    self.mode = "game"
            elif ev.key == pygame.K_F11:
                self.toggle_fullscreen()
        elif ev.type == pygame.MOUSEMOTION:
            for i, r in enumerate(self.menu_rects):
                if r.collidepoint(ev.pos) and enabled[i]:
                    self.menu_index = i
            if self.slider_drag is not None and ev.buttons[0]:
                self.slider_set(self.slider_drag, ev.pos[0])
        elif ev.type == pygame.MOUSEBUTTONDOWN and ev.button == 1:
            for i, r in enumerate(self.menu_rects):
                if r.collidepoint(ev.pos) and enabled[i]:
                    self.menu_index = i
                    if options and OPTION_ITEMS[i][2] == "slider":
                        self.slider_drag = i
                        self.slider_set(i, ev.pos[0])
                    elif options:
                        self.option_step(i, 1)
                    else:
                        return self.menu_activate(items[i][1])
        elif ev.type == pygame.MOUSEBUTTONUP:
            self.slider_drag = None
        return True

    def handle_briefing_event(self, ev):
        go = (ev.type == pygame.KEYDOWN and ev.key in (pygame.K_RETURN, pygame.K_KP_ENTER, pygame.K_SPACE)) \
            or (ev.type == pygame.MOUSEBUTTONDOWN and ev.button == 1)
        if ev.type == pygame.KEYDOWN and ev.key == pygame.K_ESCAPE:
            self.open_menu()
        elif go and self.briefing_ready():
            self.mode, self.in_game = "game", True
        elif go and self.briefing_error and not self.loading:
            self.briefing_error = None
            m = CAMPAIGN[self.story_index]["map"]
            self.load_map(m["name"], m["latlon"], m["half_width"], mission=CAMPAIGN[self.story_index],
                          timeout=m.get("timeout"))
        return True

    # in-game input ------------------------------------------------------

    def handle_event(self, ev):
        g = self.game
        if ev.type == pygame.QUIT:
            return False
        if self.mode == "controls":
            if (ev.type == pygame.KEYDOWN and ev.key in (pygame.K_ESCAPE, pygame.K_RETURN, pygame.K_SPACE,
                                                       pygame.K_KP_ENTER, pygame.K_BACKSPACE)) \
                    or (ev.type == pygame.MOUSEBUTTONDOWN and ev.button == 1):
                self.mode = "menu"
            return True
        if self.mode in ("menu", "options"):
            return self.handle_menu_event(ev)
        if self.mode == "briefing":
            return self.handle_briefing_event(ev)
        story = g.mission is not None
        if ev.type == pygame.KEYDOWN:
            ctrl = ev.mod & (pygame.KMOD_CTRL | pygame.KMOD_META)
            tool_keys = {getattr(pygame, f"K_{k.lower()}"): i for i, k in enumerate(UNIT_KEYS)}
            if ev.key == pygame.K_ESCAPE:
                if self.drag or self.sel or self.lure_path:
                    self.cancel()
                else:
                    self.open_menu()
            elif ctrl and ev.key == pygame.K_z:
                g.undo()
                self.selected_units()
            elif ctrl and ev.key == pygame.K_a:
                self.drag = None
                self.sel = {u.id for u in g.movables()}
                if not self.sel:
                    g.flash_message("No movable units deployed")
            elif ev.key == pygame.K_F11:
                self.toggle_fullscreen()
            elif ev.key in tool_keys and not ctrl:
                self.selected = UNIT_ORDER[tool_keys[ev.key]]
                self.cancel()
                self.ui_sound("ui_select")
            elif ev.key == pygame.K_SPACE:
                g.toggle_pause()
            elif ev.key in (pygame.K_f, pygame.K_EQUALS, pygame.K_PLUS, pygame.K_KP_PLUS):
                i = SPEEDS.index(g.time_scale)
                g.set_speed(SPEEDS[(i + 1) % len(SPEEDS)] if ev.key == pygame.K_f
                            else SPEEDS[min(i + 1, len(SPEEDS) - 1)])
            elif ev.key in (pygame.K_MINUS, pygame.K_KP_MINUS):
                g.set_speed(SPEEDS[max(SPEEDS.index(g.time_scale) - 1, 0)])
            elif ev.key == pygame.K_r:
                g.reset()
                self.cancel()
            elif ev.key in (pygame.K_RETURN, pygame.K_KP_ENTER) and story and g.phase == "over":
                if g.result["success"] and self.story_index + 1 < len(CAMPAIGN):
                    self.start_story(self.story_index + 1)
                else:
                    g.reset()
            elif ev.key == pygame.K_n and not story:
                if g.city.name == "PROCEDURAL":
                    self.set_city(City.procedural(random.randrange(1 << 30)))
                else:
                    g.new_outbreak()
                    self.cancel()

        if ev.type == pygame.MOUSEBUTTONDOWN:
            if ev.pos[0] >= self.panel_x:
                if ev.button == 1:
                    self.click_panel(ev.pos)
                return True
            w = self.screen_to_world(ev.pos)
            if w is None:
                return True
            if ev.button == 1:
                self.left_click(w)
            elif ev.button == 3:
                if self.drag or self.sel or self.lure_path:
                    self.cancel()
                else:
                    g.remove_near(*w)
        if ev.type == pygame.MOUSEMOTION and self.lure_path is not None:
            w = self.screen_to_world(ev.pos, clamp=True)
            last = self.lure_path[-1]
            if math.hypot(w[0] - last[0], w[1] - last[1]) > 8:
                self.lure_path.append(w)
        if ev.type == pygame.MOUSEBUTTONUP and ev.button == 1:
            if self.drag and self.selected == "bombing":
                w = self.screen_to_world(ev.pos, clamp=True)
                self.deploy(g.deploy_line, self.selected, *self.drag, *w)
                self.drag = None
            elif self.lure_path is not None:
                self.deploy(g.deploy_path, "lure", self.lure_path)
                self.lure_path = None
        return True

    def deploy(self, fn, *args):
        """Run a deploy call and answer it with a confirm or deny blip (the
        deny replaces the generic alert its refusal message queued)."""
        g = self.game
        before = (g.cp, len(g.units), len(g.shells), len(g.bombers), len(g.drones))
        n = len(g.sound_events)
        fn(*args)
        if (g.cp, len(g.units), len(g.shells), len(g.bombers), len(g.drones)) != before:
            self.ui_sound("ui_deploy_ok")
        elif len(g.sound_events) > n:
            new = [e for e in g.sound_events[n:] if e != "ui_alert"]
            g.sound_events[n:] = new
            if "ui_tool_locked" not in new:
                self.ui_sound("ui_deny")

    def left_click(self, w):
        g = self.game
        if self.drag and self.selected == "barricade":
            self.deploy(g.deploy_line, "barricade", *self.drag, *w)   # second click: place
            self.drag = None
            return
        movers = self.selected_units()
        choppers = [u for u in movers if u.kind == "chopper"]
        if choppers:                                      # escort a unit / VIP
            tgt = g.escort_target_at(*w)
            if tgt is not None:
                g.set_escort(choppers, tgt)
                others = [u for u in movers if u.kind != "chopper"]
                if others:
                    g.group_move(others, *g.escort_pos(tgt))
                return
        unit_here = g.movable_at(*w)
        if unit_here is not None:                         # (de)select one unit
            self.sel = set() if self.sel == {unit_here.id} else {unit_here.id}
        elif movers:
            g.group_move(movers, *w)
        elif UNIT_SPECS[self.selected]["mode"] == "path":
            self.lure_path = [w]                          # freehand lure-drone route
        elif UNIT_SPECS[self.selected]["mode"] == "drag":
            self.drag = w                                 # barricade anchor / bomb-run start
        else:
            self.deploy(g.deploy_point, self.selected, *w)

    def click_panel(self, pos):
        g = self.game
        for k, rect in self.unit_buttons.items():
            if rect.collidepoint(pos):
                self.selected = k
                self.cancel()
                self.ui_sound("ui_select")
        for val, rect in self.time_buttons:
            if rect.collidepoint(pos):
                if val == "undo":
                    g.undo()
                    self.selected_units()
                elif val == "pause":
                    if g.phase == "running" and not g.paused:
                        g.paused = True
                        g.sound("ui_pause")
                else:
                    g.set_speed(val)

    # ---- drawing --------------------------------------------------------

    def text(self, s, pos, font, color=COL_WHITE, anchor="topleft", bg=None):
        img = font.render(s, True, color, bg)
        r = img.get_rect(**{anchor: pos})
        self.screen.blit(img, r)
        return r

    def blink(self, hz=2.0):
        return (self.t * hz) % 1.0 < 0.5

    def draw(self):
        self.frame_no += 1
        self.screen.blit(self.backdrop, (0, 0))
        self.draw_map()
        self.draw_cctv_hud()
        self.draw_panel()
        g, mr = self.game, self.map_rect
        if self.mode in ("menu", "options"):
            self.screen.blit(self.menu_shade, (0, 0))
            self.draw_menu()
        elif self.mode == "controls":
            self.screen.blit(self.menu_shade, (0, 0))
            self.draw_controls()
        elif self.mode == "briefing":
            self.screen.blit(self.menu_shade, (0, 0))
            self.draw_briefing()
        elif g.phase == "over":
            self.draw_game_over()
        elif g.paused and self.blink(1.5):
            self.text("// PAUSED //", mr.center, self.font_big, COL_YELLOW, "center")
        # CCTV overlay: grain frame, rolling bar, scanlines + vignette.
        if self.options["crt"]:
            H = self.size[1]
            bar_y = int((self.t * 0.12 % 1.0) * (H + self.roll_bar.get_height())) - self.roll_bar.get_height()
            self.screen.blit(self.roll_bar, (0, bar_y))
            self.screen.blit(self.crt_frames[self.frame_no % len(self.crt_frames)], (0, 0))
        else:
            self.screen.blit(self.crt_static, (0, 0))
        b = self.options["brightness"]           # accessibility brightness
        if b < 0.99:
            m = int(255 * b)
            self.screen.fill((m, m, m), special_flags=pygame.BLEND_RGB_MULT)
        elif b > 1.01:
            k = int(90 * (b - 1))
            self.screen.fill((k, k, k), special_flags=pygame.BLEND_RGB_ADD)

    # ---- menus ----------------------------------------------------------

    def draw_menu(self):
        """Main menu / options over the dimmed CCTV feed."""
        W, H = self.size
        u = self.u
        cx = W // 2
        title = self.font(70 * u)
        y = int(H * 0.12)
        self.text("ZOMBIE EVAC", (cx, y), title, COL_WHITE, "midtop")
        y += title.get_linesize()
        sub = "OPTIONS" if self.mode == "options" else "OUTBREAK RESPONSE COMMAND // CCTV LINK"
        self.text(sub, (cx, y), self.font_med if self.mode == "options" else self.font_small,
                  COL_YELLOW if self.mode == "options" else COL_WHITE_DIM, "midtop")
        y += int(self.font_med.get_linesize() * 1.8)
        bw, bh, gap = int(560 * u), self.font_med.get_linesize() + int(14 * u), int(10 * u)
        self.menu_rects, self.option_bars = [], {}
        if self.mode == "options":
            for i, (key, label, kind, rng) in enumerate(OPTION_ITEMS):
                r = pygame.Rect(cx - bw // 2, y, bw, bh)
                self.menu_rects.append(r)
                sel = i == self.menu_index
                pygame.draw.rect(self.screen, COL_YELLOW if sel else COL_CYAN, r, self.ui_lw)
                col = COL_YELLOW if sel else COL_WHITE
                self.text(("> " if sel else "  ") + label, (r.x + int(14 * u), r.centery), self.font_small, col, "midleft")
                if kind == "toggle":
                    on = self.options[key]
                    self.text("[ON]" if on else "[OFF]", (r.right - int(14 * u), r.centery), self.font_small,
                              COL_YELLOW if on else COL_WHITE_DIM, "midright")
                elif kind == "choice":
                    self.text(f"< {self.options[key].upper()} >", (r.right - int(14 * u), r.centery),
                              self.font_small, COL_YELLOW, "midright")
                elif kind == "slider":
                    lo, hi = rng
                    t = (self.options[key] - lo) / (hi - lo)
                    bar = pygame.Rect(r.x + int(bw * 0.55), r.centery - int(6 * u), int(bw * 0.3), int(12 * u))
                    self.option_bars[i] = bar
                    pygame.draw.rect(self.screen, COL_GRIDLINE, bar)
                    self.screen.fill(COL_BLUE, (bar.x, bar.y, int(bar.w * t), bar.h))
                    pygame.draw.rect(self.screen, col, bar, max(1, self.ui_lw - 1))
                    self.text(f"{int(round(self.options[key] * 100))}%", (r.right - int(14 * u), r.centery),
                              self.font_small, col, "midright")
                y += bh + gap
            hint = "UP/DOWN SELECT   LEFT/RIGHT ADJUST   ESC BACK"
            note = "DIFFICULTY APPLIES FROM THE NEXT MATCH"
        else:
            for i, (label, action, enabled) in enumerate(self.menu_items()):
                r = pygame.Rect(cx - bw // 2, y, bw, bh)
                self.menu_rects.append(r)
                sel = i == self.menu_index and enabled
                border = COL_YELLOW if sel else (COL_CYAN if enabled else COL_GRIDLINE)
                if sel:
                    self.screen.fill(mix(COL_BG, COL_YELLOW, 0.18), r)
                pygame.draw.rect(self.screen, border, r, self.ui_lw)
                col = COL_YELLOW if sel else (COL_WHITE if enabled else COL_WHITE_DIM)
                self.text(label, r.center, self.font_med if len(label) < 28 else self.font_small, col, "center")
                y += bh + gap
            hint = "UP/DOWN SELECT   ENTER CONFIRM" + ("   ESC RESUME" if self.in_game else "")
            note = "MAP DATA (C) OPENSTREETMAP CONTRIBUTORS (ODBL)"
        self.text(hint, (cx, H - int(60 * u)), self.font_small, COL_WHITE_DIM, "midbottom")
        self.text(note, (cx, H - int(30 * u)), self.font_small, COL_WHITE_DIM, "midbottom")

    def draw_controls(self):
        """Controls reference (from the main menu or the pause menu)."""
        W, H = self.size
        u = self.u
        cx = W // 2
        title = self.font(52 * u)
        y = int(H * 0.06)
        self.text("CONTROLS", (cx, y), title, COL_WHITE, "midtop")
        y += title.get_linesize() + int(10 * u)
        small, med = self.font_small, self.font_med
        key_w = max(small.size(k)[0] for k, a in CONTROLS if a) + int(30 * u)
        act_w = max(small.size(a)[0] for k, a in CONTROLS if a)
        box = pygame.Rect(0, y, key_w + act_w + 4 * self.pad, 0)
        box.centerx = cx
        rows_h = sum(med.get_linesize() if a is None else small.get_linesize() for k, a in CONTROLS)
        box.h = rows_h + 2 * self.pad
        self.screen.fill(COL_BG, box)
        pygame.draw.rect(self.screen, COL_CYAN, box, self.ui_lw)
        yy = box.y + self.pad
        for keys, action in CONTROLS:
            if action is None:
                self.text(keys, (box.x + 2 * self.pad, yy), med, COL_CYAN)
                yy += med.get_linesize()
            else:
                self.text(keys, (box.x + 2 * self.pad, yy), small, COL_YELLOW)
                self.text(action, (box.x + 2 * self.pad + key_w, yy), small, COL_WHITE)
                yy += small.get_linesize()
        self.text("ESC / ENTER / CLICK: BACK", (cx, min(H - int(20 * u), box.bottom + int(28 * u))),
                  small, COL_WHITE_DIM, "midbottom")

    def draw_briefing(self):
        """Story mission briefing (the mission map loads behind it)."""
        m = CAMPAIGN[self.story_index]
        W, H = self.size
        u = self.u
        big, med, small = self.font_big, self.font_med, self.font_small
        lines = [(f"MISSION {self.story_index + 1} OF {len(CAMPAIGN)}", small, COL_WHITE_DIM),
                 (m["title"], big, COL_WHITE), (m["location"], small, COL_CYAN), ("", small, COL_BG),
                 *[(t, small, COL_WHITE) for t in m["briefing"]], ("", small, COL_BG)]
        goals, rules = mission_objectives(m, self.options["difficulty"])
        lines += [("OBJECTIVES", med, COL_YELLOW)] + [("> " + t, small, COL_YELLOW) for t in goals]
        lines += [(t, small, COL_WHITE) for t in rules]
        eff = apply_difficulty(m, self.options["difficulty"])
        lines.append((f"POPULATION {m['population']:,}   INFECTED {eff['infected'] * 100:.0f}%   "
                      f"CP {eff['cp']:,}"
                      + (f"   VIPS {m['vips']}" if m.get("vips") else "")
                      + f"   {self.options['difficulty'].upper()}", small, COL_WHITE_DIM))
        if self.loading:
            status = ("DOWNLOADING MAP DATA" + "." * (int(self.t * 3) % 4), COL_YELLOW)
        elif self.briefing_error:
            status = (f"MAP LOAD FAILED: {self.briefing_error.upper()} - ENTER: RETRY", COL_RED)
        elif self.briefing_ready():
            status = ("ENTER / CLICK: DEPLOY        ESC: MENU", COL_YELLOW if self.blink(1.0) else COL_WHITE)
        else:
            status = ("PREPARING...", COL_WHITE_DIM)
        lines.append(("", small, COL_BG))
        lines.append((status[0], small, status[1]))
        gap = int(6 * u)
        width = max(f.size(t)[0] for t, f, _ in lines) + 6 * self.pad
        height = sum(f.get_linesize() + gap for _, f, _ in lines) + 3 * self.pad
        box = pygame.Rect(0, 0, min(width, W - 20), height)
        box.center = (W // 2, H // 2)
        self.screen.fill(COL_BG, box)
        pygame.draw.rect(self.screen, COL_YELLOW, box, self.ui_lw)
        y = box.y + int(1.5 * self.pad)
        for t, f, col in lines:
            if t:
                self.text(t, (box.centerx, y), f, col, "midtop")
            y += f.get_linesize() + gap

    def draw_cctv_hud(self):
        g, mr, u = self.game, self.map_rect, self.u
        pad = int(10 * u)
        small = self.font_small
        stamp = datetime.date.today().isoformat()
        clock = f"{int(g.run_time // 3600):02d}:{int(g.run_time // 60) % 60:02d}:{int(g.run_time) % 60:02d}"
        label = f"CAM-{g.seed % 100:02d}  {g.city.name}"
        self.text(f" {label} ", (mr.x + pad, mr.y + pad), small, COL_WHITE, bg=COL_BG)
        r = self.text(" REC ", (mr.right - pad, mr.y + pad), small, COL_WHITE, "topright", bg=COL_BG)
        if g.phase == "running" and not g.paused and self.blink(1.0) or g.phase != "running":
            pygame.draw.circle(self.screen, COL_RED, (r.x + int(6 * u), r.centery), max(3, int(5 * u)))
        self.text(f" {stamp} {clock} ", (mr.x + pad, mr.bottom - pad), small, COL_WHITE, "bottomleft",
                  bg=COL_BG)
        if self.loading:
            dots = "." * (int(self.t * 3) % 4)
            msg = f"DOWNLOADING OSM: {self.loading[0]}{dots}"
        elif g.phase == "setup":
            msg = "STANDBY - DEPLOY, THEN PLAY"
        elif g.phase == "running" and not g.lzs:
            msg = "NO EVAC LZ - CIVILIANS PANICKING"
        else:
            msg = None
        if msg and (self.loading or self.blink(0.8)):
            r = self.text(f" {msg} ", (mr.centerx, mr.y + 2 * pad + small.get_linesize()),
                          self.font_med, COL_YELLOW, "midtop", bg=COL_BG)
            pygame.draw.rect(self.screen, COL_YELLOW, r.inflate(6, 6), self.ui_lw)

    def draw_map(self):
        g, s, lw = self.game, self.s, self.lw
        ms, fx = self.map_surf, self.fx
        city = g.city
        if city.surface_dirty:                   # buildings restored: full re-render
            city.render(s)
        elif city.rubble_new:                    # fresh rubble: paint just those cells
            city.paint_rubble(city.surface, s, city.rubble_new)
            city.rubble_new = []
        ms.blit(city.surface, (0, 0))
        riders = np.bincount(g.in_car[g.state == IN_CAR], minlength=g.car_state.size)
        key = (id(g), g.car_version, s, ms.get_size())   # parked cars and wrecks: cached layer
        if getattr(self, "still_cars_key", None) != key:
            layer = pygame.Surface(ms.get_size())
            layer.fill((0, 0, 0))
            layer.set_colorkey((0, 0, 0))
            for state, col in ((CAR_PARKED, mix(COL_BG, COL_WHITE, 0.6)), (CAR_WRECK, mix(COL_BG, COL_WHITE, 0.4)),
                               (CAR_BURNT, mix(COL_BG, COL_WHITE, 0.2))):
                self.draw_cars(layer, g, np.flatnonzero(g.car_state == state), col, riders)
            self.still_cars, self.still_cars_key = layer, key
        ms.blit(self.still_cars, (0, 0))

        def P(x, y):
            return int(x * s), int(y * s)

        def R(r, lo=1):
            return max(lo, int(r * s))

        hover = self.screen_to_world(pygame.mouse.get_pos())
        chosen = self.selected_units()

        # -- translucent range rings, LZ pads, squad links (not bloomed) --
        rings = [u for u in g.units.values() if u.range and (
            g.phase == "setup" or u in chosen or (hover and math.hypot(hover[0] - u.x, hover[1] - u.y) < 15))]
        fx.fill((0, 0, 0, 0))
        for u in rings:
            r = R(u.range + u.spec.get("orbit", 0))
            pygame.draw.circle(fx, (*u.spec["color"], 16), P(u.x, u.y), r)
            pygame.draw.circle(fx, (*u.spec["color"], 90), P(u.x, u.y), r, lw)
        k = max(1, round(CELL * s))
        allowed = g.build_zones.get(self.selected)
        if allowed is not None:                  # mission build zone for the selected tool
            if getattr(self, "zone_key", None) != (id(allowed), s):
                zone = pygame.Surface((ms.get_width(), ms.get_height()), pygame.SRCALPHA)
                for c in np.flatnonzero(allowed & g.city.walk_flat):
                    zone.fill((*COL_BLUE, 60), (int((c % GW) * CELL * s), int((c // GW) * CELL * s), k, k))
                self.zone_surf, self.zone_key = zone, (id(allowed), s)
            fx.blit(self.zone_surf, (0, 0))
        for u in g.lzs:
            for c in u.zone:
                fx.fill((*COL_BLUE, 70), (int((c % GW) * CELL * s), int((c // GW) * CELL * s), k, k))
        for f in g.fires:                        # incendiary pools
            flick = 0.75 + 0.25 * math.sin(self.anim_t * 9 + f.x)
            fade = min(1.0, f.t / 2.0)
            pygame.draw.circle(fx, (*COL_YELLOW, int(70 * flick * fade)), P(f.x, f.y), R(f.r))
            pygame.draw.circle(fx, (*COL_RED, int(110 * flick * fade)), P(f.x, f.y), R(f.r * 0.6))
        for d in g.drones:                       # lure radius: what the horde can "hear"
            if g.phase == "running":
                pulse = 0.5 + 0.5 * math.sin(self.anim_t * 4)
                pygame.draw.circle(fx, (*COL_YELLOW, int(14 + 16 * pulse)), P(*d.pos), R(LURE_RADIUS))
                pygame.draw.circle(fx, (*COL_YELLOW, 120), P(*d.pos), R(LURE_RADIUS), lw)
        squads = [u for u in g.units.values() if u.kind == "infantry"]
        for u in squads:                         # LZ checkpoint: the screening radius
            if u.screening:
                pygame.draw.circle(fx, (*COL_BLUE, 110), P(u.x, u.y), R(SCREEN_RADIUS), 1)
        for i, a in enumerate(squads):
            for b in squads[i + 1:]:
                if math.hypot(a.x - b.x, a.y - b.y) < REINFORCE_RADIUS:
                    pygame.draw.line(fx, (*COL_BLUE, 150), P(a.x, a.y), P(b.x, b.y), lw)
        ms.blit(fx, (0, 0))

        # Everything that should glow goes on a dark layer that is bloomed
        # and then added over the city.
        dyn = self.dyn
        dyn.fill((0, 0, 0))
        uw = max(2, round(1.5 * s))

        for u in g.units.values():
            frac = 1.0 if u.hp is None else max(0.0, u.hp / u.max_hp)
            col = mix((0, 0, 0), u.spec["color"], 0.45 + 0.55 * frac)
            if u.drop_t > 0:                         # paradrop: shrinking crosshair + falling shadow
                frac = u.drop_t / DROP_TIME
                x, y = P(u.x, u.y)
                draw_crosshair(dyn, COL_YELLOW, (x, y), R(4 + 12 * frac, 4), 1)
                pygame.draw.ellipse(dyn, mix((0, 0, 0), COL_WHITE, 0.35 * (1 - frac)),
                                    (x - R(5, 3), y - R(2, 1), 2 * R(5, 3), 2 * R(2, 1)), 1)
                draw_unit_symbol(dyn, u.kind, (x, y - R(40 * frac)), R(5, 4),
                                 mix((0, 0, 0), u.spec["color"], 0.6), 1)
                continue
            if not u.built:                          # blueprint: dashed outline + build progress
                bp = mix((0, 0, 0), COL_WHITE, 0.6)
                k = max(2, round(CELL * s))
                if u.kind == "barricade":
                    for n, c in enumerate(u.street):
                        if n % 2 == 0 or self.blink(2):
                            x, y = int((c % GW) * CELL * s), int((c // GW) * CELL * s)
                            pygame.draw.rect(dyn, bp, (x, y, k, k), 1)
                else:
                    draw_unit_symbol(dyn, u.kind, P(u.x, u.y), R(5, 4), bp, 1)
                x, y = P(*u.site)
                bw, bh = R(18, 12), max(3, R(2.5))
                dyn.fill(mix((0, 0, 0), COL_WHITE, 0.3), (x - bw // 2, y - R(9, 7), bw, bh))
                dyn.fill(COL_YELLOW, (x - bw // 2, y - R(9, 7), int(bw * u.progress), bh))
                continue
            if u.kind == "evac":
                self.draw_lz(dyn, u)
            elif u.kind == "mine":
                draw_unit_symbol(dyn, "mine", P(u.x, u.y), R(3.5, 3), COL_MAGENTA, max(1, lw))
            elif u.kind == "barricade":
                if g.run_time - u.last_hit < 0.4 and self.blink(6):
                    col = COL_YELLOW                     # under attack
                k = max(2, round(CELL * s))
                for c in u.street:                       # built street segments
                    x, y = int((c % GW) * CELL * s), int((c // GW) * CELL * s)
                    dyn.fill(col, (x, y, k, k))
                    dyn.fill(COL_WHITE, (x + k // 2, y + k // 2, 1, 1))
                dim = mix((0, 0, 0), col, 0.55)
                for c in u.seal:                         # sealed building edges (free)
                    x, y = int((c % GW) * CELL * s), int((c // GW) * CELL * s)
                    pygame.draw.rect(dyn, dim, (x, y, k, k), 1)
            elif u.kind != "chopper":
                if u.kind == "infantry" and u.retreating and self.blink(4):
                    col = COL_YELLOW
                if u.kind == "engineer" and u.state == "fleeing" and self.blink(4):
                    col = COL_YELLOW
                draw_unit_symbol(dyn, u.kind, P(u.x, u.y), R(6, 4), col, uw)
                if u.kind == "infantry" and u.support:
                    x, y = P(u.x, u.y)
                    for n in range(u.support):           # reinforcement pips
                        dyn.fill(COL_BLUE, (x - R(6, 4) + n * R(4, 3), y + R(6, 5), R(2.5, 2), R(2.5, 2)))

        # -- moving traffic glows --
        self.draw_cars(dyn, g, np.flatnonzero(g.car_state == CAR_DRIVING), COL_WHITE, riders)
        for tr in g.trains:                      # trains: a chain of carriages
            if tr.head is None:
                continue
            for j in range(4):
                d0 = tr.head - tr.dir * (j * TRAIN_LENGTH / 4 + 1)
                d1 = tr.head - tr.dir * ((j + 1) * TRAIN_LENGTH / 4 - 1)
                a, b = tr.at(np.array([d0, d1]))
                if np.hypot(*(b - a)) > 1:
                    pygame.draw.line(dyn, COL_MAGENTA if j else COL_YELLOW, P(*a), P(*b), max(3, R(4.5)))

        # -- population: thousands of small dots written straight to pixels --
        self.plot_agents(dyn)
        vips = np.flatnonzero(g.vip & (g.state == CIV))
        for i in vips:                           # VIP markers: cyan ring
            pygame.draw.circle(dyn, COL_VIP, P(*g.pos[i]), R(6, 5), 1)

        # -- health bars on damaged units, drawn above the crowds --
        for u in g.units.values():
            if u.hp is None or u.hp >= u.max_hp:
                continue
            if u.kind == "barricade":
                x, y = P((u.x + u.x2) / 2, (u.y + u.y2) / 2)
                y -= R(8, 6)
            elif u.kind == "evac":
                x, y = P(u.x, u.y - LZ_RADIUS - 4)
            else:
                x, y = P(u.x, u.y - 10)
            bw, bh = R(16, 10), max(3, R(2.5))
            if u.kind == "barricade":
                bw = R(24, 14)
            bar = pygame.Rect(x - bw // 2, y - bh, bw, bh)
            dyn.fill(COL_RED, bar)
            dyn.fill(COL_BLUE, (bar.x, bar.y, int(bw * max(0.0, u.hp / u.max_hp)), bh))
            if u.kind == "barricade" and u.defended:    # shored up by a nearby squad
                pygame.draw.rect(dyn, COL_WHITE, bar.inflate(4, 4), 1)

        # -- effects, ordnance and targeting sights --
        fx.fill((0, 0, 0, 0))
        for e in g.effects:
            a = e.t / e.life
            if e.kind == "tracer":
                pygame.draw.line(fx, (*COL_YELLOW, int(255 * a)), P(e.x, e.y), P(e.x2, e.y2), 1)
            elif e.kind == "boom":
                r = R(e.r * (1.15 - 0.45 * a), 2)
                pygame.draw.circle(fx, (*COL_MAGENTA, int(110 * a)), P(e.x, e.y), r)
                pygame.draw.circle(fx, (*COL_YELLOW, int(200 * a)), P(e.x, e.y), r, max(2, 3 * lw))
            elif e.kind == "ring":
                pygame.draw.circle(fx, (*COL_YELLOW, int(230 * a)), P(e.x, e.y), R(e.r * (1.6 - a), 3), 2 * lw)
            elif e.kind == "splash":                     # someone went under
                pygame.draw.circle(fx, (*COL_WHITE, int(200 * a)), P(e.x, e.y), R(e.r * (1.6 - a), 2), lw)
        for u in g.units.values():                       # sniper sights: yellow crosshairs
            if u.kind == "sniper" and u.aim:
                draw_crosshair(fx, (*COL_YELLOW, 230), P(*u.aim), R(5, 5), max(1, lw))
        for sh in g.shells:
            if sh.source == "car":                       # cooking-off car: no marker
                continue
            a = sh.t / sh.total
            cx, cy = P(sh.x, sh.y)
            if sh.source == "artillery":                 # artillery sight: yellow blast radius
                pygame.draw.circle(fx, (*COL_YELLOW, 40), (cx, cy), R(sh.radius))
                pygame.draw.circle(fx, (*COL_YELLOW, 230), (cx, cy), R(sh.radius), 2 * lw)
                pygame.draw.circle(fx, (*COL_YELLOW, 160), (cx, cy), R(sh.radius * a, 2), lw)
            else:                                        # airstrike marker
                pygame.draw.circle(fx, (*COL_MAGENTA, 170), (cx, cy), R(sh.radius), 2 * lw)
                pygame.draw.circle(fx, (*COL_MAGENTA, 230), (cx, cy), R(sh.radius * a, 2), lw)
                k = R(sh.radius * 0.5)
                pygame.draw.line(fx, (*COL_MAGENTA, 190), (cx - k, cy), (cx + k, cy), 2 * lw)
                pygame.draw.line(fx, (*COL_MAGENTA, 190), (cx, cy - k), (cx, cy + k), 2 * lw)
            if sh.source == "artillery":
                px = sh.sx + (sh.x - sh.sx) * (1 - a)
                py = sh.sy + (sh.y - sh.sy) * (1 - a) - math.sin((1 - a) * math.pi) * 60
                pygame.draw.circle(fx, (*COL_MAGENTA, 255), P(px, py), R(3, 2))
        for b in g.bombers:
            x1, y1 = b.x0 + b.ux * b.length, b.y0 + b.uy * b.length
            pygame.draw.line(fx, (*COL_MAGENTA, 120), P(b.x0, b.y0), P(x1, y1), 2 * lw)
        for d in g.drones:                               # lure drone route (remaining part)
            i = int(np.searchsorted(d.cum, d.dist, side="right"))
            route = [d.pos] + d.pts[i:]
            if len(route) >= 2:
                pygame.draw.lines(fx, (*COL_MAGENTA, 140), False, [P(*q) for q in route], lw)
            if d.dist >= d.length:                       # hover countdown
                frac = 1 - d.hover / DRONE_HOVER
                rect = pygame.Rect(0, 0, R(24, 16), R(24, 16))
                rect.center = P(*d.pos)
                pygame.draw.arc(fx, (*COL_YELLOW, 255), rect, 0, 2 * math.pi * frac, 2)
        if self.lure_path and len(self.lure_path) >= 2:  # route being drawn
            pygame.draw.lines(fx, (*COL_MAGENTA, 230), False, [P(*q) for q in self.lure_path], 2 * lw)
            length = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(self.lure_path, self.lure_path[1:]))
            self.drag_info = f"ROUTE {min(length, DRONE_MAX_PATH):.0f}/{DRONE_MAX_PATH}M"
        for u in g.units.values():                       # chopper escort tethers
            if u.kind == "chopper" and u.escort is not None:
                tgt = g.escort_pos(u.escort)
                if tgt:
                    pygame.draw.line(fx, (*COL_BLUE, 110), P(u.px, u.py), P(*tgt), lw)
                    pygame.draw.circle(fx, (*COL_BLUE, 200), P(*tgt), R(9, 7), lw)
        for u in chosen:                                 # selection brackets
            x, y = P(*((u.px, u.py) if u.kind == "chopper" else (u.x, u.y)))
            b = R(11, 9)
            for sx, sy in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
                pygame.draw.line(fx, (*COL_YELLOW, 255), (x + sx * b, y + sy * b), (x + sx * b // 2, y + sy * b), 2)
                pygame.draw.line(fx, (*COL_YELLOW, 255), (x + sx * b, y + sy * b), (x + sx * b, y + sy * b // 2), 2)
        for u in g.movables():                           # standing move orders
            goal = u.dest if u.kind == "chopper" else u.order
            if u.kind == "chopper" and u.escort is not None:
                goal = None
            if goal is not None:
                pygame.draw.line(fx, (*COL_BLUE, 170), P(u.x, u.y), P(*goal), lw)
                tx, ty = P(*goal)
                k = R(4, 4)
                pygame.draw.line(fx, (*COL_BLUE, 255), (tx - k, ty - k), (tx + k, ty + k), 2)
                pygame.draw.line(fx, (*COL_BLUE, 255), (tx - k, ty + k), (tx + k, ty - k), 2)
        self.draw_previews(fx, hover, chosen)
        dyn.blit(fx, (0, 0))

        for d in g.drones:
            draw_unit_symbol(dyn, "lure", P(*d.pos), R(5, 4), COL_MAGENTA, max(1, lw))
        for u in g.units.values():
            if u.kind == "chopper" and u.drop_t <= 0:
                self.draw_helicopter(dyn, u.px, u.py, 0.8, u.angle + math.pi / 2, COL_BLUE)
        for b in g.bombers:
            if b.delay <= 0:
                x, y = P(*b.pos)
                ang = math.atan2(b.uy, b.ux)
                k = R(10, 6)
                pts = [(x + math.cos(ang) * k, y + math.sin(ang) * k),
                       (x + math.cos(ang + 2.5) * k, y + math.sin(ang + 2.5) * k),
                       (x - math.cos(ang) * k * 0.3, y - math.sin(ang) * k * 0.3),
                       (x + math.cos(ang - 2.5) * k, y + math.sin(ang - 2.5) * k)]
                pygame.draw.polygon(dyn, COL_MAGENTA, pts)

        ms.blit(dyn, (0, 0), special_flags=pygame.BLEND_ADD)
        ms.blit(self.bloom(dyn), (0, 0), special_flags=pygame.BLEND_ADD)
        self.screen.blit(ms, self.map_rect)

    def draw_cars(self, surf, g, cars, col, riders, length=7.5, width=3.8):
        """Cars as hollow boxes (larger than life, to read on the map) with a
        dot per person inside; corners computed for all cars at once."""
        if not cars.size:
            return
        s = self.s
        pos, h = g.car_pos[cars], g.car_heading[cars]
        fwd = np.stack([np.cos(h), np.sin(h)], 1)
        side = np.stack([-fwd[:, 1], fwd[:, 0]], 1)
        corners = np.stack([pos + fwd * a * length / 2 + side * b * width / 2
                            for a, b in ((1, 1), (1, -1), (-1, -1), (-1, 1))], 1) * s
        for box in corners.round().astype(int).tolist():
            pygame.draw.polygon(surf, col, box, 1)
        n = np.minimum(riders[cars], 3)
        if n.any():                              # rider dots along the car's axis
            k = np.repeat(np.arange(cars.size), n)
            j = np.concatenate([np.arange(m) - (m - 1) / 2 for m in n[n > 0]])
            dots = ((pos[k] + fwd[k] * (j * 2.0)[:, None]) * s).astype(int)
            w, hgt = surf.get_size()
            ok = (dots[:, 0] >= 0) & (dots[:, 0] < w) & (dots[:, 1] >= 0) & (dots[:, 1] < hgt)
            arr = pygame.surfarray.pixels3d(surf)
            arr[dots[ok, 0], dots[ok, 1]] = COL_GREEN
            del arr

    def dot_size(self):
        return max(2, round(2.6 * self.s))      # 2px on laptops, up to 4-5px when large

    def plot_agents(self, surf):
        g, s = self.game, self.s
        w, h = surf.get_size()
        size = self.dot_size()
        xy = (g.pos * s).astype(np.int32) - size // 2
        st = g.state
        arr = pygame.surfarray.pixels3d(surf)
        # Incubating civilians look healthy until the last SYMPTOM_TIME
        # seconds, when they flicker red.
        sick = (st == CIV) & (g.incubate > 0) & (g.incubate < SYMPTOM_TIME) & self.blink(4)
        vip = (st == CIV) & g.vip
        lunge = (st == ZOMBIE) & (g.episode_kind == EP_LUNGE)          # lunging zombies swell
        for mask, col, sz in ((st == DEAD, COL_DEAD, size - 1), (st == CIV, COL_GREEN, size),
                              (st == ZOMBIE, COL_RED, size), (sick, COL_RED, size), (lunge, COL_RED, size + 1),
                              (vip, COL_VIP, size + 1)):
            # clamp per dot size so the whole dot stays on the surface
            # (lunging zombies and VIPs are a pixel bigger than the rest)
            pts = np.clip(xy[mask], 0, [w - sz, h - sz])
            for dx in range(sz):
                for dy in range(sz):
                    arr[pts[:, 0] + dx, pts[:, 1] + dy] = col
        armed = np.clip(xy[(st == CIV) & (g.ammo > 0) & ~g.vip] + size // 2, 0, [w - 1, h - 1])
        arr[armed[:, 0], armed[:, 1]] = COL_WHITE                   # concealed carry: white centre
        del arr

    def bloom(self, surf):
        """Heavy CRT bloom of the dynamic layer: average down 8x, amplify,
        and scale back up as a soft halo. Refreshed every other frame - it is
        diffuse enough that nobody can tell, and it halves the cost."""
        w, h = surf.get_size()
        if self.glow is None or self.frame_no % 2 == 0:
            small = pygame.transform.smoothscale(surf, (max(1, w // 4), max(1, h // 4)))
            small = pygame.transform.smoothscale(small, (max(1, w // 8), max(1, h // 8)))
            small.fill((2, 2, 2), special_flags=pygame.BLEND_SUB)
            # Bigger dots carry more light; normalise so the halo stays as
            # soft as it was with 1px dots.
            k = int(255 / self.dot_size() ** 2)
            small.fill((k, k, k), special_flags=pygame.BLEND_MULT)
            for _ in range(2):
                small.blit(small, (0, 0), special_flags=pygame.BLEND_ADD)
            self.glow = pygame.transform.smoothscale(small, (w, h))
        return self.glow

    def draw_previews(self, fx, hover, chosen):
        g, s, lw = self.game, self.s, self.lw

        def P(x, y):
            return int(x * s), int(y * s)

        spec = UNIT_SPECS[self.selected]
        if not self.lure_path:
            self.drag_info = None
        if self.lure_path:
            return
        if self.drag:
            x0, y0 = self.drag
            end = self.screen_to_world(pygame.mouse.get_pos(), clamp=True)
            cost, (x1, y1) = g.drag_cost(self.selected, x0, y0, *end)
            ok = 0 < cost <= g.cp and bool(g.in_zone(self.selected, cell_index(x0, y0)))
            col = spec["color"] if ok else COL_YELLOW
            if self.selected == "barricade":
                k = max(1, round(CELL * s))
                placed, seal, skipped, (a, b) = g.barricade_line(x0, y0, x1, y1)
                if not g.in_zone("barricade", placed).all():
                    ok, col = False, COL_YELLOW
                for c in skipped:                        # already occupied
                    pygame.draw.rect(fx, (*COL_YELLOW, 120), (int((c % GW) * CELL * s), int((c // GW) * CELL * s), k, k), 1)
                for c in seal:                           # building edges: sealed for free
                    pygame.draw.rect(fx, (*col, 150), (int((c % GW) * CELL * s), int((c // GW) * CELL * s), k, k), 1)
                for c in placed:                         # street: built and charged
                    fx.fill((*col, 170), (int((c % GW) * CELL * s), int((c // GW) * CELL * s), k, k))
                pygame.draw.line(fx, (*col, 120), P(*a), P(*b), lw)
                draw_crosshair(fx, (*COL_BLUE, 255), P(x0, y0), max(4, int(3 * s)), max(1, lw))
                self.drag_info = f"{placed.size} ST+{seal.size} SEAL: {cost}CP" + ("" if ok else " NO")
                return
            else:
                L = math.hypot(x1 - x0, y1 - y0)
                pygame.draw.line(fx, (*col, 230), P(x0, y0), P(x1, y1), 2 * lw)
                d = 0.0
                while L > 0 and d <= L:
                    bx, by = x0 + (x1 - x0) * d / L, y0 + (y1 - y0) * d / L
                    pygame.draw.circle(fx, (*col, 90), P(bx, by), int(spec["blast"] * s), lw)
                    d += spec["spacing"]
            self.drag_info = f"COST {cost} CP" + ("" if ok else " - DENIED")
            return
        if hover is None or g.phase == "over":
            return
        x, y = hover
        if chosen:                                       # group move preview
            for u in chosen:
                pygame.draw.line(fx, (*COL_BLUE, 90), P(u.x, u.y), P(x, y), lw)
            pygame.draw.circle(fx, (*COL_BLUE, 200), P(x, y), int((12 + 6 * len(chosen)) * s), lw)
            return
        ok = spec["cost"] <= g.cp and bool(g.in_zone(self.selected, cell_index(x, y)))
        if self.selected == "evac":
            ok = ok and g.lz_cells(x, y).size >= LZ_MIN_CELLS and g.city.open_flat[cell_index(x, y)]
            ok = ok and "evac" not in g.disabled
            k = max(1, round(CELL * s))
            col = COL_BLUE if ok else COL_YELLOW
            for c in g.lz_cells(x, y):
                fx.fill((*col, 110), (int((c % GW) * CELL * s), int((c // GW) * CELL * s), k, k))
        elif self.selected == "mine":
            col = COL_MAGENTA if ok else COL_YELLOW
            pygame.draw.circle(fx, (*col, 40), P(x, y), int(FIRE_RADIUS * s))
            pygame.draw.circle(fx, (*col, 170), P(x, y), int(FIRE_RADIUS * s), lw)
        elif self.selected == "lure":
            col = COL_YELLOW
            pygame.draw.circle(fx, (*col, 25), P(x, y), int(LURE_RADIUS * s))
            pygame.draw.circle(fx, (*col, 120), P(x, y), int(LURE_RADIUS * s), lw)
        elif spec["mode"] == "point" and (spec.get("range") or spec.get("blast")):
            col = COL_BLUE if ok else COL_YELLOW
            r = (spec.get("range") or spec.get("blast")) + spec.get("orbit", 0)
            if self.selected in ("sniper", "artillery") and g.city.indoor_flat[cell_index(x, y)]:
                r *= ROOFTOP_RANGE
            pygame.draw.circle(fx, (*col, 30), P(x, y), int(r * s))
            pygame.draw.circle(fx, (*col, 170), P(x, y), int(r * s), 2 * lw)
        draw_unit_symbol(fx, self.selected, P(x, y), max(4, int(6 * s)),
                         (*(spec["color"] if ok else COL_YELLOW), 230), max(2, lw))

    def draw_lz(self, surf, u):
        s, lw = self.s, self.lw
        c = (int(u.x * s), int(u.y * s))
        r = int(LZ_RADIUS * s)
        rect = pygame.Rect(0, 0, 2 * r, 2 * r)
        rect.center = c
        off = self.anim_t * 0.8 + u.id
        if getattr(u, "offline", 0) > 0:             # chopper down: countdown ring, no helicopter
            frac = 1 - u.offline / LZ_REPLACE_TIME
            pygame.draw.arc(surf, COL_YELLOW, rect, math.pi / 2, math.pi / 2 + 2 * math.pi * frac, max(3, 3 * lw))
            draw_unit_symbol(surf, "evac", c, max(4, int(7 * s)), COL_YELLOW if self.blink(2) else COL_BLUE,
                             max(2, lw))
            return
        for k in range(10):
            a0 = off + k * math.pi / 5
            pygame.draw.arc(surf, COL_BLUE, rect, a0, a0 + math.pi / 8, max(3, 3 * lw))
        draw_unit_symbol(surf, "evac", c, max(4, int(7 * s)), COL_BLUE, max(2, lw))
        # A helicopter cycles in and out above the pad.
        phase = (self.anim_t * 0.25 + u.id * 0.37) % 1.0
        lift = abs(phase - 0.5) * 2                  # 1 = high/away, 0 = landed
        self.draw_helicopter(surf, u.x + 4 + lift * 60, u.y - 6 - lift * 40, 1.0, 0.0, COL_WHITE)

    def draw_helicopter(self, surf, wx, wy, scale, heading, color):
        s = self.s * scale
        bob = math.sin(self.anim_t * 2.0 + wx) * 1.5
        x, y = wx * self.s, (wy + bob) * self.s
        ch, sh = math.cos(heading), math.sin(heading)

        def P(dx, dy):
            return int(x + (dx * ch - dy * sh) * s), int(y + (dx * sh + dy * ch) * s)

        w = max(2, round(2 * s))
        pygame.draw.line(surf, color, P(4, 0), P(16, -1), w + 1)
        pygame.draw.line(surf, color, P(16, -5), P(16, 3), w)
        pygame.draw.circle(surf, color, P(-2, 0), max(2, int(6 * s)), w)
        ang = self.anim_t * 18 + wx
        for k in range(2):
            a = ang + k * math.pi / 2
            dx, dy = math.cos(a) * 13, math.sin(a) * 13
            pygame.draw.line(surf, COL_WHITE, P(-2 - dx, -dy), P(-2 + dx, dy), max(1, round(s)))

    def draw_panel(self):
        g, scr, u = self.game, self.screen, self.u
        pad, gap, blw = self.pad, self.gap, self.ui_lw
        x0, pw = self.panel_x, self.panel_w
        H = self.size[1]
        scr.fill(COL_BG, (x0, 0, pw, H))
        pygame.draw.line(scr, COL_CYAN, (x0 + blw // 2, 0), (x0 + blw // 2, H), blw)
        left, right = x0 + pad + blw, x0 + pw - pad
        big, med, small = self.font_big, self.font_med, self.font_small

        self.text("ZOMBIE EVAC", (left, self.title_y), big, COL_WHITE)
        lv = g.progress.level
        diff = "" if g.difficulty == "medium" else g.difficulty.upper() + " "
        level = "" if g.mission else (f"LV{lv:+d}" if lv else "LV 0")
        self.text((diff + level).strip(), (right, self.title_y + big.get_linesize() // 2), small,
                  COL_YELLOW, "midright")
        self.text(f"CP {int(g.cp)}", (left, self.cp_y), med, COL_YELLOW)
        self.text(f"T+{int(g.run_time // 60)}:{int(g.run_time % 60):02d}", (right, self.cp_y), med,
                  COL_WHITE, "topright")
        pygame.draw.line(scr, COL_CYAN, (left, self.sep_y), (right, self.sep_y), blw)

        for n, k in enumerate(UNIT_ORDER):
            spec, rect = UNIT_SPECS[k], self.unit_buttons[k]
            cost = g.barricade_cost if k == "barricade" else spec["cost"]
            locked = k in g.disabled
            wait = g.standby(k)
            affordable = cost <= g.cp and not locked and wait <= 0
            if self.selected == k and not self.sel:
                scr.fill(spec["color"], rect)
                fg = icon = COL_BG
            else:
                pygame.draw.rect(scr, spec["color"] if affordable else COL_GRIDLINE, rect, blw)
                fg = COL_WHITE if affordable else COL_WHITE_DIM
                icon = spec["color"] if affordable else COL_WHITE_DIM
            icon_w = int(34 * u)
            draw_unit_symbol(scr, k, (rect.x + icon_w // 2, rect.centery), int(7 * u), icon,
                             max(1, round(1.5 * u)))
            self.text(f"{UNIT_KEYS[n]} {spec['name']}", (rect.x + icon_w, rect.centery), small, fg, "midleft")
            label = "LOCKED" if locked else (f"STBY {int(wait) // 60}:{int(wait) % 60:02d}" if wait > 0
                                              else (f"{cost:g}/CELL" if k == "barricade" else str(cost)))
            name = f"{UNIT_KEYS[n]} {spec['name']}"
            if wait > 0 and icon_w + small.size(name)[0] + small.size(label)[0] + 3 * gap > rect.w:
                label = label[5:]                # tight row: just the countdown
            self.text(label, (rect.right - gap - blw, rect.centery), small, fg, "midright")

        chosen = self.selected_units()
        if len(chosen) == 1 and chosen[0].kind == "infantry":
            sq = chosen[0]
            state = "RETREATING" if sq.retreating else ("MOVING" if sq.order else
                                                        ("SCREENING LZ" if sq.screening else "HOLDING"))
            line1 = f"SQUAD {state} +{sq.support} SUPPORT"
            line2, col2 = "CLICK MAP: MOVE  RMB: OFF", COL_YELLOW
        elif len(chosen) == 1 and chosen[0].kind == "engineer":
            line1 = f"ENGINEERS {chosen[0].state.upper()}"
            line2, col2 = "CLICK MAP: MOVE  RMB: OFF", COL_YELLOW
        elif chosen:
            n_ch = sum(u.kind == "chopper" for u in chosen)
            line1 = f"{len(chosen) - n_ch} GROUND + {n_ch} CHOPPERS"
            line2 = "CLICK UNIT/VIP: ESCORT" if n_ch else "CLICK MAP: GROUP MOVE"
            col2 = COL_YELLOW
        else:
            spec = UNIT_SPECS[self.selected]
            line1 = spec["desc"]
            line2, col2 = (self.drag_info, COL_YELLOW) if self.drag_info else ("> " + spec["how"], COL_WHITE_DIM)
        self.text(line1, (left, self.info_y), small, COL_WHITE)
        self.text(line2, (left, self.info_y + small.get_linesize()), small, col2)

        for val, rect in self.time_buttons:
            if val == "undo":                            # dim unless undo is allowed
                usable = g.can_undo() and bool(g.history)
                pygame.draw.rect(scr, COL_YELLOW if usable else COL_GRIDLINE, rect, blw)
                self.text("UNDO", rect.center, small, COL_YELLOW if usable else COL_WHITE_DIM, "center")
                continue
            if val == "pause":
                active = g.paused or g.phase == "setup"
            else:
                active = g.phase == "running" and not g.paused and g.time_scale == val
            if active:
                scr.fill(COL_WHITE, rect)
            pygame.draw.rect(scr, COL_WHITE if active else COL_CYAN, rect, blw)
            fg = COL_BG if active else COL_WHITE
            cx, cy = rect.center
            if val == "pause":
                k = int(rect.h * 0.22)
                bw = max(3, k // 2)
                scr.fill(fg, (cx - k + 1, cy - k, bw, 2 * k))
                scr.fill(fg, (cx + k - bw, cy - k, bw, 2 * k))
            else:
                self.text(f"{val}X", rect.center, small, fg, "center")

        n_civ, n_z = g.counts()
        stats = g.objective_progress()
        stats += [
            ("CIVILIANS", n_civ, COL_GREEN),
            ("EVACUATED", g.rescued, COL_BLUE),
            ("ZOMBIES", n_z, COL_RED),
            ("NEW INFECTED", g.infected, COL_RED),
            ("COLLATERAL", g.casualties, COL_MAGENTA),
            ("ZOMBIES DOWN", g.kills, COL_WHITE),
        ]
        y = self.stats_y
        for label, val, col in stats[:7]:
            self.text(label, (left, y), small, COL_WHITE_DIM)
            self.text(str(val), (right, y), small, col, "topright")
            y += small.get_linesize()

        y = self.help_y                          # (controls live in the menus now)
        pygame.draw.line(scr, COL_CYAN, (left, y - gap - blw), (right, y - gap - blw), blw)
        if g.message_t > 0:
            if self.blink(3):
                self.text("! " + g.message.upper(), (left, y), small, COL_YELLOW)
        else:
            self.text(g.city.name, (left, y), small, COL_WHITE_DIM)

    def draw_game_over(self):
        g, mr = self.game, self.map_rect
        self.screen.blit(self.shade, mr)
        saved = g.rescued + g.sheltered
        pct = 100 * saved / max(1, g.total_healthy)
        if pct >= 60:
            verdict = "OUTBREAK CONTAINED"
        elif pct >= 40:
            verdict = "CITY PARTIALLY SAVED"
        elif pct >= 20:
            verdict = "HEAVY CASUALTIES"
        else:
            verdict = "THE CITY HAS FALLEN"
        big, med, small = self.font_big, self.font_med, self.font_small
        if g.mission:                            # story debrief
            ok = g.result and g.result["success"]
            more = self.story_index is not None and self.story_index + 1 < len(CAMPAIGN)
            lines = [
                (f"MISSION {self.story_index + 1}: " + ("COMPLETE" if ok else "FAILED"), big,
                 COL_YELLOW if ok else COL_RED),
                (g.result["reason"] if g.result else "", med, COL_WHITE),
            ]
            lines += [(f"{lbl} {val}", small, col) for lbl, val, col in g.objective_progress()]
            lines.append((f"EVACUATED {g.rescued}  INFECTED {g.infected}  COLLATERAL {g.casualties}  "
                          f"ZOMBIES DOWN {g.kills}", small, COL_WHITE_DIM))
            if g.carried_out or g.trojans or g.screened:
                lines.append((self.infected_out_line(), small, COL_RED))
            lines.append((self.traffic_line(), small, COL_WHITE_DIM))
            if ok and more:
                lines.append(("ENTER: NEXT MISSION   R: REPLAY   ESC: MENU", small, COL_YELLOW))
            elif ok:
                lines += [("CAMPAIGN COMPLETE - THE WORLD THANKS YOU", small, COL_YELLOW),
                          ("R: REPLAY   ESC: MENU", small, COL_WHITE_DIM)]
            else:
                lines.append(("R / ENTER: RETRY   ESC: MENU", small, COL_YELLOW))
            self.draw_box(lines)
            return
        lines = [
            (verdict, big, COL_YELLOW),
            (f"SAVED {saved}/{g.total_healthy} ({pct:.0f}%)", med, COL_WHITE),
            (f"EVACUATED {g.rescued}  SHELTERED {g.sheltered}", small, COL_BLUE),
            (f"INFECTED {g.infected}  COLLATERAL {g.casualties}", small, COL_RED),
        ]
        if g.carried_out or g.trojans or g.screened:
            lines.append((self.infected_out_line(), small, COL_RED))
        lines.append((self.traffic_line(), small, COL_WHITE_DIM))
        res = g.last_result
        if res:
            nxt = res["next"]
            trend = {1: "THREAT RISING", 2: "THREAT RISING FAST", -1: "THREAT EASING"}.get(
                res["change"], "THREAT HOLDING")
            lines += [(f"{trend}: LV{res['level']:+d}", med, COL_YELLOW),
                      (f"NEXT: {nxt['infected'] * 100:.1f}% INFECTED  POP {nxt['population']}  "
                       f"CP {nxt['cp']}", small, COL_WHITE)]
        lines.append(("R RESTART   N NEW CITY   ESC MENU", small, COL_WHITE_DIM))
        self.draw_box(lines)

    def infected_out_line(self):
        g = self.game
        return (f"INFECTED FLOWN OUT {g.carried_out}  CHOPPERS LOST {g.trojans}  "
                f"SICK STOPPED AT LZS {g.screened}")

    def traffic_line(self):
        g = self.game
        return (f"CARS ESCAPED {g.cars_escaped}  CRASHED {g.car_crashes}  "
                f"RUN OVER {g.roadkill}  DROWNED {g.drowned}")

    def draw_box(self, lines):
        mr = self.map_rect
        gap = int(8 * self.u)
        total = sum(f.get_linesize() for _, f, _ in lines) + gap * (len(lines) - 1)
        width = max(f.size(t)[0] for t, f, _ in lines) + 4 * self.pad
        box = pygame.Rect(0, 0, min(width, mr.w - 8), total + 3 * self.pad)
        box.center = mr.center
        self.screen.fill(COL_BG, box)
        pygame.draw.rect(self.screen, COL_YELLOW, box, self.ui_lw)
        y = box.y + int(1.5 * self.pad)
        for t, f, col in lines:
            self.text(t, (mr.centerx, y), f, col, "midtop")
            y += f.get_linesize() + gap

    # ---- main loop ------------------------------------------------------

    def run(self):
        running = True
        while running:
            dt = min(self.clock.tick(FPS) / 1000.0, 0.1)
            self.t += dt
            self.dt = dt
            for ev in pygame.event.get():
                if not self.handle_event(ev):
                    running = False
            self.poll_loading()
            # Window resized / maximised / fullscreen toggled -> rescale.
            if pygame.display.get_surface().get_size() != self.size:
                self.relayout()
            g = self.game
            if self.mode == "game":
                g.advance(dt)
                if g.phase == "running" and not g.paused:
                    self.anim_t += dt * g.time_scale     # rotors / heli cycles freeze on pause
                if g.phase == "over" and g.mission and g.result is not self.handled_result:
                    self.handle_mission_result()
            self.update_audio()
            self.draw()
            pygame.display.flip()
        pygame.quit()


def main(argv=None):
    ap = argparse.ArgumentParser(description="Zombie Evac - outbreak evacuation RTS")
    ap.add_argument("--map", choices=sorted(MAP_ALIASES), default="procedural",
                    help="start on a preset map (real maps need osmnx)")
    ap.add_argument("--place", help='any OpenStreetMap place, e.g. "Nashville, Tennessee"')
    args = ap.parse_args(argv)
    App(MAP_ALIASES[args.map], args.place).run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
