import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageRoot = dirname(__dirname)
const standaloneRoot = join(packageRoot, 'dist', 'standalone')
const dockerRoot = join(packageRoot, 'dist', 'docker')

const mappings = [
  ['linux-x64', 'linux-amd64'],
  ['linux-arm64', 'linux-arm64']
]

rmSync(dockerRoot, { recursive: true, force: true })

let copied = 0

for (const [sourceHost, dockerHost] of mappings) {
  const source = join(standaloneRoot, sourceHost, 'peartube-relay')

  if (!existsSync(source)) continue

  const target = join(dockerRoot, dockerHost, 'peartube-relay')

  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(source, target)
  chmodSync(target, 0o755)
  copied += 1
  process.stdout.write(`${target}\n`)
}

if (copied === 0) {
  throw new Error('No standalone relay artifacts found to prepare for Docker packaging')
}
