import { CONSUMER_MODERATION_PROFILE_SETTING_KEY } from '../moderation/profile.js'

// Personal-sync API group (playlists / history / settings), extracted from
// api.js. These are registered through the shared HRPC handler table, which
// calls them as `api.method(request)` with `this` unbound — so they take the
// decoded request object and return the response envelope directly, and rely
// only on the injected `ctx`, never on `this`.

function toUint(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0
}

function toText(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * Project a log-watch-history request onto the canonical progress write. Media
 * identity, the library flag, and the playback generation come from the client;
 * the store owns Lamport stamping and deterministic merge.
 */
function watchEventFromRequest(req = {}) {
  const identity = req.identity && typeof req.identity === 'object'
    ? {
        entityRef: toText(req.identity.entityRef),
        editionRef: toText(req.identity.editionRef),
        memberRef: toText(req.identity.memberRef),
      }
    : null
  const event = {
    channelKey: toText(req.channelKey),
    videoId: toText(req.videoId),
    videoKey: toText(req.videoKey),
    title: toText(req.title),
    duration: toUint(req.duration),
    position: toUint(req.position),
    completed: req.completed === true,
    timestamp: toUint(req.timestamp),
  }
  if (identity && (identity.entityRef || identity.editionRef || identity.memberRef)) event.identity = identity
  if (typeof req.saved === 'boolean') event.saved = req.saved
  const playbackGeneration = toUint(req.playbackGeneration)
  if (playbackGeneration > 0) event.playbackGeneration = playbackGeneration
  if (req.tombstone === true) event.tombstone = true
  return event
}

/**
 * A revocation rotates the personal store into a fresh encrypted epoch and
 * freezes the epoch it is abandoning, so a write issued mid-rotation would be
 * dropped along with that epoch. Report it as a structured refusal instead: the
 * client keeps the write pending and replays it against the new epoch.
 */
async function personalWrite(run) {
  try {
    return await run()
  } catch (error) {
    if (error?.code !== 'PERSONAL_STORE_FROZEN') throw error
    return { success: false, error: 'personal-store-rotating' }
  }
}

export function createPersonalApi({ ctx }) {
  /**
   * Personal pairing never throws a raw internal out to the client: a missing
   * manager and an unexpected failure both come back as a structured
   * `{ success: false, error }`.
   */
  async function personalPairingCall(fallbackError, run) {
    const manager = ctx.personalManager
    if (!manager) return { success: false, error: 'personal-store-unavailable' }
    try {
      return await run(manager)
    } catch {
      return { success: false, error: fallbackError }
    }
  }

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
      return personalWrite(async () => {
        const id = await ctx.personal.createPlaylist({ name: req.name || '', description: req.description || '' });
        return { success: true, id };
      });
    },
    async updatePlaylist(req = {}) {
      if (!ctx.personal?.writable) throw new Error('No writable personal store');
      return personalWrite(async () => {
        await ctx.personal.updatePlaylist(req.id, { name: req.name, description: req.description });
        return { success: true };
      });
    },
    async deletePlaylist(req = {}) {
      if (!ctx.personal?.writable) throw new Error('No writable personal store');
      return personalWrite(async () => {
        await ctx.personal.deletePlaylist(req.id);
        return { success: true };
      });
    },
    async addToPlaylist(req = {}) {
      if (!ctx.personal?.writable) throw new Error('No writable personal store');
      return personalWrite(async () => {
        await ctx.personal.addToPlaylist(req.playlistId, { channelKey: req.channelKey, videoId: req.videoId, videoKey: req.videoKey });
        return { success: true };
      });
    },
    async removeFromPlaylist(req = {}) {
      if (!ctx.personal?.writable) throw new Error('No writable personal store');
      return personalWrite(async () => {
        await ctx.personal.removeFromPlaylist(req.playlistId, req.videoKey);
        return { success: true };
      });
    },

    /**
     * Watch progress is best-effort device state, not an action the viewer
     * took. A device with no writable personal store — no identity, no
     * keychain secret — has nowhere to put it, and raising that as a backend
     * fault puts an error the viewer cannot act on in front of them once per
     * playback tick. Refuse structurally instead. Every explicit personal
     * action above still throws, so creating a playlist still fails loudly.
     */
    async logWatchHistory(req = {}) {
      if (!ctx.personal?.writable) return { success: false, error: 'personal-store-unwritable' };
      return personalWrite(async () => {
        const eventId = await ctx.personal.logHistory(watchEventFromRequest(req));
        return { success: true, eventId };
      });
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
        return personalWrite(async () => {
          await ctx.setConsumerModerationProfile(value);
          return { success: true };
        });
      }
      if (!ctx.personal?.writable) throw new Error('No writable personal store');
      return personalWrite(async () => {
        await ctx.personal.setSetting(req.key, value);
        return { success: true };
      });
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

    // ============================================
    // Personal-store device pairing
    //
    // Deliberately separate from publisher-channel pairing
    // (createDeviceInvite/pairDevice/listDevices): this moves only the viewer's
    // own encrypted state — the personal-store bootstrap key, one writer
    // authorization, and the keychain secret — to a device the user explicitly
    // paired. No channel, drive key, or publisher authority is involved.
    // ============================================

    async createPersonalDeviceInvite(req = {}) {
      return personalPairingCall('personal-invite-failed', async (manager) => {
        const result = await manager.createPersonalDeviceInvite({ expiresInMs: req.expiresInMs });
        if (!result?.success) return { success: false, error: result?.error || 'personal-invite-failed' };
        return { success: true, inviteCode: result.inviteCode, expiresAt: result.expiresAt };
      });
    },

    /**
     * The only backend response that carries the personal-store secret, and
     * only to the joining device that just completed pairing. The platform
     * persists it in its keychain; the backend never stores or logs it.
     */
    async redeemPersonalDeviceInvite(req = {}) {
      return personalPairingCall('personal-pairing-failed', async (manager) => {
        const result = await manager.redeemPersonalDeviceInvite({
          inviteCode: req.inviteCode,
          deviceName: req.deviceName || '',
        });
        if (!result?.success) return { success: false, error: result?.error || 'personal-pairing-failed' };
        return { success: true, secret: result.secret, bootstrapKey: result.bootstrapKey };
      });
    },

    async listPersonalDevices() {
      return personalPairingCall('personal-device-list-failed', async (manager) => {
        const result = await manager.listPersonalDevices();
        if (!result?.success) return { success: false, error: result?.error || 'personal-device-list-failed' };
        return { success: true, devices: result.devices || [] };
      });
    },

    async revokePersonalDevice(req = {}) {
      return personalPairingCall('personal-revoke-failed', async (manager) => {
        const result = await manager.revokePersonalDevice({
          keyHex: req.keyHex,
          secret: req.secret,
          deviceName: req.deviceName || '',
        });
        if (!result?.success) return { success: false, error: result?.error || 'personal-revoke-failed' };
        return {
          success: true,
          bootstrapKey: result.bootstrapKey,
          remainingDeviceCount: result.remainingDeviceCount,
        };
      });
    },
  }
}
