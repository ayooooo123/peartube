import { requireNativeModule, Platform, EventEmitter } from 'expo-modules-core'
import type { EventSubscription as Subscription } from 'expo-modules-core'

// Types for metadata and playback state
export interface NowPlayingMetadata {
  title: string
  artist?: string
  album?: string
  artworkUrl?: string
  duration: number // seconds
}

export interface PlaybackState {
  isPlaying: boolean
  position: number // seconds
  duration: number // seconds
  rate: number // playback rate (1 = normal)
}

export type RemoteCommandType = 
  | 'play'
  | 'pause'
  | 'togglePlayPause'
  | 'stop'
  | 'skipForward'
  | 'skipBackward'
  | 'seekTo'
  | 'nextTrack'
  | 'previousTrack'

export interface RemoteCommandEvent {
  command: RemoteCommandType
  // For seekTo command
  position?: number
  // For skip commands (default: 10 seconds)
  interval?: number
}

export interface AudioInterruptionEvent {
  type: 'began' | 'ended'
  // iOS: whether playback should resume after interruption ended
  shouldResume?: boolean
}

export interface AudioRouteChangeEvent {
  reason: 'newDeviceAvailable' | 'oldDeviceUnavailable' | 'categoryChange' | 'override' | 'wakeFromSleep' | 'noSuitableRouteForCategory' | 'routeConfigurationChange' | 'unknown'
}

// Native module interface
interface MediaSessionModuleInterface {
  // Activate/deactivate the media session
  setActive(active: boolean): Promise<void>
  
  // Update Now Playing metadata (lock screen, Control Center, notification)
  setNowPlaying(metadata: NowPlayingMetadata): Promise<void>
  
  // Update playback state (position, duration, rate, playing/paused)
  setPlaybackState(state: PlaybackState): Promise<void>
  
  // Clear Now Playing info
  clearNowPlaying(): Promise<void>
  
  // Android only: enter/exit PiP mode
  enterPictureInPicture?(): Promise<boolean>
  
  // Android only: check if PiP is supported
  isPictureInPictureSupported?(): Promise<boolean>
}

// Get native module or provide web fallback
const MediaSessionNative: MediaSessionModuleInterface = Platform.OS !== 'web'
  ? requireNativeModule('MediaSession')
  : {
      setActive: async () => {},
      setNowPlaying: async () => {},
      setPlaybackState: async () => {},
      clearNowPlaying: async () => {},
    }

// Event emitter for native events
const emitter = Platform.OS !== 'web' 
  ? new EventEmitter(requireNativeModule('MediaSession'))
  : null

/**
 * Activate the media session.
 * - iOS: Configures AVAudioSession for playback, enables remote commands
 * - Android: Starts foreground service with media notification
 * 
 * Call this when playback starts.
 */
export async function setActive(active: boolean): Promise<void> {
  return MediaSessionNative.setActive(active)
}

/**
 * Update Now Playing metadata shown on lock screen / notification.
 * 
 * @param metadata - Track metadata (title, artist, artwork, duration)
 */
export async function setNowPlaying(metadata: NowPlayingMetadata): Promise<void> {
  return MediaSessionNative.setNowPlaying(metadata)
}

/**
 * Update playback state.
 * Call this periodically (e.g., every second during playback) to keep
 * the lock screen progress bar accurate.
 * 
 * @param state - Current playback state (isPlaying, position, duration, rate)
 */
export async function setPlaybackState(state: PlaybackState): Promise<void> {
  return MediaSessionNative.setPlaybackState(state)
}

/**
 * Clear Now Playing info.
 * Call this when playback stops completely.
 */
export async function clearNowPlaying(): Promise<void> {
  return MediaSessionNative.clearNowPlaying()
}

/**
 * Enter Picture-in-Picture mode (Android only).
 * Returns true if PiP was entered successfully.
 */
export async function enterPictureInPicture(): Promise<boolean> {
  if (Platform.OS !== 'android' || !MediaSessionNative.enterPictureInPicture) {
    return false
  }
  return MediaSessionNative.enterPictureInPicture()
}

/**
 * Check if PiP is supported on this device (Android only).
 */
export async function isPictureInPictureSupported(): Promise<boolean> {
  if (Platform.OS !== 'android' || !MediaSessionNative.isPictureInPictureSupported) {
    return false
  }
  return MediaSessionNative.isPictureInPictureSupported()
}

/**
 * Enable/disable auto Picture-in-Picture on home press (Android 12+ only).
 * When enabled, the app will automatically enter PiP when the user presses home
 * while video is playing.
 */
export async function setAutoPictureInPicture(enabled: boolean): Promise<void> {
  console.log('[MediaSession JS] setAutoPictureInPicture called:', enabled)
  if (Platform.OS !== 'android') {
    console.log('[MediaSession JS] Not Android, skipping')
    return
  }
  if (!(MediaSessionNative as any).setAutoPictureInPicture) {
    console.log('[MediaSession JS] setAutoPictureInPicture not available on native module')
    return
  }
  try {
    await (MediaSessionNative as any).setAutoPictureInPicture(enabled)
    console.log('[MediaSession JS] setAutoPictureInPicture succeeded')
  } catch (err) {
    console.error('[MediaSession JS] setAutoPictureInPicture failed:', err)
  }
}

