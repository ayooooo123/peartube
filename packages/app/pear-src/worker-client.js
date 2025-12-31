/**
 * PearTube Worker Client - Sets up HRPC communication with the backend worker
 *
 * Uses ES modules - load with <script type="module" src="./worker-client.js">
 */
import HRPC from '@peartube/spec'
import pipe from 'pear-pipe'

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
    console.log('[WorkerClient] Connecting to main-process backend via pear-pipe...')
    // Prefer Pear-provided pipe if available, otherwise fall back to pear-pipe().
    // (Some Pear versions expose the runtime pipe on Pear.pipe().)
    this.pipe = (typeof Pear !== 'undefined' && typeof Pear.pipe === 'function')
      ? Pear.pipe()
      : pipe()
    if (!this.pipe) throw new Error('Failed to create pear pipe')

    // Create HRPC instance with the pipe
    console.log('[WorkerClient] Creating HRPC instance...')
    this.rpc = new HRPC(this.pipe)
    console.log('[WorkerClient] HRPC client initialized')
    
    // Debug: log available methods
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(this.rpc))
      .filter(m => !m.startsWith('_') && m !== 'constructor')
    console.log('[WorkerClient] Available RPC methods:', methods.join(', '))
    console.log('[WorkerClient] Has globalSearchVideos:', typeof this.rpc.globalSearchVideos)

    // Add error handler on the RPC
    if (this.rpc.on) {
      this.rpc.on('error', (err) => {
        console.error('[WorkerClient] RPC error:', err)
      })
    }

    // Register event handlers (events are best-effort; do not rely on eventReady,
    // since main-process backend can start before UI loads and events can be missed).
    this.rpc.onEventReady?.((data) => {
      console.log('[WorkerClient] Received eventReady:', data)
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
      console.log('[WorkerClient] Video stats event received:', data?.stats?.progress + '%')
      window.dispatchEvent(new CustomEvent('pearVideoStats', { detail: data }))
    })

    this.rpc.onEventCastDeviceFound?.((data) => {
      window.dispatchEvent(new CustomEvent('pearCastDeviceFound', { detail: data }))
    })

    this.rpc.onEventCastDeviceLost?.((data) => {
      window.dispatchEvent(new CustomEvent('pearCastDeviceLost', { detail: data }))
    })

    this.rpc.onEventCastPlaybackState?.((data) => {
      window.dispatchEvent(new CustomEvent('pearCastPlaybackState', { detail: data }))
    })

    this.rpc.onEventCastTimeUpdate?.((data) => {
      window.dispatchEvent(new CustomEvent('pearCastTimeUpdate', { detail: data }))
    })

    this.pipe.on('end', () => {
      console.log('[WorkerClient] Pipe ended')
      this.isConnected = false
    })

    this.pipe.on('error', (err) => {
      console.error('[WorkerClient] Pipe error:', err)
    })

    // Handshake: request status to confirm readiness (and get blob server port).
    const statusPromise = this.rpc.getStatus({})
    const status = await Promise.race([
      statusPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('RPC init timeout')), 15000))
    ])
    const blobServerPort = status?.status?.blobServerPort || null
    this.isConnected = true
    this.blobServerPort = blobServerPort
    console.log('[WorkerClient] Connected. blobServerPort:', this.blobServerPort)
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
