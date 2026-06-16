import { mkdirSync, rmSync } from '#fs'
import { join } from '#path'
import { ARCHIVE_STATUS, createArchiveState } from './state.js'
import { createYtDlp } from './yt-dlp.js'
import { createArchivePublisher } from './publisher.js'

function shouldRetry(record) {
  if (!record) return true
  if (record.status === ARCHIVE_STATUS.ARCHIVED) return false
  if (record.status === ARCHIVE_STATUS.ABANDONED) return false
  return true
}

function withinBudget({ cacheManager, maxBytes, reservePercent }) {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return true
  const used = typeof cacheManager?.getTotalBytes === 'function'
    ? Number(cacheManager.getTotalBytes()) || 0
    : 0
  const ceiling = maxBytes * (1 - reservePercent / 100)
  return used < ceiling
}

export function createArchiver({
  config,
  runtime,
  logger,
  fs,
  ytDlp = null,
  uploadManagerFactory = null,
  publisherFactory = null,
  onBudgetPressure = null,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  setTimeoutFn = setTimeout
}) {
  if (!config) throw new Error('config is required')
  if (!runtime) throw new Error('runtime is required')
  if (!fs) throw new Error('fs is required')
  if (!logger?.archive) throw new Error('archive logger is required')

  const archiveConfig = config.archive || {}
  if (!archiveConfig.enabled) {
    return {
      enabled: false,
      sources: [],
      async getSourcesStatus() { return [] },
      async start() { /* no-op */ },
      async runOnce() { /* no-op */ },
      async stop() { /* no-op */ }
    }
  }

  const sources = Array.isArray(archiveConfig.sources) ? archiveConfig.sources : []
  if (!sources.length) {
    logger.archive.warn('Archive enabled but no sources configured; skipping')
    return {
      enabled: false,
      sources: [],
      async getSourcesStatus() { return [] },
      async start() { /* no-op */ },
      async runOnce() { /* no-op */ },
      async stop() { /* no-op */ }
    }
  }

  const tmpPath = archiveConfig.tmpPath
  const ytDlpClient = ytDlp || createYtDlp({ binary: archiveConfig.ytDlpPath })
  const state = createArchiveState({ metaDb: runtime.ctx.metaDb })

  let uploadManager = null
  let publisher = null
  let stopped = false
  const sourceTimers = new Map()
  const initialPollTimers = new Set()
  const inflight = new Set()
  const abortController = typeof AbortController === 'function' ? new AbortController() : null

  function abortSignal() {
    return abortController ? abortController.signal : undefined
  }

  function cleanupTmpForVideo(videoId) {
    const dir = join(tmpPath, videoId)
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }

  function ensureTmpDirForVideo(videoId) {
    const dir = join(tmpPath, videoId)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  async function ensureUploadManager() {
    if (uploadManager) return uploadManager
    if (typeof uploadManagerFactory === 'function') {
      uploadManager = await uploadManagerFactory({ ctx: runtime.ctx })
    } else {
      const { createUploadManager } = await import('@peartube/backend/upload')
      uploadManager = createUploadManager({ ctx: runtime.ctx })
    }
    return uploadManager
  }

  async function ensurePublisher() {
    if (publisher) return publisher
    if (typeof publisherFactory === 'function') {
      publisher = await publisherFactory({ ctx: runtime.ctx, runtime, fs, logger, state })
    } else {
      const upload = await ensureUploadManager()
      publisher = createArchivePublisher({
        ctx: runtime.ctx,
        uploadManager: upload,
        runtime,
        fs,
        logger,
        state
      })
    }
    return publisher
  }

  async function processOneVideo({ source, ytEntry }) {
    const existing = await state.getVideo(source.sourceId, ytEntry.id)
    if (!shouldRetry(existing)) return { skipped: true, status: existing.status }

    if (!withinBudget({
      cacheManager: runtime.cacheManager,
      maxBytes: config.storage?.maxBytes,
      reservePercent: archiveConfig.budgetReservePercent
    })) {
      const usedBytes = typeof runtime.cacheManager?.getTotalBytes === 'function'
        ? Number(runtime.cacheManager.getTotalBytes()) || 0
        : 0
      logger.archive.warn('Storage budget reached; skipping new archives', {
        sourceId: source.sourceId,
        videoId: ytEntry.id,
        maxBytes: config.storage?.maxBytes,
        used: usedBytes
      })
      if (typeof onBudgetPressure === 'function') {
        try {
          await onBudgetPressure({
            source,
            videoId: ytEntry.id,
            usedBytes,
            maxBytes: Number(config.storage?.maxBytes || 0) || 0,
            reservePercent: Number(archiveConfig.budgetReservePercent || 0) || 0
          })
        } catch (err) {
          logger.archive.warn('Archive budget pressure hook failed', { error: err?.message || String(err) })
        }
      }
      return { skipped: true, status: 'budget' }
    }

    const tmpDir = ensureTmpDirForVideo(ytEntry.id)
    const downloadUrl = ytEntry.webpageUrl || ytEntry.url || `https://www.youtube.com/watch?v=${ytEntry.id}`

    try {
      const files = await ytDlpClient.downloadVideo(downloadUrl, {
        workDir: tmpDir,
        format: source.format || archiveConfig.format,
        videoId: ytEntry.id,
        signal: abortSignal()
      })

      const pub = await ensurePublisher()
      const result = await pub.publishVideo({ source, ytEntry, files })

      const archivedTitle = result.title || ytEntry.title || ''
      await state.markArchived(source.sourceId, ytEntry.id, {
        peartubeVideoId: result.videoId,
        bytes: result.bytes,
        title: archivedTitle
      })

      logger.archive.info('Video archived', {
        sourceId: source.sourceId,
        ytId: ytEntry.id,
        peartubeVideoId: result.videoId,
        bytes: result.bytes,
        title: archivedTitle
      })

      return {
        archived: true,
        status: 'archived',
        bytes: result.bytes,
        channelKey: result.channelKey || null,
        publicBeeKey: result.publicBeeKey || null
      }
    } catch (err) {
      const updated = await state.markFailed(source.sourceId, ytEntry.id, err, {
        maxRetries: archiveConfig.maxRetries
      })
      logger.archive.warn('Video archive failed', {
        sourceId: source.sourceId,
        ytId: ytEntry.id,
        retries: updated.retries,
        status: updated.status,
        error: err?.message || String(err)
      })
      return { archived: false, status: updated.status, error: err?.message || String(err) }
    } finally {
      cleanupTmpForVideo(ytEntry.id)
    }
  }

  async function pollSource(source) {
    if (stopped) return
    logger.archive.debug('Polling archive source', { sourceId: source.sourceId, url: source.url })

    let listing
    try {
      if (source.kind === 'rumble-video') {
        const id = String(source.identifier || source.sourceId || source.url)
          .replace(/^rumble:video:/, '')
          .replace(/^youtube:rumble:video:/, '')
        listing = [{
          id,
          title: source.label || id,
          duration: null,
          uploader: source.creatorName || source.label || null,
          uploadDate: null,
          url: source.url,
          webpageUrl: source.url
        }]
      } else {
        listing = await ytDlpClient.listVideos(source.url, {
          maxItems: source.maxItems || archiveConfig.maxItems,
          signal: abortSignal()
        })
      }
    } catch (err) {
      logger.archive.warn('Listing source failed', {
        sourceId: source.sourceId,
        error: err?.message || String(err)
      })
      await state.putSource(source.sourceId, {
        url: source.url,
        type: source.type,
        lastPolledAt: Date.now(),
        lastError: err?.message || String(err)
      })
      return
    }

    let archivedCount = 0
    let failedCount = 0
    let skippedCount = 0
    let bytesAddedThisPoll = 0
    let channelKey = null
    let publicBeeKey = null
    let sawArchivedContent = false

    for (const ytEntry of listing) {
      if (stopped) break
      const result = await processOneVideo({ source, ytEntry })
      if (result.archived) {
        archivedCount += 1
        bytesAddedThisPoll += Number(result.bytes) || 0
        channelKey = result.channelKey || channelKey
        publicBeeKey = result.publicBeeKey || publicBeeKey
        sawArchivedContent = true
      } else if (result.skipped && result.status === 'budget') {
        skippedCount += 1
        // budget exhausted — stop processing this poll; the next poll will try again
        break
      } else if (result.skipped) {
        skippedCount += 1
        if (result.status === ARCHIVE_STATUS.ARCHIVED) sawArchivedContent = true
      } else {
        failedCount += 1
      }
    }

    if (sawArchivedContent) {
      try {
        const pub = await ensurePublisher()
        if (typeof pub.ensureSourceChannel === 'function') {
          const channelEntry = await pub.ensureSourceChannel(source)
          channelKey = channelEntry?.channelKey || channelKey
          publicBeeKey = channelEntry?.publicBeeKey || publicBeeKey
        }
      } catch (err) {
        logger.archive.warn('Archive source reannounce failed', {
          sourceId: source.sourceId,
          error: err?.message || String(err)
        })
      }
    }

    const existingSourceRecord = await state.getSource(source.sourceId).catch(() => null)

    await state.putSource(source.sourceId, {
      ...(existingSourceRecord || {}),
      url: source.url,
      type: source.type,
      label: source.label || existingSourceRecord?.label || null,
      channelKey: channelKey || existingSourceRecord?.channelKey || null,
      publicBeeKey: publicBeeKey || existingSourceRecord?.publicBeeKey || null,
      lastPolledAt: Date.now(),
      lastError: null,
      lastSeenVideos: listing.length,
      archivedCount,
      failedCount,
      skippedCount,
      bytesAddedThisPoll
    })

    logger.archive.info('Source poll complete', {
      sourceId: source.sourceId,
      seen: listing.length,
      archived: archivedCount,
      failed: failedCount,
      skipped: skippedCount,
      bytesAddedThisPoll
    })
  }

  async function pollSourceTracked(source) {
    if (inflight.has(source.sourceId)) return
    inflight.add(source.sourceId)
    try {
      await pollSource(source)
    } catch (err) {
      logger.archive.error('Source poll crashed', {
        sourceId: source.sourceId,
        error: err?.message || String(err)
      })
    } finally {
      inflight.delete(source.sourceId)
    }
  }

  function scheduleSource(source) {
    const intervalMs = Math.max(60_000, Number(archiveConfig.poll) * 1000)
    const timer = setIntervalFn(() => {
      pollSourceTracked(source)
    }, intervalMs)
    sourceTimers.set(source.sourceId, timer)
  }

  async function getSourcesStatus() {
    const out = []
    for (const source of sources) {
      const sourceRecord = await state.getSource(source.sourceId).catch(() => null)
      const videos = await state.listVideos(source.sourceId).catch(() => [])
      const counts = { archived: 0, failed: 0, abandoned: 0 }
      for (const video of videos) {
        if (video.status === 'archived') counts.archived += 1
        else if (video.status === 'failed') counts.failed += 1
        else if (video.status === 'abandoned') counts.abandoned += 1
      }
      out.push({
        sourceId: source.sourceId,
        url: source.url,
        type: source.type,
        kind: source.kind,
        label: source.label,
        channelKey: sourceRecord?.channelKey || null,
        publicBeeKey: sourceRecord?.publicBeeKey || null,
        lastPolledAt: sourceRecord?.lastPolledAt || null,
        lastError: sourceRecord?.lastError || null,
        bytesAddedThisPoll: sourceRecord?.bytesAddedThisPoll || 0,
        counts
      })
    }
    return out
  }

  return {
    enabled: true,
    sources,
    getSourcesStatus,
    async start() {
      mkdirSync(tmpPath, { recursive: true })
      logger.archive.info('Archive starting', {
        sources: sources.length,
        pollSeconds: archiveConfig.poll,
        tmpPath
      })

      // Stagger initial polls so we don't hammer yt-dlp simultaneously.
      const stagger = Math.max(1, Math.floor(60_000 / sources.length))
      sources.forEach((source, index) => {
        const delay = index * stagger
        const timeout = setTimeoutFn(() => {
          initialPollTimers.delete(timeout)
          if (!stopped) pollSourceTracked(source)
        }, delay)
        initialPollTimers.add(timeout)
        scheduleSource(source)
      })
    },
    async runOnce() {
      mkdirSync(tmpPath, { recursive: true })
      for (const source of sources) {
        if (stopped) break
        await pollSourceTracked(source)
      }
    },
    async stop() {
      if (stopped) return
      stopped = true
      for (const timer of sourceTimers.values()) {
        try { clearIntervalFn(timer) } catch { /* best effort */ }
      }
      sourceTimers.clear()
      for (const timer of initialPollTimers.values()) {
        try { clearIntervalFn(timer) } catch { /* best effort */ }
      }
      initialPollTimers.clear()
      try { abortController?.abort() } catch { /* best effort */ }
      // Wait for any in-flight poll to drain
      const drainStart = Date.now()
      while (inflight.size > 0 && Date.now() - drainStart < 30_000) {
        await new Promise((resolve) => setTimeoutFn(resolve, 100))
      }
      logger.archive.info('Archive stopped')
    }
  }
}
