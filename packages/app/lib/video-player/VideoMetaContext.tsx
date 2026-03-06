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
const lastStatsByKey = new Map<string, { driveKey: string; videoPath: string; stats: VideoStats; at: number }>()

function makeStatsKey(driveKey: string, videoPath: string) {
  return `${driveKey}:${videoPath}`
}

export const videoStatsEventEmitter = {
  emit: (driveKey: string, videoPath: string, stats: VideoStats) => {
    lastStatsByKey.set(makeStatsKey(driveKey, videoPath), {
      driveKey,
      videoPath,
      stats,
      at: Date.now(),
    })
    statsListeners.forEach((listener) => {
      listener(driveKey, videoPath, stats)
    })
  },
  subscribe: (listener: VideoStatsListener) => {
    statsListeners.add(listener)
    return () => { statsListeners.delete(listener) }
  },
  getLatest: (driveKey?: string | null, videoPath?: string | null) => {
    if (driveKey && videoPath) {
      return lastStatsByKey.get(makeStatsKey(driveKey, videoPath))?.stats ?? null
    }
    if (videoPath) {
      for (const entry of lastStatsByKey.values()) {
        if (entry.videoPath === videoPath) return entry.stats
      }
    }
    return null
  },
}

type VideoLoadListener = (video: VideoData) => void
const loadListeners = new Set<VideoLoadListener>()
let lastLoadedVideo: VideoData | null = null

export const videoLoadEventEmitter = {
  emit: (video: VideoData) => {
    lastLoadedVideo = video
    loadListeners.forEach((listener) => {
      listener(video)
    })
  },
  subscribe: (listener: VideoLoadListener) => {
    loadListeners.add(listener)
    if (lastLoadedVideo) {
      try {
        listener(lastLoadedVideo)
      } catch {
      }
    }
    return () => { loadListeners.delete(listener) }
  },
  getLast: () => lastLoadedVideo,
}

export function useVideoMetaContext() {
  throw new Error('useVideoMetaContext is deprecated and no longer available')
}

export function useVideoMetaContextOptional() {
  return null
}
