import { execFile, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/ci-proof.mjs', import.meta.url));
const ID = { GIT_AUTHOR_NAME: 'Proof Test', GIT_AUTHOR_EMAIL: 'proof@example.invalid', GIT_COMMITTER_NAME: 'Proof Test', GIT_COMMITTER_EMAIL: 'proof@example.invalid' };
const nodeTest = (imports, body) => `import test from 'node:test';\nimport assert from 'node:assert';\n${imports}\ntest('x', () => { ${body} });\n`;
const ok = () => nodeTest('', 'assert.equal(1, 1);');
const bad = () => nodeTest('', 'assert.equal(1, 2);');
const proof = (p = '../src/a.js') => nodeTest(`import { value } from '${p}';`, 'assert.equal(value, 2);');
const row = (file, base, head, expected = 'fails by assertion') => `${file} | ${expected} | ${base} | ${head}`;

function git(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...ID } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
function write(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}
function commit(root, message, paths) {
  if (paths.length) git(root, ['add', '--', ...paths]);
  git(root, ['-c', 'commit.gpgsign=false', 'commit', '-qm', message]);
  return git(root, ['rev-parse', 'HEAD']).trim();
}
function setup(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-proof-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ['init', '-q', '-b', 'main']);
  const all = {
    'package.json': '{"name":"fixture","version":"1.0.0","type":"module"}\n',
    'package-lock.json': '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"fixture","version":"1.0.0"}}}\n',
    ...files,
  };
  write(root, all);
  return { root, base: commit(root, 'base', Object.keys(all)) };
}
function run(root, args, env = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: 'utf8', timeout: 120_000, env: { ...process.env, ...env } });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
function event(root, body, base, head) {
  const file = path.join(root, '.event.json');
  fs.writeFileSync(file, JSON.stringify({ pull_request: { number: 7, body, base: { sha: base }, head: { sha: head } } }));
  return { GITHUB_EVENT_PATH: file };
}
function expect(r, code, ...needles) {
  assert.equal(r.code, code, r.out);
  for (const needle of needles) assert.ok(r.out.includes(needle), `${needle}\n${r.out}`);
}

test('selected files prove on exact head; dirty and filtered files stay out', (t) => {
  const { root, base } = setup(t, {
    'src/a.js': 'export const value = 1;\n',
    'test/mod.test.js': bad(),
    'test/old.test.js': bad(),
    'test/helper.js': 'export const helper = 1;\n',
    'test/exempt-one.test.js': ok(), 'test/nested/exempt-two.test.js': ok(),
  });
  const headFiles = {
    'src/a.js': 'export const value = 2;\n',
    'test/mod.test.js': proof(),
    'test/nested/added.test.js': proof('../../src/a.js'),
    'test/renamed.test.js': proof(),
    'test/uses-helper.test.js': nodeTest("import { helper } from './helper.js';", 'assert.equal(helper, 2);'),
    'test/helper.js': 'export const helper = 2;\n',
    'test/exempt-one.test.js': `${ok()}// touched\n`, 'test/nested/exempt-two.test.js': `${ok()}// touched\n`,
  };
  write(root, headFiles);
  git(root, ['rm', '-q', '--', 'test/old.test.js']);
  const head = commit(root, 'head', Object.keys(headFiles));
  write(root, { 'test/mod.test.js': bad(), 'test/untracked.test.js': bad() });
  const body = 'Passes-on-main: test/exempt-one.test.js, test/nested/exempt-two.test.js — green on base';
  const r = run(root, [], event(root, body, base, head));
  expect(r, 0,
    row('test/mod.test.js', 'assertion failure', 'pass'),
    row('test/nested/added.test.js', 'assertion failure', 'pass'),
    row('test/renamed.test.js', 'assertion failure', 'pass'),
    row('test/uses-helper.test.js', 'assertion failure', 'pass'),
    row('test/exempt-one.test.js', 'pass', 'pass', 'passes (Passes-on-main)'),
    row('test/nested/exempt-two.test.js', 'pass', 'pass', 'passes (Passes-on-main)'));
});

