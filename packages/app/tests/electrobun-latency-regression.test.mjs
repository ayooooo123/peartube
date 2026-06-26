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
  const rootPackage = JSON.parse(readRepoFile('package.json'))

  assert.equal(
    rootPackage.scripts.desktop,
    'npm run desktop:dev --prefix packages/app',
    'root npm run desktop should run the full app desktop dev pipeline',
  )
  assert.match(
    scripts['desktop:dev'],
    /npm run schema && npm run desktop:export && npm run desktop:merge && npm run desktop:start/,
    'desktop:dev should refresh schema and web assets before launching',
  )

  assert.match(
    scripts['desktop:start'],
    /npm run desktop:worker && npm run desktop:bundle && npm run desktop:ebuild && build\/dev-macos-arm64\/PearTube-dev\.app\/Contents\/MacOS\/launcher/,
    'desktop:start must rebuild the worker bundle and staged app before launching',
  )
  assert.match(
    scripts['desktop:ebuild'],
    /electrobun build && npm run desktop:ecopy/,
    'desktop:ebuild should refresh copied app resources after rebuilding the launcher',
  )
  assert.match(
    scripts['desktop:ecopy'],
    /rm -rf [^&]*\/workers [^&]*\/node_modules/,
    'desktop:ecopy should delete stale staged workers and legacy node_modules before copying',
  )
  assert.match(
    scripts['desktop:ecopy'],
    /rsync -a --exclude=index\.mjs desktop-build\/build\/workers\/core\/ /,
    'desktop:ecopy should copy the packed worker bundle and offloaded native addons into the staged app',
  )
})

test('Electrobun IPC relay removes the per-socket worker data listener on close', () => {
  const source = readAppFile('src/bun/index.ts')

  assert.match(source, /function removeWorkerDataListener/)
  assert.match(source, /const forwardWorkerData = \(d: Buffer\) =>/)
  assert.match(source, /worker\.on\('data', forwardWorkerData\)/)
  assert.match(source, /removeWorkerDataListener\(worker, forwardWorkerData\)/)
})

test('Electrobun main process does not proxy blob media bytes', () => {
  const source = readAppFile('src/bun/index.ts')

  assert.match(source, /__peartube_ipc_port/, 'main process should still expose IPC port discovery')
  assert.doesNotMatch(source, /__blob/, 'media should go directly to the backend blob server')
  assert.doesNotMatch(source, /Blob proxy/i, 'main process should not contain a blob proxy path')
  assert.doesNotMatch(source, /fetch\(blobUrl/, 'main process should not refetch backend blob bytes')
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
