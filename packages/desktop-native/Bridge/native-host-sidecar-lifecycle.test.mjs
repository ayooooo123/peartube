import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const sidecarSourcePath = new URL('./native-host-sidecar.mjs', import.meta.url)

async function sidecarSource() {
  return readFile(sidecarSourcePath, 'utf8')
}

test('native host sidecar no longer wires dead transcoding stub', async () => {
  const source = await sidecarSource()
  assert.doesNotMatch(source, /Transcoding is not wired in the native sidecar yet\./)
  assert.doesNotMatch(source, /const transcoder = \{[\s\S]*?startTranscode[\s\S]*?getStatus[\s\S]*?\}/)

  const backendFactoryStart = source.indexOf('async function createNativeSidecarBackend')
  assert.notEqual(backendFactoryStart, -1, 'expected createNativeSidecarBackend')
  const backendFactoryEnd = source.indexOf('async function ensureHostBooted', backendFactoryStart)
  assert.notEqual(backendFactoryEnd, -1, 'expected ensureHostBooted after backend factory')
  const backendFactory = source.slice(backendFactoryStart, backendFactoryEnd)

  assert.doesNotMatch(backendFactory, /\btranscoder,/, 'sidecar backend dependency context should not pass fake transcoder')
})

test('native host sidecar clears keepAliveTimer through shutdownBridge', async () => {
  const source = await sidecarSource()
  assert.match(source, /function clearBridgeKeepAlive\(state\) \{[\s\S]*?clearInterval\(state\.keepAliveTimer\)[\s\S]*?state\.keepAliveTimer = null[\s\S]*?\}/)
  assert.match(source, /async function shutdownBridge\(state\) \{[\s\S]*?clearBridgeKeepAlive\(state\)/)
  assert.match(source, /state\.keepAliveTimer = setInterval\(\(\) => \{\}, 1 << 30\)/)
  assert.doesNotMatch(source, /const keepAliveTimer = setInterval/)

  const explicitShutdownStart = source.indexOf('hrpcInstance.onDesktopShutdown')
  assert.notEqual(explicitShutdownStart, -1, 'expected explicit desktop shutdown handler')
  const explicitShutdown = source.slice(explicitShutdownStart, source.indexOf('})', explicitShutdownStart) + 2)
  assert.match(explicitShutdown, /await shutdownBridge\(state\)/)
})
