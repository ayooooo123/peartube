// End-to-end check of the shipped browser engine (`web/assets/peartube_web.wasm`) on files whose
// timestamps are stored in decode order — the shape of Spider-Man: Far From Home's MP4 (no `ctts`).
//
// Each codec gets a normal twin (presentation times in the container) and a decode-order twin
// (`setts=pts=DTS`, every packet stamped with its decode time). Both go through the engine over its
// real C ABI in all three output modes, and the decode-order twin must come out identical to the
// normal one:
//   - software decode: the same 72 pictures at 24 fps, never stepping backward;
//   - MSE: the same init and media segment bytes, so the browser muxes display times;
//   - WebCodecs: the same packet timestamps, so the platform decoder shows them in order.
// Before the demux repair the software path lost 4 of 72 pictures and stepped backward 28 times,
// and the worker drew half of them as late.
//
// Needs ffmpeg. Writes `desktop/target/e2e/web-player-result.json`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const wasmPath = join(root, 'web/assets/peartube_web.wasm')
const outDir = join(root, 'desktop/target/e2e')
const FPS = 24000 / 1001
const FRAMES = 72
const ABI = await (async () => {
  const wasmBytes = readFileSync(wasmPath)
  const { instance } = await WebAssembly.instantiate(wasmBytes, { env: { host_stream_len: () => 0n, host_read_at: () => 0 } })
  instance.exports.pt_abi_json()
  const ptr = instance.exports.pt_json_ptr() >>> 0
  const len = instance.exports.pt_json_len() >>> 0
  return JSON.parse(new TextDecoder().decode(new Uint8Array(instance.exports.memory.buffer, ptr, len)))
})()
const MODE = ABI.mode

// The two bodies: a normal file and the same movie with every stamp pulled back to its decode time.
function twins (name, videoArgs) {
  const dir = mkdtempSync(join(tmpdir(), 'peartube-web-player-'))
  const normal = join(dir, `${name}.mp4`)
  const decodeOrder = join(dir, `${name}-decode-order.mp4`)
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24000/1001',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '3', '-map', '0:v', '-map', '1:a', ...videoArgs,
    '-c:a', 'aac', '-ac', '2', '-f', 'mp4', normal])
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', normal,
    '-map', '0', '-c', 'copy', '-bsf:v', 'setts=pts=DTS', '-f', 'mp4', decodeOrder])
  return { dir, normal: readFileSync(normal), decodeOrder: readFileSync(decodeOrder) }
}

// One file through the engine exactly as the Worker drives it: a host that answers Range reads and,
// for the software path, a clock that follows the pictures already shown.
async function run (bytes, mode) {
  const wasmBytes = readFileSync(wasmPath)
  let wasm = null
  const imports = {
    env: {
      host_stream_len: () => BigInt(bytes.length),
      host_read_at: (offsetBig, dst, len) => {
        const offset = Number(offsetBig)
        if (offset >= bytes.length) return 0
        const n = Math.min(len, bytes.length - offset)
        new Uint8Array(wasm.memory.buffer, dst, n).set(bytes.subarray(offset, offset + n))
        return n
      }
    }
  }
  const { instance } = await WebAssembly.instantiate(wasmBytes, imports)
  wasm = instance.exports
  const json = () => {
    const ptr = wasm.pt_json_ptr() >>> 0
    const len = wasm.pt_json_len() >>> 0
    return JSON.parse(new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, ptr, len)))
  }

  assert.equal(wasm.pt_open(0, 0), 0, 'the engine opens the file')
  const manifest = json()
  assert.equal(wasm.pt_configure(manifest.defaultVideo, manifest.defaultAudio, -1, mode), 0, 'the engine takes the streams')
  const out = { manifest, frames: [], audio: [], segments: [], packets: [], bytes: [] }
  let code
  let guard = 0
  while ((code = wasm.pt_step()) !== ABI.step.eof && guard++ < 100000) {
    assert.ok(code > 0, 'decode stops only at the end: ' + JSON.stringify(json()))
    if (code === ABI.step.videoRgba || code === ABI.step.videoYuv420) {
      out.frames.push(wasm.pt_out_pts())
      if (mode === MODE.software) wasm.pt_set_clock(out.frames.length / FPS)
    } else if (code === ABI.step.audioPlanarF32) {
      out.audio.push(wasm.pt_out_pts())
    } else if (code === ABI.step.mseInit || code === ABI.step.mseSegment) {
      const ptr = wasm.pt_out_ptr() >>> 0
      const len = wasm.pt_out_len() >>> 0
      const data = Buffer.from(new Uint8Array(wasm.memory.buffer, ptr, len))
      const digest = createHash('sha256').update(data).digest('hex')
      out.segments.push({ code, start: wasm.pt_out_pts(), end: wasm.pt_out_dur(), digest })
      out.bytes.push(data)
    } else if (code === ABI.step.videoPacket) {
      out.packets.push(wasm.pt_out_pts())
    }
  }
  return out
}

