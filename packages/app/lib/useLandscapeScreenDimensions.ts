import { useEffect } from 'react'
import { Dimensions } from 'react-native'
import { useSharedValue, type SharedValue } from 'react-native-reanimated'

/**
 * Tracks the current screen dimensions as Reanimated shared values so the
 * landscape-fullscreen animated styles can size to the live screen without
 * triggering React re-renders. Orientation changes mid-gesture are handled
 * implicitly: this listener updates the shared values while the pan gesture is
 * disabled in landscape fullscreen.
 */
export function useLandscapeScreenDimensions(): {
  landscapeWidth: SharedValue<number>
  landscapeHeight: SharedValue<number>
} {
  const landscapeWidth = useSharedValue(Dimensions.get('screen').width)
  const landscapeHeight = useSharedValue(Dimensions.get('screen').height)

  useEffect(() => {
    const updateDims = () => {
      const screen = Dimensions.get('screen')
      landscapeWidth.value = screen.width
      landscapeHeight.value = screen.height
    }
    updateDims()
    const subscription = Dimensions.addEventListener('change', updateDims)
    return () => subscription.remove()
  }, [])

  return { landscapeWidth, landscapeHeight }
}
