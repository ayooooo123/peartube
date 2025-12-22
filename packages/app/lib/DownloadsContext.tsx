/**
 * DownloadsContext - Global downloads manager state
 * Provides browser-style downloads queue with progress tracking
 * Works across all platforms (iOS, Android, Desktop, Web)
 */
import { createContext, useContext, useState, useCallback, useEffect, ReactNode, useRef } from 'react'
import { Platform, Alert } from 'react-native'
import { events } from '@peartube/platform/rpc'
import type { VideoData } from '@peartube/core'

// Conditionally import saveToDownloads for mobile platforms
let saveToDownloads: ((sourcePath: string, filename: string, mimeType: string) => Promise<string>) | null = null
if (Platform.OS !== 'web') {
  try {
    const DownloadsSave = require('expo-downloads-save')
    saveToDownloads = DownloadsSave.saveToDownloads
  } catch (e) {
    console.log('[Downloads] expo-downloads-save not available:', e)
  }
}

// Download item status
export type DownloadStatus = 'queued' | 'downloading' | 'saving' | 'complete' | 'error' | 'cancelled'

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
    progressListeners.forEach(listener => listener(id, progress, bytesDownloaded, totalBytes))
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

  // Calculate active downloads count
  const activeCount = downloads.filter(d => d.status === 'downloading' || d.status === 'queued' || d.status === 'saving').length

  // Handle progress update from any source
  const handleProgressUpdate = useCallback((id: string, progress: number, bytesDownloaded: number, totalBytes: number) => {
    setDownloads(prev => prev.map(d => {
      if (d.id !== id) return d

      // Calculate speed
      const tracker = speedTrackers.current.get(id)
      const now = Date.now()
      let speed = d.speed

      if (tracker) {
        const timeDelta = (now - tracker.lastTime) / 1000 // seconds
        if (timeDelta > 0.5) { // Update speed every 500ms
          const bytesDelta = bytesDownloaded - tracker.lastBytes
          const bytesPerSec = bytesDelta / timeDelta
          speed = formatBytes(bytesPerSec) + '/s'
          speedTrackers.current.set(id, { lastBytes: bytesDownloaded, lastTime: now })
        }
      } else {
        speedTrackers.current.set(id, { lastBytes: bytesDownloaded, lastTime: now })
      }

      return {
        ...d,
        progress,
        bytesDownloaded,
        totalBytes,
        speed,
        status: 'downloading' as DownloadStatus
      }
    }))
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

  // Add a download to the queue and start it
  const addDownload = useCallback(async (video: VideoData, rpc: any) => {
    const id = `${video.channelKey}:${video.id || video.path}`

    // Check if already downloading
    const existing = downloads.find(d => d.id === id)
    if (existing && (existing.status === 'downloading' || existing.status === 'queued')) {
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
        const mimeType = (video as any).mimeType || 'video/mp4'
        const ext = getExtension(mimeType)
        const filename = `${sanitizeFilename(video.title)}_${video.id || 'video'}.${ext}`

        console.log('[Downloads] Got blob URL:', blobUrl)
        setDownloads(prev => prev.map(d => d.id === id ? { ...d, totalBytes } : d))

        await downloadForWeb(id, blobUrl, filename, abortController.signal)
      } else {
        // Mobile: Backend downloads directly to file using bare-fs
        // Progress events are emitted by the backend and captured by our progress listener
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

        // Now copy from app storage to public Downloads folder
        if (saveToDownloads && result.filePath) {
          setDownloads(prev => prev.map(d => d.id === id ? {
            ...d,
            status: 'saving' as DownloadStatus,
            progress: 100
          } : d))

          const mimeType = (video as any).mimeType || 'video/mp4'
          const ext = getExtension(mimeType)
          const filename = `${sanitizeFilename(video.title)}_${video.id || 'video'}.${ext}`

          try {
            const finalPath = await saveToDownloads(result.filePath, filename, mimeType)
            console.log('[Downloads] Saved to Downloads:', finalPath)

            setDownloads(prev => prev.map(d => d.id === id ? {
              ...d,
              filePath: finalPath,
              totalBytes: result.size || video.size || 0
            } : d))

            Alert.alert(
              'Download Complete',
              `"${video.title}" saved to Downloads folder.`
            )
          } catch (saveError: any) {
            console.error('[Downloads] Failed to save to Downloads:', saveError)
            // Fall back to showing app storage path
            setDownloads(prev => prev.map(d => d.id === id ? {
              ...d,
              filePath: result.filePath,
              totalBytes: result.size || video.size || 0
            } : d))

            Alert.alert(
              'Download Complete',
              `"${video.title}" downloaded. Saved to app storage.`
            )
          }
        } else {
          // No saveToDownloads available, just use app storage path
          setDownloads(prev => prev.map(d => d.id === id ? {
            ...d,
            filePath: result.filePath,
            totalBytes: result.size || video.size || 0
          } : d))

          Alert.alert(
            'Download Complete',
            `"${video.title}" downloaded.`
          )
        }
      }

      // Mark as complete
      setDownloads(prev => prev.map(d => d.id === id ? {
        ...d,
        status: 'complete',
        progress: 100,
        completedAt: Date.now()
      } : d))

      console.log('[Downloads] Complete:', video.title)

    } catch (error: any) {
      if (error.name === 'AbortError' || abortController.signal.aborted) {
        console.log('[Downloads] Cancelled:', video.title)
        setDownloads(prev => prev.map(d => d.id === id ? { ...d, status: 'cancelled' } : d))
      } else {
        console.error('[Downloads] Error:', error)
        setDownloads(prev => prev.map(d => d.id === id ? {
          ...d,
          status: 'error',
          error: error.message || 'Download failed'
        } : d))
      }
    } finally {
      abortControllers.current.delete(id)
      speedTrackers.current.delete(id)
    }
  }, [downloads])

  // Download for web platform
  const downloadForWeb = async (id: string, url: string, filename: string, signal: AbortSignal) => {
    console.log('[Downloads] Web download:', filename, 'from:', url)

    const response = await fetch(url, { signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)

    const contentLength = response.headers.get('content-length')
    const totalBytes = contentLength ? parseInt(contentLength, 10) : 0
    console.log('[Downloads] Content-Length:', totalBytes)

    // Stream the response to track progress
    const reader = response.body?.getReader()
    if (!reader) {
      throw new Error('Response body not readable')
    }

    const chunks: Uint8Array[] = []
    let bytesReceived = 0

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      chunks.push(value)
      bytesReceived += value.length

      // Emit progress
      const progress = totalBytes > 0 ? Math.round((bytesReceived / totalBytes) * 100) : 0
      downloadProgressEventEmitter.emit(id, progress, bytesReceived, totalBytes)
    }

    // Combine chunks into blob
    const blob = new Blob(chunks)
    const blobUrl = URL.createObjectURL(blob)
    console.log('[Downloads] Download complete, size:', blob.size)

    // Create and click download link
    const a = document.createElement('a')
    a.href = blobUrl
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(blobUrl)

    // Final progress update
    downloadProgressEventEmitter.emit(id, 100, blob.size, blob.size)
  }

  // Download for mobile (iOS/Android) - handled by backend using bare-fs
  // The backend streams the file to disk with progress events
  // This function is not used on mobile - download happens in addDownload via RPC
  const downloadForMobile = async (
    id: string,
    url: string,
    filename: string,
    totalBytes: number,
    signal: AbortSignal
  ) => {
    // On mobile, the backend handles the download using bare-fs
    // Progress is emitted via RPC events which we listen to in the progress subscriber
    // This function should not be called on mobile - see addDownload
    console.log('[Downloads] Mobile download handled by backend:', filename)
  }

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
    const download = downloads.find(d => d.id === id)
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
  }, [downloads, addDownload])

  const contextValue: DownloadsContextType = {
    downloads,
    activeCount,
    addDownload,
    cancelDownload,
    removeDownload,
    clearCompleted,
    retryDownload
  }

  return (
    <DownloadsContext.Provider value={contextValue}>
      {children}
    </DownloadsContext.Provider>
  )
}
