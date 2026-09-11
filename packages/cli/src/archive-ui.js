import { GRID_THEME_CSS } from './ui-theme.js'

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
    `Peers: ${network.peers || 0}  Serves: ${work.activeServes || 0}  Announcements: ${work.activeAnnouncements || 0}  Archive used: ${archiveBudget.usedBytes || 0}/${archiveBudget.configuredBytes || 0} bytes`,
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

function discoverStatusLabel (status, item) {
  if (status === 'seeding') {
    return `Seeding${item.seededCopies ? ` · ${item.seededCopies}` : ''}`
  }
  if (status === 'in-network') {
    return `In network · ${item.networkCopies || 1}`
  }
  return 'Missing'
}

function discoverCard(item) {
  const poster = tmdbPosterUrl(item.posterPath)
  const status = item.networkStatus || 'missing'
  const statusLabel = discoverStatusLabel(status, item)
  const typeLabel = item.type === 'tv' ? 'TV' : 'Movie'
  const episodeLabel = item.type === 'tv' && item.season && item.episode ? ` · S${item.season} E${item.episode}` : ''
  const title = item.title || 'Untitled'
  const year = item.year ? ` (${item.year})` : ''
  return `
    <article class="discover-item status-${escapeHtml(status)}">
      <div class="poster ${poster ? '' : 'empty-poster'}">
        ${poster ? `<img src="${escapeHtml(poster)}" alt="${escapeHtml(title)} poster" loading="lazy">` : '<span>Artwork unavailable</span>'}
        <span class="status ${escapeHtml(status)}">${escapeHtml(statusLabel)}</span>
      </div>
      <div class="discover-copy">
        <div class="discover-title"><strong>${escapeHtml(title)}${escapeHtml(year)}</strong><span>${escapeHtml(typeLabel)}${escapeHtml(episodeLabel)}</span></div>
        <p>${escapeHtml(item.overview || 'No overview from TMDB.')}</p>
        <details class="archive-panel">
          <summary>Archive this title</summary>
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
            <label>Source URL<input name="url" placeholder="Paste an exact source URL"></label>
            <label>Or upload a video file<input type="file" name="file" accept="video/*"></label>
            <button type="submit">Start archive</button>
          </form>
        </details>
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


// Sizes are for a person deciding whether something is worth keeping, so one
// decimal past a gigabyte and none below it.
function formatSize(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return ''
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`
  if (value >= 1024 ** 2) return `${Math.round(value / 1024 ** 2)} MB`
  return `${Math.max(1, Math.round(value / 1024))} KB`
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


function renderDiscoverSections ({ discover, discoverRows }) {
  const main = `
        <section class="card" id="discover">
          <h2>Discover missing movies &amp; shows</h2>
          <p class="sub">TMDB-powered catalog view for your relay. Cards show whether a title is already seeding, merely known to the network, or missing. TMDB supplies metadata only; paste a source URL to archive the bytes.</p>
          <form method="get" action="/discover" class="discover-toolbar">
            <label>Search TMDB<input name="q" value="${escapeHtml(discover.query || '')}" placeholder="Trending if blank, e.g. Severance"></label>
            <label>Type<select name="type"><option value="movie" ${discover.type !== 'tv' ? 'selected' : ''}>Movies</option><option value="tv" ${discover.type === 'tv' ? 'selected' : ''}>TV</option></select></label>
            <button type="submit">Search</button>
          </form>
          <div class="discover-grid">${discoverRows}</div>
          <p class="note"><a href="/discover.json?type=${escapeHtml(discover.type || 'movie')}&amp;q=${escapeHtml(discover.query || '')}">Open Discover JSON</a></p>
        </section>`

  const side = `<section class="card">
          <h2>Archive a single video</h2>
          <p class="sub">Import one video into a relay-owned anonymous channel and publish availability to the network. Paste a <strong>direct link to the video file</strong> or upload one from this device. For a YouTube or Rumble channel, use <a href="/creators">Contribute a creator</a>.</p>
          <form method="post" action="/archive" enctype="multipart/form-data">
            <label>Direct video URL<input name="url" placeholder="https://host/path/video.mp4"></label>
            <label>Or upload a video file<input type="file" name="file" accept="video/*"></label>
            <label>Anonymous channel name<input name="channelName" value="Anonymous Archive"></label>
            <label>Title override<input name="title" placeholder="Optional"></label>
            <label>Description override<textarea name="description" rows="3" placeholder="Optional"></textarea></label>
            <label class="check"><input type="checkbox" name="publish" value="true" checked> Publish to network after import</label>
            <button type="submit">Archive and publish</button>
          </form>
        </section>`
  return { main, side }
}

function renderCreatorsSections ({ totalArchived, creators, creatorRows, targetRows }) {
  const main = `
        <section class="card" id="creators">
          <h2>Tracked creators</h2>
          <p class="sub">Everyone whose content this relay holds, with how much of it is seeded. ${escapeHtml(totalArchived)} videos across ${escapeHtml(creators.length)} creators.</p>
          <ul>${creatorRows}</ul>
        </section>

        <section class="card" id="targets">
          <h2>Unseeded targets</h2>
          <p class="sub">Creators with the most under-replicated content — seed these first to maximise availability.</p>
          <ul>${targetRows}</ul>
        </section>`

  const side = `<section class="card" id="archive">
          <h2>Contribute a creator</h2>
          <p class="sub">Paste a creator's channel or video URL (YouTube or Rumble). The relay registers them in its creators database, archives the content, and keeps tracking how many of their videos still need a seeder.</p>
          <form method="post" action="/creators">
            <label>Creator channel or video URL<input name="url" required placeholder="https://www.youtube.com/@channel"></label>
            <label>Display name (optional)<input name="label" placeholder="e.g. My Favourite Channel"></label>
            <label class="check"><input type="checkbox" name="publish" value="true" checked> Publish to network after import</label>
            <button type="submit">Add creator &amp; archive</button>
          </form>
        </section>`
  return { main, side }
}

function renderS3StoreSection ({ s3, offload, capacity }) {
  return `
        <section class="card" id="s3-store">
          <div class="card-head">
            <h2>S3 block store</h2>
            <span class="status-badge ${s3.configured ? 'ok' : ''}">${s3.configured ? 'Configured' : 'Not configured'}</span>
          </div>
          <p class="sub">Read-only status. Configure S3 with Docker environment variables, then restart the relay.</p>
          <div class="meta-block">
            <p class="note">Status: <span class="status-line ${s3.configured ? 'on' : ''}">${s3.configured ? 'configured' : 'not configured'}</span></p>
            ${s3.configured ? `<p class="note">Endpoint: ${escapeHtml(s3.endpoint)}<br>Bucket: ${escapeHtml(s3.bucket)}<br>Region: ${escapeHtml(s3.region)}<br>Prefix: ${escapeHtml(s3.prefix || '(none)')}</p>` : ''}
            <p class="note">Block offload: <span class="status-line ${offload.enabled ? 'on' : ''}">${offload.enabled ? 'enabled' : 'disabled'}</span></p>
            ${offload.enabled ? `<p class="note">Resident window: ${escapeHtml(formatSize(offload.windowBytes) || '0 KB')}<br>Restored on read: ${escapeHtml(String(offload.restored))} block(s)<br>Held on this volume: ${escapeHtml(formatSize(offload.residentBytes) || '0 KB')}<br>Room left: ${escapeHtml(formatSize(capacity.effectiveCapacityBytes) || 'unmeasured')} of archive budget, not of this disk</p>` : `<p class="note">Media block data stays on this relay's volume.</p>`}
          </div>
        </section>`
}

function renderClassificationSection ({ tmdb, tmdbState }) {
  return `
        <section class="card" id="classification">
          <div class="card-head">
            <h2>Content classification (TMDB)</h2>
            <span class="status-badge ${tmdb.enabled ? 'ok' : ''}">${escapeHtml(tmdbState)}</span>
          </div>
          <p class="sub">Add a <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer">TMDB API key</a> to automatically identify archived movies and TV shows. Status: <span class="status-line ${tmdb.enabled ? 'on' : ''}">${escapeHtml(tmdbState)}</span>.</p>
          <form method="post" action="/settings/tmdb">
            <label>TMDB API key<input name="apiKey" type="password" placeholder="${tmdb.hasKey ? '•••••••• (set)' : 'Paste TMDB v3 API key'}"></label>
            <label class="check"><input type="checkbox" name="enabled" value="true" ${tmdb.enabled ? 'checked' : ''}> Enable classification</label>
            <button type="submit">Save TMDB settings</button>
          </form>
        </section>`
}

function renderDevicesSection ({ link, deviceRows }) {
  return `
        <section class="card" id="devices">
          <div class="card-head">
            <h2>Authorized creator devices</h2>
            <span class="status-badge ${link.seedPin?.enabled ? 'ok' : ''}">${link.seedPin?.enabled ? 'Pin enabled' : 'Pin disabled'}</span>
          </div>
          <p class="sub">Authorize a creator's public device key for bounded catalog publication and seed retention. Secret keys and transport identifiers are never accepted.</p>
          <p class="note">Seed retention is ${link.seedPin?.enabled ? 'enabled' : 'disabled'}; ${Number(link.seedPin?.authorizedClients || 0)} client(s) authorized.</p>
          <form method="post" action="/clients" style="margin-top:14px">
            <label>Creator device key<input name="key" required placeholder="64-character hex device key"></label>
            <label>Device label (optional)<input name="label" placeholder="e.g. Alice's phone"></label>
            <button type="submit">Authorize device</button>
          </form>
          <ul style="margin-top:14px">${deviceRows}</ul>
          <p class="note">New authorizations take effect when the relay next starts.</p>
        </section>`
}

function renderSettingsSections ({ s3, offload, capacity, tmdb, tmdbState, link, deviceRows }) {
  const main = renderS3StoreSection({ s3, offload, capacity }) + renderClassificationSection({ tmdb, tmdbState })
  const side = renderDevicesSection({ link, deviceRows })
  return { main, side }
}

// The catalog-facing sections. The operator's release table owns `/`, so this
// page renders exactly one section group per route: discover, creators, or
// settings. There is no all-in-one page any more.
function normalizeArchivePageView(options) {
  return ['discover', 'creators', 'settings'].includes(options.view) ? options.view : 'discover'
}

function normalizeArchivePageModel(model) {
  const status = model.status || {}
  const network = status.network || {}
  const library = Array.isArray(model.library) ? model.library : []
  const creators = Array.isArray(model.creators) ? model.creators : []
  const unseededTargets = Array.isArray(model.unseededTargets) ? model.unseededTargets : []
  const tmdb = model.tmdb || {}
  const s3 = model.s3 || {}
  const offloadState = s3.offload || {}
  // With offload on, what this relay can still take is bounded by the archive
  // budget rather than by the volume, so the panel reports that number next to
  // the residency it is actually paying for locally.
  const capacity = status.capacity || {}
  const discover = model.discover || { type: 'movie', query: '', items: [] }
  const discoverItems = Array.isArray(discover.items) ? discover.items : []
  const trustedClients = Array.isArray(model.trustedClients) ? model.trustedClients : []
  const link = model.link || {}
  return {
    status,
    network,
    library,
    creators,
    unseededTargets,
    tmdb,
    s3,
    offload: {
      enabled: offloadState.enabled === true,
      windowBytes: Number(offloadState.windowBytes) || 0,
      restored: Number(offloadState.restored) || 0,
      residentBytes: Number(offloadState.residentBytes) || 0
    },
    capacity,
    discover,
    discoverItems,
    trustedClients,
    link,
    totalUnseeded: creators.reduce((sum, c) => sum + (Number(c.videosUnseeded) || 0), 0),
    totalArchived: creators.reduce((sum, c) => sum + (Number(c.videosArchived) || 0), 0)
  }
}

function archivePageRows({ creators, unseededTargets, trustedClients, discoverItems }) {
  return {
    creatorRows: creators.length
      ? creators.map(creatorCard).join('')
      : '<li class="empty">No creators tracked yet. Add one in the sidebar, or archive a video.</li>',
    targetRows: unseededTargets.length
      ? unseededTargets.map(targetRow).join('')
      : '<li class="empty">Every tracked video has a copy here.</li>',
    deviceRows: trustedClients.length
      ? trustedClients.map(deviceRow).join('')
      : '<li class="empty">No linked devices yet.</li>',
    discoverRows: discoverItems.length
      ? discoverItems.map(discoverCard).join('')
      : '<div class="empty">Add a TMDB key, then search or use trending to find missing movies and shows.</div>'
  }
}

function archiveTmdbStateLabel(tmdb) {
  return tmdb.enabled ? 'enabled' : (tmdb.hasKey ? 'key set, disabled' : 'no key')
}

function archivePageCopy(view) {
  return {
    discover: {
      eyebrow: 'Catalog',
      title: 'Find what the network is missing',
      description: 'Search public metadata, check availability, and add an exact release to this relay.'
    },
    creators: {
      eyebrow: 'Coverage',
      title: 'Keep creator catalogs available',
      description: 'Track channels, see copy gaps, and add sources that this relay should preserve.'
    },
    settings: {
      eyebrow: 'Node setup',
      title: 'Configure this relay',
      description: 'Review storage services, classification, and the devices authorized to publish here.'
    }
  }[view]
}

function renderArchiveSections(view, page) {
  if (view === 'discover') {
    return renderDiscoverSections({ discover: page.discover, discoverRows: page.discoverRows })
  }
  if (view === 'creators') {
    return renderCreatorsSections({
      totalArchived: page.totalArchived,
      creators: page.creators,
      creatorRows: page.creatorRows,
      targetRows: page.targetRows
    })
  }
  if (view === 'settings') {
    return renderSettingsSections({
      s3: page.s3,
      offload: page.offload,
      capacity: page.capacity,
      tmdb: page.tmdb,
      tmdbState: page.tmdbState,
      link: page.link,
      deviceRows: page.deviceRows
    })
  }
  return { main: '', side: '' }
}

export function renderArchiveWebHome(model = {}, options = {}) {
  const view = normalizeArchivePageView(options)
  const page = normalizeArchivePageModel(model)
  const { creatorRows, targetRows, deviceRows, discoverRows } = archivePageRows(page)
  const tmdbState = archiveTmdbStateLabel(page.tmdb)
  const pageCopy = archivePageCopy(view)
  const sections = renderArchiveSections(view, {
    ...page,
    creatorRows,
    targetRows,
    deviceRows,
    discoverRows,
    tmdbState
  })
  const { network, library, totalUnseeded } = page
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PearTube Relay</title>
  <style>${GRID_THEME_CSS}
    .bar-inner { width: min(100%, 1280px); margin: 0 auto; padding: 12px 24px; display: flex; align-items: center; gap: 20px; }
    .brand-copy { display: grid; line-height: 1.05; }
    .brand-copy b { font-size: 15px; }
    .brand-copy small { margin-top: 4px; color: var(--muted); font-family: var(--mono); font-size: 9px; font-weight: 500; letter-spacing: 0.12em; text-transform: uppercase; }
    .stat-pills { display: flex; gap: 6px; }
    .spill { min-width: 70px; padding: 6px 10px; display: grid; grid-template-columns: auto; justify-items: end; border: var(--rule) solid var(--line); border-radius: var(--radius); background: transparent; }
    .spill b { font-family: var(--mono); font-size: 15px; line-height: 1; font-variant-numeric: tabular-nums; }
    .spill span { margin-top: 3px; color: var(--muted); font-family: var(--mono); font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase; }
    .spill.alert b { color: var(--danger); }
    main { width: min(100%, 1280px); margin: 0 auto; padding: 40px 24px 96px; }
    .page-intro { max-width: 720px; margin: 0 0 28px; padding-left: 14px; border-left: var(--rule) solid var(--accent); }
    .eyebrow { margin-bottom: 8px; }
    .page-intro p { max-width: 660px; margin: 10px 0 0; color: var(--ink-2); font-size: 15px; line-height: 1.6; }
    .layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; }
    .col { display: grid; gap: 20px; align-content: start; }
    .card { padding: 20px; }
    .card h2 { margin: 0 0 5px; }
    .card .sub { margin: 0 0 18px; color: var(--muted); font-family: var(--mono); font-size: 12px; line-height: 1.5; }
    ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
    .empty { padding: 28px 18px; }
    form { display: grid; gap: 13px; }
    label { display: grid; gap: 6px; color: var(--ink-2); font-family: var(--mono); font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; }
    .check { display: flex; flex-direction: row; align-items: center; gap: 9px; text-transform: none; letter-spacing: 0; font-family: var(--sans); font-size: 13px; color: var(--ink); }
    input[type=file] { padding: 7px; color: var(--muted); }
    input[type=file]::file-selector-button { margin-right: 10px; border: var(--rule) solid var(--line-strong); border-radius: var(--radius); padding: 6px 10px; background: transparent; color: var(--ink); font-family: var(--display); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; cursor: pointer; }
    button { justify-self: start; }
    button.ghost { padding: 6px 12px; color: var(--danger); border-color: var(--line-strong); }
    button.ghost:hover { border-color: var(--danger); color: var(--danger); }
    .release-list { margin: 8px 0 0; display: grid; gap: 4px; }
    .release-list li { display: grid; gap: 1px; padding: 5px 7px; border-radius: var(--radius); background: var(--surface-2); }
    .release-name { overflow: hidden; font-family: var(--mono); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
    .release-facts { color: var(--muted); font-family: var(--mono); font-size: 10px; }
    .library-grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); }
    .title-card { display: grid; grid-template-columns: 92px 1fr; gap: 13px; min-width: 0; padding: 12px; border: var(--rule) solid var(--line); border-radius: var(--radius); background: var(--surface); }
    .poster-wrap { position: relative; overflow: hidden; border: 1px solid var(--line-soft); border-radius: var(--radius); background: var(--bg); aspect-ratio: 2 / 3; box-shadow: none; }
    .lib-poster { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
    .lib-poster-blank { position: absolute; inset: 0; display: grid; place-items: center; color: var(--disabled); font-family: var(--display); font-size: 36px; }
    .seed-chip { position: absolute; right: 5px; bottom: 5px; left: 5px; overflow: hidden; display: block; border-color: var(--line); background: var(--bg); color: var(--ink); text-overflow: ellipsis; white-space: nowrap; }
    .seed-mirrored { border-color: var(--accent); background: var(--accent); color: var(--on-accent); }
    .seed-stored { color: var(--accent); border-color: var(--accent); }
    .seed-publishing { color: var(--warn); border-color: var(--warn); }
    .seed-failed { color: var(--danger); border-color: var(--danger); }
    .title-body { min-width: 0; }
    .title-body h3 { line-height: 1.2; }
    .title-body .by { overflow: hidden; margin: 4px 0 0; color: var(--accent); font-family: var(--mono); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
    .title-body .facts, .title-body .seed-detail, .inventory-note, .inventory-id { color: var(--muted); font-family: var(--mono); font-size: 11px; }
    .title-body .genres { display: flex; flex-wrap: wrap; gap: 5px; margin: 7px 0 0; }
    .title-body .overview { display: -webkit-box; overflow: hidden; margin: 7px 0 0; color: var(--ink-2); font-size: 12px; line-height: 1.45; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
    .inventory-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin: 10px 0 0; }
    .inventory-grid div { min-width: 0; padding: 6px; border-radius: var(--radius); background: var(--surface-2); }
    .inventory-grid dt { color: var(--muted); font-family: var(--mono); font-size: 9px; letter-spacing: .1em; text-transform: uppercase; }
    .inventory-grid dd { overflow: hidden; margin: 2px 0 0; font-family: var(--mono); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
    .bar { height: var(--rule); border-radius: 0; background: var(--active); overflow: hidden; }
    .library-progress { margin-top: 8px; }
    .play-link { display: inline-flex; min-height: 32px; margin-top: 9px; padding: 0 12px; align-items: center; justify-content: center; border-radius: var(--radius); background: var(--accent); color: var(--on-accent); font-family: var(--display); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; }
    .creator { display: flex; gap: 13px; padding: 15px 0; border-top: 1px solid var(--line-soft); }
    .creator:first-child, .target:first-child, .job:first-child, .device:first-child { padding-top: 2px; border-top: 0; }
    .avatar { flex: 0 0 42px; height: 42px; display: grid; place-items: center; border: var(--rule) solid var(--line); border-radius: var(--radius); color: var(--ink); font-family: var(--display); font-size: 15px; box-shadow: none; }
    .creator-body { flex: 1; min-width: 0; }
    .creator-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 9px; }
    .creator-head small { color: var(--muted); font-family: var(--mono); font-size: 11px; }
    .creator-meta { display: flex; gap: 10px; align-items: center; justify-content: space-between; margin-top: 7px; color: var(--muted); font-family: var(--mono); font-size: 11px; }
    .target, .job, .device { padding: 13px 0; border-top: 1px solid var(--line-soft); }
    .target { display: grid; gap: 9px; }
    .target-head, .device { display: flex; gap: 10px; align-items: center; justify-content: space-between; }
    .job { display: grid; gap: 8px; }
    .job-head { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 9px; align-items: center; }
    .job-head strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .job > small, .job-meta { color: var(--muted); font-family: var(--mono); font-size: 11px; }
    .job-meta { display: flex; flex-wrap: wrap; gap: 8px 16px; }
    .job-meta b { color: var(--ink); }
    .job-reason { margin: 0; color: var(--danger); font-size: 12px; line-height: 1.45; }
    .short-id { color: var(--muted); font-family: var(--mono); font-size: 11px; }
    .pill { flex: 0 0 auto; }
    .device-body { display: grid; gap: 3px; min-width: 0; }
    .device form { margin: 0; }
    .mono-key, .meta-block { display: block; margin-top: 9px; padding: 13px; background: var(--bg); }
    .note { margin: 12px 0 0; color: var(--muted); font-size: 12px; line-height: 1.55; }
    .notice { margin: 0 0 20px; padding: 13px 15px; font-size: 13px; }
    .status-line { font-family: var(--mono); font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; }
    .status-line.on { color: var(--accent); }
    .card-head { display: flex; flex-wrap: wrap; gap: 10px; align-items: baseline; justify-content: space-between; margin-bottom: 4px; }
    .meta-block { display: grid; gap: 9px; }
    .meta-block .note { margin: 0; }
    .discover-toolbar { display: grid; grid-template-columns: 1fr 140px auto; gap: 10px; align-items: end; margin-bottom: 18px; padding: 14px; border: var(--rule) solid var(--line); border-radius: var(--radius); background: var(--surface); }
    .discover-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(245px, 1fr)); gap: 14px; }
    .discover-item { overflow: hidden; border: var(--rule) solid var(--line); border-radius: var(--radius); background: var(--surface); transition: border-color 120ms ease; }
    .discover-item:hover { border-color: var(--line-strong); transform: none; box-shadow: none; }
    .poster { position: relative; display: grid; place-items: center; overflow: hidden; aspect-ratio: 16 / 10; background: var(--bg); border-bottom: 1px solid var(--line-soft); color: var(--muted); }
    .poster img { width: 100%; height: 100%; display: block; object-fit: cover; object-position: center 20%; }
    .empty-poster::before { content: ""; position: absolute; width: 96px; height: 96px; border: var(--rule) solid var(--line); }
    .empty-poster > span:first-child { position: relative; z-index: 1; color: var(--ink-2); font-family: var(--mono); font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; }
    .status { position: absolute; top: 8px; left: 8px; background: var(--bg); }
    .discover-copy { display: grid; gap: 9px; padding: 14px; }
    .discover-title { display: flex; gap: 8px; align-items: baseline; justify-content: space-between; }
    .discover-title strong { font-family: var(--display); text-transform: uppercase; line-height: 1.2; }
    .discover-title span { flex: 0 0 auto; color: var(--muted); font-family: var(--mono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; }
    .discover-copy > p { display: -webkit-box; overflow: hidden; min-height: 3.8em; margin: 0; color: var(--ink-2); font-size: 12px; line-height: 1.5; -webkit-box-orient: vertical; -webkit-line-clamp: 3; }
    .archive-panel { margin-top: 2px; }
    .archive-panel summary { display: flex; align-items: center; justify-content: center; list-style: none; text-align: center; }
    .archive-panel summary::-webkit-details-marker { display: none; }
    .archive-panel[open] summary, .status-seeding .archive-panel summary, .status-in-network .archive-panel summary { border-color: var(--line-strong); background: transparent; color: var(--ink); }
    .discover-archive { gap: 10px; padding-top: 13px; }
    .discover-archive button { width: 100%; justify-self: stretch; }
    textarea { resize: vertical; }
    @media (min-width: 980px) {
      .layout { grid-template-columns: minmax(0, 1.7fr) minmax(280px, 0.8fr); align-items: start; }
      .col.side { position: sticky; top: 92px; }
    }
    @media (max-width: 980px) {
      .bar-inner { flex-wrap: wrap; gap: 10px 16px; }
      .spacer { display: none; }
      .stat-pills { width: 100%; overflow-x: auto; padding-bottom: 2px; scrollbar-color: var(--line-strong) transparent; scrollbar-width: thin; }
      .spill { min-width: 78px; justify-items: start; }
    }
    @media (max-width: 680px) {
      header { position: static; }
      .bar-inner { padding: 12px 16px; }
      .brand { width: 100%; }
      nav { width: 100%; overflow-x: auto; padding-bottom: 2px; }
      nav a { white-space: nowrap; }
      main { padding: 30px 16px 72px; }
      .page-intro { margin-bottom: 20px; }
      .card { padding: 16px; }
      .discover-toolbar { grid-template-columns: 1fr; }
      .discover-toolbar button { width: 100%; justify-self: stretch; }
      .discover-grid { grid-template-columns: 1fr; }
      .poster { aspect-ratio: 2 / 1; }
      button, summary, input, select { min-height: 44px; }
      .check { min-height: 44px; }
      .creator-meta, .target-head, .device { align-items: flex-start; flex-direction: column; }
    }
  </style>
</head>
<body>
  <header>
    <div class="bar-inner">
      <div class="brand"><span class="dot"></span><span class="brand-copy"><b>PearTube Relay</b><small>Operator console</small></span></div>
      <nav>
        <a href="/">Releases</a>
        <a class="${view === 'discover' ? 'on' : ''}" href="/discover" ${view === 'discover' ? 'aria-current="page"' : ''}>Discover</a>
        <a class="${view === 'creators' ? 'on' : ''}" href="/creators" ${view === 'creators' ? 'aria-current="page"' : ''}>Creators</a>
        <a class="${view === 'settings' ? 'on' : ''}" href="/settings" ${view === 'settings' ? 'aria-current="page"' : ''}>Settings</a>
      </nav>
      <span class="spacer"></span>
      <div class="stat-pills">
        <div class="spill"><b>${escapeHtml(library.length)}</b><span>Titles</span></div>
        <div class="spill ${totalUnseeded > 0 ? 'alert' : ''}" title="Tracked videos with no copy on this relay"><b>${escapeHtml(totalUnseeded)}</b><span>Unseeded</span></div>
        <div class="spill"><b>${escapeHtml(network.peers || 0)}</b><span>Peers</span></div>
      </div>
    </div>
  </header>
  <main>
    <div class="page-intro">
      <span class="eyebrow">${escapeHtml(pageCopy.eyebrow)}</span>
      <h1>${escapeHtml(pageCopy.title)}</h1>
      <p>${escapeHtml(pageCopy.description)}</p>
    </div>
    ${model.notice ? `<p class="notice" role="status">${escapeHtml(model.notice)}</p>` : ''}
    <div class="layout">
      <div class="col">
        ${sections.main}
      </div>

      <div class="col side">
        ${sections.side}
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
