// Real-browser stress & regression check for the PearTube web player (`src/http.js`, `src/ui.js`,
// `web/assets/player-worker.js`, `web/assets/peartube_web.wasm`) in headless Chromium/Brave over CDP:
//   1. Cross-origin isolation (`COOP: same-origin` + `COEP: credentialless` + `CORP: cross-origin`):
//      `crossOriginIsolated` and `SharedArrayBuffer` on while cross-origin 302 poster redirects still load.
//   2. Long-GOP (8 s, 6 B-frames) multi-block H.264 + 5.1 AC-3 and 10-bit HEVC + TrueHD + E-AC-3 streams:
//      mid-GOP seeks land synced on both A/V and video-only streams instead of snapping to the prior keyframe;
//      window focus during an unprimed seek never aborts/restarts it; rapid 8-seek scrub storms under P2P
//      Range latency coalesce cleanly and keep block read-ahead alive; audio track switches update the badge.
//   3. High-packet-rate TrueHD (1,200 access units/s) mid-GOP software seeks yield across 4,096-packet slices
//      instead of terminating playback with a false EOF.
//   4. WebCodecs (`VideoDecoder`) hardware fallback transfers GPU `VideoFrame`s to page WebGL when MSE yields.
//   5. Background tab playback while another tab burns CPU: MSE evicts old SourceBuffer ranges across >20 s
//      hidden stretches without QuotaExceeded fallback or duplicate reseeks on return; WASM software mode
//      stashes raw GOPs at zero video decode CPU while hidden and replays the live GOP in sync on return.
// Writes `desktop/target/e2e/web-player-stress-result.json`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApi } from '../src/http.js'

const root = new URL('..', import.meta.url).pathname
const outDir = join(root, 'desktop/target/e2e')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const FFMPEG = existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg'
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8ffff3f0005fe02fea7d6a4a40000000049454e44ae426082',
  'hex'
)

function buildFixtures (dir) {
  const srtPath = join(dir, 'cues.srt')
  const srt = Array.from({ length: 48 }, (_, i) => {
    const ss = String(i % 60).padStart(2, '0')
    return `${i + 1}\n00:00:${ss},000 --> 00:00:${ss},900\ncue ${i}\n`
  }).join('\n')
  writeFileSync(srtPath, srt)

  // 48 s scope H.264 High + 5.1 AC-3 + stereo AAC + SRT, 8 s GOPs (-g 192), 6 B-frames, ~17 MiB (>8 x 2 MiB blocks).
  const h264Path = join(dir, 'cinema_h264.mkv')
  execFileSync(FFMPEG, [
    '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x534:rate=24',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000',
    '-i', srtPath,
    '-t', '48',
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
    '-g', '192', '-keyint_min', '192', '-sc_threshold', '0', '-bf', '6', '-b_strategy', '2',
    '-b:v', '2600k', '-maxrate', '3000k', '-bufsize', '6000k', '-preset', 'ultrafast',
    '-c:a:0', 'ac3', '-ac:a:0', '6', '-b:a:0', '384k',
    '-c:a:1', 'aac', '-ac:a:1', '2', '-b:a:1', '128k',
    '-c:s:0', 'srt',
    '-metadata:s:a:0', 'language=eng',
    '-metadata:s:a:1', 'language=spa',
    '-metadata:s:s:0', 'language=eng',
    h264Path
  ])

  // 36 s 10-bit HEVC Main10 + TrueHD (1,200 pkts/s) + 5.1 E-AC-3, 8 s GOPs, 6 B-frames, in-band headers.
  const uhdPath = join(dir, 'cinema_uhd.mkv')
  execFileSync(FFMPEG, [
    '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=960x400:rate=24',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000',
    '-t', '36',
    '-map', '0:v', '-map', '1:a', '-map', '2:a',
    '-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', '-preset', 'ultrafast',
    '-x265-params', 'keyint=192:min-keyint=192:scenecut=0:bframes=6:rc-lookahead=12:repeat-headers=1:log-level=error',
    '-c:a:0', 'truehd', '-strict', '-2', '-ac:a:0', '2',
    '-c:a:1', 'eac3', '-ac:a:1', '6', '-b:a:1', '384k',
    uhdPath
  ])

  // 28 s MPEG-4 Part 2 + 5.1 AC-3 MKV (forces pure WASM+GPU software video path).
  const swPath = join(dir, 'cinema_sw.mkv')
  execFileSync(FFMPEG, [
    '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=854x480:rate=24',
    '-f', 'lavfi', '-i', 'sine=frequency=520:sample_rate=48000',
    '-t', '28',
    '-c:v', 'mpeg4', '-q:v', '3', '-g', '96', '-bf', '2',
    '-c:a', 'ac3', '-ac', '6', '-b:a', '384k',
    swPath
  ])

  const aviPath = join(dir, 'episode_avi.avi')
  execFileSync(FFMPEG, [
    '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-t', '40', '-c:v', 'mpeg4', '-q:v', '3', '-g', '50', '-bf', '2',
    '-c:a', 'libmp3lame', '-q:a', '4', aviPath
  ])
  execFileSync(FFMPEG, ['-loglevel', 'error', '-y', '-i', aviPath,
    '-an', '-pix_fmt', 'yuv420p', '-f', 'rawvideo', join(dir, 'episode_avi.yuv')])

  return {
    h264: readFileSync(h264Path),
    uhd: readFileSync(uhdPath),
    sw: readFileSync(swPath),
    avi: readFileSync(aviPath)
  }
}

