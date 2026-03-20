/**
 * PearTube Worker Client - Sets up HRPC communication with the backend worker
 *
 * Uses ES modules - load with <script type="module" src="./worker-client.js">
 */
import pipe from 'pear-pipe'
import { createProtocolClient, PROTOCOL_EVENTS } from '@peartube/protocol'

const DOM_EVENT_NAMES = Object.freeze({
  [PROTOCOL_EVENTS.UPLOAD_PROGRESS]: 'pearUploadProgress',
  [PROTOCOL_EVENTS.FEED_UPDATED]: 'pearFeedUpdate',
  [PROTOCOL_EVENTS.VIDEO_STATS]: 'pearVideoStats',
  [PROTOCOL_EVENTS.CAST_DEVICE_FOUND]: 'pearCastDeviceFound',
  [PROTOCOL_EVENTS.CAST_DEVICE_LOST]: 'pearCastDeviceLost',
  [PROTOCOL_EVENTS.CAST_PLAYBACK_STATE]: 'pearCastPlaybackState',
  [PROTOCOL_EVENTS.CAST_TIME_UPDATE]: 'pearCastTimeUpdate'
})

class WorkerClient {
  constructor() {
    this.pipe = null
    this.client = null
    this.rpc = null
    this.isConnected = false
    this._initPromise = null
    this.blobServerPort = null
    this._protocolUnsubscribes = []
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

    this._initPromise = this._doInitialize().finally(() => {
      this._initPromise = null
    })
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

    // Create shared protocol client on top of the pipe.
    console.log('[WorkerClient] Creating shared protocol client...')
    this.client = createProtocolClient({ stream: this.pipe })
    this.rpc = this.client.rpc
    console.log('[WorkerClient] HRPC client initialized')
    
    // Debug: log available methods
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(this.rpc))
      .filter(m => !m.startsWith('_') && m !== 'constructor')
    console.log('[WorkerClient] Available RPC methods:', methods.join(', '))
    console.log('[WorkerClient] Has globalSearchVideos:', typeof this.rpc.globalSearchVideos)

    this.#bindProtocolEvents()

    this.pipe.on('end', () => {
      console.log('[WorkerClient] Pipe ended')
      this.isConnected = false
    })

    this.pipe.on('error', (err) => {
      console.error('[WorkerClient] Pipe error:', err)
    })

    // Handshake: request status through the shared protocol client.
    const ready = await Promise.race([
      this.client.ready(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('RPC init timeout')), 15000))
    ])
    this.isConnected = true
    this.blobServerPort = ready?.blobServerPort ?? null
    console.log('[WorkerClient] Connected. blobServerPort:', this.blobServerPort)
  }

  #bindProtocolEvents() {
    this.#clearProtocolSubscriptions()

    this._protocolUnsubscribes = [
      this.client.events.on(PROTOCOL_EVENTS.HOST_ERROR, (data) => {
        console.error('[WorkerClient] Backend error:', data?.message)
      }),
      this.client.events.on(PROTOCOL_EVENTS.LOG, (data) => {
        const message = data?.message ?? data
        console.log('[WorkerClient] Backend log:', message)
      }),
      this.client.events.on(PROTOCOL_EVENTS.TRANSPORT_CLOSED, (data) => {
        this.isConnected = false
        console.log('[WorkerClient] Transport closed:', data?.reason || 'unknown')
      })
    ]

    for (const [eventName, domEventName] of Object.entries(DOM_EVENT_NAMES)) {
      this._protocolUnsubscribes.push(
        this.client.events.on(eventName, (data) => {
          if (domEventName === 'pearUploadProgress') {
            console.log('[WorkerClient] Upload progress:', data?.progress, '%')
          }
          if (domEventName === 'pearFeedUpdate') {
            console.log('[WorkerClient] Feed update:', data?.action)
          }
          if (domEventName === 'pearVideoStats') {
            console.log('[WorkerClient] Video stats event received:', data?.stats?.progress + '%')
          }
          window.dispatchEvent(new CustomEvent(domEventName, { detail: data }))
        })
      )
    }
  }

  #clearProtocolSubscriptions() {
    for (const unsubscribe of this._protocolUnsubscribes) {
      try {
        unsubscribe()
      } catch {}
    }
    this._protocolUnsubscribes = []
  }

  async connect() {
    await this.initialize()

    if (!this.pipe || !this.client) {
      throw new Error('Worker client transport is not initialized')
    }

    return {
      stream: this.pipe,
      client: this.client,
      terminate: async () => {
        this.close()
      }
    }
  }

  getRpc() {
    return this.rpc
  }

  getClient() {
    return this.client
  }

  close() {
    this.#clearProtocolSubscriptions()
    if (this.pipe) {
      this.pipe.destroy()
    }
    this.pipe = null
    this.client = null
    this.rpc = null
    this.isConnected = false
    this.blobServerPort = null
    this._initPromise = null
  }
}

// Only initialize on Pear desktop
if (typeof Pear !== 'undefined') {
  window.PearWorkerClient = new WorkerClient()
  console.log('[WorkerClient] PearTube HRPC client ready')
}
