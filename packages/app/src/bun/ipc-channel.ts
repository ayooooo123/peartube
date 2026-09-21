/**
 * PearTube Desktop — IPC WebSocket authorization + relay handlers.
 *
 * The Bun main process exposes one loopback WebSocket that is the renderer's
 * entire path to the Bare backend worker: binary frames are raw HRPC bytes on
 * the worker's IPC pipe, text frames drive the Pear updater (`pear:apply`
 * swaps the app bundle on disk, `pear:restart` relaunches it).
 *
 * Loopback is not a trust boundary. WebSocket upgrades are exempt from the
 * same-origin policy, so any page the user has open can connect to
 * `ws://127.0.0.1:<port>`, and any local process that finds the ephemeral port
 * can too. The channel therefore carries a per-launch capability: minted in
 * memory at startup, never logged and never written to disk, handed to the
 * trusted view through the only bootstrap the shell fully controls — the URL
 * it navigates the window to (see `createWindow`). A caller that cannot
 * present it is refused before `server.upgrade()`, so no unauthorized socket
 * is ever attached to the worker.
 *
 * Everything here is free of Bun-only globals precisely so the gate can be
 * exercised directly under `node --test`.
 */

// Carried as a query parameter because the browser WebSocket constructor
// cannot set request headers, and the same parameter works for a non-browser
// caller. The view strips it from `window.location` the moment it reads it.
export const IPC_CAPABILITY_PARAM = '__ptcap'

const CAPABILITY_BYTES = 32

export type IpcClient = {
  send(data: string): unknown
  readyState: number
}

export type IpcSocketData = { worker?: IpcWorker; forwardWorkerData?: (d: Buffer) => void }

export type IpcSocket = IpcClient & {
  sendBinary(data: unknown): unknown
  close(code: number, reason?: string): unknown
  // Bun's per-socket slot: `open` parks the worker + its listener here so
  // `close` can unhook exactly the listener this socket installed.
  data?: IpcSocketData
}

export type IpcWorker = {
  on(event: 'data', listener: (d: Buffer) => void): unknown
  off?(event: 'data', listener: (d: Buffer) => void): unknown
  removeListener?(event: 'data', listener: (d: Buffer) => void): unknown
  write(data: Buffer): unknown
}

export type IpcUpgradeRejection = 'missing-capability' | 'invalid-capability' | 'forbidden-origin'

export type IpcUpgradeDecision =
  | { allowed: true }
  | { allowed: false; reason: IpcUpgradeRejection }

/** 32 bytes of CSPRNG output, hex — one per launch, memory only. */
export function mintIpcCapability(): string {
  const bytes = new Uint8Array(CAPABILITY_BYTES)
  globalThis.crypto.getRandomValues(bytes)
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

// Length is not secret (it is fixed by mintIpcCapability), so folding it into
// the accumulator is safe; the per-character loop then runs over the longer of
// the two strings and never short-circuits on the first differing byte.
function constantTimeEquals(a: string, b: string): boolean {
  let diff = a.length ^ b.length
  const len = a.length > b.length ? a.length : b.length
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0)
  }
  return diff === 0
}

/**
 * A capability alone authorizes a non-browser caller. A browser caller sends
 * an `Origin` it cannot forge, so when one is present it must also be the
 * shell's own server origin — a capability that leaked into some other page
 * still buys that page nothing.
 */
export function authorizeIpcUpgrade(
  request: { url: string; origin?: string | null },
  policy: { capability: string; allowedOrigins: readonly string[] },
): IpcUpgradeDecision {
  let presented = ''
  try {
    presented = new URL(request.url).searchParams.get(IPC_CAPABILITY_PARAM) ?? ''
  } catch { /* unparseable request URL carries no capability */ }
  if (!presented) return { allowed: false, reason: 'missing-capability' }
  if (!policy.capability || !constantTimeEquals(presented, policy.capability)) {
    return { allowed: false, reason: 'invalid-capability' }
  }

  const origin = request.origin ?? ''
  if (origin && !policy.allowedOrigins.includes(origin)) {
    return { allowed: false, reason: 'forbidden-origin' }
  }

  return { allowed: true }
}

