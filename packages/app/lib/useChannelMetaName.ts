import { useEffect, useState } from 'react'

const CHANNEL_META_CACHE_TTL_MS = 5 * 60 * 1000
const channelMetaNameCache = new Map<string, { name: string | null; expiresAt: number }>()

type ChannelMetaVideo = {
  channelKey?: string | null
  channel?: { key?: string | null } | null
} | null | undefined

type ChannelMetaRpc = {
  getChannelMeta?: (req: { channelKey: string }) => Promise<{ name?: string | null } | null>
} | null | undefined

/**
 * Resolve a channel's display name for the player's channel row, so it stays
 * stable even when the current video lacks embedded channel info. Results are
 * memoized in a module-level cache (5 min TTL) shared across player mounts.
 * Extracted verbatim from VideoPlayerOverlayImpl; deps intentionally key only on
 * the channel key to preserve the original effect's behavior.
 */
export function useChannelMetaName(currentVideo: ChannelMetaVideo, rpc: ChannelMetaRpc): string | null {
  const [channelMetaName, setChannelMetaName] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function loadChannelMeta() {
      const channelKey = currentVideo?.channelKey || currentVideo?.channel?.key
      if (!channelKey || !rpc?.getChannelMeta) {
        setChannelMetaName(null)
        return
      }

      const now = Date.now()
      const cached = channelMetaNameCache.get(channelKey)
      if (cached && cached.expiresAt > now) {
        setChannelMetaName(cached.name)
        return
      }

      try {
        const result = await rpc.getChannelMeta({ channelKey })
        if (cancelled) return
        const name = result?.name || null
        channelMetaNameCache.set(channelKey, {
          name,
          expiresAt: now + CHANNEL_META_CACHE_TTL_MS,
        })
        setChannelMetaName(name)
      } catch (err) {
        if (cancelled) return
        if (__DEV__) console.warn('[VideoPlayerOverlay] Failed to load channel meta:', err)
        setChannelMetaName(null)
      }
    }

    loadChannelMeta()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentVideo?.channelKey])

  return channelMetaName
}
