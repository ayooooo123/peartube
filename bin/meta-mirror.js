#!/usr/bin/env node
import { createReadStream } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { createNode } from '../src/index.js'
import { CINEMETA_URL } from '../src/art.js'
import { createMetaMirror } from '../src/meta-mirror.js'

const VALUE_FLAGS = {
  '--storage': 'storage',
  '--alias': 'alias',
  '--channel': 'channel',
  '--cinemeta': 'cinemeta'
}

function parseArgs (argv) {
  const command = argv[0] || ''
  const positional = []
  const flags = {
    storage: './peartube-meta-seeder',
    alias: '',
    channel: '',
    cinemeta: CINEMETA_URL,
    allowPrivate: false
  }
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (Object.hasOwn(VALUE_FLAGS, arg)) {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`)
      flags[VALUE_FLAGS[arg]] = argv[++i]
    } else if (arg === '--allow-private') {
      flags.allowPrivate = true
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`)
    } else {
      positional.push(arg)
    }
  }
  return { command, positional, flags }
}

function usage () {
  console.error([
    'Usage: peartube-meta-mirror <command> [args] [options]',
    '  create [--storage <dir>] [--alias <name>]',
    '  ingest-jsonl <file> --channel <key> [--storage <dir>] [--allow-private]',
    '  mirror-imdb <tt1> [tt2...] --channel <key> [--storage <dir>] [--cinemeta <url>] [--allow-private]',
    '  rebuild-snapshot --channel <key> [--storage <dir>]'
  ].join('\n'))
}

async function * readJsonlRecords (filePath) {
  const rl = createInterface({ input: createReadStream(filePath, 'utf8'), crlfDelay: Infinity })
  let lineNo = 0
  for await (const raw of rl) {
    lineNo++
    const line = raw.trim()
    if (!line) continue
    try {
      yield JSON.parse(line)
    } catch (err) {
      throw new Error(`Invalid JSON at ${filePath}:${lineNo}: ${err.message}`)
    }
  }
}

async function runCommand ({ command, positional, flags }, node) {
  if (command === 'create') {
    const ch = await node.meta.createChannel({ alias: flags.alias, seedFull: true })
    return { key: ch.key, uri: ch.uri, writerKey: ch.writerKey }
  }
  if (!flags.channel) throw new Error('--channel <key> is required')
  const src = await node.meta.addSource(flags.channel, { seedFull: true })
  const mirror = createMetaMirror({
    node,
    metaKey: src.key,
    cinemetaUrl: flags.cinemeta,
    allowPrivate: flags.allowPrivate
  })
  if (command === 'ingest-jsonl') {
    if (!positional[0]) throw new Error('ingest-jsonl requires a <file> path')
    const ingested = await mirror.ingestRecords(readJsonlRecords(resolve(positional[0])))
    const snapshot = await mirror.rebuildSnapshot()
    return { channel: src.key, ingested, snapshot }
  }
  if (command === 'mirror-imdb') {
    if (positional.length === 0) throw new Error('mirror-imdb requires at least one IMDb ID')
    const mirrored = []
    const errors = []
    for (const imdbId of positional) {
      try {
        const res = await mirror.mirrorCinemetaTitle(imdbId)
        mirrored.push({ id: res.id, title: res.card?.title || '', artAdded: res.artAdded || 0, artDeduped: res.artDeduped || 0 })
      } catch (err) {
        errors.push({ id: imdbId, error: err?.message || String(err) })
      }
    }
    const snapshot = mirrored.length > 0 ? await mirror.rebuildSnapshot() : null
    if (mirrored.length === 0 && errors.length > 0) process.exitCode = 1
    return { channel: src.key, mirrored, errors, snapshot }
  }
  if (command === 'rebuild-snapshot') {
    const snapshot = await mirror.rebuildSnapshot()
    return { channel: src.key, ...snapshot }
  }
  throw new Error(`Unknown command: ${command}`)
}

async function main () {
  const parsed = parseArgs(process.argv.slice(2))
  if (!parsed.command || parsed.command === '--help' || parsed.command === '-h') {
    usage()
    process.exit(parsed.command ? 0 : 2)
  }
  const node = await createNode({
    storage: resolve(parsed.flags.storage),
    seedFullMetadata: true
  })
  let runError = null
  let closeError = null
  let output = null
  try {
    output = await runCommand(parsed, node)
  } catch (err) {
    runError = err
  }
  try {
    await node.close()
  } catch (err) {
    closeError = err
  }
  if (runError) {
    console.error(runError?.message || String(runError))
    if (closeError) console.error(`Close failed: ${closeError?.message || String(closeError)}`)
    process.exit(1)
  }
  if (closeError) {
    console.error(`Close failed: ${closeError?.message || String(closeError)}`)
    process.exit(1)
  }
  console.log(JSON.stringify(output, null, 2))
}

main().catch(err => {
  console.error(err?.message || String(err))
  process.exit(1)
})
