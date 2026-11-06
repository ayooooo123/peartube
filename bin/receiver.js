#!/usr/bin/env node
// Portable PearTube TV Receiver daemon: kneels on any Linux/macOS/Pi/HTPC box or thin network
// appliance, advertising _peartube-cast._tcp + Noise P2P keypair while driving web, mpv, vlc, or headless sinks.
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { connect as connectSocket } from 'node:net'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import os from 'node:os'
import b4a from 'b4a'
import { createNode } from '../src/index.js'
import { createLan, interfaceAdapter, lanAddress } from '../src/lan.js'
import { createReceiver, resolvePeerStorage } from '../src/cast.js'
import { RECEIVER_PORT } from '../src/protocol.js'

if (typeof globalThis.Bare !== 'undefined') {
  await import('bare-process/global')
}

const env = process.env
const args = process.argv.slice(2)

function argVal (flag, fallback = null) {
  const i = args.indexOf(flag)
  return i !== -1 && i + 1 < args.length ? args[i + 1] : fallback
}
const hasFlag = flag => args.includes(flag)

const storage = argVal('--storage', env.PEARTUBE_STORAGE || './peartube-receiver-data')
const peerStorageArg = argVal('--peer-storage', env.PEARTUBE_PEER_STORAGE || '')
const name = argVal('--name', env.PEARTUBE_RECEIVER_NAME || `${os.hostname?.() || 'PearTube'} TV`)
const port = Number(argVal('--port', env.PEARTUBE_RECEIVER_PORT || RECEIVER_PORT))
const thin = hasFlag('--thin') || env.PEARTUBE_RECEIVER_THIN === '1'
const openAuth = hasFlag('--open') || env.PEARTUBE_RECEIVER_OPEN === '1'
const playerKind = argVal('--player', env.PEARTUBE_RECEIVER_PLAYER || 'web')
const bootstrap = argVal('--bootstrap', env.PEARTUBE_BOOTSTRAP || '')

mkdirSync(storage, { recursive: true, mode: 0o700 })

function currentLanIp () {
  if (env.PEARTUBE_LAN_HOST) return env.PEARTUBE_LAN_HOST
  try { return lanAddress(os.networkInterfaces()) } catch { return null }
}

