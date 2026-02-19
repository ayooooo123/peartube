type ThumbnailRequest = { channelKey: string; videoId: string }

type StatusResponse = {
  status?: {
    ready?: boolean
    blobServerPort?: number
  }
  blobServerPort?: number
}

export interface ThumbnailRPC {
  getStatus?: () => Promise<StatusResponse>
  getVideoThumbnail: (req: ThumbnailRequest) => Promise<{ exists?: boolean; url?: string | null; dataUrl?: string | null }>
}

const READY_TTL_MS = 30_000
const READY_ATTEMPTS = 5
const READY_TIMEOUT_MS = 1_500
const READY_RETRY_DELAY_MS = 250

const THUMBNAIL_ATTEMPTS = 4
const THUMBNAIL_TIMEOUT_MS = 2_500
const THUMBNAIL_RETRY_DELAY_MS = 300

const readinessCache = new WeakMap<object, { checkedAt: number; ready: boolean }>()
const readinessInFlight = new WeakMap<object, Promise<boolean>>()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ])
}

function hasValidPort(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

async function checkBackendReady(rpc: ThumbnailRPC, expectedPort: number | null | undefined): Promise<boolean> {
  if (typeof rpc.getStatus !== 'function') {
    return hasValidPort(expectedPort)
  }

  try {
    const status = await withTimeout(rpc.getStatus(), READY_TIMEOUT_MS)
    const statusPort = status?.status?.blobServerPort ?? status?.blobServerPort ?? null
    const readyFlag = status?.status?.ready
    const expectedOk = !hasValidPort(expectedPort) || statusPort === expectedPort
    const statusOk = hasValidPort(statusPort) && readyFlag !== false
    return statusOk && expectedOk
  } catch {
    return false
  }
}

export async function ensureThumbnailBackendReady(
  rpc: ThumbnailRPC | null | undefined,
  expectedPort: number | null | undefined
): Promise<boolean> {
  if (!rpc) return false

  const rpcKey = rpc as object
  const cached = readinessCache.get(rpcKey)
  if (cached?.ready && Date.now() - cached.checkedAt < READY_TTL_MS) {
    return true
  }

  const inflight = readinessInFlight.get(rpcKey)
  if (inflight) return inflight

  const readinessPromise = (async () => {
    let ready = false
    for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
      ready = await checkBackendReady(rpc, expectedPort)
      if (ready) break
      if (attempt < READY_ATTEMPTS - 1) {
        await sleep(READY_RETRY_DELAY_MS * (attempt + 1))
      }
    }
    readinessCache.set(rpcKey, { checkedAt: Date.now(), ready })
    return ready
  })()

  readinessInFlight.set(rpcKey, readinessPromise)

  try {
    return await readinessPromise
  } finally {
    readinessInFlight.delete(rpcKey)
  }
}

export async function fetchThumbnailUrlWithRetry(args: {
  rpc: ThumbnailRPC | null | undefined
  channelKey: string
  videoId: string
  expectedPort?: number | null
}): Promise<string | null> {
  const { rpc, channelKey, videoId, expectedPort } = args
  if (!rpc || !channelKey || !videoId) return null

  const backendReady = await ensureThumbnailBackendReady(rpc, expectedPort)
  if (!backendReady) return null

  for (let attempt = 0; attempt < THUMBNAIL_ATTEMPTS; attempt += 1) {
    try {
      const response = await withTimeout(
        rpc.getVideoThumbnail({ channelKey, videoId }),
        THUMBNAIL_TIMEOUT_MS + attempt * 500
      )
      const url = response?.dataUrl || response?.url
      if (response?.exists && url) {
        return url
      }
    } catch {}

    if (attempt < THUMBNAIL_ATTEMPTS - 1) {
      await sleep(THUMBNAIL_RETRY_DELAY_MS * (attempt + 1))
    }
  }

  return null
}
