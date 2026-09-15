import test from 'brittle'
import UDX from 'udx-native'

test('UDX exposes the pinned datagram socket surface', async (t) => {
  const socket = new UDX().createSocket()

  for (const name of ['bind', 'send', 'trySend', 'address', 'close']) {
    t.is(typeof socket[name], 'function', `${name} is a function`)
  }

  await socket.close()
})
