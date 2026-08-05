import { resolveAddPreferences } from './preferences.js'
import { buildCreatorItemDraft, buildDirectChannelDraft, buildEpisodeItemDraft, buildMovieChannelDraft, buildMovieItemDraft, buildReleaseItemDraft, buildShowChannelDraft, buildTrackItemDraft, normalizeIdentityUrl } from './content-model.js'
import { CONTENT_TYPES, coordinateRefusal, coordinateRequirement, coordinatesComplete, isQueryable, modeLabel, providerRefusal, readMediaCoordinates } from './media-coordinates.js'
import { renderPickerLines } from './render.js'
import { createDiagnosticScope } from './diagnostic-scope.js'
import { createBackendExecutorDeps } from './backend-deps.js'
import { readFileSync, appendFileSync } from 'node:fs'
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
  resolving: 'Resolving',
  downloading: 'Downloading',
  uploading: 'Uploading',
  uploaded: 'Uploaded',
  replicationPending: 'Replicating',
  durabilityVerified: 'Verifying copy',
  projecting: 'Projecting',
  announcing: 'Announcing',
  published: 'Published'
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
  const [{ openAddRuntime }, { createTmdbProvider }, { createYtDlpProvider }, { createJobStore }, { createExecutor }, { runTerminal }] = await Promise.all([
    import('./runtime.js'),
    import('./providers/tmdb.js'),
    import('./providers/yt-dlp.js'),
    import('./job-store.js'),
    import('./executor.js'),
    import('./terminal.js')
  ])
  return { openAddRuntime, createTmdbProvider, createYtDlpProvider, createJobStore, createExecutor, runTerminal }
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
    if (preferences.relayUi) {
      if (mode === 'scripted') return finish(context, await runRelayScripted({ context, preferences, deps, emitProgress }))
      if (mode === 'interactive') {
        if (typeof deps.runTerminal !== 'function') throw new AddUsageError('Interactive mode is unavailable')
        return finish(context, await runRelayInteractive({ context, preferences, deps }))
      }
    }
    if (mode === 'scripted') {
      const result = await runScripted({ context, preferences, deps, emitProgress, logger })
      return finish(context, result)
    }
    if (mode === 'interactive') {
      if (typeof deps.runTerminal !== 'function') throw new AddUsageError('Interactive mode is unavailable')
      const result = await runInteractive({ context, preferences, deps, logger })
      return finish(context, result)
    }
    throw new AddUsageError('Unsupported add mode')
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
  const tmdb = preferences.tmdbApiKey
    ? deps.createTmdbProvider({ apiKey: preferences.tmdbApiKey, searchLimit: preferences.searchLimit })
    : null
  const driver = createInteractiveDriver({
    tmdb,
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
  if (selection.result.status === 'exited') return { status: 'exited' }
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

// Drafts for an authority with no metadata client: the coordinates and the
// title the publisher typed, and nothing else.
function buildSuppliedDrafts ({ kind, coordinates, flags, source }) {
  const title = flags.title
  if (!title) {
    throw new AddUsageError(`--title is required for ${coordinates.mediaProvider} coordinates; PearTube has no ${coordinates.mediaProvider} metadata client to look one up`)
  }
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
  const enriched = coordinates !== null && isQueryable(coordinates.mediaProvider)
  if (enriched && !preferences.tmdbApiKey) {
    throw new AddUsageError('A TMDB API key is required for scripted metadata. Set TMDB_API_KEY or run peartube config.')
  }
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
    } else if (enriched && flags.type === 'episode') {
      const tmdb = deps.createTmdbProvider({ apiKey: preferences.tmdbApiKey, searchLimit: preferences.searchLimit })
      const show = await tmdb.getShow(coordinates.mediaId)
      const episodes = await tmdb.getSeason(coordinates.mediaId, coordinates.seasonNumber)
      const episode = episodes.find((entry) => entry.episodeNumber === coordinates.episodeNumber)
      if (!episode) throw new AddUsageError(`Episode S${coordinates.seasonNumber}E${coordinates.episodeNumber} was not found`)
      channelDraft = buildShowChannelDraft(show)
      itemDraft = buildEpisodeItemDraft(episode, sourceFrom(fetchUrl), coordinates)
    } else if (enriched && flags.type === 'movie') {
      const tmdb = deps.createTmdbProvider({ apiKey: preferences.tmdbApiKey, searchLimit: preferences.searchLimit })
      const movie = await tmdb.getMovie(coordinates.mediaId)
      channelDraft = buildMovieChannelDraft(movie)
      itemDraft = buildMovieItemDraft(movie, sourceFrom(fetchUrl), coordinates)
    } else if (coordinates) {
      ;({ channelDraft, itemDraft } = buildSuppliedDrafts({ kind: flags.type, coordinates, flags, source: sourceFrom(fetchUrl) }))
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
    const tmdb = preferences.tmdbApiKey
      ? deps.createTmdbProvider({ apiKey: preferences.tmdbApiKey, searchLimit: preferences.searchLimit })
      : null
    const ytDlp = typeof deps.createYtDlpProvider === 'function'
      ? deps.createYtDlpProvider({ bin: preferences.ytDlpPath || 'yt-dlp', cookiesPath: preferences.ytDlpCookiesPath || null })
      : null
    const driver = createInteractiveDriver({
      tmdb,
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
    if (selection.result.status === 'exited') return { status: 'exited' }
    return { status: 'cancelled' }
  } finally {
    await runtime.close?.()
  }
}

async function executeSingle ({ context, runtime, deps, preferences, channelDraft, itemDraft, fetchUrl, emitProgress }) {
  const jobStore = deps.createJobStore({ bee: runtime.metadataBee })
  const jobId = deps.jobId || deriveJobId(itemDraft, fetchUrl)
  await jobStore.createJob({ jobId, rows: [{ rowId: 'r1', data: { item: itemDraft, channelDraft, channelTarget: channelDraft.channelTarget } }] })

  const executor = deps.createExecutor(buildExecutorDeps({ runtime, deps, jobStore, preferences, fetchUrl, emitProgress, context }))
  const job = await jobStore.getJob(jobId)
  const outcome = await executor.executeRow(job, job.rows[0], { force: Boolean(context.flags?.force) })

  if (outcome.status === 'already-exists') {
    return { status: 'already-exists', channelKey: outcome.existing?.channelKey, videoId: outcome.existing?.videoId, availability: outcome.existing?.availability }
  }
  if (outcome.status === 'published') {
    const data = outcome.row.data
    return { status: 'published', channelKey: data.channelKey, videoId: data.videoId, url: `peartube://channel/${data.channelKey}/video/${data.videoId}` }
  }
  if (outcome.status === 'replicationPending') {
    emitProgress('No eligible durable peer yet. Local bytes retained; the uploader is still the only source. Retry later.')
    return { status: 'replicationPending', jobId, videoId: outcome.row.data.videoId }
  }
  if (outcome.status === 'released') return { status: 'released', jobId }
  if (outcome.status === 'failed') return { status: 'failed', jobId, error: outcome.error }
  return { status: outcome.status, jobId }
}

function buildExecutorDeps ({ runtime, deps, jobStore, preferences, fetchUrl, emitProgress, context }) {
  // Injected executor dependency wiring is supplied by the smoke/tests via
  // deps.buildExecutorDeps when driving fakes; otherwise wire the real runtime.
  if (typeof deps.buildExecutorDeps === 'function') {
    return deps.buildExecutorDeps({ runtime, jobStore, fetchUrl, emitProgress, context })
  }
  return createBackendExecutorDeps({ runtime, jobStore, preferences, fetchUrl, emitProgress })
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
    case 'replicationPending': return `Pending durability (job ${result.jobId}); retained locally.`
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
      try { appendFileSync(logPath, `${args.map(String).join(' ')}\n`) } catch {}
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
