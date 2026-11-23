#!/usr/bin/env python3
"""Fail a pull request that weakens a test.

    python3 scripts/ci/test_guard.py --base <rev> [--head <rev>]

The script reads only git. It reports a removed test, a removed or changed assertion, a new skip marker,
a longer or removed time limit, and a change to how the tests run. It cannot tell a correct change from a
weakening, so every finding fails, and a person decides at merge time whether the change is correct.
Exit 0: no finding. Exit 1: findings. Exit 2: git failed.
In CI, check out the full history (`fetch-depth: 0`): the script needs the merge base of --base and --head.
"""
import argparse
import os
import re
import subprocess
import sys
from collections import Counter, namedtuple

TIME = r'timeout|Timeout|TIMEOUT|from_secs|from_millis|sleep|deadline|Deadline|waitFor'
DOUBLE = r'"(?:\\.|[^"\\])*"'
QUOTE = DOUBLE + r"|'(?:\\.|[^'\\])'"  # a string or a one-character literal (so a lifetime `'a` is not a quote)
JS_QUOTE = DOUBLE + r"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`"

# The languages. To add one, add an entry. `ext` is a tuple of file suffixes and `comment` starts a comment
# line. Every other value is a regex. An entry may leave out a rule that it does not need.
#   where      the paths of files that hold test code
#   region     a line that starts an item that only the test build compiles (Rust `#[cfg(test)]`)
#   attr       a line with a test attribute; `decl` finds the declaration that the attribute marks
#   name       a test declaration on one line (`decl` and `name` hold the name of the test in the group `name`)
#   assertion  where an assertion starts          skip   a marker that switches a test off
#   time       a word that marks a time limit     quote  a string (the brackets inside it do not count)
#   limit      a line that sets a time limit; a file with fewer such lines than before has lost a limit
LANGS = {
    'rust': dict(
        ext=('.rs',), where=r'(^|/)tests/|(^|/)tests\.rs$|_tests\.rs$', comment='//', quote=QUOTE, time=TIME,
        region=r'^\s*#\[cfg\((?:all\()?test\b', attr=r'^\s*#\[(?!cfg)[^\]]*test', decl=r'\bfn\s+(?P<name>\w+)',
        assertion=r'\b(?:prop_)?assert\w*!', skip=r'#\[ignore'),
    'js': dict(
        ext=('.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts'),
        where=r'(^|/)tests?/|\.(test|spec)\.\w+$', comment='//', quote=JS_QUOTE, time=TIME,
        name=r'''(?<![\w.])(?:t\.)?test(?:\.\w+)?\(\s*(?P<q>['"`])(?P<name>.+?)(?P=q)''',
        assertion=r'\bt\.(?:is|not|ok|absent|alike|unlike|exception|execution|pass|fail)(?=[.(])'
                  r'|\bassert[.(]|\bexpect\(',
        skip=r'\.skip\(|skip:|\.todo\(|\.solo\(|solo:|\.only\('),
    'kotlin': dict(
        ext=('.kt', '.kts'), where=r'(^|/)src/(test|androidTest)/', comment='//', quote=QUOTE, time=TIME,
        attr=r'^\s*@(?:Parameterized|Repeated)?Test(?:Factory)?\b', decl=r'\bfun\s+(?P<name>`[^`]+`|\w+)',
        assertion=r'\bassert\w*\(', skip=r'@Ignore|@Disabled|assumeTrue\('),
    'swift': dict(
        ext=('.swift',), where=r'(^|/)[^/]*Tests/|Tests\.swift$', comment='//', quote=QUOTE, time=TIME,
        attr=r'^\s*@Test\b', decl=r'\bfunc\s+(?P<name>\w+)', name=r'\bfunc\s+(?P<name>test\w*)',
        assertion=r'\bXCTAssert\w*\(|#(?:expect|require)\(', skip=r'XCTSkip|\.disabled\('),
    'workflow': dict(
        ext=('.yml', '.yaml'), where=r'^\.github/workflows/', comment='#', time=TIME, skip=r'--skip(?![\w-])',
        limit=r'^\s*timeout-minutes\s*:'),
}

