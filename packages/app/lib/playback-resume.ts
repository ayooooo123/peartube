/**
 * Resume playback of a watch-history entry.
 *
 * The player has no start-position API, so after loading we nudge seekTo a
 * couple of times once the player has had a chance to attach. Shared by the
 * Home "Continue Watching" rail and the Library History tab.
 */
import { getEntry, type WatchHistoryEntry } from './watch-history'

/**
 * The video shape handed to the player. `entityRef` and friends travel with it
 * so progress written during the resumed session lands on the same record
 * rather than opening a second one under legacy coordinates.
 */
type ResumeVideo = {
  id: string
  title: string
  channelKey: string
  description: string
  path: string
  size: number
  uploadedAt: number
  duration: number
  publicBeeKey?: string
  thumbnailUrl?: string
  channel?: { name: string }
  entityRef?: string
  editionRef?: string
  memberRef?: string
}

interface ResumeDeps {
  rpc: {
    preparePlayback(req: { channelKey: string; videoId: string; publicBeeKey?: string }): Promise<{ url?: string | null } | null | undefined>
  } | null | undefined
  loadAndPlayVideo: (video: ResumeVideo, url: string) => void
  seekTo: (time: number) => void
}

/** Below this a resume is indistinguishable from starting over. */
const MIN_SEEK_SECONDS = 5

export async function resumeWatchEntry(entry: WatchHistoryEntry, { rpc, loadAndPlayVideo, seekTo }: ResumeDeps): Promise<void> {
  if (!rpc) return
  try {
    // The list that rendered this row may be several progress ticks stale. The
    // personal store's own copy is the resume point.
    const current = (await getEntry(entry)) ?? entry
    const result = await rpc.preparePlayback({
      channelKey: current.channelKey,
      videoId: current.videoId,
      publicBeeKey: current.publicBeeKey || undefined,
    })
    if (!result?.url) return
    loadAndPlayVideo(
      {
        id: current.videoId,
        title: current.title,
        channelKey: current.channelKey,
        description: '',
        path: current.videoId,
        size: 0,
        uploadedAt: current.updatedAt,
        duration: current.durationSec,
        publicBeeKey: current.publicBeeKey || undefined,
        thumbnailUrl: current.thumbnailUrl || undefined,
        channel: current.channelName ? { name: current.channelName } : undefined,
        entityRef: current.identity?.entityRef || undefined,
        editionRef: current.identity?.editionRef || undefined,
        memberRef: current.identity?.memberRef || undefined,
      },
      result.url
    )
    if (!current.completed && current.positionSec > MIN_SEEK_SECONDS) {
      const target = current.positionSec
      setTimeout(() => { try { seekTo(target) } catch {} }, 1200)
      setTimeout(() => { try { seekTo(target) } catch {} }, 3000)
    }
  } catch (err) {
    console.error('[Resume] Failed to resume playback:', err)
  }
}
