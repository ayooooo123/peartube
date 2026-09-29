// The app's P2P worker: a Bare worklet running the same core as the relay.
// The Rust app talks to it over BareKit.IPC in newline-delimited JSON:
//   app -> worker  {id, method, params}   start | status | search | stop
//   worker -> app  {id, result} | {id, error} | {event: 'update'} | {event: 'fatal', error}
// 'update' means the tracker or the peer set changed. Stream URLs point at the
// core's blob server on 127.0.0.1, which the app plays.
// Some of LAN discovery's dependencies use the global `process`, which Bare
// only has once bare-process/global has run. Imports load in order.
import 'bare-process/global'
import b4a from 'b4a'
import { createNode } from '../src/index.js'
import { createLan } from '../src/lan.js'

const ipc = BareKit.IPC
let node = null
let lifecycle = Promise.resolve()

// Any peer can publish a title with a lone surrogate, which serde_json rejects.
const wellFormed = (key, value) => typeof value === 'string' ? value.toWellFormed() : value
const send = msg => ipc.write(JSON.stringify(msg, wellFormed) + '\n')
const update = () => send({ event: 'update' })

// start and stop run one at a time, so a quick settings change cannot leave
// two nodes open on the same storage.
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
  if (!open) return
  open.swarm.off('update', update)
  await open.close()
}

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
  // lan: this device's LAN address as ip:port, for the mDNS discovery relays
  // use on one network (src/lan.js); null leaves it off.
  start: ({ storage, tracker, relayThrough = null, bootstrap = null, lan = null }) => serial(async () => {
    await close()
    node = await createNode({
      storage,
      tracker,
      relayThrough,
      bootstrap: bootstrap ? bootstrap.map(hostPort) : undefined,
      lan: lan ? keyPair => createLan({ ...hostPort(lan), keyPair }) : null,
      onchange: update
    })
    node.swarm.on('update', update)
    return node.status()
  }),
  status: async () => (await current()).status(),
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
let suspending = null
Bare.on('suspend', linger => {
  suspending = setTimeout(() => node?.swarm.suspend().catch(fatal), Math.min(linger, 5000))
})
Bare.on('resume', () => {
  clearTimeout(suspending)
  node?.swarm.resume().catch(fatal)
})