async function connectTarget (port, targetId) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const target = targetId ? list.find(t => t.id === targetId) : list.find(t => t.type === 'page')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let seq = 0
  const pending = new Map()
  const issues = []
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? reject(new Error(m.error.message)) : resolve(m.result)
      return
    }
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
      issues.push(m.params.type + ': ' + m.params.args.map(a => a.value ?? a.description).join(' '))
    }
    if (m.method === 'Runtime.exceptionThrown') {
      issues.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text))
    }
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
  await send('Runtime.enable')
  await send('Page.enable')
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result.value
  }
  return { id: target.id, ws, send, evaluate, issues }
}

async function launchBrowser (exe) {
  const dir = mkdtempSync(join(tmpdir(), 'peartube-web-stress-br-'))
  const proc = spawn(exe, [
    '--headless=new',
    '--remote-debugging-port=0',
    '--user-data-dir=' + dir,
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-extensions',
    '--use-mock-keychain',
    '--password-store=basic',
    '--disable-sync',
    '--disable-features=BraveWallet,BraveRewards,BraveNews',
    'about:blank'
  ], { stdio: 'ignore' })
  const portFile = join(dir, 'DevToolsActivePort')
  for (let i = 0; i < 200 && !existsSync(portFile); i++) await sleep(100)
  const port = readFileSync(portFile, 'utf8').split('\n')[0]
  const main = await connectTarget(port, null)
  const devtools = (path, method = 'GET') => fetch(`http://127.0.0.1:${port}${path}`, { method }).then(r => r.text())
  let heavyTab = null
  return {
    main,
    async activateHeavyOtherTab () {
      if (!heavyTab) {
        const info = JSON.parse(await devtools('/json/new?about:blank', 'PUT'))
        heavyTab = await connectTarget(port, info.id)
      }
      await devtools('/json/activate/' + heavyTab.id)
      await heavyTab.evaluate(`(() => {
        window.__busy = true;
        function burn () {
          if (!window.__busy) return;
          const end = performance.now() + 30;
          const arr = new Float64Array(16384);
          let s = 0;
          while (performance.now() < end) {
            for (let i = 0; i < arr.length; i += 64) { arr[i] = Math.cos(i + s); s += arr[i]; }
          }
          setTimeout(burn, 6);
        }
        burn();
        return true;
      })()`)
    },
    async returnToPlayerTab () {
      if (heavyTab) await heavyTab.evaluate(`window.__busy = false`).catch(() => {})
      await devtools('/json/activate/' + main.id)
    },
    async close () {
      try { main.ws.close() } catch {}
      try { heavyTab?.ws.close() } catch {}
      proc.kill('SIGKILL')
      await sleep(300)
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

test('web player survives long-GOP seeks, rapid scrub storms, TrueHD slices, WebCodecs fallback, and heavy background tab switches', { timeout: 240_000 }, async () => {
  const exe = process.env.PUPPETEER_EXECUTABLE_PATH
  assert.ok(exe && existsSync(exe), 'PUPPETEER_EXECUTABLE_PATH must point at a Chromium-family browser')
  mkdirSync(outDir, { recursive: true })
  const tmp = mkdtempSync(join(tmpdir(), 'peartube-web-stress-'))
  const files = buildFixtures(tmp)
  const aviReference = readFileSync(join(tmp, 'episode_avi.yuv'))
  const aviFrameBytes = 320 * 240 * 3 / 2
  const aviSignatures = []
  for (let off = 0; off + aviFrameBytes <= aviReference.length; off += aviFrameBytes) {
    const tiles = Array(64).fill(2166136261)
    for (let row = 0; row < 240; row += 4) {
      for (let col = 0; col < 320; col += 4) {
        const tile = Math.floor(row / 30) * 8 + Math.floor(col / 40)
        tiles[tile] = Math.imul(tiles[tile] ^ aviReference[off + row * 320 + col], 16777619) >>> 0
      }
    }
    aviSignatures.push(tiles)
  }
  const net = { delayMs: 0 }

  const blobSrv = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    const buf = files[u.searchParams.get('f') || 'h264']
    if (!buf) { res.writeHead(404); res.end(); return }
    if (net.delayMs > 0) {
      await sleep(net.delayMs)
      if (req.destroyed) return
    }
    const range = req.headers.range
    if (range && range.startsWith('bytes=')) {
      const [sStr, eStr] = range.slice(6).split('-')
      const start = Number(sStr) || 0
      const end = eStr ? Math.min(buf.length - 1, Number(eStr)) : (buf.length - 1)
      if (start >= buf.length) {
        res.writeHead(416, { 'content-range': `bytes */${buf.length}` })
        res.end()
        return
      }
      const slice = buf.subarray(start, end + 1)
      res.writeHead(206, {
        'content-type': 'video/x-matroska',
        'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${buf.length}`,
        'content-length': String(slice.length)
      })
      res.end(req.method === 'HEAD' ? undefined : slice)
      return
    }
    res.writeHead(200, { 'content-type': 'video/x-matroska', 'content-length': String(buf.length) })
    res.end(req.method === 'HEAD' ? undefined : buf)
  })
  await new Promise(resolve => blobSrv.listen(0, '127.0.0.1', resolve))
  const blobPort = blobSrv.address().port

  // Cross-origin poster server WITHOUT CORP headers, proving COEP: credentialless preserves 302 posters.
  const posterSrv = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(PNG)
  })
  await new Promise(resolve => posterSrv.listen(0, '127.0.0.1', resolve))
  const posterPort = posterSrv.address().port

  const entries = [
    {
      id: 'imdb:tt3397884',
      sha256: 'a'.repeat(64),
      title: 'Sicario 2015',
      size: files.h264.length,
      local: true,
      source: 'b'.repeat(64),
      sourceKind: 'channel',
      streamUrl: `http://127.0.0.1:${blobPort}/?key=${'a'.repeat(64)}&blob=1&f=h264`
    },
    {
      id: 'imdb:tt5052448',
      sha256: 'c'.repeat(64),
      title: 'Sicario UHD 2015',
      size: files.uhd.length,
      local: true,
      source: 'b'.repeat(64),
      sourceKind: 'channel',
      streamUrl: `http://127.0.0.1:${blobPort}/?key=${'c'.repeat(64)}&blob=1&f=uhd`
    },
    {
      id: 'clip:swcinema',
      sha256: 'd'.repeat(64),
      title: 'Software Cinema',
      size: files.sw.length,
      local: true,
      source: 'b'.repeat(64),
      sourceKind: 'channel',
      streamUrl: `http://127.0.0.1:${blobPort}/?key=${'d'.repeat(64)}&blob=1&f=sw`
    },
    {
      id: 'clip:avi-stress',
      sha256: 'e'.repeat(64),
      title: 'AVI MP3 Stress',
      size: files.avi.length,
      local: true,
      source: 'b'.repeat(64),
      sourceKind: 'channel',
      streamUrl: `http://127.0.0.1:${blobPort}/?key=${'e'.repeat(64)}&blob=1&f=avi`
    }
  ]

  const api = createApi({
    node: {
      blobServer: { port: blobPort },
      status: () => ({ peers: 3, lan: false, tracker: 'b'.repeat(64), channel: '' }),
      search: async id => id ? entries.filter(e => e.id === id) : entries,
      listSources: () => [],
      discoveredSources: async () => [],
      publishedSources: async () => []
    },
    posterUrl: async () => `http://127.0.0.1:${posterPort}/poster.png`
  })
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${api.address().port}`

  const browser = await launchBrowser(exe)
  const { evaluate, send, issues } = browser.main
  const waitFor = async (expr, what, timeout = 12_000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await evaluate(expr).catch(() => false)) return
      await sleep(80)
    }
    const diag = await evaluate(`({
      primed: player?.primed,
      drawn: player?.drawnFrames,
      swLen: player?.swFrames?.length, swPts: player?.swFrames?.map(x => x.pts), tickWall: player?.lastTickWall, perfNow: performance.now(), paused: player?.paused,
      useMse: player?.useMse,
      usingWc: player?.usingWebCodecs,
      badge: $('pBadge')?.textContent,
      status: $('pStatus')?.textContent,
      statusVis: $('pStatus')?.style?.display,
      now: player?.currentMediaTime?.()
    })`).catch(e => ({ err: e.message }))
    throw new Error('timed out waiting for ' + what + ' diag=' + JSON.stringify(diag) + ' issues=' + JSON.stringify(issues))
  }
  const result = { at: new Date().toISOString(), checks: {} }

  try {
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
    await send('Page.navigate', { url: baseUrl + '/' })
    await waitFor(`document.readyState === 'complete' && S.entries.length === 4`, 'library entries')
    await waitFor(`[...document.querySelectorAll('img.poster')].some(i => i.complete && i.naturalWidth > 0)`, 'cross-origin poster under COEP')

    // 1. COOP/COEP cross-origin isolation + SharedArrayBuffer + cross-origin posters.
    const iso = await evaluate(`({ isolated: window.crossOriginIsolated, sab: typeof SharedArrayBuffer === 'function' })`)
    assert.equal(iso.isolated, true, 'COOP/COEP enables crossOriginIsolated')
    assert.equal(iso.sab, true, 'SharedArrayBuffer unlocked')
    result.checks.isolation = iso

    // 2. WebCodecs+WASM is #1 primary on secure contexts: mid-GOP seek, video-only seek, focus race, scrub storm,
    //    macOS window drag (rAF stalled 900 ms), macOS window leave/occlusion (rAF stalled 2.4 s while visible), and hidden tab.
    await evaluate(`openPlayer(S.entries.find(e => e.id === 'imdb:tt3397884')); true`)
    await waitFor(`!!player && player.primed && player.drawnFrames >= 8`, 'H.264 WebCodecs primary playback started')
    const primaryOpen = await evaluate(`({ usingWebCodecs: player.usingWebCodecs, useMse: player.useMse, badge: $('pBadge').textContent })`)
    assert.equal(primaryOpen.usingWebCodecs, true, 'WebCodecs VideoDecoder chosen first')
    assert.equal(primaryOpen.useMse, false)
    assert.ok(primaryOpen.badge.includes('(WebCodecs+WASM)'), 'badge shows WebCodecs+WASM: ' + primaryOpen.badge)
    result.checks.primaryOpen = primaryOpen

    net.delayMs = 40
    await evaluate(`seekTo(23.2); true`)
    await waitFor(`player.primed && player.drawnFrames >= 4`, 'WebCodecs long-GOP seek primed')
    const firstSync = await evaluate(`({ v: player.lastSwPts, a: player.currentMediaTime() })`)
    assert.ok(Math.abs(firstSync.v - firstSync.a) < 0.35, `WebCodecs mid-GOP seek synced: v=${firstSync.v} a=${firstSync.a}`)

    const savedAudio = await evaluate(`player.audioStream`)
    await evaluate(`player.audioStream = -1; seekTo(23.2); true`)
    await waitFor(`player.primed && player.drawnFrames >= 4`, 'WebCodecs video-only long-GOP seek primed')
    await sleep(250)
    const voTime = await evaluate(`player.lastSwPts`)
    assert.ok(voTime >= 23.0 && voTime < 25.0, `WebCodecs video-only mid-GOP seek lands at target: ${voTime}`)
    await evaluate(`player.audioStream = ${savedAudio}; true`)

    // Window focus during an in-flight seek must not trigger a second seek that aborts priming.
    net.delayMs = 120
    const focusCheck = await evaluate(`(async () => {
      seekTo(31.4);
      const seq1 = player.seq;
      await new Promise(r => setTimeout(r, 30));
      const wasPrimed = player.primed;
      window.dispatchEvent(new Event('focus'));
      return { seq1, seq2: player.seq, wasPrimed };
    })()`)
    assert.equal(focusCheck.wasPrimed, false)
    assert.equal(focusCheck.seq2, focusCheck.seq1, 'focus during seek does not restart seekTo')
    await waitFor(`player.primed && player.drawnFrames >= 3`, 'seek after focus finished')

    // Rapid 8-seek storm across 2 MiB blocks under 80 ms Range latency.
    net.delayMs = 80
    await evaluate(`(async () => {
      for (const t of [5.0, 36.0, 11.5, 42.0, 2.5, 29.0, 14.0, 30.8]) {
        seekTo(t);
        await new Promise(r => setTimeout(r, 40));
      }
      return true;
    })()`)
    await waitFor(`player.primed && player.drawnFrames >= 6`, 'WebCodecs rapid seek storm settled')
    await sleep(300)
    const storm = await evaluate(`({
      v: player.lastSwPts,
      a: player.currentMediaTime(),
      lastBlock: player.lastReadBlock,
      statusHidden: $('pStatus').style.display === 'none'
    })`)
    assert.ok(Math.abs(storm.v - storm.a) < 0.35, `post-storm WebCodecs A/V sync tight: v=${storm.v} a=${storm.a}`)
    assert.ok(storm.lastBlock >= 0, 'block read-ahead stays armed after rapid seeks')
    assert.equal(storm.statusHidden, true)
    result.checks.seeks = { firstSync, voTime, storm }

    // Simulate macOS window move/drag (900 ms rAF freeze while visibilityState === 'visible') and
    // macOS window leave/occlusion (blur + 2.3 s rAF freeze while visibilityState === 'visible').
    net.delayMs = 20
    await evaluate(`seekTo(6.0); true`)
    await waitFor(`player.primed && player.drawnFrames >= 6`, 'WebCodecs ready at 6 s')
    const dragAndOcclude = await evaluate(`(async () => {
      let sawBuffering = false;
      const obs = setInterval(() => {
        if ($('pStatus').style.display !== 'none') sawBuffering = $('pStatus').textContent;
      }, 40);
      const origRaf = window.requestAnimationFrame;
      let pausedRaf = true;
      let heldCb = null;
      window.requestAnimationFrame = cb => {
        if (pausedRaf) { heldCb = cb; return 999999; }
        return origRaf.call(window, cb);
      };
      await new Promise(r => setTimeout(r, 40));
      // Phase A: 900 ms window drag (rAF frozen, backup 50 ms frameTimer keeps drawing WebCodecs VideoFrames!)
      const drawnBeforeDrag = player.drawnFrames;
      await new Promise(r => setTimeout(r, 900));
      const drawnDuringDrag = player.drawnFrames - drawnBeforeDrag;

      // Phase B: leave/cover browser window for another 1,600 ms (total 2.5 s rAF stall -> windowOccluded flips true)
      window.dispatchEvent(new Event('blur'));
      await new Promise(r => setTimeout(r, 1600));
      const occludedFlag = Boolean(player.windowOccluded);

      // Phase C: focus arrives before rAF resumes; decode must wake without waiting for the compositor.
      window.dispatchEvent(new Event('focus'));
      const workerUnhiddenOnFocus = await new Promise(resolve => {
        const onMem = ev => {
          if (ev.data?.type !== 'mem') return;
          clearTimeout(timer);
          player.worker.removeEventListener('message', onMem);
          resolve(ev.data.pageHidden === false);
        };
        player.worker.addEventListener('message', onMem);
        const timer = setTimeout(() => { player.worker.removeEventListener('message', onMem); resolve(false); }, 1000);
        player.worker.postMessage({ cmd: 'mem' });
      });
      pausedRaf = false;
      window.requestAnimationFrame = origRaf;
      const drawnAtUncover = player.drawnFrames;
      if (heldCb) player.raf = origRaf.call(window, heldCb);
      await new Promise(r => setTimeout(r, 700));
      const drawnAfterUncover = player.drawnFrames - drawnAtUncover;
      const occludedAfterUncover = Boolean(player.windowOccluded);
      const driftAfterUncover = Math.abs(player.lastSwPts - player.currentMediaTime());
      clearInterval(obs);
      return { sawBuffering, drawnDuringDrag, occludedFlag, workerUnhiddenOnFocus, occludedAfterUncover, drawnAfterUncover, driftAfterUncover };
    })()`)
    assert.equal(dragAndOcclude.sawBuffering, false, 'moving or leaving window never shows Buffering: ' + dragAndOcclude.sawBuffering)
    assert.ok(dragAndOcclude.drawnDuringDrag >= 8, `backup 50 ms frame stepper kept drawing during 900 ms window drag: ${dragAndOcclude.drawnDuringDrag}`)
    assert.equal(dragAndOcclude.occludedFlag, true, 'occluded unfocused window detected and paused invisible GPU decode')
    assert.equal(dragAndOcclude.workerUnhiddenOnFocus, true, 'focus wakes hidden decoding before the first resumed animation frame')
    assert.equal(dragAndOcclude.occludedAfterUncover, false, 'uncovering window clears occlusion flag')
    assert.ok(dragAndOcclude.drawnAfterUncover >= 8, `WebCodecs resumed drawing immediately on uncover: ${dragAndOcclude.drawnAfterUncover}`)
    assert.ok(dragAndOcclude.driftAfterUncover < 0.35, `post-uncover A/V sync tight: ${dragAndOcclude.driftAfterUncover}`)
    result.checks.windowDragAndLeave = dragAndOcclude

    // 3. 10-bit HEVC + TrueHD + E-AC-3 UHD remux on WebCodecs primary, runtime fallback to MSE+WASM, and >21 s hidden tab.
    net.delayMs = 0
    await evaluate(`openPlayer(S.entries.find(e => e.id === 'imdb:tt5052448')); true`)
    await waitFor(`!!player && player.primed && player.drawnFrames >= 6`, 'UHD HEVC10+TrueHD WebCodecs playing')
    assert.equal(await evaluate(`player.usingWebCodecs`), true, '10-bit HEVC uses WebCodecs primary')
    assert.ok((await evaluate(`$('pBadge').textContent`)).includes('h265 (WebCodecs+WASM) · truehd'))

    // Switch audio track to E-AC-3 and seek mid-GOP on WebCodecs.
    await evaluate(`(() => {
      const s = $('pAudioSel');
      s.selectedIndex = 1;
      s.dispatchEvent(new Event('change'));
      seekTo(23.5);
      return true;
    })()`)
    await waitFor(`player.primed && player.drawnFrames >= 4`, 'UHD EAC3 WebCodecs mid-GOP seek primed')
    await sleep(250)
    const eac3 = await evaluate(`({ badge: $('pBadge').textContent, v: player.lastSwPts, a: player.currentMediaTime() })`)
    assert.ok(eac3.badge.includes('eac3'), 'badge updates to eac3: ' + eac3.badge)
    assert.ok(Math.abs(eac3.v - eac3.a) < 0.35, `UHD EAC3 WebCodecs mid-GOP sync: v=${eac3.v} a=${eac3.a}`)

    // WebCodecs hidden-tab background playback + return under heavy CPU load in another tab.
    await evaluate(`seekTo(4.0); true`)
    await waitFor(`player.primed && player.drawnFrames >= 4`, 'UHD WebCodecs at 4 s')
    const seqBeforeWcBg = await evaluate(`player.seq`)
    await browser.activateHeavyOtherTab()
    await sleep(8000)
    const drawnBeforeWcReturn = await evaluate(`player.drawnFrames`)
    await browser.returnToPlayerTab()
    await evaluate(`window.dispatchEvent(new Event('focus')); true`)
    await waitFor(`player.drawnFrames >= ${drawnBeforeWcReturn + 8}`, 'WebCodecs resumed drawing immediately after hidden tab')
    const wcBg = await evaluate(`({
      reseekCount: player.seq - ${seqBeforeWcBg},
      usingWebCodecs: player.usingWebCodecs,
      drift: Math.abs(player.lastSwPts - player.currentMediaTime()),
      statusHidden: $('pStatus').style.display === 'none'
    })`)
    assert.equal(wcBg.usingWebCodecs, true)
    assert.equal(wcBg.reseekCount, 0)
    assert.ok(wcBg.drift < 0.35, `WebCodecs post-return drift tight: ${wcBg.drift}`)
    assert.equal(wcBg.statusHidden, true)
    result.checks.webCodecsBackground = wcBg

    // TrueHD (1,200 pkts/s) + software HEVC10 seek 7.5 s into an 8 s GOP (>9,000 packets > 4,096 slice budget).
    await evaluate(`(() => {
      const s = $('pAudioSel');
      s.selectedIndex = 0;
      player.audioStream = Number(s.value);
      player.useMse = false;
      player.allowWebCodecs = false;
      seekTo(15.5);
      return true;
    })()`)
    await waitFor(`player.primed && player.drawnFrames >= 8`, 'TrueHD software mid-GOP seek drew frames')
    const trueHdSw = await evaluate(`({ eof: player.eof, drawn: player.drawnFrames, a: player.currentMediaTime() })`)
    assert.equal(trueHdSw.eof, false, 'TrueHD >4,096 pre-target packet skip does not trigger false EOF')
    result.checks.uhdTrueHd = { eac3, trueHdSw }

    // Saved resume position (`play(e)` with `at > maxVideo`) + pre-manifest seek must start at `at` instead of deadlocking at 0:00.
    net.delayMs = 80
    await evaluate(`(() => {
      const u = S.entries.find(e => e.id === 'imdb:tt5052448');
      saveResume(u, 14.0, 36.0);
      play(u);
      seekTo(16.0);
      return true;
    })()`)
    await waitFor(`!!player && player.primed && player.currentMediaTime() >= 16.2`, 'saved resume + pre-manifest seek primed at target')
    net.delayMs = 0

    // Plain-HTTP LAN / MSE fallback path: simulate missing VideoDecoder (or webCodecsError), background >21 s, then return.
    await evaluate(`(() => {
      openPlayer(S.entries.find(e => e.id === 'imdb:tt5052448'), 0);
      return true;
    })()`)
    await waitFor(`!!player && player.primed`, 'UHD reopened before MSE fallback check')
    await evaluate(`(() => {
      player.webCodecsSupported = false;
      player.allowWebCodecs = false;
      player.usingWebCodecs = false;
      player.useMse = true;
      seekTo(1.0);
      window.__leads = [];
      window.__leadInt = setInterval(() => {
        if (player && document.hidden) window.__leads.push(player.nextAudioCtxTime - player.audioCtx.currentTime);
      }, 500);
      return true;
    })()`)
    await waitFor(`player.primed && player.useMse && $('pVideo').currentTime >= 1.2`, 'UHD MSE fallback playing')
    const seqBeforeMseBg = await evaluate(`player.seq`)
    await browser.activateHeavyOtherTab()
    await sleep(21_000)
    await browser.returnToPlayerTab()
    await evaluate(`window.dispatchEvent(new Event('focus')); true`)
    await sleep(900)
    const mseBg = await evaluate(`(() => {
      clearInterval(window.__leadInt);
      return {
        leads: window.__leads,
        reseekCount: player.seq - ${seqBeforeMseBg},
        useMse: player.useMse,
        vPaused: $('pVideo').paused,
        v: $('pVideo').currentTime,
        a: player.currentMediaTime(),
        bufStart: $('pVideo').buffered.length ? $('pVideo').buffered.start(0) : -1,
        statusHidden: $('pStatus').style.display === 'none'
      };
    })()`)
    assert.equal(mseBg.useMse, true, 'MSE fallback survived >21 s hidden tab without fallbackSw')
    assert.equal(mseBg.reseekCount, 0, 'returning + focus does not double-seek')
    assert.equal(mseBg.vPaused, false, 'video element resumed after hidden stretch')
    assert.ok(mseBg.leads.length >= 10 && mseBg.leads.every(l => l > 0), 'background audio never ran dry under heavy tab load')
    assert.ok(mseBg.bufStart > 0, `old SourceBuffer GOPs evicted cleanly while hidden: start=${mseBg.bufStart}`)
    assert.ok(Math.abs(mseBg.v - mseBg.a) < 0.35, `MSE post-return A/V sync tight: v=${mseBg.v} a=${mseBg.a}`)
    assert.equal(mseBg.statusHidden, true)
    result.checks.mseBackground = { minLead: Math.min(...mseBg.leads), v: mseBg.v, a: mseBg.a, bufStart: mseBg.bufStart }
    // 4. Pure WASM+GPU software video: only in-flight pictures may arrive just after hide; the live GOP replays on return.
    await evaluate(`(() => {
      window.__hiddenSwFrames = [];
      window.__swHiddenAt = 0;
      document.addEventListener('visibilitychange', () => { if (document.hidden) window.__swHiddenAt = performance.now(); }, { once: true });
      openPlayer(S.entries.find(e => e.id === 'clip:swcinema'));
      player.worker.addEventListener('message', ev => {
        if (ev.data?.type === 'videoFrame' && document.visibilityState !== 'visible') {
          window.__hiddenSwFrames.push(performance.now() - window.__swHiddenAt);
        }
      });
      return true;
    })()`)
    await waitFor(`!!player && player.primed && player.drawnFrames >= 6`, 'software WASM+GPU playing')
    assert.ok((await evaluate(`$('pBadge').textContent`)).includes('(WASM+GPU)'))
    await browser.activateHeavyOtherTab()
    await sleep(6500)
    const drawnBeforeReturn = await evaluate(`player.drawnFrames`)
    await browser.returnToPlayerTab()
    await evaluate(`window.dispatchEvent(new Event('focus')); true`)
    const statusImmediate = await evaluate(`$('pStatus').style.display === 'none'`)
    await waitFor(`player.drawnFrames >= ${drawnBeforeReturn + 8}`, 'software frames drawing immediately on return', 8000)
    const swBg = await evaluate(`({
      hiddenFrames: window.__hiddenSwFrames,
      hiddenAt: window.__swHiddenAt,
      drawn: player.drawnFrames,
      drift: Math.abs(player.lastSwPts - player.currentMediaTime()),
      statusHidden: $('pStatus').style.display === 'none'
    })`)
    assert.equal(statusImmediate, true, 'no false Buffering… flash on return')
    assert.ok(swBg.hiddenAt > 0 && swBg.hiddenFrames.length <= 8 && swBg.hiddenFrames.every(t => t < 500),
      `software decode stops after the in-flight frames: ${JSON.stringify(swBg.hiddenFrames)}`)
    assert.ok(swBg.drift < 0.35, `software hidden-GOP replay resumed in sync: drift=${swBg.drift}`)
    assert.equal(swBg.statusHidden, true)
    result.checks.swBackground = swBg

    // AVI/MP3: rapid seek storms and repeated background returns keep each decoded picture on its real source frame.
    net.delayMs = 80
    await evaluate(`(() => {
      openPlayer(S.entries.find(e => e.id === 'clip:avi-stress'), 5.3);
      window.__aviSamples = [];
      const wanted = ${JSON.stringify(aviSignatures)};
      const deliver = player.worker.onmessage;
      player.worker.onmessage = ev => {
        const m = ev.data;
        if (m?.type === 'videoFrame' && m.seq === player.seq && m.yuv && m.w === 320 && m.h === 240) {
          const y = new Uint8Array(m.buf, 0, 320 * 240);
          const tiles = Array(64).fill(2166136261);
          for (let row = 0; row < 240; row += 4) {
            for (let col = 0; col < 320; col += 4) {
              const tile = Math.floor(row / 30) * 8 + Math.floor(col / 40);
              tiles[tile] = Math.imul(tiles[tile] ^ y[row * 320 + col], 16777619) >>> 0;
            }
          }
          const ref = wanted[Math.round(m.pts * 25)];
          let matchingTiles = 0;
          if (ref) for (let i = 0; i < 64; i++) if (tiles[i] === ref[i]) matchingTiles++;
          window.__aviSamples.push({ seq: m.seq, pts: m.pts, matchingTiles });
        }
        deliver(ev);
      };
      return true;
    })()`)
    await waitFor(`player.primed && player.drawnFrames >= 5 && window.__aviSamples.length >= 5`, 'AVI/MP3 playing real decoded pictures')
    await evaluate(`(async () => {
      for (const t of [11.3, 2.3, 17.4, 8.5, 5.3]) {
        seekTo(t);
        await new Promise(r => setTimeout(r, 45));
      }
      return true;
    })()`)
    await waitFor(`player.primed && player.drawnFrames >= 6 && window.__aviSamples.filter(x => x.seq === player.seq).length >= 6`, 'AVI seek storm picture and audio settled')
    const seekContent = await evaluate(`window.__aviSamples.filter(x => x.seq === player.seq).slice(-8)`)
    assert.ok(seekContent.length >= 6 && seekContent.every(x => x.matchingTiles >= 50),
      `AVI pictures survive the rapid seek storm: ${JSON.stringify(seekContent)}`)
    const aviCycles = []
    for (const hiddenFor of [8300, 3100, 4300, 2100]) {
      await browser.activateHeavyOtherTab()
      await sleep(hiddenFor)
      await browser.returnToPlayerTab()
      await evaluate(`window.dispatchEvent(new Event('focus')); true`)
      const returnedAt = Date.now()
      await waitFor(`player.drawnFrames >= 6 && player.lastSwPts !== null && Math.abs(player.lastSwPts - player.currentMediaTime()) < 0.35`, 'AVI picture resumed after hidden tab', 8000)
      const recoveryMs = Date.now() - returnedAt
      const sample = await evaluate(`({
        v: player.lastSwPts, a: player.currentMediaTime(),
        wrong: window.__aviSamples.filter(x => x.seq === player.seq && x.pts >= player.lastSwPts - 0.4).find(x => x.matchingTiles < 50),
        matched: window.__aviSamples.filter(x => x.seq === player.seq && x.pts >= player.lastSwPts - 0.4 && x.matchingTiles >= 50).length,
        statusHidden: $('pStatus').style.display === 'none'
      })`)
      assert.equal(sample.wrong, undefined, `AVI pixels drifted from their labelled time: ${JSON.stringify(sample.wrong)}`)
      assert.ok(sample.matched >= 4, `AVI decoded source frames reach the screen after return: ${JSON.stringify(sample)}`)
      assert.ok(Math.abs(sample.v - sample.a) < 0.35, `AVI picture and MP3 clock remain together: ${JSON.stringify(sample)}`)
      assert.equal(sample.statusHidden, true, 'AVI return does not remain buffering')
      assert.ok(recoveryMs < 1500, `AVI took ${recoveryMs} ms to show current pictures after a hidden tab`)
      aviCycles.push({ video: sample.v, audio: sample.a, matched: sample.matched, recoveryMs })
    }
    result.checks.aviBackground = aviCycles

    assert.deepEqual(issues, [], 'no console errors or uncaught exceptions')
    result.pass = true
    writeFileSync(join(outDir, 'web-player-stress-result.json'), JSON.stringify(result, null, 2))
  } finally {
    await browser.close()
    api.closeAllConnections?.()
    api.close()
    blobSrv.closeAllConnections?.()
    blobSrv.close()
    posterSrv.closeAllConnections?.()
    posterSrv.close()
    rmSync(tmp, { recursive: true, force: true })
  }
})