function cadence (frames) {
  const steps = frames.slice(1).map((pts, i) => pts - frames[i])
  return {
    count: frames.length,
    backwards: steps.filter(step => step <= 0).length,
    min: Math.min(...steps),
    max: Math.max(...steps)
  }
}

function same (a, b, what) {
  assert.equal(a.length, b.length, `${what} count: ${a.length} vs ${b.length}`)
  for (let i = 0; i < a.length; i++) {
    if (typeof a[i] === 'number') assert.ok(Math.abs(a[i] - b[i]) < 1e-6, `${what}[${i}]: ${a[i]} vs ${b[i]}`)
    else assert.deepEqual(a[i], b[i], `${what}[${i}]`)
  }
}

test('the browser engine plays H.264 and HEVC stamped in decode order at presentation times', async () => {
  const cases = [
    { name: 'hevc', args: ['-pix_fmt', 'yuv420p10le', '-c:v', 'libx265', '-x265-params', 'keyint=24:min-keyint=24:log-level=error'] },
    { name: 'h264', args: ['-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-g', '24'] }
  ]
  const result = { cases: {}, at: new Date().toISOString() }
  for (const { name, args } of cases) {
    const twin = twins(name, args)
    try {
      const normal = {}
      const decodedOrder = {}
      for (const [kind, mode] of Object.entries(MODE)) {
        normal[kind] = await run(twin.normal, mode)
        decodedOrder[kind] = await run(twin.decodeOrder, mode)
        const expected = 'video/mp4; codecs="' + (name === 'hevc' ? 'hvc1.' : 'avc1.')
        assert.ok(String(normal[kind].manifest.mseType).startsWith(expected), `${name} muxes as ${expected}: ${normal[kind].manifest.mseType}`)
      }

      // Software decode: every picture, in order, at 24 fps, and audio that follows the same clock.
      for (const played of [normal.software, decodedOrder.software]) {
        const shape = cadence(played.frames)
        assert.equal(shape.count, FRAMES, `${name} software shows all ${FRAMES} pictures: ${shape.count}`)
        assert.equal(shape.backwards, 0, `${name} software never steps backward: ${shape.backwards}`)
        assert.ok(shape.min >= 0.03 && shape.max <= 0.06, `${name} software holds 24 fps: ${shape.min.toFixed(4)}..${shape.max.toFixed(4)}`)
        assert.ok(played.audio.length > 0, `${name} software decodes audio`)
      }
      same(normal.software.frames, decodedOrder.software.frames, `${name} software picture times`)
      assert.equal(normal.software.audio.length, decodedOrder.software.audio.length, `${name} software audio chunks`)

      // MSE: the browser must receive byte-identical segments, so the muxed composition times are
      // the same presentation times a normal file carries.
      same(normal.mse.segments, decodedOrder.mse.segments, `${name} MSE segments`)
      assert.ok(normal.mse.segments.length > 1, `${name} MSE emits media segments`)

      // WebCodecs: the platform decoder must be handed the same display timestamps.
      same(normal.webcodecs.packets, decodedOrder.webcodecs.packets, `${name} WebCodecs packet times`)
      assert.ok(normal.webcodecs.packets.length === FRAMES, `${name} WebCodecs packets: ${normal.webcodecs.packets.length}`)

      result.cases[`${name}-software`] = cadence(decodedOrder.software.frames)
      result.cases[`${name}-mse`] = { segments: decodedOrder.mse.segments.length, first: decodedOrder.mse.segments.slice(0, 3) }
      result.cases[`${name}-webcodecs`] = { packets: decodedOrder.webcodecs.packets.length, first: decodedOrder.webcodecs.packets.slice(0, 4) }
    } finally {
      rmSync(twin.dir, { recursive: true, force: true })
    }
  }
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'web-player-result.json'), JSON.stringify(result, null, 2))
})

