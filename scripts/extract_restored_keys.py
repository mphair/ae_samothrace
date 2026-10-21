"""Extracts the Restored plan's own printed compass indicator and scale
bar (distance key) into the "Keys" layer-panel group -- requested
directly (rec-1792426059633-1b56, 2026-10-19): "there's a huge N here,
and next to it there is an arrow over a... plus sign... those together
are the compass indicator... I'd like to extract that out into its own
layer. And I don't want that in the waterway layer that we're building.
Similarly, down below that, there is a distance key... I would also like
that to be its own layer... I want the compass indicator and the
distance [ruler] to be in keys. I would like them to remain aligned to
the spot."

## Reusing the EXISTING Keys mechanism, not building a new one

"Keys" already exists (2026-10-17, for the Initial Map photo's own
printed Chronology legend -- see `desk-installed-jobs/map-import-from
-photo/main.py`'s own `extract_keys()`), and it's fully generic: hmsvc's
own `_discover_keys()` (`desk_hmsvc/samothrace-tiles/service.py`) scans
EVERY `Data/mapSources/<slug>/transform.json` for an optional `"keys"`
list and serves whatever it finds; the widget's own "Keys" layer-panel
group and `drawKeyLayers` (fixed-screen-position rendering -- "remain
aligned to the spot," not tied to the map's own pan/zoom, exactly what
the user asked for) are built entirely from that same discovery, with no
per-slug special-casing anywhere. So THIS script needs zero changes to
hmsvc or the widget -- it only needs to produce the same two things
`extract_keys()` already produces for `initial-map`: a `transform.json`
with a `"keys"` list, and the cropped PNGs it points at.

The one real difference: `extract_keys()` crops from a PHOTO (the
Initial Map's own `source.jpg`, in that photo's own unwarped pixel
space) as a pre-bake step before any homography is computed. The
Restored plan has no equivalent "photo" at all -- its own raw-ink mosaic
(`.desk_temp/pipeline-stages/restored/00_raw-ink.png`, produced by
`scripts/extract_vector_layers.py`) IS already the final pixel grid, so
this script crops directly from THAT instead, no warping involved either
way. A new slug, `restored-plan`, is created under `Data/mapSources/`
purely to hang a `transform.json`+`keys/` off of -- its own
`transform.json` deliberately has NO other fields (no homography/photo
-size parameters `map-import-from-photo` would need) since nothing here
ever bakes this slug into tiles; it exists only so `_discover_keys()` has
something to read.

## Crop boxes vs. mask boxes (same split `extract_keys()` already uses)

Each key gets two boxes, same reasoning as that function's own docstring:
a GENEROUS `(x0,y0,x1,y1)` crop for the standalone key image (a little
extra margin looks nicer and is harmless for a small reference image),
and a TIGHTER `maskBoxes` rectangle for what actually gets blanked out of
`style_restored_waterway.py`'s own `ink_mask` (see
`RESTORED_KEY_MASK_BOXES` there) -- "I don't want that in the waterway
layer." Found the same way the original Chronology fix was: cropped,
looked directly at the result, and iterated -- not computed from
connected-component analysis (tried first; both symbols sit close enough
to real elevation-contour ink that 8-connectivity merges them into one
blob, exactly the same difficulty noted in `style_restored_waterway.py`'s
own header for telling this survey's ink conventions apart
automatically). A handful of short contour-line stub segments inside
each tight mask box are an accepted, visually negligible trade-off (both
keys sit in the map's own southeast corner, open/undistinguished
terrain, not a feature anyone would miss) -- same trade-off the original
Chronology fix made, not a new compromise invented here.

Unlike `extract_keys()`, this script does NOT bake a modified copy of
its own source image (there's no "main raster" for the Restored plan
that this script owns -- `00_raw-ink.png` stays untouched, since the
"00 -- Raw ink mask" pipeline-debug stage is explicitly fine still
showing these symbols; only `style_restored_waterway.py`'s own derived
output needs them gone). `maskBoxes` is carried in `restored-plan`'s own
`transform.json` purely as a durable record of where they are, in the
same shape the Chronology key already established -- not read back by
any job, since the one place that needs to act on it
(`style_restored_waterway.py`) keeps its own copy, same "duplicated
rather than imported, these scripts assume direct execution" reasoning
every other hand-derived geometry constant in that script already
follows.

Run directly: `python3 scripts/extract_restored_keys.py` (reads from
this project's own `.desk_temp/`, writes to `Data/mapSources/
restored-plan/`; no arguments). Run BEFORE `style_restored_waterway.py`
-- order doesn't actually matter today (the two scripts don't share
output), but keeping it first mirrors "extract the keys, then bake the
derived map" from the Initial Map pipeline.
"""
import json
from pathlib import Path

from PIL import Image

PROJECT_DIR = Path(__file__).resolve().parent.parent
STAGE_DIR = PROJECT_DIR / ".desk_temp" / "pipeline-stages" / "restored"
SLUG_DIR = PROJECT_DIR / "Data" / "mapSources" / "restored-plan"

# Generous crop boxes (mosaic-pixel space, `00_raw-ink.png`'s own grid)
# for each standalone key image -- see this module's own header for why
# these are wider than the tighter `maskBoxes` below.
KEYS = [
    {
        "id": "compass",
        "label": "Compass",
        "x0": 2050, "y0": 1730, "x1": 2290, "y1": 2030,
        "maskBoxes": [{"x0": 2085, "y0": 1760, "x1": 2230, "y1": 1980}],
    },
    {
        "id": "scale",
        "label": "Scale",
        "x0": 1860, "y0": 1970, "x1": 2450, "y1": 2175,
        "maskBoxes": [{"x0": 1870, "y0": 2000, "x1": 2420, "y1": 2140}],
    },
]


def main() -> None:
    ink = Image.open(STAGE_DIR / "00_raw-ink.png").convert("RGB")
    keys_dir = SLUG_DIR / "keys"
    keys_dir.mkdir(parents=True, exist_ok=True)

    transform_keys = []
    for key in KEYS:
        crop_box = (key["x0"], key["y0"], key["x1"], key["y1"])
        ink.crop(crop_box).save(keys_dir / f"{key['id']}.png")
        transform_keys.append(key)
        print(f"wrote {keys_dir / (key['id'] + '.png')} from {crop_box}")

    transform = {"slug": "restored-plan", "keys": transform_keys}
    (SLUG_DIR / "transform.json").write_text(json.dumps(transform, indent=2))
    print(f"wrote {SLUG_DIR / 'transform.json'}")


main()
