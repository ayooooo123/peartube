/**
 * VideoPlayerContext - Global video player state management
 * Enables mini player functionality across the app
 * Uses VLC player for broad codec support
 */
import { createContext, useContext, useState, useCallback, useRef, useEffect, ReactNode } from 'react'
import type { VideoData, VideoStats } from '@peartube/core'

// Re-export types for backwards compatibility
export type { VideoData, VideoStats } from '@peartube/core'

// Simple event emitter for video stats (allows RPC handler to push stats to context)
type VideoStatsListener = (driveKey: string, videoPath: string, stats: VideoStats) => void
const statsListeners = new Set<VideoStatsListener>()

export const videoStatsEventEmitter = {
  emit: (driveKey: string, videoPath: string, stats: VideoStats) => {
    console.log('[VideoStatsEmitter] Emitting stats for', videoPath?.slice(0, 30))
    statsListeners.forEach(listener => listener(driveKey, videoPath, stats))
  },
  subscribe: (listener: VideoStatsListener) => {
    statsListeners.add(listener)
    return () => statsListeners.delete(listener)
  }
}

// Event emitter for video load events (triggers prefetch in _layout.tsx)
type VideoLoadListener = (video: VideoData) => void
const loadListeners = new Set<VideoLoadListener>()

export const videoLoadEventEmitter = {
  emit: (video: VideoData) => {
    console.log('[VideoLoadEmitter] Video loaded:', video.title)
    loadListeners.forEach(listener => listener(video))
  },
  subscribe: (listener: VideoLoadListener) => {
    loadListeners.add(listener)
    return () => loadListeners.delete(listener)
  }
}

// Player mode
export type PlayerMode = 'hidden' | 'mini' | 'fullscreen'

interface VideoPlayerContextType {
  // Current video
  currentVideo: VideoData | null
  videoUrl: string | null

  // Player state
  isPlaying: boolean
  isLoading: boolean
  playerMode: PlayerMode
  videoStats: VideoStats | null

  // Playback position
  currentTime: number
  duration: number
  progress: number // 0-1 percentage

  // Playback speed
  playbackRate: number

  // VLC seek position (0-1) - passed as prop to VLCPlayer
  vlcSeekPosition: number | undefined

  // VLC player ref - set by VideoPlayerOverlay
  playerRef: React.MutableRefObject<any>

  // Actions
  loadAndPlayVideo: (video: VideoData, url: string) => void
  pauseVideo: () => void
  resumeVideo: () => void
  closeVideo: () => void
  minimizePlayer: () => void
  maximizePlayer: () => void
  seekTo: (time: number) => void
  seekBy: (delta: number) => void
  setPlaybackRate: (rate: number) => void
  setVideoStats: (stats: VideoStats | null) => void
  setIsLoading: (loading: boolean) => void

  // Called by VLCPlayer callbacks
  onProgress: (data: { currentTime: number; duration: number }) => void
  onPlaying: () => void
  onPaused: () => void
  onBuffering: (data: { isBuffering: boolean }) => void
  onEnded: () => void
  onError: (error: any) => void
}

const VideoPlayerContext = createContext<VideoPlayerContextType | null>(null)

export function useVideoPlayerContext() {
  const ctx = useContext(VideoPlayerContext)
  if (!ctx) throw new Error('useVideoPlayerContext must be used within VideoPlayerProvider')
  return ctx
}

interface VideoPlayerProviderProps {
  children: ReactNode
}

