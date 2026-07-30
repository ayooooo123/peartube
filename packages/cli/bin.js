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
import { LibraryInventory } from './src/library-inventory.js'

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
    '  library <action>  Manage the home media library (status | scan | confirm <folder> | unseed <target> | verify)',
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
    process.on('beforeExit', async () => {
      await closeRelay('beforeExit')
    })
  }
}

async function uiCommand(flags) {
  const config = await loadRelayConfig({ ...flags, archive: { uiEnabled: true, uiHost: flags.host || '0.0.0.0', uiPort: Number(flags.port || 8174) } })
  config.archive.uiEnabled = true
  config.archive.uiHost = flags.host || config.archive.uiHost || '0.0.0.0'
  config.archive.uiPort = Number(flags.port || config.archive.uiPort || 8174)
  writeLine(`[relay] archive WebUI listening on ${config.archive.uiHost}:${config.archive.uiPort}\n`)
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


async function libraryCommand(flags) {
  const action = flags.action || 'status'
  const config = await loadRelayConfig(flags)

  if (action === 'status') {
    const status = readRelayStatus(config.paths.status)
    const library = status?.library || null
    if (flags.json) {
      writeLine(JSON.stringify(library, null, 2) + '\n')
      return
    }
    if (!library) {
      writeLine('No library status recorded yet. Enable library in config and run the relay (or `library scan`).\n')
      return
    }
    const items = library.items || {}
    writeLine([
      `enabled: ${library.enabled}`,
      `folders: ${library.folders}`,
      `items: ${library.totalItems ?? 0} (${Object.entries(items).filter(([, count]) => count > 0).map(([state, count]) => `${state}=${count}`).join(' ') || 'none'})`,
      `bytes: ${library.bytes ?? 0}${library.capBytes ? `/${library.capBytes}` : ''}`,
      `importsPaused: ${Boolean(library.importsPaused)}${library.importsPausedReason ? ` (${library.importsPausedReason})` : ''}`,
      `hiverelay: ${library.hiverelay?.endpoint || 'disabled'}`,
      ...(library.awaitingPublicConfirmation?.length
        ? ['awaitingPublicConfirmation:', ...library.awaitingPublicConfirmation.map((path) => `- ${path}`)]
        : [])
    ].join('\n') + '\n')
    return
  }

  if (action === 'confirm') {
    if (!flags.target) throw new Error('library confirm requires a folder path')
    const inventory = await LibraryInventory.open({ inventoryPath: config.paths.libraryInventory })
    const confirmed = await inventory.confirmFolder(flags.target)
    writeLine(JSON.stringify({ confirmed }, null, 2) + '\n')
    return
  }

  if (action === 'scan' || action === 'unseed' || action === 'verify') {
    if (action === 'unseed' && !flags.target) throw new Error('library unseed requires a videoId, channelKey, or folder path')
    const { startRelay } = await import('./src/index.js')
    const relay = await startRelay({ config })
    try {
      const result = action === 'scan'
        ? await relay.libraryScanOnce()
        : action === 'unseed'
          ? await relay.libraryUnseed(flags.target)
          : await relay.libraryReconcile()
      const output = flags.json || action !== 'verify' ? result : relay.getLibraryStatus()
      writeLine(JSON.stringify(output, null, 2) + '\n')
    } finally {
      await relay.close()
    }
    return
  }

  throw new Error(`Unknown library action "${action}" (expected status | scan | confirm | unseed | verify)`)
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
    case 'library':
      await libraryCommand(flags)
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
