#!/usr/bin/env node
import { existsSync, writeFileSync } from '#fs'
import process from '#process'
import { normalizeCliArgv, parseArgv } from './src/argv.js'
import { DEFAULT_RELAY_CONFIG, RELAY_COMMAND, RELAY_COMPAT_COMMAND } from './src/constants.js'
import { loadRelayConfig, renderExampleConfig } from './src/config.js'
import { AlertStore } from './src/alerts.js'
import { RelayCatalog } from './src/catalog.js'
import { ModerationRuleStore } from './src/moderation-store.js'
import { buildRelayStatus, formatRelayStatus, readRelayStatus, withRelayAlerts } from './src/status.js'

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
    '  moderation  Add, remove, or list local moderation rules',
    '  alerts    List or acknowledge operator alerts',
    '  validate  Validate and print the normalized relay config',
    '  status    Print relay status from the local catalog',
    '  init      Write an example config file',
    '',
    'Options:',
    '  --config, -c <path>',
    '  --roles <roles>',
    '  --mode <private|public>',
    '  --policy <allowlist|discovery>',
    '  --add --action <action> --target-type <type> --target <value>',
    '  --remove <rule-id>',
    '  --ack <alert-id>',
    '  --reason <text>',
    '  --storage, -s <path>',
    '  --max-bytes <n>',
    '  --max-storage <mb>',
    '  --channel <key>',
    '  --owner <key>',
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
  const alertStore = await AlertStore.open({ storagePath: config.storage.path, alertsPath: config.paths.alerts })
  const alerts = alertStore.getAlerts({ limit: Infinity })
  const persistedStatus = readRelayStatus(config.paths.status)
  const status = persistedStatus ? withRelayAlerts(persistedStatus, alerts) : buildRelayStatus({
    config,
    catalog: await RelayCatalog.open({ storagePath: config.storage.path, catalogPath: config.paths.catalog }),
    alerts
  })

  if (flags.json) {
    writeLine(JSON.stringify(status, null, 2) + '\n')
    return
  }

  writeLine(formatRelayStatus(status) + '\n')
}

async function alertsCommand(flags) {
  const config = await loadRelayConfig(flags)
  const store = await AlertStore.open({
    storagePath: config.storage.path,
    alertsPath: config.paths.alerts
  })

  if (flags.ack) {
    const acknowledged = await store.acknowledgeAlert(flags.ack)
    if (flags.json) {
      writeLine(JSON.stringify({ acknowledged }, null, 2) + '\n')
      return
    }
    writeLine(acknowledged ? `acknowledged ${acknowledged.id}\n` : `no alert found for ${flags.ack}\n`)
    return
  }

  const alerts = store.getAlerts()
  if (flags.json) {
    writeLine(JSON.stringify({ alerts, summary: store.getSummary() }, null, 2) + '\n')
    return
  }

  if (!alerts.length) {
    writeLine('No active alerts.\n')
    return
  }

  writeLine(alerts.map((alert) => `${alert.id} ${alert.severity} ${alert.category} ${alert.targetType}:${alert.target} ${alert.summary}`).join('\n') + '\n')
}

async function moderationCommand(flags) {
  const config = await loadRelayConfig(flags)
  const store = await ModerationRuleStore.open({
    storagePath: config.storage.path,
    moderationPath: config.paths.moderation
  })

  if (flags.add) {
    const rule = await store.addRule({
      action: flags.action,
      targetType: flags.targetType,
      target: flags.target,
      reason: flags.reason
    })
    if (flags.json) {
      writeLine(JSON.stringify({ rule }, null, 2) + '\n')
      return
    }
    writeLine(`added ${rule.id} ${rule.action} ${rule.targetType}:${rule.target}\n`)
    return
  }

  if (flags.remove) {
    const removed = await store.removeRule(flags.remove)
    if (flags.json) {
      writeLine(JSON.stringify({ removed }, null, 2) + '\n')
      return
    }
    writeLine(removed ? `removed ${removed.id}\n` : `no rule found for ${flags.remove}\n`)
    return
  }

  const rules = store.getRules()
  if (flags.json) {
    writeLine(JSON.stringify({ rules }, null, 2) + '\n')
    return
  }

  if (!rules.length) {
    writeLine('No local moderation rules.\n')
    return
  }

  writeLine(rules.map((rule) => `${rule.id} ${rule.action} ${rule.targetType}:${rule.target}${rule.reason ? ` ${rule.reason}` : ''}`).join('\n') + '\n')
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
    case 'moderation':
      await moderationCommand(flags)
      break
    case 'alerts':
      await alertsCommand(flags)
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
