#!/usr/bin/env python3
"""Folds answers from the ContourLabelReview widget into
Data/mapFeatures/SamoWeb_<Plan>_Contours.review_decisions.json -- the
position-keyed file extract_vector_layers.py reads on every run (see
its own "Review decisions" section for why position, not fragment id).

The widget itself only ever writes
.desk_temp/contour-label-review-log.json, keyed by the fragment ids
that were current *at the moment each question was asked* -- ids that
can go stale the moment extraction re-runs (see
extract_vector_layers.py's "Known limitations"). This script is the
one place that bridges the two: for each answer, it looks up those two
fragment ids in whichever Data/mapFeatures/*.geojson is on disk RIGHT
NOW, derives the gap-candidate's approximate position from them (the
midpoint of the two fragments' nearest pair of endpoints -- a stand-in
for the original OCR candidate's own centroid, which
extract_vector_layers.py doesn't currently persist, but close enough
for position-matching purposes since the candidate necessarily sits in
that exact gap), and writes a position-keyed decision entry.

**Run this BEFORE re-running extract_vector_layers.py** so the new
extraction run actually sees what was just decided -- order matters:
if extraction has already re-run since an answer was given, that
answer's fragment ids may no longer point at the right fragments in
the CURRENT geojson, and this script will report it as unresolvable
rather than guess.

Usage:
    python3 scripts/apply_label_review.py
    (run from the project root; reads
    .desk_temp/contour-label-review-log.json, writes/updates
    Data/mapFeatures/SamoWeb_<Plan>_Contours.review_decisions.json)
"""
from __future__ import annotations

import json
from pathlib import Path

from extract_vector_layers import FEATURES_DIR, PROJECT_DIR, review_decisions_path

LOG_PATH = PROJECT_DIR / ".desk_temp" / "contour-label-review-log.json"


def plan_label(plan: str) -> str:
    return "ActualStatePlan" if plan == "actual" else "RestoredStatePlan"


def geojson_path(plan: str) -> Path:
    return FEATURES_DIR / f"SamoWeb_{plan_label(plan)}_Contours.geojson"


def fragment_gap_midpoint(features: list[dict], id_a: int, id_b: int) -> tuple[float, float] | None:
    if id_a >= len(features) or id_b >= len(features) or id_a < 0 or id_b < 0:
        return None
    coords_a = features[id_a]["geometry"]["coordinates"]
    coords_b = features[id_b]["geometry"]["coordinates"]
    endpoints_a = [coords_a[0], coords_a[-1]]
    endpoints_b = [coords_b[0], coords_b[-1]]
    best = None
    best_d = None
    for pa in endpoints_a:
        for pb in endpoints_b:
            d = (pa[0] - pb[0]) ** 2 + (pa[1] - pb[1]) ** 2  # relative comparison only -- no need for real meters here
            if best_d is None or d < best_d:
                best_d, best = d, (pa, pb)
    assert best is not None
    pa, pb = best
    return ((pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2)


def main() -> None:
    if not LOG_PATH.is_file():
        print(f"No review log at {LOG_PATH} -- nothing to apply.")
        return
    answers = json.loads(LOG_PATH.read_text()).get("answers", [])
    if not answers:
        print("Review log has no answers yet.")
        return

    by_plan: dict[str, list[dict]] = {}
    for ans in answers:
        by_plan.setdefault(ans["plan"], []).append(ans)

    for plan, plan_answers in by_plan.items():
        gj_path = geojson_path(plan)
        if not gj_path.is_file():
            print(f"  [{plan}] no geojson found at {gj_path} -- skipped")
            continue
        features = json.loads(gj_path.read_text())["features"]

        dpath = review_decisions_path(plan)
        existing = json.loads(dpath.read_text()).get("decisions", []) if dpath.is_file() else []
        by_review_id = {d.get("reviewId"): d for d in existing if d.get("reviewId")}

        applied = 0
        for ans in plan_answers:
            pos = fragment_gap_midpoint(features, ans["fragmentAId"], ans["fragmentBId"])
            if pos is None:
                print(
                    f"  [{plan}] {ans['reviewId']}: fragments {ans['fragmentAId']}/{ans['fragmentBId']} "
                    f"not found in the current geojson (extraction likely re-ran since this answer) -- skipped"
                )
                continue
            lon, lat = pos
            by_review_id[ans["reviewId"]] = {
                "reviewId": ans["reviewId"],
                "lon": lon,
                "lat": lat,
                "decision": ans["decision"],
                "value": ans["value"],
                "ocrText": ans["ocrText"],
                "resolvedAt": ans["answeredAt"],
            }
            applied += 1
            print(f"  [{plan}] {ans['reviewId']}: {ans['decision']}" + (f" ({ans['value']}m)" if ans["value"] is not None else ""))

        decisions = list(by_review_id.values())
        dpath.write_text(json.dumps({"plan": plan, "decisions": decisions}, indent=2))
        print(f"  [{plan}] wrote {dpath} ({applied} applied this run, {len(decisions)} total)")


if __name__ == "__main__":
    main()
