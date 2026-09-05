// The operator console. PearTube is a decentralized debrid provider, so the
// object an operator manages is a release: one archived file, with its own
// bytes, its own residency, and its own proof that other devices hold it. A
// work is a column that groups releases; it is never the row.
//
// Design contract (docs/relay-console-design.md):
// - one table, state column plus filter chips, attention-first default order
// - server-side query: a node that auto-seeds holds hundreds of releases
// - no artwork, no rate, no ETA - absent facts render as absent, never as zero
// - destructive verbs confirm by naming the release and its backup count

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function formatSize(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return ''
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`
  if (value >= 1024 ** 2) return `${Math.round(value / 1024 ** 2)} MB`
  return `${Math.round(value / 1024)} KB`
}

function shortIdentifier(value, length = 12) {
  const text = String(value || '')
  return text.length > length ? `${text.slice(0, length)}…` : text
}

// Relative because an operator reads "4m" faster than a timestamp, and the
// exact instant is one hover away.
function relativeAge(value) {
  const stamp = Number(value)
  if (!Number.isFinite(stamp) || stamp <= 0) return ''
  const seconds = Math.max(0, Math.round((Date.now() - stamp) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`
  return `${Math.round(seconds / 86400)}d`
}

function absoluteTime(value) {
  const stamp = Number(value)
  if (!Number.isFinite(stamp) || stamp <= 0) return 'never'
  return new Date(stamp).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

const STATE_LABELS = {
  queued: 'Queued',
  acquiring: 'Acquiring',
  verifying: 'Verifying',
  publishing: 'Publishing',
  seeding: 'Seeding',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled'
}

// Three facts, three columns. The relay contract forbids merging them: a signed
// manifest proves the file exists, an availability observation proves someone
// could serve it, and only this relay's own acquisition record proves the bytes
// are here.
const RESIDENCY_LABELS = {
  local: 'Local',
  partial: 'Partial',
  transferring: 'Transferring',
  unproven: 'Unproven',
  none: 'None'
}

const RETENTION_LABELS = {
  'archive-pin': 'Pinned',
  'contribution-cache': 'Cache',
  ephemeral: 'Temporary'
}

const FILTER_CHIPS = [
  { state: '', label: 'All' },
  { state: 'seeding', label: 'Seeding' },
  { state: 'acquiring', label: 'Acquiring' },
  { state: 'queued', label: 'Queued' },
  { state: 'failed', label: 'Failed' },
  { state: 'cancelled', label: 'Cancelled' }
]

const COLUMNS = [
  { key: 'file', label: 'File' },
  { key: 'work', label: 'Work' },
  { key: 'size', label: 'Size' },
  { key: 'progress', label: 'Progress' },
  { key: 'state', label: 'State' },
  { key: 'reach', label: 'Reach' },
  { key: 'backups', label: 'Backups' },
  { key: 'residency', label: 'Residency' },
  { key: 'age', label: 'Age' }
]

const COLUMN_SPAN = COLUMNS.length + 1

// A release is named by the file its archival source named. When the record
// predates that field the row says so with its id: borrowing the work's title
// would make two releases of one work read as the same file.
function releaseName(row) {
  return row.file || `Release ${shortIdentifier(row.id || '', 10)}`
}

// Progress is this relay's own accepted bytes against the length the manifest
// claims. A catalogued release this relay never fetched has no progress at all;
// rendering it as 100% would turn catalog presence into local residency.
function progressCell(row) {
  if (row.residency === 'local') return '<span class="pct done" title="This relay accepted every byte">100%</span>'
  const expected = Number(row.sizeBytes) || 0
  const acquired = Number(row.bytesAcquired) || 0
  if (acquired <= 0) {
    return `<span class="pct none" title="${escapeHtml(row.residencyDetail || 'This relay recorded no accepted bytes')}">—</span>`
  }
  const percent = Number(row.progressPercent) || (expected > 0 ? Math.min(100, (acquired / expected) * 100) : 0)
  const detail = expected > 0
    ? `${formatSize(acquired) || '0 KB'} accepted of ${formatSize(expected)} claimed`
    : `${formatSize(acquired) || '0 KB'} accepted, claimed length unknown`
  return `<span class="pct" title="${escapeHtml(detail)}">${percent.toFixed(1)}%<span class="bar"><i style="width:${Math.min(100, percent).toFixed(1)}%"></i></span></span>`
}

// Durability: how many independent devices proved a copy. A release this relay
// holds alone is the one worth flagging.
function backupsCell(row) {
  const backups = Math.max(0, Number(row.backups) || 0)
  const risk = backups === 0 && row.residency === 'local'
  const title = backups === 0
    ? 'No other device has proved it holds this release'
    : `${backups} independent device${backups === 1 ? '' : 's'} proved they hold this release`
  return `<span class="backups ${risk ? 'risk' : ''}" title="${escapeHtml(title)}">${backups}</span>`
}

// Presence: the length a signed manifest claims. It says the file exists and how
// big it is, and nothing about whether its bytes are on this disk.
function sizeCell(row) {
  const size = formatSize(row.sizeBytes)
  if (!size) return '<span class="none" title="No signed byte length is recorded">—</span>'
  return `<span title="${escapeHtml(row.catalogued
    ? 'Length claimed by the signed manifest. Catalog presence, not local bytes.'
    : 'Length the source reported. This release is not in a catalog yet.')}">${escapeHtml(size)}${row.catalogued ? '' : '<span class="uncatalogued">*</span>'}</span>`
}

// Reachability: what an availability observation said, and nothing more. No
// observation means unknown, which is not the same as nobody holding it.
function reachCell(row) {
  if (!row.reach) return '<span class="none" title="No availability observation covers this release">—</span>'
  return `<span class="reach" title="${escapeHtml(row.reachDetail || '')}">${escapeHtml(row.reach)}</span>`
}

// A release with a verified candidate reference gets a play link inline: the
// operator's most common read of a row is "is this actually playable".
export function renderReleaseRow(row = {}) {
  const name = releaseName(row)
  // A catalogued row opens deterministically by publication and rendition -
  // stable ids, unlike a provider lease which expires and takes the button
  // with it. Only rows without both ids fall back to a candidate reference.
  // Every variant is gated on the relay's own per-request playback gate: an
  // off-machine client renders the table with no play control at all.
  const playPath = !row.playable
    ? null
    : (row.publicationId && row.renditionId
        ? `/play/pub/${encodeURIComponent(row.publicationId)}/${encodeURIComponent(row.renditionId)}`
        : (row.candidateRef ? `/play/${encodeURIComponent(row.candidateRef)}` : null))
  const play = playPath
    ? `<a class="play js-play" href="${playPath}" title="Play this release">▶ Play</a>`
    : ''
  return `<tr data-id="${escapeHtml(row.id || '')}" data-acquisition="${escapeHtml(row.acquisitionId || '')}" data-name="${escapeHtml(name)}" data-backups="${escapeHtml(String(Math.max(0, Number(row.backups) || 0)))}">
  <td class="pick"><input type="checkbox" class="js-pick" aria-label="Select ${escapeHtml(name)}"></td>
  <td class="file" title="${escapeHtml(name)}"><div class="file-row">${play}<span class="file-name"><button type="button" class="js-open link" title="${escapeHtml(name)}">${escapeHtml(name)}</button>${row.work || !row.coordinates ? '' : ` <span class="coords">${escapeHtml(row.coordinates)}</span>`}</span></div></td>
  <td class="work">${row.work
    ? `${escapeHtml(row.work)}${row.workLabel ? `<span class="coords">${escapeHtml(row.workLabel)}</span>` : ''}`
    : '<span class="none" title="No publisher metadata named this work">—</span>'}</td>
  <td class="num">${sizeCell(row)}</td>
  <td class="progress">${progressCell(row)}</td>
  <td class="state"><span class="tag ${escapeHtml(row.state || '')}">${escapeHtml(STATE_LABELS[row.state] || row.state || 'Unknown')}</span>${row.errorCode ? `<span class="err" title="${escapeHtml(row.errorCode)}">${row.recoverable ? 'retryable' : 'terminal'}</span>` : ''}</td>
  <td class="num">${reachCell(row)}</td>
  <td class="num">${backupsCell(row)}</td>
  <td class="residency"><span class="tag res-${escapeHtml(row.residency || 'unknown')}" title="${escapeHtml(row.residencyDetail || '')}">${escapeHtml(RESIDENCY_LABELS[row.residency] || 'Unknown')}</span></td>
  <td class="age" title="${escapeHtml(absoluteTime(row.updatedAt))}">${escapeHtml(relativeAge(row.updatedAt) || '—')}</td>
</tr>`
}

export function renderReleaseRows(page = {}) {
  const rows = Array.isArray(page.rows) ? page.rows : []
  if (rows.length === 0) {
    return `<tr class="empty"><td colspan="${COLUMN_SPAN}">${page.total > 0
      ? 'No release matches this filter.'
      : 'This relay holds no releases yet. Archive one from Discover, or let a connected client seed into it.'}</td></tr>`
  }
  if (page.group !== 'work') return rows.map(renderReleaseRow).join('')
  // Grouping keeps the same rows in the same order and only inserts a heading
  // when the work changes, so a sort is never silently rewritten by a group.
  const out = []
  let current = null
  for (const row of rows) {
    const work = row.work || 'Unnamed work'
    if (work !== current) {
      current = work
      out.push(`<tr class="group-head"><td colspan="${COLUMN_SPAN}">${escapeHtml(work)}</td></tr>`)
    }
    out.push(renderReleaseRow(row))
  }
  return out.join('')
}

function chipHref(params, state) {
  const next = new URLSearchParams(params)
  if (state) next.set('state', state)
  else next.delete('state')
  next.delete('offset')
  const query = next.toString()
  return query ? `/?${query}` : '/'
}

function sortHref(params, key, active) {
  const next = new URLSearchParams(params)
  next.set('sort', key)
  next.set('dir', active && next.get('dir') !== 'asc' ? 'asc' : 'desc')
  next.delete('offset')
  return `/?${next.toString()}`
}

// The header answers "is this node healthy" before the table answers "which
// release". Held counts only bytes this relay can still prove: the full length
// of a release whose residency is local, and the accepted bytes of a transfer
// in flight. A failed attempt's partial bytes are not counted - the relay does
// not report how much of a dead attempt it kept, and a guess would be a claim.
function summarize(rows) {
  const active = new Set(['queued', 'acquiring', 'verifying', 'publishing'])
  const counts = { active: 0, failed: 0, unbacked: 0, catalogued: 0, unproven: 0, bytes: 0 }
  for (const row of rows) {
    if (active.has(row.state)) counts.active++
    if (row.state === 'failed') counts.failed++
    if (row.catalogued) counts.catalogued++
    if (row.residency === 'local') {
      counts.bytes += Number(row.sizeBytes) || 0
      if ((Number(row.backups) || 0) === 0) counts.unbacked++
    } else if (row.residency === 'transferring') {
      counts.bytes += Number(row.bytesAcquired) || 0
    } else if (row.catalogued && row.residency === 'unproven') {
      counts.unproven++
    }
  }
  return counts
}

function renderKpis(rows, counts, status) {
  const budget = Number(status.budgets?.archive?.configuredBytes) || 0
  return `<div class="kpi" title="Rows on this page's shelf: catalogued publications plus this relay's own acquisitions"><b>${escapeHtml(rows.length)}</b><span>Releases</span></div>
        <div class="kpi" title="Releases a signed catalog entry names. Presence, not local bytes."><b>${escapeHtml(counts.catalogued)}</b><span>Catalogued</span></div>
        <div class="kpi"><b>${escapeHtml(counts.active)}</b><span>Active</span></div>
        <div class="kpi ${counts.failed ? 'alert' : ''}"><b>${escapeHtml(counts.failed)}</b><span>Failed</span></div>
        <div class="kpi ${counts.unbacked ? 'alert' : ''}" title="Releases whose bytes are proven local and that no other device has proved it holds"><b>${escapeHtml(counts.unbacked)}</b><span>Unbacked</span></div>
        <div class="kpi" title="Catalogued releases with no acquisition record or local assessment proving the bytes are here"><b>${escapeHtml(counts.unproven)}</b><span>Unproven</span></div>
        <div class="kpi"><b>${escapeHtml(status.network?.peers || 0)}</b><span>Peers</span></div>
        <div class="kpi" title="Bytes proven local plus bytes accepted in flight${budget > 0 ? `, against an archive budget of ${escapeHtml(formatSize(budget))}` : '; no archive budget configured'}"><b>${escapeHtml(formatSize(counts.bytes) || '0 KB')}</b><span>Held</span></div>`
}

export function renderReleaseConsole(model = {}, params = new URLSearchParams()) {
  const page = model.page || { rows: [], total: 0, matched: 0, offset: 0, limit: 50, sort: 'attention', direction: 'desc' }
  const status = model.status || {}
  const all = Array.isArray(model.releases) ? model.releases : []
  const counts = summarize(all)
  const selectedState = params.get('state') || ''
  const query = params.get('q') || ''
  const grouped = params.get('group') === 'work'

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PearTube Relay — Releases</title>
  <style>
    :root {
      --bg: #07080c; --panel: #10131b; --line: rgba(255,255,255,0.08);
      --ink: #f5f7fb; --muted: #8b93a7; --mint: #9effd0; --warn: #ff7aa2; --amber: #ffca7a;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--ink); font-size: 13px; }
    a { color: var(--mint); text-decoration: none; }
    header { position: sticky; top: 0; z-index: 5; background: rgba(7,8,12,0.94); border-bottom: 1px solid var(--line); backdrop-filter: blur(8px); }
    .bar { display: flex; align-items: center; gap: 18px; padding: 10px 18px; }
    .brand { font-weight: 700; letter-spacing: 0.01em; }
    .brand .dot { display: inline-block; width: 8px; height: 8px; border-radius: 999px; background: var(--mint); margin-right: 8px; }
    nav { display: flex; gap: 4px; }
    nav a { padding: 6px 10px; border-radius: 7px; color: var(--muted); }
    nav a.on { background: rgba(158,255,208,0.12); color: var(--mint); }
    .spacer { flex: 1; }
    .kpis { display: flex; gap: 8px; }
    .kpi { padding: 5px 10px; border: 1px solid var(--line); border-radius: 8px; display: flex; gap: 6px; align-items: baseline; }
    .kpi b { font-size: 14px; }
    .kpi span { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
    .kpi.alert b { color: var(--warn); }
    .toolbar { display: flex; gap: 10px; align-items: center; padding: 10px 18px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
    .toolbar input[type=search] { flex: 1; min-width: 220px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; color: var(--ink); padding: 8px 11px; font: inherit; }
    .chips { display: flex; gap: 6px; }
    .chip { padding: 6px 10px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); font-size: 12px; }
    .chip.on { background: rgba(158,255,208,0.12); color: var(--mint); border-color: rgba(158,255,208,0.3); }
    .toolbar label { color: var(--muted); font-size: 12px; display: flex; gap: 6px; align-items: center; }
    .toolbar select { background: var(--panel); border: 1px solid var(--line); border-radius: 7px; color: var(--ink); padding: 6px 8px; font: inherit; }
    main { padding: 0 18px 80px; }
    table { width: 100%; border-collapse: collapse; }
    thead th { position: sticky; top: 45px; background: var(--bg); text-align: left; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); font-weight: 600; padding: 10px 8px; border-bottom: 1px solid var(--line); }
    thead th a { color: inherit; }
    thead th.sorted a { color: var(--mint); }
    tbody td { padding: 8px; border-bottom: 1px solid rgba(255,255,255,0.05); vertical-align: middle; }
    tbody tr:hover { background: rgba(255,255,255,0.03); }
    tbody tr.sel { background: rgba(158,255,208,0.07); }
    td.pick, th.pick { width: 28px; }
    td.num, th.num { text-align: right; white-space: nowrap; }
    td.file { max-width: 520px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; }
    .tag.res-local { color: var(--mint); border-color: rgba(158,255,208,0.3); }
    .tag.res-unproven, .tag.res-none { color: var(--muted); border-style: dashed; }
    .tag.res-partial, .tag.res-transferring { color: var(--amber); border-color: rgba(255,202,122,0.3); }
    .reach { font-variant-numeric: tabular-nums; }
    .uncatalogued { color: var(--amber); margin-left: 2px; }
    .coords { color: var(--muted); font-size: 11px; }
    td.file .file-row { display: flex; align-items: center; gap: 10px; }
    td.file .file-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    td.file .file-name .link { background: none; border: 0; color: var(--ink); font: inherit; cursor: pointer; padding: 0; text-align: left; font-family: inherit; }
    td.file .file-name .link:hover { color: var(--mint); }
    a.play { flex: none; display: inline-flex; align-items: center; gap: 5px; padding: 4px 12px; border: 1px solid rgba(158,255,208,0.35); border-radius: 999px; color: var(--mint); font-size: 12px; font-weight: 700; letter-spacing: 0.02em; background: rgba(158,255,208,0.08); white-space: nowrap; }
    a.play:hover { background: rgba(158,255,208,0.22); border-color: var(--mint); }
    td.work { color: var(--ink); max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .none { color: rgba(139,147,167,0.6); }
    .tag { padding: 2px 8px; border-radius: 999px; font-size: 11px; border: 1px solid var(--line); }
    .tag.seeding, .tag.completed { color: var(--mint); border-color: rgba(158,255,208,0.3); }
    .tag.failed { color: var(--warn); border-color: rgba(255,122,162,0.3); }
    .tag.acquiring, .tag.verifying, .tag.publishing, .tag.queued { color: var(--amber); border-color: rgba(255,202,122,0.3); }
    .err { margin-left: 6px; color: var(--muted); font-size: 11px; }
    .pct { display: inline-flex; flex-direction: column; gap: 3px; min-width: 92px; font-variant-numeric: tabular-nums; }
    .pct .bar { display: block; height: 3px; background: rgba(255,255,255,0.08); border-radius: 999px; overflow: hidden; }
    .pct .bar i { display: block; height: 100%; background: var(--amber); }
    .pct.done { color: var(--mint); }
    .backups.risk { color: var(--warn); }
    tr.empty td { color: var(--muted); padding: 28px 8px; text-align: center; }
    .group-head td { background: rgba(255,255,255,0.04); font-weight: 600; }
    .bulk { position: fixed; left: 50%; transform: translateX(-50%); bottom: 18px; display: none; gap: 10px; align-items: center; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 10px 14px; box-shadow: 0 12px 40px rgba(0,0,0,0.5); }
    .bulk.on { display: flex; }
    button.act { background: rgba(255,255,255,0.06); border: 1px solid var(--line); color: var(--ink); border-radius: 8px; padding: 7px 12px; font: inherit; cursor: pointer; }
    button.act:hover { border-color: var(--mint); color: var(--mint); }
    button.act.danger:hover { border-color: var(--warn); color: var(--warn); }
    button.act[disabled] { opacity: 0.4; cursor: not-allowed; }
    .verb-result { position: fixed; left: 50%; transform: translateX(-50%); bottom: 78px; margin: 0; color: var(--muted); font-size: 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 6px 12px; max-width: 70vw; }
    .verb-result:empty { display: none; }
    aside.drawer { position: fixed; top: 0; right: 0; height: 100%; width: 420px; max-width: 92vw; background: var(--panel); border-left: 1px solid var(--line); transform: translateX(100%); transition: transform 0.15s ease-out; overflow-y: auto; z-index: 10; padding: 18px; }
    aside.drawer.on { transform: none; }
    aside.drawer h2 { font-size: 15px; margin: 0 0 4px; word-break: break-all; }
    aside.drawer dl { display: grid; grid-template-columns: 128px 1fr; gap: 6px 12px; margin: 16px 0; }
    aside.drawer dt { color: var(--muted); font-size: 12px; }
    aside.drawer dd { margin: 0; font-size: 12px; word-break: break-all; }
    aside.drawer .verbs { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
    dialog#player { width: min(920px, 94vw); padding: 14px; background: var(--panel); color: var(--ink); border: 1px solid var(--line); border-radius: 12px; }
    dialog#player::backdrop { background: rgba(0,0,0,0.72); }
    dialog#player .player-head { display: flex; gap: 12px; align-items: center; justify-content: space-between; margin-bottom: 10px; }
    dialog#player .player-head strong { font-size: 14px; word-break: break-all; }
    dialog#player video { width: 100%; max-height: 72vh; background: #000; border-radius: 8px; display: block; }
    dialog#player .player-note { margin: 10px 2px 0; color: var(--muted); font-size: 12px; min-height: 1em; }
    .foot { color: var(--muted); padding: 12px 2px; display: flex; gap: 12px; align-items: center; }
  </style>
</head>
<body>
  <header>
    <div class="bar">
      <div class="brand"><span class="dot"></span>PearTube Relay</div>
      <nav>
        <a class="on" href="/">Releases</a>
        <a href="/discover">Discover</a>
        <a href="/creators">Creators</a>
        <a href="/settings">Settings</a>
      </nav>
      <span class="spacer"></span>
      <div class="kpis">
        ${renderKpis(all, counts, status)}
      </div>
    </div>
    <form class="toolbar" method="get" action="/">
      <input type="search" name="q" id="q" value="${escapeHtml(query)}" placeholder="Search file name, work, coordinates or id  (press /)" autocomplete="off">
      ${selectedState ? `<input type="hidden" name="state" value="${escapeHtml(selectedState)}">` : ''}
      <div class="chips">
        ${FILTER_CHIPS.map(chip => `<a class="chip ${chip.state === selectedState ? 'on' : ''}" href="${escapeHtml(chipHref(params, chip.state))}">${escapeHtml(chip.label)}</a>`).join('')}
      </div>
      <label>Retention
        <select name="retention" onchange="this.form.submit()">
          <option value="">Any</option>
          ${['archive-pin', 'contribution-cache', 'ephemeral'].map(value => `<option value="${value}" ${params.get('retention') === value ? 'selected' : ''}>${RETENTION_LABELS[value]}</option>`).join('')}
        </select>
      </label>
      <label><input type="checkbox" name="group" value="work" ${grouped ? 'checked' : ''} onchange="this.form.submit()"> Group by work</label>
    </form>
  </header>
  <main>
    <table id="releases">
      <thead>
        <tr>
          <th class="pick"><input type="checkbox" id="pick-all" aria-label="Select every visible release"></th>
          ${COLUMNS.map(column => `<th class="${column.key === 'size' || column.key === 'backups' ? 'num' : ''} ${page.sort === column.key ? 'sorted' : ''}"><a href="${escapeHtml(sortHref(params, column.key, page.sort === column.key))}">${escapeHtml(column.label)}${page.sort === column.key ? (page.direction === 'asc' ? ' ↑' : ' ↓') : ''}</a></th>`).join('')}
        </tr>
      </thead>
      <tbody id="rows">${renderReleaseRows(page)}</tbody>
    </table>
    <div class="foot">
      <span id="count">${escapeHtml(page.matched)} of ${escapeHtml(page.total)} release${page.total === 1 ? '' : 's'}</span>
      <span>Sorted ${escapeHtml(page.sort === 'attention' ? 'by what needs attention, then newest' : `${page.sort} ${page.direction}`)}.</span>
      <span>Progress is verified bytes accepted by this relay. Rates and ETAs are omitted until the acquisition service exposes measured samples.</span>
    </div>
  </main>
  <div class="bulk" id="bulk">
    <span id="bulk-count">0 selected</span>
    <button type="button" class="act" id="bulk-retry">Retry failed</button>
    <button type="button" class="act danger" id="bulk-cancel">Cancel transfers</button>
    <button type="button" class="act danger" id="bulk-forget">Clear finished</button>
    <button type="button" class="act danger" id="bulk-delete">Delete selected</button>
    <button type="button" class="act" id="bulk-deselect">Deselect</button>
  </div>
  <p class="verb-result" id="verb-result" role="status" aria-live="polite"></p>
  <aside class="drawer" id="drawer" aria-hidden="true"></aside>
  ${model.localPlayback === true ? `<dialog id="player" aria-label="Release player">
    <div class="player-head">
      <strong id="player-title"></strong>
      <button type="button" class="act" id="player-close">Close</button>
    </div>
    <video id="player-video" controls preload="metadata" playsinline></video>
    <p class="player-note" id="player-note" role="status" aria-live="polite"></p>
  </dialog>` : ''}
  <script>
  (function () {
    var params = new URLSearchParams(window.location.search)
    var rows = document.getElementById('rows')
    var drawer = document.getElementById('drawer')
    var bulk = document.getElementById('bulk')
    var bulkCount = document.getElementById('bulk-count')
    var pickAll = document.getElementById('pick-all')
    var openId = null
    // A publisher names its own files, so every value here is untrusted input.
    // Every less-than is escaped in the bootstrap so no title can close this
    // script tag, and esc() runs over anything the drawer writes as HTML.
    var index = ${JSON.stringify(Object.fromEntries((page.rows || []).map(row => [row.id, row]))).replaceAll('<', '\\u003c')}
    ${model.localPlayback === true ? `
    var playerDialog = document.getElementById('player')
    var playerVideo = document.getElementById('player-video')
    var playerTitle = document.getElementById('player-title')
    var playerNote = document.getElementById('player-note')

    // Playback mounts the release link straight on the <video> element: the
    // media element follows the redirect to the backend blob server's loopback
    // link, then issues its own Range requests, so seeking pulls only the
    // blocks the playhead needs and the swarm delivers them as they land.
    function detachPlayerSource () {
      playerVideo.pause()
      playerVideo.removeAttribute('src')
      playerVideo.load()
    }

    function openPlayer (anchor) {
      var row = index[openId] || (function () { var tr = anchor.closest('tr[data-id]'); return tr ? index[tr.getAttribute('data-id')] : null })()
      playerTitle.textContent = row ? (row.file || row.work || 'Release') : 'Release'
      playerNote.textContent = 'Opening this release…'
      detachPlayerSource()
      playerVideo.src = anchor.getAttribute('href')
      playerDialog.showModal()
      playerVideo.play().catch(function () { /* autoplay refusal still shows controls */ })
    }

    // The first frames arriving mean the open worked; the loading note must
    // yield, and a stalled read-ahead is what the note is for after that.
    playerVideo.addEventListener('canplay', function () {
      playerNote.textContent = ''
    })
    playerVideo.addEventListener('waiting', function () {
      if (playerVideo.currentTime > 0) {
        playerNote.textContent = 'Buffering — the swarm is delivering the next blocks…'
      }
    })

    document.getElementById('player-close').addEventListener('click', function () {
      detachPlayerSource()
      if (playerDialog.open) playerDialog.close()
    })
    playerDialog.addEventListener('close', detachPlayerSource)
    ` : ''}

    function esc (value) {
      return String(value === null || value === undefined ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    }

    // Sizes read as sizes; the exact count stays available as the raw value in
    // the JSON projection rather than shouting eleven digits at the operator.
    function bytes (value) {
      var n = Number(value)
      if (!isFinite(n) || n <= 0) return null
      if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB (' + n + ' bytes)'
      if (n >= 1024 * 1024) return Math.round(n / (1024 * 1024)) + ' MB (' + n + ' bytes)'
      return Math.round(n / 1024) + ' KB (' + n + ' bytes)'
    }

    function selected () {
      return Array.prototype.filter.call(rows.querySelectorAll('tr[data-id]'), function (tr) {
        var box = tr.querySelector('.js-pick')
        return box && box.checked
      })
    }

    function syncBulk () {
      var picked = selected()
      picked.forEach(function (tr) { tr.classList.add('sel') })
      Array.prototype.forEach.call(rows.querySelectorAll('tr[data-id]'), function (tr) {
        var box = tr.querySelector('.js-pick')
        if (!box || !box.checked) tr.classList.remove('sel')
      })
      bulkCount.textContent = picked.length + ' selected'
      bulk.classList.toggle('on', picked.length > 0)
    }

    function fact (label, value) {
      if (value === null || value === undefined || value === '') return ''
      return '<dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd>'
    }

    function renderDrawer (row) {
      if (!row) { drawer.classList.remove('on'); drawer.setAttribute('aria-hidden', 'true'); openId = null; return }
      openId = row.id
      var name = row.file || row.id
      var backups = Number(row.backups) || 0
      ${model.localPlayback === true
        ? `var playPath = (row.playable === true && row.publicationId && row.renditionId) ? ('/play/pub/' + encodeURIComponent(row.publicationId) + '/' + encodeURIComponent(row.renditionId)) : (row.playable === true && row.candidateRef ? '/play/' + encodeURIComponent(row.candidateRef) : null)
      if (playPath) verbs.push('<a class="act js-play" href="' + playPath + '">▶ Play</a>')`
        : '// an externally bound console mints no operator playback capability'}
      if (row.acquisitionId && ['queued', 'acquiring', 'verifying', 'publishing'].indexOf(row.state) >= 0) {
        verbs.push('<button type="button" class="act danger" data-cancel="' + esc(row.acquisitionId) + '">Cancel transfer</button>')
      }
      if (row.acquisitionId && row.state === 'failed' && row.recoverable !== false) {
        verbs.push('<button type="button" class="act" data-retry="' + esc(row.acquisitionId) + '">Retry transfer</button>')
      }
      if (row.acquisitionId && ['completed', 'failed', 'cancelled'].indexOf(row.state) >= 0) {
        verbs.push('<button type="button" class="act danger" data-forget="' + esc(row.acquisitionId) + '">Clear record</button>')
      }
      verbs.push('<button type="button" class="act danger" data-delete="' + esc(row.id) + '">Delete release</button>')
      drawer.innerHTML = '<button type="button" class="act" id="drawer-close">Close</button>' +
        '<h2>' + esc(name) + '</h2>' +
        '<dl>' +
        fact('Release file', row.file) +
        fact('Work', row.work) +
        fact('Coordinates', row.coordinates) +
        fact('State', row.state) +
        fact('Catalogued', row.catalogued ? 'a signed catalog entry names this release' : 'no catalog entry names it yet') +
        fact('Claimed size', bytes(row.sizeBytes)) +
        fact('Reach', row.reachDetail || 'no availability observation covers this release') +
        fact('Durability', backups + ' independent device(s) proved a copy') +
        fact('Residency', row.residency + ' — ' + row.residencyDetail) +
        fact('Bytes accepted here', bytes(row.bytesAcquired)) +
        fact('Retention', row.retentionClass) +
        fact('Publication', row.publicationId) +
        fact('Rendition', row.renditionId) +
        fact('Acquisition', row.acquisitionId) +
        fact('Error', row.errorCode ? row.errorCode + (row.recoverable ? ' (retryable)' : ' (terminal)') : null) +
        fact('Updated', row.updatedAt ? new Date(row.updatedAt).toISOString() : null) +
        '</dl>' +
        '<div class="verbs">' + verbs.join('') + '</div>' +
        (verbs.length ? '' : '<p class="none">No verb applies to this release in its current state.</p>')
      drawer.classList.add('on')
      drawer.setAttribute('aria-hidden', 'false')
    }

    // Every verb reports what the relay actually did. A cancel aimed at a
    // finished job changes nothing, and saying so beats a silent refresh that
    // reads as a broken button.
    async function runVerb (verb, ids, prompt) {
      var result = document.getElementById('verb-result')
      if (!ids.length) {
        result.textContent = verb === 'clear'
          ? 'Nothing to clear: select a finished release first.'
          : (verb === 'delete' ? 'Nothing to delete: select a release first.' : (verb === 'retry' ? 'Nothing to retry: select a failed release first.' : 'Nothing to cancel: select a transfer that is still running.'))
        return
      }
      if (!window.confirm(prompt)) return
      try {
        var endpoint = '/releases/' + (verb === 'clear' ? 'clear' : (verb === 'delete' ? 'delete' : (verb === 'retry' ? 'retry' : 'cancel')))
        var res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'ids=' + encodeURIComponent(ids.join(','))
        })
        var body = await res.json()
        var done = (body.done || []).length
        var refused = body.refused || []
        result.textContent = done + ' ' + (verb === 'clear' ? 'cleared' : (verb === 'delete' ? 'deleted' : (verb === 'retry' ? 'retried' : 'cancelled'))) +
          (refused.length
            ? '; ' + refused.length + ' refused: ' + refused.map(function (row) { return (row.id || row.acquisitionId || '').slice(0, 10) + ' ' + (row.reason || 'no reason given') }).join(', ')
            : '')
      } catch (err) {
        result.textContent = 'The relay did not answer that request.'
      }
      refresh()
    }

    async function refresh () {
      try {
        var res = await fetch('/releases.json?' + params.toString(), { headers: { accept: 'application/json' } })
        var data = await res.json()
        var picked = {}
        selected().forEach(function (tr) { picked[tr.getAttribute('data-id')] = true })
        var html = await fetch('/releases.html?' + params.toString())
        rows.innerHTML = await html.text()
        index = {}
        ;(data.rows || []).forEach(function (row) { index[row.id] = row })
        Array.prototype.forEach.call(rows.querySelectorAll('tr[data-id]'), function (tr) {
          if (picked[tr.getAttribute('data-id')]) {
            var box = tr.querySelector('.js-pick')
            if (box) box.checked = true
          }
        })
        document.getElementById('count').textContent = data.matched + ' of ' + data.total + ' release' + (data.total === 1 ? '' : 's')
        if (openId && index[openId]) renderDrawer(index[openId])
        syncBulk()
      } catch (err) { /* a poll that fails leaves the last good table on screen */ }
    }

    document.addEventListener('click', function (ev) {
      ${model.localPlayback === true ? `
      var play = ev.target.closest && ev.target.closest('.js-play')
      if (play) { ev.preventDefault(); openPlayer(play); return }
      ` : ''}
      var open = ev.target.closest && ev.target.closest('.js-open')
      if (open) { renderDrawer(index[open.closest('tr').getAttribute('data-id')]); return }
      if (ev.target.id === 'drawer-close') { renderDrawer(null); return }
      var one = ev.target.closest && ev.target.closest('[data-cancel]')
      if (one) {
        var tr = rows.querySelector('tr[data-acquisition="' + one.getAttribute('data-cancel') + '"]')
        runVerb('cancel', [one.getAttribute('data-cancel')], 'Cancel ' + (tr ? tr.getAttribute('data-name') : 'this transfer') + '? Bytes already accepted stay on this relay.')
        return
      }
      var retryOne = ev.target.closest && ev.target.closest('[data-retry]')
      if (retryOne) {
        var retryTr = rows.querySelector('tr[data-acquisition="' + retryOne.getAttribute('data-retry') + '"]')
        runVerb('retry', [retryOne.getAttribute('data-retry')], 'Retry ' + (retryTr ? retryTr.getAttribute('data-name') : 'this transfer') + '?')
        return
      }
      var forgetOne = ev.target.closest && ev.target.closest('[data-forget]')
      if (forgetOne) {
        var forgetRow = rows.querySelector('tr[data-acquisition="' + forgetOne.getAttribute('data-forget') + '"]')
        var backups = forgetRow ? forgetRow.getAttribute('data-backups') : '0'
        runVerb('clear', [forgetOne.getAttribute('data-forget')],
          'Clear ' + (forgetRow ? forgetRow.getAttribute('data-name') : 'this record') + ' from the job list? ' +
          backups + ' other device(s) proved a copy. The record and its history are deleted; archived bytes are not.')
        return
      }
      var deleteOne = ev.target.closest && ev.target.closest('[data-delete]')
      if (deleteOne) {
        var delId = deleteOne.getAttribute('data-delete')
        var delRow = index[delId]
        var delName = delRow ? (delRow.file || delRow.work || delId) : 'this release'
        runVerb('delete', [delId], 'Delete ' + delName + '? This will retract and remove it from the relay catalog.')
        return
      }
      // Only running work can be cancelled, and only finished work can be
      // cleared, so each verb sends exactly the rows it can act on.
      if (ev.target.id === 'bulk-retry') {
        var failed = selected().filter(function (tr) {
          var row = index[tr.getAttribute('data-id')]
          return tr.getAttribute('data-acquisition') && row && row.state === 'failed' && row.recoverable !== false
        })
        runVerb('retry', failed.map(function (tr) { return tr.getAttribute('data-acquisition') }),
          'Retry ' + failed.length + ' failed transfer(s)?')
        return
      }
      if (ev.target.id === 'bulk-cancel') {
        var running = selected().filter(function (tr) {
          var row = index[tr.getAttribute('data-id')]
          return tr.getAttribute('data-acquisition') && row && ['queued', 'acquiring', 'verifying', 'publishing'].indexOf(row.state) >= 0
        })
        runVerb('cancel', running.map(function (tr) { return tr.getAttribute('data-acquisition') }),
          'Cancel ' + running.length + ' transfer(s)? Bytes already accepted stay on this relay.')
        return
      }
      if (ev.target.id === 'bulk-forget') {
        var finished = selected().filter(function (tr) {
          var row = index[tr.getAttribute('data-id')]
          return tr.getAttribute('data-acquisition') && row && ['completed', 'failed', 'cancelled'].indexOf(row.state) >= 0
        })
        runVerb('clear', finished.map(function (tr) { return tr.getAttribute('data-acquisition') }),
          'Clear ' + finished.length + ' finished record(s) from the job list? Their history is deleted; archived bytes are not.')
        return
      }
      if (ev.target.id === 'bulk-delete') {
        var targets = selected().map(function (tr) { return tr.getAttribute('data-id') }).filter(Boolean)
        runVerb('delete', targets, 'Delete ' + targets.length + ' selected release(s)? This will retract and remove them from the relay catalog.')
        return
      }
      if (ev.target.id === 'bulk-deselect') {
        selected().forEach(function (tr) { tr.querySelector('.js-pick').checked = false })
        pickAll.checked = false
        syncBulk()
      }
    })

    document.addEventListener('change', function (ev) {
      if (ev.target === pickAll) {
        Array.prototype.forEach.call(rows.querySelectorAll('.js-pick'), function (box) { box.checked = pickAll.checked })
      }
      if (ev.target.classList && ev.target.classList.contains('js-pick')) syncBulk()
      if (ev.target === pickAll) syncBulk()
    })

    document.addEventListener('keydown', function (ev) {
      if (ev.key === '/' && document.activeElement !== document.getElementById('q')) {
        ev.preventDefault()
        document.getElementById('q').focus()
      }
      if (ev.key === 'Escape') renderDrawer(null)
    })

    setInterval(refresh, 4000)
  })()
  </script>
</body>
</html>`
}
