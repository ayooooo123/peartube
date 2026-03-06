export type PlayerViewMode = 'hidden' | 'fullscreen' | 'mini' | 'pip'

export type TransitionOrigin = 'user' | 'system' | 'appState'

export interface PlaybackSnapshot {
  isPlaying: boolean
  positionMs: number
  durationMs: number
  rate: number
}

export interface PlaybackSessionRef {
  sessionId: string
  videoId: string
  sourceUrl: string
}

export interface UnifiedPlayerState {
  viewMode: PlayerViewMode
  playback: PlaybackSnapshot
  session: PlaybackSessionRef | null
  origin: TransitionOrigin
}

export type RestoreTarget = Extract<PlayerViewMode, 'fullscreen' | 'mini'>

export type PlayerNativeEvent =
  | {
      type: 'PLAYER_PIP_ENTERED'
      widthDp: number
      heightDp: number
      isPlaying?: boolean
      origin: 'system' | 'appState'
    }
  | {
      type: 'PLAYER_PIP_EXITED'
      restoreTarget: RestoreTarget
      isPlaying?: boolean
      origin: 'system' | 'appState'
    }
  | {
      type: 'PLAYER_PIP_RESIZED'
      widthDp: number
      heightDp: number
      origin: 'system'
    }
  | {
      type: 'PLAYER_PIP_DISMISSED'
      shouldPause: boolean
      origin: 'system'
    }
  | {
      type: 'PLAYER_RESTORE_REQUESTED'
      source: 'pipTap' | 'notification'
      origin: 'system'
    }
  | {
      type: 'PLAYER_REMOTE_COMMAND'
      command: 'play' | 'pause' | 'seekBy' | 'next' | 'prev'
      value?: number
      origin: 'system'
    }

export type PlayerNativeCommand =
  | { type: 'enterPip' }
  | { type: 'setAutoPipEnabled'; enabled: boolean }
  | { type: 'setPipAspectRatio'; width: number; height: number }
  | {
      type: 'setPipSourceRect'
      rect: { x: number; y: number; width: number; height: number }
    }
  | { type: 'setPlaybackState'; playback: PlaybackSnapshot }
  | { type: 'restorePlayerUI' }

export type PlayerViewModeEvent =
  | { type: 'MINIMIZE'; origin: 'user' }
  | { type: 'MAXIMIZE'; origin: 'user' }
  | { type: 'CLOSE'; origin: TransitionOrigin }
  | { type: 'ENTER_PIP'; origin: 'system' | 'appState' }
  | {
      type: 'EXIT_PIP'
      target: RestoreTarget
      origin: 'system' | 'appState'
    }

export const VIEW_MODE_TRANSITIONS: {
  [From in PlayerViewMode]: Partial<Record<PlayerViewModeEvent['type'], PlayerViewMode[]>>
} = {
  hidden: {
    CLOSE: ['hidden'],
  },
  fullscreen: {
    MINIMIZE: ['mini'],
    MAXIMIZE: ['fullscreen'],
    ENTER_PIP: ['pip'],
    CLOSE: ['hidden'],
  },
  mini: {
    MINIMIZE: ['mini'],
    MAXIMIZE: ['fullscreen'],
    ENTER_PIP: ['pip'],
    CLOSE: ['hidden'],
  },
  pip: {
    EXIT_PIP: ['fullscreen', 'mini'],
    MAXIMIZE: ['fullscreen'],
    CLOSE: ['hidden'],
  },
}

export function canTransition(
  current: PlayerViewMode,
  eventType: PlayerViewModeEvent['type'],
): boolean {
  const allowed = VIEW_MODE_TRANSITIONS[current][eventType]
  return Array.isArray(allowed) && allowed.length > 0
}

export function reducePlayerViewMode(
  current: PlayerViewMode,
  event: PlayerViewModeEvent,
): PlayerViewMode {
  const allowed = VIEW_MODE_TRANSITIONS[current][event.type]
  if (!allowed || allowed.length === 0) return current

  if (event.type === 'EXIT_PIP') {
    return allowed.includes(event.target) ? event.target : current
  }

  return allowed[0]
}
