import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from '../../app/node_modules/esbuild/lib/main.js'
import { PROTOCOL_VERSION } from '@peartube/host/contracts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const platformRoot = path.resolve(__dirname, '..')

async function loadArgumentBuilders() {
  const source = fs.readFileSync(path.join(platformRoot, 'src/rpc.native.ts'), 'utf8')
  const result = await build({
    stdin: {
      contents: `${source}\nexport { buildNativeWorkerArgs, withHostProtocolLaunchOption }\n`,
      resolveDir: path.join(platformRoot, 'src'),
      sourcefile: 'rpc.native.ts',
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    packages: 'external',
  })
  const directory = fs.mkdtempSync(path.join(platformRoot, '.launch-args-'))
  const output = path.join(directory, 'args.cjs')
  fs.writeFileSync(output, result.outputFiles[0].text)
  try {
    return await import(pathToFileURL(output).href)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test('native launch options precede the downloader path and carry the host protocol', async () => {
  const { buildNativeWorkerArgs } = await loadArgumentBuilders()
  const network = { networkEnabled: false }
  const swarmOptions = { maxPeers: 3 }
  const workerPath = '/private/path with spaces/downloader.bundle'
  const args = buildNativeWorkerArgs({
    launchOptions: { network, swarmOptions, player: 'exoplayer' },
  }, workerPath)
  const launch = JSON.parse(args[0])
  assert.equal(launch.__peartubeLaunchOptions, true)
  assert.equal(launch.protocolVersion, PROTOCOL_VERSION)
  assert.equal(launch.network.networkEnabled, false)
  assert.equal(launch.swarmOptions.maxPeers, 3)
  assert.equal(launch.player, 'exoplayer')
  assert.deepEqual(args.slice(1), [workerPath])
})

test('host protocol replaces stale launch metadata without consuming worker arguments', async () => {
  const { withHostProtocolLaunchOption } = await loadArgumentBuilders()
  const stale = JSON.stringify({
    __peartubeLaunchOptions: true,
    protocolVersion: -1,
    network: { networkEnabled: false },
  })
  const original = [stale, '/downloader.bundle']
  const normalized = withHostProtocolLaunchOption(original, PROTOCOL_VERSION)
  assert.deepEqual(original, [stale, '/downloader.bundle'])
  assert.equal(JSON.parse(normalized[0]).protocolVersion, PROTOCOL_VERSION)
  assert.equal(JSON.parse(normalized[0]).network.networkEnabled, false)
  assert.deepEqual(normalized.slice(1), ['/downloader.bundle'])

  const missing = withHostProtocolLaunchOption(['/downloader.bundle'], PROTOCOL_VERSION)
  assert.equal(JSON.parse(missing[0]).__peartubeLaunchOptions, true)
  assert.equal(JSON.parse(missing[0]).protocolVersion, PROTOCOL_VERSION)
  assert.deepEqual(missing.slice(1), ['/downloader.bundle'])
})
