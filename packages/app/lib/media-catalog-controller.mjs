const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 50

const initialState = () => ({
  status: 'idle',
  items: [],
  nextCursor: undefined,
  errorCode: undefined,
  error: undefined,
  revision: undefined,
  refreshing: false,
  loadingMore: false,
})

const mergeEntities = (current, incoming) => {
  const merged = current.slice()
  const positions = new Map(merged.map((item, index) => [item.entityId, index]))
  for (const item of incoming) {
    if (!item || typeof item.entityId !== 'string' || item.entityId.length === 0) continue
    const position = positions.get(item.entityId)
    if (position === undefined) {
      positions.set(item.entityId, merged.length)
      merged.push(item)
    } else {
      merged[position] = item
    }
  }
  return merged
}

export function createMediaCatalogController({ getMediaCatalog, pageSize = DEFAULT_PAGE_SIZE }) {
  if (typeof getMediaCatalog !== 'function') throw new TypeError('getMediaCatalog must be a function')
  const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(pageSize) || DEFAULT_PAGE_SIZE))
  let state = initialState()
  let requestSequence = 0
  let destroyed = false
  const listeners = new Set()

  const publish = (patch) => {
    if (destroyed) return
    state = { ...state, ...patch }
    for (const listener of listeners) listener(state)
  }

  const requestPage = async ({ append }) => {
    if (destroyed) return state
    if (append && state.loadingMore) return state
    const cursor = append ? state.nextCursor : undefined
    if (append && !cursor) return state
    const sequence = ++requestSequence
    publish({
      status: state.items.length > 0 ? 'ready' : 'loading',
      refreshing: !append && state.items.length > 0,
      loadingMore: append,
      errorCode: undefined,
      error: undefined,
    })
    try {
      const result = await getMediaCatalog({ cursor, limit })
      if (destroyed || sequence !== requestSequence) return state
      if (!result?.success) {
        publish({
          status: 'error',
          errorCode: result?.errorCode || 'MEDIA_CATALOG_ERROR',
          error: result?.error || 'Unable to load the media catalog',
          refreshing: false,
          loadingMore: false,
        })
        return state
      }
      const incoming = Array.isArray(result.items) ? result.items : []
      publish({
        status: 'ready',
        items: append ? mergeEntities(state.items, incoming) : mergeEntities([], incoming),
        nextCursor: typeof result.nextCursor === 'string' && result.nextCursor.length > 0 ? result.nextCursor : undefined,
        errorCode: undefined,
        error: undefined,
        refreshing: false,
        loadingMore: false,
      })
    } catch (error) {
      if (destroyed || sequence !== requestSequence) return state
      publish({
        status: 'error',
        errorCode: error?.code || 'MEDIA_CATALOG_ERROR',
        error: error?.message || 'Unable to load the media catalog',
        refreshing: false,
        loadingMore: false,
      })
    }
    return state
  }

  return {
    getState: () => state,
    subscribe(listener) {
      if (destroyed) return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    load: () => requestPage({ append: false }),
    refresh: () => requestPage({ append: false }),
    loadNext: () => requestPage({ append: true }),
    async handleGraphUpdate(update) {
      if (update && typeof update.revision === 'string') publish({ revision: update.revision })
      return requestPage({ append: false })
    },
    handleForeground: () => requestPage({ append: false }),
    destroy() {
      destroyed = true
      requestSequence += 1
      listeners.clear()
    },
  }
}

export function describeMediaCatalogState(state, diagnostics = {}) {
  if (state.status === 'error') {
    return {
      kind: 'error',
      title: 'Media catalog unavailable',
      detail: state.error || diagnostics.backendError || 'The authorized catalog could not be loaded.',
      errorCode: state.errorCode || undefined,
      actionLabel: 'Try again',
    }
  }
  if (state.status === 'ready' && state.items.length === 0) {
    return {
      kind: 'empty',
      title: 'No media is available yet',
      detail: diagnostics.backendError || diagnostics.startupStatus || diagnostics.networkReason || 'No authority-accepted publications have resolved into media entities.',
      actionLabel: 'Refresh catalog',
    }
  }
  return null
}
