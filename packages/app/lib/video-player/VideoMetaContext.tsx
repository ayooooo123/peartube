/**
 * VideoMetaContext - DEPRECATED
 *
 * This file is kept only for the event emitter exports.
 * The Provider and hooks have been removed as they were never mounted.
 */

import type { VideoData, VideoStats } from '@peartube/core'

export type { VideoData, VideoStats } from '@peartube/core'

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

export function useVideoMetaContext() {
  throw new Error('useVideoMetaContext is deprecated and no longer available')
}

export function useVideoMetaContextOptional() {
  return null
}
