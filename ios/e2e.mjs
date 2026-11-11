#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import createTestnet from 'hyperdht/testnet.js'
import { createNode } from '../src/index.js'
import { createLan, lanAddress } from '../src/lan.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
process.chdir(root)
const args = process.argv.slice(2)
const simulator = args.includes('--simulator') ? args[args.indexOf('--simulator') + 1] : null
const device = args.includes('--device') ? args[args.indexOf('--device') + 1] : null
const team = args.includes('--team') ? args[args.indexOf('--team') + 1] : null
if (Boolean(simulator) === Boolean(device) || (device && !team)) throw new Error('Usage: node ios/e2e.mjs (--simulator <UDID> | --device <UDID> --team <Personal-Team-ID>) [--lan]')
const lan = args.includes('--lan')
const host = lanAddress(networkInterfaces())
if (!host) throw new Error('iOS E2E needs a Wi-Fi or Ethernet IPv4 reachable from the simulator or iPhone')
const output = join(root, 'ios/build/e2e')
mkdirSync(output, { recursive: true })
const runDir = mkdtempSync(join(output, 'run-'))
const privateDir = mkdtempSync(join(tmpdir(), 'peartube-ios-e2e-'))
const run = (program, argv, options = {}) => execFileSync(program, argv, { cwd: root, stdio: 'inherit', ...options })
let testnet
let relay
const snapshots = []
let timer
let reading
let receiverProcess
let pairCode
const redact = text => {
  const value = pairCode ? String(text).replaceAll(pairCode, '[REDACTED]') : String(text)
  return value.replace(/\b(token|apiToken|pairCode|seed|secretKey|privateKey)(["']?\s*[:=]\s*["']?)[^"'&\s,}]+/gi, '$1$2[REDACTED]')
}
const result = { schemaVersion: 1, at: new Date().toISOString(), mode: lan ? 'lan' : 'public-dht', simulator, device, passed: false }
try {
  testnet = lan ? null : await createTestnet(3, { host })
  relay = await createNode({
    storage: join(privateDir, 'relay'),
    bootstrap: testnet?.bootstrap ?? [{ host: '127.0.0.1', port: 9 }],
    lan: lan ? keyPair => createLan({ host, keyPair }) : null
  })
  const file = join(privateDir, 'fixture.mkv')
  const subtitles = join(privateDir, 'fixture.srt')
  writeFileSync(subtitles, '1\n00:00:01,000 --> 00:00:45,000\nPearTube native subtitle evidence\n')
  run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000', '-i', subtitles, '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s', '-t', '60', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p', '-c:a', 'flac', '-c:s', 'srt', '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=fra', '-metadata:s:s:0', 'language=eng', '-y', file])
  const bytes = readFileSync(file)
  for (const entry of [
    { id: 'imdb:tt0111161', title: 'PearTube E2E Movie 1080p.mkv' },
    { id: 'imdb:tt0903747:s01e01', title: 'PearTube Series S01E01.mkv' },
    { id: 'imdb:tt0903747:s01e02', title: 'PearTube Series S01E02.mkv' }
  ]) await relay.publish(entry, Readable.from([bytes]))
  const entries = await relay.search()
  const movie = entries.find(entry => entry.id === 'imdb:tt0111161')
  assert.ok(movie)
  // The receiver is a node: it must be on the same DHT as the relay and the app, or the app cannot reach it by key.
  const bootstrap = lan ? '127.0.0.1:9' : testnet.bootstrap.map(node => `${host}:${node.port}`).join(',')
  receiverProcess = spawn(process.execPath, ['test/receiver-fixture.js', '--port', '0', '--name', `PearTube E2E TV ${privateDir.split('-').at(-1)}`, '--storage', join(privateDir, 'receiver'), '--bootstrap', bootstrap], {
    cwd: root, env: { ...process.env, PEARTUBE_LAN_HOST: host || '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit']
  })
  const lines = createInterface({ input: receiverProcess.stdout })
  const receiver = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('The portable receiver did not start')), 15000)
    receiverProcess.once('error', error => { clearTimeout(deadline); reject(error) })
    lines.once('line', line => { clearTimeout(deadline); resolve(JSON.parse(line)) })
  })
  lines.close()
  pairCode = receiver.pairCode
  const fixture = {
    storage: `e2e-${Date.now()}`, tracker: relay.status().tracker, bootstrap,
    lan, movieKey: movie.key, movieTitle: movie.title, receiverId: receiver.deviceId, pairCode: receiver.pairCode,
    entries: entries.map(({ key, id, title }) => ({ key, id, title }))
  }
  const fixturePath = join(privateDir, 'fixture.json')
  writeFileSync(fixturePath, JSON.stringify(fixture, null, 2), { mode: 0o600 })
  run('node', ['ios/project.mjs'], { env: { ...process.env, PEARTUBE_E2E_FIXTURE: fixturePath } })
  const xcresult = join(privateDir, 'Parity.xcresult')
  const command = ['-project', 'ios/PearTube.xcodeproj', '-scheme', 'PearTube', '-destination', device ? `platform=iOS,id=${device}` : `platform=iOS Simulator,id=${simulator}`, '-derivedDataPath', device ? 'ios/build/physical-e2e' : 'ios/build/simulator', '-resultBundlePath', xcresult, '-parallel-testing-enabled', 'NO', '-test-timeouts-enabled', 'YES', '-default-test-execution-time-allowance', '300', '-maximum-test-execution-time-allowance', '360']
  if (device) command.push('-allowProvisioningUpdates', '-allowProvisioningDeviceRegistration', `DEVELOPMENT_TEAM=${team}`)
  command.push('test')
  result.command = ['xcodebuild', ...command]
  const child = spawn('xcodebuild', command, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 900000 })
  const logs = []
  console.log(`Running native iOS XCTest; redacted evidence will be saved in ${runDir}`)
  for (const stream of [child.stdout, child.stderr]) {
    let pending = ''
    stream.setEncoding('utf8')
    stream.on('data', data => {
      logs.push(Buffer.from(data))
      pending += data
      for (let newline = pending.indexOf('\n'); newline !== -1; newline = pending.indexOf('\n')) {
        process.stdout.write(redact(pending.slice(0, newline + 1)))
        pending = pending.slice(newline + 1)
      }
    })
    stream.on('end', () => { if (pending) process.stdout.write(redact(pending)) })
  }
  let container
  timer = setInterval(() => {
    if (reading) return
    reading = (async () => {
      try {
        let path
        if (device) {
          path = join(privateDir, 'native-state.json')
          await new Promise((resolve, reject) => execFile('xcrun', ['devicectl', 'device', 'copy', 'from', '--device', device, '--domain-type', 'appDataContainer', '--domain-identifier', 'com.peartube.app.dev', '--source', 'Documents/e2e-state.json', '--destination', path, '--quiet'], { timeout: 15000 }, error => error ? reject(error) : resolve()))
        } else {
          container = execFileSync('xcrun', ['simctl', 'get_app_container', simulator, 'com.peartube.app.dev', 'data'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
          path = join(container, 'Documents/e2e-state.json')
        }
        if (!existsSync(path)) return
        const snapshot = JSON.parse(readFileSync(path))
        if (snapshot.settings?.tracker !== fixture.tracker) return
        if (!snapshots.length || snapshot.timestamp !== snapshots.at(-1).timestamp) snapshots.push(snapshot)
      } catch { /* The app/container may not have been installed yet. */ }
    })().finally(() => { reading = null })
  }, 500)
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  clearInterval(timer)
  await reading
  const redactedLog = redact(Buffer.concat(logs).toString())
  writeFileSync(join(runDir, 'xcodebuild.log'), redactedLog)
  writeFileSync(join(runDir, 'native-snapshots.json'), JSON.stringify(snapshots, null, 2))
  result.relay = relay.status()
  result.media = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), video: 'h264', audio: ['flac:eng', 'flac:fra'], subtitle: 'subrip:eng' }
  result.exitCode = code
  if (existsSync(xcresult)) {
    const summary = run('xcrun', ['xcresulttool', 'get', 'test-results', 'summary', '--path', xcresult, '--compact'], { stdio: 'pipe', encoding: 'utf8' })
    writeFileSync(join(runDir, 'xctest-summary.json'), redact(summary))
    const exported = join(privateDir, 'attachments')
    run('xcrun', ['xcresulttool', 'export', 'attachments', '--path', xcresult, '--output-path', exported], { stdio: 'pipe' })
    result.apiEventRestart = []
    const safeScreens = new Set(['failure-state', 'library-synchronized', 'series-episodes', 'under-the-hood', 'native-player-running', 'player-controls-hidden', 'player-controls-revealed', 'player-paused-and-seeked', 'audio-tracks', 'subtitle-tracks', 'content-info', 'fullscreen-landscape', 'fullscreen-portrait', 'resumed-player', 'library-after-restart', 'network-settings', 'automatic-tv-discovery', 'cast-remote', 'transferred-back-to-phone', 'settings-restart-after-cast'])
    for (const test of JSON.parse(readFileSync(join(exported, 'manifest.json')))) {
      for (const attachment of test.attachments) {
        const proof = attachment.suggestedHumanReadableName?.match(/^peartube-proof-(api-sse-restart|background-resume)(?:[_.]|$)/)?.[1]
        if (proof && attachment.exportedFileName.endsWith('.txt')) {
          const observed = JSON.parse(readFileSync(join(exported, attachment.exportedFileName)))
          if (proof === 'api-sse-restart') result.apiEventRestart.push({ opened: observed.opened === true, closed: observed.closed === true })
          else result.lifecycle = { background: observed.background === true, resumed: observed.resumed === true }
        }
        const name = attachment.suggestedHumanReadableName?.match(/^peartube-evidence-([a-z-]+)(?:[_.]|$)/)?.[1]
        if (!safeScreens.has(name) || !attachment.exportedFileName.endsWith('.png')) continue
        mkdirSync(join(runDir, 'screenshots'), { recursive: true })
        copyFileSync(join(exported, attachment.exportedFileName), join(runDir, 'screenshots', `${name}.png`))
      }
    }
  }
  assert.equal(code, 0, 'XCTest parity scenarios must pass')
  assert.ok(snapshots.some(s => s.status?.writer && s.status.writer !== relay.status().writer), 'The app must run its own peer')
  assert.ok(snapshots.some(s => s.entries?.some(e => e.key === movie.key)), 'The app must receive the published movie')
  assert.ok(snapshots.some(s => s.player?.state?.positionMs > 1000 && !s.player.state.error), 'Native playback must advance without an error')
  assert.ok(result.lifecycle?.background && result.lifecycle?.resumed, 'The real app must enter the background and resume')
  const castProof = JSON.parse(readFileSync(join(privateDir, 'receiver/last-playback.json')))
  assert.equal(castProof.fullSha256, result.media.sha256, 'The TV must receive byte-exact media from the phone peer')
  assert.equal(castProof.fullBytes, bytes.length)
  assert.equal(castProof.rangeStatus, 206)
  result.cast = { fullSha256: castProof.fullSha256, fullBytes: castProof.fullBytes, rangeStatus: castProof.rangeStatus, rangeBytes: castProof.rangeBytes }
  assert.ok(snapshots.some(s => s.cast?.session?.receiverId === receiver.deviceId), 'The app must attach to the paired TV')
  assert.ok(result.apiEventRestart?.some(proof => proof.opened && proof.closed), 'Settings restart must close an already-open API event subscription while cast is attached')
  if (lan) {
    assert.ok(result.relay.routes.lan.txBytes >= bytes.length, 'Video bytes must travel over the LAN')
    assert.equal(result.relay.routes.public.txBytes + result.relay.routes.private.txBytes, 0, 'No public/private route may carry LAN-only test video')
  } else assert.ok(result.relay.routes.public.txBytes > 0, 'The app must receive actual P2P media bytes')
  result.passed = true
} catch (error) {
  result.error = redact(error.stack)
  process.exitCode = 1
} finally {
  clearInterval(timer)
  await reading
  writeFileSync(join(runDir, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  copyFileSync(join(runDir, 'result.json'), join(output, `${device ? 'device-' : ''}${lan ? 'lan-result.json' : 'result.json'}`))
  try {
    if (receiverProcess?.pid && receiverProcess.exitCode === null && receiverProcess.signalCode === null) {
      const closed = new Promise(resolve => receiverProcess.once('close', resolve))
      receiverProcess.kill('SIGTERM')
      await closed
    }
    try { await relay?.close() } finally { await testnet?.destroy() }
  } finally {
    try {
      for (const [data, platform] of [['physical-e2e', 'iphoneos'], ['simulator', 'iphonesimulator']]) {
        rmSync(join(root, 'ios/build', data, 'Build/Products', `Debug-${platform}`, 'PearTubeUITests-Runner.app'), { recursive: true, force: true })
      }
    } finally {
      rmSync(privateDir, { recursive: true, force: true })
    }
  }
}
console.log(JSON.stringify(result, null, 2))
