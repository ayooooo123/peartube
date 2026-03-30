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

  goodbye(async () => {
    await relay.close()
  })
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
