const FOOTER = 'peartube add · interactive'
const BAR_WIDTH = 20
const ANSI_PATTERN = /\u001b\[[0-9;?]*[A-Za-z]/g

const MULTI_SELECT_SCREENS = new Set(['episodeSelection', 'bulkMapping'])

const LIST_SCREENS = {
  search: { subtitle: 'Find content', label: 'Search', action: 'Select' },
  tvSeason: { subtitle: 'Choose a season', label: 'Season', action: 'Select' },
  episodeSelection: { subtitle: 'Choose episodes', label: 'Episode', action: 'Continue' },
  movieSource: { subtitle: 'Paste a URL or type a file path', label: 'Source', action: 'Select' },
  creatorContent: { subtitle: 'Choose content', label: 'Content', action: 'Select' },
  creatorAttachment: { subtitle: 'Attach creator source', label: 'Attachment', action: 'Select' },
  sourceSelection: { subtitle: 'Paste a URL or type a file path', label: 'Source', action: 'Select' },
  bulkMapping: { subtitle: 'Verify source mapping', label: 'Mapping', action: 'Continue' },
  review: { subtitle: 'Confirm and publish', label: 'Review', action: 'Publish' }
}

const PHASE_LABELS = {
  pending: 'Pending',
  resolving: 'Resolving',
  downloading: 'Downloading',
  uploading: 'Uploading',
  uploaded: 'Uploaded',
  replicationPending: 'Replication pending',
  durabilityVerified: 'Durability verified',
  projecting: 'Projecting',
  projected: 'Projected',
  announcing: 'Announcing',
  announced: 'Announced',
  finalizing: 'Finalizing',
  published: 'Published',
  failed: 'Failed',
  skipped: 'Skipped'
}

const RESULT_LABELS = {
  completed: 'Completed',
  error: 'Error',
  cancelled: 'Cancelled',
  exited: 'Exited'
}

export function stripAnsi (value) {
  return String(value).replace(ANSI_PATTERN, '')
}

export function displayWidth (value) {
  let width = 0
  for (const cell of toCells(stripAnsi(value))) width += cell.width
  return width
}

export function truncateDisplay (value, max) {
  const text = String(value)
  const cells = toCells(text)
  const total = cells.reduce((sum, cell) => sum + cell.width, 0)
  if (total <= max) return text
  const budget = max - 1
  let width = 0
  let out = ''
  for (const cell of cells) {
    if (width + cell.width > budget) break
    out += cell.chars
    width += cell.width
  }
  return out + '…'
}

export function renderPickerLines (state, options = {}) {
  const columns = Number.isFinite(options.columns) ? options.columns : 80
  const rows = Number.isFinite(options.rows) ? options.rows : 24
  const color = options.color !== false
  const frame = buildFrame(state, rows)
  const limit = Math.max(1, columns - 1)
  return frame.map(entry => {
    const truncated = truncateDisplay(entry.text, limit)
    return color && entry.active ? `\u001b[36m${truncated}\u001b[0m` : truncated
  })
}

export function renderPicker (state, options = {}) {
  return renderPickerLines(state, options).join('\n')
}

function buildFrame (state, rows) {
  switch (state.screen) {
    case 'progress':
      return progressFrame(state)
    case 'exitConfirm':
      return exitConfirmFrame(state)
    case 'result':
      return resultFrame(state)
    default:
      return listFrame(state, rows)
  }
}

function listFrame (state, rows) {
  const config = LIST_SCREENS[state.screen] || LIST_SCREENS.search
  const pane = state.screens[state.screen] || {
    input: { value: '' },
    results: { items: [] },
    selection: { index: 0, selected: [] }
  }
  const top = [
    line('PearTube Add'),
    line(config.subtitle),
    line(`${config.label}: ${pane.input.value}`),
    line('')
  ]
  const bottom = [
    line(''),
    line(`↑/↓ Move  Tab Complete  Enter ${config.action}  Esc Back`),
    line(FOOTER)
  ]
  const rowLines = []
  if (state.screen === 'bulkMapping') rowLines.push(line('  Source │ Target'))
  const budget = Math.max(0, rows - top.length - bottom.length - rowLines.length)
  const items = pane.results.items
  const selectedIndex = pane.selection.index
  for (const { item, index } of windowItems(items, selectedIndex, budget)) {
    rowLines.push(formatRow(state.screen, item, index, selectedIndex, pane))
  }
  return [...top, ...rowLines, ...bottom]
}

function formatRow (screen, item, index, selectedIndex, pane) {
  const active = index === selectedIndex
  const cursor = active ? '› ' : '  '
  const text = itemText(screen, item)
  const box = MULTI_SELECT_SCREENS.has(screen)
    ? (pane.selection.selected.includes(candidateIdentity(item, index)) ? '[x] ' : '[ ] ')
    : ''
  return line(`${cursor}${box}${text}`, active)
}

function itemText (screen, item) {
  switch (screen) {
    case 'search': {
      const kind = String(item.kind || item.type || '').toUpperCase()
      const badge = kind ? `[${kind}] ` : ''
      const year = item.year != null ? ` (${item.year})` : ''
      return `${badge}${item.label}${year}`
    }
    case 'tvSeason':
      return `${item.label}${item.episodeCount != null ? ` · ${item.episodeCount} episodes` : ''}`
    case 'episodeSelection':
      return `S${pad2(item.seasonNumber)}E${pad2(item.episodeNumber)} · ${item.title}`
    case 'creatorAttachment':
      return `[${String(item.platform || '').toUpperCase()}] ${item.label} · ${item.status}`
    case 'bulkMapping':
      return `${item.source} │ ${item.target} · ${item.confidence}`
    default:
      return String(item.label ?? item.title ?? '')
  }
}

function progressFrame (state) {
  const progress = state.progress || {}
  const lines = [line('PearTube Add'), line('Publishing'), line('')]
  lines.push(line(`Phase: ${PHASE_LABELS[progress.phase] || 'Working'}`))
  if (progress.title) lines.push(line(`Item: ${progress.title}`))
  if (Number.isFinite(progress.completed) && Number.isFinite(progress.total) && progress.total > 0) {
    const ratio = progress.completed / progress.total
    const filled = Math.round(ratio * BAR_WIDTH)
    const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, BAR_WIDTH - filled))
    const pct = Math.round(ratio * 100)
    lines.push(line(`Progress: ${progress.completed}/${progress.total} [${bar}] ${pct}%`))
  }
  if (progress.message) lines.push(line(progress.message))
  lines.push(line(''))
  lines.push(line('Ctrl-C Exit safely'))
  lines.push(line(FOOTER))
  return lines
}

