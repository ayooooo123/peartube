#!/usr/bin/env python3
"""Fetches the pinned peartube-native engine libraries that an app build links.

`native.lock` names the peartube-native release, its commit, the app commit it
matches (`jsRef`), the ABI version and each asset's sha256. The apps default to
the JS engine; `-Ppeartube.engine=rust` builds against these prebuilt libraries.

    python3 sync-native.py fetch <asset-key>... <out-dir>
    python3 sync-native.py fetch --local <peartube-native checkout> <asset-key>... <out-dir>
    python3 sync-native.py pin <release-tag>
    python3 sync-native.py check

Asset keys: android-arm64, darwin-arm64, header. `fetch` refuses an unpinned
lock, verifies every sha256 and caches downloads in `$XDG_CACHE_HOME` /
`~/.cache/peartube-native/<release>/`. `--local` builds `ffi/build.sh <target>
<dir>` from a checkout instead and checks no hash. `pin` rewrites `native.lock`
from the release's `ffi-manifest.json` and keeps the existing `engine` map.
`check` lists the contract files changed since the lock's `jsRef`; it fails only
when a platform's default engine is `rust`.
"""
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
LOCK = ROOT / "native.lock"
REPO = "https://github.com/ayooooo123/peartube-native"
ASSET_KEYS = ("android-arm64", "darwin-arm64", "header")
HEADER = "peartube_native.h"
ENGINES = {"android-tv": "js", "android-app": "js", "desktop": "js", "ios": "js"}


def fail(message):
    sys.exit(f"sync-native: {message}")


def load_lock():
    try:
        lock = json.loads(LOCK.read_text())
    except FileNotFoundError:
        fail(f"{LOCK.name} is missing")
    except ValueError as error:
        fail(f"{LOCK.name} is not valid JSON: {error}")
    lock.setdefault("assets", {})
    lock.setdefault("engine", dict(ENGINES))
    return lock


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def cache_dir(release):
    base = os.environ.get("XDG_CACHE_HOME") or (pathlib.Path.home() / ".cache")
    return pathlib.Path(base) / "peartube-native" / release


