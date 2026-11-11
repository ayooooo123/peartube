// Capture a rooted Android peer's actual packets, device logs, and receiver state beside a future test.
// Never install or restart an app: this only observes the serials explicitly named on the command line.
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { finished } from 'node:stream/promises'

const args = process.argv.slice(2)
const separator = args.indexOf('--')
const command = separator < 0 ? [] : args.slice(separator + 1)
const flags = separator < 0 ? args : args.slice(0, separator)
const serials = []
let out, receiver, seconds
for (let i = 0; i < flags.length; i++) {
  const value = flags[++i]
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flags[i - 1]}`)
  switch (flags[i - 1]) {
    case '--serial': serials.push(value); break
    case '--out': out = resolve(value); break
    case '--receiver': receiver = value; break
    case '--seconds': seconds = Number(value); break
    default: throw new Error(`Unknown option ${flags[i - 1]}`)
  }
}
if (!serials.length || new Set(serials).size !== serials.length || !out || (!command.length && !seconds) ||
    (seconds !== undefined && (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400))) {
  // The receiver answers its telemetry on loopback only: `adb -s <tv> forward tcp:8176 tcp:8176`, then --receiver http://127.0.0.1:8176.
  throw new Error('Usage: node android/capture-network.mjs --serial <rooted-adb-serial> [--serial ...] --out <new-directory> [--receiver http://127.0.0.1:8176] [--seconds 60] [-- command args...]')
}
if (existsSync(out)) throw new Error(`Capture directory already exists: ${out}`)
const adb = (serial, ...cmd) => execFileSync('adb', ['-s', serial, ...cmd], { encoding: 'utf8', timeout: 8000 }).trim()
const sha256 = file => new Promise((resolveHash, reject) => {
  const hash = createHash('sha256')
  const stream = createReadStream(file)
  stream.on('data', chunk => hash.update(chunk))
  stream.on('error', reject)
  stream.on('end', () => resolveHash(hash.digest('hex')))
})
const sleep = ms => new Promise(done => setTimeout(done, ms))

const freeBytes = new Map()
// Refuse partial evidence: an unprivileged shell or missing tcpdump cannot produce a useful device pcap.
for (const serial of serials) {
  if (adb(serial, 'shell', 'id', '-u') !== '0') throw new Error(`${serial}: ADB shell is not root; device-side tcpdump needs root or a separate router-side capture`)
  if (!adb(serial, 'shell', 'command -v tcpdump')) throw new Error(`${serial}: tcpdump is not installed`)
  const rows = adb(serial, 'shell', 'df -k /data/local/tmp').trim().split(/\r?\n/)
  const availableKiB = Number(rows.at(-1)?.trim().split(/\s+/)[3])
  const minimumBytes = 512 * 1048576 + (seconds || 3600) * 384 * 1024
  if (!Number.isFinite(availableKiB) || availableKiB * 1024 < minimumBytes) {
    throw new Error(`${serial}: /data/local/tmp needs at least ${Math.ceil(minimumBytes / 1048576)} MiB free for the requested capture`)
  }
  freeBytes.set(serial, availableKiB * 1024)
}
if (receiver) {
  const url = new URL('/cast/v1/info', receiver)
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`Receiver telemetry returned HTTP ${response.status}`)
}
mkdirSync(out, { recursive: true, mode: 0o700 })
const manifest = { started: new Date().toISOString(), receiver: receiver || null, snaplen: 128, devices: [], command, seconds: seconds || null }
const captures = []
let interrupted = false
let child = null
let timer = null
let timerHandle = null
let signalStop
const interruptedPromise = new Promise(done => { signalStop = done })
const stopSignal = signal => {
  interrupted = true
  if (child && child.exitCode === null) child.kill(signal)
  signalStop({ interrupted: signal })
}
process.on('SIGINT', () => stopSignal('SIGINT'))
process.on('SIGTERM', () => stopSignal('SIGTERM'))

async function startDevice (serial, index) {
  const prefix = `peer-${index + 1}`
  const pcap = join(out, `${prefix}.pcap`)
  const log = join(out, `${prefix}.logcat.txt`)
  const remoteBase = `/data/local/tmp/peartube-capture-${randomBytes(8).toString('hex')}`
  const pidFile = `${remoteBase}.pid`
  const errFile = `${remoteBase}.err`
  const remotePcap = `${remoteBase}.pcap`
  const device = { serial, pcap: `${prefix}.pcap`, logcat: `${prefix}.logcat.txt`, started: new Date().toISOString(), deviceTime: adb(serial, 'shell', 'date +%s'), packageVersion: adb(serial, 'shell', 'dumpsys package com.peartube.receiver').match(/versionName=(\S+)/)?.[1] || null, freeBytesBefore: freeBytes.get(serial), remotePcap }
  manifest.devices.push(device)
  // Spool on the device: streaming a trace through ADB would recapture its own port-5555 traffic.
  const remoteCommand = `echo $$ > ${pidFile}; exec tcpdump -i any -s 128 -U -w ${remotePcap} 'not tcp port 5555' 2>${errFile}`
  const capture = spawn('adb', ['-s', serial, 'exec-out', 'sh', '-c', remoteCommand], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  capture.stderr.on('data', b => { stderr += b.toString() })
  const logcat = spawn('adb', ['-s', serial, 'logcat', '-v', 'epoch', '-T', '1'], { stdio: ['ignore', 'pipe', 'pipe'] })
  const logFile = createWriteStream(log, { mode: 0o600 })
  const logFinished = finished(logFile).catch(err => err)
  logcat.stdout.pipe(logFile)
  captures.push({ serial, device, capture, logcat, logFinished, pcap, log, pidFile, errFile, remotePcap, getStderr: () => stderr })
  for (let i = 0; i < 40 && capture.exitCode === null; i++) {
    try {
      if (Number(adb(serial, 'shell', `if test -f ${remotePcap}; then wc -c < ${remotePcap}; fi`)) >= 24) break
    } catch {}
    await sleep(100)
  }
  if (capture.exitCode !== null) throw new Error(`${serial}: tcpdump exited before it could record packets: ${stderr.trim()}`)
  const header = execFileSync('adb', ['-s', serial, 'exec-out', 'sh', '-c', `dd if=${remotePcap} bs=24 count=1 2>/dev/null`], { timeout: 8000, maxBuffer: 1024 })
  const magic = header.subarray(0, 4).toString('hex')
  if (header.length !== 24 || !['d4c3b2a1', 'a1b2c3d4', '4d3cb2a1', 'a1b23c4d'].includes(magic)) throw new Error(`${serial}: invalid on-device pcap header ${magic}`)
  device.pid = Number(adb(serial, 'shell', `cat ${pidFile}`)) || null
  if (!device.pid) throw new Error(`${serial}: tcpdump PID was not recorded`)
}

async function stopDevice (capture) {
  const { serial, device, logFinished, logcat, pcap, log, pidFile, errFile, remotePcap } = capture
  const active = () => capture.capture.exitCode === null && capture.capture.signalCode === null
  const diedBeforeStop = !active()
  if (!device.pid) {
    try { device.pid = Number(adb(serial, 'shell', `cat ${pidFile}`)) || null } catch {}
  }
  if (active() && device.pid) {
    try { adb(serial, 'shell', `kill -2 ${device.pid}`) } catch (err) { device.stopError = String(err) }
  }
  for (let i = 0; i < 30 && active(); i++) await sleep(100)
  if (active() && device.pid) {
    try { adb(serial, 'shell', `kill -15 ${device.pid}`) } catch (err) { device.stopError = String(err) }
  }
  if (active()) capture.capture.kill('SIGTERM')
  if (logcat.exitCode === null && logcat.signalCode === null) logcat.kill('SIGTERM')
  const logResult = await logFinished
  if (logResult instanceof Error) device.captureError = String(logResult)
  device.finished = new Date().toISOString()
  device.logSha256 = await sha256(log)
  let remoteError = capture.getStderr()
  try { remoteError += adb(serial, 'shell', `cat ${errFile}`) } catch {}
  const dropped = remoteError.match(/(\d+) packets dropped by kernel/)
  device.kernelDrops = dropped ? Number(dropped[1]) : null
  try {
    execFileSync('adb', ['-s', serial, 'pull', remotePcap, pcap], { encoding: 'utf8', timeout: 0, maxBuffer: 1 << 20 })
    device.pcapBytes = statSync(pcap).size
    device.pcapSha256 = await sha256(pcap)
    const head = Buffer.allocUnsafe(4)
    const fd = openSync(pcap, 'r')
    try { readSync(fd, head, 0, 4, 0) } finally { closeSync(fd) }
    const magic = head.toString('hex')
    if (device.pcapBytes <= 24 || !['d4c3b2a1', 'a1b2c3d4', '4d3cb2a1', 'a1b23c4d'].includes(magic)) {
      throw new Error('Pulled pcap has no packet records or a damaged header')
    }
    adb(serial, 'shell', `rm -f ${pidFile} ${errFile} ${remotePcap}`)
    device.remotePcap = null
  } catch (err) {
    device.captureError = `${err}; on-device evidence retained at ${remotePcap}`
  }
  // Don't fuck a valid capture just because adb needed SIGTERM after tcpdump's timed stop.
  if (diedBeforeStop && (capture.capture.exitCode !== 0 || capture.capture.signalCode) && !interrupted) {
    device.captureError = `tcpdump exited early ${capture.capture.exitCode ?? capture.capture.signalCode}: ${remoteError.trim()}`
  }
}

let telemetry = null
let telemetryFile = null
let telemetryTask = null
let commandExit = null
let failure = null
try {
  for (const [index, serial] of serials.entries()) {
    if (interrupted) throw new Error('Capture interrupted before the test began')
    await startDevice(serial, index)
  }
  if (receiver) {
    telemetryFile = createWriteStream(join(out, 'receiver.ndjson'), { mode: 0o600 })
    telemetry = { running: true, errors: 0, samples: 0 }
    telemetryTask = (async () => {
      while (telemetry.running) {
        const at = new Date().toISOString()
        try {
          const info = await (await fetch(new URL('/cast/v1/info', receiver), { signal: AbortSignal.timeout(3000) })).json()
          const s = info.state || {}
          telemetryFile.write(JSON.stringify({ at, deviceUpdatedAt: s.updatedAt, status: s.status, mode: s.mode, positionMs: s.positionMs, buffering: s.buffering, droppedFrames: s.droppedFrames, cachedBytes: s.cachedBytes, p2pPeers: s.p2pPeers, routes: info.routes, error: s.error }) + '\n')
          telemetry.samples++
        } catch (err) {
          telemetryFile.write(JSON.stringify({ at, error: String(err) }) + '\n')
          telemetry.errors++
        }
        if (telemetry.running) await sleep(1000)
      }
    })()
  }
  if (interrupted) throw new Error('Capture interrupted before the test began')
  console.log(`Capture ready in ${out}`)
  if (command.length) {
    child = spawn(command[0], command.slice(1), { stdio: 'inherit' })
    commandExit = new Promise((done, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => done({ code, signal }))
    })
  }
  if (seconds) timer = new Promise(done => { timerHandle = setTimeout(() => done({ timedOut: true }), seconds * 1000) })
  const outcome = await Promise.race([commandExit, timer, interruptedPromise].filter(Boolean))
  if (outcome.timedOut && child?.exitCode === null) {
    child.kill('SIGINT')
    await Promise.race([commandExit, sleep(3000)])
    if (child.exitCode === null) child.kill('SIGTERM')
  }
  manifest.commandExit = outcome
} catch (err) {
  failure = String(err?.stack || err)
} finally {
  clearTimeout(timerHandle)
  if (telemetry) telemetry.running = false
  if (telemetryTask) await telemetryTask
  if (telemetryFile) { telemetryFile.end(); await finished(telemetryFile) }
  for (const capture of captures) await stopDevice(capture)
  if (telemetry) manifest.telemetry = { ...telemetry, running: undefined }
  manifest.finished = new Date().toISOString()
  if (failure) manifest.error = failure
  writeFileSync(join(out, 'capture.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
}
if (failure || manifest.devices.some(d => d.captureError)) throw new Error(failure || 'Packet capture did not retain any packets')
if (manifest.commandExit?.code && !manifest.commandExit?.timedOut) process.exitCode = manifest.commandExit.code
if (interrupted) process.exitCode = 130
console.log(`Captured packet, log, and receiver evidence in ${out}`)
