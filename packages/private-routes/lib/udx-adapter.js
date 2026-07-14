import UDX from 'udx-native'

export const UDX_SEND_DISPATCH = Symbol('udx-send-dispatch')
export const UDX_LINK_OPEN = Symbol('udx-link-open')
export const UDX_LINK_CLOSE = Symbol('udx-link-close')
export const UDX_SEND_CELL = Symbol('udx-send-cell')
export const UDX_SEND_ACTOR_CONTROL = Symbol('udx-send-actor-control')
export const UDX_LINK_STATS = Symbol('udx-link-stats')
export const UDX_LINK_STREAM_PROGRESS = Symbol('udx-link-stream-progress')

export function selectUdxLoopbackHosts({ platform, forceDistinct = false } = {}) {
  if (platform !== 'linux' && platform !== 'darwin' && platform !== 'win32') {
    throw new TypeError('unsupported loopback platform')
  }
  return platform === 'darwin' && !forceDistinct
    ? ['127.0.0.1', '127.0.0.1']
    : ['127.0.0.1', '127.0.0.2']
}

export class UdxAdapter {
  create() {
    return new UDX()
  }
}
