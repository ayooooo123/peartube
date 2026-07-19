export const CHANNEL_ARTWORK_RESOLUTION_MS = 12_000
const FAILED_URL_LIMIT = 8

function boundedFailedUrls(values) {
  if (!Array.isArray(values)) return []
  const seen = new Set()
  const bounded = []
  for (let index = values.length - 1; index >= 0 && bounded.length < FAILED_URL_LIMIT; index -= 1) {
    const value = values[index]
    if (typeof value !== 'string' || value.length === 0 || seen.has(value)) continue
    seen.add(value)
    bounded.unshift(value)
  }
  return bounded
}

function isCancelled(signal, isStale) {
  return Boolean(signal?.aborted || isStale?.())
}

function resolveBlobBeforeDeadline(resolveBlob, candidate, { deadline, signal }) {
  const remainingMs = Number.isFinite(deadline) ? deadline - Date.now() : Infinity
  if (remainingMs <= 0 || signal?.aborted) return Promise.resolve(null)

  return new Promise((resolve) => {
    let settled = false
    let timer = null

    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', abort)
      resolve(typeof value === 'string' && value.length > 0 ? value : null)
    }
    const abort = () => finish(null)

    signal?.addEventListener?.('abort', abort, { once: true })
    if (signal?.aborted) {
      finish(null)
      return
    }
    if (Number.isFinite(remainingMs)) timer = setTimeout(() => finish(null), remainingMs)

    Promise.resolve()
      .then(() => resolveBlob(candidate, { deadline, signal }))
      .then(finish, () => finish(null))
  })
}

export async function resolveArtworkCandidates(
  candidates,
  resolveBlob,
  {
    deadline = Infinity,
    signal,
    isStale,
    startIndex = 0,
    blobResolverAvailable = typeof resolveBlob === 'function',
    initialProvisional = false,
    failedUrls = [],
  } = {},
) {
  if (!Array.isArray(candidates)) {
    return { url: null, nextIndex: 0, provisional: false, failedUrls: [] }
  }

  const firstIndex = Math.min(
    candidates.length,
    Math.max(0, Number.isInteger(startIndex) ? startIndex : 0),
  )
  let provisional = initialProvisional
  const boundedFailures = boundedFailedUrls(failedUrls)
  const failedUrlSet = new Set(boundedFailures)
  const seenRemoteUrls = new Set()
  const seenBlobRefs = new Set()
  for (let index = 0; index < firstIndex; index += 1) {
    const candidate = candidates[index]
    if (candidate?.kind === 'remote' && typeof candidate.url === 'string') {
      seenRemoteUrls.add(candidate.url)
    } else if (candidate?.kind === 'blob') {
      seenBlobRefs.add(`${candidate.blobsCoreKey}\u0000${candidate.blobId}`)
    }
  }

  for (let index = firstIndex; index < candidates.length; index += 1) {
    if (isCancelled(signal, isStale)) return null

    const candidate = candidates[index]
    if (candidate?.kind === 'remote') {
      if (
        typeof candidate.url !== 'string' ||
        candidate.url.trim().length === 0 ||
        seenRemoteUrls.has(candidate.url)
      ) continue
      seenRemoteUrls.add(candidate.url)
      if (failedUrlSet.has(candidate.url)) continue
      return {
        url: candidate.url,
        nextIndex: index + 1,
        provisional,
        failedUrls: boundedFailures,
      }
    }
    if (candidate?.kind !== 'blob') continue
    const blobRef = `${candidate.blobsCoreKey}\u0000${candidate.blobId}`
    if (seenBlobRefs.has(blobRef)) continue
    seenBlobRefs.add(blobRef)
    if (!blobResolverAvailable || typeof resolveBlob !== 'function') {
      provisional = true
      continue
    }
    if (Date.now() >= deadline) continue

    const resolved = await resolveBlobBeforeDeadline(resolveBlob, candidate, { deadline, signal })
    if (isCancelled(signal, isStale)) return null
    if (resolved && !failedUrlSet.has(resolved)) {
      return {
        url: resolved,
        nextIndex: index + 1,
        provisional: false,
        failedUrls: boundedFailures,
      }
    }
  }

  return {
    url: null,
    nextIndex: candidates.length,
    provisional,
    failedUrls: boundedFailures,
  }
}
