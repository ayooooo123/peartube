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

export interface PictureInPicturePlaybackState {
  isPlaying: boolean
  isBuffering?: boolean
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
  | 'backgroundAudio'

export interface RemoteCommandEvent {
  command: RemoteCommandType
  // For seekTo command
  position?: number
  // For skip commands (default: 10 seconds)
  interval?: number
  // Android only: native transport path already applied the command to the shared player
  handledByNative?: boolean
  // Optional native source/reason metadata for distinguishing true close/stop
  // events (e.g. PiP dismissal) from generic transport noise.
  reason?: string
}

export interface AudioInterruptionEvent {
  type: 'began' | 'ended'
  // iOS: whether playback should resume after interruption ended
  shouldResume?: boolean
}

export interface AudioRouteChangeEvent {
  reason: 'newDeviceAvailable' | 'oldDeviceUnavailable' | 'categoryChange' | 'override' | 'wakeFromSleep' | 'noSuitableRouteForCategory' | 'routeConfigurationChange' | 'unknown'
}

export type PictureInPictureActionType = 'playPause' | 'backgroundAudio'

export interface PictureInPictureActionEvent {
  action: PictureInPictureActionType
  isPlaying?: boolean
}


// Native module interface
interface MediaSessionModuleInterface {
  // Activate/deactivate the media session
  setActive(active: boolean): Promise<void>
  
  // Update Now Playing metadata (lock screen, Control Center, notification)
  setNowPlaying(metadata: NowPlayingMetadata): Promise<void>
  
  // Update playback state (position, duration, rate, playing/paused)
  setPlaybackState(state: PlaybackState): Promise<void>

  // Android only: update the custom PiP action row playback state
  setPictureInPicturePlaybackState?(state: PictureInPicturePlaybackState): Promise<void>
  
  // Clear Now Playing info
  clearNowPlaying(): Promise<void>
  
  // Android only: enter/exit PiP mode
  enterPictureInPicture?(): Promise<boolean>
  
  // Android only: check if PiP is supported
  isPictureInPictureSupported?(): Promise<boolean>

  // Android only: tell native to spend one immediate PiP attempt in the next leave-hint
  armImmediatePipOnNextLeaveHint?(): Promise<void>

  // Android only: dismiss PiP into background-audio mode while keeping session alive
  enterBackgroundAudioMode?(): Promise<void>

  startCastForegroundService?(title: string, subtitle: string): Promise<void>
  updateCastForegroundService?(title: string, subtitle: string): Promise<void>
  stopCastForegroundService?(): Promise<void>
  openPlayerActivity?(payload?: any): Promise<boolean>
  isInPlayerActivity?(): Promise<boolean>
  consumePendingPlayerLaunchPayload?(): Promise<any | null>
  clearPendingPlayerLaunchPayload?(): Promise<void>
  primePlayerActivityPayload?(payload?: any): Promise<void>
}

const mediaSessionFallback: MediaSessionModuleInterface = {
  setActive: async () => {},
  setNowPlaying: async () => {},
  setPlaybackState: async () => {},
  clearNowPlaying: async () => {},
}

let mediaSessionNativeCache: MediaSessionModuleInterface | null = null
let mediaSessionEmitterCache: any = null

function getMediaSessionNative(): MediaSessionModuleInterface {
  if (Platform.OS === 'web') return mediaSessionFallback
  if (mediaSessionNativeCache) return mediaSessionNativeCache
  try {
    mediaSessionNativeCache = requireNativeModule<MediaSessionModuleInterface>('MediaSession')
    return mediaSessionNativeCache
  } catch (err) {
    console.warn('[MediaSession] Native module unavailable:', err)
    return mediaSessionFallback
  }
}

function getMediaSessionEmitter(): any {
  if (Platform.OS === 'web') return null
  if (mediaSessionEmitterCache) return mediaSessionEmitterCache
  try {
    mediaSessionEmitterCache = new EventEmitter(getMediaSessionNative() as any)
    return mediaSessionEmitterCache
  } catch (err) {
    console.warn('[MediaSession] EventEmitter unavailable:', err)
    return null
  }
}

/**
 * Activate the media session.
 * - iOS: Configures AVAudioSession for playback, enables remote commands
 * - Android: Starts foreground service with media notification
 * 
 * Call this when playback starts.
 */
export async function setActive(active: boolean): Promise<void> {
  return getMediaSessionNative().setActive(active)
}

/**
 * Update Now Playing metadata shown on lock screen / notification.
 * 
 * @param metadata - Track metadata (title, artist, artwork, duration)
 */
export async function setNowPlaying(metadata: NowPlayingMetadata): Promise<void> {
  return getMediaSessionNative().setNowPlaying(metadata)
}

/**
 * Update playback state.
 * Call this periodically (e.g., every second during playback) to keep
 * the lock screen progress bar accurate.
 * 
 * @param state - Current playback state (isPlaying, position, duration, rate)
 */
export async function setPlaybackState(state: PlaybackState): Promise<void> {
  return getMediaSessionNative().setPlaybackState(state)
}

export async function setPictureInPicturePlaybackState(state: PictureInPicturePlaybackState): Promise<void> {
  if (Platform.OS !== 'android') return
  const native = getMediaSessionNative()
  if (!native.setPictureInPicturePlaybackState) return
  return native.setPictureInPicturePlaybackState(state)
}

/**
 * Clear Now Playing info.
 * Call this when playback stops completely.
 */
export async function clearNowPlaying(): Promise<void> {
  return getMediaSessionNative().clearNowPlaying()
}

/**
 * Enter Picture-in-Picture mode (Android only).
 * Returns true if PiP was entered successfully.
 */
export async function enterPictureInPicture(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return false
  }
  const native = getMediaSessionNative()
  if (!native.enterPictureInPicture) return false
  return native.enterPictureInPicture()
}

