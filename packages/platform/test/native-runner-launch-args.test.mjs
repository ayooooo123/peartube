import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const platformRoot = path.resolve(__dirname, '..')

function readPlatformFile(relativePath) {
  return fs.readFileSync(path.join(platformRoot, relativePath), 'utf8')
}

test('native RPC launch args preserve the mobile entrypoint before trailing worker args', () => {
  const source = readPlatformFile('src/rpc.native.ts')

  assert.match(
    source,
    /resolveLaunchArgs\(options\) \{\s*return \[\s*options\.storagePath,\s*options\.entrypoint,\s*\.\.\.withHostProtocolLaunchOption\(nativeRuntimeConfig\.workerArgs, options\.protocolVersion\),?\s*\];\s*\}/,
    'mobile backend worklet argv must carry the host protocol version ahead of trailing worker args',
  )
})

test('native RPC serializes launch options before downloader worker args', () => {
  const source = readPlatformFile('src/rpc.native.ts')

  assert.match(
    source,
    /const launchOptionsArg = config\.launchOptions[\s\S]*__peartubeLaunchOptions: true[\s\S]*network: config\.launchOptions\.network[\s\S]*swarmOptions: config\.launchOptions\.swarmOptions/,
    'initPlatformRPC should serialize backend launch options',
  )
  assert.match(source, /protocolVersion: PROTOCOL_VERSION/)
  assert.match(
    source,
    /nativeRuntimeConfig\.workerArgs = \[[\s\S]*\.\.\.\(launchOptionsArg \? \[launchOptionsArg\] : \[\]\),[\s\S]*\.\.\.\(downloaderWorkerPath \? \[downloaderWorkerPath\] : \[\]\),[\s\S]*\]/,
    'launch options must be the first trailing arg so sidecar parsing consumes them before downloader worker path',
  )
})
