import { execFileSync, spawnSync } from 'node:child_process'
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The CLI loads this reporter in Node's test runner, outside the test file's process.
// Only a structured assertion can prove a regression. Stderr only helps name a load error.
export default async function * reporter (source) {
  const failures = new Set()
  let stderr = '', passed = false, finished
  for await (const { type, data } of source) {
    if (type === 'test:stderr' && stderr.length < 16384) stderr += data.message.slice(0, 16384 - stderr.length)
    if (type === 'test:summary') {
      if (data.file) passed ||= data.counts.passed > 0
      else finished = data
    }
    if (type !== 'test:fail' || data.skip || data.todo) continue
    const { failureType, cause } = data.details.error
    if (failureType === 'subtestsFailed') continue // Child failures have their own events.
    if (failureType === 'testTimeoutFailure' || cause?.code === 'ETIMEDOUT') failures.add('timeout')
    else if (failureType === 'testCodeFailure' && cause?.code === 'ERR_ASSERTION') failures.add('assertion failure')
    else if (cause?.name === 'SyntaxError') failures.add('syntax error')
    else if (['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'].includes(cause?.code)) failures.add('missing module')
    else if (data.name === process.argv.at(-1)) failures.add('file error')
    else failures.add('other failure')
  }
  if (failures.delete('file error')) {
    if (/\bSyntaxError:/.test(stderr)) failures.add('syntax error')
    else if (/\b(?:ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND)\b/.test(stderr)) failures.add('missing module')
    else failures.add('other failure')
  }
  if (!finished) yield 'incomplete run'
  else if (failures.size) yield [...failures].sort().join(' + ')
  else if (!finished.success) yield 'other failure'
  else yield passed ? 'pass' : 'no genuine pass'
}

function runFile (cwd, file) {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT // A proof invoked by a test must start a fresh test runner.
  const run = spawnSync(process.execPath, ['--test', '--test-force-exit', `--test-reporter=${import.meta.url}`, '--', file],
    { cwd, env, encoding: 'utf8', timeout: 600_000 })
  if (run.error?.code === 'ETIMEDOUT') return 'timeout'
  const verdict = run.stdout?.trim()
  if (!verdict || run.error || run.signal || (verdict === 'pass' && run.status !== 0) ||
      (verdict === 'assertion failure' && run.status !== 1)) return 'incomplete run'
  return verdict
}

function git (cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function resultsAt (root, tree, revision, files, overlay) {
  git(root, 'worktree', 'add', '--quiet', '--detach', tree, revision)
  try {
    if (overlay) git(tree, '--literal-pathspecs', 'restore', '--source', overlay, '--worktree', '--', ...files)
    execFileSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: tree, stdio: ['ignore', 'ignore', 'inherit'] })
    return files.map(file => lstatSync(join(tree, file)).isFile() ? runFile(tree, file) : 'not a regular test file')
  } catch (error) {
    console.error(`Cannot prepare tests at ${revision}: ${error.message}`)
    return files.map(() => 'setup failed')
  } finally {
    git(root, 'worktree', 'remove', '--force', tree)
  }
}

// Passes-on-main: test/a.test.js, test/b.test.js -- Both guard existing behaviour.
function passesOnMain (lines, files) {
  const named = new Set()
  const paths = [...files].sort((a, b) => b.length - a.length)
  for (const line of lines) {
    if (!line.startsWith('Passes-on-main:')) continue
    let rest = line.slice('Passes-on-main:'.length).trim()
    const group = []
    for (;;) {
      const file = paths.find(p => rest.startsWith(p) && (!rest[p.length] || /[\s,:]/.test(rest[p.length])))
      if (!file) break
      group.push(file)
      rest = rest.slice(file.length).replace(/^[\s,:]+/, '')
    }
    if (!group.length || rest.startsWith('test/') || !/[\p{L}\p{N}]/u.test(rest)) {
      console.error(`Ignoring invalid exception: ${line}`)
      continue
    }
    for (const file of group) named.add(file)
  }
  return named
}

async function description (pr) {
  const token = process.env.PROOF_BODY_TOKEN
  delete process.env.PROOF_BODY_TOKEN // npm and the tests do not need the API credential.
  if (!pr || !token) return pr?.body ?? ''
  const url = `${process.env.GITHUB_API_URL}/repos/${process.env.GITHUB_REPOSITORY}/pulls/${pr.number}`
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!response.ok) throw new Error(`Cannot read the current PR description: HTTP ${response.status}`)
  return (await response.json()).body ?? ''
}

async function proof (base, head, pr) {
  const root = git(process.cwd(), 'rev-parse', '--show-toplevel').trim()
  const commit = ref => git(root, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).trim()
  base = commit(base)
  head = commit(head)
  // Three dots select only the PR's changes. The base run still uses the exact base SHA.
  // Disabling rename detection keeps both the old (deleted) path and the new (added) path.
  const changes = git(root, 'diff', '--no-renames', '--name-status', '-z', `${base}...${head}`, '--').split('\0')
  const files = []
  let codeChanged = false
  for (let i = 0; i + 1 < changes.length; i += 2) {
    const file = changes[i + 1]
    codeChanged ||= /^(src|bin|android|ios|desktop)\//.test(file)
    if (changes[i] !== 'D' && file.startsWith('test/') && file.endsWith('.test.js')) files.push(file)
  }
  if (!codeChanged) {
    console.log('No changes under src/, bin/, android/, ios/ or desktop/. Skipping proof.')
    return 0
  }
  const lines = (await description(pr)).split(/\r?\n/)
  if (!files.length) {
    const reason = lines.find(line => line.startsWith('No-proof:') && /[\p{L}\p{N}]/u.test(line.slice('No-proof:'.length)))
    console.log(reason || 'Code changed without a new or modified test. Add a test or a No-proof: reason.')
    return reason ? 0 : 1
  }

  const exceptions = passesOnMain(lines, files)
  const temp = mkdtempSync(join(tmpdir(), 'ci-proof-'))
  try {
    const before = resultsAt(root, join(temp, 'base'), base, files, head)
    const after = resultsAt(root, join(temp, 'head'), head, files)
    let ok = true
    console.log('file | expected on base | result on base | result on head')
    for (const [i, file] of files.entries()) {
      const exempt = exceptions.has(file)
      const mismatch = before[i] !== (exempt ? 'pass' : 'assertion failure') || after[i] !== 'pass'
      const name = JSON.stringify(file).slice(1, -1).replaceAll('|', '\\|')
      console.log(`${mismatch ? 'MISMATCH ' : ''}${name} | ${exempt ? 'passes (Passes-on-main)' : 'fails by assertion'} | ${before[i]} | ${after[i]}`)
      if (mismatch) ok = false
    }
    return ok ? 0 : 1
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename) {
  try {
    if (process.argv.length === 4) process.exitCode = await proof(process.argv[2], process.argv[3])
    else if (process.argv.length === 2 && process.env.GITHUB_EVENT_PATH) {
      const { pull_request: pr } = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
      process.exitCode = await proof(pr.base.sha, pr.head.sha, pr)
    } else throw new Error('Use node scripts/ci-proof.mjs BASE HEAD or supply a pull_request event in GITHUB_EVENT_PATH.')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
