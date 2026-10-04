// The app's P2P worker: a Bare worklet running the same core as the relay.
// The Rust app talks to it over BareKit.IPC in newline-delimited JSON:
//   app -> worker  {id, method, params}   start | status | search | stop
//   worker -> app  {id, result} | {id, error} | {event: 'update'} | {event: 'fatal', error}
// 'update' means the tracker, the peer set or LAN discovery changed. start and
// status return the core's status plus `lan` (see lanNote). Stream URLs point
// at the core's blob server on 127.0.0.1, which the app plays.
// Some of LAN discovery's dependencies use the global `process`, which Bare
// only has once bare-process/global has run. Imports load in order.
import 'bare-process/global'
import b4a from 'b4a'
import os from 'bare-os'
import { createNode } from '../src/index.js'
import { createLan, interfaceAdapter, lanAddress } from '../src/lan.js'

const ipc = BareKit.IPC
let node = null
let lifecycle = Promise.resolve()

// Any peer can publish a title with a lone surrogate, which serde_json rejects.
const wellFormed = (key, value) => typeof value === 'string' ? value.toWellFormed() : value
const send = msg => ipc.write(JSON.stringify(msg, wellFormed) + '\n')
const update = () => send({ event: 'update' })

// start, stop and LAN moves run one at a time, so a quick settings change
// cannot leave two nodes open on the same storage.
function serial (fn) {
  const next = lifecycle.then(fn)
  lifecycle = next.catch(() => {})
  return next
}

// The old swarm's listener goes first: closing it fires 'update' per connection.
// A closed tracker stops calling onchange on its own.
async function close () {
  const open = node
  node = null
  lanHost = null
  lanError = null
  lanNote = null
  if (!open) return
  open.swarm.off('update', update)
  await open.close()
}

// LAN discovery (src/lan.js) binds to this device's Wi-Fi or Ethernet address,
// which changes as the device moves between networks. moveLan rebinds it to
// the current address, or stops it when there is none, when it is off, or
// while the app is in the background. It runs on start, on resume and every
// few seconds, inside serial. lanNote tells the status line what it is doing:
// on <address>, paused, failed on <address>, or found no Wi-Fi address (with
// the addresses it did see). It is null while LAN discovery is off.
const LAN_PORT = 49798 // one below the relay's default, so both fit on one machine
let lanWanted = false
let lanHost = null
let lanError = null
let lanNote = null
let suspended = false

async function moveLan () {
  let host = null
  let seen = ''
  if (node && lanWanted && !suspended) {
    try {
      const interfaces = os.networkInterfaces()
      host = lanAddress(interfaces)
      seen = ipv4s(interfaces)
    } catch (err) {
      seen = `cannot list interfaces (${err.message})`
    }
  }
  if (host !== lanHost) {
    lanHost = host
    lanError = null
    try {
      await node.setLan(host && (keyPair => createLan({ host, port: LAN_PORT, keyPair, adapter: interfaceAdapter(host) })))
    } catch (err) {
      lanError = err.message
    }
  }
  const note = noteFor(seen)
  if (note !== lanNote) {
    lanNote = note
    update()
  }
}

function noteFor (seen) {
  if (!node || !lanWanted) return null
  if (suspended) return 'paused'
  if (!lanHost) return `found no Wi-Fi address; this device has ${seen || 'no IPv4 address'}`
  return lanError ? `failed on ${lanHost}: ${lanError}` : `on ${lanHost}`
}

// Every interface's own IPv4 addresses, as "wlan0 10.0.0.5, rmnet0 100.64.0.2".
function ipv4s (interfaces) {
  return Object.entries(interfaces)
    .flatMap(([name, entries]) => entries.filter(e => (e.family === 'IPv4' || e.family === 4) && !e.internal).map(e => `${name} ${e.address}`))
    .join(', ')
}

const report = () => ({ ...node.status(), lan: lanNote })

// Reads wait for a queued start or stop, so they never see the node being replaced.
async function current () {
  await lifecycle
  if (!node) throw new Error('Not started')
  return node
}

function hostPort (address) {
  const i = address.lastIndexOf(':')
  return { host: address.slice(0, i), port: Number(address.slice(i + 1)) }
}

const methods = {
  // lan: whether to find relays on this device's network over mDNS.
  start: ({ storage, tracker, relayThrough = null, bootstrap = null, lan = false }) => serial(async () => {
    await close()
    node = await createNode({
      storage,
      tracker,
      relayThrough,
      bootstrap: bootstrap ? bootstrap.map(hostPort) : undefined,
      onchange: update
    })
    node.swarm.on('update', update)
    lanWanted = lan
    await moveLan()
    return report()
  }),
  status: async () => { await current(); return report() },
  search: async ({ id = null }) => (await current()).search(id),
  stop: () => serial(close)
}

async function handle (line) {
  let msg
  try { msg = JSON.parse(line) } catch { return send({ event: 'fatal', error: 'Malformed message from app' }) }
  try {
    const method = methods[msg.method]
    if (!method) throw new Error(`Unknown method ${msg.method}`)
    send({ id: msg.id, result: (await method(msg.params || {})) ?? null })
  } catch (err) {
    send({ id: msg.id, error: err.message })
  }
}

let pending = b4a.alloc(0)
ipc.on('data', chunk => {
  pending = b4a.concat([pending, chunk])
  for (let i = b4a.indexOf(pending, 10); i !== -1; i = b4a.indexOf(pending, 10)) {
    const line = b4a.toString(pending.subarray(0, i))
    pending = pending.subarray(i + 1)
    if (line) handle(line)
  }
})

// A worklet error aborts the whole app unless handled here; report it instead.
const fatal = err => send({ event: 'fatal', error: String(err?.message || err) })
Bare.on('uncaughtException', fatal).on('unhandledRejection', fatal)

// The app suspends the worklet in the background, and the OS grants `linger` ms
// before Bare stops. iOS also reports every brief loss of focus (notification
// shade, app switcher) as a suspend, so peers are dropped only if it lasts.
// LAN discovery stops with them; back in front it binds to whatever network
// the device is on by then.
let suspending = null
Bare.on('suspend', linger => {
  // A second suspend before the resume must not leave the first timer behind.
  clearTimeout(suspending)
  suspending = setTimeout(() => {
    suspended = true
    node?.swarm.suspend().catch(fatal)
    serial(moveLan).catch(fatal)
  }, Math.min(linger, 5000))
})
Bare.on('resume', () => {
  clearTimeout(suspending)
  suspended = false
  node?.swarm.resume().catch(fatal)
  serial(moveLan).catch(fatal)
})

// Joining or leaving a network does not suspend the app.
setInterval(() => serial(moveLan).catch(fatal), 10_000)
