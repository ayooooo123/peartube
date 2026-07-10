// Subscription API group, extracted from api.js.

export function createSubscriptionsApi({ ctx, loadChannel }) {
  return {
    /**
     * Subscribe to a channel
     * @param {string} driveKey
     * @returns {Promise<{success: boolean}>}
     */
    async subscribeChannel(driveKey) {
      // Don't let loadChannel hang forever - use a 5s timeout
      // If it times out, we still add to subscriptions (data will sync later when peers are found)
      try {
        await Promise.race([
          loadChannel(ctx, driveKey),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Channel load timeout')), 5000))
        ])
      } catch (err) {
        console.log('[API] subscribeChannel: channel load warning:', err.message, '- continuing anyway')
      }

      // Prefer the synced personal store when available so subscriptions
      // follow the user across devices; fall back to device-local metaDb.
      if (ctx.personal?.writable) {
        await ctx.personal.subscribe(driveKey, {})
        return { success: true }
      }

      const existing = await ctx.metaDb.get('subscriptions')
      const subs = existing?.value || []

      if (!subs.find(s => s.driveKey === driveKey)) {
        subs.push({
          driveKey,
          subscribedAt: Date.now()
        })
        await ctx.metaDb.put('subscriptions', subs)
      }

      return { success: true }
    },

    /**
     * Unsubscribe from a channel
     * @param {string} driveKey
     * @returns {Promise<{success: boolean}>}
     */
    async unsubscribeChannel(driveKey) {
      if (ctx.personal?.writable) {
        await ctx.personal.unsubscribe(driveKey)
        return { success: true }
      }

      const existing = await ctx.metaDb.get('subscriptions')
      const subs = existing?.value || []

      const filtered = subs.filter(s => s.driveKey !== driveKey)
      await ctx.metaDb.put('subscriptions', filtered)

      return { success: true }
    },

    /**
     * Get subscriptions list with channel names
     * @returns {Promise<Array<{driveKey: string, name: string, subscribedAt?: number}>>}
     */
    async getSubscriptions() {
      let subs
      if (ctx.personal) {
        // Normalize personal-store rows to the legacy { driveKey, subscribedAt } shape.
        subs = (await ctx.personal.listSubscriptions()).map((s) => ({
          driveKey: s.channelKey,
          subscribedAt: s.subscribedAt,
          name: s.name || undefined
        }))
      } else {
        const existing = await ctx.metaDb.get('subscriptions')
        subs = existing?.value || []
      }

      const enriched = []
      for (const sub of subs) {
        let name = sub.name || 'Unknown'
        try {
          const channel = await loadChannel(ctx, sub.driveKey)
          const meta = await channel?.getMetadata().catch(() => null)
          if (meta?.name) name = meta.name
        } catch { /* best effort */ }
        enriched.push({ ...sub, name })
      }

      return enriched
    },
  }
}
