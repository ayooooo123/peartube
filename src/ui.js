// The whole UI: one page that polls /v1/status and /v1/jobs. Every job field
// is rendered with textContent, so titles cannot inject markup.
export const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PearTube relay</title>
<style>
  :root { color-scheme: dark; --bg: #0f1115; --card: #171a21; --line: #262b36; --text: #e6e8ee; --dim: #8a91a3; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.4 system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); }
  main { max-width: 960px; margin: 0 auto; padding: 24px 16px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .facts { color: var(--dim); margin-bottom: 20px; display: flex; gap: 16px; flex-wrap: wrap; }
  .facts b { color: var(--text); font-weight: 600; }
  .job { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; margin-bottom: 8px; }
  .row { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
  .title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { color: var(--dim); font-size: 12px; margin-top: 4px; }
  .badge { font-size: 12px; padding: 2px 8px; border-radius: 99px; white-space: nowrap; }
  .queued { background: #2a2f3a; } .running, .announcing { background: #1d3b66; }
  .done { background: #1b4d32; } .failed { background: #5c1f24; } .cancelled { background: #3a3a3a; }
  .bar { height: 4px; background: var(--line); border-radius: 2px; margin-top: 8px; overflow: hidden; }
  .bar > div { height: 100%; background: #4c8dff; }
  .error { color: #ff8a8a; font-size: 12px; margin-top: 4px; }
  .empty { color: var(--dim); padding: 24px 0; }
</style>
</head>
<body>
<main>
  <h1>PearTube relay</h1>
  <div class="facts" id="facts"></div>
  <div id="jobs"></div>
</main>
<script>
const $ = id => document.getElementById(id)
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }
const size = n => n == null ? '' : n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? (n / 1e3).toFixed(0) + ' KB' : n + ' B'
const ago = t => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? s + 's ago' : s < 3600 ? Math.round(s / 60) + 'm ago' : s < 86400 ? Math.round(s / 3600) + 'h ago' : Math.round(s / 86400) + 'd ago' }

function fact (label, value) {
  const f = el('span', null, label + ' ')
  f.append(el('b', null, value))
  return f
}

function job (j) {
  const card = el('div', 'job')
  const row = el('div', 'row')
  row.append(el('div', 'title', j.title || j.id), el('span', 'badge ' + j.status, j.status))
  const bytes = j.status === 'done' ? size(j.size) : j.bytes ? size(j.bytes) + (j.total ? ' of ' + size(j.total) : '') : ''
  card.append(row, el('div', 'meta', [j.id, bytes, ago(j.created)].filter(Boolean).join(' \\u00b7 ')))
  if (j.status === 'running' && j.total) {
    const bar = el('div', 'bar')
    const fill = el('div')
    fill.style.width = Math.min(100, (j.bytes || 0) / j.total * 100) + '%'
    bar.append(fill)
    card.append(bar)
  }
  if (j.error && j.status !== 'done') card.append(el('div', 'error', j.error))
  return card
}

async function refresh () {
  try {
    const [status, list] = await Promise.all([fetch('/v1/status').then(r => r.json()), fetch('/v1/jobs').then(r => r.json())])
    $('facts').replaceChildren(fact('peers', status.peers), fact('stored', size(status.blobBytes)), fact('tracker', status.tracker.slice(0, 12) + '\\u2026'))
    const jobs = list.jobs.slice().sort((a, b) => b.created - a.created)
    $('jobs').replaceChildren(...(jobs.length ? jobs.map(job) : [el('div', 'empty', 'No acquisitions yet.')]))
  } catch (err) {
    $('facts').replaceChildren(el('span', 'error', 'Relay unreachable: ' + err.message))
  }
}
refresh()
setInterval(refresh, 3000)
</script>
</body>
</html>
`
