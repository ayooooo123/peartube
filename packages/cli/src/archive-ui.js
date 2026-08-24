function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function renderArchiveTui(model = {}) {
  const status = model.status || {}
  // The bounded relay status keeps network at the top level and reports archive
  // work as aggregate public work; per-core publisher/bootstrap/asset counters
  // are no longer published, so the console does not pretend to know them.
  const network = status.network || {}
  const work = status.publicWork || {}
  const archiveBudget = status.budgets?.archive || {}
  const jobs = Array.isArray(model.jobs) ? model.jobs : []
  const lines = [
    'PearTube Relay Archive Console',
    '================================',
    `Peers: ${network.peers || 0}  Announcements: ${work.activeAnnouncements || 0}  Uploads: ${work.activeUploads || 0}  Archive used: ${archiveBudget.usedBytes || 0}/${archiveBudget.configuredBytes || 0} bytes`,
    '',
    'Anonymous channel archival',
    'Paste a YouTube video URL or channel URL, import into a local relay-owned channel, then Publish to network.',
    '',
    'Queue:'
  ]

  if (!jobs.length) {
    lines.push('  No archive jobs yet.')
  } else {
    for (const job of jobs) {
      lines.push(`  ${job.id}  ${job.status}  ${job.channelName || 'Anonymous Archive'}  ${job.title || ''}`)
    }
  }

  lines.push('', 'Actions:', '  Archive URL', '  Publish to network', '  Seed archived channel')
  return lines.join('\n')
}

// --- web rendering helpers ---

function initials(name) {
  const cleaned = String(name || '').replace(/^@/, '').trim()
  if (!cleaned) return '?'
  const words = cleaned.split(/[\s._-]+/).filter(Boolean)
  const letters = words.length >= 2 ? words[0][0] + words[1][0] : cleaned.slice(0, 2)
  return letters.toUpperCase()
}

function avatarHue(id) {
  let h = 0
  for (const ch of String(id || '')) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
}

function seededPercent(archived, unseeded) {
  const total = Number(archived || 0)
  if (total <= 0) return 100
  const seeded = Math.max(0, total - Number(unseeded || 0))
  return Math.round((seeded / total) * 100)
}

function classChips(c = {}) {
  const chips = []
  if (Number(c.movie) > 0) chips.push(`<span class="chip">🎬 ${escapeHtml(c.movie)}</span>`)
  if (Number(c.tv) > 0) chips.push(`<span class="chip">📺 ${escapeHtml(c.tv)}</span>`)
  return chips.join('')
}

function creatorCard(creator) {
  const archived = Number(creator.videosArchived || 0)
  const unseeded = Number(creator.videosUnseeded || 0)
  const pct = seededPercent(archived, unseeded)
  const hue = avatarHue(creator.creatorId || creator.name)
  const fullySeeded = unseeded === 0
  // A 64-character key is how a machine tells two channels apart. It told a
  // reader nothing while filling the widest line on the page.
  const named = humanName(creator.name || creator.creatorId)
  const held = archived - unseeded
  return `
    <li class="creator">
      <div class="avatar" style="background: hsl(${hue} 55% 42%)">${escapeHtml(initials(named.label))}</div>
      <div class="creator-body">
        <div class="creator-head">
          <strong>${escapeHtml(named.label)}</strong>
          ${named.shortId ? `<small class="short-id" title="Channel key starts ${escapeHtml(named.shortId)}">${escapeHtml(named.shortId)}</small>` : ''}
          ${creator.handle ? `<small>${escapeHtml(creator.handle)}</small>` : ''}
          ${classChips(creator.classification)}
        </div>
        <div class="bar" title="${escapeHtml(held)} of ${escapeHtml(archived)} backed up">
          <span class="bar-fill ${fullySeeded ? 'ok' : ''}" style="width:${pct}%"></span>
        </div>
        <div class="creator-meta">
          <span>${escapeHtml(held)} of ${escapeHtml(archived)} kept here</span>
          ${unseeded > 0
            ? `<span class="tag warn">${escapeHtml(unseeded)} still to copy</span>`
            : '<span class="tag ok">all copied</span>'}
        </div>
      </div>
    </li>`
}

function targetRow(target) {
  const archived = Number(target.videosArchived || 0)
  const unseeded = Number(target.videosUnseeded || 0)
  const pct = seededPercent(archived, unseeded)
  return `
    <li class="target">
      <div class="target-head">
        <strong>${escapeHtml(target.name || target.creatorId)}</strong>
        <span class="tag warn">${escapeHtml(unseeded)} / ${escapeHtml(archived)} unseeded</span>
      </div>
      <div class="bar"><span class="bar-fill warn" style="width:${pct}%"></span></div>
    </li>`
}

// One line per attempt: what was being added, where it came from, and - when it
// did not work - what to do about it. The job id is a handle for a support
// conversation, not the subject of the row, so it sits on hover.
function jobRow(job) {
  const title = String(job.title || 'Untitled archive')
  const named = humanName(job.channelName, 'Anonymous archive')
  const reason = friendlyJobError(job.error)
  // A relay that publishes one channel per title repeats itself on every row.
  // The channel is worth a line only when it says something the title did not.
  const channelLine = named.label && named.label !== title ? named.label : ''
  return `
    <li class="job">
      <span class="pill ${escapeHtml(job.status)}">${escapeHtml(job.status)}</span>
      <div class="job-body">
        <strong title="${escapeHtml(job.id || '')}">${escapeHtml(title)}</strong>
        ${channelLine ? `<small>${escapeHtml(channelLine)}</small>` : ''}
        ${reason ? `<p class="job-reason" title="${escapeHtml(job.error || '')}">${reason}</p>` : ''}
      </div>
    </li>`
}


