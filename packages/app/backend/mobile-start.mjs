/* eslint-disable no-empty, @typescript-eslint/no-require-imports */
import { startHost } from '@peartube/host/start-host'

function resolveMobileStoragePath(providedStoragePath) {
  if (providedStoragePath) return providedStoragePath

  let bareStorageDir = ''
  try {
    if (typeof require === 'function') {
      bareStorageDir = require('bare-storage').persistent()
    }
  } catch {}

  const bare = globalThis.Bare
  return bare?.argv?.[0] || bareStorageDir || ''
}

export function parseMobileLaunchArgsForTest(args = []) {
  const candidates = [0, 1]
  for (const index of candidates) {
    const arg = args[index]
    if (typeof arg !== 'string' || !arg.trim().startsWith('{')) continue
    try {
      const parsed = JSON.parse(arg)
      if (parsed?.__peartubeLaunchOptions === true) {
        return { launchOptions: parsed, workerArgs: [...args.slice(0, index), ...args.slice(index + 1)].filter((value) => value !== 'mobile-entry') }
      }
    } catch {}
  }

  const workerArgs = args[0] === 'mobile-entry' ? args.slice(1) : args
  return { launchOptions: null, workerArgs }
}

async function missingCreateBackendImpl() {
  throw new Error('startMobileBackend requires createBackendImpl outside the mobile runtime entry')
}

export async function startMobileBackend(options = {}) {
  const bare = globalThis.Bare
  const {
    storagePath: providedStoragePath,
    stream = globalThis.BareKit?.IPC,
    entrypoint = 'mobile-entry',
    args = Array.isArray(bare?.argv) ? bare.argv.slice(1) : [],
    startHostImpl = startHost,
    createBackendImpl = missingCreateBackendImpl,
    attachMobileHandlersImpl,
    attachCastHandlersImpl
  } = options

  const storagePath = resolveMobileStoragePath(providedStoragePath)

  return startHostImpl({
    platform: 'mobile',
    storagePath,
    entrypoint,
    args,
    stream,
    createBackendImpl: async (hostOptions) => {
      const backendSession = await createBackendImpl({
        ...hostOptions,
        storagePath: hostOptions.storagePath || storagePath,
        stream: hostOptions.stream || stream,
        args: hostOptions.args ?? args
      })

      if (backendSession?.backend && typeof attachMobileHandlersImpl === 'function') {
        attachMobileHandlersImpl(backendSession.backend, backendSession.handlerDeps ?? {})
      }

      if (backendSession?.backend && typeof attachCastHandlersImpl === 'function') {
        attachCastHandlersImpl(backendSession.backend, backendSession.handlerDeps ?? {})
      }

      return backendSession
    }
  })
}
