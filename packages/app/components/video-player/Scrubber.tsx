import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { type LayoutChangeEvent, Platform, Text, View } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, {
  clamp,
  Easing,
  interpolate,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  withRepeat,
} from 'react-native-reanimated'
let Haptics: any = null
try { Haptics = require('expo-haptics') } catch {}
import { styles } from './styles'
import { formatDuration } from './formatters'

// ── Dimensions (spec §1, §3) ────────────────────────────────────────────
const TRACK_PADDING = 16
const TRACK_HEIGHT_REST = 4
const TRACK_HEIGHT_TOUCH = 6
const TRACK_HEIGHT_SCRUB = 8
const HANDLE_SIZE_REST = 14
const HANDLE_SIZE_ACTIVE = 18
const TRACK_WRAPPER_HEIGHT = TRACK_HEIGHT_SCRUB
const TOUCH_TARGET_HEIGHT = 48

// ── Animation configs (spec §8) ─────────────────────────────────────────
const TRACK_SPRING = { damping: 15, stiffness: 350, mass: 0.8 }
const HANDLE_SPRING = { damping: 20, stiffness: 400, mass: 0.6, overshootClamping: true }
const HANDLE_EXIT = { duration: 200, easing: Easing.out(Easing.cubic) }
const PREVIEW_SPRING = { damping: 18, stiffness: 300, mass: 0.7 }
const PREVIEW_EXIT = { duration: 100, easing: Easing.in(Easing.cubic) }
const BUFFER_TIMING = { duration: 300, easing: Easing.out(Easing.quad) }

// ── Worklet helpers ──────────────────────────────────────────────────────
function getTrackGeometry(touching: number, scrubbing: number) {
  'worklet'
  const touchHeight = interpolate(touching, [0, 1], [TRACK_HEIGHT_REST, TRACK_HEIGHT_TOUCH])
  const height = interpolate(scrubbing, [0, 1], [touchHeight, TRACK_HEIGHT_SCRUB])
  return {
    borderRadius: height / 2,
    height,
    top: (TRACK_WRAPPER_HEIGHT - height) / 2,
  }
}

function getProgressFromTouch(touchX: number, trackWidth: number): number {
  'worklet'
  // touchX is relative to the outer container (which has TRACK_PADDING).
  // Subtract padding to get position within the track, then divide by track width.
  if (trackWidth <= 0) return -1 // -1 signals unmeasured — caller must check
  return clamp((touchX - TRACK_PADDING) / trackWidth, 0, 1)
}

function getFineScrubScale(verticalDistance: number): number {
  'worklet'
  if (verticalDistance > 80) return 0.25
  if (verticalDistance > 40) return 0.5
  return 1
}

// ── Haptic helpers (called from UI thread via runOnJS) ──────────────────
function triggerLightHaptic() {
  try { Haptics?.impactAsync?.(Haptics?.ImpactFeedbackStyle?.Light)?.catch?.(() => {}) } catch {}
}

function triggerMediumHaptic() {
  try { Haptics?.impactAsync?.(Haptics?.ImpactFeedbackStyle?.Medium)?.catch?.(() => {}) } catch {}
}

function triggerHeavyHaptic() {
  try { Haptics?.impactAsync?.(Haptics?.ImpactFeedbackStyle?.Heavy)?.catch?.(() => {}) } catch {}
}

type Props = {
  duration: number
  currentTime: number
  progress: number
  bufferProgress?: number // 0-1 float, download progress
  pendingSeekTime?: number | null
  disabled?: boolean
  containerStyle?: any
  externalGesture?: Parameters<ReturnType<(typeof Gesture)['Pan']>['blocksExternalGesture']>[0]
  onScrubStart?: () => void
  onSeekCommit: (timeSeconds: number) => void
}

