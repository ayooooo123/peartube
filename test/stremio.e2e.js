// The Stremio add-on names each stream's resolution, read from the file's own header through the relay's blob
// server: Matroska (a letterboxed 1920x800 picture is 1080p), MP4 with its moov after a multi-megabyte mdat and with
// it first (faststart), and AVI. Clients such as MediaStorm rank an unnamed resolution below every 480p source.
// A file that is not video keeps a plain name. Every stream plays from the add-on's own origin (`/v1/blob`), the one
// address a client such as MediaStorm admits for a private-network add-on.
//
// Needs ffmpeg. Run with `node --test --test-force-exit` (node teardown leaves a promise pending).
// Writes `desktop/target/e2e/stremio-result.json`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import createTestnet from 'hyperdht/testnet.js'
import { createNode } from '../src/index.js'
import { createApi } from '../src/http.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tmp = () => mkdtempSync(join(tmpdir(), 'peartube-stremio-'))

function encode (dir, name, size, seconds, args) {
  const file = join(dir, name)
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=24`,
    '-t', String(seconds), ...args, file])
  return readFileSync(file)
}

test('Stremio streams name the resolution read from each file', { timeout: 240000 }, async t => {
  const dir = tmp()
  const x264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']
  const fixtures = [
    { id: 'imdb:tt0000001', file: 'letterboxed.mkv', want: '1080p', bytes: encode(dir, 'letterboxed.mkv', '1920x800', 1, x264) },
    // Lossless keeps mdat well past the first read, so moov is reached by walking the boxes.
    { id: 'imdb:tt0000002', file: 'moov-last.mp4', want: '720p', bytes: encode(dir, 'moov-last.mp4', '1280x720', 3, [...x264, '-qp', '0']) },
    { id: 'imdb:tt0000003', file: 'faststart.mp4', want: '2160p', bytes: encode(dir, 'faststart.mp4', '3840x1600', 0.25, [...x264, '-movflags', '+faststart']) },
    { id: 'imdb:tt0000004', file: 'xvid.avi', want: '480p', bytes: encode(dir, 'xvid.avi', '720x304', 1, ['-c:v', 'mpeg4']) },
    { id: 'imdb:tt0000005', file: 'noise.bin', want: null, bytes: randomBytes(300 * 1024) }
  ]
  assert.ok(fixtures[1].bytes.length > 2 * 1024 * 1024, 'the moov-last MP4 is large enough to need more than one read')

  const testnet = await createTestnet(3)
  const node = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap })
  const api = createApi({ node, acquirer: null })
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve))
  t.after(async () => { api.close(); await node.close(); await testnet.destroy() })
  const base = `http://127.0.0.1:${api.address().port}`

  const result = { fixtures: [] }
  for (const f of fixtures) {
    await node.publish({ id: f.id, title: f.file }, Readable.from([f.bytes]))
    const { streams } = await (await fetch(`${base}/stream/movie/${f.id.slice(5)}.json`)).json()
    assert.equal(streams.length, 1, `${f.file} is listed`)
    const label = streams[0].name.split('\n')[1] || null
    result.fixtures.push({ file: f.file, bytes: f.bytes.length, name: streams[0].name, label })
    assert.equal(label, f.want, `${f.file} is named ${f.want}`)
    // Clients that trust only the add-on's own address (MediaStorm) must be able to play the stream.
    assert.ok(streams[0].url.startsWith(`${base}/v1/blob?`), `${f.file} streams from the add-on's origin`)
    const range = await fetch(streams[0].url, { headers: { range: 'bytes=100-4195' } })
    assert.equal(range.status, 206)
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), f.bytes.subarray(100, 4196), `${f.file} range bytes match`)
  }

  mkdirSync(join(root, 'desktop/target/e2e'), { recursive: true })
  writeFileSync(join(root, 'desktop/target/e2e/stremio-result.json'), JSON.stringify(result, null, 2))
})