export function VideoPlayerProvider({ children }: VideoPlayerProviderProps) {
  // Video state
  const [currentVideo, setCurrentVideo] = useState<VideoData | null>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [playerMode, setPlayerMode] = useState<PlayerMode>('hidden')
  const [videoStats, setVideoStats] = useState<VideoStats | null>(null)

  // Playback position state
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)

  // Playback speed state
  const [playbackRate, setPlaybackRateState] = useState(1)

  // VLC seek position (0-1) - used as a prop, not a ref method
  // Use undefined when not seeking so the prop isn't passed to VLC
  const [seekPosition, setSeekPosition] = useState<number | undefined>(undefined)

  // VLC player ref - will be set by VideoPlayerOverlay
  const playerRef = useRef<any>(null)

  // Ref for current video - updated synchronously to avoid race conditions with stats events
  const currentVideoRef = useRef<VideoData | null>(null)

  // Subscribe to video stats events from backend
  useEffect(() => {
    const unsubscribe = videoStatsEventEmitter.subscribe((driveKey, videoPath, stats) => {
      // Use ref for synchronous access (state may not be updated yet)
      const video = currentVideoRef.current
      console.log('[VideoPlayerContext] Stats event received, checking match:', {
        videoPath,
        driveKey,
        currentPath: video?.path,
        currentKey: video?.channelKey
      })
      // Only update if this is for the current video
      if (video && video.path === videoPath && video.channelKey === driveKey) {
        console.log('[VideoPlayerContext] Received stats event:', stats.progress + '%')
        setVideoStats(stats)
      }
    })
    return unsubscribe
  }, []) // No dependencies - ref is used for synchronous access

  // Load and play a new video
  const loadAndPlayVideo = useCallback((video: VideoData, url: string) => {
    console.log('[VideoPlayerContext] Loading video:', video.title, 'URL:', url)
    // Update ref synchronously FIRST (before emitting event)
    currentVideoRef.current = video
    setCurrentVideo(video)
    setVideoUrl(url)
    setIsPlaying(true)
    setPlayerMode('fullscreen')
    setVideoStats(null)
    setIsLoading(true)
    setCurrentTime(0)
    setDuration(0)
    // Emit load event so _layout.tsx can trigger prefetch
    videoLoadEventEmitter.emit(video)
  }, [])

  // Pause video
  const pauseVideo = useCallback(() => {
    console.log('[VideoPlayerContext] Pausing video')
    setIsPlaying(false)
  }, [])

  // Resume video
  const resumeVideo = useCallback(() => {
    console.log('[VideoPlayerContext] Resuming video')
    setIsPlaying(true)
  }, [])

  // Close video completely
  const closeVideo = useCallback(() => {
    console.log('[VideoPlayerContext] Closing video')
    currentVideoRef.current = null
    setCurrentVideo(null)
    setVideoUrl(null)
    setIsPlaying(false)
    setPlayerMode('hidden')
    setVideoStats(null)
    setCurrentTime(0)
    setDuration(0)
  }, [])

  // Minimize to mini player - video keeps playing, just changes UI mode
  const minimizePlayer = useCallback(() => {
    console.log('[VideoPlayerContext] Minimizing to mini player')
    setPlayerMode('mini')
  }, [])

  // Maximize from mini player
  const maximizePlayer = useCallback(() => {
    console.log('[VideoPlayerContext] Maximizing player')
    setPlayerMode('fullscreen')
  }, [])

  // Seek to specific time (in seconds)
  const seekTo = useCallback((time: number) => {
    if (duration <= 0) return
    const clampedTime = Math.max(0, Math.min(time, duration))
    const seekValue = clampedTime / duration // VLC seek uses 0-1 range
    console.log('[VideoPlayerContext] Seeking to:', clampedTime, 'seconds, seek prop:', seekValue)
    // Set the seek position - VLC will see this as the seek prop
    setSeekPosition(seekValue)
    setCurrentTime(clampedTime)
    // Clear after VLC processes the seek (so we can seek to same position again later)
    setTimeout(() => setSeekPosition(undefined), 100)
  }, [duration])

  // Seek by relative amount (positive = forward, negative = backward)
  const seekBy = useCallback((delta: number) => {
    if (duration <= 0) return
    const newTime = Math.max(0, Math.min(currentTime + delta, duration))
    const seekValue = newTime / duration // VLC seek uses 0-1 range
    console.log('[VideoPlayerContext] Seeking by:', delta, 'to:', newTime, 'seek prop:', seekValue)
    // Set the seek position - VLC will see this as the seek prop
    setSeekPosition(seekValue)
    setCurrentTime(newTime)
    // Clear after VLC processes the seek (so we can seek to same position again later)
    setTimeout(() => setSeekPosition(undefined), 100)
  }, [currentTime, duration])

  // Set playback speed
  const setPlaybackRate = useCallback((rate: number) => {
    console.log('[VideoPlayerContext] Setting playback rate:', rate)
    setPlaybackRateState(rate)
    // VLC handles this via the rate prop
  }, [])

  // VLC callbacks
  const onProgress = useCallback((data: { currentTime: number; duration: number }) => {
    // VLC reports time in milliseconds
    setCurrentTime(data.currentTime / 1000)
    if (data.duration > 0) {
      setDuration(data.duration / 1000)
    }
  }, [])

  const onPlaying = useCallback(() => {
    console.log('[VideoPlayerContext] VLC playing')
    setIsLoading(false)
    setIsPlaying(true)
  }, [])

  const onPaused = useCallback(() => {
    console.log('[VideoPlayerContext] VLC paused')
    setIsPlaying(false)
  }, [])

  const onBuffering = useCallback((data: { isBuffering: boolean }) => {
    console.log('[VideoPlayerContext] VLC buffering:', data?.isBuffering)
    // Only show loading when actually buffering, hide when buffering stops
    if (data?.isBuffering !== undefined) {
      setIsLoading(data.isBuffering)
    }
  }, [])

  const onEnded = useCallback(() => {
    console.log('[VideoPlayerContext] VLC ended')
    setIsPlaying(false)
  }, [])

  const onError = useCallback((error: any) => {
    console.error('[VideoPlayerContext] VLC error:', error)
    setIsLoading(false)
  }, [])

  // Calculate progress percentage
  const progress = duration > 0 ? currentTime / duration : 0

  const contextValue: VideoPlayerContextType = {
    currentVideo,
    videoUrl,
    isPlaying,
    isLoading,
    playerMode,
    videoStats,
    currentTime,
    duration,
    progress,
    playbackRate,
    vlcSeekPosition: seekPosition,
    playerRef,
    loadAndPlayVideo,
    pauseVideo,
    resumeVideo,
    closeVideo,
    minimizePlayer,
    maximizePlayer,
    seekTo,
    seekBy,
    setPlaybackRate,
    setVideoStats,
    setIsLoading,
    onProgress,
    onPlaying,
    onPaused,
    onBuffering,
    onEnded,
    onError,
  }

  return (
    <VideoPlayerContext.Provider value={contextValue}>
      {children}
    </VideoPlayerContext.Provider>
  )
}
