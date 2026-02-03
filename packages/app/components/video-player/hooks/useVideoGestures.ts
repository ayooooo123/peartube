/**
 * useVideoGestures - Pan gesture handling for fullscreen/mini transitions
 *
 * Manages the pan gesture for dragging between mini player and fullscreen modes,
 * including swipe-to-dismiss functionality for the mini player.
 */

import { useMemo } from 'react'
import { Gesture } from 'react-native-gesture-handler'
import { withSpring, withTiming, runOnJS, type SharedValue } from 'react-native-reanimated'
import {
  MINI_PIP_WIDTH,
  MINI_PIP_HEIGHT,
  MINI_PIP_MARGIN,
  SWIPE_DISMISS_THRESHOLD,
  SWIPE_VELOCITY_THRESHOLD,
  SPRING_CONFIG_BOUNCY,
  SPRING_CONFIG_TIGHT,
} from '../constants'

interface UseVideoGesturesProps {
  // Shared values from parent
  animProgress: SharedValue<number>
  isGestureActive: SharedValue<boolean>
  isLandscapeFullscreenShared: SharedValue<boolean>
  miniPipX: SharedValue<number>
  miniPipY: SharedValue<number>
  miniPipStartX: SharedValue<number>
  miniPipStartY: SharedValue<number>
  swipeDismissX: SharedValue<number>
  swipeDismissOpacity: SharedValue<number>
  isSwipeDismissing: SharedValue<boolean>
  gestureStartedInFullscreen: SharedValue<number>
  screenWidthShared: SharedValue<number>
  screenHeightShared: SharedValue<number>
  insetTopShared: SharedValue<number>
  miniPlayerBottomShared: SharedValue<number>

  // Callbacks
  closeVideo: () => void
  minimizePlayer: () => void
  maximizePlayer: () => void
}

