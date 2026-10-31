#!/usr/bin/env node
// Standalone, diskless, Corestore-free 2-hop Guard forwarder daemon:
// touches zero files on disk, imports zero Hypercore/Corestore modules, and forwards only encrypted UDX streams in RAM.
// Runs under Node or Bare; bin/relay.js starts it as a child process when its `privateGuard` setting is on.
import process from 'node:process'
import b4a from 'b4a'
import { createPrivateGuard } from '../src/private-overlay.js'

const env = process.env
const bootstrap = env.PEARTUBE_BOOTSTRAP
  ? env.PEARTUBE_BOOTSTRAP.split(',').map(s => {
      const i = s.trim().lastIndexOf(':')
      return i > 0 ? { host: s.trim().slice(0, i), port: Number(s.trim().slice(i + 1)) } : s.trim()
    }).filter(Boolean)
  : undefined
const port = Number(env.PEARTUBE_PRIVATE_RELAY_PORT || env.PEARTUBE_DHT_PORT || 0)
const host = env.PEARTUBE_PRIVATE_HOST || undefined
const seed = env.PEARTUBE_GUARD_SEED && /^[0-9a-f]{64}$/i.test(env.PEARTUBE_GUARD_SEED.trim())
  ? b4a.from(env.PEARTUBE_GUARD_SEED.trim(), 'hex')
  : null

const guard = await createPrivateGuard({ host, port, bootstrap, seed })
const addr = guard.address()
console.log(JSON.stringify({
  msg: 'private-guard ready',
  publicKey: b4a.toString(guard.publicKey, 'hex'),
  host: addr?.host || host || '0.0.0.0',
  port: addr?.port || port
}))

const heartbeat = setInterval(() => {
  console.log(JSON.stringify({
    msg: 'private-guard heartbeat',
    publicKey: b4a.toString(guard.publicKey, 'hex'),
    ...guard.stats()
  }))
}, env.PEARTUBE_GUARD_FOLLOW_PARENT ? 10_000 : 60_000)
heartbeat.unref?.()

let stopping = false
async function shutdown () {
  if (stopping) return
  stopping = true
  clearInterval(heartbeat)
  setTimeout(() => process.exit(0), 2000).unref?.()
  await guard.close().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
// Started by bin/relay.js: leave with the relay, even if it died without stopping us.
if (env.PEARTUBE_GUARD_FOLLOW_PARENT) {
  const parent = process.ppid
  setInterval(() => { if (process.ppid !== parent) shutdown() }, 2000).unref?.()
}
