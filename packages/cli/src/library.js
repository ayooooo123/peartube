import { createLocalDriveMirrorState, mirrorLocalDriveToRelayChannel } from './local-drive-mirror.js'
import { LIBRARY_AUDIENCE_PUBLIC } from './constants.js'

function folderChannelName(folder) {
  if (folder.channelName) return folder.channelName
  const segments = String(folder.path).split(/[/\\]/).filter(Boolean)
  return segments[segments.length - 1] || 'Home Library'
}

function collectChannelCoreKeys(items) {
  const keys = new Set()
  for (const item of items) {
    if (item.publicBeeKey) keys.add(item.publicBeeKey)
    const preview = item.previewVideo || {}
    if (preview.blobsCoreKey) keys.add(preview.blobsCoreKey)
    if (preview.thumbnailBlobsCoreKey) keys.add(preview.thumbnailBlobsCoreKey)
  }
  return [...keys]
}

export function createLibraryManager({
  config,
  runtime,
  catalog,
  inventory,
  createPublisher,
  hiverelay = null,
  logger = null,
  fsModule,
  nowFn = Date.now
}) {
  if (!config?.library) throw new Error('library config is required')
  if (!runtime) throw new Error('runtime is required')
  if (!catalog) throw new Error('catalog is required')
  if (!inventory) throw new Error('inventory is required')
  if (typeof createPublisher !== 'function') throw new Error('createPublisher is required')
  if (!fsModule) throw new Error('fsModule is required')

  const libraryConfig = config.library
  const log = {
    info: (message, meta) => logger?.library?.info?.(message, meta) ?? logger?.archive?.info?.(message, meta),
    warn: (message, meta) => logger?.library?.warn?.(message, meta) ?? logger?.archive?.warn?.(message, meta),
    error: (message, meta) => logger?.library?.error?.(message, meta) ?? logger?.archive?.error?.(message, meta)
  }

  let closed = false
  let importsPaused = false
  let importsPausedReason = null
  let lastScan = null
  let lastReconcileAt = null

  // Serialize scan / reconcile / unseed. All three read-modify-write the
  // inventory across await points; without a shared lock they interleave and
  // clobber each other (a scan's stale snapshot can resurrect an item an
  // operator just unseeded). close() awaits this chain to drain the in-flight
  // op before the runtime is torn down.
  let opChain = Promise.resolve()
  function withLock(fn) {
    const run = opChain.then(() => fn())
    opChain = run.then(() => {}, () => {})
    return run
  }

  function isFolderPublishable(folder) {
    if (folder.audience !== LIBRARY_AUDIENCE_PUBLIC) return true
    return folder.confirmed || inventory.isFolderConfirmed(folder.path)
  }

  function awaitingPublicConfirmation() {
    return libraryConfig.folders
      .filter((folder) => folder.audience === LIBRARY_AUDIENCE_PUBLIC && !isFolderPublishable(folder))
      .map((folder) => folder.path)
  }

  function validateFolders() {
    const missing = libraryConfig.folders
      .filter((folder) => typeof fsModule.existsSync === 'function' && !fsModule.existsSync(folder.path))
      .map((folder) => folder.path)
    if (missing.length > 0) {
      throw new Error(`library folders do not exist or are not readable: ${missing.join(', ')}`)
    }
  }

  // Private audience must never touch the public feed. The base archive
  // publisher announces on publish AND inside seedChannel, so the private
  // wrapper replaces both: it records the channel in the local cache and joins
  // swarm topics for availability, nothing more.
  function publisherForAudience(basePublisher, audience) {
    if (audience === LIBRARY_AUDIENCE_PUBLIC) return basePublisher
    return {
      ensureAnonymousChannel: (args) => basePublisher.ensureAnonymousChannel(args),
      importVideo: (args) => basePublisher.importVideo(args),
      async publishChannel() {
        return null
      },
      // Main local-drive-mirror calls publishCatalog + retainAssets after import.
      // Private audience must not announce on the public feed — only cache + seed.
      async publishCatalog(channelInfo) {
        const channelKey = channelInfo?.channelKey
        const publicBeeKey = channelInfo?.publicBeeKey
        if (!channelKey || !publicBeeKey) return null
        const playable = Array.isArray(channelInfo.previewVideos) ? channelInfo.previewVideos.filter(Boolean) : []
        await runtime.cacheManager?.addChannel?.(channelKey, publicBeeKey, 'private', {
          previewVideos: playable
        }).catch(() => {})
        return runtime.seeder?.seedChannel?.({
          driveKey: channelKey,
          publicBeeKey,
          previewVideos: playable
        }).catch(() => null)
      },
      async retainAssets() {
        return null
      },
      async seedChannel({ channelKey, publicBeeKey, previewVideos }) {
        if (!channelKey || !publicBeeKey) return null
        const playable = Array.isArray(previewVideos) ? previewVideos.filter(Boolean) : []
        await runtime.cacheManager?.addChannel?.(channelKey, publicBeeKey, 'private', {
          previewVideos: playable
        }).catch(() => {})
        return runtime.seeder?.seedChannel?.({
          driveKey: channelKey,
          publicBeeKey,
          previewVideos: playable
        }).catch(() => null)
      }
    }
  }

  async function recordFolderResult(folder, result, mirrorState) {
    const itemsByPath = new Map(result.videos.map((video) => [video.filePath, video]))

    for (const [filePath, seenRecord] of mirrorState.seen) {
      const imported = itemsByPath.get(filePath)
      const existing = inventory.getItem(filePath)
      // Only freshly-imported (or entirely new) items are written here.
      // Anything already tracked but not re-imported this scan keeps its
      // reconciled state (durable/self-only/pending-approval/unseeded) — a
      // no-op rescan must not touch it.
      if (!imported && existing) continue
      const record = {
        path: filePath,
        folderPath: folder.path,
        audience: folder.audience,
        fingerprint: seenRecord?.fingerprint || existing?.fingerprint || null,
        videoId: imported?.videoId || seenRecord?.previewVideo?.id || existing?.videoId || null,
        channelKey: seenRecord?.channelKey || imported?.channelKey || existing?.channelKey || null,
        publicBeeKey: seenRecord?.publicBeeKey || existing?.publicBeeKey || null,
        sourceIdentity: seenRecord?.sourceIdentity || existing?.sourceIdentity || null,
        previewVideo: seenRecord?.previewVideo || existing?.previewVideo || null,
        bytes: Number(imported?.size ?? existing?.bytes ?? 0) || 0,
        state: 'published',
        unseededAt: null,
        publishedAt: existing?.publishedAt || nowFn(),
        lastError: null
      }
      await inventory.upsertItem(record)
    }

    for (const failure of result.failures || []) {
      await inventory.upsertItem({
        path: failure.filePath,
        folderPath: folder.path,
        audience: folder.audience,
        state: 'failed',
        lastError: failure.error || 'import failed'
      })
      log.warn('Library import failed', { file: failure.filePath, error: failure.error })
    }

    for (const channel of result.channels || []) {
      if (!channel.channelKey) continue
      // Byte total must reflect the whole channel, not just items touched this
      // scan. On a no-op rescan nothing is re-imported, so deriving bytes from
      // this scan alone would clobber the catalog entry to 0 and corrupt quota
      // accounting. Sum the live inventory instead (idempotent).
      const liveItems = inventory.getItemsForChannel(channel.channelKey)
        .filter((item) => item.state !== 'unseeded' && item.state !== 'unseeding')
      const channelBytes = liveItems.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0)
      await catalog.upsertChannel({
        channelKey: channel.channelKey,
        publicBeeKey: channel.publicBeeKey || null,
        source: 'library',
        retentionClass: 'private',
        relayRole: 'origin',
        relayServing: true,
        channelName: channel.channelName || null,
        audience: folder.audience,
        bytes: channelBytes,
        videoCount: Array.isArray(channel.videos) ? channel.videos.length : 0,
        previewVideos: Array.isArray(channel.videos) ? channel.videos : [],
        lastDecisionReason: 'library-folder',
        lastSeenAt: nowFn(),
        mirroredAt: nowFn(),
        manifestUpdatedAt: nowFn()
      })
    }
  }

  async function scanOnceInner() {
    if (closed) return { skipped: true, reason: 'closed' }

    // Pick up any out-of-band `library confirm` written by the CLI since the
    // last scan (the confirm command runs in a separate process).
    inventory.reloadConfirmedFolders?.()

    const capBytes = Number(libraryConfig.caps?.maxBytes) || 0
    if (capBytes > 0 && inventory.summary().totalBytes >= capBytes) {
      if (!importsPaused) {
        importsPaused = true
        importsPausedReason = 'library cap reached'
        log.error('Library imports paused: cap reached', {
          capBytes,
          totalBytes: inventory.summary().totalBytes
        })
      }
      return { skipped: true, reason: 'cap-reached', importsPaused: true }
    }
    importsPaused = false
    importsPausedReason = null

    // Deliberately-withdrawn content stays withdrawn: unseeded/unseeding paths
    // are excluded from the scan entirely, so a later edit to the file cannot
    // silently resurrect and re-publish it. Re-adding requires clearing it
    // from the inventory.
    const skipPaths = new Set(
      inventory.getItems()
        .filter((item) => item.state === 'unseeded' || item.state === 'unseeding')
        .map((item) => item.path)
    )

    const basePublisher = createPublisher(fsModule)
    const totals = { scanned: 0, imported: 0, skipped: 0, failed: 0, folders: [] }

    for (const folder of libraryConfig.folders) {
      if (closed) break
      if (!isFolderPublishable(folder)) {
        totals.folders.push({ path: folder.path, skipped: true, reason: 'awaiting-public-confirmation' })
        continue
      }

      const mirrorState = createLocalDriveMirrorState({ seen: inventory.seenEntries() })
      const publisher = publisherForAudience(basePublisher, folder.audience)

      try {
        const result = await mirrorLocalDriveToRelayChannel({
          rootPath: folder.path,
          publisher,
          channelName: folderChannelName(folder),
          recursive: folder.recursive,
          maxFiles: folder.maxFiles,
          skipPaths,
          fs: fsModule,
          logger,
          state: mirrorState
        })
        await recordFolderResult(folder, result, mirrorState)
        totals.scanned += result.scanned
        totals.imported += result.imported
        totals.skipped += result.skipped
        totals.failed += result.failed
        totals.folders.push({
          path: folder.path,
          audience: folder.audience,
          scanned: result.scanned,
          imported: result.imported,
          skipped: result.skipped,
          failed: result.failed
        })
      } catch (err) {
        totals.folders.push({ path: folder.path, error: err?.message || String(err) })
        log.error('Library folder scan failed', { path: folder.path, error: err?.message || String(err) })
      }
    }

    lastScan = { at: nowFn(), ...totals }
    if (totals.imported || totals.failed) {
      log.info('Library scan complete', {
        scanned: totals.scanned,
        imported: totals.imported,
        skipped: totals.skipped,
        failed: totals.failed
      })
    }

    await reconcileDurabilityInner()
    return lastScan
  }

  async function reconcileDurabilityInner() {
    if (closed) return { reconciled: false, reason: 'closed' }
    const now = nowFn()
    lastReconcileAt = now

    const items = inventory.getItems()
      .filter((item) => ['published', 'self-only', 'pending-approval', 'durable'].includes(item.state))
    if (items.length === 0) return { reconciled: true, items: 0 }

    if (!hiverelay) {
      for (const item of items) {
        if (item.state !== 'self-only') await inventory.setState(item.path, 'self-only')
      }
      return { reconciled: true, items: items.length, mode: 'self-only' }
    }

    const detection = await hiverelay.detect()
    if (!detection.detected) {
      for (const item of items) {
        if (item.state !== 'self-only') await inventory.setState(item.path, 'self-only')
      }
      return { reconciled: true, items: items.length, mode: 'self-only', error: detection.error || null }
    }

    const ttlMs = Number(config.hiverelay?.seedRequest?.ttlSeconds || 0) * 1000
    const byChannel = new Map()
    for (const item of items) {
      if (!item.channelKey) continue
      if (!byChannel.has(item.channelKey)) byChannel.set(item.channelKey, [])
      byChannel.get(item.channelKey).push(item)
    }

    for (const [channelKey, channelItems] of byChannel) {
      const freshestRequest = Math.max(0, ...channelItems.map((item) => Number(item.relay?.requestedAt) || 0))
      const allDurable = channelItems.every((item) => item.state === 'durable')
      const renewDue = ttlMs > 0 && freshestRequest > 0 && now - freshestRequest > ttlMs / 2
      if (allDurable && !renewDue) continue

      const keys = collectChannelCoreKeys(channelItems)
      if (channelKey) keys.unshift(channelKey)
      const maxStorageBytes = channelItems.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0)
      const outcome = await hiverelay.seedCores({ keys, maxStorageBytes })

      const anyError = outcome.results.some((entry) => entry.status === 'error')
      const anyPending = outcome.results.some((entry) => entry.status === 'pending-approval')
      // Operator-authenticated seed-core pins durably on accept (HiveRelay
      // README); review-mode appliances answer pending until approved.
      const nextState = !outcome.submitted || anyError
        ? 'self-only'
        : (anyPending ? 'pending-approval' : 'durable')

      for (const item of channelItems) {
        await inventory.upsertItem({
          ...item,
          path: item.path,
          state: nextState,
          relay: {
            ...(item.relay || {}),
            endpoint: hiverelay.endpoint,
            requestedAt: now,
            lastOutcome: nextState,
            lastVerifiedAt: nextState === 'durable' ? now : (item.relay?.lastVerifiedAt || null)
          }
        })
      }
    }

    return { reconciled: true, items: items.length, mode: 'relay' }
  }

  async function unseedInner(target) {
    const items = inventory.findItems(target)
    if (items.length === 0) return { unseeded: 0, reason: 'not-found', target }

    const affectedChannels = new Map()
    const publicItems = items.filter((item) => item.audience === LIBRARY_AUDIENCE_PUBLIC)

    for (const item of items) {
      await inventory.setState(item.path, 'unseeding')
      if (item.channelKey) affectedChannels.set(item.channelKey, item.audience)
    }

    if (publicItems.length > 0) {
      log.warn('Unseeding public items: bytes already fetched by peers cannot be recalled', {
        items: publicItems.length
      })
    }

    const results = { unseeded: 0, channelsReleased: [], relayWithdrawals: null }

    for (const [channelKey, audience] of affectedChannels) {
      const channelItems = inventory.getItemsForChannel(channelKey)
      const remaining = channelItems.filter((item) => !['unseeding', 'unseeded'].includes(item.state))

      if (remaining.length === 0) {
        const unseedingItems = channelItems.filter((item) => item.state === 'unseeding')
        if (hiverelay) {
          const keys = collectChannelCoreKeys(unseedingItems)
          keys.unshift(channelKey)
          results.relayWithdrawals = await hiverelay.unseedCores({ keys })
        }
        // Retract from the public feed BEFORE the seeder teardown. Without this
        // the channel stays in publicFeed.entries and the runtime's feed-update
        // re-seed loop re-announces it on the next tick — unseed would be
        // fail-open for exactly the public content it most needs to recall.
        if (audience === LIBRARY_AUDIENCE_PUBLIC) {
          await runtime.publicFeed?.unpublishChannel?.(channelKey).catch(() => null)
        }
        await runtime.seeder?.unseedChannel?.({ driveKey: channelKey }).catch(() => null)
        await runtime.cacheManager?.removeChannel?.(channelKey).catch(() => null)
        await catalog.removeChannel(channelKey).catch(() => null)
        results.channelsReleased.push(channelKey)
        log.info('Library channel released', { channelKey, audience })
      }
    }

    for (const item of items) {
      await inventory.setState(item.path, 'unseeded', {
        unseededAt: nowFn(),
        relay: null
      })
      results.unseeded += 1
    }

    log.info('Library unseed complete', { target, unseeded: results.unseeded, channelsReleased: results.channelsReleased.length })
    return results
  }

  // Crash-safe resume: anything left mid-unseed by a previous process finishes
  // its withdrawal before new imports run. Runs under the shared lock so it
  // cannot interleave with a scan.
  async function resumeIncompleteUnseeds() {
    const stuck = inventory.getItems().filter((item) => item.state === 'unseeding')
    for (const item of stuck) {
      await withLock(() => unseedInner(item.path))
    }
    return { resumed: stuck.length }
  }

  function pauseImports(reason) {
    importsPaused = true
    importsPausedReason = reason || 'paused'
    log.error('Library imports paused', { reason: importsPausedReason })
  }

  function getStatusSection() {
    const summary = inventory.summary()
    return {
      enabled: Boolean(libraryConfig.enabled),
      folders: libraryConfig.folders.length,
      items: summary.counts,
      totalItems: summary.total,
      bytes: summary.totalBytes,
      capBytes: Number(libraryConfig.caps?.maxBytes) || 0,
      importsPaused,
      importsPausedReason,
      awaitingPublicConfirmation: awaitingPublicConfirmation(),
      hiverelay: {
        enabled: Boolean(config.hiverelay?.enabled),
        endpoint: hiverelay?.endpoint || null,
        lastReconcileAt
      },
      lastScan
    }
  }

  async function close() {
    closed = true
    // Drain any in-flight scan/reconcile/unseed before the caller tears down
    // the runtime, so no library op touches a closed swarm/store/cache.
    await opChain.catch(() => {})
    await inventory.persist().catch(() => {})
  }

  // Public entry points serialize through the shared lock; the *Inner
  // implementations call each other directly (scan → reconcile) without
  // re-acquiring it, which would deadlock.
  const scanOnce = () => withLock(scanOnceInner)
  const reconcileDurability = () => withLock(reconcileDurabilityInner)
  const unseed = (target) => withLock(() => unseedInner(target))

  async function confirmFolder(folderPath) {
    return inventory.confirmFolder(folderPath)
  }

  return {
    validateFolders,
    scanOnce,
    reconcileDurability,
    resumeIncompleteUnseeds,
    unseed,
    confirmFolder,
    pauseImports,
    getStatusSection,
    close
  }
}
