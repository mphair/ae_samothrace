#!/usr/bin/env python3
"""Folds answers from the ContourConnector widget into
Data/mapFeatures/SamoWeb_<Plan>_Contours.connections.confirmed.json and
SamoWeb_<Plan>_Contours.connections.rejected.json.

Unlike contour-label-review-log.json (keyed by fragment ids that go
stale across re-runs -- see apply_label_review.py's own docstring for
why that needed a position-translation step), ContourConnector already
writes .desk_temp/contour-connector-log.json position-keyed (every
connection's two endpoints are stored as lon/lat, never a fragment
array index) -- see contour-connector.ts's own "Connection actions"
section. That makes this script a straight fold rather than a
translation: merge the log's `connections` into each plan's own
*.connections.confirmed.json (by connectionId, log wins on conflict,
existing entries not mentioned in this run's log are kept), drop any
connectionId the log lists in `removed`, and record `rejections` in a
parallel *.connections.rejected.json so a future
extract_vector_layers.py run can be taught to skip re-suggesting a
position a human already dismissed (not yet wired up on the extraction
side as of this script's writing -- see that script's own "Known
limitations").

Neither output file is ever read back INTO the log -- the log is the
widget's own append-only record of what happened in the UI; these two
*.connections.*.json files are the derived, Data/mapFeatures-side
artifact other tools (and a future "flatten connections into one
stitched line" pass) are meant to read.

Usage:
    python3 scripts/apply_contour_connections.py
    (run from the project root; reads
    .desk_temp/contour-connector-log.json, writes/updates
    Data/mapFeatures/SamoWeb_<Plan>_Contours.connections.{confirmed,rejected}.json)
"""
from __future__ import annotations

import json
from pathlib import Path

from extract_vector_layers import FEATURES_DIR, PROJECT_DIR

LOG_PATH = PROJECT_DIR / ".desk_temp" / "contour-connector-log.json"


def plan_label(plan: str) -> str:
    return "ActualStatePlan" if plan == "actual" else "RestoredStatePlan"


def confirmed_path(plan: str) -> Path:
    return FEATURES_DIR / f"SamoWeb_{plan_label(plan)}_Contours.connections.confirmed.json"


def rejected_path(plan: str) -> Path:
    return FEATURES_DIR / f"SamoWeb_{plan_label(plan)}_Contours.connections.rejected.json"


def main() -> None:
    if not LOG_PATH.is_file():
        print(f"No connector log at {LOG_PATH} -- nothing to apply.")
        return
    log = json.loads(LOG_PATH.read_text())
    connections = log.get("connections", [])
    rejections = log.get("rejections", [])
    removed = set(log.get("removed", []))

    plans = {c["plan"] for c in connections} | {r["plan"] for r in rejections}
    if not plans:
        print("Connector log has no connections or rejections yet.")
        return

    for plan in sorted(plans):
        cpath = confirmed_path(plan)
        existing = json.loads(cpath.read_text()).get("connections", []) if cpath.is_file() else []
        by_id = {c["connectionId"]: c for c in existing}

        applied = 0
        for c in connections:
            if c["plan"] != plan:
                continue
            by_id[c["connectionId"]] = {
                "connectionId": c["connectionId"],
                "source": c["source"],
                "aLon": c["aLon"],
                "aLat": c["aLat"],
                "bLon": c["bLon"],
                "bLat": c["bLat"],
                "elevationM": c["elevationM"],
                "confirmedAt": c["confirmedAt"],
            }
            applied += 1

        removed_here = 0
        for connection_id in list(by_id):
            if connection_id in removed:
                del by_id[connection_id]
                removed_here += 1

        confirmed_list = list(by_id.values())
        cpath.write_text(json.dumps({"plan": plan, "connections": confirmed_list}, indent=2))
        print(
            f"  [{plan}] wrote {cpath} ({applied} applied this run, {removed_here} removed this run, "
            f"{len(confirmed_list)} total confirmed)"
        )

        rpath = rejected_path(plan)
        existing_rejected = json.loads(rpath.read_text()).get("rejections", []) if rpath.is_file() else []
        by_rejected_id = {r["connectionId"]: r for r in existing_rejected}
        plan_rejections = [r for r in rejections if r["plan"] == plan]
        for r in plan_rejections:
            by_rejected_id[r["connectionId"]] = {"connectionId": r["connectionId"], "rejectedAt": r["rejectedAt"]}
        if by_rejected_id:
            rpath.write_text(json.dumps({"plan": plan, "rejections": list(by_rejected_id.values())}, indent=2))
            print(f"  [{plan}] wrote {rpath} ({len(plan_rejections)} applied this run, {len(by_rejected_id)} total)")


if __name__ == "__main__":
    main()
