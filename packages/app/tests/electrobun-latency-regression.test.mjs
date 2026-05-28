import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(__dirname, '..')

function readAppFile(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8')
}

function readRepoFile(relativePath) {
  return fs.readFileSync(path.resolve(appRoot, '../..', relativePath), 'utf8')
}

function readPackageJson() {
  return JSON.parse(readAppFile('package.json'))
}

test('Electrobun desktop start refreshes staged workspace packages before launching', () => {
  const { scripts } = readPackageJson()

  assert.match(
    scripts['desktop:start'],
    /npm run desktop:ecopy && build\/dev-macos-arm64\/PearTube-dev\.app\/Contents\/MacOS\/launcher/,
    'desktop:start must not launch a stale packaged backend directly',
  )
  assert.match(
    scripts['desktop:ecopy'],
    /rsync -a --delete \.\.\/\.\.\/packages\/backend\/ build\/dev-macos-arm64\/PearTube-dev\.app\/Contents\/Resources\/app\/node_modules\/@peartube\/backend\//,
    'desktop:ecopy should delete stale backend files from the staged app before copying',
  )
})

test('Electrobun IPC relay removes the per-socket worker data listener on close', () => {
  const source = readAppFile('src/bun/index.ts')

  assert.match(source, /function removeWorkerDataListener/)
  assert.match(source, /const forwardWorkerData = \(d: Buffer\) =>/)
  assert.match(source, /worker\.on\('data', forwardWorkerData\)/)
  assert.match(source, /removeWorkerDataListener\(worker, forwardWorkerData\)/)
})

test('Electroview bridge reuses the IPC WebSocket instead of creating duplicate transports', () => {
  const source = readAppFile('src/view/index.ts')

  assert.match(source, /let ipcConnectPromise: Promise<boolean> \| null = null/)
  assert.match(source, /if \(ipcSocket\?\.readyState === WebSocket\.OPEN\) return true/)
  assert.match(source, /if \(ipcConnectPromise\) return ipcConnectPromise/)
})

test('platform web transport rejects failed Electrobun worker startup', () => {
  const source = readRepoFile('packages/platform/src/rpc.web.ts')

  assert.match(source, /const started = await window\.bridge\.startWorker\(BACKEND_WORKER\)/)
  assert.match(source, /if \(!started\) \{/)
  assert.match(source, /throw new Error\('Failed to start Electrobun backend worker'\)/)
  assert.doesNotMatch(source, /await window\.bridge\.startWorker\(BACKEND_WORKER\);\s*console\.log\('\[Platform RPC\] Worker started:'/)
})

test('desktop web layout does not start fallback stats polling on the Electrobun bridge path', () => {
  const source = readAppFile('app/_layout.web.tsx')

  assert.match(source, /const isBridgeDesktop = typeof window !== 'undefined' && !!\(window as any\)\.bridge/)
  assert.match(source, /const shouldUseStatsPollingFallback = !isBridgeDesktop/)

  const fallbackIndex = source.indexOf('Fallback: poll getVideoStats')
  assert.notEqual(fallbackIndex, -1, 'fallback stats polling comment should still document the mobile/legacy path')

  const guardIndex = source.lastIndexOf('if (shouldUseStatsPollingFallback)', fallbackIndex)
  assert.notEqual(guardIndex, -1, 'fallback stats polling should be guarded away from Electrobun bridge desktops')
})
