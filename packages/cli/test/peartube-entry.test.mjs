import test from 'brittle'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PEARTUBE_USAGE, runPeartube } from '../peartube.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(__dirname, '..')

function memoryStream({ isTTY = false } = {}) {
  let content = ''
  return {
    isTTY,
    write(chunk) {
      content += String(chunk)
      return true
    },
    read() {
      return content
    }
  }
}

test('package exposes only the new peartube alias beside legacy executables', (t) => {
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))

  t.alike(pkg.bin, {
    peartube: 'peartube.js',
    'peartube-relay': 'bin.js',
    'peartube-peer': 'bin.js',
    'peartube-relay-bare': 'bare-bin.js',
    'peartube-peer-bare': 'bare-bin.js'
  })
})

test('CLI source entrypoint instantiates without obsolete stream lease exports', async (t) => {
  const entry = await import('../src/index.js')
  t.is(typeof entry.createCompanionRouter, 'function')
  t.is('createStreamLeaseStore' in entry, false)
})

test('help prints stable usage without loading command modules', async (t) => {
  const stdout = memoryStream()
  const stderr = memoryStream()
  const loaded = []

  const exitCode = await runPeartube({
    argv: ['help'],
    stdin: memoryStream(),
    stdout,
    stderr,
    env: {},
    loadModule: async (specifier) => {
      loaded.push(specifier)
      throw new Error('help must not load a command module')
    }
  })

  t.is(exitCode, 0)
  t.alike(loaded, [])
  t.is(stdout.read(), `${PEARTUBE_USAGE}\n`)
  t.is(stderr.read(), '')
  t.is(PEARTUBE_USAGE, [
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
    '  --kind <kind>       Narrow search to a kind (movie, series, episode, track, release)',
    '  --genre <name>      Narrow search to a genre; repeat to require several',
    '  --timeout <s>       Seconds to wait for the next block',
    '  -h, --help          Show this help',
    '',
    'Add coordinates:',
    '  --type <kind>       episode, movie, track, release, video',
    '  --provider <name>   tmdb|tvdb (episode, movie); musicbrainz (track, release)',
    '  --show-id <id>      Series id, with --season and --episode',
    '  --movie-id <id>     Movie id',
    '  --recording-id <id> MusicBrainz recording MBID',
    '  --release-id <id>   MusicBrainz release MBID',
    '  --title <text>      Title to publish under; optional when the authority',
    '                      can be read, required when it cannot',
    '  --channel-name <t>  Channel to publish into',
    '',
    'Metadata credentials (an authority is read only once its key is set):',
    '  tmdb         TMDB_API_KEY',
    '  tvdb         PEARTUBE_TVDB_API_KEY (+ PEARTUBE_TVDB_PIN)',
    '  musicbrainz  no credential required'
  ].join('\n'))
})

test('add lazily loads only src/add/index.js through the injected boundary', async (t) => {
  const stdout = memoryStream()
  const stderr = memoryStream()
  const loaded = []
  let received = null

  const exitCode = await runPeartube({
    argv: [
      'add', 'https://media.example/movie/550',
      '--type', 'movie',
      '--provider', 'tmdb',
      '--movie-id', '550',
      '--json',
      '--yes'
    ],
    stdin: memoryStream(),
    stdout,
    stderr,
    env: { TMDB_API_KEY: 'secret' },
    loadModule: async (specifier) => {
      loaded.push(specifier)
      if (specifier !== './src/add/index.js') {
        throw new Error(`unexpected import ${specifier}`)
      }
      return {
        async runAddCommand(options) {
          received = options
          options.stderr.write('resolving metadata\n')
          options.stdout.write('{"status":"published"}\n')
          return 0
        }
      }
    }
  })

  t.is(exitCode, 0)
  t.alike(loaded, ['./src/add/index.js'])
  t.is(received.command, 'add')
  t.is(received.fetchUrl, 'https://media.example/movie/550')
  t.is(received.flags.json, true)
  t.is(received.env.TMDB_API_KEY, 'secret')
  t.is(stdout.read(), '{"status":"published"}\n', '--json final output stays on stdout')
  t.is(stderr.read(), 'resolving metadata\n', 'diagnostics stay on stderr')
})

test('config lazily loads only the content settings flow', async (t) => {
  const stdout = memoryStream()
  const stderr = memoryStream()
  const loaded = []
  let received = null

  const exitCode = await runPeartube({
    argv: ['config', '--storage', '/srv/content', '--no-color'],
    stdin: memoryStream({ isTTY: true }),
    stdout,
    stderr: memoryStream({ isTTY: true }),
    env: {},
    loadModule: async (specifier) => {
      loaded.push(specifier)
      if (specifier !== './src/add/config-command.js') {
        throw new Error(`unexpected import ${specifier}`)
      }
      return {
        async runContentConfigCommand(options) {
          received = options
          return 0
        }
      }
    }
  })

  t.is(exitCode, 0)
  t.alike(loaded, ['./src/add/config-command.js'])
  t.is(received.command, 'config')
  t.is(received.flags.storage, '/srv/content')
  t.is(received.flags.noColor, true)
})

