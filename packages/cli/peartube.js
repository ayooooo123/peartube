#!/usr/bin/env node

import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parsePeartubeArgv, PeartubeUsageError } from './src/add/argv.js'

export const PEARTUBE_USAGE = [
  'Usage: peartube <command> [options]',
  '',
  'Commands:',
  '  add [query-or-url]  Add content',
  '  search <query>      Find titles on the network',
  '  get <entity-or-publication>',
  '                      Retrieve a title to a local file',
  '  config              Configure content settings',
  '  help                Show this help',
  '',
  'Options:',
  '  --storage <path>    Content storage directory',
  '  --config <path>     Configuration file',
  '  --no-color          Disable color output',
  '  --json              Format the final result as JSON',
  '  --no-input          Never prompt for input',
  '  --yes               Accept review confirmation',
  '  --force             Retry a failed local source job',
  '  --output <path>     Destination file for get',
  '  --rendition <id>    Rendition to retrieve',
  '  --limit <n>         Maximum search results',
  '  --timeout <s>       Seconds to wait for the next block',
  '  -h, --help          Show this help'
].join('\n')

const defaultLoadModule = specifier => import(specifier)

function write(stream, text) {
  if (stream && typeof stream.write === 'function') {
    stream.write(text)
  }
}

function commandHandler(module, names) {
  for (const name of names) {
    if (typeof module?.[name] === 'function') return module[name]
  }
  if (typeof module?.default === 'function') return module.default
  throw new TypeError(`Command module must export ${names.join(' or ')}`)
}

function exitCodeFrom(value) {
  return Number.isInteger(value) ? value : 0
}

export async function runPeartube({
  argv = process.argv.slice(2),
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  parseArgv = parsePeartubeArgv,
  loadModule = defaultLoadModule
} = {}) {
  try {
    const parsed = parseArgv(argv, { stdin, stderr })

    if (parsed.command === 'help') {
      write(stdout, `${PEARTUBE_USAGE}\n`)
      return 0
    }

    const context = {
      ...parsed,
      argv: [...argv],
      stdin,
      stdout,
      stderr,
      env
    }

    if (parsed.command === 'add') {
      const module = await loadModule('./src/add/index.js')
      const handler = commandHandler(module, ['runAddCommand'])
      return exitCodeFrom(await handler(context))
    }

    if (parsed.command === 'search') {
      const module = await loadModule('./src/network/query.js')
      const handler = commandHandler(module, ['runSearchCommand'])
      return exitCodeFrom(await handler(context))
    }

    if (parsed.command === 'get') {
      const module = await loadModule('./src/network/fetch.js')
      const handler = commandHandler(module, ['runGetCommand'])
      return exitCodeFrom(await handler(context))
    }

    if (parsed.command === 'config') {
      const module = await loadModule('./src/add/config-command.js')
      const handler = commandHandler(module, ['runContentConfigCommand', 'runConfigCommand'])
      return exitCodeFrom(await handler(context))
    }

    throw new PeartubeUsageError(`Unknown command "${parsed.command}"`)
  } catch (error) {
    write(stderr, `${error?.message || String(error)}\n`)
    return error instanceof PeartubeUsageError || error?.exitCode === 2 ? 2 : 1
  }
}

function isDirectInvocation() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isDirectInvocation()) {
  const code = await runPeartube()
  // The result line is already written; exit promptly so late backend
  // diagnostics (DHT/shutdown) can never leak past the --json stdout line.
  await new Promise((resolve) => {
    if (process.stdout.writableLength === 0) return resolve()
    process.stdout.write('', resolve)
  })
  process.exit(code)
}
