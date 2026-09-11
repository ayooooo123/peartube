// Shared "Grid" stylesheet for the relay's server-rendered pages. Same design
// language as the client apps: true-black base, lime accent, cyan reserved for
// peer presence, 4px corners, 2px structural rules, monospace for every fact.
// Body copy stays on the system sans; the display face is served from /fonts.

export const UI_FONT_ROUTE = '/fonts/Syne-ExtraBold.ttf'

export const GRID_THEME_CSS = `
    @font-face {
      font-family: 'Syne';
      font-weight: 800;
      font-style: normal;
      font-display: swap;
      src: url('${UI_FONT_ROUTE}') format('truetype');
    }
    :root {
      color-scheme: dark;
      --bg: #000000;
      --surface: #0f0f0f;
      --surface-2: #1a1a1a;
      --active: #262626;
      --line: #262626;
      --line-soft: #1a1a1a;
      --line-strong: #3d3d3d;
      --ink: #f2f2f2;
      --ink-2: #a3a3a3;
      --muted: #6b6b6b;
      --disabled: #3d3d3d;
      --accent: #d4ff3f;
      --accent-hover: #e2ff70;
      --accent-tint: rgba(212, 255, 63, 0.14);
      --on-accent: #000000;
      --swarm: #39d5ff;
      --ok: #7dff8a;
      --warn: #ffc53f;
      --danger: #ff4d4d;
      --danger-tint: rgba(255, 77, 77, 0.14);
      --warn-tint: rgba(255, 197, 63, 0.14);
      --rule: 2px;
      --radius: 4px;
      --display: 'Syne', 'Arial Black', Impact, sans-serif;
      --mono: ui-monospace, 'JetBrains Mono', SFMono-Regular, Menlo, Consolas, monospace;
      --sans: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
      font-family: var(--sans);
    }
    * { box-sizing: border-box; }
    html { background: var(--bg); }
    body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--ink); font-size: 14px; line-height: 1.5; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { color: var(--accent-hover); }
    code, .mono { font-family: var(--mono); font-size: 12px; color: var(--ink-2); word-break: break-all; }
    h1, h2, h3 { margin: 0; font-family: var(--display); font-weight: 800; letter-spacing: -0.02em; text-transform: uppercase; line-height: 1.05; }
    h1 { font-size: clamp(28px, 4vw, 44px); }
    h2 { font-size: 18px; }
    h3 { font-size: 15px; }
    .eyebrow, .kicker { display: block; font-family: var(--mono); font-size: 11px; font-weight: 500; letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent); }
    header { position: sticky; top: 0; z-index: 10; background: var(--bg); border-bottom: var(--rule) solid var(--line); }
    .brand { display: flex; align-items: center; gap: 10px; min-width: max-content; font-family: var(--display); font-size: 15px; letter-spacing: -0.02em; text-transform: uppercase; color: var(--ink); }
    .brand .dot { display: inline-block; width: 8px; height: 8px; border-radius: 0; background: var(--accent); box-shadow: none; margin: 0; }
    nav { display: flex; gap: 2px; }
    nav a { padding: 8px 12px; border-radius: 0; border-bottom: var(--rule) solid transparent; color: var(--muted); font-family: var(--mono); font-size: 11px; font-weight: 500; letter-spacing: 0.12em; text-transform: uppercase; transition: color 120ms ease; }
    nav a:hover { color: var(--ink); background: transparent; }
    nav a.on, nav a[aria-current="page"] { color: var(--accent); background: transparent; border-bottom-color: var(--accent); }
    .spacer { flex: 1; }
    input, textarea, select {
      width: 100%;
      border: var(--rule) solid var(--line);
      border-radius: var(--radius);
      padding: 9px 12px;
      background: var(--surface-2);
      color: var(--ink);
      font: inherit;
      transition: border-color 120ms ease;
    }
    input::placeholder, textarea::placeholder { color: var(--muted); font-family: var(--mono); font-size: 12px; letter-spacing: 0.02em; }
    input:hover, textarea:hover, select:hover { border-color: var(--line-strong); }
    input:focus, textarea:focus, select:focus { outline: none; border-color: var(--accent); box-shadow: none; background: var(--surface-2); }
    input[type=checkbox] { width: auto; accent-color: var(--accent); }
    input[type=search] { font-family: var(--mono); font-size: 13px; }
    button, summary, .btn {
      border: var(--rule) solid var(--accent);
      border-radius: var(--radius);
      padding: 9px 16px;
      background: var(--accent);
      color: var(--on-accent);
      font-family: var(--display);
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      cursor: pointer;
      transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
    }
    button:hover, summary:hover { background: var(--accent-hover); border-color: var(--accent-hover); filter: none; box-shadow: none; }
    button:active, summary:active { transform: none; }
    button:focus-visible, summary:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: var(--rule) solid var(--swarm); outline-offset: 2px; }
    button.ghost, button.act { background: transparent; border-color: var(--line-strong); color: var(--ink); }
    button.ghost:hover, button.act:hover { border-color: var(--accent); color: var(--accent); background: transparent; }
    button.act.danger:hover, button.ghost.danger:hover { border-color: var(--danger); color: var(--danger); }
    button[disabled] { opacity: 0.4; cursor: not-allowed; }
    .tag, .chip, .pill, .status-badge, .status, .seed-chip {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 2px 7px;
      border: 1px solid var(--line);
      border-radius: 2px;
      background: transparent;
      color: var(--ink-2);
      font-family: var(--mono); font-size: 10px; font-weight: 500; letter-spacing: 0.1em; text-transform: uppercase;
      backdrop-filter: none;
    }
    .tag.ok, .pill.completed, .status-badge.ok, .status.seeding, .tag.seeding, .tag.completed, .tag.res-local { color: var(--accent); border-color: var(--accent); background: transparent; }
    .tag.warn, .pill.failed, .pill.cancelled, .status.missing, .tag.failed { color: var(--danger); border-color: var(--danger); background: transparent; }
    .pill.running, .pill.queued, .status.in-network, .tag.acquiring, .tag.verifying, .tag.publishing, .tag.queued, .tag.res-partial, .tag.res-transferring { color: var(--warn); border-color: var(--warn); background: transparent; }
    .status.in-network { color: var(--swarm); border-color: var(--swarm); }
    .tag.res-unproven, .tag.res-none { color: var(--muted); border-style: dashed; }
    .chip.on { color: var(--on-accent); background: var(--accent); border-color: var(--accent); }
    .card, .empty, .mono-key, .meta-block, .notice {
      border: var(--rule) solid var(--line);
      border-radius: var(--radius);
      background: var(--surface);
      box-shadow: none;
    }
    .empty { border-style: dashed; color: var(--muted); text-align: center; font-family: var(--mono); font-size: 12px; }
    .notice { border-color: var(--warn); color: var(--ink); }
    .library-progress, .transfer-bar, .pct .bar { height: var(--rule); border-radius: 0; background: var(--active); box-shadow: none; overflow: hidden; }
    .bar-fill, .library-progress span, .transfer-bar span, .pct .bar i { display: block; height: 100%; border-radius: 0; background: var(--accent); }
    .bar-fill.ok { background: var(--accent); }
    .bar-fill.warn { background: var(--warn); }
    ::selection { background: var(--accent); color: var(--on-accent); }
`
