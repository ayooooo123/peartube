import { createBackendRuntime } from './runtime.js'

export async function createBackend(opts = {}) {
  const runtime = createBackendRuntime(opts)
  const { backend, rpc } = await runtime.init()
  return {
    runtime,
    backend,
    rpc,
    destroy: runtime.dispose,
  }
}

export default {
  createBackend
}
