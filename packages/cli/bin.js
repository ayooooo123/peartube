#!/usr/bin/env node
import { existsSync, writeFileSync } from '#fs'
import { DEFAULT_RELAY_CONFIG, RELAY_COMMAND, RELAY_COMPAT_COMMAND } from './src/constants.js'
import { loadRelayConfig, renderExampleConfig } from './src/config.js'
import { RelayCatalog } from './src/catalog.js'
import { buildRelayStatus, formatRelayStatus, readRelayStatus } from './src/status.js'

function printHelp() {
  process.stdout.write([
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

function pushFlag(target, key, value) {
  if (target[key] === undefined) {
    target[key] = value
    return
  }

  if (Array.isArray(target[key])) {
    target[key].push(value)
    return
  }

  target[key] = [target[key], value]
}

function parseArgv(argv) {
  const args = [...argv]
  let command = 'run'

  if (args[0] && !args[0].startsWith('-')) {
    command = args.shift()
  }

  const flags = {}

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]

    if (arg === '--help' || arg === '-h') {
      flags.help = true
      continue
    }

    if (arg === '--debug' || arg === '-d') {
      flags.debug = true
      continue
    }

    if (arg === '--json') {
      flags.json = true
      continue
    }

    const next = args[i + 1]
    const consumeValue = () => {
      if (next === undefined) {
        throw new Error(`Missing value for ${arg}`)
      }
      i += 1
      return next
    }

    if (arg === '--config' || arg === '-c') {
      flags.config = consumeValue()
      continue
    }

    if (arg === '--mode') {
      flags.mode = consumeValue()
      continue
    }

    if (arg === '--policy') {
      flags.policy = consumeValue()
      continue
    }

    if (arg === '--storage' || arg === '-s') {
      flags.storage = consumeValue()
      continue
    }

    if (arg === '--max-bytes') {
      flags.maxBytes = consumeValue()
      continue
    }

    if (arg === '--max-storage' || arg === '-m') {
      flags.maxStorage = consumeValue()
      continue
    }

    if (arg === '--channel') {
      pushFlag(flags, 'channel', consumeValue())
      continue
    }

    if (arg === '--owner') {
      pushFlag(flags, 'owner', consumeValue())
      continue
    }

    throw new Error(`Unknown argument ${arg}`)
  }

  return { command, flags }
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
  process.stdout.write(output + '\n')
}

async function statusCommand(flags) {
  const config = await loadRelayConfig(flags)
  const status = readRelayStatus(config.paths.status) || buildRelayStatus({
    config,
    catalog: await RelayCatalog.open({ storagePath: config.storage.path, catalogPath: config.paths.catalog })
  })

  if (flags.json) {
    process.stdout.write(JSON.stringify(status, null, 2) + '\n')
    return
  }

  process.stdout.write(formatRelayStatus(status) + '\n')
}

async function initCommand(flags) {
  const target = flags.config || 'peartube-relay.yml'
  if (existsSync(target)) {
    throw new Error(`Config already exists at ${target}`)
  }

  writeFileSync(target, renderExampleConfig(DEFAULT_RELAY_CONFIG))
  process.stdout.write(`Wrote ${target}\n`)
}

async function main() {
  const { command, flags } = parseArgv(process.argv.slice(2))

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
  process.stderr.write((err?.stack || err?.message || String(err)) + '\n')
  process.exit(1)
})