export const Scrubber = memo(function Scrubber({
  duration,
  currentTime,
  progress,
  bufferProgress = 0,
  pendingSeekTime,
  disabled,
  containerStyle,
  externalGesture,
  onScrubStart,
  onSeekCommit,
}: Props) {
  const [previewSeconds, setPreviewSeconds] = useState<number | null>(null)

  // ── Layout measurement ───────────────────────────────────────────────
  const trackWidthSV = useSharedValue(0)
  const tooltipWidthSV = useSharedValue(0)
  const durationSV = useSharedValue(duration)

  // ── External progress ────────────────────────────────────────────────
  const externalProgressSV = useSharedValue(progress)
  const bufferProgressSV = useSharedValue(bufferProgress)

  // ── Interaction state ────────────────────────────────────────────────
  // Three-state model: rest → touch → scrub
  const isTouchingSV = useSharedValue(0) // 0→1 on finger down
  const isScrubbingSV = useSharedValue(0) // 0→1 when the pan gesture activates
  const isInteractingSV = useSharedValue(false) // gates external progress for entire interaction
  const showPreviewSV = useSharedValue(false)
  const previewVisibilitySV = useSharedValue(0)
  // Track whether we were at a boundary last update (for heavy haptic)
  const wasAtBoundarySV = useSharedValue(false)

  // Buffer shimmer opacity (starts hidden, only visible when buffer is growing)
  const bufferShimmerOpacity = useSharedValue(0)
  const prevBufferProgressSV = useSharedValue(bufferProgress)

  // Lock-and-commit: keeps bar at seek target until parent confirms
  const lockActiveSV = useSharedValue(false)
  const lockProgressSV = useSharedValue(0)

  // The progress value driving the UI (0..1). During interaction this tracks finger.
  const uiProgressSV = useSharedValue(0)

  // ── Sync props to shared values ──────────────────────────────────────
  useEffect(() => { durationSV.value = duration }, [duration, durationSV])
  useEffect(() => { externalProgressSV.value = progress }, [progress, externalProgressSV])
  useEffect(() => {
    bufferProgressSV.value = withTiming(bufferProgress, BUFFER_TIMING)
    // Detect buffer growth for shimmer
    if (bufferProgress > prevBufferProgressSV.value && bufferProgress < 1.0) {
      // Buffer is growing — start shimmer (pulse between 0.25 and 0.45 per spec)
      bufferShimmerOpacity.value = 0.25
      bufferShimmerOpacity.value = withRepeat(
        withTiming(0.45, { duration: 800, easing: Easing.inOut(Easing.ease) }),
        -1, // infinite
        true // reverse
      )
    } else if (bufferProgress >= 1.0) {
      // Fully buffered — stop shimmer (fade to invisible)
      bufferShimmerOpacity.value = withTiming(0, { duration: 300 })
    }
    prevBufferProgressSV.value = bufferProgress
  }, [bufferProgress, bufferProgressSV, bufferShimmerOpacity, prevBufferProgressSV])

  useEffect(() => {
    if (pendingSeekTime === null || pendingSeekTime === undefined || duration <= 0) {
      // Don't clear the lock here — let the animated reaction below clear
      // it once external progress catches up. This prevents snap-back.
      return
    }
    const p = clamp(pendingSeekTime / duration, 0, 1)
    lockActiveSV.value = true
    lockProgressSV.value = p
    uiProgressSV.value = p
  }, [pendingSeekTime, duration, lockActiveSV, lockProgressSV, uiProgressSV])

  // Sync UI progress from external progress when not interacting/locked.
  // Also clears the lock once external progress catches up to the seek target.
  useAnimatedReaction(
    () => externalProgressSV.value,
    (p) => {
      if (isInteractingSV.value) return
      if (lockActiveSV.value) {
        // Check if external progress has caught up to the lock target
        const diff = Math.abs(p - lockProgressSV.value)
        if (diff < 0.005) {
          // Close enough — clear lock and sync
          lockActiveSV.value = false
          uiProgressSV.value = clamp(p, 0, 1)
        }
        // Otherwise keep the lock — don't let stale progress snap back
        return
      }
      uiProgressSV.value = withTiming(clamp(p, 0, 1), { duration: 140 })
    },
    []
  )

  // Emit coarse preview time to JS only when the displayed second changes.
  useAnimatedReaction(
    () => {
      if (!showPreviewSV.value) return -1
      const d = durationSV.value
      if (d <= 0) return -1
      return Math.round(uiProgressSV.value * d)
    },
    (sec, prevSec) => {
      if (sec < 0) return
      if (sec !== prevSec) runOnJS(setPreviewSeconds)(sec)
    },
    []
  )

  const handleCommit = useCallback((timeSeconds: number) => {
    if (disabled || duration <= 0) return
    onSeekCommit(timeSeconds)
  }, [disabled, duration, onSeekCommit])

  // ── Gesture ─────────────────────────────────────────────────────────
  // Single pan gesture: touch to jump, drag to scrub.
  // Dragging uses translationX / trackWidth so the handle moves at
  // exactly the same speed as the finger (1:1 mapping).
  const gesture = useMemo(() => {
    let startProgress = 0
    let startY = 0
    let didDrag = false
    let didCommit = false

    let g = Gesture.Pan()
      .minDistance(0)
      .hitSlop({ top: 12, bottom: 12, left: 0, right: 0 })
      .shouldCancelWhenOutside(false)
      .onBegin((evt) => {
        'worklet'
        const tw = trackWidthSV.value
        const d = durationSV.value
        if (disabled) return
        if (tw <= 0 || d <= 0) return

        const p = getProgressFromTouch(evt.x, tw)
        if (p < 0) return // track not measured yet

        didDrag = false
        didCommit = false
        startY = evt.y

        // Gate external progress, jump thumb to touch point
        isInteractingSV.value = true
        lockActiveSV.value = false
        startProgress = p
        uiProgressSV.value = startProgress

        isTouchingSV.value = withSpring(1, TRACK_SPRING)

        runOnJS(triggerLightHaptic)()
        if (onScrubStart) runOnJS(onScrubStart)()
      })
      .onStart(() => {
        'worklet'
        if (!isInteractingSV.value) return
        didDrag = true
        wasAtBoundarySV.value = false

        runOnJS(triggerMediumHaptic)()
        showPreviewSV.value = true
        isScrubbingSV.value = withSpring(1, HANDLE_SPRING)
        previewVisibilitySV.value = withSpring(1, PREVIEW_SPRING)

        const d = durationSV.value
        if (d > 0) {
          runOnJS(setPreviewSeconds)(Math.round(uiProgressSV.value * d))
        }
      })
      .onUpdate((evt) => {
        'worklet'
        if (!isInteractingSV.value) return
        const tw = trackWidthSV.value
        if (tw <= 0) return

        // translationX / trackWidth gives 1:1 finger-to-handle movement
        const verticalDistance = Math.abs(evt.y - startY)
        const scale = getFineScrubScale(verticalDistance)
        uiProgressSV.value = clamp(startProgress + (evt.translationX * scale) / tw, 0, 1)

        // Heavy haptic at boundaries
        const atBoundary = uiProgressSV.value <= 0.0 || uiProgressSV.value >= 1.0
        if (atBoundary && !wasAtBoundarySV.value) {
          runOnJS(triggerHeavyHaptic)()
        }
        wasAtBoundarySV.value = atBoundary
      })
      .onEnd((evt) => {
        'worklet'
        if (!isInteractingSV.value) return
        didCommit = true
        runOnJS(triggerLightHaptic)()
        const d = durationSV.value
        const p = clamp(uiProgressSV.value, 0, 1)
        lockActiveSV.value = true
        lockProgressSV.value = p
        uiProgressSV.value = p

        if (didDrag) {
          showPreviewSV.value = false
          previewVisibilitySV.value = withTiming(0, PREVIEW_EXIT)
          runOnJS(setPreviewSeconds)(null)
        }
        runOnJS(handleCommit)(p * d)
      })
      .onFinalize(() => {
        'worklet'
        // If onEnd didn't fire (gesture cancelled), commit from here
        if (!didCommit && isInteractingSV.value) {
          const d = durationSV.value
          const p = clamp(uiProgressSV.value, 0, 1)
          lockActiveSV.value = true
          lockProgressSV.value = p
          uiProgressSV.value = p
          runOnJS(handleCommit)(p * d)
        }

        isTouchingSV.value = withSpring(0, TRACK_SPRING)
        isScrubbingSV.value = withTiming(0, HANDLE_EXIT)
        isInteractingSV.value = false
        showPreviewSV.value = false
        previewVisibilitySV.value = withTiming(0, PREVIEW_EXIT)
        startY = 0
        didDrag = false
        didCommit = false
        runOnJS(setPreviewSeconds)(null)
      })

    if (externalGesture) {
      g = g.blocksExternalGesture(externalGesture)
    }
    return g
  }, [disabled, trackWidthSV, durationSV, uiProgressSV, isTouchingSV, isScrubbingSV, isInteractingSV, lockActiveSV, lockProgressSV, wasAtBoundarySV, externalGesture, onScrubStart, handleCommit, showPreviewSV, previewVisibilitySV, setPreviewSeconds])

  // ── Animated styles ──────────────────────────────────────────────────

  // Track background (all three layers share height + borderRadius)
  const trackAnimatedStyle = useAnimatedStyle(() => {
    'worklet'
    const geometry = getTrackGeometry(isTouchingSV.value, isScrubbingSV.value)
    return {
      top: geometry.top,
      height: geometry.height,
      borderRadius: geometry.borderRadius,
    }
  }, [])

  // Buffer fill layer
  const bufferFillStyle = useAnimatedStyle(() => {
    'worklet'
    const geometry = getTrackGeometry(isTouchingSV.value, isScrubbingSV.value)
    const w = trackWidthSV.value
    const bufW = clamp(bufferProgressSV.value, 0, 1) * w
    return {
      top: geometry.top,
      height: geometry.height,
      borderRadius: geometry.borderRadius,
      width: bufW,
    }
  }, [])
  // Buffer shimmer leading edge style
  const bufferShimmerStyle = useAnimatedStyle(() => {
    'worklet'
    const geometry = getTrackGeometry(isTouchingSV.value, isScrubbingSV.value)
    const w = trackWidthSV.value
    const bufW = clamp(bufferProgressSV.value, 0, 1) * w
    // Position a small shimmer element at the leading edge of the buffer
    const shimmerWidth = 8
    return {
      position: 'absolute' as const,
      top: geometry.top,
      height: geometry.height,
      borderRadius: geometry.borderRadius,
      width: shimmerWidth,
      left: Math.max(0, bufW - shimmerWidth),
      backgroundColor: `rgba(145, 71, 255, 1)`,
      opacity: bufferShimmerOpacity.value,
    }
  }, [])

  // Played fill layer
  const fillAnimatedStyle = useAnimatedStyle(() => {
    'worklet'
    const geometry = getTrackGeometry(isTouchingSV.value, isScrubbingSV.value)
    const p = lockActiveSV.value ? lockProgressSV.value : uiProgressSV.value
    const w = trackWidthSV.value
    const fillW = clamp(p, 0, 1) * w
    return {
      top: geometry.top,
      height: geometry.height,
      borderRadius: geometry.borderRadius,
      width: fillW,
    }
  }, [])

  // Handle — always visible, grows on scrub, positioned with translateX
  const handleAnimatedStyle = useAnimatedStyle(() => {
    'worklet'
    const p = lockActiveSV.value ? lockProgressSV.value : uiProgressSV.value
    const size = interpolate(isScrubbingSV.value, [0, 1], [HANDLE_SIZE_REST, HANDLE_SIZE_ACTIVE])
    const tw = trackWidthSV.value
    const handleCenterX = clamp(p, 0, 1) * tw
    const tx = handleCenterX - size / 2
    return {
      width: size,
      height: size,
      borderRadius: size / 2,
      top: TRACK_WRAPPER_HEIGHT / 2 - size / 2,
      transform: [{ translateX: tx }],
      // Glow ring on scrub
      borderWidth: interpolate(isScrubbingSV.value, [0, 1], [0, 2]),
      borderColor: 'rgba(145, 71, 255, 0.50)',
      shadowOpacity: interpolate(isScrubbingSV.value, [0, 1], [0.4, 0.5]),
      shadowRadius: interpolate(isScrubbingSV.value, [0, 1], [3, 5]),
      elevation: interpolate(isScrubbingSV.value, [0, 1], [4, 6]),
    }
  }, [])

  // Preview tooltip — appears during scrub, positioned with translateX
  const previewAnimatedStyle = useAnimatedStyle(() => {
    'worklet'
    const geometry = getTrackGeometry(isTouchingSV.value, isScrubbingSV.value)
    const p = lockActiveSV.value ? lockProgressSV.value : uiProgressSV.value
    const tw = trackWidthSV.value
    const handleCenterX = clamp(p, 0, 1) * tw
    const tooltipWidth = tooltipWidthSV.value
    const maxTooltipOffset = Math.max(0, tw - tooltipWidth)
    const tx = clamp(handleCenterX - tooltipWidth / 2, 0, maxTooltipOffset)
    return {
      bottom: TRACK_WRAPPER_HEIGHT - geometry.top + 12,
      opacity: previewVisibilitySV.value,
      transform: [
        { translateX: tx },
        { scale: interpolate(previewVisibilitySV.value, [0, 1], [0.8, 1]) },
      ],
    }
  }, [])

  const handleTrackLayout = useCallback((e: LayoutChangeEvent) => {
    trackWidthSV.value = e.nativeEvent.layout.width
  }, [trackWidthSV])

  const handleTooltipLayout = useCallback((e: LayoutChangeEvent) => {
    tooltipWidthSV.value = e.nativeEvent.layout.width
  }, [tooltipWidthSV])

  return (
    <Animated.View style={containerStyle}>
      <GestureDetector gesture={gesture}>
        <View
          style={{
            height: TOUCH_TARGET_HEIGHT,
            paddingHorizontal: TRACK_PADDING,
            justifyContent: 'center',
          }}
          accessibilityRole="adjustable"
          accessibilityLabel="Video progress"
          accessibilityValue={{
            min: 0,
            max: Math.round(duration),
            now: Math.round(currentTime),
          }}
          accessibilityActions={[
            { name: 'increment', label: 'Seek forward 10 seconds' },
            { name: 'decrement', label: 'Seek backward 10 seconds' },
          ]}
          onAccessibilityAction={(event) => {
            if (disabled || duration <= 0) return
            const step = 10
            let newTime = currentTime
            if (event.nativeEvent.actionName === 'increment') {
              newTime = Math.min(duration, currentTime + step)
            } else if (event.nativeEvent.actionName === 'decrement') {
              newTime = Math.max(0, currentTime - step)
            }
            onSeekCommit(newTime)
          }}
        >
          {/* Track wrapper — contains all layers */}
          <View style={styles.scrubberTrackWrapper} onLayout={handleTrackLayout}>
            {/* Preview tooltip — above track */}
            {previewSeconds !== null && (
              <Animated.View
                style={[styles.scrubberTooltip, previewAnimatedStyle]}
                pointerEvents="none"
              >
                <View style={styles.scrubberTooltipBubble} onLayout={handleTooltipLayout}>
                  <Text style={styles.scrubberTooltipText}>
                    {formatDuration(previewSeconds)}
                  </Text>
                </View>
                <View style={styles.scrubberTooltipArrow} />
              </Animated.View>
            )}

            {/* Layer 1: Background */}
            <Animated.View
              style={[styles.scrubberTrackBg, trackAnimatedStyle]}
              pointerEvents="none"
            />

            {/* Layer 2: Buffer fill */}
            <Animated.View
              style={[styles.scrubberBufferFill, bufferFillStyle]}
              pointerEvents="none"
            />

            {/* Buffer shimmer leading edge */}
            <Animated.View
              style={bufferShimmerStyle}
              pointerEvents="none"
            />

            {/* Layer 3: Played fill */}
            <Animated.View
              style={[styles.scrubberPlayedFill, fillAnimatedStyle]}
              pointerEvents="none"
            />

            {/* Handle */}
            <Animated.View
              style={[styles.scrubberHandleNew, handleAnimatedStyle]}
              pointerEvents="none"
            />
          </View>
        </View>
      </GestureDetector>
    </Animated.View>
  )
})