export async function isPictureInPictureSupported(): Promise<boolean> {
  if (Platform.OS === 'web') return false
  const native = getMediaSessionNative()
  if (!native.isPictureInPictureSupported) return false
  return native.isPictureInPictureSupported()
}

export async function setAutoPictureInPicture(enabled: boolean): Promise<void> {
  if (Platform.OS !== 'android') return
  const native = getMediaSessionNative() as any
  if (!native.setAutoPictureInPicture) return
  try {
    await native.setAutoPictureInPicture(enabled)
  } catch (err) {
    console.error('[MediaSession] setAutoPictureInPicture failed:', err)
  }
}

export async function armImmediatePipOnNextLeaveHint(): Promise<void> {
  if (Platform.OS !== 'android') return
  const native = getMediaSessionNative() as any
  if (!native.armImmediatePipOnNextLeaveHint) return
  try {
    await native.armImmediatePipOnNextLeaveHint()
  } catch (err) {
    console.error('[MediaSession] armImmediatePipOnNextLeaveHint failed:', err)
  }
}

export async function enterBackgroundAudioMode(): Promise<void> {
  if (Platform.OS !== 'android') return
  const native = getMediaSessionNative() as any
  if (!native.enterBackgroundAudioMode) return
  try {
    await native.enterBackgroundAudioMode()
  } catch (err) {
    console.error('[MediaSession] enterBackgroundAudioMode failed:', err)
  }
}

export async function setPictureInPictureSourceRect(rect: { x: number; y: number; width: number; height: number }): Promise<void> {
  if (Platform.OS !== 'android') return
  const native = getMediaSessionNative() as any
  if (!native.setPictureInPictureSourceRect) {
    return
  }
  return native.setPictureInPictureSourceRect(rect)
}

/**
 * Set the aspect ratio for PiP window (Android only).
 * Call this when video dimensions become known.
 *
 * @param width - Video width in pixels
 * @param height - Video height in pixels
 */
export async function setPictureInPictureAspectRatio(width: number, height: number): Promise<void> {
  if (Platform.OS !== 'android') {
    return
  }
  const native = getMediaSessionNative() as any
  if (!native.setPictureInPictureAspectRatio) {
    return
  }
  return native.setPictureInPictureAspectRatio(width, height)
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
  if (Platform.OS !== 'android') return
  const native = getMediaSessionNative() as any
  if (!native.setStatusBarOverlayEnabled) return
  try {
    await native.setStatusBarOverlayEnabled(enabled)
  } catch (err) {
    console.error('[MediaSession] setStatusBarOverlayEnabled failed:', err)
  }
}

/**
 * Shift the underlying SurfaceView by a top inset (Android only).
 * This avoids layout changes while moving the video below the cutout.
 */
export async function setSurfaceViewInset(topInsetDp: number): Promise<void> {
  if (Platform.OS !== 'android') {
    return
  }
  const native = getMediaSessionNative() as any
  if (!native.setSurfaceViewInset) {
    return
  }
  return native.setSurfaceViewInset(topInsetDp)
}

