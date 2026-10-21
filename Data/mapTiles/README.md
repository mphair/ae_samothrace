# Map tiles — Samothrace sanctuary plans

Pre-tiled raster tiles (zoom 17–22, Web Mercator / EPSG:3857), one
directory per plan/imagery set:

| Directory | What it is |
|---|---|
| `SamoWebsite_ActualStatePlan_3857/` | The excavated/current-state site plan |
| `SamoWebsite_RestoredStatePlan_3857/` | The scholarly restored-state reconstruction |
| `SamoWebsite_ActualStateMonuments_3857/` | Actual State plan, with monument footprints highlighted |
| `SamoWebsite_RestoredStateMonuments_3857/` | Restored State plan, with monument footprints highlighted |
| `SamoWebsite_AerialImagery_3857/` | Aerial/satellite imagery of the site |
| `SamoWebsite_InitialMap_3857/` | The original website's own default/landing tile set |

Served live by `desk_hmsvc/samothrace-tiles/` (see that service's own
header comment for the "topographic" and "`<plan>`-structures" layers
it additionally synthesizes from these tiles), and read directly by
`scripts/extract_vector_layers.py` and
`scripts/build_samothrace_vectors.py` (the stitching/vectorizing
pipelines that produce `Data/samothraceVectors/` — see those scripts'
own header comments).

## Provenance

This project is a fork of
[jagingrich/samo_website](https://github.com/jagingrich/samo_website)
— **American Excavations: Samothrace**'s own "Interactive Map:
Sanctuary of the Great Gods, Samothrace" web map (see root
`README.md`'s own "Forked from..." section for the full note). These
tiles are that repository's own original map imagery, carried over
unmodified at import time — nothing in this project re-derives or
redraws them from source surveys; this project only re-tiles, serves,
and (in `samothrace-tiles`/`samothrace-vectors`) extracts/vectorizes
what's already here.

Every layer derived from these tiles elsewhere in this project —
`samothrace-tiles`'s synthesized "topographic"/structure layers,
`Data/samothraceVectors/`'s vectorized contours/waterway/regios — still
traces back to this same source and is credited the same way, not
treated as project-original content. See
`desk_widgets/layered-map/layered-map.ts`'s own `SOURCE_INFO`/
`sourceKeyForLayer` for where that's surfaced live, in the Layered Map
widget's own lower-left attribution box.
