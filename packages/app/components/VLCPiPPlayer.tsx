import React, { forwardRef, useImperativeHandle } from 'react'
import { View, ViewStyle, StyleSheet } from 'react-native'

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
  useImperativeHandle(ref, () => ({
    startPiP: () => {},
    stopPiP: () => {},
    play: () => {},
    pause: () => {},
    stop: () => {},
    isPiPSupported: false,
  }), [])

  return <View style={[styles.fallback, props.style]} />
})

const styles = StyleSheet.create({
  fallback: {
    backgroundColor: '#000',
  },
})

VLCPiPPlayer.displayName = 'VLCPiPPlayer'

export default VLCPiPPlayer
