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

function getAlertModel(model = {}) {
  const relayStatus = model.relayStatus || {}
  const alerts = Array.isArray(model.alerts)
    ? model.alerts
    : (Array.isArray(relayStatus.alerts?.latest) ? relayStatus.alerts.latest : [])
  return alerts
}

function getReviewModel(model = {}) {
  const relayStatus = model.relayStatus || {}
  const reviewQueue = Array.isArray(model.reviewQueue)
    ? model.reviewQueue
    : (Array.isArray(relayStatus.reviewQueue) ? relayStatus.reviewQueue : [])
  return reviewQueue
}

function targetHref(item = {}) {
  return `/moderation/target?targetType=${encodeURIComponent(item.targetType || '')}&target=${encodeURIComponent(item.target || '')}`
}

function renderVideoRefs(videos = []) {
  if (!videos.length) return '<li class="empty">No video refs recorded.</li>'
  return videos.map((video) => `
    <li>
      <strong>${escapeHtml(video.title || video.id || 'Untitled video')}</strong>
      <small>id=${escapeHtml(video.id || 'none')} blobId=${escapeHtml(video.blobId || 'none')} blobsCoreKey=${escapeHtml(video.blobsCoreKey || 'none')}</small>
      ${video.thumbnailBlobId || video.thumbnailBlobsCoreKey ? `<small>thumbnailBlobId=${escapeHtml(video.thumbnailBlobId || 'none')} thumbnailBlobsCoreKey=${escapeHtml(video.thumbnailBlobsCoreKey || 'none')}</small>` : ''}
      ${video.reason ? `<small>reason=${escapeHtml(video.reason)}</small>` : ''}
    </li>`).join('')
}

