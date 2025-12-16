/* global Pear */
import Runtime from 'pear-electron'
import Bridge from 'pear-bridge'

console.log('[PearTube] Booting Pear desktop runtime...')

const bridge = new Bridge()
await bridge.ready()
console.log('[PearTube] Bridge ready')

const runtime = new Runtime()
const pipe = await runtime.start({ bridge })
console.log('[PearTube] Runtime started, starting backend on main pipe + opening UI window')

// Pear v2 best practice:
// - main process owns backend work
// - UI connects over the runtime pipe (no pear-run / extra process)
globalThis.__PEARTUBE_HRPC_PIPE__ = pipe
try {
  // This module registers HRPC handlers on the provided pipe.
  // It is built into pear/build/workers/core/index.js during the Pear build pipeline.
  await import('./build/workers/core/index.js')
  console.log('[PearTube] Backend HRPC server started')
} catch (err) {
  console.error('[PearTube] Failed to start backend HRPC server:', err?.message || err)
}

pipe.on('close', () => {
  Pear.exit()
})
