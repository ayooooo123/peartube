import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { isArtworkRendition } from '../assets/rendition.js'

// One scan continuation, one page lease, one candidate and one timer. The map
// holds only this manager's bounded owner handles, never a catalog-sized queue.
export function createLocalPublicationCustody({
  catalogRegistry,
  verifiedQueryView,
  scopedNetwork,
  ceiling = 256,
  workPerTick = 16,
  intervalMs = 1000,
  dwellMs = 30_000,
  retryBaseMs = 1000,
  retryMaxMs = 30_000,
  maxAttempts = 3,
  now = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  for (const value of [ceiling, workPerTick, intervalMs, dwellMs, retryBaseMs, retryMaxMs, maxAttempts]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('custody bounds must be positive integers')
  }
  const ownerId = `local-publication-custody:${b4a.toString(crypto.randomBytes(16), 'hex')}`
  const owned = new Map()
  let closed = false
  let started = false
  let timer = null
  let running = null
  let closing = null
  let page = null
  let bindingCursor = null
  let bindingIndex = 0
  let catalogReady = false
  let projections = null
  let projectionCursor = null
  let projectionIndex = 0
  let candidate = null
  let attempts = 0
  let rotation = null
  const signal = { get aborted() { return closed } }

  async function releasePage() {
    const previous = page
    page = null
    await previous?.release?.()
  }

  function nextBinding() {
    bindingIndex++
    catalogReady = false
    projections = null
    projectionCursor = null
    projectionIndex = 0
    candidate = null
  }

  function nextRendition() {
    candidate.renditionIndex++
  }

  async function retain(rendition) {
    const renditionId = rendition.renditionId
    if (!owned.has(renditionId) && owned.size >= ceiling) {
      rotation ||= owned.entries()
      const next = rotation.next()
      if (next.done) {
        rotation = null
        return intervalMs
      }
      const [oldestId, retainedAt] = next.value
      const wait = retainedAt + dwellMs - now()
      if (wait > 0) {
        rotation = null
        return wait
      }
      // A full-range owner may support another owner's narrower authorization.
      // Keep/count it if release would revoke that dependent; try another slot
      // next tick. Never weaken the shared scope's authorization to make room.
      const result = await scopedNetwork.releaseAuthorizedRendition({
        renditionId: oldestId, ownerId, preserveDependentOwners: true,
      })
      if (result?.blockedByDependentOwners) return intervalMs
      owned.delete(oldestId)
      rotation = null
    }
    if (closed) return 0
    await scopedNetwork.retainAuthorizedRendition({
      manifest: candidate.projected.manifest,
      renditionId,
      publicationId: candidate.publicationId,
      ownerId,
      retainArtwork: false,
      signal,
    })
    // Close drains this handle too if an injected dependency ignored the signal.
    if (!owned.has(renditionId)) owned.set(renditionId, now())
    if (closed) return 0
    nextRendition()
    return 0
  }

  function advanceProjectionCandidate() {
    if (projectionIndex >= projections.items.length) {
      projectionCursor = projections.nextCursor || null
      projections = null
      if (!projectionCursor) nextBinding()
      return
    }
    const publicationId = projections.items[projectionIndex++]?.body?.publicationId
    if (publicationId) {
      candidate = {
        publicationId: typeof publicationId === 'string' ? publicationId : b4a.toString(publicationId, 'hex'),
        projected: null,
        renditionIndex: -1,
      }
    }
  }

  async function stepCandidate() {
    if (!candidate.projected) {
      const projected = await verifiedQueryView.getRendition({ publicationId: candidate.publicationId })
      if (projected) candidate.projected = projected
      else candidate = null
      return 0
    }
    if (candidate.renditionIndex === -1) return retain(candidate.projected.rendition)
    const renditions = candidate.projected.manifest.body.renditions
    if (candidate.renditionIndex >= renditions.length) {
      candidate = null
      return 0
    }
    const artwork = renditions[candidate.renditionIndex]
    if (!isArtworkRendition(artwork) || artwork.blocked || artwork.superseded ||
        artwork.renditionId === candidate.projected.rendition.renditionId) {
      nextRendition()
      return 0
    }
    return retain(artwork)
  }

  async function step() {
    if (!page) {
      page = await catalogRegistry.listBindingPage({ cursor: bindingCursor, limit: 16, writableOnly: true, signal })
      bindingIndex = 0
      return 0
    }
    if (bindingIndex >= page.items.length) {
      bindingCursor = page.nextCursor || null
      await releasePage()
      return bindingCursor ? 0 : dwellMs
    }
    const catalog = page.items[bindingIndex]?.catalog
    if (!catalog?.writable || typeof catalog.listProjections !== 'function') {
      nextBinding()
      return 0
    }
    if (!catalogReady) {
      await catalog.ready?.()
      catalogReady = true
      return 0
    }
    if (!projections) {
      projections = await catalog.listProjections('publication', { cursor: projectionCursor, limit: 64 })
      projectionIndex = 0
      return 0
    }
    if (!candidate) {
      advanceProjectionCandidate()
      return 0
    }
    return stepCandidate()
  }

  function advanceFailedStep() {
    if (candidate) {
      if (candidate.projected) nextRendition()
      else candidate = null
    } else if (page) {
      // A permanently unreadable catalog cannot starve later bindings.
      nextBinding()
    } else {
      // A failed binding-page read has no trustworthy continuation. Restart a
      // pass after bounded backoff, rather than permanently abandoning custody.
      bindingCursor = null
    }
  }

  async function tick() {
    let delay = intervalMs
    try {
      for (let work = 0; work < workPerTick && !closed; work++) {
        try {
          const wait = await step()
          attempts = 0
          if (wait > 0) {
            delay = Math.max(intervalMs, wait)
            break
          }
        } catch {
          if (closed) break
          attempts++
          delay = Math.max(intervalMs, Math.min(retryMaxMs, retryBaseMs * 2 ** (attempts - 1)))
          if (attempts >= maxAttempts) {
            advanceFailedStep()
            attempts = 0
          }
          break
        }
      }
    } finally {
      running = null
      if (!closed) arm(delay)
    }
  }

  function arm(delay) {
    timer = schedule(() => {
      timer = null
      if (closed) return
      running = tick()
      return running
    }, delay)
    timer?.unref?.()
  }

  function start() {
    if (started || closed) return
    started = true
    arm(intervalMs)
  }

  function close() {
    if (closing) return closing
    closed = true
    if (timer !== null) cancel(timer)
    timer = null
    closing = (async () => {
      await running
      let failure = null
      try {
        await releasePage()
      } catch (error) {
        failure = error
      }
      candidate = null
      projections = null
      rotation = null
      const deferredToRuntimeClose = []
      // Complete all independent releases even if one runtime close fails.
      for (const renditionId of owned.keys()) {
        try {
          const result = await scopedNetwork.releaseAuthorizedRendition({
            renditionId, ownerId, preserveDependentOwners: true,
          })
          if (result?.blockedByDependentOwners) deferredToRuntimeClose.push(renditionId)
          else owned.delete(renditionId)
        } catch (error) {
          failure ||= error
        }
      }
      if (failure) throw failure
      // Lifecycle closes the enclosing scoped runtime later; only it can end
      // dependent scopes without pretending their other owners survive.
      return { deferredToRuntimeClose }
    })()
    return closing
  }

  return { start, close }
}
