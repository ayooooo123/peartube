type ThumbnailRequest = {
  channelKey: string
  videoId: string
  // Blob refs from feed previews. Discovered channels whose metadata is not
  // loaded locally have no resolvable video record backend-side, so without
  // forwarding these refs their thumbnails never resolve on mobile.
  thumbnailBlobId?: string | null
  thumbnailBlobsCoreKey?: string | null
  // Stored MIME type from the feed preview. Forwarded so the blob server
  // serves the correct Content-Type (JPEG today, WebP/PNG if added later)
  // instead of falling back to a default that may not match the bytes.
  thumbnailMimeType?: string | null
}

export type ThumbnailBlobRefs = {
  thumbnailBlobId?: string | null
  thumbnailBlobsCoreKey?: string | null
  thumbnailMimeType?: string | null
}

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

const THUMBNAIL_ATTEMPTS = 3
// The backend handler can legitimately spend up to 1.5s on a bounded network
// wait (plus channel/bee lookups) before answering, and on Android cold start
// the worklet is saturated by P2P bootstrap. A 1.5s timeout abandoned replies
// that were about to arrive, so feed cards stayed on placeholders.
const THUMBNAIL_TIMEOUT_MS = 4_000
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

async function attemptThumbnailFetch(
  rpc: ThumbnailRPC,
  request: ThumbnailRequest,
  timeoutMs: number
): Promise<string | null> {
  try {
    const response = await withTimeout(rpc.getVideoThumbnail(request), timeoutMs)
    // Mobile inlines the thumbnail bytes as a data: URL (the loopback blob-server
    // URL won't render in Android image clients); rendered via expo-image, whose
    // Glide backend paints base64 reliably. Desktop returns only the URL.
    const url = response?.dataUrl || response?.url
    if (response?.exists && url) return url
  } catch {}
  return null
}

export async function fetchThumbnailUrlWithRetry(args: {
  rpc: ThumbnailRPC | null | undefined
  channelKey: string
  videoId: string
  expectedPort?: number | null
  blobRefs?: ThumbnailBlobRefs | null
}): Promise<string | null> {
  const { rpc, channelKey, videoId, expectedPort, blobRefs } = args
  if (!rpc || !channelKey || !videoId) return null

  const request: ThumbnailRequest = {
    channelKey,
    videoId,
    thumbnailBlobId: blobRefs?.thumbnailBlobId || undefined,
    thumbnailBlobsCoreKey: blobRefs?.thumbnailBlobsCoreKey || undefined,
    thumbnailMimeType: blobRefs?.thumbnailMimeType || undefined,
  }

  // Fast path: fetch immediately. Feed previews already carry thumbnail refs
  // backend-side, so the first attempt usually succeeds without paying for a
  // readiness probe first.
  const firstUrl = await attemptThumbnailFetch(rpc, request, THUMBNAIL_TIMEOUT_MS)
  if (firstUrl) {
    readinessCache.set(rpc as object, { checkedAt: Date.now(), ready: true })
    return firstUrl
  }

  // Slow path: the immediate fetch failed — gate the remaining retries on
  // backend readiness so we don't hammer a worklet that is still booting.
  const backendReady = await ensureThumbnailBackendReady(rpc, expectedPort)
  if (!backendReady) return null

  for (let attempt = 1; attempt < THUMBNAIL_ATTEMPTS; attempt += 1) {
    await sleep(THUMBNAIL_RETRY_DELAY_MS * attempt)
    const url = await attemptThumbnailFetch(rpc, request, THUMBNAIL_TIMEOUT_MS + attempt * 1000)
    if (url) return url
  }

  return null
}
