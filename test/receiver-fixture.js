// Test fixture, not a product: a receiver with no screen. It advertises _peartube-cast._tcp, takes casts, and checks
// the bytes it is sent; the position and tracks it reports are made up. Real receivers are the TV app and
// PearTubeReceiver, which play with PearTube's own player.
import { mkdirSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import os from 'node:os'
import b4a from 'b4a'
import { createNode } from '../src/index.js'
import { createLan, interfaceAdapter, lanAddress } from '../src/lan.js'
import { createReceiver, receiverKeyPair, resolvePeerStorage } from '../src/cast.js'
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
const openAuth = hasFlag('--open') || env.PEARTUBE_RECEIVER_OPEN === '1'
const bootstrap = argVal('--bootstrap', env.PEARTUBE_BOOTSTRAP || '')

mkdirSync(storage, { recursive: true, mode: 0o700 })

function currentLanIp () {
  if (env.PEARTUBE_LAN_HOST) return env.PEARTUBE_LAN_HOST
  try { return lanAddress(os.networkInterfaces()) } catch { return null }
}

// Stands in for the player: pulls real HTTP Range slices and SHA-256s the full cast stream into disk evidence.
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

const driver = createHeadlessDriver(storage)

let lanIp = currentLanIp()
const peerStorage = peerStorageArg ? await resolvePeerStorage(peerStorageArg, storage) : storage
// The node runs under the receiver's saved key, so the senders that paired with it find it again after a restart.
const node = await createNode({
  storage: peerStorage,
  keyPair: receiverKeyPair(storage),
  bootstrap: bootstrap ? bootstrap.split(',').map(s => s.trim()).filter(Boolean) : undefined,
  privateRouting: Boolean(env.PEARTUBE_PRIVATE_ROUTING),
  relayThrough: env.PEARTUBE_RELAY_THROUGH ? env.PEARTUBE_RELAY_THROUGH.split(',') : null,
  lan: lanIp ? keyPair => createLan({ host: lanIp, keyPair, adapter: interfaceAdapter(lanIp) }) : null
})

const receiver = await createReceiver({
  storage,
  peerStorage,
  name,
  port,
  lanHost: lanIp,
  node,
  openAuth,
  onCommand: (cmd, ctx) => driver.onCommand(cmd, ctx)
})

const lanWatcher = setInterval(async () => {
  const nextIp = currentLanIp()
  if (nextIp === lanIp) return
  lanIp = nextIp
  // The node's LAN endpoint moves first: the receiver advertises it.
  await node.setLan(lanIp && (keyPair => createLan({ host: lanIp, keyPair, adapter: interfaceAdapter(lanIp) }))).catch(() => {})
  await receiver.setHost(lanIp).catch(() => {})
}, 10_000)
lanWatcher.unref?.()

let shuttingDown = false
async function shutdown () {
  if (shuttingDown) return
  shuttingDown = true
  clearInterval(lanWatcher)
  const kill = () => { try { os.kill?.(process.pid, 9) } catch {} process.exit(0) }
  setTimeout(kill, 3000).unref?.()
  driver.close()
  await receiver.close().catch(() => {})
  await node.close().catch(() => {})
  process.exit(0)
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, shutdown)

console.log(JSON.stringify({ msg: 'receiver ready', ...receiver.info() }))
