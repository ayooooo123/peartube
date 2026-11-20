// A folder of music files becomes one identified album: each track announced under the release's id with its disc
// and track in the suffix, its own name carried in `music`, and all of them grouped as one tile by the web UI.
//
// The fixtures are built here rather than committed: a FLAC with Vorbis comments and a MusicBrainz release id, an
// MP3 with ID3v2.4 frames and no release id, and a folder of untagged files whose names say nothing. What each one
// must produce is the point of the test — the id a track lands on decides whether two relays agree about an album,
// and only an id that survives a rename and a different rip is worth writing into an append-only channel.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTags, albumKey } from '../src/tags.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// A FLAC whose only metadata block is a Vorbis comment: `fLaC`, one block header with the last-block flag, then
// little-endian vendor and tag lengths. No audio frames are needed to read tags, but they are cheap, so a little
// follows to keep the file a plausible size.
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
  return Buffer.concat([enc('fLaC'), header, comment, Buffer.alloc(4096, 0x11)])
}

// An ID3v2.4 tag whose frames are the text frames a tagger writes, plus a `TXXX` frame for the MusicBrainz id the
// way ffmpeg spells it and the way Picard spells it (both must match, since a mirror sees both).
function mp3 ({ frames = {}, txxx = {}, version = 4 }) {
  const textFrame = (id, value) => {
    const body = Buffer.concat([Buffer.from([3]), Buffer.from(value, 'utf8')])
    const h = Buffer.alloc(10)
    h.write(id, 0, 'latin1')
    if (version === 4) {
      const n = body.length
      h[4] = (n >> 21) & 0x7f; h[5] = (n >> 14) & 0x7f; h[6] = (n >> 7) & 0x7f; h[7] = n & 0x7f
    } else {
      h.writeUInt32BE(body.length, 4)
    }
    return Buffer.concat([h, body])
  }
  const parts = []
  for (const [id, value] of Object.entries(frames)) parts.push(textFrame(id, value))
  for (const [desc, value] of Object.entries(txxx)) {
    const body = Buffer.concat([Buffer.from([3]), Buffer.from(desc, 'utf8'), Buffer.from([0]), Buffer.from(value, 'utf8')])
    const h = Buffer.alloc(10)
    h.write('TXXX', 0, 'latin1')
    if (version === 4) {
      const n = body.length
      h[4] = (n >> 21) & 0x7f; h[5] = (n >> 14) & 0x7f; h[6] = (n >> 7) & 0x7f; h[7] = n & 0x7f
    } else {
      h.writeUInt32BE(body.length, 4)
    }
    parts.push(Buffer.concat([h, body]))
  }
  const framesBuf = Buffer.concat(parts)
  const header = Buffer.alloc(10)
  header.write('ID3', 0, 'latin1')
  header[3] = version; header[4] = 0; header[5] = 0
  const n = framesBuf.length
  header[6] = (n >> 21) & 0x7f; header[7] = (n >> 14) & 0x7f; header[8] = (n >> 7) & 0x7f; header[9] = n & 0x7f
  return Buffer.concat([header, framesBuf, Buffer.alloc(1024, 0x22), Buffer.from([0xff, 0xfb, 0x90, 0x00])])
}

// An Opus file's first two Ogg pages: the `OpusHead` packet, then `OpusTags` with the same comment structure FLAC uses.
// A long comment makes the tags packet span several 255-byte lacing segments. The CRC is left zero: tag reading does
// not check it.
function opus (tags) {
  const page = (seq, packet) => {
    const lacing = []
    for (let left = packet.length; ; left -= 255) { lacing.push(Math.min(left, 255)); if (left < 255) break }
    const h = Buffer.alloc(27)
    h.write('OggS', 0, 'latin1'); h[5] = seq === 0 ? 2 : 0; h.writeUInt32LE(1, 14); h.writeUInt32LE(seq, 18); h[26] = lacing.length
    return Buffer.concat([h, Buffer.from(lacing), packet])
  }
  const head = Buffer.concat([Buffer.from('OpusHead', 'latin1'), Buffer.from([1, 2, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0])])
  const comment = flac({ ...tags, COMMENT: 'x'.repeat(700) }).subarray(8, -4096)
  return Buffer.concat([page(0, head), page(1, Buffer.concat([Buffer.from('OpusTags', 'latin1'), comment])), Buffer.alloc(2048, 0x33)])
}

