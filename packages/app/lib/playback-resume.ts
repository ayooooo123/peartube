/**
 * Resume playback of a watch-history entry.
 *
 * The player has no start-position API, so after loading we nudge seekTo a
 * couple of times once the player has had a chance to attach. Shared by the
 * Home "Continue Watching" rail and the Library History tab.
 */
import type { WatchHistoryEntry } from './watch-history'

interface ResumeDeps {
  rpc: any
  loadAndPlayVideo: (video: any, url: string) => void
  seekTo: (time: number) => void
}

export async function resumeWatchEntry(entry: WatchHistoryEntry, { rpc, loadAndPlayVideo, seekTo }: ResumeDeps): Promise<void> {
  if (!rpc) return
  try {
    const result = await rpc.preparePlayback({
      channelKey: entry.channelKey,
      videoId: entry.videoId,
      publicBeeKey: entry.publicBeeKey || undefined,
    })
    if (!result?.url) return
    loadAndPlayVideo(
      {
        id: entry.videoId,
        title: entry.title,
        channelKey: entry.channelKey,
        description: '',
        path: entry.videoId,
        size: 0,
        uploadedAt: entry.updatedAt,
        duration: entry.durationSec,
        publicBeeKey: entry.publicBeeKey || undefined,
        thumbnailUrl: entry.thumbnailUrl || undefined,
        channel: entry.channelName ? { name: entry.channelName } : undefined,
      },
      result.url
    )
    if (!entry.completed && entry.positionSec > 5) {
      const target = entry.positionSec
      setTimeout(() => { try { seekTo(target) } catch {} }, 1200)
      setTimeout(() => { try { seekTo(target) } catch {} }, 3000)
    }
  } catch (err) {
    console.error('[Resume] Failed to resume playback:', err)
  }
}
