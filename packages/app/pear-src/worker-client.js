/**
 * PearTube Worker Client - Sets up HRPC communication with the backend worker
 *
 * Uses ES modules - load with <script type="module" src="./worker-client.js">
 */
import HRPC from '@peartube/spec'
import run from 'pear-run'

class WorkerClient {
  constructor() {
    this.pipe = null
    this.rpc = null
    this.isConnected = false
    this._initPromise = null
    this._readyResolve = null
    this.blobServerPort = null
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

    // Spawn worker using pear-run
    this.pipe = run(workerPath)

    if (!this.pipe) {
      this._initPromise = null
      throw new Error('Failed to create worker pipe')
    }

    // Create HRPC instance with the pipe
    console.log('[WorkerClient] Creating HRPC instance...')
    this.rpc = new HRPC(this.pipe)
    console.log('[WorkerClient] HRPC client initialized')

    // Add error handler on the RPC
    if (this.rpc.on) {
      this.rpc.on('error', (err) => {
        console.error('[WorkerClient] RPC error:', err)
      })
    }

    // Wait for eventReady from worker
    const readyPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._readyResolve = null
        reject(new Error('Worker init timeout'))
      }, 60000)

      this._readyResolve = (data) => {
        clearTimeout(timeout)
        this._readyResolve = null
        this.isConnected = true
        this.blobServerPort = data?.blobServerPort
        console.log('[WorkerClient] Worker ready, blobServerPort:', this.blobServerPort)
        resolve()
      }
    })

    // Register event handlers
    console.log('[WorkerClient] Registering onEventReady handler...')
    this.rpc.onEventReady((data) => {
      console.log('[WorkerClient] Received eventReady:', data)
      if (this._readyResolve) {
        this._readyResolve(data)
      }
    })

    this.rpc.onEventError((data) => {
      console.error('[WorkerClient] Backend error:', data?.message)
    })

    this.rpc.onEventUploadProgress((data) => {
      console.log('[WorkerClient] Upload progress:', data?.progress, '%')
      window.dispatchEvent(new CustomEvent('pearUploadProgress', { detail: data }))
    })

    this.rpc.onEventFeedUpdate((data) => {
      console.log('[WorkerClient] Feed update:', data?.action)
      window.dispatchEvent(new CustomEvent('pearFeedUpdate', { detail: data }))
    })

    this.rpc.onEventVideoStats((data) => {
      window.dispatchEvent(new CustomEvent('pearVideoStats', { detail: data }))
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

// Only initialize on Pear desktop
if (typeof Pear !== 'undefined') {
  window.PearWorkerClient = new WorkerClient()
  console.log('[WorkerClient] PearTube HRPC client ready')
}
