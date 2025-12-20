/**
 * Root Layout - Wraps app with providers
 *
 * Uses @peartube/platform/rpc for unified backend communication.
 */
import '../global.css'
import { useEffect, useState, useCallback, useRef } from 'react'
import { Stack } from 'expo-router'
import { StatusBar, View, Platform, AppState, AppStateStatus } from 'react-native'
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider'
import { PlatformProvider } from '@/lib/PlatformProvider'
import { VideoPlayerProvider, videoStatsEventEmitter, videoLoadEventEmitter, VideoData } from '@/lib/VideoPlayerContext'
import { VideoPlayerOverlay } from '@/components/VideoPlayerOverlay'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import * as ScreenOrientation from 'expo-screen-orientation'
import { colors } from '@/lib/colors'
import { AppContext, type AppContextType } from '@/lib/AppContext'
export { useApp } from '@/lib/AppContext'

// Re-export colors for backward compatibility
export { colors }

// Platform detection
const isNative = Platform.OS !== 'web'
const isPear = Platform.OS === 'web' && typeof window !== 'undefined' && !!(window as any).Pear

// Types from shared package
import type { Identity, Video } from '@peartube/core'

// Platform RPC - conditionally imported
let platformRPC: any = null

// Cached app state to persist across soft navigations (component remounts)
// This prevents the "loading" flash when navigating between tabs
let cachedAppState: {
  identity: Identity | null
  videos: Video[]
  blobServerPort: number | null
} | null = null

// AppContext / useApp live in '@/lib/AppContext' to avoid require cycles with VideoPlayerOverlay.

