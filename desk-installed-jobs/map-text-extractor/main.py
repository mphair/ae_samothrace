"""Installed Job: map-text-extractor.

Thin orchestrator, exec'd in-process by Desk (see tempui-installed-jobs.md)
-- its only job is to make sure this job's OWN dedicated venv exists (with
opencv-python-headless/numpy installed into it, independent of whatever's
importable under Desk's own shared interpreter), then hand off the real
work to extract.py, run as a genuine subprocess under that venv.

Why a self-managed venv at all, when python-kind Installed Jobs already
run arbitrary pip-importable code in-process: isolating this job's
(fairly specific, fairly heavy) image-processing dependencies from
whatever Desk's own interpreter happens to have installed, so upgrading
either one can't break the other. Installed Jobs have no built-in
per-job venv/interpreter config (unlike desk_hmsvc's service.json) --
this is a manual equivalent, implemented here.

The venv itself lives OUTSIDE this job's own directory (under
`.desk_temp/job-venvs/<job-name>/.venv` at the project root), not
alongside main.py/extract.py -- diagnosed directly (desk_ask_desk_expert
investigation, filed as a Desk-side FEEDBACK too): Desk's own
compute_version_hash walks every byte of every file under a job's own
directory to compute its install hash, with no exclusion for a venv the
way rust jobs' target/ gets excluded. Once this venv grew to ~27k files
/ ~1GB (torch/easyocr/opencv/scipy, added for the OCR step), that hash
computation took ~5-5.5s against this directory -- right at/over
GuiBridge.call's hardcoded 5-second timeout that both desk_install_job
and desk_run_installed_job go through, so every single install/run call
failed with "GuiBridge: GUI thread did not respond in time," every time,
reboot-proof, regardless of anything happening elsewhere in the
session -- it was never contention or a stuck dialog, just a
deterministic timeout from hashing this directory's own venv. Keeping
the venv out of this directory entirely keeps the hashed directory down
to the 3 small source files, which is what actually fixes it (not a
retry, not a reboot).

Generalized over which map image to process -- not hardcoded to one
screenshot -- via this job's own config_path (see
tempui-installed-jobs.md): {"source_image": "<project-relative path>",
"output_dir": "<project-relative path>", "project_dir": "<optional,
falls back to DESK_PROJECT_DIR>"}.
"""
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

# No __file__ here -- Desk exec()s this script's text with a custom
# globals dict (see installed_jobs.py's own run_script), not loads it as
# a real module. It does `sys.path.insert(0, job_dir)` right before exec
# so a sibling file can be imported, which doubles as the only reliable
# way for this script to learn its own directory.
JOB_DIR = Path(sys.path[0]).resolve()
# project_root/desk-installed-jobs/<job-name>/ -- the fixed structural
# convention every Installed Job lives under (tempui-installed-jobs.md),
# relied on here just to find the project root without needing
# DESK_PROJECT_DIR (not guaranteed set yet at this point -- see
# _resolve_paths below, which reads it from config.json as a fallback).
PROJECT_DIR = JOB_DIR.parent.parent
REQUIREMENTS_PATH = JOB_DIR / "requirements.txt"
EXTRACT_SCRIPT = JOB_DIR / "extract.py"
# Deliberately OUTSIDE JOB_DIR -- see the module docstring's own
# "venv lives outside this job's own directory" section for why.
VENV_DIR = PROJECT_DIR / ".desk_temp" / "job-venvs" / JOB_DIR.name / ".venv"
REQUIREMENTS_STAMP = VENV_DIR / ".requirements_sha256"


def _venv_python() -> Path:
    # hmsvc's own venv convention (see tempui-hmsvc.md) -- <venv>/bin/python.
    return VENV_DIR / "bin" / "python"


def _requirements_hash() -> str:
    return hashlib.sha256(REQUIREMENTS_PATH.read_bytes()).hexdigest()


def _ensure_venv() -> Path:
    """Creates the venv and installs requirements.txt into it if either is
    missing or requirements.txt has changed since the last install. Returns
    the venv's own python executable path."""
    python = _venv_python()
    current_hash = _requirements_hash()
    stamped_hash = REQUIREMENTS_STAMP.read_text().strip() if REQUIREMENTS_STAMP.is_file() else None

    if python.is_file() and stamped_hash == current_hash:
        return python

    print(f"map-text-extractor: (re)building venv at {VENV_DIR} ...")
    subprocess.run([sys.executable, "-m", "venv", str(VENV_DIR)], check=True)
    subprocess.run(
        [str(python), "-m", "pip", "install", "--quiet", "-r", str(REQUIREMENTS_PATH)],
        check=True,
    )
    REQUIREMENTS_STAMP.write_text(current_hash)
    print("map-text-extractor: venv ready.")
    return python


def _resolve_paths() -> tuple[Path, Path]:
    try:
        config_path_global = CONFIG_PATH  # type: ignore[name-defined]  -- injected by Desk's own installed-job runner
    except NameError:
        config_path_global = None
    if not config_path_global:
        raise RuntimeError(
            "map-text-extractor needs a config_path: "
            '{"source_image": "<project-relative path>", "output_dir": "<project-relative path>", '
            '"project_dir": "<optional, else DESK_PROJECT_DIR>"}'
        )
    config = json.loads(Path(config_path_global).read_text())

    project_dir = config.get("project_dir") or os.environ.get("DESK_PROJECT_DIR")
    if not project_dir:
        raise RuntimeError(
            "config.json must set project_dir (installed jobs get neither a reliable cwd nor DESK_PROJECT_DIR)"
        )
    project_dir = Path(project_dir).resolve()

    source_image = config.get("source_image")
    output_dir = config.get("output_dir")
    if not source_image or not output_dir:
        raise RuntimeError('config.json must set both "source_image" and "output_dir" (project-relative paths)')

    return (project_dir / source_image).resolve(), (project_dir / output_dir).resolve()


def _ssl_cert_env() -> dict:
    """extract.py's OCR step (easyocr) downloads model weights on first
    use, over HTTPS, the first time this job ever runs on a given
    machine (cached under ~/.EasyOCR afterward, not re-downloaded). The
    stock python.org macOS build has no system CA bundle wired up by
    default (a well-known gap, normally plugged by running that
    installer's own "Install Certificates.command" once) -- rather than
    depend on that having happened, point SSL_CERT_FILE at the `certifi`
    package already being installed into this job's own venv (see
    requirements.txt) so the download works regardless."""
    env = os.environ.copy()
    cert_matches = list(VENV_DIR.glob("lib/python*/site-packages/certifi/cacert.pem"))
    if cert_matches:
        env["SSL_CERT_FILE"] = str(cert_matches[0])
    return env


def main() -> None:
    source_image, output_dir = _resolve_paths()
    python = _ensure_venv()

    result = subprocess.run(
        [str(python), str(EXTRACT_SCRIPT), str(source_image), str(output_dir)],
        capture_output=True,
        text=True,
        env=_ssl_cert_env(),
    )
    if result.stdout:
        print(result.stdout, end="")
    if result.stderr:
        print(result.stderr, end="", file=sys.stderr)
    if result.returncode != 0:
        raise RuntimeError(f"extract.py exited with code {result.returncode} -- see stderr above")


main()
