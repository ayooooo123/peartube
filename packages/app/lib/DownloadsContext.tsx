/**
 * DownloadsContext - Global downloads manager state
 * Provides browser-style downloads queue with progress tracking
 * Works across all platforms (iOS, Android, Desktop, Web)
 */
import { createContext, useContext, useState, useCallback, useEffect, ReactNode, useRef, useMemo } from 'react'
import { Platform, Alert } from 'react-native'
import { events } from '@peartube/platform/rpc'
import type { VideoData } from '@peartube/core'

// Download item status
export type DownloadStatus = 'queued' | 'downloading' | 'complete' | 'error' | 'cancelled'

// Download item interface
export interface DownloadItem {
  id: string                    // `${channelKey}:${videoId}`
  videoId: string
  channelKey: string
  title: string
  thumbnail?: string
  status: DownloadStatus
  progress: number              // 0-100
  bytesDownloaded: number
  totalBytes: number
  speed: string                 // "2.5 MB/s"
  filePath?: string             // Final saved path
  error?: string
  startedAt: number
  completedAt?: number
}

// Event emitter for download progress (allows RPC handler to push progress)
type DownloadProgressListener = (id: string, progress: number, bytesDownloaded: number, totalBytes: number) => void
const progressListeners = new Set<DownloadProgressListener>()

export const downloadProgressEventEmitter = {
  emit: (id: string, progress: number, bytesDownloaded: number, totalBytes: number) => {
    progressListeners.forEach(listener => {
      listener(id, progress, bytesDownloaded, totalBytes)
    })
  },
  subscribe: (listener: DownloadProgressListener) => {
    progressListeners.add(listener)
    return () => progressListeners.delete(listener)
  }
}

interface DownloadsContextType {
  // Downloads list
  downloads: DownloadItem[]
  activeCount: number

  // Actions
  addDownload: (video: VideoData, rpc: any) => Promise<void>
  cancelDownload: (id: string) => void
  removeDownload: (id: string) => Promise<void>
  clearCompleted: () => void
  retryDownload: (id: string, rpc: any) => Promise<void>
}

const DownloadsContext = createContext<DownloadsContextType | null>(null)

export function useDownloads() {
  const ctx = useContext(DownloadsContext)
  if (!ctx) throw new Error('useDownloads must be used within DownloadsProvider')
  return ctx
}

// Helper to format bytes
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

// Helper to sanitize filename
function sanitizeFilename(title: string): string {
  return title
    .replace(/[^a-zA-Z0-9\s\-_]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 50)
}

// Get file extension from MIME type
function getExtension(mimeType?: string): string {
  if (mimeType?.includes('webm')) return 'webm'
  if (mimeType?.includes('matroska') || mimeType?.includes('mkv')) return 'mkv'
  return 'mp4'
}

interface DownloadsProviderProps {
  children: ReactNode
}

