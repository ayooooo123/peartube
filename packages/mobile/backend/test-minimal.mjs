/**
 * Truly minimal test backend - no native dependencies
 */

import RPC from 'bare-rpc'
import b4a from 'b4a'

// Test basic BareKit access
console.log('[TestBackend] Starting minimal test backend')

try {
  console.log('[TestBackend] BareKit available:', typeof BareKit)
  console.log('[TestBackend] BareKit.IPC:', typeof BareKit.IPC)
  console.log('[TestBackend] Bare.argv:', Bare.argv)
} catch (e) {
  console.error('[TestBackend] BareKit access error:', e.message)
}

// BareKit.IPC for IPC, Bare.argv for arguments (per docs)
const { IPC } = BareKit
const storagePath = Bare.argv[0] || ''

console.log('[TestBackend] Bare.argv:', Bare.argv)
console.log('[TestBackend] Storage path:', storagePath)

// Setup basic RPC
const rpc = new RPC(IPC, (req) => {
  const command = req.command
  console.log('[TestBackend] RPC received:', command)

  const response = rpc.request(command)
  response.send(Buffer.from(JSON.stringify({ success: true, test: 'minimal backend works' })))
})

// Signal ready after a short delay to ensure everything is initialized
// Using numeric command ID 100 for EVENT_READY (bare-rpc requires uint)
setTimeout(() => {
  console.log('[TestBackend] Sending ready signal')
  const ready = rpc.request(100)  // EVENT_READY = 100
  ready.send(Buffer.from(JSON.stringify({ ready: true })))
}, 100)

console.log('[TestBackend] Minimal test backend initialized')
