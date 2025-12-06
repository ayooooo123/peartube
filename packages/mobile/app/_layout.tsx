/**
 * Root Layout - Wraps app with providers
 */
import '../global.css'
import { useEffect, useState, createContext, useContext, useRef, useCallback } from 'react'
import { Stack } from 'expo-router'
import { StatusBar, View, Text, Platform, AppState, AppStateStatus } from 'react-native'
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
// Check for Pear runtime (available on Pear desktop)
const isPear = Platform.OS === 'web' && typeof window !== 'undefined' && !!(window as any).Pear

// Native-only imports (not available on web)
let Worklet: any = null
let HRPC: any = null
let FileSystem: any = null

if (isNative) {
  Worklet = require('react-native-bare-kit').Worklet
  HRPC = require('@peartube/spec')
  FileSystem = require('expo-file-system')
}

// Module-level worklet reference for lifecycle management
let workletInstance: any = null

// Note: We now use HRPC typed methods directly instead of command IDs

// Types from shared package
import type { Identity, Video } from '@peartube/core'

interface AppContextType {
  ready: boolean
  identity: Identity | null
  videos: Video[]
  loading: boolean
  blobServerPort: number | null
  rpc: any // HRPC instance - typed methods available
  uploadVideo: (filePath: string, title: string, description: string, mimeType?: string, onProgress?: (progress: number) => void) => Promise<any>
  pickVideoFile: () => Promise<{ filePath: string; name: string; size: number } | { cancelled: true } | null>
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
  const rpcRef = useRef<any>(null)

