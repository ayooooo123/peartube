import { getHostComponent, callback } from 'react-native-nitro-modules'
import type { NitroVLCMethods, NitroVLCProps } from './NitroVLC.nitro'

export const name = 'NitroVLC'

export const NitroVLCView = getHostComponent<NitroVLCProps, NitroVLCMethods>(
  'NitroVLCView',
  () => ({
    uiViewClassName: 'NitroVLCView',
    supportsRawText: false,
    bubblingEventTypes: {},
    directEventTypes: {},
    validAttributes: {
      source: true,
      subtitleUri: true,
      paused: true,
      loop: true,
      rate: true,
      seek: true,
      volume: true,
      muted: true,
      audioTrack: true,
      textTrack: true,
      playInBackground: true,
      videoAspectRatio: true,
      autoAspectRatio: true,
      resizeMode: true,
      autoplay: true,
      acceptInvalidCertificates: true,
      onPlaying: true,
      onProgress: true,
      onPaused: true,
      onStopped: true,
      onBuffering: true,
      onEnded: true,
      onError: true,
      onLoad: true,
    },
  })
)

export { callback }

export type {
  NitroVLCMethods,
  NitroVLCProps,
  NitroVLCView as NitroVLCViewSpec,
  OnPlayingEventProps,
  OnProgressEventProps,
  PlayerAspectRatio,
  PlayerResizeMode,
  SimpleCallbackEventProps,
  Track,
  VideoInfo,
  VLCPlayerSource,
  VideoSize,
} from './NitroVLC.nitro'
