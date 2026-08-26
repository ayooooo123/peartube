/* eslint-disable @typescript-eslint/no-require-imports, no-empty, no-extra-semi */
/**
 * Root Layout - Wraps app with providers
 *
 * Uses @peartube/platform/rpc for unified backend communication.
 */
import '../global.css'
import { useEffect, useState, useCallback, useRef } from 'react'
import { Stack } from 'expo-router'
import { StatusBar, View, Platform, AppState, AppStateStatus, PermissionsAndroid, NativeModules } from 'react-native'
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider'
import { PlatformProvider } from '@/lib/PlatformProvider'
import { VideoPlayerProvider, videoStatsEventEmitter, videoLoadEventEmitter, VideoData, playbackActiveEmitter } from '@/lib/VideoPlayerContext'
import { DownloadsProvider } from '@/lib/DownloadsContext'
import { VideoPlayerOverlay } from '@/components/VideoPlayerOverlay'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { SocialProvider } from '@/lib/SocialContext'
import { ensurePersonalEncryption } from '@/lib/personal-encryption'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import * as ScreenOrientation from 'expo-screen-orientation'
import Constants from 'expo-constants'
import { useFonts } from 'expo-font'
import { colors } from '@/lib/colors'
import { AppContext, type AppContextType } from '@/lib/AppContext'
import { buildBundleVersionKey } from '@peartube/platform/native-bundle-cache'
import { getNativePublisherKeyVault, getNativePublisherSigner } from '@/lib/publisher-shell-signer'
import { useDeviceConditionsReporter } from '@/hooks/useNetworkPolicy'
export { useApp } from '@/lib/AppContext'

