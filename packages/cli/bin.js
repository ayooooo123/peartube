#!/usr/bin/env node
import { existsSync, writeFileSync } from '#fs'
import process from '#process'
import { normalizeCliArgv, parseArgv } from './src/argv.js'
import { DEFAULT_RELAY_CONFIG, RELAY_COMMAND, RELAY_COMPAT_COMMAND } from './src/constants.js'
import { loadRelayConfig, renderExampleConfig } from './src/config.js'
import { RelayCatalog } from './src/catalog.js'
import { RelayCreators, summarizeCreatorsFromCatalog, rankUnseededTargets } from './src/creators.js'
import { TrustedClients } from './src/trusted-clients.js'
import { buildRelayStatus, formatRelayStatus, readRelayStatus } from './src/status.js'

function writeLine(message, preferredStream = 'stdout') {
  const text = typeof message === 'string' ? message : String(message)
  const streams = preferredStream === 'stderr'
    ? [process?.stderr, process?.stdout]
    : [process?.stdout, process?.stderr]

  for (const stream of streams) {
    if (stream && typeof stream.write === 'function') {
      stream.write(text)
      return
    }
  }

  if (preferredStream === 'stderr' && typeof console?.error === 'function') {
    console.error(text.replace(/\n$/, ''))
    return
  }

  if (typeof console?.log === 'function') {
    console.log(text.replace(/\n$/, ''))
  }
}

function printHelp() {
  writeLine([
    `${RELAY_COMMAND} <command> [options]`,
    '',
    'Commands:',
    '  run       Run the relay service',
    '  ui       Run the relay archive WebUI',
    '  archive  Queue or run anonymous YouTube archive jobs',
    '  mirror-local  Import local video files into the relay channel',
    '  validate  Validate and print the normalized relay config',
    '  status    Print relay status from the local catalog',
    '  creators  List tracked creators and unseeded targets',
    '  clients   List authorized creator client devices',
    '  authorize Authorize a creator device key (--key)',
    '  revoke    Revoke a creator device key (--key)',
    '  link      Print this relay\'s link descriptor (mirror key)',
    '  init      Write an example config file',
    '',
    'Options:',
    '  --config, -c <path>',
    '  --mode <private|public>',
    '  --policy <allowlist|discovery>',
    '  --storage, -s <path>',
    '  --max-bytes <n>',
    '  --max-storage <mb>',
    '  --max-direct-download-bytes <n>  (per-download ceiling for url seeds)',
    '  --channel <key>',
    '  --owner <key>',
    '  --key <device-key-hex>',
    '  --label <name>',
    '  --url <youtube-url>',
    '  --path <local-directory>',
    '  --local-mirror-path <local-directory>',
    '  --local-mirror-poll <seconds>',
    '  --local-mirror-channel-name <name>',
    '  --max-files <n>',
    '  --channel-name <name>',
    '  --title <title>',
    '  --description <text>',
    '  --host <host>',
    '  --port <port>',
    '  --api-open  (open /api/v1 catalog and stream when bound off loopback)',
    '  --no-reseed  (stop taking new archive pledges and stop asking peers to mirror)',
    '  --run-now',
    '  --debug, -d',
    '  --json',
    ''
  ].join('\n'))
}

async function runCommand(flags) {
  const config = await loadRelayConfig(flags)
  const { startRelay } = await import('./src/index.js')
  const goodbyeModule = await import('graceful-goodbye').catch(() => null)
  const goodbye = goodbyeModule?.default || (() => {})
  const relay = await startRelay({ config })

  let shuttingDown = false
  const closeRelay = async (signal = 'unknown') => {
    if (shuttingDown) return
    shuttingDown = true
    try {
      writeLine(`[relay] shutting down on ${signal}\n`)
      await relay.close()
    } catch (err) {
      writeLine(`[relay] shutdown failed: ${err?.message || String(err)}\n`, 'stderr')
    }
  }

  goodbye(async () => {
    await closeRelay('graceful-goodbye')
  })

  // Standalone containers can stop/start without invoking graceful-goodbye in time.
  // Install explicit signal handlers so Corestore/RocksDB closes cleanly before exit.
  if (typeof process?.on === 'function') {
    process.on('SIGTERM', async () => {
      await closeRelay('SIGTERM')
      process.exit?.(0)
    })
    process.on('SIGINT', async () => {
      await closeRelay('SIGINT')
      process.exit?.(0)
    })
    // Keep process alive for daemon workloads; explicit SIGTERM/SIGINT handles graceful shutdown.
  }
}