export function useVideoGestures({
  animProgress,
  isGestureActive,
  isLandscapeFullscreenShared,
  miniPipX,
  miniPipY,
  miniPipStartX,
  miniPipStartY,
  swipeDismissX,
  swipeDismissOpacity,
  isSwipeDismissing,
  gestureStartedInFullscreen,
  screenWidthShared,
  screenHeightShared,
  insetTopShared,
  miniPlayerBottomShared,
  closeVideo,
  minimizePlayer,
  maximizePlayer,
}: UseVideoGesturesProps) {
  const panGesture = useMemo(() => Gesture.Pan()
    .onStart(() => {
      'worklet'
      // Skip gesture if in landscape fullscreen mode
      if (isLandscapeFullscreenShared.value) {
        return
      }
      isGestureActive.value = true
      miniPipStartX.value = miniPipX.value
      miniPipStartY.value = miniPipY.value
      // Reset swipe dismiss values
      swipeDismissX.value = 0
      swipeDismissOpacity.value = 1
      isSwipeDismissing.value = false
      // Track mode at gesture start (1 = fullscreen, 0 = mini)
      gestureStartedInFullscreen.value = animProgress.value >= 0.5 ? 1 : 0
    })
    .onUpdate((event) => {
      'worklet'
      // Skip if gesture was started in disabled state
      if (isLandscapeFullscreenShared.value || !isGestureActive.value) {
        return
      }
      // Use gestureStartedInFullscreen for consistent behavior throughout entire gesture
      if (gestureStartedInFullscreen.value === 0) {
        // Mini player mode - always allow dragging, decide dismiss vs reposition on release
        const safeTop = insetTopShared.value + MINI_PIP_MARGIN
        const safeBottom = screenHeightShared.value - MINI_PIP_HEIGHT - MINI_PIP_MARGIN
        const safeLeft = MINI_PIP_MARGIN
        const safeRight = screenWidthShared.value - MINI_PIP_WIDTH - MINI_PIP_MARGIN

        const newX = miniPipStartX.value + event.translationX
        const newY = miniPipStartY.value + event.translationY

        // Allow dragging freely within bounds
        miniPipX.value = Math.max(safeLeft, Math.min(safeRight, newX))
        miniPipY.value = Math.max(safeTop, Math.min(safeBottom, newY))

        // Track if this looks like a dismiss gesture (for visual feedback)
        // Only show dismiss feedback when dragging past the edge bounds
        const pastLeftEdge = newX < safeLeft - 20
        const pastRightEdge = newX > safeRight + 20
        if (pastLeftEdge || pastRightEdge) {
          isSwipeDismissing.value = true
          // Calculate how far past the edge
          const overflowX = pastLeftEdge ? (safeLeft - newX) : (newX - safeRight)
          swipeDismissX.value = pastLeftEdge ? -overflowX : overflowX
          // Fade opacity based on overflow
          const progress = Math.min(overflowX / SWIPE_DISMISS_THRESHOLD, 1)
          swipeDismissOpacity.value = 1 - (progress * 0.4)
        } else {
          isSwipeDismissing.value = false
          swipeDismissX.value = 0
          swipeDismissOpacity.value = 1
        }
      } else {
        // Fullscreen mode - drag to minimize
        const totalDistance = screenHeightShared.value - miniPlayerBottomShared.value - insetTopShared.value - MINI_PIP_HEIGHT
        const dragProgress = -event.translationY / totalDistance
        animProgress.value = Math.max(0, Math.min(1, 1 + dragProgress))
      }
    })
    .onEnd((event) => {
      'worklet'
      // Always reset gesture active state first
      const wasActive = isGestureActive.value
      isGestureActive.value = false

      // Skip if gesture was never activated (landscape mode)
      if (!wasActive) {
        return
      }

      // Handle mini player gestures (swipe dismiss or corner snap)
      if (gestureStartedInFullscreen.value === 0) {
        const safeTop = insetTopShared.value + MINI_PIP_MARGIN
        const safeBottom = screenHeightShared.value - MINI_PIP_HEIGHT - MINI_PIP_MARGIN - miniPlayerBottomShared.value
        const safeLeft = MINI_PIP_MARGIN
        const safeRight = screenWidthShared.value - MINI_PIP_WIDTH - MINI_PIP_MARGIN

        // Check if this should be a dismiss gesture:
        // - High horizontal velocity (fast swipe)
        // - OR was showing dismiss feedback (dragged past edge)
        const absVelocityX = Math.abs(event.velocityX)
        const shouldDismiss = absVelocityX >= SWIPE_VELOCITY_THRESHOLD || isSwipeDismissing.value

        if (shouldDismiss && absVelocityX > 200) {
          // Dismiss - animate off screen in swipe direction
          const direction = event.velocityX > 0 ? 1 : -1
          swipeDismissX.value = withTiming(direction * screenWidthShared.value, { duration: 200 })
          swipeDismissOpacity.value = withTiming(0, { duration: 200 })
          // Animate position off screen too
          miniPipX.value = withTiming(direction > 0 ? screenWidthShared.value : -MINI_PIP_WIDTH, { duration: 200 })
          runOnJS(closeVideo)()
        } else {
          // Snap to nearest corner with bouncy animation
          const centerX = miniPipX.value + MINI_PIP_WIDTH / 2
          const centerY = miniPipY.value + MINI_PIP_HEIGHT / 2
          const screenCenterX = screenWidthShared.value / 2
          const screenCenterY = (safeTop + safeBottom) / 2

          // Factor in velocity for more natural feeling (throw towards corner)
          const velocityInfluence = 30
          const adjustedCenterX = centerX + (event.velocityX / velocityInfluence)
          const adjustedCenterY = centerY + (event.velocityY / velocityInfluence)

          const targetX = adjustedCenterX < screenCenterX ? safeLeft : safeRight
          const targetY = adjustedCenterY < screenCenterY ? safeTop : safeBottom

          // Animate to corner with bouncy spring
          miniPipX.value = withSpring(targetX, SPRING_CONFIG_BOUNCY)
          miniPipY.value = withSpring(targetY, SPRING_CONFIG_BOUNCY)

          // Reset any dismiss visual feedback
          swipeDismissX.value = withSpring(0, SPRING_CONFIG_BOUNCY)
          swipeDismissOpacity.value = withSpring(1, SPRING_CONFIG_BOUNCY)
        }
        // Always reset swipe dismiss state
        isSwipeDismissing.value = false
      } else if (gestureStartedInFullscreen.value === 1) {
        // YouTube-like snap behavior with velocity-based decisions
        const velocity = event.velocityY
        const position = animProgress.value

        // Determine snap direction based on position and velocity
        let shouldMinimize = false

        if (velocity > 300) {
          // Fast swipe down - minimize
          shouldMinimize = true
        } else if (velocity < -300) {
          // Fast swipe up - maximize
          shouldMinimize = false
        } else if (position < 0.75) {
          // Below commitment threshold (0.75): need to drag 25% down to minimize
          // In the uncertain zone (0.5-0.75), velocity decides
          // Tiny velocity (> 20 px/s) in direction determines outcome
          shouldMinimize = velocity > 20
        } else {
          // Above 0.75: stay fullscreen unless velocity says otherwise
          shouldMinimize = velocity > 100
        }

        if (shouldMinimize) {
          animProgress.value = withSpring(0, SPRING_CONFIG_TIGHT)
          runOnJS(minimizePlayer)()
        } else {
          animProgress.value = withSpring(1, SPRING_CONFIG_BOUNCY)
          runOnJS(maximizePlayer)()
        }
      } else {
        // Fallback: snap to nearest state to prevent stuck states
        if (animProgress.value < 0.5) {
          animProgress.value = withSpring(0, SPRING_CONFIG_TIGHT)
        } else {
          animProgress.value = withSpring(1, SPRING_CONFIG_BOUNCY)
        }
      }
    }), [closeVideo, minimizePlayer, maximizePlayer])

  return panGesture
}
