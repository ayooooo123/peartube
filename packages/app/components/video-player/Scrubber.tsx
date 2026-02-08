import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { Text, View } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, {
  clamp,
  interpolate,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated'
import { styles } from './styles'
import { formatDuration } from './formatters'

type Props = {
  duration: number
  currentTime: number
  progress: number
  pendingSeekTime?: number | null
  disabled?: boolean
  containerStyle?: any
  externalGesture?: Parameters<ReturnType<(typeof Gesture)['Pan']>['blocksExternalGesture']>[0]
  onSeekCommit: (timeSeconds: number) => void
}

export const Scrubber = memo(function Scrubber({
  duration,
  currentTime,
  progress,
  pendingSeekTime,
  disabled,
  containerStyle,
  externalGesture,
  onSeekCommit,
}: Props) {
  const [previewSeconds, setPreviewSeconds] = useState<number | null>(null)

  const trackWidthSV = useSharedValue(0)
  const durationSV = useSharedValue(duration)
  const currentTimeSV = useSharedValue(currentTime)

  const externalProgressSV = useSharedValue(progress)
  const isScrubbingSV = useSharedValue(false)
  const activationSV = useSharedValue(0)

  // When committing a seek, keep the bar locked to the target until the parent
  // clears pendingSeekTime (once playback progress catches up).
  const lockActiveSV = useSharedValue(false)
  const lockProgressSV = useSharedValue(0)

  // The progress value that drives the UI (0..1). During scrubbing this tracks finger.
  const uiProgressSV = useSharedValue(0)

  useEffect(() => {
    durationSV.value = duration
  }, [duration, durationSV])

  useEffect(() => {
    currentTimeSV.value = currentTime
  }, [currentTime, currentTimeSV])

  useEffect(() => {
    externalProgressSV.value = progress
  }, [progress, externalProgressSV])

  useEffect(() => {
    if (pendingSeekTime === null || pendingSeekTime === undefined || duration <= 0) {
      lockActiveSV.value = false
      return
    }

    const p = clamp(pendingSeekTime / duration, 0, 1)
    lockActiveSV.value = true
    lockProgressSV.value = p
    uiProgressSV.value = p
  }, [pendingSeekTime, duration, lockActiveSV, lockProgressSV, uiProgressSV])

  // Sync UI progress from external progress when not scrubbing/locked.
  useAnimatedReaction(
    () => externalProgressSV.value,
    (p) => {
      if (isScrubbingSV.value) return
      if (lockActiveSV.value) return
      uiProgressSV.value = withTiming(clamp(p, 0, 1), { duration: 140 })
    },
    []
  )

  // Emit a coarse preview time to JS only when the displayed second changes.
  useAnimatedReaction(
    () => {
      if (!isScrubbingSV.value) return -1
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

  const updateWidth = useCallback((w: number) => {
    trackWidthSV.value = w
  }, [trackWidthSV])

  const handleCommit = useCallback((timeSeconds: number) => {
    if (disabled || duration <= 0) return
    onSeekCommit(timeSeconds)
  }, [disabled, duration, onSeekCommit])

  const panGesture = useMemo(() => {
    let g = Gesture.Pan()
      // Make the scrubber very forgiving: any touch on the track should start.
      // This fixes the "takes a few clicks" feel caused by Tap+Pan both failing
      // when the finger drifts slightly vertically.
      .minDistance(0)
      .hitSlop({ top: 14, bottom: 14, left: 8, right: 8 })
      .onStart((evt) => {
        'worklet'
        if (disabled) return
        const w = trackWidthSV.value
        const d = durationSV.value
        if (w <= 0 || d <= 0) return

        lockActiveSV.value = false
        isScrubbingSV.value = true
        activationSV.value = withTiming(1, { duration: 120 })

        // Jump the thumb immediately to the touch point.
        uiProgressSV.value = clamp(evt.x / w, 0, 1)
      })
      .onUpdate((evt) => {
        'worklet'
        if (!isScrubbingSV.value) return
        const w = trackWidthSV.value
        const d = durationSV.value
        if (w <= 0 || d <= 0) return
        uiProgressSV.value = clamp(evt.x / w, 0, 1)
      })
      .onEnd(() => {
        'worklet'
        if (!isScrubbingSV.value) return
        const d = durationSV.value
        const timeSeconds = clamp(uiProgressSV.value, 0, 1) * d

        // Lock locally immediately to avoid snapping back before parent state updates.
        lockActiveSV.value = true
        lockProgressSV.value = clamp(uiProgressSV.value, 0, 1)
        uiProgressSV.value = lockProgressSV.value

        isScrubbingSV.value = false
        activationSV.value = withTiming(0, { duration: 220 })
        runOnJS(setPreviewSeconds)(null)
        runOnJS(handleCommit)(timeSeconds)
      })
      .onFinalize(() => {
        'worklet'
        isScrubbingSV.value = false
      })

    if (externalGesture) {
      g = g.blocksExternalGesture(externalGesture)
    }
    return g
  }, [disabled, trackWidthSV, durationSV, uiProgressSV, activationSV, lockActiveSV, lockProgressSV, isScrubbingSV, externalGesture, handleCommit])

  const gesture = panGesture

  const trackAnimatedStyle = useAnimatedStyle(() => {
    'worklet'
    const h = interpolate(activationSV.value, [0, 1], [3, 6])
    return { height: h }
  }, [])

  const fillAnimatedStyle = useAnimatedStyle(() => {
    'worklet'
    const h = interpolate(activationSV.value, [0, 1], [3, 6])
    const p = lockActiveSV.value ? lockProgressSV.value : uiProgressSV.value
    return {
      height: h,
      width: `${clamp(p, 0, 1) * 100}%`,
    }
  }, [])

  const handleAnimatedStyle = useAnimatedStyle(() => {
    'worklet'
    const p = lockActiveSV.value ? lockProgressSV.value : uiProgressSV.value
    return {
      opacity: activationSV.value,
      transform: [{ scale: interpolate(activationSV.value, [0, 1], [0.85, 1]) }],
      left: `${clamp(p, 0, 1) * 100}%`,
    }
  }, [])

  const previewAnimatedStyle = useAnimatedStyle(() => {
    'worklet'
    const p = lockActiveSV.value ? lockProgressSV.value : uiProgressSV.value
    return {
      opacity: activationSV.value,
      left: `${clamp(p, 0, 1) * 100}%`,
    }
  }, [])

  return (
    <Animated.View
      style={containerStyle}
      onLayout={(e) => updateWidth(e.nativeEvent.layout.width)}
    >
      <GestureDetector gesture={gesture}>
        <View style={{ flex: 1, justifyContent: 'flex-end' }}>
          {previewSeconds !== null && (
            <Animated.View style={[styles.seekTimePreview, previewAnimatedStyle]} pointerEvents="none">
              <Text style={styles.seekTimeText}>{formatDuration(previewSeconds)}</Text>
            </Animated.View>
          )}

          <Animated.View style={[styles.thinProgressBg, trackAnimatedStyle]} pointerEvents="none">
            <Animated.View style={[styles.thinProgressFill, fillAnimatedStyle]} />
          </Animated.View>

          <Animated.View style={[styles.scrubberHandle, handleAnimatedStyle]} pointerEvents="none" />
        </View>
      </GestureDetector>
    </Animated.View>
  )
})
