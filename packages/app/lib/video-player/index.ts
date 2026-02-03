/**
 * Video Player Context - Split Architecture
 *
 * The video player context has been split into 3 separate contexts to reduce re-renders:
 *
 * 1. VideoProgressContext - High frequency (~4Hz): currentTime, duration, progress
 * 2. VideoControlContext - Medium frequency: isPlaying, isLoading, playerMode, playbackRate
 * 3. VideoMetaContext - Low frequency: currentVideo, videoUrl, videoStats
 *
 * Components should import the specific context they need:
 * - SeekBar: useVideoProgressContext()
 * - PlayPauseButton: useVideoControlContext()
 * - VideoInfo: useVideoMetaContext()
 *
 * For backward compatibility, useVideoPlayerContext() is still available and
 * combines all three contexts into one object (but with performance cost).
 */

export { VideoProgressProvider, useVideoProgressContext, useVideoProgressContextOptional } from './VideoProgressContext'
export { VideoControlProvider, useVideoControlContext, useVideoControlContextOptional, playbackActiveEmitter } from './VideoControlContext'
export { VideoMetaProvider, useVideoMetaContext, useVideoMetaContextOptional, videoStatsEventEmitter, videoLoadEventEmitter } from './VideoMetaContext'
export type { PlayerMode } from './types'
export type { VideoData, VideoStats } from './VideoMetaContext'