# Files that set how the tests run: (path regex, the line that opens the block of a changed line, the changed line).
# A TOML file is read by section header, any other file by the nearest less indented line. None means any.
PROFILE = [
    (r'(^|/)Cargo\.toml$', r'^\[(profile\.|dev-dependencies|target\..*dev-dependencies)', None),
    (r'(^|/)\.cargo/config(\.toml)?$', None, None),
    (r'(^|/)\.config/nextest\.toml$', None, None),
    (r'^\.github/workflows/[^/]+\.ya?ml$', None,
     r'cargo test|cargo nextest|npm test|npm run test|node --test|brittle|--test-[a-z]|--include-ignored|--ignored'
     r'|--skip|RUST_TEST_THREADS|gradlew|xcodebuild'),
    (r'(^|/)package\.json$', r'"scripts"\s*:', r'^\s*"test[^"]*"\s*:'),
]

DIFF = ['diff', '-M', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/']
HUNK = re.compile(r'^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@')
NUMBER = re.compile(r'(?<![\w.])\d+(?:_\d+)*(?:\.\d+)?')

# One weakened test: its place, the rule that found it, and what changed.
Finding = namedtuple('Finding', 'path line kind detail')
# One `--unified=0` hunk: old start and size, new start and size, and the removed and added (number, text) lines.
Hunk = namedtuple('Hunk', 'a b c d removed added')
# One version of a file: all its lines, and the non-comment lines that are test code (number -> text).
Side = namedtuple('Side', 'lines code')

def git(*args):
    """Run git and return its output as text; if git fails, print why and exit with status 2."""
    try:
        done = subprocess.run(['git', '-c', 'core.quotePath=false', *args], capture_output=True, check=True)
    except (subprocess.CalledProcessError, OSError) as error:
        print(f'test_guard: git {args[0]} failed: {(getattr(error, "stderr", None) or b"").decode().strip() or error}',
              file=sys.stderr)
        sys.exit(2)
    return done.stdout.decode('utf-8', 'replace')

def parse_status(text):
    """(old path, new path) of each changed file; the old path is None if added, the new path None if deleted."""
    parts = [line.split('\t') for line in text.splitlines()]
    return [(None if p[0][0] == 'A' else p[1], None if p[0][0] == 'D' else p[-1]) for p in parts]

def diff_path(line):
    """The path in a `--- ` or `+++ ` header line, without its `a/` or `b/`; None for /dev/null."""
    path = line[4:].split('\t')[0].strip('"')
    return None if path == '/dev/null' else path[2:]

def parse_diff(text):
    """Map each changed path (the new name; the old name if deleted) to its hunks."""
    files, old, cur = {}, None, None
    for line in text.split('\n'):
        if line.startswith('diff --git '):
            old, cur = None, None
        elif cur is None and line.startswith('--- '):
            old = diff_path(line)
        elif cur is None and line.startswith('+++ '):
            cur = files.setdefault(diff_path(line) or old, [])
        elif cur is not None and (m := HUNK.match(line)):
            cur.append(Hunk(*(int(g or 1) for g in m.groups()), [], []))
        elif cur and line[:1] == '-':
            cur[-1].removed.append((cur[-1].a + len(cur[-1].removed), line[1:]))
        elif cur and line[:1] == '+':
            cur[-1].added.append((cur[-1].c + len(cur[-1].added), line[1:]))
    return files

def head_line(hunks, line):
    """Where a base line is at head: moved by the hunks above it; a removed line keeps its place in its hunk."""
    shift = 0
    for h in hunks:
        if h.a <= line < h.a + h.b:
            return max(h.c + min(line - h.a, h.d - 1), h.c, 1)
        if (h.a + h.b if h.b else h.a + 1) <= line:
            shift += h.d - h.b
    return line + shift

def uncomment(lang, s):
    """The line without its trailing comment (a comment marker inside a string stays)."""
    return re.sub(f"({lang['quote']})|{re.escape(lang['comment'])}.*", lambda m: m.group(1) or '', s)

def plain(lang, s):
    """The line without its trailing comment and without what is inside its strings."""
    return re.sub(lang['quote'], '', uncomment(lang, s))

def brackets(text):
    """Opening brackets minus closing brackets in a text."""
    return sum(map(text.count, '([{')) - sum(map(text.count, ')]}'))

def regions(lang, lines):
    """Numbers of the lines in items that a test-only attribute guards, up to the closing brace or the `;`."""
    inside, active, level, opened = set(), False, 0, False
    for n, line in enumerate(lines, 1):
        if not active and re.search(lang['region'], line):
            active, level, opened = True, 0, False
        if active:
            inside.add(n)
            text = plain(lang, line)
            level, opened = level + brackets(text), opened or '{' in text
            active = not (level < 0 or level == 0 and (opened or text.rstrip().endswith(';')))
    return inside

def load(rev, path, lang):
    """Read a file at a revision (an empty file if it does not exist there)."""
    lines = git('show', f'{rev}:{path}').split('\n') if path else []
    code = {}
    if lang and path:
        test = set(range(1, len(lines) + 1)) if re.search(lang['where'], path) else (
            regions(lang, lines) if 'region' in lang else set())
        code = {n: s for n, s in enumerate(lines, 1) if n in test and not s.lstrip().startswith(lang['comment'])}
    return Side(lines, code)

def names(lang, code):
    """(test name, line) pairs: a declaration after a test attribute, or a one-line test declaration."""
    found, armed = {}, False
    for n, s in code.items():
        armed = armed or bool(lang.get('attr') and re.search(lang['attr'], s))
        if armed and (m := re.search(lang['decl'], s)):
            found[n], armed = m.group('name'), False
        elif armed and re.search(r'[;{}]\s*$', s):
            armed = False
        if lang.get('name') and (m := re.search(lang['name'], s)):
            found[n] = m.group('name')
    return [(name, n) for n, name in found.items()]

def squash(text):
    """Collapse whitespace; ignore what a reformat moves: spaces inside brackets, before `.method`, last commas."""
    text = re.sub(r'([(\[{]) | ([)\]}])|\s+(?=\.[A-Za-z_])', r'\1\2', ' '.join(text.split()))
    return re.sub(r',([)\]}])', r'\1', text)

def statements(lang, code):
    """(assertion statement, line) pairs: from the assertion token to the line where its brackets balance."""
    rows = [(n, uncomment(lang, s)) for n, s in code.items()] if 'assertion' in lang else []
    out = []
    for i, (n, first) in enumerate(rows):
        if not (m := re.search(lang['assertion'], first)):
            continue
        parts, level = [], 0
        for k in range(i, min(i + 60, len(rows))):
            parts.append(rows[k][1][m.start():] if k == i else rows[k][1])
            level += brackets(plain(lang, parts[-1]))
            if level <= 0 and not (k + 1 < len(rows) and rows[k + 1][1].lstrip().startswith('.')):
                break
        text = ' '.join(parts).rstrip()
        while level < 0 and text[-1:] in tuple(';)]} '):  # the closers of the block around a one-line test
            level, text = level + (text[-1] in ')]}'), text[:-1]
        out.append((squash(text), n))
    return out

def lost(old, new):
    """The (key, line) items of `old` whose key is in `new` fewer times, in file order (a multiset difference)."""
    left = Counter(k for k, _ in old) - Counter(k for k, _ in new)
    out = []
    for key, n in old:
        if left[key] > 0:
            left[key] -= 1
            out.append((key, n))
    return out

def short(text, limit=110):
    """Cut a text that is too long for one message line."""
    return text if len(text) <= limit else text[:limit - 3] + '...'

def markers(lang, s):
    """The skip markers on a line."""
    return [m.group() for m in re.finditer(lang['skip'], s)] if 'skip' in lang else []

def new_skips(path, lang, old, new, hunks):
    """A skip marker on an added line that the file has more often than it had."""
    before = Counter(m for s in old.code.values() for m in markers(lang, s))
    after = Counter(m for s in new.code.values() for m in markers(lang, s))
    for h in hunks:
        for n, s in h.added:
            more = [m for m in markers(lang, s) if n in new.code and after[m] > before[m]]
            if more:
                yield Finding(path, n, 'new-skip', f'"{more[0]}" now {after[more[0]]} times in the file, '
                                                   f'was {before[more[0]]}: {short(s.strip())}')

def longer_limits(path, lang, old, new, hunks):
    """In one hunk: a removed and an added line that differ only in numbers, hold a time word, and one number grew."""
    for h in hunks:
        before = {}
        for n, s in h.removed:
            if n in old.code and re.search(lang['time'], s):
                before.setdefault(NUMBER.sub('#', s.strip()), []).append(NUMBER.findall(s))
        for n, s in h.added:
            numbers = before.get(NUMBER.sub('#', s.strip()))
            if numbers and n in new.code and re.search(lang['time'], s):
                grown = [f'{a} -> {b}' for a, b in zip(numbers.pop(0), NUMBER.findall(s)) if float(b) > float(a)]
                if grown:
                    yield Finding(path, n, 'longer-limit', f"{', '.join(grown)}: {short(s.strip())}")

def removed_limits(path, lang, old, new, hunks):
    """Fewer time limit lines than before: without its own limit, a job runs until a longer default limit."""
    if 'limit' not in lang:
        return
    before = sum(1 for s in old.code.values() if re.search(lang['limit'], s))
    after = sum(1 for s in new.code.values() if re.search(lang['limit'], s))
    if after < before:
        n, s = next((row for h in hunks for row in h.removed if re.search(lang['limit'], row[1])), (1, ''))
        yield Finding(path, head_line(hunks, n), 'longer-limit', f'{before} -> {after} time limits: -{short(s.strip())}')

def opener(lines, i, toml):
    """The line that opens the block of lines[i]: its TOML section header, else the nearest less indented line."""
    indent = len(lines[i]) - len(lines[i].lstrip())
    for j in range(i, -1, -1):
        s = lines[j]
        if s.startswith('[') if toml else (j < i and s.strip() and len(s) - len(s.lstrip()) < indent):
            return s
    return ''

def profile_changes(path, rule, old, new, hunks):
    """A changed line (not a comment) in a file that sets how the tests run."""
    opener_re, line_re = rule
    for h in hunks:
        for sign, side, rows in (('-', old, h.removed), ('+', new, h.added)):
            for n, s in rows:
                if s.strip() and not s.lstrip().startswith('#') and (not line_re or re.search(line_re, s)) and (
                        not opener_re or re.search(opener_re, opener(side.lines, n - 1, path.endswith('.toml')))):
                    yield Finding(path, n if sign == '+' else head_line([h], n), 'test-profile-changed',
                                  f'{sign}{short(s.strip())}')

def scan(base, head):
    """Every way in which the changes from base to head weaken a test."""
    root = git('merge-base', base, head).strip()
    changes = parse_status(git(*DIFF, '--name-status', f'{base}...{head}'))
    hunks = parse_diff(git(*DIFF, '--unified=0', f'{base}...{head}'))
    found, gone, came = [], [], Counter()
    for old_path, new_path in changes:
        path = new_path or old_path
        lang = next((x for x in LANGS.values() if path.endswith(x['ext'])), None)
        rule = next(((o, ln) for p, o, ln in PROFILE if re.search(p, path)), None)
        if not lang and not rule:
            continue
        old, new, hs = load(root, old_path, lang), load(head, new_path, lang), hunks.get(path, [])
        if lang:
            before, after = names(lang, old.code), names(lang, new.code)
            gone += [(name, path, head_line(hs, n)) for name, n in lost(before, after)]
            came.update(name for name, _ in lost(after, before))
            for text, n in lost(statements(lang, old.code), statements(lang, new.code)):
                found.append(Finding(path, head_line(hs, n), 'assertion-changed', f'removed or changed: {short(text)}'))
            found += list(new_skips(path, lang, old, new, hs)) + list(longer_limits(path, lang, old, new, hs))
            found += removed_limits(path, lang, old, new, hs)
        if rule:
            found += profile_changes(path, rule, old, new, hs)
    for name, path, line in gone:  # a test that moved to another file is not gone
        if came[name] > 0:
            came[name] -= 1
        else:
            found.append(Finding(path, line, 'removed-test', f'test {name} is in no test file at head'))
    return sorted(set(found))

def report(findings):
    """Print one line for each finding and one summary line."""
    github = os.environ.get('GITHUB_ACTIONS') == 'true'
    for f in findings:
        if github:
            text = f'{f.kind}: {f.detail}'.replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')
            print(f'::error file={f.path},line={f.line}::{text}')
        else:
            print(f'{f.path}:{f.line}: {f.kind}: {f.detail}')
    count = f'{len(findings)} finding{"" if len(findings) == 1 else "s"}'
    print(f'test_guard: {count}.' + (' A person decides at merge time whether each change is correct.' if findings else ''))

def main():
    """Read the command line, scan, report, and return the exit status."""
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--base', required=True, help='the revision that the pull request starts from')
    parser.add_argument('--head', default='HEAD', help='the revision of the pull request (default HEAD)')
    args = parser.parse_args()
    findings = scan(args.base, args.head)
    report(findings)
    return 1 if findings else 0

if __name__ == '__main__':
    sys.exit(main())
