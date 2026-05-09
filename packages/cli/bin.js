#!/usr/bin/env node
import { existsSync, writeFileSync } from '#fs'
import process from '#process'
import { normalizeCliArgv, parseArgv } from './src/argv.js'
import { DEFAULT_RELAY_CONFIG, RELAY_COMMAND, RELAY_COMPAT_COMMAND } from './src/constants.js'
import { loadRelayConfig, renderExampleConfig } from './src/config.js'
import { RelayCatalog } from './src/catalog.js'
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
    '  --url <youtube-url>',
    '  --path <local-directory>',
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
