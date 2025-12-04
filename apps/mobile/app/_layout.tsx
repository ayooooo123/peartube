/**
 * Root Layout - Wraps app with providers
 */
import '../global.css'
import { useEffect, useState, createContext, useContext, useRef, useCallback } from 'react'
import { Stack } from 'expo-router'
import { StatusBar, View, Text, Platform } from 'react-native'
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
// Check for PearWorkerClient which is set by worker-client.js preload script
const isPear = Platform.OS === 'web' && typeof window !== 'undefined' && !!(window as any).PearWorkerClient

// Native-only imports (not available on web)
let Worklet: any = null
let RPC: any = null
let b4a: any = null
let FileSystem: any = null
let Commands: any = null
let pearRun: any = null
let path: any = null

if (isNative) {
  Worklet = require('react-native-bare-kit').Worklet
  RPC = require('bare-rpc')
  b4a = require('b4a')
  FileSystem = require('expo-file-system')
  Commands = require('../rpc-commands.mjs').RPC
}
// Note: Pear modules (bare-rpc, b4a, pear-run, path) are loaded dynamically
// in initPearBackend() using Pear's require to bypass the web bundler

// Desktop command IDs (different from mobile)
const PearCommands = {
  GET_STATUS: 1,
  CREATE_IDENTITY: 2,
  GET_IDENTITIES: 3,
  SET_ACTIVE_IDENTITY: 4,
  LIST_VIDEOS: 5,
  GET_VIDEO_URL: 6,
  SUBSCRIBE_CHANNEL: 7,
  GET_SUBSCRIPTIONS: 8,
  GET_BLOB_SERVER_PORT: 9,
  UPLOAD_VIDEO: 10, // Upload via file path - bare-fs streams to Hyperdrive
  GET_CHANNEL: 11,
  RECOVER_IDENTITY: 12,
  PICK_VIDEO_FILE: 13, // Native file picker using osascript
  // Public Feed (P2P Discovery)
  GET_PUBLIC_FEED: 14,
  REFRESH_FEED: 15,
  SUBMIT_TO_FEED: 16,
  HIDE_CHANNEL: 17,
  GET_CHANNEL_META: 18,
}

// Types from shared package
import type { Identity, Video } from '@peartube/shared'

interface AppContextType {
  ready: boolean
  identity: Identity | null
  videos: Video[]
  loading: boolean
  blobServerPort: number | null
  rpcCall: (command: number, data?: any) => Promise<any>
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
  const pearPipeRef = useRef<any>(null)
  const pendingRequestsRef = useRef<Map<string, { resolve: Function, reject: Function, timeout: NodeJS.Timeout }>>(new Map())
  const requestIdRef = useRef<number>(0)

  useEffect(() => {
    if (isNative) {
      initBackend()
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
    if (!isNative || !ready) return

    const unsubscribe = videoLoadEventEmitter.subscribe(async (video: VideoData) => {
      if (!rpcRef.current || !Commands) return

      console.log('[App] Video loaded, starting prefetch for:', video.title)
      try {
        // Call PREFETCH_VIDEO to start P2P download and stats streaming
        const requestId = ++requestIdRef.current
        const pendingKey = String(requestId)

        const request = rpcRef.current.request(Commands.PREFETCH_VIDEO)
        request.send(b4a.from(JSON.stringify({
          driveKey: video.channelKey,
          videoPath: video.path,
          _requestId: requestId
        })))

        console.log('[App] PREFETCH_VIDEO sent for:', video.path)
      } catch (err) {
        console.error('[App] Failed to start prefetch:', err)
      }
    })

    return unsubscribe
  }, [ready])

  async function initBackend() {
    console.log('[App] Initializing backend...')

    const worklet = new Worklet()

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
      return
    }

    const { IPC } = worklet

    // Setup RPC
    const rpcClient = new RPC(IPC, (req: any) => {
      const command = req.command
      const data = req.data ? JSON.parse(b4a.toString(req.data)) : {}

      console.log('[App] Backend event:', command, data)

      // Check if response to pending request - use _requestId if present
      const requestId = data._requestId
      const pendingKey = requestId !== undefined ? String(requestId) : String(command)
      const pending = pendingRequestsRef.current.get(pendingKey)
      if (pending) {
        clearTimeout(pending.timeout)
        pendingRequestsRef.current.delete(pendingKey)
        if (data.success) {
          pending.resolve(data.data)
        } else {
          pending.reject(new Error(data.error || 'Unknown error'))
        }
        return
      }

      // Handle events
      if (command === Commands.EVENT_READY) {
        setReady(true)
        loadIdentityFromBackend()
      } else if (command === Commands.EVENT_ERROR) {
        console.error('[App] Backend error:', data.error)
      } else if (command === Commands.EVENT_VIDEO_STATS) {
        // Push stats to VideoPlayerContext via event emitter
        console.log('[App] Received video stats event:', data.stats?.progress + '%')
        if (data.driveKey && data.videoPath && data.stats) {
          videoStatsEventEmitter.emit(data.driveKey, data.videoPath, data.stats)
        }
      }
    })

    rpcRef.current = rpcClient
    console.log('[App] RPC client initialized')
  }

