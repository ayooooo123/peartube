import { CONSUMER_MODERATION_PROFILE_SETTING_KEY } from '../moderation/profile.js'

// Personal-sync API group (playlists / history / settings), extracted from
// api.js. These are registered through the shared HRPC handler table, which
// calls them as `api.method(request)` with `this` unbound — so they take the
// decoded request object and return the response envelope directly, and rely
// only on the injected `ctx`, never on `this`.

export function createPersonalApi({ ctx }) {
  return {
    // ============================================
    // Personal Sync: Playlists / History / Settings
    // (private per-identity multi-writer store, synced across the user's devices)
    //
    // These are registered through the shared HRPC handler table, which calls
    // them as `api.method(request)` with `this` unbound — so they take the
    // decoded request object and return the response envelope directly, and
    // must not rely on `this`.
    // ============================================

    async getPlaylists() {
      if (!ctx.personal) return { playlists: [] };
      return { playlists: await ctx.personal.listPlaylists() };
    },
    async getPlaylistItems(req = {}) {
      if (!ctx.personal) return { items: [] };
      return { items: await ctx.personal.listPlaylistItems(req.playlistId) };
    },
    async createPlaylist(req = {}) {
      if (!ctx.personal?.writable) throw new Error('No writable personal store (create or activate an identity first)');
      const id = await ctx.personal.createPlaylist({ name: req.name || '', description: req.description || '' });
      return { success: true, id };
    },
    async updatePlaylist(req = {}) {
      if (!ctx.personal?.writable) throw new Error('No writable personal store');
      await ctx.personal.updatePlaylist(req.id, { name: req.name, description: req.description });
      return { success: true };
    },
    async deletePlaylist(req = {}) {
      if (!ctx.personal?.writable) throw new Error('No writable personal store');
      await ctx.personal.deletePlaylist(req.id);
      return { success: true };
    },
    async addToPlaylist(req = {}) {
      if (!ctx.personal?.writable) throw new Error('No writable personal store');
      await ctx.personal.addToPlaylist(req.playlistId, { channelKey: req.channelKey, videoId: req.videoId, videoKey: req.videoKey });
      return { success: true };
    },
    async removeFromPlaylist(req = {}) {
      if (!ctx.personal?.writable) throw new Error('No writable personal store');
      await ctx.personal.removeFromPlaylist(req.playlistId, req.videoKey);
      return { success: true };
    },

    async logWatchHistory(req = {}) {
      if (!ctx.personal?.writable) throw new Error('No writable personal store');
      const eventId = await ctx.personal.logHistory(req);
      return { success: true, eventId };
    },
    async getWatchHistory(req = {}) {
      if (!ctx.personal) return { entries: [] };
      return { entries: await ctx.personal.listHistory({ limit: req.limit || 100 }) };
    },
    async getResumePosition(req = {}) {
      if (!ctx.personal) return { found: false };
      const resume = await ctx.personal.getResume(req.videoKey);
      return resume ? { found: true, resume } : { found: false };
    },
    async listResumePositions() {
      if (!ctx.personal) return { entries: [] };
      return { entries: await ctx.personal.listResume() };
    },

    async setPersonalSetting(req = {}) {
      // Values arrive JSON-encoded over HRPC so a setting can hold any JSON type.
      let value = req.value;
      if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch { /* keep raw string */ }
      }
      if (req.key === CONSUMER_MODERATION_PROFILE_SETTING_KEY && ctx.setConsumerModerationProfile) {
        await ctx.setConsumerModerationProfile(value)
        return { success: true };
      }
      if (!ctx.personal?.writable) throw new Error('No writable personal store');
      await ctx.personal.setSetting(req.key, value);
      return { success: true };
    },
    async getPersonalSettings() {
      const settings = ctx.personal ? await ctx.personal.getSettings() : {};
      if (ctx.consumerModerationProfile) {
        settings[CONSUMER_MODERATION_PROFILE_SETTING_KEY] = await ctx.consumerModerationProfile.inspect();
      }
      return { settings: Object.entries(settings).map(([key, value]) => ({ key, value: JSON.stringify(value) })) };
    },

    /**
     * Provision the at-rest encryption secret (from the device's native
     * keychain) for the active identity's personal store, opening it encrypted.
     * The platform generates and persists the secret in the device keychain
     * before passing it here. The backend never generates or returns it.
     */
    async provisionPersonalEncryption(req = {}) {
      if (!ctx.personalManager) return { success: false, error: 'personal store unavailable' };
      const result = await ctx.personalManager.provisionSecret({
        secret: req.secret,
        bootstrapKey: req.bootstrapKey || undefined,
        deviceLocal: req.deviceLocal === true,
      });
      if (result?.success && result.profileReconciled !== true) {
        await ctx.reloadConsumerModerationProfile?.();
      }
      return {
        success: !!result.success,
        bootstrapKey: result.bootstrapKey,
        encrypted: !!result.encrypted,
        error: result.error,
      };
    },
  }
}
