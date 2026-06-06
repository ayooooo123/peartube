/**
 * useP2PVideo - Shared hook for P2P video loading and stats polling
 *
 * Encapsulates the P2P video loading pattern:
 * 1. Get video URL from backend
 * 2. Start prefetching video blocks
 * 3. Poll for download stats until complete
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { VideoStats } from '../types';

export interface P2PVideoState {
  url: string | null;
  status: 'idle' | 'loading' | 'prefetching' | 'ready' | 'error';
  stats: VideoStats | null;
  error: Error | null;
}

export interface PlaybackRequest {
  channelKey: string;
  videoId: string;
  publicBeeKey?: string;
  blobId?: string;
  blobsCoreKey?: string;
  mimeType?: string;
}

export interface P2PVideoService {
  getVideoUrl(request: PlaybackRequest): Promise<{ url: string }>;
  getVideoUrl(driveKey: string, videoPath: string): Promise<{ url: string }>;
  prefetchVideo(request: PlaybackRequest): Promise<{ success: boolean }>;
  prefetchVideo(driveKey: string, videoPath: string): Promise<{ success: boolean }>;
  preparePlayback?: {
    (request: PlaybackRequest): Promise<{ url: string; stats?: VideoStats | null }>;
    (driveKey: string, videoPath: string): Promise<{ url: string; stats?: VideoStats | null }>;
  };
  getVideoStats(request: PlaybackRequest): Promise<VideoStats>;
  getVideoStats(driveKey: string, videoPath: string): Promise<VideoStats>;
}

export interface UseP2PVideoOptions {
  /** Public bee key for canonical remote playback requests. */
  publicBeeKey?: string;
  /** Direct blob id for canonical instant playback requests. */
  blobId?: string;
  /** Direct blobs core key for canonical instant playback requests. */
  blobsCoreKey?: string;
  /** MIME type for canonical instant playback requests. */
  mimeType?: string;
  /** Auto-start loading when channelKey/videoPath change (default: true) */
  autoStart?: boolean;
  /** Stats polling interval in ms (default: 500) */
  pollInterval?: number;
  /** Stop polling after this many ms (default: 300000 = 5 min) */
  pollTimeout?: number;
}

const defaultOptions: Required<Pick<UseP2PVideoOptions, 'autoStart' | 'pollInterval' | 'pollTimeout'>> = {
  autoStart: true,
  pollInterval: 500,
  pollTimeout: 300000,
};


function callPlaybackService<T>(fn: any, request: PlaybackRequest): Promise<T> {
  if (typeof fn !== 'function') return Promise.reject(new Error('Missing playback service method'));
  const hasCanonicalPlaybackFields = Boolean(
    request.publicBeeKey || request.blobId || request.blobsCoreKey || request.mimeType
  );
  if (!hasCanonicalPlaybackFields && fn.length >= 2) return fn(request.channelKey, request.videoId);
  return fn(request);
}

/**
 * Hook for managing P2P video loading state
 *
 * @param service - Platform-specific video service implementation
 * @param channelKey - The channel/drive key
 * @param videoPath - The video path within the drive
 * @param options - Configuration options
 */
