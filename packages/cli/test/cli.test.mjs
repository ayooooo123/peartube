import test from 'brittle'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

test('package.json exports peartube-relay and compatibility aliases', async (t) => {
  const packageJsonPath = join(__dirname, '..', 'package.json')
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'))

  t.is(pkg.bin['peartube-relay'], 'bin.js')
  t.is(pkg.bin['peartube-peer'], 'bin.js')
  t.is(pkg.bin['peartube-relay-bare'], 'bare-bin.js')
  t.is(pkg.bin['peartube-peer-bare'], 'bare-bin.js')
  t.alike(pkg.imports['#process'], {
    bare: './src/shims/process.bare.js',
    default: './src/shims/process.node.js'
  })
})

test('bin.js exposes relay subcommands', async (t) => {
  const binPath = join(__dirname, '..', 'bin.js')
  const content = readFileSync(binPath, 'utf8')

  t.ok(content.includes('peartube-relay'), 'canonical relay command name is present')
  t.ok(content.includes('run'), 'run subcommand is present')
  t.ok(content.includes('validate'), 'validate subcommand is present')
  t.ok(content.includes('status'), 'status subcommand is present')
  t.ok(content.includes('init'), 'init subcommand is present')
  t.ok(content.includes("import process from '#process'"), 'bin.js uses the runtime process shim')
})

test('config and logger use the runtime process shim', async (t) => {
  const configPath = join(__dirname, '..', 'src', 'config.js')
  const loggerPath = join(__dirname, '..', 'src', 'cli-logger.js')
  const configContent = readFileSync(configPath, 'utf8')
  const loggerContent = readFileSync(loggerPath, 'utf8')

  t.ok(configContent.includes("import process from '#process'"), 'config.js uses the runtime process shim')
  t.ok(loggerContent.includes("import process from '#process'"), 'cli-logger.js uses the runtime process shim')
})