def download(url, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    print(f"download {url}")
    try:
        with urllib.request.urlopen(url, timeout=120) as response, part.open("wb") as out:
            shutil.copyfileobj(response, out)
    except Exception as error:
        part.unlink(missing_ok=True)
        fail(f"{url}: {error}")
    part.replace(dest)


def fetch_asset(lock, key, out_dir):
    if lock.get("release") in (None, "", "unpinned"):
        fail("native.lock is unpinned: the integrator must run "
             "`python3 sync-native.py pin <release-tag>` after peartube-native publishes a release")
    asset = lock["assets"].get(key)
    if not asset or not asset.get("file"):
        fail(f"native.lock has no asset {key!r}")
    want = asset.get("sha256") or ""
    if len(want) != 64:
        fail(f"native.lock has no sha256 for {key!r}")
    release = lock["release"]
    name = asset["file"]
    url = f"{REPO}/releases/download/{release}/{name}"
    cached = cache_dir(release) / name
    if cached.is_file() and sha256(cached) == want:
        print(f"cached {cached}")
    else:
        cached.unlink(missing_ok=True)
        download(url, cached)
        got = sha256(cached)
        if got != want:
            cached.unlink(missing_ok=True)
            fail(f"{name}: sha256 {got} does not match native.lock's {want}")
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / name
    shutil.copyfile(cached, target)
    print(f"{key} -> {target} ({want})")


def fetch_local(lock, checkout, key, out_dir):
    checkout = pathlib.Path(checkout).expanduser().resolve()
    ffi = checkout / "ffi"
    out_dir.mkdir(parents=True, exist_ok=True)
    if key == "header":
        header = ffi / "include" / HEADER
        if not header.is_file():
            fail(f"{header} is not in the checkout")
        shutil.copyfile(header, out_dir / HEADER)
        print(f"unpinned local header -> {out_dir / HEADER}")
        return
    build = ffi / "build.sh"
    if not build.is_file():
        fail(f"{build} is missing")
    asset = lock["assets"].get(key) or {}
    name = asset.get("file") or f"libpeartube_native_ffi.so"
    work = pathlib.Path(tempfile.mkdtemp(prefix=f"peartube-native-{key}-"))
    try:
        print(f"unpinned local build: sh {build} {key} {work}")
        result = subprocess.run(["sh", str(build), key, str(work)], cwd=str(checkout))
        if result.returncode != 0:
            fail(f"ffi/build.sh {key} exited {result.returncode}")
        found = next(work.rglob(name), None)
        if found is None:
            found = next(work.rglob("libpeartube_native_ffi.*"), None)
        if found is None:
            fail(f"ffi/build.sh {key} wrote no {name} under {work}")
        shutil.copyfile(found, out_dir / name)
        print(f"unpinned local build -> {out_dir / name} (no hash check)")
    finally:
        shutil.rmtree(work, ignore_errors=True)


def cmd_fetch(args):
    local = None
    if "--local" in args:
        index = args.index("--local")
        if index + 1 >= len(args):
            fail("--local needs a peartube-native checkout")
        local = args[index + 1]
        del args[index:index + 2]
    if len(args) < 2:
        fail("usage: fetch [--local <checkout>] <asset-key>... <out-dir>")
    keys, out = args[:-1], pathlib.Path(args[-1]).expanduser().resolve()
    unknown = [key for key in keys if key not in ASSET_KEYS]
    if unknown:
        fail(f"unknown asset key(s) {', '.join(unknown)}; expected {', '.join(ASSET_KEYS)}")
    lock = load_lock()
    for key in keys:
        if local is not None:
            fetch_local(lock, local, key, out)
        else:
            fetch_asset(lock, key, out)
    return 0


def cmd_pin(args):
    if len(args) != 1:
        fail("usage: pin <release-tag>")
    tag = args[0]
    url = f"{REPO}/releases/download/{tag}/ffi-manifest.json"
    with tempfile.TemporaryDirectory(prefix="peartube-native-manifest-") as work:
        manifest_path = pathlib.Path(work) / "ffi-manifest.json"
        download(url, manifest_path)
        try:
            manifest = json.loads(manifest_path.read_text())
        except ValueError as error:
            fail(f"{url}: {error}")
    assets = manifest.get("assets") or {}
    if not isinstance(assets, dict) or not assets:
        fail("ffi-manifest.json has no assets")
    resolved = {}
    for key in ASSET_KEYS:
        if key == "header":
            name = next((name for name in assets if name.endswith(".h")), None)
        else:
            name = next((name for name in assets if key in name), None)
        if name is None:
            fail(f"ffi-manifest.json has no asset for {key!r}: {', '.join(assets)}")
        digest = assets[name]
        if len(digest) != 64:
            fail(f"ffi-manifest.json has no sha256 for {name}")
        resolved[key] = {"file": name, "sha256": digest}
    previous = load_lock() if LOCK.is_file() else {}
    lock = {
        "release": tag,
        "commit": manifest.get("commit", ""),
        "jsRef": manifest.get("jsRef", ""),
        "abiVersion": manifest.get("abiVersion", 1),
        "assets": resolved,
        "engine": previous.get("engine") or dict(ENGINES),
    }
    LOCK.write_text(json.dumps(lock, indent=2) + "\n")
    print(f"native.lock pinned to {tag} ({lock['commit'][:9] or 'no commit'}); "
          f"engines: {', '.join(f'{k}={v}' for k, v in lock['engine'].items())}")
    return 0


def cmd_check(_args):
    lock = load_lock()
    rust = sorted(platform for platform, engine in lock.get("engine", {}).items() if engine == "rust")
    jsref = lock.get("jsRef") or ""
    if lock.get("release") in (None, "", "unpinned"):
        print("native.lock is unpinned; no released engine to check against.")
        return 1 if rust else 0
    if not jsref:
        print("native.lock has no jsRef.")
        return 1 if rust else 0
    exists = subprocess.run(
        ["git", "-C", str(ROOT), "cat-file", "-e", f"{jsref}^{{commit}}"],
        capture_output=True, text=True,
    )
    if exists.returncode != 0:
        print(f"jsRef {jsref[:9]} is not in this checkout's history; fetch it to check the engine contract.")
        return 1 if rust else 0
    diff = subprocess.run(
        ["git", "-C", str(ROOT), "diff", "--name-only", jsref, "HEAD", "--",
         "src", "bin", "worklet/worker.js", ":!src/ui.js"],
        capture_output=True, text=True,
    )
    if diff.returncode != 0:
        print(diff.stderr.strip() or "git diff failed")
        return 1
    changed = [line for line in diff.stdout.splitlines() if line]
    if not changed:
        print(f"engine contract unchanged since jsRef {jsref[:9]}.")
        return 0
    print(f"app contract files changed since native.lock's jsRef {jsref[:9]}:")
    for name in changed:
        print(f"  {name}")
    if rust:
        print(f"platforms defaulting to rust ({', '.join(rust)}) must be re-pinned "
              f"after peartube-native matches this commit")
        return 1
    print("every platform defaults to js; a build-flag rust APK is not covered by this check")
    return 0


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0 if argv else 2
    command, rest = argv[0], argv[1:]
    if command == "fetch":
        return cmd_fetch(rest)
    if command == "pin":
        return cmd_pin(rest)
    if command == "check":
        return cmd_check(rest)
    fail(f"unknown command {command!r}; try --help")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
