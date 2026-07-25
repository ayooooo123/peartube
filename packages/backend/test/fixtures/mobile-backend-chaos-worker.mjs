import fs from 'bare-fs'
import path from 'bare-path'

import { createBackend } from '../../src/backend-entry.js'

const [scenario, phase, storagePath] = Bare.argv.slice(2)

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  const temporary = `${file}.${Bare.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(value))
  fs.renameSync(temporary, file)
}

function barrier(name) {
  console.log(JSON.stringify({ type: 'barrier', scenario, name }))
  setInterval(() => {}, 60_000)
  return new Promise(() => {})
}

async function run() {
  if (scenario !== 'mobile-backend-restart') throw new Error(`Unsupported Bare chaos scenario: ${scenario}`)
  const startupFile = path.join(storagePath, 'mobile-startup-count.json')
  const prior = readJson(startupFile, { count: 0 })
  const startupCount = prior.count + 1
  writeJson(startupFile, { count: startupCount })

  const metaDb = { async get() { return null }, async put() {} }
  const session = await createBackend({
    storagePath,
    stream: {},
    platform: 'mobile',
    protocolVersion: 1,
    createBackendContext: async () => ({
      ctx: { metaDb }, api: {}, identityManager: { getIdentities: () => [] }, uploadManager: {}, async destroy() {},
    }),
    createGossipService: () => ({}),
    createMirrorSeedWorker: () => ({}),
    createStorageService: () => ({}),
    loadNativeModules: async () => ({ libhc: { async create() { return { async init() {}, async flush() {}, async start() {}, async shutdown() {} } } } }),
    HRPCImpl: class MockHRPC { respond() {} eventReady() {} eventError() {} },
  })

  if (phase === 'prepare') return barrier('mobile-backend-ready')
  console.log(JSON.stringify({
    type: 'result',
    scenario,
    result: { platform: 'mobile', startupCount, coreState: session.core.state },
  }))
  await session.destroy()
}

try {
  await run()
} catch (error) {
  console.error(error?.stack || error)
  Bare.exitCode = 1
}