// Browsers take VP8 through MSE only as WebM, and a LAN relay page over plain HTTP has no
// WebCodecs. The engine's WebM init + clusters must be a stream a decoder reads back whole:
// every picture at its source time, keyframes marked, and no declared duration that disagrees
// with the next picture's time. The clip is variable-rate (10 fps, then 30 fps) and its own
// container declares 30 fps throughout, so a frame rate guessed from metadata is wrong for half.
test('the browser engine remuxes variable-rate VP8 to WebM for MSE', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'peartube-web-player-vp8-'))
  const packets = file => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,width,height:packet=pts_time,duration_time,flags', '-of', 'json', file]).toString())
  try {
    const source = join(dir, 'vp8.webm')
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '4', '-map', '0:v', '-map', '1:a', '-vf', "select='gte(t,2)+not(mod(n,3))'", '-fps_mode', 'vfr',
      '-c:v', 'libvpx', '-g', '24', '-auto-alt-ref', '0', '-b:v', '500k', '-c:a', 'libopus', source])
    const played = await run(readFileSync(source), MODE.mse)
    assert.equal(played.manifest.mseType, 'video/webm; codecs="vp8"')
    assert.ok(played.segments.length > 2, `VP8 MSE emits an init and media segments: ${played.segments.length}`)
    assert.equal(played.segments[0].code, ABI.step.mseInit, 'the init segment comes first')

    const remuxed = join(dir, 'remuxed.webm')
    writeFileSync(remuxed, Buffer.concat(played.bytes))
    const want = packets(source)
    const got = packets(remuxed)
    assert.deepEqual(got.streams[0], { codec_name: 'vp8', width: 320, height: 240 })
    const times = probe => probe.packets.map(p => Number(p.pts_time))
    same(times(got).map(t => Math.round(t * 1000)), times(want).map(t => Math.round(t * 1000)), 'VP8 picture times (ms)')
    const keys = probe => probe.packets.flatMap((p, i) => p.flags.startsWith('K') ? [i] : [])
    assert.deepEqual(keys(got), keys(want), 'keyframes stay marked')
    got.packets.slice(0, -1).forEach((p, i) => {
      if (p.duration_time === undefined) return
      const gap = Number(got.packets[i + 1].pts_time) - Number(p.pts_time)
      assert.ok(Math.abs(Number(p.duration_time) - gap) < 0.002, `picture ${i} lasts ${p.duration_time} s but the next starts ${gap.toFixed(3)} s later`)
    })
    const decoded = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-i', remuxed, '-f', 'framemd5', '-']).toString()
    assert.equal(decoded.split('\n').filter(l => l && !l.startsWith('#')).length, want.packets.length, 'every picture decodes')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('AVI catches up to the audio clock without relabeling later pictures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'peartube-avi-sync-'))
  try {
    const file = join(dir, 'episode.avi')
    const reference = join(dir, 'reference.yuv')
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=25',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
      '-t', '10', '-map', '0:v', '-map', '1:a', '-c:v', 'mpeg4', '-g', '50', '-bf', '2', '-q:v', '3',
      '-c:a', 'libmp3lame', '-q:a', '4', file])
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', file, '-an', '-pix_fmt', 'yuv420p', '-f', 'rawvideo', reference])
    const bytes = readFileSync(file)
    let wasm
    const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), { env: {
      host_stream_len: () => BigInt(bytes.length),
      host_read_at: (pos, dst, len) => {
        const offset = Number(pos)
        if (offset >= bytes.length) return 0
        const n = Math.min(len, bytes.length - offset)
        new Uint8Array(wasm.memory.buffer, dst, n).set(bytes.subarray(offset, offset + n))
        return n
      }
    } })
    wasm = instance.exports
    const json = () => JSON.parse(new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, wasm.pt_json_ptr(), wasm.pt_json_len())))
    assert.equal(wasm.pt_open(0, 0), 0)
    const manifest = json()
    assert.equal(wasm.pt_configure(manifest.defaultVideo, manifest.defaultAudio, -1, MODE.software), 0)
    assert.equal(wasm.pt_seek(5.3), 0)
    wasm.pt_set_clock(5.8)
    const expected = readFileSync(reference)
    let frame = null
    let sound = null
    for (let n = 0; n < 100000 && frame === null; n++) {
      const step = wasm.pt_step()
      if (step === ABI.step.audioPlanarF32 && sound === null) sound = wasm.pt_out_pts()
      if (step === ABI.step.videoYuv420) {
        const pts = wasm.pt_out_pts()
        const w = wasm.pt_out_w(), h = wasm.pt_out_h()
        const size = w * h
        const index = Math.round(pts * 25)
        const actual = Buffer.from(new Uint8Array(wasm.memory.buffer, wasm.pt_out_ptr(), size))
        const wanted = expected.subarray(index * size * 3 / 2, index * size * 3 / 2 + size)
        assert.ok(actual.equals(wanted), `AVI picture labelled ${pts.toFixed(2)} must show that frame, not the next keyframe`)
        frame = { pts, index, digest: createHash('sha256').update(actual).digest('hex') }
      } else if (step === ABI.step.eof || step < 0) break
    }
    assert.ok(frame, 'AVI seek emits a picture')
    assert.ok(sound !== null && Math.abs(sound - 5.3) < 0.1, `MP3 stays at the sought time: ${sound}`)
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'avi-audio-sync-result.json'), JSON.stringify({ frame, sound }, null, 2))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
