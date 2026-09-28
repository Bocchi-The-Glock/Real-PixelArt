"""Synchronize the Python core into a self-contained static website; no server code."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import shutil
import sys
import urllib.request
import zipfile

WEB = Path(__file__).resolve().parent
ROOT = WEB.parent
VERSION = "0.26.4"  # Python 3.12 / NumPy 1.26.4, matching the desktop numerical stack.
CDN = f"https://cdn.jsdelivr.net/pyodide/v{VERSION}/full/"


def bundle():
    sys.path.insert(0, str(ROOT / "src"))
    from dataclasses import asdict
    from realpixelart import Config, __version__, palette_catalog
    entries = {"realpixelart/" + p.name: p.read_bytes()
               for p in sorted((ROOT / "src/realpixelart").glob("*.py"))}
    entries["realpixelart/palettes.json"] = (ROOT / "src/realpixelart/palettes.json").read_bytes()
    entries["web_bridge.py"] = (WEB / "bridge.py").read_bytes()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries.items():
            info = zipfile.ZipInfo(name, (2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)
    data = buffer.getvalue()
    manifest = dict(version=__version__, pyodide=VERSION, defaults=asdict(Config()), palettes=palette_catalog(),
                    bundle_sha256=hashlib.sha256(data).hexdigest(),
                    files={name: hashlib.sha256(raw).hexdigest() for name, raw in entries.items()})
    return data, (json.dumps(manifest, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def download_runtime():
    target = WEB / "vendor/pyodide"
    target.mkdir(parents=True, exist_ok=True)
    def get(name, expected=None):
        path = target / name
        if path.is_file() and (expected is None or hashlib.sha256(path.read_bytes()).hexdigest() == expected):
            return
        print("Downloading", name, flush=True)
        with urllib.request.urlopen(CDN + name, timeout=120) as response:
            data = response.read()
        if expected and hashlib.sha256(data).hexdigest() != expected:
            raise ValueError("Checksum mismatch: " + name)
        path.write_bytes(data)
    for name in ("pyodide-lock.json", "pyodide.js", "pyodide.asm.js", "pyodide.asm.wasm", "python_stdlib.zip"):
        get(name)
    lock = json.loads((target / "pyodide-lock.json").read_text())
    pending, seen = ["numpy", "pillow"], set()
    while pending:
        name = pending.pop()
        if name in seen:
            continue
        seen.add(name)
        item = lock["packages"][name]
        get(item["file_name"], item["sha256"])
        pending.extend(item["depends"])
    inventory = {p.name: dict(bytes=p.stat().st_size, sha256=hashlib.sha256(p.read_bytes()).hexdigest())
                 for p in sorted(target.iterdir()) if p.is_file()}
    (WEB / "vendor/runtime-manifest.json").write_text(json.dumps(inventory, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", action="store_true", help="download pinned runtime files (one-time setup)")
    parser.add_argument("--check", action="store_true", help="fail if core.zip or manifest is stale")
    args = parser.parse_args()
    data, manifest = bundle()
    if args.check:
        for name, expected in (("core.zip", data), ("core-manifest.json", manifest)):
            if not (WEB / name).exists() or (WEB / name).read_bytes() != expected:
                raise SystemExit(f"Stale {name}; run python web/build.py")
        print("Web core matches src/realpixelart byte-for-byte.")
        return
    (WEB / "core.zip").write_bytes(data)
    (WEB / "core-manifest.json").write_bytes(manifest)
    (WEB / "assets").mkdir(exist_ok=True)
    shutil.copyfile(ROOT / "input/lastTour.png", WEB / "assets/demo.png")
    if args.runtime:
        download_runtime()
    print("Static website synchronized:", WEB)


if __name__ == "__main__":
    main()
