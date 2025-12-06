/**
 * Worker Client - UI-side HRPC communication with worker
 *
 * Spawns workers and uses HRPC for typed binary RPC.
 * Uses Pear IPC API (preferred) or falls back to Pear.worker.run (deprecated).
 */
'use strict'

// Load HRPC in Pear renderer environment
const HRPC = require('@peartube/spec')

// Helper to spawn worker - mirrors pear-run's renderer logic
function runWorker(path, args) {
  // Try new IPC API first (non-deprecated)
  if (typeof Pear[Pear.constructor.IPC]?.run === 'function') {
    return Pear[Pear.constructor.IPC].run(path, args)
  }
  // Fall back to deprecated API
  return Pear.worker.run(path, args)
}

class WorkerClient {
  constructor() {
    this.pipe = null
    this.rpc = null
    this.isConnected = false
    this._initPromise = null
    this._readyResolve = null
  }

  async initialize() {
    if (this.rpc) {
      console.log('[WorkerClient] Already initialized')
      return
    }

    if (this._initPromise) {
      console.log('[WorkerClient] Waiting for existing init...')
      return this._initPromise
    }

    this._initPromise = this._doInitialize()
    return this._initPromise
  }

  async _doInitialize() {
    const config = Pear.config

    // Build worker path
    const workerPath = Pear.key
      ? `${config.applink || ''}/build/workers/core/index.js`
      : `${config.dir || ''}/build/workers/core/index.js`.replace(/\/+/g, '/')

    console.log('[WorkerClient] Starting worker:', workerPath)

    // Spawn worker using IPC API or fallback
    this.pipe = runWorker(workerPath, [])

    if (!this.pipe) {
      this._initPromise = null
      throw new Error('Failed to create worker pipe')
    }

    // Create HRPC instance with the pipe
    this.rpc = new HRPC(this.pipe)
    console.log('[WorkerClient] HRPC client initialized')

    // Wait for eventReady from worker
    const readyPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._readyResolve = null
        reject(new Error('Worker init timeout'))
      }, 30000)

      this._readyResolve = (data) => {
        clearTimeout(timeout)
        this._readyResolve = null
        this.isConnected = true
        console.log('[WorkerClient] Worker ready, blobServerPort:', data?.blobServerPort)
        resolve(data)
      }
    })

    // Register event handlers
    this.rpc.onEventReady((data) => {
      if (this._readyResolve) {
        this._readyResolve(data)
      }
    })

    this.rpc.onEventError((data) => {
      console.error('[WorkerClient] Backend error:', data?.message)
    })

    this.rpc.onEventUploadProgress((data) => {
      console.log('[WorkerClient] Upload progress:', data?.progress, '%')
      // Emit event for UI to handle
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('pearUploadProgress', { detail: data }))
      }
    })

    this.rpc.onEventFeedUpdate((data) => {
      console.log('[WorkerClient] Feed update:', data?.action)
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('pearFeedUpdate', { detail: data }))
      }
    })

    this.rpc.onEventVideoStats((data) => {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('pearVideoStats', { detail: data }))
      }
    })

    this.pipe.on('end', () => {
      console.log('[WorkerClient] Pipe ended')
      this.isConnected = false
    })

    this.pipe.on('error', (err) => {
      console.error('[WorkerClient] Pipe error:', err)
    })

    // Wait for ready event
    await readyPromise
    this._initPromise = null
  }

  // Expose HRPC methods directly - the RPC instance has typed methods
  // Methods: getStatus, createIdentity, getIdentities, listVideos, etc.
  async call(methodName, args = {}) {
    if (!this.isConnected) {
      await this.initialize()
    }

    if (!this.rpc || !this.isConnected) {
      throw new Error('Worker not connected')
    }

    // Call the HRPC method directly
    if (typeof this.rpc[methodName] === 'function') {
      return this.rpc[methodName](args)
    }

    throw new Error(`Unknown HRPC method: ${methodName}`)
  }

  // Get the raw RPC instance for direct access to all methods
  getRpc() {
    return this.rpc
  }

  close() {
    if (this.pipe) {
      this.pipe.destroy()
      this.pipe = null
      this.rpc = null
      this.isConnected = false
    }
  }
}

// Singleton instance
const workerClient = new WorkerClient()

// Export for use in the app
if (typeof window !== 'undefined') {
  window.PearWorkerClient = workerClient
}
