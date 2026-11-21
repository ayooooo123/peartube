// End-to-end verification of the YouTube source on a real Bare relay (`bin/relay.js`) with a stub `ubit` (`UBIT_BIN`):
//   1. `POST /v1/search/sources` marks every row with its source and `lossy: true`, never invents peer fields for a
//      video, still answers when another source fails (one `errors` entry), and refuses an unknown source.
//   2. `stream: true` sends one `source` event per source, then `done`.
//   3. A save asks ubit for audio only (`-a`), lands in `<Artist> - <Album> (<Year>) [YouTube]/NN - Title.m4a` byte
//      for byte, and is announced as `yt:<hex>:s01eNN` (hex equal to the importer's `album:` hash, so the names agree
//      and the ids do not) with the artist from the pin, since an M4A carries no tags the importer reads.
//   4. A track YouTube will not send is reported on the job and does not lose the rest of the album; an album with
//      no track saved fails with YouTube's reason.
//   5. Deleting the album removes the saved files from disk, and a re-scan imports nothing.
//   6. Three empty answers in a row report the source as `degraded`; so does YouTube's bot check, which stops the
//      album at the first refusal (one request, not one per track) and clears on the next save that works.
// Writes `desktop/target/e2e/youtube-provider-result.json`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import createTestnet from 'hyperdht/testnet.js'
import { albumKey } from '../src/tags.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const freePort = () => new Promise(res => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)) }) })
const until = async (fn, ms = 30_000) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out')
    await new Promise(r => setTimeout(r, 150))
  }
}

// `ubit info --json ytsearch:<q>` and `ubit get <url> ... -o <dir>`; every call's argv is appended to `calls.log`.
function writeStubUbit (binDir) {
  const script = [
    '#!/usr/bin/env node',
    'const fs = require("node:fs"), path = require("node:path");',
    'const args = process.argv.slice(2);',
    `fs.appendFileSync(${JSON.stringify(join(binDir, 'calls.log'))}, JSON.stringify(args) + "\\n");`,
    'const say = o => process.stdout.write(JSON.stringify(o) + "\\n");',
    'if (args[0] === "info") {',
    '  const q = args[1].replace(/^ytsearch:/, "");',
    '  if (/nothing/.test(q)) { process.stderr.write("error: No YouTube results for \'" + q + "\'\\n"); process.exit(1) }',
    '  if (/explode/.test(q)) { process.stderr.write("error: HTTP 429 from youtube\\n"); process.exit(1) }',
    '  say({ entries: [',
    '    { id: "aaaaaaaaaa1", title: "Blue Train (Remastered)", url: "https://www.youtube.com/watch?v=aaaaaaaaaa1", duration: 643, thumbnail: "x", author: "" },',
    '    { id: "aaaaaaaaaa2", title: "Moment\'s Notice", url: "https://www.youtube.com/watch?v=aaaaaaaaaa2", duration: 550.4, author: "John Coltrane - Topic" },',
    '    { id: "aaaaaaaaaa2", title: "duplicate id", duration: 1 },',
    '    { id: "not a video id", title: "bad", duration: 1 }',
    '  ] });',
    '  process.exit(0)',
    '}',
    'const id = /v=([\\w-]{11})/.exec(args[1])[1];',
    'if (id === "gonegonegon") { say({ event: "error", error: "Video unavailable in your country" }); process.exit(1) }',
    'if (id === "botbotbotbo") { say({ event: "error", error: "YouTube: Sign in to confirm you’re not a bot" }); process.exit(1) }',
    'const out = args[args.indexOf("-o") + 1];',
    'const body = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypM4A "), Buffer.alloc(4000, id)]);',
    'const file = path.join(out, "Some Uploader Title [" + id + "].m4a");',
    'say({ event: "info", ext: "m4a", quality: "Audio 129k" });',
    'say({ event: "progress", downloaded: 2000, total: 4012 });',
    'fs.writeFileSync(file, body);',
    'say({ event: "done", path: file, size: body.length });'
  ].join('\n')
  const file = join(binDir, 'ubit')
  writeFileSync(file, script)
  chmodSync(file, 0o755)
  return file
}

