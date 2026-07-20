import { deriveContentIdentityKey } from './content-model.js'

const TERMINAL = new Set(['published', 'skipped'])

// Executes one verified content-import row through the durable state machine.
// Every external effect is injected so the flow is deterministic under test and
// resumable across process restarts. Success is reported only after verified
// remote durability and public projection/announcement/finalization.
export function createExecutor (deps = {}) {
  const {
    jobStore,
    resolveChannel,
    loadChannel,
    duplicateCheck,
    deriveImportClaimantId,
    writeClaim,
    resolveClaimWinner,
    downloadSource,
    artworkCache = null,
    uploadFromPath,
    requestPin,
    awaitDurable,
    publication,
    logger = { log () {}, warn () {}, debug () {} }
  } = deps

  async function executeRow (job, initialRow, { force = false } = {}) {
    let row = initialRow
    if (TERMINAL.has(row.state)) return { status: row.state, row } // completed rows are skipped

    let channel = row.state === 'pending'
      ? null
      : await loadChannel(row.data.channelKey)

    // Resume a previously failed step before continuing.
    if (row.state === 'failed') {
      row = await jobStore.transitionRow(job.jobId, row.rowId, { to: row.failedFrom })
    }

    try {
      while (!TERMINAL.has(row.state)) {
        const step = STEPS[row.state]
        if (!step) throw new Error(`no executor step for state ${row.state}`)
        const outcome = await step({ job, row, channel, force, deps: {
          resolveChannel, loadChannel, duplicateCheck, deriveImportClaimantId, writeClaim,
          resolveClaimWinner, downloadSource, artworkCache, uploadFromPath, requestPin, awaitDurable,
          publication, jobStore, logger
        } })
        if (outcome.channel) channel = outcome.channel
        if (outcome.halt) return { status: outcome.status, row: outcome.row || row, ...outcome.extra }
        row = outcome.row
      }
      return { status: row.state, row, ...(row.data.existing ? { existing: row.data.existing } : {}) }
    } catch (error) {
      row = await jobStore.transitionRow(job.jobId, row.rowId, { to: 'failed', error })
      return { status: 'failed', row, error: { message: error.message, code: error.code || null } }
    }
  }

  return { executeRow }
}

