// Seeding API group, extracted from api.js.

export function createSeedingApi({ ctx, seedingManager, loadChannel, isSeedingAuthorizationError }) {
  return {
    /**
     * Get seeding status
     * @returns {Promise<Object>}
     */
    async getSeedingStatus() {
      if (seedingManager) {
        return seedingManager.getStatus()
      }
      return { error: 'Seeding manager not initialized' }
    },

    /**
     * Set seeding config
     * @param {Object} config
     * @returns {Promise<Object>}
     */
    async setSeedingConfig(config) {
      if (seedingManager) {
        await seedingManager.setConfig(config)
        return { success: true, config: seedingManager.config }
      }
      return { success: false, error: 'Seeding manager not initialized' }
    },

    /**
     * Pin a channel
     * @param {string} driveKey
     * @returns {Promise<Object>}
     */
    async pinChannel(driveKey) {
      console.log('[API] PIN_CHANNEL:', driveKey?.slice(0, 16))
      if (seedingManager && driveKey) {
        try {
          await seedingManager.pinChannel(driveKey)
        } catch (err) {
          if (isSeedingAuthorizationError(err)) return { success: false, error: err.message }
          throw err
        }
        await loadChannel(ctx, driveKey)
        return { success: true }
      }
      return { success: false, error: 'Invalid request' }
    },

    /**
     * Unpin a channel
     * @param {string} driveKey
     * @returns {Promise<Object>}
     */
    async unpinChannel(driveKey) {
      console.log('[API] UNPIN_CHANNEL:', driveKey?.slice(0, 16))
      if (seedingManager && driveKey) {
        try {
          await seedingManager.unpinChannel(driveKey)
        } catch (err) {
          if (isSeedingAuthorizationError(err)) return { success: false, error: err.message }
          throw err
        }
        return { success: true }
      }
      return { success: false, error: 'Invalid request' }
    },

    /**
     * Get pinned channels
     * @returns {{channels: string[]}}
     */
    getPinnedChannels() {
      if (seedingManager) {
        return { channels: seedingManager.getPinnedChannels() }
      }
      return { channels: [] }
    },
  }
}
