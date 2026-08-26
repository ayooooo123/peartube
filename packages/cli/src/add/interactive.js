// Interactive picker orchestrator.
//
// Connects the pure picker state machine (`picker-state.js`), the terminal
// engine (`terminal.js`), and the live providers (one metadata authority plus
// yt-dlp) into a single running `peartube add` session. The terminal engine is
// synchronous; this driver supplies the async effects it cannot: per-screen
// discovery fetches, path autocomplete for local sources, and the
// publish/execution step that runs while the picker sits on the `progress`
// screen.
//
// Wiring contract with `terminal.js`:
//   onReady(dispatch)        -> capture the dispatch bridge
//   onState(state, dispatch) -> react to screen/query transitions
//   onAction(action, dispatch) -> pre-reduce interception (episode auto-select)

import nodePath from 'node:path'
import { homedir as osHomedir } from 'node:os'
import { listPathCandidates } from './controller.js'
import {
  buildShowChannelDraft,
  buildMovieChannelDraft,
  buildCreatorChannelDraft,
  buildEpisodeItemDraft,
  buildMovieItemDraft,
  buildCreatorItemDraft
} from './content-model.js'

const HTTP_RE = /^https?:\/\//i
const SEARCH_DEBOUNCE_MS = 250
const MIN_QUERY = 2

function isUrl (value) {
  return HTTP_RE.test(String(value || '').trim())
}

// Channel/profile URLs list recent videos; anything else is treated as search text.
function isChannelUrl (value) {
  return /(youtube\.com\/(channel|c|user)\/|youtube\.com\/@|\/@[^/]+$)/i.test(String(value || ''))
}

function pad2 (value) {
  return String(value ?? 0).padStart(2, '0')
}

function messageOf (error) {
  return error && error.message ? String(error.message) : String(error)
}

