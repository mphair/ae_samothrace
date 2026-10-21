"""Bakes the two genuinely-computed samothrace-tiles layers
("topographic", "restored-structures") to static PNGs, plus a single
static "blank" backdrop tile -- the pre-baked output
desk_hmsvc/samothrace-tiles-static/ serves.

Written 2026-10-21 in response to a request from the aws_am_samothrace
deployment project: the AWS deployment doesn't want a live per-request PIL
compute tier for these two layers, since their output is fully
deterministic for a given z/x/y and the tile pyramid is small (z17-22,
1,736 source tiles per plan). The other 5 layers moving to the new
static hmsvc (aerial, initial-map, restored-monuments, restored-plan-raw)
need no baking at all -- they're already-static passthrough files, and
desk_hmsvc/samothrace-tiles-static/service.py reads them straight from
their EXISTING Data/mapTiles/ directories (the same ones
desk_hmsvc/samothrace-tiles/ itself reads, read-only, no copy needed).

2026-10-21 (same day, second pass): versioned. A re-bake must never
change the bytes at an already-published tile URL (that's the entire
point of the long-lived immutable Cache-Control those URLs get -- see
desk_hmsvc/samothrace-tiles-static/service.py's own header comment), so
each run of this script writes topographic/restored-structures to a
NEW `v<N>/` subdirectory -- never overwriting a previous version's own
directory -- and bumps that layer's `version` in
Data/mapTilesStatic/manifest.json (resolved live by
desk_widgets/_shared/platform.ts's `resolveTileUrl`). Each layer's
`overrides` are cleared on its own re-bake: an override exists to patch
one specific tile in a specific, now-superseded version, and carrying
it forward into a version whose underlying content has already changed
wouldn't mean the same thing. Passthrough/blank layers have no version
concept (nothing to re-bake) -- their manifest entries are written once,
on first run only, and never touched again by this script (so a
hand-added override for one of those, if ever needed, survives a later
re-run of this script for the OTHER, versioned layers).

Imports desk_hmsvc/samothrace-tiles/service.py directly (rather than
reimplementing its PIL mask logic) so this bake is byte-for-byte
identical to what that service would compute live for the same
z/x/y -- the whole point of baking is "same output, computed once,"
not "an approximation of the same output."

Run from the project root: `python3 scripts/bake_static_tiles.py`
(no arguments; DESK_PROJECT_DIR is set here from this script's own
location, same convention desk_hmsvc/*/service.py's own
`_project_dir()` already documents for standalone invocation).
"""
import json
import os
import sys
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent
os.environ.setdefault("DESK_PROJECT_DIR", str(PROJECT_DIR))

# Import the real service module directly -- not installed as a
# package, so its directory has to go on sys.path first. Loaded by
# path (not a plain `import service`) to avoid colliding with any
# other project script/module also happening to be named `service`.
SAMOTHRACE_TILES_DIR = PROJECT_DIR / "desk_hmsvc" / "samothrace-tiles"
sys.path.insert(0, str(SAMOTHRACE_TILES_DIR))
import service as tiles_service  # noqa: E402  (must follow sys.path.insert)

STATIC_OUT_DIR = PROJECT_DIR / "Data" / "mapTilesStatic"
MANIFEST_PATH = STATIC_OUT_DIR / "manifest.json"

# layer id -> the tiles_service function that computes it, taking
# (z, x, y) in standard XYZ (north-origin) -- same convention
# tiles_service's own /tiles endpoint takes, see that module's own
# _tms_path comment for why on-disk lookup needs a TMS flip that this
# bake script's OWN output directory deliberately does not replicate
# (we control both producer and consumer here, so there's no reason to
# carry that convention into a brand-new, private directory).
COMPUTED_LAYERS = {
    "topographic": lambda z, x, y: tiles_service._topographic_png(z, x, y),
    "restored-structures": lambda z, x, y: tiles_service._structures_png("restored", z, x, y),
}

