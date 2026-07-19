import { mapContentCatalog, mapContentItems } from './content-catalog.js'

export const CHANNEL_CATALOG_PAGE_LIMIT = 24

function emptyPage(overrides = {}) {
  return {
    cards: [],
    nextCursor: null,
    loaded: false,
    loading: false,
    loadingMore: false,
    error: '',
    ...overrides,
  }
}

function mergeUniqueCards(previous, incoming) {
  const seenIds = new Set()
  const merged = []
  for (const card of [...previous, ...incoming]) {
    if (!card?.id || seenIds.has(card.id)) continue
    seenIds.add(card.id)
    merged.push(card)
  }
  return merged
}

function isTimedOut(result) {
  return Boolean(result && typeof result === 'object' && result.timedOut === true)
}

function responseError(result, fallback) {
  return typeof result?.error === 'string' && result.error.length > 0 ? result.error : fallback
}

export function createChannelCatalogState({
  rpc,
  bound = (promise) => promise,
  onChange = (_state) => {},
  limit = CHANNEL_CATALOG_PAGE_LIMIT,
}) {
  let disposed = false
  let catalogGeneration = 0
  let groupGenerations = new Map()
  let state = {
    route: { channelKey: '', publicBeeKey: '' },
    catalog: null,
    selectedGroupId: '',
    pages: {},
    catalogLoading: false,
    catalogError: '',
  }

  const emit = () => {
    if (!disposed) onChange(state)
  }

  const updatePage = (groupId, updater) => {
    const page = updater(state.pages[groupId] || emptyPage())
    state = { ...state, pages: { ...state.pages, [groupId]: page } }
    emit()
  }

  const requestFor = (groupId, cursor = null) => ({
    channelKey: state.route.channelKey,
    ...(state.route.publicBeeKey ? { publicBeeKey: state.route.publicBeeKey } : {}),
    groupId,
    ...(cursor ? { cursor } : {}),
    limit,
  })

  const loadGroup = async (groupId, { cursor = null, append = false } = {}) => {
    if (disposed || !groupId || !state.route.channelKey) return state
    const routeGeneration = catalogGeneration
    const requestGeneration = (groupGenerations.get(groupId) || 0) + 1
    groupGenerations.set(groupId, requestGeneration)
    const isCurrentRequest = () => (
      !disposed &&
      routeGeneration === catalogGeneration &&
      groupGenerations.get(groupId) === requestGeneration
    )

    updatePage(groupId, (current) => ({
      ...current,
      loading: !append,
      loadingMore: append,
      error: '',
    }))

    try {
      let result = await bound(rpc.getContentItems(requestFor(groupId, cursor)))
      if (!isCurrentRequest()) return state

      let resetExpiredCursor = false
      if (!isTimedOut(result) && result?.success === false && result.errorCode === 'INVALID_CURSOR' && cursor) {
        resetExpiredCursor = true
        updatePage(groupId, () => emptyPage({ loading: true }))
        result = await bound(rpc.getContentItems(requestFor(groupId)))
        if (!isCurrentRequest()) return state
      }

      if (isTimedOut(result)) {
        updatePage(groupId, (current) => ({
          ...current,
          loaded: true,
          error: 'This section is taking longer than expected. Retry to refresh it.',
        }))
      } else if (result?.success === false) {
        updatePage(groupId, (current) => ({
          ...current,
          loaded: true,
          error: responseError(result, 'Failed to load this section. Retry to refresh it.'),
        }))
      } else {
        const mappedPage = mapContentItems(result, state.catalog?.profile)
        updatePage(groupId, (current) => ({
          ...current,
          cards: mergeUniqueCards(append && !resetExpiredCursor ? current.cards : [], mappedPage.cards),
          nextCursor: mappedPage.nextCursor,
          loaded: true,
          error: '',
        }))
      }
    } catch (error) {
      if (!isCurrentRequest()) return state
      updatePage(groupId, (current) => ({
        ...current,
        loaded: true,
        error: error?.message || 'Failed to load this section. Retry to refresh it.',
      }))
    } finally {
      if (isCurrentRequest()) {
        updatePage(groupId, (current) => ({
          ...current,
          loading: false,
          loadingMore: false,
        }))
      }
    }
    return state
  }

  const loadCatalog = async ({ channelKey, publicBeeKey = '' }) => {
    disposed = false
    const requestGeneration = ++catalogGeneration
    groupGenerations = new Map()
    state = {
      route: { channelKey: channelKey || '', publicBeeKey: publicBeeKey || '' },
      catalog: null,
      selectedGroupId: '',
      pages: {},
      catalogLoading: true,
      catalogError: '',
    }
    emit()

    if (!channelKey) {
      state = { ...state, catalogLoading: false, catalogError: 'Missing channel key.' }
      emit()
      return state
    }

    try {
      const result = await bound(rpc.getContentCatalog({
        channelKey,
        ...(publicBeeKey ? { publicBeeKey } : {}),
      }))
      if (disposed || requestGeneration !== catalogGeneration) return state

      if (isTimedOut(result)) {
        state = {
          ...state,
          catalogLoading: false,
          catalogError: 'Channel details are taking longer than expected. Retry to refresh this channel.',
        }
        emit()
        return state
      }
      if (result?.success === false) {
        state = {
          ...state,
          catalogLoading: false,
          catalogError: responseError(result, 'Failed to load channel.'),
        }
        emit()
        return state
      }

      const catalog = mapContentCatalog(result)
      const selectedGroupId = catalog.tabs[0]?.id || ''
      state = { ...state, catalog, selectedGroupId, catalogLoading: false, catalogError: '' }
      emit()
      if (selectedGroupId) await loadGroup(selectedGroupId)
      return state
    } catch (error) {
      if (disposed || requestGeneration !== catalogGeneration) return state
      state = {
        ...state,
        catalogLoading: false,
        catalogError: error?.message || 'Failed to load channel.',
      }
      emit()
      return state
    }
  }

  const selectGroup = async (groupId) => {
    if (disposed || !state.catalog?.tabs.some((tab) => tab.id === groupId)) return state
    state = { ...state, selectedGroupId: groupId }
    emit()
    if (state.pages[groupId]?.loaded) return state
    return loadGroup(groupId)
  }

  const loadMore = async () => {
    const groupId = state.selectedGroupId
    const page = state.pages[groupId]
    if (!groupId || !page?.nextCursor || page.loadingMore) return state
    return loadGroup(groupId, { cursor: page.nextCursor, append: true })
  }

  const retrySelectedGroup = async () => {
    const groupId = state.selectedGroupId
    if (!groupId) return state
    return loadGroup(groupId)
  }

  const dispose = () => {
    disposed = true
    catalogGeneration += 1
    groupGenerations.clear()
  }

  return {
    getSnapshot: () => state,
    loadCatalog,
    selectGroup,
    loadMore,
    retrySelectedGroup,
    dispose,
  }
}
