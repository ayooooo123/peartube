import { readFileSync } from 'node:fs'

const ASSET_VER = (() => {
  try {
    const lock = readFileSync(new URL('../web/assets/peartube_web.lock.sha256', import.meta.url), 'utf8').trim()
    const wrk = readFileSync(new URL('../web/assets/player-worker.js', import.meta.url))
    let h = 0x811c9dc5
    for (let i = 0; i < wrk.length; i++) h = Math.imul(h ^ wrk[i], 0x01000193) >>> 0
    return lock ? '?v=' + lock.slice(0, 12) + h.toString(16).padStart(8, '0') : ''
  } catch {}
  return ''
})()

// Single-page dashboard for relays & local client daemons; textContent guards every peer string.
export const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>PearTube</title>
<script>try{document.documentElement.dataset.theme=localStorage.getItem('peartube-theme')||'system'}catch(e){document.documentElement.dataset.theme='system'}</script>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%239147ff'/%3E%3Cpath d='M12 9l12 7-12 7z' fill='white'/%3E%3C/svg%3E">
<style>
  /* design/tokens.json, hand-kept here because the relay must ship without a build step.
     Brand: violet (#9147ff) — the Mac, Android and TV surfaces already wear it. */
  :root { color-scheme: dark; --bg:#08090c; --surface:#101218; --raised:#171a22; --line:#232733; --text:#f2f4f8; --dim:#98a0b3;
    --brand:#9147ff; --brand-hover:#a866ff; --brand-soft:rgba(145,71,255,.16); --ring:#b98bff; --on-brand:#fff;
    --ok:#45d08a; --warn:#e8b45c; --bad:#ff7d7d; --focus:var(--ring); --live:#e11d48;
    --on-media:#f7f8fb; --on-media-dim:rgba(247,248,251,.74); --on-media-line:rgba(255,255,255,.3);
    --s1:4px; --s2:8px; --s3:12px; --s4:16px; --s5:24px; --s6:32px; --s7:48px;
    --r-control:10px; --r-card:14px; --r-panel:18px; --r-pill:999px;
    --t-fast:120ms; --t-base:160ms; --ease:cubic-bezier(.2,.8,.2,1); }
  html[data-theme='light'] { color-scheme: light; --bg:#f7f8fa; --surface:#fff; --raised:#eef1f6; --line:#e3e7ee; --text:#0d1016; --dim:#5b6475;
    --brand:#7c3aed; --brand-hover:#6d28d9; --brand-soft:rgba(124,58,237,.12); --ring:#7c3aed;
    --ok:#127a48; --warn:#8a5200; --bad:#b3261e; --live:#be123c; }
  @media (prefers-color-scheme: light) { html[data-theme='system'], html:not([data-theme]) { color-scheme: light; --bg:#f7f8fa; --surface:#fff; --raised:#eef1f6; --line:#e3e7ee; --text:#0d1016; --dim:#5b6475;
    --brand:#7c3aed; --brand-hover:#6d28d9; --brand-soft:rgba(124,58,237,.12); --ring:#7c3aed;
    --ok:#127a48; --warn:#8a5200; --bad:#b3261e; --live:#be123c; } }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body { margin: 0; font: 15px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif; letter-spacing: -0.005em; -webkit-font-smoothing: antialiased; background: var(--bg); color: var(--text); }
  a { color: var(--brand); }
  .top { position: sticky; top: 0; z-index: 20; background: color-mix(in srgb, var(--bg) 82%, transparent); backdrop-filter: blur(18px) saturate(1.3); border-bottom: 1px solid var(--line); }
  .bar { max-width: 1440px; margin: 0 auto; padding: 14px 28px 0; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 17px; letter-spacing: -0.02em; color: var(--text); text-decoration: none; }
  .brand svg { width: 30px; height: 30px; border-radius: 9px; background: var(--brand); box-shadow: 0 6px 18px var(--brand-soft); }
  .brand svg rect { fill: transparent; }
  .brand svg path { fill: var(--on-brand); }
  .pills { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .bar-right { display: flex; align-items: center; gap: 8px; margin-left: auto; }
  .theme-toggle { min-height: 34px; padding: 0 10px; color: var(--dim); }
  .theme-toggle:hover:not(:disabled) { color: var(--text); }
  .pill { font-size: 12px; font-weight: 500; padding: 4px 10px; border-radius: var(--r-pill); background: var(--raised); color: var(--dim); white-space: nowrap; }
  .pill b { color: var(--text); font-weight: 600; font-variant-numeric: tabular-nums; }
  .pill.warn { color: var(--warn); }
  button.pill { border: 0; font-family: inherit; cursor: pointer; }
  button.pill:disabled { opacity: .6; cursor: default; }
  .pill.ok::before { content: ''; display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--ok); margin-right: 6px; vertical-align: 1px; box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 16%, transparent); }
  .tabs { max-width: 1440px; margin: 0 auto; padding: 0 20px; display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none; }
  .tabs a { padding: 12px 14px 11px; color: var(--dim); text-decoration: none; font-size: 14px; font-weight: 600; border-bottom: 2px solid transparent; white-space: nowrap; transition: color var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease); }
  .tabs a:hover { color: var(--text); }
  .tabs a[aria-current='page'] { color: var(--text); border-bottom-color: var(--brand); }
  main { max-width: 1440px; margin: 0 auto; padding: 24px 28px 96px; }
  h2 { font-size: 20px; font-weight: 700; letter-spacing: -0.015em; margin: 40px 0 16px; display: flex; align-items: baseline; gap: 10px; }
  h2 .count { color: var(--dim); font-weight: 500; font-size: 13px; font-variant-numeric: tabular-nums; }
  h3 { font-size: 15px; font-weight: 600; margin: 0 0 4px; }
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-panel); padding: 18px; margin-bottom: 14px; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .grow { flex: 1; min-width: 0; }
  .label, label { font-weight: 600; font-size: 14px; }
  .field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
  .hint { color: var(--dim); font-size: 12.5px; }
  input[type=text], input[type=url], input[type=number], input[type=password], input[type=search], select { min-height: 42px; width: 100%; background: var(--raised); color: var(--text); border: 1px solid var(--line); border-radius: var(--r-control); padding: 8px 12px; font: inherit; transition: border-color var(--t-fast) var(--ease); }
  input::placeholder { color: var(--dim); }
  input:focus-visible, select:focus-visible, button:focus-visible, a:focus-visible, [tabindex]:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
  .btn { min-height: 38px; padding: 0 16px; border-radius: var(--r-control); border: 1px solid var(--line); background: var(--raised); color: var(--text); font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; white-space: nowrap; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; gap: 7px; transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease), transform var(--t-fast) var(--ease); }
  .btn:hover:not(:disabled) { border-color: color-mix(in srgb, var(--dim) 45%, transparent); }
  .btn.primary { background: var(--brand); border-color: var(--brand); color: var(--on-brand); }
  .btn.primary:hover:not(:disabled) { background: var(--brand-hover); border-color: var(--brand-hover); }
  .btn.quiet { background: transparent; border-color: transparent; color: var(--dim); }
  .btn.quiet:hover:not(:disabled) { color: var(--text); border-color: var(--line); }
  .btn:disabled { opacity: .5; cursor: default; }
  .chips { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; }
  .chip { min-height: 32px; padding: 0 14px; border-radius: var(--r-pill); border: 1px solid var(--line); background: transparent; color: var(--dim); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; transition: color var(--t-fast) var(--ease), background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease); }
  .chip:hover { color: var(--text); border-color: color-mix(in srgb, var(--dim) 45%, transparent); }
  .chip[aria-expanded='true'] { background: var(--raised); color: var(--text); border-color: var(--brand); }
  .panel { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--line); }
  .list { display: flex; flex-direction: column; gap: 8px; }
  /* Jobs are ephemeral: keep them from pushing the library below the fold. */
  #jobs { max-height: 268px; overflow-y: auto; scrollbar-width: thin; padding-right: 4px; }
  .item.job { padding: 10px 14px; }
  .item.job .name { font-size: 14px; }
  .item { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); padding: 14px; display: flex; gap: 14px; align-items: center; transition: border-color var(--t-fast) var(--ease); }
  .item:hover { border-color: color-mix(in srgb, var(--dim) 35%, var(--line)); }
  .item .info { flex: 1; min-width: 0; }
  .item .name { font-weight: 600; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
  .meta { color: var(--dim); font-size: 12.5px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .acts { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
  .poster { width: 48px; height: 72px; border-radius: 8px; flex: none; background: var(--raised); object-fit: cover; display: flex; align-items: center; justify-content: center; color: var(--dim); font-weight: 700; font-size: 18px; overflow: hidden; }
  .thumb { width: 128px; height: 72px; }
  .lib-tools { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 20px; }
  .lib-tools .kinds { display: flex; gap: 6px; flex-wrap: wrap; }
  .lib-tools input { flex: 1; min-width: 200px; width: auto; }
  .chip[aria-pressed='true'] { background: var(--text); color: var(--bg); border-color: var(--text); }
  .chip .count { opacity: .7; font-size: 12px; font-variant-numeric: tabular-nums; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(168px, 1fr)); gap: 24px 16px; }
  .tile { display: flex; flex-direction: column; gap: 2px; padding: 0; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; min-width: 0; }
  .tile .poster { width: 100%; height: auto; aspect-ratio: 2 / 3; border-radius: var(--r-card); font-size: 40px; margin-bottom: 8px; background: linear-gradient(160deg, var(--raised), var(--line)); box-shadow: 0 0 0 1px var(--line); transition: transform var(--t-base) var(--ease), box-shadow var(--t-base) var(--ease); }
  .grid > .empty { grid-column: 1 / -1; }
  .tile:hover .poster { transform: translateY(-4px); box-shadow: 0 22px 44px rgba(0,0,0,.45), 0 0 0 1px color-mix(in srgb, var(--ring) 35%, transparent); }
  .tile:focus-visible { outline: none; }
  .tile:focus-visible .poster { outline: 2px solid var(--ring); outline-offset: 3px; transform: translateY(-4px); }
  .tile-title { font-weight: 600; font-size: 14px; line-height: 1.3; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .tile-meta { color: var(--dim); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tile-meta.ok { color: var(--ok); }
  .tile-art { position: relative; }
  .tile-progress { position: absolute; left: 8px; right: 8px; bottom: 8px; height: 3px; border-radius: 2px; background: rgba(255,255,255,.28); overflow: hidden; }
  .tile-progress > span { display: block; height: 100%; background: var(--brand); border-radius: 2px; }
  .more { grid-column: 1 / -1; display: flex; justify-content: center; padding: 12px; }
  /* Browse face: one hero, landscape rails, posters underneath — Netflix shape, YouTube rows,
     torrent truth kept in the meta line instead of the layout. */
  #resumeWrap, #liveWrap { margin-bottom: 32px; }
  #hero { position: relative; overflow: hidden; border-radius: var(--r-panel); border: 1px solid var(--line); min-height: 372px; display: flex; align-items: flex-end; margin-bottom: 4px; background: linear-gradient(135deg, var(--raised), var(--surface)); }
  #hero.no-art { min-height: 236px; }
  #hero.no-art .hero-scrim { background: none; }
  .hero-art { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .hero-scrim { position: absolute; inset: 0; background: linear-gradient(90deg, rgba(4,5,8,.95) 0%, rgba(4,5,8,.86) 34%, rgba(4,5,8,.16) 70%, rgba(4,5,8,.55) 100%); }
  .hero-body { position: relative; padding: 32px; display: flex; flex-direction: column; gap: 12px; max-width: 640px; }
  .hero-logo { max-width: 320px; max-height: 96px; object-fit: contain; object-position: left bottom; filter: drop-shadow(0 6px 24px rgba(0,0,0,.6)); margin-bottom: 2px; }
  .hero-title { font-size: 40px; font-weight: 800; letter-spacing: -0.02em; line-height: 1.06; margin: 0; color: var(--on-media); }
  .hero-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; color: var(--on-media-dim); font-size: 13.5px; }
  .hero-progress { display: flex; align-items: center; gap: 12px; max-width: 360px; }
  .hero-progress .bar-track { flex: 1; margin-top: 0; background: rgba(255,255,255,.24); }
  .hero-progress span { color: var(--on-media-dim); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .hero-actions { display: flex; gap: 10px; margin-top: 4px; }
  #hero .eyebrow { font-size: 11px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--on-media-dim); }
  .hero-actions .btn.ghost { color: var(--on-media); border-color: var(--on-media-line); background: rgba(255,255,255,.10); }
  .dot { width: 3px; height: 3px; border-radius: 50%; background: currentColor; opacity: .55; }
  .rail { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 12px; }
  .r-card { position: relative; display: block; padding: 0; border: 0; border-radius: var(--r-card); overflow: hidden; aspect-ratio: 16 / 9; background: var(--raised); box-shadow: 0 0 0 1px var(--line); cursor: pointer; text-align: left; color: inherit; font: inherit; transition: transform var(--t-base) var(--ease), box-shadow var(--t-base) var(--ease); }
  .r-card > img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: .92; }
  .r-card .wash { position: absolute; inset: 0; background: linear-gradient(0deg, rgba(4,5,8,.94) 0%, rgba(4,5,8,.18) 58%, rgba(4,5,8,0) 100%); }
  .r-body { position: absolute; left: 0; right: 0; bottom: 0; padding: 10px 12px; display: flex; flex-direction: column; gap: 1px; }
  .r-title { font-size: 13px; font-weight: 600; color: var(--on-media); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .r-meta { font-size: 11.5px; color: var(--on-media-dim); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .r-track { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: rgba(255,255,255,.22); }
  .r-track > div { height: 100%; background: var(--brand); }
  .r-card:hover { transform: translateY(-3px); box-shadow: 0 18px 36px rgba(0,0,0,.45), 0 0 0 1px color-mix(in srgb, var(--ring) 40%, transparent); }
  .r-card:focus-visible { outline: 2px solid var(--ring); outline-offset: 3px; }
  .badge.live { display: inline-flex; align-items: center; gap: 5px; background: var(--live); color: #fff; border: 0; align-self: flex-start; margin-bottom: 2px; }
  .badge.live::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: #fff; }
  .r-card.live .r-track { display: none; }
  #detail, #ytSave { width: min(760px, calc(100% - 24px)); max-height: calc(100% - 48px); padding: 0; border: 1px solid var(--line); border-radius: var(--r-panel); background: var(--surface); color: var(--text); box-shadow: 0 40px 90px rgba(0,0,0,.5); }
  #detail::backdrop, #ytSave::backdrop { background: color-mix(in srgb, #05060a 72%, transparent); backdrop-filter: blur(6px); }
  #detail .bar { padding: 14px 14px 0 22px; justify-content: flex-end; }
  #detailBody { padding: 0 22px 22px; }
  .detail-head { display: flex; gap: 20px; align-items: flex-start; margin-bottom: 20px; }
  .detail-head .poster { width: 128px; height: 192px; font-size: 40px; border-radius: var(--r-card); }
  .detail-head h3 { font-size: 24px; font-weight: 700; letter-spacing: -0.015em; line-height: 1.2; margin: 2px 0 8px; }
  .rows { display: flex; flex-direction: column; }
  .row-item { display: flex; gap: 12px; align-items: center; padding: 12px 0; border-top: 1px solid var(--line); }
  #detail .meta, #ytSave .meta { white-space: normal; font-size: 13px; line-height: 1.5; }
  .file-info { display: grid; gap: 6px; margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--line); font-size: 13px; line-height: 1.5; }
  .rows .file-info { margin-top: 0; padding: 0 0 12px; border-top: 0; }
  .info-row { display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 12px; }
  .info-row > :first-child { color: var(--dim); }
  .info-row > :last-child { overflow-wrap: anywhere; }
  .info-peer { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .info-peer code { font-family: ui-monospace, Menlo, monospace; font-size: 12px; color: var(--dim); }
  .bar-track { height: 3px; background: var(--raised); border-radius: 2px; margin-top: 10px; overflow: hidden; }
  .bar-track > div { height: 100%; background: var(--brand); border-radius: 2px; transition: width var(--t-base) var(--ease); }
  .tag { font-size: 11.5px; padding: 3px 9px; border-radius: var(--r-pill); background: var(--raised); color: var(--dim); white-space: nowrap; font-weight: 600; letter-spacing: .01em; }
  .tag.warn { color: var(--warn); }
  .tag.ok { color: var(--ok); }
  .tag.bad { color: var(--bad); }
  .err { color: var(--bad); }
  .msg { margin-top: 10px; font-size: 14px; min-height: 1px; }
  .empty { color: var(--dim); padding: 24px 0; text-align: center; }
  .switch { position: relative; display: inline-flex; align-items: center; gap: 10px; cursor: pointer; min-height: 40px; }
  .switch input { appearance: none; width: 44px; height: 26px; border-radius: 13px; background: var(--line); position: relative; cursor: pointer; flex: none; margin: 0; transition: background .2s; }
  .switch input::after { content: ''; position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%; background: var(--on-media); transition: transform .2s; box-shadow: 0 1px 2px #0004; }
  .switch input:checked { background: var(--brand); }
  .switch input:checked::after { transform: translateX(18px); }
  .switch input:disabled { opacity: .5; cursor: default; }
  .setting { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 0; border-top: 1px solid var(--line); flex-wrap: wrap; }
  .setting:first-of-type { border-top: 0; }
  .setting .what { display: flex; flex-direction: column; gap: 4px; min-width: 200px; flex: 1; }
  .setting .control { flex: 1; min-width: 220px; max-width: 420px; }
  .setting .control.narrow { flex: none; min-width: 0; }
  .listedit .entry { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 4px 0; overflow-wrap: anywhere; }
  .stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; margin-top: 12px; }
  .stat { background: var(--raised); border-radius: 10px; padding: 10px 12px; }
  .stat .v { font-size: 18px; font-weight: 700; }
  .stat .k { color: var(--dim); font-size: 13px; }
  .banner { background: var(--raised); border-left: 4px solid var(--warn); border-radius: 8px; padding: 12px 14px; margin-bottom: 14px; }
  .cands { display: flex; flex-direction: column; gap: 6px; border: 0; padding: 0; margin: 12px 0; }
  .cands legend { font-weight: 600; font-size: 14px; margin-bottom: 6px; padding: 0; }
  .cand { display: flex; align-items: center; gap: 10px; padding: 8px; border: 1px solid var(--line); border-radius: 10px; cursor: pointer; font-weight: 500; }
  .cand:has(input:checked) { border-color: var(--brand); background: var(--raised); }
  .cand .poster { width: 32px; height: 48px; font-size: 14px; }
  .qr { width: 160px; height: 160px; background: #fff; border-radius: 8px; padding: 8px; }
  .menu { position: absolute; right: 0; top: calc(100% + 4px); background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 6px; display: flex; flex-direction: column; min-width: 200px; z-index: 30; box-shadow: 0 8px 24px #0003; }
  .menu .btn { justify-content: flex-start; background: transparent; border-color: transparent; }
  .wrap-rel { position: relative; }
  #castBar { position: fixed; left: 50%; transform: translateX(-50%); bottom: 16px; z-index: 40; background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 8px 10px 8px 16px; box-shadow: 0 8px 28px #0004; display: flex; align-items: center; gap: 8px; max-width: calc(100% - 24px); }
  #castBar .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #toast { position: fixed; left: 50%; transform: translateX(-50%); bottom: 84px; z-index: 50; background: var(--text); color: var(--bg); padding: 10px 16px; border-radius: 10px; font-size: 14px; max-width: calc(100% - 24px); }
  .vh { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  @media (max-width: 1100px) { .rail { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
  @media (max-width: 640px) {
    .bar { padding: 10px 16px 0; flex-wrap: nowrap; }
    #hero { min-height: 300px; }
    .hero-body { padding: 18px; gap: 8px; }
    .hero-title { font-size: 26px; letter-spacing: -0.015em; }
    .hero-logo { max-width: 190px; max-height: 58px; }
    .hero-meta { font-size: 12px; gap: 7px; }
    .rail { display: flex; overflow-x: auto; gap: 10px; scrollbar-width: none; padding-bottom: 2px; }
    .rail .r-card { flex: 0 0 214px; }
    .bar-right { min-width: 0; flex: 1; }
    .pills { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; justify-content: flex-end; }
    .pills::-webkit-scrollbar { display: none; }
    .pill { flex: none; }
    .pill.rate { display: none; }
    .tabs { padding: 0 6px; gap: 0; }
    main { padding: 16px 16px 96px; }
    h2 { font-size: 18px; margin: 28px 0 12px; }
    .item { flex-wrap: wrap; }
    .item.job { flex-wrap: nowrap; }
    .item:not(.job) .acts { width: 100%; justify-content: flex-start; }
    .tabs a { padding: 12px 8px 10px; }
    .thumb { width: 96px; height: 54px; }
    .setting .control { max-width: none; }
    .grid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 20px 10px; }
    .tile .poster { font-size: 28px; }
    .detail-head .poster { width: 96px; height: 144px; font-size: 30px; }
    .p-top { flex-wrap: wrap; }
    #playerModal .p-head { flex-basis: 100%; }
    #playerModal .p-title { white-space: normal; }
  }
  /* The browser cinema HUD borrows the Mac player's over-picture chrome and quiet violet controls. */
  #playerModal { --p-bg:#08090c; --p-surface:#101218; --p-raised:#171a22; --p-line:#232733; --p-text:#f2f4f8; --p-dim:#98a0b3;
    position: fixed; inset: 0; background: var(--p-bg); color: var(--p-text); z-index: 100; display: none; flex-direction: column; overflow: hidden; }
  #playerModal.open { display: flex; }
  #playerModal .btn { background: rgba(23,26,34,.72); border-color: rgba(255,255,255,.12); color: var(--p-text); min-height: 36px; padding: 0 12px; backdrop-filter: blur(12px); }
  #playerModal .btn:hover:not(:disabled) { border-color: var(--brand); background: rgba(145,71,255,.22); }
  #playerModal .btn.primary { background: var(--brand); border-color: var(--brand); color: var(--on-brand); }
  #playerModal .btn.primary:hover:not(:disabled) { background: var(--brand-hover); border-color: var(--brand-hover); }
  #playerModal select { background: rgba(23,26,34,.85); color: var(--p-text); border-color: rgba(255,255,255,.12); min-height: 36px; width: auto; backdrop-filter: blur(12px); }
  .p-top { position: absolute; z-index: 2; top: 0; left: 0; right: 0; display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 16px 22px 32px; background: linear-gradient(180deg,rgba(0,0,0,.82),transparent); transition: opacity .2s; }
  .p-head { min-width: 0; flex: 1; }
  .p-title { font-size: 18px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .p-badge { font-size: 12px; color: var(--p-dim); font-variant-numeric: tabular-nums; }
  .p-stage { position: relative; flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; background: #000; overflow: hidden; cursor: pointer; }
  #pBackdrop { position: absolute; inset: -32px; background: center / cover no-repeat; filter: blur(28px) brightness(.36); transform: scale(1.06); opacity: 0; transition: opacity .35s ease; pointer-events: none; }
  #pBackdrop.vis { opacity: 1; }
  #pVideo, #pGlCanvas, #pCanvas { position: relative; z-index: 1; max-width: 100%; max-height: 100%; width: 100%; height: 100%; object-fit: contain; display: none; }
  #pSubCanvas { position: absolute; z-index: 2; inset: 0; width: 100%; height: 100%; object-fit: contain; pointer-events: none; }
  #pSubText { position: absolute; z-index: 2; left: 8%; right: 8%; bottom: 13%; text-align: center; font-size: clamp(16px, 2.2vw, 28px); font-weight: 600; color: var(--on-media); text-shadow: 0 2px 6px #000, 0 0 3px #000, 1px 1px 0 #000, -1px -1px 0 #000; white-space: pre-wrap; pointer-events: none; }
  @keyframes pSpin { to { transform: rotate(360deg); } }
  #pStatus { position: absolute; z-index: 3; display: inline-flex; align-items: center; gap: 10px; padding: 10px 18px; border-radius: 999px; background: rgba(16,18,24,.84); backdrop-filter: blur(14px); border: 1px solid rgba(255,255,255,.14); box-shadow: 0 12px 32px rgba(0,0,0,.55); font-size: 13px; font-weight: 500; color: var(--p-text); pointer-events: none; }
  #pStatus:not(.err)::before { content: ''; width: 14px; height: 14px; border-radius: 50%; border: 2px solid rgba(255,255,255,.22); border-top-color: var(--brand); animation: pSpin .7s linear infinite; flex-shrink: 0; }
  #pStatus.err { border-color: rgba(255,95,95,.45); border-radius: var(--r-control); }
  .p-bar { position: absolute; z-index: 2; bottom: 0; left: 0; right: 0; padding: 32px 20px 16px; background: linear-gradient(0deg,rgba(0,0,0,.88),rgba(0,0,0,.60) 52%,transparent); transition: opacity .2s; }
  .p-bar .row { justify-content: space-between; }
  .p-bar .row .row { justify-content: flex-start; }
  #pSeek { width: 100%; accent-color: var(--brand); padding: 0; cursor: pointer; }
  .clock { font-variant-numeric: tabular-nums; font-size: 12.5px; color: var(--p-dim); min-width: 96px; }
  #playerModal.chrome-hidden .p-top, #playerModal.chrome-hidden .p-bar { opacity: 0; pointer-events: none; }
  /* Music: one bar along the bottom of every tab, and the queue it opens. The bar is the proof that sound is on. */
  :root { --np-h: 76px; }
  .np { position: fixed; left: 0; right: 0; bottom: 0; z-index: 30; min-height: var(--np-h); display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(200px, 1.5fr) auto; grid-template-areas: 'info ctl seek side'; align-items: center; gap: 6px 20px; padding: 10px 24px; background: color-mix(in srgb, var(--surface) 94%, transparent); backdrop-filter: blur(18px) saturate(1.3); border-top: 1px solid var(--line); box-shadow: 0 -10px 30px rgba(0,0,0,.16); }
  body.np-on main { padding-bottom: calc(var(--np-h) + 56px); }
  body.np-on #toast { bottom: calc(var(--np-h) + 16px); }
  body.np-on #castBar { bottom: calc(var(--np-h) + 12px); }
  .np-info { grid-area: info; display: flex; align-items: center; gap: 12px; min-width: 0; }
  .np-art { flex: none; width: 48px; height: 48px; border-radius: 10px; border: 0; padding: 0; background: linear-gradient(150deg, var(--brand), color-mix(in srgb, var(--brand) 35%, var(--raised))); color: var(--on-brand); font: inherit; font-weight: 800; font-size: 20px; cursor: pointer; }
  .np-art .sleeve { position: relative; width: 100%; height: 100%; border-radius: inherit; }
  .np-art .sleeve-mono { font-size: 17px; }
  .np-text { min-width: 0; display: flex; flex-direction: column; align-items: flex-start; }
  .np-title { max-width: 100%; padding: 0; border: 0; background: none; color: var(--text); font: inherit; font-weight: 600; text-align: left; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .np-title:hover { text-decoration: underline; }
  .np-sub { max-width: 100%; color: var(--dim); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .np-sub.bad { color: var(--bad); }
  .np-pos { display: none; }
  .np-ctl { grid-area: ctl; display: flex; align-items: center; gap: 4px; }
  .np-btn { flex: none; width: 40px; height: 40px; padding: 0; border-radius: 50%; border: 0; background: transparent; color: var(--text); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; transition: background var(--t-fast) var(--ease), transform var(--t-fast) var(--ease); }
  .np-btn:hover:not(:disabled) { background: var(--raised); }
  .np-btn:disabled { opacity: .35; cursor: default; }
  .np-btn svg, .track-play svg, .np-q svg, .nq-num svg { width: 20px; height: 20px; fill: currentColor; }
  .np-btn.np-play { width: 44px; height: 44px; background: var(--text); color: var(--bg); }
  .np-btn.np-play:hover:not(:disabled) { background: var(--text); transform: scale(1.06); }
  .i-pause { display: none; }
  .on > .i-play { display: none; }
  .on > .i-pause { display: block; }
  .btn-ic { display: inline-flex; }
  .btn-ic svg { width: 16px; height: 16px; fill: currentColor; }
  .np-seek { grid-area: seek; display: flex; align-items: center; gap: 10px; color: var(--dim); font-size: 12px; font-variant-numeric: tabular-nums; }
  .np-seek span { flex: none; min-width: 38px; }
  .np-seek span:first-child { text-align: right; }
  #npSeek { flex: 1; min-width: 0; margin: 0; accent-color: var(--brand); cursor: pointer; }
  #npSeek:disabled { cursor: default; }
  .np-side { grid-area: side; display: flex; align-items: center; gap: 10px; color: var(--dim); }
  .np-q { min-height: 36px; padding: 0 12px; font-variant-numeric: tabular-nums; }
  .np-q[aria-expanded='true'] { color: var(--text); border-color: var(--line); background: var(--raised); }
  .np-vol { display: flex; align-items: center; gap: 6px; }
  .np-vol svg { width: 18px; height: 18px; fill: currentColor; flex: none; }
  #npVol { width: 92px; margin: 0; accent-color: var(--brand); cursor: pointer; }
  .np-queue { position: fixed; right: 16px; bottom: calc(var(--np-h) + 10px); z-index: 31; width: min(400px, calc(100vw - 24px)); max-height: min(62vh, 540px); display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-panel); box-shadow: 0 24px 60px rgba(0,0,0,.35); overflow: hidden; }
  .nq-head { display: flex; align-items: center; gap: 8px; padding: 12px 10px 8px 18px; border-bottom: 1px solid var(--line); }
  .nq-head .grow h3 { margin: 0; }
  .nq-list { list-style: none; margin: 0; padding: 6px; overflow-y: auto; }
  .nq-list button { width: 100%; display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 8px 10px; border: 0; border-radius: var(--r-control); background: none; color: var(--text); font: inherit; font-size: 14px; text-align: left; cursor: pointer; }
  .nq-list button:hover { background: var(--raised); }
  .nq-num { color: var(--dim); font-size: 12.5px; font-variant-numeric: tabular-nums; text-align: center; display: flex; justify-content: center; }
  .nq-num svg { width: 16px; height: 16px; }
  .nq-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .nq-dur { color: var(--dim); font-size: 12.5px; font-variant-numeric: tabular-nums; }
  .nq-list .done button { color: var(--dim); }
  .nq-list .now button { background: var(--brand-soft); font-weight: 600; }
  .nq-list .now .nq-num { color: var(--ring); }
  .rows .row-item.now { background: var(--brand-soft); border-radius: var(--r-control); padding-left: 10px; padding-right: 10px; }
  .rows .row-item.now + .row-item { border-top-color: transparent; }
  .row-item.now .label { color: var(--ring); }
  .tag.now { color: var(--ring); background: transparent; border: 1px solid currentColor; margin-left: 8px; vertical-align: 1px; }
  .track-play { flex: none; width: 36px; height: 36px; padding: 0; border-radius: 50%; border: 1px solid var(--line); background: transparent; color: var(--text); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
  .track-play svg { width: 14px; height: 14px; }
  .track-play:hover { border-color: var(--brand); }
  .row-item.now .track-play { background: var(--brand); border-color: var(--brand); color: var(--on-brand); }
  .pill.busy::before { content: ''; display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--brand); margin-right: 6px; vertical-align: 1px; animation: npPulse 1.2s ease-in-out infinite; }
  @keyframes npPulse { 50% { opacity: .25; } }
  @media (prefers-reduced-motion: reduce) { .pill.busy::before { animation: none; } }
  @media (max-width: 640px) {
    :root { --np-h: 104px; }
    .np { grid-template-columns: minmax(0, 1fr) auto auto; grid-template-areas: 'info ctl side' 'seek seek seek'; gap: 2px 4px; padding: 8px 10px 10px 14px; }
    .np-art, .np-vol, .np-qtext { display: none; }
    .np-pos { display: inline; }
    .np-pos::after { content: ' · '; }
    .np-btn { width: 38px; height: 38px; }
    .np-btn.np-play { width: 42px; height: 42px; }
    .np-q { min-height: 38px; width: 38px; padding: 0; }
    .np-seek { gap: 8px; }
    .np-queue { left: 8px; right: 8px; width: auto; bottom: calc(var(--np-h) + 8px); }
  }
.p-mini-controls, #pMiniRestore { display: none; }
  #playerModal.mini { inset: auto 18px 18px auto; width: min(380px, calc(100vw - 24px)); height: 280px; border-radius: 16px;
    border: 1px solid rgba(255,255,255,.18); box-shadow: 0 18px 65px rgba(0,0,0,.7); }
  #playerModal.mini .p-stage { flex: 1; }
  #playerModal.mini .p-top { padding: 10px 12px 26px; }
  #playerModal.mini .p-title { font-size: 14px; }
  #playerModal.mini .p-badge, #playerModal.mini #pRawLink, #playerModal.mini #pFsBtn, #playerModal.mini #pMiniBtn, #playerModal.mini .p-bar > #pSeek, #playerModal.mini .p-bar > .row { display: none; }
  #playerModal.mini #pMiniRestore, #playerModal.mini .p-mini-controls { display: flex; }
  #playerModal.mini .p-bar { padding: 24px 12px 10px; }
  #playerModal.mini .p-mini-controls { flex-direction: column; gap: 3px; }
  #playerModal.mini .p-mini-controls .row { display: flex; align-items: center; gap: 6px; }
  #playerModal.mini .p-mini-controls .btn { min-height: 30px; padding: 0 8px; font-size: 12px; }
  #playerModal.mini .p-mini-controls .clock { margin-left: auto; min-width: 0; }
  #pMiniSeek { width: 100%; accent-color: var(--brand); cursor: pointer; }
  #playerModal.mini #pSubText { bottom: 25%; font-size: 13px; }
  @media (max-width: 650px) {
    #playerModal:not(.mini) .p-top { padding: 10px 12px 25px; }
    #playerModal:not(.mini) .p-bar { padding: 24px 12px 10px; }
    #playerModal:not(.mini) .p-bar .row { gap: 5px; }
    #playerModal:not(.mini) #pRawLink, #playerModal:not(.mini) #pDownloadBtn, #playerModal:not(.mini) #pVol { display: none; }
    #playerModal:not(.mini) .p-bar > .row { flex-wrap: wrap; }
    #playerModal:not(.mini) .p-bar select { max-width: 42vw; }
    #playerModal.mini { right: 12px; bottom: 12px; }
  }
  /* ==== Music library ==== */
  .sleeve { position: relative; flex: none; width: 64px; height: 64px; border-radius: 8px; display: flex; align-items: center; justify-content: center; overflow: hidden; color: rgba(255,255,255,.95); box-shadow: inset 0 0 0 1px rgba(255,255,255,.1), 0 1px 3px rgba(0,0,0,.18); }
  .sleeve-mono { font-weight: 800; font-size: 24px; letter-spacing: -0.03em; line-height: 1; text-shadow: 0 2px 12px rgba(0,0,0,.28); }
  .sleeve-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .shelf { display: flex; flex-direction: column; gap: 28px; }
  .shelf > .empty { padding: 24px 0; }
  .artist-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px; }
  .artist-head h3 { font-size: 17px; font-weight: 700; letter-spacing: -0.01em; margin: 0; }
  .artist-head .count { color: var(--dim); font-size: 13px; font-variant-numeric: tabular-nums; }
  .album-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 10px; }
  .album-card { display: flex; align-items: center; gap: 10px; padding: 10px 14px 10px 10px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); transition: border-color var(--t-fast) var(--ease); }
  .album-card:hover { border-color: color-mix(in srgb, var(--dim) 40%, transparent); }
  .album-open { flex: 1; min-width: 0; display: flex; align-items: center; gap: 14px; padding: 0; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; border-radius: 8px; }
  .album-open .sleeve { width: 72px; height: 72px; }
  .album-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .album-name { font-weight: 650; font-size: 15px; line-height: 1.25; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .album-meta { color: var(--dim); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .album-meta:empty { display: none; }
  .album-play { flex: none; width: 40px; height: 40px; padding: 0; border-radius: 50%; border: 1px solid var(--line); background: var(--raised); color: var(--text); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease), transform var(--t-fast) var(--ease); }
  .album-play .btn-ic svg { width: 18px; height: 18px; }
  .album-play:hover, .album-play:has(.btn-ic.on) { background: var(--brand); border-color: var(--brand); color: var(--on-brand); }
  .album-play:hover { transform: scale(1.06); }
  .detail-head.album-head { display: grid; grid-template-columns: auto minmax(0, 1fr); grid-template-rows: 1fr auto auto; grid-template-areas: 'art title' 'art meta' 'art acts'; column-gap: 20px; row-gap: 0; align-items: end; }
  .album-head > .sleeve { grid-area: art; }
  .ah-title { grid-area: title; min-width: 0; }
  .ah-meta { grid-area: meta; min-width: 0; }
  .album-head > .album-acts { grid-area: acts; }
  .sleeve.sleeve-lg { width: 168px; height: 168px; border-radius: var(--r-card); box-shadow: inset 0 0 0 1px rgba(255,255,255,.1), 0 18px 40px rgba(0,0,0,.28); }
  .sleeve-lg .sleeve-mono { font-size: 64px; }
  .detail-head.album-head h3 { font-size: 28px; margin: 0 0 4px; }
  .album-by { font-weight: 600; font-size: 15px; margin-bottom: 4px; }
  .album-acts { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; }
  .album-acts .btn.primary { min-width: 116px; }
  .disc-head { font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); margin: 18px 0 6px; }
  .rows.tracks .row-item { gap: 12px; padding: 6px 8px; border-top: 0; border-radius: var(--r-control); cursor: pointer; }
  .rows.tracks .row-item:hover { background: var(--raised); }
  .rows.tracks .row-item.now { background: var(--brand-soft); padding: 6px 8px; }
  .rows.tracks .label { font-weight: 500; font-size: 14.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #detail .rows.tracks .meta { font-size: 12.5px; line-height: 1.4; }
  .rows.tracks .meta:empty { display: none; }
  .rows.tracks .track-play { width: 32px; height: 32px; border: 0; border-radius: 8px; background: transparent; color: var(--dim); font-size: 13.5px; font-variant-numeric: tabular-nums; }
  .rows.tracks .track-play svg { display: none; width: 14px; height: 14px; }
  .rows.tracks .row-item:hover .track-play .tn, .rows.tracks .row-item.now .track-play .tn, .rows.tracks .track-play:focus-visible .tn { display: none; }
  .rows.tracks .row-item:hover .track-play:not(.on) .i-play, .rows.tracks .row-item.now .track-play:not(.on) .i-play, .rows.tracks .track-play:focus-visible:not(.on) .i-play { display: block; }
  .rows.tracks .track-play.on .i-pause { display: block; }
  .rows.tracks .row-item:hover .track-play, .rows.tracks .row-item.now .track-play { color: var(--text); background: transparent; }
  .rows.tracks .row-item.now .track-play { color: var(--ring); }
  .track-dur { flex: none; min-width: 42px; text-align: right; color: var(--dim); font-size: 13px; font-variant-numeric: tabular-nums; }
  .track-dl { flex: none; width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center; border-radius: 8px; color: var(--dim); opacity: 0; transition: opacity var(--t-fast) var(--ease); }
  .track-dl svg { width: 18px; height: 18px; }
  .row-item:hover .track-dl, .track-dl:focus-visible { opacity: 1; }
  .track-dl:hover { color: var(--text); background: var(--surface); }
  @media (hover: none) { .track-dl { opacity: 1; } }
  @media (max-width: 640px) {
    .album-list { grid-template-columns: minmax(0, 1fr); gap: 8px; }
    .album-open .sleeve { width: 56px; height: 56px; }
    .album-open .sleeve-mono { font-size: 20px; }
    .detail-head.album-head { grid-template-columns: 108px minmax(0, 1fr); grid-template-rows: auto auto auto; grid-template-areas: 'art title' 'meta meta' 'acts acts'; column-gap: 14px; }
    .album-head > .sleeve { margin-bottom: 12px; }
    .ah-title { align-self: center; margin-bottom: 12px; }
    .sleeve.sleeve-lg { width: 108px; height: 108px; }
    .sleeve-lg .sleeve-mono { font-size: 40px; }
    .detail-head.album-head h3 { font-size: 21px; }
    .album-acts .btn.primary { flex: 1; }
    .rows.tracks .row-item { gap: 8px; padding: 6px 4px; }
  }
  /* ==== Sources: Soulseek and YouTube search, save and progress ==== */
  .slsk-port { margin-top: 12px; font-size: 13px; color: var(--dim); line-height: 1.45; overflow-wrap: anywhere; }
  .slsk-port.alert { background: var(--raised); border-left: 4px solid var(--warn); border-radius: 8px; padding: 10px 12px; color: var(--text); }
  .slsk-port code { font-size: 12.5px; background: var(--surface); padding: 1px 5px; border-radius: 4px; }
  .meta.wrap { white-space: normal; overflow-wrap: anywhere; }
  .src-jobs { margin-top: 12px; }
  .src-jobs .item.job { align-items: flex-start; }
  .slsk-state { font-size: 13.5px; font-weight: 600; margin-top: 2px; overflow-wrap: anywhere; }
  .slsk-state.ok { color: var(--ok); }
  .slsk-state .what { color: var(--dim); font-weight: 500; }
  .slsk-state.bad { color: var(--bad); }
  .slsk-state.warn { color: var(--warn); }
  .slsk-amount { font-variant-numeric: tabular-nums; }
  .src-jobs .bar-track { height: 5px; }
  .src-jobs .bar-track.wait > div { background: var(--dim); }
  .slsk-fix { color: var(--text); }
  .slsk-fix code { font-size: 12px; background: var(--raised); padding: 1px 5px; border-radius: 4px; }
  .slsk-tools { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin: 10px 0; }
  .slsk-tools select { width: auto; min-width: 200px; }
  .slsk-browse h3 { margin: 0; font-size: 17px; overflow-wrap: anywhere; }
  .slsk-head { display: flex; gap: 8px; align-items: flex-start; margin-bottom: 12px; }
  .slsk-head .grow { flex: 1; min-width: 0; }
  .slsk-browse input[type=search] { margin-bottom: 10px; }
  .slsk-wait { display: flex; gap: 10px; align-items: center; color: var(--dim); font-size: 14px; padding: 18px 0; }
  .slsk-spin { width: 16px; height: 16px; flex: none; border: 2px solid var(--line); border-top-color: var(--brand); border-radius: 50%; animation: slskSpin .8s linear infinite; }
  @keyframes slskSpin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .slsk-spin { animation-duration: 3s; } }
  .item.slsk-folder { flex-direction: column; flex-wrap: nowrap; align-items: stretch; gap: 0; }
  .item.slsk-folder.focus { border-color: var(--brand); }
  .slsk-row { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
  .slsk-row .info { flex: 1 1 240px; min-width: 0; }
  .slsk-files { margin-top: 10px; border-top: 1px solid var(--line); }
  .slsk-file { display: flex; gap: 10px; align-items: center; padding: 8px 2px; border-bottom: 1px solid var(--line); font-size: 13.5px; cursor: pointer; min-width: 0; }
  .slsk-file:last-child { border-bottom: 0; }
  .slsk-file input { width: 18px; height: 18px; flex: none; margin: 0; accent-color: var(--brand); }
  .slsk-file .grow { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .slsk-file .meta { margin: 0; flex: none; max-width: 48%; }
  @media (max-width: 640px) {
    .slsk-file { flex-wrap: wrap; }
    .slsk-file .meta { max-width: none; flex-basis: 100%; padding-left: 28px; }
    .slsk-tools select { width: 100%; }
    .src-jobs .item.job { flex-wrap: wrap; }
    .src-jobs .item.job .acts { width: 100%; justify-content: flex-start; }
  }
  .src-in { display: flex; gap: 6px 10px; align-items: center; flex-wrap: wrap; }
  .src-in .chips { margin-top: 0; }
  .chip .st { font-weight: 500; opacity: .85; }
  .chip.setup { border-style: dashed; }
  .chip[aria-disabled='true'] { opacity: .6; cursor: default; }
  .chip .warn-ic { color: var(--warn); }
  .src-summary { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 12px; font-size: 13.5px; color: var(--dim); }
  .src-summary a { color: var(--text); font-weight: 600; text-decoration: underline; text-underline-offset: 3px; min-height: 24px; display: inline-flex; align-items: center; }
  .src-summary a:hover { text-decoration-thickness: 2px; }
  #srcMsg:not(.err) { position: absolute; width: 1px; height: 1px; margin: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  #srcGroups { overflow-anchor: none; }
  .src-summary .sep { opacity: .55; }
  .src-group { margin-top: 22px; }
  .src-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; }
  .src-head h3 { margin: 0; font-size: 16px; display: inline-flex; align-items: baseline; gap: 8px; }
  .src-head h3:focus { outline: none; }
  .src-head h3:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
  .src-head .count { margin-left: auto; color: var(--dim); font-size: 13px; font-variant-numeric: tabular-nums; display: inline-flex; align-items: center; gap: 8px; }
  .src-note { color: var(--dim); font-size: 13px; margin-top: 4px; overflow-wrap: anywhere; display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; }
  .src-note .btn { min-height: 32px; padding: 0 12px; font-size: 13px; }
  .src-group > .list { margin-top: 10px; }
  .src-group .msg { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; }
  .src-tag { margin-right: 6px; }
  .src-glyph { width: 40px; height: 40px; flex: none; border-radius: 10px; background: var(--raised); color: var(--dim); display: flex; align-items: center; justify-content: center; }
  .src-glyph svg { width: 20px; height: 20px; }
  .item.src-row { align-items: flex-start; }
  .yt-pick-row { flex: 1 1 320px; min-width: 0; min-height: 72px; display: flex; gap: 12px; align-items: center; cursor: pointer; font-weight: inherit; font-size: inherit; }
  .yt-pick-row > input { width: 20px; height: 20px; flex: none; margin: 0; accent-color: var(--brand); }
  .yt-pick-row .info { flex: 1; min-width: 0; }
  .yt-pick-row .meta { display: block; }
  .yt-pick-row .meta .tag { margin-right: 2px; display: inline-block; margin-bottom: 2px; }
  .yt-thumb { position: relative; border-radius: 8px; }
  .yt-thumb.sm { width: 48px; height: 27px; border-radius: 4px; }
  .yt-ph { width: 0; height: 0; border-left: 16px solid var(--dim); border-top: 10px solid transparent; border-bottom: 10px solid transparent; opacity: .7; }
  .yt-thumb.sm .yt-ph { border-left-width: 9px; border-top-width: 6px; border-bottom-width: 6px; }
  .yt-thumb img { z-index: 1; }
  .yt-dur { position: absolute; z-index: 2; right: 4px; bottom: 4px; padding: 1px 5px; border-radius: 4px; background: rgba(0,0,0,.72); color: var(--on-media); font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .yt-pick { position: sticky; bottom: 12px; z-index: 5; display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; margin-top: 12px; padding: 10px 12px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); box-shadow: 0 10px 30px rgba(0,0,0,.25); }
  body.np-on .yt-pick { bottom: calc(var(--np-h) + 12px); }
  .yt-pick .grow { flex: 1 1 140px; min-width: 0; font-weight: 600; font-size: 14px; overflow-wrap: anywhere; }
  #ytSaveClose { position: absolute; top: 14px; right: 14px; }
  .yt-save { padding: 22px; }
  .yt-save h3 { font-size: 20px; margin: 0 96px 4px 0; }
  .yt-save h3:focus { outline: none; }
  #ytSaveNote { margin: 12px 0 0; }
  #ytSaveNote div + div { margin-top: 4px; }
  #ytSaveHint { display: block; margin: -6px 0 14px; }
  #ytSaveSub { margin-bottom: 16px; }
  #ytSaveNote { margin-bottom: 16px; }
  .yt-tracks { border: 0; padding: 0; margin: 0 0 6px; min-width: 0; }
  .yt-tracks legend { font-weight: 600; font-size: 14px; padding: 0; margin-bottom: 8px; }
  .yt-tracks ol { list-style: none; margin: 0 0 8px; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .yt-tracks li { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .yt-tracks .tn { width: 22px; flex: none; text-align: right; color: var(--dim); font-variant-numeric: tabular-nums; font-weight: 600; }
  .yt-tracks li > input { flex: 1 1 200px; width: auto; min-width: 0; }
  .yt-tracks .dur { color: var(--dim); font-size: 13px; font-variant-numeric: tabular-nums; min-width: 36px; }
  .yt-tracks .mv { display: inline-flex; gap: 4px; }
  .ic-btn { width: 32px; height: 32px; padding: 0; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--text); font: inherit; font-size: 14px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
  .ic-btn[aria-disabled='true'] { opacity: .4; cursor: default; }
  .yt-tracks .yt-dup { flex-basis: 100%; margin-left: 30px; display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: center; font-size: 13px; color: var(--dim); }
  .yt-tracks .yt-dup[hidden] { display: none; }
  .yt-dup label { display: inline-flex; gap: 6px; align-items: center; color: var(--text); cursor: pointer; }
  .why summary { cursor: pointer; width: max-content; max-width: 100%; }
  .why > div { margin-top: 4px; overflow-wrap: anywhere; }
  .yt-save-acts { position: sticky; bottom: 0; z-index: 2; margin: 12px -22px -22px; padding: 12px 22px 22px; background: var(--surface); border-top: 1px solid var(--line); }
  .album-meta[data-aq]:not(:empty) { display: flex; }
  .album-meta .aq-main { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .album-meta .aq-yt { flex: none; white-space: pre; }
  .track-alt-del { display: inline-block; margin-top: 2px; padding: 2px 0; border: 0; background: transparent; color: var(--dim); font: inherit; font-size: 12.5px; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
  .track-alt-del:hover { color: var(--text); }
  .track-alt-del.armed { color: var(--bad); }
  .empty .btn { margin-top: 12px; }
  .bar-steps { display: flex; gap: 3px; margin-top: 10px; }
  .bar-steps > i { flex: 1; height: 5px; border-radius: 2px; background: var(--raised); }
  .bar-steps > i.done { background: var(--brand); }
  .bar-steps > i.now { background: var(--brand-soft); background-image: linear-gradient(90deg, transparent, var(--brand), transparent); background-size: 200% 100%; animation: srcSheen 1.4s linear infinite; }
  .bar-track.indef { position: relative; }
  .bar-track.indef > div { width: 30%; animation: srcSlide 1.4s ease-in-out infinite; }
  @keyframes srcSheen { from { background-position: 100% 0; } to { background-position: -100% 0; } }
  @keyframes srcSlide { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
  @media (prefers-reduced-motion: reduce) {
    .bar-steps > i.now { animation: none; background: var(--dim); }
    .bar-track.indef > div { animation: none; width: 100%; background: var(--dim); }
  }
  @media (pointer: coarse) {
    .chip { min-height: 40px; }
    .ic-btn { width: 44px; height: 44px; }
    .src-summary a { min-height: 44px; }
  }
  @media (max-width: 640px) {
    .yt-pick .btn { flex: 1; }
    .yt-pick .grow { flex-basis: 100%; }
    .yt-save { padding: 18px 16px; }
    .yt-save-acts { margin: 12px -16px -18px; padding: 12px 16px 18px; }
    .yt-tracks li > input { flex-basis: calc(100% - 30px); }
    .yt-tracks .dur { margin-left: 30px; }
    .yt-tracks .mv { margin-left: auto; }
  }
  /* ==== end Sources ==== */
  /* ==== Delete (DeleteAndSingleMirror) ==== */
  .track-del { flex: none; min-width: 32px; height: 32px; padding: 0 6px; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 8px; background: transparent; color: var(--dim); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; opacity: 0; transition: opacity var(--t-fast) var(--ease); }
  .track-del svg { width: 18px; height: 18px; }
  .row-item:hover .track-del, .track-del:focus-visible, .track-del.armed { opacity: 1; }
  .track-del:hover { color: var(--text); background: var(--surface); }
  @media (hover: none) { .track-del { opacity: 1; } }
  .btn.armed, .track-del.armed { color: var(--bad); border-color: var(--bad); }
  .del-ask { align-self: center; color: var(--bad); overflow-wrap: anywhere; }
  .slsk-file > label { display: flex; gap: 10px; align-items: center; flex: 1 1 auto; min-width: 0; cursor: pointer; }
  .slsk-file .slsk-one { flex: none; min-height: 32px; padding: 0 10px; font-size: 13px; }
  @media (max-width: 640px) { .slsk-file .meta { order: 2; } }
  /* ==== end Delete ==== */
</style>
</head>
<body>
<header class="top">
  <div class="bar">
    <a class="brand" href="#library"><svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8"/><path d="M12 9l12 7-12 7z"/></svg>PearTube</a>
    <div class="bar-right">
      <div class="pills" id="pills"></div>
      <button class="btn quiet theme-toggle" id="themeToggle" type="button" aria-label="Theme" title="Theme">
        <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="6.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 3.4a6.6 6.6 0 010 13.2z" fill="currentColor"/></svg>
      </button>
    </div>
  </div>
  <nav class="tabs" aria-label="Sections">
    <a href="#library" data-tab="library">Library</a>
    <a href="#music" data-tab="music">Music</a>
    <a href="#channels" data-tab="channels">Channels</a>
    <a href="#sharing" data-tab="sharing">Sharing</a>
    <a href="#tv" data-tab="tv">TV</a>
    <a href="#settings" data-tab="settings">Settings</a>
  </nav>
</header>
<main>
  <form id="authForm" class="card" hidden>
    <div class="field">
      <label for="tokenInput">Access token</label>
      <div class="row"><input class="grow" id="tokenInput" type="password" autocomplete="current-password" placeholder="9f86d081884c7d659a2feaa0c55ad015" required><button class="btn primary" type="submit">Sign in</button></div>
      <span class="hint">This relay asks for the token it was started with.</span>
    </div>
    <div class="msg err" id="authMsg" role="alert"></div>
  </form>

  <section id="tab-library" data-panel="library">
    <section id="hero" hidden></section>
    <div id="resumeWrap" hidden><h2>Continue watching <span class="count" id="resumeCount"></span></h2><div class="rail" id="resume"></div></div>
    <div id="liveWrap" hidden><h2>Live <span class="count" id="liveCount"></span></h2><div class="rail" id="live"></div></div>
    <div class="card">
      <form id="addForm">
        <div class="field" style="margin:0">
          <label for="addInput">Add a video or channel</label>
          <div class="row"><input class="grow" id="addInput" type="text" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://www.youtube.com/watch?v=aqz-KE-bpKQ"><button class="btn primary" type="submit" id="addBtn">Add</button></div>
        </div>
      </form>
      <div class="chips" role="group" aria-label="More ways to add">
        <button class="chip" type="button" id="folderChip" data-opens="folderForm" aria-expanded="false" hidden>Import folder</button>
        <button class="chip" type="button" data-opens="feedForm" aria-expanded="false">Mirror a catalog</button>
        <button class="chip" type="button" data-opens="copyForm" aria-expanded="false">Copy a channel</button>
      </div>
      <form id="folderForm" class="panel" hidden>
        <div class="row"><button class="btn primary" type="submit">Scan import folder</button></div>
        <span class="hint">New videos in the relay’s import folder are added automatically.</span>
      </form>
      <form id="feedForm" class="panel" hidden>
        <div class="field">
          <label for="feedInput">Catalog URL</label>
          <div class="row"><input class="grow" id="feedInput" type="url" spellcheck="false" placeholder="https://example.org/catalog.json" required><button class="btn primary" type="submit">Mirror</button></div>
          <span class="hint">JSON list of titles and source URLs; another relay's /v1/entries works.</span>
        </div>
        <div class="listedit" id="feedList"></div>
      </form>
      <form id="copyForm" class="panel" hidden>
        <div class="field">
          <label for="copyInput">Channel link</label>
          <div class="row"><input class="grow" id="copyInput" type="text" spellcheck="false" placeholder="peartube://channel/6049da41fd86a20f4883255bd6120bd6b580e19aa209693eb1f3f8c649c76d70" required><button class="btn primary" type="submit">Copy</button></div>
          <span class="hint">Follows the channel and keeps every video on this relay.</span>
        </div>
      </form>
      <form id="preview" class="panel" hidden></form>
      <div class="msg" id="addMsg" role="status"></div>
    </div>
    <div id="jobsWrap" hidden><h2>Adding <span class="count" id="jobCount"></span></h2><div class="list" id="jobs"></div></div>
    <h2>Library <span class="count" id="libCount"></span></h2>
    <div class="lib-tools" id="libTools" hidden>
      <div class="kinds" id="libKinds" role="group" aria-label="Show"></div>
      <input id="libFilter" type="search" aria-label="Search library" placeholder="Big Buck Bunny">
    </div>
    <div class="grid" id="entries"></div>
    <h2>Search all relays</h2>
    <form id="globalForm" class="card">
      <div class="field">
        <label for="globalInput">Title or IMDb id</label>
        <div class="row"><input class="grow" id="globalInput" type="search" spellcheck="false" placeholder="Stalker 1979" required><button class="btn primary" type="submit" id="globalBtn">Search</button></div>
        <span class="hint">Asks relays you do not follow; results play from them.</span>
      </div>
      <div class="msg" id="globalMsg" role="status"></div>
      <div class="list" id="globalResults"></div>
    </form>
  </section>

  <section id="tab-music" data-panel="music" hidden>
    <h2>Music <span class="count" id="musicCount"></span></h2>
    <div class="lib-tools" id="musicTools" hidden>
      <input id="musicFilter" type="search" aria-label="Search music" placeholder="Chop Suey!">
    </div>
    <div class="shelf" id="albums"></div>
    <h2>Find music</h2>
    <!-- ==== Sources: one search over Soulseek and YouTube ==== -->
    <form id="srcForm" class="card">
      <div class="field">
        <label for="srcInput">Artist or album</label>
        <div class="row"><input class="grow" id="srcInput" type="search" spellcheck="false" placeholder="John Coltrane Blue Train" required><button class="btn primary" type="submit" id="srcBtn">Search</button></div>
        <div class="src-in" id="srcIn" hidden><span class="label" id="srcInLabel">Search in</span><div class="chips" id="srcChips" role="group" aria-labelledby="srcInLabel"></div></div>
        <span class="hint" id="srcHint">Finds albums on peers and mirrors them here.</span>
        <div class="meta wrap" id="srcNote" hidden></div>
      </div>
      <div class="slsk-port" id="slskPort" role="note" hidden></div>
      <div class="list src-jobs" id="srcJobs" aria-label="Adding" hidden></div>
      <div class="msg" id="srcMsg" role="status"></div>
      <nav class="src-summary" id="srcSummary" aria-label="Results by source" hidden></nav>
      <div id="srcGroups"></div>
      <div class="yt-pick" id="ytPick" role="region" aria-label="Selected videos" hidden>
        <span class="grow" id="ytPickText"></span>
        <button class="btn primary" type="button" id="ytPickSave">Save track</button>
        <button class="btn quiet" type="button" id="ytPickClear">Clear</button>
      </div>
    </form>
    <div class="card slsk-browse" id="slskBrowse" hidden></div>
    <!-- ==== end Sources ==== -->
  </section>

  <section id="tab-channels" data-panel="channels" hidden>
    <h2>This channel</h2>
    <div class="list" id="mine"></div>
    <div id="devicesWrap" hidden>
      <h2>Devices &amp; writers</h2>
      <div class="list" id="devices"></div>
      <form id="writerForm" class="card" style="margin-top:12px">
        <div class="field">
          <label for="writerInput">Add device or writer key</label>
          <input id="writerInput" type="text" spellcheck="false" placeholder="6049da41fd86a20f4883255bd6120bd6b580e19aa209693eb1f3f8c649c76d70" required>
        </div>
        <div class="field">
          <label for="writerRole">Role</label>
          <select id="writerRole"><option value="owner">My device (owner)</option><option value="mod">Moderator</option><option value="writer">Contributor</option></select>
        </div>
        <div class="field">
          <label for="writerName">Label</label>
          <input id="writerName" type="text" placeholder="Phone">
        </div>
        <button class="btn primary" type="submit">Add</button>
        <div class="msg" id="writerMsg" role="status"></div>
      </form>
      <form id="recoverForm" class="card" style="margin-top:12px">
        <div class="field">
          <label for="recoverInput">Link with 12-word recovery phrase</label>
          <input id="recoverInput" type="text" spellcheck="false" placeholder="abandon ability able about above absent absorb abstract absurd abuse access accident" required>
          <span class="hint">Links this relay to an existing recovery phrase.</span>
        </div>
        <div class="row">
          <button class="btn primary" type="submit">Link channel</button>
          <button class="btn quiet" type="button" id="revealPhraseBtn">Copy my 12-word phrase</button>
        </div>
        <div class="msg" id="recoverMsg" role="status"></div>
      </form>
    </div>
    <h2>Following <span class="count" id="followCount"></span></h2>
    <div class="list" id="following"></div>
    <form id="followForm" class="card" style="margin-top:12px">
      <div class="field">
        <label for="followInput">Follow a channel or subscriber pass</label>
        <input id="followInput" type="text" spellcheck="false" placeholder="peartube://channel/6049da41fd86a20f4883255bd6120bd6b580e19aa209693eb1f3f8c649c76d70" required>
      </div>
      <div class="field">
        <label for="followName">Name</label>
        <input id="followName" type="text" placeholder="Blender Studio">
      </div>
      <button class="btn primary" type="submit">Follow</button>
      <div class="msg" id="followMsg" role="status"></div>
    </form>
    <div id="foundWrap" hidden><h2>Found on the network</h2><div class="list" id="found"></div></div>
  </section>

  <section id="tab-sharing" data-panel="sharing" hidden>
    <h2>Peers</h2>
    <div class="card" id="netCard"></div>
    <h2>Keep copies</h2>
    <div class="card" id="copiesCard"></div>
    <h2>Answer searches</h2>
    <div class="card" id="globalCard"></div>
    <h2>HiveRelays</h2>
    <div class="card">
      <div id="hiveStatus"></div>
      <form id="hiveForm" class="panel">
        <div class="field">
          <label for="hiveInput">Ask a HiveRelay to seed</label>
          <input id="hiveInput" type="url" spellcheck="false" placeholder="http://192.168.1.50:9100" required>
        </div>
        <div class="field">
          <label for="hiveKey">Its access key</label>
          <input id="hiveKey" type="password" autocomplete="off" placeholder="hr_4f1c2a9b7d" >
        </div>
        <button class="btn primary" type="submit">Add HiveRelay</button>
        <div class="msg" id="hiveMsg" role="status"></div>
      </form>
    </div>
    <h2>Other apps</h2>
    <div class="card" id="appsCard"></div>
  </section>

  <section id="tab-tv" data-panel="tv" hidden>
    <div class="card" id="castNow" hidden></div>
    <form id="pairForm" class="card">
      <div class="field" style="margin:0">
        <label for="pairInput">Pair a TV</label>
        <div class="row"><input class="grow" id="pairInput" type="text" autocomplete="off" spellcheck="false" placeholder="K7Q2PX" required><button class="btn primary" type="submit">Pair</button></div>
        <span class="hint">Enter the code or link shown on the TV.</span>
      </div>
      <div class="msg" id="pairMsg" role="status"></div>
    </form>
    <h2>Your TVs</h2>
    <div class="list" id="tvs"></div>
  </section>

  <section id="tab-settings" data-panel="settings" hidden>
    <div id="settingsBody"></div>
  </section>
</main>
<dialog id="detail" aria-labelledby="detailTitle">
  <div class="bar"><button class="btn quiet" id="detailClose" type="button">Close</button></div>
  <div id="detailBody"></div>
</dialog>
<dialog id="ytSave" aria-labelledby="ytSaveTitle">
  <form id="ytSaveForm" class="yt-save" novalidate>
    <h3 id="ytSaveTitle" tabindex="-1">Save from YouTube</h3>
    <div class="meta" id="ytSaveSub"></div>
    <div class="slsk-port alert" id="ytSaveNote" role="note" hidden></div>
    <div class="field"><label for="ytArtist">Artist</label><input id="ytArtist" type="text" required autocomplete="off" spellcheck="false" placeholder="e.g. Miles Davis"></div>
    <div class="field"><label for="ytAlbum">Album</label><input id="ytAlbum" type="text" required autocomplete="off" spellcheck="false" placeholder="e.g. Kind of Blue"></div>
    <div class="field"><label for="ytYear">Year (optional)</label><input id="ytYear" type="text" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="e.g. 1959"></div>
    <span class="hint" id="ytSaveHint" hidden></span>
    <fieldset class="yt-tracks"><legend id="ytTracksLegend">Tracks</legend><ol id="ytTracks"></ol><span class="hint" id="ytTracksHint">Numbered in this order on disc 1.</span></fieldset>
    <div class="msg" id="ytSaveMsg" role="alert"></div>
    <div class="vh" id="ytSaveLive" role="status"></div>
    <div class="row yt-save-acts"><button class="btn primary" type="submit" id="ytSaveBtn">Save track</button><button class="btn quiet" type="button" id="ytSaveCancel">Cancel</button></div>
    <button class="btn quiet" type="button" id="ytSaveClose">Close</button>
  </form>
</dialog>
<div id="castBar" hidden></div>
<div class="np" id="np" role="region" aria-label="Music player" hidden>
  <div class="np-info">
    <button class="np-art" id="npArt" type="button" aria-label="Open album"></button>
    <div class="np-text">
      <button class="np-title" id="npTitle" type="button"></button>
      <div class="np-sub" aria-live="polite"><span class="np-pos" id="npPos"></span><span id="npMeta"></span></div>
    </div>
  </div>
  <div class="np-ctl">
    <button class="np-btn" id="npPrev" type="button" aria-label="Previous track"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5.5" width="2.6" height="13" rx="1"/><path d="M19 6.4v11.2a1 1 0 0 1-1.55.83L9.6 13.2a1.4 1.4 0 0 1 0-2.4l7.85-5.23A1 1 0 0 1 19 6.4z"/></svg></button>
    <button class="np-btn np-play" id="npPlay" type="button" aria-label="Play"><svg class="i-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.2-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg><svg class="i-pause" viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg></button>
    <button class="np-btn" id="npNext" type="button" aria-label="Next track"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="16.4" y="5.5" width="2.6" height="13" rx="1"/><path d="M5 6.4v11.2a1 1 0 0 0 1.55.83l7.85-5.23a1.4 1.4 0 0 0 0-2.4L6.55 5.57A1 1 0 0 0 5 6.4z"/></svg></button>
  </div>
  <div class="np-seek">
    <span id="npAt">0:00</span>
    <input type="range" id="npSeek" min="0" max="0" step="any" value="0" aria-label="Seek" disabled>
    <span id="npLeft">--:--</span>
  </div>
  <div class="np-side">
    <button class="btn quiet np-q" id="npQueueBtn" type="button" aria-expanded="false" aria-controls="npQueue"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="12" height="2" rx="1"/><rect x="3" y="11" width="12" height="2" rx="1"/><rect x="3" y="16" width="8" height="2" rx="1"/><path d="M15.5 13.6v6.3a.6.6 0 0 0 .92.5l4.6-3.15a.6.6 0 0 0 0-1l-4.6-3.15a.6.6 0 0 0-.92.5z"/></svg><span class="np-qtext" id="npQText"></span></button>
    <label class="np-vol"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.2L12 5.6v12.8l-4.8-3.9H4z"/><path d="M15.2 8.6a5 5 0 0 1 0 6.8l-1.1-1.1a3.4 3.4 0 0 0 0-4.6zM17.6 6.2a8.4 8.4 0 0 1 0 11.6l-1.1-1.1a6.8 6.8 0 0 0 0-9.4z"/></svg><input type="range" id="npVol" min="0" max="100" step="1" value="100" aria-label="Volume"></label>
  </div>
</div>
<section class="np-queue" id="npQueue" aria-label="Queue" hidden>
  <div class="nq-head">
    <div class="grow"><h3>Queue</h3><div class="meta" id="npQueueMeta"></div></div>
    <button class="btn quiet" id="npClear" type="button">Stop</button>
    <button class="btn quiet" id="npQueueClose" type="button">Close</button>
  </div>
  <ol class="nq-list" id="npList"></ol>
</section>
<div id="toast" role="status" hidden></div>
<div id="playerModal" role="dialog" aria-modal="true" aria-labelledby="pTitle">
  <div class="p-top">
    <div class="p-head">
      <div class="p-title" id="pTitle"></div>
      <div class="p-badge" id="pBadge">Loading player…</div>
    </div>
    <div class="row">
      <a class="btn" id="pRawLink" target="_blank" rel="noopener">Open file</a>
      <button class="btn" id="pMiniBtn" type="button" aria-label="Minimize player">Mini player</button>
      <button class="btn" id="pMiniRestore" type="button" aria-label="Expand player">Expand</button>
      <button class="btn" id="pFsBtn" type="button">Fullscreen</button>
      <button class="btn" id="pCloseBtn" type="button" aria-label="Close player">Close</button>
    </div>
  </div>
  <div class="p-stage" id="pStage">
    <div id="pBackdrop"></div>
    <video id="pVideo" muted playsinline></video>
    <canvas id="pGlCanvas"></canvas>
    <canvas id="pCanvas"></canvas>
    <canvas id="pSubCanvas"></canvas>
    <div id="pSubText"></div>
    <div id="pStatus"></div>
  </div>
  <div class="p-bar">
    <input type="range" id="pSeek" min="0" max="1000" value="0" step="1" aria-label="Position">
    <div class="row">
      <div class="row">
        <button class="btn" id="pBackBtn" type="button" aria-label="Back 10 seconds">↶ 10</button>
        <button class="btn primary" id="pPlayBtn" type="button">Pause</button>
        <button class="btn" id="pFwdBtn" type="button" aria-label="Forward 10 seconds">10 ↷</button>
        <span class="clock" id="pClock">0:00 / 0:00</span>
      </div>
      <div class="row">
        <select id="pAudioSel" aria-label="Audio track"></select>
        <select id="pSubSel" aria-label="Subtitles"></select>
        <a class="btn" id="pDownloadBtn" href="#" download>Download</a>
        <button class="btn" id="pMuteBtn" type="button">Mute</button>
        <input type="range" id="pVol" min="0" max="100" value="100" style="width:80px;padding:0;accent-color:var(--brand)" aria-label="Volume">
      </div>
    </div>
    <div class="p-mini-controls">
      <input type="range" id="pMiniSeek" min="0" max="1000" value="0" step="1" aria-label="Mini player position">
      <div class="row">
        <button class="btn" id="pMiniBack" type="button" aria-label="Back 10 seconds">↶ 10</button>
        <button class="btn primary" id="pMiniPlay" type="button" aria-label="Pause">Pause</button>
        <button class="btn" id="pMiniFwd" type="button" aria-label="Forward 10 seconds">10 ↷</button>
        <span class="clock" id="pMiniClock">0:00 / 0:00</span>
      </div>
    </div>
  </div>
</div>
<script>
const $ = id => document.getElementById(id)
const el = (t, c, txt) => { const e = document.createElement(t); if (t === 'button') e.type = 'button'; if (c) e.className = c; if (txt != null) e.textContent = txt; return e }
// Builds an element: h('button', { class: 'btn', onclick }, 'Label', child, ...). Strings always land as text.
function h (tag, attrs, ...kids) {
  const e = document.createElement(tag)
  if (tag === 'button') e.type = 'button'
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v
    else if (k.startsWith('on') || k === 'checked' || k === 'disabled' || k === 'value' || k === 'hidden') e[k] = v
    else if (v === true) e.setAttribute(k, '')
    else if (v !== false && v != null) e.setAttribute(k, v)
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid instanceof Node ? kid : String(kid))
  return e
}
const size = n => n == null || !Number.isFinite(n) ? '' : n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? Math.round(n / 1e3) + ' KB' : n + ' B'
const rate = n => size(n || 0) + '/s'
const short = k => k ? k.slice(0, 8) + '…' : ''
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many)
function duration (s) {
  if (!s) return ''
  const m = Math.floor(s / 60), r = String(Math.floor(s % 60)).padStart(2, '0')
  return m >= 60 ? Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0') + ':' + r : m + ':' + r
}

let token = localStorage.getItem('peartube.token') || ''
let needsToken = false
// The token header every owner route needs; a 401 shows the sign-in form. api() and the streamed search share them.
function authHeaders (json) {
  const headers = {}
  if (json) headers['content-type'] = 'application/json'
  if (token) headers.authorization = 'Bearer ' + token
  return headers
}
function signInFirst () {
  needsToken = true
  $('authForm').hidden = false
  return new Error('Sign in with the access token first.')
}
// Every call goes through here: the token rides along, a 401 asks for it, errors come back as messages.
async function api (path, { method, body } = {}) {
  const res = await fetch(path, { method: method || (body !== undefined ? 'POST' : 'GET'), headers: authHeaders(body !== undefined), body: body !== undefined ? JSON.stringify(body) : undefined })
  let data = null
  try { data = await res.json() } catch {}
  if (res.status === 401) throw signInFirst()
  if (!res.ok) throw new Error((data && data.error) || 'The relay answered ' + res.status)
  return data
}

let toastTimer = 0
function toast (text) {
  const t = $('toast')
  t.textContent = text
  t.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { t.hidden = true }, 3500)
}
function say (id, text, bad) {
  const m = $(id)
  m.textContent = text || ''
  m.classList.toggle('err', Boolean(bad))
}
async function act (btn, fn, msgId) {
  if (btn) btn.disabled = true
  try { return await fn() } catch (err) {
    if (msgId) say(msgId, err.message, true)
    else toast(err.message)
  } finally { if (btn) btn.disabled = false }
}

function copyText (text) {
  if (!text) return
  let copied = false
  const onCopy = ev => {
    if (!ev.clipboardData) return
    ev.clipboardData.setData('text/plain', text)
    ev.preventDefault()
    copied = true
  }
  document.addEventListener('copy', onCopy, true)
  const prev = document.activeElement
  const dialogs = document.querySelectorAll('dialog[open]')
  const host = dialogs.length ? dialogs[dialogs.length - 1] : document.body
  const ta = el('textarea')
  ta.value = text
  ta.setAttribute('inputmode', 'none')
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0'
  host.append(ta)
  ta.focus({ preventScroll: true })
  ta.select()
  ta.setSelectionRange(0, text.length)
  let ok = false
  try { ok = document.execCommand('copy') } catch {}
  document.removeEventListener('copy', onCopy, true)
  ta.remove()
  if (prev && prev.focus) { try { prev.focus({ preventScroll: true }) } catch {} }
  if (ok || copied) { toast('Link copied'); return }
  if (window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => toast('Link copied'), () => toast('Could not copy link'))
    return
  }
  toast('Could not copy link')
}
const copyBtn = (label, text) => h('button', { class: 'btn', disabled: !text, title: text || '', onclick: () => copyText(text) }, label)

// Holds the lists still while a finger is down, so an update never moves a button mid-press. Source groups that
// answered during the press wait in srcHeld and are drawn when it ends.
let pressing = false, refreshQueued = false, player = null, playerEntry = null, lastResumeSave = 0
let srcHeld = null // null, or { names: Set of source groups whose answer is waiting for the press to end, said: the status line for it }
// Where the mouse rests (never a finger, which leaves): what a redraw above it must not move.
let srcPointer = null
addEventListener('pointerdown', () => { pressing = true })
addEventListener('pointermove', ev => { srcPointer = ev.pointerType === 'mouse' ? [ev.clientX, ev.clientY] : null }, { passive: true })
document.documentElement.addEventListener('mouseleave', () => { srcPointer = null })
for (const evName of ['pointerup', 'pointercancel', 'blur']) {
  addEventListener(evName, () => {
    if (!pressing) return
    pressing = false
    if (refreshQueued) { refreshQueued = false; setTimeout(refresh, 0) }
    if (srcHeld) setTimeout(srcFlush, 0)
  })
}

const S = { status: {}, sources: { sources: [], discovered: [], published: [] }, entries: [], jobs: [], plugins: [], cast: null, settings: null, identity: null }
const plugin = name => S.plugins.find(p => p.name === name) || {}
// The music sources this page can search, in the order their groups are drawn: the one that can hold the better
// copy first. Display names only; the ids stay off screen.
const SOURCES = [['soulseek', 'Soulseek'], ['youtube', 'YouTube']]
const SOURCE_NAMES = new Set(SOURCES.map(s => s[0]))
const sourceLabel = name => (SOURCES.find(s => s[0] === name) || [name, 'This source'])[1]
// A copy saved from YouTube is AAC at about 128 kbps whatever its header says, and its id says where it came from.
const YT_CODEC = 'AAC 128 kbps'
const YT_LABEL = 'YouTube · ' + YT_CODEC
const isYt = e => String((e && e.id) || '').startsWith('yt:')
const setting = key => S.settings && S.settings.settings[key]
const sval = key => setting(key) ? setting(key).value : undefined

// ---- Tabs
let tab = 'library'
function showTab () {
  const want = location.hash.slice(1)
  tab = ['library', 'music', 'channels', 'sharing', 'tv', 'settings'].includes(want) ? want : 'library'
  for (const a of document.querySelectorAll('.tabs a')) a.setAttribute('aria-current', a.dataset.tab === tab ? 'page' : 'false')
  for (const s of document.querySelectorAll('[data-panel]')) s.hidden = s.dataset.panel !== tab
  if (tab === 'tv') loadCast()
  if (tab === 'settings') renderSettings()
  render()
}
addEventListener('hashchange', showTab)

// ---- Loading
async function refresh () {
  if (pressing || player) { refreshQueued = true; return }
  try {
    // A job missing from a list asked for after it started is gone (dismissed or trimmed), not yet to come.
    const asked = Date.now()
    const [st, src, ent, jb, pl, set, ident] = await Promise.all([
      api('/v1/status'), api('/v1/sources'), api('/v1/entries'), api('/v1/jobs'),
      api('/v1/plugins').catch(() => ({ plugins: [] })),
      // Another tab, a reopen or the relay itself can change settings; reload them once this page may see them.
      S.settings ? api('/v1/settings').catch(() => S.settings) : null,
      S.settings ? api('/v1/identity').catch(() => S.identity) : null
    ])
    Object.assign(S, { status: st, sources: src, entries: ent.results || [], jobs: jb.jobs || [], jobsAsked: asked, plugins: pl.plugins || [], offline: false })
    if (set) S.settings = set
    if (ident) S.identity = ident
    noticeJobs(!S.loaded)
    S.loaded = true
    restoreMusic()
  } catch (err) {
    S.offline = !needsToken
  }
  if (pressing || player) { refreshQueued = true; return }
  render()
  if (S.jobs.some(srcActive)) pollMirrors()
  if (tab === 'settings') refreshSettingsView()
}
let settingsShown = ''
function refreshSettingsView () {
  const shown = JSON.stringify([S.settings, S.status.privateGuard ? S.status.privateGuard.port : 0])
  if (shown === settingsShown || $('settingsBody').contains(document.activeElement)) return
  renderSettings()
}
let settingsLoaded = false
async function loadSettings () {
  try { S.settings = await api('/v1/settings') } catch { S.settings = null }
  try { S.identity = S.settings ? await api('/v1/identity') : null } catch { S.identity = null }
  settingsLoaded = true
  if (tab === 'settings') renderSettings()
  render()
}
async function loadCast () {
  try { S.cast = await api('/v1/cast/status') } catch { S.cast = null }
  renderCast()
}
let refreshTimer = 0
const soon = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 250) }

function render () {
  renderPills()
  if (tab === 'library') renderLibrary()
  if (tab === 'music') renderMusic()
  if (tab === 'channels') renderChannels()
  if (tab === 'sharing') renderSharing()
  if (tab === 'tv') renderCast()
  renderCastBar()
}

// ---- Header
function renderPills () {
  const st = S.status
  const pills = []
  if (S.offline) pills.push(h('span', { class: 'pill warn' }, 'Relay unreachable'))
  else {
    pills.push(h('span', { class: 'pill' + (st.peers || st.lanPeers ? ' ok' : '') }, h('b', null, String((st.peers || 0))), ' ', (st.peers === 1 ? 'peer' : 'peers'), st.lanPeers ? ' · ' + st.lanPeers + ' nearby' : ''))
    pills.push(h('span', { class: 'pill rate' }, '↓ ', h('b', null, rate(st.downBps)), ' ↑ ', h('b', null, rate(st.upBps))))
  }
  // An album being added runs for minutes; the header says so on every tab, and a press goes to its progress. A
  // percentage only when every running job knows its total (a YouTube save never does).
  const adding = S.jobs.filter(srcActive)
  if (!S.offline && adding.length) {
    const total = adding.every(j => j.total > 0) ? adding.reduce((n, j) => n + j.total, 0) : 0
    const pct = total ? Math.min(99, Math.floor(adding.reduce((n, j) => n + (j.bytes || 0), 0) / total * 100)) : null
    const btn = h('button', { class: 'pill busy', type: 'button' }, 'Adding' + (adding.length > 1 ? ' ' + adding.length + ' albums' : '') + (pct != null ? ' ' + pct + '%' : ''))
    btn.onclick = () => { location.hash = '#music'; setTimeout(() => $('srcJobs').scrollIntoView({ block: 'center' }), 0) }
    pills.push(btn)
  }
  const restart = S.settings ? S.settings.restartNeeded.length : 0
  if (restart) {
    const btn = h('button', { class: 'pill warn', type: 'button' }, 'Restart to apply ' + plural(restart, 'change', 'changes'))
    btn.onclick = () => act(btn, restartRelay)
    pills.push(btn)
  }
  if (needsToken && !token) pills.push(h('span', { class: 'pill warn' }, 'Read-only until you sign in'))
  $('pills').replaceChildren(...pills)
}
const MIRROR_ACTIVE = new Set(['queued', 'running', 'transferring', 'announcing'])
// When an album lands or fails, say so on whichever tab is open. The first load only learns what is already there.
const jobWas = new Map()
function noticeJobs (first) {
  for (const j of S.jobs) {
    if (!SOURCE_NAMES.has(j.plugin)) continue
    const was = jobWas.get(j.jobId)
    jobWas.set(j.jobId, j.status)
    if (first || was === j.status || (was && !MIRROR_ACTIVE.has(was))) continue
    const title = '“' + (j.title || 'the album') + '”'
    if (j.status === 'done') toast('Added ' + title + ' to your library')
    else if (j.status === 'failed') toast((j.plugin === 'youtube' ? 'Could not save ' + title + ' from YouTube' : 'Could not mirror ' + title) + (j.error ? ': ' + j.error : ''))
  }
}

// ---- Library: add flow
for (const chip of document.querySelectorAll('[data-opens]')) {
  chip.onclick = () => {
    for (const other of document.querySelectorAll('[data-opens]')) {
      const open = other === chip && other.getAttribute('aria-expanded') !== 'true'
      other.setAttribute('aria-expanded', String(open))
      $(other.dataset.opens).hidden = !open
      if (open) $(other.dataset.opens).querySelector('input, button').focus()
    }
    $('preview').hidden = true
    say('addMsg', '')
    renderFeeds()
  }
}

const HEX = /^[0-9a-f]{64}$/i
$('addForm').onsubmit = async ev => {
  ev.preventDefault()
  const val = $('addInput').value.trim()
  say('addMsg', '')
  $('preview').hidden = true
  if (!val) return say('addMsg', 'Paste a link to a video, a page, or a channel.', true)
  if (/^peartube:/i.test(val)) {
    return act($('addBtn'), async () => {
      const watch = /^peartube:(?:[/][/])?watch[/]/i.test(val)
      const access = /^peartube:(?:[/][/])?access[/]/i.test(val)
      const r = await api((watch || access) ? '/v1/open' : '/v1/sources', { body: { uri: val } })
      $('addInput').value = ''
      say('addMsg', watch ? 'Opened. It is in your library now.' : access ? 'Pass saved. Subscriber videos are unlocked.' : 'Following ' + ((r.source && r.source.alias) || 'the channel') + '.')
      refresh()
    }, 'addMsg')
  }
  if (HEX.test(val)) {
    location.hash = '#channels'
    $('followInput').value = val
    $('followInput').dispatchEvent(new Event('input'))
    $('followName').focus()
    return
  }
  if (!/^https?:[/][/]/i.test(val)) return say('addMsg', 'That is not a link. Links start with https://', true)
  await act($('addBtn'), async () => {
    say('addMsg', 'Looking at the link…')
    const r = await api('/v1/identify', { body: { url: val } })
    say('addMsg', '')
    renderPreview(val, r)
  }, 'addMsg')
}

function posterBox (src, title, cls) {
  const box = h('div', { class: 'poster' + (cls ? ' ' + cls : '') }, (title || '?').trim().charAt(0).toUpperCase())
  if (src) {
    const img = h('img', { class: 'poster' + (cls ? ' ' + cls : ''), alt: '', loading: 'lazy', src })
    img.onerror = () => img.replaceWith(box)
    return img
  }
  return box
}

function renderPreview (url, r) {
  const p = $('preview')
  const link = r.link
  const facts = [link.site, link.uploader, duration(link.duration), r.parsed.resolution, size(link.size)].filter(Boolean)
  const choices = [...r.candidates.map(c => ({ id: c.id, title: c.title, label: c.title, poster: c.poster, sub: c.type === 'series' ? 'Episode' : 'Movie' })),
    { id: r.plain.id, title: r.plain.title, label: r.candidates.length ? 'None of these' : r.plain.title, sub: link.kind === 'page' ? 'Video' : 'Video file' }]
  const chosen = r.match || r.plain.id
  const titleInput = h('input', { id: 'addTitle', type: 'text', value: (choices.find(c => c.id === chosen) || choices[0]).title, placeholder: 'Big Buck Bunny 2008', required: true })
  let privOnly = false
  const privToggle = h('label', { class: 'switch' },
    h('input', { type: 'checkbox', role: 'switch', onchange: ev => { privOnly = ev.target.checked } }),
    h('span', null, 'Subscribers only'))
  const radios = choices.map(c => h('label', { class: 'cand' },
    h('input', { type: 'radio', name: 'cand', value: c.id, checked: c.id === chosen, onchange: () => { titleInput.value = c.title } }),
    c.poster !== undefined ? posterBox(c.poster, c.label) : null,
    h('span', { class: 'grow' }, h('div', null, c.label), h('div', { class: 'meta' }, c.sub))))
  p.replaceChildren(
    h('div', { class: 'row', style: 'flex-wrap:nowrap;align-items:flex-start' },
      link.thumbnail ? posterBox(link.thumbnail, link.name, 'thumb') : null,
      h('div', { class: 'grow' }, h('h3', null, link.name || r.parsed.title), h('div', { class: 'meta' }, facts.join(' · ')))),
    r.candidates.length ? h('fieldset', { class: 'cands' }, h('legend', null, 'Is this one of these?'), radios) : null,
    h('div', { class: 'field' }, h('label', { for: 'addTitle' }, 'Title in your library'), titleInput),
    privToggle,
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', type: 'submit', id: 'confirmAdd' }, 'Add to library'),
      h('button', { class: 'btn quiet', onclick: () => { p.hidden = true } }, 'Cancel')))
  p.onsubmit = async ev => {
    ev.preventDefault()
    const picked = p.querySelector('input[name=cand]:checked')
    const id = picked ? picked.value : r.plain.id
    await act($('confirmAdd'), async () => {
      await api('/v1/acquire', { body: { id, title: titleInput.value.trim() || r.plain.title, private: privOnly, source: { url, page: link.kind === 'page' } } })
      p.hidden = true
      $('addInput').value = ''
      say('addMsg', 'Adding “' + (titleInput.value.trim() || r.plain.title) + '”.')
      refresh()
    }, 'addMsg')
  }
  p.hidden = false
}

// The import folder is the relay host's (PEARTUBE_WATCH_DIR); the page only asks for a scan and never sees its path.
$('folderForm').onsubmit = async ev => {
  ev.preventDefault()
  await act(ev.submitter, async () => {
    const r = await api('/v1/plugins/watch-dir/run', { body: {} })
    say('addMsg', r.skipped ? 'This relay has no import folder.' : r.busy ? 'A scan is already running.' : 'Scanned the import folder: ' + plural(r.ingested || 0, 'new video', 'new videos') + '.')
    refresh()
  }, 'addMsg')
}
$('feedForm').onsubmit = async ev => {
  ev.preventDefault()
  const url = $('feedInput').value.trim()
  await act(ev.submitter, async () => {
    await saveSettings({ feeds: [...(sval('feeds') || []).map(f => f.ref), url] })
    $('feedInput').value = ''
    say('addMsg', 'Following the feed. Its videos are added as they appear.')
    renderFeeds()
  }, 'addMsg')
}
function renderFeeds () {
  const feeds = sval('feeds') || []
  $('feedList').replaceChildren(...feeds.map(f => h('div', { class: 'entry' }, h('span', null, f.label),
    h('button', { class: 'btn quiet', onclick: e => act(e.currentTarget, async () => { await saveSettings({ feeds: feeds.filter(x => x !== f).map(x => x.ref) }); renderFeeds() }) }, 'Unfollow'))))
}
$('copyForm').onsubmit = async ev => {
  ev.preventDefault()
  const val = $('copyInput').value.trim()
  await act(ev.submitter, async () => {
    const r = await api('/v1/sources', { body: HEX.test(val) ? { key: val.toLowerCase(), kind: 'channel' } : { uri: val } })
    await keepCopy(r.source.key, true)
    $('copyInput').value = ''
    say('addMsg', 'Copying ' + (r.source.alias || 'the channel') + ' to this relay.')
    refresh()
  }, 'addMsg')
}

// ---- Library: jobs and entries
// Copying: the file is already in a followed channel, so the relay takes that copy from peers instead of downloading.
// Albums from music sources have their own card under Find music (srcJobItem); this list is everything else.
const JOB_TEXT = { queued: 'Waiting', copying: 'Copying from peers', running: 'Downloading', announcing: 'Publishing', done: 'Added', failed: 'Failed', cancelled: 'Cancelled' }
function jobItem (j) {
  const active = j.status === 'queued' || j.status === 'copying' || j.status === 'running' || j.status === 'announcing'
  const moving = j.status === 'running' || j.status === 'copying'
  const pct = j.total ? Math.min(100, Math.round((j.bytes || 0) / j.total * 100)) : null
  const verb = j.status === 'copying' ? 'Copying from peers' : 'Downloading'
  const status = moving && j.bytes != null
    ? (pct != null ? verb + ' ' + pct + '% of ' + size(j.total) : verb + ' · ' + size(j.bytes))
    : JOB_TEXT[j.status] || j.status
  const tagClass = j.status === 'done' ? 'tag ok' : j.status === 'failed' ? 'tag bad' : 'tag'
  return h('div', { class: 'item job' },
    h('div', { class: 'info' },
      h('div', { class: 'name' }, j.title || 'Untitled'),
      h('div', { class: 'meta' }, h('span', { class: tagClass }, status), j.status === 'done' && j.size ? ' ' + size(j.size) : ''),
      j.error && j.status === 'failed' ? h('div', { class: 'meta err wrap' }, j.error) : null,
      moving ? h('div', { class: 'bar-track' }, h('div', { style: 'width:' + (pct == null ? 100 : pct) + '%' })) : null),
    h('div', { class: 'acts' }, h('button', { class: 'btn quiet', onclick: e => act(e.currentTarget, async () => { await api('/v1/jobs/' + j.jobId, { method: 'DELETE' }); refresh() }) }, active ? 'Cancel' : 'Dismiss')))
}
function renderJobs () {
  const recent = Date.now() - 6 * 3600_000
  const jobs = S.jobs.filter(j => !SOURCE_NAMES.has(j.plugin) && (j.status !== 'done' || j.created > recent)).sort((a, b) => b.created - a.created).slice(0, 20)
  $('jobsWrap').hidden = !jobs.length
  $('jobCount').textContent = jobs.length ? String(jobs.length) : ''
  $('jobs').replaceChildren(...jobs.map(jobItem))
}

// ---- Library: one tile per title (the relay already returns one entry per file). Episodes group under their show,
// numbered from the id, since their titles are usually just the show's name.
// A replica that has every block holds the file as fully as its owner does.
const saved = e => e.local || e.cachedBytes >= e.size
const where = e => saved(e) ? 'Saved here' : e.cachedBytes ? 'Partly saved' : 'On the network'
function sourceName (key) {
  const s = (S.sources.sources || []).find(x => x.key === key)
  if (!s || s.writable) return ''
  return s.alias || (s.kind === 'channel' ? 'Channel ' : 'Tracker ') + short(s.key)
}
function libraryTiles () {
  const tiles = new Map()
  for (const e of S.entries) {
    const m = e.id.match(/^imdb:(tt[0-9]+)(?::s([0-9]+)e([0-9]+))?$/)
    // An imdb: id is a film or an episode. Anything else with a season and an episode is a track of an album
    // (mb:, discogs: and album: ids carry disc and track in that suffix), and is grouped by its series key so an
    // album is one tile with one row per track instead of one loose video per file.
    const music = !m && e.season != null
    const kind = !m ? (music ? 'album' : 'video') : m[2] ? 'show' : 'movie'
    const key = kind === 'video' ? 'v:' + e.id + '/' + e.sha256 : music ? 'album:' + e.seriesKey : kind + ':' + m[1]
    let t = tiles.get(key)
    if (!t) tiles.set(key, t = { key, kind, imdb: m ? m[1] : null, title: e.title.replace(/\\s+S[0-9]+E[0-9]+$/i, ''), items: [] })
    t.items.push({ e, season: m ? (m[2] ? Number(m[2]) : null) : e.season, episode: m ? (m[3] ? Number(m[3]) : null) : e.episode })
  }
  for (const t of tiles.values()) {
    if (t.kind === 'album') continue
    t.items.sort((a, b) => (a.season - b.season) || (a.episode - b.episode) || (b.e.size - a.e.size))
    t.saved = t.items.filter(i => saved(i.e)).length
    t.partial = t.items.some(i => !saved(i.e) && i.e.cachedBytes)
  }
  for (const t of mergeAlbums(tiles)) tiles.set(t.key, t)
  return [...tiles.values()].sort((a, b) => a.title.localeCompare(b.title))
}
// An album is its artist and its name, not its release id: a peer that tagged by release group and another that
// tagged by release announce the same album under two ids, and both land here as one tile. A track held twice is one
// row, playing the copy saved here (or the larger one). The album's name is what most of its tracks' titles say, so
// one badly tagged track ("Untitled album") neither renames the album nor splits it off.
const fold = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\\p{L}\\p{N}]+/gu, ' ').trim()
function mergeAlbums (tiles) {
  const groups = new Map()
  for (const t of [...tiles.values()]) {
    if (t.kind !== 'album') continue
    tiles.delete(t.key)
    const votes = new Map()
    for (const i of t.items) {
      const a = (i.e.music && i.e.music.artist) || ''
      const name = a && i.e.title.startsWith(a + ' · ') ? i.e.title.slice(a.length + 3) : i.e.title
      const v = votes.get(a + '\\n' + name) || { a, name, n: 0 }
      v.n++
      votes.set(a + '\\n' + name, v)
    }
    const top = [...votes.values()].sort((x, y) => y.n - x.n)[0]
    const id = fold(top.a) + '\\n' + fold(top.name)
    const g = groups.get(id)
    if (g) g.parts.push(t)
    else groups.set(id, { artist: top.a, album: top.name, parts: [t] })
  }
  const albums = [...groups.values()].map(({ artist, album, parts }) => {
    // The release with the most tracks names the tile, so its key stays put when a duplicate arrives or leaves.
    parts.sort((x, y) => (y.items.length - x.items.length) || x.key.localeCompare(y.key))
    const all = parts.flatMap(p => p.items)
      .sort((a, b) => (a.season - b.season) || (a.episode - b.episode) || (saved(b.e) - saved(a.e)) || (b.e.size - a.e.size))
    const items = []
    for (const i of all) {
      const prev = items[items.length - 1]
      if (prev && prev.season === i.season && prev.episode === i.episode && fold(trackName(prev.e)) === fold(trackName(i.e))) {
        prev.copies++
        prev.alts.push(i.e)
      } else items.push({ ...i, copies: 1, alts: [] })
    }
    // A YouTube copy is numbered by whoever saved it, so the same song can sit under another number than the
    // release's own. Matched by name, it becomes one more copy of that row; the copy saved here (or the larger) plays.
    const named = new Map()
    for (const i of items) if (!isYt(i.e) && !named.has(fold(trackName(i.e)))) named.set(fold(trackName(i.e)), i)
    const rows = items.filter(i => {
      const twin = isYt(i.e) && !i.alts.some(a => !isYt(a)) ? named.get(fold(trackName(i.e))) : null
      if (!twin) return true
      if (saved(i.e) && !saved(twin.e)) [twin.e, i.e] = [i.e, twin.e]
      twin.copies += i.copies
      twin.alts.push(i.e, ...i.alts)
      return false
    })
    return {
      key: parts[0].key,
      kind: 'album',
      imdb: null,
      title: artist ? artist + ' · ' + album : album,
      artist,
      album,
      // A YouTube copy beside a release is one more copy, not one more release.
      releases: parts.filter(p => !p.items.every(i => isYt(i.e))).length,
      // Every announce this tile folded, across all its releases: a delete must reach the sibling release ids, not just
      // the one that happened to sort first, or the tile regroups from the survivors and the album reappears.
      keys: parts.flatMap(p => p.items.map(i => i.e.key)),
      items: rows,
      saved: rows.filter(i => saved(i.e)).length,
      partial: rows.some(i => !saved(i.e) && i.e.cachedBytes),
      seed: sleeveHash(fold(artist) + '\\n' + fold(album))
    }
  })
  // One artist's albums sit side by side, so each takes its own sixth of the colour wheel: its hash picks a sixth,
  // and a sibling already there moves it to the next free one. Taken in hash order, an album keeps its colour unless
  // a newcomer lands on its sixth first, which is rare; up to six albums per artist never share a hue.
  const byArtist = new Map()
  for (const t of albums) {
    const k = fold(t.artist)
    if (!byArtist.has(k)) byArtist.set(k, [])
    byArtist.get(k).push(t)
  }
  for (const list of byArtist.values()) {
    const used = new Set()
    for (const t of list.sort((a, b) => a.seed - b.seed)) {
      let slot = Math.floor((t.seed % 360) / 60)
      for (let k = 0; k < 6 && used.has(slot); k++) slot = (slot + 1) % 6
      used.add(slot)
      t.hue = slot * 60 + (t.seed >>> 11) % 36
    }
  }
  return albums
}
function tileLine (t) {
  const n = t.items.length
  if (t.kind === 'show') {
    const seasons = new Set(t.items.map(i => i.season)).size
    return (seasons > 1 ? plural(seasons, 'season', 'seasons') + ' · ' : '') + plural(n, 'episode', 'episodes')
  }
  if (t.kind === 'album') {
    const discs = new Set(t.items.map(i => i.season)).size
    // Size, not length: a length is known only once every track's header is read, and a shelf where some cards
    // say minutes and others megabytes reads as noise. The sheet says both.
    return [(discs > 1 ? plural(discs, 'disc', 'discs') + ' · ' : '') + plural(n, 'track', 'tracks'), size(t.items.reduce((sum, i) => sum + (i.e.size || 0), 0))].join(' · ')
  }
  const e = t.items[0].e
  return [t.kind === 'movie' ? 'Movie' : 'Video', n > 1 ? n + ' versions' : size(e.size)].join(' · ')
}
function tileState (t) {
  if (t.saved === t.items.length) return ['Saved here', 'ok']
  if (t.saved || t.partial) return [t.kind === 'show' ? t.saved + ' saved here' : t.kind === 'album' ? t.saved + ' of ' + t.items.length + ' saved here' : 'Partly saved', '']
  return ['On the network', '']
}

// ---- Music library
// An album's picture is the one its own files carry: a FLAC PICTURE block, read from the bytes this relay already
// holds (never a third party: Cover Art Archive from this page would tell it what the relay holds, and /v1/poster
// serves IMDb ids only). Until one is found, and for albums that carry none, the album wears a sleeve made from its
// name: a hue (spread across the artist's albums by mergeAlbums), and from a hash of artist and album a second hue,
// a lightness, an angle and one of three cuts (a sweep, a record, a split), with the album's initials on top. The
// same album is the same sleeve on every reload, and albums by one artist are told apart at a glance.
function sleeveHash (s) {
  let x = 2166136261
  for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619)
  // FNV-1a leaves short strings' high bits poorly mixed; a final avalanche spreads every bit the sleeve reads.
  x ^= x >>> 16
  x = Math.imul(x, 0x85ebca6b)
  x ^= x >>> 13
  x = Math.imul(x, 0xc2b2ae35)
  return (x ^ (x >>> 16)) >>> 0
}
const SMALL_WORDS = new Set(['a', 'an', 'the', 'of', 'and', 'in', 'on', 'to', 'for', 'le', 'la', 'les', 'de', 'der', 'die', 'das'])
function monogram (name) {
  const words = String(name || '').split(/[\\s·:/-]+/).filter(Boolean)
  const big = words.filter(w => !SMALL_WORDS.has(w.toLowerCase()))
  const pick = (big.length ? big : words).map(w => [...w][0]).filter(c => /[\\p{L}\\p{N}]/u.test(c))
  return (pick.slice(0, 2).join('') || '♪').toUpperCase()
}
function albumArt (t, cls) {
  const n = t.seed
  const h1 = t.hue
  const h2 = (h1 + 30 + (n >>> 9) % 120) % 360
  const angle = 120 + (n >>> 17) % 120
  const base = 'hsl(' + h1 + ' 62% ' + (42 + (n >>> 3) % 16) + '%)'
  const deep = 'hsl(' + h2 + ' 64% 20%)'
  const shine = 'radial-gradient(circle at 78% 18%, rgba(255,255,255,.22), transparent 46%), '
  const cuts = [
    shine + 'linear-gradient(' + angle + 'deg, ' + base + ', ' + deep + ')',
    'repeating-radial-gradient(circle, rgba(0,0,0,.14) 0 1px, transparent 1px 4px), radial-gradient(circle, ' + base + ' 0 31%, ' + deep + ' 32%)',
    shine + 'linear-gradient(' + angle + 'deg, ' + base + ' 0 54%, ' + deep + ' 54%)'
  ]
  const box = h('div', { class: 'sleeve' + (cls ? ' ' + cls : ''), 'aria-hidden': 'true', style: 'background:' + cuts[(n >>> 25) % 3] },
    h('span', { class: 'sleeve-mono' }, monogram(t.album)))
  albumCover(t).then(src => { if (src) box.append(h('img', { class: 'sleeve-img', alt: '', src })) })
  return box
}
// The first front cover (or, failing one, the first picture) among the album's first few saved tracks. Only files
// held here are read, so looking for a picture never asks the network for a title; four tracks bound the cost of an
// album that carries none to four small reads.
const covers = new Map() // tile key -> Promise of an object URL or null
function albumCover (t) {
  if (!covers.has(t.key)) {
    covers.set(t.key, (async () => {
      for (const i of t.items.filter(x => saved(x.e) && x.e.streamUrl).slice(0, 4)) {
        const src = await flacPicture(i.e).catch(() => null)
        if (src) return src
      }
      return null
    })())
  }
  return covers.get(t.key)
}
// Walks a FLAC file's metadata blocks (after an ID3 tag, if one leads) through 16 KB range reads, and returns the
// PICTURE block's image as an object URL.
async function flacPicture (e) {
  const url = resolveStreamUrl(e.streamUrl)
  const read = async (at, n) => {
    const r = await fetch(url, { headers: { range: 'bytes=' + at + '-' + (at + n - 1) } })
    // Anything but a range reply would be the whole file.
    if (r.status !== 206) { if (r.body) r.body.cancel(); return new Uint8Array(0) }
    return new Uint8Array(await r.arrayBuffer())
  }
  let win = { at: 0, b: await read(0, 16384) }
  const bytes = async (at, n) => {
    if (at < win.at || at + n > win.at + win.b.length) win = { at, b: await read(at, Math.max(n, 16384)) }
    const b = win.b.subarray(at - win.at, at - win.at + n)
    if (b.length < n) throw new Error('short read')
    return b
  }
  const ascii = b => String.fromCharCode(...b)
  let at = 0
  const id3 = await bytes(0, 10)
  if (ascii(id3.subarray(0, 3)) === 'ID3') at = 10 + ((id3[6] & 127) << 21 | (id3[7] & 127) << 14 | (id3[8] & 127) << 7 | (id3[9] & 127))
  if (ascii(await bytes(at, 4)) !== 'fLaC') return null
  at += 4
  let pick = null
  for (let n = 0; n < 64; n++) {
    const hd = await bytes(at, 4)
    const len = hd[1] << 16 | hd[2] << 8 | hd[3]
    if ((hd[0] & 127) === 6 && len < 16e6) {
      const block = await bytes(at + 4, len)
      const kind = new DataView(block.buffer, block.byteOffset).getUint32(0)
      if (!pick || kind === 3) pick = block
      if (kind === 3) break
    }
    if (hd[0] & 128) break
    at += 4 + len
  }
  if (!pick) return null
  const v = new DataView(pick.buffer, pick.byteOffset, pick.byteLength)
  let p = 4
  const mime = ascii(pick.subarray(p + 4, p + 4 + v.getUint32(p)))
  p += 4 + v.getUint32(p)
  p += 4 + v.getUint32(p) + 16
  const length = v.getUint32(p)
  if (!/^image[/](jpeg|png|webp|gif)$/.test(mime) || p + 4 + length > pick.length) return null
  return URL.createObjectURL(new Blob([pick.subarray(p + 4, p + 4 + length)], { type: mime }))
}
// The album's running time, once every track's header has been read (the sheet reads them all); 0 until then.
function albumSecs (t) {
  let secs = 0
  for (const i of t.items) {
    const d = infoData.get(i.e.key)
    if (!d || !d.media || !d.media.duration) return 0
    secs += d.media.duration
  }
  return secs
}
// What a copy of the album is: "FLAC 24-bit 44.1 kHz". The full verdict (bitrate, "lossless container") is the
// album sheet's; this is the one fact a listener sorts a shelf by. The shelf reads one track's header per album,
// and once a sheet has read them all it says what most tracks are.
function shortQuality (d) {
  const a = d && d.media && (d.media.audio || [])[0]
  if (!a) return ''
  return [a.codec, a.depth ? a.depth + '-bit' : '', a.rate ? (a.rate / 1000) + ' kHz' : ''].filter(Boolean).join(' ')
}
// What a copy is, for the shelf, the sheet and a track's line: a YouTube copy is named by where it came from.
const copyQuality = (e, d) => isYt(e) ? YT_LABEL : shortQuality(d)
// An album that holds a YouTube copy beside another one (rows playing it, or kept as a second copy of a row).
const hasYt = t => t.items.some(i => isYt(i.e) || (i.alts || []).some(isYt))
const allYt = t => t.items.every(i => isYt(i.e) && !(i.alts || []).some(a => !isYt(a)))
// One read per album at a time: the card is painted when it lands, and asked again on a later draw if it did not.
const qualityAsked = new Set()
function albumQuality (t) {
  const e = (t.items.find(i => !isYt(i.e)) || t.items[0]).e
  if (isYt(e) || infoData.has(e.key)) return commonQuality(t)
  if (qualityAsked.has(e.key)) return ''
  qualityAsked.add(e.key)
  infoEntries.set(e.key, e)
  loadInfo(e.key).then(() => {
    qualityAsked.delete(e.key)
    if (!infoData.has(e.key)) return
    for (const line of document.querySelectorAll('[data-aq]')) if (line.dataset.aq === t.key) line.replaceChildren(...albumLine(t))
  })
  return ''
}
// Saved here is the normal state of a mirrored album, so it is said only when it is not true. An album that also
// holds a YouTube copy says so after what most of it is; on a narrow card the quality is cut, never "also YouTube".
function albumLine (t) {
  const [state, tone] = tileState(t)
  const q = albumQuality(t)
  const main = [tone === 'ok' ? '' : state, q].filter(Boolean).join(' · ')
  const yt = hasYt(t) && !allYt(t) && q !== YT_LABEL ? 'also YouTube' : ''
  return [main ? h('span', { class: 'aq-main' }, main) : null, yt ? h('span', { class: 'aq-yt' }, (main ? ' · ' : '') + yt) : null].filter(Boolean)
}
function albumPlayBtn (t) {
  const list = t.items.map(i => i.e).filter(e => !e.locked)
  if (!list.length) return null
  const b = h('button', { class: 'album-play', 'data-album': t.key, 'aria-label': 'Play ' + t.album, onclick: () => (queue.length && (tileOf(queue[queueIndex]) || {}).key === t.key) ? musicToggle() : startQueue(list, list[0], t.title) })
  const ic = h('span', { class: 'btn-ic' })
  ic.innerHTML = ICON_PLAY + ICON_PAUSE
  b.append(ic)
  return b
}
// The Music view is a shelf per artist, not a wall of posters: albums are square, read left to right as name, size
// and copy, and play from where they sit. Rows fill the width four to a line on a desktop and stack on a phone.
function renderAlbums (list) {
  const byArtist = new Map()
  for (const t of list) {
    const k = t.artist || 'Unknown artist'
    if (!byArtist.has(k)) byArtist.set(k, [])
    byArtist.get(k).push(t)
  }
  return [...byArtist].sort((a, b) => a[0].localeCompare(b[0])).map(([artist, albums]) => h('section', { class: 'artist-group' },
    h('div', { class: 'artist-head' },
      h('h3', null, artist),
      h('span', { class: 'count' }, plural(albums.length, 'album', 'albums') + ' · ' + plural(albums.reduce((n, t) => n + t.items.length, 0), 'track', 'tracks'))),
    h('div', { class: 'album-list' }, albums.sort((a, b) => a.album.localeCompare(b.album)).map(t => h('div', { class: 'album-card', 'data-tile': t.key },
      h('button', { class: 'album-open', onclick: () => openDetail(t.key) },
        albumArt(t),
        h('span', { class: 'album-text' },
          h('span', { class: 'album-name' }, t.album),
          h('span', { class: 'album-meta' }, tileLine(t)),
          h('span', { class: 'album-meta', 'data-aq': t.key }, ...albumLine(t)))),
      albumPlayBtn(t))))))
}
const albumMatches = (t, q) => t.title.toLowerCase().includes(q) || t.items.some(i => trackName(i.e).toLowerCase().includes(q))
// Continue watching: where this browser stopped, remembered locally. No protocol change,
// no relay state; a different browser starts its own list.
const WATCH_KEY = 'peartube-watch'
let watchStore = {}
try { watchStore = JSON.parse(localStorage.getItem(WATCH_KEY) || '{}') || {} } catch {}
const watchId = e => e.sha256 ? 's:' + e.sha256 : 'i:' + e.id
function saveResume (entry, at, dur) {
  if (!entry || !(dur > 0) || !isFinite(at)) return
  watchStore[watchId(entry)] = { at: Math.max(0, at), dur, t: Date.now() }
  const ids = Object.keys(watchStore)
  if (ids.length > 300) ids.sort((a, b) => watchStore[a].t - watchStore[b].t).slice(0, ids.length - 300).forEach(i => delete watchStore[i])
  try { localStorage.setItem(WATCH_KEY, JSON.stringify(watchStore)) } catch {}
}
function resumeTiles (tiles) {
  const out = []
  for (const t of tiles) {
    for (const i of t.items) {
      const w = watchStore[watchId(i.e)]
      if (!w || !(w.dur > 0)) continue
      const pct = w.at / w.dur
      if (pct < 0.02 || pct > 0.95) continue
      out.push({ t, i, w, pct })
    }
  }
  return out.sort((a, b) => b.w.t - a.w.t).slice(0, 6)
}
function artImg (t, kind, cls) {
  const img = h('img', { class: cls || '', alt: '', loading: 'lazy' })
  if (!t.imdb) { img.style.display = 'none'; return img }
  img.src = '/v1/' + kind + '/' + t.imdb
  img.onerror = () => {
    if (kind !== 'poster') { img.onerror = () => { img.style.visibility = 'hidden' }; img.src = '/v1/poster/' + t.imdb }
    else img.style.visibility = 'hidden'
  }
  return img
}
function playLabel (t, i, w) {
  const ep = t.kind === 'show' && i.season ? 'S' + i.season + 'E' + String(i.episode).padStart(2, '0') + ' · ' : ''
  return ep + fmtClock(Math.max(0, w.dur - w.at)) + ' left'
}
function renderHero (list) {
  const hero = $('hero')
  const pick = list[0]
  if (!pick) { hero.hidden = true; hero.replaceChildren(); return }
  const { t, i, w, pct } = pick
  hero.hidden = false
  hero.classList.toggle('no-art', !t.imdb)
  const from = sourceName(i.e.source)
  hero.replaceChildren(
    artImg(t, 'backdrop', 'hero-art'),
    h('div', { class: 'hero-scrim' }),
    h('div', { class: 'hero-body' },
      h('span', { class: 'eyebrow' }, 'Continue watching · ' + Math.round(pct * 100) + '%'),
      h('h2', { class: 'hero-title' }, t.title),
      h('div', { class: 'hero-meta' },
        h('span', null, tileLine(t)), h('span', { class: 'dot' }), h('span', null, tileState(t)[0]),
        from ? h('span', { class: 'dot' }) : null, from ? h('span', null, 'From ' + from) : null,
        h('span', { class: 'dot' }), h('span', null, playLabel(t, i, w))),
      h('div', { class: 'hero-progress' },
        h('div', { class: 'bar-track' }, h('div', { style: 'width:' + Math.round(pct * 100) + '%' })),
        h('span', null, Math.round(pct * 100) + '%')),
      h('div', { class: 'hero-actions' },
        h('button', { class: 'btn primary', onclick: () => play(i.e) },
          h('svg', { width: '13', height: '13', viewBox: '0 0 16 16', 'aria-hidden': 'true' }, h('path', { d: 'M4 2.4l9 5.6-9 5.6z', fill: 'currentColor' })),
          'Resume'),
        h('button', { class: 'btn ghost', onclick: () => openDetail(t.key) }, 'Details')))
  )
}
function renderResume (list) {
  // With a single title the hero already carries it; a one-card rail is noise.
  const show = list.length > 1
  $('resumeWrap').hidden = !show
  $('resumeCount').textContent = show ? String(list.length) : ''
  if (!show) { $('resume').replaceChildren(); return }
  $('resume').replaceChildren(...list.map(({ t, i, w, pct }) => h('button', { class: 'r-card', onclick: () => play(i.e) },
    artImg(t, 'backdrop'),
    h('div', { class: 'wash' }),
    h('div', { class: 'r-body' }, h('span', { class: 'r-title' }, t.title), h('span', { class: 'r-meta' }, playLabel(t, i, w))),
    h('div', { class: 'r-track' }, h('div', { style: 'width:' + Math.round(pct * 100) + '%' }))
  )))
}
// Live channels land with the streaming pipeline: this is the slot and the card shape they will fill.
function renderLive () {
  const items = Array.isArray(S.live) ? S.live.slice(0, 6) : []
  $('liveWrap').hidden = !items.length
  $('liveCount').textContent = items.length ? String(items.length) : ''
  if (!items.length) { $('live').replaceChildren(); return }
  $('live').replaceChildren(...items.map(l => h('button', { class: 'r-card live', onclick: () => l.key && openDetail(l.key) },
    l.imdb ? artImg({ imdb: l.imdb }, 'backdrop') : null,
    h('div', { class: 'wash' }),
    h('div', { class: 'r-body' },
      h('span', { class: 'badge live' }, 'LIVE'),
      h('span', { class: 'r-title' }, l.title || 'Live'),
      h('span', { class: 'r-meta' }, (l.channel ? l.channel + ' · ' : '') + (l.viewers != null ? l.viewers + ' watching' : ''))))))
}

let libKind = 'all'
let libShown = 60
let libSignature = ''
const KINDS = [['all', 'All'], ['movie', 'Movies'], ['show', 'Shows'], ['video', 'Videos']]
function renderLibrary (force) {
  renderJobs()
  // The scan is offered only on a relay whose host set an import folder.
  const watching = Boolean(plugin('watch-dir').watching)
  $('folderChip').hidden = !watching
  if (!watching && !$('folderForm').hidden) {
    $('folderForm').hidden = true
    $('folderChip').setAttribute('aria-expanded', 'false')
  }
  // Albums live under Music: the film grid and its posters are the wrong shape for them.
  const tiles = libraryTiles()
  const all = tiles.filter(t => t.kind !== 'album')
  const resume = resumeTiles(all)
  renderHero(resume)
  renderResume(resume)
  renderLive()
  const q = $('libFilter').value.trim().toLowerCase()
  const list = all.filter(t => (libKind === 'all' || t.kind === libKind) && (!q || t.title.toLowerCase().includes(q)))
  // Progress polls arrive every few seconds; redraw only when what the grid shows has changed.
  const signature = [libKind, q, libShown, S.offline, S.loaded, tiles.length - all.length, ...list.slice(0, libShown).map(t => t.key + tileState(t)[0] + t.items.length)].join('|')
  if (!force && signature === libSignature) return
  libSignature = signature
  $('libCount').textContent = all.length ? String(all.length) : ''
  $('libTools').hidden = all.length < 2
  $('libKinds').replaceChildren(...KINDS.map(([k, label]) => {
    const n = k === 'all' ? all.length : all.filter(t => t.kind === k).length
    return n || k === 'all' ? h('button', { class: 'chip', 'aria-pressed': String(libKind === k), onclick: () => { libKind = k; libShown = 60; renderLibrary() } }, label + ' ', h('span', { class: 'count' }, String(n))) : null
  }).filter(Boolean))
  if (!all.length) {
    $('entries').replaceChildren(h('div', { class: 'empty' }, S.offline ? 'Can’t reach the relay.' : !S.loaded && !needsToken ? 'Loading the library…' : tiles.length ? 'No videos yet. Your albums are under Music.' : 'Nothing here yet. Paste a link above to add a video.'))
    return
  }
  if (!list.length) {
    $('entries').replaceChildren(h('div', { class: 'empty' }, q ? 'No titles match “' + q + '”.' : 'Nothing in this view.'))
    return
  }
  $('entries').replaceChildren(...list.slice(0, libShown).map(t => {
    const [state, tone] = tileState(t)
    return h('button', { class: 'tile', 'data-tile': t.key, onclick: () => openDetail(t.key) },
      posterBox(t.imdb ? '/v1/poster/' + t.imdb : null, t.title),
      h('span', { class: 'tile-title' }, t.title),
      h('span', { class: 'tile-meta' }, [tileLine(t), sourceName(t.items[0].e.source)].filter(Boolean).join(' · ')),
      h('span', { class: 'tile-meta' + (tone ? ' ' + tone : '') }, state))
  }), ...(list.length > libShown ? [h('div', { class: 'more', id: 'libMore' }, h('button', { class: 'btn', onclick: showMore }, 'Show more'))] : []))
  const more = $('libMore')
  if (more && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver(entries => { if (entries.some(x => x.isIntersecting)) { io.disconnect(); showMore() } }, { rootMargin: '600px' })
    io.observe(more)
  }
  if ($('detail').open) renderDetail()
}
function showMore () { libShown += 60; renderLibrary() }
$('libFilter').oninput = () => { libShown = 60; renderLibrary() }

// ---- Music: the albums tab. Its own surface, not a filter on the film grid: a shelf per artist, the album sheet
// as the place to listen, and the Soulseek search below it as the way to add more.
let musicSignature = ''
function renderMusic (force) {
  renderSourcesStatus()
  const all = libraryTiles().filter(t => t.kind === 'album')
  const q = $('musicFilter').value.trim().toLowerCase()
  const list = all.filter(t => !q || albumMatches(t, q))
  // The copy count is in it too: removing one copy of a track leaves the rows alone but changes the card's line.
  const signature = [q, S.offline, S.loaded, sourcesOn().join(), ...list.map(t => t.key + tileState(t)[0] + t.items.length + '/' + (t.keys || []).length)].join('|')
  if (!force && signature === musicSignature) return
  musicSignature = signature
  $('musicCount').textContent = all.length ? String(all.length) : ''
  $('musicTools').hidden = all.length < 2
  if (!all.length) {
    $('albums').replaceChildren(h('div', { class: 'empty' }, S.offline ? 'Can’t reach the relay.' : !S.loaded && !needsToken ? 'Loading albums…' : 'No albums yet. Find one below.'))
  } else if (!list.length) {
    // A miss in the library is a reason to look further: one press runs the same words through Find music.
    const words = $('musicFilter').value.trim()
    const on = sourcesOn()
    const look = on.length ? h('div', null, h('button', { class: 'btn', onclick: () => {
      $('srcInput').value = words
      $('srcForm').scrollIntoView({ block: 'start', behavior: 'smooth' })
      $('srcForm').requestSubmit()
    } }, 'Search ' + on.map(sourceLabel).join(' and ') + ' for “' + words + '”')) : null
    $('albums').replaceChildren(h('div', { class: 'empty' }, 'No album, artist or track matches “' + q + '”.', look))
  } else {
    $('albums').replaceChildren(...renderAlbums(list))
    paintRows()
  }
  if ($('detail').open) renderDetail()
}
$('musicFilter').oninput = () => renderMusic()

// ---- Library: search all relays (POST /v1/search/global). Answers that arrive later come with an update event,
// which asks the same query again for 60 s.
let globalAsk = null
function globalBody (val) {
  const tt = val.toLowerCase().match(/^(imdb:)?(tt[0-9]+)$/)
  return tt ? { id: 'imdb:' + tt[2] } : { query: val }
}
async function askGlobal () {
  if (!globalAsk || Date.now() - globalAsk.at > 60000) return
  const r = await api('/v1/search/global', { body: globalAsk.body })
  renderGlobal(r.results || [])
}
function renderGlobal (rows) {
  say('globalMsg', rows.length ? '' : 'No relay has it yet. Answers can take a few seconds.')
  $('globalResults').replaceChildren(...rows.map(row => h('div', { class: 'item' },
    h('div', { class: 'info' },
      h('div', { class: 'name' }, row.title || row.id),
      h('div', { class: 'meta' }, [size(row.size), plural(row.relays, 'relay', 'relays')].filter(Boolean).join(' · '))),
    h('div', { class: 'acts' },
      h('button', { class: 'btn primary', onclick: e => act(e.currentTarget, async () => {
        const r = await api('/v1/open', { body: { uri: row.magnetUrl } })
        refresh()
        play(r.entry, 0)
      }, 'globalMsg') }, 'Play'),
      copyBtn('Copy link', row.magnetUrl)))))
}
$('globalForm').onsubmit = ev => {
  ev.preventDefault()
  const val = $('globalInput').value.trim()
  globalAsk = { body: globalBody(val), at: Date.now() }
  say('globalMsg', 'Asking relays…')
  act($('globalBtn'), askGlobal, 'globalMsg')
}

// ==== Sources: one search over Soulseek and YouTube, browse a peer's folders, save, port and job legibility ====
// POST /v1/search/sources (streamed: each source's part as it finishes), /v1/providers/soulseek/{browse,mirror} and
// /v1/providers/youtube/mirror. Peer paths use backslashes; they are shown with slashes. A Soulseek row is the
// matching files of one peer folder; Browse lists that peer's whole share by folder. A YouTube row is one video.
const slskPath = s => String(s || '').split('\\\\').join('/')
const slskDir = f => slskPath(f).split('/').slice(0, -1).join('/')
const slskLeaf = (path, n) => path.split('/').filter(s => s && !s.startsWith('@@')).slice(-(n || 1)).join(' / ')
const slskKey = (username, dir) => username + '\\n' + dir.toLowerCase()
const slskStarted = new Map()
const ytStarted = new Map()
let slskView = null
function slskRate (bitDepth, sampleRate, bitrate) {
  if (bitDepth && sampleRate) return bitDepth + '-bit/' + (sampleRate / 1000) + ' kHz'
  if (sampleRate) return (sampleRate / 1000) + ' kHz'
  return bitrate ? bitrate + ' kbps' : 'bitrate unknown'
}
const slskMinutes = s => s >= 3600 ? Math.floor(s / 3600) + ' h ' + Math.round(s % 3600 / 60) + ' min' : Math.max(1, Math.round(s / 60)) + ' min'
function slskFolders (files) {
  const groups = new Map()
  for (const f of files) {
    const dir = slskDir(f.filename)
    const key = slskKey(f.username, dir)
    let g = groups.get(key)
    if (!g) groups.set(key, g = { key, username: f.username, dir, title: slskLeaf(dir) || 'Shared files', slots: Boolean(f.slots), queue: Number(f.queue) || 0, files: [], bytes: 0, secs: 0, score: 0, rates: [] })
    g.files.push(f)
    g.bytes += Number(f.size) || 0
    g.secs += Number(f.length) || 0
    g.score = Math.max(g.score, (f.bit_depth || 0) * 1e7 + (f.sample_rate || 0) * 10 + (f.bitrate || 0) / 1000)
    const r = slskRate(f.bit_depth, f.sample_rate, f.bitrate)
    if (!g.rates.includes(r)) g.rates.push(r)
  }
  return [...groups.values()]
}
const slskQuality = g => g.rates.length > 1 ? g.rates[0] + ' (mixed)' : g.rates[0]
// The most common file type of a folder, as a word: "FLAC", "MP3".
function slskFormat (g) {
  const n = new Map()
  for (const f of g.files) {
    const ext = (String(f.filename || '').match(/[.]([a-z0-9]{2,5})$/i) || [])[1]
    if (ext) n.set(ext.toUpperCase(), (n.get(ext.toUpperCase()) || 0) + 1)
  }
  return [...n].sort((a, b) => b[1] - a[1]).map(x => x[0])[0] || ''
}
const LOSSLESS_FORMATS = new Set(['FLAC', 'WAV', 'ALAC', 'AIFF'])

// The button that starts a mirror then follows it ("Queued at 12", "34%", "Saved") across redraws, so the row that
// was pressed answers at once; a failed or cancelled mirror gives the button back.
function slskMirrorBtn (g, pick, label, msgId, name) {
  const b = h('button', { class: 'btn primary', 'data-src-key': 's:' + g.key, 'data-label': label, 'aria-label': name || null, onclick: async () => {
    const files = pick()
    if (!files.length || slskStarted.has(g.key)) return
    // The first mirror of a session signs in first, which can take seconds; the press is answered at once.
    b.textContent = 'Starting'
    const r = await act(b, () => api('/v1/providers/soulseek/mirror', { body: { username: g.username, title: g.title, files: files.map(f => ({ filename: f.filename, size: f.size })) } }), msgId)
    if (!r || !r.job) { b.textContent = b.dataset.label; return }
    slskStarted.set(g.key, { id: r.job.jobId, at: Date.now() })
    if (!S.jobs.some(j => j.jobId === r.job.jobId)) S.jobs.unshift(r.job)
    renderMirrors()
    pollMirrors()
  } }, label)
  srcSyncButton(b)
  return b
}

// ---- Chips: which sources a search asks. The user's "off" choices are kept, so a source that becomes usable later
// (Soulseek after setup) arrives on, and an explicit no sticks across reloads.
const SRC_OFF_KEY = 'peartube.sourcesOff'
function sourcesOff () {
  try { const v = JSON.parse(localStorage.getItem(SRC_OFF_KEY) || '[]'); return Array.isArray(v) ? v : [] } catch { return [] }
}
function setSourceOff (name, off) {
  const set = new Set(sourcesOff())
  if (off) set.add(name)
  else set.delete(name)
  try { localStorage.setItem(SRC_OFF_KEY, JSON.stringify([...set])) } catch {}
}
const SRC_UNAVAILABLE = { soulseek: 'Soulseek needs a relay with its add-on.', youtube: 'YouTube search needs the relay, not this device.' }
// on | off | setup | unavailable, from /v1/plugins and the remembered off-set; null when the relay has no such source.
function sourceState (name) {
  const p = plugin(name)
  if (!p.name) return null
  if (p.status === 'unavailable') return { state: 'unavailable', note: p.message || SRC_UNAVAILABLE[name] }
  if (p.configured === false) return { state: 'setup', note: '' }
  const degraded = p.status === 'degraded'
  const blocked = p.canSave === false
  const note = blocked ? (p.message || 'YouTube is refusing saves from this network. Search still works.')
    : degraded ? (p.message || 'YouTube found nothing lately; its search may be out of date.') : ''
  return { state: sourcesOff().includes(name) ? 'off' : 'on', degraded, blocked, note }
}
const sourcesHere = () => SOURCES.map(s => s[0]).filter(n => sourceState(n))
const sourcesOn = () => sourcesHere().filter(n => sourceState(n).state === 'on')
function openSourceSetup () {
  location.hash = '#settings'
  const until = Date.now() + 3000
  const find = () => {
    const card = document.querySelector('.card[data-group="Sources"]')
    if (card) { card.scrollIntoView({ block: 'start' }); const f = card.querySelector('input'); if (f) f.focus({ preventScroll: true }) } else if (Date.now() < until) setTimeout(find, 100)
  }
  setTimeout(find, 0)
}
function sourceChip (name) {
  const st = sourceState(name)
  const label = sourceLabel(name)
  if (st.state === 'setup') return h('button', { class: 'chip setup', 'data-src': name, 'aria-label': 'Set up ' + label + ' in Settings', onclick: openSourceSetup }, label + ' · ', h('span', { class: 'st' }, 'Set up'))
  if (st.state === 'unavailable') return h('button', { class: 'chip', 'data-src': name, 'aria-disabled': 'true', 'aria-describedby': 'srcNote' }, label + ' · ', h('span', { class: 'st' }, 'Not on this device'))
  const on = st.state === 'on'
  const warn = st.blocked ? 'Saves blocked' : st.degraded ? 'May miss results' : ''
  return h('button', { class: 'chip', 'data-src': name, 'aria-pressed': String(on), 'aria-label': 'Search ' + label + (warn ? ', ' + warn.toLowerCase() : ''), onclick: () => toggleSource(name) },
    on ? '✓ ' : '', warn ? [h('span', { class: 'warn-ic', 'aria-hidden': 'true' }, '⚠'), ' '] : null, label, warn ? [' · ', h('span', { class: 'st' }, warn)] : null)
}
// Turning a source on while results are shown searches it alone for the same words; turning it off drops its group
// at once, and its answer is ignored if it lands later.
function toggleSource (name) {
  const off = sourceState(name).state === 'on'
  setSourceOff(name, off)
  renderSourcesStatus()
  if (!srcRun) return
  if (off) { srcRun.groups.delete(name); renderSrcGroups() } else searchSources(srcRun.query, [name])
}
function renderSourceChips () {
  const here = sourcesHere()
  const box = $('srcChips')
  const focused = box.contains(document.activeElement) ? document.activeElement.dataset.src : ''
  $('srcIn').hidden = here.length < 2
  box.replaceChildren(...here.map(sourceChip))
  if (focused) { const again = box.querySelector('[data-src="' + focused + '"]'); if (again) again.focus() }
  const on = sourcesOn()
  const usable = here.filter(n => ['on', 'off'].includes(sourceState(n).state))
  $('srcHint').textContent = on.length === 2 ? 'Finds albums on peers and tracks on YouTube.'
    : on[0] === 'soulseek' ? 'Finds albums on peers and mirrors them here.'
      : on[0] === 'youtube' ? 'Finds YouTube videos and saves their audio here.'
        : usable.length ? 'Pick a source to search.'
          : here.some(n => sourceState(n).state === 'setup') ? 'Set up a source in Settings to search.' : 'No search source works on this device.'
  const notes = here.map(n => sourceState(n).note).filter(Boolean)
  $('srcNote').hidden = !notes.length
  $('srcNote').replaceChildren(...notes.map(t => h('div', null, t)))
}

// ---- One search, answered per source as each finishes. Groups keep a fixed order (the better-copy source first)
// and fill their slot when their answer lands, so nothing moves under the finger when the slow one arrives. The
// status line says the start, each arrival and failures; the ticking seconds stay out of it.
let srcRun = null // { query, groups: Map(name -> group), ctrls, said }
let srcAsks = 0
let srcTimer = 0
let slskSortBy = 'ready'
async function readEvents (res, on) {
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
    buf += value
    let at
    while ((at = buf.indexOf('\\n\\n')) !== -1) {
      const block = buf.slice(0, at)
      buf = buf.slice(at + 2)
      let event = 'message'
      let data = ''
      for (const line of block.split('\\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data += line.slice(5).trim()
      }
      if (data) on(event, JSON.parse(data))
    }
  }
}
function srcSay (run, line, bad) {
  run.said = line
  say('srcMsg', line, bad)
}
async function searchSources (query, names) {
  if (!names || !srcRun || srcRun.query !== query) {
    if (srcRun) for (const c of srcRun.ctrls) c.abort()
    srcRun = { query, groups: new Map(), ctrls: new Set(), said: '' }
    ytThumbsPrune()
  }
  const run = srcRun
  const list = names || sourcesOn()
  if (!list.length) { say('srcMsg', 'Pick a source to search.', true); renderSrcGroups(); return }
  const ask = ++srcAsks
  for (const n of list) run.groups.set(n, { state: 'pending', started: Date.now(), ask, results: [], truncated: false, error: null })
  renderSrcGroups(list, [run, 'Searching ' + list.map(sourceLabel).join(' and ') + ' for “' + query + '”.'])
  srcTick()
  const ctrl = new AbortController()
  run.ctrls.add(ctrl)
  const land = part => {
    const g = srcRun === run && run.groups.get(part.source)
    if (!g || g.ask !== ask) return
    g.ms = Date.now() - g.started
    g.results = part.results || []
    g.truncated = Boolean(part.truncated)
    g.error = part.error || null
    g.state = g.error ? 'error' : 'done'
    srcRedraw([part.source], [run, srcArrival(part.source, g)])
  }
  try {
    const res = await fetch('/v1/search/sources', { method: 'POST', headers: authHeaders(true), body: JSON.stringify({ query, sources: list, stream: true }), signal: ctrl.signal })
    if (res.status === 401) throw signInFirst()
    if (!res.ok) {
      let data = null
      try { data = await res.json() } catch {}
      throw new Error((data && data.error) || 'The relay answered ' + res.status)
    }
    if ((res.headers.get('content-type') || '').includes('application/json')) {
      const all = await res.json()
      for (const n of all.sources || list) land({ source: n, results: (all.results || []).filter(r => r.source === n), truncated: Boolean(all.truncated && all.truncated[n]), error: (all.errors || []).find(e => e.source === n) })
    } else await readEvents(res, (event, data) => { if (event === 'source') land(data) })
    // A stream cut before a source answered leaves it with an error, not a spinner forever.
    for (const n of list) { const g = run.groups.get(n); if (g && g.ask === ask && g.state === 'pending') land({ source: n, results: [], error: { status: 502, message: 'The relay stopped answering' } }) }
  } catch (err) {
    if (err.name === 'AbortError' || srcRun !== run) return
    for (const n of list) { const g = run.groups.get(n); if (g && g.ask === ask && g.state === 'pending') run.groups.delete(n) }
    srcRedraw(null, [run, err.message, true])
  } finally { run.ctrls.delete(ctrl) }
}
function srcArrival (name, g) {
  const label = sourceLabel(name)
  if (g.error) return label + ' search failed.'
  if (!g.results.length) return label + ' found nothing.'
  if (name === 'youtube') return label + ': ' + plural(g.results.length, 'video', 'videos') + '.'
  return label + ': ' + slskCount(g.results, ', ') + ' from ' + plural(new Set(g.results.map(r => r.username)).size, 'peer', 'peers') + '.'
}
// A folder where one file matched is a track, not an album, so the count names both.
function slskCount (results, sep) {
  const folders = slskFolders(results)
  const one = folders.filter(f => f.files.length === 1).length
  return [folders.length - one ? plural(folders.length - one, 'album', 'albums') : '', one ? plural(one, 'track', 'tracks') : ''].filter(Boolean).join(sep) || plural(0, 'album', 'albums')
}
// One timer for every pending group: it rewrites only the hidden-from-readers seconds in the headers.
function srcTick () {
  if (srcTimer) return
  srcTimer = setInterval(() => {
    const run = srcRun
    let pending = false
    for (const [name, g] of run ? run.groups : []) {
      if (g.state !== 'pending') continue
      pending = true
      const s = document.querySelector('#srcHead-' + name + ' ~ .count [data-secs]')
      if (s) s.textContent = Math.round((Date.now() - g.started) / 1000) + ' s'
    }
    if (!pending) { clearInterval(srcTimer); srcTimer = 0 }
  }, 1000)
}
$('srcForm').onsubmit = ev => {
  ev.preventDefault()
  const query = $('srcInput').value.trim()
  if (!query) return
  try { localStorage.setItem('peartube.srcQuery', query) } catch {}
  searchSources(query)
}
try { $('srcInput').value = localStorage.getItem('peartube.srcQuery') || '' } catch {}

// ---- Groups: one section per source in SOURCES order; only the named ones are redrawn, so a row being pressed in
// one group is not rebuilt when the other answers. An answer that lands while a press is in progress waits for it to
// end, status line included. The slower group sits on top, so its rows would push the faster one's down under the
// pointer or the finger: whatever the reader is on (the row under the mouse, else the first result row on screen,
// else the first heading or line on screen) is measured before anything an answer changes (groups, the YouTube
// note, the summary, the status line, the selection bar) and the page is scrolled by however far it moved. A result
// row, not the heading above it: the YouTube note between them grows when peers answer. A pointer resting on the form
// above the groups keeps the form still instead.
function srcRedraw (only, said) {
  if (!pressing) return renderSrcGroups(only, said)
  srcHeld = srcHeld || { names: new Set(), said: null }
  for (const n of only || SOURCES.map(s => s[0])) srcHeld.names.add(n)
  if (said) srcHeld.said = said
}
function srcFlush () {
  if (pressing || !srcHeld) return
  const held = srcHeld
  srcHeld = null
  renderSrcGroups([...held.names], held.said)
}
function srcAnchor (skip) {
  const box = $('srcGroups')
  const rows = [...box.querySelectorAll('.src-head, .src-note, .msg, .meta, .item')].filter(el => !skip.some(s => s.contains(el)))
  let el = null
  if (srcPointer) {
    const at = document.elementFromPoint(srcPointer[0], srcPointer[1])
    if (at && !box.contains(at) && $('srcForm').contains(at) && (at.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING)) return null
    el = at ? rows.find(r => r.contains(at)) || null : null
  }
  const seen = r => { const b = r.getBoundingClientRect(); return b.height && b.bottom > 0 && b.top < innerHeight }
  if (!el) el = rows.find(r => r.classList.contains('item') && seen(r)) || rows.find(seen) || null
  return el && { el, top: el.getBoundingClientRect().top }
}
// said: [run, line, bad] for the status line, written inside the same measured update as the groups.
function renderSrcGroups (only, said) {
  const run = srcRun
  const names = run ? SOURCES.map(s => s[0]).filter(n => run.groups.has(n)) : []
  const box = $('srcGroups')
  const keep = srcAnchor([...box.children].filter(s => !only || only.includes(s.id.replace('srcGroup-', '')) || !names.includes(s.id.replace('srcGroup-', ''))))
  const secs = names.map(n => {
    let sec = $('srcGroup-' + n)
    const fresh = !sec
    if (fresh) sec = h('section', { class: 'src-group', id: 'srcGroup-' + n, 'aria-labelledby': 'srcHead-' + n })
    if (fresh || !only || only.includes(n)) fillSrcGroup(n, sec)
    return sec
  })
  if (box.children.length !== secs.length || secs.some((s, i) => box.children[i] !== s)) box.replaceChildren(...secs)
  if (said && said[0] === srcRun) srcSay(...said)
  renderYtNote()
  renderSrcSummary()
  renderYtPick()
  if (keep && keep.el.isConnected) {
    const by = keep.el.getBoundingClientRect().top - keep.top
    if (Math.abs(by) >= 1) scrollBy({ top: by, behavior: 'instant' })
  }
}
function renderSrcSummary () {
  const run = srcRun
  const nav = $('srcSummary')
  nav.hidden = !run || sourcesHere().length < 2
  if (nav.hidden) return nav.replaceChildren()
  const parts = sourcesHere().map(n => {
    const g = run.groups.get(n)
    const label = sourceLabel(n)
    // A source with no group was not asked: say why, and lead to the fix when there is one.
    if (!g) {
      const st = sourceState(n).state
      if (st === 'setup') return h('span', null, label + ' not set up: ', h('a', { href: '#settings', onclick: ev => { ev.preventDefault(); openSourceSetup() } }, 'set up in Settings'))
      return h('span', null, label + (st === 'unavailable' ? ' not on this device' : st === 'off' ? ' off' : ' not searched'))
    }
    const what = g.state === 'pending' ? '…' : g.state === 'error' ? 'failed' : n === 'youtube' ? plural(g.results.length, 'video', 'videos') : slskCount(g.results, ', ')
    return h('a', { href: '#srcGroup-' + n, onclick: ev => { ev.preventDefault(); focusSrcHead(n) } }, label + ' ' + what)
  })
  nav.replaceChildren(...parts.flatMap((p, i) => i ? [h('span', { class: 'sep', 'aria-hidden': 'true' }, '·'), p] : [p]))
}
function focusSrcHead (name) {
  const head = $('srcHead-' + name)
  if (!head) return
  head.scrollIntoView({ block: 'start', behavior: 'smooth' })
  head.focus({ preventScroll: true })
}
const SRC_GLYPH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2h8.4A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>'
// The relay's own reason, without repeating the source's name in front of it.
const srcReason = (name, err) => String(err.message || '').replace(new RegExp('^' + sourceLabel(name) + ' search failed: ', 'i'), '')
function fillSrcGroup (name, sec) {
  const g = srcRun.groups.get(name)
  const label = sourceLabel(name)
  const secs = Math.max(1, Math.round((g.ms || 0) / 1000)) + ' s'
  let count
  if (g.state === 'pending') {
    count = [h('span', { class: 'slsk-spin', 'aria-hidden': 'true' }), name === 'youtube' ? 'Searching YouTube… ' : 'Searching peers… ', h('span', { 'data-secs': '', 'aria-hidden': 'true' }, Math.round((Date.now() - g.started) / 1000) + ' s')]
  } else if (g.state === 'done' && g.results.length) {
    count = name === 'youtube' ? plural(g.results.length, 'video', 'videos') + ' · ' + secs
      : [slskCount(g.results, ' · '), plural(new Set(g.results.map(r => r.username)).size, 'peer', 'peers'), secs].join(' · ')
  }
  const head = h('div', { class: 'src-head' },
    h('h3', { id: 'srcHead-' + name, tabindex: '-1' }, label, name === 'youtube' ? h('span', { class: 'tag' }, 'Lossy') : null),
    count ? h('span', { class: 'count' }, count) : null)
  const again = h('button', { class: 'btn quiet', onclick: () => searchSources(srcRun.query, [name]) }, 'Try again')
  const kids = [head]
  if (name === 'youtube') kids.push(h('div', { class: 'src-note', id: 'ytNote' }))
  if (g.state === 'pending') {
    if (name === 'soulseek') kids.push(h('div', { class: 'meta' }, 'Peers answer within a few seconds.'))
  } else if (g.state === 'error') {
    const setup = name === 'soulseek' && g.error.status === 400 && /not configured|not set up/i.test(g.error.message)
    const text = setup ? label + ' is not set up.' : g.error.status === 504 ? label + ' did not answer in ' + secs + '.' : label + ' search failed: ' + srcReason(name, g.error)
    kids.push(h('div', { class: 'msg err', role: 'alert' }, h('span', null, text), setup ? h('button', { class: 'btn', onclick: openSourceSetup }, 'Open Settings') : again))
  } else if (!g.results.length) {
    if (name === 'youtube') {
      kids.push(h('div', { class: 'msg' }, 'No videos found for “' + srcRun.query + '”.' + (sourceState('youtube').degraded ? ' YouTube search may be out of date.' : '')))
    } else {
      kids.push(h('div', { class: 'msg' }, 'No matching albums found in ' + secs + '.'), h('div', { class: 'meta' }, 'Try fewer words, such as the album name.'))
    }
  } else if (name === 'youtube') {
    if (g.truncated) kids.push(h('div', { class: 'meta wrap' }, 'Showing the first ' + g.results.length + ' videos. Add a word to narrow it.'))
    kids.push(h('div', { class: 'list', id: 'ytResults' }, g.results.map(ytRow)))
  } else {
    if (g.truncated) kids.push(h('div', { class: 'meta wrap' }, 'Showing the first results. Add a word to narrow it.'))
    kids.push(...renderSlskResults(g))
  }
  ytThumbsLetGo(sec)
  sec.replaceChildren(...kids)
}

// ---- Soulseek group: one row per peer folder. What the copy is on the first line, whether it will come on the second.
const slskSorts = { quality: (a, b) => b.score - a.score || b.bytes - a.bytes, size: (a, b) => b.bytes - a.bytes }
function renderSlskResults (part) {
  const groups = slskFolders(part.results)
  const sorter = slskSorts[slskSortBy]
  if (sorter) groups.sort(sorter)
  const sort = h('select', { id: 'slskSort', 'aria-label': 'Sort albums', onchange: ev => { slskSortBy = ev.target.value; renderSrcGroups(['soulseek']); $('slskSort').focus() } },
    [['ready', 'Ready to send first'], ['quality', 'Best quality first'], ['size', 'Largest first']].map(([v, t]) => h('option', { value: v, selected: v === slskSortBy }, t)))
  const glyph = () => { const s = h('span', { class: 'src-glyph', 'aria-hidden': 'true' }); s.innerHTML = SRC_GLYPH; return s }
  return [
    h('div', { class: 'slsk-tools', id: 'slskTools' }, sort, h('span', { class: 'hint' }, 'A queue means the peer sends to others first.')),
    h('div', { class: 'list', id: 'slskResults' }, groups.map(g => {
      const lossy = g.files.filter(f => f.lossy === true).length * 2 > g.files.length
      const q = slskQuality(g)
      const what = [[slskFormat(g), q].filter(Boolean).join(String(q).startsWith('bitrate') ? ' · ' : ' '), plural(g.files.length, 'matching track', 'matching tracks'), size(g.bytes), lossy ? 'lossy' : ''].filter(Boolean).join(' · ')
      const ready = g.slots && !g.queue ? 'Ready now · no queue' : (g.slots ? 'Slots open' : 'Slots full') + ' · ' + (g.queue ? 'queue ' + g.queue : 'no queue')
      return h('div', { class: 'item src-row' },
        glyph(),
        h('div', { class: 'info' },
          h('div', { class: 'name' }, g.title),
          h('div', { class: 'meta wrap' }, h('span', { class: 'tag src-tag' }, 'Soulseek'), what),
          h('div', { class: 'meta wrap' }, ready + ' · from ' + g.username)),
        h('div', { class: 'acts' },
          h('button', { class: 'btn', 'aria-label': 'Browse ' + g.username + '’s ' + g.title, onclick: () => openSlskBrowse(g.username, g.dir) }, 'Browse'),
          slskMirrorBtn(g, () => g.files, g.files.length === 1 ? 'Mirror track' : 'Mirror', 'srcMsg', (g.files.length === 1 ? 'Mirror track ' + slskLeaf(slskPath(g.files[0].filename)) : 'Mirror ' + g.title) + ' from ' + g.username)))
    }))]
}
// The FLAC-like format peers offered for this search, if any: the reason to look above before saving a lossy copy.
function peersLossless () {
  const g = srcRun && srcRun.groups.get('soulseek')
  if (!g || g.state !== 'done') return ''
  const n = new Map()
  for (const f of slskFolders(g.results)) { const x = slskFormat(f); if (LOSSLESS_FORMATS.has(x)) n.set(x, (n.get(x) || 0) + 1) }
  return [...n].sort((a, b) => b[1] - a[1]).map(x => x[0])[0] || ''
}
// The YouTube group's advice follows the Soulseek group's state, so a lossy save is a choice made knowing the rest.
function renderYtNote () {
  const box = $('ytNote')
  if (!box) return
  const g = srcRun.groups.get('soulseek')
  const st = sourceState('soulseek')
  const show = h('button', { class: 'btn', onclick: () => focusSrcHead('soulseek') }, 'Show peer copies')
  let text = 'YouTube copies are lossy ' + YT_CODEC + '.'
  let btn = null
  if (st && !g) {
    text = 'Peers not searched. ' + text
    if (st.state === 'setup') btn = h('button', { class: 'btn', onclick: openSourceSetup }, 'Set up Soulseek')
  } else if (g && g.state === 'pending') text = 'Peers are still answering; better copies may appear above.'
  else if (g && g.state === 'error') text = 'Peers could not be searched. ' + text
  // YouTube answers every query with something, so an empty peer group says nothing about these videos matching.
  else if (g && !g.results.length) text = 'No peer copies. Check these videos match; they are lossy.'
  else if (g) {
    const fmt = peersLossless()
    text = fmt ? 'Peers have ' + fmt + ' copies above. These are lossy ' + YT_CODEC + '.' : 'Peers have copies above. Compare before saving.'
    btn = show
  }
  box.replaceChildren(...[h('span', null, text), btn].filter(Boolean))
}

// ---- YouTube rows: the whole row selects the video as a track; Save track saves it alone. The label is the
// promise of what a save gives, so it is fixed, not read from the row. No row links out to YouTube. The tags sit at
// the start of the first meta line, never in the clamped title, so a phone shows them too.
const ytPicked = new Map() // videoId -> { row, query }, in the order picked: that order numbers the tracks
// A video the title calls a full album, or any long one: either saves as one track.
const ytAlbumVideo = r => /\\bfull\\s+album\\b/i.test(r.title)
const ytFull = r => r.length >= 1200 || ytAlbumVideo(r)
function ytRow (r) {
  const n = [...ytPicked.keys()].indexOf(r.videoId) + 1
  const full = ytFull(r)
  const save = h('button', { class: 'btn', 'data-src-key': 'y:' + r.videoId, 'data-label': full ? 'Save as one track' : 'Save track', 'aria-label': 'Save “' + r.title + '” as a track', onclick: ev => openYtSave([r], ev.currentTarget) }, full ? 'Save as one track' : 'Save track')
  srcSyncButton(save)
  return h('div', { class: 'item src-row yt-item', 'data-vid': r.videoId },
    h('label', { class: 'yt-pick-row' },
      h('input', { type: 'checkbox', checked: n > 0, 'aria-label': 'Select “' + r.title + '”', onchange: ev => ytPick(r, ev.target.checked) }),
      ytThumbBox(r),
      h('span', { class: 'info' },
        h('span', { class: 'name' }, r.title),
        h('span', { class: 'meta wrap' }, n ? [h('span', { class: 'tag' }, 'Track ' + n), ' '] : null, full ? [h('span', { class: 'tag' }, ytAlbumVideo(r) ? 'Full album video' : 'Long video'), ' '] : null,
          h('span', { class: 'tag src-tag' }, 'YouTube'), ' ' + YT_CODEC + ' · lossy'),
        // The duration is on the picture already; this line is only for the channel, when the relay knows it.
        r.channel ? h('span', { class: 'meta wrap' }, r.channel) : null)),
    h('div', { class: 'acts' }, save))
}
function ytPick (r, on) {
  if (on) ytPicked.set(r.videoId, { row: r, query: srcRun ? srcRun.query : '' })
  else ytPicked.delete(r.videoId)
  say('srcMsg', plural(ytPicked.size, 'video', 'videos') + ' selected.')
  renderYtRows(r.videoId)
  renderYtPick()
}
// Redraws the YouTube rows in place (track numbers follow the picks) and keeps focus on the same checkbox.
function renderYtRows (focusVid) {
  const list = $('ytResults')
  const g = srcRun && srcRun.groups.get('youtube')
  if (!list || !g) return
  ytThumbsLetGo(list)
  list.replaceChildren(...g.results.map(ytRow))
  const box = focusVid && list.querySelector('[data-vid="' + focusVid + '"] input')
  if (box) box.focus()
}
function renderYtPick () {
  const n = ytPicked.size
  $('ytPick').hidden = !n
  if (!n) return
  const earlier = [...ytPicked.values()].filter(p => !srcRun || p.query !== srcRun.query).length
  $('ytPickText').textContent = n + ' selected' + (earlier ? ' · ' + earlier + ' from an earlier search' : '')
  $('ytPickSave').textContent = n === 1 ? 'Save track' : 'Save ' + n + ' as album'
}
$('ytPickSave').onclick = ev => openYtSave([...ytPicked.values()].map(p => p.row), ev.currentTarget)
$('ytPickClear').onclick = () => {
  ytPicked.clear()
  say('srcMsg', '0 videos selected.')
  renderYtRows()
  renderYtPick()
  $('srcInput').focus()
}

// ---- Thumbnails: fetched from the relay with the token (never from YouTube's image host), lazily, four at a time,
// kept as object URLs per video. Until one lands, or when there is none (204), the row shows a drawn placeholder.
const ytThumbs = new Map() // videoId -> object URL, or null for none
const ytThumbWait = []
let ytThumbBusy = 0
const ytThumbIO = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
  for (const x of entries) if (x.isIntersecting) { ytThumbIO.unobserve(x.target); ytThumbAsk(x.target.dataset.thumb, x.target.dataset.vid) }
}, { rootMargin: '300px' }) : null
function ytThumbBox (r, small) {
  const box = h('div', { class: 'poster thumb yt-thumb' + (small ? ' sm' : ''), 'aria-hidden': 'true', 'data-vid': r.videoId, 'data-thumb': r.thumbnail || '' },
    h('span', { class: 'yt-ph' }), small ? null : h('span', { class: 'yt-dur' }, duration(r.length)))
  const url = ytThumbs.get(r.videoId)
  if (url) box.prepend(h('img', { class: 'sleeve-img', alt: '', src: url }))
  else if (url === undefined && r.thumbnail) { if (ytThumbIO) ytThumbIO.observe(box); else ytThumbAsk(r.thumbnail, r.videoId) }
  return box
}
// Rows about to be redrawn stop being watched, so the observer never holds boxes that left the page.
function ytThumbsLetGo (root) {
  if (ytThumbIO) for (const box of root.querySelectorAll('.yt-thumb')) ytThumbIO.unobserve(box)
}
function ytThumbAsk (path, vid) {
  if (!path || ytThumbs.has(vid) || ytThumbWait.some(w => w[1] === vid)) return
  ytThumbWait.push([path, vid])
  ytThumbPump()
}
function ytThumbPump () {
  while (ytThumbBusy < 4 && ytThumbWait.length) {
    const [path, vid] = ytThumbWait.shift()
    ytThumbBusy++
    fetch(path, { headers: authHeaders() })
      .then(res => res.status === 200 ? res.blob().then(b => URL.createObjectURL(b)) : null)
      .catch(() => null)
      .then(url => {
        ytThumbs.set(vid, url)
        if (url) for (const box of document.querySelectorAll('.yt-thumb[data-vid="' + vid + '"]')) if (!box.querySelector('img')) box.prepend(h('img', { class: 'sleeve-img', alt: '', src: url }))
      })
      .finally(() => { ytThumbBusy--; ytThumbPump() })
  }
}
// A new search lets go of the last one's pictures, except those of picked videos, which the save dialog shows.
function ytThumbsPrune () {
  ytThumbWait.length = 0
  for (const [vid, url] of ytThumbs) {
    if (ytPicked.has(vid)) continue
    if (url) URL.revokeObjectURL(url)
    ytThumbs.delete(vid)
  }
}

// ---- Save dialog: the videos become the tracks of an album the owner names. Suggestions come from the titles and
// are only ever prefilled into fields the owner can change; the relay never guesses them.
let ytSave = null // { tracks: [{ r, title }], opener, done }
// A title is the uploader's, not the album's: brackets about the upload, words trailing it ("Lyrics", "HQ",
// "- Full Album"), decorations (combining underlines, surrounding quotes) all go, so none of it reaches the library.
const YT_BRACKET = /[([][^()[\\]]*\\b(official|video|audio|lyrics?|visuali[sz]er|hd|hq|4k|remaster(ed)?|full\\s+album|black\\s+screen)\\b[^()[\\]]*[)\\]]/gi
const YT_YEAR = /[([]\\s*((19|20)[0-9]{2})\\s*[)\\]]/g
const YT_TAIL = /(\\s*[-–—|~:•]\\s*|\\s+)(full\\s+album|official\\s+(music\\s+)?(video|audio)|lyrics?(\\s+video)?|hd|hq|4k)$/i
// Upload noise wherever it stands, unbracketed too ("Time 1080p BEST QUALITY"): resolutions and frame rates,
// quality boasts, "official video", "lyric video", "full album", remasters. Whole phrases only, so "HDMI", "Lyrical",
// "Official Secrets" or "Remasters" stay.
const YT_NOISE = /\\b(?:(?:best|high|highest|top|super|ultra|max(?:imum)?|great)\\s+(?:sound\\s+|audio\\s+)?quality|(?:hq|hd|hi[- ]?res|4k|8k|uhd|fhd|full\\s+hd|ultra\\s+hd|[0-9]{3,4}p(?:\\s?(?:60|50|30)(?:\\s?fps)?)?|[0-9]{2,3}\\s?fps|[0-9]{3}\\s?kbps)(?:\\s+(?:audio|sound|version|quality))?|official\\s+(?:music\\s+|lyrics?\\s+|hd\\s+|4k\\s+)?(?:video|audio|visuali[sz]er|clip|m\\/v)|official\\s+lyrics?|lyrics?\\s+video|with\\s+lyrics|full\\s+(?:album|ep|lp)|(?:(?:19|20)[0-9]{2}\\s+)?(?:digitally\\s+)?remaster(?:ed)?(?:\\s+(?:19|20)[0-9]{2})?(?:\\s+version)?|m\\/v)\\b/gi
const YT_MARKS = /[\\u0300-\\u036f\\u1ab0-\\u1aff\\u1dc0-\\u1dff\\u20d0-\\u20ff\\ufe20-\\ufe2f]/g
const ytUnquote = s => { const m = s.match(/^["“”„«‹'‘’]\\s*(.+?)\\s*["“”»›'‘’]$/); return m ? m[1] : s }
function ytClean (title) {
  // NFC first, so an accent that has its own letter (é) stays and only decoration left over is dropped.
  let s = String(title || '').normalize('NFC').replace(YT_MARKS, '')
  const year = (s.match(/[([]\\s*((19|20)[0-9]{2})\\s*[)\\]]/) || [])[1] || ''
  s = s.replace(YT_BRACKET, ' ').replace(YT_YEAR, ' ').replace(YT_NOISE, ' ')
  // What the noise leaves behind: empty or padded brackets, doubled or leading separators.
  s = s.replace(/[([]\\s*[)\\]]/g, ' ').replace(/([([])\\s+/g, '$1').replace(/\\s+([)\\]])/g, '$1')
    .replace(/\\s*([-–—|~:•])(?:\\s*[-–—|~:•])+\\s*/g, ' $1 ').replace(/^\\s*[-–—|~:•]+\\s*/, '').replace(/\\s+/g, ' ').trim()
  for (let was = ''; was !== s;) { was = s; s = s.replace(YT_TAIL, '').replace(/\\s*[-–—|~:•]$/, '').trim() }
  return { text: ytUnquote(s), year }
}
const ytCleanTitle = s => ytClean(s).text
const ytSplit = s => { const m = s.match(/^(.+?)\\s+[-–—]\\s+(.+)$/); return m ? [m[1].trim(), ytUnquote(m[2].trim())] : [null, s] }
// The left of " - " is an artist only with evidence: an artist in the library (whose spelling wins), the searched
// words or their initials ("SOAD"), a left side other videos of the search share, or a right side that is what was
// searched for. A left side that is another video's song ("Soldier Side" of "Soldier Side - Intro") is never one.
// Without evidence the field stays empty: better than a wrong one.
const ytTitleCase = s => s === s.toLowerCase() ? s.replace(/(^|\\s)\\S/g, c => c.toUpperCase()) : s
function ytEvidence (queries, pool) {
  const known = new Map()
  for (const q of queries) if (fold(q)) known.set(fold(q), { name: q.trim(), lib: false })
  for (const t of libraryTiles()) if (t.kind === 'album' && fold(t.artist)) known.set(fold(t.artist), { name: t.artist, lib: true })
  const lefts = new Map()
  const rights = new Set()
  for (const r of new Map(pool.map(r => [r.videoId, r])).values()) {
    const [left, right] = ytSplit(ytCleanTitle(r.title))
    if (!left) continue
    lefts.set(fold(left), (lefts.get(fold(left)) || 0) + 1)
    rights.add(fold(right))
  }
  return { known, lefts, rights, queries: queries.map(fold) }
}
function ytArtistOf (left, right, ev) {
  const f = fold(left)
  if (!f) return null
  const hit = ev.known.get(f)
  if (hit && hit.lib) return hit.name
  if (ev.rights.has(f)) return null
  if (hit) return left
  if (ev.queries.some(q => q.startsWith(f + ' '))) return left
  if (!f.includes(' ') && f.length >= 3) {
    for (const [k, v] of ev.known) {
      const words = k.split(' ')
      for (let n = 3; n <= words.length; n++) {
        if (words.slice(0, n).map(w => w[0]).join('') !== f) continue
        if (v.lib) { if (n === words.length) return v.name; continue }
        const lib = ev.known.get(words.slice(0, n).join(' '))
        if (lib && lib.lib) return lib.name
        const typed = v.name.split(/\\s+/)
        if (typed.length === words.length) return ytTitleCase(typed.slice(0, n).join(' '))
      }
    }
  }
  if ((ev.lefts.get(f) || 0) >= 2) return left
  const r = fold(right)
  if (r && ev.queries.some(q => q === r || q.endsWith(' ' + r))) return left
  return null
}
// "System Of A Down Hypnotize", with no separator: an artist at its start when the library has it, or other videos
// of the search put it before their " - " (never one they use as a song name).
function ytPrefix (s, ev) {
  const words = s.split(' ')
  for (let n = words.length - 1; n >= 1; n--) {
    const lead = words.slice(0, n).join(' ')
    const f = fold(lead)
    const hit = ev.known.get(f)
    const rest = ytUnquote(words.slice(n).join(' '))
    if (hit && hit.lib) return [hit.name, rest]
    if (ev.lefts.get(f) && !ev.rights.has(f)) return [lead, rest]
  }
  return null
}
// The album in the library that holds a song of this name, and the name as the library spells it: where one saved
// song belongs. Without a known artist the name must be unique and longer than one word ("Intro" is on many albums).
function ytLibraryTrack (title, artist) {
  const f = fold(title)
  if (!f) return null
  const named = t => t.items.map(i => i.e).find(e => fold(trackName(e)) === f) || t.items.flatMap(i => i.alts).find(e => fold(trackName(e)) === f)
  const hits = libraryTiles().filter(t => t.kind === 'album' && (!artist || fold(t.artist) === fold(artist)) && named(t))
  if (!artist && (hits.length !== 1 || !f.includes(' '))) return null
  const tile = hits.sort((a, b) => allYt(a) - allYt(b))[0]
  return tile ? { tile, name: trackName(named(tile)) } : null
}
function ytSuggest (rows, queries, pool) {
  const ev = ytEvidence(queries, [...rows, ...(pool || [])])
  const known = ev.known
  const clean = rows.map(r => ytClean(r.title))
  const read = clean.map(c => {
    const [left, right] = ytSplit(c.text)
    const a = left && ytArtistOf(left, right, ev)
    if (a) return [a, right]
    if (left) return [null, fold(left) === fold(right) ? right : c.text, true]
    return ytPrefix(c.text, ev) || [null, c.text]
  })
  const count = new Map()
  for (const [a] of read) if (a) count.set(fold(a), (count.get(fold(a)) || 0) + 1)
  const top = [...count].sort((x, y) => y[1] - x[1])[0]
  let artist = top && top[1] * 2 >= rows.length ? read.find(p => p[0] && fold(p[0]) === top[0])[0] : ''
  let titles = read.map((p, i) => p[0] && artist && fold(p[0]) === fold(artist) ? p[1] : p[0] ? clean[i].text : p[1])
  if (!artist) {
    const ch = rows.map(r => r.channel).find(Boolean)
    if (ch) artist = ch.replace(/\\s+-\\s+Topic$/i, '').replace(/(VEVO|\\s+Official)$/i, '').trim()
  }
  let album = ''
  let year = ''
  let hint = ''
  if (rows.length === 1 && ytFull(rows[0])) {
    // One long video is one track named as the album it holds; it is never "a single". Split at " - " with no
    // known artist on either side, which half is the album is a guess, so the field stays empty.
    album = artist || !read[0][2] ? titles[0] : ''
    year = clean[0].year || (rows[0].title.match(/\\b(19|20)[0-9]{2}\\b/) || [''])[0]
  } else if (rows.length === 1) {
    // One song: the album the library already files it under, else its own name, as a single's album usually is.
    const libArtist = artist || ([...known.values()].find(k => k.lib && queries.some(q => fold(q) === fold(k.name) || fold(q).startsWith(fold(k.name) + ' '))) || {}).name || ''
    const lib = ytLibraryTrack(titles[0], libArtist)
    if (lib) {
      artist = lib.tile.artist
      album = lib.tile.album
      titles = [lib.name]
      hint = 'Artist and album match this song in your library. Check them.'
    } else {
      album = titles[0]
      year = clean[0].year
    }
  }
  titles = titles.map(t => t || '')
  if (!hint) {
    const single = rows.length === 1 && !ytFull(rows[0])
    const names = [artist ? 'artist' : '', album && !single ? 'album' : '', year ? 'year' : ''].filter(Boolean)
    const said = names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0] || ''
    const from = said ? said[0].toUpperCase() + said.slice(1) + ' from the video ' + (rows.length > 1 ? 'titles' : 'title') : ''
    hint = single ? (from ? from + '; album is the song name.' : 'Album is the song name, as for a single.')
      : from ? from + '. Check ' + (names.length > 1 ? 'them.' : 'it.') : ''
  }
  return { artist, album, year, titles, hint }
}
function openYtSave (rows, opener) {
  if (!rows.length) return
  const queries = [...new Set(rows.map(r => (ytPicked.get(r.videoId) || {}).query || (srcRun ? srcRun.query : '')).filter(Boolean))]
  const s = ytSuggest(rows, queries, (srcRun && srcRun.groups.get('youtube') || {}).results)
  ytSave = { tracks: rows.map((r, i) => ({ r, title: s.titles[i] })), opener, done: false }
  $('ytArtist').value = s.artist
  $('ytAlbum').value = s.album
  $('ytYear').value = s.year
  $('ytSaveHint').hidden = !s.hint
  $('ytSaveHint').textContent = s.hint
  say('ytSaveMsg', '')
  $('ytSaveLive').textContent = ''
  renderYtSaveTracks()
  ytSaveNotes()
  $('ytSave').showModal()
  // A focused field on a touch screen raises the keyboard over half the form, so the title takes focus there.
  if (matchMedia('(pointer: coarse)').matches) $('ytSaveTitle').focus()
  else $('ytArtist').focus()
}
// Where each track lands. Saved into an album the library already has, a song it holds takes that song's number (the
// copies then share one row) and a new one goes after the album's last track; otherwise the dialog's order. A song
// the album already has from YouTube is a duplicate: left out unless the owner ticks "Save again" on its row.
function ytPlan () {
  const list = ytSave.tracks
  const has = libraryHas($('ytArtist').value.trim(), $('ytAlbum').value.trim())
  const twins = list.map(() => null)
  const dups = list.map(() => false)
  const plan = () => ({ has, nums, twins, dups, send: list.filter((t, k) => !dups[k] || t.again) })
  let nums = list.map((_, i) => i + 1)
  if (!has) return plan()
  const disc = has.items.filter(i => i.season == null || i.season <= 1)
  nums = list.map(() => 0)
  const used = new Set()
  list.forEach((t, k) => {
    const f = fold(t.title.trim() || ytCleanTitle(t.r.title))
    const named = x => [x.e, ...x.alts].some(e => fold(trackName(e)) === f)
    dups[k] = has.items.some(x => named(x) && [x.e, ...x.alts].some(isYt))
    const i = disc.find(named)
    if (i && i.episode >= 1 && i.episode <= 999 && !used.has(i.episode)) { twins[k] = i; nums[k] = i.episode; used.add(i.episode) }
  })
  let last = Math.max(0, ...disc.map(i => i.episode || 0))
  list.forEach((t, k) => {
    if (nums[k]) return
    last++
    while (used.has(last)) last++
    nums[k] = Math.min(last, 999)
    used.add(nums[k])
  })
  return plan()
}
// The numbers beside the titles, each row's duplicate line, the Save button and the line under them follow the plan,
// redrawn in place so typing keeps focus.
function ytNumber (plan) {
  const n = ytSave.tracks.length
  $('ytTracks').querySelectorAll('li > .tn').forEach((s, k) => { s.textContent = String(plan.nums[k]) })
  $('ytTracks').querySelectorAll('li > .yt-dup').forEach((d, k) => { d.hidden = !plan.dups[k] })
  const m = plan.send.length
  $('ytSaveBtn').textContent = n === 1 ? 'Save track' : m === n ? 'Save ' + n + ' as album' : 'Save ' + plural(m, 'track', 'tracks')
  $('ytTracksHint').hidden = n === 1
  $('ytTracksHint').textContent = plan.has ? 'Numbered to fit the album already here.' : 'Numbered in this order on disc 1.'
}
function renderYtSaveTracks (focus) {
  const list = ytSave.tracks
  const n = list.length
  $('ytSaveSub').textContent = plural(n, 'track', 'tracks') + ' · lossy ' + YT_CODEC
  $('ytTracksLegend').textContent = n === 1 ? 'Track' : 'Tracks'
  const icon = (kind, i, text, label, off, fn) => h('button', { class: 'ic-btn', 'data-mv': kind + '-' + i, 'aria-label': label, 'aria-disabled': off ? 'true' : null, onclick: () => { if (!off) fn() } }, text)
  $('ytTracks').replaceChildren(...list.map((t, i) => {
    const name = t.title.trim() || ytCleanTitle(t.r.title)
    return h('li', null,
      h('span', { class: 'tn', 'aria-hidden': 'true' }, String(i + 1)),
      ytThumbBox(t.r, true),
      h('input', { type: 'text', id: 'ytTrack-' + i, value: t.title, required: true, autocomplete: 'off', spellcheck: 'false', placeholder: ytCleanTitle(t.r.title) || 'e.g. So What', 'aria-label': 'Title of track ' + (i + 1), oninput: ev => { t.title = ev.target.value; ytNotesSoon() } }),
      h('span', { class: 'dur' }, duration(t.r.length)),
      // One track has nothing to reorder or leave out, so it gets no buttons to skip past.
      n > 1 ? h('span', { class: 'mv' },
        icon('up', i, '↑', 'Move ' + name + ' up', i === 0, () => ytMove(i, -1, 'up')),
        icon('down', i, '↓', 'Move ' + name + ' down', i === n - 1, () => ytMove(i, 1, 'down')),
        icon('rm', i, '✕', 'Remove ' + name, false, () => ytRemove(i))) : null,
      // Shown by the plan when the album already has this song from YouTube; the tick is the owner's override.
      h('div', { class: 'yt-dup', hidden: true },
        h('span', null, 'Already saved from YouTube; left out.'),
        h('label', null, h('input', { type: 'checkbox', checked: Boolean(t.again), 'aria-label': 'Save ' + name + ' again', onchange: ev => { t.again = ev.target.checked; ytSaveNotes() } }), ' Save again')))
  }))
  ytNumber(ytPlan())
  if (focus) { const b = $('ytTracks').querySelector('[data-mv="' + focus + '"]'); if (b) b.focus() }
}
function ytMove (i, by, kind) {
  const list = ytSave.tracks
  const j = i + by
  ;[list[i], list[j]] = [list[j], list[i]]
  renderYtSaveTracks(kind + '-' + j)
  $('ytSaveLive').textContent = (list[j].title.trim() || 'The track') + ' is now track ' + ytPlan().nums[j] + '.'
}
function ytRemove (i) {
  ytSave.tracks.splice(i, 1)
  renderYtSaveTracks(ytSave.tracks.length > 1 ? 'rm-' + Math.min(i, ytSave.tracks.length - 1) : null)
  if (ytSave.tracks.length === 1) $('ytTrack-0').focus()
  ytSaveNotes()
}
// The album already on the shelf under the same artist and name (the shelf's own grouping), or null.
const libraryHas = (artist, album) => libraryTiles().find(t => t.kind === 'album' && fold(t.artist) === fold(artist) && fold(t.album) === fold(album)) || null
// What the save will do to the library, said before it happens: a song already there, where a new one goes.
function ytSaveNotes () {
  const lines = []
  if (plugin('youtube').canSave === false) lines.push('YouTube is refusing saves from this network right now.')
  const plan = ytPlan()
  ytNumber(plan)
  if (plan.has) {
    const q = commonQuality(plan.has)
    // A song already here from YouTube says so on its own row, unless the owner chose to save it again.
    const twins = ytSave.tracks.map((t, k) => plan.twins[k] && (!plan.dups[k] || t.again) ? [t, plan.twins[k]] : null).filter(Boolean)
    for (const [t, i] of twins.slice(0, 3)) {
      const what = copyQuality(i.e, infoData.get(i.e.key)) || q
      lines.push((t.title.trim() || 'This song') + ' is already track ' + i.episode + ' here' + (what ? ', in ' + what : '') + '. This adds a second copy.')
    }
    if (twins.length > 3) lines.push(plural(twins.length - 3, 'more song is', 'more songs are') + ' already here.')
    const fresh = plan.nums.filter((_, k) => !plan.twins[k])
    if (fresh.length) {
      lines.push('Your library has this album' + (q ? ' (' + q + ')' : '') + '. ' +
        (fresh.length === 1 ? 'This saves as track ' + fresh[0] + '.' : 'These save as tracks ' + Math.min(...fresh) + '–' + Math.max(...fresh) + '.'))
    }
  }
  if (peersLossless()) {
    // The way to those copies, not just their mention: the dialog closes on the peers' heading.
    lines.push(['Peers offered ' + peersLossless() + ' for this search. ', h('button', { class: 'btn', onclick: () => { ytSave.opener = null; $('ytSave').close(); focusSrcHead('soulseek') } }, 'Show peer copies')])
  }
  if (ytSave.tracks.some(t => ytFull(t.r))) lines.push('One long video saves as one track.')
  $('ytSaveNote').hidden = !lines.length
  $('ytSaveNote').replaceChildren(...lines.map(t => h('div', null, t)))
}
let ytNoteTimer = 0
const ytNotesSoon = () => { clearTimeout(ytNoteTimer); ytNoteTimer = setTimeout(() => { if (ytSave && $('ytSave').open) ytSaveNotes() }, 300) }
for (const id of ['ytArtist', 'ytAlbum']) $(id).addEventListener('input', ytNotesSoon)
$('ytSaveForm').onsubmit = async ev => {
  ev.preventDefault()
  const artist = $('ytArtist').value.trim()
  const album = $('ytAlbum').value.trim()
  const year = $('ytYear').value.trim()
  const fail = (id, text) => { say('ytSaveMsg', text, true); $(id).focus() }
  if (!artist) return fail('ytArtist', 'Add the artist, e.g. Miles Davis.')
  if (!album) return fail('ytAlbum', 'Add the album name, e.g. Kind of Blue.')
  if (year && !/^\\d{4}$/.test(year)) return fail('ytYear', 'Year is four digits, e.g. 1959.')
  const empty = ytSave.tracks.findIndex(t => !t.title.trim())
  if (empty !== -1) return fail('ytTrack-' + empty, 'Every track needs a title.')
  const plan = ytPlan()
  if (!plan.send.length) {
    say('ytSaveMsg', ytSave.tracks.length === 1 ? 'This song is already saved from YouTube. Tick Save again to add another copy.' : 'Every song is already saved from YouTube. Tick Save again on one to add it.', true)
    return $('ytTracks').querySelector('.yt-dup input').focus()
  }
  say('ytSaveMsg', '')
  const btn = $('ytSaveBtn')
  const label = btn.textContent
  btn.textContent = 'Saving…'
  // The dialog this save belongs to: Cancel, Close and Esc still work while the relay answers, so by then
  // another save may be on screen, and its selection and form are not this one's to touch.
  const mine = ytSave
  const body = { artist, album, ...(year ? { year } : {}), tracks: plan.send.map(t => ({ videoId: t.r.videoId, title: t.title.trim(), track: plan.nums[mine.tracks.indexOf(t)] })) }
  // A refusal the owner can act on (the album folder holds other files) leads; the relay's words stay as detail.
  let r = null
  btn.disabled = true
  try { r = await api('/v1/providers/youtube/mirror', { body }) } catch (err) { if (ytSave === mine) ytSayFail('ytSaveMsg', err.message); else toast('Could not save “' + album + '”: ' + err.message) } finally { btn.disabled = false }
  btn.textContent = label
  if (!r || !r.job) return
  for (const t of mine.tracks) ytPicked.delete(t.r.videoId)
  for (const t of plan.send) ytStarted.set(t.r.videoId, { id: r.job.jobId, at: Date.now() })
  mine.done = true
  if (ytSave === mine) $('ytSave').close()
  if (!S.jobs.some(j => j.jobId === r.job.jobId)) S.jobs.unshift(r.job)
  renderMirrors()
  renderYtRows()
  renderYtPick()
  pollMirrors()
  toast('Saving “' + (body.tracks.length === 1 ? body.tracks[0].title : album) + '” from YouTube')
  const name = document.querySelector('[data-job="' + r.job.jobId + '"] .name')
  if (name) name.focus()
}
const ytSaveCancel = () => $('ytSave').close()
$('ytSaveCancel').onclick = ytSaveCancel
$('ytSaveClose').onclick = ytSaveCancel
// Esc, Cancel and Close give focus back to the control that opened the dialog (or its redrawn twin).
$('ytSave').addEventListener('close', () => {
  if (!ytSave || ytSave.done) return
  const o = ytSave.opener
  const twin = o && !o.isConnected && o.dataset.srcKey ? document.querySelector('[data-src-key="' + o.dataset.srcKey + '"]') : null
  const back = o && o.isConnected ? o : twin
  if (back) back.focus()
})

// Browse: the relay caches a peer's list for a few minutes, so reopening is instant; the first fetch can take
// seconds (up to 30), so it shows a ticking spinner, and a peer that does not answer is said plainly.
async function openSlskBrowse (username, focusDir, again) {
  const view = { username, focus: focusDir || '', data: null, error: '', filter: '', open: new Set(), off: new Map(), shown: 40, started: Date.now() }
  if (focusDir) view.open.add(slskKey(username, focusDir))
  slskView = view
  renderSlskBrowse()
  $('slskBrowse').scrollIntoView({ block: 'start', behavior: 'smooth' })
  const timer = setInterval(() => {
    const t = $('slskWaitText')
    if (t && slskView === view) t.textContent = slskWaitText(view)
  }, 1000)
  try {
    view.data = await api('/v1/providers/soulseek/browse', { body: { username, refresh: Boolean(again) } })
    view.folders = slskFolders(view.data.files || [])
    const focus = slskKey(username, view.focus)
    view.folders.sort((a, b) => (b.key === focus) - (a.key === focus) || (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0))
  } catch (err) {
    view.error = err.message
  } finally { clearInterval(timer) }
  if (slskView === view) renderSlskBrowse()
}
const slskWaitText = v => 'Asking ' + v.username + ' for their shared files… ' + Math.round((Date.now() - v.started) / 1000) + ' s'
function renderSlskBrowse () {
  const box = $('slskBrowse')
  const v = slskView
  box.hidden = !v
  if (!v) return box.replaceChildren()
  const d = v.data
  const summary = d
    ? [plural(v.folders.length, 'folder', 'folders'), plural(d.tracks, 'track', 'tracks'), size(d.size), d.cached ? 'saved list' : 'just fetched'].join(' · ')
    : v.error ? 'Could not list files' : 'Loading'
  const head = h('div', { class: 'slsk-head' },
    h('div', { class: 'grow' }, h('h3', null, v.username), h('div', { class: 'meta' }, summary)),
    h('button', { class: 'btn quiet', disabled: !d && !v.error, onclick: () => openSlskBrowse(v.username, v.focus, true) }, 'Refresh'),
    h('button', { class: 'btn quiet', onclick: () => { slskView = null; renderSlskBrowse() } }, 'Close'))
  if (!d && !v.error) {
    return box.replaceChildren(head, h('div', { class: 'slsk-wait', role: 'status' }, h('span', { class: 'slsk-spin', 'aria-hidden': 'true' }), h('span', { id: 'slskWaitText' }, slskWaitText(v))))
  }
  if (v.error) return box.replaceChildren(head, h('div', { class: 'msg err', role: 'alert' }, v.error))
  if (!d.files.length) return box.replaceChildren(head, h('div', { class: 'msg' }, v.username + ' shares no music files, or hides them from browsing.'))
  box.replaceChildren(head,
    h('input', { type: 'search', id: 'slskFilter', spellcheck: 'false', placeholder: 'Blue Train', 'aria-label': 'Filter folders', oninput: ev => { v.filter = ev.target.value; v.shown = 40; renderSlskFolders() } }),
    h('div', { class: 'msg', id: 'slskBrowseMsg', role: 'status' }),
    h('div', { class: 'list', id: 'slskFolders' }))
  renderSlskFolders()
}
function renderSlskFolders () {
  const v = slskView
  const q = v.filter.trim().toLowerCase()
  const list = v.folders.filter(g => !q || g.dir.toLowerCase().includes(q))
  const items = list.slice(0, v.shown).map(slskFolderItem)
  if (list.length > v.shown) items.push(h('button', { class: 'btn quiet', onclick: () => { v.shown += 40; renderSlskFolders() } }, 'Show ' + Math.min(40, list.length - v.shown) + ' more folders'))
  if (!list.length) items.push(h('div', { class: 'meta' }, 'No folder matches “' + v.filter.trim() + '”.'))
  $('slskFolders').replaceChildren(...items)
}
function slskFolderItem (g) {
  const v = slskView
  const off = v.off.get(g.key) || new Set()
  v.off.set(g.key, off)
  const open = v.open.has(g.key)
  const picked = () => g.files.filter(f => !off.has(f.filename))
  const label = () => {
    const n = picked().length
    return n === g.files.length ? 'Mirror folder' : n ? 'Mirror ' + plural(n, 'track', 'tracks') : 'None selected'
  }
  const mirror = slskMirrorBtn(g, picked, label(), 'slskBrowseMsg')
  // Nothing picked keeps the button off, also when a finished mirror gives it back.
  mirror.toggleAttribute('data-none', !picked().length)
  if (!picked().length) mirror.disabled = true
  const where = slskLeaf(g.dir, 2)
  const facts = [plural(g.files.length, 'track', 'tracks'), slskQuality(g), size(g.bytes), g.secs ? slskMinutes(g.secs) : ''].filter(Boolean).join(' · ')
  const toggle = h('button', { class: 'btn quiet', 'aria-expanded': String(open), onclick: () => { if (open) v.open.delete(g.key); else v.open.add(g.key); renderSlskFolders() } }, open ? 'Hide files' : 'Files')
  // Each file can be mirrored on its own: it lands in its album's folder as a track of that album (the relay reads
  // its tags, else this folder's name, and says so on the job), and is followed live like a folder mirror.
  const one = f => {
    const b = slskMirrorBtn({ key: slskKey(g.username, f.filename), username: g.username, title: '', files: [f] }, () => [f], 'Mirror track', 'slskBrowseMsg')
    b.className = 'btn quiet slsk-one'
    b.setAttribute('aria-label', 'Mirror track ' + slskLeaf(slskPath(f.filename)))
    return b
  }
  const files = open
    ? h('div', { class: 'slsk-files' }, ...g.files.map(f => h('div', { class: 'slsk-file' },
        h('label', null,
          h('input', { type: 'checkbox', checked: !off.has(f.filename), onchange: ev => {
            if (ev.target.checked) off.delete(f.filename)
            else off.add(f.filename)
            mirror.toggleAttribute('data-none', !picked().length)
            mirror.dataset.label = label()
            if (slskStarted.has(g.key)) return
            mirror.textContent = mirror.dataset.label
            mirror.disabled = !picked().length
          } }),
          h('span', { class: 'grow' }, slskLeaf(slskPath(f.filename)))),
        h('span', { class: 'meta' }, [slskRate(f.bit_depth, f.sample_rate, f.bitrate), duration(f.length), size(f.size)].filter(Boolean).join(' · ')),
        one(f))))
    : null
  return h('div', { class: 'item slsk-folder' + (slskKey(v.username, v.focus) === g.key ? ' focus' : '') },
    h('div', { class: 'slsk-row' },
      h('div', { class: 'info' }, h('div', { class: 'name' }, g.title), h('div', { class: 'meta' }, where !== g.title ? where + ' · ' + facts : facts)),
      h('div', { class: 'acts' }, toggle, mirror)),
    files)
}

// ---- Progress: one card per album being added from a source, redrawn every second from /v1/jobs while any is
// active. A queue place is the peer saying yes, later, so it reads as a place in line, never as a stall; only a minute
// of silence with no place is a warning. A YouTube save has no size until it is done, so it counts tracks, never a
// percentage. A failure shows the relay's own reason, plus the port fix when this session has evidence peers cannot
// reach the relay (inbound failures and no transfer yet), or a plain line for YouTube's known refusals.
function srcActive (j) { return SOURCE_NAMES.has(j.plugin) && MIRROR_ACTIVE.has(j.status) }
const slskFor = ms => ms < 90_000 ? Math.round(ms / 1000) + ' s' : Math.round(ms / 60_000) + ' min'
const slskPct = j => j.total ? Math.min(j.status === 'done' ? 100 : 99, Math.floor((j.bytes || 0) / j.total * 100)) : null
// What a job is doing: a sentence for its card and a word or two for the button that started it.
const jobState = j => j.plugin === 'youtube' ? ytJobState(j) : slskJobState(j)
function ytJobState (j) {
  const n = j.fileCount || 1
  const skipped = (j.skipped || []).length
  if (j.status === 'done' && skipped) return { tone: 'warn', text: 'Saved ' + (n - skipped) + ' of ' + plural(n, 'track', 'tracks'), short: 'Saved ' + (n - skipped) + ' of ' + n }
  if (j.status === 'done') return { tone: 'ok', text: 'Saved · ' + plural(n, 'track', 'tracks') + ' · ' + size(j.size || j.bytes || 0), what: YT_LABEL, short: 'Saved' }
  if (j.status === 'failed') return { tone: 'bad', text: 'Failed', short: 'Failed' }
  if (j.status === 'cancelled') return { tone: '', text: 'Cancelled', short: 'Cancelled' }
  if (j.status === 'announcing') return { tone: '', text: 'Adding to your library', short: 'Adding' }
  if (j.status === 'transferring') return n > 1 ? { tone: '', text: 'Downloading track ' + j.fileIndex + ' of ' + n + ' from YouTube', short: 'Track ' + j.fileIndex + ' of ' + n } : { tone: '', text: 'Downloading from YouTube', short: 'Saving' }
  return { tone: '', text: 'Waiting to start', short: 'Waiting' }
}
function slskJobState (j) {
  const pct = slskPct(j)
  if (j.status === 'done') return { tone: 'ok', text: 'Saved · ' + plural(j.fileCount || 1, 'track', 'tracks') + ' · ' + size(j.size || j.bytes || 0), short: 'Saved' }
  if (j.status === 'failed') return { tone: 'bad', text: 'Failed', short: 'Failed' }
  if (j.status === 'cancelled') return { tone: '', text: 'Cancelled', short: 'Cancelled' }
  if (j.status === 'announcing') return { tone: '', text: 'Adding to your library', short: 'Adding' }
  if (j.status === 'transferring') return { tone: '', text: 'Downloading from ' + j.peer + (pct != null ? ' · ' + pct + '%' : ''), short: pct != null ? pct + '%' : 'Downloading' }
  if (j.phase === 'connecting') return { tone: '', text: 'Connecting to ' + j.peer, short: 'Connecting' }
  if (j.queuePlace > 0) return { tone: '', text: 'Queued at ' + j.queuePlace + ' on ' + j.peer, short: 'Queued at ' + j.queuePlace }
  if (j.queuePlace === 0) return { tone: '', text: 'Next in line on ' + j.peer, short: 'Next in line' }
  if (j.idleMs > 60_000) return { tone: 'warn', text: 'No answer from ' + j.peer + ' for ' + slskFor(j.idleMs), short: 'No answer' }
  return { tone: '', text: 'Asking ' + j.peer + ' to send', short: 'Asking' }
}
// The amount line: bytes of the whole album, the speed while bytes move, and how long nothing has changed.
function slskAmount (j) {
  const got = j.total ? size(j.bytes || 0) + ' of ' + size(j.total) : j.bytes ? size(j.bytes) + ' so far' : ''
  const quiet = j.idleMs > 15_000 ? slskFor(j.idleMs) : ''
  const note = j.status === 'transferring' ? (quiet ? 'no data for ' + quiet : j.speed > 0 ? rate(j.speed) : '')
    : j.phase === 'connecting' ? 'waiting for it to reach port ' + j.listenPort
      : j.queuePlace != null && quiet ? 'waiting ' + quiet : ''
  return [got, note].filter(Boolean).join(' · ')
}
const slskPortFix = n => ['Publish port ' + n + ' (', h('code', null, '-p ' + n + ':' + n), ') and forward it on your router.']
// The album a finished job added: by the files it saved, else (YouTube) by the release it was pinned to.
const jobAlbumEntry = j => (j.sha256s && j.sha256s.length ? S.entries.find(e => j.sha256s.includes(e.sha256)) : null) ||
  (j.plugin === 'youtube' && j.id ? S.entries.find(e => e.seriesKey === j.id) : null) || null
// Progress a reader can trust: bytes of a known total (Soulseek), else tracks done of tracks asked (YouTube).
function jobProgress (j) {
  if (j.plugin !== 'youtube') {
    return h('div', { class: 'bar-track' + (j.status === 'transferring' || j.status === 'announcing' ? '' : ' wait') }, h('div', { style: 'width:' + (j.status === 'announcing' ? 100 : slskPct(j) || 0) + '%' }))
  }
  const n = j.fileCount || 1
  const doneN = j.status === 'announcing' ? n : j.status === 'transferring' ? (j.fileIndex || 1) - 1 : 0
  const text = plural(doneN, 'track', 'tracks') + ' of ' + n + ' saved'
  if (n === 1) {
    return j.status === 'announcing'
      ? h('div', { class: 'bar-track', role: 'progressbar', 'aria-valuetext': 'Adding' }, h('div', { style: 'width:100%' }))
      : h('div', { class: 'bar-track indef' + (j.status === 'queued' ? ' wait' : ''), role: 'progressbar', 'aria-valuetext': j.status === 'queued' ? 'Waiting' : 'Downloading' }, h('div'))
  }
  const aria = { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(n), 'aria-valuenow': String(doneN), 'aria-valuetext': text }
  if (n > 30) return h('div', { class: 'bar-track', ...aria }, h('div', { style: 'width:' + Math.round(doneN / n * 100) + '%' }))
  return h('div', { class: 'bar-steps', ...aria }, Array.from({ length: n }, (_, i) => h('i', { class: i < doneN ? 'done' : i === doneN && j.status === 'transferring' ? 'now' : '' })))
}
// What went wrong, as a sentence the owner can act on, from YouTube's or the relay's own words (kept as detail).
// Whole words and phrases only: "age" inside "storage" or "webpage" is no age gate. The order matters: YouTube says
// "Video unavailable" before a country block too.
const YT_FAIL_HINTS = [
  [/refusing downloads|\\bbot check\\b|not a bot/i, 'YouTube blocks saves from this relay’s network. Try later, or from another network.'],
  [/\\bcountry\\b|not available in your|geo[- ]?restrict/i, 'This video is blocked where the relay is. Pick another upload.'],
  [/confirm your age|\\bage[- ](restricted|gated?)\\b|inappropriate for some users/i, 'This video is age-restricted, which needs an account. Pick another upload.'],
  [/\\bprivate video\\b|\\bvideo is private\\b|\\bmembers[- ]only\\b|join this channel|\\bremoved\\b|no longer available|video unavailable|\\bterminated\\b|does not exist/i, 'This video is private or was removed. Pick another upload.'],
  [/already holds/i, 'The album folder already holds other files. Change the album name or year.'],
  [/\\bstalled\\b|timed out|\\btimeout\\b|ETIMEDOUT/i, 'YouTube stopped sending. Try again.']
]
const ytFailHint = error => ((YT_FAIL_HINTS.find(([re]) => re.test(String(error || ''))) || [])[1]) || ''
// The provider's or relay's own words, one press away under the sentence.
const ytWhy = (lines, fk) => h('details', { class: 'meta why' }, h('summary', { 'data-fk': fk || null }, 'Details'), lines.map(t => h('div', { class: 'wrap' }, t)))
function ytSayFail (id, error) {
  const hint = ytFailHint(error)
  say(id, hint || error, true)
  if (hint) $(id).append(ytWhy([error]))
}
// The song a one-track save is of, from its file name ("04 - Revenga.m4a"): such a card names the song, not just
// the album it went into.
const ytJobSong = j => j.plugin === 'youtube' && j.fileCount === 1 && j.file ? j.file.replace(/^[0-9]+ - /, '').replace(/[.][a-z0-9]{2,4}$/i, '') : ''
function srcJobItem (j) {
  const yt = j.plugin === 'youtube'
  const st = jobState(j)
  const active = MIRROR_ACTIVE.has(j.status)
  const p = plugin('soulseek')
  const unreachable = !yt && p.inboundFailures > 0 && p.transfersOk === 0
  const album = j.status === 'done' ? jobAlbumEntry(j) : null
  const song = ytJobSong(j)
  const track = yt ? (song ? '' : j.file || '') : [j.fileCount > 1 ? 'Track ' + j.fileIndex + ' of ' + j.fileCount : '', j.file].filter(Boolean).join(' · ')
  const skipped = yt && j.status === 'done' ? j.skipped || [] : []
  const hinted = skipped.filter(s => ytFailHint(s.error))
  const failHint = j.status === 'failed' && yt ? ytFailHint(j.error) : ''
  const btn = (label, fn) => h('button', { class: 'btn' + (label === 'Open album' ? '' : ' quiet'), 'data-fk': j.jobId + ':' + label, onclick: fn }, label)
  return h('div', { class: 'item job src-job', 'data-job': j.jobId, 'data-status': j.status },
    h('div', { class: 'info' },
      h('div', { class: 'name', tabindex: '-1' }, song ? song + ' — ' + j.title : j.title || 'Album'),
      h('div', { class: 'slsk-state' + (st.tone ? ' ' + st.tone : '') }, st.text, st.what ? h('span', { class: 'what' }, ' · ' + st.what) : null),
      active && track ? h('div', { class: 'meta wrap' }, track) : null,
      active && slskAmount(j) ? h('div', { class: 'meta slsk-amount' }, slskAmount(j)) : null,
      active ? jobProgress(j) : null,
      skipped.map(s => h('div', { class: 'meta wrap' }, 'Not saved: ' + s.title + (ytFailHint(s.error) ? '. ' + ytFailHint(s.error) : s.error ? ' (' + s.error + ')' : ''))),
      hinted.length ? ytWhy(hinted.map(s => s.title + ': ' + s.error), j.jobId + ':why') : null,
      j.status === 'done' && j.note && !skipped.length ? h('div', { class: 'meta wrap' }, j.note) : null,
      j.status === 'failed' && j.error ? h('div', { class: 'meta err wrap slsk-error' }, failHint || j.error) : null,
      failHint ? ytWhy([j.error], j.jobId + ':why') : null,
      j.status === 'failed' && unreachable ? h('div', { class: 'meta wrap slsk-fix' }, ...slskPortFix(p.listenPort || p.listenPortSetting || j.listenPort)) : null),
    h('div', { class: 'acts' },
      album ? btn('Open album', () => { const t = tileOf(album); if (t) openDetail(t.key) }) : null,
      btn(active ? 'Cancel' : 'Dismiss', e => act(e.currentTarget, async () => { await api('/v1/jobs/' + j.jobId, { method: 'DELETE' }); refresh() }))))
}
// A button that started a job follows it; "s:" keys are Soulseek folders, "y:" keys YouTube videos. A job that
// failed, was cancelled, or left the list (dismissed, or trimmed by the relay) gives the button back.
function srcSyncButton (b) {
  const key = b.dataset.srcKey
  const started = key.startsWith('y:') ? ytStarted : slskStarted
  const was = started.get(key.slice(2))
  if (!was) return
  const j = S.jobs.find(x => x.jobId === was.id)
  if (j ? j.status === 'failed' || j.status === 'cancelled' : S.jobsAsked > was.at) {
    started.delete(key.slice(2))
    b.textContent = b.dataset.label
    b.disabled = b.hasAttribute('data-none')
    return
  }
  b.textContent = j ? jobState(j).short : key.startsWith('y:') ? 'Waiting' : 'Mirroring'
  b.disabled = true
}
function renderSrcJobs () {
  const box = $('srcJobs')
  // Focus survives the once-a-second redraw: a card's button, or the name a new save moved focus to.
  const at = box.contains(document.activeElement) ? document.activeElement : null
  const fk = at ? at.dataset.fk || (at.classList.contains('name') ? 'name:' + at.closest('[data-job]').dataset.job : '') : ''
  const recent = Date.now() - 3600_000
  const jobs = S.jobs.filter(j => SOURCE_NAMES.has(j.plugin) && (j.status !== 'done' || j.created > recent))
    .sort((a, b) => MIRROR_ACTIVE.has(b.status) - MIRROR_ACTIVE.has(a.status) || b.created - a.created).slice(0, 5)
  box.hidden = !jobs.length
  // Opened details stay open too.
  const opened = new Set([...box.querySelectorAll('details[open]')].map(d => d.closest('[data-job]').dataset.job))
  box.replaceChildren(...jobs.map(srcJobItem))
  for (const d of box.querySelectorAll('details')) d.open = opened.has(d.closest('[data-job]').dataset.job)
  const again = fk && (fk.startsWith('name:') ? box.querySelector('[data-job="' + fk.slice(5) + '"] .name') : [...box.querySelectorAll('[data-fk]')].find(b => b.dataset.fk === fk))
  if (again) again.focus()
  for (const b of document.querySelectorAll('button[data-src-key]')) srcSyncButton(b)
}
function renderMirrors () {
  renderPills()
  if (tab === 'music') renderSourcesStatus()
}
// Cheap and independent of the full refresh, which holds still while a film plays. When the last mirror ends, one
// full refresh loads the new album's tracks so its card can open it.
let slskPolling = false
async function pollMirrors () {
  if (slskPolling) return
  slskPolling = true
  let failed = false
  try {
    while (S.jobs.some(srcActive)) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      const asked = Date.now()
      try { S.jobs = (await api('/v1/jobs')).jobs || []; S.jobsAsked = asked } catch { failed = true; break }
      noticeJobs(false)
      if (!pressing) renderMirrors()
    }
  } finally { slskPolling = false }
  if (!failed) refresh()
}

// The port peers send files to. The relay cannot test its own public port, so the strong warning waits for evidence:
// a peer that could not reach it, or a mirror that has waited a minute with no answer at all.
function slskPortNote (p) {
  if (!p.configured || p.status === 'unavailable' || p.listenPortSetting == null) return null
  const port = p.listenPort == null ? p.listenPortSetting : p.listenPort
  const fix = n => [' Publish it (', h('code', null, '-p ' + n + ':' + n), ') and forward it on your router.']
  if (p.listenPortSetting === 0) return { alert: true, kids: ['Soulseek picks a new port each start' + (port ? ' (now ' + port + ')' : '') + ', which cannot be published, so peers cannot send you files. Set a Listen port in Settings.'] }
  if (port === 0) return { alert: true, kids: ['Soulseek could not open port ' + p.listenPortSetting + ' on this relay. Pick a free Listen port in Settings.'] }
  const stalled = S.jobs.some(j => j.plugin === 'soulseek' && j.status === 'queued' && !j.bytes && j.queuePlace == null && j.idleMs > 60_000)
  if ((p.inboundFailures && !p.transfersOk) || stalled) {
    return { alert: true, kids: ['Peers cannot reach this relay, so downloads never start. Soulseek listens on port ' + port + '.', ...fix(port)] }
  }
  return { alert: false, kids: ['Peers send files to this relay on port ' + port + '; keep it reachable.'] }
}
function renderSourcesStatus () {
  renderSourceChips()
  const note = slskPortNote(plugin('soulseek'))
  $('slskPort').hidden = !note
  $('slskPort').classList.toggle('alert', Boolean(note && note.alert))
  $('slskPort').replaceChildren(...(note ? note.kids : []))
  renderSrcJobs()
}
// ==== end Sources ====

// ---- Library: details sheet (play, cast, copy; a show's episodes by season)
let detailKey = null
let detailSeason = null
function openDetail (key, season = null) {
  detailKey = key
  detailSeason = season
  renderDetail()
  if (!$('detail').open) $('detail').showModal()
  if (!infoTimer) infoTimer = setInterval(pollInfo, 3000)
}
function castButton (e) {
  const tvs = (S.cast && S.cast.receivers) || []
  if (!tvs.length) return null
  const wrap = h('span', { class: 'wrap-rel' })
  wrap.append(h('button', { class: 'btn', 'aria-haspopup': 'menu', onclick: () => {
    if (wrap.querySelector('.menu')) return wrap.querySelector('.menu').remove()
    wrap.append(h('div', { class: 'menu', role: 'menu' }, tvs.map(tv => h('button', { class: 'btn', role: 'menuitem', onclick: ev => act(ev.currentTarget, async () => {
      await api('/v1/cast/play', { body: { receiverId: tv.id, key: e.key } })
      wrap.querySelector('.menu')?.remove()
      toast('Playing on ' + tv.name)
      loadCast()
    }) }, tv.name))))
  } }, 'Cast'))
  return wrap
}
const resumeAtFor = e => {
  const w = watchStore[watchId(e)]
  return w && w.dur > 0 && w.at / w.dur < 0.95 ? w.at : 0
}
function play (e, at) {
  $('detail').close()
  openPlayer(e, at == null ? resumeAtFor(e) : at)
}
function downloadHref (e, nameOverride) {
  if (!e || !e.streamUrl) return ''
  const base = resolveStreamUrl(e.streamUrl)
  const name = nameOverride || e.title || e.id || 'video'
  return base + (base.includes('?') ? '&' : '?') + 'download=' + encodeURIComponent(name)
}
function downloadBtn (e, quiet, nameOverride) {
  if (!e || !e.streamUrl) return null
  return h('a', { class: 'btn' + (quiet ? ' quiet' : ''), 'data-download': true, href: downloadHref(e, nameOverride), download: '' }, 'Download')
}
// ---- Delete (DeleteAndSingleMirror)
// Two presses: the first arms the button ("Confirm", and what goes said beside it) for 5 s, the second deletes. The
// owner only, and only this channel's entries: another channel's are its owner's to remove. The toast says whether
// the file left the disk too (a mirrored file does; one in the import folder stays).
const ownEntry = e => Boolean(S.settings && e && e.source === S.status.channel)
const ICON_TRASH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 11v6M14 11v6M9 7l1-3h4l1 3M7 7l1 13h8l1-13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
function removedText (r) {
  const gone = (r && r.removed) || []
  if (!gone.length) return (r && r.notRemoved && r.notRemoved[0] && r.notRemoved[0].reason) || 'Nothing was removed'
  const what = gone.length > 1 ? plural(gone.length, 'track', 'tracks') + ' removed' : 'Removed'
  if (gone.some(x => x.file === 'kept')) return what + ' from the library. Files in the import folder stay.'
  return what + (gone.some(x => x.file === 'deleted') ? ' and deleted from disk' : ' from the library')
}
async function removeEntries (body, after) {
  const r = await api('/v1/entries/remove', { body })
  toast(removedText(r))
  if (after) after()
  await refresh()
}
function armDelete (b, idle, ask, run) {
  let timer = 0
  const reset = () => {
    clearTimeout(timer)
    timer = 0
    b.classList.remove('armed')
    idle()
    if (ask) ask.hidden = true
  }
  b.onclick = ev => {
    ev.stopPropagation()
    if (!timer) {
      b.classList.add('armed')
      b.textContent = 'Confirm'
      if (ask) ask.hidden = false
      timer = setTimeout(reset, 5000)
      return
    }
    reset()
    act(b, run)
  }
  idle()
  return b
}
function deleteBtn (e, quiet) {
  if (!ownEntry(e)) return null
  const b = h('button', { class: 'btn' + (quiet ? ' quiet' : '') })
  return armDelete(b, () => { b.textContent = 'Delete' }, null, () => removeEntries({ key: e.key }))
}
// A row that holds a YouTube copy beside another one: its trash says which copy it removes (the one that plays), and
// the YouTube copy gets a control of its own, so the lossy copy can go without the better one.
const trackMixed = i => (i.alts || []).some(a => isYt(a) !== isYt(i.e))
function trackDeleteLabel (i) {
  const e = i.e
  if (!trackMixed(i)) return ['Delete', 'Delete ' + trackName(e)]
  const word = isYt(e) ? 'YouTube' : (shortQuality(infoData.get(e.key)) || '').split(' ')[0]
  return word ? ['Delete ' + word + ' copy', 'Delete ' + word + ' copy of ' + trackName(e)] : ['Delete the copy that plays', 'Delete the copy of ' + trackName(e) + ' that plays']
}
function trackDeleteBtn (i) {
  const e = i.e
  if (!ownEntry(e)) return null
  const [title, label] = trackDeleteLabel(i)
  const b = h('button', { class: 'track-del', 'data-del': e.key, title, 'aria-label': label })
  return armDelete(b, () => { b.innerHTML = ICON_TRASH }, null, () => removeEntries({ key: e.key }))
}
function trackYtDeleteBtn (i) {
  if (isYt(i.e)) return null
  const copies = (i.alts || []).filter(a => isYt(a) && ownEntry(a))
  if (!copies.length) return null
  const b = h('button', { class: 'track-alt-del', 'aria-label': 'Remove YouTube copy of ' + trackName(i.e) })
  return armDelete(b, () => { b.textContent = 'Remove YouTube copy' }, null, () => removeEntries({ keys: copies.map(a => a.key) }))
}
// One press for the whole album: every track this channel holds under its release, in one request.
function albumDeleteBtn (t) {
  const own = t.items.filter(i => ownEntry(i.e))
  if (!own.length) return null
  const ask = h('span', { class: 'meta del-ask', role: 'status', hidden: true }, 'Deletes “' + t.album + '” and its ' + plural(own.length, 'track', 'tracks') + '.')
  const b = h('button', { class: 'btn quiet' })
  armDelete(b, () => { b.textContent = 'Delete album' }, ask, () => {
    // The tile's key list spans every release folded into it; its items collapse duplicate copies to one row and
    // would leave the dropped copy's announce behind (mergeAlbums keeps only the first). Fall back to rows we have.
    const keys = Array.isArray(t.keys) && t.keys.length ? t.keys : own.map(i => i.e.key)
    return removeEntries({ keys }, () => $('detail').close())
  })
  return [b, ask]
}
// ---- end Delete
function fileRow (label, e, withHealth) {
  const from = sourceName(e.source)
  const dlName = /^S\\d+E\\d+$/i.test(label) && e.title && !/s\\d+e\\d+/i.test(e.title) ? e.title + ' ' + label : (e.title || label)
  const accessNote = e.locked ? 'Subscriber pass needed' : (e.private ? 'Subscribers only' : '')
  const shown = infoShown.has(e.key)
  return h('div', null, h('div', { class: 'row-item' },
    h('div', { class: 'grow' }, h('div', { class: 'label' }, label, withHealth ? healthTag(e) : null), h('div', { class: 'meta' }, [size(e.size), where(e), accessNote, from && 'from ' + from].filter(Boolean).join(' · '))),
    h('div', { class: 'acts' },
      e.locked ? null : h('button', { class: 'btn primary', 'data-play': true, onclick: () => play(e) }, 'Play'),
      e.locked ? null : castButton(e),
      e.locked ? null : downloadBtn(e, true, dlName),
      h('button', { class: 'btn quiet', title: e.magnetUrl, onclick: () => copyText(e.magnetUrl) }, 'Copy link'),
      h('button', { class: 'btn quiet', 'aria-expanded': String(shown), onclick: () => { shown ? infoShown.delete(e.key) : infoShown.add(e.key); renderDetail() } }, 'File info'),
      deleteBtn(e, true))),
  shown ? infoPanel(e) : null)
}

// ---- Music
// A track is a track, not one of a film's versions: the row shows the number it is addressed by (its disc and track
// from the id's ':sNNeMM' suffix) and the name the announce carries in 'music.title'. The announce title is the album
// on every track, so without 'music' an album's rows would all read the same.
const trackName = e => (e.music && e.music.title) || (e.id.split(':').pop() || '').toUpperCase() || e.title || 'Track'
const trackNo = e => e.season != null && e.episode != null
  ? (e.season > 1 ? e.season + '-' : '') + String(e.episode).padStart(2, '0')
  : ''
// What a track is, in the terms a listener judges a copy by: the sample rate and depth of a lossless file, or the
// bitrate of a lossy one, plus the bitrate the file's own size works out to. The header is read once per file and
// cached; until it arrives the cell is empty rather than a guess.
function qualityOf (e, d) {
  if (isYt(e)) return YT_LABEL + ' · lossy copy'
  if (!d || !d.media) return ''
  const secs = d.media.duration
  const a = (d.media.audio || [])[0]
  const bits = a && a.depth ? a.depth + '-bit ' : ''
  // "Lossless container", never "lossless": FLAC stores whatever it was given without further loss, and a file
  // transcoded from a lossy source is still a lossless container of lossy audio. The word on its own invites the
  // reader to believe the recording is lossless, which only the source can decide.
  const containerLossless = d.media.container === 'flac' || d.media.container === 'wav' || (a && a.codec === 'FLAC')
  const base = a ? bits + (a.rate ? (a.rate / 1000) + ' kHz' : '') : ''
  const br = bitrate(e.size, secs)
  return [a && a.codec, base, containerLossless ? 'lossless container' : br, containerLossless ? br + ' file' : ''].filter(Boolean).join(' · ')
}
// A row's second line says only what sets the track apart: an artist who is not the album's, a copy that is not
// what the rest of the album is (one 16-bit track on a 24-bit album, a YouTube copy on a FLAC album), not saved here
// yet, or held twice. On a clean album every row is one line. The full verdict ("lossless container", bitrate) is
// the line's tooltip, and the album's own is the sheet's header.
function trackMeta (i, d, albumArtist, common) {
  const e = i.e
  const artist = e.music && e.music.artist
  const q = copyQuality(e, d)
  const ytAlso = !isYt(e) && i.alts.some(isYt)
  return [artist && artist !== albumArtist ? artist : '', q !== common ? q : '', saved(e) ? '' : where(e), ytAlso ? 'Also from YouTube' : i.copies > 1 ? i.copies + ' copies' : ''].filter(Boolean).join(' · ')
}
// What most of an album's tracks are, among the headers read so far.
function commonQuality (t) {
  const n = new Map()
  for (const i of t.items) {
    const q = copyQuality(i.e, infoData.get(i.e.key))
    if (q) n.set(q, (n.get(q) || 0) + 1)
  }
  return [...n].sort((a, b) => b[1] - a[1]).map(x => x[0])[0] || ''
}
const trackSecs = d => (d && d.media && d.media.duration) || 0
const ICON_DOWNLOAD = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
// The whole row plays its track; the number turns into play or pause on the row being hovered or playing.
function trackRow (i, t, common) {
  const e = i.e
  const d = infoData.get(e.key)
  infoEntries.set(e.key, e)
  if (!d) loadInfo(e.key)
  const go = () => isCurrent(e) ? musicToggle() : startQueue(t.items.map(x => x.e), e, t.title)
  const btn = h('button', { class: 'track-play', 'aria-label': 'Play ' + trackName(e), onclick: ev => { ev.stopPropagation(); go() } }, h('span', { class: 'tn' }, String(i.episode)))
  btn.insertAdjacentHTML('beforeend', ICON_PLAY + ICON_PAUSE)
  const dl = e.streamUrl ? h('a', { class: 'track-dl', href: downloadHref(e, (trackNo(e) ? trackNo(e) + ' ' : '') + trackName(e) + ' — ' + t.title), download: '', title: 'Download', 'aria-label': 'Download ' + trackName(e) }) : null
  if (dl) dl.innerHTML = ICON_DOWNLOAD
  return h('div', { class: 'row-item track', 'data-track': e.key, 'data-name': trackName(e), onclick: ev => { if (!ev.target.closest('a, button')) go() } },
    btn,
    h('div', { class: 'grow', style: 'min-width:0' },
      h('div', { class: 'label' }, trackName(e), h('span', { class: 'tag now', hidden: true })),
      h('div', { class: 'meta', 'data-q': e.key, title: qualityOf(e, d) }, trackMeta(i, d, t.artist, common)),
      trackYtDeleteBtn(i)),
    h('span', { class: 'track-dur', 'data-dur': e.key }, duration(trackSecs(d))),
    dl,
    trackDeleteBtn(i))
}
// The sheet's header: how much and how long (once every header is read) and where it lives; then what the copy is.
function albumHeadLine (t) {
  const secs = albumSecs(t)
  return [plural(t.items.length, 'track', 'tracks'), secs ? Math.round(secs / 60) + ' min' : '', size(t.items.reduce((n, i) => n + (i.e.size || 0), 0)),
    tileState(t)[0], t.releases > 1 ? 'from ' + t.releases + ' releases' : ''].filter(Boolean).join(' · ')
}
function albumVerdict (t) {
  const common = commonQuality(t)
  if (common === YT_LABEL) return 'From ' + YT_LABEL
  const i = t.items.find(x => !isYt(x.e) && shortQuality(infoData.get(x.e.key)) === common) || t.items.find(x => !isYt(x.e)) || t.items[0]
  return qualityOf(i.e, infoData.get(i.e.key))
}
// Under the verdict, only when an album mixes a YouTube copy with another: which one plays, and what exists only
// on YouTube.
function albumAlso (t) {
  if (!hasYt(t) || allYt(t)) return ''
  const known = t.items.flatMap(i => [i.e, ...i.alts]).find(e => !isYt(e) && shortQuality(infoData.get(e.key)))
  const codec = known ? shortQuality(infoData.get(known.key)).split(' ')[0] : ''
  const playsYt = t.items.filter(i => isYt(i.e))
  const onNet = playsYt.filter(i => i.alts.some(a => !isYt(a))).length
  const only = playsYt.length - onNet
  const lines = []
  if (t.items.some(i => !isYt(i.e) && i.alts.some(isYt))) lines.push('Also from ' + YT_LABEL + '. ' + (codec ? codec + ' plays first.' : 'The other copy plays first.'))
  if (onNet) lines.push((codec ? 'A ' + codec : 'Another') + ' copy is on the network.')
  if (only) lines.push(plural(only, 'track', 'tracks') + ' only from ' + YT_LABEL + '.')
  return lines.join(' ')
}
// Headers land one by one after the sheet opens; each redraws the lines that depend on them, never the rows.
function paintAlbumSheet (t) {
  const box = $('detailBody')
  const common = commonQuality(t)
  const am = box.querySelector('[data-am]')
  if (am) am.textContent = albumHeadLine(t)
  const av = box.querySelector('[data-av]')
  if (av) av.textContent = albumVerdict(t)
  const ay = box.querySelector('[data-ay]')
  if (ay) { ay.textContent = albumAlso(t); ay.hidden = !ay.textContent }
  for (const i of t.items) {
    const d = infoData.get(i.e.key)
    for (const line of box.querySelectorAll('[data-q]')) {
      if (line.dataset.q !== i.e.key) continue
      line.textContent = trackMeta(i, d, t.artist, common)
      line.title = qualityOf(i.e, d)
    }
    for (const cell of box.querySelectorAll('[data-dur]')) if (cell.dataset.dur === i.e.key) cell.textContent = duration(trackSecs(d))
    for (const b of box.querySelectorAll('[data-del]')) {
      if (b.dataset.del !== i.e.key) continue
      const [title, label] = trackDeleteLabel(i)
      b.title = title
      b.setAttribute('aria-label', label)
    }
  }
}
function albumHead (t) {
  const list = t.items.map(i => i.e).filter(e => !e.locked)
  const del = albumDeleteBtn(t)
  const icons = h('span', { class: 'btn-ic' })
  icons.innerHTML = ICON_PLAY + ICON_PAUSE
  const shuffled = () => {
    const pool = list.slice()
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]] }
    return pool
  }
  // Flat children on a grid: beside the sleeve on a desktop; on a phone the name sits beside it and the facts and
  // buttons take the full width under it, so Play and Shuffle stay on one line.
  return h('div', { class: 'detail-head album-head' },
    albumArt(t, 'sleeve-lg'),
    h('div', { class: 'ah-title' },
      h('h3', { id: 'detailTitle' }, t.album),
      h('div', { class: 'album-by' }, t.artist || 'Unknown artist')),
    h('div', { class: 'ah-meta' },
      h('div', { class: 'meta', 'data-am': t.key }, albumHeadLine(t)),
      h('div', { class: 'meta', 'data-av': t.key }, albumVerdict(t)),
      h('div', { class: 'meta', 'data-ay': t.key, hidden: !albumAlso(t) }, albumAlso(t))),
    list.length || del
      ? h('div', { class: 'album-acts' },
        list.length ? h('button', { class: 'btn primary', 'data-album': t.key, onclick: () => queue.length && (tileOf(queue[queueIndex]) || {}).key === t.key ? musicToggle() : startQueue(list, list[0], t.title) }, icons, h('span', null, 'Play')) : null,
        list.length > 1 ? h('button', { class: 'btn quiet', onclick: () => startQueue(shuffled(), null, t.title, 'Shuffling') }, 'Shuffle') : null,
        del)
      : null)
}

// ---- Music: one queue, one audio element, one bar along the bottom of every tab
// The queue is what plays next, in the order the queue panel shows. Starting one replaces it; shuffling only reorders
// it, so the panel never lies about what comes next. The queue, the spot in it and the volume are kept in this
// browser, so a reload comes back to the same track, paused where it was.
const ICON_PLAY = '<svg class="i-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.2-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>'
const ICON_PAUSE = '<svg class="i-pause" viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg>'
const MUSIC_KEY = 'peartube-music'
let musicStore = {}
try { musicStore = JSON.parse(localStorage.getItem(MUSIC_KEY) || '{}') || {} } catch {}
let queue = []
let queueIndex = 0
let queueTitle = ''
let audioEl = null
let npState = 'idle' // loading, playing, paused, done or error: what the bar says under the track name
let npAnnounce = '' // said once the first sound of a started track is heard, never before it
let npError = '' // why the current track did not play, in the listener's terms
let npSlowTimer = 0 // a load that has not started after 10 s says it is still looking, rather than spinning in silence
let npSlow = false
function npLoading () {
  npState = 'loading'
  npSlow = false
  clearTimeout(npSlowTimer)
  npSlowTimer = setTimeout(() => { if (npState === 'loading') { npSlow = true; paintBar() } }, 10000)
}
let seekDragging = false
let lastMusicSave = 0
let musicRestored = false
const albumName = title => String(title || '').split(' · ').pop()
const isCurrent = e => queue.length > 0 && queue[queueIndex].key === e.key
const clock = s => duration(s) || '0:00'
const nowLine = (verb, i) => verb + ' “' + trackName(queue[i]) + '”' + (queue.length > 1 ? ', ' + (i + 1) + ' of ' + queue.length : '')

function musicAudio () {
  if (audioEl) return audioEl
  // Attached, not floating: a detached media element has no document to schedule playback against, and its
  // events are the only thing that keeps the bar honest about what is playing.
  const a = audioEl = el('audio')
  a.preload = 'auto'
  a.hidden = true
  a.volume = Number.isFinite(musicStore.vol) ? Math.min(1, Math.max(0, musicStore.vol)) : 1
  document.body.append(a)
  a.addEventListener('playing', () => {
    npState = 'playing'
    if (npAnnounce) { toast(npAnnounce); npAnnounce = '' }
    paintBar()
  })
  a.addEventListener('waiting', () => { if (!a.paused) { npLoading(); paintBar() } })
  a.addEventListener('pause', () => { if (npState !== 'done' && npState !== 'error') npState = 'paused'; paintBar(); saveMusic(true) })
  a.addEventListener('ended', trackEnded)
  a.addEventListener('timeupdate', () => { paintTime(); saveMusic() })
  a.addEventListener('durationchange', paintTime)
  a.addEventListener('error', async () => {
    const src = a.getAttribute('src')
    if (!src || !queue.length) return
    const e = queue[queueIndex]
    npState = 'error'
    npAnnounce = ''
    npError = 'Could not play this track'
    paintBar()
    const why = await whyUnplayable(a.error, src)
    if (a.getAttribute('src') !== src) return
    npError = why
    toast('Could not play “' + trackName(e) + '”. ' + why + '.')
    paintBar()
  })
  // Media keys and the system's now-playing panel drive the same queue as the bar.
  const ms = navigator.mediaSession
  const actions = [['play', () => { if (a.paused) musicToggle() }], ['pause', () => { if (!a.paused) a.pause() }], ['previoustrack', musicPrev], ['nexttrack', musicNext], ['seekto', d => musicSeek(d.seekTime)]]
  if (ms) for (const [name, fn] of actions) { try { ms.setActionHandler(name, fn) } catch {} }
  return a
}
// A media error alone cannot tell a missing file from a broken one: code 4 covers both a 404 and a format this
// browser lacks. One byte asked of the same URL tells them apart.
async function whyUnplayable (err, src) {
  if (err && err.code === 3) return 'The file is damaged and could not be decoded'
  let res
  try { res = await fetch(src, { headers: { range: 'bytes=0-0' } }) } catch { return 'Could not reach the relay' }
  if (res.body) res.body.cancel().catch(() => {})
  if (res.status === 404) return 'The relay does not have this file'
  if (!res.ok) return 'The relay could not send this file (' + res.status + ')'
  return err && err.code === 2 ? 'The connection to the relay dropped' : 'This browser cannot play this format'
}
function setMediaSession (e) {
  if (!navigator.mediaSession || typeof MediaMetadata !== 'function') return
  try { navigator.mediaSession.metadata = new MediaMetadata({ title: trackName(e), artist: (e.music && e.music.artist) || '', album: albumName(e.title) }) } catch {}
}
// Starts a list from one of its tracks (the first when none is named) and says so once the sound starts.
function startQueue (list, start, title, verb = 'Playing') {
  const q = list.filter(e => !e.locked)
  if (!q.length) return
  queue = q
  queueTitle = title || q[0].title
  $('detail').close()
  const i = Math.max(0, q.indexOf(start))
  playAt(i, i === 0 && q.length > 1 ? verb + ' “' + albumName(queueTitle) + '”, ' + plural(q.length, 'track', 'tracks') : nowLine(verb, i))
  loadQueueInfo()
}
// Track lengths for the queue panel come from the same header read as the sheet's rows.
function loadQueueInfo () {
  for (const e of queue) if (!infoData.has(e.key)) { infoEntries.set(e.key, e); loadInfo(e.key) }
}
function playAt (i, announce) {
  const a = musicAudio()
  // A track has no picture, so it never opens the video player; one that is open is closed, not left half-running.
  closePlayer()
  queueIndex = i
  const e = queue[i]
  npAnnounce = announce || ''
  npLoading()
  a.preload = 'auto'
  a.src = resolveStreamUrl(e.streamUrl)
  a.play().catch(err => {
    // A browser that wants a click first refuses here; the bar then offers play instead of a spinner that never ends.
    if (err && err.name === 'NotAllowedError' && queue[queueIndex] === e) { npState = 'paused'; npAnnounce = ''; paintBar() }
  })
  setMediaSession(e)
  saveMusic(true)
  paintBar()
}
function musicToggle () {
  const a = audioEl
  if (!a || !queue.length) return
  if (npState === 'done') playAt(0, nowLine('Playing', 0))
  else if (npState === 'error') playAt(queueIndex)
  else if (a.paused) a.play().catch(() => {})
  else a.pause()
}
function musicNext () {
  if (queueIndex + 1 < queue.length) playAt(queueIndex + 1)
}
function musicPrev () {
  if (!queue.length) return
  // Like every player: back restarts the track, and only a second press near its start goes to the one before.
  if (queueIndex === 0 || (audioEl && audioEl.currentTime > 3 && npState !== 'error')) musicSeek(0)
  else playAt(queueIndex - 1)
}
function musicSeek (secs) {
  const a = audioEl
  if (!a || !Number.isFinite(a.duration)) return
  a.currentTime = Math.max(0, Math.min(a.duration, secs))
  paintTime()
}
function trackEnded () {
  if (queueIndex + 1 < queue.length) { playAt(queueIndex + 1, nowLine('Now playing', queueIndex + 1)); return }
  npState = 'done'
  toast('Finished “' + albumName(queueTitle) + '”')
  paintBar()
}
function musicStop () {
  queue = []
  queueIndex = 0
  npState = 'idle'
  if (audioEl) { audioEl.pause(); audioEl.removeAttribute('src'); audioEl.load() }
  saveMusic(true)
  paintBar()
}
function saveMusic (now) {
  if (!now && Date.now() - lastMusicSave < 5000) return
  lastMusicSave = Date.now()
  const vol = audioEl ? audioEl.volume : 1
  musicStore = queue.length ? { keys: queue.map(x => x.key), i: queueIndex, at: (audioEl && audioEl.currentTime) || 0, title: queueTitle, vol } : { vol }
  try { localStorage.setItem(MUSIC_KEY, JSON.stringify(musicStore)) } catch {}
}
// After the first load: the queue this browser left comes back on the same track, paused where it was.
function restoreMusic () {
  if (musicRestored || !S.entries.length) return
  musicRestored = true
  const m = musicStore
  if (queue.length || !Array.isArray(m.keys)) return
  const byKey = new Map(S.entries.map(e => [e.key, e]))
  const cur = byKey.get(m.keys[m.i])
  if (!cur) return
  queue = m.keys.map(k => byKey.get(k)).filter(Boolean)
  queueIndex = queue.indexOf(cur)
  queueTitle = m.title || cur.title
  const a = musicAudio()
  a.preload = 'metadata'
  a.src = resolveStreamUrl(cur.streamUrl)
  if (m.at > 0) a.addEventListener('loadedmetadata', () => { if (queue[queueIndex] === cur && m.at < a.duration) a.currentTime = m.at }, { once: true })
  npState = 'paused'
  setMediaSession(cur)
  loadQueueInfo()
  paintBar()
}

function paintBar () {
  const e = queue[queueIndex]
  $('np').hidden = !e
  document.body.classList.toggle('np-on', Boolean(e))
  paintRows()
  if (!e) {
    toggleQueue(false)
    document.title = 'PearTube'
    if (navigator.mediaSession) navigator.mediaSession.metadata = null
    return
  }
  const playing = Boolean(audioEl && !audioEl.paused)
  $('npPlay').classList.toggle('on', playing)
  $('npPlay').setAttribute('aria-label', playing ? 'Pause' : 'Play')
  // The bar wears the album's own sleeve, so the tile and the bar read as the same record.
  const art = $('npArt')
  if (art.dataset.key !== e.key) {
    const t = tileOf(e)
    art.dataset.key = e.key
    art.replaceChildren(t && t.album ? albumArt(t) : albumName(e.title).trim().charAt(0).toUpperCase() || '?')
  }
  $('npArt').setAttribute('aria-label', 'Open ' + albumName(e.title))
  $('npTitle').textContent = trackName(e)
  const status = npState === 'loading' ? (npSlow ? 'Still looking for this file on the network…' : 'Loading…') : npState === 'error' ? npError : npState === 'done' ? 'Finished' : ''
  $('npMeta').textContent = status || [e.music && e.music.artist, albumName(e.title)].filter(Boolean).join(' · ')
  $('npMeta').parentNode.classList.toggle('bad', npState === 'error')
  const pos = (queueIndex + 1) + ' of ' + queue.length
  $('npPos').textContent = pos
  $('npQText').textContent = pos
  $('npQueueBtn').setAttribute('aria-label', 'Queue, track ' + pos)
  $('npNext').disabled = queueIndex + 1 >= queue.length
  document.title = trackName(e) + ' · ' + albumName(e.title)
  paintTime()
  if (!$('npQueue').hidden) renderQueue()
}
function paintTime () {
  const a = audioEl
  if (!a || !queue.length) return
  const dur = Number.isFinite(a.duration) ? a.duration : 0
  const seek = $('npSeek')
  const at = seekDragging ? Number(seek.value) : (a.currentTime || 0)
  $('npAt').textContent = clock(at)
  $('npLeft').textContent = dur ? '-' + clock(dur - at) : '--:--'
  seek.disabled = !dur
  if (!seekDragging) { seek.max = String(dur); seek.value = String(at) }
  seek.setAttribute('aria-valuetext', clock(at) + ' of ' + clock(dur))
}
// Every row and album button that names a track says whether it is the one playing, wherever it is drawn, without
// redrawing anything under the pointer: rows carry data-track, album buttons data-album with the tile key.
function paintRows () {
  const cur = queue[queueIndex]
  const playing = Boolean(cur && audioEl && !audioEl.paused)
  for (const row of document.querySelectorAll('[data-track]')) {
    const now = Boolean(cur) && row.dataset.track === cur.key
    row.classList.toggle('now', now)
    const btn = row.querySelector('.track-play')
    if (btn) {
      btn.classList.toggle('on', now && playing)
      btn.setAttribute('aria-label', (now && playing ? 'Pause ' : 'Play ') + row.dataset.name)
    }
    const tag = row.querySelector('.tag.now')
    if (tag) {
      tag.hidden = !now
      tag.textContent = npState === 'loading' ? 'Loading' : playing ? 'Playing' : 'Paused'
    }
  }
  const buttons = document.querySelectorAll('[data-album]')
  if (!buttons.length) return
  const curTile = cur ? (tileOf(cur) || {}).key : null
  for (const btn of buttons) {
    const mine = Boolean(curTile) && btn.dataset.album === curTile
    const icons = btn.querySelector('.btn-ic')
    if (icons) icons.classList.toggle('on', mine && playing)
    if (btn.lastChild !== icons) btn.lastChild.textContent = !mine ? 'Play' : playing ? 'Pause' : 'Resume'
  }
}
function toggleQueue (open) {
  const panel = $('npQueue')
  panel.hidden = !(open ?? panel.hidden) || !queue.length
  $('npQueueBtn').setAttribute('aria-expanded', String(!panel.hidden))
  if (panel.hidden) return
  renderQueue()
  const cur = $('npList').querySelector('.now')
  if (cur) cur.scrollIntoView({ block: 'nearest' })
}
function renderQueue () {
  const playing = Boolean(audioEl && !audioEl.paused)
  $('npQueueMeta').textContent = albumName(queueTitle) + ' · ' + plural(queue.length, 'track', 'tracks')
  $('npList').replaceChildren(...queue.map((e, i) => {
    const now = i === queueIndex
    const d = infoData.get(e.key)
    const secs = d && d.media && d.media.duration
    const num = h('span', { class: 'nq-num' + (now && playing ? ' on' : '') }, now ? '' : String(i + 1))
    if (now) num.innerHTML = ICON_PLAY + ICON_PAUSE
    return h('li', { class: now ? 'now' : i < queueIndex ? 'done' : '' },
      h('button', { 'aria-current': now ? 'true' : false, onclick: () => now ? musicToggle() : playAt(i) },
        num, h('span', { class: 'nq-name' }, trackName(e)), h('span', { class: 'nq-dur' }, secs ? duration(secs) : '')))
  }))
}
// The library tile that holds a track, whatever its grouping key is, as the copy a row plays or a second copy of it.
const tileOf = e => libraryTiles().find(t => t.items.some(i => i.e.key === e.key || (i.alts || []).some(a => a.key === e.key)))
const openAlbum = () => { const e = queue[queueIndex]; const t = e && tileOf(e); if (t) openDetail(t.key, e.season) }
$('npArt').onclick = openAlbum
$('npTitle').onclick = openAlbum
$('npPlay').onclick = musicToggle
$('npPrev').onclick = musicPrev
$('npNext').onclick = musicNext
$('npQueueBtn').onclick = () => toggleQueue()
$('npQueueClose').onclick = () => { toggleQueue(false); $('npQueueBtn').focus() }
$('npClear').onclick = musicStop
$('npSeek').addEventListener('input', () => { seekDragging = true; paintTime() })
$('npSeek').addEventListener('change', () => { seekDragging = false; musicSeek(Number($('npSeek').value)) })
$('npVol').value = String(Math.round((Number.isFinite(musicStore.vol) ? musicStore.vol : 1) * 100))
$('npVol').addEventListener('input', () => { musicAudio().volume = Number($('npVol').value) / 100; saveMusic(true) })
addEventListener('pointerdown', ev => { if (!$('npQueue').hidden && !ev.target.closest('#npQueue, #npQueueBtn')) toggleQueue(false) })
// Music keys, whenever a typed key would not land in a text field or a control: space plays or pauses, the arrows
// step 10 s. A focused button or link keeps Space for itself, so a chip or a checkbox never pauses the music.
addEventListener('keydown', ev => {
  if (!queue.length || player || ev.altKey || ev.ctrlKey || ev.metaKey || ev.defaultPrevented) return
  const t = ev.target
  const range = t.tagName === 'INPUT' && t.type === 'range'
  if ((!range && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) || t.isContentEditable) return
  if (ev.key === 'Escape' && !$('npQueue').hidden) { ev.preventDefault(); toggleQueue(false); $('npQueueBtn').focus() }
  else if (/^(BUTTON|A)$/.test(t.tagName)) return
  else if (ev.key === ' ') { ev.preventDefault(); musicToggle() }
  else if (!range && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) { ev.preventDefault(); musicSeek(audioEl.currentTime + (ev.key === 'ArrowLeft' ? -10 : 10)) }
})

// ---- Library: what a file holds and how well it streams here now (GET /v1/entries/info), redrawn every 3 s while
// the sheet is open. Episodes and versions open theirs with File info; a single file shows it at once, and each
// version of a film carries its verdict on its row. The relay reads a header only for files it holds or has open;
// for any other, Check sources asks the network on purpose, which tells peers the title is wanted, as Play does.
const infoData = new Map() // entry key -> last reply, or { error }
const infoEntries = new Map() // entry key -> the entry it describes
const infoBusy = new Set()
const infoShown = new Set()
const infoWatched = new Set() // entry keys polled while the sheet is open: open panels and a film's versions
let infoTimer = 0
const CHANNELS = { 1: 'Mono', 2: 'Stereo', 6: '5.1', 8: '7.1' }
function langName (code) {
  if (!code) return ''
  try { return new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' }).of(code) || code } catch { return code }
}
const trackLine = t => [t.codec, t.channels ? CHANNELS[t.channels] || t.channels + ' channels' : '', langName(t.language), t.name].filter(Boolean).join(' · ')
function bitrate (bytes, secs) {
  const kbps = secs > 0 ? bytes * 8 / secs / 1000 : 0
  return !kbps ? '' : kbps >= 1000 ? (kbps / 1000).toFixed(1) + ' Mbps' : Math.round(kbps) + ' kbps'
}
// Download speed over the file's own bitrate: 1.5 or more keeps ahead of playback.
function headroom (e, d) {
  const secs = d.media && d.media.duration
  return d.health && d.health.rateBps > 0 && secs > 0 ? d.health.rateBps / (e.size / secs) : 0
}
function verdict (e, d) {
  const x = d && d.health
  if (!x) return null
  if (saved(e)) return ['Plays from this relay', 'ok']
  const r = headroom(e, d)
  if (r) return r >= 1.5 ? ['Plays smoothly', 'ok'] : r >= 1 ? ['May buffer', 'warn'] : ['Too slow to play', 'bad']
  if (x.wholePeers) return ['Full copy on ' + plural(x.wholePeers, 'peer', 'peers'), 'ok']
  if (x.peers) return ['Only partial copies connected', 'warn']
  if (x.open) return ['No peers for this copy', 'bad']
  return ['Not checked', '']
}
function healthTag (e) {
  infoEntries.set(e.key, e)
  infoWatched.add(e.key)
  const tag = h('span', { class: 'tag', 'data-health': e.key, style: 'margin-left:8px' })
  paintTag(tag, e, infoData.get(e.key))
  if (!infoData.has(e.key)) loadInfo(e.key)
  return tag
}
function paintTag (tag, e, d) {
  const v = verdict(e, d)
  tag.hidden = !v
  if (v) { tag.textContent = v[0]; tag.className = 'tag' + (v[1] ? ' ' + v[1] : '') }
}
function infoRows (e, d) {
  if (!d) return [h('div', { class: 'meta' }, 'Reading file details…')]
  if (d.error) return [h('div', { class: 'meta err' }, d.error)]
  const rows = []
  const row = (label, ...value) => rows.push(h('div', { class: 'info-row' }, h('span', null, label), h('span', null, ...value)))
  const m = d.media
  if (d.mediaDeferred) {
    row('Format', 'Not read yet: this relay does not hold the file',
      d.health ? h('button', { class: 'btn quiet', style: 'margin-left:8px', title: 'Tells peers this title is wanted, as Play does', onclick: ev => act(ev.currentTarget, () => loadInfo(e.key, true)) }, 'Check sources') : null)
  } else if (m === undefined) row('Format', 'Reading the file header…')
  else if (!m) row('Format', 'Not recognised')
  else {
    row('Format', [m.container.toUpperCase(), duration(m.duration), bitrate(e.size, m.duration)].filter(Boolean).join(' · '))
    for (const v of m.video) row('Video', [v.codec, v.width && v.height ? v.width + '×' + v.height : '', v.hdr].filter(Boolean).join(' · '))
    m.audio.forEach((a, i) => row(m.audio.length > 1 ? 'Audio ' + (i + 1) : 'Audio', trackLine(a)))
    if (m.subtitles.length) row('Subtitles', m.subtitles.slice(0, 8).map(trackLine).join(', ') + (m.subtitles.length > 8 ? ', +' + (m.subtitles.length - 8) + ' more' : ''))
  }
  const x = d.health
  if (!x) return rows
  const v = verdict(e, d)
  const r = headroom(e, d)
  row('Health', h('span', { class: 'tag' + (v[1] ? ' ' + v[1] : '') }, v[0]),
    x.rateBps ? ' ' + [rate(x.rateBps) + ' from ' + plural(x.sources, 'peer', 'peers'), r ? r.toFixed(1) + '× the bitrate' : ''].filter(Boolean).join(' · ') : '')
  if (x.open) row('Peers', [x.peers + ' connected', x.wholePeers && x.wholePeers + ' with the whole file', x.lanPeers && x.lanPeers + ' on LAN', x.shared && 'counted on a shared older store'].filter(Boolean).join(' · '))
  if (x.otherCopies) row('Copies', 'Same file in ' + plural(x.otherCopies, 'other swarm', 'other swarms') + (x.usingOtherCopy ? ' · playing from one now' : ' · used when this one has no peers'))
  return rows
}
function infoPanel (e) {
  infoEntries.set(e.key, e)
  infoWatched.add(e.key)
  const box = h('div', { class: 'file-info', 'data-info': e.key }, infoRows(e, infoData.get(e.key)))
  if (!infoData.has(e.key)) loadInfo(e.key)
  return box
}
// A read already in flight is shared, so a caller waiting on it (the shelf's quality line) hears when it lands.
const infoPending = new Map()
function loadInfo (key, read) {
  if (infoBusy.has(key) && !read) return infoPending.get(key)
  const p = readInfo(key, read)
  infoPending.set(key, p)
  return p
}
async function readInfo (key, read) {
  infoBusy.add(key)
  try {
    infoData.set(key, await api('/v1/entries/info?key=' + encodeURIComponent(key) + (read ? '&read=1' : '')))
  } catch (err) {
    infoData.set(key, { error: err.message })
  } finally {
    infoBusy.delete(key)
    infoPending.delete(key)
  }
  const e = infoEntries.get(key)
  for (const box of $('detailBody').querySelectorAll('[data-info]')) {
    if (box.dataset.info === key) box.replaceChildren(...infoRows(e, infoData.get(key)))
  }
  for (const tag of $('detailBody').querySelectorAll('[data-health]')) {
    if (tag.dataset.health === key) paintTag(tag, e, infoData.get(key))
  }
  // An album sheet's rows and header are built from these reads, so they are redrawn as each header lands.
  const am = $('detailBody').querySelector('[data-am]')
  const at = am && libraryTiles().find(x => x.key === am.dataset.am)
  if (at && at.items.some(i => i.e.key === key)) paintAlbumSheet(at)
  if (!$('npQueue').hidden && queue.some(x => x.key === key)) renderQueue()
}
function pollInfo () {
  if (document.hidden) return
  for (const key of infoWatched) loadInfo(key)
}
function renderDetail () {
  const t = libraryTiles().find(x => x.key === detailKey)
  const box = $('detailBody')
  infoWatched.clear()
  if (!t) { box.replaceChildren(h('div', { class: 'empty' }, 'This title is no longer in the library.')); return }
  const head = t.kind === 'album'
    ? albumHead(t)
    : h('div', { class: 'detail-head' },
      posterBox(t.imdb ? '/v1/poster/' + t.imdb : null, t.title),
      h('div', { class: 'grow' }, h('h3', { id: 'detailTitle' }, t.title), h('div', { class: 'meta' }, tileLine(t) + ' · ' + tileState(t)[0])))
  let body
  if (t.kind === 'album') {
    // Every track on one page, in disc and track order, with a heading per disc when there is more than one: a
    // disc picker hid half an album behind a select for no gain.
    const discs = [...new Set(t.items.map(i => i.season))].sort((a, b) => a - b)
    const common = commonQuality(t)
    body = discs.map(d => [
      discs.length > 1 ? h('h4', { class: 'disc-head' }, 'Disc ' + d) : null,
      h('div', { class: 'rows tracks' }, t.items.filter(i => i.season === d).map(i => trackRow(i, t, common)))]).flat()
  } else if (t.kind === 'show') {
    const seasons = [...new Set(t.items.map(i => i.season))]
    if (detailSeason == null || !seasons.includes(detailSeason)) detailSeason = seasons[0]
    const pick = seasons.length > 1
      ? h('div', { class: 'field' }, h('label', { for: 'seasonPick' }, 'Season'), h('select', { id: 'seasonPick', onchange: ev => { detailSeason = Number(ev.target.value); renderDetail() } },
        seasons.map(s => h('option', { value: String(s), selected: s === detailSeason }, 'Season ' + s + ' (' + t.items.filter(i => i.season === s).length + ')'))))
      : null
    body = [pick, h('div', { class: 'rows' }, t.items.filter(i => i.season === detailSeason).map(i => fileRow('S' + String(i.season).padStart(2, '0') + 'E' + String(i.episode).padStart(2, '0'), i.e)))]
  } else if (t.items.length > 1) {
    // A film's versions are few, so each row shows its verdict; a show's episodes check only under File info.
    body = [h('div', { class: 'rows' }, t.items.map((i, n) => fileRow('Version ' + (n + 1), i.e, n < 8)))]
  } else {
    const e = t.items[0].e
    const from = sourceName(e.source)
    const accessNote = e.locked ? 'Subscriber pass needed' : (e.private ? 'Subscribers only' : '')
    body = [h('div', { class: 'meta' }, [where(e), accessNote, from && 'from ' + from].filter(Boolean).join(' · ')),
      h('div', { class: 'row', style: 'margin-top:14px;flex-wrap:wrap' },
        e.locked ? null : h('button', { class: 'btn primary', 'data-play': true, onclick: () => play(e) }, 'Play'),
        e.locked ? null : castButton(e),
        e.locked ? null : downloadBtn(e),
        copyBtn('Copy link', e.magnetUrl),
        deleteBtn(e, false)),
      infoPanel(e)]
  }
  box.replaceChildren(head, ...body.filter(Boolean))
  paintRows()
}
$('detailClose').onclick = () => $('detail').close()
$('detail').addEventListener('click', ev => { if (ev.target === $('detail')) $('detail').close() })
$('detail').addEventListener('close', () => { clearInterval(infoTimer); infoTimer = 0; infoShown.clear(); infoWatched.clear() })

// ---- Channels
$('followForm').onsubmit = async ev => {
  ev.preventDefault()
  const val = $('followInput').value.trim()
  const alias = $('followName').value.trim()
  await act(ev.submitter, async () => {
    const access = /^peartube:(?:[/][/])?access[/]/i.test(val)
    const body = HEX.test(val) ? { key: val.toLowerCase(), kind: 'channel', alias } : { uri: val, alias }
    const r = await api(access ? '/v1/open' : '/v1/sources', { body })
    $('followInput').value = ''
    $('followName').value = ''
    say('followMsg', access ? 'Pass saved and channel followed.' : 'Following ' + ((r.source && r.source.alias) || short((r.source && r.source.key) || '')) + '.')
    refresh()
  }, 'followMsg')
}
$('writerForm').onsubmit = async ev => {
  ev.preventDefault()
  const writer = $('writerInput').value.trim().toLowerCase()
  const role = $('writerRole').value
  const alias = $('writerName').value.trim()
  await act(ev.submitter, async () => {
    S.identity = await api('/v1/identity/writers', { body: { writer, role, alias } })
    $('writerInput').value = ''
    $('writerName').value = ''
    say('writerMsg', 'Added ' + (alias || short(writer)) + '.')
    refresh()
  }, 'writerMsg')
}
$('recoverForm').onsubmit = async ev => {
  ev.preventDefault()
  const mnemonic = $('recoverInput').value.trim()
  await act(ev.submitter, async () => {
    S.identity = await api('/v1/identity/recover', { body: { mnemonic } })
    $('recoverInput').value = ''
    say('recoverMsg', 'Channel linked.')
    refresh()
  }, 'recoverMsg')
}
$('revealPhraseBtn').onclick = ev => act(ev.currentTarget, async () => {
  const ident = await api('/v1/identity?reveal=1')
  if (!ident.mnemonic) throw new Error('No recovery phrase saved on this relay')
  copyText(ident.mnemonic)
}, 'recoverMsg')

function copying (key) {
  if (!sval('replicate')) return false
  const only = sval('replicateSources') || []
  return !only.length || only.includes(key)
}
// Keeping a copy of one source: replicate everything, or only the listed sources.
async function keepCopy (key, on) {
  const followed = (S.sources.sources || []).filter(s => !s.writable).map(s => s.key)
  const only = sval('replicateSources') || []
  if (on) {
    if (!sval('replicate')) return saveSettings({ replicate: true, replicateSources: [key] })
    if (only.length && !only.includes(key)) return saveSettings({ replicateSources: [...only, key] })
    return
  }
  const next = (only.length ? only : followed.concat(key)).filter(k => k !== key)
  return saveSettings(next.length ? { replicateSources: [...new Set(next)] } : { replicate: false, replicateSources: [] })
}
function envNote (key) {
  const s = setting(key)
  return s && s.source === 'env' ? 'From ' + s.env : ''
}
function switchRow (label, checked, onchange, { disabled = false, note = '' } = {}) {
  const input = h('input', { type: 'checkbox', role: 'switch', checked: Boolean(checked), disabled })
  input.onchange = () => act(input, () => onchange(input.checked)).then(render)
  return h('label', { class: 'switch' }, input, h('span', null, label), note ? h('span', { class: 'tag' }, note) : null)
}

function renderChannels () {
  const st = S.status
  const src = S.sources
  const ident = S.identity
  const canEdit = Boolean(S.settings)
  const published = new Set((src.published || []).map(p => p.key))
  const mineRows = [
    h('div', { class: 'item' }, h('div', { class: 'info' }, h('div', { class: 'name' }, 'Channel'), h('div', { class: 'meta' }, 'Share publicly · ' + short(st.channel))),
      h('div', { class: 'acts' }, copyBtn('Copy link', st.channel ? 'peartube://channel/' + st.channel : '')))
  ]
  if (canEdit && st.writer) {
    mineRows.push(h('div', { class: 'item' }, h('div', { class: 'info' }, h('div', { class: 'name' }, 'This device'), h('div', { class: 'meta' }, 'Device writer key · ' + short(st.writer))),
      h('div', { class: 'acts' }, copyBtn('Copy key', st.writer))))
  }
  if (canEdit && ident && ident.accessUri) {
    mineRows.push(h('div', { class: 'item' }, h('div', { class: 'info' }, h('div', { class: 'name' }, 'Subscriber pass'), h('div', { class: 'meta' }, 'Epoch ' + ident.epoch + ' · unlocks subscriber videos')),
      h('div', { class: 'acts' },
        copyBtn('Copy pass', ident.accessUri),
        h('button', { class: 'btn quiet', onclick: e => act(e.currentTarget, async () => { S.identity = await api('/v1/identity/epoch', { body: {} }); toast('Rotated to epoch ' + S.identity.epoch); render() }) }, 'Rotate pass'))))
  }
  $('mine').replaceChildren(...mineRows)
  $('devicesWrap').hidden = !canEdit
  if (canEdit) {
    const writers = (ident && ident.writers) || []
    $('devices').replaceChildren(...(writers.length ? writers.map(w => h('div', { class: 'item' },
      h('div', { class: 'info' },
        h('div', { class: 'name' }, (w.alias || short(w.key)) + (w.self ? ' (this relay)' : '')),
        h('div', { class: 'meta' }, w.role + ' · ' + short(w.key))),
      h('div', { class: 'acts' },
        w.key === st.channel ? null : h('button', { class: 'btn quiet', onclick: e => act(e.currentTarget, async () => { S.identity = await api('/v1/identity/writers/' + w.key, { method: 'DELETE' }); render() }) }, 'Remove'))))
      : [h('div', { class: 'empty' }, 'Only this relay writes to your channel.')]))
  }
  const following = (src.sources || []).filter(s => !s.writable)
  $('followCount').textContent = following.length ? String(following.length) : ''
  $('following').replaceChildren(...(following.length ? following.map(s => {
    const listed = published.has(s.key)
    return h('div', { class: 'item' },
      h('div', { class: 'info' },
        h('div', { class: 'name' }, s.alias || 'Channel ' + short(s.key)),
        h('div', { class: 'meta' }, 'Channel' + (listed ? ' · In your directory' : '')),
        canEdit ? switchRow('Keep a copy here', copying(s.key), on => keepCopy(s.key, on)) : null),
      h('div', { class: 'acts' },
        copyBtn('Copy link', 'peartube://channel/' + s.key),
        listed
          ? h('button', { class: 'btn quiet', onclick: e => act(e.currentTarget, async () => { await api('/v1/channel/sources/' + s.key, { method: 'DELETE' }); refresh() }) }, 'Remove from directory')
          : h('button', { class: 'btn quiet', onclick: e => act(e.currentTarget, async () => { await api('/v1/channel/publish', { body: { type: 'source', sourceKey: s.key, kind: 'channel', title: s.alias || short(s.key) } }); refresh() }) }, 'Add to directory'),
        h('button', { class: 'btn quiet', onclick: e => act(e.currentTarget, async () => { await api('/v1/sources/' + s.key, { method: 'DELETE' }); refresh() }) }, 'Unfollow')))
  }) : [h('div', { class: 'empty' }, 'You are not following anything yet.')]))
  const found = (src.discovered || []).filter(d => !(src.sources || []).some(s => s.key === d.key))
  $('foundWrap').hidden = !found.length
  $('found').replaceChildren(...found.map(d => h('div', { class: 'item' },
    h('div', { class: 'info' }, h('div', { class: 'name' }, d.title), h('div', { class: 'meta' }, 'Channel')),
    h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: e => act(e.currentTarget, async () => { await api('/v1/sources', { body: { key: d.key, kind: 'channel', alias: d.title } }); refresh() }) }, 'Follow')))))
}

// ---- Sharing
const stat = (v, k) => h('div', { class: 'stat' }, h('div', { class: 'v' }, v), h('div', { class: 'k' }, k))
function renderSharing () {
  const st = S.status
  const routes = st.routes || {}
  const lan = st.lan
  $('netCard').replaceChildren(
    h('div', { class: 'stats' },
      stat(String((routes.public && routes.public.peers) || 0), 'over the internet'),
      stat(String(st.lanPeers || 0), lan ? 'nearby on ' + lan.host : 'nearby'),
      stat(st.privateRouting ? String((routes.private && routes.private.peers) || 0) : 'Off', 'private routing'),
      stat(st.privateGuard ? String(st.privateGuard.activeCircuits || 0) : 'Off', 'guard circuits'),
      stat(rate(st.upBps), 'sending now')),
    S.settings ? h('div', { style: 'margin-top:12px' }, switchRow('Find peers on this network', sval('lan'), on => saveSettings({ lan: on }), { note: envNote('lan') })) : null)

  const rep = plugin('p2p-replicate')
  const only = sval('replicateSources') || []
  const copyLines = []
  if (rep.enabled) {
    copyLines.push(h('div', { class: 'stats' },
      stat(String(rep.replicatedEntries || 0) + ' / ' + (rep.totalEntries || 0), 'videos copied'),
      stat(size(rep.replicatedBytes || 0), 'of ' + size(rep.targetBytes || 0)),
      stat(size(rep.freeDiskBytes), 'disk free')))
    if (rep.waitingForViewers) copyLines.push(h('div', { class: 'msg' }, h('span', { class: 'tag warn' }, 'Paused while viewers watch')))
    else if (rep.activeTitles && rep.activeTitles.length) copyLines.push(h('div', { class: 'meta', style: 'margin-top:10px' }, 'Copying ' + rep.activeTitles.map(t => t.split(' · ').slice(1).join(' · ')).join(', ')))
    if (rep.skippedDiskFull) copyLines.push(h('div', { class: 'meta' }, plural(rep.skippedDiskFull, 'video', 'videos') + ' skipped to keep disk space free'))
  }
  $('copiesCard').replaceChildren(
    S.settings
      ? switchRow(only.length ? 'Keep copies of ' + plural(only.length, 'followed source', 'followed sources') : 'Keep copies of everything I follow', sval('replicate'), on => saveSettings({ replicate: on, replicateSources: on ? only : [] }), { note: envNote('replicate') })
      : h('div', { class: 'hint' }, 'Sign in to change sharing.'),
    ...copyLines,
    h('div', { class: 'hint', style: 'margin-top:8px' }, 'Disk and speed limits are in ', h('a', { href: '#settings' }, 'Settings'), '.'))

  const mc = plugin('media-check')
  $('globalCard').replaceChildren(
    S.settings
      ? switchRow('Answer searches from other nodes', sval('globalSearch'), on => saveSettings({ globalSearch: on }), { note: envNote('globalSearch'), disabled: Boolean(st.privateRouting) })
      : h('div', { class: 'hint' }, 'Sign in to change sharing.'),
    mc.enabled && !st.privateRouting
      ? h('div', { class: 'stats' }, stat(String(mc.mediaFiles || 0), 'files offered'), stat(String(mc.checkedFiles || 0), 'files checked'))
      : null,
    st.privateRouting ? h('div', { class: 'hint' }, 'Off while private routing is on.') : null,
    h('div', { class: 'hint', style: 'margin-top:8px' }, 'Offers media this relay holds; each file is checked once.'))

  const hr = plugin('hiverelay-seed')
  const relays = sval('hiverelays') || []
  const lines = []
  if (S.settings) lines.push(switchRow('Find HiveRelays automatically', sval('hiverelayDiscover'), on => saveSettings({ hiverelayDiscover: on }), { note: envNote('hiverelayDiscover') }))
  if (hr.enabled) {
    lines.push(h('div', { class: 'stats' },
      stat(String((hr.p2pAcceptedRelays || []).length + (hr.configuredRelays || []).filter(r => r.pubkey).length), 'HiveRelays seeding'),
      stat(String(hr.httpPinnedCores || 0), 'videos pinned'),
      stat(String(hr.bulkPeers || 0), 'relays copying from you')))
    if (hr.servingViewers) lines.push(h('div', { class: 'msg' }, h('span', { class: 'tag ok' }, 'Serving viewers first')))
    if (hr.bulkPaused) lines.push(h('div', { class: 'msg' }, h('span', { class: 'tag warn' }, 'Seeding paused at the upload limit')))
  } else if (st.privateRouting) {
    lines.push(h('div', { class: 'hint' }, 'Off while private routing is on.'))
  }
  if (relays.length) {
    const running = new Map((hr.configuredRelays || []).map(r => [r.url.replace(/^https?:[/][/]/, '').replace(/[/]+$/, ''), r]))
    const later = S.settings.restartNeeded.includes('hiverelays')
    lines.push(h('div', { class: 'listedit', style: 'margin-top:10px' }, relays.map(r => h('div', { class: 'entry' }, h('span', null, r.label, ' ',
      h('span', { class: 'tag' + (running.get(r.label)?.pubkey ? ' ok' : '') }, later && !running.has(r.label) ? 'Not applied yet' : running.get(r.label)?.pubkey ? 'Seeding' : 'Not reached yet')),
      h('button', { class: 'btn quiet', onclick: e => act(e.currentTarget, () => saveSettings({ hiverelays: relays.filter(x => x !== r).map(x => x.ref) })) }, 'Remove')))))
  }
  $('hiveStatus').replaceChildren(...lines)
  $('hiveForm').hidden = !S.settings

  const origin = location.origin
  $('appsCard').replaceChildren(
    h('div', { class: 'setting' }, h('div', { class: 'what' }, h('span', { class: 'label' }, 'Stremio add-on'), h('span', { class: 'hint' }, 'Install this address in Stremio.')), copyBtn('Copy address', origin + '/manifest.json')),
    h('div', { class: 'setting' }, h('div', { class: 'what' }, h('span', { class: 'label' }, 'M3U playlist'), h('span', { class: 'hint' }, 'For VLC, Kodi and IPTV players.')), copyBtn('Copy address', origin + '/v1/playlist.m3u')))
}
$('hiveForm').onsubmit = async ev => {
  ev.preventDefault()
  const url = $('hiveInput').value.trim().replace(/[/]+$/, '')
  const key = $('hiveKey').value.trim()
  await act(ev.submitter, async () => {
    await saveSettings({ hiverelays: [...(sval('hiverelays') || []).map(r => r.ref), key ? url + '=' + key : url] })
    $('hiveInput').value = ''
    $('hiveKey').value = ''
    say('hiveMsg', 'Added. Seeding starts once it answers.')
  }, 'hiveMsg')
}

// ---- TV
$('pairForm').onsubmit = async ev => {
  ev.preventDefault()
  const val = $('pairInput').value.trim()
  await act(ev.submitter, async () => {
    const body = /^peartube:/i.test(val) ? { uri: val } : { code: val.toUpperCase() }
    const r = await api('/v1/cast/pair', { body })
    $('pairInput').value = ''
    say('pairMsg', 'Paired with ' + ((r && r.name) || 'the TV') + '.')
    loadCast()
  }, 'pairMsg')
}
function castControl (body) {
  return api('/v1/cast/control', { body }).then(s => { S.cast = s; renderCast() })
}
function castButtons () {
  const state = (S.cast && S.cast.session && S.cast.session.state) || {}
  const paused = state.paused === true || state.playing === false
  return [
    h('button', { class: 'btn', 'aria-label': 'Back 10 seconds', onclick: e => act(e.currentTarget, () => castControl({ action: 'skip', deltaMs: -10000 })) }, '-10s'),
    h('button', { class: 'btn primary', onclick: e => act(e.currentTarget, () => castControl({ action: 'togglePlay' })) }, paused ? 'Play' : 'Pause'),
    h('button', { class: 'btn', 'aria-label': 'Forward 10 seconds', onclick: e => act(e.currentTarget, () => castControl({ action: 'skip', deltaMs: 10000 })) }, '+10s'),
    h('button', { class: 'btn', onclick: e => act(e.currentTarget, async () => { S.cast = await api('/v1/cast/stop', { body: {} }); render() }) }, 'Stop')
  ]
}
function renderCastBar () {
  const session = S.cast && S.cast.session
  const bar = $('castBar')
  bar.hidden = !session || tab === 'tv'
  if (!session) return
  const state = session.state || {}
  bar.replaceChildren(h('div', { class: 'grow', style: 'min-width:0' }, h('div', { class: 'name' }, state.title || 'Casting'), h('div', { class: 'meta' }, 'on ' + session.receiverName)), ...castButtons())
}
function renderCast () {
  const c = S.cast
  const session = c && c.session
  $('castNow').hidden = !session
  if (session) {
    const state = session.state || {}
    const clock = state.durationMs ? fmtClock((state.positionMs || 0) / 1000) + ' / ' + fmtClock(state.durationMs / 1000) : ''
    $('castNow').replaceChildren(h('div', { class: 'label' }, 'Playing on ' + session.receiverName), h('h3', { style: 'margin:6px 0' }, state.title || 'Casting'), clock ? h('div', { class: 'meta' }, clock) : null, h('div', { class: 'row', style: 'margin-top:12px' }, castButtons()))
  }
  const tvs = (c && c.receivers) || []
  $('tvs').replaceChildren(...(tvs.length ? tvs.map(tv => h('div', { class: 'item' },
    h('div', { class: 'info' }, h('div', { class: 'name' }, tv.name || 'TV'), h('div', { class: 'meta' }, h('span', { class: tv.online ? 'tag ok' : 'tag' }, tv.online ? 'Online' : 'Offline'), ' ', tv.paired ? 'Paired' : 'Not paired', tv.host ? ' · ' + tv.host : '')),
    h('div', { class: 'acts' }, h('button', { class: 'btn quiet', onclick: e => act(e.currentTarget, async () => { await api('/v1/cast/receivers/' + encodeURIComponent(tv.id), { method: 'DELETE' }); loadCast() }) }, 'Forget')))) : [h('div', { class: 'empty' }, c ? 'No TVs yet. Pair one with its code.' : 'Casting is not available on this relay.')]))
  renderCastBar()
}

// ---- Settings
const GROUPS = [
  { title: 'Network', hint: 'How this relay is reached and who it talks to.', items: [
    { key: 'lan', label: 'Find peers on this network', hint: 'mDNS discovery on the LAN; needs both on the same Wi-Fi.' },
    { key: 'lanHost', label: 'Advertised LAN address', hint: 'Interface peers dial; picks Wi-Fi or Ethernet automatically.', ph: '192.168.1.20' },
    { key: 'dhtPort', label: 'Peer port (UDP)', hint: '0 picks a random port; fix it to forward through NAT.', ph: '49737' },
    { key: 'privateRouting', label: 'Private routing (2-hop guards)', hint: 'Routes your own traffic through two guards; no direct or LAN peers.' },
    { key: 'privateGuard', label: 'Help others route privately (guard)', hint: 'Forwards encrypted 2-hop traffic for others; your connections stay direct.' },
    { key: 'privateGuardPort', label: 'Guard port (UDP)', hint: '0 picks a random port; forward it so others reach it.', ph: '49738' },
    { key: 'relayThrough', label: 'Blind relays', hint: 'DHT relay keys that forward when both sides are behind NAT.', ph: '3a8f0c1e5b7d92f4a6c0e8b1d3f5a7c9e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2' },
    { key: 'bootstrap', label: 'DHT bootstrap nodes', hint: 'Leave empty to use the public HyperDHT bootstrap list.', ph: '88.99.3.86:49737' },
    { key: 'allowedPeers', label: 'Only connect to these peers', hint: 'Allowlist of peer keys; empty means anyone.', ph: '3a8f0c1e5b7d92f4a6c0e8b1d3f5a7c9e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2' }
  ] },
  { title: 'Library', hint: 'What it collects and publishes.', items: [
    { key: 'channel', label: 'Primary channel key', hint: '64-hex channel key this relay serves.', ph: 'bc7d85ea0eec017d3f6875b4c06c3c16091a50337b4d1709425e3bd35122fbeb' },
    { key: 'publishChannel', label: 'Publish new videos to my channel', hint: 'Off keeps this relay’s library private to itself.' },
    { key: 'directory', label: 'List followed channels in my directory', hint: 'Lets others discover the channels you follow.' },
    { key: 'acquireConcurrency', label: 'Concurrent downloads', hint: 'Each page download runs a ubit process; higher costs CPU.', ph: '4' },
    { key: 'cinemetaUrl', label: 'Title lookup service', hint: 'Matches titles to IMDb ids; supplies posters and backdrops.', ph: 'https://v3-cinemeta.strem.io' },
    { key: 'feeds', label: 'Mirrored catalogs (feeds)', hint: 'JSON list of titles and sources; another relay’s /v1/entries works.', ph: 'https://example.org/catalog.json' },
    // Only on relays with videos in the old format (or with the switch already on), like the Storage card.
    { key: 'rechunk', label: 'Convert old-format videos at every start', hint: 'Moves videos from the old shared storage into their own files.', when: () => plugin('blob-rechunk').running || plugin('blob-rechunk').remaining > 0 || sval('rechunk') }
  ] },
  { title: 'Sharing', hint: 'What it keeps for others.', items: [
    { key: 'replicate', label: 'Keep copies of what I follow', hint: 'Seeds followed content until the free-space floor is hit.' },
    { key: 'replicateFreeGb', label: 'Keep this much disk free (GB)', hint: 'Replication stops when free space reaches this.', ph: '20' },
    { key: 'replicateMbps', label: 'Copy speed limit (Mbps)', hint: '0 removes the limit; applies immediately.', ph: '80' },
    { key: 'globalSearch', label: 'Answer searches from other nodes', hint: 'Offers checked media this relay holds to global search.' },
    { key: 'hiverelayDiscover', label: 'Find HiveRelays automatically', hint: 'Uses a public discovery topic to recruit seeders.' },
    { key: 'hiverelays', label: 'HiveRelays', hint: 'Base URLs of seeding helpers that keep copies.', ph: 'http://192.168.1.50:9100' },
    { key: 'hiverelayApiKey', label: 'HiveRelay access key', hint: 'One key for every HiveRelay listed above.', ph: 'hr_4f1c2a9b7d' },
    { key: 'hiverelayReplicas', label: 'Copies per video on HiveRelays', hint: 'How many HiveRelays hold each video.', ph: '3' },
    { key: 'hiverelayUploadMbps', label: 'HiveRelay upload limit (Mbps)', hint: 'Caps seeding speed to helpers.', ph: '50' }
  ] },
  { title: 'Sources', hint: 'Music network account for album search.', items: [
    { key: 'slskUser', label: 'Account username', hint: 'Username used to sign in and search.', ph: 'coltrane_fan' },
    { key: 'slskPass', label: 'Account password', hint: 'Saved privately on this relay; never logged.', ph: 'correct-horse-battery' },
    { key: 'slskServer', label: 'Server address', hint: 'Host and port of the central server.', ph: 'vps.slsknet.org:2271' },
    { key: 'slskListenPort', label: 'Listen port', hint: 'Peers send files here; publish and forward this port.', ph: '50300' },
    { key: 'slskShare', label: 'Share my albums', hint: 'Lets other users browse and download your album folders.' },
    { key: 'slskShareMaxFiles', label: 'Most files to share', hint: 'Caps how many files other users can see.', ph: '2000' }
  ] }
]

const INPUT_TYPE = { host: 'text', hostport: 'text', text: 'text', port: 'number', number: 'number', key: 'text', path: 'text', url: 'url', secret: 'password' }
// Settings cards with unsaved edits, by title: redraws leave them alone, and saving one card redraws only that card.
const dirtyCards = new Set()

async function saveSettings (patch, card = null) {
  const reopens = Object.keys(patch).some(k => !setting(k).live)
  if (reopens) toast('Applying…')
  const r = await api('/v1/settings', { method: 'PUT', body: patch })
  S.settings = r
  if (r.warning) toast(r.warning)
  else toast(reopens && r.changed.length ? 'Saved and applied' : 'Saved')
  if (card) {
    dirtyCards.delete(card.dataset.group)
    const group = GROUPS.find(g => g.title === card.dataset.group)
    if (dirtyCards.size) card.replaceWith(settingsCard(group))
    else renderSettings(true)
  } else if (tab === 'settings') renderSettings()
  refresh()
  return r
}

// Reopens the node, jobs, plugins and cast stack in the relay's process; the page stays connected.
async function restartRelay () {
  toast('Restarting…')
  try {
    S.settings = await api('/v1/restart', { method: 'POST' })
    toast('Restarted')
    if (tab === 'settings') renderSettings()
  } finally {
    refresh()
  }
}

// Nothing on the Settings tab applies until its card's Save: switches, list edits and "Use PEARTUBE_..." go into
// the card's draft (key to value, or null to go back to the env value) beside the text fields.
function settingRow (item, draft) {
  const s = setting(item.key)
  if (!s) return null
  const id = 'set-' + item.key
  const changed = el => {
    const card = el.closest('.card')
    dirtyCards.add(card.dataset.group)
    card.querySelector('.save').disabled = false
  }
  const tags = [h('span', { class: 'tag ok' }, s.live ? 'Applies on save' : 'Applies on save, reconnects peers')]
  // A pending "Use PEARTUBE_…" is undone by any later edit of the same setting: the newest edit is what Save sends.
  let cancelReset = () => {}
  if (s.source === 'env') tags.push(h('span', { class: 'tag' }, 'From ' + s.env))
  else if (s.envSet) {
    tags.push(h('span', { class: 'tag' }, 'Overrides ' + s.env))
    const reset = h('button', { class: 'btn quiet' }, 'Use ' + s.env)
    const pending = h('span', { class: 'tag warn' }, 'Uses ' + s.env + ' after saving')
    reset.onclick = () => {
      draft.set(item.key, null)
      reset.replaceWith(pending)
      changed(what)
    }
    cancelReset = () => {
      if (draft.get(item.key) !== null) return
      draft.delete(item.key)
      pending.replaceWith(reset)
    }
    tags.push(reset)
  }
  if (item.key === 'privateGuard' && S.status.privateGuard) tags.push(h('span', { class: 'tag ok' }, 'Guarding on port ' + S.status.privateGuard.port))
  const what = h('div', { class: 'what' }, h('label', { for: id }, item.label), item.hint ? h('div', { class: 'hint' }, item.hint) : null, h('div', { class: 'row' }, tags))
  if (s.type === 'bool') {
    const input = h('input', { id, type: 'checkbox', role: 'switch', checked: Boolean(s.value) })
    input.onchange = () => {
      cancelReset()
      if (input.checked === Boolean(s.value)) draft.delete(item.key)
      else draft.set(item.key, input.checked)
      changed(input)
    }
    return h('div', { class: 'setting' }, what, h('div', { class: 'control narrow' }, h('span', { class: 'switch' }, input)))
  }
  if (s.type === 'keys' || s.type === 'hosts' || s.type === 'urls') {
    const shown = v => s.type === 'urls' ? v.label : v
    const kept = v => s.type === 'urls' ? v.ref : v
    let working = [...(s.value || [])]
    const entries = h('div')
    const draw = () => entries.replaceChildren(...working.map(v => h('div', { class: 'entry' }, h('span', null, shown(v)),
      h('button', { class: 'btn quiet', onclick: e => { working = working.filter(x => x !== v); edited(e.currentTarget) } }, 'Remove'))))
    const edited = el => {
      cancelReset()
      draft.set(item.key, working.map(kept))
      changed(el)
      draw()
    }
    draw()
    const input = h('input', { id, type: s.type === 'urls' ? 'url' : 'text', spellcheck: 'false', placeholder: item.ph })
    const add = h('button', { class: 'btn' }, 'Add')
    add.onclick = () => {
      const v = input.value.trim()
      if (!v) return
      working.push(s.type === 'urls' ? { ref: v, label: v } : v)
      input.value = ''
      edited(add)
    }
    input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); add.click() } }
    return h('div', { class: 'setting' }, what, h('div', { class: 'control listedit' }, entries,
      h('div', { class: 'row' }, h('span', { class: 'grow' }, input), add)))
  }
  const detected = item.key === 'lanHost' && S.status.lan ? S.status.lan.host : ''
  const input = h('input', { id, type: INPUT_TYPE[s.type] || 'text', placeholder: detected || item.ph, spellcheck: 'false', value: s.type === 'secret' ? '' : String(s.value ?? '') })
  if (s.type === 'port' || s.type === 'number') { input.min = '0'; input.step = 'any'; input.inputMode = 'numeric' }
  if (s.type === 'secret' && s.set) input.placeholder = 'Saved. Type to replace.'
  input.dataset.key = item.key
  input.oninput = () => {
    cancelReset()
    changed(input)
  }
  return h('div', { class: 'setting' }, what, h('div', { class: 'control' }, input))
}

function readField (input) {
  const s = setting(input.dataset.key)
  if (s.type === 'port' || s.type === 'number') return input.value === '' ? 0 : Number(input.value)
  return input.value.trim()
}

function settingsCard (g) {
  const draft = new Map()
  const card = h('div', { class: 'card' }, h('h3', null, g.title), g.hint ? h('div', { class: 'hint', style: 'margin:-2px 0 6px' }, g.hint) : null, g.items.filter(item => !item.when || item.when()).map(item => settingRow(item, draft)))
  card.dataset.group = g.title
  const save = h('button', { class: 'btn primary save', disabled: true }, 'Save changes')
  save.onclick = () => {
    const patch = Object.fromEntries(draft)
    for (const input of card.querySelectorAll('input[data-key]')) {
      if (draft.has(input.dataset.key)) continue
      const s = setting(input.dataset.key)
      const v = readField(input)
      if (s.type === 'secret' ? v !== '' : v !== s.value) patch[input.dataset.key] = v
    }
    if (Object.keys(patch).length) act(save, () => saveSettings(patch, card))
  }
  card.append(h('div', { class: 'row', style: 'margin-top:12px' }, save))
  return card
}

function renderSettings (force) {
  const body = $('settingsBody')
  if (!S.settings) {
    body.replaceChildren(h('div', { class: 'card' }, settingsLoaded && needsToken
      ? [h('h3', null, 'Sign in to see settings'), h('div', { class: 'hint' }, 'Use the access token above.')]
      : h('div', { class: 'hint' }, !settingsLoaded ? 'Loading…' : S.status.settingsOpen === false ? 'Over the internet, settings need the relay’s access token.' : 'Settings are not available on this relay.')))
    return
  }
  if (dirtyCards.size && !force) return
  dirtyCards.clear()
  settingsShown = JSON.stringify([S.settings, S.status.privateGuard ? S.status.privateGuard.port : 0])
  const blocks = []
  const pending = S.settings.restartNeeded
  if (pending.length) {
    const names = pending.map(k => (GROUPS.flatMap(g => g.items).find(i => i.key === k) || { label: k }).label)
    const again = h('button', { class: 'btn primary' }, 'Restart now')
    again.onclick = () => act(again, restartRelay)
    blocks.push(h('div', { class: 'banner' }, h('div', { class: 'label' }, plural(pending.length, 'change is', 'changes are') + ' not applied yet.'),
      h('div', { class: 'row', style: 'margin-top:8px' }, names.map(n => h('span', { class: 'tag' }, n)), again)))
  }
  for (const g of GROUPS) blocks.push(settingsCard(g))
  const rechunk = plugin('blob-rechunk')
  if (rechunk.running || rechunk.remaining > 0) {
    const done = (rechunk.migrated || 0) + (rechunk.deduped || 0)
    blocks.push(h('div', { class: 'card' }, h('h3', null, 'Storage'),
      h('div', { class: 'meta' }, rechunk.running ? 'Converting old-format videos: ' + done + ' of ' + rechunk.total : plural(rechunk.remaining, 'video uses', 'videos use') + ' the old storage format.'),
      rechunk.running ? h('div', { class: 'bar-track' }, h('div', { style: 'width:' + Math.round(done / Math.max(1, rechunk.total) * 100) + '%' })) : null,
      h('div', { class: 'row', style: 'margin-top:12px' },
        h('button', { class: 'btn primary', disabled: Boolean(rechunk.running), onclick: e => act(e.currentTarget, async () => { api('/v1/plugins/blob-rechunk/run', { body: { foreground: true } }).then(refresh, err => toast(err.message)); toast('Converting now'); setTimeout(refresh, 500) }) }, 'Convert now'))))
  }
  blocks.push(h('div', { class: 'card' }, h('h3', null, 'Access'),
    h('div', { class: 'row' }, h('span', { class: 'grow hint' }, token ? 'Signed in on this browser.' : 'No token needed on this relay.'),
      token ? h('button', { class: 'btn', onclick: () => { token = ''; localStorage.removeItem('peartube.token'); location.reload() } }, 'Sign out') : null),
    h('div', { class: 'row', style: 'margin-top:12px' }, h('span', { class: 'grow hint' }, 'Reopens peers, downloads and plugins in a few seconds.'),
      h('button', { class: 'btn', onclick: e => act(e.currentTarget, restartRelay) }, 'Restart relay'))))
  body.replaceChildren(...blocks)
}

$('authForm').onsubmit = async ev => {
  ev.preventDefault()
  const prev = token
  token = $('tokenInput').value.trim()
  try {
    S.settings = await api('/v1/settings')
    localStorage.setItem('peartube.token', token)
    needsToken = false
    $('authForm').hidden = true
    $('tokenInput').value = ''
    say('authMsg', '')
    renderSettings(true)
    refresh()
  } catch {
    token = prev
    say('authMsg', 'That token did not work.', true)
  }
}

showTab()
// Settings need the token: ask for it first instead of probing with a request that fails.
refresh().then(() => {
  if (S.status.tokenRequired && !token) {
    needsToken = true
    settingsLoaded = true
    $('authForm').hidden = false
    render()
    if (tab === 'settings') renderSettings()
  } else if (S.status.settingsOpen === false) {
    settingsLoaded = true
    render()
    if (tab === 'settings') renderSettings()
  } else loadSettings()
})
loadCast()
const events = new EventSource('/v1/events')
// Left open, each visit's stream keeps a connection to the relay; after six reloads the browser has none left.
addEventListener('pagehide', () => events.close())
events.onmessage = ev => {
  let event = 'update'
  try { event = JSON.parse(ev.data).event } catch {}
  if (event === 'cast') loadCast()
  else {
    soon()
    askGlobal().catch(() => {})
  }
}
setInterval(() => {
  const busy = S.jobs.some(j => j.status === 'running' || j.status === 'queued' || j.status === 'transferring' || j.status === 'announcing') || plugin('p2p-replicate').replicating || plugin('blob-rechunk').running
  if (busy || document.visibilityState === 'visible') refresh()
}, 4000)
setInterval(() => { if (tab === 'tv' || (S.cast && S.cast.session)) loadCast() }, 5000)

// In-browser peartube-media WebAssembly player: demuxes MKV/AVI/MP4/TS over same-origin HTTP Range,
// hardware-accelerates H.264/HEVC via fMP4 MSE when supported, falls back to WASM SIMD software video,
// and decodes surround AC-3/DTS/TrueHD/Opus/MP3 + SRT/ASS/PGS subtitles straight in the browser.
// Track menus name languages and layouts ("English · 5.1 · TrueHD"); a number tells same-named tracks apart.
const CODEC_NAMES = { eac3: 'E-AC-3', ac3: 'AC-3', truehd: 'TrueHD', dts: 'DTS', aac: 'AAC', opus: 'Opus', flac: 'FLAC', mp3: 'MP3', vorbis: 'Vorbis', pcm_s16le: 'PCM', hdmv_pgs_subtitle: 'PGS', pgs: 'PGS', dvd_subtitle: 'DVD', dvdsub: 'DVD' }
function languageName (code) {
  if (!code || code === 'und') return ''
  try { return new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' }).of(code) || code } catch { return code }
}
function trackLabels (tracks, kind) {
  const layout = n => n === 1 ? 'Mono' : n === 2 ? 'Stereo' : n === 6 ? '5.1' : n === 8 ? '7.1' : n ? n + ' channels' : ''
  const labels = tracks.map((t, i) => [languageName(t.language) || (kind === 'audio' ? 'Audio ' : 'Subtitles ') + (i + 1),
    kind === 'audio' ? layout(t.channels) : '', CODEC_NAMES[t.codec] && (kind === 'audio' || /pgs|dvd/i.test(t.codec)) ? CODEC_NAMES[t.codec] : ''].filter(Boolean).join(' · '))
  const total = {}
  for (const l of labels) total[l] = (total[l] || 0) + 1
  const seen = {}
  return labels.map(l => total[l] > 1 ? l + ' (' + (seen[l] = (seen[l] || 0) + 1) + ')' : l)
}
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

// GPU BT.709 / BT.601 / BT.2020 YUV420P WebGL renderer: uploads planar Y/U/V straight to textures in ~0.15ms with zero CPU color conversion.
let yuvGl = null
function getYuvGl () {
  if (yuvGl !== null) return yuvGl
  const c = $('pGlCanvas')
  const gl = c.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false }) ||
    c.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false })
  if (!gl) { yuvGl = false; return false }
  const vs = gl.createShader(gl.VERTEX_SHADER)
  gl.shaderSource(vs, 'precision highp float;attribute vec2 a_pos;varying vec2 v_uv;uniform vec4 u_crop;void main(){vec2 uv=vec2(a_pos.x*0.5+0.5,0.5-a_pos.y*0.5);v_uv=mix(u_crop.xy,u_crop.zw,uv);gl_Position=vec4(a_pos,0.0,1.0);}')
  gl.compileShader(vs)
  const fs = gl.createShader(gl.FRAGMENT_SHADER)
  const fsPrec = gl.getShaderPrecisionFormat?.(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT)?.precision ? 'precision highp float;' : 'precision mediump float;'
  gl.shaderSource(fs, fsPrec + 'varying vec2 v_uv;uniform int u_mode;uniform int u_matrix;uniform int u_full;uniform sampler2D u_y;uniform sampler2D u_u;uniform sampler2D u_v;void main(){if(u_mode==1){gl_FragColor=vec4(texture2D(u_y,v_uv).rgb,1.0);return;}float y=texture2D(u_y,v_uv).r;float u=texture2D(u_u,v_uv).r-(128.0/255.0);float v=texture2D(u_v,v_uv).r-(128.0/255.0);if(u_full==0){y=(y-(16.0/255.0))*(255.0/219.0);u*=255.0/224.0;v*=255.0/224.0;}vec3 rgb;if(u_matrix==1){rgb=vec3(y+1.402*v,y-0.34413629*u-0.71413629*v,y+1.772*u);}else if(u_matrix==2){rgb=vec3(y+1.4746*v,y-0.16455313*u-0.57135313*v,y+1.8814*u);}else{rgb=vec3(y+1.5748*v,y-0.18732427*u-0.46812427*v,y+1.8556*u);}gl_FragColor=vec4(clamp(rgb,0.0,1.0),1.0);}')
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
  const modeLoc = gl.getUniformLocation(prog, 'u_mode')
  const matrixLoc = gl.getUniformLocation(prog, 'u_matrix')
  const fullLoc = gl.getUniformLocation(prog, 'u_full')
  const cropLoc = gl.getUniformLocation(prog, 'u_crop')
  gl.uniform1i(modeLoc, 0)
  gl.uniform1i(matrixLoc, 0)
  gl.uniform1i(fullLoc, 0)
  gl.uniform4f(cropLoc, 0, 0, 1, 1)
  yuvGl = { gl, canvas: c, texY, texU, texV, modeLoc, matrixLoc, fullLoc, cropLoc, mode: 0, matrix: 0, full: 0, cs: 'srgb', w: 0, h: 0 }
  return yuvGl
}

function audioOutTime (ctx) {
  if (!ctx) return 0
  const ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null
  return (ts && ts.contextTime > 0) ? ts.contextTime : ctx.currentTime
}
// One shared WASM Worker, compiled when a Play button is about to be used, so playback opens without a compile wait.
const ASSET_VER = ${JSON.stringify(ASSET_VER)}
let sharedWorker = null
let workerWarm = false
let streamBlockBytes = 0
function showStatus (text, isErr = false) {
  const el = $('pStatus')
  el.classList.toggle('err', Boolean(isErr))
  el.textContent = text
  el.style.display = 'inline-flex'
}
function hideStatus () {
  const el = $('pStatus')
  el.classList.remove('err')
  el.style.display = 'none'
  $('pBackdrop')?.classList.remove('vis')
}
function nowWallMs () { return (performance.timeOrigin || 0) + performance.now() }
function getWorker () {
  if (!sharedWorker) {
    sharedWorker = new Worker('/web/player-worker.js' + ASSET_VER)
    sharedWorker.onmessage = ev => {
      if (ev.data?.type === 'warm') workerWarm = true
      if (ev.data?.streamBlock) streamBlockBytes = ev.data.streamBlock
    }
    // The Worker's OffscreenCanvas renderer dropped pictures on long titles (18 fps on Batman's
    // VC-1 where this page-side GL holds 24). Keep the canvas here and let the worker post frames.
    sharedWorker.postMessage({ cmd: 'warmup', wasmUrl: location.origin + '/web/peartube_web.wasm' + ASSET_VER })
  }
  return sharedWorker
}
// Warm the WASM engine as soon as a title tile or Play button is approached so it's compiled before Play is clicked.
for (const evName of ['pointerover', 'focusin', 'touchstart', 'click']) {
  addEventListener(evName, ev => {
    if (!sharedWorker && ev.target.closest && ev.target.closest('[data-play], [data-tile]')) { try { getWorker() } catch {} }
  }, { passive: true })
}

let openCounter = 0
let chromeTimer = 0
function showPlayerChrome () {
  const modal = $('playerModal')
  modal.classList.remove('chrome-hidden')
  clearTimeout(chromeTimer)
  if (player && !player.paused && !modal.classList.contains('mini')) {
    chromeTimer = setTimeout(() => {
      if (player && !player.paused && !modal.classList.contains('mini') && !modal.matches(':focus-within')) {
        modal.classList.add('chrome-hidden')
      }
    }, 3000)
  }
}
function setMiniPlayer (mini) {
  if (!player) return
  if (mini && document.fullscreenElement) document.exitFullscreen().catch(() => {})
  const modal = $('playerModal')
  modal.classList.toggle('mini', mini)
  modal.setAttribute('aria-modal', String(!mini))
  modal.classList.remove('chrome-hidden')
  if (!mini) showPlayerChrome()
}

function closePlayer () {
  if (!player) return
  clearTimeout(seekTimer)
  clearTimeout(chromeTimer)
  $('playerModal').classList.remove('mini', 'chrome-hidden')
  $('playerModal').setAttribute('aria-modal', 'true')
  seekTarget = null
  const p = player
  player = null
  $('playerModal').classList.remove('open')
  cancelAnimationFrame(p.raf)
  clearInterval(p.creditTimer)
  clearInterval(p.frameTimer)
  if (p.prefetchInFlight) { for (const ctl of p.prefetchInFlight.values()) { try { ctl.abort() } catch {} } p.prefetchInFlight.clear() }
  try { p.worker?.postMessage({ cmd: 'close' }) } catch {}
  while (p.swFrames?.length > 0) p.releaseFrame?.(p.swFrames.shift())
  for (const s of p.audioNodes) { try { s.node.stop(); s.node.disconnect() } catch {} }
  try { p.audioCtx?.close() } catch {}
  const v = $('pVideo')
  v.pause()
  v.removeAttribute('src')
  v.load()
  if (p.msUrl) { try { URL.revokeObjectURL(p.msUrl) } catch {} }
  $('pSubText').textContent = ''
  $('pBackdrop').style.backgroundImage = ''
  $('pBackdrop').classList.remove('vis')
  const sc = $('pSubCanvas')
  sc.getContext('2d').clearRect(0, 0, sc.width, sc.height)
  if (refreshQueued) { refreshQueued = false; setTimeout(refresh, 50) }
}

function openPlayer (entry, at = 0) {
  closePlayer()
  // One sound at a time: a film or a clip pauses the album, which stays on its bar to resume after.
  if (audioEl && !audioEl.paused) audioEl.pause()
  playerEntry = entry
  const streamUrl = resolveStreamUrl(entry.streamUrl)
  const worker = getWorker()
  $('pTitle').textContent = entry.title || entry.id
  $('pDownloadBtn').href = downloadHref(entry)
  $('pBadge').textContent = workerWarm ? 'Opening…' : 'Loading player…'
  $('pRawLink').href = streamUrl
  showStatus(workerWarm ? 'Opening stream…' : 'Loading player…')
  const imdbId = (entry.id && (entry.id.match(/^imdb:(tt[0-9]+)/) || [])[1]) || null
  const cachedArt = imdbId ? [...document.querySelectorAll('#detail img.poster, #entries img.poster')].find(i => i.complete && i.naturalWidth > 0 && i.src.includes(imdbId)) : null
  if (cachedArt?.currentSrc) {
    $('pBackdrop').style.backgroundImage = 'url(' + JSON.stringify(cachedArt.currentSrc) + ')'
    $('pBackdrop').classList.add('vis')
  }
  $('pSubText').textContent = ''
  $('pPlayBtn').textContent = 'Pause'
  $('pSeek').value = '0'
  $('pClock').textContent = '0:00 / 0:00'
  $('pMiniSeek').value = '0'
  $('pMiniClock').textContent = '0:00 / 0:00'
  $('playerModal').classList.remove('mini', 'chrome-hidden')
  $('playerModal').setAttribute('aria-modal', 'true')
  $('playerModal').classList.add('open')
  showPlayerChrome()

  // Each decoded chunk becomes its own AudioBufferSourceNode. If its sample rate differs from the context's, the browser
  // resamples every 20–30 ms buffer on its own and the edges click; matching the rate leaves one resampler at the output.
  // Most film audio is 48 kHz; the first chunk switches the context if this stream differs.
  const AudioCtx = window.AudioContext || window.webkitAudioContext
  function makeAudio (rate) {
    if (!AudioCtx) return { audioCtx: null, gainNode: null }
    let ctx
    try { ctx = new AudioCtx({ sampleRate: rate }) } catch { ctx = new AudioCtx() }
    const gain = ctx.createGain()
    gain.gain.value = ($('pMuteBtn').dataset.muted === '1') ? 0 : (Number($('pVol').value) / 100)
    gain.connect(ctx.destination)
    ctx.resume?.().catch(() => {})
    return { audioCtx: ctx, gainNode: gain }
  }
  const { audioCtx, gainNode } = makeAudio(48000)

  const seq = ++openCounter
  const initialAt = Math.max(0, Number(at) || 0)
  const p = {
    entry,
    startAt: initialAt,
    streamUrl,
    worker,
    audioCtx,
    gainNode,
    pendingAudio: [],
    audioNodes: [],
    nextAudioCtxTime: 0,
    audioBaseMedia: initialAt,
    audioBaseCtx: 0,
    audioStarted: false,
    freeBaseMedia: initialAt,
    freeBasePerf: performance.now(),
    primed: false,
    rebuffering: false,
    paused: false,
    seeking: false,
    seq,
    manifest: null,
    videoStream: -1,
    audioStream: -1,
    subStream: -1,
    videoCrop: null,
    lastReadBlock: -1,
    prefetchInFlight: new Map(),
    prefetchDone: new Set(),
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
  showPlayerChrome()

  const canvas = $('pCanvas')
  const glCanvas = $('pGlCanvas')
  const ctx2d = canvas.getContext('2d', { alpha: false, desynchronized: true }) || canvas.getContext('2d')
  const subCanvas = $('pSubCanvas')
  const subCtx = subCanvas.getContext('2d')
  const video = $('pVideo')

  function currentMediaTime () {
    if (!p.primed || p.paused || p.rebuffering) return p.freeBaseMedia
    if (p.audioStream >= 0 && p.audioCtx && p.audioStarted && p.audioCtx.state === 'running' && p.audioNodes.length > 0) {
      const outT = audioOutTime(p.audioCtx)
      for (const a of p.audioNodes) {
        if (outT >= a.startCtx && outT <= a.endCtx) {
          p.audioBaseMedia = a.pts + (outT - a.startCtx)
          p.audioBaseCtx = outT
          break
        }
      }
      const lastEnd = p.audioNodes[p.audioNodes.length - 1].endCtx
      if (outT >= p.audioBaseCtx && outT <= lastEnd + 0.08) {
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
  p.currentMediaTime = currentMediaTime

  function recycleVideoBuf (buf) {
    if (buf && buf.byteLength > 0) {
      try { worker.postMessage({ cmd: 'recycleVideo', buf }, [buf]) } catch {}
    }
  }
  function releaseFrame (f) {
    if (!f) return
    if (f.hwFrame) {
      try { f.hwFrame.close() } catch {}
      f.hwFrame = null
      try { worker.postMessage({ cmd: 'releaseHwFrame', seq: f.seq }) } catch {}
    }
    if (f.buf) { recycleVideoBuf(f.buf); f.buf = null }
  }
  p.releaseFrame = releaseFrame
  function effectiveHidden () {
    return document.visibilityState !== 'visible' || Boolean(p.windowOccluded)
  }
  function syncWorkerClock (timeSecs, playing, extra = null) {
    const pf = performance.now()
    const b0 = (p.useMse && video.buffered.length > 0) ? (p.rebuffering ? mseActiveStart(p.freeBaseMedia) : video.buffered.start(0)) : -1
    const bEnd = (p.useMse && video.buffered.length > 0) ? video.buffered.end(video.buffered.length - 1) : -1
    const mseStalled = Boolean(p.useMse && p.lastMseAdvanceWall && (pf - p.lastMseAdvanceWall) > 650)
    const canHardSync = Boolean(p.audioStarted && !video.seeking && (p.lastHardSync === 0 || (pf - p.lastHardSync) > 1200))
    try {
      worker.postMessage({
        cmd: 'clock',
        time: timeSecs,
        wallMs: nowWallMs(),
        playing,
        hidden: effectiveHidden(),
        vt: p.useMse ? video.currentTime : undefined,
        b0,
        bEnd,
        readyState: p.useMse ? video.readyState : 0,
        mseStalled,
        canHardSync,
        duration: p.duration || 0,
        rebuffering: Boolean(p.rebuffering),
        mseBufferedAhead: p.useMse ? mseBufferedAhead(p.freeBaseMedia) : 0,
        audioQueuedAhead: queuedAudioAheadSec(),
        ...extra
      })
    } catch {}
  }
  p.syncWorkerClock = syncWorkerClock
  function scheduleAudioChunk (m) {
    if (p.audioCtx && !p.audioStarted && m.rate > 0 && m.rate !== p.audioCtx.sampleRate) {
      const prev = p.audioCtx
      Object.assign(p, makeAudio(m.rate))
      try { prev.close() } catch {}
    }
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
    if (!p.audioStarted || (p.audioNodes.length === 0 && !p.rebuffering)) {
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

  function pendingAudioSec () {
    let s = 0
    for (const m of p.pendingAudio) s += m.samples / (m.rate || 48000)
    return s
  }
  function queuedAudioAheadSec () {
    if (!p.audioCtx || p.audioNodes.length === 0) return 0
    const last = p.audioNodes[p.audioNodes.length - 1]
    return Math.max(0, last.endCtx - p.audioCtx.currentTime)
  }
  function mseBufferedAhead (atTime) {
    if (!p.sb) return 0
    let best = 0
    for (let i = 0; i < p.sb.buffered.length; i++) {
      const bs = p.sb.buffered.start(i), be = p.sb.buffered.end(i)
      if (atTime + 0.35 >= bs && atTime <= be + 0.05) {
        best = Math.max(best, be - Math.max(atTime, bs))
      }
    }
    return best
  }
  p.mseBufferedAhead = mseBufferedAhead
  function mseActiveStart (atTime) {
    if (!p.sb || p.sb.buffered.length === 0) return -1
    for (let i = 0; i < p.sb.buffered.length; i++) {
      const bs = p.sb.buffered.start(i), be = p.sb.buffered.end(i)
      if (atTime + 0.35 >= bs && atTime <= be + 0.05) return bs
    }
    return p.sb.buffered.start(0)
  }
  function enterRebuffer () {
    if (p.rebuffering || !p.primed || p.paused || p.seeking || p.eof || !p.useMse) return
    p.rebuffering = true
    const hold = video.currentTime > 0 ? video.currentTime : p.freeBaseMedia
    p.freeBaseMedia = hold
    p.freeBasePerf = performance.now()
    video.pause()
    p.audioCtx?.suspend?.().catch(() => {})
    syncWorkerClock(hold, !p.paused)
    showStatus('Buffering…')
    pumpPrefetch(p)
  }
  function maybeExitRebuffer () {
    if (!p.rebuffering || player !== p) return
    syncWorkerClock(p.freeBaseMedia, !p.paused)
  }
  function applyRebufferExit (snapTo) {
    if (!p.rebuffering || player !== p) return
    p.rebuffering = false
    hideStatus()
    p.freeBasePerf = performance.now()
    p.lastMseAdvanceWall = p.freeBasePerf
    if (typeof snapTo === 'number' && snapTo >= 0) {
      try { video.currentTime = snapTo; p.freeBaseMedia = snapTo; p.lastMseTime = snapTo } catch {}
    }
    if (!p.paused) {
      if (p.audioCtx) {
        p.audioCtx.resume().then(() => {
          if (player === p && !p.paused && !p.rebuffering) {
            p.audioBaseMedia = p.freeBaseMedia
            p.audioBaseCtx = p.audioCtx.currentTime
            syncWorkerClock(p.freeBaseMedia, true)
          }
        }).catch(() => {})
      }
      video.play().catch(() => {})
      syncWorkerClock(p.freeBaseMedia, true)
    }
  }

  function tryPrime () {
    if (p.primed || !p.manifest) return
    const rules = p.manifest.rules
    const minSwFrames = rules?.minSwPrimeFrames ?? 2
    const minAudioSec = rules?.minAudioPrimeSec ?? 0.01
    const vReady = p.videoStream < 0 || (p.useMse ? (p.mseReady && video.readyState >= 2) : (p.workerGlPrimed || p.drawnFrames >= 1 || p.swFrames.length >= minSwFrames)) || p.eof
    const aReady = p.audioStream < 0 || pendingAudioSec() >= minAudioSec || p.eof
    if (!vReady || !aReady) return
    p.primed = true
    hideStatus()
    p.freeBasePerf = performance.now()
    while (p.pendingAudio.length > 0) scheduleAudioChunk(p.pendingAudio.shift())
    if (p.useMse && !p.paused) {
      p.lastMseTime = video.currentTime
      video.play().catch(() => {})
    }
    syncWorkerClock(currentMediaTime(), !p.paused)
  }

  video.onloadeddata = () => { if (player === p) { $('pBackdrop')?.classList.remove('vis'); tryPrime() } }
  video.oncanplay = () => { if (player === p) { $('pBackdrop')?.classList.remove('vis'); tryPrime() } }

  function resetMediaOutputs (targetSecs) {
    for (const s of p.audioNodes) { try { s.node.stop(); s.node.disconnect() } catch {} }
    p.audioNodes.length = 0
    p.pendingAudio.length = 0
    p.nextAudioCtxTime = 0
    p.audioStarted = false
    p.primed = false
    p.rebuffering = false
    p.returnSyncPending = false
    p.audioBaseMedia = targetSecs
    p.freeBaseMedia = targetSecs
    p.freeBasePerf = performance.now()
    while (p.swFrames.length > 0) releaseFrame(p.swFrames.shift())
    p.videoCrop = null
    p.workerGlPrimed = false
    p.lastSwPts = null
    p.lastDrawWall = 0
    p.lastHardSync = 0
    p.consumedVideoSec = 0
    p.consumedAudioSec = 0
    p.subCues.length = 0
    $('pSubText').textContent = ''
    subCtx.clearRect(0, 0, subCanvas.width, subCanvas.height)
    if (p.useMse) setupMse(targetSecs)
  }
  p.resetMediaOutputs = resetMediaOutputs

  function finalizeMsePrimeIfReady () {
    if (!p.useMse || p.mseReady || !p.sb || p.ms?.readyState !== 'open' || p.sb.buffered.length === 0) return
    const bStart = p.sb.buffered.start(0)
    const bEnd = p.sb.buffered.end(p.sb.buffered.length - 1)
    // Wait until buffered segments actually reach the target timestamp inside a long GOP (or EOF)
    const minMseLead = p.manifest?.rules?.minMsePrimeLeadSec ?? 0.04
    if (bEnd >= p.mseStartAt + minMseLead || (p.eof && !p.sb.updating && p.mseQueue.length === 0)) {
      p.mseReady = true
      const snap = Math.max(bStart, Math.min(p.mseStartAt, bEnd > bStart + 0.02 ? bEnd - 0.02 : bStart))
      video.currentTime = snap
      p.lastMseTime = snap
      p.lastHardSync = 0
      tryPrime()
    }
  }

  function setupMse (startAt) {
    video.pause()
    video.playbackRate = 1
    if (p.msUrl) { try { URL.revokeObjectURL(p.msUrl) } catch {} p.msUrl = '' }
    p.mseQueue.length = 0
    p.mseKeyframes = []
    p.sb = null
    p.mseReady = false
    p.mseStartAt = startAt
    const MS = window.MediaSource || window.ManagedMediaSource
    if (!MS || !p.manifest?.mseType) { fallbackSw(startAt); return }
    const mime = p.manifest.mseType
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
          finalizeMsePrimeIfReady()
          maybeExitRebuffer()
          drainMseQueue()
          if (p.pendingReturnSnap && !p.sb.updating && p.mseQueue.length === 0) {
            p.pendingReturnSnap = false
            resyncOnReturn()
          }
        })
        drainMseQueue()
      } catch {
        fallbackSw(currentMediaTime())
      }
    }, { once: true })
  }

  function safeMseEvictCut (now, keepBehind) {
    if (!p.sb || p.sb.buffered.length === 0) return 0
    const b0 = p.sb.buffered.start(0)
    const bEnd = p.sb.buffered.end(p.sb.buffered.length - 1)
    const maxSafe = (typeof p.rustMaxEvictCap === 'number' && p.rustMaxEvictCap > 0) ? p.rustMaxEvictCap : (now - Math.max(keepBehind, 10))
    const cut = Math.min(bEnd - 0.5, now - keepBehind, maxSafe)
    return cut > b0 + 0.2 ? cut : 0
  }
  p.safeMseEvictCut = safeMseEvictCut

  function applyMseEvict (cut) {
    if (!p.sb || p.ms?.readyState !== 'open' || p.sb.updating || p.sb.buffered.length === 0 || !(cut > 0)) return false
    const b0 = p.sb.buffered.start(0)
    const bEnd = p.sb.buffered.end(p.sb.buffered.length - 1)
    if (cut <= b0 + 0.2) return false
    const now = p.primed ? currentMediaTime() : p.mseStartAt
    if (video.currentTime < cut + 0.5) {
      try { video.currentTime = Math.min(Math.max(b0, bEnd - 0.25), Math.max(cut + 0.5, now - 0.5)) } catch {}
    }
    try { p.sb.remove(0, cut); return true } catch { return false }
  }

  function drainMseQueue () {
    if (!p.sb || p.ms?.readyState !== 'open' || p.sb.updating) return
    if (p.pendingEvictTo > 0) {
      const cut = p.pendingEvictTo
      p.pendingEvictTo = 0
      if (applyMseEvict(cut)) return
    }
    if (p.mseQueue.length > 0) {
      const buf = p.mseQueue.shift()
      try {
        p.sb.appendBuffer(buf)
      } catch (err) {
        // High-bitrate 4K remuxes can brush SourceBuffer QuotaExceededError on bitrate spikes; ask Rust
        // (pt_ctrl_evict_cut / rustMaxEvictCap) for the keyframe-safe cutoff instead of removing activeKf.
        if (err?.name === 'QuotaExceededError') {
          buf.__retries = (buf.__retries || 0) + 1
          if (p.sb.buffered.length > 0 && buf.__retries <= 4) {
            const now = p.primed ? currentMediaTime() : p.mseStartAt
            const keepBehind = Math.max(1.5, 5 - buf.__retries)
            const b0 = p.sb.buffered.start(0)
            const bEnd = p.sb.buffered.end(p.sb.buffered.length - 1)
            p.worker?.postMessage({ cmd: 'evictCut', now, keepBehind, b0, bEnd })
            const cut = safeMseEvictCut(now, keepBehind)
            if (cut > 0) {
              p.mseQueue.unshift(buf)
              if (applyMseEvict(cut)) return
            }
          }
          if (p.primed) {
            if (p.mseQueue.length < 24) p.mseQueue.unshift(buf)
            setTimeout(() => { if (player === p) drainMseQueue() }, 250)
            return
          }
        }
        fallbackSw(currentMediaTime())
      }
    }
  }
  p.drainMseQueue = drainMseQueue

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
    p.allowWebCodecs = Boolean(p.manifest?.webCodecs && p.webCodecsSupported)
    p.usingWebCodecs = p.allowWebCodecs
    updateBadge()
    p.seq = ++openCounter
    resetMediaOutputs(atSecs)
    p.worker.postMessage({ cmd: 'seek', seq: p.seq, time: atSecs, videoStream: p.videoStream, audioStream: p.audioStream, subStream: p.subStream, useMse: false, allowWebCodecs: p.allowWebCodecs })
  }
  video.onerror = () => { if (player === p && p.useMse) fallbackSw(currentMediaTime()) }

  function updateBadge () {
    if (!p.manifest) return
    const vt = p.manifest.tracks.find(t => t.stream === p.videoStream)
    const at = p.manifest.tracks.find(t => t.stream === p.audioStream)
    const parts = [p.manifest.container]
    if (vt) {
      const hasGpu = Boolean(getYuvGl())
      const tag = p.useMse ? ' (MSE+WASM)' : (p.usingWebCodecs ? ' (WebCodecs+WASM)' : (hasGpu ? ' (WASM+GPU)' : ' (WASM)'))
      parts.push(vt.codec + tag)
    }
    if (at) parts.push(at.codec)
    $('pBadge').textContent = parts.join(' \\u00b7 ')
  }
  p.updateBadge = updateBadge

  worker.onerror = err => {
    if (player !== p) return
    showStatus('Worker error: ' + (err?.message || 'failed'), true)
  }
  worker.onmessage = ev => {
    if (player !== p) return
    const m = ev.data || {}
    if (m.type === 'warm') { workerWarm = true; if (m.streamBlock) streamBlockBytes = m.streamBlock; return }
    if (m.seq && m.seq !== p.seq) return
    if (m.type === 'stage') {
      if (!p.primed && m.status) showStatus(m.status)
      return
    }
    if (m.type === 'error') {
      showStatus('Playback error: ' + m.error, true)
      $('pBadge').textContent = 'Can’t play this file'
      return
    }
    if (m.type === 'manifest') {
      if (m.streamBlock) streamBlockBytes = m.streamBlock
      const mf = m.manifest
      p.manifest = mf
      p.duration = mf.duration || 0
      if (p.duration > 0) {
        const initClk = fmtClock(p.startAt) + ' / ' + fmtClock(p.duration)
        $('pClock').textContent = initClk
        $('pMiniClock').textContent = initClk
      }
      if (!p.primed) showStatus('Starting playback…')
      p.videoStream = mf.defaultVideo ?? -1
      p.audioStream = mf.defaultAudio ?? -1
      const subs = mf.tracks.filter(t => t.kind === 'subtitle')
      const auds = mf.tracks.filter(t => t.kind === 'audio')
      p.subStream = -1

      const aSel = $('pAudioSel')
      const audLabels = trackLabels(auds, 'audio')
      const subLabels = trackLabels(subs, 'subtitle')
      aSel.replaceChildren(...(auds.length ? auds.map((t, i) => {
        const o = el('option', null, audLabels[i])
        o.value = String(t.stream)
        if (t.stream === p.audioStream) o.selected = true
        return o
      }) : [Object.assign(el('option', null, 'No Audio'), { value: '-1' })]))
      aSel.disabled = auds.length <= 1

      const sSel = $('pSubSel')
      const offOpt = el('option', null, 'Subtitles off'); offOpt.value = '-1'
      sSel.replaceChildren(offOpt, ...subs.map((t, i) => {
        const o = el('option', null, subLabels[i])
        o.value = String(t.stream)
        return o
      }))
      sSel.disabled = subs.length === 0

      p.webCodecsSupported = Boolean(m.webCodecsSupported)
      const MS = window.MediaSource || window.ManagedMediaSource
      // A music file has no video track, so the fast path is gated on the manifest's own MIME type, not on a
      // video stream: an audio-only manifest still plays through MSE, while a video one needs its video track.
      p.mseSupported = Boolean(mf.mseType && MS && MS.isTypeSupported(mf.mseType) && (p.videoStream >= 0 || mf.defaultAudio >= 0))
      // Prefer MSE (<video>) first whenever supported so macOS/iOS promote directly to AVSampleBufferDisplayLayer
      // (native BT.709/BT.1886 colors, 10-bit P010/HDR, zero per-frame JS copy). Fall back to WebCodecs -> WASM+GPU.
      p.useMse = Boolean(p.mseSupported)
      p.allowWebCodecs = Boolean(!p.useMse && p.videoStream >= 0 && p.webCodecsSupported)
      p.usingWebCodecs = p.allowWebCodecs
      if (p.useMse) {
        setupMse(p.startAt)
      } else {
        video.style.display = 'none'
        glCanvas.style.display = Boolean(getYuvGl()) ? 'block' : 'none'
        canvas.style.display = 'none'
      }
      updateBadge()
      if (p.startAt > 0) {
        for (const ctl of p.prefetchInFlight.values()) { try { ctl.abort() } catch {} }
        p.prefetchInFlight.clear()
        p.prefetchDone.clear()
        p.lastReadBlock = -1
      } else {
        // probeStream already cached block 0 without HTTP/1.1 socket contention; now stream blocks 1..N ahead while start runs.
        p.prefetchDone.add(0)
        p.lastReadBlock = 1
        pumpPrefetch(p)
      }
      worker.postMessage({ cmd: 'start', seq: p.seq, time: p.startAt, videoStream: p.videoStream, audioStream: p.audioStream, subStream: p.subStream, useMse: p.useMse, allowWebCodecs: p.allowWebCodecs })
    } else if (m.type === 'webCodecsError') {
      p.webCodecsSupported = false
      p.allowWebCodecs = false
      p.usingWebCodecs = false
      p.useMse = Boolean(p.mseSupported)
      updateBadge()
      seekTo(currentMediaTime())
    } else if (m.type === 'mseInit' || m.type === 'mseSeg') {
      if (m.type === 'mseSeg' && typeof m.maxEvictCap === 'number' && m.maxEvictCap > 0) {
        p.rustMaxEvictCap = m.maxEvictCap
      }
      p.mseQueue.push(m.buf)
      drainMseQueue()
    } else if (m.type === 'mseCtrl') {
      if (typeof m.maxEvictCap === 'number' && m.maxEvictCap > 0) p.rustMaxEvictCap = m.maxEvictCap
      if (m.exitRebuffer && p.rebuffering) applyRebufferExit(m.snapTo)
      if (m.evictTo > 0 && p.useMse) {
        if (!applyMseEvict(m.evictTo)) p.pendingEvictTo = m.evictTo
      }
      if (p.useMse && p.primed && !p.paused && !p.rebuffering && !video.seeking) {
        if (m.snapTo >= 0) {
          p.drainMseQueue?.()
          p.lastHardSync = performance.now()
          p.lastMseTime = m.snapTo
          p.lastMseAdvanceWall = p.lastHardSync
          try { video.currentTime = m.snapTo } catch {}
          if (video.paused) video.play().catch(() => {})
        } else if (typeof m.rate === 'number' && m.rate > 0 && Math.abs(video.playbackRate - m.rate) > 0.005) {
          video.playbackRate = m.rate
        }
      }
    } else if (m.type === 'returnCtrl') {
      p.returnSyncPending = false
      if (p.paused || !p.primed || p.seeking) return
      if (m.mode === 1) {
        p.pendingReturnSnap = true
      } else if (m.mode === 2) {
        p.pendingReturnSnap = false
        try { video.currentTime = m.target } catch {}
        p.lastMseTime = m.target
        p.lastHardSync = performance.now()
      } else if (m.mode === 3) {
        p.pendingReturnSnap = false
        seekTo(m.target)
      } else {
        p.pendingReturnSnap = false
        if (p.useMse) {
          p.lastMseTime = m.target
          p.lastHardSync = performance.now()
        } else {
          p.lastDrawWall = performance.now()
          p.lastSwPts = null
        }
      }
    } else if (m.type === 'videoPrimed') {
      p.workerGlPrimed = true
      p.usingWebCodecs = Boolean(m.hw)
      if (!p.useMse) { glCanvas.style.display = 'block'; canvas.style.display = 'none' }
      updateBadge()
      tryPrime()
    } else if (m.type === 'videoFrame') {
      if (m.hwFrame && !p.usingWebCodecs) {
        p.usingWebCodecs = true
        updateBadge()
      }
      // Worker MAX_WC_ACTIVE paces future frames; here only trim already-past-due frames when hidden, and keep PTS sorted across B-frames.
      if (effectiveHidden() && p.swFrames.length >= (m.hwFrame ? 6 : 72)) {
        const now = currentMediaTime()
        while (p.swFrames.length > 0 && p.swFrames[0].pts <= now) releaseFrame(p.swFrames.shift())
      }
      let ins = p.swFrames.length
      while (ins > 0 && p.swFrames[ins - 1].pts > m.pts) ins--
      p.swFrames.splice(ins, 0, m)
      if (p.drawnFrames === 0) drawSwFrame(p.swFrames[0])
      tryPrime()
    } else if (m.type === 'audioChunk' && m.samples > 0) {
      if (!p.primed) {
        p.pendingAudio.push(m)
        tryPrime()
      } else {
        scheduleAudioChunk(m)
        if (p.rebuffering) maybeExitRebuffer()
      }
    } else if (m.type === 'subText') {
      p.subCues.push({ kind: 'text', start: m.start, end: m.end, text: m.text })
    } else if (m.type === 'subBitmap') {
      p.subCues.push({ kind: 'bitmap', start: m.start, end: m.end, x: m.x, y: m.y, w: m.w, h: m.h, cw: m.cw, ch: m.ch, buf: m.buf })
    } else if (m.type === 'readBlock') {
      p.lastReadBlock = m.block
      if (typeof m.endBlock === 'number') p.prefetchEndBlock = m.endBlock
      if (typeof m.evictBefore === 'number') p.prefetchEvictBefore = m.evictBefore
      if (typeof m.maxInFlight === 'number' && m.maxInFlight > 0) p.prefetchMaxInFlight = m.maxInFlight
      // When force is true, the Worker's own sync XHR is already fetching m.block to blockEnd;
      // mark m.block done here so pumpPrefetch puts full P2P bandwidth onto m.block + 1..N instead of duplicating it.
      if (m.force && !p.prefetchInFlight.has(m.block)) p.prefetchDone.add(m.block)
      pumpPrefetch(p)
    } else if (m.type === 'videoCrop') {
      p.videoCrop = m.full ? null : { x: m.left, y: m.top, w: m.right - m.left, h: m.bottom - m.top, cw: m.w, ch: m.h }
    } else if (m.type === 'flushed') {
      // Only clear Seeking… if already primed; otherwise tryPrime() clears it once target audio+video land.
      if (player === p && p.primed) $('pStatus').style.display = 'none'
    } else if (m.type === 'eof') {
      p.eof = true
      finalizeMsePrimeIfReady()
      maybeExitRebuffer()
      tryPrime()
    }
  }

  // Executes the block prefetch plan (block..endBlock, evictBefore, maxInFlight) computed by Rust's pt_ctrl_prefetch_plan.
  function pumpPrefetch (p) {
    if (!p || player !== p || !p.worker || !p.streamUrl || !streamBlockBytes) return
    if (effectiveHidden()) return
    const base = p.lastReadBlock
    if (!Number.isFinite(base) || base < 0) return
    const evictBefore = typeof p.prefetchEvictBefore === 'number' ? p.prefetchEvictBefore : Math.max(0, base - (p.manifest?.rules?.evictTrailBlocks ?? 4))
    if (p.prefetchDone.size > 96) {
      for (const k of p.prefetchDone) {
        if (k < evictBefore) p.prefetchDone.delete(k)
      }
    }
    const maxInFlight = p.prefetchMaxInFlight || p.manifest?.rules?.prefetchInFlight || 6
    const endBlock = typeof p.prefetchEndBlock === 'number' ? p.prefetchEndBlock : (base + (p.manifest?.rules?.prefetchLookahead ?? 24) + 1)
    for (let idx = base; idx < endBlock; idx++) {
      if (p.prefetchInFlight.size >= maxInFlight) break
      if (idx < 0) continue
      if (p.prefetchDone.has(idx) || p.prefetchInFlight.has(idx)) continue
      const start = idx * streamBlockBytes
      const end = start + streamBlockBytes - 1
      const ctl = new AbortController()
      p.prefetchInFlight.set(idx, ctl)
      const killTimer = setTimeout(() => { try { ctl.abort() } catch {} }, 15000)
      const settle = () => { clearTimeout(killTimer); p.prefetchInFlight.delete(idx) }
      fetch(p.streamUrl, { headers: { range: 'bytes=' + start + '-' + end }, signal: ctl.signal })
        .then(r => (r.ok || r.status === 206) ? r.arrayBuffer() : null)
        .then(ab => {
          clearTimeout(killTimer)
          p.prefetchInFlight.delete(idx)
          if (!ab || player !== p) return
          p.prefetchDone.add(idx)
          try { p.worker.postMessage({ cmd: 'block', block: idx, buf: ab }, [ab]) } catch {}
          pumpPrefetch(p)
        })
        .catch(() => {
          settle()
          if (player === p && !effectiveHidden()) setTimeout(() => { if (player === p) pumpPrefetch(p) }, 400)
        })
    }
  }
  p.pumpPrefetch = pumpPrefetch

  function drawSwFrame (f) {
    p.lastDrawWall = performance.now()
    if ($('pStatus').textContent === 'Buffering…') hideStatus()
    const r = (f.yuv || f.hwFrame) ? getYuvGl() : false
    if (f.hwFrame) {
      const fw = f.w || f.hwFrame.displayWidth || f.hwFrame.codedWidth || 0
      const fh = f.h || f.hwFrame.displayHeight || f.hwFrame.codedHeight || 0
      if (fw <= 0 || fh <= 0) return
      const crop = p.videoCrop && p.videoCrop.w > 0 && p.videoCrop.cw === fw && p.videoCrop.ch === fh ? p.videoCrop : null
      const ow = crop ? crop.w : fw, oh = crop ? crop.h : fh
      if (r) {
        if (glCanvas.style.display !== 'block') { glCanvas.style.display = 'block'; canvas.style.display = 'none' }
        const { gl } = r
        const framePrim = f.hwFrame.colorSpace?.primaries || p.manifest?.videoColor?.primaries || ''
        const targetCs = (framePrim === 'bt2020' || framePrim === 'smpte432') ? 'display-p3' : 'srgb'
        if (r.cs !== targetCs) {
          r.cs = targetCs
          try {
            if ('drawingBufferColorSpace' in gl) gl.drawingBufferColorSpace = targetCs
            if ('unpackColorSpace' in gl) gl.unpackColorSpace = targetCs
          } catch {}
        }
        if (r.w !== ow || r.h !== oh) {
          r.w = ow; r.h = oh
          glCanvas.width = ow; glCanvas.height = oh
          gl.viewport(0, 0, ow, oh)
        }
        if (r.mode !== 1) { r.mode = 1; gl.uniform1i(r.modeLoc, 1) }
        gl.uniform4f(r.cropLoc, crop ? crop.x / fw : 0, crop ? crop.y / fh : 0,
          crop ? (crop.x + crop.w) / fw : 1, crop ? (crop.y + crop.h) / fh : 1)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, r.texY)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, f.hwFrame)
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      } else {
        if (canvas.style.display !== 'block') { canvas.style.display = 'block'; glCanvas.style.display = 'none' }
        if (canvas.width !== ow || canvas.height !== oh) { canvas.width = ow; canvas.height = oh }
        ctx2d.drawImage(f.hwFrame, crop ? crop.x : 0, crop ? crop.y : 0, ow, oh, 0, 0, ow, oh)
      }
      p.drawnFrames++
      return
    }
    const crop = p.videoCrop && p.videoCrop.w > 0 && p.videoCrop.cw === f.w && p.videoCrop.ch === f.h ? p.videoCrop : null
    const ow = crop ? crop.w : f.w, oh = crop ? crop.h : f.h
    if (r) {
      if (glCanvas.style.display !== 'block') { glCanvas.style.display = 'block'; canvas.style.display = 'none' }
      const { gl } = r
      if (r.cs !== 'srgb') {
        r.cs = 'srgb'
        try {
          if ('drawingBufferColorSpace' in gl) gl.drawingBufferColorSpace = 'srgb'
          if ('unpackColorSpace' in gl) gl.unpackColorSpace = 'srgb'
        } catch {}
      }
      const modeChanged = r.mode !== 0
      if (modeChanged) { r.mode = 0; gl.uniform1i(r.modeLoc, 0) }
      const nextMat = typeof f.matrix === 'number' ? f.matrix : (p.manifest?.videoColor?.matrix || 0)
      const nextFull = (typeof f.full === 'boolean' ? f.full : Boolean(p.manifest?.videoColor?.fullRange)) ? 1 : 0
      if (r.matrix !== nextMat) { r.matrix = nextMat; gl.uniform1i(r.matrixLoc, nextMat) }
      if (r.full !== nextFull) { r.full = nextFull; gl.uniform1i(r.fullLoc, nextFull) }
      const cw = (f.w + 1) >> 1, ch = (f.h + 1) >> 1
      const u8 = new Uint8Array(f.buf, 0, f.byteLen || f.buf.byteLength)
      const yLen = f.w * f.h, cLen = cw * ch
      const ySub = u8.subarray(0, yLen)
      const uSub = u8.subarray(yLen, yLen + cLen)
      const vSub = u8.subarray(yLen + cLen, yLen + cLen * 2)
      const resized = (r.w !== ow || r.h !== oh) || modeChanged
      if (r.w !== ow || r.h !== oh) {
        r.w = ow; r.h = oh
        glCanvas.width = ow; glCanvas.height = oh
        gl.viewport(0, 0, ow, oh)
      }
      const u0 = crop ? crop.x / f.w : 0, u1 = crop ? (crop.x + crop.w) / f.w : 1
      const v0 = crop ? crop.y / f.h : 0, v1 = crop ? (crop.y + crop.h) / f.h : 1
      gl.uniform4f(r.cropLoc, u0, v0, u1, v1)
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
  function tick () {
    if (player !== p) return
    p.raf = requestAnimationFrame(tick)
    if (!p.primed) tryPrime()
    let now = currentMediaTime()
    const pf = performance.now()
    // The demuxer has delivered everything: stop at the end instead of letting the free clock run past it.
    if (p.eof && p.primed && !p.paused) {
      const drained = p.audioNodes.length === 0 && p.swFrames.length === 0
      if (p.duration > 0 ? now >= p.duration - 0.25 : drained) {
        now = p.duration > 0 ? p.duration : now
        p.paused = true
        p.ended = true
        p.freeBaseMedia = now
        p.audioCtx?.suspend?.().catch(() => {})
        if (p.useMse) video.pause()
        syncWorkerClock(now, false)
        $('pPlayBtn').textContent = 'Replay'
        $('pMiniPlay').textContent = 'Replay'
      }
    }

    if (p.rebuffering) maybeExitRebuffer()
    if (p.primed && p.useMse && p.mseReady && !p.paused && !p.rebuffering) {
      const vt = video.currentTime
      if (vt > p.lastMseTime) {
        p.consumedVideoSec += Math.min(1.0, vt - p.lastMseTime)
        p.lastMseTime = vt
        p.lastMseAdvanceWall = pf
        if (!video.seeking && video.readyState >= 2 && $('pStatus').textContent === 'Buffering…') {
          $('pStatus').style.display = 'none'
        }
      }
    } else if (p.primed && !p.useMse && p.swFrames.length > 0 && !p.paused) {
      stepCanvasFrames(now, true)
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
      const seekVal = String(Math.min(1000, Math.round((now / p.duration) * 1000)))
      if (seekVal !== p.lastSeekVal) { p.lastSeekVal = seekVal; $('pSeek').value = seekVal; $('pMiniSeek').value = seekVal }
    }
    // Rewriting the same text node every frame makes the clock shimmer; only touch the DOM when
    // the formatted time actually changes (once a second), not on every animation frame.
    const clockText = fmtClock(now) + ' / ' + fmtClock(p.duration)
    if (clockText !== p.lastClockText) { p.lastClockText = clockText; $('pClock').textContent = clockText; $('pMiniClock').textContent = clockText }
    if (p.duration > 0 && playerEntry && Date.now() - lastResumeSave > 4000) {
      lastResumeSave = Date.now()
      saveResume(playerEntry, now, p.duration)
    }
    const prevTickGap = p.lastTickWall ? (pf - p.lastTickWall) : 0
    if (prevTickGap > 200) {
      p.lastDrawWall = pf
    }
    p.lastTickWall = pf
    // macOS throttles covered windows to ~0.5 Hz rAF (~1.8 s gap); only clear occlusion on real 60 Hz cadence or focus.
    if (p.windowOccluded && (document.hasFocus() || (prevTickGap > 0 && prevTickGap < 250))) {
      resyncOnReturn(true)
    }
    if (p.primed && !p.paused && !p.seeking && !p.useMse && !p.eof && p.swFrames.length === 0 &&
        document.visibilityState === 'visible' && !p.windowOccluded &&
        p.lastDrawWall && pf - p.lastDrawWall > 1500 &&
        $('pStatus').style.display === 'none') {
      showStatus('Buffering…')
    }
  }
  function stepCanvasFrames (now, draw) {
    let pick = null
    while (p.swFrames.length > 0 && p.swFrames[0].pts <= now + 0.015) {
      const f = p.swFrames.shift()
      if (pick) releaseFrame(pick)
      const step = p.lastSwPts !== null ? Math.max(0.01, Math.min(0.2, f.pts - p.lastSwPts)) : (1 / 30)
      p.lastSwPts = f.pts
      p.consumedVideoSec += step
      pick = f
    }
    if (pick) {
      if (draw) drawSwFrame(pick)
      releaseFrame(pick)
    }
  }
  p.lastTickWall = performance.now()
  p.raf = requestAnimationFrame(tick)
  // Backup 50 ms frame stepper: keeps WebCodecs/WASM drawing during macOS window drags (where rAF stalls)
  // and pauses invisible GPU/CPU video decode once macOS occludes an unfocused window for >1.5 s.
  p.frameTimer = setInterval(() => {
    if (player !== p) { clearInterval(p.frameTimer); return }
    if (!p.primed || p.paused) return
    const pf = performance.now()
    const rafGap = pf - (p.lastTickWall || pf)
    if (rafGap <= 65) return
    p.lastDrawWall = pf
    const now = currentMediaTime()
    if (!p.useMse && p.swFrames.length > 0) {
      const shouldDraw = document.visibilityState === 'visible' && rafGap < 1500
      stepCanvasFrames(now, shouldDraw)
    }
    if (rafGap >= 1500 && !p.windowOccluded) {
      p.windowOccluded = true
      syncWorkerClock(now, true)
    }
  }, 50)
  p.creditTimer = setInterval(() => {
    if (player !== p) { clearInterval(p.creditTimer); return }
    if (!p.primed || !p.worker) return
    const vSec = p.consumedVideoSec
    const aSec = p.consumedAudioSec
    p.consumedVideoSec = 0
    p.consumedAudioSec = 0
    syncWorkerClock(currentMediaTime(), !p.paused, { cmd: 'consumed', videoSec: vSec, audioSec: aSec })
  }, 250)

  const vid = $('pVideo')
  if (vid) {
    vid.addEventListener('waiting', () => {
      if (player !== p || !p.useMse || effectiveHidden()) return
      if (p.lastTickWall && performance.now() - p.lastTickWall > 200) return
      const checkAt = video.currentTime > 0 ? video.currentTime : currentMediaTime()
      for (let i = 0; i < vid.buffered.length; i++) {
        if (checkAt >= vid.buffered.start(i) && checkAt + 0.35 <= vid.buffered.end(i)) return
      }
      enterRebuffer()
    })
    vid.addEventListener('playing', () => {
      if (player === p && !p.rebuffering && $('pStatus').textContent === 'Buffering…') hideStatus()
    })
  }
  const extMatch = (entry.streamUrl || '').split('?')[0].split('.').pop() || ''
  worker.postMessage({ cmd: 'open', seq: p.seq, streamUrl, wasmUrl: location.origin + '/web/peartube_web.wasm' + ASSET_VER, ext: extMatch.length <= 5 ? extMatch : '' })
  return p
}

function togglePlay () {
  if (!player) return
  if (player.ended) {
    player.ended = false
    player.paused = false
    $('pPlayBtn').textContent = 'Pause'
    $('pMiniPlay').textContent = 'Pause'
    player.audioCtx?.resume?.().catch(() => {})
    seekTo(0)
    return
  }
  const now = player.currentMediaTime ? player.currentMediaTime() : player.freeBaseMedia
  player.paused = !player.paused
  player.freeBaseMedia = now
  player.freeBasePerf = performance.now()
  $('pPlayBtn').textContent = player.paused ? 'Play' : 'Pause'
  $('pMiniPlay').textContent = $('pPlayBtn').textContent
  showPlayerChrome()
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
  if (player.ended) {
    player.ended = false
    $('pPlayBtn').textContent = 'Pause'
    $('pMiniPlay').textContent = 'Pause'
  }
  const clamped = Math.max(0, player.duration > 0 ? Math.min(player.duration, targetSecs) : targetSecs)
  // If open is still probing the container before manifest lands, update startAt in place instead of dropping manifest's seq.
  if (!player.manifest) {
    player.startAt = clamped
    player.freeBaseMedia = clamped
    player.audioBaseMedia = clamped
    showStatus('Seeking…')
    return
  }
  player.seq = ++openCounter
  player.eof = false
  showStatus('Seeking…')
  player.drawnFrames = 0
  player.videoCrop = null
  for (const ctl of player.prefetchInFlight.values()) { try { ctl.abort() } catch {} }
  player.prefetchInFlight.clear()
  player.prefetchDone.clear()
  player.lastReadBlock = -1
  player.updateBadge?.()
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
$('pMiniBtn').onclick = () => setMiniPlayer(true)
$('pMiniRestore').onclick = () => setMiniPlayer(false)
$('pMiniPlay').onclick = togglePlay
$('pMiniBack').onclick = () => nudge(-10)
$('pMiniFwd').onclick = () => nudge(10)
$('pPlayBtn').onclick = togglePlay
$('playerModal').onpointermove = showPlayerChrome
$('playerModal').onfocusin = showPlayerChrome
$('pStage').onclick = () => {
  if ($('playerModal').classList.contains('mini')) { setMiniPlayer(false); return }
  // A click into an unfocused window only focuses it; the first click after returning must not
  // pause the film. Real clicks (document focused, outside the grace window) still toggle.
  if (!document.hasFocus()) return
  if (player && performance.now() < (player.suppressStageClickUntil || 0)) return
  togglePlay()
}
$('pStage').ondblclick = () => $('pFsBtn').click()
// Repeated ±10 s presses add up into one seek: each seek restarts the demuxer and its range reads.
let seekTimer = 0
let seekTarget = null
function nudge (deltaSecs) {
  if (!player) return
  const liveNow = player.currentMediaTime ? player.currentMediaTime() : (player.freeBaseMedia || 0)
  const from = seekTarget ?? liveNow
  seekTarget = Math.max(0, player.duration > 0 ? Math.min(player.duration, from + deltaSecs) : from + deltaSecs)
  showStatus('Seeking to ' + fmtClock(seekTarget))
  clearTimeout(seekTimer)
  seekTimer = setTimeout(() => { const t = seekTarget; seekTarget = null; seekTo(t) }, 350)
}
$('pBackBtn').onclick = () => nudge(-10)
$('pFwdBtn').onclick = () => nudge(10)
$('pFsBtn').onclick = () => {
  const m = $('playerModal')
  if (m.classList.contains('mini')) setMiniPlayer(false)
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
  else m.requestFullscreen?.().catch(() => {})
}
$('pSeek').onpointerdown = () => { if (player) player.seeking = true }
$('pSeek').onchange = () => {
  if (!player) return
  player.seeking = false
  if (player.duration > 0) seekTo((Number($('pSeek').value) / 1000) * player.duration)
}
$('pMiniSeek').onpointerdown = () => { if (player) player.seeking = true }
$('pMiniSeek').onchange = () => {
  if (!player) return
  player.seeking = false
  if (player.duration > 0) seekTo((Number($('pMiniSeek').value) / 1000) * player.duration)
}
$('pAudioSel').onchange = () => {
  if (!player) return
  player.audioStream = Number($('pAudioSel').value)
  seekTo(player.currentMediaTime ? player.currentMediaTime() : (player.freeBaseMedia || 0))
}
$('pSubSel').onchange = () => {
  if (!player) return
  player.subStream = Number($('pSubSel').value)
  seekTo(player.currentMediaTime ? player.currentMediaTime() : (player.freeBaseMedia || 0))
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
  if (!player || ev.altKey || ev.ctrlKey || ev.metaKey || /^(INPUT|SELECT|TEXTAREA)$/.test(ev.target.tagName) || ev.target.isContentEditable) return
  if ($('playerModal').classList.contains('mini') && !$('playerModal').contains(document.activeElement)) return
  if (ev.key === 'Escape') { ev.preventDefault(); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else closePlayer() }
  else if (ev.key === ' ') { ev.preventDefault(); togglePlay() }
  else if (ev.key === 'ArrowLeft') { ev.preventDefault(); $('pBackBtn').click() }
  else if (ev.key === 'ArrowRight') { ev.preventDefault(); $('pFwdBtn').click() }
  else if (ev.key === 'f' || ev.key === 'F') { ev.preventDefault(); $('pFsBtn').click() }
  else if (ev.key === 'm' || ev.key === 'M') { ev.preventDefault(); $('pMuteBtn').click() }
})
// A hidden tab has no picture to show, but the player keeps its timeline (the Worker owns decode and
// the clock). On return, make the browser's video element play again if it paused it in the
// background; the GL path restarts its render loop from the first clock message of the next frame.
function resyncOnReturn (fromHidden = false) {
  if (!player) return
  const p = player
  const wasHidden = fromHidden || p.windowOccluded
  p.windowOccluded = false
  p.lastTickWall = performance.now()
  if (p.paused || !p.primed || p.seeking || p.returnSyncPending) return
  const audio = p.currentMediaTime ? p.currentMediaTime() : (p.freeBaseMedia || 0)
  p.suppressStageClickUntil = performance.now() + 900
  if (p.audioCtx?.state === 'suspended') p.audioCtx.resume().catch(() => {})
  if (p.useMse) {
    const v = $('pVideo')
    v.playbackRate = 1
    p.drainMseQueue?.()
    if (v.paused) v.play().catch(() => {})
  }
  p.returnSyncPending = true
  p.syncWorkerClock?.(audio, true, {
    returnSync: true,
    wasHidden,
    isAvi: p.manifest?.container === 'avi',
    mseBufferedAtAudio: p.useMse ? p.mseBufferedAhead?.(audio) : 0,
    sbUpdating: Boolean(p.sb?.updating || p.mseQueue.length > 0)
  })
  p.pumpPrefetch?.(p)
}
addEventListener('visibilitychange', () => {
  if (!player) return
  const hidden = document.visibilityState !== 'visible'
  if (hidden) {
    const liveNow = player.currentMediaTime ? player.currentMediaTime() : (player.freeBaseMedia || 0)
    player.syncWorkerClock?.(liveNow, !player.paused)
  } else {
    resyncOnReturn(true)
  }
})
addEventListener('focus', () => {
  if (document.visibilityState === 'visible') resyncOnReturn()
})


// Theme follows the device until someone picks dark or light; the choice sticks per browser.
const THEME_KEY = 'peartube-theme'
const THEME_ORDER = ['system', 'dark', 'light']
const themeLabel = mode => mode === 'system' ? 'Theme: follow this device' : 'Theme: ' + mode
function applyTheme (mode) {
  document.documentElement.dataset.theme = mode
  const t = $('themeToggle')
  if (!t) return
  t.setAttribute('aria-label', themeLabel(mode))
  t.title = themeLabel(mode) + ' — click to change'
}
applyTheme(document.documentElement.dataset.theme || 'system')
$('themeToggle').onclick = () => {
  const now = document.documentElement.dataset.theme || 'system'
  const next = THEME_ORDER[(THEME_ORDER.indexOf(now) + 1) % THEME_ORDER.length]
  try { localStorage.setItem(THEME_KEY, next) } catch {}
  applyTheme(next)
}
</script>
</body>
</html>
`
