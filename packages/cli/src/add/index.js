import { CREDENTIAL_FIELDS, resolveAddPreferences } from './preferences.js'
import { buildCreatorItemDraft, buildDirectChannelDraft, buildEpisodeItemDraft, buildMovieChannelDraft, buildMovieItemDraft, buildReleaseItemDraft, buildShowChannelDraft, buildTrackItemDraft, normalizeIdentityUrl } from './content-model.js'
import { CONTENT_TYPES, canBrowse, coordinateRefusal, coordinateRequirement, coordinatesComplete, lookupRefusal, modeLabel, providerRefusal, readMediaCoordinates } from './media-coordinates.js'
import { canReadAuthority, createMetadataProvider } from './providers/index.js'
import { renderPickerLines } from './render.js'
import { createDiagnosticScope } from './diagnostic-scope.js'
import fs, { readFileSync, appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { loadChannel } from '@peartube/backend/storage'
import { deriveImportClaimantId } from '@peartube/backend/structured-content'
import { createYtDlpDownloader } from '../archive-manager.js'
import { fingerprintFile } from './bulk/source-scanner.js'
import { itemIdentity } from './duplicate-check.js'
import { deriveImportIdentityKey } from './content-model.js'
import { canonicalLocalResolutionRecord, executeLocalFileAcquisition, mimeTypeForPath, normalizeLocalDurationSeconds, sha256File } from '../local-file-acquisition.js'
import { createInteractiveDriver } from './interactive.js'
import { createPickerState } from './picker-state.js'
import nodePath from 'node:path'
import { promises as nodeFsPromises } from 'node:fs'
import { createRelayClient } from './relay-client.js'

function loadConfigFile (path) {
  if (!path) return {}
  try {
    const text = readFileSync(path, 'utf8')
    return JSON.parse(text)
  } catch {
    return {}
  }
}

const PROGRESS_PHASES = {
  queued: 'Queued',
  acquiring: 'Acquiring',
  verifying: 'Verifying',
  publishing: 'Publishing',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled'
}

class AddUsageError extends Error {
  constructor (message) {
    super(message)
    this.name = 'AddUsageError'
    this.exitCode = 2
  }
}

// Loads injected dependencies for tests/smoke without pulling the heavy backend
// graph into the default help/config paths.
async function loadDeps (context) {
  if (context.deps) return context.deps
  const modulePath = context.env?.PEARTUBE_ADD_DEPS_MODULE
  if (modulePath) {
    const mod = await import(modulePath)
    return (mod.createDeps ? await mod.createDeps(context) : mod.default) || {}
  }
  // The registry itself is cheap — it only lazily imports the one authority
  // module a run actually asks for — so it is injected rather than imported.
  const [{ openAddRuntime }, { createYtDlpProvider }, { runTerminal }] = await Promise.all([
    import('./runtime.js'),
    import('./providers/yt-dlp.js'),
    import('./terminal.js')
  ])
  return { openAddRuntime, createMetadataProvider, createYtDlpProvider, runTerminal }
}

async function executeAddMode ({ context, preferences, deps, mode, emitProgress, logger }) {
  if (preferences.relayUi) {
    if (mode === 'scripted') return await runRelayScripted({ context, preferences, deps, emitProgress })
    if (mode === 'interactive') {
      if (typeof deps.runTerminal !== 'function') throw new AddUsageError('Interactive mode is unavailable')
      return await runRelayInteractive({ context, preferences, deps })
    }
  }
  if (mode === 'scripted') {
    return await runScripted({ context, preferences, deps, emitProgress, logger })
  }
  if (mode === 'interactive') {
    if (typeof deps.runTerminal !== 'function') throw new AddUsageError('Interactive mode is unavailable')
    return await runInteractive({ context, preferences, deps, logger })
  }
  throw new AddUsageError('Unsupported add mode')
}

export async function runAddCommand (context = {}) {
  const { stdout, stderr, flags = {}, mode } = context
  const emitProgress = (line) => write(stderr, `${line}\n`)

  let config = {}
  if (typeof context.resolveConfig === 'function') config = await context.resolveConfig(context)
  else config = loadConfigFile(flags.config || context.env?.PEARTUBE_CONFIG || null)
  const preferences = resolveAddPreferences({ flags, env: context.env || {}, config })

  const deps = await loadDeps(context)

  const logger = mode === 'interactive' ? silentLogger(context.env || {}) : stderrLogger(stderr)
  const scope = createDiagnosticScope({ logger })
  scope.install()
  try {
    const result = await executeAddMode({ context, preferences, deps, mode, emitProgress, logger })
    return finish(context, result)
  } catch (error) {
    if (error?.exitCode === 2) {
      write(stderr, `${error.message}\n`)
      return 2
    }
    write(stderr, `${redact(error?.message || String(error))}\n`)
    return 1
  } finally {
    scope.restore()
  }
}

// Relay mode: `peartube add` is a thin client to a relay's archive console.
// The relay downloads, seeds, and publishes; the CLI just POSTs the URL.
async function runRelayScripted ({ context, preferences, deps, emitProgress }) {
  const { flags } = context
  const url = context.fetchUrl || context.query
  if (!url) throw new AddUsageError('Relay add requires a URL: peartube add <url> --relay-ui <addr>')
  const client = (deps.createRelayClient || createRelayClient)(preferences.relayUi)
  const publish = !flags.noPublish
  if (flags.creator) {
    await client.addCreator({ url, label: flags.title || flags.channelName || '', publish })
    return { status: 'queued', kind: 'creator', relay: client.base, url }
  }
  const { job, status, timedOut } = await client.archiveAndWait({
    url,
    channelName: flags.channelName,
    title: flags.title,
    invidiousInstance: flags.invidious,
    publish
  }, { emit: emitProgress, wait: !flags.noWait })
  return relayResult({ job, status, timedOut, relay: client.base, url })
}

async function runRelayInteractive ({ context, preferences, deps }) {
  const client = (deps.createRelayClient || createRelayClient)(preferences.relayUi)
  const { authority, metadata } = await openPickerMetadata({ context, preferences, deps })
  const driver = createInteractiveDriver({
    metadata,
    authority,
    ytDlp: null,
    searchLimit: preferences.searchLimit,
    cwd: context.cwd || process.cwd(),
    fs: nodeFsPromises,
    path: nodePath,
    execute: async (plan, onProgress) => {
      const { job, status, timedOut } = await client.archiveAndWait({
        url: plan.fetchUrl,
        title: plan.itemDraft?.title,
        channelName: plan.channelDraft?.name,
        publish: !context.flags?.noPublish
      }, { emit: onProgress })
      return relayResult({ job, status, timedOut, relay: client.base, url: plan.fetchUrl })
    }
  })
  const initialState = createPickerState({ query: typeof context.query === 'string' ? context.query : '' })
  const selection = await deps.runTerminal({
    input: context.stdin,
    output: context.stderr,
    signals: context.signals || process,
    initialState,
    onReady: driver.onReady,
    onState: driver.onState,
    onAction: driver.onAction,
    render: (state) => renderPickerLines(state, { columns: context.stderr?.columns || 80, rows: context.stderr?.rows || 24, color: !context.flags?.noColor })
  })
  driver.cleanup()
  if (!selection || !selection.result) return { status: 'cancelled' }
  if (selection.result.status === 'completed') return selection.result.value
  return { status: 'cancelled' }
}

function relayResult ({ job, status, timedOut, relay, url }) {
  if (status === 'completed') {
    const videoId = job?.videoId || null
    const channelKey = job?.channelKey || null
    return {
      status: 'published',
      relay,
      sourceUrl: url,
      videoId,
      channelKey,
      title: job?.title || null,
      url: channelKey && videoId ? `peartube://channel/${channelKey}/video/${videoId}` : url
    }
  }
  if (status === 'failed') return { status: 'failed', relay, url, error: { message: job?.error || 'relay archive failed' } }
  if (timedOut) return { status: 'pending', relay, url, jobId: job?.id || null }
  return { status: status || 'queued', relay, url, jobId: job?.id || null }
}

function refuse (message) {
  if (message) throw new AddUsageError(message)
}

// Build the client for one authority. The registry supplies its credential
// from preferences; anything beyond that — TVDB's subscriber PIN today — comes
// from the same credential table, so no authority is named twice.
function metadataProvider (authority, { preferences, deps }) {
  const create = deps.createMetadataProvider || createMetadataProvider
  const options = { searchLimit: preferences.searchLimit }
  for (const field of CREDENTIAL_FIELDS) {
    if (field.authority !== authority || field.option === 'apiKey') continue
    if (preferences[field.key]) options[field.option] = preferences[field.key]
  }
  return create(authority, { preferences, ...options })
}

// The picker browses one authority per session, chosen explicitly: the
// requested --provider when it has shows and movies to offer, TMDB otherwise.
// An authority nobody credentialed browses nothing rather than failing late.
async function openPickerMetadata ({ context, preferences, deps }) {
  const requested = context.flags?.provider
  const authority = requested && canBrowse(null, requested) ? requested : 'tmdb'
  const metadata = canReadAuthority(authority, preferences)
    ? await metadataProvider(authority, { preferences, deps })
    : null
  return { authority, metadata }
}

// Drafts from the catalogue: the authority supplies the name, description, and
// artwork, and an explicit --title or --channel-name still wins over both.
async function buildLookedUpDrafts ({ kind, coordinates, flags, preferences, deps, source }) {
  const provider = await metadataProvider(coordinates.mediaProvider, { preferences, deps })
  const retitled = (record) => (flags.title ? { ...record, title: flags.title } : record)

  if (kind === 'episode') {
    const show = await provider.getShow(coordinates.mediaId)
    const episodes = await provider.getSeason(coordinates.mediaId, coordinates.seasonNumber)
    const episode = episodes.find((entry) => entry.episodeNumber === coordinates.episodeNumber)
    if (!episode) throw new AddUsageError(`Episode S${coordinates.seasonNumber}E${coordinates.episodeNumber} was not found`)
    return {
      channelDraft: buildShowChannelDraft(flags.channelName ? { ...show, name: flags.channelName } : show),
      itemDraft: buildEpisodeItemDraft(retitled(episode), source, coordinates)
    }
  }
  if (kind === 'movie') {
    // A movie channel is the movie, so it carries the same renaming.
    const movie = retitled(await provider.getMovie(coordinates.mediaId))
    return {
      channelDraft: buildMovieChannelDraft(flags.channelName ? { ...movie, title: flags.channelName } : movie),
      itemDraft: buildMovieItemDraft(movie, source, coordinates)
    }
  }
  const work = retitled(kind === 'track'
    ? await provider.getRecording(coordinates.mediaId)
    : await provider.getRelease(coordinates.mediaId))
  // Music publishes into the artist's channel — see buildSuppliedDrafts — and
  // MusicBrainz names that artist, so the publisher need not.
  return {
    channelDraft: buildDirectChannelDraft({ name: flags.channelName || work.artist || work.title }),
    itemDraft: kind === 'track'
      ? buildTrackItemDraft(work, source, coordinates)
      : buildReleaseItemDraft(work, source, coordinates)
  }
}

// Drafts for an authority PearTube cannot read: the coordinates and the title
// the publisher typed, and nothing else.
function buildSuppliedDrafts ({ kind, coordinates, flags, source }) {
  const title = flags.title
  const channelName = flags.channelName || title
  const work = { title, seasonNumber: coordinates.seasonNumber, episodeNumber: coordinates.episodeNumber }
  const channelCoordinates = { mediaProvider: coordinates.mediaProvider, mediaId: coordinates.mediaId }
  if (kind === 'episode') {
    return {
      channelDraft: buildShowChannelDraft({ name: channelName, ...channelCoordinates }),
      itemDraft: buildEpisodeItemDraft(work, source, coordinates)
    }
  }
  if (kind === 'movie') {
    return {
      channelDraft: buildMovieChannelDraft({ title: channelName, ...channelCoordinates }),
      itemDraft: buildMovieItemDraft(work, source, coordinates)
    }
  }
  // A channel is an artist or a label, never a single recording, and the
  // profile vocabulary has no album kind: music publishes into a creator
  // channel and carries its MusicBrainz identity on the work itself.
  const channelDraft = buildDirectChannelDraft({ name: channelName })
  const itemDraft = kind === 'track'
    ? buildTrackItemDraft(work, source, coordinates)
    : buildReleaseItemDraft(work, source, coordinates)
  return { channelDraft, itemDraft }
}

async function runScripted ({ context, preferences, deps, emitProgress, logger }) {
  const { flags } = context
  refuse(providerRefusal(flags.type, flags.provider))
  refuse(coordinateRefusal(flags.type, flags))

  const coordinates = readMediaCoordinates(flags.type, flags)
  // A half-named work — an id with no authority, or an authority with no id —
  // is refused here too, because a caller can reach this without the parser.
  if (coordinates && !coordinatesComplete(flags.type, flags)) {
    throw new AddUsageError(`${modeLabel(flags.type)} mode requires ${coordinateRequirement(flags.type)}`)
  }
  // A title the publisher typed is always enough. Without one the authority has
  // to be readable, and the refusal names which half is missing: no client at
  // all, or a client whose credential nobody configured.
  const refusal = coordinates ? lookupRefusal(coordinates.mediaProvider, preferences) : null
  if (refusal && !flags.title) throw new AddUsageError(refusal)
  const enriched = coordinates !== null && refusal === null
  const fetchUrl = context.fetchUrl || context.query
  if (!fetchUrl) throw new AddUsageError('Scripted add requires a source URL or file path')

  const runtime = await deps.openAddRuntime({ storagePath: preferences.storagePath, network: preferences.network, logger })
  try {
    let channelDraft
    let itemDraft
    if (flags.type === 'video' || !flags.type) {
      const title = flags.title || titleFromUrl(fetchUrl)
      channelDraft = buildDirectChannelDraft({ name: flags.channelName || title })
      itemDraft = buildCreatorItemDraft({ title, contentKind: 'video' }, sourceFrom(fetchUrl))
    } else if (enriched) {
      const lookedUp = await buildLookedUpDrafts({
        kind: flags.type,
        coordinates,
        flags,
        preferences,
        deps,
        source: sourceFrom(fetchUrl)
      })
      channelDraft = lookedUp.channelDraft
      itemDraft = lookedUp.itemDraft
    } else if (coordinates) {
      const supplied = buildSuppliedDrafts({ kind: flags.type, coordinates, flags, source: sourceFrom(fetchUrl) })
      channelDraft = supplied.channelDraft
      itemDraft = supplied.itemDraft
    } else {
      throw new AddUsageError(`Scripted add requires --type ${CONTENT_TYPES.join(', ')}`)
    }

    return await executeSingle({ context, runtime, deps, preferences, channelDraft, itemDraft, fetchUrl, emitProgress })
  } finally {
    await runtime.close?.()
  }
}

async function runInteractive ({ context, preferences, deps, logger }) {
  const runtime = await deps.openAddRuntime({ storagePath: preferences.storagePath, network: preferences.network, logger })
  try {
    const { authority, metadata } = await openPickerMetadata({ context, preferences, deps })
    const ytDlp = typeof deps.createYtDlpProvider === 'function'
      ? deps.createYtDlpProvider({ bin: preferences.ytDlpPath || 'yt-dlp', cookiesPath: preferences.ytDlpCookiesPath || null })
      : null
    const driver = createInteractiveDriver({
      metadata,
      authority,
      ytDlp,
      searchLimit: preferences.searchLimit,
      cwd: context.cwd || process.cwd(),
      fs: nodeFsPromises,
      path: nodePath,
      execute: (plan, onProgress) => executeSingle({
        context,
        runtime,
        deps,
        preferences,
        channelDraft: plan.channelDraft,
        itemDraft: plan.itemDraft,
        fetchUrl: plan.fetchUrl,
        emitProgress: onProgress
      })
    })
    const initialState = createPickerState({ query: typeof context.query === 'string' ? context.query : '' })
    const selection = await deps.runTerminal({
      input: context.stdin,
      output: context.stderr,
      signals: context.signals || process,
      initialState,
      onReady: driver.onReady,
      onState: driver.onState,
      onAction: driver.onAction,
      render: (state) => renderPickerLines(state, { columns: context.stderr?.columns || 80, rows: context.stderr?.rows || 24, color: !context.flags?.noColor })
    })
    driver.cleanup()
    if (!selection || !selection.result) return { status: 'cancelled' }
    if (selection.result.status === 'completed') return selection.result.value
    return { status: 'cancelled' }
  } finally {
    await runtime.close?.()
  }
}

async function resolvePublisherId (deps, runtime) {
  const localPublisher = deps.ensureLocalPublisher
    ? await deps.ensureLocalPublisher()
    : await runtime.ensureLocalPublisher()
  const publisherId = localPublisher?.publisherId
  if (typeof publisherId !== 'string' || !/^[0-9a-f]{64}$/.test(publisherId)) {
    throw new Error(`invalid publisherId from ensureLocalPublisher: ${publisherId}`)
  }
  return publisherId
}

async function checkPreflightChannelState ({ deps, context, channel, channelInfo, itemDraft, jobId }) {
  const duplicateChecker = deps.duplicateCheck || { check: checkDuplicateForAdd }
  if (channel && duplicateChecker.check) {
    const duplicate = await duplicateChecker.check({ channel, item: itemDraft, force: Boolean(context.flags?.force) })
    if (duplicate?.status === 'already-exists') {
      return {
        earlyExit: true,
        result: {
          status: 'already-exists',
          channelKey: duplicate.existing?.channelKey || channelInfo?.channelKey,
          videoId: duplicate.existing?.videoId,
          availability: duplicate.existing?.availability
        }
      }
    }
  }

  const claimArbitrator = deps.arbitrateImportClaim || arbitrateImportClaimForAdd
  if (channel) {
    const claim = await claimArbitrator({ channel, itemDraft, jobId })
    if (claim && !claim.ok) {
      return {
        earlyExit: true,
        result: { status: 'released', jobId }
      }
    }
  }

  return { earlyExit: false }
}

async function createCanonicalRecordForStaged (staged, itemDraft) {
  const byteLength = Number(fs.statSync(staged.artifactPath).size)
  const hex = staged.checksum ? staged.checksum.replace(/^sha256:/, '') : await sha256File(staged.artifactPath)
  return canonicalLocalResolutionRecord({
    sha256: hex,
    byteLength,
    title: itemDraft.title || staged.title,
    fileName: basename(staged.artifactPath),
    kind: itemDraft.contentKind || 'video',
    namespace: itemDraft.mediaProvider || itemDraft.sourceProvider || null,
    identifier: itemDraft.mediaId || itemDraft.sourceVideoId || null,
    season: itemDraft.seasonNumber,
    episode: itemDraft.episodeNumber
  })
}

function buildAcquisitionInput ({ canon, staged, itemDraft, channelDraft, disposeStaged, abortSignal }) {
  return {
    idempotencyKey: canon.idempotencyKey,
    title: canon.title,
    selector: canon.selector,
    expectedBytes: canon.expectedBytes,
    retentionClass: canon.retentionClass,
    path: staged.artifactPath,
    mimeType: staged.mimeType || mimeTypeForPath(staged.artifactPath),
    sourceFileName: canon.sourceFileName,
    description: itemDraft.description || undefined,
    artwork: Array.isArray(itemDraft.artwork) ? itemDraft.artwork : undefined,
    tags: Array.isArray(itemDraft.tags) ? itemDraft.tags : undefined,
    creatorName: itemDraft.creatorName || channelDraft?.name || undefined,
    creatorHandle: itemDraft.creatorHandle || undefined,
    duration: normalizeLocalDurationSeconds(itemDraft.duration) ?? undefined,
    dispose: disposeStaged,
    ...(abortSignal ? { signal: abortSignal } : {}),
    awaitCompletion: true
  }
}

function assertJobPublicationValid (job) {
  if (job?.state !== 'completed') {
    const error = new Error(job?.errorCode || `Acquisition failed with state ${job?.state || 'unknown'}`)
    error.code = job?.errorCode || 'ACQUISITION_FAILED'
    throw error
  }

  const publicationFields = ['publicationId', 'manifestId', 'renditionId', 'assetId']
  if (publicationFields.some((field) => typeof job[field] !== 'string' || job[field].length === 0)) {
    const error = new Error('Completed acquisition lacks immutable publication identifiers')
    error.code = 'ACQUISITION_PUBLICATION_INVALID'
    throw error
  }
}

async function executeSingle ({ context, runtime, deps, preferences, channelDraft, itemDraft, fetchUrl, emitProgress }) {
  const jobId = deps.jobId || deriveJobId(itemDraft, fetchUrl)
  const publisherId = await resolvePublisherId(deps, runtime)

  const channelResolver = deps.resolveChannel || resolveChannelForAdd
  const channelInfo = await channelResolver({ runtime, channelDraft, emitProgress })
  const channel = channelInfo?.channel || channelInfo

  const preflight = await checkPreflightChannelState({ deps, context, channel, channelInfo, itemDraft, jobId })
  if (preflight.earlyExit) return preflight.result

  const sourceStager = deps.stageSource || stageSourceForAdd
  const staged = await sourceStager({ fetchUrl, preferences, emitProgress, channel, row: { data: { item: itemDraft } } })
  const disposeStaged = onceAsync(() => staged.dispose?.())
  const abortSignal = context.signal || context.abortSignal || null
  try {
    const canon = await createCanonicalRecordForStaged(staged, itemDraft)
    const acquireLocalFile = deps.executeLocalFileAcquisition || executeLocalFileAcquisition
    const input = buildAcquisitionInput({ canon, staged, itemDraft, channelDraft, disposeStaged, abortSignal })
    const job = await acquireLocalFile({ runtime, publisherId, input })

    if (job?.state === 'cancelled') {
      return { status: 'cancelled', jobId: job.acquisitionId }
    }

    assertJobPublicationValid(job)

    const videoId = job.publicationId
    const channelKey = channelInfo?.channelKey || channel?.channelKey || 'local'
    return {
      status: 'published',
      channelKey,
      videoId,
      url: `peartube://channel/${channelKey}/video/${videoId}`
    }
  } finally {
    await disposeStaged()
  }
}

async function resolveOrCreateIdentity (identityManager, emitProgress) {
  let identity = identityManager?.getActiveIdentity?.() || identityManager?.getIdentities?.()[0]
  if (!identity && identityManager?.createIdentity) {
    emitProgress('Creating your channel')
    const created = await identityManager.createIdentity('My PearTube', true, {})
    identity = identityManager?.getActiveIdentity?.() || {
      channelKey: created.driveKey,
      channelWriterKeyName: `peartube-channel-writer:${created.publicKey}`,
      channelEncryptionKey: created.channelEncryptionKey || null
    }
  }
  return identity
}

async function loadChannelForIdentity (ctx, channelKey, identity) {
  const existing = ctx?.channels?.get?.(channelKey)
  if (existing) return existing
  if (!channelKey || !ctx) return null
  return await loadChannel(ctx, channelKey, {
    writerKeyName: identity?.channelWriterKeyName || null,
    encryptionKeyHex: identity?.channelEncryptionKey || null,
    preferWritable: true
  }).catch(() => null)
}

async function resolveChannelForAdd ({ runtime, channelDraft, emitProgress }) {
  const identity = await resolveOrCreateIdentity(runtime.identityManager, emitProgress)
  const channelKey = identity?.channelKey || identity?.driveKey || 'local'
  const channel = await loadChannelForIdentity(runtime.ctx, channelKey, identity)
  return { channel, channelKey, identity }
}

async function checkDuplicateForAdd ({ channel, item } = {}) {
  const identity = itemIdentity(item)
  if (channel && identity && typeof channel.listVideos === 'function') {
    const videos = await channel.listVideos().catch(() => [])
    const match = videos.find((video) => itemIdentity({
      contentKind: video.contentKind,
      seasonNumber: video.seasonNumber,
      episodeNumber: video.episodeNumber,
      sourceProvider: video.sourceProvider,
      sourceVideoId: video.sourceVideoId,
      identityUrl: video.identityUrl
    }) === identity)
    if (match) {
      return { status: 'already-exists', existing: { channelKey: channel.keyHex, videoId: match.id, availability: match.publicationState || 'published' } }
    }
  }
  return { status: 'ok', advisories: [] }
}

async function arbitrateImportClaimForAdd ({ channel, itemDraft, jobId }) {
  if (!channel || typeof channel.putImportClaim !== 'function') return { ok: true }
  const importIdentityKey = deriveImportIdentityKey({
    contentKind: itemDraft.contentKind || 'video',
    sourceProvider: itemDraft.sourceProvider || 'local',
    sourceVideoId: itemDraft.sourceVideoId || jobId
  })
  const claimantId = deriveImportClaimantId(channel.localWriterKeyHex, jobId)
  await channel.putImportClaim({ identityKey: importIdentityKey, claimantId, jobId, writerKey: channel.localWriterKeyHex, videoId: jobId })
  const winner = await channel.resolveImportClaim?.(importIdentityKey)
  if (winner && winner.claimantId && winner.claimantId !== claimantId) {
    return { ok: false, status: 'released' }
  }
  return { ok: true, importIdentityKey, claimantId }
}

async function stageSourceForAdd ({ fetchUrl, preferences, emitProgress }) {
  if (fetchUrl && fs.existsSync(fetchUrl)) {
    emitProgress('Using local source file')
    return { artifactPath: fetchUrl, checksum: await fingerprintFile(fetchUrl), title: basename(fetchUrl), mimeType: mimeTypeForPath(fetchUrl), dispose: null }
  }
  emitProgress(`Downloading ${fetchUrl}`)
  const outputDir = mkdtempSync(join(tmpdir(), 'peartube-add-dl-'))
  const downloader = createYtDlpDownloader({
    bin: preferences?.ytDlpPath,
    outputDir,
    format: 'bv*+ba/b',
    cookiesPath: preferences?.ytDlpCookiesPath || null
  })
  const result = await downloader.download({ url: fetchUrl })
  const dispose = () => {
    try { rmSync(outputDir, { recursive: true, force: true }) } catch { /* Best-effort temp cleanup; a failed remove must not mask the add result. */ }
  }
  return { artifactPath: result.filePath, checksum: await fingerprintFile(result.filePath), title: result.title, mimeType: result.mimeType || mimeTypeForPath(result.filePath), dispose }
}

function onceAsync (fn) {
  let pending = null
  return () => {
    if (!pending) pending = Promise.resolve().then(() => fn?.())
    return pending
  }
}

function finish (context, result) {
  const { stdout, flags = {}, mode } = context
  if (flags.json) {
    write(stdout, `${JSON.stringify(result)}\n`)
  } else if (mode !== 'interactive') {
    // Interactive mode already shows the outcome on the picker's Result screen.
    write(stdout, `${humanLine(result)}\n`)
  }
  return result.status === 'failed' ? 1 : 0
}

function humanLine (result) {
  switch (result.status) {
    case 'published': return `Published ${result.url}`
    case 'already-exists': return `Already added: channel ${result.channelKey} video ${result.videoId}`
    case 'queued': return `Queued on relay ${result.relay}${result.jobId ? ` (job ${result.jobId})` : ''}.`
    case 'pending': return `Relay is still archiving (job ${result.jobId || 'unknown'}); check the relay UI at ${result.relay}.`
    case 'cancelled': return 'Cancelled.'
    case 'released': return `Skipped (another writer is importing this item).`
    case 'failed': return `Failed: ${result.error?.message || 'unknown error'}`
    default: return `Status: ${result.status}`
  }
}

function sourceFrom (fetchUrl) {
  const identityUrl = normalizeIdentityUrl(fetchUrl)
  return { provider: providerFromUrl(fetchUrl), identityUrl, displayUrl: identityUrl || fetchUrl }
}

function providerFromUrl (url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    if (/youtube|youtu\.be/.test(host)) return 'youtube'
    return host.split('.').slice(-2, -1)[0] || 'url'
  } catch {
    return 'url'
  }
}

