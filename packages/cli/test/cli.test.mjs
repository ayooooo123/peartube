import test from 'brittle'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { normalizeCliArgv, parseArgv } from '../src/argv.js'
import { createCliLogger } from '../src/cli-logger.js'

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

  t.is(pkg.scripts['test'], 'brittle test/admission.test.mjs test/archive-ui.test.mjs test/archive.test.mjs test/blob-downloader.test.mjs test/cli.test.mjs test/config.test.mjs test/local-drive-mirror.test.mjs test/relay-seeding.test.mjs test/service.test.mjs test/status.test.mjs')
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

test('CLI logger keeps positional metadata out of numbered JSON fields', async (t) => {
  const writes = []
  const originalWrite = process.stdout.write

  process.stdout.write = function write(chunk, ...args) {
    writes.push(String(chunk))
    const callback = args.find((arg) => typeof arg === 'function')
    callback?.()
    return true
  }

  try {
    const logger = createCliLogger('debug')
    logger.download.error('download failed', 'aa'.repeat(32), 'video-1')
  } finally {
    process.stdout.write = originalWrite
  }

  t.is(writes.length, 1)
  const entry = JSON.parse(writes[0])
  t.absent(Object.hasOwn(entry, '0'))
  t.alike(entry.args, ['aa'.repeat(32), 'video-1'])
})

