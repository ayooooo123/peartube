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
  const seeding = status.seeding || {}
  const jobs = Array.isArray(model.jobs) ? model.jobs : []
  const lines = [
    'PearTube Relay Archive Console',
    '================================',
    `Peers: ${status.peers || 0}  Feed entries: ${status.feedEntries || 0}  Seeded videos: ${seeding.videos || 0}`,
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
  return `
    <li class="creator">
      <div class="avatar" style="background: hsl(${hue} 55% 42%)">${escapeHtml(initials(creator.name || creator.creatorId))}</div>
      <div class="creator-body">
        <div class="creator-head">
          <strong>${escapeHtml(creator.name || creator.creatorId)}</strong>
          ${creator.handle ? `<small>${escapeHtml(creator.handle)}</small>` : ''}
          ${classChips(creator.classification)}
        </div>
        <div class="bar" title="${escapeHtml(archived - unseeded)} of ${escapeHtml(archived)} seeded">
          <span class="bar-fill ${fullySeeded ? 'ok' : ''}" style="width:${pct}%"></span>
        </div>
        <div class="creator-meta">
          <span>${escapeHtml(archived - unseeded)}/${escapeHtml(archived)} seeded</span>
          ${unseeded > 0
            ? `<span class="tag warn">${escapeHtml(unseeded)} unseeded</span>`
            : '<span class="tag ok">fully seeded</span>'}
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

function jobRow(job) {
  return `
    <li class="job">
      <span class="pill ${escapeHtml(job.status)}">${escapeHtml(job.status)}</span>
      <div class="job-body">
        <strong>${escapeHtml(job.title || 'Untitled archive')}</strong>
        <small>${escapeHtml(job.channelName || 'Anonymous Archive')} · ${escapeHtml(job.id)}</small>
        ${job.error ? `<code>${escapeHtml(job.error)}</code>` : ''}
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
          <input type="hidden" name="tmdbSeason" value="${escapeHtml(item.season || '')}">
          <input type="hidden" name="tmdbEpisode" value="${escapeHtml(item.episode || '')}">
          <input type="hidden" name="tmdbPosterPath" value="${escapeHtml(item.posterPath || '')}">
          <input type="hidden" name="sourceType" value="tmdb">
          <input type="hidden" name="sourceVideoId" value="${escapeHtml(tmdbSourceVideoId(item))}">
          <input type="hidden" name="channelName" value="${escapeHtml(title)}">
          <input type="hidden" name="title" value="${escapeHtml(title)}">
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

export function renderArchiveWebHome(model = {}) {
  const status = model.status || {}
  const seeding = status.seeding || {}
  const jobs = Array.isArray(model.jobs) ? model.jobs : []
  const creators = Array.isArray(model.creators) ? model.creators : []
  const unseededTargets = Array.isArray(model.unseededTargets) ? model.unseededTargets : []
  const tmdb = model.tmdb || {}
  const discover = model.discover || { type: 'movie', query: '', items: [] }
  const discoverItems = Array.isArray(discover.items) ? discover.items : []
  const trustedClients = Array.isArray(model.trustedClients) ? model.trustedClients : []
  const link = model.link || {}
  const publicBaseUrl = typeof model.publicBaseUrl === 'string' ? model.publicBaseUrl : ''
  const catalogUrl = publicBaseUrl ? `${publicBaseUrl.replace(/\/$/, '')}/catalog.json` : '/catalog.json'

  const totalUnseeded = creators.reduce((sum, c) => sum + (Number(c.videosUnseeded) || 0), 0)
  const totalArchived = creators.reduce((sum, c) => sum + (Number(c.videosArchived) || 0), 0)

  const creatorRows = creators.length
    ? creators.map(creatorCard).join('')
    : '<li class="empty">No creators tracked yet. Add one in the sidebar, or archive a video.</li>'

  const targetRows = unseededTargets.length
    ? unseededTargets.map(targetRow).join('')
    : '<li class="empty">All tracked creator videos are seeded. 🎉</li>'

  const jobRows = jobs.length
    ? jobs.map(jobRow).join('')
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
        <a href="#discover">Discover</a>
        <a href="#creators">Creators</a>
        <a href="#targets">Targets</a>
        <a href="#devices">Devices</a>
        <a href="#archive">Archive</a>
      </nav>
      <span class="spacer"></span>
      <div class="stat-pills">
        <div class="spill"><b>${escapeHtml(status.peers || 0)}</b><span>Peers</span></div>
        <div class="spill"><b>${escapeHtml(seeding.videos || 0)}</b><span>Seeded</span></div>
        <div class="spill"><b>${escapeHtml(creators.length)}</b><span>Creators</span></div>
        <div class="spill ${totalUnseeded > 0 ? 'alert' : ''}"><b>${escapeHtml(totalUnseeded)}</b><span>Unseeded</span></div>
      </div>
    </div>
  </header>
  <main>
    <div class="layout">
      <div class="col">
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
          <h2>Archive queue</h2>
          <p class="sub">Source URLs stay in the local job store; only imported metadata is exposed publicly.</p>
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
          <p class="sub">Import one video into a relay-owned anonymous channel and publish availability to the network. Paste a source URL <strong>or</strong> upload a video file from this device.</p>
          <form method="post" action="/archive" enctype="multipart/form-data">
            <label>Video or channel URL<input name="url" placeholder="https://www.youtube.com/watch?v=..."></label>
            <label>Or upload a video file<input type="file" name="file" accept="video/*"></label>
            <label>Invidious fallback instance<input name="invidiousInstance" placeholder="Optional, e.g. https://inv.thepixora.com"></label>
            <label>Anonymous channel name<input name="channelName" value="Anonymous Archive"></label>
            <label>Title override<input name="title" placeholder="Optional"></label>
            <label>Description override<textarea name="description" rows="3" placeholder="Optional"></textarea></label>
            <label class="check"><input type="checkbox" name="publish" value="true" checked> Publish to network after import</label>
            <button type="submit">Archive and publish</button>
          </form>
        </section>

        <section class="card" id="devices">
          <h2>Linked creator devices</h2>
          <p class="sub">Authorize a creator's device so this relay always mirrors their uploads and livestreams — guaranteeing their content a peer. Paste the 64-character device key from their PearTube app.</p>
          ${link.relayMirrorKey
            ? `<p class="sub" style="margin-bottom:6px">This relay's mirror key (creators' apps adopt this automatically over P2P):</p><code class="mono-key">${escapeHtml(link.relayMirrorKey)}</code>`
            : '<p class="note">Relay mirror key appears once the blind peer is running.</p>'}
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
          <h2>Simple relay catalog</h2>
          <p class="sub">Fallback JSON catalog for clients that can't reach live P2P gossip.</p>
          <code class="mono-key"><a href="${escapeHtml(catalogUrl)}">${escapeHtml(catalogUrl)}</a></code>
        </section>
      </div>
    </div>
  </main>
</body>
</html>`
}
