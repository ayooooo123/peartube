import { resolveAddPreferences } from './preferences.js'
import { buildCreatorItemDraft, buildDirectChannelDraft, buildEpisodeItemDraft, buildMovieChannelDraft, buildMovieItemDraft, buildShowChannelDraft, normalizeIdentityUrl } from './content-model.js'
import { renderPickerLines } from './render.js'
import { createDiagnosticScope } from './diagnostic-scope.js'
import { createBackendExecutorDeps } from './backend-deps.js'
import { readFileSync, appendFileSync } from 'node:fs'
import { createInteractiveDriver } from './interactive.js'
import { createPickerState } from './picker-state.js'
import nodePath from 'node:path'
import { promises as nodeFsPromises } from 'node:fs'

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

async function runScripted ({ context, preferences, deps, emitProgress, logger }) {
  const { flags } = context
  if (flags.provider && flags.provider !== 'tmdb') {
    throw new AddUsageError(`Provider ${flags.provider} is not available in this version`)
  }
  if (!preferences.tmdbApiKey && (flags.type === 'episode' || flags.type === 'movie')) {
    throw new AddUsageError('A TMDB API key is required for scripted metadata. Set TMDB_API_KEY or run peartube config.')
  }
  const fetchUrl = context.fetchUrl || context.query
  if (!fetchUrl) throw new AddUsageError('Scripted add requires a source URL or file path')

  const runtime = await deps.openAddRuntime({ storagePath: preferences.storagePath, network: preferences.network, logger })
  try {
    let channelDraft
    let itemDraft
    if (flags.type === 'video') {
      const title = flags.title || titleFromUrl(fetchUrl)
      channelDraft = buildDirectChannelDraft({ name: flags.channelName || title })
      itemDraft = buildCreatorItemDraft({ title, contentKind: 'video' }, sourceFrom(fetchUrl))
    } else if (flags.type === 'episode') {
      const tmdb = deps.createTmdbProvider({ apiKey: preferences.tmdbApiKey, searchLimit: preferences.searchLimit })
      const show = await tmdb.getShow(flags.showId)
      const episodes = await tmdb.getSeason(flags.showId, flags.season)
      const episode = episodes.find((entry) => entry.episodeNumber === Number(flags.episode))
      if (!episode) throw new AddUsageError(`Episode S${flags.season}E${flags.episode} was not found`)
      channelDraft = buildShowChannelDraft(show)
      itemDraft = buildEpisodeItemDraft(episode, sourceFrom(fetchUrl), { mediaProvider: 'tmdb', mediaId: show.mediaId })
    } else if (flags.type === 'movie') {
      const tmdb = deps.createTmdbProvider({ apiKey: preferences.tmdbApiKey, searchLimit: preferences.searchLimit })
      const movie = await tmdb.getMovie(flags.movieId)
      channelDraft = buildMovieChannelDraft(movie)
      itemDraft = buildMovieItemDraft(movie, sourceFrom(fetchUrl))
    } else {
      throw new AddUsageError('Scripted add requires --type video, episode, or movie')
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
