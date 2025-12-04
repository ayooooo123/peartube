/**
 * Worker Client - UI-side RPC to worker
 *
 * Spawns workers with newline-delimited JSON protocol.
 * Uses Pear IPC API (preferred) or falls back to Pear.worker.run (deprecated).
 */
'use strict'

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
    this.isConnected = false
    this.pendingRequests = new Map()
    this.progressCallbacks = new Map() // requestId -> callback
    this.messageBuffer = ''
    this.reqId = 0
    this._initCheck = null
    this._initPromise = null
  }

  async initialize() {
    if (this.pipe) {
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

    // Build worker path - use simple string concatenation to avoid path module
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

    // Handle incoming data with newline-delimited JSON
    this.pipe.on('data', (data) => {
      this.messageBuffer += Buffer.from(data).toString()
      this._processMessages()
    })

    this.pipe.on('end', () => {
      console.log('[WorkerClient] Pipe ended')
      this.isConnected = false
    })

    this.pipe.on('error', (err) => {
      console.error('[WorkerClient] Pipe error:', err)
    })

    // Wait for worker_initialized message
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._initCheck = null
        this._initPromise = null
        reject(new Error('Worker init timeout'))
      }, 30000)

      this._initCheck = (msg) => {
        if (msg.type === 'worker_initialized') {
          clearTimeout(timeout)
          this._initCheck = null
          this.isConnected = true
          console.log('[WorkerClient] Worker initialized')
          resolve()
          return true
        }
        return false
      }
    })

    this._initPromise = null
  }

  _processMessages() {
    const messages = this.messageBuffer.split('\n')
    this.messageBuffer = messages.pop() || ''

    for (const msg of messages) {
      if (!msg.trim()) continue

      try {
        const parsed = JSON.parse(msg)
        console.log('[WorkerClient] Received:', parsed.type || parsed.id)

        // Check if this is the init message
        if (this._initCheck && this._initCheck(parsed)) {
          continue
        }

        // Handle progress events
        if (parsed.type === 'upload_progress') {
          const callback = this.progressCallbacks.get(parsed.requestId)
          if (callback) {
            callback(parsed.progress, parsed.bytesWritten, parsed.totalBytes)
          }
          continue
        }

        // Handle response to pending request
        if (parsed.id) {
          const pending = this.pendingRequests.get(parsed.id)
          if (pending) {
            this.pendingRequests.delete(parsed.id)
            this.progressCallbacks.delete(parsed.id) // Clean up progress callback
            if (parsed.success === false) {
              pending.reject(new Error(parsed.error || 'Unknown error'))
            } else {
              pending.resolve(parsed.data)
            }
          }
        }
      } catch (e) {
        console.error('[WorkerClient] Parse error:', e)
      }
    }
  }

  async call(command, data = {}, onProgress = null) {
    if (!this.isConnected) {
      await this.initialize()
    }

    if (!this.pipe || !this.isConnected) {
      throw new Error('Worker not connected')
    }

    const id = String(++this.reqId)

    // Register progress callback if provided
    if (onProgress) {
      this.progressCallbacks.set(id, onProgress)
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id)
        this.progressCallbacks.delete(id)
        reject(new Error('Request timeout'))
      }, 300000) // 5 min for uploads

      this.pendingRequests.set(id, {
        resolve: (data) => { clearTimeout(timeout); resolve(data) },
        reject: (err) => { clearTimeout(timeout); reject(err) }
      })

      const msg = JSON.stringify({ id, command, data }) + '\n'
      this.pipe.write(msg)
    })
  }

  close() {
    if (this.pipe) {
      this.pipe.write(JSON.stringify({ type: 'exit' }) + '\n')
      this.pipe.destroy()
      this.pipe = null
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
