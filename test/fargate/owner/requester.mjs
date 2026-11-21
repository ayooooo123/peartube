import { createWriteStream } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import BlindPeering from 'blind-peering'
import Corestore from 'corestore'
import DHT from 'hyperdht'
import id from 'hypercore-id-encoding'
import Wakeup from 'protomux-wakeup'

function argumentsOf (argv) {
  const options = { peers: [] }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[++i]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`)
    if (flag === '--blind-peer') options.peers.push(value)
    else if (flag === '--run') options.run = value
    else if (flag === '--subset') options.subset = value
    else if (flag === '--out') options.out = value
    else throw new Error(`Unknown option: ${flag}`)
  }
  if (!options.run || !/^[a-zA-Z0-9_-]+$/.test(options.run) || !options.subset || !options.peers.length) {
    throw new Error('Use --run <id> --subset <path> --blind-peer <key> [--blind-peer <key>] [--out <directory>]')
  }
  return options
}

function decodeKey (text) {
  const key = id.decode(text)
  if (key.length !== 32) throw new Error('Blind peer key must be 32 bytes')
  return key
}

export async function runOwner ({ argv = process.argv.slice(2), bootstrap } = {}) {
  const options = argumentsOf(argv)
  const seed = process.env.OWNER_SEED || ''
  if (!/^[0-9a-f]{64}$/i.test(seed)) throw new Error('OWNER_SEED must be a 32-byte hex seed')
  const subset = JSON.parse(await readFile(options.subset, 'utf8'))
  if (!/^[0-9a-f]{64}$/i.test(subset.channel) || !Array.isArray(subset.entries) || !Number.isFinite(subset.totalBytes) || subset.totalBytes < 0) throw new Error('Invalid subset')
  for (const entry of subset.entries) {
    if (!/^[0-9a-f]{64}$/i.test(entry.blobs) || !Number.isSafeInteger(entry.blockOffset) || entry.blockOffset < 0 ||
        !Number.isSafeInteger(entry.blockLength) || entry.blockLength <= 0 || !Number.isFinite(entry.size) || entry.size < 0) {
      throw new Error('Invalid subset entry')
    }
  }
  const peers = [...new Map(options.peers.map(text => {
    const key = decodeKey(text)
    return [key.toString('hex'), key]
  })).values()]
  const pair = DHT.keyPair(Buffer.from(seed, 'hex'))
  console.error(`Owner public key: ${pair.publicKey.toString('hex')}`)
  const outputDir = options.out || join('test', 'fargate', 'results', options.run)
  await mkdir(outputDir, { recursive: true })
  const output = createWriteStream(join(outputDir, 'owner.jsonl'), { flags: 'a' })
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache')
  const store = new Corestore(join(cache, 'peartube-fargate', options.run, 'owner-store'))
  const dht = bootstrap ? new DHT({ keyPair: pair, bootstrap }) : new DHT({ keyPair: pair })
  const wakeup = new Wakeup()
  const peering = new BlindPeering(dht, store, {
    blindPeers: peers.map(key => ({ key })),
    pick: peers.length,
    wakeup
  })
  const channel = { blobs: subset.channel, blockOffset: 0, blockLength: 0, size: 0, channel: true }
  const entries = [channel, ...subset.entries].map(entry => ({
    ...entry,
    core: store.get({ key: Buffer.from(entry.blobs, 'hex') })
  }))
  await Promise.all(entries.map(entry => entry.core.ready()))
  const connected = new Set()
  let closing = false

  function emit (peer, ev, remote, cores, haveBytes, detail = {}) {
    const line = JSON.stringify({
      v: 1, type: 'owner', run: options.run, ts: Date.now(), bp: peer.toString('hex'),
      ev, remote, cores, haveBytes, targetBytes: subset.totalBytes, detail
    })
    console.log(line)
    output.write(line + '\n')
  }

  function progress () {
    for (const peer of peers) {
      const hex = peer.toString('hex')
      const cores = {}
      let remote = null
      let haveBytes = 0
      let found = false
      for (const entry of entries) {
        const link = entry.core.peers.find(p => p.remotePublicKey?.equals(peer))
        if (!link) continue
        found = true
        const raw = link.stream?.rawStream
        if (raw?.remoteHost) remote = `${raw.remoteHost}:${raw.remotePort}`
        const contiguous = link.remoteContiguousLength || 0
        cores[entry.blobs.slice(0, 8)] = {
          length: entry.channel ? entry.core.length : entry.blockLength,
          remoteLength: link.remoteLength || 0,
          remoteContiguous: contiguous
        }
        if (!entry.channel) {
          const have = Math.min(entry.blockLength, Math.max(0, contiguous - entry.blockOffset))
          haveBytes += Math.round(have * entry.size / entry.blockLength)
        }
      }
      if (!found) {
        connected.delete(hex)
        continue
      }
      if (!connected.has(hex)) {
        connected.add(hex)
        emit(peer, 'connect', remote, cores, haveBytes)
      }
      emit(peer, 'progress', remote, cores, haveBytes)
    }
  }

  const timer = setInterval(progress, 10000)
  const close = async () => {
    if (closing) return
    closing = true
    clearInterval(timer)
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    await peering.close()
    await dht.destroy({ force: true })
    await store.close()
    await new Promise(resolve => output.end(resolve))
  }
  const onSignal = () => { close().catch(err => console.error(err.message)) }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  for (const entry of entries) {
    for (const peer of peers) {
      if (closing) return { close }
      try {
        await peering.addCore(entry.core, {
          target: peer, blindPeers: [{ key: peer }], announce: true,
          priority: entry.channel ? 1 : 0, pick: peers.length
        })
        emit(peer, 'added', null, {}, 0, { core: entry.blobs.slice(0, 8), channel: Boolean(entry.channel) })
      } catch (err) {
        emit(peer, 'error', null, {}, 0, { core: entry.blobs.slice(0, 8), message: err.message })
      }
    }
  }
  progress()
  return { close }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runOwner().catch(err => {
    console.error(err.message)
    process.exitCode = 1
  })
}
