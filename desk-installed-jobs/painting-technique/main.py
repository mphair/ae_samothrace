"""Generalized seeded flood fill ("paint bucket") over a line-art/ink
image -- a direct, literal implementation of a technique the user
described after trying several rounds of corridor-detection-plus-manual
-correction for the "Restored State -- Waterway" layer
(`scripts/style_restored_waterway.py`) and deciding there's a simpler way:
"put some spots [[seed points]], and in those spots you should be able to
do a normal flood fill... move out from that blue spot... and keep
growing that until it hits a line, or... some other color besides white."

**Not hardcoded to Samothrace or to water** -- generalized over any
line-art image + seed points, the same "generalized over `<slug>`, not
hardcoded to one photo" convention `map-import-from-photo` already
follows one directory over. Any image where the thing you want
("water," a room, a region bounded by drawn lines) is enclosed by ink
on a lighter background can use this.

## Algorithm

A literal multi-source flood fill, bounded by "ink" (anything darker
than `barrier_threshold` on the image's own red channel -- same
convention `style_restored_waterway.py`'s own `ink_mask` already uses,
and the same one every stage-mask PNG in this project is saved in),
implemented via connected-component labeling rather than a hand-rolled
pixel-by-pixel BFS: `scipy.ndimage.label` on the INVERSE of the barrier
mask (the open/background area) partitions it into components in one
pass; a seed's own fill region is just "every pixel sharing that seed's
component id." Multiple seeds landing in the same component merge for
free (same id); seeds in different enclosed regions stay separate.
Equivalent to a real paint-bucket fill from each seed, just computed as
connected-components instead of an explicit frontier -- scipy's
implementation is a fast, well-tested two-pass union-find, not slower
than a manual BFS for an image this size, and avoids writing a new
Python-level pixel-by-pixel loop (slow at this resolution).

**Optional closing pre-pass, same reasoning as
`WATER_FILL_CLOSE_ITERATIONS`'s own comment in `style_restored_waterway.py`**:
real hand-drawn boundary ink often has genuine small gaps (a "ladder"
-pattern channel's own tick marks, a dashed convention, a scanning
artifact) that a literal flood fill would leak straight through with no
closing. `closing_iterations` (default 0 -- off, since not every input
image needs it and a wrong default could silently paper over a real
leak) runs `ndimage.binary_closing` on the barrier mask first, same 3x3
iterated-closing idea already proven out there. Left as a tunable, not
auto-detected, since "how big is a real gap vs. how big a closing radius
accidentally bridges two rooms that should stay separate" is exactly the
same judgment call that constant's own comment describes -- there's no
generic answer, it has to be tuned per input by looking at the result.

Pass config via `config_path` (see `tempui-installed-jobs.md`):
```json
{
  "project_dir": "/abs/path/to/this/desk/project",
  "image_path": "relative/or/absolute/path/to/the/line-art/image.png",
  "seeds_px": [[x, y], [x, y], ...],
  "barrier_threshold": 128,
  "closing_iterations": 0,
  "fill_color": [70, 130, 200],
  "fill_alpha": 235,
  "output_path": "relative/or/absolute/path/for/the/output/RGBA/PNG"
}
```
`image_path`/`output_path` resolve against `project_dir` if not already
absolute. `barrier_threshold`/`closing_iterations`/`fill_color`/
`fill_alpha` are all optional (defaults above). Prints how many seeds
landed on open ground vs. directly on a barrier pixel (the latter are
silently skipped -- a seed on ink can't start a fill, and failing loud
here beats a seed that quietly fills nothing) and the total filled pixel
count, so a leak (a suspiciously huge fill) or a dud (suspiciously small)
is visible immediately in the job's own stdout, before even opening the
output image.
"""
import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

DEFAULT_BARRIER_THRESHOLD = 128
DEFAULT_CLOSING_ITERATIONS = 0
DEFAULT_FILL_COLOR = (70, 130, 200)
DEFAULT_FILL_ALPHA = 235


def seeded_flood_fill(barrier_mask: np.ndarray, seeds: list[tuple[int, int]], closing_iterations: int = 0) -> tuple[np.ndarray, int, int]:
    """Returns `(filled_mask, n_seeds_on_open_ground, n_seeds_on_barrier)`.
    `barrier_mask` is True where a pixel is "ink" (a line/boundary --
    cannot be filled, blocks the flood from crossing it); `seeds` are
    `(x, y)` pixel coordinates (NOT row/col -- swapped internally).
    See this module's own header for the connected-components approach
    and why `closing_iterations` defaults to off."""
    if closing_iterations > 0:
        barrier_mask = ndimage.binary_closing(barrier_mask, structure=np.ones((3, 3), dtype=bool), iterations=closing_iterations)
    open_mask = ~barrier_mask
    labels, _ = ndimage.label(open_mask, structure=np.ones((3, 3), dtype=int))

    h, w = barrier_mask.shape
    seed_label_ids = set()
    n_open = 0
    n_barrier = 0
    for x, y in seeds:
        xi, yi = int(round(x)), int(round(y))
        if not (0 <= xi < w and 0 <= yi < h):
            n_barrier += 1
            continue
        label_id = labels[yi, xi]
        if label_id == 0:
            n_barrier += 1
            continue
        seed_label_ids.add(int(label_id))
        n_open += 1

    filled = np.isin(labels, list(seed_label_ids)) if seed_label_ids else np.zeros_like(barrier_mask)
    return filled, n_open, n_barrier


def _resolve(project_dir: Path, path_str: str) -> Path:
    p = Path(path_str)
    return p if p.is_absolute() else project_dir / p


def main() -> None:
    try:
        config_path_global = CONFIG_PATH  # type: ignore[name-defined]  -- injected by Desk's own installed-job runner
    except NameError:
        config_path_global = None
    if not config_path_global:
        raise ValueError("painting-technique requires a config_path -- see this job's own main.py header comment")

    config = json.loads(Path(config_path_global).read_text())
    project_dir = Path(config["project_dir"]).resolve()
    image_path = _resolve(project_dir, config["image_path"])
    output_path = _resolve(project_dir, config["output_path"])
    seeds_px = [tuple(pt) for pt in config["seeds_px"]]
    barrier_threshold = config.get("barrier_threshold", DEFAULT_BARRIER_THRESHOLD)
    closing_iterations = config.get("closing_iterations", DEFAULT_CLOSING_ITERATIONS)
    fill_color = tuple(config.get("fill_color", DEFAULT_FILL_COLOR))
    fill_alpha = config.get("fill_alpha", DEFAULT_FILL_ALPHA)

    rgb = np.asarray(Image.open(image_path).convert("RGB"))
    barrier_mask = rgb[:, :, 0] < barrier_threshold
    print(f"image={image_path} size={rgb.shape[1]}x{rgb.shape[0]} barrier px={barrier_mask.sum()} seeds={len(seeds_px)}")

    filled, n_open, n_barrier = seeded_flood_fill(barrier_mask, seeds_px, closing_iterations)
    print(f"seeds on open ground: {n_open}, seeds landed on a barrier pixel (skipped): {n_barrier}")
    print(f"filled: {filled.sum()} px")

    rgba = np.zeros((*barrier_mask.shape, 4), dtype=np.uint8)
    rgba[filled] = [*fill_color, fill_alpha]
    output_path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba, mode="RGBA").save(output_path)
    print(f"wrote {output_path}")


main()