# One static, un-versioned manifest entry each, written only if the
# layer isn't already present (see this module's own header comment --
# never touched again on a later run, so a hand-added override
# survives).
STATIC_MANIFEST_DEFAULTS = {
    "aerial": {"version": 1, "urlTemplate": "/tiles/aerial/{z}/{x}/{y}.png", "overrides": {}},
    "blank": {"version": 1, "urlTemplate": "/tiles/blank/{z}/{x}/{y}.png", "overrides": {}},
    "initial-map": {"version": 1, "urlTemplate": "/tiles/initial-map/{z}/{x}/{y}.png", "overrides": {}},
    "restored-monuments": {"version": 1, "urlTemplate": "/tiles/restored-monuments/{z}/{x}/{y}.png", "overrides": {}},
    "restored-plan-raw": {"version": 1, "urlTemplate": "/tiles/restored-plan-raw/{z}/{x}/{y}.png", "overrides": {}},
}


def _enumerate_source_tiles():
    """Every (z, x, y) -- standard XYZ -- that actually exists in the
    Restored State Plan's own on-disk tile set, the shared source grid
    both computed layers are derived from (see this module's own header
    comment: enumerate once, bake both layers from the same (z, x, y)
    set, rather than walking the directory tree twice)."""
    restored_dir = tiles_service.PLAN_DIRS["restored"]
    for z_dir in sorted(restored_dir.iterdir()):
        if not z_dir.is_dir():
            continue
        z = int(z_dir.name)
        for x_dir in sorted(z_dir.iterdir()):
            if not x_dir.is_dir():
                continue
            x = int(x_dir.name)
            for tile_path in sorted(x_dir.glob("*.png")):
                y_tms = int(tile_path.stem)
                y = (2**z) - 1 - y_tms  # TMS -> XYZ, same flip _tms_path itself does
                yield z, x, y


def _load_manifest() -> dict:
    if not MANIFEST_PATH.is_file():
        return {"layers": {}}
    return json.loads(MANIFEST_PATH.read_text())


def _write_manifest(manifest: dict) -> None:
    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")


def bake_computed_layers(manifest: dict) -> None:
    tiles = list(_enumerate_source_tiles())
    print(f"Found {len(tiles)} source tiles in the Restored State Plan's own tile set.")
    for layer_id, compute in COMPUTED_LAYERS.items():
        current = manifest["layers"].get(layer_id)
        new_version = (current["version"] + 1) if current else 1
        out_dir = STATIC_OUT_DIR / layer_id / f"v{new_version}"
        written = skipped = 0
        for z, x, y in tiles:
            data = compute(z, x, y)
            if data is None:
                skipped += 1
                continue
            tile_path = out_dir / str(z) / str(x) / f"{y}.png"
            tile_path.parent.mkdir(parents=True, exist_ok=True)
            tile_path.write_bytes(data)
            written += 1
        print(f"{layer_id}: wrote {written} tiles (version {new_version}), skipped {skipped} (no computable output).")
        manifest["layers"][layer_id] = {
            "version": new_version,
            "urlTemplate": f"/tiles/v{{version}}/{layer_id}/{{z}}/{{x}}/{{y}}.png",
            "overrides": {},  # cleared on every re-bake -- see this module's own header comment
        }


def bake_blank_tile() -> None:
    """Single static file, not a tile pyramid -- see
    tiles_service._blank_png's own comment: a blank tile looks the same
    everywhere, so one file covers every z/x/y request. Not versioned
    (STATIC_MANIFEST_DEFAULTS covers its manifest entry) -- regenerated
    every run regardless, since it's a single cheap file with nothing
    to lose by overwriting it in place."""
    out_path = STATIC_OUT_DIR / "blank.png"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(tiles_service._blank_png())
    print(f"blank: wrote {out_path.relative_to(PROJECT_DIR)}.")


def apply_static_manifest_defaults(manifest: dict) -> None:
    for layer_id, default_entry in STATIC_MANIFEST_DEFAULTS.items():
        if layer_id in manifest["layers"]:
            continue  # already present -- never overwritten by this script again
        manifest["layers"][layer_id] = dict(default_entry)
        print(f"{layer_id}: added default (un-versioned) manifest entry.")


def main() -> int:
    manifest = _load_manifest()
    bake_computed_layers(manifest)
    bake_blank_tile()
    apply_static_manifest_defaults(manifest)
    _write_manifest(manifest)
    print(f"Wrote {MANIFEST_PATH.relative_to(PROJECT_DIR)}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
