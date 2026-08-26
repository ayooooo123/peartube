import { useContext, useEffect, useMemo, useState } from 'react'
import { AppContext } from '@/lib/AppContext'

/**
 * What a catalog entry tells a card about its cover art.
 *
 * The poster is an asset *of* the publication: the publisher emits it as a
 * rendition on the signed publication manifest, so it replicates and is served
 * over the very same authorized asset path as the video. A consumer therefore
 * names the entity, never the bytes, and the backend resolves the poster
 * rendition and answers with a local URL.
 *
 * `posterBlobId`/`posterBlobsCoreKey` still ride the metadata claim, but only
 * as the publisher's statement that cover art exists. They are deliberately not
 * read as a locator any more: a raw blob core is announced by nobody, so
 * reading one found `peers: 0` and every card stayed grey.
 */
export type PosterArtworkRef = {
  entityId?: string | null
  localEntityId?: string | null
  publicationId?: string | null
  posterBlobId?: string | null
  posterBlobsCoreKey?: string | null
}

// Replication is not instant: the publication is discovered, connected and then
// read. These delays cover that without hammering a peer that is simply slow,
// and stop rather than retry forever on art that never arrives.
const RETRY_DELAYS_MS = [1_500, 3_000, 6_000, 12_000, 20_000]

type ArtworkRequest = { entityId?: string; publicationId?: string }

type ArtworkResponse = {
  success?: boolean
  exists?: boolean
  url?: string | null
  errorCode?: string | null
}

type ArtworkRpc = {
  getEntityArtwork?(request: ArtworkRequest): Promise<ArtworkResponse | null>
}

// A resolved URL points at the loopback blob server, which serves the same
// address for a given entity for as long as the process lives. Keeping them
// here means a rail scrolled out of view and back does not pay for the swarm
// round trip twice, and two cards for one entity resolve once between them.
const resolvedArtwork = new Map<string, string>()
const pendingArtwork = new Map<string, Promise<string | null>>()
// A backend that answered with a hard failure, or rejected because it has no
// such method at all, will not start answering later in the session. Recording
// that is what keeps a whole shelf from walking the retry ladder for nothing.
const exhaustedArtwork = new Set<string>()

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function resolveArtwork(
  cacheKey: string,
  getEntityArtwork: (request: ArtworkRequest) => Promise<ArtworkResponse | null>,
  request: ArtworkRequest,
): Promise<string | null> {
  const done = resolvedArtwork.get(cacheKey)
  if (done) return Promise.resolve(done)
  if (exhaustedArtwork.has(cacheKey)) return Promise.resolve(null)

  const inFlight = pendingArtwork.get(cacheKey)
  if (inFlight) return inFlight

  const pending = Promise.resolve(getEntityArtwork(request)).then((response) => {
    pendingArtwork.delete(cacheKey)
    const url = trimmed(response?.url)
    if (response?.exists && url) {
      resolvedArtwork.set(cacheKey, url)
      return url
    }
    // `exists: false` on its own is the ordinary first answer: the publication
    // is known, its poster simply has not replicated here yet. That stays
    // retryable. An error code is the backend saying asking again is pointless.
    if (response?.errorCode || response?.success === false) exhaustedArtwork.add(cacheKey)
    return null
  }, () => {
    // A backend built before artwork was an asset of the publication rejects
    // the call outright. The card degrades to the placeholder it already draws;
    // nothing escapes into a render.
    pendingArtwork.delete(cacheKey)
    exhaustedArtwork.add(cacheKey)
    return null
  })

  pendingArtwork.set(cacheKey, pending)
  return pending
}

/**
 * Returns the artwork URL a card should render for `item`.
 *
 * An entity whose publisher claimed cover art resolves through the backend and
 * renders nothing at all until that lands — the placeholder the card already
 * draws, so the layout never shifts. Older claims that named an origin keep
 * rendering `fallbackUrl` unchanged.
 */
export function usePosterArtwork(item: unknown, fallbackUrl: string | null): string | null {
  const app = useContext(AppContext)
  const getEntityArtwork = (app?.rpc as ArtworkRpc | null)?.getEntityArtwork

  const ref = item as PosterArtworkRef | null | undefined
  const entityId = trimmed(ref?.entityId) || trimmed(ref?.localEntityId)
  const publicationId = trimmed(ref?.publicationId)
  // An entry carrying no blob claim never had cover art, and asking for it
  // would cost every relay-archived title on the shelf a round trip that can
  // only miss.
  const claimsArtwork = Boolean(trimmed(ref?.posterBlobId) || trimmed(ref?.posterBlobsCoreKey))
  // No method means an older backend than this screen: fall through to the
  // placeholder rather than throwing out of a card.
  const canAsk = claimsArtwork
    && Boolean(entityId || publicationId)
    && typeof getEntityArtwork === 'function'
  const cacheKey = canAsk ? `${entityId}|${publicationId}` : null

  const request = useMemo<ArtworkRequest>(() => ({
    ...(entityId ? { entityId } : {}),
    ...(publicationId ? { publicationId } : {}),
  }), [entityId, publicationId])

  // Kicked off during render as well as in the effect: a static render (and the
  // regression test that measures it) never runs effects, and the module-level
  // maps collapse the duplicate into one in-flight request.
  useMemo(
    () => (cacheKey && getEntityArtwork ? resolveArtwork(cacheKey, getEntityArtwork, request) : null),
    [cacheKey, getEntityArtwork, request],
  )

  const [resolved, setResolved] = useState<{ key: string; url: string } | null>(null)

  // A poster that has not replicated yet is the normal first answer, not a
  // failure: the publication was only just discovered on the swarm. Giving up
  // after one miss leaves a permanent placeholder for art that arrives seconds
  // later, so keep asking on a widening delay while the card is on screen.
  useEffect(() => {
    if (!cacheKey || !getEntityArtwork) return
    // A pending timer left by unmount finds this false and does nothing, which
    // is why the handle itself never needs keeping.
    let live = true

    const attempt = (index: number) => {
      if (!live) return
      void resolveArtwork(cacheKey, getEntityArtwork, request).then((url) => {
        if (!live) return
        if (url) {
          setResolved({ key: cacheKey, url })
          return
        }
        if (exhaustedArtwork.has(cacheKey)) return
        const delay = RETRY_DELAYS_MS[index]
        if (delay != null) setTimeout(() => attempt(index + 1), delay)
      })
    }

    attempt(0)
    return () => { live = false }
  }, [cacheKey, getEntityArtwork, request])

  if (!cacheKey) return fallbackUrl
  // Keyed so a recycled card never shows the previous entity's cover art.
  return resolvedArtwork.get(cacheKey) ?? (resolved?.key === cacheKey ? resolved.url : null)
}
