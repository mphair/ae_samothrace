#!/usr/bin/env python3
"""Downloads and unzips the raw Natural Earth 10m Shapefiles this project
needs (coastline, land, minor islands, rivers, populated places, and two
named-point layers for island/region labels), for the area around
Samothrace -- see clip_natural_earth.py for how that area is used.

Deliberately writes only under .desk_temp/ (never Data/ or any
source-controlled path): the raw downloads are large (full-world, not
clipped) and are not source material we want to carry forward -- they're
scratch input for clip_natural_earth.py, which is the script that
produces the small, committed, Samothrace-area-only files in
Data/naturalEarth/.

Usage:
    python3 scripts/fetch_natural_earth.py
"""

import os
import sys
import zipfile

import requests

from natural_earth_common import (
    DATASETS,
    NATURAL_EARTH_CDN,
    RAW_DIR,
    shp_dir,
    shp_path,
    zip_path,
)


def download(name, theme):
    dest = zip_path(name)
    if os.path.exists(dest):
        print(f"  [skip download] {name}.zip already present")
        return
    url = f"{NATURAL_EARTH_CDN}/{theme}/{name}.zip"
    print(f"  downloading {url}")
    resp = requests.get(url, timeout=60)
    resp.raise_for_status()
    os.makedirs(RAW_DIR, exist_ok=True)
    with open(dest, "wb") as f:
        f.write(resp.content)
    print(f"    -> {dest} ({len(resp.content):,} bytes)")


def unzip(name):
    dest_dir = shp_dir(name)
    if os.path.exists(shp_path(name)):
        print(f"  [skip unzip] {name} already extracted")
        return
    os.makedirs(dest_dir, exist_ok=True)
    with zipfile.ZipFile(zip_path(name)) as zf:
        zf.extractall(dest_dir)
    print(f"  extracted -> {dest_dir}/")


def main():
    os.makedirs(RAW_DIR, exist_ok=True)
    for name, theme in DATASETS:
        print(f"{name}:")
        download(name, theme)
        unzip(name)
    print(f"\nDone. Raw Shapefiles are under {RAW_DIR}/ (not committed).")
    print("Next: python3 scripts/clip_natural_earth.py")


if __name__ == "__main__":
    sys.exit(main())
