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

export interface P2PVideoService {
  getVideoUrl(driveKey: string, videoPath: string): Promise<{ url: string }>;
  prefetchVideo(driveKey: string, videoPath: string): Promise<{ success: boolean }>;
  getVideoStats(driveKey: string, videoPath: string): Promise<VideoStats>;
}

export interface UseP2PVideoOptions {
  /** Auto-start loading when channelKey/videoPath change (default: true) */
  autoStart?: boolean;
  /** Stats polling interval in ms (default: 500) */
  pollInterval?: number;
  /** Stop polling after this many ms (default: 300000 = 5 min) */
  pollTimeout?: number;
}

const defaultOptions: Required<UseP2PVideoOptions> = {
  autoStart: true,
  pollInterval: 500,
  pollTimeout: 300000,
};

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
  const cancelledRef = useRef(false);
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
    cancelledRef.current = true;
    cleanup();
    setState(prev => ({
      ...prev,
      status: prev.status === 'ready' ? 'ready' : 'idle',
    }));
  }, [cleanup]);

  // Reset to initial state
  const reset = useCallback(() => {
    cancelledRef.current = true;
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

    cancelledRef.current = false;
    startTimeRef.current = Date.now();

    setState({
      url: null,
      status: 'loading',
      stats: null,
      error: null,
    });

    try {
      // Get video URL
      const urlResult = await service.getVideoUrl(channelKey, videoPath);

      if (cancelledRef.current) return;

      setState(prev => ({
        ...prev,
        url: urlResult.url,
        status: 'prefetching',
      }));

      // Start prefetching
      await service.prefetchVideo(channelKey, videoPath);

      if (cancelledRef.current) return;

      // Get initial stats
      const initialStats = await service.getVideoStats(channelKey, videoPath);

      if (cancelledRef.current) return;

      setState(prev => ({
        ...prev,
        stats: initialStats,
        status: initialStats.isComplete ? 'ready' : 'prefetching',
      }));

      // Start polling for stats if not already complete
      if (!initialStats.isComplete) {
        pollIntervalRef.current = setInterval(async () => {
          // Check timeout
          if (Date.now() - startTimeRef.current > opts.pollTimeout) {
            cleanup();
            return;
          }

          if (cancelledRef.current) {
            cleanup();
            return;
          }

          try {
            const stats = await service.getVideoStats(channelKey, videoPath);

            if (cancelledRef.current) return;

            setState(prev => ({
              ...prev,
              stats,
              status: stats.isComplete ? 'ready' : 'prefetching',
            }));

            // Stop polling when complete
            if (stats.isComplete) {
              cleanup();
            }
          } catch (err) {
            console.error('[useP2PVideo] Stats polling error:', err);
            // Continue polling on transient errors
          }
        }, opts.pollInterval);
      }
    } catch (err) {
      if (cancelledRef.current) return;

      setState({
        url: null,
        status: 'error',
        stats: null,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }, [service, channelKey, videoPath, opts.pollInterval, opts.pollTimeout, cleanup]);

  // Auto-start on mount or when video changes
  useEffect(() => {
    if (opts.autoStart && channelKey && videoPath) {
      start();
    }

    return () => {
      cancelledRef.current = true;
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
