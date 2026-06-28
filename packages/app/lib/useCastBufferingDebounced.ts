import { useEffect, useRef, useState } from 'react'

/**
 * Debounce cast BUFFERING — a brief BUFFERING state from HLS segment transitions
 * shouldn't flash the loading overlay. Returns true only after ~2s of continuous
 * buffering, and clears immediately once buffering ends.
 * Extracted verbatim from VideoPlayerOverlayImpl.
 */
export function useCastBufferingDebounced(castState: string | undefined): boolean {
  const [castBufferingDebounced, setCastBufferingDebounced] = useState(false)
  const castBufferingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const isBuffering = castState === 'buffering'
    if (isBuffering) {
      if (!castBufferingTimerRef.current) {
        castBufferingTimerRef.current = setTimeout(() => {
          setCastBufferingDebounced(true)
        }, 2000)
      }
    } else {
      if (castBufferingTimerRef.current) {
        clearTimeout(castBufferingTimerRef.current)
        castBufferingTimerRef.current = null
      }
      setCastBufferingDebounced(false)
    }
    return () => {
      if (castBufferingTimerRef.current) {
        clearTimeout(castBufferingTimerRef.current)
        castBufferingTimerRef.current = null
      }
    }
  }, [castState])

  return castBufferingDebounced
}
