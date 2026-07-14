import UDX from 'udx-native'

export const UDX_SEND_DISPATCH = Symbol('udx-send-dispatch')
export const UDX_LINK_OPEN = Symbol('udx-link-open')
export const UDX_LINK_CLOSE = Symbol('udx-link-close')

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
