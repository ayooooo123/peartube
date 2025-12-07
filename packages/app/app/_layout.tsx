/**
 * Root Layout - Wraps app with providers
 *
 * Uses @peartube/platform/rpc for unified backend communication.
 */
import '../global.css'
import { useEffect, useState, createContext, useContext, useCallback } from 'react'
import { Stack } from 'expo-router'
import { StatusBar, View, Platform, AppState, AppStateStatus } from 'react-native'
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider'
import { PlatformProvider } from '@/lib/PlatformProvider'
import { VideoPlayerProvider, videoStatsEventEmitter, videoLoadEventEmitter, VideoData } from '@/lib/VideoPlayerContext'
import { VideoPlayerOverlay } from '@/components/VideoPlayerOverlay'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { colors } from '@/lib/colors'

// Re-export colors for backward compatibility
export { colors }

// Platform detection
const isNative = Platform.OS !== 'web'
const isPear = Platform.OS === 'web' && typeof window !== 'undefined' && !!(window as any).Pear

// Types from shared package
import type { Identity, Video } from '@peartube/core'

// Platform RPC - conditionally imported
let platformRPC: any = null

interface AppContextType {
  ready: boolean
  identity: Identity | null
  videos: Video[]
  loading: boolean
  blobServerPort: number | null
  rpc: any
  uploadVideo: (filePath: string, title: string, description: string, mimeType?: string, category?: string, onProgress?: (progress: number) => void) => Promise<any>
  pickVideoFile: () => Promise<{ filePath: string; name: string; size: number } | { cancelled: true } | null>
  pickImageFile: () => Promise<{ filePath: string; name: string; size: number } | { cancelled: true } | null>
  loadIdentity: () => Promise<void>
  createIdentity: (name: string) => Promise<Identity>
  loadVideos: (driveKey: string) => Promise<void>
}

const AppContext = createContext<AppContextType | null>(null)

export function useApp() {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used within AppProvider')
  return ctx
}

export default function RootLayout() {
  const [ready, setReady] = useState(false)
  const [identity, setIdentity] = useState<Identity | null>(null)
  const [videos, setVideos] = useState<Video[]>([])
  const [loading, setLoading] = useState(true)
  const [blobServerPort, setBlobServerPort] = useState<number | null>(null)

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
        await platformRPC.rpc.prefetchVideo(video.channelKey, video.path)
        console.log('[App] prefetchVideo sent for:', video.path)
      } catch (err) {
        console.error('[App] Failed to start prefetch:', err)
      }
    })

    return unsubscribe
  }, [ready])

  function handleAppStateChange(nextState: AppStateStatus) {
    if (!platformRPC) return

    if (nextState === 'background' || nextState === 'inactive') {
      console.log('[App] Terminating backend for background')
      platformRPC.terminatePlatformRPC()
      setReady(false)
    } else if (nextState === 'active' && !platformRPC.isInitialized()) {
      console.log('[App] Re-initializing backend from foreground')
      initNativeBackend()
    }
  }

  async function initNativeBackend() {
    console.log('[App] Initializing native backend via platform RPC...')

    // Import platform RPC
    platformRPC = await import('@peartube/platform/rpc')

    // Subscribe to events before initialization
    platformRPC.events.onReady(async (data: any) => {
      console.log('[App] Backend ready, blobServerPort:', data?.blobServerPort)
      setBlobServerPort(data?.blobServerPort || null)
      setReady(true)

      // Load identity after ready
      await loadInitialData()
    })

    platformRPC.events.onError((data: any) => {
      console.error('[App] Backend error:', data?.message)
    })

    platformRPC.events.onVideoStats((data: any) => {
      if (data?.channelKey && data?.videoId && data?.stats) {
        videoStatsEventEmitter.emit(data.channelKey, data.videoId, data.stats)
      }
    })

    platformRPC.events.onUploadProgress((data: any) => {
      console.log('[App] Upload progress:', data?.progress + '%')
    })

    // Initialize with backend source
    const backendSource = require('../backend.bundle.js')
    console.log('[App] Backend bundle length:', backendSource?.length || 0)

    try {
      await platformRPC.initPlatformRPC({ backendSource })
    } catch (err) {
      console.error('[App] Failed to initialize platform RPC:', err)
    }
  }

  async function initPearBackend() {
    console.log('[App] Initializing Pear desktop backend via platform RPC...')

    try {
      // Import platform RPC for web
      platformRPC = await import('@peartube/platform/rpc')

      // Subscribe to events
      platformRPC.events.onReady(async (data: any) => {
        console.log('[App] Backend ready, blobServerPort:', data?.blobServerPort)
        setBlobServerPort(data?.blobServerPort || null)
        await loadInitialData()
      })

      platformRPC.events.onVideoStats((data: any) => {
        if (data?.channelKey && data?.videoId && data?.stats) {
          videoStatsEventEmitter.emit(data.channelKey, data.videoId, data.stats)
        }
      })

      // Initialize
      await platformRPC.initPlatformRPC()
    } catch (err) {
      console.error('[App] Failed to initialize Pear backend:', err)
    }

    setReady(true)
    setLoading(false)
  }

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

        // Load videos for active identity
        if (active?.driveKey) {
          const videosResult = await platformRPC.rpc.listVideos(active.driveKey)
          setVideos(videosResult?.videos || [])
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
      setIdentity(id)

      if (id?.driveKey) {
        await loadVideosFromBackend(id.driveKey)
      }
    } catch (err) {
      console.error('[App] Failed to load identity:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadVideosFromBackend = useCallback(async (driveKey: string) => {
    if (!platformRPC) return
    try {
      const result = await platformRPC.rpc.listVideos(driveKey)
      setVideos(result?.videos || [])
    } catch (err) {
      console.error('[App] Failed to load videos:', err)
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
    onProgress?: (progress: number) => void,
    skipThumbnailGeneration: boolean = false
  ): Promise<any> => {
    if (!platformRPC) throw new Error('RPC not ready')

    console.log('[App] Uploading video:', filePath, 'category:', category, 'skipThumbnailGeneration:', skipThumbnailGeneration)

    const result = await platformRPC.rpc.uploadVideo({
      filePath,
      title,
      description,
      category,
      skipThumbnailGeneration,
    })
    console.log('[App] Upload complete:', result)

    // Reload videos
    if (identity?.driveKey) {
      await loadVideosFromBackend(identity.driveKey)
    }

    return result?.video
  }, [identity, loadVideosFromBackend])

  const pickVideoFileHandler = useCallback(async () => {
    if (!platformRPC) return null
    return await platformRPC.rpc.pickVideoFile()
  }, [])

  const pickImageFileHandler = useCallback(async () => {
    if (!platformRPC) return null
    return await platformRPC.rpc.pickImageFile()
  }, [])

  const contextValue: AppContextType = {
    ready,
    identity,
    videos,
    loading,
    blobServerPort,
    rpc: platformRPC?.rpc,
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
                <VideoPlayerOverlay />
              </View>
            </VideoPlayerProvider>
          </AppContext.Provider>
        </PlatformProvider>
      </GluestackUIProvider>
    </GestureHandlerRootView>
  )
}
