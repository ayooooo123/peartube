import type { VideoData } from '@peartube/core'
import { useReducer } from 'react'
import {
  canTransition,
  reducePlayerViewMode,
} from './video-player'
import type {
  PlayerMode,
  PlayerViewMode,
  PlayerViewModeEvent,
} from './video-player'

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
      platform: 'ios' | 'android' | 'web'
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
    MINIMIZE: 'mini' | 'pip_entering'
    MAXIMIZE: 'fullscreen'
    PIP_ENTERED_ANDROID: 'pip_entering'
    PIP_EXITED_ANDROID: 'fullscreen' | 'mini' | 'loading'
  }
  fullscreen: {
    LOAD_VIDEO: 'fullscreen'
    CLOSE_VIDEO: 'hidden'
    MINIMIZE: 'mini' | 'pip_entering'
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
    LOAD_VIDEO: 'fullscreen'
    CLOSE_VIDEO: 'hidden'
    MINIMIZE: 'mini' | 'pip_entering'
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
    PIP_EXITED_ANDROID: 'fullscreen' | 'mini' | 'loading'
    CLOSE_VIDEO: 'hidden'
  }
  pip_active: {
    PIP_EXITED_ANDROID: 'fullscreen' | 'mini' | 'loading'
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

const DEV_INVALID_TRANSITION = '[player-state-machine] Invalid transition:'
const DEV_CONTRACT_MISMATCH = '[player-state-machine] Contract mismatch:'
const ENABLE_ANDROID_SPLIT_PLAYER_ACTIVITY = false

function toUnifiedViewMode(mode: PlayerStateMode): PlayerViewMode {
  switch (mode) {
    case 'hidden':
      return 'hidden'
    case 'loading':
    case 'fullscreen':
      return 'fullscreen'
    case 'mini':
      return 'mini'
    case 'pip_entering':
    case 'pip_active':
    case 'pip_exiting':
      return 'pip'
  }
}

function toUnifiedEvent(event: PlayerEvent): PlayerViewModeEvent | null {
  switch (event.type) {
    case 'MINIMIZE':
      return { type: 'MINIMIZE', origin: 'user' }
    case 'MAXIMIZE':
      return { type: 'MAXIMIZE', origin: 'user' }
    case 'CLOSE_VIDEO':
      return {
        type: 'CLOSE',
        origin: event.source === 'closeVideo' ? 'user' : 'appState',
      }
    case 'PIP_ENTERED_ANDROID':
      return { type: 'ENTER_PIP', origin: 'system' }
    case 'PIP_EXITED_ANDROID':
      return {
        type: 'EXIT_PIP',
        target: event.restoreMode,
        origin: 'system',
      }
    default:
      return null
  }
}

function assertContractCompatibility(
  previous: PlayerState,
  event: PlayerEvent,
  next: PlayerState,
): void {
  if (!__DEV__) return

  const unifiedEvent = toUnifiedEvent(event)
  if (!unifiedEvent) return

  const currentUnified = toUnifiedViewMode(previous.mode)
  if (!canTransition(currentUnified, unifiedEvent.type)) return

  const contractNext = reducePlayerViewMode(currentUnified, unifiedEvent)
  const actualNext = toUnifiedViewMode(next.mode)
  if (contractNext !== actualNext) {
    console.log(
      DEV_CONTRACT_MISMATCH,
      `${previous.mode} + ${event.type} -> ${next.mode} (contract expected ${contractNext})`,
      `(${event.source})`,
    )
  }
}

function invalidTransition(state: PlayerState, event: PlayerEvent): PlayerState {
  if (__DEV__) {
    console.log(DEV_INVALID_TRANSITION, `${state.mode} + ${event.type}`, `(${event.source})`)
  }
  return state
}

function toFullscreenState(
  state: PlayerState,
  video: VideoData,
  url: string,
  resetMemory: boolean,
): PlayerState {
  return {
    mode: 'fullscreen',
    video,
    url,
    wasPlayingWhenBackgrounded: resetMemory ? false : state.wasPlayingWhenBackgrounded,
    wasPlayingWhenPipEntered: resetMemory ? false : state.wasPlayingWhenPipEntered,
    modeBeforePip: resetMemory ? 'fullscreen' : state.modeBeforePip,
  }
}

function toHiddenState(state: PlayerState): PlayerState {
  return {
    mode: 'hidden',
    video: null,
    url: null,
    wasPlayingWhenBackgrounded: state.wasPlayingWhenBackgrounded,
    wasPlayingWhenPipEntered: state.wasPlayingWhenPipEntered,
    modeBeforePip: state.modeBeforePip,
  }
}

function withMode(state: ActivePlayerState, mode: ActivePlayerState['mode']): PlayerState {
  return {
    ...state,
    mode,
  }
}

function playerReducerInternal(state: PlayerState, event: PlayerEvent): PlayerState {
  switch (state.mode) {
    case 'hidden': {
      switch (event.type) {
        case 'LOAD_VIDEO':
          return toFullscreenState(state, event.video, event.url, true)
        case 'RESTORE_FROM_LAST_CLOSED':
          return toFullscreenState(state, event.video, event.url, false)
        case 'FORCE_RELOAD_PLAYBACK':
        case 'MINIMIZE':
        case 'MAXIMIZE':
        case 'APP_BACKGROUND':
        case 'REMOTE_PAUSE':
        case 'REMOTE_TOGGLE_PLAY_PAUSE':
        case 'PIP_ENTERED_ANDROID':
        case 'PIP_EXITED_ANDROID':
          return invalidTransition(state, event)
        case 'APP_FOREGROUND':
          if (event.suppressRestore || !event.wasInPip) {
            return {
              ...state,
              mode: 'hidden',
            }
          }
          return {
            ...state,
            mode: 'hidden',
          }
        case 'REMOTE_PLAY':
          if (event.isBackgrounded) {
            return {
              ...state,
              mode: 'hidden',
            }
          }
          return {
            ...state,
            mode: 'hidden',
          }
        case 'CLOSE_VIDEO':
          return {
            ...state,
            mode: 'hidden',
          }
      }
      break
    }
    case 'loading': {
      switch (event.type) {
        case 'LOAD_VIDEO':
        case 'RESTORE_FROM_LAST_CLOSED':
        case 'APP_BACKGROUND':
        case 'APP_FOREGROUND':
        case 'REMOTE_PLAY':
        case 'REMOTE_PAUSE':
        case 'REMOTE_TOGGLE_PLAY_PAUSE':
          return invalidTransition(state, event)
        case 'FORCE_RELOAD_PLAYBACK':
          return invalidTransition(state, event)
        case 'MINIMIZE':
          if (event.platform === 'android' && ENABLE_ANDROID_SPLIT_PLAYER_ACTIVITY) {
            return {
              ...state,
              mode: 'pip_entering',
              modeBeforePip: 'fullscreen',
            }
          }
          return withMode(state, 'mini')
        case 'MAXIMIZE':
          return withMode(state, 'fullscreen')
        case 'PIP_ENTERED_ANDROID':
          return {
            ...state,
            mode: 'pip_entering',
            wasPlayingWhenPipEntered: Boolean(
              event.isPlaying ?? state.wasPlayingWhenBackgrounded ?? false,
            ),
          }
        case 'PIP_EXITED_ANDROID':
          if (!event.wasInPip) {
            return {
              ...state,
              mode: 'loading',
            }
          }
          return {
            ...state,
            mode: event.restoreMode,
          }
        case 'CLOSE_VIDEO':
          return toHiddenState(state)
      }
      break
    }
    case 'fullscreen': {
      switch (event.type) {
        case 'LOAD_VIDEO':
          // Allow loading a new video while in fullscreen (e.g., tapping related video)
          return toFullscreenState(state, event.video, event.url, true)
        case 'RESTORE_FROM_LAST_CLOSED':
          return invalidTransition(state, event)
        case 'CLOSE_VIDEO':
          return toHiddenState(state)
        case 'MINIMIZE':
          if (event.platform === 'android' && ENABLE_ANDROID_SPLIT_PLAYER_ACTIVITY) {
            return {
              ...state,
              mode: 'pip_entering',
              modeBeforePip: 'fullscreen',
            }
          }
          return withMode(state, 'mini')
        case 'MAXIMIZE':
          return withMode(state, 'fullscreen')
        case 'APP_BACKGROUND':
          return {
            ...state,
            mode: 'fullscreen',
            wasPlayingWhenBackgrounded: event.isPlaying,
          }
        case 'APP_FOREGROUND':
          return withMode(state, 'fullscreen')
        case 'REMOTE_PLAY':
        case 'REMOTE_PAUSE':
        case 'REMOTE_TOGGLE_PLAY_PAUSE':
          return withMode(state, 'fullscreen')
        case 'PIP_ENTERED_ANDROID':
          return {
            ...state,
            mode: 'pip_entering',
            wasPlayingWhenPipEntered: Boolean(
              event.isPlaying ?? state.wasPlayingWhenBackgrounded,
            ),
            modeBeforePip: 'fullscreen',
          }
        case 'PIP_EXITED_ANDROID':
          return {
            ...state,
            mode: event.restoreMode,
          }
        case 'FORCE_RELOAD_PLAYBACK':
          return toFullscreenState(state, event.video, event.url, false)
      }
      break
    }
    case 'mini': {
      switch (event.type) {
        case 'LOAD_VIDEO':
          // Allow loading a new video from mini mode — transitions to fullscreen.
          // This happens when user taps a new video while mini player is active.
          return toFullscreenState(state, event.video, event.url, true)
        case 'RESTORE_FROM_LAST_CLOSED':
          return invalidTransition(state, event)
        case 'PIP_ENTERED_ANDROID':
          return {
            ...state,
            mode: 'pip_entering',
            wasPlayingWhenPipEntered: Boolean(
              event.isPlaying ?? state.wasPlayingWhenBackgrounded,
            ),
            modeBeforePip: 'mini',
          }
        case 'CLOSE_VIDEO':
          return toHiddenState(state)
        case 'MINIMIZE':
          if (event.platform === 'android' && ENABLE_ANDROID_SPLIT_PLAYER_ACTIVITY) {
            return {
              ...state,
              mode: 'pip_entering',
              modeBeforePip: 'mini',
            }
          }
          return withMode(state, 'mini')
        case 'MAXIMIZE':
          return withMode(state, 'fullscreen')
        case 'APP_BACKGROUND':
          if (ENABLE_ANDROID_SPLIT_PLAYER_ACTIVITY) {
            // KEEP: split-activity PiP handoff still needs a fullscreen-sized surface on Android.
            return {
              ...state,
              mode: 'fullscreen',
              wasPlayingWhenBackgrounded: event.isPlaying,
            }
          }
          // SIMPLIFIED: keep mini mode stable on background in the state machine.
          // Any Android-specific PiP handoff behavior should be handled explicitly
          // in VideoPlayerContext/native PiP code, not by silently coercing mini ->
          // fullscreen here.
          return {
            ...state,
            mode: 'mini',
            wasPlayingWhenBackgrounded: event.isPlaying,
          }
        case 'APP_FOREGROUND':
          if (ENABLE_ANDROID_SPLIT_PLAYER_ACTIVITY) {
            // KEEP: split-activity mode has no in-app mini surface to restore to.
            return withMode(state, 'fullscreen')
          }
          return {
            ...state,
            mode: event.wasInPip ? 'fullscreen' : 'mini',
          }
        case 'REMOTE_PLAY':
          return {
            ...state,
            mode: event.isBackgrounded && event.platform === 'android' ? 'fullscreen' : 'mini',
          }
        case 'REMOTE_PAUSE':
          return withMode(state, 'mini')
        case 'REMOTE_TOGGLE_PLAY_PAUSE':
          return {
            ...state,
            mode:
              !event.isPlaying && event.isBackgrounded && event.platform === 'android'
                ? 'fullscreen'
                : 'mini',
          }
        case 'PIP_EXITED_ANDROID':
          // Split-player PiP: PlayerActivity managed PiP outside the React
          // state machine, so there's no pip_exiting intermediate state.
          // Transition directly back to the restore mode.
          if (!event.wasInPip) {
            return {
              ...state,
              mode: 'loading',
              wasPlayingWhenPipEntered: false,
            }
          }
          return {
            ...state,
            mode: event.restoreMode,
            wasPlayingWhenPipEntered: false,
          }
        case 'FORCE_RELOAD_PLAYBACK':
          return toFullscreenState(state, event.video, event.url, false)
      }
      break
    }
    case 'pip_entering': {
      switch (event.type) {
        case 'LOAD_VIDEO':
        case 'RESTORE_FROM_LAST_CLOSED':
        case 'FORCE_RELOAD_PLAYBACK':
        case 'MINIMIZE':
        case 'MAXIMIZE':
        case 'APP_BACKGROUND':
        case 'APP_FOREGROUND':
        case 'REMOTE_PLAY':
        case 'REMOTE_PAUSE':
        case 'REMOTE_TOGGLE_PLAY_PAUSE':
          return invalidTransition(state, event)
        case 'PIP_ENTERED_ANDROID':
          return {
            ...state,
            mode: 'pip_active',
            wasPlayingWhenPipEntered: Boolean(
              event.isPlaying ?? state.wasPlayingWhenPipEntered,
            ),
          }
        case 'PIP_EXITED_ANDROID':
          if (!event.wasInPip) {
            return {
              ...state,
              mode: 'loading',
              wasPlayingWhenPipEntered: false,
            }
          }
          return {
            ...state,
            mode: event.restoreMode,
            wasPlayingWhenPipEntered: false,
          }
        case 'CLOSE_VIDEO':
          return toHiddenState(state)
      }
      break
    }
    case 'pip_active': {
      switch (event.type) {
        case 'LOAD_VIDEO':
        case 'RESTORE_FROM_LAST_CLOSED':
        case 'FORCE_RELOAD_PLAYBACK':
        case 'MINIMIZE':
        case 'MAXIMIZE':
        case 'APP_BACKGROUND':
        case 'APP_FOREGROUND':
        case 'REMOTE_PLAY':
        case 'REMOTE_PAUSE':
        case 'REMOTE_TOGGLE_PLAY_PAUSE':
        case 'PIP_ENTERED_ANDROID':
          return invalidTransition(state, event)
        case 'PIP_EXITED_ANDROID':
          if (!event.wasInPip) {
            return {
              ...state,
              mode: 'loading',
              wasPlayingWhenPipEntered: false,
            }
          }
          return {
            ...state,
            mode: event.restoreMode,
            wasPlayingWhenPipEntered: false,
          }
        case 'CLOSE_VIDEO':
          return toHiddenState(state)
      }
      break
    }
    case 'pip_exiting': {
      switch (event.type) {
        case 'LOAD_VIDEO':
        case 'RESTORE_FROM_LAST_CLOSED':
        case 'FORCE_RELOAD_PLAYBACK':
        case 'MINIMIZE':
        case 'MAXIMIZE':
        case 'APP_BACKGROUND':
        case 'APP_FOREGROUND':
        case 'REMOTE_PLAY':
        case 'REMOTE_TOGGLE_PLAY_PAUSE':
        case 'PIP_ENTERED_ANDROID':
          return invalidTransition(state, event)
        case 'PIP_EXITED_ANDROID':
          if (!event.wasInPip) {
            return {
              ...state,
              mode: 'loading',
              wasPlayingWhenPipEntered: false,
            }
          }
          return {
            ...state,
            mode: event.restoreMode,
            wasPlayingWhenPipEntered: false,
          }
        case 'REMOTE_PAUSE':
          if (event.duringAndroidPipExitGuardWindow) {
            return withMode(state, 'pip_exiting')
          }
          return withMode(state, 'pip_exiting')
        case 'CLOSE_VIDEO':
          return toHiddenState(state)
      }
      break
    }
  }

  return invalidTransition(state, event)
}

export function playerReducer(state: PlayerState, event: PlayerEvent): PlayerState {
  const next = playerReducerInternal(state, event)
  assertContractCompatibility(state, event, next)
  return next
}

export function usePlayerStateMachine(initialState: PlayerState) {
  const [state, dispatch] = useReducer(playerReducer, initialState)
  return { state, dispatch }
}