async function uiCommand(flags) {
  // Only what the operator actually typed may override the file. Passing the
  // fallback in as a CLI value outranked the config file it was meant to fall
  // back to, so `--config` could not set the UI host or port at all: every
  // relay started from a file bound 0.0.0.0:8174, and a second one on the same
  // machine died with EADDRINUSE while its own file named a free port.
  const archiveOverrides = { uiEnabled: true }
  if (flags.host) archiveOverrides.uiHost = flags.host
  // 0 is a real port here - it means "any free one" - so presence decides.
  if (flags.port !== undefined && flags.port !== null && flags.port !== '') {
    archiveOverrides.uiPort = Number(flags.port)
  }
  const config = await loadRelayConfig({ ...flags, archive: archiveOverrides })
  config.archive.uiEnabled = true
  config.archive.uiHost = config.archive.uiHost || '0.0.0.0'
  const resolvedPort = Number(config.archive.uiPort)
  config.archive.uiPort = Number.isSafeInteger(resolvedPort) && resolvedPort >= 0 ? resolvedPort : 8174
  // Intent, not fact: the bind happens inside startRelay. Printing it as though
  // the port were already open is what made a relay that never bound look like
  // one that had.
  writeLine(`[relay] starting archive WebUI on ${config.archive.uiHost}:${config.archive.uiPort}\n`)
  await runCommand({ ...flags, archive: config.archive })
}

async function archiveCommand(flags) {
  if (!flags.url) throw new Error('--url is required')
  const config = await loadRelayConfig(flags)
  const { startRelay } = await import('./src/index.js')
  const relay = await startRelay({ config })
  try {
    const job = await relay.enqueueArchiveJob({
      url: flags.url,
      channelName: flags.channelName || 'Anonymous Archive',
      title: flags.title || '',
      description: flags.description || '',
      publish: true,
      anonymous: true
    }, { runNow: Boolean(flags.runNow) })
    writeLine(JSON.stringify(job, null, 2) + '\n')
  } finally {
    await relay.close()
  }
}

async function mirrorLocalCommand(flags) {
  if (!flags.path) throw new Error('--path is required')
  const config = await loadRelayConfig(flags)
  const { startRelay } = await import('./src/index.js')
  const relay = await startRelay({ config })
  try {
    const result = await relay.mirrorLocalDrive({
      path: flags.path,
      channelName: flags.channelName || flags.title || 'Local Drive Mirror',
      description: flags.description || '',
      recursive: flags.recursive !== false,
      maxFiles: flags.maxFiles
    })
    writeLine(JSON.stringify(result, null, 2) + '\n')
  } finally {
    await relay.close()
  }
}

async function validateCommand(flags) {
  const config = await loadRelayConfig(flags)
  const output = JSON.stringify(config, null, 2)
  writeLine(output + '\n')
}

async function statusCommand(flags) {
  const config = await loadRelayConfig(flags)
  const status = readRelayStatus(config.paths.status) || buildRelayStatus({
    config,
    catalog: await RelayCatalog.open({ storagePath: config.storage.path, catalogPath: config.paths.catalog })
  })

  if (flags.json) {
    writeLine(JSON.stringify(status, null, 2) + '\n')
    return
  }

  writeLine(formatRelayStatus(status) + '\n')
}

async function creatorsCommand(flags) {
  const config = await loadRelayConfig(flags)
  const creatorsDb = await RelayCreators.open({ storagePath: config.storage.path, creatorsPath: config.paths.creators })
  let creators = creatorsDb.getCreators()

  // Fall back to deriving from the catalog when the persisted creators DB is
  // empty (e.g. the relay has not run since this feature was added).
  if (creators.length === 0) {
    const catalog = await RelayCatalog.open({ storagePath: config.storage.path, catalogPath: config.paths.catalog })
    creators = summarizeCreatorsFromCatalog(catalog.getChannels())
  }

  const targets = rankUnseededTargets(creators)

  if (flags.json) {
    writeLine(JSON.stringify({ creators, unseededTargets: targets }, null, 2) + '\n')
    return
  }

  if (creators.length === 0) {
    writeLine('No creators tracked yet.\n')
    return
  }

  const lines = ['Tracked creators:']
  for (const creator of [...creators].sort((a, b) => (b.videosUnseeded || 0) - (a.videosUnseeded || 0))) {
    const cls = creator.classification || {}
    lines.push(`- ${creator.name || creator.creatorId} | archived=${creator.videosArchived || 0} unseeded=${creator.videosUnseeded || 0} movies=${cls.movie || 0} tv=${cls.tv || 0}`)
  }
  if (targets.length > 0) {
    lines.push('', 'Unseeded targets (seed these first):')
    for (const target of targets.slice(0, 20)) {
      lines.push(`- ${target.name} (${target.videosUnseeded}/${target.videosArchived} unseeded)`)
    }
  }
  writeLine(lines.join('\n') + '\n')
}

