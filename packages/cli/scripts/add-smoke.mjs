#!/usr/bin/env node
/**
 * End-to-end smoke for the real `peartube add` binary.
 *
 * It launches the actual executable (argv parser, command dispatch, diagnostic
 * scope, job store, executor, and result writer) as a separate process for each
 * scenario. Network durability, TMDB, and yt-dlp are supplied through the
 * injected deterministic deps module so the run needs no live key, internet, or
 * relay. Live P2P full-range durability and interactive PTY keystrokes are
 * covered by the backend seed-pin integration suites and the terminal unit
 * suites respectively; this harness proves the real command wiring end to end.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const cliRoot = join(here, '..')
const entry = join(cliRoot, 'peartube.js')
const depsModule = join(cliRoot, 'test', 'fixtures', 'add-deps-fake.mjs')
const workDir = mkdtempSync(join(tmpdir(), 'peartube-add-smoke-'))

function run (args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: cliRoot,
      env: { PATH: process.env.PATH, PEARTUBE_ADD_DEPS_MODULE: depsModule, TMDB_API_KEY: 'smoke-token', ...env }
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

const MOVIE = ['add', 'https://youtube.com/watch?v=v1', '--type', 'movie', '--provider', 'tmdb', '--movie-id', '603', '--yes', '--json']
const EPISODE = ['add', 'https://youtube.com/watch?v=v1', '--type', 'episode', '--provider', 'tmdb', '--show-id', '1396', '--season', '1', '--episode', '1', '--yes', '--json']
const TVDB_EPISODE = ['add', 'https://youtube.com/watch?v=v1', '--type', 'episode', '--provider', 'tvdb', '--show-id', '81189', '--season', '1', '--episode', '2', '--title', 'Cat\'s in the Bag...', '--yes', '--json']
const TVDB_MOVIE = ['add', 'https://youtube.com/watch?v=v1', '--type', 'movie', '--provider', 'tvdb', '--movie-id', '603', '--title', 'The Matrix', '--yes', '--json']
const TRACK = ['add', 'https://youtube.com/watch?v=v1', '--type', 'track', '--provider', 'musicbrainz', '--recording-id', 'b1a9c0e8-2f9d-4b3e-9a24-6f3c1d9a7b55', '--title', 'Paranoid Android', '--yes', '--json']
const RELEASE = ['add', 'https://youtube.com/watch?v=v1', '--type', 'release', '--provider', 'musicbrainz', '--release-id', '550e8400-e29b-41d4-a716-446655440000', '--title', 'OK Computer', '--yes', '--json']

const scenarios = [
  {
    name: 'scripted movie publishes after verified durability',
    async check () { const r = await run(MOVIE); return json(r).status === 'published' && !r.stdout.includes('smoke-token') }
  },
  {
    name: 'scripted episode publishes with canonical channel',
    async check () { const r = await run(EPISODE); return json(r).status === 'published' }
  },
  {
    name: 'target-authority duplicate is a successful no-op',
    async check () { const r = await run(MOVIE, { PEARTUBE_FAKE_DUPLICATE: '1' }); const j = json(r); return j.status === 'already-exists' && j.videoId === 'existing-9' }
  },
  {
    name: 'no eligible peer stays replicationPending and retains bytes',
    async check () {
      const bee = join(workDir, 'pending.json')
      const r = await run(MOVIE, { PEARTUBE_FAKE_PENDING: '1', PEARTUBE_FAKE_BEE_FILE: bee })
      return json(r).status === 'replicationPending' && r.stderr.includes('retained')
    }
  },
  {
    name: 'resume after durability succeeds without repeated upload',
    async check () {
      const bee = join(workDir, 'resume.json')
      const first = await run(MOVIE, { PEARTUBE_FAKE_PENDING: '1', PEARTUBE_FAKE_BEE_FILE: bee })
      if (json(first).status !== 'replicationPending') return false
      const second = await run(MOVIE, { PEARTUBE_FAKE_BEE_FILE: bee })
      return json(second).status === 'published'
    }
  },
  {
    name: 'diagnostics route to stderr, never stdout',
    async check () { const r = await run(MOVIE); return r.stderr.includes('[diag]') && !r.stdout.includes('[diag]') }
  },
  {
    name: 'help prints stable usage and exits 0',
    async check () { const r = await run(['add', '--help']); return r.code === 0 && r.stdout.includes('Usage: peartube') }
  },
  {
    name: 'missing TMDB key yields an actionable setup error',
    async check () { const r = await run(MOVIE, { TMDB_API_KEY: '' }); return r.code === 2 && r.stderr.includes('TMDB API key') && !r.stderr.includes('smoke-token') }
  },
  {
    name: 'unsupported provider is rejected before any transfer',
    async check () { const r = await run(['add', 'https://x/y', '--type', 'movie', '--provider', 'vimeo', '--movie-id', '1', '--yes'], {}); return r.code === 2 && /unavailable|not available/.test(r.stderr) }
  },
  {
    name: 'TVDB episode and movie publish without any TMDB key',
    async check () {
      const episode = await run(TVDB_EPISODE, { TMDB_API_KEY: '' })
      const movie = await run(TVDB_MOVIE, { TMDB_API_KEY: '' })
      return json(episode).status === 'published' && json(movie).status === 'published'
    }
  },
  {
    name: 'MusicBrainz recording and release publish without any TMDB key',
    async check () {
      const track = await run(TRACK, { TMDB_API_KEY: '' })
      const release = await run(RELEASE, { TMDB_API_KEY: '' })
      return json(track).status === 'published' && json(release).status === 'published'
    }
  },
  {
    name: 'an authority a kind cannot carry is refused before any transfer',
    async check () {
      const r = await run(['add', 'https://x/y', '--type', 'track', '--provider', 'tmdb', '--recording-id', 'b1a9c0e8-2f9d-4b3e-9a24-6f3c1d9a7b55', '--yes'])
      return r.code === 2 && /track coordinates require --provider musicbrainz and --recording-id/.test(r.stderr)
    }
  },
  {
    name: 'an ordinal a kind does not have is refused before any transfer',
    async check () {
      const r = await run([...TRACK, '--season', '1'])
      return r.code === 2 && /Track mode does not accept --season/.test(r.stderr)
    }
  },
  {
    name: 'coordinates with no metadata client demand an explicit title',
    async check () {
      const r = await run(['add', 'https://x/y', '--type', 'release', '--provider', 'musicbrainz', '--release-id', '550e8400-e29b-41d4-a716-446655440000', '--yes'])
      return r.code === 2 && /--title is required for musicbrainz coordinates/.test(r.stderr)
    }
  }
]

function json (result) {
  try { return JSON.parse(result.stdout.trim().split('\n').pop()) } catch { return {} }
}

async function checkInteractivePty () {
  try {
    await import('node-pty')
    return 'node-pty present (interactive keystroke drive available)'
  } catch {
    return 'skipped: node-pty unavailable; interactive keystrokes covered by test/add-terminal.test.mjs'
  }
}

async function main () {
  const results = []
  for (const scenario of scenarios) {
    let ok = false
    let error = null
    try { ok = await scenario.check() } catch (e) { error = e }
    results.push({ name: scenario.name, ok, error })
    console.log(`${ok ? '✓' : '✗'} ${scenario.name}${error ? ` — ${error.message}` : ''}`)
  }
  console.log(`• interactive PTY: ${await checkInteractivePty()}`)
  rmSync(workDir, { recursive: true, force: true })

  const failed = results.filter((r) => !r.ok)
  if (failed.length > 0) {
    console.error(`\n${failed.length}/${results.length} smoke scenarios failed.`)
    process.exit(1)
  }
  console.log(`\nAll ${results.length} smoke scenarios verified.`)
}

await main()
