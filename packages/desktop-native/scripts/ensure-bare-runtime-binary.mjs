import fs from 'fs'
import path from 'path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const bareRuntime = require('bare-runtime')

const packageRoot = path.resolve(import.meta.dirname, '..')
const runtimeBinary = bareRuntime('bare')
const runtimeOutputDir = path.join(packageRoot, 'Resources', 'Runtime')
const runtimeOutputPath = path.join(runtimeOutputDir, 'bare')

function newestMtime(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs
  } catch {
    return 0
  }
}

const sourceMtime = newestMtime(runtimeBinary)
const outputMtime = newestMtime(runtimeOutputPath)

if (outputMtime >= sourceMtime && outputMtime !== 0) {
  console.log('[bundle:native-sidecar:runtime] Bare runtime binary is up to date')
  process.exit(0)
}

fs.mkdirSync(runtimeOutputDir, { recursive: true })
fs.copyFileSync(runtimeBinary, runtimeOutputPath)
fs.chmodSync(runtimeOutputPath, 0o755)

console.log(`[bundle:native-sidecar:runtime] Copied Bare runtime to ${runtimeOutputPath}`)
