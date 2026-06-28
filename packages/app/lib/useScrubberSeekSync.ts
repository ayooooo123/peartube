import { useCallback, useEffect, useRef, useState } from 'react'

interface UseScrubberSeekSyncProps {
  effectiveCurrentTime: number
  effectiveDuration: number
  isCasting: boolean
  cast: { seek: (timeSeconds: number) => unknown }
  seekTo: (timeSeconds: number) => unknown
  controlsTimeoutRef: React.MutableRefObject<NodeJS.Timeout | null>
  setShowControls: (showControls: boolean) => void
  showControlsTemporarily: () => void
}

export function useScrubberSeekSync({
  effectiveCurrentTime,
  effectiveDuration,
  isCasting,
  cast,
  seekTo,
  controlsTimeoutRef,
  setShowControls,
  showControlsTemporarily,
}: UseScrubberSeekSyncProps) {
  const [isSeeking, setIsSeeking] = useState(false)
  const [seekPosition, setSeekPosition] = useState(0)
  const [scrubPendingTime, setScrubPendingTime] = useState<number | null>(null)
  const scrubPendingSinceRef = useRef(0)

  // Sync seek position with current time when not seeking
  useEffect(() => {
    if (!isSeeking) {
      setSeekPosition(effectiveCurrentTime)
    }
  }, [effectiveCurrentTime, isSeeking])

  // Clear scrub pending lock once playback catches up (or after a timeout).
  // This prevents the scrubber UI from snapping back to stale progress right after commit.
  useEffect(() => {
    if (scrubPendingTime === null) return
    if (effectiveDuration <= 0) {
      setScrubPendingTime(null)
      return
    }

    const ageMs = Date.now() - scrubPendingSinceRef.current
    const closeEnough = Math.abs(effectiveCurrentTime - scrubPendingTime) < 0.75
    if (closeEnough || ageMs > 1500) {
      setScrubPendingTime(null)
    }
  }, [scrubPendingTime, effectiveCurrentTime, effectiveDuration])

  const handleDesktopSeekStart = useCallback(() => {
    if (effectiveDuration > 0) {
      setIsSeeking(true)
    }
  }, [effectiveDuration])

  const handleDesktopSeekChange = useCallback((event: any) => {
    const value = Number(event?.target?.value)
    if (!Number.isFinite(value)) return
    setSeekPosition(value)
  }, [])

  const handleDesktopSeekEnd = useCallback(() => {
    if (effectiveDuration <= 0) return
    if (isSeeking) {
      if (isCasting) {
        cast.seek(seekPosition)
      } else {
        seekTo(seekPosition)
      }
      setIsSeeking(false)
    }
  }, [effectiveDuration, isSeeking, seekPosition, isCasting, cast, seekTo])

  const handleScrubStart = useCallback(() => {
    // Pause the auto-hide timer while scrubbing
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current)
      controlsTimeoutRef.current = null
    }
    setShowControls(true)
  }, [])

  const handleScrubCommit = useCallback((timeSeconds: number) => {
    if (effectiveDuration <= 0) return
    const clamped = Math.max(0, Math.min(timeSeconds, effectiveDuration))
    setScrubPendingTime(clamped)
    scrubPendingSinceRef.current = Date.now()
    if (isCasting) {
      cast.seek(clamped)
    } else {
      seekTo(clamped)
    }
    // Restart auto-hide timer after scrub ends
    showControlsTemporarily()
  }, [effectiveDuration, isCasting, cast, seekTo, showControlsTemporarily])

  return {
    isSeeking,
    seekPosition,
    scrubPendingTime,
    handleDesktopSeekStart,
    handleDesktopSeekChange,
    handleDesktopSeekEnd,
    handleScrubStart,
    handleScrubCommit,
  }
}