function titleFromUrl (url) {
  try {
    const parsed = new URL(url)
    const last = parsed.pathname.split('/').filter(Boolean).pop()
    return decodeURIComponent(last || parsed.hostname).replace(/\.[^.]+$/, '') || 'Untitled'
  } catch {
    const base = String(url).split('/').pop() || 'Untitled'
    return base.replace(/\.[^.]+$/, '') || 'Untitled'
  }
}

function deriveJobId (item, fetchUrl) {
  const basis = `${item.sourceProvider || ''}:${item.sourceVideoId || ''}:${item.identityUrl || fetchUrl || ''}`
  let hash = 0
  for (let i = 0; i < basis.length; i += 1) hash = (Math.imul(31, hash) + basis.charCodeAt(i)) | 0
  return `add_${(hash >>> 0).toString(16).padStart(8, '0')}`
}

function stderrLogger (stderr) {
  const emit = (...args) => write(stderr, `${args.map(String).join(' ')}\n`)
  return { log: emit, info: emit, warn: emit, error: emit, debug: emit }
}

// Interactive mode owns stderr for the picker UI, so backend chatter must not
// touch it. Discard by default; route to a file when PEARTUBE_LOG is set.
function silentLogger (env = {}) {
  const logPath = env.PEARTUBE_LOG
  if (logPath) {
    const emit = (...args) => {
      try { appendFileSync(logPath, `${args.map(String).join(' ')}\n`) } catch { /* Logging is best-effort; an unwritable log path must not break the add. */ }
    }
    return { log: emit, info: emit, warn: emit, error: emit, debug: emit }
  }
  const noop = () => {}
  return { log: noop, info: noop, warn: noop, error: noop, debug: noop }
}

function redact (message) {
  return String(message).replace(/(api[_-]?key|token|cookie|authorization)=\S+/gi, '$1=[redacted]')
}

function write (stream, text) {
  if (stream && typeof stream.write === 'function') stream.write(text)
}

export { PROGRESS_PHASES }
