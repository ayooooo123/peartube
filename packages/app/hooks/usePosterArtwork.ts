import { useContext, useEffect, useMemo, useState } from 'react'
import { AppContext } from '@/lib/AppContext'
import { fetchThumbnailUrlWithRetry } from '@/lib/thumbnail'

/**
 * Cover art the publisher put in their own blob core. The catalog hands over a
 * reference rather than a locator so browsing never touches an outside origin:
 * an origin leaks who is watching what, is blockable, and is simply absent
 * offline. Resolving the reference through the local blob server keeps the
 * whole picture inside the swarm.
 */
export type PosterBlobRef = {
  posterBlobId?: string | null
  posterBlobsCoreKey?: string | null
  posterMimeType?: string | null
}

// A resolved URL points at the loopback blob server, which serves the same
// address for a given (core key, blob id) pair for as long as the process
// lives. Keeping them here means a rail scrolled out of view and back does not
// pay for the swarm round trip twice, and two cards sharing cover art resolve
// once between them.
// Replication is not instant: the publisher's core is discovered, connected and
// then read. These delays cover that without hammering a peer that is simply
// slow, and stop rather than retry forever on art that is genuinely gone.
const RETRY_DELAYS_MS = [1_500, 3_000, 6_000, 12_000, 20_000]

const resolvedPosters = new Map<string, string>()
const pendingPosters = new Map<string, Promise<string | null>>()

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function resolvePoster(
  cacheKey: string,
  rpc: unknown,
  expectedPort: number | null,
  ref: { blobId: string; blobsCoreKey: string; mimeType: string },
): Promise<string | null> {
  const done = resolvedPosters.get(cacheKey)
  if (done) return Promise.resolve(done)

  const inFlight = pendingPosters.get(cacheKey)
  if (inFlight) return inFlight

  const pending = fetchThumbnailUrlWithRetry({
    rpc: rpc as never,
    // The entity is a media-graph work, not a channel upload, so there is no
    // channel or video to name. The refs alone identify the blob.
    channelKey: '',
    videoId: '',
    expectedPort,
    blobRefs: {
      thumbnailBlobId: ref.blobId,
      thumbnailBlobsCoreKey: ref.blobsCoreKey,
      thumbnailMimeType: ref.mimeType || undefined,
    },
  }).then((url) => {
    pendingPosters.delete(cacheKey)
    if (url) resolvedPosters.set(cacheKey, url)
    return url
  }, () => {
    pendingPosters.delete(cacheKey)
    return null
  })

  pendingPosters.set(cacheKey, pending)
  return pending
}

/**
 * Returns the artwork URL a card should render for `item`.
 *
 * An entity carrying a blob reference resolves through the local blob server
 * and renders nothing at all until that lands — the placeholder the card
 * already draws, so the layout never shifts. Older claims that named an origin
 * keep rendering `fallbackUrl` unchanged.
 */
export function usePosterArtwork(item: unknown, fallbackUrl: string | null): string | null {
  const app = useContext(AppContext)
  const rpc = app?.rpc ?? null
  const expectedPort = app?.blobServerPort ?? null

  const ref = item as PosterBlobRef | null | undefined
  const blobId = trimmed(ref?.posterBlobId)
  const blobsCoreKey = trimmed(ref?.posterBlobsCoreKey)
  const mimeType = trimmed(ref?.posterMimeType)
  const cacheKey = blobId && blobsCoreKey ? `${blobsCoreKey}@${blobId}` : null

  // Kicked off during render as well as in the effect: a static render (and the
  // regression test that measures it) never runs effects, and the module-level
  // maps collapse the duplicate into one in-flight request.
  useMemo(
    () => (cacheKey && rpc ? resolvePoster(cacheKey, rpc, expectedPort, { blobId, blobsCoreKey, mimeType }) : null),
    [cacheKey, rpc, expectedPort, blobId, blobsCoreKey, mimeType],
  )

  const [resolved, setResolved] = useState<{ key: string; url: string } | null>(null)

  // A blob that has not replicated yet is the normal first answer, not a
  // failure: the core was only just discovered on the swarm. Giving up after
  // one miss leaves a permanent placeholder for art that arrives seconds later,
  // so keep asking on a widening delay for as long as the card is on screen.
  useEffect(() => {
    if (!cacheKey || !rpc) return
    // A pending timer left by unmount finds this false and does nothing, which
    // is why the handle itself never needs keeping.
    let live = true

    const attempt = (index: number) => {
      if (!live) return
      void resolvePoster(cacheKey, rpc, expectedPort, { blobId, blobsCoreKey, mimeType }).then((url) => {
        if (!live) return
        if (url) {
          setResolved({ key: cacheKey, url })
          return
        }
        const delay = RETRY_DELAYS_MS[index]
        if (delay != null) setTimeout(() => attempt(index + 1), delay)
      })
    }

    attempt(0)
    return () => { live = false }
  }, [cacheKey, rpc, expectedPort, blobId, blobsCoreKey, mimeType])

  if (!cacheKey) return fallbackUrl
  // Keyed so a recycled card never shows the previous entity's cover art.
  return resolvedPosters.get(cacheKey) ?? (resolved?.key === cacheKey ? resolved.url : null)
}
