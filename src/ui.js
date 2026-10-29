// Single-page dashboard for relays & local client daemons; textContent guards every peer string.
export const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PearTube</title>
<style>
  :root { color-scheme: dark; --bg: #0c0e12; --panel: #12151a; --card: #191d24; --hover: #222731; --line: #252a34; --text: #eceef3; --dim: #8d95a6; --brand: #9fd356; --brand-ink: #11160a; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); }
  a { color: inherit; }
  svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; flex: none; }
  .top { position: fixed; inset: 0 0 auto 0; height: 60px; z-index: 20; display: flex; align-items: center; gap: 16px; padding: 0 16px; background: var(--panel); border-bottom: 1px solid var(--line); }
  .logo { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 18px; text-decoration: none; letter-spacing: -.01em; }
  .logo .mark { width: 30px; height: 30px; border-radius: 9px; background: var(--brand); color: var(--brand-ink); display: grid; place-items: center; }
  .logo .mark svg { width: 18px; height: 18px; stroke-width: 2.4; }
  .search { flex: 1; max-width: 560px; margin: 0 auto; position: relative; }
  .search input { width: 100%; height: 38px; border-radius: 99px; padding: 0 16px 0 40px; background: var(--bg); }
  .search svg { position: absolute; left: 13px; top: 9px; color: var(--dim); }
  .menu { display: none; }
  .side { position: fixed; top: 60px; bottom: 0; left: 0; width: 230px; z-index: 15; overflow-y: auto; padding: 12px 10px; background: var(--panel); border-right: 1px solid var(--line); display: flex; flex-direction: column; gap: 2px; }
  .nav { display: flex; align-items: center; gap: 14px; padding: 9px 12px; border-radius: 8px; text-decoration: none; color: var(--dim); font-weight: 500; }
  .nav:hover { background: var(--hover); color: var(--text); }
  .nav.on { background: var(--hover); color: var(--text); }
  .nav.on svg { color: var(--brand); }
  .side h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--dim); margin: 16px 12px 6px; font-weight: 600; }
  .side .nav .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .stats { margin-top: auto; padding: 12px; color: var(--dim); font-size: 12px; border-top: 1px solid var(--line); display: grid; gap: 4px; }
  .stats b { color: var(--text); font-weight: 600; }
  .stats .links { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
  main { margin: 60px 0 0 230px; padding: 24px 28px 48px; min-height: calc(100vh - 60px); }
  h1 { font-size: 20px; margin: 0 0 16px; }
  h2 { font-size: 16px; margin: 28px 0 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 22px 16px; }
  .vcard { cursor: pointer; min-width: 0; }
  .thumb { position: relative; aspect-ratio: 16 / 9; border-radius: 10px; overflow: hidden; display: grid; place-items: center; transition: transform .15s; }
  .vcard:hover .thumb { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0, 0, 0, .45); }
  .thumb .big { font-size: clamp(20px, 2.1vw, 30px); overflow-wrap: anywhere; font-weight: 800; color: rgba(255, 255, 255, .88); letter-spacing: -.02em; text-shadow: 0 2px 12px rgba(0, 0, 0, .35); padding: 0 16px; text-align: center; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; line-height: 1.1; }
  .thumb .play { position: absolute; width: 52px; height: 52px; border-radius: 50%; background: rgba(0, 0, 0, .55); display: grid; place-items: center; opacity: 0; transition: opacity .15s; }
  .thumb .play svg { width: 24px; height: 24px; fill: #fff; stroke: none; margin-left: 3px; }
  .vcard:hover .play { opacity: 1; }
  .thumb .tag { position: absolute; font-size: 11px; font-weight: 600; padding: 2px 6px; border-radius: 4px; background: rgba(0, 0, 0, .75); }
  .thumb .tl { top: 8px; left: 8px; } .thumb .br { bottom: 8px; right: 8px; }
  .thumb .tag.local { background: var(--brand); color: var(--brand-ink); }
  .thumb .copy { position: absolute; top: 6px; right: 6px; opacity: 0; }
  .vcard:hover .copy { opacity: 1; }
  .vinfo { display: flex; gap: 10px; margin-top: 10px; }
  .vtitle { font-weight: 600; line-height: 1.3; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .vmeta { color: var(--dim); font-size: 12.5px; margin-top: 3px; }
  .vmeta a { text-decoration: none; } .vmeta a:hover { color: var(--text); }
  .avatar { width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; color: #fff; flex: none; font-size: 15px; }
  .avatar.sm { width: 26px; height: 26px; font-size: 12px; }
  .avatar.lg { width: 84px; height: 84px; font-size: 34px; border: 4px solid var(--bg); }
  .banner { height: 150px; border-radius: 12px; }
  .chead { display: flex; align-items: flex-end; gap: 16px; margin: -42px 0 24px 24px; flex-wrap: wrap; }
  .chead .who { flex: 1; min-width: 200px; padding-bottom: 6px; }
  .chead .who h1 { margin: 0; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; margin-bottom: 8px; }
  .row { display: flex; justify-content: space-between; gap: 10px; align-items: center; flex-wrap: wrap; }
  .grow { flex: 1; min-width: 0; display: flex; gap: 12px; align-items: center; }
  .title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { color: var(--dim); font-size: 12px; margin-top: 3px; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 99px; background: #2a2f3a; white-space: nowrap; }
  .running, .announcing, .queued { background: #1d3b66; } .done, .seeder { background: #24481d; } .failed { background: #5c1f24; }
  .bar { height: 4px; background: var(--line); border-radius: 2px; margin-top: 8px; overflow: hidden; }
  .bar > div { height: 100%; background: var(--brand); }
  .error { color: #ff8a8a; font-size: 13px; margin: 6px 0; }
  .empty { color: var(--dim); padding: 40px 0; text-align: center; }
  .empty svg { width: 44px; height: 44px; display: block; margin: 0 auto 10px; stroke-width: 1.5; }
  input, select { background: var(--card); color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; font: inherit; outline: none; }
  input:focus, select:focus { border-color: var(--brand); }
  label { display: grid; gap: 6px; font-size: 13px; color: var(--dim); }
  button, a.btn { display: inline-flex; align-items: center; gap: 6px; background: #262b36; color: var(--text); border: 1px solid #363d4d; border-radius: 8px; padding: 6px 12px; font: inherit; font-size: 13px; font-weight: 500; cursor: pointer; text-decoration: none; white-space: nowrap; }
  button.primary, a.btn.primary { background: var(--brand); border-color: var(--brand); color: var(--brand-ink); font-weight: 600; }
  button.ghost { background: transparent; border-color: transparent; }
  button:hover:not(:disabled), a.btn:hover { background: #323947; }
  button.primary:hover:not(:disabled) { background: #b2e06e; }
  button.ghost:hover:not(:disabled) { background: var(--hover); }
  button:disabled { opacity: .45; cursor: default; }
  button svg, a.btn svg { width: 16px; height: 16px; }
  .sheet { position: fixed; inset: 0; z-index: 50; background: rgba(5, 6, 9, .72); display: none; align-items: center; justify-content: center; padding: 16px; }
  .sheet.open { display: flex; }
  .sheet form { width: 100%; max-width: 480px; background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 22px; display: grid; gap: 14px; }
  .sheet h1 { margin: 0; }
  .sheet .hint { color: var(--dim); font-size: 12.5px; margin: -6px 0 0; }
  .check { display: flex; gap: 8px; align-items: center; color: var(--text); }
  .check input { width: auto; }
  @media (max-width: 820px) {
    .menu { display: inline-flex; }
    .side { transform: translateX(-100%); transition: transform .2s; box-shadow: 0 0 40px rgba(0, 0, 0, .6); }
    body.nav-open .side { transform: none; }
    main { margin-left: 0; padding: 20px 16px 40px; }
    .logo .word, .top .up-label { display: none; }
    .grid { grid-template-columns: repeat(auto-fill, minmax(min(100%, 220px), 1fr)); }
  }
  button.primary:hover:not(:disabled) { background: #2d5cb0; }
  button:disabled { opacity: .45; cursor: default; }
  #playerModal { position: fixed; inset: 0; background: rgba(7, 9, 13, .95); z-index: 100; display: none; flex-direction: column; }
  #playerModal.open { display: flex; }
  .p-top { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 18px; background: rgba(15, 17, 21, .9); border-bottom: 1px solid var(--line); }
  .p-stage { position: relative; flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; background: #000; overflow: hidden; cursor: pointer; }
  #pVideo, #pGlCanvas, #pCanvas { max-width: 100%; max-height: 100%; width: 100%; height: 100%; object-fit: contain; display: none; }
  #pSubCanvas { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; pointer-events: none; }
  #pSubText { position: absolute; left: 8%; right: 8%; bottom: 28px; text-align: center; font-size: clamp(16px, 2.2vw, 28px); font-weight: 600; color: #fff; text-shadow: 0 2px 6px #000, 0 0 3px #000, 1px 1px 0 #000, -1px -1px 0 #000; white-space: pre-wrap; pointer-events: none; }
  #pStatus { position: absolute; padding: 8px 14px; border-radius: 8px; background: rgba(15, 17, 21, .82); border: 1px solid var(--line); color: var(--text); font-size: 13px; pointer-events: none; display: none; }
  .p-bar { padding: 10px 18px 14px; background: rgba(15, 17, 21, .94); border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; }
  #pSeek { width: 100%; accent-color: var(--brand); padding: 0; cursor: pointer; }
  .clock { font-variant-numeric: tabular-nums; font-size: 12px; color: var(--dim); min-width: 96px; }
</style>
</head>
<body>
<header class="top">
  <button class="ghost menu" id="menuBtn" title="Menu"><svg viewBox="0 0 24 24"><path d="M3 6h18M3 12h18M3 18h18"/></svg></button>
  <a class="logo" href="#/"><span class="mark"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></span><span class="word">PearTube</span></a>
  <div class="search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="q" type="search" placeholder="Search videos and channels" autocomplete="off"></div>
  <button class="primary" id="upBtn"><svg viewBox="0 0 24 24"><path d="M12 16V4M6 10l6-6 6 6M4 20h16"/></svg><span class="up-label">Upload</span></button>
</header>
<nav class="side" id="side">
  <a class="nav" href="#/" data-v="home"><svg viewBox="0 0 24 24"><path d="M3 11 12 4l9 7v9h-6v-6H9v6H3z"/></svg>Home</a>
  <a class="nav" href="#/following" data-v="following"><svg viewBox="0 0 24 24"><path d="M12 21s-7-4.5-9.5-9A5.5 5.5 0 0 1 12 6a5.5 5.5 0 0 1 9.5 6c-2.5 4.5-9.5 9-9.5 9z"/></svg>Following</a>
  <a class="nav" href="#/discover" data-v="discover"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/></svg>Discover</a>
  <a class="nav" href="#/uploads" data-v="uploads"><svg viewBox="0 0 24 24"><path d="M4 4h16v16H4zM4 9h16M9 4v5"/></svg>Uploads</a>
  <a class="nav" href="#/settings" data-v="settings"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>Settings</a>
  <h3>Channels</h3>
  <div id="sideChannels"></div>
  <div class="stats" id="stats"></div>
</nav>
<main id="view"></main>
<div class="sheet" id="upSheet">
  <form id="upForm">
    <h1>Upload a video</h1>
    <p class="hint">Give the relay a direct link to a video file. It downloads it, splits it into pieces and shares it with peers.</p>
    <label>Video file URL<input id="upUrl" type="url" placeholder="https://example.com/video.mp4" required></label>
    <label>Title<input id="upTitle" maxlength="300" placeholder="My video" required></label>
    <label>ID (optional)<input id="upId" placeholder="clip:myvideo or imdb:tt0111161"></label>
    <label class="check"><input id="upChannel" type="checkbox" checked>Publish to my channel</label>
    <div class="error" id="upErr"></div>
    <div class="row"><span></span><span class="row"><button type="button" id="upCancel">Cancel</button><button class="primary" type="submit">Upload</button></span></div>
  </form>
</div>
<div id="playerModal">
  <div class="p-top">
    <div class="row" style="min-width:0;flex:1">
      <span class="title" id="pTitle"></span>
      <span class="badge running" id="pBadge">Loading WASM…</span>
    </div>
    <div class="row">
      <a class="btn" id="pRawLink" target="_blank" rel="noopener">Raw URL</a>
      <button id="pFsBtn">Fullscreen</button>
      <button id="pCloseBtn">Close</button>
    </div>
  </div>
  <div class="p-stage" id="pStage">
    <video id="pVideo" muted playsinline></video>
    <canvas id="pGlCanvas"></canvas>
    <canvas id="pCanvas"></canvas>
    <canvas id="pSubCanvas"></canvas>
    <div id="pSubText"></div>
    <div id="pStatus"></div>
  </div>
  <div class="p-bar">
    <input type="range" id="pSeek" min="0" max="1000" value="0" step="1">
    <div class="row">
      <div class="row">
        <button class="primary" id="pPlayBtn">Pause</button>
        <button id="pBackBtn">-10s</button>
        <button id="pFwdBtn">+10s</button>
        <span class="clock" id="pClock">0:00 / 0:00</span>
      </div>
      <div class="row">
        <select id="pAudioSel" title="Audio Track"></select>
        <select id="pSubSel" title="Subtitles"></select>
        <button id="pMuteBtn">Mute</button>
        <input type="range" id="pVol" min="0" max="100" value="100" style="width:80px;padding:0;accent-color:var(--brand)" title="Volume">
      </div>
    </div>
  </div>
</div>
<script>
const $ = id => document.getElementById(id)
const el = (t, c, txt) => { const e = document.createElement(t); if (t === 'button') e.type = 'button'; if (c) e.className = c; if (txt != null) e.textContent = txt; return e }
const size = n => n == null ? '' : n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? (n / 1e3).toFixed(0) + ' KB' : n + ' B'
const fact = (k, v) => { const s = el('span', null, k + ' '); s.append(el('b', null, v)); return s }
// Stuffs the URI down a hidden textarea throat so plain HTTP relays and permission-stingy browsers still swallow every byte on click.
const copiedUntil = new Map()
function execCopy (text) {
  const prev = document.activeElement
  const ta = el('textarea')
  ta.value = text
  ta.readOnly = true
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;pointer-events:none'
  document.body.append(ta)
  try { ta.focus({ preventScroll: true }) } catch { ta.focus() }
  ta.select()
  ta.setSelectionRange(0, text.length)
  let ok = false
  try { ok = document.execCommand('copy') } catch {}
  ta.remove()
  try { prev?.focus?.({ preventScroll: true }) } catch { prev?.focus?.() }
  return ok
}
function copyBtn (label, text) {
  const key = label + ':' + text
  const until = copiedUntil.get(key) || 0
  const rem = until - Date.now()
  const b = el('button', null, rem > 0 ? 'Copied!' : label)
  b.disabled = !text
  if (text) b.title = text
  if (rem > 0) setTimeout(() => { if (copiedUntil.get(key) === until) { copiedUntil.delete(key); b.textContent = label } }, rem)
  b.onclick = () => {
    if (!text) return
    const flash = () => {
      const exp = Date.now() + 1500
      copiedUntil.set(key, exp)
      b.textContent = 'Copied!'
      setTimeout(() => { if (copiedUntil.get(key) === exp) { copiedUntil.delete(key); b.textContent = label } }, 1500)
    }
    const ok = execCopy(text)
    if (ok) flash()
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => { if (!ok) flash() }, () => {})
    }
  }
  return b
}
// Hold the DOM still while Master's finger presses a button so SSE updates never yank the target mid-stroke before click lands.
let pressing = false, refreshQueued = false, player = null
addEventListener('pointerdown', () => { pressing = true })
for (const evName of ['pointerup', 'pointercancel', 'blur']) {
  addEventListener(evName, () => {
    if (!pressing) return
    pressing = false
    if (refreshQueued) { refreshQueued = false; setTimeout(refresh, 0) }
  })
}

// Video-site shell: hash routes (#/, #/following, #/discover, #/uploads, #/settings, #/channel/<key>) over the same /v1 API.
const data = { st: {}, src: {}, entries: [], jobs: [], plugins: [], ok: false }
const icon = d => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.innerHTML = '<path d="' + d + '"/>'; return s }
const ICON = { play: 'M8 5v14l11-7z', film: 'M4 4h16v16H4zM8 4v16M16 4v16M4 9h4M4 15h4M16 9h4M16 15h4', heart: 'M12 21s-7-4.5-9.5-9A5.5 5.5 0 0 1 12 6a5.5 5.5 0 0 1 9.5 6c-2.5 4.5-9.5 9-9.5 9z', box: 'M4 4h16v16H4zM4 9h16M9 4v5' }
const hue = s => { let h = 7; for (const c of String(s)) h = (h * 31 + c.codePointAt(0)) >>> 0; return h % 360 }
const tint = seed => { const h = hue(seed); return 'background:linear-gradient(135deg,hsl(' + h + ' 55% 34%),hsl(' + ((h + 55) % 360) + ' 60% 16%))' }
function avatar (name, seed, cls) {
  const a = el('span', 'avatar' + (cls ? ' ' + cls : ''), (String(name || '?').trim().charAt(0) || '?').toUpperCase())
  a.style.cssText = tint(seed)
  return a
}
const myKeys = () => new Set([data.st.channel, data.st.tracker, data.st.writer].filter(Boolean))
function channelName (key) {
  const s = (data.src.sources || []).find(x => x.key === key)
  if (s?.alias) return s.alias
  if (myKeys().has(key) || s?.primary || s?.writable) return 'My channel'
  return key && key !== 'direct' ? key.slice(0, 8) + '…' : 'Direct link'
}
const route = () => { const p = location.hash.replace(/^#[/]?/, '').split('/'); return { view: p[0] || 'home', arg: p[1] || '' } }
const query = () => $('q').value.trim().toLowerCase()
const matches = e => { const q = query(); return !q || (e.title || '').toLowerCase().includes(q) || e.id.includes(q) || channelName(e.source).toLowerCase().includes(q) }
const epLabel = id => { const m = id.match(/:s([0-9]{2})e([0-9]{2,3})$/); return m ? 'S' + m[1] + 'E' + m[2] : '' }

function videoCard (e) {
  const c = el('div', 'vcard')
  const th = el('div', 'thumb')
  th.style.cssText = tint(e.id + e.title)
  th.append(el('div', 'big', e.title || e.id))
  const pl = el('span', 'play'); pl.append(icon(ICON.play)); th.append(pl)
  if (e.local) th.append(el('span', 'tag tl local', 'ON THIS RELAY'))
  else if (e.cachedBytes) th.append(el('span', 'tag tl', 'CACHED ' + Math.min(100, Math.round(100 * e.cachedBytes / (e.size || 1))) + '%'))
  th.append(el('span', 'tag br', [epLabel(e.id), size(e.size)].filter(Boolean).join(' · ')))
  if (e.magnetUrl) { const cp = copyBtn('Copy link', e.magnetUrl); cp.classList.add('copy'); cp.addEventListener('click', ev => ev.stopPropagation()); th.append(cp) }
  const info = el('div', 'vinfo')
  const who = channelName(e.source)
  info.append(avatar(who, e.source, 'sm'))
  const txt = el('div')
  txt.style.minWidth = '0'
  const meta = el('div', 'vmeta')
  const a = el('a', null, who)
  a.href = '#/channel/' + e.source
  a.onclick = ev => ev.stopPropagation()
  meta.append(a)
  txt.append(el('div', 'vtitle', e.title || e.id), meta)
  info.append(txt)
  c.append(th, info)
  c.onclick = () => openPlayer(e)
  return c
}
function videoGrid (list, emptyText) {
  const shown = list.filter(matches)
  if (!shown.length) {
    const d = el('div', 'empty')
    d.append(icon(ICON.film), el('div', null, query() ? 'No videos match "' + $('q').value.trim() + '".' : emptyText))
    return d
  }
  const g = el('div', 'grid')
  g.append(...shown.map(videoCard))
  return g
}
const sortVideos = list => list.slice().sort((a, b) => (Number(Boolean(b.local)) - Number(Boolean(a.local))) || ((b.cachedBytes || 0) - (a.cachedBytes || 0)) || String(a.title).localeCompare(String(b.title)))
const post = (url, body, method = 'POST') => fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(r => r.json())

function homeView () {
  const out = [el('h1', null, query() ? 'Search results' : 'Latest videos')]
  out.push(videoGrid(sortVideos(data.entries), 'No videos yet. Upload one, or follow a channel to see its videos here.'))
  return out
}
function channelRow (s, pubSet) {
  const c = el('div', 'card row')
  const g = el('a', 'grow')
  g.href = '#/channel/' + s.key
  g.style.textDecoration = 'none'
  const name = channelName(s.key)
  const t = el('div')
  t.style.minWidth = '0'
  const count = data.entries.filter(e => e.source === s.key).length
  t.append(el('div', 'title', name), el('div', 'meta', [s.kind === 'tracker' ? 'Shared tracker' : 'Channel', count + ' video' + (count === 1 ? '' : 's'), s.key.slice(0, 12) + '…'].join(' · ')))
  g.append(avatar(name, s.key), t)
  if (pubSet.has(s.key)) g.append(el('span', 'badge seeder', 'in directory'))
  const act = el('span', 'row')
  act.append(copyBtn('Copy link', 'peartube://' + s.kind + '/' + s.key + (s.alias ? '?name=' + encodeURIComponent(s.alias) : '')))
  if (!s.primary) {
    const listed = pubSet.has(s.key)
    const b = el('button', null, listed ? 'Unlist' : 'List in directory')
    b.onclick = () => (listed
      ? fetch('/v1/channel/sources/' + s.key, { method: 'DELETE' })
      : post('/v1/channel/publish', { type: 'source', sourceKey: s.key, kind: s.kind, title: s.alias || s.key.slice(0, 12), target: 'both' })).then(refresh)
    act.append(b)
  }
  if (!s.primary && !s.writable) {
    const rm = el('button', null, 'Unfollow')
    rm.onclick = () => fetch('/v1/sources/' + s.key, { method: 'DELETE' }).then(() => { location.hash = '#/following'; refresh() })
    act.append(rm)
  }
  c.append(g, act)
  return c
}
function followView () {
  const f = el('form', 'row')
  f.style.marginBottom = '18px'
  const uri = el('input'); uri.placeholder = 'Paste a peartube://channel/… link, a watch link, or a 64-character key'; uri.required = true; uri.style.cssText = 'flex:1;min-width:240px'
  const kind = el('select'); kind.innerHTML = '<option value="channel">Channel</option><option value="tracker">Shared tracker</option>'
  const alias = el('input'); alias.placeholder = 'Name (optional)'; alias.style.width = '150px'
  const go = el('button', 'primary', 'Follow'); go.type = 'submit'
  const err = el('div', 'error')
  f.append(uri, kind, alias, go)
  f.onsubmit = async ev => {
    ev.preventDefault()
    const val = uri.value.trim()
    const watch = val.startsWith('peartube://watch/') || val.startsWith('peartube:watch/')
    const r = await post(watch ? '/v1/open' : '/v1/sources', val.startsWith('peartube:') ? { uri: val } : { key: val, kind: kind.value, alias: alias.value.trim() }).catch(e => ({ error: e.message }))
    if (r.error) { err.textContent = r.error; return }
    if (watch && r.entry) openPlayer(r.entry)
    uri.value = ''; alias.value = ''; refresh()
  }
  const pubSet = new Set((data.src.published || []).map(p => p.key))
  const list = (data.src.sources || []).filter(s => !query() || channelName(s.key).toLowerCase().includes(query()))
  return [el('h1', null, 'Following'), f, err, ...(list.length ? list.map(s => channelRow(s, pubSet)) : [el('div', 'empty', 'Not following any channels yet.')])]
}
function discoverView () {
  const disc = data.src.discovered || []
  const out = [el('h1', null, 'Discover channels')]
  if (!disc.length) { out.push(el('div', 'empty', 'No channels discovered yet. Channels that peers list in their directories show up here.')); return out }
  out.push(...disc.map(d => {
    const c = el('div', 'card row')
    const g = el('div', 'grow')
    const t = el('div'); t.style.minWidth = '0'
    t.append(el('div', 'title', d.title || d.key.slice(0, 12)), el('div', 'meta', (d.kind === 'tracker' ? 'Shared tracker' : 'Channel') + ' · ' + d.key.slice(0, 12) + '…'))
    g.append(avatar(d.title, d.key), t)
    const join = el('button', 'primary', 'Follow')
    join.onclick = () => post('/v1/sources', { key: d.key, kind: d.kind, alias: d.title }).then(refresh)
    c.append(g, join)
    return c
  }))
  return out
}
function channelView (key) {
  const name = channelName(key)
  const banner = el('div', 'banner'); banner.style.cssText = tint(key + 'banner')
  const head = el('div', 'chead')
  const who = el('div', 'who')
  const vids = data.entries.filter(e => e.source === key)
  const s = (data.src.sources || []).find(x => x.key === key)
  who.append(el('h1', null, name), el('div', 'meta', [s?.kind === 'tracker' ? 'Shared tracker' : 'Channel', vids.length + ' video' + (vids.length === 1 ? '' : 's'), key.slice(0, 16) + '…'].join(' · ')))
  const act = el('span', 'row')
  act.append(copyBtn('Copy channel link', 'peartube://' + (s?.kind || 'channel') + '/' + key + (s?.alias ? '?name=' + encodeURIComponent(s.alias) : '')))
  if (s && !s.primary && !s.writable) {
    const rm = el('button', null, 'Unfollow')
    rm.onclick = () => fetch('/v1/sources/' + key, { method: 'DELETE' }).then(() => { location.hash = '#/following'; refresh() })
    act.append(rm)
  }
  head.append(avatar(name, key, 'lg'), who, act)
  return [banner, head, videoGrid(sortVideos(vids), 'This channel has no videos yet.')]
}
function uploadsView () {
  const top = el('div', 'row')
  const b = el('button', 'primary', 'Upload a video'); b.onclick = openUpload
  top.append(el('h1', null, 'Uploads'), b)
  const jobs = (data.jobs || []).slice().sort((a, b) => b.created - a.created)
  const out = [top]
  if (!jobs.length) { out.push(el('div', 'empty', 'Nothing uploaded yet.')); return out }
  out.push(...jobs.map(j => {
    const c = el('div', 'card')
    const r = el('div', 'row'); r.append(el('div', 'title', j.title || j.id), el('span', 'badge ' + j.status, j.status))
    c.append(r, el('div', 'meta', [j.id, j.total ? size(j.bytes || 0) + ' of ' + size(j.total) : (j.size ? size(j.size) : '')].filter(Boolean).join(' · ')))
    if (j.status === 'running' && j.total) { const bar = el('div', 'bar'); const fill = el('div'); fill.style.width = Math.min(100, 100 * (j.bytes || 0) / j.total) + '%'; bar.append(fill); c.append(bar) }
    if (j.error && j.status !== 'done') c.append(el('div', 'error', j.error))
    return c
  }))
  return out
}
function settingsView () {
  const st = data.st
  const rec = st.reciprocity || {}
  const out = [el('h1', null, 'Settings')]
  const me = el('div', 'card')
  me.append(el('div', 'title', 'This relay'), el('div', 'meta', ['peers ' + (st.peers || 0) + (st.lanPeers ? ' (+' + st.lanPeers + ' LAN)' : ''), 'stored ' + size(st.blobBytes || 0), 'cached ' + size(st.cachedBytes || 0), (rec.tier || 'peer') + ' tier'].join(' · ')))
  const act = el('div', 'row'); act.style.cssText = 'justify-content:flex-start;margin-top:10px'
  act.append(copyBtn('Copy my channel link', st.channel ? 'peartube://channel/' + st.channel : ''), copyBtn('Copy tracker link', st.tracker ? 'peartube://tracker/' + st.tracker : ''))
  if ((st.cachedBytes || 0) > 0) { const clr = el('button', null, 'Clear cache'); clr.onclick = () => post('/v1/cache/clear', {}).then(refresh); act.append(clr) }
  me.append(act)
  out.push(me, el('h2', null, 'Plugins'))
  out.push(...(data.plugins.length ? data.plugins.map(p => {
    const c = el('div', 'card row')
    const info = el('div'); info.style.minWidth = '0'
    const summary = p.lastResult ? JSON.stringify(p.lastResult) : (p.description || '')
    info.append(el('div', 'title', p.name), el('div', 'meta', [p.runs ? p.runs + ' runs' : 'idle', summary].filter(Boolean).join(' · ')))
    if (p.lastError) info.append(el('div', 'error', p.lastError))
    const run = el('button', null, 'Run now')
    run.onclick = () => post('/v1/plugins/' + encodeURIComponent(p.name) + '/run', {}).then(refresh)
    c.append(info, run)
    return c
  }) : [el('div', 'empty', 'No plugins on this node.')]))
  return out
}

function renderSide () {
  const { view, arg } = route()
  for (const a of document.querySelectorAll('.nav[data-v]')) a.classList.toggle('on', a.dataset.v === view)
  $('sideChannels').replaceChildren(...(data.src.sources || []).map(s => {
    const a = el('a', 'nav' + (view === 'channel' && arg === s.key ? ' on' : ''))
    a.href = '#/channel/' + s.key
    const name = channelName(s.key)
    a.append(avatar(name, s.key, 'sm'), el('span', 'name', name))
    return a
  }))
  const st = data.st
  const links = el('div', 'links')
  const m = el('a', 'btn', 'Stremio'); m.href = '/manifest.json'; m.target = '_blank'
  const p = el('a', 'btn', 'M3U'); p.href = '/v1/playlist.m3u'
  links.append(m, p)
  const line = (k, v) => { const d = el('div', null, k + ' '); d.append(el('b', null, v)); return d }
  $('stats').replaceChildren(line('Peers', String(st.peers || 0) + (st.lanPeers ? ' (+' + st.lanPeers + ' LAN)' : '')), line('Down', size(st.downBps || 0) + '/s'), line('Up', size(st.upBps || 0) + '/s'), line('Stored', size(st.blobBytes || 0)), links)
}
function render () {
  if (pressing || player) { refreshQueued = true; return }
  const { view, arg } = route()
  renderSide()
  // Don't wipe a form someone is typing in; the next refresh after they leave it catches up.
  const f = document.activeElement
  if (f && $('view').contains(f) && (f.tagName === 'INPUT' || f.tagName === 'SELECT')) return
  const views = { home: homeView, following: followView, discover: discoverView, uploads: uploadsView, settings: settingsView, channel: () => channelView(arg) }
  const err = el('div', 'error'); err.id = 'err'
  if (!data.ok && data.error) err.textContent = data.error
  $('view').replaceChildren(err, ...(views[view] || homeView)())
}
async function refresh () {
  if (pressing || player) { refreshQueued = true; return }
  try {
    const [st, src, ent, jb, pl] = await Promise.all([
      fetch('/v1/status').then(r => r.json()),
      fetch('/v1/sources').then(r => r.json()),
      fetch('/v1/entries').then(r => r.json()),
      fetch('/v1/jobs').then(r => r.json()),
      fetch('/v1/plugins').then(r => r.json()).catch(() => ({ plugins: [] }))
    ])
    Object.assign(data, { st, src, entries: ent.results || [], jobs: jb.jobs || [], plugins: pl.plugins || [], ok: true, error: '' })
  } catch (err) { Object.assign(data, { ok: false, error: 'Node unreachable: ' + err.message }) }
  render()
}
addEventListener('hashchange', () => { document.body.classList.remove('nav-open'); scrollTo(0, 0); render() })
$('q').oninput = render
$('q').onkeydown = ev => { if (ev.key === 'Enter' && !['home', 'channel', 'following'].includes(route().view)) location.hash = '#/' }
$('menuBtn').onclick = () => document.body.classList.toggle('nav-open')

function openUpload () { $('upErr').textContent = ''; $('upSheet').classList.add('open'); $('upUrl').focus() }
const closeUpload = () => $('upSheet').classList.remove('open')
$('upBtn').onclick = openUpload
$('upCancel').onclick = closeUpload
$('upSheet').onclick = ev => { if (ev.target === $('upSheet')) closeUpload() }
$('upForm').onsubmit = async ev => {
  ev.preventDefault()
  const title = $('upTitle').value.trim()
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 40) || 'video'
  const id = $('upId').value.trim().toLowerCase() || 'clip:' + slug + Date.now().toString(36)
  const r = await post('/v1/acquire', { id, title, source: { url: $('upUrl').value.trim() }, channel: $('upChannel').checked }).catch(e => ({ error: e.message }))
  if (r.error) { $('upErr').textContent = r.error; return }
  $('upForm').reset(); $('upChannel').checked = true
  closeUpload()
  location.hash = '#/uploads'
  refresh()
}
refresh()
const ev = new EventSource('/v1/events')
ev.onmessage = refresh
setInterval(refresh, 5000)

// In-browser peartube-media WebAssembly player: demuxes MKV/AVI/MP4/TS over same-origin HTTP Range,
// hardware-accelerates H.264/HEVC via fMP4 MSE when supported, falls back to WASM SIMD software video,
// and decodes surround AC-3/DTS/TrueHD/Opus/MP3 + SRT/ASS/PGS subtitles straight in the browser.
function fmtClock (s) {
  if (!Number.isFinite(s) || s < 0) s = 0
  const t = Math.floor(s)
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), r = String(t % 60).padStart(2, '0')
  return h > 0 ? h + ':' + String(m).padStart(2, '0') + ':' + r : m + ':' + r
}

function resolveStreamUrl (rawUrl) {
  try {
    const u = new URL(rawUrl, location.href)
    if (u.searchParams.has('key') && (u.searchParams.has('blob') || u.searchParams.has('pointer'))) {
      return location.origin + '/v1/blob' + u.search
    }
    return u.href
  } catch {
    return rawUrl
  }
}

// GPU BT.709 YUV420P WebGL renderer: uploads planar Y/U/V straight to textures in ~0.15ms with zero CPU color conversion.
let yuvGl = null
function getYuvGl () {
  if (yuvGl !== null) return yuvGl
  const c = $('pGlCanvas')
  const gl = c.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false })
  if (!gl) { yuvGl = false; return false }
  const vs = gl.createShader(gl.VERTEX_SHADER)
  gl.shaderSource(vs, 'attribute vec2 a_pos;varying vec2 v_uv;void main(){v_uv=vec2(a_pos.x*0.5+0.5,0.5-a_pos.y*0.5);gl_Position=vec4(a_pos,0.0,1.0);}')
  gl.compileShader(vs)
  const fs = gl.createShader(gl.FRAGMENT_SHADER)
  gl.shaderSource(fs, 'precision mediump float;varying vec2 v_uv;uniform sampler2D u_y;uniform sampler2D u_u;uniform sampler2D u_v;void main(){float y=(texture2D(u_y,v_uv).r-0.062745)*1.164384;float u=texture2D(u_u,v_uv).r-0.5;float v=texture2D(u_v,v_uv).r-0.5;gl_FragColor=vec4(y+1.792741*v,y-0.213249*u-0.532909*v,y+2.112402*u,1.0);}')
  gl.compileShader(fs)
  const prog = gl.createProgram()
  gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog); gl.useProgram(prog)
  const quad = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, quad)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  const loc = gl.getAttribLocation(prog, 'a_pos')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  const mkTex = unit => {
    gl.activeTexture(gl.TEXTURE0 + unit)
    const t = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return t
  }
  const texY = mkTex(0), texU = mkTex(1), texV = mkTex(2)
  gl.uniform1i(gl.getUniformLocation(prog, 'u_y'), 0)
  gl.uniform1i(gl.getUniformLocation(prog, 'u_u'), 1)
  gl.uniform1i(gl.getUniformLocation(prog, 'u_v'), 2)
  yuvGl = { gl, canvas: c, texY, texU, texV, w: 0, h: 0 }
  return yuvGl
}

function audioOutTime (ctx) {
  if (!ctx) return 0
  const ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null
  return (ts && ts.contextTime > 0) ? ts.contextTime : ctx.currentTime
}
// Keep one warm WASM Worker pre-compiled in the background so clicking Stream opens in 0 ms.
const ASSET_VER = '?v=5'
let sharedWorker = null
let workerCanvasTransferred = false
let workerOffscreenReady = false
function nowWallMs () { return (performance.timeOrigin || 0) + performance.now() }
function getWorker () {
  if (!sharedWorker) {
    sharedWorker = new Worker('/web/player-worker.js' + ASSET_VER)
    const glc = $('pGlCanvas')
    if (!workerCanvasTransferred && glc && typeof glc.transferControlToOffscreen === 'function') {
      try {
        const off = glc.transferControlToOffscreen()
        workerCanvasTransferred = true
        workerOffscreenReady = true
        sharedWorker.postMessage({ cmd: 'initCanvas', canvas: off }, [off])
      } catch {}
    }
    sharedWorker.postMessage({ cmd: 'warmup', wasmUrl: location.origin + '/web/peartube_web.wasm' + ASSET_VER })
  }
  return sharedWorker
}
setTimeout(() => { try { getWorker() } catch {} }, 150)

let openCounter = 0

function closePlayer () {
  if (!player) return
  const p = player
  player = null
  $('playerModal').classList.remove('open')
  cancelAnimationFrame(p.raf)
  try { p.worker?.postMessage({ cmd: 'close' }) } catch {}
  for (const s of p.audioNodes) { try { s.node.stop(); s.node.disconnect() } catch {} }
  try { p.audioCtx?.close() } catch {}
  const v = $('pVideo')
  v.pause()
  v.removeAttribute('src')
  v.load()
  if (p.msUrl) { try { URL.revokeObjectURL(p.msUrl) } catch {} }
  $('pSubText').textContent = ''
  const sc = $('pSubCanvas')
  sc.getContext('2d').clearRect(0, 0, sc.width, sc.height)
  if (refreshQueued) { refreshQueued = false; setTimeout(refresh, 50) }
}

function openPlayer (entry) {
  closePlayer()
  const streamUrl = resolveStreamUrl(entry.streamUrl)
  const worker = getWorker()
  $('pTitle').textContent = entry.title || entry.id
  $('pBadge').textContent = 'Opening…'
  $('pBadge').className = 'badge running'
  $('pRawLink').href = streamUrl
  $('pStatus').style.display = ''
  $('pStatus').textContent = 'Buffering stream…'
  $('pSubText').textContent = ''
  $('pPlayBtn').textContent = 'Pause'
  $('pSeek').value = '0'
  $('pClock').textContent = '0:00 / 0:00'
  $('playerModal').classList.add('open')

  const AudioCtx = window.AudioContext || window.webkitAudioContext
  const audioCtx = AudioCtx ? new AudioCtx() : null
  const gainNode = audioCtx ? audioCtx.createGain() : null
  if (gainNode) {
    gainNode.gain.value = ($('pMuteBtn').dataset.muted === '1') ? 0 : (Number($('pVol').value) / 100)
    gainNode.connect(audioCtx.destination)
  }
  audioCtx?.resume?.().catch(() => {})

  const seq = ++openCounter
  const p = {
    entry,
    streamUrl,
    worker,
    audioCtx,
    gainNode,
    pendingAudio: [],
    audioNodes: [],
    nextAudioCtxTime: 0,
    audioBaseMedia: 0,
    audioBaseCtx: 0,
    audioStarted: false,
    freeBaseMedia: 0,
    freeBasePerf: performance.now(),
    primed: false,
    paused: false,
    seeking: false,
    duration: 0,
    seq,
    manifest: null,
    videoStream: -1,
    audioStream: -1,
    subStream: -1,
    useMse: false,
    allowWebCodecs: false,
    usingWebCodecs: false,
    workerGlPrimed: false,
    ms: null,
    msUrl: '',
    sb: null,
    mseQueue: [],
    mseReady: false,
    lastMseTime: 0,
    lastHardSync: 0,
    swFrames: [],
    lastSwPts: null,
    drawnFrames: 0,
    imgData: null,
    consumedVideoSec: 0,
    consumedAudioSec: 0,
    subCues: [],
    eof: false,
    raf: 0
  }
  player = p

  const canvas = $('pCanvas')
  const glCanvas = $('pGlCanvas')
  const ctx2d = canvas.getContext('2d', { alpha: false, desynchronized: true }) || canvas.getContext('2d')
  const subCanvas = $('pSubCanvas')
  const subCtx = subCanvas.getContext('2d')
  const video = $('pVideo')

  function currentMediaTime () {
    if (!p.primed || p.paused) return p.freeBaseMedia
    if (p.audioStream >= 0 && p.audioCtx && p.audioStarted && p.audioCtx.state === 'running') {
      const outT = audioOutTime(p.audioCtx)
      if (outT > p.audioBaseCtx + 0.01) {
        const t = p.audioBaseMedia + (outT - p.audioBaseCtx)
        p.freeBaseMedia = t
        p.freeBasePerf = performance.now()
        return t
      }
    }
    if (p.useMse && !video.paused && video.readyState >= 2) {
      p.freeBaseMedia = video.currentTime
      p.freeBasePerf = performance.now()
      return video.currentTime
    }
    return p.freeBaseMedia + Math.max(0, (performance.now() - p.freeBasePerf) / 1000)
  }

  function recycleVideoBuf (buf) {
    if (buf && buf.byteLength > 0) {
      try { worker.postMessage({ cmd: 'recycleVideo', buf }, [buf]) } catch {}
    }
  }
  function syncWorkerClock (timeSecs, playing) {
    try { worker.postMessage({ cmd: 'clock', time: timeSecs, wallMs: nowWallMs(), playing }) } catch {}
  }
  p.syncWorkerClock = syncWorkerClock

  function scheduleAudioChunk (m) {
    if (!p.audioCtx || !p.gainNode || m.samples <= 0) {
      if (m?.buf?.byteLength) { try { worker.postMessage({ cmd: 'recycleAudio', buf: m.buf }, [m.buf]) } catch {} }
      return
    }
    const f32 = new Float32Array(m.buf, 0, m.samples * 2)
    const ab = p.audioCtx.createBuffer(2, m.samples, m.rate)
    const lSub = f32.subarray(0, m.samples), rSub = f32.subarray(m.samples, m.samples * 2)
    if (ab.copyToChannel) {
      ab.copyToChannel(lSub, 0)
      ab.copyToChannel(rSub, 1)
    } else {
      ab.getChannelData(0).set(lSub)
      ab.getChannelData(1).set(rSub)
    }
    try { worker.postMessage({ cmd: 'recycleAudio', buf: m.buf }, [m.buf]) } catch {}
    const node = p.audioCtx.createBufferSource()
    node.buffer = ab
    node.connect(p.gainNode)
    const nowCtx = p.audioCtx.currentTime
    const startCtx = Math.max(nowCtx + 0.02, p.nextAudioCtxTime || (nowCtx + 0.03))
    p.nextAudioCtxTime = startCtx + ab.duration
    if (!p.audioStarted) {
      p.audioStarted = true
      p.audioBaseMedia = m.pts
      p.audioBaseCtx = startCtx
    }
    const rec = { node, startCtx, endCtx: startCtx + ab.duration, pts: m.pts, dur: ab.duration }
    p.audioNodes.push(rec)
    node.onended = () => {
      const idx = p.audioNodes.indexOf(rec)
      if (idx !== -1) p.audioNodes.splice(idx, 1)
      if (player === p) p.consumedAudioSec += rec.dur
    }
    node.start(startCtx)
  }

  function tryPrime () {
    if (p.primed || !p.manifest) return
    const vReady = p.videoStream < 0 || (p.useMse ? (p.mseReady && video.readyState >= 2) : (p.workerGlPrimed || p.swFrames.length >= 2)) || p.eof
    const aReady = p.audioStream < 0 || p.pendingAudio.length >= 1 || p.eof
    if (!vReady || !aReady) return
    p.primed = true
    $('pStatus').style.display = 'none'
    p.freeBasePerf = performance.now()
    while (p.pendingAudio.length > 0) scheduleAudioChunk(p.pendingAudio.shift())
    if (p.useMse && !p.paused) {
      p.lastMseTime = video.currentTime
      video.play().catch(() => {})
    }
    syncWorkerClock(currentMediaTime(), !p.paused)
  }

  video.onloadeddata = () => { if (player === p) tryPrime() }
  video.oncanplay = () => { if (player === p) tryPrime() }

  function resetMediaOutputs (targetSecs) {
    for (const s of p.audioNodes) { try { s.node.stop(); s.node.disconnect() } catch {} }
    p.audioNodes.length = 0
    p.pendingAudio.length = 0
    p.nextAudioCtxTime = 0
    p.audioStarted = false
    p.primed = false
    p.audioBaseMedia = targetSecs
    p.freeBaseMedia = targetSecs
    p.freeBasePerf = performance.now()
    while (p.swFrames.length > 0) recycleVideoBuf(p.swFrames.shift().buf)
    p.workerGlPrimed = false
    p.lastSwPts = null
    p.consumedVideoSec = 0
    p.consumedAudioSec = 0
    p.subCues.length = 0
    $('pSubText').textContent = ''
    subCtx.clearRect(0, 0, subCanvas.width, subCanvas.height)
    if (p.useMse) setupMse(targetSecs)
  }
  p.resetMediaOutputs = resetMediaOutputs

  function setupMse (startAt) {
    video.pause()
    video.playbackRate = 1
    if (p.msUrl) { try { URL.revokeObjectURL(p.msUrl) } catch {} p.msUrl = '' }
    p.mseQueue.length = 0
    p.sb = null
    p.mseReady = false
    const MS = window.MediaSource || window.ManagedMediaSource
    if (!MS || !p.manifest?.mseCodec) { fallbackSw(startAt); return }
    const mime = 'video/mp4; codecs="' + p.manifest.mseCodec + '"'
    if (!MS.isTypeSupported(mime)) { fallbackSw(startAt); return }
    const ms = new MS()
    p.ms = ms
    p.msUrl = URL.createObjectURL(ms)
    video.style.display = 'block'
    canvas.style.display = 'none'
    glCanvas.style.display = 'none'
    video.src = p.msUrl
    ms.addEventListener('sourceopen', () => {
      if (player !== p || p.ms !== ms) return
      try {
        const sb = ms.addSourceBuffer(mime)
        sb.mode = 'segments'
        p.sb = sb
        sb.addEventListener('updateend', () => {
          if (player !== p || p.sb !== sb || p.ms?.readyState !== 'open') return
          if (!p.mseReady && sb.buffered.length > 0) {
            p.mseReady = true
            const bStart = sb.buffered.start(0)
            const bEnd = sb.buffered.end(0)
            const snap = Math.max(bStart, Math.min(startAt, bEnd > bStart + 0.05 ? bEnd - 0.05 : bStart))
            video.currentTime = snap
            p.lastMseTime = snap
            tryPrime()
          }
          drainMseQueue()
        })
        drainMseQueue()
      } catch {
        fallbackSw(currentMediaTime())
      }
    }, { once: true })
  }

  function drainMseQueue () {
    if (!p.sb || p.ms?.readyState !== 'open' || p.sb.updating) return
    if (p.mseQueue.length > 0) {
      const buf = p.mseQueue.shift()
      try { p.sb.appendBuffer(buf) } catch { fallbackSw(currentMediaTime()) }
      return
    }
    const now = currentMediaTime()
    if (p.sb.buffered.length > 0 && now - p.sb.buffered.start(0) > 20) {
      try { p.sb.remove(0, now - 12) } catch {}
    }
  }

  function fallbackSw (atSecs) {
    if (!p.useMse && (canvas.style.display === 'block' || glCanvas.style.display === 'block')) return
    p.useMse = false
    p.sb = null
    p.ms = null
    p.mseQueue.length = 0
    p.mseReady = false
    video.pause()
    video.removeAttribute('src')
    video.load()
    if (p.msUrl) { try { URL.revokeObjectURL(p.msUrl) } catch {} p.msUrl = '' }
    video.style.display = 'none'
    updateBadge()
    p.seq = ++openCounter
    resetMediaOutputs(atSecs)
    p.allowWebCodecs = Boolean(p.manifest?.webCodecs && p.webCodecsSupported)
    p.worker.postMessage({ cmd: 'seek', seq: p.seq, time: atSecs, videoStream: p.videoStream, audioStream: p.audioStream, subStream: p.subStream, useMse: false, allowWebCodecs: p.allowWebCodecs })
  }
  video.onerror = () => { if (player === p && p.useMse) fallbackSw(currentMediaTime()) }

  function updateBadge () {
    if (!p.manifest) return
    const vt = p.manifest.tracks.find(t => t.stream === p.videoStream)
    const at = p.manifest.tracks.find(t => t.stream === p.audioStream)
    const parts = [p.manifest.container]
    if (vt) {
      const tag = p.useMse ? ' (MSE+WASM)' : (p.usingWebCodecs ? ' (WebCodecs+WASM)' : (workerOffscreenReady ? ' (WASM+GPU)' : ' (WASM)'))
      parts.push(vt.codec + tag)
    }
    if (at) parts.push(at.codec)
    $('pBadge').textContent = parts.join(' \\u00b7 ')
    $('pBadge').className = 'badge seeder'
  }

  worker.onerror = err => {
    if (player !== p) return
    $('pStatus').style.display = ''
    $('pStatus').textContent = 'Worker error: ' + (err?.message || 'failed')
  }
  worker.onmessage = ev => {
    if (player !== p) return
    const m = ev.data || {}
    if (m.type === 'warm') return
    if (m.type === 'canvasReady') { workerOffscreenReady = Boolean(m.offscreen); return }
    if (m.seq && m.seq !== p.seq) return
    if (m.type === 'error') {
      $('pStatus').style.display = ''
      $('pStatus').textContent = 'Playback error: ' + m.error
      $('pBadge').textContent = 'Error'
      $('pBadge').className = 'badge failed'
      return
    }
    if (m.type === 'manifest') {
      const mf = m.manifest
      p.manifest = mf
      p.duration = mf.duration || 0
      p.videoStream = mf.defaultVideo ?? -1
      p.audioStream = mf.defaultAudio ?? -1
      const subs = mf.tracks.filter(t => t.kind === 'subtitle')
      const auds = mf.tracks.filter(t => t.kind === 'audio')
      p.subStream = -1

      const aSel = $('pAudioSel')
      aSel.replaceChildren(...(auds.length ? auds.map((t, i) => {
        const o = el('option', null, 'Audio ' + (i + 1) + ': ' + [t.codec, t.language, t.channels ? t.channels + 'ch' : ''].filter(Boolean).join(' '))
        o.value = String(t.stream)
        if (t.stream === p.audioStream) o.selected = true
        return o
      }) : [Object.assign(el('option', null, 'No Audio'), { value: '-1' })]))
      aSel.disabled = auds.length <= 1

      const sSel = $('pSubSel')
      const offOpt = el('option', null, 'Subtitles: Off'); offOpt.value = '-1'
      sSel.replaceChildren(offOpt, ...subs.map((t, i) => {
        const o = el('option', null, 'Sub ' + (i + 1) + ': ' + [t.codec, t.language].filter(Boolean).join(' '))
        o.value = String(t.stream)
        return o
      }))
      sSel.disabled = subs.length === 0

      if (typeof m.offscreen === 'boolean') workerOffscreenReady = m.offscreen
      p.webCodecsSupported = Boolean(m.webCodecsSupported)
      const MS = window.MediaSource || window.ManagedMediaSource
      p.useMse = Boolean(p.videoStream >= 0 && mf.mseCodec && MS && MS.isTypeSupported('video/mp4; codecs="' + mf.mseCodec + '"'))
      p.allowWebCodecs = Boolean(!p.useMse && p.videoStream >= 0 && p.webCodecsSupported)
      p.usingWebCodecs = p.allowWebCodecs
      if (p.useMse) {
        setupMse(0)
      } else {
        video.style.display = 'none'
        glCanvas.style.display = workerOffscreenReady ? 'block' : 'none'
        canvas.style.display = 'none'
      }
      updateBadge()
      worker.postMessage({ cmd: 'start', seq: p.seq, videoStream: p.videoStream, audioStream: p.audioStream, subStream: p.subStream, useMse: p.useMse, allowWebCodecs: p.allowWebCodecs })
    } else if (m.type === 'mseInit' || m.type === 'mseSeg') {
      p.mseQueue.push(m.buf)
      drainMseQueue()
    } else if (m.type === 'videoPrimed') {
      p.workerGlPrimed = true
      p.usingWebCodecs = Boolean(m.hw)
      if (!p.useMse) { glCanvas.style.display = 'block'; canvas.style.display = 'none' }
      updateBadge()
      tryPrime()
    } else if (m.type === 'videoFrame') {
      p.swFrames.push(m)
      if (p.drawnFrames === 0) drawSwFrame(m)
      tryPrime()
    } else if (m.type === 'audioChunk' && m.samples > 0) {
      if (!p.primed) {
        p.pendingAudio.push(m)
        tryPrime()
      } else {
        scheduleAudioChunk(m)
      }
    } else if (m.type === 'subText') {
      p.subCues.push({ kind: 'text', start: m.start, end: m.end, text: m.text })
    } else if (m.type === 'subBitmap') {
      p.subCues.push({ kind: 'bitmap', start: m.start, end: m.end, x: m.x, y: m.y, w: m.w, h: m.h, cw: m.cw, ch: m.ch, buf: m.buf })
    } else if (m.type === 'eof') {
      p.eof = true
      tryPrime()
    }
  }

  function drawSwFrame (f) {
    const r = (f.yuv && !workerCanvasTransferred) ? getYuvGl() : false
    if (r) {
      if (glCanvas.style.display !== 'block') { glCanvas.style.display = 'block'; canvas.style.display = 'none' }
      const { gl } = r
      const cw = (f.w + 1) >> 1, ch = (f.h + 1) >> 1
      const u8 = new Uint8Array(f.buf, 0, f.byteLen || f.buf.byteLength)
      const yLen = f.w * f.h, cLen = cw * ch
      const ySub = u8.subarray(0, yLen)
      const uSub = u8.subarray(yLen, yLen + cLen)
      const vSub = u8.subarray(yLen + cLen, yLen + cLen * 2)
      const resized = (r.w !== f.w || r.h !== f.h)
      if (resized) {
        r.w = f.w; r.h = f.h
        glCanvas.width = f.w; glCanvas.height = f.h
        gl.viewport(0, 0, f.w, f.h)
      }
      const up = (unit, tex, tw, th, data) => {
        gl.activeTexture(gl.TEXTURE0 + unit)
        gl.bindTexture(gl.TEXTURE_2D, tex)
        if (resized) gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, tw, th, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, data)
        else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, tw, th, gl.LUMINANCE, gl.UNSIGNED_BYTE, data)
      }
      up(0, r.texY, f.w, f.h, ySub)
      up(1, r.texU, cw, ch, uSub)
      up(2, r.texV, cw, ch, vSub)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      p.drawnFrames++
      return
    }
    if (canvas.style.display !== 'block') { canvas.style.display = 'block'; glCanvas.style.display = 'none' }
    if (canvas.width !== f.w || canvas.height !== f.h || !p.imgData) {
      canvas.width = f.w
      canvas.height = f.h
      p.imgData = ctx2d.createImageData(f.w, f.h)
    }
    p.imgData.data.set(new Uint8ClampedArray(f.buf, 0, f.w * f.h * 4))
    ctx2d.putImageData(p.imgData, 0, 0)
    p.drawnFrames++
  }

  let lastCreditReport = performance.now()
  function tick () {
    if (player !== p) return
    p.raf = requestAnimationFrame(tick)
    if (!p.primed) tryPrime()
    const now = currentMediaTime()
    const pf = performance.now()

    if (p.primed && p.audioCtx && p.audioNodes.length > 0) {
      const ct = audioOutTime(p.audioCtx)
      for (const a of p.audioNodes) {
        if (ct >= a.startCtx && ct <= a.endCtx) {
          p.audioBaseMedia = a.pts + (ct - a.startCtx)
          p.audioBaseCtx = ct
          break
        }
      }
    }

    if (p.primed && p.useMse && p.mseReady && !p.paused) {
      const vt = video.currentTime
      if (vt > p.lastMseTime) {
        p.consumedVideoSec += Math.min(1.0, vt - p.lastMseTime)
        p.lastMseTime = vt
      }
      if (p.audioStarted && !video.seeking && video.readyState >= 2) {
        const drift = vt - now
        if (Math.abs(drift) > 1.2 && video.readyState >= 3 && (pf - p.lastHardSync) > 2500) {
          for (let i = 0; i < video.buffered.length; i++) {
            if (now >= video.buffered.start(i) && now + 0.25 <= video.buffered.end(i)) {
              p.lastHardSync = pf
              p.lastMseTime = now
              video.currentTime = now
              break
            }
          }
        } else if (drift > 0.20) video.playbackRate = 0.95
        else if (drift > 0.025) video.playbackRate = 0.98
        else if (drift < -0.20) video.playbackRate = 1.05
        else if (drift < -0.025) video.playbackRate = 1.02
        else if (video.playbackRate !== 1) video.playbackRate = 1
      }
    } else if (p.primed && !p.useMse && p.swFrames.length > 0 && !p.paused) {
      let pick = null
      while (p.swFrames.length > 0 && p.swFrames[0].pts <= now + 0.015) {
        const f = p.swFrames.shift()
        if (pick) recycleVideoBuf(pick.buf)
        const step = p.lastSwPts !== null ? Math.max(0.01, Math.min(0.2, f.pts - p.lastSwPts)) : (1 / 30)
        p.lastSwPts = f.pts
        p.consumedVideoSec += step
        pick = f
      }
      if (pick) {
        drawSwFrame(pick)
        recycleVideoBuf(pick.buf)
      }
    }
    if (p.subCues.length > 0) {
      p.subCues = p.subCues.filter(c => c.end >= now - 2)
      const activeTexts = []
      let activeBmp = null
      for (const c of p.subCues) {
        if (now >= c.start && now <= c.end) {
          if (c.kind === 'text') activeTexts.push(c.text)
          else activeBmp = c
        }
      }
      const joined = activeTexts.join('\\n')
      if ($('pSubText').textContent !== joined) $('pSubText').textContent = joined
      if (activeBmp) {
        if (subCanvas.width !== activeBmp.cw || subCanvas.height !== activeBmp.ch) {
          subCanvas.width = activeBmp.cw
          subCanvas.height = activeBmp.ch
        }
        subCtx.clearRect(0, 0, subCanvas.width, subCanvas.height)
        if (activeBmp.w > 0 && activeBmp.h > 0) {
          subCtx.putImageData(new ImageData(new Uint8ClampedArray(activeBmp.buf), activeBmp.w, activeBmp.h), activeBmp.x, activeBmp.y)
        }
      } else {
        subCtx.clearRect(0, 0, subCanvas.width, subCanvas.height)
      }
    }

    if (!p.seeking && p.duration > 0) {
      $('pSeek').value = String(Math.min(1000, Math.round((now / p.duration) * 1000)))
    }
    $('pClock').textContent = fmtClock(now) + ' / ' + fmtClock(p.duration)

    if (p.primed && pf - lastCreditReport > 120 && (p.consumedVideoSec > 0 || p.consumedAudioSec > 0 || (pf - lastCreditReport > 250))) {
      const vSec = p.consumedVideoSec
      const aSec = p.consumedAudioSec
      p.consumedVideoSec = 0
      p.consumedAudioSec = 0
      lastCreditReport = pf
      worker.postMessage({ cmd: 'consumed', videoSec: vSec, audioSec: aSec, time: now, wallMs: nowWallMs(), playing: !p.paused })
    }
  }
  p.raf = requestAnimationFrame(tick)

  const extMatch = (entry.streamUrl || '').split('?')[0].split('.').pop() || ''
  worker.postMessage({ cmd: 'open', seq: p.seq, streamUrl, wasmUrl: location.origin + '/web/peartube_web.wasm' + ASSET_VER, ext: extMatch.length <= 5 ? extMatch : '' })
  return p
}

function togglePlay () {
  if (!player) return
  const now = player.freeBaseMedia
  player.paused = !player.paused
  player.freeBaseMedia = now
  player.freeBasePerf = performance.now()
  $('pPlayBtn').textContent = player.paused ? 'Play' : 'Pause'
  if (player.paused) {
    player.audioCtx?.suspend?.().catch(() => {})
    if (player.useMse) $('pVideo').pause()
    player.syncWorkerClock?.(now, false)
  } else {
    if (player.audioCtx) {
      player.audioCtx.resume().then(() => {
        if (player) {
          player.audioBaseMedia = now
          player.audioBaseCtx = player.audioCtx.currentTime
          player.syncWorkerClock?.(now, true)
        }
      }).catch(() => {})
    }
    if (player.useMse && player.primed) $('pVideo').play().catch(() => {})
    if (player.primed) player.syncWorkerClock?.(now, true)
  }
}

function seekTo (targetSecs) {
  if (!player) return
  const clamped = Math.max(0, player.duration > 0 ? Math.min(player.duration, targetSecs) : targetSecs)
  player.seq = ++openCounter
  player.eof = false
  $('pStatus').style.display = ''
  $('pStatus').textContent = 'Seeking…'
  player.drawnFrames = 0
  player.resetMediaOutputs(clamped)
  player.worker.postMessage({
    cmd: 'seek',
    seq: player.seq,
    time: clamped,
    videoStream: player.videoStream,
    audioStream: player.audioStream,
    subStream: player.subStream,
    useMse: player.useMse,
    allowWebCodecs: player.allowWebCodecs
  })
}

$('pCloseBtn').onclick = closePlayer
$('pPlayBtn').onclick = togglePlay
$('pStage').onclick = togglePlay
$('pStage').ondblclick = () => $('pFsBtn').click()
$('pBackBtn').onclick = () => player && seekTo((player.freeBaseMedia || 0) - 10)
$('pFwdBtn').onclick = () => player && seekTo((player.freeBaseMedia || 0) + 10)
$('pFsBtn').onclick = () => {
  const m = $('playerModal')
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
  else m.requestFullscreen?.().catch(() => {})
}
$('pSeek').onpointerdown = () => { if (player) player.seeking = true }
$('pSeek').onchange = () => {
  if (!player) return
  player.seeking = false
  if (player.duration > 0) seekTo((Number($('pSeek').value) / 1000) * player.duration)
}
$('pAudioSel').onchange = () => {
  if (!player) return
  player.audioStream = Number($('pAudioSel').value)
  seekTo(player.freeBaseMedia || 0)
}
$('pSubSel').onchange = () => {
  if (!player) return
  player.subStream = Number($('pSubSel').value)
  seekTo(player.freeBaseMedia || 0)
}
$('pMuteBtn').onclick = () => {
  const muted = $('pMuteBtn').dataset.muted === '1' ? '0' : '1'
  $('pMuteBtn').dataset.muted = muted
  $('pMuteBtn').textContent = muted === '1' ? 'Unmute' : 'Mute'
  if (player?.gainNode) player.gainNode.gain.value = muted === '1' ? 0 : (Number($('pVol').value) / 100)
}
$('pVol').oninput = () => {
  $('pMuteBtn').dataset.muted = '0'
  $('pMuteBtn').textContent = 'Mute'
  if (player?.gainNode) player.gainNode.gain.value = Number($('pVol').value) / 100
}
addEventListener('keydown', ev => {
  if (!player) return
  if (ev.key === 'Escape') { ev.preventDefault(); closePlayer() }
  else if (ev.key === ' ') { ev.preventDefault(); togglePlay() }
  else if (ev.key === 'ArrowLeft') { ev.preventDefault(); $('pBackBtn').click() }
  else if (ev.key === 'ArrowRight') { ev.preventDefault(); $('pFwdBtn').click() }
  else if (ev.key === 'f' || ev.key === 'F') { ev.preventDefault(); $('pFsBtn').click() }
  else if (ev.key === 'm' || ev.key === 'M') { ev.preventDefault(); $('pMuteBtn').click() }
})
</script>
</body>
</html>
`
