import { buildRelayPosture, describeRelayPosture, normalizeRelayRoles } from './relay-roles.js'

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function getPostureModel(model = {}) {
  const relayStatus = model.relayStatus || {}
  const roles = normalizeRelayRoles(relayStatus.roles)
  const posture = relayStatus.posture || buildRelayPosture(roles)

  return {
    roles,
    posture,
    description: describeRelayPosture(posture)
  }
}

export function renderArchiveTui(model = {}) {
  const status = model.status || {}
  const seeding = status.seeding || {}
  const jobs = Array.isArray(model.jobs) ? model.jobs : []
  const posture = getPostureModel(model)
  const lines = [
    'PearTube Relay Archive Console',
    '================================',
    `roles: ${posture.roles.join(',')}`,
    `posture: ${posture.description}`,
    '',
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

export function renderArchiveWebHome(model = {}) {
  const status = model.status || {}
  const seeding = status.seeding || {}
  const jobs = Array.isArray(model.jobs) ? model.jobs : []
  const posture = getPostureModel(model)
  const publicBaseUrl = typeof model.publicBaseUrl === 'string' ? model.publicBaseUrl : ''
  const catalogUrl = publicBaseUrl ? `${publicBaseUrl.replace(/\/$/, '')}/catalog.json` : '/catalog.json'
  const rows = jobs.length
    ? jobs.map((job) => `
        <li>
          <span class="job-id">${escapeHtml(job.id)}</span>
          <span class="pill ${escapeHtml(job.status)}">${escapeHtml(job.status)}</span>
          <strong>${escapeHtml(job.title || 'Untitled archive')}</strong>
          <small>${escapeHtml(job.channelName || 'Anonymous Archive')}</small>
          ${job.error ? `<code>${escapeHtml(job.error)}</code>` : ''}
        </li>`).join('')
    : '<li class="empty">No archive jobs yet.</li>'

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PearTube Relay Archive</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif; background: #07080c; color: #f5f7fb; }
    body { margin: 0; min-height: 100vh; background: radial-gradient(circle at top left, #14213d 0, #07080c 46rem); }
    main { max-width: 980px; margin: 0 auto; padding: 42px 20px 80px; }
    h1 { margin: 0 0 8px; font-size: clamp(32px, 5vw, 58px); letter-spacing: -0.05em; }
    p { color: #aab3c5; line-height: 1.55; }
    a { color: #9effd0; }
    .stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 28px 0; }
    .stat, form, .queue, .catalog, .posture { border: 1px solid rgba(255,255,255,0.12); background: rgba(12,15,25,0.76); border-radius: 18px; padding: 18px; box-shadow: 0 20px 80px rgba(0,0,0,0.24); }
    .stat b { display: block; font-size: 28px; }
    .posture { margin: 24px 0; border-color: rgba(158,255,208,0.28); }
    .posture strong { display: block; margin-bottom: 8px; color: #9effd0; }
    .posture p { margin: 6px 0 0; }
    form { display: grid; gap: 14px; margin: 24px 0; }
    label { display: grid; gap: 6px; color: #c8d1e4; font-weight: 650; }
    input, textarea { width: 100%; box-sizing: border-box; border: 1px solid rgba(255,255,255,0.14); background: #0c101a; color: #f5f7fb; border-radius: 12px; padding: 12px 13px; font: inherit; }
    button { justify-self: start; border: 0; border-radius: 999px; padding: 12px 18px; color: #071016; background: #9effd0; font-weight: 800; cursor: pointer; }
    ul { padding: 0; list-style: none; display: grid; gap: 10px; }
    li { display: grid; gap: 6px; border-top: 1px solid rgba(255,255,255,0.08); padding: 14px 0; }
    .job-id, small, code { color: #91a0b8; }
    .pill { width: max-content; border-radius: 999px; padding: 3px 9px; background: rgba(255,255,255,0.1); color: #dce5f8; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
    .completed { background: rgba(80, 255, 174, 0.18); color: #9effd0; }
    .failed { background: rgba(255, 91, 91, 0.18); color: #ffabab; }
    .running { background: rgba(91, 176, 255, 0.18); color: #b9ddff; }
    @media (max-width: 720px) { .stats { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <h1>PearTube Relay Archive</h1>
    <p>Archive videos into a relay-owned anonymous channel and publish availability to the PearTube network. Source URLs stay in the local container job input store; public job status only exposes imported metadata.</p>
    <section class="posture">
      <strong>roles: ${escapeHtml(posture.roles.join(','))}</strong>
      <p>${escapeHtml(posture.description)}</p>
      <p>Public index stores public metadata for discovery. Archive is publisher content chosen by this operator.</p>
    </section>
    <section class="stats">
      <div class="stat"><span>Peers</span><b>${escapeHtml(status.peers || 0)}</b></div>
      <div class="stat"><span>Feed entries</span><b>${escapeHtml(status.feedEntries || 0)}</b></div>
      <div class="stat"><span>Seeded videos</span><b>${escapeHtml(seeding.videos || 0)}</b></div>
    </section>
    <section class="catalog">
      <h2>Simple relay catalog</h2>
      <p>Clients can import this URL directly instead of waiting for live P2P feed gossip. This is the fallback path for unreliable relay discovery.</p>
      <p><a href="${escapeHtml(catalogUrl)}">${escapeHtml(catalogUrl)}</a></p>
      <code>${escapeHtml(catalogUrl)}</code>
    </section>
    <form method="post" action="/archive">
      <label>Video or channel URL<input name="url" required placeholder="https://www.youtube.com/watch?v=..."></label>
      <label>Invidious fallback instance<input name="invidiousInstance" placeholder="Optional, e.g. https://inv.thepixora.com"><small>Used only if direct YouTube archive hits a bot-check/403. The relay tries the instance's direct media endpoint before the watch page.</small></label>
      <label>Anonymous channel name<input name="channelName" value="Anonymous Archive"></label>
      <label>Title override<input name="title" placeholder="Optional"></label>
      <label>Description override<textarea name="description" rows="4" placeholder="Optional"></textarea></label>
      <label><input type="checkbox" name="publish" value="true" checked> Publish to network after import</label>
      <button type="submit">Archive and publish</button>
    </form>
    <section class="queue">
      <h2>Queue</h2>
      <ul>${rows}</ul>
    </section>
  </main>
</body>
</html>`
}
