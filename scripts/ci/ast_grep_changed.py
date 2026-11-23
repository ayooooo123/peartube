"""Fail a pull request only for ast-grep error matches that touch lines it adds or changes.

A new rule can match old code. Failing on old matches would block every pull request, so this
script runs `ast-grep scan`, keeps the error-level matches, and fails only when a match spans a
line that `git diff <base>...HEAD` adds or changes. It counts the other matches and does not
fail on them.

Usage: python3 scripts/ci/ast_grep_changed.py --base <rev>
Environment: AST_GREP names the ast-grep binary (default: ast-grep).
Exit codes: 0 no new violations, 1 new violations, 2 script or tool error.
"""

import argparse
import ast
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import NoReturn

ROOT = Path(__file__).resolve().parents[2]  # the repository root, where sgconfig.yml lives
HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")


def die(message: str) -> NoReturn:
    print(f"ast_grep_changed: {message}", file=sys.stderr)
    sys.exit(2)


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(cmd, cwd=ROOT, capture_output=True,
                              encoding="utf-8", errors="replace")
    except OSError as err:
        die(f"cannot run {cmd[0]}: {err}")


def unquote(name: str) -> str:
    # git quotes a name with unusual bytes as a C string, for example "b/caf\303\251.rs".
    if name.startswith('"'):
        return ast.literal_eval("b" + name).decode("utf-8")
    return name


def changed_lines(base: str) -> dict[str, set[int]]:
    """Map each file to the new-side line numbers (1-based) that the diff adds or changes."""
    # The flags keep user diff settings (color, external tool, noprefix) from changing the output.
    proc = run(["git", "diff", "--unified=0", "--no-color", "--no-ext-diff", "--diff-filter=AMR",
                "-M", "--src-prefix=a/", "--dst-prefix=b/", f"{base}...HEAD"])
    if proc.returncode:
        die(f"git diff failed: {proc.stderr.strip()}")
    changed: dict[str, set[int]] = {}
    path = ""
    added_left = 0  # added lines of the current hunk that are still to read
    for line in proc.stdout.splitlines():
        if added_left:  # a body line; added text "++ x" appears as "+++ x"
            added_left -= line.startswith("+")
        elif line.startswith("+++ "):
            # git adds a tab after a name that contains a space.
            path = unquote(line[4:].rstrip("\t")).removeprefix("b/")
        elif line.startswith("@@"):
            hunk = HUNK.match(line)
            start, count = int(hunk[1]), int(hunk[2] or 1)  # "+N" alone means one line
            added_left = count
            changed.setdefault(path, set()).update(range(start, start + count))
    return changed


def error_matches() -> list[dict]:
    proc = run([os.environ.get("AST_GREP", "ast-grep"), "scan", "--json=stream"])
    if proc.returncode not in (0, 1):  # 1 means that ast-grep found error-level matches
        die(f"ast-grep exited with {proc.returncode}: {proc.stderr.strip()}")
    matches = []
    for line in proc.stdout.splitlines():
        try:
            hit = json.loads(line)
        except json.JSONDecodeError:
            die(f"ast-grep printed a line that is not JSON: {line[:200]}")
        if hit["severity"] == "error":
            matches.append(hit)
    return matches


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base", required=True, help="revision that the pull request starts from")
    changed = changed_lines(parser.parse_args().base)
    annotate = os.environ.get("GITHUB_ACTIONS") == "true"
    new = older = 0
    for hit in error_matches():
        path = os.path.normpath(hit["file"])
        first, last = hit["range"]["start"]["line"] + 1, hit["range"]["end"]["line"] + 1
        if not any(n in changed.get(path, ()) for n in range(first, last + 1)):
            older += 1
            continue
        new += 1
        if annotate:
            where = f"::error file={path},line={first},endLine={last}::"
        else:
            where = f"{path}:{first}: "
        print(f"{where}[{hit['ruleId']}] {hit['message']}")
    print(f"{new} new rule violations in changed lines; "
          f"{older} older violations on unchanged lines (run `ast-grep scan` to list them).")
    return 1 if new else 0


if __name__ == "__main__":
    sys.exit(main())
