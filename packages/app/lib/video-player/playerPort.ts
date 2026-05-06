export type PlayerBackendKind = 'native' | 'web-mse' | 'cast' | 'desktop-native' | 'unknown'

export type PlayerPortEventName =
  | 'loaded'
  | 'playing'
  | 'paused'
  | 'buffering'
  | 'progress'
  | 'ended'
  | 'error'
  | 'pip-change'
  | 'cast-change'

export type PlayerPortEventMap = {
  loaded: { duration?: number; durationMs?: number }
  playing: undefined
  paused: undefined
  buffering: { isBuffering: boolean }
  progress: { currentTime: number; duration: number }
  ended: undefined
  error: unknown
  'pip-change': { isInPictureInPicture: boolean; width?: number; height?: number }
  'cast-change': { isCasting: boolean }
}

export type PlayerPortEventHandler<Name extends PlayerPortEventName = PlayerPortEventName> = (
  event: PlayerPortEventMap[Name],
) => void

export type PlayerPortCapabilities = {
  pictureInPicture?: boolean
  cast?: boolean
  playbackRate?: boolean
  backgroundAudio?: boolean
}

export type PlayerPortMetadata = {
  kind: PlayerBackendKind
  capabilities: PlayerPortCapabilities
  label?: string
}

export interface PlayerPort {
  readonly kind: PlayerBackendKind
  readonly capabilities: PlayerPortCapabilities
  play(): void | Promise<void>
  pause(): void | Promise<void>
  stop(): void | Promise<void>
  seek(timeSeconds: number): void | Promise<void>
  setPlaybackRate?(rate: number): void | Promise<void>
  destroy?(): void | Promise<void>
  on?<Name extends PlayerPortEventName>(event: Name, handler: PlayerPortEventHandler<Name>): () => void
  enterPictureInPicture?(): void | Promise<void>
  exitPictureInPicture?(): void | Promise<void>
  startCasting?(): void | Promise<void>
  stopCasting?(): void | Promise<void>
}

export type LegacyPlayerRef = {
  play?: () => void | Promise<void>
  pause?: () => void | Promise<void>
  stop?: () => void | Promise<void>
  destroy?: () => void | Promise<void>
  seek?: (timeSeconds: number) => void | Promise<void>
  resume?: (playing: boolean) => void | Promise<void>
  setPlaybackRate?: (rate: number) => void | Promise<void>
  enterPip?: () => void | Promise<void>
  enterPictureInPicture?: () => void | Promise<void>
  exitPictureInPicture?: () => void | Promise<void>
  startCasting?: () => void | Promise<void>
  stopCasting?: () => void | Promise<void>
}

export function createPlayerPort(
  backend: LegacyPlayerRef,
  metadata: PlayerPortMetadata,
): PlayerPort {
  const port: PlayerPort = {
    kind: metadata.kind,
    capabilities: metadata.capabilities,
    play: () => backend.play?.() ?? backend.resume?.(true),
    pause: () => backend.pause?.() ?? backend.resume?.(false),
    stop: () => {
      if (typeof backend.stop === 'function') return backend.stop()
      backend.pause?.()
      return backend.seek?.(0)
    },
    seek: (timeSeconds: number) => backend.seek?.(Math.max(0, timeSeconds)),
  }

  if (typeof backend.setPlaybackRate === 'function') {
    port.setPlaybackRate = (rate: number) => backend.setPlaybackRate?.(rate)
  }

  if (typeof backend.destroy === 'function') {
    port.destroy = () => backend.destroy?.()
  }

  const enterPip = backend.enterPictureInPicture ?? backend.enterPip
  if (typeof enterPip === 'function') {
    port.enterPictureInPicture = () => enterPip()
  }

  if (typeof backend.exitPictureInPicture === 'function') {
    port.exitPictureInPicture = () => backend.exitPictureInPicture?.()
  }

  if (typeof backend.startCasting === 'function') {
    port.startCasting = () => backend.startCasting?.()
  }

  if (typeof backend.stopCasting === 'function') {
    port.stopCasting = () => backend.stopCasting?.()
  }

  return port
}

export function isPlayerPort(value: unknown): value is PlayerPort {
  const candidate = value as Partial<PlayerPort> | null
  return !!candidate &&
    typeof candidate.play === 'function' &&
    typeof candidate.pause === 'function' &&
    typeof candidate.stop === 'function' &&
    typeof candidate.seek === 'function'
}

export function resolvePlayerPort(value: unknown): PlayerPort | null {
  return isPlayerPort(value) ? value : null
}

export function createWebMsePlayerPort(video: HTMLVideoElement): PlayerPort {
  return createPlayerPort(
    {
      play: () => video.play(),
      pause: () => video.pause(),
      stop: () => {
        video.pause()
        video.currentTime = 0
      },
      seek: (timeSeconds: number) => { video.currentTime = Math.max(0, timeSeconds) },
      setPlaybackRate: (rate: number) => { video.playbackRate = rate },
    },
    {
      kind: 'web-mse',
      capabilities: {
        pictureInPicture: typeof document !== 'undefined' && 'pictureInPictureEnabled' in document,
        playbackRate: true,
      },
    },
  )
}