// One MPEG audio frame header, then (Layer III) the side information an encoder leaves empty in its first frame and a
// Xing header with a frame count. The side information is 32 bytes for MPEG-1 stereo and 9 for MPEG-2 mono.
function mpegFrame (header, sideInfo, frames) {
  const xing = frames ? Buffer.concat([Buffer.from('Xing', 'latin1'), Buffer.from([0, 0, 0, 1]), Buffer.alloc(4)]) : Buffer.alloc(0)
  if (frames) xing.writeUInt32BE(frames, 8)
  return Buffer.concat([Buffer.from(header), Buffer.alloc(sideInfo), xing, Buffer.alloc(2048)])
}

test('a FLAC with Vorbis comments names its release, disc and track', () => {
  const tags = parseTags(flac({
    ALBUM: 'Blue Train',
    ALBUMARTIST: 'John Coltrane',
    TITLE: 'Moment\'s Notice',
    DATE: '1958',
    DISCNUMBER: '1',
    TRACKNUMBER: '3',
    MUSICBRAINZ_ALBUMID: '0123456789abcdef0123456789abcdef'
  }))
  assert.equal(tags.container, 'flac')
  assert.equal(tags.album, 'Blue Train')
  assert.equal(tags.albumArtist, 'John Coltrane')
  assert.equal(tags.title, 'Moment\'s Notice')
  assert.equal(tags.year, 1958)
  assert.equal(tags.disc, 1)
  assert.equal(tags.track, 3)
  assert.equal(tags.mbid, '0123456789abcdef0123456789abcdef')
})