export function renderArchiveTui(model = {}) {
  const status = model.status || {}
  const seeding = status.seeding || {}
  const jobs = Array.isArray(model.jobs) ? model.jobs : []
  const posture = getPostureModel(model)
  const alerts = getAlertModel(model)
  const reviewQueue = getReviewModel(model)
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
    'Alerts:'
  ]

  if (!alerts.length) {
    lines.push('  No active alerts.')
  } else {
    for (const alert of alerts) {
      lines.push(`  ${alert.severity} ${alert.category} ${alert.targetType}:${alert.target} ${alert.summary}`)
    }
  }

  lines.push(
    '',
    'Review Queue:'
  )

  if (!reviewQueue.length) {
    lines.push('  No items waiting for review.')
  } else {
    for (const item of reviewQueue) {
      lines.push(`  ${item.state} ${item.targetType}:${item.target} owner=${item.ownerKey || 'none'} bytes=${item.bytes || 0} videos=${item.videoCount || 0}`)
    }
  }

  lines.push(
    '',
    'Queue:'
  )

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
  const alerts = getAlertModel(model)
  const reviewQueue = getReviewModel(model)
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
  const alertRows = alerts.length
    ? alerts.map((alert) => `
        <li>
          <span class="pill ${escapeHtml(alert.severity)}">${escapeHtml(alert.severity)}</span>
          <strong>${escapeHtml(alert.summary)}</strong>
          <small>${escapeHtml(alert.category)} ${escapeHtml(alert.targetType)}:${escapeHtml(alert.target)}</small>
          ${Array.isArray(alert.suggestedActions) && alert.suggestedActions.length ? `<small>${escapeHtml(alert.suggestedActions.join(', '))}</small>` : ''}
        </li>`).join('')
    : '<li class="empty">No active alerts.</li>'
  const reviewRows = reviewQueue.length
    ? reviewQueue.map((item) => `
        <li>
          <strong><a href="${escapeHtml(targetHref(item))}">${escapeHtml(item.targetType)}:${escapeHtml(item.target)}</a></strong>
          <small>${escapeHtml(item.state)} ${escapeHtml(item.source || 'unknown')} ${escapeHtml(item.retentionClass || 'unknown')} owner=${escapeHtml(item.ownerKey || 'none')} bytes=${escapeHtml(item.bytes || 0)} videos=${escapeHtml(item.videoCount || 0)}</small>
          ${item.reportCount ? `<small>reports=${escapeHtml(item.reportCount)} latest=${escapeHtml(item.reportReason || item.reason || 'other')} ${escapeHtml(item.reportComment || item.comment || '')}</small>` : ''}
          <form class="review-actions" method="post" action="/moderation/action">
            <input type="hidden" name="targetType" value="${escapeHtml(item.targetType)}">
            <input type="hidden" name="target" value="${escapeHtml(item.target)}">
            <input type="hidden" name="reason" value="operator-review">
            <button type="submit" name="action" value="watch">Watch</button>
            <button type="submit" name="action" value="quarantine">Quarantine</button>
            <button type="submit" name="action" value="block">Block</button>
          </form>
        </li>`).join('')
    : '<li class="empty">No items waiting for review.</li>'

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
    .stat, form, .queue, .catalog, .posture, .alerts, .review { border: 1px solid rgba(255,255,255,0.12); background: rgba(12,15,25,0.76); border-radius: 18px; padding: 18px; box-shadow: 0 20px 80px rgba(0,0,0,0.24); }
    .stat b { display: block; font-size: 28px; }
    .posture { margin: 24px 0; border-color: rgba(158,255,208,0.28); }
    .posture strong { display: block; margin-bottom: 8px; color: #9effd0; }
    .posture p { margin: 6px 0 0; }
    form { display: grid; gap: 14px; margin: 24px 0; }
    .review-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 4px 0 0; padding: 0; border: 0; background: transparent; box-shadow: none; }
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
    .critical { background: rgba(255, 91, 91, 0.18); color: #ffabab; }
    .warning { background: rgba(255, 202, 91, 0.18); color: #ffe1a1; }
    .info { background: rgba(91, 176, 255, 0.18); color: #b9ddff; }
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
    <section class="alerts">
      <h2>Alerts</h2>
      <ul>${alertRows}</ul>
    </section>
    <section class="review">
      <h2>Review Queue</h2>
      <p><a href="/moderation/audit.json">Export moderation audit JSON</a></p>
      <form class="report-form" method="post" action="/moderation/report">
        <select name="targetType" aria-label="Report target type">
          <option value="channel">Channel</option>
          <option value="owner">Owner</option>
          <option value="videoId">Video</option>
          <option value="blobCore">Blob core</option>
          <option value="feedEntry">Feed entry</option>
        </select>
        <input name="target" placeholder="target key or id" required>
        <select name="reason" aria-label="Report reason">
          <option value="spam">Spam</option>
          <option value="abuse">Abuse</option>
          <option value="copyright">Copyright</option>
          <option value="malware">Malware</option>
          <option value="other">Other</option>
        </select>
        <input name="comment" placeholder="optional comment">
        <button type="submit">Report</button>
      </form>
      <ul>${reviewRows}</ul>
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

export function renderModerationTargetDetail(model = {}) {
  const detail = model.detail || {}
  const channels = Array.isArray(detail.channels) ? detail.channels : []
  const cacheStatus = detail.cacheStatus || {}
  const channelRows = channels.length
    ? channels.map((channel) => `
      <section class="target-channel">
        <h2>${escapeHtml(channel.channelKey || 'unknown channel')}</h2>
        <p>source=${escapeHtml(channel.source || 'unknown')} retention=${escapeHtml(channel.retentionClass || 'unknown')} bytes=${escapeHtml(channel.bytes || 0)} videos=${escapeHtml(channel.videoCount || 0)} relayServing=${escapeHtml(channel.relayServing === true)}</p>
        <dl>
          <dt>publicBeeKey</dt><dd><code>${escapeHtml(channel.publicBeeKey || 'none')}</code></dd>
          <dt>ownerKey</dt><dd><code>${escapeHtml(channel.ownerKey || 'none')}</code></dd>
          <dt>lastDecision</dt><dd>${escapeHtml(channel.lastDecisionReason || 'none')}</dd>
          <dt>moderation</dt><dd>${escapeHtml(channel.moderation?.state || 'none')} ${escapeHtml(channel.moderation?.action || '')}</dd>
        </dl>
        <h3>Preview Refs</h3>
        <ul>${renderVideoRefs(channel.previewVideos || [])}</ul>
        <h3>Unavailable Refs</h3>
        <ul>${renderVideoRefs(channel.unavailableVideos || [])}</ul>
      </section>`).join('')
    : '<p>No local cache or catalog records match this target.</p>'

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PearTube Moderation Target</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif; background: #07080c; color: #f5f7fb; }
    body { margin: 0; min-height: 100vh; background: #07080c; }
    main { max-width: 980px; margin: 0 auto; padding: 42px 20px 80px; }
    a { color: #9effd0; }
    h1 { margin: 0 0 12px; font-size: clamp(28px, 4vw, 42px); }
    section { border-top: 1px solid rgba(255,255,255,0.12); padding: 18px 0; }
    p, small, dd { color: #aab3c5; }
    code { color: #dce5f8; overflow-wrap: anywhere; }
    dl { display: grid; grid-template-columns: 140px minmax(0, 1fr); gap: 8px 14px; }
    ul { padding: 0; list-style: none; display: grid; gap: 10px; }
    li { display: grid; gap: 6px; padding: 10px 0; border-top: 1px solid rgba(255,255,255,0.08); }
  </style>
</head>
<body>
  <main>
    <p><a href="/">Back to dashboard</a></p>
    <h1>${escapeHtml(detail.targetType || 'target')}:${escapeHtml(detail.target || '')}</h1>
    <p>matchedChannels=${escapeHtml(detail.matchedChannels || 0)} bytes=${escapeHtml(cacheStatus.bytes || 0)} videos=${escapeHtml(cacheStatus.videoCount || 0)}</p>
    <p>retention=${escapeHtml((cacheStatus.retentionClasses || []).join(',') || 'none')} source=${escapeHtml((cacheStatus.sources || []).join(',') || 'none')}</p>
    ${channelRows}
  </main>
</body>
</html>`
}
