import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { build } from 'esbuild'


const __dirname = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(__dirname, '..')
const source = readFileSync(resolve(appRoot, 'components/video-player/P2PStatsBar.tsx'), 'utf8')

async function loadStatsModel() {
  const stubs = {
    'react-native-stub': 'export const View = () => null\nexport const Text = () => null\nexport const Pressable = () => null\n',
    'icons-stub': 'export const Feather = () => null\n',
    'primitives-stub': 'export const SwarmIndicator = () => null\n',
    'colors-stub': 'export const colors = {}\n',
    'styles-stub': 'export const styles = {}\n',
    'formatters-stub': 'export const formatSizeCompact = value => String(value)\n',
  }
  const plugin = {
    name: 'instrument-p2p-stats-model',
    setup(builder) {
      builder.onResolve({ filter: /^react-native$/ }, () => ({ path: 'react-native-stub', namespace: 'p2p-stub' }))
      builder.onResolve({ filter: /^@expo\/vector-icons$/ }, () => ({ path: 'icons-stub', namespace: 'p2p-stub' }))
      builder.onResolve({ filter: /^@\/components\/primitives$/ }, () => ({ path: 'primitives-stub', namespace: 'p2p-stub' }))
      builder.onResolve({ filter: /^@\/lib\/colors$/ }, () => ({ path: 'colors-stub', namespace: 'p2p-stub' }))
      builder.onResolve({ filter: /\/styles$/ }, () => ({ path: 'styles-stub', namespace: 'p2p-stub' }))
      builder.onResolve({ filter: /\/formatters$/ }, () => ({ path: 'formatters-stub', namespace: 'p2p-stub' }))
      builder.onLoad({ filter: /.*/, namespace: 'p2p-stub' }, args => ({
        contents: stubs[args.path],
        loader: 'js',
      }))
      builder.onLoad({ filter: /P2PStatsBar\.tsx$/ }, args => ({
        contents: `${source}
export { deriveP2PStatsModel }
`,
        loader: 'tsx',
        resolveDir: dirname(args.path),
      }))
    },
  }
  const result = await build({
    stdin: {
      contents: "export { deriveP2PStatsModel } from './components/video-player/P2PStatsBar.tsx'",
      resolveDir: appRoot,
      sourcefile: 'p2p-stats-model-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['react', 'react-dom'],
    plugins: [plugin],
    tsconfigRaw: { compilerOptions: { jsx: 'react-jsx', baseUrl: appRoot, paths: { '@/*': ['./*'] } } },
    write: false,
  })
  const directory = mkdtempSync(resolve(appRoot, '.p2p-stats-'))
  const output = resolve(directory, 'model.cjs')
  writeFileSync(output, result.outputFiles[0].text)
  try {
    return await import(`${pathToFileURL(output).href}?${Math.random()}`)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}


test('P2P stats bar reports active peer transfers as streaming', () => {
  assert.match(
    source,
    /if \(peerCount > 0 && \(downloadSpeed > 0 \|\| stats\?\.status === 'downloading'\)\) \{[\s\S]*`Streaming from \$\{peerCount\}/,
  )
})

test('P2P stats bar does not infer live streaming from aggregate cache progress', () => {
  assert.match(source, /const hasPlayableProgress = downloadSpeed > 0/)
  assert.doesNotMatch(source, /hasPlayableProgress = [^\n]*(?:downloadedBytes|downloadedBlocks|stats\?\.progress)/)
})

test('P2P stats bar treats fully loaded videos as saved before streaming', async () => {
  const { deriveP2PStatsModel } = await loadStatsModel()
  const cached = deriveP2PStatsModel({
    status: 'complete',
    progress: 100,
    peerCount: 2,
    speedMBps: 1,
    downloadedBlocks: 10,
    totalBlocks: 10,
    downloadedBytes: 1_000,
    totalBytes: 1_000,
  }, true, false, true)
  assert.equal(cached.isCached, true, 'the production model should recognize a complete transfer')
  assert.equal(cached.statusLine, 'Saved on this device', 'saved state should win over streaming')
  assert.equal(cached.showProgressBar, false, 'a complete transfer has no active progress bar')

  const partial = deriveP2PStatsModel({
    status: 'downloading',
    progress: 30,
    peerCount: 2,
    speedMBps: 1,
    downloadedBlocks: 3,
    totalBlocks: 10,
    downloadedBytes: 300,
    totalBytes: 1_000,
  }, true, false, true)
  assert.equal(partial.isCached, false, 'partial transfer must remain live')
  assert.equal(partial.statusLine, 'Streaming from 2 peers')
  assert.equal(partial.showProgressBar, true)
})

// A publication plays with no P2P stats at all: the channel-drive stats poller
// needs a channel key and skips these titles, so `stats` stays null for the
// whole session. The bar read that as "Starting player…" over frames that were
// already on screen.
test('P2P stats bar stops claiming the player is starting once it plays', () => {
  const playingIndex = source.indexOf("if (playing) return 'Playing'")
  const startingIndex = source.indexOf("if (!stats) return 'Starting player…'")

  assert.notEqual(playingIndex, -1, 'the bar reads the player state, not only the swarm')
  assert.notEqual(startingIndex, -1, 'a player that has not started still says so')
  assert.ok(playingIndex < startingIndex, 'real playback wins over the absence of stats')
  assert.match(source, /if \(failed \|\| stats\?\.status === 'error'\)/, 'a terminal failure is not a starting player either')
})
