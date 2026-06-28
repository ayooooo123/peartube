import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

import HRPC from '../../spec/spec/hrpc/index.js'

const packageRoot = path.resolve(import.meta.dirname, '..')
const bundlePath = path.join(packageRoot, 'Resources', 'Generated', 'native-host-sidecar.bundle')
const bareRuntimePath = path.join(packageRoot, 'Resources', 'Runtime', 'bare')
const linkedFrameworksPath = path.join(packageRoot, 'Vendor', 'BareAddons')
const debugLogPath = path.join(os.tmpdir(), `peartube-native-sidecar-debug-${process.pid}.log`)

function readDebugLog() {
  try {
    return fs.readFileSync(debugLogPath, 'utf8')
  } catch {
    return ''
  }
}

function createSidecarEnv() {
  const linkedLibraryPath = path.join(linkedFrameworksPath, 'lib')
  return {
    ...process.env,
    DYLD_FRAMEWORK_PATH: linkedFrameworksPath,
    LD_LIBRARY_PATH: [linkedLibraryPath, linkedFrameworksPath, process.env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter),
    PEARTUBE_NATIVE_WORKLET_DEBUG_LOG: debugLogPath,
  }
}

function createChildStream(child) {
  return {
    write(data) {
      return child.stdin.write(data)
    },
    destroy(error) {
      child.stdin.destroy(error)
      child.stdout.destroy(error)
    },
    on(event, listener) {
      if (event === 'drain') child.stdin.on(event, listener)
      else child.stdout.on(event, listener)
      return this
    },
    once(event, listener) {
      if (event === 'drain') child.stdin.once(event, listener)
      else child.stdout.once(event, listener)
      return this
    },
    removeListener(event, listener) {
      if (event === 'drain') child.stdin.removeListener(event, listener)
      else child.stdout.removeListener(event, listener)
      return this
    },
  }
}

async function withSidecarTimeout(label, task, timeoutMs = 30000) {
  let timer = null
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for ${label} after ${timeoutMs}ms\nDEBUG:\n${readDebugLog()}`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

test('bundled native host sidecar boots and responds to bootstrap', { timeout: 120000 }, async () => {
  assert.equal(fs.existsSync(bundlePath), true, 'sidecar bundle should exist after generate')
  assert.equal(fs.existsSync(bareRuntimePath), true, 'bare runtime should exist after generate')

  try { fs.rmSync(debugLogPath, { force: true }) } catch (error) { void error }

  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-native-sidecar-'))
  const child = spawn(bareRuntimePath, [bundlePath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: createSidecarEnv(),
  })
  const stderrChunks = []
  child.stderr.on('data', (chunk) => stderrChunks.push(chunk))

  const rpc = new HRPC(createChildStream(child))
  const failWithDiagnostics = (error) => {
    const stderr = Buffer.concat(stderrChunks).toString('utf8')
    error.message = `${error.message}\nSTDERR:\n${stderr}\nDEBUG:\n${readDebugLog()}`
    return error
  }

  try {
    const payload = await withSidecarTimeout(
      'desktopBootstrap',
      () => rpc.desktopBootstrap({ storagePath })
    ).catch((error) => { throw failWithDiagnostics(error) })

    assert.equal(payload.storagePath, storagePath)
    assert.equal(payload.protocolVersion, 3)
    assert.ok(Array.isArray(payload.snapshot.sections.home))

    const searchPayload = await withSidecarTimeout(
      'globalSearchVideos',
      () => rpc.globalSearchVideos({ query: 'native shell', topK: 5 })
    ).catch((error) => { throw failWithDiagnostics(error) })
    assert.ok(Array.isArray(searchPayload.results))

    const createIdentityPayload = await withSidecarTimeout(
      'createIdentity',
      () => rpc.createIdentity({ name: 'Native Sidecar Test Channel' })
    ).catch((error) => { throw failWithDiagnostics(error) })
    const createdIdentity = createIdentityPayload.identity
    assert.equal(createdIdentity.name, 'Native Sidecar Test Channel')
    assert.equal(createdIdentity.isActive, true)
    assert.equal(typeof createdIdentity.publicKey, 'string')
    assert.notEqual(createdIdentity.publicKey.length, 0)

    const refreshed = await withSidecarTimeout(
      'desktopRefreshBrowse',
      () => rpc.desktopRefreshBrowse({})
    ).catch((error) => { throw failWithDiagnostics(error) })
    const refreshedSnapshot = refreshed.snapshot
    assert.equal(refreshedSnapshot.state.activeIdentityName, 'Native Sidecar Test Channel')
    assert.equal(refreshedSnapshot.state.identityChannelKeys.length > 0, true)
    assert.equal(typeof refreshedSnapshot.state.activeIdentityChannelKey, 'string')

    const activeChannelKey = refreshedSnapshot.state.activeIdentityChannelKey
    const getChannelMetaPayload = await withSidecarTimeout(
      'getChannelMeta',
      () => rpc.getChannelMeta({
        channelKey: activeChannelKey,
        publicBeeKey: null,
      })
    ).catch((error) => { throw failWithDiagnostics(error) })
    assert.equal(getChannelMetaPayload.name, 'Native Sidecar Test Channel')
    assert.equal(getChannelMetaPayload.avatarURL ?? null, null)

    const listChannelVideosPayload = await withSidecarTimeout(
      'listVideos',
      () => rpc.listVideos({
        channelKey: activeChannelKey,
        publicBeeKey: null,
        limit: 100,
        offset: 0,
      })
    ).catch((error) => { throw failWithDiagnostics(error) })
    assert.ok(Array.isArray(listChannelVideosPayload.videos))

    const ffmpegAvailablePayload = await withSidecarTimeout(
      'ffmpegDecodeAvailable',
      () => rpc.ffmpegDecodeAvailable({})
    ).catch((error) => { throw failWithDiagnostics(error) })
    assert.equal(typeof ffmpegAvailablePayload.available, 'boolean')
    assert.equal(
      ffmpegAvailablePayload.available ? ffmpegAvailablePayload.error === null || ffmpegAvailablePayload.error === '' : typeof ffmpegAvailablePayload.error === 'string',
      true
    )

    await withSidecarTimeout(
      'desktopShutdown',
      () => rpc.desktopShutdown({}),
      10000
    ).catch((error) => { throw failWithDiagnostics(error) })
    child.stdin.end()
  } finally {
    child.kill('SIGTERM')
  }
})
