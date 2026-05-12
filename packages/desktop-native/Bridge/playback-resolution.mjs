function withTimeout(task, fallback, timeoutMs = 3000) {
  return Promise.race([
    Promise.resolve().then(task),
    new Promise((resolve) => setTimeout(() => resolve(fallback), timeoutMs)),
  ]).catch(() => fallback)
}

function noop() {}

function createVideoRequest(params = {}) {
  const videoRef = params.videoPath || params.videoId

  return {
    videoId: params.videoId,
    videoRef,
    request: {
      channelKey: params.channelKey,
      videoId: videoRef,
      publicBeeKey: params.publicBeeKey || undefined,
      blobId: params.blobId || undefined,
      blobsCoreKey: params.blobsCoreKey || undefined,
      mimeType: params.mimeType || undefined,
    },
  }
}

function logPrefetchOutcome(log, params, result) {
  if (!result) return

  if (result.success === false) {
    if (result.error === 'Playback prefetch timed out') {
      log(`Playback prefetch is still warming for ${params.videoId}.`)
      return
    }

    log(`Playback prefetch failed for ${params.videoId}: ${result.error || 'Unknown error'}`)
    return
  }

  if (result.cached) {
    log(`Playback prefetch found cached blocks for ${params.videoId}.`)
    return
  }

  log(
    `Playback prefetch started for ${params.videoId} ` +
    `(${result.initialBlocks ?? 0} initial blocks, ${result.peerCount ?? 0} peers).`
  )
}

export async function resolvePlaybackViaClient({
  client,
  params,
  log = noop,
  prefetchTimeoutMs = 7000,
}) {
  if (!client?.video) {
    throw new Error('Native sidecar video client is unavailable')
  }

  const { videoId, request } = createVideoRequest(params)

  const response = await client.video.getVideoUrl(request)

  if (!response?.url) {
    throw new Error(`Playback URL was not resolved for video ${videoId}`)
  }

  if (typeof client.video.prefetchVideo === 'function') {
    queueMicrotask(() => {
      void withTimeout(
        () => client.video.prefetchVideo({
          channelKey: params.channelKey,
          videoId: request.videoId,
          publicBeeKey: params.publicBeeKey || undefined,
        }),
        { success: false, error: 'Playback prefetch timed out' },
        prefetchTimeoutMs
      )
        .then((prefetchResult) => logPrefetchOutcome(log, params, prefetchResult))
        .catch((error) => {
          log(`Playback prefetch failed for ${params.videoId}: ${error?.message || String(error)}`)
        })
    })

    queueMicrotask(() => {
      void withTimeout(
        () => client.video.getVideoStats?.({
          channelKey: params.channelKey,
          videoId: request.videoId,
          publicBeeKey: params.publicBeeKey || undefined,
        }),
        null,
        Math.min(prefetchTimeoutMs, 3000)
      )
        .then((stats) => {
          if (!stats) return
          const status = stats?.stats?.status ?? stats?.status ?? null
          const peerCount = stats?.stats?.peerCount ?? stats?.peerCount ?? null
          if (status || peerCount != null) {
            log(
              `Playback stats after URL resolution for ${params.videoId}: ` +
              `status=${status ?? 'unknown'} peers=${peerCount ?? 0}.`
            )
          }
        })
        .catch((error) => {
          log(`Playback stats poll failed for ${params.videoId}: ${error?.message || String(error)}`)
        })
    })
  }

  return {
    videoId,
    url: response.url,
  }
}