export function DownloadsProvider({ children }: DownloadsProviderProps) {
  const [downloads, setDownloads] = useState<DownloadItem[]>([])
  const abortControllers = useRef<Map<string, AbortController>>(new Map())
  const speedTrackers = useRef<Map<string, { lastBytes: number; lastTime: number }>>(new Map())

  // Throttle refs for batching progress updates (max 4 updates/second)
  const pendingUpdatesRef = useRef<Map<string, { progress: number; bytesDownloaded: number; totalBytes: number }>>(new Map())
  const flushTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Calculate active downloads count
  const activeCount = downloads.filter(d => d.status === 'downloading' || d.status === 'queued').length

  // Handle progress update from any source (throttled - batches updates every 250ms)
  const handleProgressUpdate = useCallback((id: string, progress: number, bytesDownloaded: number, totalBytes: number) => {
    pendingUpdatesRef.current.set(id, { progress, bytesDownloaded, totalBytes })

    if (!flushTimeoutRef.current) {
      flushTimeoutRef.current = setTimeout(() => {
        const updates = pendingUpdatesRef.current
        pendingUpdatesRef.current = new Map()
        flushTimeoutRef.current = null

        if (updates.size === 0) return

        setDownloads(prev => prev.map(d => {
          const update = updates.get(d.id)
          if (!update) return d

          // Calculate speed
          const tracker = speedTrackers.current.get(d.id)
          const now = Date.now()
          let speed = d.speed

          if (tracker) {
            const timeDelta = (now - tracker.lastTime) / 1000 // seconds
            if (timeDelta > 0.5) { // Update speed every 500ms
              const bytesDelta = update.bytesDownloaded - tracker.lastBytes
              const bytesPerSec = bytesDelta / timeDelta
              speed = formatBytes(bytesPerSec) + '/s'
              speedTrackers.current.set(d.id, { lastBytes: update.bytesDownloaded, lastTime: now })
            }
          } else {
            speedTrackers.current.set(d.id, { lastBytes: update.bytesDownloaded, lastTime: now })
          }

          return {
            ...d,
            progress: update.progress,
            bytesDownloaded: update.bytesDownloaded,
            totalBytes: update.totalBytes,
            speed,
            status: 'downloading' as DownloadStatus
          }
        }))
      }, 250)
    }
  }, [])

  // Subscribe to progress events from internal emitter (for web)
  useEffect(() => {
    const unsubscribe = downloadProgressEventEmitter.subscribe(handleProgressUpdate)
    return () => { unsubscribe() }
  }, [handleProgressUpdate])

  // Subscribe to platform events (for mobile - backend emits progress via HRPC)
  useEffect(() => {
    if (Platform.OS === 'web') return // Web uses internal emitter

    const unsubscribe = events.onDownloadProgress((data) => {
      console.log('[Downloads] Platform progress event:', data.id, data.progress)
      handleProgressUpdate(data.id, data.progress, data.bytesDownloaded || 0, data.totalBytes || 0)
    })
    return () => { unsubscribe() }
  }, [handleProgressUpdate])

  // Clean up flush timeout on unmount
  useEffect(() => {
    return () => {
      if (flushTimeoutRef.current) {
        clearTimeout(flushTimeoutRef.current)
        flushTimeoutRef.current = null
      }
    }
  }, [])

   const downloadForWeb = useCallback(async (id: string, url: string, filename: string, signal: AbortSignal) => {
     console.log('[Downloads] Web download:', filename)

    const response = await fetch(url, { signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)

    const contentLength = response.headers.get('content-length')
    const totalBytes = contentLength ? parseInt(contentLength, 10) : 0
    console.log('[Downloads] Content-Length:', totalBytes)

    const reader = response.body?.getReader()
    if (!reader) {
      throw new Error('Response body not readable')
    }

    const chunks: ArrayBuffer[] = []
    let bytesReceived = 0

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue

      const copy = new ArrayBuffer(value.byteLength)
      new Uint8Array(copy).set(value)
      chunks.push(copy)
      bytesReceived += value.length

      const progress = totalBytes > 0 ? Math.round((bytesReceived / totalBytes) * 100) : 0
      downloadProgressEventEmitter.emit(id, progress, bytesReceived, totalBytes)
    }

    const blob = new Blob(chunks)
    const blobUrl = URL.createObjectURL(blob)
    console.log('[Downloads] Download complete, size:', blob.size)

    const a = document.createElement('a')
    a.href = blobUrl
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(blobUrl)

    downloadProgressEventEmitter.emit(id, 100, blob.size, blob.size)
  }, [])

   const addDownload = useCallback(async (video: VideoData, rpc: any) => {
     const id = `${video.channelKey}:${video.id || video.path}`

     // Check if already downloading (using functional update to avoid dependency)
     let isAlreadyDownloading = false
     setDownloads(prev => {
       const existing = prev.find(d => d.id === id)
       if (existing && (existing.status === 'downloading' || existing.status === 'queued')) {
         isAlreadyDownloading = true
       }
       return prev
     })

     if (isAlreadyDownloading) {
       Alert.alert('Already Downloading', 'This video is already being downloaded.')
       return
     }

    // Create download item
    const downloadItem: DownloadItem = {
      id,
      videoId: video.id || video.path || '',
      channelKey: video.channelKey,
      title: video.title,
      thumbnail: video.thumbnail,
      status: 'queued',
      progress: 0,
      bytesDownloaded: 0,
      totalBytes: video.size || 0,
      speed: '0 B/s',
      startedAt: Date.now()
    }

    // Add to list (or update existing)
    setDownloads(prev => {
      const filtered = prev.filter(d => d.id !== id)
      return [downloadItem, ...filtered]
    })

    // Create abort controller
    const abortController = new AbortController()
    abortControllers.current.set(id, abortController)

    try {
      console.log('[Downloads] Starting download for:', video.title)
      setDownloads(prev => prev.map(d => d.id === id ? { ...d, status: 'downloading' } : d))

      if (Platform.OS === 'web') {
        // Web/Desktop: Get blob URL and download via browser
        const result = await rpc.downloadVideo({
          channelKey: video.channelKey,
          videoId: video.id || video.path,
          destPath: '',
          publicBeeKey: (video as any).publicBeeKey || undefined
        })

        if (!result?.filePath) {
          throw new Error('Failed to get video URL')
        }

        const blobUrl = result.filePath
         const totalBytes = result.size || video.size || 0
         const ext = getExtension((video as any).mimeType)
         const filename = `${sanitizeFilename(video.title)}_${video.id || 'video'}.${ext}`

        console.log('[Downloads] Got blob URL:', blobUrl)
        setDownloads(prev => prev.map(d => d.id === id ? { ...d, totalBytes } : d))

        await downloadForWeb(id, blobUrl, filename, abortController.signal)
      } else {
        const result = await rpc.downloadVideo({
          channelKey: video.channelKey,
          videoId: video.id || video.path,
          destPath: '', // Backend will choose the path
          publicBeeKey: (video as any).publicBeeKey || undefined
        })

        if (!result?.success) {
          throw new Error(result?.error || 'Download failed')
        }

        console.log('[Downloads] Backend saved to:', result.filePath)

        setDownloads(prev => prev.map(d => d.id === id ? {
          ...d,
          filePath: result.filePath,
          totalBytes: result.size || video.size || 0
        } : d))

        Alert.alert(
          'Download Complete',
          `"${video.title}" saved to Downloads folder.`
        )
      }

      // Mark as complete
      setDownloads(prev => prev.map(d => d.id === id ? {
        ...d,
        status: 'complete',
        progress: 100,
        completedAt: Date.now()
      } : d))

      console.log('[Downloads] Complete:', video.title)

       } catch (err: any) {
         if (err.name === 'AbortError' || abortController.signal.aborted) {
           console.log('[Downloads] Cancelled:', video.title)
           setDownloads(prev => prev.map(d => d.id === id ? { ...d, status: 'cancelled' } : d))
         } else {
           console.error('[Downloads] Error:', err)
           setDownloads(prev => prev.map(d => d.id === id ? {
             ...d,
             status: 'error',
             error: err.message || 'Download failed'
           } : d))
         }
       } finally {
       abortControllers.current.delete(id)
       speedTrackers.current.delete(id)
     }
   }, [downloadForWeb])

  // Cancel a download
  const cancelDownload = useCallback((id: string) => {
    const controller = abortControllers.current.get(id)
    if (controller) {
      controller.abort()
    }
    setDownloads(prev => prev.map(d => d.id === id ? { ...d, status: 'cancelled' } : d))
  }, [])

  // Remove a download from the list
  const removeDownload = useCallback(async (id: string) => {
    // Cancel if still active
    cancelDownload(id)

    // Remove from list (file remains in Downloads folder - user can delete manually)
    setDownloads(prev => prev.filter(d => d.id !== id))
  }, [cancelDownload])

  // Clear completed downloads
  const clearCompleted = useCallback(() => {
    setDownloads(prev => prev.filter(d => d.status !== 'complete' && d.status !== 'cancelled' && d.status !== 'error'))
  }, [])

   // Retry a failed download
   const retryDownload = useCallback(async (id: string, rpc: any) => {
     let download: DownloadItem | undefined
     setDownloads(prev => {
       download = prev.find(d => d.id === id)
       return prev
     })

     if (!download) return

     // Recreate video data
     const video: VideoData = {
       id: download.videoId,
       channelKey: download.channelKey,
       title: download.title,
       thumbnail: download.thumbnail,
       size: download.totalBytes,
       path: download.videoId,
       description: '',
       uploadedAt: 0
     }

     await addDownload(video, rpc)
   }, [addDownload])

  const contextValue = useMemo<DownloadsContextType>(() => ({
    downloads,
    activeCount,
    addDownload,
    cancelDownload,
    removeDownload,
    clearCompleted,
    retryDownload
  }), [downloads, activeCount, addDownload, cancelDownload, removeDownload, clearCompleted, retryDownload])

  return (
    <DownloadsContext.Provider value={contextValue}>
      {children}
    </DownloadsContext.Provider>
  )
}
