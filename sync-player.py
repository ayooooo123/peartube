#!/usr/bin/env python3
"""Pins the apps' player to a peartube-media commit.

Sets the `rev` of the `player` and `codecs` git dependencies in
desktop/Cargo.toml (the Mac app), android/native/Cargo.toml, and
ios/native/Cargo.toml (the mobile player libraries), and copies
peartube-media's [patch.crates-io] block into each, which pins every OxideAV
crate (Cargo applies patches only from the top-level manifest).

    python3 sync-player.py [--local] [path to a peartube-media checkout]

The default checkout is ~/projects/peartube-media; without `--local`, its HEAD must be pushed.
"""
import os, pathlib, re, subprocess, sys

args = [a for a in sys.argv[1:] if a != "--local"]
local_mode = "--local" in sys.argv[1:]
media = pathlib.Path(args[0] if args else "~/projects/peartube-media").expanduser().resolve()
root = pathlib.Path(__file__).resolve().parent
manifests = [
    root / "desktop" / "Cargo.toml",
    root / "android" / "native" / "Cargo.toml",
    root / "ios" / "native" / "Cargo.toml",
    root / "web" / "Cargo.toml",
]

block = re.search(r"# BEGIN pin-oxideav\n.*?# END pin-oxideav\n", (media / "Cargo.toml").read_text(), re.S)
if not block:
    sys.exit("peartube-media/Cargo.toml has no pin-oxideav block")
pattern = re.compile(r"# BEGIN pin-oxideav\n.*?# END pin-oxideav\n", re.S)

if local_mode:
    for manifest in manifests:
        text = manifest.read_text()
        rel_crates = os.path.relpath(media / "crates", manifest.parent).replace("\\", "/")
        for crate in ("player", "codecs", "audio-trim"):
            text = re.sub(
                rf'^({re.escape(crate)}\s*=\s*\{{[^\n]*\}})',
                f'{crate} = {{ path = "{rel_crates}/{crate}" }}',
                text,
                flags=re.M,
            )
        text = pattern.sub(lambda _: block.group(0), text) if pattern.search(text) else text.rstrip("\n") + "\n\n" + block.group(0)
        manifest.write_text(text)
    print(f"player wired locally to {media}")
else:
    rev = subprocess.check_output(["git", "-C", media, "rev-parse", "HEAD"], text=True).strip()
    pushed = subprocess.run(["git", "-C", media, "branch", "-r", "--contains", rev], capture_output=True, text=True).stdout
    if not pushed.strip():
        sys.exit(f"peartube-media {rev[:9]} is not pushed (pass --local to wire local path)")
    for manifest in manifests:
        text = manifest.read_text()
        for crate in ("player", "codecs", "audio-trim"):
            text = re.sub(
                rf'^({re.escape(crate)}\s*=\s*\{{[^\n]*\}})',
                f'{crate} = {{ git = "https://github.com/ayooooo123/peartube-media", rev = "{rev}" }}',
                text,
                flags=re.M,
            )
        text = pattern.sub(lambda _: block.group(0), text) if pattern.search(text) else text.rstrip("\n") + "\n\n" + block.group(0)
        manifest.write_text(text)
    print(f"player pinned to peartube-media {rev[:9]}")