// Configure Reanimated logger to disable strict mode warnings
// We intentionally update shared values during render for PiP exit transitions
// to ensure animated worklets see current values immediately
// Guarded for SSR: only load on native or Pear runtime (not during static rendering)
if (Platform.OS !== 'web' || (typeof window !== 'undefined' && ((window as any).Pear || (window as any).bridge))) {
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
const isPear = Platform.OS === 'web' && typeof window !== 'undefined' && (
  !!(window as any).Pear || !!(window as any).bridge
)

// Types from shared package
import type { Identity, Video } from '@peartube/core'

/**
 * Map raw backend ipcLog messages to short, user-facing status strings.
 * Returns null for messages that don't map to a meaningful UI step.
 */
function friendlyStartupStatus(raw: string): string | null {
  if (!raw) return null
  const s = raw.toLowerCase()
  if (s.includes('owner lock')) return 'Acquiring storage lock…'
  if (s.includes('corestore') || s.includes('lock cleanup')) return 'Cleaning up storage…'
  if (s.includes('initializestorage') || s.includes('storage starting')) return 'Opening local storage…'
  if (s.includes('storage initialized')) return 'Storage ready, starting managers…'
  if (s.includes('managers creating')) return 'Starting background services…'
  if (s.includes('seedingmanager')) return 'Initializing seeding…'
  if (s.includes('loadidentities')) return 'Loading your identity…'
  if (s.includes('backend ready')) return 'Almost there…'
  if (s.includes('lock retry')) return 'Waiting for storage lock…'
  return null
}

// Platform RPC - conditionally imported
let platformRPC: any = null



const BACKEND_SOURCE_CACHE_KEY = '__PEARTUBE_BACKEND_SOURCE__'
const DOWNLOADER_SOURCE_CACHE_KEY = '__PEARTUBE_DOWNLOADER_WORKER_SOURCE__'
const CAST_ACTIVE_GLOBAL_KEY = '__PEARTUBE_CAST_ACTIVE__'
const PeartubeNetworkDiscovery = (NativeModules as any).PeartubeNetworkDiscovery

function requirePeartubeNetworkDiscovery(): any {
  const mod = (NativeModules as any).PeartubeNetworkDiscovery
  if (!mod) {
    throw new Error('PeartubeNetworkDiscovery native module is unavailable')
  }
  return mod
}

type AndroidDiscoveryPermissionStatus = {
  postNotifications?: string
  nearbyWifi?: string
  multicastLockHeld?: boolean
  lastError?: string | null
}

function coerceBundleSource(mod: any): string | null {
  if (typeof mod === 'string') return mod
  if (typeof mod?.default === 'string') return mod.default
  return null
}

function readCachedBundleSources(): { backendSource: string | null; downloaderWorkerSource: string | null } {
  const g = globalThis as any
  const backendSource = typeof g[BACKEND_SOURCE_CACHE_KEY] === 'string' ? g[BACKEND_SOURCE_CACHE_KEY] : null
  const downloaderWorkerSource = typeof g[DOWNLOADER_SOURCE_CACHE_KEY] === 'string' ? g[DOWNLOADER_SOURCE_CACHE_KEY] : null
  return { backendSource, downloaderWorkerSource }
}

function cacheBundleSources(backendSource: string, downloaderWorkerSource?: string | null): void {
  const g = globalThis as any
  g[BACKEND_SOURCE_CACHE_KEY] = backendSource
  if (typeof downloaderWorkerSource === 'string' && downloaderWorkerSource.length > 0) {
    g[DOWNLOADER_SOURCE_CACHE_KEY] = downloaderWorkerSource
  }
}

function loadNativeBundleSources(): { backendSource: string; downloaderWorkerSource?: string } {
  let backendSource: string | null = null
  let downloaderWorkerSource: string | null = null
  let backendLoadError: unknown = null

  try {
    backendSource = coerceBundleSource(require('../backend.bundle.js'))
  } catch (err) {
    backendLoadError = err
  }

  try {
    downloaderWorkerSource = coerceBundleSource(require('../downloader-worker.bundle.js'))
  } catch {
    downloaderWorkerSource = null
  }

  const cached = readCachedBundleSources()
  if (!backendSource) backendSource = cached.backendSource
  if (!downloaderWorkerSource) downloaderWorkerSource = cached.downloaderWorkerSource

  if (backendSource) {
    if (backendLoadError) {
      console.warn('[App] Using cached backend bundle sources after reload resolution miss')
    }
    cacheBundleSources(backendSource, downloaderWorkerSource)
    return downloaderWorkerSource
      ? { backendSource, downloaderWorkerSource }
      : { backendSource }
  }

  if (backendLoadError) throw backendLoadError
  throw new Error('Backend bundles could not be resolved')
}

function getNativeBackendVersionKey(
  backendSource?: string | null,
  downloaderWorkerSource?: string | null,
): string | undefined {
  if (typeof __DEV__ !== 'undefined' && __DEV__) return undefined

  const expoConfig = (Constants as any)?.expoConfig ?? {}
  const version = expoConfig.version || '1.0.0'
  const buildVersion =
    (Constants as any)?.nativeBuildVersion
    || expoConfig.ios?.buildNumber
    || expoConfig.android?.versionCode
    || 'native'

  // Note: `version` (from app.json) and `versionCode` (from android/app/build.gradle)
  // are static across releases unless explicitly bumped. Mix in a content
  // fingerprint of the embedded backend bundle so persisted bundle cache hits
  // do not silently re-launch a stale bundle after an in-place app upgrade.
  return buildBundleVersionKey({
    baseKey: `peartube-native-backend:${version}:${buildVersion}`,
    backendSource,
    downloaderWorkerSource,
  })
}

// Cached app state to persist across soft navigations (component remounts)
// This prevents the "loading" flash when navigating between tabs
let cachedAppState: {
  identity: Identity | null
  videos: Video[]
  blobServerPort: number | null
} | null = null

// AppContext / useApp live in '@/lib/AppContext' to avoid require cycles with VideoPlayerOverlay.

export default function RootLayout() {
  // Brand fonts (headings only — body text stays on the system font).
  // The first frame is held until these resolve (see the gate before the
  // main return): Android measures Text with the fallback font otherwise
  // and keeps the stale width after the swap, clipping the last glyphs.
  const [fontsLoaded, fontsError] = useFonts({
    'SpaceGrotesk-Medium': require('../assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-Bold': require('../assets/fonts/SpaceGrotesk-Bold.ttf'),
  })

  // Initialize state from cache if available (for soft navigation)
  const [ready, setReady] = useState(() => cachedAppState !== null)
  const [identity, setIdentity] = useState<Identity | null>(() => cachedAppState?.identity ?? null)
  const [videos, setVideos] = useState<Video[]>(() => cachedAppState?.videos ?? [])
  const [loading, setLoading] = useState(() => cachedAppState === null)
  const [blobServerPort, setBlobServerPort] = useState<number | null>(() => cachedAppState?.blobServerPort ?? null)
  const [backendError, setBackendError] = useState<string | null>(null)
  const [startupStatus, setStartupStatus] = useState<string | null>(null)
  const [androidDiscoveryPermissionStatus, setAndroidDiscoveryPermissionStatus] = useState<AndroidDiscoveryPermissionStatus | null>(null)
  const statsPollersRef = useRef<Map<string, NodeJS.Timeout>>(new Map())
const castKeepaliveIntervalRef = useRef<NodeJS.Timeout | null>(null)
const castSuspendGraceTimerRef = useRef<NodeJS.Timeout | null>(null)
const castKeepaliveLastErrorLogAtRef = useRef(0)
const lastKnownCastActiveAtRef = useRef(0)
const nativeInitInFlightRef = useRef<Promise<void> | null>(null)
const suspendInFlightRef = useRef(false)
const castActiveRef = useRef<boolean>(false)
const nativeEventsSubscribedRef = useRef(false)
const castPlaybackStateUnsubRef = useRef<(() => void) | null>(null)
const backendReadyRef = useRef(false)
const startupTimerRef = useRef<NodeJS.Timeout | null>(null)
const startupProbeIntervalRef = useRef<NodeJS.Timeout | null>(null)
const lastMirroredPlaybackActiveRef = useRef<boolean | null>(null)
const CAST_ACTIVITY_GRACE_MS = 60 * 60 * 1000
const BACKEND_STARTUP_TIMEOUT_MS = 30000
const FOREGROUND_RESUME_TIMEOUT_MS = 5000

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

  useEffect(() => {
    const syncPlaybackActive = () => {
      if (!platformRPC?.rpc?.setPlaybackActive) return
      const nextActive = Boolean(playbackActiveEmitter.isActive)
      if (lastMirroredPlaybackActiveRef.current === nextActive) return
      lastMirroredPlaybackActiveRef.current = nextActive
      platformRPC.rpc?.setPlaybackActive?.({ active: nextActive }).catch((err: any) => {
        console.log('[App] setPlaybackActive error:', err?.message)
      })
    }

    syncPlaybackActive()
    const interval = setInterval(syncPlaybackActive, 1000)
    return () => clearInterval(interval)
  }, [ready])

  const loadInitialData = useCallback(async () => {
    if (!platformRPC) return

    try {
      const t0 = Date.now()
      const identityResult = await platformRPC.rpc.getIdentities()
      const identities: any[] = identityResult?.identities || []
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
    }
  }, [startupLog])

  const markBackendReady = useCallback(async (source: string, port: number | null) => {
    if (backendReadyRef.current) return
    backendReadyRef.current = true
    if (startupTimerRef.current) {
      clearTimeout(startupTimerRef.current)
      startupTimerRef.current = null
    }
    if (startupProbeIntervalRef.current) {
      clearInterval(startupProbeIntervalRef.current)
      startupProbeIntervalRef.current = null
    }
    startupLog('[Startup] backend ready via', source)
    setBlobServerPort(port)
    setReady(true)
    setLoading(false)
    setBackendError(null)
    setStartupStatus(null)
    loadInitialData().catch((err) => {
      console.error('[App] Background initial data load failed:', err)
    })
  }, [loadInitialData, startupLog])

  // Subscribe to video load events to drive the stats-polling fallback
  useEffect(() => {
    if (!ready || !platformRPC) return

    const unsubscribe = videoLoadEventEmitter.subscribe(async (video: VideoData) => {
      try {
        const resolvedChannelKey =
          video.channelKey
          || (video as any).driveKey
          || (video as any).publicKey
          || (video as any).channel?.key
          || (video as any).channel?.driveKey
          || (video as any).channel?.channelKey
          || ''
        const videoRef = (video.path && typeof video.path === 'string' && video.path.startsWith('/'))
          ? video.path
          : video.id
        if (!resolvedChannelKey) {
          console.log('[App] Stats polling skipped: missing channel key for video', videoRef)
          return
        }

        // Fallback: poll getVideoStats and feed into the context emitter.
        // Some mobile runtimes can be flaky with push events (eventVideoStats) over BareKit IPC.
        // Polling keeps the UI stats bar updated regardless.
        const pollKey = `${resolvedChannelKey}:${videoRef}`
        if (!statsPollersRef.current.has(pollKey)) {
          let attempts = 0
          const poll = async () => {
            attempts++
            try {
              const res = await platformRPC.rpc.getVideoStats({ channelKey: resolvedChannelKey, videoId: videoRef })
              const stats = res?.stats
              if (stats) {
                // Normalize identifiers (some backends include them in stats, some don't)
                videoStatsEventEmitter.emit(resolvedChannelKey, videoRef, {
                  ...stats,
                  channelKey: stats.channelKey || resolvedChannelKey,
                  videoId: stats.videoId || videoRef,
                })
                if (
                  stats.isComplete ||
                  stats.status === 'complete' ||
                  stats.progress >= 100 ||
                  (typeof stats.totalBlocks === 'number' &&
                    stats.totalBlocks > 0 &&
                    stats.downloadedBlocks >= stats.totalBlocks)
                ) {
                  return true
                }
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
        console.error('[App] Failed to start stats polling:', err)
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
    setStartupStatus(null)
    backendReadyRef.current = false
    if (startupTimerRef.current) {
      clearTimeout(startupTimerRef.current)
      startupTimerRef.current = null
    }
    if (startupProbeIntervalRef.current) {
      clearInterval(startupProbeIntervalRef.current)
      startupProbeIntervalRef.current = null
    }

    // Import platform RPC
    platformRPC = await import('@peartube/platform/rpc')

    if (!nativeEventsSubscribedRef.current) {
      platformRPC.events.onReady(async (data: any) => {
        console.log('[App] Backend ready, blobServerPort:', data?.blobServerPort)
        startupLog('[Startup] backend ready ms=', Date.now() - t0)
        const readyPort = typeof data?.blobServerPort === 'number' ? data.blobServerPort : null
        await markBackendReady('eventReady', readyPort)
      })

      platformRPC.events.onError((data: any) => {
        const message = String(data?.message || 'Backend error')
        console.error('[App] Backend error:', message)
        setBackendError(message)
        if (!backendReadyRef.current) {
          setReady(true)
          setLoading(false)
        }
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

      if ((platformRPC.events as any).onCastPlaybackState) {
        castPlaybackStateUnsubRef.current = (platformRPC.events as any).onCastPlaybackState((data: any) => {
          const state = String(data?.state || '').toLowerCase()
          const g = globalThis as Record<string, unknown>
          if (state === 'playing' || state === 'buffering' || state === 'loading' || state === 'paused') {
            lastKnownCastActiveAtRef.current = Date.now()
            castActiveRef.current = true
            g[CAST_ACTIVE_GLOBAL_KEY] = true
            console.log('[CastDiag] onCastPlaybackState: cast active state =', state)
          } else {
            castActiveRef.current = false
            g[CAST_ACTIVE_GLOBAL_KEY] = false
            console.log('[CastDiag] onCastPlaybackState: cast inactive state =', state)
          }
        })
      }

      if ((platformRPC.events as any).onLog) {
        ;(platformRPC.events as any).onLog((data: any) => {
          const level = data?.level || 'info'
          const msg = data?.message || JSON.stringify(data)
          console.log(`[BackendLog/${level}]`, msg)
          // Surface startup progress to UI while backend is still initializing
          if (!backendReadyRef.current && msg) {
            const friendly = friendlyStartupStatus(msg)
            if (friendly) {
              setStartupStatus(friendly)
            }
          }
        })
      }

      nativeEventsSubscribedRef.current = true
    }

    // Initialize with backend source
    // NOTE: `backend.bundle.js` is generated by `npm run bundle:backend`.
    // If it's missing (common when running `expo run:ios` directly), fail gracefully instead of crashing.
    try {
      let resolvedBundleSources: { backendSource: string; downloaderWorkerSource?: string } | null = null
      const readBundleSources = () => {
        if (!resolvedBundleSources) {
          resolvedBundleSources = loadNativeBundleSources()
          console.log('[App] Backend bundle length:', resolvedBundleSources.backendSource?.length || 0)
          if (resolvedBundleSources.downloaderWorkerSource) {
            console.log('[App] Downloader worker bundle length:', resolvedBundleSources.downloaderWorkerSource.length)
          } else {
            console.warn('[App] Downloader worker bundle unavailable - continuing without downloader worker')
          }
        }

        return resolvedBundleSources
      }

      if (!backendReadyRef.current) {
        startupTimerRef.current = setTimeout(() => {
          if (!backendReadyRef.current) {
            console.warn('[App] Backend startup timeout after', BACKEND_STARTUP_TIMEOUT_MS, 'ms — entering degraded mode')
            startupLog('[Startup] TIMEOUT ms=', Date.now() - t0)
            setBackendError('Backend is taking longer than expected. You can browse the UI — it will connect when ready.')
            setReady(true)
            setLoading(false)
          }
          startupTimerRef.current = null
        }, BACKEND_STARTUP_TIMEOUT_MS)
      }

      // Read sources up front so the version key includes a content
      // fingerprint of the embedded bundle. Without this, in-place app
      // upgrades reuse the cached worklet bundle and never run new backend
      // code (the user keeps seeing the same "Connecting to P2P network"
      // behavior even after a fix shipped).
      const sources = readBundleSources()
      const publisherKeyVault = await getNativePublisherKeyVault()

      await platformRPC.initPlatformRPC({
        backendVersionKey: getNativeBackendVersionKey(
          sources.backendSource,
          sources.downloaderWorkerSource,
        ),
        loadBackendSource: async () => sources.backendSource,
        loadDownloaderWorkerSource: async () => sources.downloaderWorkerSource ?? null,
        launchOptions: {
          __peartubeLaunchOptions: true,
        },
        publisherSigner: await getNativePublisherSigner(),
        migrateLegacyPublisherRoot: async (request: unknown) =>
          publisherKeyVault.importLegacyRootMigration(request),
      })
      await ensurePersonalEncryption(platformRPC.rpc)
      startupLog('[Startup] initPlatformRPC returned ms=', Date.now() - t0)

      if (!backendReadyRef.current) {
        console.log('[App] initPlatformRPC resolved before ready callback, marking backend ready directly')
        const modulePort = platformRPC.getBlobServerPort?.()
        const readyPort = typeof modulePort === 'number' ? modulePort : null
        await markBackendReady('initPlatformRPC', readyPort)
      }
    } catch (err) {
      console.error('[App] Failed to initialize platform RPC:', err)
      if (startupTimerRef.current) {
        clearTimeout(startupTimerRef.current)
        startupTimerRef.current = null
      }
      const message = err instanceof Error ? err.message : 'Failed to initialize backend'
      const isMissingBundle =
        message.includes('backend.bundle.js') ||
        message.includes('Backend bundles could not be resolved')

      if (isMissingBundle) {
        setBackendError('Backend bundle is missing. Run `npm run bundle:backend` in packages/app, then restart the app.')
      } else {
        setBackendError(message)
      }
      setReady(true)
      setLoading(false)
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
  }, [markBackendReady, startupLog])

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

        await platformRPC.initPlatformRPC()
      }
      await ensurePersonalEncryption(platformRPC.rpc)

      // Upload UI cannot become ready until the privileged Bun shell has
      // provisioned, initialized, and admitted the one local publisher catalog.
      const publisher = await platformRPC.ensureLocalPublisherCatalog()
      console.log('[App] Local publisher catalog ready:', publisher.publisherId)

      if (alreadyInitialized) {
        // Already initialized - restore from cache or load fresh
        console.log('[App] RPC already initialized, cached state:', cachedAppState ? 'yes' : 'no')
        setBlobServerPort(platformRPC.getBlobServerPort())

        if (cachedAppState) {
          console.log('[App] Using cached state for instant navigation')
          setReady(true)
          setLoading(false)
          loadInitialData().catch(() => {})
          return
        }
        await loadInitialData()
      }
    } catch (err) {
      console.error('[App] Failed to initialize Pear backend:', err)
      setReady(false)
      setLoading(false)
      return
    }

    setReady(true)
    setLoading(false)
  }, [loadInitialData])

  const isCastSessionActive = useCallback(async (): Promise<boolean> => {
    if (!platformRPC?.rpc?.castIsConnected) return false
    console.log('[CastDiag] isCastSessionActive: checking cast status');

    try {
      const connected = await platformRPC.rpc.castIsConnected({})
      if (!connected?.connected) {
        console.log('[CastDiag] isCastSessionActive: RPC failed, using timestamp fallback, lastKnown:', lastKnownCastActiveAtRef.current);
        return Date.now() - lastKnownCastActiveAtRef.current < CAST_ACTIVITY_GRACE_MS
      }
      lastKnownCastActiveAtRef.current = Date.now()

      if (typeof platformRPC.rpc.castGetState === 'function') {
        try {
          const state = await platformRPC.rpc.castGetState({})
          const castState = String(state?.state || '').toLowerCase()
          if (castState === 'stopped') {
            console.log('[CastDiag] isCastSessionActive: castState is', castState, '- returning false');
            return false
          }
          lastKnownCastActiveAtRef.current = Date.now()
        } catch {
          return true
        }
      }

      console.log('[CastDiag] isCastSessionActive: cast is active (no state polled)');
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
    lastKnownCastActiveAtRef.current = Date.now()

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
        if (suspendInFlightRef.current) return
        suspendInFlightRef.current = true

        try {
          if (playbackActiveEmitter.isActive) {
            console.log('[App] Skipping network suspend - local playback is active (state:', nextState + ')')
            suspendInFlightRef.current = false
            return
          }

          if (castActiveRef.current) {
            console.log('[CastDiag] maybeSuspendWithGrace: castActiveRef fast-path, cast is active')
            startCastKeepalive()
            suspendInFlightRef.current = false
            return
          }

          if (await isCastSessionActive()) {
            console.log('[App] Skipping network suspend - cast session is active (state:', nextState + ')')
            startCastKeepalive()
            suspendInFlightRef.current = false
            return
          }

          castSuspendGraceTimerRef.current = setTimeout(async () => {
            castSuspendGraceTimerRef.current = null
            console.log('[CastDiag] maybeSuspendWithGrace: grace timer fired, checking cast state again');

            if (playbackActiveEmitter.isActive) {
              console.log('[App] Grace check: local playback active, skip suspend')
              suspendInFlightRef.current = false
              return
            }

            if (castActiveRef.current) {
              console.log('[CastDiag] maybeSuspendWithGrace: castActiveRef fast-path in timer, cast is active')
              startCastKeepalive()
              suspendInFlightRef.current = false
              return
            }

            if (await isCastSessionActive()) {
              console.log('[App] Grace check: cast session active, skip suspend')
              startCastKeepalive()
              suspendInFlightRef.current = false
              return
            }

            stopCastKeepalive();
            console.log('[CastDiag] maybeSuspendWithGrace: proceeding with suspendNetwork()');
            console.log('[App] Suspending network for app state:', nextState)
            const suspendResult = platformRPC.rpc?.suspendNetwork?.()
            if (suspendResult && typeof (suspendResult as Promise<unknown>).catch === 'function') {
              ;(suspendResult as Promise<unknown>).catch((err: any) => {
                console.log('[App] suspendNetwork error:', err?.message)
              })
            }
            suspendInFlightRef.current = false
          }, 8000)
        } catch (err: any) {
          suspendInFlightRef.current = false
          console.log('[App] maybeSuspendWithGrace error:', err?.message)
      }
      }
      void maybeSuspendWithGrace()
    } else if (nextState === 'active') {
      clearCastSuspendGraceTimer()
      suspendInFlightRef.current = false
      stopCastKeepalive()

      const resumeAndVerifyBackend = async () => {
        console.log('[App] Resuming network from foreground')
        let resumeTimeout: NodeJS.Timeout | null = null
        try {
          await Promise.race([
            Promise.resolve(platformRPC.rpc?.resumeNetwork?.()),
            new Promise<void>((resolve) => {
              resumeTimeout = setTimeout(resolve, FOREGROUND_RESUME_TIMEOUT_MS)
            }),
          ])
        } catch (err: any) {
          console.log('[App] resumeNetwork error:', err?.message)
        } finally {
          if (resumeTimeout) clearTimeout(resumeTimeout)
        }

        if (typeof platformRPC.rpc?.castStartDiscovery === 'function') {
          platformRPC.rpc.castStartDiscovery({}).catch((err: any) => {
            console.log('[App] castStartDiscovery error after foreground:', err?.message)
          })
        }

        const startupState = platformRPC.getStartupState?.() || 'idle'
        const shouldVerifyReadyBackend = Platform.OS === 'android'
          && platformRPC.isInitialized()
          && !nativeInitInFlightRef.current
          && startupState === 'ready'
        const shouldReinitialize = !platformRPC.isInitialized()
          && !nativeInitInFlightRef.current
          && startupState === 'idle'

        if (shouldVerifyReadyBackend) {
          console.log('[App] Verifying native backend after foreground...')
          await initNativeBackend()
        } else if (shouldReinitialize) {
          console.log('[App] Backend not initialized, reinitializing...')
          await initNativeBackend()
        }
      }

      void resumeAndVerifyBackend()
    }
  }, [
    clearCastSuspendGraceTimer,
    initNativeBackend,
    isCastSessionActive,
    startCastKeepalive,
    stopCastKeepalive,
  ])

  const requestAndroidDiscoveryPermissions = useCallback(async (): Promise<AndroidDiscoveryPermissionStatus> => {
    const status: AndroidDiscoveryPermissionStatus = {}

    if (Platform.OS !== 'android') return status

    if (Platform.Version >= 33) {
      try {
        status.postNotifications = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS)
      } catch (err: any) {
        status.postNotifications = 'error'
        status.lastError = err?.message || String(err)
      }

      if (PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES) {
        try {
          status.nearbyWifi = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES)
        } catch (err: any) {
          status.nearbyWifi = 'error'
          status.lastError = err?.message || String(err)
        }
      }
    }

    try {
      const discoveryModule = requirePeartubeNetworkDiscovery()
      const discoveryStatus = await discoveryModule.getDiscoveryNetworkStatus()
      status.multicastLockHeld = discoveryStatus?.multicastLockHeld === true
      status.lastError = discoveryStatus?.lastError ?? status.lastError ?? null
    } catch (err: any) {
      status.multicastLockHeld = false
      status.lastError = err?.message || String(err)
      console.warn('[App] Android network discovery status failed:', status.lastError)
    }

    console.log('[App] Android discovery permission status:', JSON.stringify(status))
    setAndroidDiscoveryPermissionStatus(status)
    return status
  }, [])

  useEffect(() => {
    if (isNative) {
      let cancelled = false
      ;(async () => {
        await requestAndroidDiscoveryPermissions()
        if (!cancelled) initNativeBackend()
      })()

      const subscription = AppState.addEventListener('change', handleAppStateChange)
      return () => {
        cancelled = true
        subscription.remove()
        castPlaybackStateUnsubRef.current?.()
        clearCastSuspendGraceTimer()
        if (startupTimerRef.current) {
          clearTimeout(startupTimerRef.current)
          startupTimerRef.current = null
        }
        if (startupProbeIntervalRef.current) {
          clearInterval(startupProbeIntervalRef.current)
          startupProbeIntervalRef.current = null
        }
        if (castActiveRef.current) {
          console.log('[CastDiag] Unmount: cast active, keeping worklet alive for headless cast')
        } else {
          console.log('[CastDiag] Unmount: cast inactive, terminating worklet')
          stopCastKeepalive()
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
    requestAndroidDiscoveryPermissions,
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
        // Provision keychain-backed at-rest encryption for the personal store
        // before any personal feature is used. Non-blocking, best-effort.
        void ensurePersonalEncryption(platformRPC.rpc, id.publicKey)
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
      const createPromise = platformRPC.rpc.createIdentity(name)
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Create channel timed out. Backend may still be starting.')), 30000)
      })
      const result = await Promise.race([createPromise, timeoutPromise]) as any
      const id = result?.identity
      if (id) {
        setIdentity(id)
        // Provision encryption now so this identity's store is created encrypted.
        void ensurePersonalEncryption(platformRPC.rpc, id.publicKey)
      }
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
    skipThumbnailGeneration: boolean = false,
    mediaMetadata?: import('@peartube/core').UploadVideoEpisodeMetadata
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
        ...mediaMetadata,
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

  // Nothing else in the app supplies the OS signals the backend participation
  // decision runs on, and an unreported signal stays unknown — which the
  // decision treats as a constraint. Reporting starts as soon as the backend is
  // up and re-reports on lifecycle, network, and power changes.
  const activeRpc = platformRPC?.isInitialized?.() ? platformRPC.rpc : null
  useDeviceConditionsReporter(activeRpc)

  const contextValue: AppContextType = {
    ready,
    identity,
    videos,
    loading,
    blobServerPort,
    rpc: platformRPC?.isInitialized?.() ? platformRPC.rpc : null,
    platformEvents: platformRPC?.events,
    backendError,
    startupStatus,
    androidDiscoveryPermissionStatus,
    retryBackend,
    uploadVideo: uploadVideoHandler,
    pickVideoFile: pickVideoFileHandler,
    pickImageFile: pickImageFileHandler,
    loadIdentity: loadIdentityFromBackend,
    createIdentity: createIdentityHandler,
    loadVideos: loadVideosFromBackend,
    removeVideo: (videoId: string) => setVideos(prev => prev.filter(v => v.id !== videoId)),
  }

  // Local font assets resolve within a frame or two; if loading fails we
  // render anyway and headings fall back to the system font.
  if (!fontsLoaded && !fontsError) {
    return <View style={{ flex: 1, backgroundColor: colors.bg }} />
  }

  return (
    <ErrorBoundary onRetry={retryBackend}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
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
                        >
                          <Stack.Screen
                            name="profile"
                            options={{ presentation: 'modal' }}
                          />
                        </Stack>
                      </View>
                      <VideoPlayerOverlay />
                    </SocialProvider>
                  </VideoPlayerProvider>
                </DownloadsProvider>
              </AppContext.Provider>
            </PlatformProvider>
          </GluestackUIProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </ErrorBoundary>
  )
}