const STEPS = {
  async pending ({ job, row, force, deps }) {
    const item = row.data.item
    const channelDraft = row.data.channelDraft
    const channelTarget = row.data.channelTarget || channelDraft?.channelTarget || { mode: 'new' }
    const channel = await deps.resolveChannel({ channelDraft, channelTarget })

    // Target-authority duplicate + active-job checks block before any transfer.
    const duplicate = await deps.duplicateCheck.check({ channel, item, force })
    if (duplicate.status === 'already-exists') {
      const skipped = await deps.jobStore.transitionRow(job.jobId, row.rowId, {
        to: 'skipped',
        patch: { data: { skipReason: 'already-exists', existing: duplicate.existing } }
      })
      return { halt: true, status: 'already-exists', row: skipped, extra: { existing: duplicate.existing } }
    }

    // Deterministic import claim; a losing claimant never downloads or uploads.
    const importIdentityKey = deriveContentIdentityKey({
      provider: item.sourceProvider,
      sourceId: item.sourceVideoId,
      identityUrl: item.identityUrl
    })
    const claimantId = deps.deriveImportClaimantId(channel.writerKeyHex, job.jobId)
    await deps.writeClaim({ channel, identityKey: importIdentityKey, claimantId, jobId: job.jobId, writerKey: channel.writerKeyHex })
    const winner = await deps.resolveClaimWinner({ channel, identityKey: importIdentityKey })
    if (winner && winner.claimantId && winner.claimantId !== claimantId) {
      const released = await deps.jobStore.transitionRow(job.jobId, row.rowId, {
        to: 'skipped',
        patch: { data: { skipReason: 'released', importIdentityKey, importClaimantId: claimantId } }
      })
      return { halt: true, status: 'released', row: released }
    }

    const nextRow = await deps.jobStore.transitionRow(job.jobId, row.rowId, {
      to: 'resolving',
      patch: { data: { channelKey: channel.channelKey, importIdentityKey, importClaimantId: claimantId, advisories: duplicate.advisories || [] } }
    })
    return { row: nextRow, channel }
  },

  async resolving ({ job, row, channel, deps }) {
    const item = row.data.item
    const { artifactPath, checksum } = await deps.downloadSource({ row, channel })
    let artworkRefs = []
    let artworkWarnings = []
    if (deps.artworkCache && Array.isArray(item.artwork) && item.artwork.length > 0) {
      const cached = await deps.artworkCache.cacheArtwork(item.artwork)
      artworkRefs = cached.refs
      artworkWarnings = cached.warnings
    }
    const nextRow = await deps.jobStore.transitionRow(job.jobId, row.rowId, {
      to: 'downloading',
      patch: { data: { verifiedArtifact: artifactPath, checksum, artworkRefs, artworkWarnings } }
    })
    return { row: nextRow }
  },

  async downloading ({ job, row, deps }) {
    // Persist the deterministic upload intent atomically BEFORE upload begins.
    const nextRow = await deps.jobStore.transitionRow(job.jobId, row.rowId, {
      to: 'uploading',
      patch: { data: { uploadIntent: { videoId: row.intent.videoId, importIdentityKey: row.data.importIdentityKey, importClaimantId: row.data.importClaimantId } } }
    })
    return { row: nextRow }
  },

  async uploading ({ job, row, channel, deps }) {
    const item = row.data.item
    const result = await deps.uploadFromPath({
      channel,
      videoId: row.intent.videoId,
      path: row.data.verifiedArtifact,
      checksum: row.data.checksum,
      identityUrl: item.identityUrl || null,
      importIdentityKey: row.data.importIdentityKey,
      importClaimantId: row.data.importClaimantId,
      artworkRefs: row.data.artworkRefs || []
    })
    const nextRow = await deps.jobStore.transitionRow(job.jobId, row.rowId, {
      to: 'uploaded',
      patch: { data: { videoId: result.videoId || row.intent.videoId, channelKey: result.channelKey || row.data.channelKey, blobKey: result.blobKey || null } }
    })
    return { row: nextRow }
  },

  async uploaded ({ job, row, channel, deps }) {
    await deps.requestPin({ channel, videoId: row.data.videoId })
    const nextRow = await deps.jobStore.transitionRow(job.jobId, row.rowId, { to: 'replicationPending' })
    return { row: nextRow }
  },

  async replicationPending ({ job, row, channel, deps }) {
    const durability = await deps.awaitDurable({ channel, videoId: row.data.videoId })
    if (!durability || durability.verified !== true) {
      // No eligible durable holder yet: remain pending, retain local bytes.
      return { halt: true, status: 'replicationPending', row }
    }
    await deps.publication.markDurabilityVerified(row.data.videoId)
    const nextRow = await deps.jobStore.transitionRow(job.jobId, row.rowId, { to: 'durabilityVerified', patch: { data: { holders: durability.holders || [] } } })
    return { row: nextRow }
  },

  async durabilityVerified ({ job, row, deps }) {
    return { row: await deps.jobStore.transitionRow(job.jobId, row.rowId, { to: 'projecting' }) }
  },

  async projecting ({ job, row, channel, deps }) {
    const projection = await deps.publication.project({ videoId: row.data.videoId, staged: row.data.stagedPatch || null })
    const nextRow = await deps.jobStore.transitionRow(job.jobId, row.rowId, {
      to: 'projected',
      patch: { data: { channelKey: projection.channelKey || row.data.channelKey, publicBeeKey: projection.publicBeeKey || null } }
    })
    return { row: nextRow }
  },

  async projected ({ job, row, deps }) {
    return { row: await deps.jobStore.transitionRow(job.jobId, row.rowId, { to: 'announcing' }) }
  },

  async announcing ({ job, row, deps }) {
    await deps.publication.announce({ channelKey: row.data.channelKey, publicBeeKey: row.data.publicBeeKey, videoId: row.data.videoId })
    return { row: await deps.jobStore.transitionRow(job.jobId, row.rowId, { to: 'announced' }) }
  },

  async announced ({ job, row, deps }) {
    return { row: await deps.jobStore.transitionRow(job.jobId, row.rowId, { to: 'finalizing' }) }
  },

  async finalizing ({ job, row, deps }) {
    await deps.publication.finalize(row.data.videoId)
    return { row: await deps.jobStore.transitionRow(job.jobId, row.rowId, { to: 'published' }) }
  }
}