test('each file is judged alone; failures and invalid directives never prove', (t) => {
  const { root, base } = setup(t, {
    'src/a.js': 'export const value = 1;\n',
    'src/wrong.js': 'export const value = 1;\n',
    'src/mode.js': "export const mode = 'base';\n",
    'src/mixed.js': 'export const value = 1;\nexport const run = () => new Promise(resolve => setTimeout(resolve, 2000, 2));\n',
    'src/timeout.js': 'export const run = () => new Promise(resolve => setTimeout(resolve, 2000, 2));\n',
    'src/other.js': "export const run = () => { console.error('AssertionError [ERR_ASSERTION]: 1 == 2'); throw new Error('plain'); };\n",
    'src/syntax.js': 'export const value = ;\n',
    'src/throw.js': "throw new Error('startup');\nexport const value = 2;\n",
  });
  const headFiles = {
    'src/a.js': 'export const value = 2;\n',
    'src/wrong.js': 'export const value = 3;\n',
    'src/mode.js': "export const mode = 'head';\n",
    'src/mixed.js': 'export const value = 2;\nexport const run = () => Promise.resolve(2);\n',
    'src/timeout.js': 'export const run = () => Promise.resolve(2);\n',
    'src/other.js': 'export const run = () => 2;\n',
    'src/syntax.js': 'export const value = 2;\n', 'src/throw.js': 'export const value = 2;\n',
    'src/helper.js': 'export const value = 2;\n',
    'test/proof.test.js': proof(),
    'test/base-pass.test.js': ok(),
    'test/head-fail.test.js': nodeTest("import { value } from '../src/wrong.js';", 'assert.equal(value, 2);'),
    'test/skip.test.js': "import test from 'node:test';\nimport assert from 'node:assert';\nimport { mode } from '../src/mode.js';\ntest('a', { skip: mode === 'head' }, () => assert.equal(mode, 'head'));\ntest('b', { todo: mode === 'head' }, () => assert.equal(mode, 'head'));\n",
    'test/mixed.test.js': "import test from 'node:test';\nimport assert from 'node:assert';\nimport { value, run } from '../src/mixed.js';\ntest('value', () => assert.equal(value, 2));\ntest('run', { timeout: 100 }, async () => assert.equal(await run(), 2));\n",
    'test/timeout.test.js': "import test from 'node:test';\nimport assert from 'node:assert';\nimport { run } from '../src/timeout.js';\ntest('run', { timeout: 100 }, async () => assert.equal(await run(), 2));\n",
    'test/other.test.js': nodeTest("import { run } from '../src/other.js';", "console.error('AssertionError [ERR_ASSERTION]: 1 == 2'); assert.equal(run(), 2);"),
    'test/syntax.test.js': nodeTest("import { value } from '../src/syntax.js';", 'assert.equal(value, 2);'),
    'test/missing.test.js': nodeTest("import { value } from '../src/helper.js';", 'assert.equal(value, 2);'),
    'test/throw.test.js': proof('../src/throw.js'),
  };
  write(root, headFiles);
  const head = commit(root, 'head', Object.keys(headFiles));
  const body = [
    '  Passes-on-main: test/base-pass.test.js -- indented must not count',
    'passes-on-main: test/head-fail.test.js -- lowercase must not count',
    'Passes-on-main: test/base-pass.test.js, test/nope.test.js -- unknown path',
    'Passes-on-main: test/base-pass.test.js',
  ].join('\n');
  const r = run(root, [], event(root, body, base, head));
  expect(r, 1,
    row('test/proof.test.js', 'assertion failure', 'pass'),
    row('test/base-pass.test.js', 'pass', 'pass'),
    row('test/head-fail.test.js', 'assertion failure', 'assertion failure'),
    row('test/skip.test.js', 'assertion failure', 'no genuine pass'),
    row('test/timeout.test.js', 'timeout', 'pass'),
    row('test/other.test.js', 'other failure', 'pass'),
    row('test/syntax.test.js', 'syntax error', 'pass'),
    row('test/missing.test.js', 'missing module', 'pass'));
  assert.match(r.out, /test\/mixed\.test\.js \| fails by assertion \| [^|]*timeout[^|]*\| pass/);
  assert.match(r.out, /test\/throw\.test\.js \| fails by assertion \| (?:other failure|incomplete run) \| pass/);
  const mismatches = ['test/base-pass.test.js', 'test/head-fail.test.js', 'test/skip.test.js', 'test/timeout.test.js', 'test/other.test.js', 'test/syntax.test.js', 'test/missing.test.js', 'test/mixed.test.js', 'test/throw.test.js'];
  for (const file of mismatches) assert.ok(r.out.includes(`MISMATCH ${file}`), file);
});

