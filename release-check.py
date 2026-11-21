#!/usr/bin/env python3
"""Fails unless a release would include every piece of work that is on our repos' main lines.

    python3 release-check.py

A release ships what this checkout pins, so each pin must be the head of the branch its work lands on:

- `package.json` dependencies pinned as `github:ayooooo123/<repo>#<sha>`: the head of `main`, or of
  `peartube` for our forks of Holepunch modules (FORK_BRANCH).
- The player: every `peartube-media` `rev` in the apps' Cargo.toml files, the head of its `main`.
- The Rust engine: `native.lock`'s commit, the head of peartube-native `main`; and each crate in that
  commit's `STACK.lock`, the head of the crate's `main` (`peartube` for forks).
- No open, non-draft pull request on any of these repos or on this one: that work is not on a main line yet.

It reads only public GitHub (`git ls-remote`, the REST API; GITHUB_TOKEN raises the rate limit).
After a failure, land the work, publish what needs publishing (a peartube-native `ffi-*` release, then
`python3 sync-native.py pin <tag>`; `python3 sync-player.py`; `npm install <dep>@github:...#<sha>`) and
run it again. `release.yml` runs it before it builds a tagged release.
"""
import json
import os
import pathlib
import re
import subprocess
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
OWNER = "ayooooo123"
# Forks whose PearTube work lives on a `peartube` branch instead of `main`.
FORK_BRANCH = {"autobee": "peartube", "corestore": "peartube", "hypercore": "peartube", "mdns-sd": "peartube"}


def head(repo, branch=None):
    branch = branch or FORK_BRANCH.get(repo, "main")
    out = subprocess.run(["git", "ls-remote", f"https://github.com/{OWNER}/{repo}.git", f"refs/heads/{branch}"],
                         capture_output=True, text=True, check=True).stdout.split()
    return (out[0] if out else None), branch


def api(path):
    req = urllib.request.Request(f"https://api.github.com/{path}", headers={"Accept": "application/vnd.github+json"})
    if os.environ.get("GITHUB_TOKEN"):
        req.add_header("Authorization", f"Bearer {os.environ['GITHUB_TOKEN']}")
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.load(res)


def raw(repo, sha, path):
    with urllib.request.urlopen(f"https://raw.githubusercontent.com/{OWNER}/{repo}/{sha}/{path}", timeout=30) as res:
        return res.read().decode()


def main():
    problems = []
    pins = []  # (what, repo, pinned sha)

    deps = json.loads((ROOT / "package.json").read_text())["dependencies"]
    for name, spec in sorted(deps.items()):
        m = re.fullmatch(rf"github:{OWNER}/([\w.-]+)#([0-9a-f]{{40}})", spec)
        if m:
            pins.append((f"package.json {name}", m.group(1), m.group(2)))

    media = set()
    for toml in sorted(ROOT.glob("*/**/Cargo.toml")):
        if "node_modules" in toml.parts or "target" in toml.parts:
            continue
        media.update(re.findall(r'peartube-media", rev = "([0-9a-f]{40})"', toml.read_text()))
    if len(media) > 1:
        problems.append(f"the apps pin different peartube-media revs: {sorted(media)}; run python3 sync-player.py")
    for rev in sorted(media):
        pins.append(("player (Cargo.toml)", "peartube-media", rev))

    native = json.loads((ROOT / "native.lock").read_text())["commit"]
    pins.append((f"native.lock {json.loads((ROOT / 'native.lock').read_text())['release']}", "peartube-native", native))
    for line in raw("peartube-native", native, "STACK.lock").splitlines():
        if line.strip() and not line.startswith("#"):
            repo, sha = line.split()[:2]
            pins.append(("peartube-native STACK.lock", repo, sha))

    for what, repo, sha in pins:
        tip, branch = head(repo)
        state = "ok  " if tip == sha else "DIFF"
        print(f"{state} {what}: {repo} {sha[:9]}, {branch} is {tip[:9] if tip else 'missing'}")
        if tip != sha:
            problems.append(f"{what} pins {repo} {sha[:9]}, but {branch} is at {tip[:9] if tip else 'missing'}")

    for repo in sorted({"peartube"} | {repo for _, repo, _ in pins}):
        for pr in api(f"repos/{OWNER}/{repo}/pulls?state=open&per_page=100"):
            label = f"{repo}#{pr['number']} {pr['head']['ref']}: {pr['title']}"
            if pr["draft"]:
                print(f"draft {label} (not counted)")
            else:
                print(f"OPEN {label}")
                problems.append(f"open pull request {label}")

    if problems:
        print(f"\nnot ready: {len(problems)} item(s) would be left out of this release:", file=sys.stderr)
        for p in problems:
            print(f"- {p}", file=sys.stderr)
        sys.exit(1)
    print("\nready: every pin is the head of its branch and no pull request is open")


if __name__ == "__main__":
    main()
