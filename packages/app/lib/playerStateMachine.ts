import type { VideoData } from '@peartube/core'
import type { PlayerMode } from './video-player'

export type PlayerStateMode =
  | 'hidden'
  | 'loading'
  | 'fullscreen'
  | 'mini'
  | 'pip_entering'
  | 'pip_active'
  | 'pip_exiting'

export type ModeBeforePip = Extract<PlayerMode, 'fullscreen' | 'mini'>

type PlaybackMemory = {
  wasPlayingWhenBackgrounded: boolean
  wasPlayingWhenPipEntered: boolean
  modeBeforePip: ModeBeforePip
}

type HiddenPlayerState = PlaybackMemory & {
  mode: 'hidden'
  video: null
  url: null
}

type ActivePlayerState = PlaybackMemory & {
  mode: Exclude<PlayerStateMode, 'hidden'>
  video: VideoData
  url: string
}

export type PlayerState = HiddenPlayerState | ActivePlayerState

export type TransitionSource =
  | 'restoreLastClosedVideo'
  | 'forceReloadPlayback'
  | 'appStateBackgroundMiniAutoMaximizeForPip'
  | 'appStateForegroundHiddenRestore'
  | 'remoteCommandHiddenRestore'
  | 'androidPipExitRestorePreviousMode'
  | 'loadAndPlayVideo'
  | 'closeVideo'
  | 'minimizePlayer'
  | 'maximizePlayer'

export type PlayerEvent =
  | {
      type: 'LOAD_VIDEO'
      source: 'loadAndPlayVideo'
      video: VideoData
      url: string
    }
  | {
      type: 'RESTORE_FROM_LAST_CLOSED'
      source: 'restoreLastClosedVideo'
      video: VideoData
      url: string
      resumeSeconds?: number
    }
  | {
      type: 'FORCE_RELOAD_PLAYBACK'
      source: 'forceReloadPlayback'
      video: VideoData
      url: string
      resumeSeconds: number
    }
  | {
      type: 'CLOSE_VIDEO'
      source: 'closeVideo'
    }
  | {
      type: 'MINIMIZE'
      source: 'minimizePlayer'
    }
  | {
      type: 'MAXIMIZE'
      source: 'maximizePlayer'
    }
  | {
      type: 'APP_BACKGROUND'
      source: 'appStateBackgroundMiniAutoMaximizeForPip'
      appState: 'background' | 'inactive'
      isPlaying: boolean
    }
  | {
      type: 'APP_FOREGROUND'
      source: 'appStateForegroundHiddenRestore'
      appState: 'active'
      wasInPip: boolean
      suppressRestore: boolean
    }
  | {
      type: 'REMOTE_PLAY'
      source: 'remoteCommandHiddenRestore'
      isBackgrounded: boolean
      platform: 'ios' | 'android'
    }
  | {
      type: 'REMOTE_PAUSE'
      source: 'remoteCommandHiddenRestore'
      platform: 'ios' | 'android'
      duringAndroidPipExitGuardWindow: boolean
    }
  | {
      type: 'REMOTE_TOGGLE_PLAY_PAUSE'
      source: 'remoteCommandHiddenRestore'
      isPlaying: boolean
      isBackgrounded: boolean
      platform: 'ios' | 'android'
    }
  | {
      type: 'PIP_ENTERED_ANDROID'
      source: 'androidPipExitRestorePreviousMode'
      platform: 'android'
      dimensions?: { width: number; height: number }
      isPlaying?: boolean
    }
  | {
      type: 'PIP_EXITED_ANDROID'
      source: 'androidPipExitRestorePreviousMode'
      platform: 'android'
      wasInPip: boolean
      shouldResume?: boolean
      restoreMode: ModeBeforePip
      dimensions?: { width: number; height: number }
    }

type TransitionMap = {
  hidden: {
    LOAD_VIDEO: 'fullscreen'
    RESTORE_FROM_LAST_CLOSED: 'fullscreen'
    CLOSE_VIDEO: 'hidden'
    APP_FOREGROUND: 'fullscreen' | 'hidden'
    REMOTE_PLAY: 'fullscreen' | 'hidden'
  }
  loading: {
    CLOSE_VIDEO: 'hidden'
    MINIMIZE: 'mini'
    MAXIMIZE: 'fullscreen'
    PIP_ENTERED_ANDROID: 'pip_entering'
    PIP_EXITED_ANDROID: 'fullscreen' | 'mini' | 'loading'
  }
  fullscreen: {
    CLOSE_VIDEO: 'hidden'
    MINIMIZE: 'mini'
    MAXIMIZE: 'fullscreen'
    APP_BACKGROUND: 'fullscreen'
    APP_FOREGROUND: 'fullscreen'
    REMOTE_PLAY: 'fullscreen'
    REMOTE_PAUSE: 'fullscreen'
    REMOTE_TOGGLE_PLAY_PAUSE: 'fullscreen'
    PIP_ENTERED_ANDROID: 'pip_entering'
    PIP_EXITED_ANDROID: 'fullscreen' | 'mini'
    FORCE_RELOAD_PLAYBACK: 'fullscreen'
  }
  mini: {
    CLOSE_VIDEO: 'hidden'
    MINIMIZE: 'mini'
    MAXIMIZE: 'fullscreen'
    APP_BACKGROUND: 'fullscreen' | 'mini'
    APP_FOREGROUND: 'mini' | 'fullscreen'
    REMOTE_PLAY: 'mini' | 'fullscreen'
    REMOTE_PAUSE: 'mini'
    REMOTE_TOGGLE_PLAY_PAUSE: 'mini' | 'fullscreen'
    FORCE_RELOAD_PLAYBACK: 'fullscreen'
  }
  pip_entering: {
    PIP_ENTERED_ANDROID: 'pip_active' | 'pip_entering'
    PIP_EXITED_ANDROID: 'pip_exiting'
    CLOSE_VIDEO: 'hidden'
  }
  pip_active: {
    PIP_EXITED_ANDROID: 'pip_exiting'
    CLOSE_VIDEO: 'hidden'
  }
  pip_exiting: {
    PIP_EXITED_ANDROID: 'fullscreen' | 'mini' | 'loading'
    REMOTE_PAUSE: 'pip_exiting'
    CLOSE_VIDEO: 'hidden'
  }
}

export type ValidEventTypeForMode<M extends PlayerStateMode> = Extract<
  keyof TransitionMap[M],
  PlayerEvent['type']
>

export type NextMode<
  M extends PlayerStateMode,
  E extends ValidEventTypeForMode<M>,
> = TransitionMap[M][E]

export type TransitionDecision<
  M extends PlayerStateMode,
  E extends PlayerEvent['type'],
> = E extends ValidEventTypeForMode<M>
  ? {
      kind: 'transition'
      to: NextMode<M, Extract<E, ValidEventTypeForMode<M>>>
      source: TransitionSource
    }
  : {
      kind: 'noop'
      source: TransitionSource
      devLog: '[player-state-machine] invalid transition'
    }
