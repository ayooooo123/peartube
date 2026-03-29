import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import build from 'bare-build'

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageRoot = dirname(__dirname)

const SUPPORTED_HOSTS = new Set(['linux-x64', 'linux-arm64'])
const host = process.env.RELAY_STANDALONE_HOST || process.argv[2] || defaultHost()

if (!SUPPORTED_HOSTS.has(host)) {
  throw new Error(`Unsupported standalone relay host "${host}"`)
}

const outputDir = join(packageRoot, 'dist', 'standalone', host)
const outputPath = join(outputDir, 'peartube-relay')

rmSync(outputDir, { recursive: true, force: true })
mkdirSync(outputDir, { recursive: true })

for await (const resource of build(join(packageRoot, 'bare-bin.js'), {
  base: packageRoot,
  hosts: [host],
  standalone: true,
  out: outputDir,
  name: 'peartube-relay'
})) {
  if (resource?.path) {
    process.stdout.write(`built ${resource.path}\n`)
  }
}

if (!existsSync(outputPath)) {
  throw new Error(`Expected standalone relay executable at ${outputPath}`)
}

chmodSync(outputPath, 0o755)
process.stdout.write(`${outputPath}\n`)

function defaultHost() {
  switch (process.arch) {
    case 'x64':
      return 'linux-x64'
    case 'arm64':
      return 'linux-arm64'
    default:
      throw new Error(`Unsupported local architecture "${process.arch}" for relay standalone build`)
  }
}
