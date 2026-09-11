import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_VERSION, HOST_ERROR_CODES } from '../src/contracts.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const contractsDtsPath = path.resolve(__dirname, '../src/contracts.d.ts')

export function renderContractsDts() {
  const errorCodesEntries = Object.keys(HOST_ERROR_CODES)
    .map((key) => `  readonly ${key}: '${HOST_ERROR_CODES[key]}'`)
    .join('\n')

  return `// Generated from packages/host/src/contracts.js - do not edit directly
export const PROTOCOL_VERSION: ${PROTOCOL_VERSION}

export const HOST_ERROR_CODES: {
${errorCodesEntries}
}

export function createHostError(
  code: string,
  message: string,
  options?: { cause?: unknown; retryable?: boolean }
): Error & { code: string; retryable: boolean; cause?: unknown }
`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rendered = renderContractsDts()
  if (process.argv.includes('--check')) {
    const existing = fs.readFileSync(contractsDtsPath, 'utf8')
    if (existing !== rendered) {
      console.error('contracts.d.ts is out of date with contracts.js')
      process.exit(1)
    }
  } else {
    fs.writeFileSync(contractsDtsPath, rendered, 'utf8')
  }
}