export default function RootLayout() {
  // Initialize state from cache if available (for soft navigation)
  const [ready, setReady] = useState(() => cachedAppState !== null)
  const [identity, setIdentity] = useState<Identity | null>(() => cachedAppState?.identity ?? null)
  const [videos, setVideos] = useState<Video[]>(() => cachedAppState?.videos ?? [])
  const [loading, setLoading] = useState(() => cachedAppState === null)
  const [blobServerPort, setBlobServerPort] = useState<number | null>(() => cachedAppState?.blobServerPort ?? null)
  const [backendError, setBackendError] = useState<string | null>(null)
  const statsPollersRef = useRef<Map<string, NodeJS.Timeout>>(new Map())

  // Lock to portrait on app startup (mobile only)
  // Fullscreen video player will temporarily override this to landscape
  useEffect(() => {
    if (isNative) {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {
        // Ignore errors - some devices may not support orientation locking
      })
    }
  }, [])

  useEffect(() => {
    if (isNative) {
      initNativeBackend()

      const subscription = AppState.addEventListener('change', handleAppStateChange)
      return () => {
        subscription.remove()
        if (platformRPC) {
          platformRPC.terminatePlatformRPC()
        }
      }
    } else if (isPear) {
      initPearBackend()
    } else {
      // Regular web: mark as ready without backend
      setReady(true)
      setLoading(false)
    }
  }, [])

  // Subscribe to video load events to trigger prefetch
  useEffect(() => {
    if (!ready || !platformRPC) return

    const unsubscribe = videoLoadEventEmitter.subscribe(async (video: VideoData) => {
      console.log('[App] Video loaded, starting prefetch for:', video.title)
      try {
        const videoRef = (video.path && typeof video.path === 'string' && video.path.startsWith('/'))
          ? video.path
          : video.id
        await platformRPC.rpc.prefetchVideo(video.channelKey, videoRef)
        console.log('[App] prefetchVideo sent for:', videoRef)

        // Fallback: poll getVideoStats and feed into the context emitter.
        // Some mobile runtimes can be flaky with push events (eventVideoStats) over BareKit IPC.
        // Polling keeps the UI stats bar updated regardless.
        const pollKey = `${video.channelKey}:${videoRef}`
        if (!statsPollersRef.current.has(pollKey)) {
          let attempts = 0
          const poll = async () => {
            attempts++
            try {
              const res = await platformRPC.rpc.getVideoStats({ channelKey: video.channelKey, videoId: videoRef })
              const stats = res?.stats
              if (stats) {
                // Normalize identifiers (some backends include them in stats, some don't)
                videoStatsEventEmitter.emit(video.channelKey, videoRef, {
                  ...stats,
                  channelKey: stats.channelKey || video.channelKey,
                  videoId: stats.videoId || videoRef,
                })
                if (stats.isComplete) return true
              }
            } catch (err) {
              // Ignore polling errors
            }
            // Stop after ~60s to avoid background polling forever.
            if (attempts >= 60) return true
            return false
          }

          const interval = setInterval(async () => {
            const done = await poll()
            if (done) {
              const t = statsPollersRef.current.get(pollKey)
              if (t) clearInterval(t)
              statsPollersRef.current.delete(pollKey)
            }
          }, 1000)
          statsPollersRef.current.set(pollKey, interval)
        }
      } catch (err) {
        console.error('[App] Failed to start prefetch:', err)
      }
    })

    return unsubscribe
  }, [ready])

  // Cleanup any running pollers on unmount
  useEffect(() => {
    return () => {
      for (const t of statsPollersRef.current.values()) clearInterval(t)
      statsPollersRef.current.clear()
    }
  }, [])

  function handleAppStateChange(nextState: AppStateStatus) {
    if (!platformRPC) return

    if (nextState === 'background') {
      console.log('[App] Terminating backend for background')
      platformRPC.terminatePlatformRPC()
      setReady(false)
      setBackendError(null)
    } else if (nextState === 'active' && !platformRPC.isInitialized()) {
      console.log('[App] Re-initializing backend from foreground')
      initNativeBackend()
    }
  }

  async function initNativeBackend() {
    console.log('[App] Initializing native backend via platform RPC...')
    setBackendError(null)

    // Import platform RPC
    platformRPC = await import('@peartube/platform/rpc')

    // Subscribe to events before initialization
    platformRPC.events.onReady(async (data: any) => {
      console.log('[App] Backend ready, blobServerPort:', data?.blobServerPort)
      setBlobServerPort(data?.blobServerPort || null)
      setReady(true)
      setBackendError(null)

      // Load identity after ready
      await loadInitialData()
    })

    platformRPC.events.onError((data: any) => {
      console.error('[App] Backend error:', data?.message)
      setBackendError(data?.message || 'Backend error')
    })

    platformRPC.events.onVideoStats((data: any) => {
      // HRPC `event-video-stats` payload is `{ stats: VideoStats }`.
      // Some layers historically forwarded a legacy `{ channelKey, videoId, stats }` shape.
      // Normalize both to the context emitter signature.
      const stats = data?.stats ?? data
      const channelKey = data?.channelKey ?? stats?.channelKey
      const videoId = data?.videoId ?? stats?.videoId

      if (channelKey && videoId && stats) {
        videoStatsEventEmitter.emit(channelKey, videoId, stats)
      }
    })

    platformRPC.events.onUploadProgress((data: any) => {
      console.log('[App] Upload progress:', data?.progress + '%')
    })

    if ((platformRPC.events as any).onLog) {
      ;(platformRPC.events as any).onLog((data: any) => {
        const level = data?.level || 'info'
        const msg = data?.message || JSON.stringify(data)
        console.log(`[BackendLog/${level}]`, msg)
      })
    }

    // Initialize with backend source
    // NOTE: `backend.bundle.js` is generated by `npm run bundle:backend`.
    // If it's missing (common when running `expo run:ios` directly), fail gracefully instead of crashing.
    try {
      const backendSource = require('../backend.bundle.js')
      console.log('[App] Backend bundle length:', backendSource?.length || 0)
      await platformRPC.initPlatformRPC({ backendSource })
    } catch (err) {
      console.error('[App] Failed to initialize platform RPC:', err)
      setBackendError(err instanceof Error ? err.message : 'Failed to initialize backend')
    }
  }

  async function initPearBackend() {
    console.log('[App] Initializing Pear desktop backend via platform RPC...')

    try {
      // Import platform RPC for web
      platformRPC = await import('@peartube/platform/rpc')

      // Check if already initialized (happens on soft navigation/remount)
      const alreadyInitialized = platformRPC.isInitialized()

      if (!alreadyInitialized) {
        // Subscribe to events only on first init
        platformRPC.events.onReady(async (data: any) => {
          console.log('[App] Backend ready, blobServerPort:', data?.blobServerPort)
          setBlobServerPort(data?.blobServerPort || null)
          await loadInitialData()
        })

        platformRPC.events.onVideoStats((data: any) => {
          const stats = data?.stats ?? data
          const channelKey = data?.channelKey ?? stats?.channelKey
          const videoId = data?.videoId ?? stats?.videoId

          if (channelKey && videoId && stats) {
            videoStatsEventEmitter.emit(channelKey, videoId, stats)
          }
        })

        // Initialize
        await platformRPC.initPlatformRPC()
      } else {
        // Already initialized - restore from cache or load fresh
        console.log('[App] RPC already initialized, cached state:', cachedAppState ? 'yes' : 'no')
        setBlobServerPort(platformRPC.getBlobServerPort())

        if (cachedAppState) {
          // State already restored from cache in useState initializers
          // Just mark as ready immediately for instant navigation
          console.log('[App] Using cached state for instant navigation')
          setReady(true)
          setLoading(false)
          // Optionally refresh in background to catch any updates
          // (don't await - let it happen async)
          loadInitialData().catch(() => {})
          return // Early return since we already set ready/loading
        } else {
          // No cache, need to load
          await loadInitialData()
        }
      }
    } catch (err) {
      console.error('[App] Failed to initialize Pear backend:', err)
    }

    setReady(true)
    setLoading(false)
  }

  // Update cache when state changes
  useEffect(() => {
    if (ready && (identity || videos.length > 0)) {
      cachedAppState = { identity, videos, blobServerPort }
    }
  }, [ready, identity, videos, blobServerPort])

  async function loadInitialData() {
    if (!platformRPC) return

    try {
      setLoading(true)

      // Load identities
      const result = await platformRPC.rpc.getIdentities()
      const identities = result?.identities || []
      console.log('[App] Got', identities.length, 'identities')

      if (identities.length > 0) {
        const active = identities.find((id: any) => id.isActive) || identities[0]
        setIdentity(active)

        // Load videos for active identity with timeout
        // Use longer timeout (30s) for initial load as channel may need to sync
        // Backend smart sync takes up to 25s (15s peer discovery + 10s data sync)
        if (active?.driveKey) {
          try {
            const timeoutPromise = new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Initial listVideos timeout')), 30000)
            )
            const listPromise = platformRPC.rpc.listVideos({ channelKey: active.driveKey })
            const videosResult = await Promise.race([listPromise, timeoutPromise]) as any
            console.log('[App] Initial load got', videosResult?.videos?.length, 'videos')
            if (videosResult?.videos?.length > 0) {
              setVideos(videosResult.videos)
            }
            // Don't clear videos on empty result - keep any cached data
          } catch (err: any) {
            console.error('[App] Initial video load failed:', err?.message)
            // Continue without videos - they'll load on next interaction
          }
        }
      }
    } catch (err) {
      console.error('[App] Failed to load initial data:', err)
    } finally {
      setLoading(false)
    }
  }

  const loadIdentityFromBackend = useCallback(async () => {
    if (!platformRPC) return
    try {
      setLoading(true)
      const result = await platformRPC.rpc.getIdentity()
      const id = result?.identity
      // Only update identity if we got a valid one (don't clear existing identity on error)
      if (id?.driveKey) {
        setIdentity(id)
        await loadVideosFromBackend(id.driveKey)
      } else {
        console.warn('[App] getIdentity returned no identity, keeping current state')
      }
    } catch (err) {
      console.error('[App] Failed to load identity:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadVideosFromBackend = useCallback(async (driveKey: string, retryCount = 0) => {
    if (!platformRPC) return
    const maxRetries = 3
    const retryDelay = 5000 // 5 seconds between retries

    try {
      console.log('[App] loadVideosFromBackend calling listVideos for:', driveKey?.slice(0, 16), 'retry:', retryCount)

      // Longer timeout for initial sync after pairing (30s), shorter for retries (15s)
      // Backend smart sync can take up to 25s (15s peer discovery + 10s data sync)
      const timeout = retryCount === 0 ? 30000 : 15000
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('listVideos timeout')), timeout)
      )
      const listPromise = platformRPC.rpc.listVideos({ channelKey: driveKey })

      const result = await Promise.race([listPromise, timeoutPromise]) as any
      console.log('[App] loadVideosFromBackend got', result?.videos?.length, 'videos')

      // Only update if we got videos, don't clear existing videos with empty result
      // This prevents race conditions where a refresh returns empty before sync completes
      if (result?.videos?.length > 0) {
        setVideos(result.videos)
      } else if (result?.videos?.length === 0) {
        console.log('[App] loadVideosFromBackend: got 0 videos, checking if we should clear...')
        // Only clear if we truly have no videos (not a sync issue)
        // Keep existing videos if this might be a transient empty result
        setVideos(prev => {
          if (prev.length === 0) return []
          console.log('[App] loadVideosFromBackend: keeping', prev.length, 'existing videos (not clearing)')
          return prev
        })

        // Schedule automatic retry in background if no videos found
        // This helps when DHT discovery is slow after device pairing
        if (retryCount < maxRetries) {
          console.log(`[App] No videos found, scheduling retry ${retryCount + 1}/${maxRetries} in ${retryDelay}ms...`)
          setTimeout(() => {
            loadVideosFromBackend(driveKey, retryCount + 1)
          }, retryDelay)
        } else {
          console.log('[App] Max retries reached, giving up auto-retry')
        }
      }
    } catch (err: any) {
      console.error('[App] Failed to load videos:', err?.message || err)
      // Don't clear videos on error - keep stale data

      // Also retry on timeout errors (common after pairing while DHT syncs)
      if (retryCount < maxRetries) {
        console.log(`[App] Load failed, scheduling retry ${retryCount + 1}/${maxRetries} in ${retryDelay}ms...`)
        setTimeout(() => {
          loadVideosFromBackend(driveKey, retryCount + 1)
        }, retryDelay)
      }
    }
  }, [])

  const createIdentityHandler = useCallback(async (name: string): Promise<Identity> => {
    if (!platformRPC) throw new Error('RPC not ready')
    setLoading(true)
    try {
      const result = await platformRPC.rpc.createIdentity(name)
      const id = result?.identity
      setIdentity(id)
      return id
    } finally {
      setLoading(false)
    }
  }, [])

  const uploadVideoHandler = useCallback(async (
    filePath: string,
    title: string,
    description: string,
    mimeType: string = 'video/mp4',
    category: string = 'Other',
    onProgress?: (progress: number, speed?: number, eta?: number, isTranscoding?: boolean) => void,
    skipThumbnailGeneration: boolean = false
  ): Promise<any> => {
    if (!platformRPC) throw new Error('RPC not ready')

    console.log('[App] Uploading video:', filePath, 'category:', category, 'skipThumbnailGeneration:', skipThumbnailGeneration)

    // Listen for progress events during upload (Pear desktop)
    let progressHandler: ((e: Event) => void) | null = null
    if (onProgress && isPear && typeof window !== 'undefined') {
      progressHandler = (e: Event) => {
        const detail = (e as CustomEvent).detail
        if (detail?.progress !== undefined) {
          // videoId='transcoding' indicates transcode phase
          const isTranscoding = detail.videoId === 'transcoding'
          onProgress(detail.progress, detail.speed, detail.eta, isTranscoding)
        }
      }
      window.addEventListener('pearUploadProgress', progressHandler)
    }

    try {
      console.log('[App] Calling rpc.uploadVideo...')
      const result = await platformRPC.rpc.uploadVideo({
        filePath,
        title,
        description,
        category,
        skipThumbnailGeneration,
      })
      console.log('[App] Upload RPC returned:', JSON.stringify(result))

      // Reload videos
      if (identity?.driveKey) {
        console.log('[App] Reloading videos...')
        await loadVideosFromBackend(identity.driveKey)
        console.log('[App] Videos reloaded')
      }

      console.log('[App] Returning video:', result?.video)
      return result?.video
    } finally {
      // Clean up event listener
      if (progressHandler && typeof window !== 'undefined') {
        window.removeEventListener('pearUploadProgress', progressHandler)
      }
    }
  }, [identity, loadVideosFromBackend])

  const pickVideoFileHandler = useCallback(async () => {
    if (!platformRPC) return null
    return await platformRPC.rpc.pickVideoFile()
  }, [])

  const pickImageFileHandler = useCallback(async () => {
    if (!platformRPC) return null
    return await platformRPC.rpc.pickImageFile()
  }, [])

  const retryBackend = useCallback(() => {
    if (!isNative) return
    try {
      platformRPC?.terminatePlatformRPC?.()
    } catch {}
    platformRPC = null
    setReady(false)
    setLoading(true)
    setBackendError(null)
    initNativeBackend()
  }, [])

  const contextValue: AppContextType = {
    ready,
    identity,
    videos,
    loading,
    blobServerPort,
    rpc: platformRPC?.rpc,
    platformEvents: platformRPC?.events,
    backendError,
    retryBackend,
    uploadVideo: uploadVideoHandler,
    pickVideoFile: pickVideoFileHandler,
    pickImageFile: pickImageFileHandler,
    loadIdentity: loadIdentityFromBackend,
    createIdentity: createIdentityHandler,
    loadVideos: loadVideosFromBackend,
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <GluestackUIProvider mode="dark">
        <PlatformProvider>
          <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
          <AppContext.Provider value={contextValue}>
            <VideoPlayerProvider>
              <View style={{ flex: 1 }}>
                <Stack
                  screenOptions={{
                    headerShown: false,
                    contentStyle: { backgroundColor: colors.bg },
                  }}
                />
              </View>
              <VideoPlayerOverlay />
            </VideoPlayerProvider>
          </AppContext.Provider>
        </PlatformProvider>
      </GluestackUIProvider>
    </GestureHandlerRootView>
  )
}
