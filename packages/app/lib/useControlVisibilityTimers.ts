import { useCallback, useEffect, useRef, useState } from 'react'

export function useControlVisibilityTimers(isInPipMode: boolean) {
  // Simplified PiP state tracking - trust the native event, don't over-engineer
  const wasInPipRef = useRef(false)
  const [showControls, setShowControls] = useState(false)
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  const showControlsTemporarily = useCallback(() => {
    setShowControls(true)
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current)
    }
    controlsTimeoutRef.current = setTimeout(() => {
      setShowControls(false)
    }, 3000)
  }, [])

  useEffect(() => {
    if (isInPipMode) {
      wasInPipRef.current = true
      // PiP has system-level controls; keep fullscreen overlay hidden.
      setShowControls(false)
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current)
        controlsTimeoutRef.current = null
      }
    } else if (wasInPipRef.current) {
      wasInPipRef.current = false
      showControlsTemporarily()
      // PiP re-arm is handled by the main auto-PiP effect using a ref flag.
    }
  }, [isInPipMode, showControlsTemporarily])

  // Always register cleanup hooks (even when no video) to avoid changing hook order
  useEffect(() => {
    return () => {
      if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current)
    }
  }, [])

  return {
    wasInPipRef,
    showControls,
    setShowControls,
    controlsTimeoutRef,
    showControlsTemporarily,
  }
}
