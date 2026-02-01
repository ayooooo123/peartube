import React, { useRef, forwardRef, useImperativeHandle, useCallback } from 'react'
import {
  requireNativeComponent,
  UIManager,
  findNodeHandle,
  ViewStyle,
  Platform,
  StyleSheet,
  View,
} from 'react-native'

// Check if iOS 15+ for PiP support
const isPiPSupported = Platform.OS === 'ios' && parseInt(Platform.Version as string, 10) >= 15

interface VLCPiPPlayerNativeProps {
  style?: ViewStyle
  source?: { uri: string }
  paused?: boolean
  seek?: number
  onPiPStateChange?: (event: { nativeEvent: { isActive: boolean } }) => void
  onPlaybackStateChange?: (event: { nativeEvent: { state: string } }) => void
  onError?: (event: { nativeEvent: { message: string } }) => void
  onProgress?: (event: { nativeEvent: { currentTime: number; duration: number; position: number } }) => void
  onLoad?: (event: { nativeEvent: { duration: number; videoSize: { width: number; height: number } } }) => void
  onEnd?: (event: { nativeEvent: {} }) => void
}

const NativeVLCPiPPlayer = isPiPSupported
  ? requireNativeComponent<VLCPiPPlayerNativeProps>('VLCPiPPlayer')
  : null

export interface VLCPiPPlayerRef {
  startPiP: () => void
  stopPiP: () => void
  play: () => void
  pause: () => void
  stop: () => void
  isPiPSupported: boolean
}

export interface VLCPiPPlayerProps {
  style?: ViewStyle
  source?: { uri: string }
  paused?: boolean
  onPiPStateChange?: (isActive: boolean) => void
  onPlaybackStateChange?: (state: string) => void
  onError?: (message: string) => void
  onProgress?: (progress: { currentTime: number; duration: number; position: number }) => void
  onLoad?: (info: { duration: number; videoSize: { width: number; height: number } }) => void
  onEnd?: () => void
}

const VLCPiPPlayer = forwardRef<VLCPiPPlayerRef, VLCPiPPlayerProps>((props, ref) => {
  const nativeRef = useRef<any>(null)

  const callNativeMethod = useCallback((method: string) => {
    if (!NativeVLCPiPPlayer || !nativeRef.current) return

    const handle = findNodeHandle(nativeRef.current)
    if (handle) {
      UIManager.dispatchViewManagerCommand(
        handle,
        UIManager.getViewManagerConfig('VLCPiPPlayer').Commands[method],
        []
      )
    }
  }, [])

  useImperativeHandle(ref, () => ({
    startPiP: () => callNativeMethod('startPiP'),
    stopPiP: () => callNativeMethod('stopPiP'),
    play: () => callNativeMethod('play'),
    pause: () => callNativeMethod('pause'),
    stop: () => callNativeMethod('stop'),
    isPiPSupported,
  }), [callNativeMethod])

  const handlePiPStateChange = useCallback((event: { nativeEvent: { isActive: boolean } }) => {
    props.onPiPStateChange?.(event.nativeEvent.isActive)
  }, [props.onPiPStateChange])

  const handlePlaybackStateChange = useCallback((event: { nativeEvent: { state: string } }) => {
    props.onPlaybackStateChange?.(event.nativeEvent.state)
  }, [props.onPlaybackStateChange])

  const handleError = useCallback((event: { nativeEvent: { message: string } }) => {
    props.onError?.(event.nativeEvent.message)
  }, [props.onError])

  const handleProgress = useCallback((event: { nativeEvent: { currentTime: number; duration: number; position: number } }) => {
    props.onProgress?.(event.nativeEvent)
  }, [props.onProgress])

  const handleLoad = useCallback((event: { nativeEvent: { duration: number; videoSize: { width: number; height: number } } }) => {
    props.onLoad?.(event.nativeEvent)
  }, [props.onLoad])

  const handleEnd = useCallback((_event: { nativeEvent: {} }) => {
    props.onEnd?.()
  }, [props.onEnd])

  if (!NativeVLCPiPPlayer) {
    // Fallback for iOS < 15
    return <View style={[styles.fallback, props.style]} />
  }

  return (
    <NativeVLCPiPPlayer
      ref={nativeRef}
      style={props.style}
      source={props.source}
      paused={props.paused}
      onPiPStateChange={handlePiPStateChange}
      onPlaybackStateChange={handlePlaybackStateChange}
      onError={handleError}
      onProgress={handleProgress}
      onLoad={handleLoad}
      onEnd={handleEnd}
    />
  )
})

const styles = StyleSheet.create({
  fallback: {
    backgroundColor: '#000',
  },
})

VLCPiPPlayer.displayName = 'VLCPiPPlayer'

export default VLCPiPPlayer
