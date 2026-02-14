import { UIManager, findNodeHandle, NativeModules, Platform, requireNativeComponent, View } from 'react-native'

export type MpvPlayerSource = {
  uri: string
  headers?: Record<string, string>
  initOptions?: string[]
}

export type MpvPlayerOnProgressEvent = {
  currentTime: number
  duration: number
}

export type MpvPlayerOnLoadEvent = {
  duration: number
  videoSize: {
    width: number
    height: number
  }
}

export type MpvPlayerOnPlayingEvent = {
  duration: number
  seekable: boolean
}

export type MpvPlayerOnSimpleEvent = {
  target: number
}

export type MpvPlayerOnVideoStateEvent = {
  type?: string
  mVideoWidth?: number
  mVideoHeight?: number
}

export type MpvPlayerOnPictureInPictureEvent = {
  isInPictureInPicture: boolean
  width: number
  height: number
}

export type MpvPlayerProps = {
  source: MpvPlayerSource
  paused?: boolean
  rate?: number
  volume?: number
  muted?: boolean
  seek?: number
  resizeMode?: 'contain' | 'cover' | 'stretch'
  autoAspectRatio?: boolean
  pipEnabled?: boolean
  onLoad?: (event: MpvPlayerOnLoadEvent) => void
  onProgress?: (event: MpvPlayerOnProgressEvent) => void
  onPlaying?: (event: MpvPlayerOnPlayingEvent) => void
  onPaused?: (event: MpvPlayerOnSimpleEvent) => void
  onBuffering?: (event: MpvPlayerOnSimpleEvent) => void
  onEnded?: (event: MpvPlayerOnSimpleEvent) => void
  onError?: (event: MpvPlayerOnSimpleEvent) => void
  onVideoStateChange?: (event: MpvPlayerOnVideoStateEvent) => void
  onPictureInPictureChanged?: (event: MpvPlayerOnPictureInPictureEvent) => void
  style?: any
}

const IOS_VIEW_MANAGER_CANDIDATES = ['MpvPlayerView', 'MpvPlayerViewManager'] as const

function resolveViewManagerName() {
  if (Platform.OS !== 'ios') return 'MpvPlayerView'
  for (const candidate of IOS_VIEW_MANAGER_CANDIDATES) {
    const config: any = UIManager.getViewManagerConfig(candidate)
    if (config && (config.NativeProps || config.Commands)) {
      return candidate
    }
  }
  return 'MpvPlayerView'
}

const resolvedViewManagerName = resolveViewManagerName()
const mpvViewConfig: any = UIManager.getViewManagerConfig(resolvedViewManagerName)
const hasMpvNativeView = !!(mpvViewConfig && (mpvViewConfig.NativeProps || mpvViewConfig.Commands))

if (__DEV__ && !hasMpvNativeView) {
  console.error(`[react-native-mpv] Native view manager ${resolvedViewManagerName} is not registered on this build`, mpvViewConfig)
}

export const MpvPlayerView = hasMpvNativeView
  ? requireNativeComponent<MpvPlayerProps>(resolvedViewManagerName)
  : (View as unknown as (props: MpvPlayerProps) => any)

export const isMpvNativeViewAvailable = hasMpvNativeView

export const MpvCommands = {
  play(ref: any) {
    dispatchCommand(ref, 'play', [])
  },
  pause(ref: any) {
    dispatchCommand(ref, 'pause', [])
  },
  stop(ref: any) {
    dispatchCommand(ref, 'stop', [])
  },
  seekToSeconds(ref: any, seconds: number) {
    dispatchCommand(ref, 'seekToSeconds', [seconds])
  },
  startPiP(ref: any) {
    dispatchCommand(ref, 'startPiP', [])
  },
  stopPiP(ref: any) {
    dispatchCommand(ref, 'stopPiP', [])
  },
}

function resolveReactTag(ref: any): number | null {
  if (!ref) return null
  if (typeof ref === 'number') return ref

  const candidate = ref?.current ?? ref
  if (!candidate) return null

  const directTag = candidate?._nativeTag ?? candidate?.__nativeTag ?? candidate?.nativeTag
  if (typeof directTag === 'number') return directTag

  try {
    const resolved = findNodeHandle(candidate)
    return typeof resolved === 'number' ? resolved : null
  } catch {
    return null
  }
}

function dispatchCommand(ref: any, name: string, args: unknown[]) {
  const handle = resolveReactTag(ref)
  if (!handle) return

  if (Platform.OS === 'ios') {
    const manager = NativeModules.MpvPlayerViewManager ?? NativeModules.MpvPlayerView
    if (!manager) return
    switch (name) {
      case 'play':
        manager.play(handle)
        break
      case 'pause':
        manager.pause(handle)
        break
      case 'stop':
        manager.stop(handle)
        break
      case 'seekToSeconds':
        manager.seekToSeconds(handle, args[0])
        break
      case 'startPiP':
        manager.startPiP(handle)
        break
      case 'stopPiP':
        manager.stopPiP(handle)
        break
    }
    return
  }

  const config = UIManager.getViewManagerConfig('MpvPlayerView')
  if (!config?.Commands) return
  const commandId = config.Commands[name]
  if (commandId === undefined) return
  UIManager.dispatchViewManagerCommand(handle, commandId, args)
}
