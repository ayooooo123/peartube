// Deleting an album from a relay whose mirrors land in its import folder (PEARTUBE_WATCH_DIR): a folder a mirror
// pinned (`.peartube-album.json`, with or without the newer `.peartube-mirrored.json` list) is this relay's, so its
// files go with their mirror-watch.json rows and no later scan brings them back. A folder the owner dropped in is
// theirs: the announces go, the files stay, and a scan does not import them again until a file changes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function flac (tags) {
  const enc = s => Buffer.from(s, 'utf8')
  const vendor = enc('peartube-test')
  const entries = Object.entries(tags).map(([k, v]) => enc(`${k}=${v}`))
  const body = []
  const vh = Buffer.alloc(4); vh.writeUInt32LE(vendor.length, 0)
  body.push(vh, vendor)
  const ch = Buffer.alloc(4); ch.writeUInt32LE(entries.length, 0)
  body.push(ch)
  for (const e of entries) { const h = Buffer.alloc(4); h.writeUInt32LE(e.length, 0); body.push(h, e) }
  const comment = Buffer.concat(body)
  const header = Buffer.from([0x84, (comment.length >> 16) & 0xff, (comment.length >> 8) & 0xff, comment.length & 0xff])
  return Buffer.concat([enc('fLaC'), header, comment, Buffer.alloc(4096, tags.TITLE ? tags.TITLE.length : 0x11)])
}

function album (watch, folder, { artist, album, year, mbid }, titles, extra = {}) {
  const dir = join(watch, folder)
  mkdirSync(dir, { recursive: true })
  for (const [name, body] of Object.entries(extra)) writeFileSync(join(dir, name), body)
  titles.forEach((title, i) => {
    writeFileSync(join(dir, `${String(i + 1).padStart(2, '0')} - ${title}.flac`), flac({
      ALBUM: album, ALBUMARTIST: artist, TITLE: title, DATE: year, TRACKNUMBER: String(i + 1), MUSICBRAINZ_ALBUMID: mbid
    }))
  })
  return dir
}

