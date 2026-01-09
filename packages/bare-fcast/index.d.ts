/**
 * bare-fcast - Type declarations
 * FCast and Chromecast sender SDK for Bare/Pear runtime
 */

declare module 'bare-fcast' {
  import { EventEmitter } from 'bare-events'

  export const ProtocolType: {
    readonly FCAST: 'fcast'
    readonly CHROMECAST: 'chromecast'
  }

  export const ConnectionState: {
    readonly DISCONNECTED: 'disconnected'
    readonly CONNECTING: 'connecting'
    readonly CONNECTED: 'connected'
    readonly ERROR: 'error'
  }

  export const PlaybackState: {
    readonly IDLE: 'idle'
    readonly PLAYING: 'playing'
    readonly PAUSED: 'paused'
    readonly BUFFERING: 'buffering'
    readonly STOPPED: 'stopped'
  }

  export interface CastDevice {
    id: string
    name: string
    host: string
    port: number
    protocol: 'fcast' | 'chromecast'
    manual?: boolean
  }

  export interface PlayOptions {
    url: string
    contentType: string
    title?: string
    thumbnail?: string
    time?: number
    volume?: number
    duration?: number
    streamType?: 'BUFFERED' | 'LIVE'
  }

  export interface DeviceState {
    state: string
    currentTime: number
    duration: number
    volume: number
  }

  export class FCastDevice extends EventEmitter {
    constructor(device: CastDevice)
    connect(): Promise<void>
    disconnect(): Promise<void>
    play(options: PlayOptions): Promise<void>
    pause(): Promise<void>
    resume(): Promise<void>
    stop(): Promise<void>
    seek(time: number): Promise<void>
    setVolume(volume: number): Promise<void>
    getState(): DeviceState
    isConnected(): boolean
  }

  export class ChromecastDevice extends EventEmitter {
    constructor(device: CastDevice)
    connect(): Promise<void>
    disconnect(): Promise<void>
    play(options: PlayOptions): Promise<void>
    pause(): Promise<void>
    resume(): Promise<void>
    stop(): Promise<void>
    seek(time: number): Promise<void>
    setVolume(volume: number): Promise<void>
    getState(): DeviceState
    isConnected(): boolean
  }

  export class DeviceDiscoverer extends EventEmitter {
    constructor()
    start(): void
    stop(): void
    isRunning(): boolean
    addManualDevice(options: {
      name: string
      host: string
      port?: number
      protocol?: string
    }): CastDevice
    removeManualDevice(deviceId: string): void
    getDevices(): CastDevice[]
    clearDevices(): void
  }

  export class CastContext extends EventEmitter {
    constructor()
    readonly available: boolean
    readonly connectionState: string
    readonly currentDevice: CastDevice | null
    readonly discoverer: DeviceDiscoverer
    startDiscovery(): void
    stopDiscovery(): void
    getDevices(): CastDevice[]
    addManualDevice(options: {
      name: string
      host: string
      port?: number
      protocol?: string
    }): CastDevice
    connect(deviceId: string): Promise<void>
    disconnect(): Promise<void>
    isConnected(): boolean
    play(options: PlayOptions): Promise<void>
    pause(): Promise<void>
    resume(): Promise<void>
    stop(): Promise<void>
    seek(time: number): Promise<void>
    setVolume(volume: number): Promise<void>
    getState(): DeviceState
  }

  export default CastContext
}
