import fs from 'fs'
import path from 'path'

const packageRoot = path.resolve(import.meta.dirname, '..')
const repoRoot = path.resolve(packageRoot, '..', '..')

const sourceRoot = path.join(repoRoot, 'packages', 'bare-mpv', 'prebuilds')
const outputRoot = path.join(packageRoot, 'Resources', 'Generated', 'bare-mpv-prebuilds')

fs.rmSync(outputRoot, { recursive: true, force: true })
fs.mkdirSync(path.dirname(outputRoot), { recursive: true })
fs.cpSync(sourceRoot, outputRoot, {
  recursive: true,
  force: true,
})

console.log('[bundle:native-sidecar:mpv] Copied bare-mpv prebuilds into native resources')
