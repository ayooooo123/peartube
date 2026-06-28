// Multi-device pairing API group, extracted from api.js.

export function createPairingApi({ ctx, loadChannel, pairChannelDevice }) {
  return {
    /**
     * Create a device invite code for a multi-writer channel.
     * @param {string} channelKey
     * @returns {Promise<{inviteCode: string}>}
     */
    async createDeviceInvite(channelKey) {
      const channel = await loadChannel(ctx, channelKey)
      const inviteCode = await channel.createInvite({})
      return { inviteCode }
    },

    /**
     * Pair this device to an existing channel using an invite code.
     * @param {string} inviteCode
     * @param {string} [deviceName]
     * @returns {Promise<{success: boolean, channelKey: string, syncState?: string, videoCount?: number}>}
     */
    async pairDevice(inviteCode, deviceName = '') {
      const { channel, channelKeyHex } = await pairChannelDevice(ctx, inviteCode, { deviceName })

      // Use smart sync - waits for peer connection first, then polls for data
      console.log('[API] pairDevice: starting smart sync...')
      const syncResult = await channel.waitForInitialSync({
        peerTimeout: 30000,  // 30s for DHT discovery
        dataTimeout: 20000,  // 20s for data sync after connected
        onProgress: (state, detail) => {
          console.log('[API] pairDevice sync progress:', state, detail)
        }
      })

      console.log('[API] pairDevice: sync result:', syncResult)

      return {
        success: true,
        channelKey: channelKeyHex,
        syncState: syncResult.state,
        videoCount: syncResult.videoCount
      }
    },

    /**
     * Retry syncing a channel that may have failed initial sync.
     * @param {string} channelKey
     * @returns {Promise<{success: boolean, state: string, videoCount: number}>}
     */
    async retrySyncChannel(channelKey) {
      const channel = await loadChannel(ctx, channelKey)

      console.log('[API] retrySyncChannel: starting sync for', channelKey?.slice(0, 16))
      const result = await channel.waitForInitialSync({
        peerTimeout: 30000,
        dataTimeout: 20000,
        onProgress: (state, detail) => {
          console.log('[API] retrySyncChannel progress:', state, detail)
        }
      })

      return {
        success: result.success,
        state: result.state,
        videoCount: result.videoCount
      }
    },

    /**
     * List known devices/writers for a channel.
     * @param {string} channelKey
     * @returns {Promise<{devices: Array<{keyHex: string, role?: string, deviceName?: string, addedAt?: number, blobDriveKey?: string|null}>}>}
     */
    async listDevices(channelKey) {
      const channel = await loadChannel(ctx, channelKey)
      const devices = await channel.listWriters()
      return { devices }
    },
  }
}
