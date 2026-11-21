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
import { createNode } from '../src/index.js'
import { createMirrorHost } from '../src/mirror.js'

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
    '  if (/slow/.test(q)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);',
    '  if (/explode/.test(q)) { process.stderr.write("error: HTTP 429 from youtube\\n"); process.exit(1) }',
    '  say({ entries: [',
    '    { id: "aaaaaaaaaa1", title: "Blue Train (Remastered)", url: "https://www.youtube.com/watch?v=aaaaaaaaaa1", duration: 643, thumbnail: "x", author: "" },',
    '    { id: "aaaaaaaaaa2", title: "Moment\'s Notice", url: "https://www.youtube.com/watch?v=aaaaaaaaaa2", duration: 550.4 },',
    '    { id: "aaaaaaaaaa2", title: "duplicate id", duration: 1 },',
    '    { id: "not a video id", title: "bad", duration: 1 }',
    '  ] });',
    '  process.exit(0)',
    '}',
    'const id = /v=([\\w-]{11})/.exec(args[1])[1];',
    'if (id === "gonegonegon") { say({ event: "error", error: "Video unavailable in your country" }); process.exit(1) }',
    'if (id === "botbotbotbo") { say({ event: "error", error: "YouTube: Sign in to confirm you’re not a bot" }); process.exit(1) }',
    'if (id === "ageageageag") { say({ event: "error", error: "YouTube: Sign in to confirm your age. This video may be inappropriate for some users." }); process.exit(1) }',
    'if (id === "slowslowslo") { say({ event: "progress", downloaded: 10, total: 4012 }); setTimeout(() => {}, 30000); return }',
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
    thumbnail: '/v1/providers/youtube/thumb/aaaaaaaaaa1'
  })
  assert.equal(second.channel, null, 'ubit names no uploader for search results')
  assert.equal(second.length, 550)
  for (const k of ['username', 'slots', 'queue', 'filename']) assert.equal(k in row, false, `a video has no ${k}`)
  assert.equal((await call('POST', '/v1/search/sources', { query: 'x', sources: ['napster'] })).status, 400)
  for (const sources of ['youtube', [], [7], {}]) {
    const bad = await call('POST', '/v1/search/sources', { query: 'x', sources })
    assert.equal(bad.status, 400, `sources ${JSON.stringify(sources)} is refused, not read as every source`)
  }
  assert.equal((await call('POST', '/v1/search/sources', { query: '  ' })).status, 400)
  const failed = await call('POST', '/v1/search/sources', { query: 'explode now', sources: ['youtube'] })
  assert.equal(failed.status, 200)
  assert.match(failed.data.errors[0].message, /HTTP 429/)

  // 2. Streamed: each source's part is sent when that source finishes, not when the last one does. Here the peer
  // source fails at once (not set up) and YouTube takes 1.5 s, so the first event must arrive about 1.5 s before
  // the second; a reply held back until the end has them together.
  const sse = await fetch(base + '/v1/search/sources', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'slow blue train', stream: true }) })
  assert.match(sse.headers.get('content-type'), /text\/event-stream/)
  const events = []
  const reader = sse.body.getReader()
  const decoder = new TextDecoder()
  for (let buf = ''; ;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    for (let i; (i = buf.indexOf('\n\n')) >= 0; buf = buf.slice(i + 2)) {
      const f = buf.slice(0, i)
      events.push({ at: Date.now(), event: /^event: (\w+)/m.exec(f)[1], data: JSON.parse(/^data: (.*)$/m.exec(f)[1]) })
    }
  }
  assert.deepEqual(events.map(e => e.event), ['source', 'source', 'done'])
  assert.deepEqual(events.map(e => e.data.source), ['soulseek', 'youtube', undefined], 'the source that finished first is sent first')
  assert.ok(events[1].at - events[0].at >= 1000, `the first source arrived ${events[1].at - events[0].at} ms before the second`)
  assert.equal(events[1].data.results.length, 2)
  assert.ok(events[0].data.error)
  assert.deepEqual(events[2].data.bySource, { soulseek: 0, youtube: 2 })

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

  // An age-gated video is one video's refusal, not the network's: the rest is saved and saving stays open.
  const aged = await call('POST', '/v1/providers/youtube/mirror', { artist: 'John Coltrane', album: 'Aged', tracks: [{ videoId: 'ageageageag', title: 'Gated' }, { videoId: 'aaaaaaaaaa1', title: 'Open' }], wait: true })
  assert.equal(aged.status, 200, JSON.stringify(aged.data))
  assert.equal(aged.data.files, 1)
  assert.match(aged.data.skipped[0].error, /confirm your age/)
  assert.equal((await plugin()).canSave, true)
  await call('POST', '/v1/entries/remove', { keys: (await call('GET', '/v1/entries')).data.results.filter(e => e.title.endsWith('Aged')).map(e => e.key) })

  // Names in other scripts are their own albums, not all one (folding to a-z left nothing to tell them apart), and
  // a long title in a script of three bytes a character still fits a file name.
  const zh1 = await call('POST', '/v1/providers/youtube/mirror', { artist: '周杰倫', album: '七里香', tracks: [{ videoId: 'aaaaaaaaaa1', title: '界'.repeat(84) }], wait: true })
  const zh2 = await call('POST', '/v1/providers/youtube/mirror', { artist: '周杰倫', album: '葉惠美', tracks: [{ videoId: 'aaaaaaaaaa2', title: '晴天' }], wait: true })
  assert.equal(zh1.status, 200, JSON.stringify(zh1.data))
  assert.equal(zh2.status, 200, JSON.stringify(zh2.data))
  assert.notEqual(zh1.data.id, zh2.data.id, 'two albums named in Chinese are two albums')
  assert.equal(zh1.data.files, 1)
  const zhFile = readdirSync(join(watchDir, zh1.data.folder)).find(n => n.endsWith('.m4a'))
  assert.ok(Buffer.byteLength(zhFile) <= 255, `${Buffer.byteLength(zhFile)} bytes`)
  await call('POST', '/v1/entries/remove', { keys: (await call('GET', '/v1/entries')).data.results.filter(e => e.title.startsWith('周杰倫')).map(e => e.key) })

  // Cancel between tracks: the track already downloaded is not left for the next scan to import.
  const slow = await call('POST', '/v1/providers/youtube/mirror', { artist: 'John Coltrane', album: 'Cancelled', tracks: [{ videoId: 'aaaaaaaaaa1', title: 'Done' }, { videoId: 'slowslowslo', title: 'Never' }] })
  const jobOf = async id => (await call('GET', '/v1/jobs')).data.jobs.find(x => x.jobId === id)
  await until(async () => (await jobOf(slow.data.job.jobId)).fileIndex === 2)
  await call('DELETE', `/v1/jobs/${slow.data.job.jobId}`)
  await until(async () => (await jobOf(slow.data.job.jobId))?.status === 'cancelled')
  await until(() => !existsSync(join(storage, 'youtube-work')) || readdirSync(join(storage, 'youtube-work')).length === 0)
  assert.equal(existsSync(join(watchDir, 'John Coltrane - Cancelled [YouTube]')), false, 'a cancelled save leaves no folder')
  assert.equal((await call('POST', '/v1/plugins/watch-dir/run', {})).data.ingested, 0, 'and nothing to import')

  // A folder of the owner's own files that happens to carry the save's name is not taken over: no pin is written
  // into it and nothing lands beside its files.
  const mine = join(watchDir, 'John Coltrane - Mine [YouTube]')
  mkdirSync(mine)
  writeFileSync(join(mine, '01 - Own.flac'), 'own bytes')
  const taken = await call('POST', '/v1/providers/youtube/mirror', { artist: 'John Coltrane', album: 'Mine', tracks: [{ videoId: 'aaaaaaaaaa1', title: 'Theirs' }], wait: true })
  assert.equal(taken.status, 409, JSON.stringify(taken.data))
  assert.deepEqual(readdirSync(mine), ['01 - Own.flac'])
  rmSync(mine, { recursive: true })

  // The picture route is the owner's: another site's page is refused; an id with no picture is 204, not an error.
  const evil = await fetch(base + '/v1/providers/youtube/thumb/aaaaaaaaaa1', { headers: { origin: 'http://evil.example' } })
  assert.equal(evil.status, 403)
  assert.equal(evil.headers.get('access-control-allow-origin'), null)
  assert.equal((await fetch(base + '/v1/providers/youtube/thumb/x')).status, 204)

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

