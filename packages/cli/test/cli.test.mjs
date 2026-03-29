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

test('package.json defines standalone relay build scripts', async (t) => {
  const packageJsonPath = join(__dirname, '..', 'package.json')
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'))

  t.is(pkg.scripts['build:standalone'], 'node ./scripts/build-standalone.mjs')
  t.is(pkg.scripts['build:standalone:linux-x64'], 'RELAY_STANDALONE_HOST=linux-x64 node ./scripts/build-standalone.mjs')
  t.is(pkg.scripts['build:standalone:linux-arm64'], 'RELAY_STANDALONE_HOST=linux-arm64 node ./scripts/build-standalone.mjs')
  t.is(pkg.devDependencies['bare-build'], '^0.4.6')
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

test('Dockerfile packages the standalone relay executable in a minimal runtime image', async (t) => {
  const dockerfilePath = join(__dirname, '..', 'Dockerfile')
  const content = readFileSync(dockerfilePath, 'utf8')

  t.ok(content.includes('gcr.io/distroless/base-debian12'), 'final image uses a minimal distroless runtime')
  t.ok(content.includes('npm run build:standalone'), 'builder stage produces a standalone relay executable')
  t.ok(content.includes('COPY --from=builder'), 'final image copies the built artifact from the builder stage')
  t.ok(content.includes('ENTRYPOINT ["/peartube-relay"]'), 'final image runs the standalone relay executable directly')
})