test('Dockerfile packages the standalone relay executable in a minimal runtime image', async (t) => {
  const dockerfilePath = join(__dirname, '..', 'Dockerfile')
  const content = readFileSync(dockerfilePath, 'utf8')

  t.ok(content.includes('FROM busybox:1.36.1 AS artifact'), 'artifact stage selects the prebuilt standalone relay binary')
  t.ok(content.includes('FROM debian:13-slim AS runtime-libs'), 'runtime libs stage installs missing shared libraries for native addons')
  t.ok(content.includes('ARG YT_DLP_VERSION='), 'Dockerfile pins the yt-dlp release version as a build arg')
  t.ok(content.includes('ca-certificates curl libatomic1'), 'runtime libs stage installs curl and CA roots to download archive helpers')
  t.ok(content.includes('YT_DLP_ASSET=yt-dlp_linux'), 'runtime libs stage selects the Linux standalone yt-dlp binary for amd64')
  t.ok(content.includes('YT_DLP_ASSET=yt-dlp_linux_aarch64'), 'runtime libs stage selects the Linux standalone yt-dlp binary for arm64')
  t.ok(content.includes('https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/${YT_DLP_ASSET}'), 'runtime libs stage downloads the pinned standalone yt-dlp release asset')
  t.ok(content.includes('chmod 755 /usr/local/bin/yt-dlp'), 'runtime libs stage makes yt-dlp executable')
  t.ok(content.includes('/usr/local/bin/yt-dlp --version'), 'Docker build fails early if the packaged yt-dlp binary cannot execute')
  t.ok(content.includes('COPY packages/cli/dist/docker/ /dist/'), 'builder stage only packages prebuilt docker artifacts')
  t.ok(content.includes('cp /dist/linux-amd64/peartube-relay /peartube-relay'), 'artifact stage maps Docker amd64 to the prepared standalone binary')
  t.ok(content.includes('cp /dist/linux-arm64/peartube-relay /peartube-relay'), 'artifact stage maps Docker arm64 to the prepared standalone binary')
  t.ok(content.includes('gcr.io/distroless/cc-debian13'), 'final image uses the distroless C runtime needed by the standalone relay binary and bgutil-pot')
  t.absent(content.includes('npm run build:standalone'), 'Docker build no longer runs bare-build inside the image')
  t.ok(content.includes('COPY --from=artifact'), 'final image copies the packaged artifact from the artifact stage')
  t.ok(content.includes('COPY --from=runtime-libs /runtime-libs/libatomic.so.1 /lib/libatomic.so.1'), 'final image copies libatomic into the runtime rootfs for rocksdb-native')
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

test('Dockerfile packages executable standalone yt-dlp in the distroless relay image', async (t) => {
  const dockerfilePath = join(__dirname, '..', 'Dockerfile')
  const content = readFileSync(dockerfilePath, 'utf8')

  t.ok(content.includes('YT_DLP_ASSET=yt-dlp_linux'), 'amd64 uses the standalone Linux yt-dlp binary instead of the Python script')
  t.ok(content.includes('YT_DLP_ASSET=yt-dlp_linux_aarch64'), 'arm64 uses the standalone Linux yt-dlp binary instead of the Python script')
  t.ok(content.includes('/usr/local/bin/yt-dlp --version'), 'Docker build verifies the packaged yt-dlp binary executes')
  t.ok(content.includes('ENV PATH="/usr/local/bin:/usr/bin:${PATH}"'), 'final image PATH includes the packaged yt-dlp location')
  t.ok(content.includes('PEARTUBE_ARCHIVE_YT_DLP_PATH=/usr/local/bin/yt-dlp'), 'relay archive config uses the absolute packaged yt-dlp path')
})

test('Dockerfile copies yt-dlp shared libraries required by the distroless runtime', async (t) => {
  const dockerfilePath = join(__dirname, '..', 'Dockerfile')
  const content = readFileSync(dockerfilePath, 'utf8')

  t.ok(content.includes('zlib1g'), 'runtime libs stage installs libz provider for standalone yt-dlp')
  t.ok(content.includes('cp /lib/${archTriplet}/libz.so.1 /runtime-libs/libz.so.1'), 'runtime libs stage stages libz for the final image')
  t.ok(content.includes('cp /lib/${archTriplet}/${loader} /runtime-libs/${loader}'), 'runtime libs stage stages the architecture dynamic loader')
  t.ok(content.includes('COPY --from=runtime-libs /runtime-libs/libz.so.1 /lib/libz.so.1'), 'final image copies libz into the distroless runtime')
  t.ok(content.includes('COPY --from=runtime-libs /runtime-libs/libc.so.6 /lib/libc.so.6'), 'final image copies libc into the distroless runtime for Python-based yt-dlp plugins')
  t.ok(content.includes('COPY --from=runtime-libs /runtime-libs/ld-linux-x86-64.so.2 /lib64/ld-linux-x86-64.so.2'), 'final image copies the amd64 dynamic loader path')
  t.ok(content.includes('COPY --from=runtime-libs /runtime-libs/ld-linux-aarch64.so.1 /lib/ld-linux-aarch64.so.1'), 'final image copies the arm64 dynamic loader path')
})

test('Dockerfile stages both dynamic loader filenames for each platform build', async (t) => {
  const dockerfilePath = join(__dirname, '..', 'Dockerfile')
  const content = readFileSync(dockerfilePath, 'utf8')

  t.ok(content.includes('test -e /runtime-libs/ld-linux-x86-64.so.2 || cp /runtime-libs/${loader} /runtime-libs/ld-linux-x86-64.so.2'), 'amd64 build still exposes the arm64 loader COPY source placeholder')
  t.ok(content.includes('test -e /runtime-libs/ld-linux-aarch64.so.1 || cp /runtime-libs/${loader} /runtime-libs/ld-linux-aarch64.so.1'), 'arm64 build still exposes the amd64 loader COPY source placeholder')
})

test('Dockerfile packages deno for yt-dlp YouTube JavaScript extraction', async (t) => {
  const dockerfile = readFileSync(join(__dirname, '..', 'Dockerfile'), 'utf8')

  t.ok(dockerfile.includes('ARG DENO_VERSION='), 'Dockerfile pins a Deno version for reproducible relay images')
  t.ok(dockerfile.includes('github.com/denoland/deno/releases/download'), 'Dockerfile downloads Deno release assets')
  t.ok(dockerfile.includes('/usr/local/bin/deno --version'), 'Dockerfile validates Deno during image build')
  t.ok(dockerfile.includes('PEARTUBE_ARCHIVE_JS_RUNTIME=deno:/usr/local/bin/deno'), 'final image configures yt-dlp to use Deno')
  t.ok(dockerfile.includes('COPY --from=runtime-libs /usr/local/bin/deno /usr/local/bin/deno'), 'final image includes Deno executable')
})

test('Dockerfile packages ffmpeg for yt-dlp archive merging', async (t) => {
  const dockerfile = readFileSync(join(__dirname, '..', 'Dockerfile'), 'utf8')

  t.ok(dockerfile.includes('ARG FFMPEG_VERSION='), 'Dockerfile pins an ffmpeg static build version')
  t.ok(dockerfile.includes('johnvansickle.com/ffmpeg/releases'), 'Dockerfile downloads static ffmpeg release assets')
  t.ok(dockerfile.includes('/usr/local/bin/ffmpeg -version'), 'Dockerfile validates ffmpeg during image build')
  t.ok(dockerfile.includes('PEARTUBE_ARCHIVE_FFMPEG_PATH=/usr/local/bin/ffmpeg'), 'final image exposes configured ffmpeg path to archive jobs')
  t.ok(dockerfile.includes('COPY --from=runtime-libs /usr/local/bin/ffmpeg /usr/local/bin/ffmpeg'), 'final image includes ffmpeg executable')
  t.ok(dockerfile.includes('COPY --from=runtime-libs /usr/local/bin/ffprobe /usr/local/bin/ffprobe'), 'final image includes ffprobe executable')
})

test('relay runtime source wires client-equivalent feed availability providers', async (t) => {
  const runtimePath = join(__dirname, '..', 'src', 'runtime.js')
  const content = readFileSync(runtimePath, 'utf8')

  t.ok(content.includes('publicFeed.setAvailabilityHintProvider'), 'relay runtime should answer availability hint requests over the feed protocol')
  t.ok(content.includes('this.api.getAvailabilityHints(requests, conn)'), 'relay availability provider should use the same API path as clients')
  t.ok(content.includes('publicFeed.setFeedSnapshotProvider'), 'relay runtime should gossip compact playable feed snapshots')
  t.ok(content.includes('this.api.getFeedSnapshotEntries(entries, { limitPerChannel: 3 })'), 'relay feed snapshot provider should use the same API path as clients')
  t.ok(content.includes("ctx.swarm.on('peer'"), 'relay runtime should promote shared-topic peer discoveries into Hyperswarm socket candidates')
  t.ok(content.includes('publicFeed.handleDiscoveredPeer(peer, topic)'), 'relay runtime should pass discovered shared-topic peers through the same promotion path as app backends')
})

test('legacy relay init leaves shared-topic discovery under storage ownership', async (t) => {
  const initPath = join(__dirname, '..', 'src', 'init.js')
  const content = readFileSync(initPath, 'utf8')

  t.absent(content.includes("ctx.swarm.on('peer', (peer, topic)"), 'legacy relay init should not install app-level shared-topic peer discovery hooks')
  t.absent(content.includes('publicFeed.handleDiscoveredPeer(peer, topic)'), 'legacy relay init should leave discovery diagnostics to the storage-owned swarm')
})

test('Dockerfile packages the yt-dlp POT provider plugin for noninteractive YouTube bot checks', async (t) => {
  const dockerfile = readFileSync(join(__dirname, '..', 'Dockerfile'), 'utf8')

  t.ok(dockerfile.includes('ARG BGUTIL_POT_PROVIDER_VERSION='), 'Dockerfile pins the bgutil POT provider release')
  t.ok(dockerfile.includes('BGUTIL_POT_ASSET=bgutil-pot-linux-x86_64'), 'Dockerfile selects the prebuilt bgutil POT CLI binary for amd64')
  t.ok(dockerfile.includes('BGUTIL_POT_ASSET=bgutil-pot-linux-aarch64'), 'Dockerfile selects the prebuilt bgutil POT CLI binary for arm64')
  t.absent(dockerfile.includes('cargo install bgutil-ytdlp-pot-provider'), 'Dockerfile does not compile the Rust POT provider during multi-arch image builds')
  t.ok(dockerfile.includes('/usr/local/bin/bgutil-pot --version'), 'Dockerfile validates the bgutil POT CLI binary during image build')
  t.ok(dockerfile.includes('bgutil-ytdlp-pot-provider-rs.zip'), 'Dockerfile downloads the yt-dlp POT provider plugin archive')
  t.ok(dockerfile.includes('/usr/local/bin/yt-dlp --plugin-dirs /usr/local/share/yt-dlp-plugins --extractor-args "youtube:player_client=default,-android_vr,mweb;youtubepot-bgutilcli:cli_path=/usr/local/bin/bgutil-pot"'), 'Dockerfile validates yt-dlp can load the packaged plugin directory')
  t.ok(dockerfile.includes('ENV PEARTUBE_ARCHIVE_YT_DLP_EXTRA_ARGS="--plugin-dirs /usr/local/share/yt-dlp-plugins --extractor-args youtube:player_client=default,-android_vr,mweb;youtubepot-bgutilcli:cli_path=/usr/local/bin/bgutil-pot"'), 'final image defaults YouTube archive jobs to the packaged plugin directory and CLI POT provider')
  t.ok(dockerfile.includes('ENV PEARTUBE_ARCHIVE_YT_DLP_RETRY_EXTRA_ARGS='), 'final image includes configurable yt-dlp retry client fallbacks')
  t.ok(dockerfile.includes('COPY --from=runtime-libs /usr/local/bin/bgutil-pot /usr/local/bin/bgutil-pot'), 'final image includes the bgutil POT CLI binary')
  t.ok(dockerfile.includes('COPY --from=runtime-libs /usr/local/share/yt-dlp-plugins /usr/local/share/yt-dlp-plugins'), 'final image includes yt-dlp plugins')
})