test('album delete in the import folder: mirrored folders go for good, owner folders stay on disk', { timeout: 240_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'peartube-remove-'))
  const storage = join(dir, 'storage')
  const watch = join(dir, 'import')
  mkdirSync(storage, { recursive: true })
  const MB = { legacy: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', listed: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', owner: 'cccccccccccccccccccccccccccccccc', other: 'dddddddddddddddddddddddddddddddd' }
  // A mirror made before `.peartube-mirrored.json` existed: a pin and no list.
  const legacy = album(watch, 'Legacy Artist - Pinned (2001)', { artist: 'Legacy Artist', album: 'Pinned', year: '2001', mbid: MB.legacy }, ['One', 'Two', 'Three'],
    { '.peartube-album.json': JSON.stringify({ release: `mb:${MB.legacy}` }) + '\n' })
  // A mirror made now: the list names its files, and no pin.
  const listed = album(watch, 'Listed Artist - Listed (2003)', { artist: 'Listed Artist', album: 'Listed', year: '2003', mbid: MB.listed }, ['Alpha', 'Beta'],
    { '.peartube-mirrored.json': JSON.stringify(['01 - Alpha.flac', '02 - Beta.flac']) + '\n' })
  // The owner's own rip, dropped into the import folder.
  const owner = album(watch, 'Owner Artist - Own Rip (2002)', { artist: 'Owner Artist', album: 'Own Rip', year: '2002', mbid: MB.owner }, ['Mine', 'Yours'])
  const other = album(watch, 'Other Artist - Untouched (1999)', { artist: 'Other Artist', album: 'Untouched', year: '1999', mbid: MB.other }, ['Stay'])

  const port = 8300 + Math.floor(Math.random() * 400)
  const proc = spawn(join(root, 'node_modules/.bin/bare'), [join(root, 'bin/relay.js')], {
    cwd: root,
    env: { ...process.env, PEARTUBE_STORAGE: storage, PEARTUBE_WATCH_DIR: watch, PEARTUBE_API_PORT: String(port), PEARTUBE_LAN_HOST: '127.0.0.1', PEARTUBE_API_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const errors = []
  createInterface({ input: proc.stderr }).on('line', line => errors.push(line))
  const call = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, data: await res.json() }
  }
  const rows = async () => (await call('GET', '/v1/entries')).data.results
  const count = async mbid => (await rows()).filter(r => r.seriesKey === `mb:${mbid}`).length
  const ledger = () => Object.keys(JSON.parse(readFileSync(join(storage, 'mirror-watch.json'), 'utf8')))
  try {
    await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('relay did not start: ' + errors.join('\n'))), 90_000)
      createInterface({ input: proc.stdout }).on('line', line => {
        if (line.includes('relay ready')) { clearTimeout(timer); resolveReady() }
      })
      proc.once('exit', code => reject(new Error(`relay exited ${code}: ${errors.join('\n')}`)))
    })
    let all = []
    for (let i = 0; i < 120 && all.length < 8; i++) {
      all = await rows().catch(() => [])
      if (all.length < 8) await sleep(1000)
    }
    assert.equal(all.length, 8, `every track imported: ${all.map(r => r.id)}`)

    // A pinned folder with no list is a mirror: every file goes, with its ledger rows and the folder.
    const a = await call('POST', '/v1/entries/remove', { seriesKey: `mb:${MB.legacy}` })
    assert.equal(a.status, 200, JSON.stringify(a.data))
    assert.equal(a.data.removed.length, 3)
    assert.equal(a.data.filesDeleted, 3, JSON.stringify(a.data))
    assert.equal(existsSync(legacy), false, 'the emptied album folder and its pin are gone')
    assert.equal(ledger().some(k => k.startsWith('Legacy Artist')), false)

    // A listed folder is a mirror too.
    const b = await call('POST', '/v1/entries/remove', { ids: [`mb:${MB.listed}:s01e01`, `mb:${MB.listed}:s01e02`] })
    assert.equal(b.data.filesDeleted, 2, JSON.stringify(b.data))
    assert.equal(existsSync(listed), false)

    // The owner's folder: announces go, files and ledger rows stay.
    const c = await call('POST', '/v1/entries/remove', { seriesKey: `mb:${MB.owner}` })
    assert.deepEqual(c.data.removed.map(r => r.file), ['kept', 'kept'], JSON.stringify(c.data))
    assert.equal(c.data.filesDeleted, 0)
    assert.deepEqual(readdirSync(owner).sort(), ['01 - Mine.flac', '02 - Yours.flac'])
    assert.equal(ledger().filter(k => k.startsWith('Owner Artist')).length, 2)

    // A sweep afterwards brings none of them back, and leaves the other album alone.
    const sweep = await call('POST', '/v1/plugins/watch-dir/run', {})
    assert.equal(sweep.data.ingested, 0, JSON.stringify(sweep.data))
    assert.deepEqual([await count(MB.legacy), await count(MB.listed), await count(MB.owner), await count(MB.other)], [0, 0, 0, 1])

    // A vinyl-style file with album tags and no track number joins an album already announced: it takes the album's
    // name, not "Untitled album", and the place it sorts at in the folder.
    writeFileSync(join(other, 'B1 Side Two.flac'), flac({ ALBUM: 'Untouched', ALBUMARTIST: 'Other Artist', TITLE: 'Side Two', DATE: '1999' }))
    const joined = await call('POST', '/v1/plugins/watch-dir/run', {})
    assert.equal(joined.data.ingested, 1, JSON.stringify(joined.data))
    const added = (await rows()).find(r => r.music?.title === 'Side Two')
    assert.deepEqual([added?.seriesKey, added?.episode, added?.title], [`mb:${MB.other}`, 2, 'Other Artist · Untouched'])

    // The owner's file comes back when it changes (touched, re-tagged, replaced): that is the way to restore it.
    const later = new Date(Date.now() + 5000)
    utimesSync(join(owner, '01 - Mine.flac'), later, later)
    const restore = await call('POST', '/v1/plugins/watch-dir/run', {})
    assert.equal(restore.data.ingested, 1, JSON.stringify(restore.data))
    assert.equal(await count(MB.owner), 1)
  } finally {
    proc.kill('SIGTERM')
    await sleep(1500)
    proc.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
})