function tmdbPosterUrl(path) {
  return path ? `https://image.tmdb.org/t/p/w342${path}` : ''
}


function normalizeTmdbEpisodePart(value) {
  const n = Number(value || 0)
  return Number.isFinite(n) && n > 0 ? n : null
}

function tmdbSourceVideoId(item = {}) {
  if (!item.type || !item.tmdbId) return ''
  const type = item.type === 'tv' ? 'tv' : 'movie'
  const season = normalizeTmdbEpisodePart(item.season)
  const episode = normalizeTmdbEpisodePart(item.episode)
  const suffix = type === 'tv' && season && episode ? `:s${season}:e${episode}` : ''
  return `tmdb:${type}:${item.tmdbId}${suffix}`
}

function discoverCard(item) {
  const poster = tmdbPosterUrl(item.posterPath)
  const status = item.networkStatus || 'missing'
  const statusLabel = status === 'seeding'
    ? `Seeding${item.seededCopies ? ` · ${item.seededCopies}` : ''}`
    : (status === 'in-network' ? `In network · ${item.networkCopies || 1}` : 'Missing')
  const typeLabel = item.type === 'tv' ? 'TV' : 'Movie'
  const episodeLabel = item.type === 'tv' && item.season && item.episode ? ` · S${item.season} E${item.episode}` : ''
  const title = item.title || 'Untitled'
  const year = item.year ? ` (${item.year})` : ''
  return `
    <article class="discover-item">
      <div class="poster ${poster ? '' : 'empty-poster'}">
        ${poster ? `<img src="${escapeHtml(poster)}" alt="${escapeHtml(title)} poster" loading="lazy">` : '<span>No poster</span>'}
        <span class="status ${escapeHtml(status)}">${escapeHtml(statusLabel)}</span>
      </div>
      <div class="discover-copy">
        <div class="discover-title"><strong>${escapeHtml(title)}${escapeHtml(year)}</strong><span>${escapeHtml(typeLabel)}${escapeHtml(episodeLabel)}</span></div>
        <p>${escapeHtml(item.overview || 'No overview from TMDB.')}</p>
        <form method="post" action="/discover/archive" class="discover-archive" enctype="multipart/form-data">
          <input type="hidden" name="tmdbType" value="${escapeHtml(item.type)}">
          <input type="hidden" name="tmdbId" value="${escapeHtml(item.tmdbId)}">
          <input type="hidden" name="tmdbTitle" value="${escapeHtml(title)}">
          <input type="hidden" name="tmdbYear" value="${escapeHtml(item.year || '')}">
          ${item.type === 'tv'
            ? `<label class="ep-field">Season<select name="tmdbSeason" class="js-season" data-tmdbid="${escapeHtml(item.tmdbId)}"><option value="">Loading seasons…</option></select></label>
          <label class="ep-field">Episode<select name="tmdbEpisode" class="js-episode"><option value="">Choose a season first</option></select></label>`
            : `<input type="hidden" name="tmdbSeason" value="">
          <input type="hidden" name="tmdbEpisode" value="">`}
          <input type="hidden" name="tmdbPosterPath" value="${escapeHtml(item.posterPath || '')}">
          <input type="hidden" name="tmdbOverview" value="${escapeHtml(item.overview || '')}">
          <input type="hidden" name="tmdbGenres" value="${escapeHtml(Array.isArray(item.genres) ? item.genres.join(',') : '')}">
          <input type="hidden" name="sourceType" value="tmdb">
          <input type="hidden" name="sourceVideoId" value="${item.type === 'tv' ? '' : escapeHtml(tmdbSourceVideoId(item))}">
          <input type="hidden" name="channelName" value="${escapeHtml(title)}">
          <input type="hidden" name="title" value="${escapeHtml(title)}" class="js-title" data-show="${escapeHtml(title)}">
          <label>Source URL<input name="url" placeholder="Paste a YouTube/Rumble/source URL for this exact title"></label>
          <label>Or upload a video file<input type="file" name="file" accept="video/*"></label>
          <button type="submit">Archive this title</button>
        </form>
      </div>
    </article>`
}

function deviceRow(client) {
  return `
    <li class="device">
      <div class="device-body">
        <strong>${escapeHtml(client.label || 'Device')}</strong>
        <code>${escapeHtml(client.key)}</code>
      </div>
      <form method="post" action="/clients/revoke">
        <input type="hidden" name="key" value="${escapeHtml(client.key)}">
        <button type="submit" class="ghost">Revoke</button>
      </form>
    </li>`
}

// What a relay can honestly say about a show: which seasons of it are here and
// how many episodes, counted from the coordinates each publisher signed. How
// many episodes the season actually has is a fact about the show, not about
// this relay, and nothing here knows it - so it is not implied.
function heldEpisodesLabel(item = {}) {
  const seasons = Array.isArray(item.seasonNumbers) ? item.seasonNumbers.filter((season) => Number(season) > 0) : []
  const episodes = Number(item.episodeCount) || 0
  if (episodes < 1) return 'Series'
  const counted = `${escapeHtml(episodes)} episode${episodes === 1 ? '' : 's'}`
  if (seasons.length === 1) return `Season ${escapeHtml(seasons[0])} &middot; ${counted}`
  if (seasons.length > 1) {
    const span = seasons.length === seasons[seasons.length - 1] - seasons[0] + 1
      ? `Seasons ${escapeHtml(seasons[0])}&ndash;${escapeHtml(seasons[seasons.length - 1])}`
      : `${escapeHtml(seasons.length)} seasons`
    return `${span} &middot; ${counted}`
  }
  return counted
}

