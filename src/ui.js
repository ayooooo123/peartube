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
  #detail { width: min(760px, calc(100% - 24px)); max-height: calc(100% - 48px); padding: 0; border: 1px solid var(--line); border-radius: var(--r-panel); background: var(--surface); color: var(--text); box-shadow: 0 40px 90px rgba(0,0,0,.5); }
  #detail::backdrop { background: color-mix(in srgb, #05060a 72%, transparent); backdrop-filter: blur(6px); }
  #detail .bar { padding: 14px 14px 0 22px; justify-content: flex-end; }
  #detailBody { padding: 0 22px 22px; }
  .detail-head { display: flex; gap: 20px; align-items: flex-start; margin-bottom: 20px; }
  .detail-head .poster { width: 128px; height: 192px; font-size: 40px; border-radius: var(--r-card); }
  .detail-head h3 { font-size: 24px; font-weight: 700; letter-spacing: -0.015em; line-height: 1.2; margin: 2px 0 8px; }
  .rows { display: flex; flex-direction: column; }
  .row-item { display: flex; gap: 12px; align-items: center; padding: 12px 0; border-top: 1px solid var(--line); }
  #detail .meta { white-space: normal; font-size: 13px; line-height: 1.5; }
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
    .tabs { padding: 0 8px; }
    main { padding: 16px 16px 96px; }
    h2 { font-size: 18px; margin: 28px 0 12px; }
    .item { flex-wrap: wrap; }
    .item.job { flex-wrap: nowrap; }
    .item:not(.job) .acts { width: 100%; justify-content: flex-start; }
    .tabs a { padding: 12px 10px 10px; }
    .thumb { width: 96px; height: 54px; }
    .setting .control { max-width: none; }
    .grid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 20px 10px; }
    .tile .poster { font-size: 28px; }
    .detail-head .poster { width: 96px; height: 144px; font-size: 30px; }
    .p-top { flex-wrap: wrap; }
    #playerModal .p-head { flex-basis: 100%; }
    #playerModal .p-title { white-space: normal; }
  }
  /* The player is always dark chrome, in both themes: video wants black around it. */
  #playerModal { --p-bg:#08090c; --p-surface:#101218; --p-raised:#171a22; --p-line:#232733; --p-text:#f2f4f8; --p-dim:#98a0b3;
    position: fixed; inset: 0; background: var(--p-bg); color: var(--p-text); z-index: 100; display: none; flex-direction: column; }
  #playerModal.open { display: flex; }
  #playerModal .btn { background: var(--p-raised); border-color: var(--p-line); color: var(--p-text); min-height: 36px; padding: 0 12px; }
  #playerModal .btn:hover:not(:disabled) { border-color: var(--p-dim); }
  #playerModal .btn.primary { background: var(--brand); border-color: var(--brand); color: var(--on-brand); }
  #playerModal .btn.primary:hover:not(:disabled) { background: var(--brand-hover); border-color: var(--brand-hover); }
  #playerModal select { background: var(--p-raised); color: var(--p-text); border-color: var(--p-line); min-height: 36px; width: auto; }
  .p-top { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 16px; background: color-mix(in srgb, var(--p-surface) 92%, transparent); border-bottom: 1px solid var(--p-line); }
  .p-head { min-width: 0; flex: 1; }
  .p-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .p-badge { font-size: 12px; color: var(--p-dim); font-variant-numeric: tabular-nums; }
  .p-stage { position: relative; flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; background: #000; overflow: hidden; cursor: pointer; }
  #pVideo, #pGlCanvas, #pCanvas { max-width: 100%; max-height: 100%; width: 100%; height: 100%; object-fit: contain; display: none; }
  #pSubCanvas { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; pointer-events: none; }
  #pSubText { position: absolute; left: 8%; right: 8%; bottom: 28px; text-align: center; font-size: clamp(16px, 2.2vw, 28px); font-weight: 600; color: var(--on-media); text-shadow: 0 2px 6px #000, 0 0 3px #000, 1px 1px 0 #000, -1px -1px 0 #000; white-space: pre-wrap; pointer-events: none; }
  #pStatus { position: absolute; padding: 8px 14px; border-radius: var(--r-control); background: color-mix(in srgb, var(--p-surface) 88%, transparent); border: 1px solid var(--p-line); font-size: 13px; color: var(--p-text); pointer-events: none; display: none; }
  .p-bar { padding: 10px 16px 14px; background: color-mix(in srgb, var(--p-surface) 94%, transparent); border-top: 1px solid var(--p-line); display: flex; flex-direction: column; gap: 8px; }
  .p-bar .row { justify-content: space-between; }
  #pSeek { width: 100%; accent-color: var(--brand); padding: 0; cursor: pointer; }
  .clock { font-variant-numeric: tabular-nums; font-size: 12.5px; color: var(--p-dim); min-width: 96px; }
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
        <button class="chip" type="button" data-opens="folderForm" aria-expanded="false">Import a folder</button>
        <button class="chip" type="button" data-opens="feedForm" aria-expanded="false">Mirror a catalog</button>
        <button class="chip" type="button" data-opens="copyForm" aria-expanded="false">Copy a channel</button>
      </div>
      <form id="folderForm" class="panel" hidden>
        <div class="field">
          <label for="folderInput">Folder on the relay</label>
          <div class="row"><input class="grow" id="folderInput" type="text" spellcheck="false" placeholder="/data/import" required><button class="btn primary" type="submit">Import</button></div>
          <span class="hint" id="folderHint">New videos in this folder are added automatically.</span>
        </div>
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
  </section>

  <section id="tab-channels" data-panel="channels" hidden>
    <h2>This relay</h2>
    <div class="list" id="mine"></div>
    <h2>Following <span class="count" id="followCount"></span></h2>
    <div class="list" id="following"></div>
    <form id="followForm" class="card" style="margin-top:12px">
      <div class="field">
        <label for="followInput">Follow a channel or tracker</label>
        <input id="followInput" type="text" spellcheck="false" placeholder="peartube://channel/6049da41fd86a20f4883255bd6120bd6b580e19aa209693eb1f3f8c649c76d70" required>
      </div>
      <div class="field" id="followKindWrap" hidden>
        <label for="followKind">This key is a</label>
        <select id="followKind"><option value="channel">Channel</option><option value="tracker">Tracker</option></select>
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
    <h2>Use a browser as a TV</h2>
    <div class="card" id="webTv"></div>
  </section>

  <section id="tab-settings" data-panel="settings" hidden>
    <div id="settingsBody"></div>
  </section>
</main>
<dialog id="detail" aria-labelledby="detailTitle">
  <div class="bar"><button class="btn quiet" id="detailClose" type="button">Close</button></div>
  <div id="detailBody"></div>
</dialog>
<div id="castBar" hidden></div>
<div id="toast" role="status" hidden></div>
<div id="playerModal" role="dialog" aria-modal="true" aria-labelledby="pTitle">
  <div class="p-top">
    <div class="p-head">
      <div class="p-title" id="pTitle"></div>
      <div class="p-badge" id="pBadge">Loading player…</div>
    </div>
    <div class="row">
      <a class="btn" id="pRawLink" target="_blank" rel="noopener">Open file</a>
      <button class="btn" id="pFsBtn" type="button">Fullscreen</button>
      <button class="btn" id="pCloseBtn" type="button">Close</button>
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
    <input type="range" id="pSeek" min="0" max="1000" value="0" step="1" aria-label="Position">
    <div class="row">
      <div class="row">
        <button class="btn primary" id="pPlayBtn" type="button">Pause</button>
        <button class="btn" id="pBackBtn" type="button" aria-label="Back 10 seconds">-10s</button>
        <button class="btn" id="pFwdBtn" type="button" aria-label="Forward 10 seconds">+10s</button>
        <span class="clock" id="pClock">0:00 / 0:00</span>
      </div>
      <div class="row">
        <select id="pAudioSel" aria-label="Audio track"></select>
        <select id="pSubSel" aria-label="Subtitles"></select>
        <button class="btn" id="pMuteBtn" type="button">Mute</button>
        <input type="range" id="pVol" min="0" max="100" value="100" style="width:80px;padding:0;accent-color:var(--brand)" aria-label="Volume">
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
// Every call goes through here: the token rides along, a 401 asks for it, errors come back as messages.
async function api (path, { method, body } = {}) {
  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = 'Bearer ' + token
  const res = await fetch(path, { method: method || (body !== undefined ? 'POST' : 'GET'), headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  let data = null
  try { data = await res.json() } catch {}
  if (res.status === 401) {
    needsToken = true
    $('authForm').hidden = false
    throw new Error('Sign in with the access token first.')
  }
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
// Runs an action from a button: disables it meanwhile and reports failures.
async function act (btn, fn, msgId) {
  if (btn) btn.disabled = true
  try { return await fn() } catch (err) {
    if (msgId) say(msgId, err.message, true)
    else toast(err.message)
  } finally { if (btn) btn.disabled = false }
}

function copyText (text) {
  const ta = el('textarea')
  ta.value = text
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0'
  document.body.append(ta)
  ta.select()
  let ok = false
  try { ok = document.execCommand('copy') } catch {}
  ta.remove()
  if (!ok && window.isSecureContext && navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {})
  toast('Link copied')
}
const copyBtn = (label, text) => h('button', { class: 'btn', disabled: !text, title: text || '', onclick: () => copyText(text) }, label)

// Holds the lists still while a finger is down, so an update never moves a button mid-press.
let pressing = false, refreshQueued = false, player = null, playerEntry = null, lastResumeSave = 0
addEventListener('pointerdown', () => { pressing = true })
for (const evName of ['pointerup', 'pointercancel', 'blur']) {
  addEventListener(evName, () => {
    if (!pressing) return
    pressing = false
    if (refreshQueued) { refreshQueued = false; setTimeout(refresh, 0) }
  })
}

const S = { status: {}, sources: { sources: [], discovered: [], published: [] }, entries: [], jobs: [], plugins: [], cast: null, settings: null }
const plugin = name => S.plugins.find(p => p.name === name) || {}
const setting = key => S.settings && S.settings.settings[key]
const sval = key => setting(key) ? setting(key).value : undefined

// ---- Tabs
let tab = 'library'
function showTab () {
  const want = location.hash.slice(1)
  tab = ['library', 'channels', 'sharing', 'tv', 'settings'].includes(want) ? want : 'library'
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
    const [st, src, ent, jb, pl, set] = await Promise.all([
      api('/v1/status'), api('/v1/sources'), api('/v1/entries'), api('/v1/jobs'),
      api('/v1/plugins').catch(() => ({ plugins: [] })),
      // Another tab, a reopen or the relay itself can change settings; reload them once this page may see them.
      S.settings ? api('/v1/settings').catch(() => S.settings) : null
    ])
    Object.assign(S, { status: st, sources: src, entries: ent.results || [], jobs: jb.jobs || [], plugins: pl.plugins || [], offline: false })
    if (set) S.settings = set
  } catch (err) {
    S.offline = !needsToken
  }
  if (pressing || player) { refreshQueued = true; return }
  render()
  if (tab === 'settings') refreshSettingsView()
}
// Redraws the Settings tab when what it shows changed, unless the user is in one of its fields.
let settingsShown = ''
function refreshSettingsView () {
  const shown = JSON.stringify([S.settings, S.status.privateGuard ? S.status.privateGuard.port : 0])
  if (shown === settingsShown || $('settingsBody').contains(document.activeElement)) return
  renderSettings()
}
let settingsLoaded = false
async function loadSettings () {
  try { S.settings = await api('/v1/settings') } catch { S.settings = null }
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
  const restart = S.settings ? S.settings.restartNeeded.length : 0
  if (restart) {
    const btn = h('button', { class: 'pill warn', type: 'button' }, 'Restart to apply ' + plural(restart, 'change', 'changes'))
    btn.onclick = () => act(btn, restartRelay)
    pills.push(btn)
  }
  if (needsToken && !token) pills.push(h('span', { class: 'pill warn' }, 'Read-only until you sign in'))
  $('pills').replaceChildren(...pills)
}

// ---- Library: add flow
for (const chip of document.querySelectorAll('[data-opens]')) {
  chip.onclick = () => {
    for (const other of document.querySelectorAll('[data-opens]')) {
      const open = other === chip && other.getAttribute('aria-expanded') !== 'true'
      other.setAttribute('aria-expanded', String(open))
      $(other.dataset.opens).hidden = !open
      if (open) $(other.dataset.opens).querySelector('input').focus()
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
      const r = await api(watch ? '/v1/open' : '/v1/sources', { body: { uri: val } })
      $('addInput').value = ''
      say('addMsg', watch ? 'Opened. It is in your library now.' : 'Following ' + ((r.source && r.source.alias) || 'the channel') + '.')
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
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', type: 'submit', id: 'confirmAdd' }, 'Add to library'),
      h('button', { class: 'btn quiet', onclick: () => { p.hidden = true } }, 'Cancel')))
  p.onsubmit = async ev => {
    ev.preventDefault()
    const picked = p.querySelector('input[name=cand]:checked')
    const id = picked ? picked.value : r.plain.id
    await act($('confirmAdd'), async () => {
      await api('/v1/acquire', { body: { id, title: titleInput.value.trim() || r.plain.title, source: { url, page: link.kind === 'page' } } })
      p.hidden = true
      $('addInput').value = ''
      say('addMsg', 'Adding “' + (titleInput.value.trim() || r.plain.title) + '”.')
      refresh()
    }, 'addMsg')
  }
  p.hidden = false
}

$('folderForm').onsubmit = async ev => {
  ev.preventDefault()
  const dir = $('folderInput').value.trim()
  await act(ev.submitter, async () => {
    if (sval('watchDir') !== dir) await saveSettings({ watchDir: dir })
    await api('/v1/plugins/watch-dir/run', { body: { dir } })
    say('addMsg', 'Importing from ' + dir + '. New files there are added automatically.')
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
  const dir = sval('watchDir')
  if (dir && !$('folderInput').value) $('folderInput').value = dir
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
const JOB_TEXT = { queued: 'Waiting', running: 'Downloading', announcing: 'Publishing', done: 'Added', failed: 'Failed', cancelled: 'Cancelled' }
function renderJobs () {
  const recent = Date.now() - 6 * 3600_000
  const jobs = S.jobs.filter(j => j.status !== 'done' || j.created > recent).sort((a, b) => b.created - a.created).slice(0, 20)
  $('jobsWrap').hidden = !jobs.length
  $('jobCount').textContent = jobs.length ? String(jobs.length) : ''
  $('jobs').replaceChildren(...jobs.map(j => {
    const active = j.status === 'queued' || j.status === 'running' || j.status === 'announcing'
    const pct = j.total ? Math.min(100, Math.round((j.bytes || 0) / j.total * 100)) : null
    const status = j.status === 'running' && j.bytes != null ? (pct != null ? 'Downloading ' + pct + '% of ' + size(j.total) : 'Downloading · ' + size(j.bytes)) : JOB_TEXT[j.status] || j.status
    const tagClass = j.status === 'done' ? 'tag ok' : j.status === 'failed' ? 'tag bad' : 'tag'
    return h('div', { class: 'item job' },
      h('div', { class: 'info' },
        h('div', { class: 'name' }, j.title || 'Untitled'),
        h('div', { class: 'meta' }, h('span', { class: tagClass }, status), j.status === 'done' && j.size ? ' ' + size(j.size) : ''),
        j.error && j.status === 'failed' ? h('div', { class: 'meta err' }, j.error) : null,
        j.status === 'running' ? h('div', { class: 'bar-track' }, h('div', { style: 'width:' + (pct == null ? 100 : pct) + '%' })) : null),
      h('div', { class: 'acts' }, h('button', { class: 'btn quiet', onclick: e => act(e.currentTarget, async () => { await api('/v1/jobs/' + j.jobId, { method: 'DELETE' }); refresh() }) }, active ? 'Cancel' : 'Dismiss')))
  }))
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
    const kind = !m ? 'video' : m[2] ? 'show' : 'movie'
    const key = kind === 'video' ? 'v:' + e.id + '/' + e.sha256 : kind + ':' + m[1]
    let t = tiles.get(key)
    if (!t) tiles.set(key, t = { key, kind, imdb: m ? m[1] : null, title: e.title.replace(/\\s+S[0-9]+E[0-9]+$/i, ''), items: [] })
    t.items.push({ e, season: m && m[2] ? Number(m[2]) : null, episode: m && m[3] ? Number(m[3]) : null })
  }
  for (const t of tiles.values()) {
    t.items.sort((a, b) => (a.season - b.season) || (a.episode - b.episode) || (b.e.size - a.e.size))
    t.saved = t.items.filter(i => saved(i.e)).length
    t.partial = t.items.some(i => !saved(i.e) && i.e.cachedBytes)
  }
  return [...tiles.values()].sort((a, b) => a.title.localeCompare(b.title))
}
function tileLine (t) {
  const n = t.items.length
  if (t.kind === 'show') {
    const seasons = new Set(t.items.map(i => i.season)).size
    return (seasons > 1 ? plural(seasons, 'season', 'seasons') + ' · ' : '') + plural(n, 'episode', 'episodes')
  }
  const e = t.items[0].e
  return [t.kind === 'movie' ? 'Movie' : 'Video', n > 1 ? n + ' versions' : size(e.size)].join(' · ')
}
function tileState (t) {
  if (t.saved === t.items.length) return ['Saved here', 'ok']
  if (t.saved || t.partial) return [t.kind === 'show' && t.saved ? t.saved + ' saved here' : 'Partly saved', '']
  return ['On the network', '']
}
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
  const all = libraryTiles()
  const resume = resumeTiles(all)
  renderHero(resume)
  renderResume(resume)
  renderLive()
  const q = $('libFilter').value.trim().toLowerCase()
  const list = all.filter(t => (libKind === 'all' || t.kind === libKind) && (!q || t.title.toLowerCase().includes(q)))
  // Progress polls arrive every few seconds; redraw only when what the grid shows has changed.
  const signature = [libKind, q, libShown, S.offline, ...list.slice(0, libShown).map(t => t.key + tileState(t)[0] + t.items.length)].join('|')
  if (!force && signature === libSignature) return
  libSignature = signature
  $('libCount').textContent = all.length ? String(all.length) : ''
  $('libTools').hidden = all.length < 2
  $('libKinds').replaceChildren(...KINDS.map(([k, label]) => {
    const n = k === 'all' ? all.length : all.filter(t => t.kind === k).length
    return n || k === 'all' ? h('button', { class: 'chip', 'aria-pressed': String(libKind === k), onclick: () => { libKind = k; libShown = 60; renderLibrary() } }, label + ' ', h('span', { class: 'count' }, String(n))) : null
  }).filter(Boolean))
  if (!all.length) {
    $('entries').replaceChildren(h('div', { class: 'empty' }, S.offline ? 'Can’t reach the relay.' : 'Nothing here yet. Paste a link above to add a video.'))
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

// ---- Library: details sheet (play, cast, copy; a show's episodes by season)
let detailKey = null
let detailSeason = null
function openDetail (key) {
  detailKey = key
  detailSeason = null
  renderDetail()
  if (!$('detail').open) $('detail').showModal()
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
function fileRow (label, e) {
  const from = sourceName(e.source)
  return h('div', { class: 'row-item' },
    h('div', { class: 'grow' }, h('div', { class: 'label' }, label), h('div', { class: 'meta' }, [size(e.size), where(e), from && 'from ' + from].filter(Boolean).join(' · '))),
    h('div', { class: 'acts' }, h('button', { class: 'btn primary', 'data-play': true, onclick: () => play(e) }, 'Play'), castButton(e), h('button', { class: 'btn quiet', title: e.magnetUrl, onclick: () => copyText(e.magnetUrl) }, 'Copy link')))
}
function renderDetail () {
  const t = libraryTiles().find(x => x.key === detailKey)
  const box = $('detailBody')
  if (!t) { box.replaceChildren(h('div', { class: 'empty' }, 'This title is no longer in the library.')); return }
  const head = h('div', { class: 'detail-head' },
    posterBox(t.imdb ? '/v1/poster/' + t.imdb : null, t.title),
    h('div', { class: 'grow' }, h('h3', { id: 'detailTitle' }, t.title), h('div', { class: 'meta' }, tileLine(t) + ' · ' + tileState(t)[0])))
  let body
  if (t.kind === 'show') {
    const seasons = [...new Set(t.items.map(i => i.season))]
    if (detailSeason == null || !seasons.includes(detailSeason)) detailSeason = seasons[0]
    const pick = seasons.length > 1
      ? h('div', { class: 'field' }, h('label', { for: 'seasonPick' }, 'Season'), h('select', { id: 'seasonPick', onchange: ev => { detailSeason = Number(ev.target.value); renderDetail() } },
        seasons.map(s => h('option', { value: String(s), selected: s === detailSeason }, 'Season ' + s + ' (' + t.items.filter(i => i.season === s).length + ')'))))
      : null
    body = [pick, h('div', { class: 'rows' }, t.items.filter(i => i.season === detailSeason).map(i => fileRow('S' + String(i.season).padStart(2, '0') + 'E' + String(i.episode).padStart(2, '0'), i.e)))]
  } else if (t.items.length > 1) {
    body = [h('div', { class: 'rows' }, t.items.map((i, n) => fileRow('Version ' + (n + 1), i.e)))]
  } else {
    const e = t.items[0].e
    const from = sourceName(e.source)
    body = [h('div', { class: 'meta' }, [where(e), from && 'from ' + from].filter(Boolean).join(' · ')),
      h('div', { class: 'row', style: 'margin-top:14px' }, h('button', { class: 'btn primary', 'data-play': true, onclick: () => play(e) }, 'Play'), castButton(e), copyBtn('Copy link', e.magnetUrl))]
  }
  box.replaceChildren(head, ...body)
}
$('detailClose').onclick = () => $('detail').close()
$('detail').addEventListener('click', ev => { if (ev.target === $('detail')) $('detail').close() })

// ---- Channels
$('followInput').oninput = () => { $('followKindWrap').hidden = !HEX.test($('followInput').value.trim()) }
$('followForm').onsubmit = async ev => {
  ev.preventDefault()
  const val = $('followInput').value.trim()
  const alias = $('followName').value.trim()
  await act(ev.submitter, async () => {
    const body = HEX.test(val) ? { key: val.toLowerCase(), kind: $('followKind').value, alias } : { uri: val, alias }
    const r = await api('/v1/sources', { body })
    $('followInput').value = ''
    $('followName').value = ''
    $('followKindWrap').hidden = true
    say('followMsg', 'Following ' + (r.source.alias || short(r.source.key)) + '.')
    refresh()
  }, 'followMsg')
}

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
// A setting that still follows its env var says so.
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
  const published = new Set((src.published || []).map(p => p.key))
  const tracker = (src.sources || []).find(s => s.primary && s.kind === 'tracker')?.key || (st.tracker || '')
  $('mine').replaceChildren(
    h('div', { class: 'item' }, h('div', { class: 'info' }, h('div', { class: 'name' }, 'Tracker'), h('div', { class: 'meta' }, 'Everything this relay announces · ' + short(tracker))),
      h('div', { class: 'acts' }, copyBtn('Copy link', tracker ? 'peartube://tracker/' + tracker : ''))),
    h('div', { class: 'item' }, h('div', { class: 'info' }, h('div', { class: 'name' }, 'Channel'), h('div', { class: 'meta' }, 'Videos you publish · ' + short(st.channel))),
      h('div', { class: 'acts' }, copyBtn('Copy link', st.channel ? 'peartube://channel/' + st.channel : ''))))
  const following = (src.sources || []).filter(s => !s.writable)
  $('followCount').textContent = following.length ? String(following.length) : ''
  const canEdit = Boolean(S.settings)
  $('following').replaceChildren(...(following.length ? following.map(s => {
    const listed = published.has(s.key)
    return h('div', { class: 'item' },
      h('div', { class: 'info' },
        h('div', { class: 'name' }, s.alias || (s.kind === 'channel' ? 'Channel ' : 'Tracker ') + short(s.key)),
        h('div', { class: 'meta' }, (s.kind === 'channel' ? 'Channel' : 'Tracker') + (listed ? ' · In your directory' : '')),
        canEdit ? switchRow('Keep a copy here', copying(s.key), on => keepCopy(s.key, on)) : null),
      h('div', { class: 'acts' },
        copyBtn('Copy link', 'peartube://' + s.kind + '/' + s.key),
        listed
          ? h('button', { class: 'btn quiet', onclick: e => act(e.currentTarget, async () => { await api('/v1/channel/sources/' + s.key, { method: 'DELETE' }); refresh() }) }, 'Remove from directory')
          : h('button', { class: 'btn quiet', onclick: e => act(e.currentTarget, async () => { await api('/v1/channel/publish', { body: { type: 'source', sourceKey: s.key, kind: s.kind, title: s.alias || short(s.key), target: 'both' } }); refresh() }) }, 'Add to directory'),
        h('button', { class: 'btn quiet', onclick: e => act(e.currentTarget, async () => { await api('/v1/sources/' + s.key, { method: 'DELETE' }); refresh() }) }, 'Unfollow')))
  }) : [h('div', { class: 'empty' }, 'You are not following anything yet.')]))
  const found = (src.discovered || []).filter(d => !(src.sources || []).some(s => s.key === d.key))
  $('foundWrap').hidden = !found.length
  $('found').replaceChildren(...found.map(d => h('div', { class: 'item' },
    h('div', { class: 'info' }, h('div', { class: 'name' }, d.title), h('div', { class: 'meta' }, d.kind === 'channel' ? 'Channel' : 'Tracker')),
    h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: e => act(e.currentTarget, async () => { await api('/v1/sources', { body: { key: d.key, kind: d.kind, alias: d.title } }); refresh() }) }, 'Follow')))))
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
  // A relay serves the TV page on its own address; apps run a separate hub.
  const lanHost = S.status.lan && S.status.lan.host
  const web = (c && c.webReceiverUrl) || (c ? location.protocol + '//' + (lanHost && /^(127[.]|localhost)/.test(location.hostname) ? lanHost + ':' + location.port : location.host) + '/tv' : '')
  $('webTv').replaceChildren(...(web ? [
    h('div', { class: 'row', style: 'align-items:flex-start;gap:16px' },
      c.webReceiverQrSvg ? h('img', { class: 'qr', alt: 'QR code for ' + web, src: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(c.webReceiverQrSvg) }) : null,
      h('div', { class: 'grow' }, h('div', { class: 'hint' }, 'Open this on a smart TV or console browser.'), h('div', { class: 'label', style: 'margin:8px 0;overflow-wrap:anywhere' }, web), copyBtn('Copy address', web)))
  ] : [h('div', { class: 'hint' }, 'Needs a network address. Set one in Settings.')]))
  renderCastBar()
}

// ---- Settings
const GROUPS = [
  { title: 'Network', hint: 'How this relay is reached and who it talks to.', items: [
    { key: 'streamHost', label: 'Stream address for viewers', hint: 'Reachable IP viewers use for playback; never 127.0.0.1.', ph: '192.168.1.20' },
    { key: 'streamPort', label: 'Stream port', hint: 'HTTP blob port players fetch from; open it if firewalled.', ph: '8175' },
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
    { key: 'tracker', label: 'Join a tracker', hint: '64-hex tracker key; this relay writes its own channel.', ph: 'bc7d85ea0eec017d3f6875b4c06c3c16091a50337b4d1709425e3bd35122fbeb' },
    { key: 'publishChannel', label: 'Publish new videos to my channel', hint: 'Off keeps this relay’s library private to itself.' },
    { key: 'directory', label: 'List followed channels in my directory', hint: 'Lets others discover the channels you follow.' },
    { key: 'acquireConcurrency', label: 'Concurrent downloads', hint: 'Each one is a yt-dlp process; higher costs CPU.', ph: '4' },
    { key: 'cinemetaUrl', label: 'Title lookup service', hint: 'Matches titles to IMDb ids; supplies posters and backdrops.', ph: 'https://v3-cinemeta.strem.io' },
    { key: 'watchDir', label: 'Import folder', hint: 'Absolute path on the relay; new files are added automatically.', ph: '/data/import' },
    { key: 'feeds', label: 'Mirrored catalogs (feeds)', hint: 'JSON list of titles and sources; another relay’s /v1/entries works.', ph: 'https://example.org/catalog.json' },
    // Only on relays with videos in the old format (or with the switch already on), like the Storage card.
    { key: 'rechunk', label: 'Convert old-format videos at every start', hint: 'Moves videos from the old shared storage into their own files.', when: () => plugin('blob-rechunk').running || plugin('blob-rechunk').remaining > 0 || sval('rechunk') }
  ] },
  { title: 'Sharing', hint: 'What it keeps for others.', items: [
    { key: 'replicate', label: 'Keep copies of what I follow', hint: 'Seeds followed content until the free-space floor is hit.' },
    { key: 'replicateFreeGb', label: 'Keep this much disk free (GB)', hint: 'Replication stops when free space reaches this.', ph: '20' },
    { key: 'replicateMbps', label: 'Copy speed limit (Mbps)', hint: '0 removes the limit; applies immediately.', ph: '80' },
    { key: 'hiverelayDiscover', label: 'Find HiveRelays automatically', hint: 'Uses a public discovery topic to recruit seeders.' },
    { key: 'hiverelays', label: 'HiveRelays', hint: 'Base URLs of seeding helpers that keep copies.', ph: 'http://192.168.1.50:9100' },
    { key: 'hiverelayApiKey', label: 'HiveRelay access key', hint: 'One key for every HiveRelay listed above.', ph: 'hr_4f1c2a9b7d' },
    { key: 'hiverelayReplicas', label: 'Copies per video on HiveRelays', hint: 'How many HiveRelays hold each video.', ph: '3' },
    { key: 'hiverelayUploadMbps', label: 'HiveRelay upload limit (Mbps)', hint: 'Caps seeding speed to helpers.', ph: '50' }
  ] }
]

const INPUT_TYPE = { host: 'text', port: 'number', number: 'number', key: 'text', path: 'text', url: 'url', secret: 'password' }
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
  else soon()
}
// Progress polls only while something is moving.
setInterval(() => {
  const busy = S.jobs.some(j => j.status === 'running' || j.status === 'queued' || j.status === 'announcing') || plugin('p2p-replicate').replicating || plugin('blob-rechunk').running
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

// GPU BT.709 YUV420P WebGL renderer: uploads planar Y/U/V straight to textures in ~0.15ms with zero CPU color conversion.
let yuvGl = null
function getYuvGl () {
  if (yuvGl !== null) return yuvGl
  const c = $('pGlCanvas')
  const gl = c.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false })
  if (!gl) { yuvGl = false; return false }
  const vs = gl.createShader(gl.VERTEX_SHADER)
  gl.shaderSource(vs, 'attribute vec2 a_pos;varying vec2 v_uv;uniform vec4 u_crop;void main(){vec2 uv=vec2(a_pos.x*0.5+0.5,0.5-a_pos.y*0.5);v_uv=mix(u_crop.xy,u_crop.zw,uv);gl_Position=vec4(a_pos,0.0,1.0);}')
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
  const cropLoc = gl.getUniformLocation(prog, 'u_crop')
  gl.uniform4f(cropLoc, 0, 0, 1, 1)
  yuvGl = { gl, canvas: c, texY, texU, texV, cropLoc, w: 0, h: 0 }
  return yuvGl
}

function audioOutTime (ctx) {
  if (!ctx) return 0
  const ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null
  return (ts && ts.contextTime > 0) ? ts.contextTime : ctx.currentTime
}
// One shared WASM Worker, compiled when a Play button is about to be used, so playback opens without a compile wait.
const ASSET_VER = '?v=6'
let sharedWorker = null
let workerCanvasTransferred = false
let workerOffscreenReady = false
function nowWallMs () { return (performance.timeOrigin || 0) + performance.now() }
function getWorker () {
  if (!sharedWorker) {
    sharedWorker = new Worker('/web/player-worker.js' + ASSET_VER)
    // The Worker's OffscreenCanvas renderer dropped pictures on long titles (18 fps on Batman's
    // VC-1 where this page-side GL holds 24). Keep the canvas here and let the worker post frames.
    sharedWorker.postMessage({ cmd: 'warmup', wasmUrl: location.origin + '/web/peartube_web.wasm' + ASSET_VER })
  }
  return sharedWorker
}
// The player is a 16 MB download: warm it on the way to a Play button, not on every visit.
for (const evName of ['pointerover', 'focusin', 'touchstart']) {
  addEventListener(evName, ev => {
    if (!sharedWorker && ev.target.closest && ev.target.closest('[data-play]')) { try { getWorker() } catch {} }
  }, { passive: true })
}

let openCounter = 0

function closePlayer () {
  if (!player) return
  clearTimeout(seekTimer)
  seekTarget = null
  const p = player
  player = null
  $('playerModal').classList.remove('open')
  cancelAnimationFrame(p.raf)
  clearInterval(p.creditTimer)
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

function openPlayer (entry, at = 0) {
  closePlayer()
  playerEntry = entry
  const streamUrl = resolveStreamUrl(entry.streamUrl)
  const worker = getWorker()
  $('pTitle').textContent = entry.title || entry.id
  $('pBadge').textContent = 'Opening…'
  $('pRawLink').href = streamUrl
  $('pStatus').style.display = ''
  $('pStatus').textContent = 'Buffering stream…'
  $('pSubText').textContent = ''
  $('pPlayBtn').textContent = 'Pause'
  $('pSeek').value = '0'
  $('pClock').textContent = '0:00 / 0:00'
  $('playerModal').classList.add('open')

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
  const p = {
    entry,
    startAt: Math.max(0, Number(at) || 0),
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
    try { worker.postMessage({ cmd: 'clock', time: timeSecs, wallMs: nowWallMs(), playing, hidden: document.visibilityState !== 'visible' }) } catch {}
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
      $('pBadge').textContent = 'Can’t play this file'
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

      if (typeof m.offscreen === 'boolean') workerOffscreenReady = m.offscreen
      p.webCodecsSupported = Boolean(m.webCodecsSupported)
      const MS = window.MediaSource || window.ManagedMediaSource
      p.useMse = Boolean(p.videoStream >= 0 && mf.mseCodec && MS && MS.isTypeSupported('video/mp4; codecs="' + mf.mseCodec + '"'))
      p.allowWebCodecs = Boolean(!p.useMse && p.videoStream >= 0 && p.webCodecsSupported)
      p.usingWebCodecs = p.allowWebCodecs
      if (p.useMse) {
        setupMse(p.startAt)
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
      // Hidden pictures are kept in a small ring, not dropped: the newest is the live one, so the
      // first tick after return draws instantly instead of waiting seconds for future frames.
      // Cap it at ~3 s so a long hidden stretch cannot pile up gigabytes of YUV.
      if (document.visibilityState !== 'visible' && p.swFrames.length >= 72) {
        recycleVideoBuf(p.swFrames.shift().buf)
      }
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
    } else if (m.type === 'readBlock') {
      p.lastReadBlock = m.block
      // The Worker missed this block, so a stale done mark must not make the page skip refetching it.
      if (m.force) p.prefetchDone.delete(m.block)
      pumpPrefetch(p)
    } else if (m.type === 'videoCrop') {
      p.videoCrop = m.full ? null : { x: m.left, y: m.top, w: m.right - m.left, h: m.bottom - m.top, cw: m.w, ch: m.h }
    } else if (m.type === 'flushed') {
      // A seek with the same streams (audio or subtitle switch) does not re-prime, so clear the
      // buffering notice here instead of leaving "Seeking…" over a playing picture forever.
      if (player === p) $('pStatus').style.display = 'none'
    } else if (m.type === 'eof') {
      p.eof = true
      tryPrime()
    }
  }

  // Blocks the demuxer is about to need, fetched here where fetch() is reliable (the Worker's own
  // prefetch can hang, and one blocked sync read drops every picture due behind it).
  const BLOCK_BYTES = 2 * 1024 * 1024
  function pumpPrefetch (p) {
    if (!p || player !== p || !p.worker || !p.streamUrl) return
    const base = p.lastReadBlock
    if (!Number.isFinite(base)) return
    // The block the demuxer is on plus a deep window: a relay range can stall for seconds on a cold
    // block, and the Worker's fallback read is synchronous, so the next blocks must already be here.
    for (let i = 0; i <= 12; i++) {
      if (p.prefetchInFlight.size >= 4) break
      const idx = base + i
      if (idx < 0) continue
      if (p.prefetchDone.has(idx) || p.prefetchInFlight.has(idx)) continue
      const start = idx * BLOCK_BYTES
      const end = start + BLOCK_BYTES - 1
      const ctl = new AbortController()
      p.prefetchInFlight.set(idx, ctl)
      // A fetch that never settles holds a slot forever; with every slot stuck the Worker falls back
      // to its blocking sync read, which freezes the whole frame clock. Cut it loose and retry.
      const killTimer = setTimeout(() => { try { ctl.abort() } catch {} }, 6000)
      const settle = () => { clearTimeout(killTimer); p.prefetchInFlight.delete(idx) }
      fetch(p.streamUrl, { headers: { range: 'bytes=' + start + '-' + end }, signal: ctl.signal })
        .then(r => (r.ok || r.status === 206) ? r.arrayBuffer() : null)
        .then(ab => {
          clearTimeout(killTimer)
          p.prefetchInFlight.delete(idx)
          if (!ab || player !== p) return
          p.prefetchDone.add(idx)
          if (p.prefetchDone.size > 96) p.prefetchDone.clear()
          try { p.worker.postMessage({ cmd: 'block', block: idx, buf: ab }, [ab]) } catch {}
          pumpPrefetch(p)
        })
        .catch(() => {
          settle()
          if (player === p) setTimeout(() => { if (player === p) pumpPrefetch(p) }, 400)
        })
    }
  }

  function drawSwFrame (f) {
    p.lastDrawWall = performance.now()
    if ($('pStatus').textContent === 'Buffering…') $('pStatus').style.display = 'none'
    const r = (f.yuv && !workerCanvasTransferred) ? getYuvGl() : false
    const crop = p.videoCrop && p.videoCrop.w > 0 && p.videoCrop.cw === f.w && p.videoCrop.ch === f.h ? p.videoCrop : null
    const ow = crop ? crop.w : f.w, oh = crop ? crop.h : f.h
    if (r) {
      if (glCanvas.style.display !== 'block') { glCanvas.style.display = 'block'; canvas.style.display = 'none' }
      const { gl } = r
      const cw = (f.w + 1) >> 1, ch = (f.h + 1) >> 1
      const u8 = new Uint8Array(f.buf, 0, f.byteLen || f.buf.byteLength)
      const yLen = f.w * f.h, cLen = cw * ch
      const ySub = u8.subarray(0, yLen)
      const uSub = u8.subarray(yLen, yLen + cLen)
      const vSub = u8.subarray(yLen + cLen, yLen + cLen * 2)
      const resized = (r.w !== ow || r.h !== oh)
      if (resized) {
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
      }
    }

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
      const seekVal = String(Math.min(1000, Math.round((now / p.duration) * 1000)))
      if (seekVal !== p.lastSeekVal) { p.lastSeekVal = seekVal; $('pSeek').value = seekVal }
    }
    // Rewriting the same text node every frame makes the clock shimmer; only touch the DOM when
    // the formatted time actually changes (once a second), not on every animation frame.
    const clockText = fmtClock(now) + ' / ' + fmtClock(p.duration)
    if (clockText !== p.lastClockText) { p.lastClockText = clockText; $('pClock').textContent = clockText }
    if (p.duration > 0 && playerEntry && Date.now() - lastResumeSave > 4000) {
      lastResumeSave = Date.now()
      saveResume(playerEntry, now, p.duration)
    }
    if (p.primed && !p.paused && !p.seeking && document.visibilityState === 'visible' &&
        p.lastDrawWall && performance.now() - p.lastDrawWall > 1200 &&
        $('pStatus').style.display === 'none') {
      // The clock keeps running off the audio clock even while the picture stalls; say so instead of
      // leaving a frozen frame with no explanation. A drawn frame (or a playing video element) clears it.
      $('pStatus').textContent = 'Buffering…'
      $('pStatus').style.display = 'block'
    }
  }
  p.raf = requestAnimationFrame(tick)
  // Visibility, credits and the worker's clock must not ride requestAnimationFrame: a hidden or
  // unfocused window stops that loop, so the Worker never learns it is hidden and keeps posting
  // pictures nobody consumes until the tab balloons and freezes. A 250 ms timer (Clamped to ~1 s
  // while hidden) reports instead; the Worker still owns decode and the audio-only switch.
  p.creditTimer = setInterval(() => {
    if (player !== p) { clearInterval(p.creditTimer); return }
    if (!p.primed || !p.worker) return
    const vSec = p.consumedVideoSec
    const aSec = p.consumedAudioSec
    p.consumedVideoSec = 0
    p.consumedAudioSec = 0
    p.worker.postMessage({ cmd: 'consumed', videoSec: vSec, audioSec: aSec, time: currentMediaTime(), wallMs: nowWallMs(), playing: !p.paused, hidden: document.visibilityState !== 'visible' })
  }, 250)

  const vid = $('pVideo')
  if (vid) {
    vid.addEventListener('waiting', () => {
      if (player !== p) return
      $('pStatus').textContent = 'Buffering…'
      $('pStatus').style.display = 'block'
    })
    vid.addEventListener('playing', () => {
      if (player === p && $('pStatus').textContent === 'Buffering…') $('pStatus').style.display = 'none'
    })
  }
  const extMatch = (entry.streamUrl || '').split('?')[0].split('.').pop() || ''
  worker.postMessage({ cmd: 'open', seq: p.seq, streamUrl, wasmUrl: location.origin + '/web/peartube_web.wasm' + ASSET_VER, ext: extMatch.length <= 5 ? extMatch : '' })
  // Start the page fetch before the demuxer reaches its first block edge: waiting for the Worker to
  // miss a block means the miss is already costing a blocking read.
  p.lastReadBlock = 0
  p.prefetchDone.clear()
  pumpPrefetch(p)
  return p
}

function togglePlay () {
  if (!player) return
  if (player.ended) {
    player.ended = false
    player.paused = false
    $('pPlayBtn').textContent = 'Pause'
    player.audioCtx?.resume?.().catch(() => {})
    seekTo(0)
    return
  }
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
  if (player.ended) {
    player.ended = false
    $('pPlayBtn').textContent = 'Play'
  }
  const clamped = Math.max(0, player.duration > 0 ? Math.min(player.duration, targetSecs) : targetSecs)
  player.seq = ++openCounter
  player.eof = false
  $('pStatus').style.display = ''
  $('pStatus').textContent = 'Seeking…'
  player.drawnFrames = 0
  player.videoCrop = null
  for (const ctl of player.prefetchInFlight.values()) { try { ctl.abort() } catch {} }
  player.prefetchInFlight.clear()
  player.prefetchDone.clear()
  player.lastReadBlock = -1
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
$('pStage').onclick = () => {
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
  const from = seekTarget ?? (player.freeBaseMedia || 0)
  seekTarget = Math.max(0, player.duration > 0 ? Math.min(player.duration, from + deltaSecs) : from + deltaSecs)
  $('pStatus').style.display = ''
  $('pStatus').textContent = 'Seeking to ' + fmtClock(seekTarget)
  clearTimeout(seekTimer)
  seekTimer = setTimeout(() => { const t = seekTarget; seekTarget = null; seekTo(t) }, 350)
}
$('pBackBtn').onclick = () => nudge(-10)
$('pFwdBtn').onclick = () => nudge(10)
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
// A hidden tab has no picture to show, but the player keeps its timeline (the Worker owns decode and
// the clock). On return, make the browser's video element play again if it paused it in the
// background; the GL path restarts its render loop from the first clock message of the next frame.
function resyncOnReturn () {
  if (!player || player.paused) return
  const p = player
  const audio = p.freeBaseMedia || 0
  // The first click that brings the window back is a focus click, not a play/pause command.
  p.suppressStageClickUntil = performance.now() + 900
  if (p.audioCtx?.state === 'suspended') p.audioCtx.resume().catch(() => {})
  if (p.useMse) {
    const v = $('pVideo')
    v.playbackRate = 1
    if (v.paused) v.play().catch(() => {})
    // Hard A/V sync after any absence. The SourceBuffer keeps filling while hidden, so if the live
    // position is buffered we can snap the element there instantly; only a real hole needs a seek.
    let buffered = false
    for (let i = 0; i < v.buffered.length; i++) {
      if (audio >= v.buffered.start(i) && audio + 0.25 <= v.buffered.end(i)) { buffered = true; break }
    }
    if (!buffered) seekTo(audio)
    else if (Math.abs(v.currentTime - audio) > 0.2) { try { v.currentTime = audio } catch {} }
    p.lastMseTime = audio
    p.lastHardSync = performance.now()
  } else {
    // The tick draws from the ring on the next frame; the stale ones are dropped by its due loop.
    p.lastSwPts = null
  }
  p.syncWorkerClock?.(audio, true)
}
addEventListener('visibilitychange', () => {
  if (!player) return
  const hidden = document.visibilityState !== 'visible'
  player.syncWorkerClock?.(player.freeBaseMedia || 0, !player.paused)
  if (!hidden) resyncOnReturn()
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