test('actual executable reports an unknown command with code 2 and no stack', (t) => {
  const result = spawnSync(process.execPath, [join(packageRoot, 'peartube.js'), 'publish'], {
    cwd: packageRoot,
    encoding: 'utf8'
  })

  t.is(result.status, 2)
  t.is(result.stdout, '')
  t.is(result.stderr, 'Unknown command "publish"\n')
  t.is(result.stderr.trim().split('\n').length, 1, 'stderr is one concise diagnostic')
  t.absent(result.stderr.includes(' at '), 'diagnostic does not include an Error stack')
})

test('symlinked executable runs with preserve-symlinks-main', (t) => {
  const linkPath = join(packageRoot, `.peartube-entry-${process.pid}-${Date.now()}.js`)
  symlinkSync('peartube.js', linkPath)
  t.teardown(() => rmSync(linkPath, { force: true }))

  const result = spawnSync(process.execPath, [
    '--preserve-symlinks-main',
    linkPath,
    'help'
  ], {
    cwd: packageRoot,
    encoding: 'utf8'
  })

  t.is(result.status, 0)
  t.is(result.stdout, `${PEARTUBE_USAGE}\n`)
  t.is(result.stderr, '')
})

test('legacy Node and Bare entry graphs remain isolated', (t) => {
  const tmp = mkdtempSync(join(process.env.TMPDIR || '/tmp', 'peartube-entry-'))
  t.teardown(() => rmSync(tmp, { recursive: true, force: true }))

  const hookPath = join(tmp, 'trace-imports.mjs')
  const tracePrefix = 'PEARTUBE_IMPORT '
  const hookSource = [
    `const prefix = ${JSON.stringify('PEARTUBE_IMPORT ')}`,
    'export async function resolve(specifier, context, nextResolve) {',
    '  const result = await nextResolve(specifier, context)',
    '  process.stderr.write(prefix + JSON.stringify({ specifier, url: result.url }) + "\\n")',
    '  return result',
    '}'
  ].join('\n')
  t.absent(hookSource.includes('registerHooks'), 'graph tracer stays compatible with Node 18')
  writeFileSync(hookPath, hookSource)

  const nodeResult = spawnSync(process.execPath, [
    '--no-warnings',
    '--experimental-loader', hookPath,
    join(packageRoot, 'bin.js'),
    '--help'
  ], {
    cwd: packageRoot,
    encoding: 'utf8'
  })

  t.is(nodeResult.status, 0, 'legacy Node help exits successfully')
  t.ok(nodeResult.stdout.includes('peartube-relay'), 'legacy Node entry keeps relay help')
  const stderrLines = nodeResult.stderr.trim() ? nodeResult.stderr.trim().split('\n') : []
  const traceLines = stderrLines.filter(line => line.startsWith(tracePrefix))
  const diagnostics = stderrLines.filter(line => !line.startsWith(tracePrefix))
  t.alike(diagnostics, [], 'legacy Node entry emits no import error')

  const resolved = traceLines.map(line => JSON.parse(line.slice(tracePrefix.length)))
  const graph = resolved.map(entry => `${entry.specifier} ${entry.url}`).join('\n')
  t.ok(graph.includes('/packages/cli/bin.js'), 'trace includes the legacy entry')
  t.ok(graph.includes('/packages/cli/src/argv.js'), 'trace includes transitive legacy parser imports')
  for (const forbidden of ['node:readline', '/src/add/', '/providers/tmdb', '/peartube.js']) {
    t.absent(graph.toLowerCase().includes(forbidden.toLowerCase()), `Node graph does not resolve ${forbidden}`)
  }
  // Resolve the Bare runner script directly so execution does not rely on OS shebang or broken .bin symlinks
  const bareName = process.platform === 'win32' ? 'bare.cmd' : 'bare'
  const bareCandidates = [
    join(packageRoot, 'node_modules', 'bare-runtime', 'bin', 'bare'),
    join(packageRoot, '..', '..', 'node_modules', 'bare-runtime', 'bin', 'bare'),
    join(packageRoot, 'node_modules', '.bin', bareName),
    join(packageRoot, '..', '..', 'node_modules', '.bin', bareName)
  ]
  const bareLauncher = bareCandidates.find((candidate) => existsSync(candidate)) || bareCandidates[0]
  const bareResult = spawnSync(process.execPath, [bareLauncher, join(packageRoot, 'bare-bin.js'), '--help'], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dirname(process.execPath)}:${process.env.PATH || ''}`
    }
  })

  const bareStdout = String(bareResult.stdout || '')
  const bareStderr = String(bareResult.stderr || '')
  const failureDetail = bareResult.error ? `launcher error: ${bareResult.error.message}` : (bareStderr || bareStdout || `exit code ${bareResult.status}`)
  t.is(bareResult.status, 0, `bare-bin executes under the actual Bare runtime conditions: ${failureDetail}`)
  t.ok(bareStdout.includes('peartube-relay'), `Bare graph keeps relay help: ${failureDetail}`)
  t.is(bareStderr, '', `Bare graph resolves without Node-only dependency errors: ${failureDetail}`)
  t.is(readFileSync(join(packageRoot, 'bare-bin.js'), 'utf8').trim(), [
    '#!/usr/bin/env bare',
    '',
    "import './bin.js'"
  ].join('\n'), 'Bare boundary remains the legacy bin graph only')
})
