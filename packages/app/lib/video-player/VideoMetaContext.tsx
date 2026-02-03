/**
 * VideoMetaContext - Low-frequency video metadata state
 *
 * Contains current video data, URL, and P2P stats.
 * These values only change when a new video is loaded.
 */

import { createContext, useContext, useState, useCallback, useRef, useEffect, ReactNode, useMemo } from 'react'
import { Platform } from 'react-native'
import type { VideoData, VideoStats } from '@peartube/core'
import * as MediaSession from '../../modules/expo-media-session/src'

// Re-export types for convenience
export type { VideoData, VideoStats } from '@peartube/core'

// Simple event emitter for video stats (allows RPC handler to push stats to context)
type VideoStatsListener = (driveKey: string, videoPath: string, stats: VideoStats) => void
const statsListeners = new Set<VideoStatsListener>()

export const videoStatsEventEmitter = {
  emit: (driveKey: string, videoPath: string, stats: VideoStats) => {
    statsListeners.forEach(listener => listener(driveKey, videoPath, stats))
  },
  subscribe: (listener: VideoStatsListener) => {
    statsListeners.add(listener)
    return () => statsListeners.delete(listener)
  }
}

// Event emitter for video load events (triggers prefetch)
type VideoLoadListener = (video: VideoData) => void
const loadListeners = new Set<VideoLoadListener>()

export const videoLoadEventEmitter = {
  emit: (video: VideoData) => {
    loadListeners.forEach(listener => listener(video))
  },
  subscribe: (listener: VideoLoadListener) => {
    loadListeners.add(listener)
    return () => loadListeners.delete(listener)
  }
}

interface VideoMetaContextType {
  // Current video metadata
  currentVideo: VideoData | null
  videoUrl: string | null
  videoStats: VideoStats | null

  // Refs for synchronous access
  currentVideoRef: React.MutableRefObject<VideoData | null>
  videoUrlRef: React.MutableRefObject<string | null>

  // Actions
  setCurrentVideo: (video: VideoData | null) => void
  setVideoUrl: (url: string | null) => void
  setVideoStats: (stats: VideoStats | null) => void
}

const VideoMetaContext = createContext<VideoMetaContextType | null>(null)

export function useVideoMetaContext() {
  const ctx = useContext(VideoMetaContext)
  if (!ctx) throw new Error('useVideoMetaContext must be used within VideoMetaProvider')
  return ctx
}

// Optional hook for conditional usage
export function useVideoMetaContextOptional() {
  return useContext(VideoMetaContext)
}

interface VideoMetaProviderProps {
  children: ReactNode
  // For coordinating with control context
  setIsLoading: (loading: boolean) => void
  durationRef: React.MutableRefObject<number>
}

export function VideoMetaProvider({
  children,
  setIsLoading,
  durationRef,
}: VideoMetaProviderProps) {
  const [currentVideo, setCurrentVideoState] = useState<VideoData | null>(null)
  const [videoUrl, setVideoUrlState] = useState<string | null>(null)
  const [videoStats, setVideoStatsState] = useState<VideoStats | null>(null)

  // Refs for synchronous access
  const currentVideoRef = useRef<VideoData | null>(null)
  const videoUrlRef = useRef<string | null>(null)

  const setCurrentVideo = useCallback((video: VideoData | null) => {
    currentVideoRef.current = video
    setCurrentVideoState(video)
  }, [])

  const setVideoUrl = useCallback((url: string | null) => {
    videoUrlRef.current = url
    setVideoUrlState(url)
  }, [])

  const setVideoStats = useCallback((stats: VideoStats | null) => {
    setVideoStatsState(stats)
  }, [])

  // Keep Now Playing metadata up to date
  useEffect(() => {
    if (Platform.OS === 'web') return
    if (!currentVideo) return
    MediaSession.setNowPlaying({
      title: currentVideo.title || 'Video',
      artist: currentVideo.channel?.name || 'PearTube',
      duration: durationRef.current,
      artworkUrl: currentVideo.thumbnailUrl ?? undefined,
    }).catch(() => {})
  }, [currentVideo?.id, currentVideo?.title, currentVideo?.thumbnailUrl, currentVideo?.channel?.name, durationRef])

  // Subscribe to video stats events from backend
  useEffect(() => {
    const unsubscribe = videoStatsEventEmitter.subscribe((driveKey, videoPath, stats) => {
      const video = currentVideoRef.current

      // Normalize IDs for comparison
      const extractVideoId = (idOrPath?: string | null) => {
        if (!idOrPath) return null
        const cleaned = idOrPath.split('?')[0]?.split('#')[0] || idOrPath
        const m = cleaned.match(/(?:^|\/)videos\/([^.\/]+)(?:\.[^\/]+)?$/)
        if (m?.[1]) return m[1]
        const base = cleaned.split('/').pop() || cleaned
        return base.replace(/\.[^./]+$/, '')
      }

      const currentKey = (video as any)?.channelKey || (video as any)?.driveKey || null
      const currentId = extractVideoId((video as any)?.id) ?? extractVideoId(video?.path)
      const incomingId = extractVideoId(videoPath)

      const sameVideo =
        Boolean(video) &&
        (currentKey ? currentKey === driveKey : true) &&
        (video?.path === videoPath || (currentId && incomingId && currentId === incomingId))

      if (sameVideo) {
        setVideoStatsState(stats)
        // Drop loading overlay once stats show real activity
        if (stats) {
          if (stats.isComplete ||
              (typeof stats.progress === 'number' && stats.progress > 0) ||
              (stats.status && stats.status !== 'connecting' && stats.status !== 'resolving')) {
            setIsLoading(false)
          }
        }
      }
    })
    return () => { unsubscribe() }
  }, [setIsLoading])

  const contextValue = useMemo<VideoMetaContextType>(() => ({
    currentVideo,
    videoUrl,
    videoStats,
    currentVideoRef,
    videoUrlRef,
    setCurrentVideo,
    setVideoUrl,
    setVideoStats,
  }), [currentVideo, videoUrl, videoStats, setCurrentVideo, setVideoUrl, setVideoStats])

  return (
    <VideoMetaContext.Provider value={contextValue}>
      {children}
    </VideoMetaContext.Provider>
  )
}
