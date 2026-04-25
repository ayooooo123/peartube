export async function loadPublicBeeFromCache({
  cache,
  inflight,
  key,
  isUsable,
  closeStale,
  loadFresh,
}) {
  if (cache.has(key)) {
    const cached = cache.get(key)
    if (isUsable(cached)) return cached

    cache.delete(key)
    await closeStale(cached)
  }

  if (inflight.has(key)) {
    return inflight.get(key)
  }

  const loadPromise = (async () => {
    const fresh = await loadFresh()
    cache.set(key, fresh)
    return fresh
  })()

  inflight.set(key, loadPromise)

  try {
    return await loadPromise
  } finally {
    inflight.delete(key)
  }
}
