const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 50
const MAX_SEARCH_SCAN_PAGES = 16
const SEARCH_CURSOR_PREFIX = 'consumer-search:v1:'

const normalizeSearchText = (value) => String(value || '')
  .toLowerCase()
  .replace(/[._\-[\]()]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()

const searchMatches = (item, query) => {
  const words = normalizeSearchText(query).split(' ').filter(Boolean)
  if (words.length === 0) return false
  const searchable = normalizeSearchText([
    item?.title,
    item?.subtitle,
    item?.entityKind,
    item?.entityId,
  ].filter(Boolean).join(' '))
  return words.every(word => searchable.includes(word))
}

const encodeSearchCursor = ({ catalogCursor, offset }) =>
  `${SEARCH_CURSOR_PREFIX}${encodeURIComponent(JSON.stringify({
    catalogCursor: catalogCursor || null,
    offset,
  }))}`

const decodeSearchCursor = (cursor) => {
  if (cursor == null || cursor === '') return { catalogCursor: undefined, offset: 0 }
  if (typeof cursor !== 'string' || cursor.length > 2048 || !cursor.startsWith(SEARCH_CURSOR_PREFIX)) {
    throw new Error('Invalid consumer search cursor')
  }
  const value = JSON.parse(decodeURIComponent(cursor.slice(SEARCH_CURSOR_PREFIX.length)))
  if (
    !value ||
    typeof value !== 'object' ||
    (value.catalogCursor !== null && typeof value.catalogCursor !== 'string') ||
    !Number.isSafeInteger(value.offset) ||
    value.offset < 0 ||
    value.offset > MAX_PAGE_SIZE
  ) {
    throw new Error('Invalid consumer search cursor')
  }
  return {
    catalogCursor: value.catalogCursor || undefined,
    offset: value.offset,
  }
}

export async function searchMediaCatalog({
  getMediaCatalog,
  query,
  cursor,
  limit = DEFAULT_PAGE_SIZE,
}) {
  if (typeof getMediaCatalog !== 'function') {
    throw new TypeError('getMediaCatalog must be a function')
  }
  const boundedQuery = typeof query === 'string' ? query.trim().slice(0, 256) : ''
  const pageLimit = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(limit) || DEFAULT_PAGE_SIZE))
  if (!boundedQuery) return { success: true, items: [], nextCursor: null }

  let state
  try {
    state = decodeSearchCursor(cursor)
  } catch {
    return {
      success: false,
      errorCode: 'INVALID_CURSOR',
      error: 'Invalid consumer search cursor',
      items: [],
      nextCursor: null,
    }
  }

  const items = []
  let catalogCursor = state.catalogCursor
  let offset = state.offset
  for (let page = 0; page < MAX_SEARCH_SCAN_PAGES; page++) {
    const pageStartCursor = catalogCursor
    const result = await getMediaCatalog({ cursor: catalogCursor, limit: MAX_PAGE_SIZE })
    if (!result?.success) {
      return {
        ...result,
        items: [],
        nextCursor: null,
      }
    }
    const matches = (Array.isArray(result.items) ? result.items : [])
      .filter(item => searchMatches(item, boundedQuery))
    const remaining = matches.slice(offset)
    const available = pageLimit - items.length
    items.push(...remaining.slice(0, available))
    const consumed = offset + Math.min(remaining.length, available)
    if (items.length >= pageLimit) {
      const nextCursor = consumed < matches.length
        ? encodeSearchCursor({ catalogCursor: pageStartCursor, offset: consumed })
        : result.nextCursor
          ? encodeSearchCursor({ catalogCursor: result.nextCursor, offset: 0 })
          : null
      return { success: true, items, nextCursor }
    }
    offset = 0
    catalogCursor = typeof result.nextCursor === 'string' && result.nextCursor
      ? result.nextCursor
      : null
    if (!catalogCursor) return { success: true, items, nextCursor: null }
  }
  return {
    success: true,
    items,
    nextCursor: catalogCursor
      ? encodeSearchCursor({ catalogCursor, offset: 0 })
      : null,
  }
}

const initialState = () => ({
  catalogScope: 'consumer',
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