async function clientsCommand(flags) {
  const config = await loadRelayConfig(flags)
  const trusted = await TrustedClients.open({ storagePath: config.storage.path, trustedClientsPath: config.paths.trustedClients })
  const clients = trusted.list()

  if (flags.json) {
    writeLine(JSON.stringify({ clients }, null, 2) + '\n')
    return
  }
  if (clients.length === 0) {
    writeLine('No trusted client devices authorized.\n')
    return
  }
  const lines = ['Authorized client devices:']
  for (const client of clients) {
    lines.push(`- ${client.label || 'Device'}  ${client.key}`)
  }
  writeLine(lines.join('\n') + '\n')
}

async function authorizeCommand(flags) {
  if (!flags.key) throw new Error('--key is required')
  const config = await loadRelayConfig(flags)
  const trusted = await TrustedClients.open({ storagePath: config.storage.path, trustedClientsPath: config.paths.trustedClients })
  const record = await trusted.add({ key: flags.key, label: flags.label || null })
  writeLine(`Authorized client device ${record.key}${record.label ? ` (${record.label})` : ''}.\n`)
  writeLine('Takes effect when the relay next starts.\n')
}

async function revokeCommand(flags) {
  if (!flags.key) throw new Error('--key is required')
  const config = await loadRelayConfig(flags)
  const trusted = await TrustedClients.open({ storagePath: config.storage.path, trustedClientsPath: config.paths.trustedClients })
  const removed = await trusted.remove(flags.key)
  writeLine(removed ? `Revoked client device ${flags.key}.\n` : `No authorized client device matched ${flags.key}.\n`)
}

async function linkCommand(flags) {
  const config = await loadRelayConfig(flags)
  const status = readRelayStatus(config.paths.status)
  const relayMirrorKey = status?.runtime?.blindPeer?.publicKey || null
  const descriptor = {
    schema: 'peartube.relayLink',
    version: 1,
    relayMirrorKey,
    blindPeerEnabled: Boolean(status?.runtime?.blindPeer?.enabled),
    trustedClients: status?.runtime?.trustedClients || 0
  }

  if (flags.json) {
    writeLine(JSON.stringify(descriptor, null, 2) + '\n')
    return
  }
  if (!relayMirrorKey) {
    writeLine('Relay mirror key not available yet. Start the relay (with the blind peer enabled) first.\n')
    return
  }
  writeLine([
    'Relay link descriptor:',
    `  mirror key: ${relayMirrorKey}`,
    `  trusted client devices: ${descriptor.trustedClients}`,
    '',
    "Creators' apps adopt this mirror key automatically over the P2P feed.",
    'To guarantee a creator a peer, authorize their device key:',
    '  peartube-relay authorize --key <device-key>'
  ].join('\n') + '\n')
}

async function initCommand(flags) {
  const target = flags.config || 'peartube-relay.yml'
  if (existsSync(target)) {
    throw new Error(`Config already exists at ${target}`)
  }

  writeFileSync(target, renderExampleConfig(DEFAULT_RELAY_CONFIG))
  writeLine(`Wrote ${target}\n`)
}

async function main() {
  const { command, flags } = parseArgv(normalizeCliArgv(process.argv))

  if (flags.help) {
    printHelp()
    return
  }

  switch (command) {
    case 'run':
      await runCommand(flags)
      break
    case 'ui':
      await uiCommand(flags)
      break
    case 'archive':
      await archiveCommand(flags)
      break
    case 'mirror-local':
      await mirrorLocalCommand(flags)
      break
    case 'validate':
      await validateCommand(flags)
      break
    case 'status':
      await statusCommand(flags)
      break
    case 'creators':
      await creatorsCommand(flags)
      break
    case 'clients':
      await clientsCommand(flags)
      break
    case 'authorize':
      await authorizeCommand(flags)
      break
    case 'revoke':
      await revokeCommand(flags)
      break
    case 'link':
      await linkCommand(flags)
      break
    case 'init':
      await initCommand(flags)
      break
    default:
      if (command === RELAY_COMMAND || command === RELAY_COMPAT_COMMAND) {
        printHelp()
        return
      }
      throw new Error(`Unknown command ${command}`)
  }
}

main().catch((err) => {
  writeLine((err?.stack || err?.message || String(err)) + '\n', 'stderr')
  if ('exitCode' in process) {
    process.exitCode = 1
    return
  }
  process.exit(1)
})
