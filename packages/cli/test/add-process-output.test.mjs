import test from 'brittle'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const cliRoot = join(here, '..')
const entry = join(cliRoot, 'peartube.js')
const depsModule = join(here, 'fixtures', 'add-deps-fake.mjs')

function runEntry (args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: cliRoot,
      env: {
        PATH: process.env.PATH,
        PEARTUBE_ADD_DEPS_MODULE: depsModule,
        TMDB_API_KEY: 'super-secret-token',
        ...env
      }
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

test('the dedicated entry emits exactly one JSON value on stdout with diagnostics on stderr', async (t) => {
  const { code, stdout, stderr } = await runEntry([
    'add', 'https://youtube.com/watch?v=v1',
    '--type', 'movie', '--provider', 'tmdb', '--movie-id', '603', '--yes', '--json'
  ])
  t.is(code, 0)
  const trimmed = stdout.trim()
  const parsed = JSON.parse(trimmed)
  t.is(parsed.status, 'published')
  t.is(trimmed.split('\n').length, 1, 'stdout carries exactly one line')
  t.absent(stdout.includes('super-secret-token'), 'secret never reaches stdout')
  t.absent(stdout.includes('fetchUrl'), 'runtime fetchUrl never reaches stdout')
  t.absent(stdout.includes('[diag]'), 'diagnostics are not written to stdout')
  t.ok(stderr.includes('[diag]'), 'diagnostics are routed to stderr')
})

test('a target-authority duplicate exits successfully with stable identifiers in JSON', async (t) => {
  const { code, stdout } = await runEntry([
    'add', 'https://youtube.com/watch?v=v1',
    '--type', 'movie', '--provider', 'tmdb', '--movie-id', '603', '--yes', '--json'
  ], { PEARTUBE_FAKE_DUPLICATE: '1' })
  t.is(code, 0)
  const parsed = JSON.parse(stdout.trim())
  t.is(parsed.status, 'already-exists')
  t.is(parsed.channelKey, 'chan-1')
  t.is(parsed.videoId, 'existing-9')
})

test('secrets never appear in stdout or stderr across the run', async (t) => {
  const { stdout, stderr } = await runEntry([
    'add', 'https://youtube.com/watch?v=v1',
    '--type', 'movie', '--provider', 'tmdb', '--movie-id', '603', '--yes'
  ])
  t.absent(stdout.includes('super-secret-token'))
  t.absent(stderr.includes('super-secret-token'))
})
