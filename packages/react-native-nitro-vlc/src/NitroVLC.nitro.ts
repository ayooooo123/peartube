import { HybridView, HybridViewMethods, HybridViewProps } from 'react-native-nitro-modules'

/**
 * Video aspect ratio type.
 */
export type PlayerAspectRatio = '16:9' | '1:1' | '4:3' | '3:2' | '21:9' | '9:16'

/**
 * Video resize mode.
 */
export type PlayerResizeMode = 'fill' | 'contain' | 'cover' | 'none' | 'scale-down'

/**
 * VLC Player source configuration options.
 */
export interface VLCPlayerSource {
  /**
   * Media source URI to render.
   */
  uri: string

  /**
   * VLC Player initialization type.
   *
   * - Default configuration: `1`
   * - Custom configuration: `2`
   *
   * @default 1
   */
  initType?: 1 | 2

  /**
   * VLC Player initialization options.
   *
   * Example: `['--network-caching=50', '--rtsp-tcp']`
   *
   * If `repeat` is set on props this will default to `['--repeat']` unless
   * another `--repeat` or `--input-repeat` flag is passed.
   *
   * @default []
   */
  initOptions?: string[]
}

/**
 * Represents a track type in playback.
 */
export interface Track {
  /**
   * Track identification.
   */
  id: number

  /**
   * Track name.
   */
  name: string
}

/**
 * Represents playback video size.
 */
export interface VideoSize {
  /**
   * Video width.
   */
  width: number

  /**
   * Video height.
   */
  height: number
}

/**
 * Represents full playback information.
 */
export interface VideoInfo {
  /**
   * Total playback duration.
   */
  duration: number

  /**
   * Playback target.
   */
  target: number

  /**
   * Total playback video size.
   */
  videoSize: VideoSize

  /**
   * List of playback audio tracks.
   */
  audioTracks: Track[]

  /**
   * List of playback text tracks.
   */
  textTracks: Track[]
}

export interface OnPlayingEventProps {
  duration: number
  target: number
  seekable: boolean
}

export interface OnProgressEventProps {
  /**
   * Total playback duration.
   */
  duration: number

  /**
   * Playback target.
   */
  target: number

  /**
   * Current playback time.
   */
  currentTime: number

  /**
   * Current playback position.
   */
  position: number

  /**
   * Remaining time to end playback.
   */
  remainingTime: number
}

export interface SimpleCallbackEventProps {
  target: number
}

export interface NitroVLCProps extends HybridViewProps {
  /**
   * Object that contains the uri of a video or song to play.
   */
  source: VLCPlayerSource

  /**
   * Local subtitle file path.
   */
  subtitleUri?: string

  /**
   * Set to `true` or `false` to pause or play the media.
   *
   * @default false
   */
  paused?: boolean

  /**
   * Set to `true` or `false` to loop the media.
   *
   * @default false
   */
  repeat?: boolean

  /**
   * Set the playback rate of the player.
   *
   * @default 1
   */
  rate?: number

  /**
   * Set position to seek between 0 and 1.
   */
  seek?: number

  /**
   * Set the volume of the player.
   */
  volume?: number

  /**
   * Set to `true` or `false` to mute the player.
   *
   * @default false
   */
  muted?: boolean

  /**
   * Set audioTrack id (number) (see onLoad callback VideoInfo.audioTracks).
   */
  audioTrack?: number

  /**
   * Set textTrack(subtitle) id (number) (see onLoad callback VideoInfo.textTracks).
   */
  textTrack?: number

  /**
   * Set to `true` or `false` to allow playing in the background.
   *
   * @default false
   */
  playInBackground?: boolean

  /**
   * Video aspect ratio.
   */
  videoAspectRatio?: PlayerAspectRatio

  /**
   * Set to `true` or `false` to enable auto aspect ratio.
   *
   * @default false
   */
  autoAspectRatio?: boolean

  /**
   * Set the behavior for the video size (fill, contain, cover, none, scale-down).
   */
  resizeMode?: PlayerResizeMode

  /**
   * Enables autoplay.
   *
   * @default true
   */
  autoplay?: boolean

  /**
   * Set to `true` to automatically accept invalid SSL/TLS certificates.
   *
   * @default false
   */
  acceptInvalidCertificates?: boolean

  /**
   * Called when media starts playing.
   *
   * @param event - Event properties.
   */
  onPlaying?: (event: OnPlayingEventProps) => void

  /**
   * Callback containing position as a fraction, and duration, currentTime and remainingTime in seconds.
   *
   * @param event - Event properties.
   */
  onProgress?: (event: OnProgressEventProps) => void

  /**
   * Called when media is paused.
   *
   * @param event - Event properties.
   */
  onPaused?: (event: SimpleCallbackEventProps) => void

  /**
   * Called when media is stopped.
   *
   * @param event - Event properties.
   */
  onStopped?: (event: SimpleCallbackEventProps) => void

  /**
   * Called when media is buffering.
   *
   * @param event - Event properties.
   */
  onBuffering?: (event: SimpleCallbackEventProps) => void

  /**
   * Called when media playing ends.
   *
   * @param event - Event properties.
   */
  onEnded?: (event: SimpleCallbackEventProps) => void

  /**
   * Called when an error occurs whilst attempting to play media.
   *
   * @param event - Event properties.
   */
  onError?: (event: SimpleCallbackEventProps) => void

  /**
   * Called when video info is loaded, Callback containing `VideoInfo`.
   *
   * @param event - Event properties.
   */
  onLoad?: (event: VideoInfo) => void
}

export interface NitroVLCMethods extends HybridViewMethods {
  /**
   * Start or resume playback.
   */
  play(): void

  /**
   * Pause playback.
   */
  pause(): void

  /**
   * Stop playback and reset position.
   */
  stop(): void

  /**
   * Seek to position (0-1 normalized).
   */
  seek(position: number): void

  /**
   * Set volume (0-1).
   */
  setVolume(volume: number): void
}

export type NitroVLCView = HybridView<NitroVLCProps, NitroVLCMethods>
