import UDX from 'udx-native'

export const UDX_SEND_DISPATCH = Symbol('udx-send-dispatch')
export const UDX_LINK_OPEN = Symbol('udx-link-open')
export const UDX_LINK_CLOSE = Symbol('udx-link-close')

export class UdxAdapter {
  create() {
    return new UDX()
  }
}
