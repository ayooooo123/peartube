export const PLAYBACK_READY_RETRY_DELAYS_MS = [900, 1400, 2200] as const

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function isWaitingForSelectedBlob(result: any) {
  const warmup = result?.selectedBlobWarmup
  return Boolean(warmup && warmup.readyForPlayback === false)
}

export async function preparePlaybackWhenReady({
  preparePlayback,
  playbackRequest,
  isCurrent,
}: {
  preparePlayback: (request: any) => Promise<any>
  playbackRequest: any
  isCurrent: () => boolean
}) {
  let result: any = null
  for (let attempt = 0; attempt <= PLAYBACK_READY_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      await wait(PLAYBACK_READY_RETRY_DELAYS_MS[attempt - 1])
      if (!isCurrent()) return null
    }
    result = await preparePlayback(playbackRequest)
    if (!isCurrent()) return null
    if (!result?.url || !isWaitingForSelectedBlob(result)) return result
  }
  return result
}