export function createInteractiveDriver ({
  metadata = null,
  authority = 'tmdb',
  ytDlp = null,
  searchLimit = 20,
  cwd = process.cwd(),
  fs = null,
  path = nodePath,
  homedir = osHomedir,
  execute
} = {}) {
  if (typeof execute !== 'function') throw new TypeError('execute is required')

  let dispatch = null
  let counter = 0
  let activeAbort = null
  let searchTimer = null
  let prevScreen = null
  let prevQuery = null
  let executing = false
  let currentState = null
  let show = null // full TMDB show (with mediaId/artwork) cached for the tv flow
  let creator = null // yt-dlp creator profile cached for the creator flow

  function onReady (d) {
    dispatch = d
  }

  function clearTimer () {
    if (searchTimer !== null) {
      clearTimeout(searchTimer)
      searchTimer = null
    }
  }

  function abortActive () {
    if (activeAbort) {
      try { activeAbort.abort() } catch {}
      activeAbort = null
    }
  }

  // Monotonic request tokens mirror the reducer's stale-response guard: only the
  // latest request's results are applied, so fast typing/back-navigation is safe.
  function load (producer, { debounce = 0 } = {}) {
    if (!dispatch) return Promise.resolve()
    clearTimer()
    abortActive()
    const id = ++counter
    dispatch({ type: 'results.request', requestId: id })
    return new Promise((resolve) => {
      const run = async () => {
        const ac = new AbortController()
        activeAbort = ac
        try {
          const items = await producer({ signal: ac.signal })
          if (id === counter) dispatch({ type: 'results.replace', requestId: id, items: Array.isArray(items) ? items : [] })
        } catch (error) {
          if (id === counter) dispatch({ type: 'results.error', requestId: id, error: { message: messageOf(error) } })
        } finally {
          resolve(id === counter)
        }
      }
      if (debounce > 0) searchTimer = setTimeout(run, debounce)
      else run()
    })
  }

  function resolveLocal (value) {
    let inner = String(value || '').trim()
    if ((inner.startsWith('"') && inner.endsWith('"')) || (inner.startsWith("'") && inner.endsWith("'"))) {
      inner = inner.slice(1, -1)
    }
    if (inner === '~' || inner.startsWith('~/')) inner = path.join(homedir(), inner.slice(1))
    return path.resolve(cwd, inner)
  }

  async function searchProducer (query, signal) {
    const q = String(query || '').trim()
    if (isChannelUrl(q)) {
      return [{ kind: 'creator', id: `creator:${q}`, label: q, completion: q, canonicalUrl: q }]
    }
    if (isUrl(q)) return [] // non-channel URLs belong to scripted `--type video`
    if (!metadata) return []
    const results = await metadata.search(q, { signal })
    return results.map((r) => ({
      kind: r.kind,
      id: r.id,
      label: r.title,
      completion: r.title,
      title: r.title,
      year: r.year,
      mediaId: r.mediaId,
      provider: authority,
      mediaProvider: authority,
      description: r.description,
      artwork: r.artwork
    }))
  }

  // The source input always exposes the typed value as the primary (index 0)
  // candidate so Enter commits it; path entries follow for Tab autocomplete.
  async function sourceProducer (query) {
    const q = String(query || '').trim()
    if (!q) return [] // empty input: no directory dump; render prompt guides the user
    const items = []
    if (q && isUrl(q)) {
      items.push({ label: `Use URL: ${q}`, completion: q, value: q })
      return items
    }
    if (q) items.push({ label: `Use file: ${q}`, completion: q, value: resolveLocal(q) })
    try {
      const candidates = await listPathCandidates(query || '', { cwd, filesystem: fs || undefined, path, homedir })
      for (const candidate of candidates) {
        items.push({
          label: `${candidate.name}${candidate.directory ? '/' : ''}`,
          completion: candidate.completion,
          value: candidate.directory ? null : resolveLocal(candidate.completion),
          directory: candidate.directory
        })
      }
    } catch {}
    return items
  }

  function autoConfirmIf (screen) {
    if (!dispatch) return
    if (currentState && currentState.screen === screen && !currentState.result) {
      const pane = currentState.screens[screen]
      if (pane && pane.results.items.length > 0) dispatch({ type: 'step.confirm' })
    }
  }

  function onEnterScreen (state) {
    const screen = state.screen
    const choices = state.choices || {}
    const pane = state.screens[screen]
    const query = (pane && pane.input && pane.input.value) || ''

    switch (screen) {
      case 'search':
        if (isChannelUrl(query) || query.trim().length >= MIN_QUERY) {
          load(({ signal }) => searchProducer(query, signal))
        }
        break
      case 'tvSeason':
        load(async ({ signal }) => {
          show = await metadata.getShow(choices.search.mediaId, { signal })
          return (show.seasons || []).map((season) => ({
            label: season.name || `Season ${season.seasonNumber}`,
            completion: season.name || `Season ${season.seasonNumber}`,
            seasonNumber: season.seasonNumber,
            episodeCount: season.episodeCount
          }))
        })
        break
      case 'episodeSelection':
        load(async ({ signal }) => {
          const season = choices.tvSeason
          const episodes = await metadata.getSeason(choices.search.mediaId, season.seasonNumber, { signal })
          return episodes.map((episode) => ({
            label: `S${pad2(episode.seasonNumber)}E${pad2(episode.episodeNumber)} · ${episode.title}`,
            completion: episode.title,
            seasonNumber: episode.seasonNumber,
            episodeNumber: episode.episodeNumber,
            title: episode.title,
            airDate: episode.airDate,
            artwork: episode.artwork
          }))
        })
        break
      case 'creatorContent':
        load(async () => {
          const profile = await ytDlp.listProfile(choices.search.canonicalUrl, { limit: searchLimit })
          creator = profile.creator
          return (profile.items || []).map((item) => ({
            label: item.title || item.canonicalUrl,
            completion: item.canonicalUrl,
            title: item.title,
            canonicalUrl: item.canonicalUrl,
            sourceProvider: item.sourceProvider,
            sourceVideoId: item.sourceVideoId,
            thumbnail: item.thumbnail,
            sourcePublishedAt: item.sourcePublishedAt
          }))
        })
        break
      case 'creatorAttachment':
        // v1 always creates a fresh creator channel; single option, auto-advance.
        load(() => [{
          label: `Create channel for ${creator?.name || 'creator'}`,
          completion: 'new',
          mode: 'new',
          platform: creator?.platform || '',
          status: 'new'
        }]).then(() => autoConfirmIf('creatorAttachment'))
        break
      case 'movieSource':
        load(() => sourceProducer(query))
        break
      case 'sourceSelection':
        if (choices.creatorContent) {
          // The picked creator video already carries its source URL; auto-fill.
          const video = choices.creatorContent
          load(() => [{ label: `Use ${video.title || video.canonicalUrl}`, completion: video.canonicalUrl, value: video.canonicalUrl }])
            .then(() => autoConfirmIf('sourceSelection'))
        } else {
          load(() => sourceProducer(query))
        }
        break
      case 'review':
        load(() => [{ label: summarize(state.choices), completion: 'publish', value: 'publish' }])
        break
      default:
        break
    }
  }

  function summarize (choices) {
    if (choices.movieSource || choices.search?.kind === 'movie') return `Publish movie: ${choices.search?.title || 'movie'}`
    if (choices.episodes) {
      const ep = choices.episodes[0] || {}
      return `Publish ${choices.search?.title || 'show'} S${pad2(ep.seasonNumber)}E${pad2(ep.episodeNumber)}`
    }
    if (choices.creatorContent) return `Publish ${choices.creatorContent.title || 'video'}`
    return 'Publish selection'
  }

  function sourceFrom (fetchUrl, provider) {
    return { provider: provider || null, identityUrl: isUrl(fetchUrl) ? fetchUrl : null, displayUrl: fetchUrl }
  }

  function buildPlan (choices) {
    if (choices.movieSource) {
      const movie = choices.search
      const fetchUrl = choices.movieSource.value
      return {
        fetchUrl,
        channelDraft: buildMovieChannelDraft(movie),
        itemDraft: buildMovieItemDraft(movie, sourceFrom(fetchUrl), {
          mediaProvider: movie.mediaProvider || movie.provider || null,
          mediaId: movie.mediaId ?? null
        })
      }
    }
    if (choices.episodes) {
      const episode = choices.episodes[0]
      const fetchUrl = choices.sourceSelection && choices.sourceSelection.value
      const channelSource = show || choices.search
      return {
        fetchUrl,
        channelDraft: buildShowChannelDraft(channelSource),
        itemDraft: buildEpisodeItemDraft(episode, sourceFrom(fetchUrl), {
          mediaProvider: (channelSource && (channelSource.mediaProvider || channelSource.provider)) || null,
          mediaId: (channelSource && channelSource.mediaId) || null
        })
      }
    }
    if (choices.creatorContent) {
      const video = choices.creatorContent
      const fetchUrl = (choices.sourceSelection && choices.sourceSelection.value) || video.canonicalUrl
      const creatorRecord = creator || { name: video.title, platform: video.sourceProvider, canonicalUrl: video.canonicalUrl }
      return {
        fetchUrl,
        channelDraft: buildCreatorChannelDraft(creatorRecord),
        itemDraft: buildCreatorItemDraft({
          title: video.title,
          contentKind: 'video',
          sourceProvider: video.sourceProvider,
          sourceVideoId: video.sourceVideoId,
          canonicalUrl: video.canonicalUrl,
          thumbnail: video.thumbnail,
          sourcePublishedAt: video.sourcePublishedAt
        }, sourceFrom(fetchUrl, video.sourceProvider))
      }
    }
    return null
  }

  function progressEmit (message) {
    if (!dispatch) return
    const text = String(message)
    let phase = 'resolving'
    if (/download/i.test(text)) phase = 'downloading'
    else if (/upload complete|uploaded/i.test(text)) phase = 'uploaded'
    else if (/upload/i.test(text)) phase = 'uploading'
    // Guarded phases (replicationPending/projecting/announcing) require a
    // checkpoint record the reducer validates; keep updates on open phases.
    dispatch({ type: 'progress.update', progress: { phase, message: text } })
  }

  function resultMessage (outcome) {
    switch (outcome.status) {
      case 'published': return `Published ${outcome.url}`
      case 'already-exists': return `Already added (video ${outcome.videoId})`
      case 'replicationPending': return 'Saved locally — awaiting a durable peer.'
      case 'failed': return `Failed: ${outcome.error?.message || 'unknown error'}`
      default: return `Status: ${outcome.status}`
    }
  }

  async function runExecution (state) {
    let outcome
    try {
      const plan = buildPlan(state.choices)
      if (!plan || !plan.fetchUrl) throw new Error('No source selected')
      outcome = await execute(plan, progressEmit)
    } catch (error) {
      outcome = { status: 'failed', error: { message: messageOf(error) } }
    }
    if (dispatch) dispatch({ type: 'progress.complete', value: { ...outcome, message: resultMessage(outcome) } })
  }

  function onAction (action, d) {
    dispatch = d
    // Episodes render as a multi-select but no key toggles selection, so Enter
    // on a fresh list auto-selects the highlighted episode (single-episode add).
    if (action.type === 'step.confirm' && currentState && currentState.screen === 'episodeSelection') {
      const pane = currentState.screens.episodeSelection
      if (pane && pane.results.items.length > 0 && pane.selection.selected.length === 0) {
        d({ type: 'selection.toggle' })
      }
    }
  }

  function onState (state, d) {
    dispatch = d
    currentState = state
    const screen = state.screen
    const pane = state.screens[screen]
    const query = (pane && pane.input && pane.input.value) || ''

    if (screen === 'progress') {
      if (!executing) {
        executing = true
        runExecution(state)
      }
      return
    }

    if (screen !== prevScreen) {
      prevScreen = screen
      prevQuery = query
      onEnterScreen(state)
      return
    }

    if (query !== prevQuery) {
      prevQuery = query
      if (screen === 'search') {
        if (isChannelUrl(query) || query.trim().length >= MIN_QUERY) {
          load(({ signal }) => searchProducer(query, signal), { debounce: SEARCH_DEBOUNCE_MS })
        } else {
          load(() => [])
        }
      } else if ((screen === 'movieSource' || screen === 'sourceSelection') && !state.choices.creatorContent) {
        load(() => sourceProducer(query))
      }
    }
  }

  function cleanup () {
    clearTimer()
    abortActive()
  }

  return { onReady, onState, onAction, cleanup, buildPlan }
}