/**
 * Set the source rect hint for PiP (Android only).
 * This tells Android which part of the screen contains the video.
 */
export async function setPictureInPictureSourceRect(rect: { x: number; y: number; width: number; height: number }): Promise<void> {
  if (Platform.OS !== 'android' || !(MediaSessionNative as any).setPictureInPictureSourceRect) {
    return
  }
  return (MediaSessionNative as any).setPictureInPictureSourceRect(rect)
}

/**
 * Set the aspect ratio for PiP window (Android only).
 * Call this when video dimensions become known.
 *
 * @param width - Video width in pixels
 * @param height - Video height in pixels
 */
export async function setPictureInPictureAspectRatio(width: number, height: number): Promise<void> {
  if (Platform.OS !== 'android' || !(MediaSessionNative as any).setPictureInPictureAspectRatio) {
    return
  }
  console.log('[MediaSession JS] setPictureInPictureAspectRatio:', width, 'x', height)
  return (MediaSessionNative as any).setPictureInPictureAspectRatio(width, height)
}

/**
 * Enable/disable the native status bar overlay (Android only).
 *
 * When enabled, a black bar is shown over the status bar area to prevent
 * video from playing behind the camera cutout. The overlay is automatically
 * hidden during PiP transitions to prevent black bars in the PiP window.
 *
 * Call with `true` when entering fullscreen video mode.
 * Call with `false` when exiting fullscreen video mode.
 *
 * @param enabled - Whether the overlay should be visible
 */
export async function setStatusBarOverlayEnabled(enabled: boolean): Promise<void> {
  if (Platform.OS !== 'android') {
    console.log('[MediaSession JS] setStatusBarOverlayEnabled: not Android, skipping')
    return
  }
  if (!(MediaSessionNative as any).setStatusBarOverlayEnabled) {
    console.log('[MediaSession JS] setStatusBarOverlayEnabled: function not available on native module')
    return
  }
  console.log('[MediaSession JS] setStatusBarOverlayEnabled: calling native with enabled=', enabled)
  try {
    await (MediaSessionNative as any).setStatusBarOverlayEnabled(enabled)
    console.log('[MediaSession JS] setStatusBarOverlayEnabled: native call succeeded')
  } catch (err) {
    console.error('[MediaSession JS] setStatusBarOverlayEnabled: native call failed:', err)
  }
}

/**
 * Subscribe to remote control commands (play, pause, seek, skip, etc.)
 * from lock screen, notification, headset buttons, etc.
 * 
 * @param listener - Callback receiving RemoteCommandEvent
 * @returns Subscription that can be removed
 */
export function addRemoteCommandListener(
  listener: (event: RemoteCommandEvent) => void
): Subscription {
  if (!emitter) {
    return { remove: () => {} }
  }
  return (emitter as any).addListener('onRemoteCommand', (event: RemoteCommandEvent) => {
    console.log('[MediaSession JS] Remote command event received:', event)
    listener(event)
  })
}

/**
 * Subscribe to audio interruption events (phone call, Siri, other audio).
 * 
 * @param listener - Callback receiving AudioInterruptionEvent
 * @returns Subscription that can be removed
 */
export function addAudioInterruptionListener(
  listener: (event: AudioInterruptionEvent) => void
): Subscription {
  if (!emitter) {
    return { remove: () => {} }
  }
  return (emitter as any).addListener('onAudioInterruption', listener)
}

/**
 * Subscribe to audio route changes (headphones plugged/unplugged, etc.)
 * 
 * @param listener - Callback receiving AudioRouteChangeEvent
 * @returns Subscription that can be removed
 */
export function addAudioRouteChangeListener(
  listener: (event: AudioRouteChangeEvent) => void
): Subscription {
  if (!emitter) {
    return { remove: () => {} }
  }
  return (emitter as any).addListener('onAudioRouteChange', listener)
}

/**
 * PiP event payload.
 * - isPreparing: true when PiP entry is about to happen (gives JS time to update layout)
 * - isInPictureInPicture: true when actually in PiP mode
 */
export interface PictureInPictureEvent {
  isInPictureInPicture: boolean
  isPreparing?: boolean
  width?: number
  height?: number
}

/**
 * Subscribe to PiP state changes (Android only).
 *
 * @param listener - Callback receiving PictureInPictureEvent
 * @returns Subscription that can be removed
 */
export function addPictureInPictureListener(
  listener: (event: PictureInPictureEvent) => void
): Subscription {
  if (!emitter) {
    return { remove: () => {} }
  }
  return (emitter as any).addListener(
    'onPictureInPictureChanged',
    (event: PictureInPictureEvent) => {
    console.log('[MediaSession JS] PiP changed event received:', event)
    listener(event)
    }
  )
}

export default {
  setActive,
  setNowPlaying,
  setPlaybackState,
  clearNowPlaying,
  enterPictureInPicture,
  isPictureInPictureSupported,
  setAutoPictureInPicture,
  setPictureInPictureAspectRatio,
  setStatusBarOverlayEnabled,
  addRemoteCommandListener,
  addAudioInterruptionListener,
  addAudioRouteChangeListener,
  addPictureInPictureListener,
}
