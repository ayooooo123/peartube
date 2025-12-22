/**
 * DownloadsContext - Global downloads manager state
 * Provides browser-style downloads queue with progress tracking
 * Works across all platforms (iOS, Android, Desktop, Web)
 */
import { createContext, useContext, useState, useCallback, useEffect, ReactNode, useRef } from 'react'
import { Platform, Alert } from 'react-native'
import * as FileSystem from 'expo-file-system'
import * as MediaLibrary from 'expo-media-library'
import type { VideoData } from '@peartube/core'

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

  // Subscribe to progress events
  useEffect(() => {
    const unsubscribe = downloadProgressEventEmitter.subscribe((id, progress, bytesDownloaded, totalBytes) => {
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
    })
    return () => { unsubscribe() }
  }, [])

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
      // Get blob URL from backend
      console.log('[Downloads] Starting download for:', video.title)
      setDownloads(prev => prev.map(d => d.id === id ? { ...d, status: 'downloading' } : d))

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
      console.log('[Downloads] Total bytes:', totalBytes)

      // Update total bytes
      setDownloads(prev => prev.map(d => d.id === id ? { ...d, totalBytes } : d))

      // Platform-specific download
      if (Platform.OS === 'web') {
        // Web: Use fetch + blob + anchor download
        await downloadForWeb(id, blobUrl, filename, abortController.signal)
      } else {
        // Mobile: Use expo-file-system + expo-media-library
        await downloadForMobile(id, blobUrl, filename, totalBytes, abortController.signal)
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
    console.log('[Downloads] Web download:', filename)

    const response = await fetch(url, { signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)

    const blob = await response.blob()
    const blobUrl = URL.createObjectURL(blob)

    // Create and click download link
    const a = document.createElement('a')
    a.href = blobUrl
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(blobUrl)

    // Update progress to 100%
    downloadProgressEventEmitter.emit(id, 100, blob.size, blob.size)
  }

  // Download for mobile (iOS/Android)
  const downloadForMobile = async (
    id: string,
    url: string,
    filename: string,
    totalBytes: number,
    signal: AbortSignal
  ) => {
    console.log('[Downloads] Mobile download:', filename)

    // Request media library permissions
    const { status } = await MediaLibrary.requestPermissionsAsync()
    if (status !== 'granted') {
      throw new Error('Media library permission denied')
    }

    // Create temp directory
    const tempDir = `${FileSystem.cacheDirectory}downloads/`
    await FileSystem.makeDirectoryAsync(tempDir, { intermediates: true }).catch(() => {})

    const tempPath = `${tempDir}${filename}`

    // Mark as saving
    setDownloads(prev => prev.map(d => d.id === id ? { ...d, status: 'saving' } : d))

    // Download to temp file with progress
    const downloadResumable = FileSystem.createDownloadResumable(
      url,
      tempPath,
      {},
      (downloadProgress) => {
        const progress = downloadProgress.totalBytesExpectedToWrite > 0
          ? Math.round((downloadProgress.totalBytesWritten / downloadProgress.totalBytesExpectedToWrite) * 100)
          : 0
        downloadProgressEventEmitter.emit(
          id,
          progress,
          downloadProgress.totalBytesWritten,
          downloadProgress.totalBytesExpectedToWrite || totalBytes
        )
      }
    )

    // Check for abort
    if (signal.aborted) throw new Error('AbortError')

    const result = await downloadResumable.downloadAsync()
    if (!result?.uri) throw new Error('Download failed - no file created')

    console.log('[Downloads] Downloaded to temp:', result.uri)

    // Save to media library (gallery/photos)
    try {
      const asset = await MediaLibrary.createAssetAsync(result.uri)
      console.log('[Downloads] Saved to gallery:', asset.uri)

      // Update with final path
      setDownloads(prev => prev.map(d => d.id === id ? { ...d, filePath: asset.uri } : d))

      // Clean up temp file
      await FileSystem.deleteAsync(result.uri, { idempotent: true }).catch(() => {})
    } catch (err: any) {
      console.log('[Downloads] Could not save to gallery:', err.message)
      // Fall back to keeping in app documents
      const docsPath = `${FileSystem.documentDirectory}Downloads/${filename}`
      await FileSystem.makeDirectoryAsync(`${FileSystem.documentDirectory}Downloads/`, { intermediates: true }).catch(() => {})
      await FileSystem.moveAsync({ from: result.uri, to: docsPath })
      setDownloads(prev => prev.map(d => d.id === id ? { ...d, filePath: docsPath } : d))
    }
  }

  // Cancel a download
  const cancelDownload = useCallback((id: string) => {
    const controller = abortControllers.current.get(id)
    if (controller) {
      controller.abort()
    }
    setDownloads(prev => prev.map(d => d.id === id ? { ...d, status: 'cancelled' } : d))
  }, [])

  // Remove a download from the list and delete file from storage
  const removeDownload = useCallback(async (id: string) => {
    const download = downloads.find(d => d.id === id)

    // Cancel if still active
    cancelDownload(id)

    // Delete file from storage (mobile only - web downloads go to browser folder)
    if (download?.filePath && Platform.OS !== 'web') {
      try {
        await FileSystem.deleteAsync(download.filePath, { idempotent: true })
        console.log('[Downloads] Deleted file:', download.filePath)
      } catch (err) {
        console.log('[Downloads] Could not delete file:', err)
      }
    }

    // Remove from list
    setDownloads(prev => prev.filter(d => d.id !== id))
  }, [downloads, cancelDownload])

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