  useEffect(() => {
    if (isNative) {
      // Handle app state changes for worklet lifecycle
      const handleAppStateChange = (nextState: AppStateStatus) => {
        if (nextState === 'background' || nextState === 'inactive') {
          if (workletInstance) {
            console.log('[App] Terminating worklet for background')
            try {
              workletInstance.terminate()
            } catch (err) {
              console.error('[App] Failed to terminate worklet:', err)
            }
            workletInstance = null
            rpcRef.current = null
            setReady(false)
          }
        } else if (nextState === 'active' && !workletInstance) {
          console.log('[App] Re-initializing backend from foreground')
          initBackend()
        }
      }

      const subscription = AppState.addEventListener('change', handleAppStateChange)
      initBackend()

      return () => {
        subscription.remove()
        // Cleanup on unmount
        if (workletInstance) {
          workletInstance.terminate()
          workletInstance = null
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
    if (!ready) return

    const unsubscribe = videoLoadEventEmitter.subscribe(async (video: VideoData) => {
      if (!rpcRef.current) return

      console.log('[App] Video loaded, starting prefetch for:', video.title)
      try {
        // Call prefetchVideo via HRPC to start P2P download and stats streaming
        await rpcRef.current.prefetchVideo({
          channelKey: video.channelKey,
          videoId: video.path,
        })
        console.log('[App] prefetchVideo sent for:', video.path)
      } catch (err) {
        console.error('[App] Failed to start prefetch:', err)
      }
    })

    return unsubscribe
  }, [ready])

  async function initBackend() {
    console.log('[App] Initializing backend with HRPC...')

    // Create and store worklet reference for lifecycle management
    const worklet = new Worklet()
    workletInstance = worklet

    // Get document directory for storage (strip file:// prefix for bare-fs)
    let storageDir = FileSystem.documentDirectory || ''
    if (storageDir.startsWith('file://')) {
      storageDir = storageDir.slice(7)
    }

    // Load bundled backend
    const backendSource = require('../backend.bundle.js')
    console.log('[App] Backend bundle length:', backendSource?.length || 0)

    try {
      worklet.start('/backend.bundle', backendSource, [storageDir])
      console.log('[App] Backend worklet started')
    } catch (err) {
      console.error('[App] Backend worklet failed:', err)
      workletInstance = null
      return
    }

    const { IPC } = worklet

    // Setup HRPC client with the IPC stream
    const rpc = new HRPC(IPC)
    rpcRef.current = rpc
    console.log('[App] HRPC client initialized')

    // Register event handlers
    rpc.onEventReady(async (data: any) => {
      console.log('[App] Backend ready, blobServerPort:', data?.blobServerPort)
      if (data?.blobServerPort) {
        setBlobServerPort(data.blobServerPort)
      }
      setReady(true)

      // Load identity after ready
      try {
        setLoading(true)
        const result = await rpc.getIdentity({})
        const id = result?.identity
        if (id) {
          setIdentity(id)
          if (id.driveKey) {
            const videosResult = await rpc.listVideos({ channelKey: id.driveKey })
            setVideos(videosResult?.videos || [])
          }
        }
      } catch (err) {
        console.error('[App] Failed to load identity:', err)
      } finally {
        setLoading(false)
      }
    })

    rpc.onEventError((data: any) => {
      console.error('[App] Backend error:', data?.message)
    })

    rpc.onEventVideoStats((data: any) => {
      // Push stats to VideoPlayerContext via event emitter
      console.log('[App] Received video stats event:', data?.stats?.progress + '%')
      if (data?.channelKey && data?.videoId && data?.stats) {
        videoStatsEventEmitter.emit(data.channelKey, data.videoId, data.stats)
      }
    })

    rpc.onEventUploadProgress((data: any) => {
      console.log('[App] Upload progress:', data?.progress + '%')
    })
  }

  async function initPearBackend() {
    console.log('[App] Initializing Pear desktop backend via PearWorkerClient...')

    // Access PearWorkerClient (set up by worker-client.js unbundled script)
    const workerClient = (window as any).PearWorkerClient
    if (!workerClient) {
      console.error('[App] PearWorkerClient not available')
      setReady(true)
      setLoading(false)
      return
    }

    try {
      // Initialize the worker client (spawns worker, sets up HRPC)
      await workerClient.initialize()

      const rpc = workerClient.getRpc()
      if (!rpc) {
        throw new Error('Failed to get RPC from worker client')
      }

      rpcRef.current = rpc
      console.log('[App] HRPC client ready')

      // Set blob server port
      if (workerClient.blobServerPort) {
        setBlobServerPort(workerClient.blobServerPort)
      }

      // Subscribe to video stats events from worker
      window.addEventListener('pearVideoStats', ((e: CustomEvent) => {
        const data = e.detail
        if (data?.channelKey && data?.videoId && data?.stats) {
          videoStatsEventEmitter.emit(data.channelKey, data.videoId, data.stats)
        }
      }) as EventListener)

      // Load identities and set active one
      console.log('[App] Loading identities via HRPC...')
      const result = await rpc.getIdentities({})
      const identities = result?.identities || []
      console.log('[App] Got', identities.length, 'identities')

      if (identities.length > 0) {
        const active = identities.find((id: any) => id.isActive) || identities[0]
        setIdentity(active)

        // Load videos for the active identity
        if (active?.driveKey) {
          console.log('[App] Loading videos for drive:', active.driveKey)
          const videosResult = await rpc.listVideos({ channelKey: active.driveKey })
          setVideos(videosResult?.videos || [])
        }
      }

      // Get blob server port if not already set
      if (!workerClient.blobServerPort) {
        const portResult = await rpc.getBlobServerPort({})
        if (portResult?.port) {
          setBlobServerPort(portResult.port)
          console.log('[App] Blob server port:', portResult.port)
        }
      }
    } catch (err) {
      console.error('[App] Failed to initialize Pear backend:', err)
    }

    setReady(true)
    setLoading(false)
  }

  // Load identity using HRPC
  const loadIdentityFromBackend = useCallback(async () => {
    if (!rpcRef.current) return
    try {
      setLoading(true)
      const result = await rpcRef.current.getIdentity({})
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

  // Load videos using HRPC
  const loadVideosFromBackend = useCallback(async (driveKey: string) => {
    if (!rpcRef.current) return
    try {
      const result = await rpcRef.current.listVideos({ channelKey: driveKey })
      setVideos(result?.videos || [])
    } catch (err) {
      console.error('[App] Failed to load videos:', err)
    }
  }, [])

  // Create identity using HRPC
  const createIdentityHandler = useCallback(async (name: string): Promise<Identity> => {
    if (!rpcRef.current) throw new Error('RPC not ready')
    setLoading(true)
    try {
      const result = await rpcRef.current.createIdentity({ name })
      const id = result?.identity
      setIdentity(id)
      return id
    } finally {
      setLoading(false)
    }
  }, [])

  // Upload video using HRPC
  // Worker handles streaming to Hyperdrive
  const uploadVideoHandler = useCallback(async (
    filePath: string,
    title: string,
    description: string,
    mimeType: string = 'video/mp4',
    onProgress?: (progress: number) => void
  ): Promise<any> => {
    if (!rpcRef.current) {
      throw new Error('RPC not ready')
    }

    console.log('[App] Uploading video:', filePath)

    // Use HRPC uploadVideo method - progress comes via eventUploadProgress events
    const result = await rpcRef.current.uploadVideo({
      filePath,
      title,
      description,
    })

    console.log('[App] Upload complete:', result)

    // Reload videos
    if (identity?.driveKey) {
      await loadVideosFromBackend(identity.driveKey)
    }

    return result?.video
  }, [identity, loadVideosFromBackend])

  // Pick video file using native file picker
  const pickVideoFileHandler = useCallback(async (): Promise<{ filePath: string; name: string; size: number } | { cancelled: true } | null> => {
    if (!rpcRef.current) {
      console.log('[App] pickVideoFile: RPC not ready')
      return null
    }

    console.log('[App] Opening native file picker...')
    return await rpcRef.current.pickVideoFile({})
  }, [])

  const contextValue: AppContextType = {
    ready,
    identity,
    videos,
    loading,
    blobServerPort,
    rpc: rpcRef.current, // Direct HRPC instance access
    uploadVideo: uploadVideoHandler,
    pickVideoFile: pickVideoFileHandler,
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