// Drives mpv over its JSON UNIX IPC pipe so D-pad and phone seeks hit hardware decode directly.
function createMpvDriver (storageDir) {
  let proc = null
  let ipc = null
  let pollTimer = null
  let reqId = 1
  const sockPath = join(storageDir, `mpv-${process.pid}.sock`)

  function sendMpv (command) {
    if (ipc && !ipc.destroyed) {
      try { ipc.write(JSON.stringify({ command, request_id: reqId++ }) + '\n') } catch {}
    }
  }

  function stopMpv () {
    clearInterval(pollTimer)
    pollTimer = null
    if (ipc) { try { ipc.destroy() } catch {} ipc = null }
    if (proc) { try { proc.kill() } catch {} proc = null }
    try { unlinkSync(sockPath) } catch {}
  }

  return {
    async onCommand (cmd, ctx) {
      if (cmd.action === 'load') {
        stopMpv()
        const startSec = cmd.startPositionMs > 0 ? `--start=+${(cmd.startPositionMs / 1000).toFixed(2)}` : null
        const mpvArgs = ['--fs', '--force-window=immediate', '--audio-spdif=ac3,eac3,dts-hd,truehd', '--video-sync=display-resample', '--hdr-compute-peak=auto', '--target-colorspace-hint=yes', `--input-ipc-server=${sockPath}`, ...(startSec ? [startSec] : []), cmd.streamUrl]
        proc = spawn('mpv', mpvArgs, { stdio: 'ignore' })
        proc.on('error', err => ctx.updateState({ status: 'error', playing: false, buffering: false, error: `mpv failed: ${err.message}` }))
        proc.once('exit', () => {
          if (proc) {
            stopMpv()
            const cur = ctx.getState()
            if (cur.entry) ctx.updateState({ status: 'ended', playing: false, buffering: false, ended: true })
          }
        })
        for (let i = 0; i < 30 && proc; i++) {
          await new Promise(resolve => setTimeout(resolve, 100))
          try {
            const sock = await new Promise((resolve, reject) => {
              const s = connectSocket(sockPath, () => resolve(s))
              s.once('error', reject)
            })
            ipc = sock
            let buf = ''
            const props = { pos: cmd.startPositionMs || 0, dur: null, paused: false, idle: false }
            sock.on('data', chunk => {
              buf += b4a.toString(b4a.isBuffer(chunk) ? chunk : b4a.from(chunk))
              let nl
              while ((nl = buf.indexOf('\n')) !== -1) {
                const line = buf.slice(0, nl)
                buf = buf.slice(nl + 1)
                let msg
                try { msg = JSON.parse(line) } catch { continue }
                if (msg.request_id === 9001 && typeof msg.data === 'number') props.pos = Math.round(msg.data * 1000)
                else if (msg.request_id === 9002 && typeof msg.data === 'number') props.dur = Math.round(msg.data * 1000)
                else if (msg.request_id === 9003 && typeof msg.data === 'boolean') props.paused = msg.data
                else if (msg.request_id === 9004 && Array.isArray(msg.data)) {
                  const tracks = msg.data
                    .filter(t => t.type === 'audio' || t.type === 'sub')
                    .map(t => ({ stream: Number(t.id), kind: t.type === 'sub' ? 'subtitle' : 'audio', codec: String(t.codec || ''), language: t.lang || null, title: t.title || null }))
                  const selAudio = msg.data.find(t => t.type === 'audio' && t.selected)?.id ?? null
                  const selSub = msg.data.find(t => t.type === 'sub' && t.selected)?.id ?? -1
                  ctx.updateState({ positionMs: props.pos, durationMs: props.dur, playing: !props.paused, buffering: false, status: props.paused ? 'paused' : 'playing', tracks, audio: selAudio, subtitle: selSub })
                }
              }
            })
            sock.on('error', () => {})
            pollTimer = setInterval(() => {
              if (!ipc || ipc.destroyed) return
              try {
                ipc.write(
                  JSON.stringify({ command: ['get_property', 'time-pos'], request_id: 9001 }) + '\n' +
                  JSON.stringify({ command: ['get_property', 'duration'], request_id: 9002 }) + '\n' +
                  JSON.stringify({ command: ['get_property', 'pause'], request_id: 9003 }) + '\n' +
                  JSON.stringify({ command: ['get_property', 'track-list'], request_id: 9004 }) + '\n'
                )
              } catch {}
            }, 500)
            pollTimer.unref?.()
            break
          } catch {}
        }
      } else if (cmd.action === 'play') sendMpv(['set_property', 'pause', false])
      else if (cmd.action === 'pause') sendMpv(['set_property', 'pause', true])
      else if (cmd.action === 'togglePlay') sendMpv(['cycle', 'pause'])
      else if (cmd.action === 'seek') sendMpv(['seek', (cmd.positionMs || 0) / 1000, 'absolute'])
      else if (cmd.action === 'skip') sendMpv(['seek', (cmd.deltaMs || 0) / 1000, 'relative'])
      else if (cmd.action === 'selectAudio') sendMpv(['set_property', 'aid', cmd.stream < 0 ? 'no' : cmd.stream])
      else if (cmd.action === 'selectSubtitle') sendMpv(['set_property', 'sid', cmd.stream < 0 ? 'no' : cmd.stream])
      else if (cmd.action === 'volume') {
        if (typeof cmd.volume === 'number') sendMpv(['set_property', 'volume', Math.round(cmd.volume * 100)])
        if (typeof cmd.muted === 'boolean') sendMpv(['set_property', 'mute', cmd.muted])
      } else if (cmd.action === 'stop') stopMpv()
    },
    close: stopMpv
  }
}

// Spawns VLC or any custom shell binary (`cmd:ffplay -fs`) for appliances with their own video player.
function createProcessDriver (spec) {
  let proc = null
  const rawCmd = spec === 'vlc' ? 'vlc --fullscreen --play-and-exit' : spec.replace(/^cmd:/, '')
  const parts = rawCmd.trim().split(/\s+/)
  const bin = parts[0]
  const baseArgs = parts.slice(1)
  const killProc = () => { if (proc) { try { proc.kill() } catch {} proc = null } }
  return {
    async onCommand (cmd, ctx) {
      if (cmd.action === 'load') {
        killProc()
        proc = spawn(bin, [...baseArgs, cmd.streamUrl], { stdio: 'ignore' })
        proc.on('error', err => ctx.updateState({ status: 'error', playing: false, buffering: false, error: err.message }))
        ctx.updateState({ status: 'playing', playing: true, buffering: false })
        proc.once('exit', () => {
          if (proc) { proc = null; ctx.updateState({ status: 'ended', playing: false, ended: true }) }
        })
      } else if (cmd.action === 'stop') killProc()
    },
    close: killProc
  }
}