  async function initPearBackend() {
    console.log('[App] Initializing Pear desktop backend...')

    // Check for PearWorkerClient which is injected by worker-client.js preload script
    const workerClient = (window as any).PearWorkerClient
    if (!workerClient) {
      console.error('[App] PearWorkerClient not available - worker-client.js may not have loaded')
      setReady(true)
      setLoading(false)
      return
    }

    // Initialize the worker client (uses pear-run with newline-delimited JSON)
    console.log('[App] Initializing PearWorkerClient...')

    try {
      // PearWorkerClient.initialize() spawns the worker and waits for worker_initialized
      await workerClient.initialize()
      pearPipeRef.current = workerClient
    } catch (err) {
      console.error('[App] Failed to initialize worker:', err)
      setReady(true)
      setLoading(false)
      return
    }

    if (!workerClient.isConnected) {
      console.error('[App] Worker not connected')
      setReady(true)
      setLoading(false)
      return
    }

    // PearWorkerClient provides .call() method for RPC
    rpcRef.current = workerClient
    console.log('[App] Pear RPC client initialized via PearWorkerClient')

    // Get blob server port and load identity
    try {
      const portResult = await pearRpcCall(PearCommands.GET_BLOB_SERVER_PORT, {})
      if (portResult?.port) {
        setBlobServerPort(portResult.port)
        console.log('[App] Blob server port:', portResult.port)
      }

      // Load identities and set active one
      const identities = await pearRpcCall(PearCommands.GET_IDENTITIES, {})
      if (identities && identities.length > 0) {
        const active = identities.find((id: any) => id.isActive) || identities[0]
        setIdentity(active)

        // Load videos for the active identity
        if (active?.driveKey) {
          const vids = await pearRpcCall(PearCommands.LIST_VIDEOS, { driveKey: active.driveKey })
          setVideos(vids || [])
        }
      }
    } catch (err) {
      console.error('[App] Failed to initialize Pear backend:', err)
    }

    setReady(true)
    setLoading(false)
  }

  // Pear-specific RPC call using simple JSON protocol over pipe
  async function pearRpcCall(command: number, data: any = {}): Promise<any> {
    if (!rpcRef.current) throw new Error('RPC not ready')
    return rpcRef.current.call(command, data)
  }

  const rpcCall = useCallback(async (command: number, data: any = {}): Promise<any> => {
    if (!rpcRef.current) throw new Error('RPC not ready')

    return new Promise((resolve, reject) => {
      // Generate unique request ID
      const requestId = ++requestIdRef.current
      const pendingKey = String(requestId)

      const timeout = setTimeout(() => {
        pendingRequestsRef.current.delete(pendingKey)
        reject(new Error('RPC timeout'))
      }, 30000)

      pendingRequestsRef.current.set(pendingKey, { resolve, reject, timeout })

      const request = rpcRef.current.request(command)
      request.send(b4a.from(JSON.stringify({ ...data, _requestId: requestId })))
    })
  }, [])

  const loadIdentityFromBackend = useCallback(async () => {
    try {
      setLoading(true)
      const id = await rpcCall(Commands.GET_IDENTITY)
      setIdentity(id)

      if (id?.driveKey) {
        await loadVideosFromBackend(id.driveKey)
      }
    } catch (err) {
      console.error('[App] Failed to load identity:', err)
    } finally {
      setLoading(false)
    }
  }, [rpcCall])

  const loadVideosFromBackend = useCallback(async (driveKey: string) => {
    try {
      if (isPear) {
        const vids = await pearRpcCall(PearCommands.LIST_VIDEOS, { driveKey })
        setVideos(vids || [])
      } else {
        const vids = await rpcCall(Commands.LIST_VIDEOS, { driveKey })
        setVideos(vids || [])
      }
    } catch (err) {
      console.error('[App] Failed to load videos:', err)
    }
  }, [rpcCall])

  const createIdentityHandler = useCallback(async (name: string): Promise<Identity> => {
    setLoading(true)
    try {
      if (isPear) {
        const id = await pearRpcCall(PearCommands.CREATE_IDENTITY, { name })
        setIdentity(id)
        return id
      } else {
        const id = await rpcCall(Commands.CREATE_IDENTITY, { name })
        setIdentity(id)
        return id
      }
    } finally {
      setLoading(false)
    }
  }, [rpcCall])

  // Upload video for Pear desktop - simple file path based upload
  // Worker handles streaming with bare-fs to Hyperdrive
  const uploadVideoHandler = useCallback(async (
    filePath: string,
    title: string,
    description: string,
    mimeType: string = 'video/mp4',
    onProgress?: (progress: number) => void
  ): Promise<any> => {
    if (!isPear || !rpcRef.current) {
      throw new Error('Upload only available on Pear desktop')
    }

    console.log('[App] Uploading video:', filePath)

    // RPC call with progress callback - worker sends progress events during upload
    const result = await rpcRef.current.call(PearCommands.UPLOAD_VIDEO, {
      filePath,
      title,
      description,
      mimeType,
    }, onProgress ? (progress: number) => onProgress(progress) : null)

    console.log('[App] Upload complete:', result)

    // Reload videos
    if (identity?.driveKey) {
      const vids = await pearRpcCall(PearCommands.LIST_VIDEOS, { driveKey: identity.driveKey })
      setVideos(vids || [])
    }

    return result
  }, [identity])

  // Pick video file using native file picker (Pear desktop only)
  const pickVideoFileHandler = useCallback(async (): Promise<{ filePath: string; name: string; size: number } | { cancelled: true } | null> => {
    if (!isPear || !rpcRef.current) {
      console.log('[App] pickVideoFile only available on Pear desktop')
      return null
    }

    console.log('[App] Opening native file picker...')
    return rpcRef.current.call(PearCommands.PICK_VIDEO_FILE, {})
  }, [])

  const contextValue: AppContextType = {
    ready,
    identity,
    videos,
    loading,
    blobServerPort,
    rpcCall: isPear ? pearRpcCall : rpcCall,
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