// A viewer's shelf, not an operator's inventory: a cover, the name of the film
// or show, what kind of thing it is, and one sentence about whether it is safe.
// Nothing here renders an id, a key, or a hash - those name machines, and a
// person reading this page is choosing something to watch.
function libraryCard(item = {}) {
  const title = String(item.title || 'Untitled')
  const kind = typeof item.kind === 'string' ? item.kind : ''
  const isSeries = kind === 'series' || kind === 'show' || kind === 'episode'
  const facts = []
  // A show is named by what of it is actually here. A film is named by its
  // year and length. Neither has a "channel" - that belongs to creator
  // uploads, and it is shown only where one actually exists.
  if (isSeries) {
    facts.push(heldEpisodesLabel(item))
  } else if (Number(item.year) > 0) {
    facts.push(escapeHtml(item.year))
  }
  if (Number(item.runtimeMinutes) > 0 && !isSeries) facts.push(`${escapeHtml(item.runtimeMinutes)} min`)
  if (Number(item.sizeBytes) > 0) facts.push(escapeHtml(formatSize(item.sizeBytes)))
  const genres = Array.isArray(item.genres) ? item.genres.slice(0, 3) : []
  const status = item.status || {}
  const state = typeof status.state === 'string' ? status.state : 'waiting'
  // The initial is always painted, and a cover is layered over it when one
  // exists. `hasPoster` means the publisher signed cover art, not that its
  // bytes are on this relay yet - resolving that for real costs a replication
  // attempt per title, which no page render should wait on - so the request can
  // still 404. A failed <img alt=""> paints nothing, which leaves the letter
  // showing instead of a broken-image icon, and needs no script to do it.
  const poster = item.hasPoster && item.entityId
    ? `<img class="lib-poster" src="/poster/${encodeURIComponent(item.entityId)}" alt="" loading="lazy">`
    : ''

  return `<article class="title-card">
      <div class="poster-wrap">
        <div class="lib-poster-blank" aria-hidden="true">${escapeHtml(title.trim().charAt(0).toUpperCase() || '?')}</div>
        ${poster}
        <span class="seed-chip seed-${escapeHtml(state)}">${escapeHtml(status.label || 'Waiting for a backup')}</span>
      </div>
      <div class="title-body">
        <h3>${escapeHtml(title)}</h3>
        ${item.channelName ? `<p class="by">${escapeHtml(item.channelName)}</p>` : ''}
        ${facts.length ? `<p class="facts">${facts.join(' &middot; ')}</p>` : ''}
        ${genres.length ? `<p class="genres">${genres.map(genre => `<span class="chip">${escapeHtml(genre)}</span>`).join('')}</p>` : ''}
        ${item.overview ? `<p class="overview">${escapeHtml(item.overview)}</p>` : ''}
        ${status.detail ? `<p class="seed-detail">${escapeHtml(status.detail)}</p>` : ''}
      </div>
    </article>`
}

// Sizes are for a person deciding whether something is worth keeping, so one
// decimal past a gigabyte and none below it.
function formatSize(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return ''
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`
  if (value >= 1024 ** 2) return `${Math.round(value / 1024 ** 2)} MB`
  return `${Math.max(1, Math.round(value / 1024))} KB`
}

// How full the relay is, in the units a person deciding whether to add
// something thinks in. The limit is the one the relay actually enforces, so
// this is the number that decides whether the next title is accepted.
function describeStorage(storage = {}) {
  const used = Number(storage.totalStorageBytes)
  const max = Number(storage.maxBytes)
  if (!Number.isFinite(used) || used < 0) {
    return { label: '--', title: 'This relay could not measure its own storage', near: false, pct: 0 }
  }
  const usedLabel = formatSize(used) || '0 KB'
  if (!Number.isFinite(max) || max <= 0) {
    return { label: usedLabel, title: `${usedLabel} stored, no limit set`, near: false, pct: 0 }
  }
  const pct = Math.min(100, Math.round((used / max) * 100))
  // Both numbers, because the used figure only means something against the
  // limit that refuses the next title.
  return {
    label: `${usedLabel} / ${formatSize(max)}`,
    title: `${pct}% of this relay's ${formatSize(max)} limit. At the limit it stops accepting new titles.`,
    near: pct >= 85,
    pct
  }
}

// Channels created for an anonymous archive are named by their key, which is
// how a machine tells them apart and no help at all to a reader. A name that
// is only an identifier is replaced by what it is, with a short prefix kept so
// two of them can still be told apart.
const MACHINE_NAME = /^(?:channel:)?[0-9a-f]{16,}$/i

function humanName(name, fallback = 'Anonymous archive') {
  const value = String(name || '').trim()
  if (!value) return { label: fallback, shortId: '' }
  if (!MACHINE_NAME.test(value)) return { label: value, shortId: '' }
  const hex = value.replace(/^channel:/i, '')
  return { label: fallback, shortId: hex.slice(0, 6) }
}