function exitConfirmFrame (state) {
  const progress = (state.exitConfirm && state.exitConfirm.resume && state.exitConfirm.resume.progress) || {}
  const checkpoint = progress.checkpoint || {}
  return [
    line('PearTube Add'),
    line('Publication in progress'),
    line(''),
    line('Publishing is past the durable checkpoint.'),
    line('Exit without rolling back published work?'),
    line(`Checkpoint: ${checkpoint.jobId ?? 'unknown'}`),
    line(''),
    line('Enter Exit safely  Esc Keep waiting'),
    line(FOOTER)
  ]
}

function resultFrame (state) {
  const result = state.result || {}
  const label = RESULT_LABELS[result.status] || 'Result'
  const detail = (result.value && result.value.message) || (result.error && result.error.message) || ''
  return [
    line('PearTube Add'),
    line('Result'),
    line(''),
    line(label),
    line(detail),
    line(''),
    line('Enter Close'),
    line(FOOTER)
  ]
}

function windowItems (items, index, budget) {
  if (budget <= 0 || items.length === 0) return []
  let start = 0
  if (index >= budget) start = index - budget + 1
  start = Math.max(0, Math.min(start, Math.max(0, items.length - budget)))
  const end = Math.min(items.length, start + budget)
  const out = []
  for (let cursor = start; cursor < end; cursor += 1) out.push({ item: items[cursor], index: cursor })
  return out
}

function line (text, active = false) {
  return { text, active }
}

function pad2 (value) {
  return String(value).padStart(2, '0')
}

// Mirrors picker-state candidateIdentity so selection membership matches stored keys.
function candidateIdentity (candidate, index = 0) {
  const key = candidate.id ?? candidate.key ?? candidate.value ?? candidate.path ??
    candidate.label ?? candidate.completion ?? index
  return JSON.stringify({
    kind: candidate.kind ?? null,
    type: candidate.type ?? null,
    provider: candidate.provider ?? null,
    source: candidate.source ?? null,
    keyType: typeof key,
    key
  })
}

function toCells (text) {
  const cells = []
  for (const char of text) {
    const width = charWidth(char.codePointAt(0))
    if (width === 0 && cells.length > 0) {
      cells[cells.length - 1].chars += char
      continue
    }
    cells.push({ chars: char, width })
  }
  return cells
}

function charWidth (code) {
  if (isZeroWidth(code)) return 0
  if (isWide(code)) return 2
  return 1
}

function isZeroWidth (code) {
  return (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe20 && code <= 0xfe2f) ||
    (code >= 0x200b && code <= 0x200f) ||
    code === 0xfeff
  )
}

function isWide (code) {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}