export type IpcChannelDeps = {
  /** The launch capability every upgrade must present. */
  capability: string
  /** The shell's own server origins, read per request (ports are ephemeral). */
  allowedOrigins(): readonly string[]
  /** Live sockets, so the update bridge can broadcast to the view. */
  clients: Set<IpcClient>
  /** First text frame every accepted socket receives. */
  greeting(): string
  /** Spawns (or returns) the backend worker for an accepted socket. */
  startWorker(): IpcWorker
  /** The already-running backend worker, if any — never spawns one. */
  runningWorker(): IpcWorker | undefined
  /** Text frames are this process's own control channel, not HRPC bytes. */
  onControlFrame(ws: IpcClient, raw: string): void
}

function removeWorkerDataListener(worker: IpcWorker, listener: (d: Buffer) => void) {
  if (!worker || !listener) return
  if (typeof worker.off === 'function') {
    worker.off('data', listener)
    return
  }
  if (typeof worker.removeListener === 'function') {
    worker.removeListener('data', listener)
  }
}

/**
 * The `fetch` + `websocket` halves of the Bun.serve config. Split out of the
 * launcher so the authorization gate can be driven against a recording worker
 * stub instead of a live Bare process.
 */
export function createIpcChannelHandlers(deps: IpcChannelDeps) {
  return {
    // `options` is Bun's per-socket data slot, which this channel does not
    // use; naming it keeps a real Bun `Server` assignable to this parameter.
    fetch(
      req: Request,
      server: { upgrade(request: Request, options?: unknown): boolean },
    ): Response | undefined {
      const decision = authorizeIpcUpgrade(
        { url: req.url, origin: req.headers.get('origin') },
        { capability: deps.capability, allowedOrigins: deps.allowedOrigins() },
      )
      if (!decision.allowed) {
        // The reason, never the capability: this line goes to the app log.
        console.error('[main] IPC WebSocket upgrade rejected:', decision.reason)
        return new Response('Forbidden', { status: 403 })
      }
      if (server.upgrade(req)) return undefined
      return new Response('WebSocket only', { status: 426 })
    },

    websocket: {
      open(ws: IpcSocket) {
        console.log('[main] IPC WebSocket connected')
        deps.clients.add(ws)
        ws.send(deps.greeting())
        try {
          const worker = deps.startWorker()
          // Pipe: worker IPC → WebSocket → renderer
          const forwardWorkerData = (d: Buffer) => {
            if (ws.readyState === 1) ws.sendBinary(d)
          }
          Object.assign(ws, { data: { worker, forwardWorkerData } })
          worker.on('data', forwardWorkerData)
        } catch {
          console.error('[main] IPC WebSocket worker startup failed')
          try { ws.close(1011, 'worker startup failed') } catch { /* best effort */ }
        }
      },

      message(ws: IpcSocket, message: string | ArrayBuffer | Uint8Array) {
        if (typeof message === 'string') {
          deps.onControlFrame(ws, message)
          return
        }
        // Pipe: renderer → WebSocket → worker IPC. Both branches copy: the
        // frame's backing memory belongs to the server and may be reused as
        // soon as this handler returns.
        const worker = deps.runningWorker()
        if (worker) {
          const bytes = message instanceof ArrayBuffer ? new Uint8Array(message) : message
          worker.write(Buffer.from(bytes))
        }
      },

      close(ws: IpcSocket) {
        deps.clients.delete(ws)
        const data = ws.data || {}
        const worker = data.worker || deps.runningWorker()
        const forwardWorkerData = data.forwardWorkerData
        if (worker && forwardWorkerData) {
          removeWorkerDataListener(worker, forwardWorkerData)
        }
        console.log('[main] IPC WebSocket closed')
      },
    },
  }
}