export async function startCastForegroundService(title: string, subtitle: string): Promise<void> {
  const native = getMediaSessionNative()
  if (Platform.OS !== 'android' || !native.startCastForegroundService) return
  return native.startCastForegroundService(title, subtitle)
}

export async function updateCastForegroundService(title: string, subtitle: string): Promise<void> {
  const native = getMediaSessionNative()
  if (Platform.OS !== 'android' || !native.updateCastForegroundService) return
  return native.updateCastForegroundService(title, subtitle)
}

export async function stopCastForegroundService(): Promise<void> {
  const native = getMediaSessionNative()
  if (Platform.OS !== 'android' || !native.stopCastForegroundService) return
  return native.stopCastForegroundService()
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
  const emitter = getMediaSessionEmitter()
  if (!emitter) {
    return { remove: () => {} }
  }
  return (emitter as any).addListener('onRemoteCommand', listener)
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
  const emitter = getMediaSessionEmitter()
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
  const emitter = getMediaSessionEmitter()
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
  // Android only: current playback state as known by the PiP bridge
  isPlaying?: boolean
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
  const emitter = getMediaSessionEmitter()
  if (!emitter) {
    return { remove: () => {} }
  }
  return (emitter as any).addListener('onPictureInPictureChanged', listener)
}

export function addPictureInPictureActionListener(
  listener: (event: PictureInPictureActionEvent) => void
): Subscription {
  const emitter = getMediaSessionEmitter()
  if (!emitter) {
    return { remove: () => {} }
  }
  return (emitter as any).addListener('onPictureInPictureAction', listener)
}

// Phase 1 PlayerActivity shell helpers. Most callers remain gated off for now,
// but the native bridge is real again so we can incrementally test split-activity
// playback ownership without another API rewrite later.
export interface OpenPlayerActivityPayload { [key: string]: any }
export interface PlaybackSnapshotEvent { [key: string]: any }
export interface PlayerLaunchPayloadEvent { [key: string]: any }
export async function openPlayerActivity(payload?: any): Promise<boolean> {
  const native = getMediaSessionNative() as any
  if (!native.openPlayerActivity) return false
  return native.openPlayerActivity(payload ?? null)
}
export async function consumePendingPlayerLaunchPayload(): Promise<any | null> {
  const native = getMediaSessionNative() as any
  if (!native.consumePendingPlayerLaunchPayload) return null
  return native.consumePendingPlayerLaunchPayload()
}
export async function clearPendingPlayerLaunchPayload(): Promise<void> {
  const native = getMediaSessionNative() as any
  if (!native.clearPendingPlayerLaunchPayload) return
  return native.clearPendingPlayerLaunchPayload()
}
export async function getPlaybackSnapshot(): Promise<null> { return null }
export async function primePlayerActivityPayload(payload?: any): Promise<void> {
  const native = getMediaSessionNative() as any
  if (!native.primePlayerActivityPayload) return
  return native.primePlayerActivityPayload(payload ?? null)
}
export async function launchPrimedPipPlayerActivity(): Promise<boolean> { return false }
export async function isInPlayerActivity(): Promise<boolean> {
  const native = getMediaSessionNative() as any
  if (!native.isInPlayerActivity) return false
  return native.isInPlayerActivity()
}
export function addPlayerLaunchPayloadListener(listener: (event: any) => void): Subscription {
  const emitter = getMediaSessionEmitter()
  if (!emitter) return { remove: () => {} }
  return (emitter as any).addListener('onPlayerLaunchPayload', listener)
}
export function addPlaybackSnapshotListener(_listener: (event: any) => void): Subscription { return { remove: () => {} } }

export default {
  setActive,
  setNowPlaying,
  setPlaybackState,
  setPictureInPicturePlaybackState,
  clearNowPlaying,
  enterPictureInPicture,
  isPictureInPictureSupported,
  setAutoPictureInPicture,
  setPictureInPictureAspectRatio,
  setStatusBarOverlayEnabled,
  startCastForegroundService,
  updateCastForegroundService,
  stopCastForegroundService,
  addRemoteCommandListener,
  addAudioInterruptionListener,
  addAudioRouteChangeListener,
  addPictureInPictureListener,
  addPictureInPictureActionListener,
  openPlayerActivity,
  consumePendingPlayerLaunchPayload,
  clearPendingPlayerLaunchPayload,
  getPlaybackSnapshot,
  primePlayerActivityPayload,
  launchPrimedPipPlayerActivity,
  addPlayerLaunchPayloadListener,
  addPlaybackSnapshotListener,
  isInPlayerActivity,
}