// A finished save must not touch the import folder while another import holds it, because that wait can be long (a
// first import of a large folder) and has to stay cancellable. Ways this can go wrong, each checked below: the files
// are placed before the wait, so a cancelled or abandoned save is imported anyway; Cancel is ignored while waiting;
// the wait never ends; a save that waited and then went ahead does not import.
test('YouTube save: waits for a running import with nothing placed, can be cancelled, and gives up after a limit', { timeout: 180_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-youtube-wait-'))
  const storage = join(dir, 'storage')
  const watchDir = join(dir, 'import')
  for (const d of [storage, watchDir]) mkdirSync(d, { recursive: true })
  const testnet = await createTestnet(3)
  const node = await createNode({ storage, bootstrap: testnet.bootstrap })
  const host = importWaitMs => createMirrorHost({
    node,
    storage,
    acquirer: null,
    watchDir,
    pollIntervalMs: 0,
    importWaitMs,
    youtube: {
      info: async () => ({ entries: [] }),
      download: async (url, outDir) => {
        const path = join(outDir, 'audio.m4a')
        writeFileSync(path, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypM4A '), Buffer.from(url)]))
        return { path, size: null }
      }
    }
  })
  let mirror = await host(60_000)
  t.after(async () => {
    await mirror.close()
    await node.close()
    await testnet.destroy()
    rmSync(dir, { recursive: true, force: true })
  })
  // An import to wait behind: 300 files, each its own bytes.
  let batch = 0
  const longImport = () => {
    batch++
    for (let i = 0; i < 300; i++) writeFileSync(join(watchDir, `clip-${batch}-${String(i).padStart(3, '0')}.mp4`), createHash('sha256').update(`${batch}:${i}`).digest().subarray(0, 24).toString('hex').repeat(600))
    let done = false
    const run = mirror.run('watch-dir').then(r => { done = true; return r })
    return { run, done: () => done }
  }
  const ytFolders = () => readdirSync(watchDir).filter(n => n.endsWith('[YouTube]'))
  const save = (album, wait) => mirror.mirrorProvider('youtube', { artist: 'Waits', album, tracks: [{ videoId: 'aaaaaaaaaa1', title: 'One' }], wait })

  // Cancel while waiting: nothing was placed, so nothing is imported later.
  const first = longImport()
  const started = await save('Cancelled')
  const waiting = await until(() => { const j = mirror.getProviderJob(started.job.jobId); return j.status === 'announcing' && j.phase === 'waiting' && j }, 10_000).catch(() => null)
  assert.ok(waiting, 'the save waits behind the running import')
  assert.equal(first.done(), false, 'and that import is still running')
  assert.deepEqual(ytFolders(), [], 'nothing is placed while another import runs')
  assert.equal(mirror.cancelProviderJob(started.job.jobId).status, 'cancelled')
  await until(() => !existsSync(join(storage, 'youtube-work')) || readdirSync(join(storage, 'youtube-work')).length === 0)
  assert.equal((await first.run).ingested, 300)
  assert.deepEqual(ytFolders(), [])
  assert.equal(mirror.getProviderJob(started.job.jobId).status, 'cancelled')
  assert.equal((await mirror.run('watch-dir')).ingested, 0, 'the cancelled save left nothing to import')

  // With the folder free, the same save goes straight through and is imported.
  const ok = await save('Goes through', true)
  assert.equal(ok.files, 1)
  assert.equal(ok.ingested, 1)
  assert.deepEqual(ytFolders(), ['Waits - Goes through [YouTube]'])
  assert.deepEqual((await node.search()).map(e => e.id).filter(id => id.startsWith('yt:')), [`${ok.id}:s01e01`])

  // Closing the relay while a save waits ends it as a cancel, in the tick close() is called, and close() does not
  // wait out the save's limit (60 s on this host): the save's own stop only waits for it to unwind.
  const third = longImport()
  const parked = await save('Closed')
  await until(() => { const j = mirror.getProviderJob(parked.job.jobId); return j.status === 'announcing' && j.phase === 'waiting' }, 10_000)
  const closeAt = Date.now()
  const closingHost = mirror.close()
  assert.equal(mirror.getProviderJob(parked.job.jobId).status, 'cancelled', 'flagged in the tick close() was called')
  await closingHost
  assert.ok(Date.now() - closeAt < 5000, `close took ${Date.now() - closeAt} ms`)
  await third.run.catch(() => {})
  const closedJob = mirror.getProviderJob(parked.job.jobId)
  assert.equal(closedJob.status, 'cancelled', closedJob.error || '')
  assert.equal(closedJob.error, null)
  assert.deepEqual(ytFolders(), ['Waits - Goes through [YouTube]'], 'the closed save placed nothing')

  // The wait has a limit (100 ms on this second host): after it the save fails in plain words, again with nothing
  // placed, while the other import is still running.
  mirror = await host(100)
  const second = longImport()
  await assert.rejects(save('Gave up', true), err => /Another import has held the folder for 1 s\. Nothing was saved/.test(err.message) && err.status === 503)
  assert.equal(second.done(), false, 'it gave up while the other import was still running')
  assert.deepEqual(ytFolders(), ['Waits - Goes through [YouTube]'])
  assert.ok((await second.run).ingested >= 300, 'the import it gave up behind ran to its end')
  assert.equal((await mirror.run('watch-dir')).ingested, 0, 'the abandoned save left nothing to import')
})