test('ID3v2.4 reads synchsafe size, and both taggers spellings of the release id', () => {
  const ffmpeg = parseTags(mp3({
    frames: { TALB: 'Kid A', TPE2: 'Radiohead', TIT2: 'Everything In Its Right Place', TDRC: '2000', TRCK: '1/10', TPOS: '1/1' },
    txxx: { MUSICBRAINZ_ALBUMID: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
  }))
  assert.equal(ffmpeg.album, 'Kid A')
  assert.equal(ffmpeg.track, 1)
  assert.equal(ffmpeg.disc, 1)
  assert.equal(ffmpeg.mbid, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')

  // Picard writes the description with spaces, and the id with hyphens.
  const picard = parseTags(mp3({
    frames: { TALB: 'Kid A' },
    txxx: { 'MusicBrainz Album Id': 'b0b1c2d3-1111-2222-3333-444455556666' }
  }))
  assert.equal(picard.mbid, 'b0b1c2d3111122223333444455556666')
})

test('ID3v2.3 reads a plain frame size, not a synchsafe one', () => {
  const tags = parseTags(mp3({ version: 3, frames: { TALB: 'OK Computer', TPE1: 'Radiohead', TYER: '1997', TRCK: '3' } }))
  assert.equal(tags.album, 'OK Computer')
  assert.equal(tags.artist, 'Radiohead')
  assert.equal(tags.year, 1997)
  assert.equal(tags.track, 3)
})

test('a truncated tag never throws and never loops', () => {
  const full = flac({ ALBUM: 'Half', TRACKNUMBER: '1' })
  for (let cut = 0; cut < full.length; cut += 7) {
    assert.doesNotThrow(() => parseTags(full.subarray(0, cut)), `cut ${cut}`)
  }
  const id3 = mp3({ frames: { TALB: 'Half' } })
  for (let cut = 0; cut < id3.length; cut += 11) {
    assert.doesNotThrow(() => parseTags(id3.subarray(0, cut)), `cut ${cut}`)
  }
})

test('the same album folds to one key however it is typed', () => {
  assert.equal(
    albumKey({ albumArtist: 'Sigur Rós', album: 'Ágætis byrjun', year: 1999 }),
    albumKey({ albumArtist: 'sigur ros', album: 'Agætis Byrjun!', year: 1999 })
  )
  assert.notEqual(
    albumKey({ albumArtist: 'A', album: 'Same Name', year: 1999 }),
    albumKey({ albumArtist: 'A', album: 'Same Name', year: 2009 })
  )
})

// The whole path, through a real relay: a folder is scanned, each track announced, and the catalog hands back one
// album whose tracks say which one they are.
test('a folder becomes one album through a relay', { timeout: 240_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'peartube-album-'))
  const storage = join(dir, 'storage')
  const watch = join(dir, 'staging')
  const albumDir = join(watch, 'John Coltrane - Blue Train (1958)')
  mkdirSync(albumDir, { recursive: true })
  mkdirSync(storage, { recursive: true })

  writeFileSync(join(albumDir, '01 - Blue Train.flac'), flac({
    ALBUM: 'Blue Train', ALBUMARTIST: 'John Coltrane', TITLE: 'Blue Train', DATE: '1958',
    DISCNUMBER: '1', TRACKNUMBER: '1', MUSICBRAINZ_ALBUMID: '0123456789abcdef0123456789abcdef'
  }))
  writeFileSync(join(albumDir, '02 - Moment\'s Notice.flac'), flac({
    ALBUM: 'Blue Train', ALBUMARTIST: 'John Coltrane', TITLE: 'Moment\'s Notice', DATE: '1958',
    DISCNUMBER: '1', TRACKNUMBER: '2', MUSICBRAINZ_ALBUMID: '0123456789abcdef0123456789abcdef'
  }))
  // Untagged, named so nothing about it says Blue Train: it must still join the album the others named.
  // Untagged: a bare FLAC header with an empty comment block, so only its place in the folder names it.
  writeFileSync(join(albumDir, '03.flac'), flac({}))
  // Tagged with an album but no track numbers (ffmpeg rips commonly are): one album, numbered by folder position.
  const noNumDir = join(watch, 'NoNum')
  mkdirSync(noNumDir)
  for (const name of ['Intro', 'Outro']) writeFileSync(join(noNumDir, `${name}.flac`), flac({ ALBUM: 'No Numbers', ARTIST: 'B', TITLE: name }))
  // A Discogs release that gains a track after its first import must keep its release id.
  const discogsDir = join(watch, 'Discogs')
  mkdirSync(discogsDir)
  const discogsTrack = n => flac({ ALBUM: 'D', ALBUMARTIST: 'A', TITLE: `T${n}`, TRACKNUMBER: String(n), DISCOGS_RELEASE_ID: '12345' })
  for (const n of [1, 2]) writeFileSync(join(discogsDir, `0${n} - T${n}.flac`), discogsTrack(n))
  // Ogg Opus tags name their album too.
  const opusDir = join(watch, 'Opus')
  mkdirSync(opusDir)
  for (const n of [1, 2]) writeFileSync(join(opusDir, `track${n}.opus`), opus({ ALBUM: 'Opus Album', ARTIST: 'C', TITLE: `O${n}`, TRACKNUMBER: String(n) }))
  // MPEG audio: MPEG-1 Layer III 128 kbps 44.1 kHz stereo, MPEG-2 Layer III 64 kbps 22.05 kHz mono, and MPEG-1 Layer II.
  const mpegDir = join(watch, 'Mpeg')
  mkdirSync(mpegDir)
  const tagged = n => mp3({ frames: { TALB: 'Mpeg Album', TPE1: 'E', TIT2: `M${n}`, TRCK: String(n) } }).subarray(0, -4)
  writeFileSync(join(mpegDir, '1.mp3'), Buffer.concat([tagged(1), mpegFrame([0xff, 0xfb, 0x90, 0x00], 32, 1000)]))
  writeFileSync(join(mpegDir, '2.mp3'), Buffer.concat([tagged(2), mpegFrame([0xff, 0xf3, 0x80, 0xc0], 9, 500)]))
  writeFileSync(join(mpegDir, '3.mp3'), Buffer.concat([tagged(3), mpegFrame([0xff, 0xfd, 0x90, 0x00], 0, 0)]))

  const port = 8300 + Math.floor(Math.random() * 400)
  const proc = spawn(join(root, 'node_modules/.bin/bare'), [join(root, 'bin/relay.js')], {
    cwd: root,
    env: { ...process.env, PEARTUBE_STORAGE: storage, PEARTUBE_WATCH_DIR: watch, PEARTUBE_API_PORT: String(port), PEARTUBE_LAN_HOST: '127.0.0.1', PEARTUBE_API_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const errors = []
  createInterface({ input: proc.stderr }).on('line', line => errors.push(line))
  try {
    await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('relay did not start: ' + errors.join('\n'))), 90_000)
      createInterface({ input: proc.stdout }).on('line', line => {
        if (line.includes('relay ready')) { clearTimeout(timer); resolveReady() }
      })
      proc.once('exit', code => reject(new Error(`relay exited ${code}: ${errors.join('\n')}`)))
    })

    // The import runs at startup and on a poll; wait for the catalog to hold the album rather than for a fixed time.
    let rows = []
    for (let i = 0; i < 120; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/v1/entries`).catch(() => null)
      if (res?.ok) {
        rows = (await res.json()).results || []
        if (rows.length >= 12) break
      }
      await sleep(1000)
    }
    assert.equal(rows.length, 12, `expected every folder's tracks, got ${rows.length}: ${errors.slice(-3).join(' ')}`)
    const opusRows = rows.filter(r => r.title === 'C · Opus Album')
    assert.deepEqual(opusRows.map(r => r.music?.title).sort(), ['O1', 'O2'], 'Opus tags are read')
    assert.equal(new Set(opusRows.map(r => r.seriesKey)).size, 1, 'one Opus album')

    // What the relay says each MPEG file holds, read from the header it stored.
    const audioOf = async r => {
      for (let i = 0; i < 10; i++) {
        const info = await (await fetch(`http://127.0.0.1:${port}/v1/entries/info?key=${encodeURIComponent(r.key)}`)).json()
        if (info.media) return { codec: info.media.audio[0]?.codec, rate: info.media.audio[0]?.rate, channels: info.media.audio[0]?.channels, duration: info.media.duration && Math.round(info.media.duration * 1000) / 1000 }
        await sleep(500)
      }
      return null
    }
    const mpeg = Object.fromEntries(await Promise.all(rows.filter(r => r.title === 'E · Mpeg Album').map(async r => [r.music?.title, await audioOf(r)])))
    assert.deepEqual(mpeg, {
      M1: { codec: 'MP3', rate: 44100, channels: 2, duration: Math.round(1000 * 1152 / 44100 * 1000) / 1000 },
      M2: { codec: 'MP3', rate: 22050, channels: 1, duration: Math.round(500 * 576 / 22050 * 1000) / 1000 },
      M3: { codec: 'MP2', rate: 44100, channels: 2, duration: null }
    })
    assert.ok(rows.every(r => !r.id.startsWith('undefined')), 'no track lands on an "undefined" release')

    const noNum = rows.filter(r => r.title === 'B · No Numbers')
    assert.deepEqual(noNum.map(r => r.id.replace(/^album:[0-9a-f]{20}:/, '')).sort(), ['s01e01', 's01e02'], 'numbered by folder position')
    assert.equal(new Set(noNum.map(r => r.seriesKey)).size, 1, 'one album')

    const discogs = rows.filter(r => r.id.startsWith('discogs:'))
    assert.deepEqual(discogs.map(r => r.id).sort(), ['discogs:r12345:s01e01', 'discogs:r12345:s01e02'])
    writeFileSync(join(discogsDir, '03 - T3.flac'), discogsTrack(3))
    const rescan = await (await fetch(`http://127.0.0.1:${port}/v1/plugins/watch-dir/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()
    assert.deepEqual(rescan.items.map(i => i.id), ['discogs:r12345:s01e03'], 'an added track keeps its release id')

    const blue = rows.filter(r => r.id.startsWith('mb:'))
    for (const r of blue) assert.match(r.id, /^mb:0123456789abcdef0123456789abcdef:s01e\d{2}$/, r.id)
    assert.equal(blue[0].title, 'John Coltrane · Blue Train', 'every track carries the album as its title')
    assert.equal(new Set(blue.map(r => r.seriesKey)).size, 1, 'one album')
    assert.equal(new Set(blue.map(r => r.season)).size, 1, 'one disc')
    // Two tagged tracks and one untagged file (the untagged one is named "03", so it is track 3): an untagged file
    // in an album folder is a track of that album, not a clip of its own.
    assert.deepEqual([...new Set(blue.map(r => r.episode))].sort((a, b) => a - b), [1, 2, 3])

    const first = blue.find(r => r.episode === 1)
    assert.equal(first.music?.title, 'Blue Train', 'the track says its own name')
    assert.equal(first.music?.artist, 'John Coltrane')

    // The M3U lists every track, the one added by the rescan included.
    const m3u = await (await fetch(`http://127.0.0.1:${port}/v1/playlist.m3u`)).text()
    const lines = m3u.split('\n').filter(l => l.startsWith('#EXTINF'))
    assert.equal(lines.length, rows.length + 1)
    assert.ok(lines.some(l => /Blue Train/.test(l)))

    // Nothing internal leaked: the staging folder and the socket address stay out of the channel.
    const json = JSON.stringify(rows)
    assert.ok(!json.includes(dir), 'no staging path in the catalog')
    assert.ok(!json.includes(albumDir), 'no album folder in the catalog')
  } finally {
    proc.kill('SIGTERM')
    await sleep(1500)
    proc.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
})
