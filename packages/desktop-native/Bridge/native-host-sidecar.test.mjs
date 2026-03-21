import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

import {
  BRIDGE_COMMANDS,
  bootstrapRequestCodec,
  bootstrapResponseCodec,
  browseSnapshotCodec,
  createIdentityRequestCodec,
  createRPCFrameParser,
  decodePayload,
  encodePayload,
  encodeRequestFrame,
  searchRequestCodec,
  searchResponseCodec,
} from './native-rpc.mjs'

const packageRoot = path.resolve(import.meta.dirname, '..')
const bundlePath = path.join(packageRoot, 'Resources', 'Generated', 'native-host-sidecar.bundle')
const bareRuntimePath = path.join(packageRoot, 'Resources', 'Runtime', 'bare')
const linkedFrameworksPath = path.join(packageRoot, 'Vendor', 'BareAddons')

function waitForResponse(child, id) {
  return new Promise((resolve, reject) => {
    const parser = createRPCFrameParser()
    let stderr = ''

    const cleanup = () => {
      child.stdout.off('data', onStdout)
      child.stderr.off('data', onStderr)
      child.off('exit', onExit)
      child.off('error', onError)
    }

    const onStdout = (chunk) => {
      try {
        const messages = parser.push(chunk)
        for (const message of messages) {
          if (message.kind !== 'response' || message.id !== id) continue
          cleanup()
          resolve(message)
          return
        }
      } catch (error) {
        cleanup()
        reject(error)
      }
    }

    const onStderr = (chunk) => {
      stderr += chunk.toString('utf8')
    }

    const onExit = (code, signal) => {
      cleanup()
      reject(new Error(`Sidecar exited before responding (${signal || code || 0})\n${stderr}`))
    }

    const onError = (error) => {
      cleanup()
      reject(error)
    }

    child.stdout.on('data', onStdout)
    child.stderr.on('data', onStderr)
    child.once('exit', onExit)
    child.once('error', onError)
  })
}

test('bundled native host sidecar boots and responds to bootstrap', { timeout: 120000 }, async () => {
  assert.equal(fs.existsSync(bundlePath), true, 'sidecar bundle should exist after generate')
  assert.equal(fs.existsSync(bareRuntimePath), true, 'bare runtime should exist after generate')

  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-native-sidecar-'))
  const child = spawn(bareRuntimePath, [bundlePath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DYLD_FRAMEWORK_PATH: linkedFrameworksPath,
    },
  })

  try {
    const bootstrapFrame = encodeRequestFrame({
      id: 1,
      command: BRIDGE_COMMANDS.bootstrap,
      data: encodePayload(bootstrapRequestCodec, { storagePath }),
    })

    child.stdin.write(bootstrapFrame)

    const response = await waitForResponse(child, 1)
    assert.equal(response.isError, false)

    const payload = decodePayload(bootstrapResponseCodec, response.data)
    assert.equal(payload.storagePath, storagePath)
    assert.equal(payload.protocolVersion, 1)
    assert.ok(Array.isArray(payload.snapshot.sections.home))

    const searchFrame = encodeRequestFrame({
      id: 2,
      command: BRIDGE_COMMANDS.searchVideos,
      data: encodePayload(searchRequestCodec, { query: 'native shell', topK: 5 }),
    })

    child.stdin.write(searchFrame)

    const searchResponse = await waitForResponse(child, 2)
    assert.equal(searchResponse.isError, false)

    const searchPayload = decodePayload(searchResponseCodec, searchResponse.data)
    assert.equal(searchPayload.query, 'native shell')
    assert.ok(Array.isArray(searchPayload.results))

    const createIdentityFrame = encodeRequestFrame({
      id: 3,
      command: BRIDGE_COMMANDS.createIdentity,
      data: encodePayload(createIdentityRequestCodec, { name: 'Native Sidecar Test Channel' }),
    })

    child.stdin.write(createIdentityFrame)

    const createIdentityResponse = await waitForResponse(child, 3)
    assert.equal(createIdentityResponse.isError, false)

    const createdSnapshot = decodePayload(browseSnapshotCodec, createIdentityResponse.data)
    assert.equal(createdSnapshot.state.activeIdentityName, 'Native Sidecar Test Channel')
    assert.equal(createdSnapshot.state.identityChannelKeys.length > 0, true)

    const shutdownFrame = encodeRequestFrame({
      id: 4,
      command: BRIDGE_COMMANDS.shutdown,
      data: null,
    })

    child.stdin.write(shutdownFrame)
    child.stdin.end()
  } finally {
    child.kill('SIGTERM')
  }
})
