import test from 'brittle'

import { createApi } from '../src/api.js'

test('composed backend API exposes channel pairing and device methods', async (t) => {
  const devices = [{ keyHex: 'a'.repeat(64), role: 'owner', deviceName: 'Phone' }]
  const api = createApi({
    ctx: {},
    loadChannel: async (_ctx, channelKey) => {
      t.is(channelKey, 'channel-key')
      return {
        async listWriters() {
          return devices
        },
      }
    },
  })

  t.is(typeof api.createDeviceInvite, 'function')
  t.is(typeof api.pairDevice, 'function')
  t.is(typeof api.retrySyncChannel, 'function')
  t.alike(await api.listDevices('channel-key'), { devices })
})
