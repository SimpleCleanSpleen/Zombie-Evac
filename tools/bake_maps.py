#!/usr/bin/env python3
"""Bake Zombie Evac maps for the web port.

Builds each City with the reference implementation (zombie_evac.py) and
writes its nav-grid masks (run-length encoded) plus render geometry to
docs/maps/<slug>.json, and an index docs/maps/index.json.

    python tools/bake_maps.py [--procedural N] [--cache DIR ...]
"""
import argparse
import json
import os
import sys
from pathlib import Path

os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import numpy as np  # noqa: E402
import zombie_evac as ze  # noqa: E402

OUT = ROOT / "docs" / "maps"


def rle(a):
    """Flat int array -> [value, count, value, count, ...]."""
    a = np.asarray(a).ravel().astype(np.int64)
    edges = np.flatnonzero(np.diff(a)) + 1
    starts = np.concatenate([[0], edges])
    counts = np.diff(np.concatenate([starts, [a.size]]))
    out = np.empty(2 * starts.size, np.int64)
    out[0::2], out[1::2] = a[starts], counts
    return out.tolist()


def pts(seq):
    return [[round(float(x), 1), round(float(y), 1)] for x, y in seq]


def bake(city, slug, kind, extra=None):
    d = dict(
        name=city.name, slug=slug, kind=kind, seed=int(city.seed),
        indoor=rle(city.indoor0), water=rle(city.water), water_full=rle(city.water_full),
        street=rle(city.street), label=rle(city.bldg_label), n_bldg=int(city.n_bldg),
        main_water=rle(city.main_water()) if city.water_full.any() else None,
        cars=[int(c) for c in city.cars],
        polys=[pts(p) for p in city.polys if len(p) >= 3],
        roads=[[round(float(w), 1), pts(p), lyr] for w, p, lyr in city.roads],
        water_polys=[pts(p) for p in city.water_polys if len(p) >= 3],
        parks=[pts(p) for p in city.park_polys],
        lots=[pts(seg) for seg in city.lot_lines],
        rails=[pts(p) for p in city.rails],
    )
    if extra:
        d.update(extra)
    (OUT / f"{slug}.json").write_text(json.dumps(d, separators=(",", ":")))
    return (OUT / f"{slug}.json").stat().st_size


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--procedural", type=int, default=50)
    ap.add_argument("--cache", nargs="*", default=[str(ROOT / "map_cache")])
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    index = dict(procedural=[], real={})
    found = {}
    for folder in args.cache:                     # later folders don't override earlier ones
        for f in sorted(Path(folder).glob("*.json")):
            data = json.loads(f.read_text())
            if "name" in data and "buildings" in data:
                found.setdefault(data["name"].upper(), data)
    for name, data in sorted(found.items()):
        city = ze.City.from_osm(data)
        slug = ze.slugify(name)
        size = bake(city, slug, "osm", dict(attribution="MAP DATA (C) OPENSTREETMAP CONTRIBUTORS"))
        index["real"][name] = slug
        print(f"{name:40s} {size / 1024:7.0f} KB  street {city.street.sum()}")
    rng = np.random.default_rng(20261026)
    for seed in rng.choice(1 << 30, args.procedural, replace=False):
        city = ze.City.procedural(int(seed))
        slug = f"proc_{int(seed)}"
        size = bake(city, slug, "procedural")
        index["procedural"].append(slug)
        print(f"{slug:40s} {size / 1024:7.0f} KB")
    (OUT / "index.json").write_text(json.dumps(index, indent=1))


if __name__ == "__main__":
    main()
