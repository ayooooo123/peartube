/**
 * Root Layout - Wraps app with providers
 *
 * Uses @peartube/platform/rpc for unified backend communication.
 */
import '../global.css'
import { useEffect, useState, useCallback, useRef } from 'react'
import { Stack } from 'expo-router'
import { StatusBar, View, Platform, AppState, AppStateStatus, PermissionsAndroid } from 'react-native'
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider'
import { PlatformProvider } from '@/lib/PlatformProvider'
import { VideoPlayerProvider, videoStatsEventEmitter, videoLoadEventEmitter, VideoData, playbackActiveEmitter } from '@/lib/VideoPlayerContext'
import { DownloadsProvider } from '@/lib/DownloadsContext'
import { VideoPlayerOverlay } from '@/components/VideoPlayerOverlay'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { SocialProvider } from '@/lib/SocialContext'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import * as ScreenOrientation from 'expo-screen-orientation'
import { colors } from '@/lib/colors'
import { AppContext, type AppContextType } from '@/lib/AppContext'
export { useApp } from '@/lib/AppContext'

// Configure Reanimated logger to disable strict mode warnings
// We intentionally update shared values during render for PiP exit transitions
// to ensure animated worklets see current values immediately
// Guarded for SSR: only load on native or Pear runtime (not during static rendering)
if (Platform.OS !== 'web' || (typeof window !== 'undefined' && (window as any).Pear)) {
  try {
    const { configureReanimatedLogger, ReanimatedLogLevel } = require('react-native-reanimated')
    configureReanimatedLogger({
      level: ReanimatedLogLevel.warn,
      strict: false,
    })
  } catch {}
}

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
const castKeepaliveIntervalRef = useRef<NodeJS.Timeout | null>(null)
const castSuspendGraceTimerRef = useRef<NodeJS.Timeout | null>(null)
const castKeepaliveLastErrorLogAtRef = useRef(0)
const lastKnownCastActiveAtRef = useRef(0)
const nativeInitInFlightRef = useRef<Promise<void> | null>(null)
const nativeEventsSubscribedRef = useRef(false)
const CAST_ACTIVITY_GRACE_MS = 60 * 60 * 1000

  const startupLog = useCallback((...args: unknown[]) => {
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      // eslint-disable-next-line no-console
      console.log(...args)
    }
  }, [])

  // Lock to portrait on app startup (mobile only)
  // Fullscreen video player will temporarily override this to landscape
  useEffect(() => {
    if (isNative) {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {
        // Ignore errors - some devices may not support orientation locking
      })
    }
  }, [])

  const loadInitialData = useCallback(async () => {
    if (!platformRPC) return

    try {
      const t0 = Date.now()
      setLoading(true)

      let identities: any[] = []
      for (let attempt = 0; attempt < 4; attempt++) {
        const result = await platformRPC.rpc.getIdentities()
        identities = result?.identities || []
        if (identities.length > 0 || attempt === 3) break
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
      console.log('[App] Got', identities.length, 'identities')
      startupLog('[Startup] getIdentities ms=', Date.now() - t0)

      if (identities.length > 0) {
        const active = identities.find((id: any) => id.isActive) || identities[0]
        setIdentity(active)

        // Load videos for active identity with timeout
        // Use longer timeout (30s) for initial load as channel may need to sync
        // Backend smart sync takes up to 25s (15s peer discovery + 10s data sync)
        if (active?.driveKey) {
          try {
            const tList = Date.now()
            const timeoutPromise = new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Initial listVideos timeout')), 30000)
            )
            const listPromise = platformRPC.rpc.listVideos({ channelKey: active.driveKey })
            const videosResult = await Promise.race([listPromise, timeoutPromise]) as any
            console.log('[App] Initial load got', videosResult?.videos?.length, 'videos')
            startupLog('[Startup] listVideos ms=', Date.now() - tList)
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
  }, [startupLog])

  // Subscribe to video load events to trigger prefetch
  useEffect(() => {
    if (!ready || !platformRPC) return

    const unsubscribe = videoLoadEventEmitter.subscribe(async (video: VideoData) => {
      console.log('[App] Video loaded, starting prefetch for:', video.title)
      try {
        const videoRef = (video.path && typeof video.path === 'string' && video.path.startsWith('/'))
          ? video.path
          : video.id
        await platformRPC.rpc.prefetchVideo({
          channelKey: video.channelKey,
          videoId: videoRef,
          publicBeeKey: (video as any).publicBeeKey || undefined
        })
        console.log('[App] prefetchVideo sent for:', videoRef)

        // Proactively prefetch next videos in background for smooth playback
        platformRPC.rpc.prefetchNextVideos?.(video.channelKey, videoRef, 3).then((res: any) => {
          if (res?.prefetchedCount > 0) {
            console.log('[App] Prefetching', res.prefetchedCount, 'next videos in background')
          }
        }).catch(() => {})

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

    return () => { unsubscribe() }
  }, [ready])

  // Cleanup any running pollers on unmount
  useEffect(() => {
    return () => {
      for (const t of statsPollersRef.current.values()) clearInterval(t)
      statsPollersRef.current.clear()
    }
  }, [])

  const initNativeBackend = useCallback(async () => {
    if (nativeInitInFlightRef.current) {
      await nativeInitInFlightRef.current
      return
    }

    const run = (async () => {
    const t0 = Date.now()
    console.log('[App] Initializing native backend via platform RPC...')
    setBackendError(null)

    // Import platform RPC
    platformRPC = await import('@peartube/platform/rpc')

    if (!nativeEventsSubscribedRef.current) {
      platformRPC.events.onReady(async (data: any) => {
        console.log('[App] Backend ready, blobServerPort:', data?.blobServerPort)
        startupLog('[Startup] backend ready ms=', Date.now() - t0)
        setBlobServerPort(data?.blobServerPort || null)
        setReady(true)
        setBackendError(null)
        await loadInitialData()
      })

      platformRPC.events.onError((data: any) => {
        const message = String(data?.message || 'Backend error')
        console.error('[App] Backend error:', message)
        setBackendError(message)
      })

      platformRPC.events.onVideoStats((data: any) => {
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

      nativeEventsSubscribedRef.current = true
    }

    // Initialize with backend source
    // NOTE: `backend.bundle.js` is generated by `npm run bundle:backend`.
    // If it's missing (common when running `expo run:ios` directly), fail gracefully instead of crashing.
    try {
      const backendSource = require('../backend.bundle.js')
      const downloaderWorkerSource = require('../downloader-worker.bundle.js')
      console.log('[App] Backend bundle length:', backendSource?.length || 0)
      console.log('[App] Downloader worker bundle length:', downloaderWorkerSource?.length || 0)
      await platformRPC.initPlatformRPC({ backendSource, downloaderWorkerSource })
      startupLog('[Startup] initPlatformRPC returned ms=', Date.now() - t0)

      // Don't set ready here — wait for eventReady from backend.
      // The backend root causes for startup stalls (FD locks, identity
      // loading, corestore contention) are fixed, so eventReady should
      // fire within seconds.
    } catch (err) {
      console.error('[App] Failed to initialize platform RPC:', err)
      const message = err instanceof Error ? err.message : 'Failed to initialize backend'
      const isMissingBundle =
        message.includes('backend.bundle.js') ||
        message.includes('downloader-worker.bundle.js')

      if (isMissingBundle) {
        setBackendError('Backend bundles are missing. Run `npm run bundle:backend` in packages/app, then restart the app.')
      } else {
        setBackendError(message)
      }
    }
    })()

    nativeInitInFlightRef.current = run
    try {
      await run
    } finally {
      if (nativeInitInFlightRef.current === run) {
        nativeInitInFlightRef.current = null
      }
    }
  }, [loadInitialData, startupLog])

  const initPearBackend = useCallback(async () => {
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
  }, [loadInitialData])

  const isCastSessionActive = useCallback(async (): Promise<boolean> => {
    if (!platformRPC?.rpc?.castIsConnected) return false

    try {
      const connected = await platformRPC.rpc.castIsConnected({})
      if (!connected?.connected) {
        return Date.now() - lastKnownCastActiveAtRef.current < CAST_ACTIVITY_GRACE_MS
      }
      lastKnownCastActiveAtRef.current = Date.now()

      if (typeof platformRPC.rpc.castGetState === 'function') {
        try {
          const state = await platformRPC.rpc.castGetState({})
          const castState = String(state?.state || '').toLowerCase()
          if (castState === 'idle' || castState === 'stopped') {
            return false
          }
          lastKnownCastActiveAtRef.current = Date.now()
        } catch {
          return true
        }
      }

      return true
    } catch {
      return Date.now() - lastKnownCastActiveAtRef.current < CAST_ACTIVITY_GRACE_MS
    }
  }, [])

  const stopCastKeepalive = useCallback(() => {
    if (castKeepaliveIntervalRef.current) {
      clearInterval(castKeepaliveIntervalRef.current)
      castKeepaliveIntervalRef.current = null
    }
  }, [])

  const startCastKeepalive = useCallback(() => {
    if (castKeepaliveIntervalRef.current) return
    if (!platformRPC?.rpc?.castGetState) return

    castKeepaliveIntervalRef.current = setInterval(() => {
      platformRPC.rpc.castGetState({}).catch(() => {
        const now = Date.now()
        if (now - castKeepaliveLastErrorLogAtRef.current > 60000) {
          castKeepaliveLastErrorLogAtRef.current = now
          console.log('[App] Cast keepalive state check failed (will retry)')
        }
      })
    }, 15000)
  }, [])

  const clearCastSuspendGraceTimer = useCallback(() => {
    if (castSuspendGraceTimerRef.current) {
      clearTimeout(castSuspendGraceTimerRef.current)
      castSuspendGraceTimerRef.current = null
    }
  }, [])

  const handleAppStateChange = useCallback((nextState: AppStateStatus) => {
    if (!platformRPC) return
    const goingToBackground = nextState === 'background' || (nextState === 'inactive' && Platform.OS !== 'android')

    if (goingToBackground) {
      clearCastSuspendGraceTimer()

      const maybeSuspendWithGrace = async () => {
        if (playbackActiveEmitter.isActive) {
          console.log('[App] Skipping network suspend - local playback is active (state:', nextState + ')')
          return
        }

        if (await isCastSessionActive()) {
          console.log('[App] Skipping network suspend - cast session is active (state:', nextState + ')')
          startCastKeepalive()
          return
        }

        castSuspendGraceTimerRef.current = setTimeout(async () => {
          castSuspendGraceTimerRef.current = null

          if (playbackActiveEmitter.isActive) {
            console.log('[App] Grace check: local playback active, skip suspend')
            return
          }

          if (await isCastSessionActive()) {
            console.log('[App] Grace check: cast session active, skip suspend')
            startCastKeepalive()
            return
          }

          stopCastKeepalive()
          console.log('[App] Suspending network for app state:', nextState)
          platformRPC.rpc?.suspendNetwork?.().catch((err: any) => {
            console.log('[App] suspendNetwork error:', err?.message)
          })
        }, 8000)
      }

      void maybeSuspendWithGrace()
    } else if (nextState === 'active') {
      clearCastSuspendGraceTimer()
      stopCastKeepalive()
      console.log('[App] Resuming network from foreground')
      platformRPC.rpc?.resumeNetwork?.().catch((err: any) => {
        console.log('[App] resumeNetwork error:', err?.message)
      })

      if (typeof platformRPC.rpc?.castStartDiscovery === 'function') {
        platformRPC.rpc.castStartDiscovery({}).catch((err: any) => {
          console.log('[App] castStartDiscovery error after foreground:', err?.message)
        })
      }

      const startupState = platformRPC.getStartupState?.() || 'idle'
      const shouldReinitialize = !platformRPC.isInitialized()
        && !nativeInitInFlightRef.current
        && (startupState === 'idle' || startupState === 'error')

      if (shouldReinitialize) {
        console.log('[App] Backend not initialized, reinitializing...')
        initNativeBackend()
      }
    }
  }, [
    clearCastSuspendGraceTimer,
    initNativeBackend,
    isCastSessionActive,
    startCastKeepalive,
    stopCastKeepalive,
  ])

  useEffect(() => {
    if (isNative) {
      if (Platform.OS === 'android' && Platform.Version >= 33) {
        PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).catch(() => {})
        if (PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES) {
          PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES).catch(() => {})
        }
      }
      initNativeBackend()

      const subscription = AppState.addEventListener('change', handleAppStateChange)
      return () => {
        subscription.remove()
        clearCastSuspendGraceTimer()
        stopCastKeepalive()
        // Always terminate worklet on unmount — shutdown signal handles graceful cleanup
        if (platformRPC) {
          console.log('[App] Initiating backend shutdown before terminate')
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
  }, [
    clearCastSuspendGraceTimer,
    handleAppStateChange,
    initNativeBackend,
    initPearBackend,
    stopCastKeepalive,
  ])

  // Update cache when state changes
  useEffect(() => {
    if (ready && (identity || videos.length > 0)) {
      cachedAppState = { identity, videos, blobServerPort }
    }
  }, [ready, identity, videos, blobServerPort])

  const loadVideosFromBackend = useCallback(async (
    driveKey: string,
    options: { retryCount?: number; allowEmptyResult?: boolean } = {}
  ) => {
    if (!platformRPC) return
    const retryCount = options.retryCount ?? 0
    const allowEmptyResult = options.allowEmptyResult === true
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
        if (allowEmptyResult) {
          setVideos([])
        } else {
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
              loadVideosFromBackend(driveKey, { retryCount: retryCount + 1, allowEmptyResult })
            }, retryDelay)
          } else {
            console.log('[App] Max retries reached, giving up auto-retry')
          }
        }
      }
    } catch (err: any) {
      console.error('[App] Failed to load videos:', err?.message || err)
      // Don't clear videos on error - keep stale data

      // Also retry on timeout errors (common after pairing while DHT syncs)
      if (retryCount < maxRetries) {
        console.log(`[App] Load failed, scheduling retry ${retryCount + 1}/${maxRetries} in ${retryDelay}ms...`)
        setTimeout(() => {
          loadVideosFromBackend(driveKey, { retryCount: retryCount + 1, allowEmptyResult })
        }, retryDelay)
      }
    }
  }, [])

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
  }, [loadVideosFromBackend])

  const createIdentityHandler = useCallback(async (name: string): Promise<Identity> => {
    if (!platformRPC) throw new Error('RPC not ready')
    setLoading(true)
    try {
      const result = await platformRPC.rpc.createIdentity(name)
      const id = result?.identity
      if (id) setIdentity(id)
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

    // Listen for progress events during upload
    let progressHandler: ((e: Event) => void) | null = null
    let unsubscribeNativeProgress: (() => void) | null = null

    if (onProgress && isNative) {
      unsubscribeNativeProgress = platformRPC.events.onUploadProgress((detail: any) => {
        if (detail?.progress !== undefined) {
          const isTranscoding = detail.videoId === 'transcoding'
          onProgress(detail.progress, detail.speed || undefined, detail.eta || undefined, isTranscoding)
        }
      })
    } else if (onProgress && isPear && typeof window !== 'undefined') {
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
      if (unsubscribeNativeProgress) {
        unsubscribeNativeProgress()
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
  }, [initNativeBackend])

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
    removeVideo: (videoId: string) => setVideos(prev => prev.filter(v => v.id !== videoId)),
  }

  return (
    <ErrorBoundary onRetry={retryBackend}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <GluestackUIProvider mode="dark">
          <PlatformProvider>
            <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
            <AppContext.Provider value={contextValue}>
              <DownloadsProvider>
                <VideoPlayerProvider>
                  <SocialProvider>
                    <View style={{ flex: 1 }}>
                      <Stack
                        screenOptions={{
                          headerShown: false,
                          contentStyle: { backgroundColor: colors.bg },
                        }}
                      />
                    </View>
                    <VideoPlayerOverlay />
                  </SocialProvider>
                </VideoPlayerProvider>
              </DownloadsProvider>
            </AppContext.Provider>
          </PlatformProvider>
        </GluestackUIProvider>
      </GestureHandlerRootView>
    </ErrorBoundary>
  )
}
