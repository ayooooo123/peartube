import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppState, type AppStateStatus } from 'react-native'
import type { MediaCatalogResult, MediaCatalogState, MediaGraphUpdate } from '@peartube/core'
import {
  createMediaCatalogController,
  describeMediaCatalogState,
  type MediaCatalogDiagnostic,
} from '@/lib/media-catalog-controller.mjs'

const INITIAL_STATE: MediaCatalogState = {
  status: 'idle',
  items: [],
  refreshing: false,
  loadingMore: false,
}

interface MediaCatalogRpc {
  getMediaCatalog(request: { cursor?: string; limit?: number }): Promise<MediaCatalogResult>
}

interface MediaCatalogEvents {
  onMediaGraphUpdate(callback: (update: MediaGraphUpdate) => void): (() => void) | void
}

export interface UseMediaCatalogOptions {
  ready: boolean
  rpc: MediaCatalogRpc | null | undefined
  events?: MediaCatalogEvents | null
  pageSize?: number
  diagnostics?: {
    backendError?: string | null
    startupStatus?: string | null
    networkReason?: string | null
  }
}

export interface UseMediaCatalogResult extends MediaCatalogState {
  diagnostic: MediaCatalogDiagnostic | null
  refresh(): Promise<MediaCatalogState | void>
  loadNext(): Promise<MediaCatalogState | void>
}

export function useMediaCatalog({
  ready,
  rpc,
  events,
  pageSize = 20,
  diagnostics = {},
}: UseMediaCatalogOptions): UseMediaCatalogResult {
  const controller = useMemo(() => {
    if (!rpc || typeof rpc.getMediaCatalog !== 'function') return null
    return createMediaCatalogController({
      pageSize,
      getMediaCatalog: (request) => rpc.getMediaCatalog(request),
    })
  }, [pageSize, rpc])
  const [state, setState] = useState<MediaCatalogState>(INITIAL_STATE)
  const appState = useRef<AppStateStatus>(AppState.currentState)

  useEffect(() => {
    if (!controller) {
      setState(INITIAL_STATE)
      return
    }
    setState(controller.getState())
    const unsubscribe = controller.subscribe(setState)
    return () => {
      unsubscribe()
      controller.destroy()
    }
  }, [controller])

  useEffect(() => {
    if (ready && controller) void controller.load()
  }, [controller, ready])

  useEffect(() => {
    if (!ready || !controller || !events?.onMediaGraphUpdate) return
    const unsubscribe = events.onMediaGraphUpdate((update) => {
      void controller.handleGraphUpdate(update)
    })
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [controller, events, ready])

  useEffect(() => {
    if (!controller) return
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (ready && nextState === 'active' && appState.current !== 'active') {
        void controller.handleForeground()
      }
      appState.current = nextState
    })
    return () => subscription.remove()
  }, [controller, ready])

  const refresh = useCallback(() => controller?.refresh() ?? Promise.resolve(), [controller])
  const loadNext = useCallback(() => controller?.loadNext() ?? Promise.resolve(), [controller])
  const diagnostic = describeMediaCatalogState(state, diagnostics)

  return { ...state, diagnostic, refresh, loadNext }
}