export function useP2PVideo(
  service: P2PVideoService,
  channelKey: string | null,
  videoPath: string | null,
  options: UseP2PVideoOptions = {}
): P2PVideoState & {
  start: () => void;
  cancel: () => void;
  reset: () => void;
} {
  const opts = { ...defaultOptions, ...options };

  const [state, setState] = useState<P2PVideoState>({
    url: null,
    status: 'idle',
    stats: null,
    error: null,
  });

  // Refs for cleanup
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const requestGenerationRef = useRef(0);
  const startTimeRef = useRef<number>(0);

  // Cleanup function
  const cleanup = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  // Cancel current loading
  const cancel = useCallback(() => {
    requestGenerationRef.current += 1;
    cleanup();
    setState(prev => ({
      ...prev,
      status: prev.status === 'ready' ? 'ready' : 'idle',
    }));
  }, [cleanup]);

  // Reset to initial state
  const reset = useCallback(() => {
    requestGenerationRef.current += 1;
    cleanup();
    setState({
      url: null,
      status: 'idle',
      stats: null,
      error: null,
    });
  }, [cleanup]);

  // Start loading video
  const start = useCallback(async () => {
    if (!channelKey || !videoPath) {
      setState(prev => ({
        ...prev,
        status: 'error',
        error: new Error('Missing channelKey or videoPath'),
      }));
      return;
    }

    cleanup();
    const requestId = requestGenerationRef.current + 1;
    requestGenerationRef.current = requestId;
    const isCurrentRequest = () => requestGenerationRef.current === requestId;
    startTimeRef.current = Date.now();

    setState({
      url: null,
      status: 'loading',
      stats: null,
      error: null,
    });

    const playbackRequest: PlaybackRequest = {
      channelKey,
      videoId: videoPath,
      publicBeeKey: options.publicBeeKey || undefined,
      blobId: options.blobId || undefined,
      blobsCoreKey: options.blobsCoreKey || undefined,
      mimeType: options.mimeType || undefined,
    };

    try {
      if (typeof service.preparePlayback === 'function') {
        const playback = await callPlaybackService<{ url: string; stats?: VideoStats | null }>(service.preparePlayback, playbackRequest);

        if (!isCurrentRequest()) return;

        setState(prev => ({
          ...prev,
          url: playback.url,
          stats: playback.stats || null,
          status: playback.stats?.isComplete ? 'ready' : 'prefetching',
        }));

        if (playback.stats?.isComplete) {
          return;
        }
      } else {
        const urlResult = await callPlaybackService<{ url: string }>(service.getVideoUrl, playbackRequest);

        if (!isCurrentRequest()) return;

        setState(prev => ({
          ...prev,
          url: urlResult.url,
          status: 'prefetching',
        }));

        await callPlaybackService<{ success: boolean }>(service.prefetchVideo, playbackRequest);

        if (!isCurrentRequest()) return;
      }

      const initialStats = await callPlaybackService<VideoStats>(service.getVideoStats, playbackRequest);

      if (!isCurrentRequest()) return;

      setState(prev => ({
        ...prev,
        stats: initialStats,
        status: initialStats.isComplete ? 'ready' : 'prefetching',
      }));

      // Start polling for stats if not already complete
      if (!initialStats.isComplete) {
        const interval = setInterval(async () => {
          const stopThisInterval = () => {
            clearInterval(interval);
            if (pollIntervalRef.current === interval) {
              pollIntervalRef.current = null;
            }
          };

          // Check timeout
          if (requestGenerationRef.current !== requestId || Date.now() - startTimeRef.current > opts.pollTimeout) {
            stopThisInterval();
            return;
          }

          try {
            const stats = await callPlaybackService<VideoStats>(service.getVideoStats, playbackRequest);

            if (requestGenerationRef.current !== requestId) {
              stopThisInterval();
              return;
            }

            setState(prev => ({
              ...prev,
              stats,
              status: stats.isComplete ? 'ready' : 'prefetching',
            }));

            // Stop polling when complete
            if (stats.isComplete) {
              stopThisInterval();
            }
          } catch (err) {
            console.error('[useP2PVideo] Stats polling error:', err);
            // Continue polling on transient errors
          }
        }, opts.pollInterval);
        pollIntervalRef.current = interval;
      }
    } catch (err) {
      if (!isCurrentRequest()) return;

      setState({
        url: null,
        status: 'error',
        stats: null,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }, [service, channelKey, videoPath, options.publicBeeKey, options.blobId, options.blobsCoreKey, options.mimeType, opts.pollInterval, opts.pollTimeout, cleanup]);

  // Auto-start on mount or when video changes
  useEffect(() => {
    if (opts.autoStart && channelKey && videoPath) {
      start();
    }

    return () => {
      requestGenerationRef.current += 1;
      cleanup();
    };
  }, [channelKey, videoPath, opts.autoStart]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    ...state,
    start,
    cancel,
    reset,
  };
}

export default useP2PVideo;
