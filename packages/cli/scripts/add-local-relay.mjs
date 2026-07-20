#!/usr/bin/env node
/**
 * Boots a local trusted PearTube relay so `peartube add` can reach `published`.
 *
 * The relay joins the public DHT, accepts authenticated seed-pin requests, and
 * pins the uploader's blob ranges. It prints a ready-to-use config file and the
 * exact `peartube add` command to run against it. Ctrl-C to stop.
 *
 * Usage: node scripts/add-local-relay.mjs [relayStorageDir]
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PinStore, PinWorker, registerSeedPinProtocol } from '@peartube/backend/seed-pin'

// corestore/hyperswarm/hyperbee live in the backend package's dependency tree.
const backendRequire = createRequire(new URL('../../backend/package.json', import.meta.url))
const Corestore = backendRequire('corestore')
const Hyperswarm = backendRequire('hyperswarm')
const Hyperbee = backendRequire('hyperbee')
const crypto = backendRequire('hypercore-crypto')
const b4a = backendRequire('b4a')
const relayStorage = process.argv[2] || join(tmpdir(), 'peartube-local-relay')
mkdirSync(relayStorage, { recursive: true })

function loadOrCreateKeyPair (dir) {
  const keyFile = join(dir, 'relay-key.json')
  if (existsSync(keyFile)) {
    const saved = JSON.parse(readFileSync(keyFile, 'utf8'))
    return { publicKey: b4a.from(saved.publicKey, 'hex'), secretKey: b4a.from(saved.secretKey, 'hex') }
  }
  const keyPair = crypto.keyPair()
  writeFileSync(keyFile, JSON.stringify({
    publicKey: b4a.toString(keyPair.publicKey, 'hex'),
    secretKey: b4a.toString(keyPair.secretKey, 'hex')
  }))
  return keyPair
}

const store = new Corestore(join(relayStorage, 'corestore'))
await store.ready()
const metaCore = store.get({ name: 'relay-meta' })
await metaCore.ready()
const metaDb = new Hyperbee(metaCore, { keyEncoding: 'utf-8', valueEncoding: 'json' })
await metaDb.ready()

const keyPair = loadOrCreateKeyPair(relayStorage)
const relayKey = b4a.toString(keyPair.publicKey, 'hex')

const swarm = new Hyperswarm({ keyPair })
swarm.on('connection', (connection) => {
  store.replicate(connection)
  console.error(`[relay] peer connected: ${b4a.toString(connection.remotePublicKey, 'hex').slice(0, 16)}…`)
})

const pinStore = new PinStore({ db: metaDb })
const worker = new PinWorker({ corestore: store, pinStore, concurrency: 2, rangeTimeout: 120_000, downloadTimeout: 120_000 })

const ctx = { store, metaDb, swarm, seedPinClients: new Map() }
const registration = registerSeedPinProtocol(ctx, {
  store: pinStore,
  worker,
  admission: async ({ verified }) => {
    console.error(`[relay] pin request for channel ${String(verified?.manifest?.channelKey || '').slice(0, 16)}… — accepting`)
    return true
  },
  capacity: async () => true,
  onError: (error) => console.error('[relay] registration error:', error?.message || error)
})
await registration.ready
await swarm.listen()

const configPath = join(relayStorage, 'uploader-config.json')
const uploaderStorage = join(relayStorage, 'uploader-storage')
writeFileSync(configPath, JSON.stringify({
  content: { storagePath: uploaderStorage, ytDlpPath: process.env.PEARTUBE_YTDLP_PATH || 'yt-dlp' },
  network: { trustedRelayKeys: [relayKey], blindPeerMirrors: [relayKey] }
}, null, 2))

console.error('')
console.error('════════════════════════════════════════════════════════════════')
console.error('  PearTube local trusted relay is running')
console.error(`  relay key : ${relayKey}`)
console.error(`  storage   : ${relayStorage}`)
console.error(`  config    : ${configPath}`)
console.error('')
console.error('  Run the uploader in another terminal:')
console.error('')
console.error(`    export PATH="$HOME/Library/Python/3.9/bin:$PATH"`)
console.error(`    node peartube.js add "<url-or-file>" --type video --title "Demo" \\`)
console.error(`      --yes --json --config ${configPath}`)
console.error('')
console.error('  Ctrl-C to stop the relay.')
console.error('════════════════════════════════════════════════════════════════')

let closing = false
async function shutdown () {
  if (closing) return
  closing = true
  console.error('\n[relay] shutting down…')
  try { await registration.unregister?.() } catch {}
  try { await worker.stop?.() } catch {}
  try { await swarm.destroy() } catch {}
  try { await metaDb.close() } catch {}
  try { await store.close() } catch {}
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