// Deterministic headless sink: pulls real HTTP Range slices and SHA-256s the full cast stream into disk evidence.
function createHeadlessDriver (storageDir) {
  let timer = null
  let activeSeq = 0

  function fetchBytes (url, rangeHeader = null) {
    return new Promise((resolve, reject) => {
      const headers = rangeHeader ? { range: rangeHeader } : {}
      const req = httpRequest(url, { headers }, res => {
        const hash = createHash('sha256')
        let bytes = 0
        res.on('data', chunk => {
          const b = b4a.isBuffer(chunk) ? chunk : b4a.from(chunk)
          hash.update(b)
          bytes += b.length
        })
        res.once('end', () => resolve({ statusCode: res.statusCode, bytes, sha256: hash.digest('hex'), contentRange: res.headers['content-range'] || null }))
        res.once('error', reject)
      })
      req.once('error', reject)
      req.end()
    })
  }

  return {
    async onCommand (cmd, ctx) {
      if (cmd.action === 'load') {
        clearInterval(timer)
        const mySeq = ++activeSeq
        const durationMs = 60_000
        let pos = cmd.startPositionMs || 0
        const tracks = [
          { stream: 0, kind: 'audio', codec: 'flac', language: 'eng', title: 'Stereo' },
          { stream: 1, kind: 'subtitle', codec: 'ass', language: 'eng', title: 'English' }
        ]
        ctx.updateState({ status: 'playing', playing: true, buffering: false, positionMs: pos, durationMs, tracks, audio: 0, subtitle: -1 })
        timer = setInterval(() => {
          const cur = ctx.getState()
          if (!cur.entry || !cur.playing) return
          pos = Math.min(durationMs, (cur.positionMs || 0) + 500)
          ctx.updateState({ positionMs: pos, playing: pos < durationMs, ended: pos >= durationMs, status: pos >= durationMs ? 'ended' : 'playing' })
        }, 500)
        timer.unref?.()

        ;(async () => {
          try {
            const probe = await fetchBytes(cmd.streamUrl, 'bytes=0-4095')
            const full = await fetchBytes(cmd.streamUrl)
            if (mySeq !== activeSeq) return
            const artifact = {
              verifiedAt: Date.now(),
              entry: cmd.entry,
              mode: ctx.getState().mode,
              streamUrl: cmd.streamUrl,
              rangeStatus: probe.statusCode,
              rangeBytes: probe.bytes,
              fullStatus: full.statusCode,
              fullBytes: full.bytes,
              fullSha256: full.sha256
            }
            writeFileSync(join(storageDir, 'last-playback.json'), JSON.stringify(artifact, null, 2))
          } catch (err) {
            if (mySeq === activeSeq) ctx.updateState({ status: 'error', playing: false, buffering: false, error: err.message })
          }
        })()
      } else if (cmd.action === 'stop') {
        activeSeq++
        clearInterval(timer)
        timer = null
      }
    },
    close () {
      activeSeq++
      clearInterval(timer)
      timer = null
    }
  }
}

const driver = playerKind === 'mpv'
  ? createMpvDriver(storage)
  : playerKind === 'headless'
    ? createHeadlessDriver(storage)
    : (playerKind === 'vlc' || playerKind.startsWith('cmd:'))
      ? createProcessDriver(playerKind)
      : null

let lanIp = currentLanIp()
let node = null
const peerStorage = peerStorageArg ? await resolvePeerStorage(peerStorageArg, storage) : storage
if (!thin) {
  node = await createNode({
    storage: peerStorage,
    bootstrap: bootstrap ? bootstrap.split(',').map(s => s.trim()).filter(Boolean) : undefined,
    privateRouting: Boolean(env.PEARTUBE_PRIVATE_ROUTING),
    relayThrough: env.PEARTUBE_RELAY_THROUGH ? env.PEARTUBE_RELAY_THROUGH.split(',') : null,
    lan: lanIp ? keyPair => createLan({ host: lanIp, keyPair, adapter: interfaceAdapter(lanIp) }) : null
  })
}

const receiver = await createReceiver({
  storage,
  peerStorage,
  name,
  port,
  lanHost: lanIp,
  node,
  allowPeerNode: !thin,
  openAuth,
  onCommand: driver ? (cmd, ctx) => driver.onCommand(cmd, ctx) : null
})

const lanWatcher = setInterval(async () => {
  const nextIp = currentLanIp()
  if (nextIp === lanIp) return
  lanIp = nextIp
  await receiver.setHost(lanIp).catch(() => {})
  if (node) {
    await node.setLan(lanIp && (keyPair => createLan({ host: lanIp, keyPair, adapter: interfaceAdapter(lanIp) }))).catch(() => {})
  }
}, 10_000)
lanWatcher.unref?.()

let shuttingDown = false
async function shutdown () {
  if (shuttingDown) return
  shuttingDown = true
  clearInterval(lanWatcher)
  const kill = () => { try { os.kill?.(process.pid, 9) } catch {} process.exit(0) }
  setTimeout(kill, 3000).unref?.()
  driver?.close?.()
  await receiver.close().catch(() => {})
  await node?.close().catch(() => {})
  process.exit(0)
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, shutdown)

console.log(JSON.stringify({ msg: 'receiver ready', thin, player: playerKind, ...receiver.info() }))