test('YouTube source: unified search, audio-only save into a yt: album, partial failure, delete', { timeout: 180_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-youtube-'))
  const storage = join(dir, 'storage')
  const watchDir = join(dir, 'import')
  const binDir = join(dir, 'bin')
  for (const d of [storage, watchDir, binDir]) mkdirSync(d, { recursive: true })
  const ubit = writeStubUbit(binDir)
  const testnet = await createTestnet(3)
  const apiPort = await freePort()
  const logs = []
  const proc = spawn(join(root, 'node_modules/.bin/bare'), [join(root, 'bin/relay.js')], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: storage,
      UBIT_BIN: ubit,
      PEARTUBE_STORAGE: storage,
      PEARTUBE_WATCH_DIR: watchDir,
      PEARTUBE_API_PORT: String(apiPort),
      PEARTUBE_API_HOST: '127.0.0.1',
      PEARTUBE_BOOTSTRAP: testnet.bootstrap.map(b => `${b.host}:${b.port}`).join(','),
      PEARTUBE_SLSK_LISTEN_PORT: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  createInterface({ input: proc.stdout }).on('line', line => logs.push(line))
  createInterface({ input: proc.stderr }).on('line', line => logs.push(line))
  t.after(async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGTERM')
      await new Promise(r => { proc.once('exit', r); setTimeout(r, 3000) })
      if (proc.exitCode === null) proc.kill('SIGKILL')
    }
    await testnet.destroy()
    rmSync(dir, { recursive: true, force: true })
  })
  await until(() => {
    if (proc.exitCode !== null) throw new Error(`relay exited ${proc.exitCode}: ${logs.join('\n')}`)
    return logs.some(l => l.includes('relay ready'))
  }, 60_000)

  const base = `http://127.0.0.1:${apiPort}`
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
    return { status: res.status, data: await res.json() }
  }
  const plugin = async () => (await until(async () => (await call('GET', '/v1/plugins')).data.plugins.find(p => p.name === 'youtube')))
  assert.equal((await plugin()).status, 'ready')

  // 1. Unified search: YouTube answers, the unconfigured peer source is one error, rows are marked.
  const both = await call('POST', '/v1/search/sources', { query: 'blue train' })
  assert.equal(both.status, 200, JSON.stringify(both.data))
  assert.deepEqual(both.data.bySource, { soulseek: 0, youtube: 2 })
  assert.equal(both.data.errors.length, 1)
  assert.equal(both.data.errors[0].source, 'soulseek')
  assert.match(both.data.errors[0].message, /not configured/i)
  const [row, second] = both.data.results
  assert.deepEqual(row, {
    source: 'youtube',
    title: 'Blue Train (Remastered)',
    lossy: true,
    length: 643,
    size: null,
    bitrate: 128,
    sample_rate: null,
    bit_depth: null,
    videoId: 'aaaaaaaaaa1',
    url: 'https://www.youtube.com/watch?v=aaaaaaaaaa1',
    channel: null,
    thumbnail: 'https://i.ytimg.com/vi/aaaaaaaaaa1/mqdefault.jpg'
  })
  assert.equal(second.channel, 'John Coltrane - Topic')
  assert.equal(second.length, 550)
  for (const k of ['username', 'slots', 'queue', 'filename']) assert.equal(k in row, false, `a video has no ${k}`)
  assert.equal((await call('POST', '/v1/search/sources', { query: 'x', sources: ['napster'] })).status, 400)
  assert.equal((await call('POST', '/v1/search/sources', { query: '  ' })).status, 400)
  const failed = await call('POST', '/v1/search/sources', { query: 'explode now', sources: ['youtube'] })
  assert.equal(failed.status, 200)
  assert.match(failed.data.errors[0].message, /HTTP 429/)

  // 2. Streamed: one `source` event per source, then `done`.
  const sse = await fetch(base + '/v1/search/sources', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'blue train', stream: true }) })
  assert.match(sse.headers.get('content-type'), /text\/event-stream/)
  const events = (await sse.text()).trim().split('\n\n').map(f => ({ event: /^event: (\w+)/m.exec(f)[1], data: JSON.parse(/^data: (.*)$/m.exec(f)[1]) }))
  assert.deepEqual(events.map(e => e.event).sort(), ['done', 'source', 'source'])
  assert.equal(events[events.length - 1].event, 'done')
  assert.equal(events.find(e => e.data.source === 'youtube').data.results.length, 2)
  assert.ok(events.find(e => e.data.source === 'soulseek').data.error)

  // 3 + 4. Save an album of three videos; the middle one is refused by YouTube.
  assert.equal((await call('POST', '/v1/providers/youtube/mirror', { album: 'Blue Train', tracks: [{ videoId: 'aaaaaaaaaa1', title: 'x' }] })).status, 400)
  assert.equal((await call('POST', '/v1/providers/youtube/mirror', { artist: 'A', album: 'B', tracks: [{ videoId: '../../etc', title: 'x' }] })).status, 400)
  const started = await call('POST', '/v1/providers/youtube/mirror', {
    artist: 'John Coltrane',
    album: 'Blue Train',
    year: 1957,
    tracks: [
      { videoId: 'aaaaaaaaaa1', title: 'Blue Train' },
      { videoId: 'gonegonegon', title: 'Moment\'s Notice' },
      { videoId: 'aaaaaaaaaa2', title: 'Locomotion: take/2' }
    ]
  })
  assert.equal(started.status, 200, JSON.stringify(started.data))
  const hex = createHash('sha256').update(albumKey({ albumArtist: 'John Coltrane', album: 'Blue Train', year: '1957' })).digest('hex').slice(0, 20)
  assert.equal(started.data.job.id, `yt:${hex}`)
  assert.equal(started.data.job.plugin, 'youtube')
  assert.equal(started.data.job.total, null)
  const job = await until(async () => {
    const j = (await call('GET', '/v1/jobs')).data.jobs.find(x => x.jobId === started.data.job.jobId)
    if (j?.status === 'failed') throw new Error(j.error)
    return j?.status === 'done' && j
  })
  assert.equal(job.skipped.length, 1)
  assert.match(job.note, /1 of 3 tracks not saved: Moment's Notice \(Video unavailable in your country\)/)
  const folder = join(watchDir, 'John Coltrane - Blue Train (1957) [YouTube]')
  assert.deepEqual(readdirSync(folder).filter(n => !n.startsWith('.')).sort(), ['01 - Blue Train.m4a', '03 - Locomotion take 2.m4a'])
  assert.equal(readFileSync(join(folder, '01 - Blue Train.m4a')).subarray(8, 12).toString(), 'M4A ', 'the bytes ubit wrote, unchanged')
  const gets = readFileSync(join(binDir, 'calls.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(a => a[0] === 'get')
  assert.equal(gets.length, 3)
  for (const g of gets) assert.ok(g.includes('-a') && g.includes('--no-playlist'), 'audio only, one video')
  const entries = (await call('GET', '/v1/entries')).data.results
  assert.deepEqual(entries.map(e => e.id).sort(), [`yt:${hex}:s01e01`, `yt:${hex}:s01e03`])
  for (const e of entries) {
    assert.equal(e.title, 'John Coltrane · Blue Train')
    assert.equal(e.music.artist, 'John Coltrane')
  }
  assert.equal(entries.find(e => e.id.endsWith('e03')).music.title, 'Locomotion take 2')

  const none = await call('POST', '/v1/providers/youtube/mirror', { artist: 'John Coltrane', album: 'Gone', tracks: [{ videoId: 'gonegonegon', title: 'Lost' }], wait: true })
  assert.equal(none.status, 502)
  assert.match(none.data.error, /YouTube did not send “Lost”: Video unavailable in your country/)
  assert.equal(existsSync(join(watchDir, 'John Coltrane - Gone [YouTube]')), false, 'a failed save leaves no folder')

  // 5. Delete the album: files go, and the next scan imports nothing.
  const removed = await call('POST', '/v1/entries/remove', { keys: entries.map(e => e.key) })
  assert.equal(removed.status, 200, JSON.stringify(removed.data))
  assert.equal(removed.data.filesDeleted, 2)
  assert.equal(existsSync(folder), false, 'the emptied album folder is removed')
  assert.equal((await call('POST', '/v1/plugins/watch-dir/run', {})).data.ingested, 0)
  assert.equal((await call('GET', '/v1/entries')).data.results.length, 0)

  // 6. Three empty answers in a row: the extractor may be out of date.
  for (let i = 0; i < 3; i++) {
    const r = await call('POST', '/v1/providers/youtube/search', { query: 'nothing here' })
    assert.deepEqual(r.data.candidates, [])
  }
  const degraded = await plugin()
  assert.equal(degraded.status, 'degraded')
  assert.ok(degraded.message.split(' ').length <= 12, degraded.message)
  await call('POST', '/v1/providers/youtube/search', { query: 'blue train' })
  assert.equal((await plugin()).status, 'ready')

  const getsBefore = readFileSync(join(binDir, 'calls.log'), 'utf8').split('\n').filter(l => l.startsWith('["get"')).length
  const blocked = await call('POST', '/v1/providers/youtube/mirror', { artist: 'A', album: 'Blocked', tracks: [{ videoId: 'botbotbotbo', title: 'One' }, { videoId: 'botbotbotbo', title: 'Two' }, { videoId: 'aaaaaaaaaa1', title: 'Three' }], wait: true })
  assert.equal(blocked.status, 503)
  assert.match(blocked.data.error, /refusing downloads from this relay's network/)
  assert.equal(readFileSync(join(binDir, 'calls.log'), 'utf8').split('\n').filter(l => l.startsWith('["get"')).length, getsBefore + 1, 'the album stops at the first refusal')
  const blockedInfo = await plugin()
  assert.equal(blockedInfo.status, 'degraded')
  assert.equal(blockedInfo.canSave, false)
  assert.ok(blockedInfo.message.split(' ').length <= 12, blockedInfo.message)
  const again = await call('POST', '/v1/providers/youtube/mirror', { artist: 'A', album: 'Works', tracks: [{ videoId: 'aaaaaaaaaa1', title: 'One' }], wait: true })
  assert.equal(again.status, 200, JSON.stringify(again.data))
  assert.equal((await plugin()).canSave, true)

  const out = join(root, 'desktop/target/e2e')
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'youtube-provider-result.json'), JSON.stringify({
    at: new Date().toISOString(),
    search: both.data.bySource,
    streamEvents: events.map(e => e.event),
    job: { id: job.id, status: job.status, skipped: job.skipped, bytes: job.bytes },
    ids: entries.map(e => e.id),
    removed: removed.data.filesDeleted,
    degradedMessage: degraded.message
  }, null, 2) + '\n')
})