// Why a job failed, said the way an operator can act on. The underlying errors
// name byte counts and internal stages; those stay available on hover rather
// than leading the row.
function friendlyJobError(error) {
  const raw = String(error || '').trim()
  if (!raw) return ''
  if (/storage headroom|storage threshold/i.test(raw)) {
    return 'No room left under this relay&rsquo;s storage limit. Free space or raise the limit, then try again.'
  }
  if (/free disk|ENOSPC/i.test(raw)) return 'The disk is full.'
  if (/timed out|ETIMEDOUT|timeout/i.test(raw)) return 'The source stopped responding.'
  if (/404|not found/i.test(raw)) return 'The source is no longer there.'
  if (/403|401|forbidden|unauthorized/i.test(raw)) return 'The source refused this relay.'
  if (/unsupported|no video/i.test(raw)) return 'Nothing playable was found at that address.'
  return raw
}

export function renderArchiveWebHome(model = {}) {
  const status = model.status || {}
  // The bounded relay status reports network at the top level and disk use as
  // the catalog summary plus the archive budget, so the header reads real
  // numbers instead of a `storage` block the relay no longer publishes.
  const network = status.network || {}
  const storage = {
    totalStorageBytes: status.summary?.usedBytes,
    maxBytes: status.budgets?.archive?.configuredBytes
  }
  const jobs = Array.isArray(model.jobs) ? model.jobs : []
  const library = Array.isArray(model.library) ? model.library : []
  const creators = Array.isArray(model.creators) ? model.creators : []
  const unseededTargets = Array.isArray(model.unseededTargets) ? model.unseededTargets : []
  const tmdb = model.tmdb || {}
  const s3 = model.s3 || {}
  // Offload is what makes a bucket load bearing for playback, so it reads as
  // its own line rather than as another field of the connection details.
  const offloadState = s3.offload || {}
  const offload = {
    enabled: offloadState.enabled === true,
    windowBytes: Number(offloadState.windowBytes) || 0,
    blocksOffloaded: Number(offloadState.blocksOffloaded) || 0,
    uploadedBlocks: Number(offloadState.uploadedBlocks) || 0,
    uploadedBytes: Number(offloadState.uploadedBytes) || 0,
    bytesOffloaded: Number(offloadState.bytesOffloaded) || 0,
    restored: Number(offloadState.restored) || 0,
    residentBytes: Number(offloadState.residentBytes) || 0
  }
  // With offload on, what this relay can still take is bounded by the archive
  // budget rather than by the volume, so the panel reports that number next to
  // the residency it is actually paying for locally.
  const capacity = status.capacity || {}
  const discover = model.discover || { type: 'movie', query: '', items: [] }
  const discoverItems = Array.isArray(discover.items) ? discover.items : []
  const trustedClients = Array.isArray(model.trustedClients) ? model.trustedClients : []
  const link = model.link || {}
  const publicBaseUrl = typeof model.publicBaseUrl === 'string' ? model.publicBaseUrl : ''
  const catalogUrl = publicBaseUrl ? `${publicBaseUrl.replace(/\/$/, '')}/catalog.json` : '/catalog.json'

  const totalUnseeded = creators.reduce((sum, c) => sum + (Number(c.videosUnseeded) || 0), 0)
  const totalArchived = creators.reduce((sum, c) => sum + (Number(c.videosArchived) || 0), 0)
  const storageUse = describeStorage(storage)

  const libraryCards = library.length
    ? library.map(libraryCard).join('')
    : '<div class="empty">Nothing here yet. Anything added from a connected app or the form below shows up here with its cover.</div>'

  const creatorRows = creators.length
    ? creators.map(creatorCard).join('')
    : '<li class="empty">No creators tracked yet. Add one in the sidebar, or archive a video.</li>'

  const targetRows = unseededTargets.length
    ? unseededTargets.map(targetRow).join('')
    : '<li class="empty">Every tracked video has a copy here.</li>'

  // The queue is a log, and a log's job is to answer "did that work?" first.
  // Twenty rows of the same retried title buried the four that failed, so the
  // counts lead and the list is capped at what a person will actually read.
  const JOB_ROW_LIMIT = 12
  const jobCounts = jobs.reduce((counts, job) => {
    const key = job?.status === 'completed' || job?.status === 'failed' ? job.status : 'working'
    counts[key] = (counts[key] || 0) + 1
    return counts
  }, {})
  const jobSummary = jobs.length
    ? [
      jobCounts.completed ? `${jobCounts.completed} added` : '',
      jobCounts.working ? `${jobCounts.working} in progress` : '',
      jobCounts.failed ? `${jobCounts.failed} failed` : ''
    ].filter(Boolean).join(' &middot; ')
    : ''
  const jobRows = jobs.length
    ? jobs.slice(0, JOB_ROW_LIMIT).map(jobRow).join('') +
      (jobs.length > JOB_ROW_LIMIT
        ? `<li class="empty">${escapeHtml(jobs.length - JOB_ROW_LIMIT)} older attempts not shown.</li>`
        : '')
    : '<li class="empty">No archive jobs yet.</li>'

  const deviceRows = trustedClients.length
    ? trustedClients.map(deviceRow).join('')
    : '<li class="empty">No linked devices yet.</li>'

  const discoverRows = discoverItems.length
    ? discoverItems.map(discoverCard).join('')
    : '<div class="empty">Add a TMDB key, then search or use trending to find missing movies and shows.</div>'

  const tmdbState = tmdb.enabled ? 'enabled' : (tmdb.hasKey ? 'key set, disabled' : 'no key')

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PearTube Relay</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #07080c; --panel: rgba(17,21,33,0.72); --line: rgba(255,255,255,0.10);
      --ink: #f5f7fb; --muted: #97a2b8; --mint: #9effd0; --warn: #ff7a7a; --ok: #5dffb0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: radial-gradient(1200px 600px at 15% -5%, #16284d 0, var(--bg) 55%); color: var(--ink); min-height: 100vh; }
    a { color: var(--mint); text-decoration: none; }
    code { color: #9fb0cc; word-break: break-all; font-size: 12px; }
    h1, h2 { letter-spacing: -0.02em; }
    /* top bar */
    header { position: sticky; top: 0; z-index: 10; backdrop-filter: blur(12px);
      background: rgba(7,8,12,0.78); border-bottom: 1px solid var(--line); }
    .bar-inner { max-width: 1180px; margin: 0 auto; padding: 14px 20px; display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
    .brand { font-weight: 850; font-size: 18px; display: flex; align-items: center; gap: 9px; }
    .brand .dot { width: 11px; height: 11px; border-radius: 50%; background: var(--mint); box-shadow: 0 0 16px var(--mint); }
    nav { display: flex; gap: 4px; flex-wrap: wrap; }
    nav a { color: var(--muted); padding: 6px 11px; border-radius: 999px; font-weight: 600; font-size: 14px; }
    nav a:hover { color: var(--ink); background: rgba(255,255,255,0.06); }
    .spacer { flex: 1; }
    .stat-pills { display: flex; gap: 8px; flex-wrap: wrap; }
    .spill { display: flex; flex-direction: column; align-items: flex-end; padding: 5px 12px; border: 1px solid var(--line); border-radius: 12px; background: rgba(255,255,255,0.03); }
    .spill b { font-size: 17px; line-height: 1; }
    .spill span { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
    .spill.alert b { color: var(--warn); }
    /* layout */
    main { max-width: 1180px; margin: 0 auto; padding: 26px 20px 90px; }
    .layout { display: grid; grid-template-columns: 1fr; gap: 18px; }
    @media (min-width: 940px) { .layout { grid-template-columns: 1.65fr 1fr; align-items: start; } }
    .col { display: grid; gap: 18px; }
    .card { border: 1px solid var(--line); background: var(--panel); border-radius: 18px; padding: 20px; box-shadow: 0 24px 80px rgba(0,0,0,0.28); }
    .card h2 { margin: 0 0 4px; font-size: 20px; }
    .card .sub { margin: 0 0 16px; color: var(--muted); font-size: 14px; line-height: 1.5; }
    ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
    .empty { color: var(--muted); padding: 10px 0; }
    /* forms */
    form { display: grid; gap: 13px; }
    label { display: grid; gap: 6px; color: #cdd6e8; font-weight: 650; font-size: 14px; }
    .check { display: flex; flex-direction: row; align-items: center; gap: 9px; }
    input, textarea { width: 100%; border: 1px solid var(--line); background: #0b0f19; color: var(--ink); border-radius: 11px; padding: 11px 12px; font: inherit; }
    input:focus, textarea:focus { outline: none; border-color: rgba(158,255,208,0.5); }
    input[type=checkbox] { width: auto; }
    button { justify-self: start; border: 0; border-radius: 999px; padding: 11px 18px; color: #04130c; background: var(--mint); font-weight: 800; cursor: pointer; }
    button:hover { filter: brightness(1.07); }
    button.ghost { background: transparent; color: var(--warn); border: 1px solid var(--line); padding: 6px 13px; font-weight: 700; }
    /* library: the shelf a viewer reads, so the poster leads and the status is a
       sentence rather than a counter */
    .library-grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
    .title-card { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
    .poster-wrap { position: relative; border-radius: 14px; overflow: hidden; border: 1px solid var(--line);
      background: #0b0f19; aspect-ratio: 2 / 3; box-shadow: 0 18px 44px rgba(0,0,0,0.36); }
    .lib-poster { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
    .lib-poster-blank { position: absolute; inset: 0; display: grid; place-items: center; font-size: 44px; font-weight: 800; color: rgba(255,255,255,0.16); }
    .seed-chip { position: absolute; left: 8px; bottom: 8px; right: 8px; padding: 5px 9px; border-radius: 9px;
      font-size: 11px; font-weight: 750; letter-spacing: 0.01em; backdrop-filter: blur(8px);
      background: rgba(7,8,12,0.72); border: 1px solid var(--line); color: var(--ink);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .seed-mirrored { color: #04130c; background: var(--ok); border-color: transparent; }
    .seed-stored { color: var(--mint); }
    .seed-publishing { color: #ffd88a; }
    .seed-failed { color: var(--warn); }
    .title-body { min-width: 0; }
    .title-body h3 { margin: 0; font-size: 15px; line-height: 1.3; letter-spacing: -0.01em; }
    .title-body .by { margin: 3px 0 0; font-size: 12px; color: var(--mint); font-weight: 650;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .title-body .facts { margin: 4px 0 0; font-size: 12px; color: var(--muted); }
    .title-body .genres { margin: 7px 0 0; display: flex; gap: 5px; flex-wrap: wrap; }
    .title-body .overview { margin: 7px 0 0; font-size: 12px; line-height: 1.5; color: #b9c3d6;
      display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    .title-body .seed-detail { margin: 7px 0 0; font-size: 11px; color: var(--muted); }
    /* creators */
    .creator { display: flex; gap: 13px; padding: 14px 0; border-top: 1px solid var(--line); }
    .creator:first-child { border-top: 0; padding-top: 2px; }
    .avatar { flex: 0 0 42px; height: 42px; border-radius: 12px; display: grid; place-items: center; font-weight: 800; font-size: 15px; color: #fff; }
    .creator-body { flex: 1; min-width: 0; }
    .creator-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 9px; }
    .creator-head small { color: var(--muted); }
    .creator-meta { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 7px; font-size: 13px; color: var(--muted); }
    .bar { height: 8px; border-radius: 999px; background: rgba(255,122,122,0.22); overflow: hidden; }
    .bar-fill { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, #58e6ff, var(--mint)); }
    .bar-fill.ok { background: var(--ok); }
    .bar-fill.warn { background: linear-gradient(90deg, var(--mint), #58e6ff); }
    .tag { font-size: 12px; font-weight: 700; padding: 3px 9px; border-radius: 999px; }
    .tag.warn { background: rgba(255,122,122,0.16); color: #ffb0b0; }
    .tag.ok { background: rgba(93,255,176,0.15); color: var(--ok); }
    .chip { font-size: 12px; color: #cdd6e8; background: rgba(255,255,255,0.07); border-radius: 999px; padding: 2px 9px; }
    /* targets */
    .target { padding: 12px 0; border-top: 1px solid var(--line); display: grid; gap: 9px; }
    .target:first-child { border-top: 0; }
    .target-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    /* jobs */
    .job { display: flex; gap: 12px; padding: 12px 0; border-top: 1px solid var(--line); align-items: flex-start; }
    .job:first-child { border-top: 0; }
    .job-body { display: grid; gap: 3px; }
    .job-body small { color: var(--muted); font-size: 12px; }
    .job-reason { margin: 3px 0 0; font-size: 12.5px; color: #ffc9c9; line-height: 1.45; }
    .short-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--muted); opacity: 0.75; }
    .pill { flex: 0 0 auto; border-radius: 999px; padding: 3px 10px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em; font-weight: 800; background: rgba(255,255,255,0.1); color: #dce5f8; }
    .pill.completed { background: rgba(93,255,176,0.17); color: var(--ok); }
    .pill.failed { background: rgba(255,122,122,0.18); color: #ffb0b0; }
    .pill.running { background: rgba(91,176,255,0.2); color: #bcdcff; }
    /* devices */
    .device { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0; border-top: 1px solid var(--line); }
    .device:first-child { border-top: 0; }
    .device-body { display: grid; gap: 3px; min-width: 0; }
    .device form { margin: 0; }
    .mono-key { display: block; margin-top: 8px; padding: 9px 11px; border: 1px solid var(--line); border-radius: 10px; background: #0b0f19; }
    .note { color: var(--muted); font-size: 12px; margin: 12px 0 0; }
    .notice { margin: 0 0 16px; padding: 12px 16px; border-radius: 8px; border: 1px solid #b45309; background: #78350f; color: #fef3c7; font-size: 14px; }
    .status-line { font-weight: 700; }
    .status-line.on { color: var(--ok); }
    /* discover */
    .discover-toolbar { display: grid; gap: 10px; grid-template-columns: 1fr; margin-bottom: 16px; }
    @media (min-width: 720px) { .discover-toolbar { grid-template-columns: 1fr 140px auto; align-items: end; } }
    select { width: 100%; border: 1px solid var(--line); background: #0b0f19; color: var(--ink); border-radius: 11px; padding: 11px 12px; font: inherit; }
    .discover-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }
    .discover-item { border: 1px solid var(--line); border-radius: 16px; overflow: hidden; background: rgba(255,255,255,0.035); }
    .poster { position: relative; aspect-ratio: 2 / 3; background: #101725; display: grid; place-items: center; color: var(--muted); }
    .poster img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .status { position: absolute; left: 10px; top: 10px; border-radius: 999px; padding: 4px 9px; font-size: 11px; font-weight: 850; background: rgba(0,0,0,0.68); border: 1px solid rgba(255,255,255,0.12); }
    .status.seeding { color: var(--ok); }
    .status.in-network { color: #bcdcff; }
    .status.missing { color: #ffb0b0; }
    .discover-copy { padding: 13px; display: grid; gap: 10px; }
    .discover-title { display: flex; gap: 8px; justify-content: space-between; align-items: baseline; }
    .discover-title span { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; }
    .discover-copy p { color: var(--muted); font-size: 13px; line-height: 1.45; margin: 0; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
    .discover-archive { gap: 9px; }
    .discover-archive button { padding: 9px 14px; }
  </style>
</head>
<body>
  <header>
    <div class="bar-inner">
      <div class="brand"><span class="dot"></span> PearTube Relay</div>
      <nav>
        <a href="#library">Library</a>
        <a href="#discover">Discover</a>
        <a href="#creators">Creators</a>
        <a href="#targets">Targets</a>
        <a href="#devices">Devices</a>
        <a href="#archive">Archive</a>
      </nav>
      <span class="spacer"></span>
      <div class="stat-pills">
        <div class="spill"><b>${escapeHtml(library.length)}</b><span>Titles</span></div>
        <div class="spill"><b>${escapeHtml(network.peers || 0)}</b><span>Peers</span></div>
        <div class="spill ${storageUse.near ? 'alert' : ''}" title="${escapeHtml(storageUse.title)}"><b>${escapeHtml(storageUse.label)}</b><span>Stored</span></div>
        <div class="spill"><b>${escapeHtml(creators.length)}</b><span>Creators</span></div>
        <div class="spill ${totalUnseeded > 0 ? 'alert' : ''}"><b>${escapeHtml(totalUnseeded)}</b><span>Unseeded</span></div>
      </div>
    </div>
  </header>
  <main>
    ${model.notice ? `<p class="notice" role="status">${escapeHtml(model.notice)}</p>` : ''}
    <div class="layout">
      <div class="col">
        <section class="card" id="library">
          <h2>Library</h2>
          <p class="sub">Everything this relay is keeping, with a cover and how safe each title is. A backup means another device holds a full copy and has proved it.</p>
          <div class="library-grid">${libraryCards}</div>
        </section>
        <section class="card" id="discover">
          <h2>Discover missing movies &amp; shows</h2>
          <p class="sub">TMDB-powered catalog view for your relay. Cards show whether a title is already seeding, merely known to the network, or missing. TMDB supplies metadata only; paste a source URL to archive the bytes.</p>
          <form method="get" action="/" class="discover-toolbar">
            <label>Search TMDB<input name="q" value="${escapeHtml(discover.query || '')}" placeholder="Trending if blank, e.g. Severance"></label>
            <label>Type<select name="type"><option value="movie" ${discover.type !== 'tv' ? 'selected' : ''}>Movies</option><option value="tv" ${discover.type === 'tv' ? 'selected' : ''}>TV</option></select></label>
            <button type="submit">Search</button>
          </form>
          <div class="discover-grid">${discoverRows}</div>
          <p class="note"><a href="/discover.json?type=${escapeHtml(discover.type || 'movie')}&amp;q=${escapeHtml(discover.query || '')}">Open Discover JSON</a></p>
        </section>

        <section class="card" id="creators">
          <h2>Tracked creators</h2>
          <p class="sub">Everyone whose content this relay holds, with how much of it is seeded. ${escapeHtml(totalArchived)} videos across ${escapeHtml(creators.length)} creators.</p>
          <ul>${creatorRows}</ul>
        </section>

        <section class="card" id="targets">
          <h2>Unseeded targets</h2>
          <p class="sub">Creators with the most under-replicated content — seed these first to maximise availability.</p>
          <ul>${targetRows}</ul>
        </section>

        <section class="card">
          <h2>Recent additions</h2>
          <p class="sub">${jobSummary ? `${jobSummary}. ` : ''}Every attempt to add something to this relay. Source addresses stay on this machine; only the title and its metadata are published.</p>
          <ul>${jobRows}</ul>
        </section>
      </div>

      <div class="col">
        <section class="card" id="archive">
          <h2>Contribute a creator</h2>
          <p class="sub">Paste a creator's channel or video URL (YouTube or Rumble). The relay registers them in its creators database, archives the content, and keeps tracking how many of their videos still need a seeder.</p>
          <form method="post" action="/creators">
            <label>Creator channel or video URL<input name="url" required placeholder="https://www.youtube.com/@channel"></label>
            <label>Display name (optional)<input name="label" placeholder="e.g. My Favourite Channel"></label>
            <label class="check"><input type="checkbox" name="publish" value="true" checked> Publish to network after import</label>
            <button type="submit">Add creator &amp; archive</button>
          </form>
        </section>

        <section class="card">
          <h2>Archive a single video</h2>
          <p class="sub">Import one video into a relay-owned anonymous channel and publish availability to the network. Paste a <strong>direct link to the video file</strong> or upload one from this device. For a YouTube/Rumble creator, use <em>Contribute a creator</em> above.</p>
          <form method="post" action="/archive" enctype="multipart/form-data">
            <label>Direct video URL<input name="url" placeholder="https://host/path/video.mp4"></label>
            <label>Or upload a video file<input type="file" name="file" accept="video/*"></label>
            <label>Anonymous channel name<input name="channelName" value="Anonymous Archive"></label>
            <label>Title override<input name="title" placeholder="Optional"></label>
            <label>Description override<textarea name="description" rows="3" placeholder="Optional"></textarea></label>
            <label class="check"><input type="checkbox" name="publish" value="true" checked> Publish to network after import</label>
            <button type="submit">Archive and publish</button>
          </form>
        </section>

        <section class="card" id="devices">
          <h2>Authorized creator devices</h2>
          <p class="sub">Authorize a creator's public device key for bounded catalog publication and seed retention. Secret keys and transport identifiers are never accepted.</p>
          <p class="note">Seed retention is ${link.seedPin?.enabled ? 'enabled' : 'disabled'}; ${Number(link.seedPin?.authorizedClients || 0)} client(s) authorized.</p>
          <form method="post" action="/clients" style="margin-top:14px">
            <label>Creator device key<input name="key" required placeholder="64-character hex device key"></label>
            <label>Device label (optional)<input name="label" placeholder="e.g. Alice's phone"></label>
            <button type="submit">Authorize device</button>
          </form>
          <ul style="margin-top:14px">${deviceRows}</ul>
          <p class="note">New authorizations take effect when the relay next starts.</p>
        </section>

        <section class="card">
          <h2>Content classification (TMDB)</h2>
          <p class="sub">Add a <a href="https://www.themoviedb.org/settings/api">TMDB API key</a> to automatically identify archived movies and TV shows. Status: <span class="status-line ${tmdb.enabled ? 'on' : ''}">${escapeHtml(tmdbState)}</span>.</p>
          <form method="post" action="/settings/tmdb">
            <label>TMDB API key<input name="apiKey" type="password" placeholder="${tmdb.hasKey ? '•••••••• (set)' : 'Paste TMDB v3 API key'}"></label>
            <label class="check"><input type="checkbox" name="enabled" value="true" ${tmdb.enabled ? 'checked' : ''}> Enable classification</label>
            <button type="submit">Save TMDB settings</button>
          </form>
        </section>
        <section class="card">
          <h2>S3 archive provider</h2>
          <p class="sub">Read-only status. Configure S3 with Docker environment variables, then restart the relay.</p>
          <p class="note">Status: <span class="status-line ${s3.configured ? 'on' : ''}">${s3.configured ? 'configured' : 'not configured'}</span></p>
          ${s3.configured ? `<p class="note">Endpoint: ${escapeHtml(s3.endpoint)}<br>Bucket: ${escapeHtml(s3.bucket)}<br>Region: ${escapeHtml(s3.region)}<br>Prefix: ${escapeHtml(s3.prefix || '(none)')}</p>` : ''}
          <p class="note">Block offload: <span class="status-line ${offload.enabled ? 'on' : ''}">${offload.enabled ? 'enabled' : 'disabled'}</span></p>
          ${offload.enabled ? `<p class="note">Resident window: ${escapeHtml(formatSize(offload.windowBytes) || '0 KB')}<br>Written to the store: ${escapeHtml(String(offload.uploadedBlocks))} block(s), ${escapeHtml(formatSize(offload.uploadedBytes) || '0 KB')} (includes staging copies later purged)<br>Offloaded: ${escapeHtml(String(offload.blocksOffloaded))} block(s), ${escapeHtml(formatSize(offload.bytesOffloaded) || '0 KB')}<br>Restored on read: ${escapeHtml(String(offload.restored))} block(s)<br>Held on this volume: ${escapeHtml(formatSize(offload.residentBytes) || '0 KB')}<br>Room left: ${escapeHtml(formatSize(capacity.effectiveCapacityBytes) || 'unmeasured')} of archive budget, not of this disk</p>` : '<p class="note">Media block data stays on this relay\'s volume.</p>'}
        </section>

        <section class="card">
          <h2>Simple relay catalog</h2>
          <p class="sub">Fallback JSON catalog for clients that can't reach live P2P gossip.</p>
          <code class="mono-key"><a href="${escapeHtml(catalogUrl)}">${escapeHtml(catalogUrl)}</a></code>
        </section>
      </div>
    </div>
  </main>
  <script>
  (function () {
    function opt (value, label) { var o = document.createElement('option'); o.value = value; o.textContent = label; return o; }
    function pad (n) { n = String(n); return n.length < 2 ? '0' + n : n; }
    async function loadSeasons (sel) {
      var tmdbId = sel.getAttribute('data-tmdbid');
      try {
        var res = await fetch('/discover/seasons.json?tmdbId=' + encodeURIComponent(tmdbId));
        var data = await res.json();
        sel.innerHTML = '';
        sel.appendChild(opt('', 'Select season'));
        (data.seasons || []).forEach(function (s) {
          sel.appendChild(opt(String(s.season), (s.name || ('Season ' + s.season)) + ' (' + s.episodeCount + ' eps)'));
        });
      } catch (e) { sel.innerHTML = ''; sel.appendChild(opt('', 'Seasons unavailable')); }
    }
    async function loadEpisodes (seasonSel) {
      var form = seasonSel.closest('form');
      var epSel = form.querySelector('.js-episode');
      var tmdbId = seasonSel.getAttribute('data-tmdbid');
      var season = seasonSel.value;
      epSel.innerHTML = ''; epSel.appendChild(opt('', 'Loading episodes'));
      if (!season) { epSel.innerHTML = ''; epSel.appendChild(opt('', 'Choose a season first')); return; }
      try {
        var res = await fetch('/discover/episodes.json?tmdbId=' + encodeURIComponent(tmdbId) + '&season=' + encodeURIComponent(season));
        var data = await res.json();
        epSel.innerHTML = ''; epSel.appendChild(opt('', 'Select episode'));
        (data.episodes || []).forEach(function (ep) {
          epSel.appendChild(opt(String(ep.episode), 'E' + ep.episode + (ep.title ? ' - ' + ep.title : '')));
        });
        epSel._episodes = data.episodes || [];
      } catch (e) { epSel.innerHTML = ''; epSel.appendChild(opt('', 'Episodes unavailable')); }
    }
    function updateTitle (form) {
      var titleInput = form.querySelector('.js-title');
      if (!titleInput) return;
      var show = titleInput.getAttribute('data-show') || '';
      var seasonSel = form.querySelector('.js-season');
      var epSel = form.querySelector('.js-episode');
      if (!seasonSel || !epSel || !seasonSel.value || !epSel.value) { titleInput.value = show; return; }
      var epName = '';
      if (epSel._episodes) {
        var m = epSel._episodes.find(function (x) { return String(x.episode) === String(epSel.value); });
        if (m && m.title) epName = ' ' + m.title;
      }
      titleInput.value = show + ' S' + pad(seasonSel.value) + 'E' + pad(epSel.value) + epName;
    }
    document.querySelectorAll('select.js-season').forEach(function (sel) {
      loadSeasons(sel);
      sel.addEventListener('change', function () { loadEpisodes(sel).then(function () { updateTitle(sel.closest('form')); }); });
    });
    document.addEventListener('change', function (ev) {
      if (ev.target && ev.target.classList && ev.target.classList.contains('js-episode')) { updateTitle(ev.target.closest('form')); }
    });
  })();
  </script>
</body>
</html>`
}