test('the merge base scopes the PR, the exact base decides the verdict', (t) => {
  const { root } = setup(t, { 'src/a.js': 'export const value = 1;\n', 'test/one.test.js': bad(), 'README.md': 'start\n' });
  git(root, ['checkout', '-q', '-b', 'feature']);
  write(root, { 'src/a.js': 'export const value = 2;\n', 'test/one.test.js': proof() });
  const head = commit(root, 'feature', ['src/a.js', 'test/one.test.js']);
  git(root, ['checkout', '-q', 'main']);
  write(root, { 'src/a.js': 'export const value = 2;\n', 'test/one.test.js': proof(), 'README.md': 'moved\n' });
  const base = commit(root, 'main moved', ['src/a.js', 'test/one.test.js', 'README.md']);
  expect(run(root, [base, head]), 1, row('test/one.test.js', 'pass', 'pass'), 'MISMATCH test/one.test.js');
});

test('no code passes; code without tests needs a reason, including on re-run', async (t) => {
  const { root, base } = setup(t, { 'src/a.js': 'export const value = 1;\n', 'test/one.test.js': bad(), 'docs/a.md': 'one\n' });
  git(root, ['checkout', '-q', '-b', 'docs']);
  write(root, { 'docs/a.md': 'two\n' });
  git(root, ['rm', '-q', '--', 'test/one.test.js']);
  const docsHead = commit(root, 'docs', ['docs/a.md']);
  expect(run(root, [base, docsHead]), 0);
  git(root, ['checkout', '-q', 'main']);
  git(root, ['checkout', '-q', '-b', 'dead']);
  git(root, ['rm', '-q', '--', 'src/a.js', 'test/one.test.js']);
  write(root, { 'docs/a.md': 'three\n' });
  const dead = commit(root, 'dead', ['docs/a.md']);
  expect(run(root, [base, dead]), 1);
  const body = (text) => event(root, text, base, dead);
  const valid = run(root, [], body('No-proof: native only'));
  expect(valid, 0);
  assert.ok(valid.out.includes('native only'));
  for (const text of ['  No-proof: indented', 'no-proof: lowercase', 'No-proof:']) {
    expect(run(root, [], body(text)), 1);
  }

  // The author corrected the description after the original event. A re-run must use the correction.
  const api = createServer((req, res) => {
    if (req.url !== '/repos/fixture/proof/pulls/7' || req.headers.authorization !== 'Bearer fixture') return res.writeHead(404).end();
    res.end(JSON.stringify({ body: 'No-proof: verified on the device' }));
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  t.after(() => api.close());
  const env = { ...process.env, ...body(''), PROOF_BODY_TOKEN: 'fixture', GITHUB_REPOSITORY: 'fixture/proof', GITHUB_API_URL: `http://127.0.0.1:${api.address().port}` };
  const { stdout } = await promisify(execFile)(process.execPath, [SCRIPT], { cwd: root, env, timeout: 10_000 });
  assert.match(stdout, /No-proof: verified on the device/);
});
