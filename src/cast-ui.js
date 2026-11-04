// Zero-install 10-foot Smart TV Web Receiver: spreads wide on webOS, Tizen, consoles, and kiosk browsers,
// giving the TV remote full local Play/Pause, ±10s, Seek, Mute, Fullscreen, and Stop controls synced back to sender.
export function receiverPage ({ mode = 'standalone', defaultName = 'PearTube Web TV' } = {}) {
  const boot = JSON.stringify({ mode, defaultName })
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>PearTube TV Receiver</title>
<style>
  :root { color-scheme: dark; --bg: #08090d; --card: #11141d; --line: #202636; --ink: #f3f5fa; --dim: #8a94a8; --brand: #9147ff; --accent: #4ade80; --danger: #f87171; }
  * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: var(--bg); color: var(--ink); font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif; }
  #idle { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 4vw; background: radial-gradient(circle at 50% 15%, rgba(145, 71, 255, 0.14) 0%, var(--bg) 62%); }
  .panel { width: min(940px, 92vw); background: rgba(17, 20, 29, 0.94); border: 1px solid var(--line); border-radius: 28px; padding: 48px 56px; box-shadow: 0 32px 90px rgba(0,0,0,0.72); display: grid; grid-template-columns: auto 1fr; gap: 48px; align-items: center; }
  @media (max-width: 820px) { .panel { grid-template-columns: 1fr; justify-items: center; text-align: center; padding: 32px; gap: 28px; } }
  .qr-frame { width: clamp(220px, 26vw, 340px); height: clamp(220px, 26vw, 340px); background: #ffffff; border-radius: 22px; padding: 14px; box-shadow: 0 18px 48px rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center; }
  .qr-frame svg { width: 100%; height: 100%; display: block; }
  .qr-wait { color: #11141d; font-size: 14px; font-weight: 600; text-align: center; padding: 16px; }
  .copy-col { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
  .eyebrow { display: inline-flex; align-items: center; gap: 10px; font-size: 13px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent); }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 12px var(--accent); }
  h1 { font-size: clamp(32px, 3.8vw, 50px); font-weight: 800; letter-spacing: -0.025em; line-height: 1.08; }
  .sub { color: var(--dim); font-size: clamp(16px, 1.5vw, 20px); line-height: 1.45; }
  .actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  button, input { font: inherit; color: var(--ink); background: #191f2e; border: 1px solid var(--line); border-radius: 12px; padding: 10px 18px; font-size: 15px; font-weight: 600; cursor: pointer; outline: none; }
  button:focus, button:hover, input:focus { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(74, 222, 128, 0.35); }
  button.primary { background: var(--brand); color: #ffffff; border-color: var(--brand); }
  button.danger { color: var(--danger); }
  #stage { position: absolute; inset: 0; background: #000; display: none; }
  video { width: 100%; height: 100%; object-fit: contain; background: #000; }
  #hud { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: space-between; padding: 36px 48px; background: linear-gradient(180deg, rgba(0,0,0,0.78) 0%, transparent 26%, transparent 62%, rgba(0,0,0,0.90) 100%); transition: opacity 0.25s ease; }
  #hud.hidden { opacity: 0; pointer-events: none; }
  .top { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
  .title { font-size: clamp(22px, 2.6vw, 36px); font-weight: 700; text-shadow: 0 2px 10px rgba(0,0,0,0.8); }
  .badge { padding: 6px 14px; border-radius: 999px; background: rgba(74, 222, 128, 0.16); border: 1px solid var(--accent); color: var(--accent); font-size: 13px; font-weight: 700; letter-spacing: 0.06em; white-space: nowrap; }
  .bar-wrap { display: flex; flex-direction: column; gap: 14px; }
  .track { width: 100%; height: 10px; background: rgba(255,255,255,0.22); border-radius: 999px; overflow: hidden; cursor: pointer; outline: none; }
  .track:focus { box-shadow: 0 0 0 2px var(--accent); }
  .fill { height: 100%; width: 0%; background: var(--brand); transition: width 0.15s linear; }
  .controls-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
  .btn-group { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
  .clock { font-size: 16px; font-variant-numeric: tabular-nums; color: #dbe2f0; margin-left: 6px; }
  #unmute { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); display: none; z-index: 10; }
  #err { color: var(--danger); font-size: 14px; min-height: 18px; }
</style>
</head>
<body>
<div id="idle">
  <div class="panel">
    <div class="qr-frame" id="qrBox"><span class="qr-wait">Preparing QR…</span></div>
    <div class="copy-col">
      <div class="eyebrow"><span class="dot"></span><span id="tvName">PearTube TV</span> · <span id="statusTxt">Connecting…</span></div>
      <h1>Scan to play here</h1>
      <p class="sub">Pick this TV directly from <b>Cast</b> on the same Wi-Fi, or scan this QR code with your phone to start playing immediately.</p>
      <div class="actions">
        <button class="primary" id="fsBtn" tabindex="1">Fullscreen</button>
        <input id="nameInput" tabindex="2" placeholder="Rename TV…" style="max-width:200px" />
      </div>
      <div id="err"></div>
    </div>
  </div>
</div>
<div id="stage">
  <video id="video" playsinline></video>
  <button id="unmute" class="primary">Press OK / Tap to Unmute Audio</button>
  <div id="hud">
    <div class="top">
      <div class="title" id="nowTitle">Loading…</div>
      <div class="badge" id="modeBadge">PearTube Cast</div>
    </div>
    <div class="bar-wrap">
      <div class="track" id="scrub" tabindex="10"><div class="fill" id="fill"></div></div>
      <div class="controls-row">
        <div class="btn-group">
          <button class="primary" id="playBtn" tabindex="11">Pause</button>
          <button id="backBtn" tabindex="12">-10s</button>
          <button id="fwdBtn" tabindex="13">+10s</button>
          <button id="muteBtn" tabindex="14">Mute</button>
          <span class="clock" id="clock">0:00 / 0:00</span>
        </div>
        <div class="btn-group">
          <span id="playState" style="color:var(--dim);font-size:15px;margin-right:6px">Buffering…</span>
          <button id="stageFsBtn" tabindex="15">Fullscreen</button>
          <button class="danger" id="stopBtn" tabindex="16">Stop</button>
        </div>
      </div>
    </div>
  </div>
</div>

<script>
(() => {
  const BOOT = ${boot};
  const $ = id => document.getElementById(id);
  const video = $('video');
  const savedName = localStorage.getItem('peartube.tv.name') || BOOT.defaultName;
  const savedId = localStorage.getItem('peartube.tv.id') || '';
  $('nameInput').value = savedName;
  $('tvName').textContent = savedName;

  let reg = { id: savedId, token: localStorage.getItem('peartube.tv.token') || '', uri: '', mode: 'http', entry: null };
  let hudTimer = null;
  let es = null;

  function fmt (sec) {
    if (!Number.isFinite(sec) || sec < 0) return '0:00';
    const s = Math.floor(sec);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return h > 0 ? h + ':' + String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0') : m + ':' + String(r).padStart(2, '0');
  }

  function pokeHud (focusDefault = false) {
    const wasHidden = $('hud').classList.contains('hidden');
    $('hud').classList.remove('hidden');
    if (focusDefault && wasHidden) $('playBtn').focus?.();
    clearTimeout(hudTimer);
    if (!video.paused && !video.ended) {
      hudTimer = setTimeout(() => $('hud').classList.add('hidden'), 4500);
    }
  }

  function snapshot (extra = {}) {
    const dur = Number.isFinite(video.duration) && video.duration > 0 ? Math.round(video.duration * 1000) : null;
    const pos = Number.isFinite(video.currentTime) ? Math.round(video.currentTime * 1000) : 0;
    const playing = !video.paused && !video.ended && Boolean(reg.entry);
    const buffering = Boolean(reg.entry) && video.readyState < 3 && !video.paused && !video.ended;
    const status = !reg.entry ? 'idle' : video.error ? 'error' : video.ended ? 'ended' : buffering ? 'buffering' : playing ? 'playing' : 'paused';
    return {
      status,
      mode: reg.entry ? reg.mode : null,
      entry: reg.entry,
      positionMs: pos,
      durationMs: dur,
      playing,
      buffering,
      ended: Boolean(video.ended && reg.entry),
      volume: video.volume,
      muted: video.muted,
      tracks: [],
      audio: 0,
      subtitle: -1,
      error: video.error ? ('Media error ' + video.error.code) : null,
      ...extra
    };
  }

  async function reportState (extra) {
    const state = snapshot(extra);
    $('playState').textContent = state.error ? state.error : state.buffering ? 'Buffering…' : state.playing ? 'Playing' : 'Paused';
    $('playBtn').textContent = state.playing ? 'Pause' : 'Play';
    $('muteBtn').textContent = video.muted ? 'Unmute' : 'Mute';
    $('clock').textContent = fmt(state.positionMs / 1000) + ' / ' + fmt((state.durationMs || 0) / 1000);
    $('fill').style.width = state.durationMs ? Math.min(100, (state.positionMs / state.durationMs) * 100).toFixed(2) + '%' : '0%';
    const url = BOOT.mode === 'hub' ? '/v1/cast/web-state' : '/cast/v1/web-state';
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: reg.id, token: reg.token, state })
      });
    } catch {}
  }

  function stopPlayback () {
    reg.entry = null;
    video.pause();
    video.removeAttribute('src');
    video.load();
    $('stage').style.display = 'none';
    $('idle').style.display = 'flex';
    $('unmute').style.display = 'none';
    reportState({ idle: true, status: 'idle', entry: null, playing: false, buffering: false, positionMs: 0, durationMs: null, ended: true });
  }

  async function handleCommand (cmd) {
    if (!cmd || !cmd.action) return;
    if (cmd.action === 'load') {
      reg.entry = cmd.entry || { id: 'stream', title: 'Cast Stream', size: 0 };
      reg.mode = cmd.mode || 'http';
      $('nowTitle').textContent = reg.entry.title || reg.entry.id || 'PearTube Stream';
      $('modeBadge').textContent = 'PearTube Cast';
      $('idle').style.display = 'none';
      $('stage').style.display = 'block';
      const rawSrc = cmd.streamUrl || cmd.httpStreamUrl;
      let playSrc = rawSrc;
      if (BOOT.mode === 'hub' && rawSrc) {
        try {
          const u = new URL(rawSrc, location.href);
          if (u.searchParams.has('key') && (u.searchParams.has('blob') || u.searchParams.has('pointer'))) {
            playSrc = location.origin + '/v1/blob' + u.search;
          }
        } catch {}
      }
      video.src = playSrc;
      video.load();
      if (cmd.startPositionMs > 0) {
        video.addEventListener('loadedmetadata', () => { video.currentTime = cmd.startPositionMs / 1000; }, { once: true });
      }
      try {
        await video.play();
        $('unmute').style.display = 'none';
      } catch {
        video.muted = true;
        try { await video.play(); $('unmute').style.display = 'block'; } catch (e) { $('err').textContent = e.message; }
      }
      pokeHud(true);
      reportState();
    } else if (cmd.action === 'play') {
      video.play().catch(() => {}); pokeHud();
    } else if (cmd.action === 'pause') {
      video.pause(); pokeHud();
    } else if (cmd.action === 'togglePlay') {
      if (video.paused) video.play().catch(() => {}); else video.pause();
      pokeHud();
    } else if (cmd.action === 'seek' && Number.isFinite(cmd.positionMs)) {
      video.currentTime = Math.max(0, cmd.positionMs / 1000); pokeHud(); reportState();
    } else if (cmd.action === 'skip' && Number.isFinite(cmd.deltaMs)) {
      video.currentTime = Math.max(0, (video.currentTime || 0) + cmd.deltaMs / 1000); pokeHud(); reportState();
    } else if (cmd.action === 'volume') {
      if (typeof cmd.volume === 'number') video.volume = Math.max(0, Math.min(1, cmd.volume));
      if (typeof cmd.muted === 'boolean') video.muted = cmd.muted;
      reportState();
    } else if (cmd.action === 'stop') {
      stopPlayback();
    }
  }

  async function connect () {
    try {
      if (BOOT.mode === 'hub') {
        const res = await fetch('/v1/cast/web-register', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: reg.id, token: reg.token, name: $('nameInput').value.trim() || savedName })
        });
        const info = await res.json();
        reg = { ...reg, ...info, token: info.webToken || '' };
        localStorage.setItem('peartube.tv.id', info.id);
        localStorage.setItem('peartube.tv.token', info.webToken);
        $('tvName').textContent = info.name;
        if (info.qrSvg) $('qrBox').innerHTML = info.qrSvg;
        $('statusTxt').textContent = 'Ready';
        if (es) es.close();
        es = new EventSource('/v1/cast/web-events?id=' + encodeURIComponent(info.id) + '&token=' + encodeURIComponent(info.webToken));
      } else {
        const res = await fetch('/cast/v1/web-info');
        const info = await res.json();
        reg = { ...reg, ...info, token: info.webToken || '' };
        $('tvName').textContent = info.name;
        $('nameInput').style.display = 'none';
        if (info.qrSvg) $('qrBox').innerHTML = info.qrSvg;
        $('statusTxt').textContent = 'Ready';
        if (es) es.close();
        es = new EventSource('/cast/v1/web-events?token=' + encodeURIComponent(reg.token));
      }
      es.onmessage = ev => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.command) handleCommand(msg.command);
        } catch {}
      };
      es.onerror = () => { $('statusTxt').textContent = 'Reconnecting…'; };
    } catch (e) {
      $('err').textContent = 'Receiver offline: ' + e.message;
      setTimeout(connect, 2500);
    }
  }

  for (const ev of ['loadedmetadata', 'play', 'pause', 'seeking', 'seeked', 'waiting', 'playing', 'volumechange', 'ended', 'error']) {
    video.addEventListener(ev, () => { pokeHud(); reportState(); });
  }
  setInterval(() => { if (reg.entry && !video.paused && !video.ended) reportState(); }, 1000);

  const toggleFs = () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
    else document.exitFullscreen?.().catch(() => {});
  };
  $('fsBtn').onclick = toggleFs;
  $('stageFsBtn').onclick = e => { e.stopPropagation(); toggleFs(); pokeHud(); };
  $('playBtn').onclick = e => { e.stopPropagation(); if (video.paused) video.play().catch(() => {}); else video.pause(); pokeHud(); reportState(); };
  $('backBtn').onclick = e => { e.stopPropagation(); video.currentTime = Math.max(0, (video.currentTime || 0) - 10); pokeHud(); reportState(); };
  $('fwdBtn').onclick = e => { e.stopPropagation(); video.currentTime = Math.max(0, (video.currentTime || 0) + 10); pokeHud(); reportState(); };
  $('muteBtn').onclick = e => { e.stopPropagation(); video.muted = !video.muted; if (!video.muted) $('unmute').style.display = 'none'; pokeHud(); reportState(); };
  $('stopBtn').onclick = e => { e.stopPropagation(); stopPlayback(); };
  $('nameInput').onchange = () => {
    const v = $('nameInput').value.trim() || BOOT.defaultName;
    localStorage.setItem('peartube.tv.name', v);
    connect();
  };
  $('unmute').onclick = e => { e.stopPropagation(); video.muted = false; $('unmute').style.display = 'none'; video.play().catch(() => {}); reportState(); };
  $('stage').onclick = e => {
    if (e.target === $('video') || e.target === $('hud') || e.target === $('stage')) {
      if (video.paused) video.play().catch(() => {}); else video.pause();
      pokeHud();
    }
  };
  $('scrub').onclick = e => {
    e.stopPropagation();
    if (!Number.isFinite(video.duration)) return;
    const r = $('scrub').getBoundingClientRect();
    video.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * video.duration;
    pokeHud();
    reportState();
  };

  window.addEventListener('mousemove', () => { if (reg.entry) pokeHud(); });
  window.addEventListener('keydown', e => {
    if (document.activeElement === $('nameInput')) return;
    const k = e.key, c = e.keyCode;
    if (!reg.entry) {
      if (k === 'Enter' || k === 'f' || k === 'F') toggleFs();
      return;
    }
    const hudHidden = $('hud').classList.contains('hidden');
    if (k === 'MediaPlayPause' || c === 179 || c === 10252) {
      e.preventDefault();
      if (video.paused) video.play().catch(() => {}); else video.pause();
      pokeHud(); reportState();
    } else if (k === 'MediaPlay' || c === 415) { video.play().catch(() => {}); pokeHud(); reportState(); }
    else if (k === 'MediaPause' || c === 19) { video.pause(); pokeHud(); reportState(); }
    else if (k === 'MediaRewind' || c === 412 || ((hudHidden || document.activeElement === $('scrub')) && k === 'ArrowLeft')) {
      e.preventDefault();
      video.currentTime = Math.max(0, (video.currentTime || 0) - 10);
      pokeHud(); reportState();
    } else if (k === 'MediaFastForward' || c === 417 || ((hudHidden || document.activeElement === $('scrub')) && k === 'ArrowRight')) {
      e.preventDefault();
      video.currentTime = Math.max(0, (video.currentTime || 0) + 10);
      pokeHud(); reportState();
    } else if (hudHidden && (k === 'Enter' || k === ' ' || k === 'ArrowUp' || k === 'ArrowDown')) {
      e.preventDefault();
      pokeHud(true);
    } else if (k === 'f' || k === 'F') { toggleFs(); }
    else if (k === 'MediaStop' || c === 413) { e.preventDefault(); stopPlayback(); }
    else if (k === 'Escape' || k === 'Backspace' || c === 461 || c === 10009) {
      e.preventDefault();
      if (!hudHidden && !video.paused) $('hud').classList.add('hidden');
      else stopPlayback();
    } else {
      pokeHud();
    }
  });

  connect();
})();
</script>
</body>
</html>`
}
