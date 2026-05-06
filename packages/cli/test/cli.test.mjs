import test from 'brittle'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { normalizeCliArgv, parseArgv } from '../src/argv.js'

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

test('argv normalization supports both node-style and standalone bare-style argv', async (t) => {
  t.alike(
    normalizeCliArgv(['/usr/local/bin/node', '/app/packages/cli/bin.js', 'status', '--json']),
    ['status', '--json']
  )

  t.alike(
    normalizeCliArgv(['/peartube-relay', 'status', '--json']),
    ['status', '--json']
  )

  t.alike(
    normalizeCliArgv(['status', '--json']),
    ['status', '--json']
  )
})

test('parseArgv keeps standalone bare commands instead of defaulting to run', async (t) => {
  const parsed = parseArgv(normalizeCliArgv(['/peartube-relay', '--help']))
  t.is(parsed.command, 'run')
  t.is(parsed.flags.help, true)

  const statusParsed = parseArgv(normalizeCliArgv(['/peartube-relay', 'status', '--json']))
  t.is(statusParsed.command, 'status')
  t.is(statusParsed.flags.json, true)
})

test('package.json defines standalone relay build scripts', async (t) => {
  const packageJsonPath = join(__dirname, '..', 'package.json')
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'))

  t.is(pkg.scripts['test'], 'brittle test/admission.test.mjs test/archive-ui.test.mjs test/cli.test.mjs test/config.test.mjs test/relay-seeding.test.mjs test/service.test.mjs test/status.test.mjs')
  t.is(pkg.imports['#subprocess'].bare, './src/shims/subprocess.bare.js')
  t.is(pkg.imports['#subprocess'].default, './src/shims/subprocess.node.js')
  t.is(pkg.imports['#http'].bare, './src/shims/http.bare.js')
  t.is(pkg.imports['#http'].default, './src/shims/http.node.js')
  t.is(pkg.dependencies['bare-subprocess'], '^6.0.0')
  t.is(pkg.dependencies['bare-http1'], '^4.5.6')
  t.is(pkg.scripts['build:standalone'], 'node ./scripts/build-standalone.mjs')
  t.is(pkg.scripts['build:standalone:linux-x64'], 'RELAY_STANDALONE_HOST=linux-x64 node ./scripts/build-standalone.mjs')
  t.is(pkg.scripts['build:standalone:linux-arm64'], 'RELAY_STANDALONE_HOST=linux-arm64 node ./scripts/build-standalone.mjs')
  t.is(pkg.scripts['prepare:docker-artifacts'], 'node ./scripts/prepare-docker-artifacts.mjs')
  t.is(pkg.devDependencies['bare-build'], '^0.5.3')
})

test('standalone build script writes the relay executable into the host output directory', async (t) => {
  const scriptPath = join(__dirname, '..', 'scripts', 'build-standalone.mjs')
  const content = readFileSync(scriptPath, 'utf8')

  t.ok(content.includes("const outputDir = join(packageRoot, 'dist', 'standalone', host)"), 'standalone outputs are grouped by host directory')
  t.ok(content.includes("const outputPath = join(outputDir, 'peartube-relay')"), 'standalone build verifies the final executable path')
  t.ok(content.includes('out: outputDir'), 'bare-build writes into the host directory instead of nesting under the executable path')
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

  t.ok(content.includes('FROM busybox:1.36.1 AS artifact'), 'artifact stage selects the prebuilt standalone relay binary')
  t.ok(content.includes('FROM debian:12-slim AS runtime-libs'), 'runtime libs stage installs missing shared libraries for native addons')
  t.ok(content.includes('ARG YT_DLP_VERSION='), 'Dockerfile pins the yt-dlp release version as a build arg')
  t.ok(content.includes('ca-certificates curl libatomic1'), 'runtime libs stage installs curl and CA roots to download yt-dlp')
  t.ok(content.includes('https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp'), 'runtime libs stage downloads the pinned yt-dlp release')
  t.ok(content.includes('chmod 755 /usr/local/bin/yt-dlp'), 'runtime libs stage makes yt-dlp executable')
  t.ok(content.includes('COPY packages/cli/dist/docker/ /dist/'), 'builder stage only packages prebuilt docker artifacts')
  t.ok(content.includes('cp /dist/linux-amd64/peartube-relay /peartube-relay'), 'artifact stage maps Docker amd64 to the prepared standalone binary')
  t.ok(content.includes('cp /dist/linux-arm64/peartube-relay /peartube-relay'), 'artifact stage maps Docker arm64 to the prepared standalone binary')
  t.ok(content.includes('gcr.io/distroless/cc-debian12'), 'final image uses the distroless C runtime needed by the standalone relay binary')
  t.absent(content.includes('npm run build:standalone'), 'Docker build no longer runs bare-build inside the image')
  t.ok(content.includes('COPY --from=artifact'), 'final image copies the packaged artifact from the artifact stage')
  t.ok(content.includes('COPY --from=runtime-libs /libatomic.so.1 /lib/libatomic.so.1'), 'final image copies libatomic into the runtime rootfs for rocksdb-native')
  t.ok(content.includes('COPY --from=runtime-libs /usr/local/bin/yt-dlp /usr/local/bin/yt-dlp'), 'final image copies yt-dlp into PATH for relay CLI import workflows')
  t.ok(content.includes('ENTRYPOINT ["/peartube-relay"]'), 'final image runs the standalone relay executable directly')
})

test('Dockerfile final stage copies the prepared relay artifact', async (t) => {
  const dockerfilePath = join(__dirname, '..', 'Dockerfile')
  const content = readFileSync(dockerfilePath, 'utf8')

  t.ok(content.includes('COPY --from=artifact /peartube-relay /peartube-relay'), 'final image copies the packaged relay executable from the artifact stage')
})

test('relay workflow prepares standalone artifacts before docker image build', async (t) => {
  const workflowPath = join(__dirname, '..', '..', '..', '.github', 'workflows', 'build-relay.yml')
  const content = readFileSync(workflowPath, 'utf8')

  t.ok(content.includes('npm run build:standalone:linux-x64 --prefix packages/cli'), 'workflow builds linux x64 standalone artifacts before docker packaging')
  t.ok(content.includes('npm run prepare:docker-artifacts --prefix packages/cli'), 'workflow stages prepared docker artifacts before docker packaging')
})
