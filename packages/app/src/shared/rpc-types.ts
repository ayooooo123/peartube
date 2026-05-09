/**
 * Electrobun RPC types for PearTube desktop.
 *
 * The renderer communicates with the Bare worker via HRPC/Protomux.
 * Bun just relays raw binary chunks between them — no knowledge of
 * the 50+ RPC methods. This keeps the surface tiny.
 */
export type PearTubeRPC = {
  // Handled by Bun (renderer calls these)
  bun: {
    requests: {
      startWorker: { params: { specifier: string }; response: { ok: boolean } }
      viewReady: { params: {}; response: { blobServerPort: number | null } }
    }
    messages: {
      workerWrite: { specifier: string; data: number[] }
    }
  }
  // Handled by Renderer (Bun calls these)
  webview: {
    requests: {}
    messages: {
      onWorkerIPC: { specifier: string; data: number[] }
      onWorkerStdout: { specifier: string; data: string }
      onWorkerStderr: { specifier: string; data: string }
      onWorkerExit: { specifier: string; code: number }
    }
  }
}
