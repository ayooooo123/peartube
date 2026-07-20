import readline from 'node:readline'
import { reducePicker } from './picker-state.js'
import { renderPickerLines } from './render.js'

const HIDE_CURSOR = '\u001b[?25l'
const SHOW_CURSOR = '\u001b[?25h'

export class TerminalUsageError extends Error {
  constructor (message, { code, exitCode = 2 } = {}) {
    super(message)
    this.name = 'TerminalUsageError'
    this.code = code
    this.exitCode = exitCode
  }
}

export function mapKeypressToAction (str, key = {}) {
  const name = key && key.name
  if (key && key.ctrl && name === 'c') return { type: 'interrupt' }

  switch (name) {
    case 'up': return { type: 'selection.move', delta: -1 }
    case 'down': return { type: 'selection.move', delta: 1 }
    case 'tab': return { type: 'selection.complete' }
    case 'return':
    case 'enter': return { type: 'step.confirm' }
    case 'escape': return { type: 'step.back' }
    case 'backspace': return { type: 'query.deleteBackward' }
    case 'delete': return { type: 'query.deleteForward' }
    case 'left': return { type: 'query.cursor', delta: -1 }
    case 'right': return { type: 'query.cursor', delta: 1 }
    case 'home': return { type: 'query.home' }
    case 'end': return { type: 'query.end' }
  }

  if (typeof str !== 'string' || str.length === 0) return null
  if (str.charCodeAt(0) === 0x1b) return null
  const text = stripControl(str)
  return text.length > 0 ? { type: 'query.insert', text } : null
}

export function runTerminal (options = {}) {
  const { input, output, signals } = options
  if (!input || !input.isTTY || !output || !output.isTTY) {
    return Promise.reject(new TerminalUsageError(
      'Interactive add requires a TTY. Re-run in a terminal or pass --no-input for scripted mode.',
      { code: 'ERR_PEARTUBE_TTY_REQUIRED', exitCode: 2 }
    ))
  }

  return new Promise((resolve, reject) => {
    const render = typeof options.render === 'function'
      ? options.render
      : (state) => renderPickerLines(state, {
          columns: output.columns || 80,
          rows: output.rows || 24,
          color: output.isTTY
        })

    let state = options.initialState
    let previousLineCount = 0
    let cleaned = false

    const onKeypress = (str, key) => handle(mapKeypressToAction(str, key || {}))
    const onSigint = () => handle({ type: 'interrupt' })

    const dataListenersBefore = input.listeners('data')
    input.setRawMode(true)
    output.write(HIDE_CURSOR)
    readline.emitKeypressEvents(input)
    input.on('keypress', onKeypress)
    signals.on('SIGINT', onSigint)

    if (typeof options.onReady === 'function') options.onReady(handle)

    if (!draw()) return
    if (state.result) finish(state)

    function draw () {
      let lines
      try {
        lines = render(state)
      } catch (error) {
        cleanup()
        reject(error)
        return false
      }
      output.write(frameFor(lines, previousLineCount))
      previousLineCount = lines.length
      if (typeof options.onState === 'function') options.onState(state, handle)
      return true
    }

    function handle (rawAction) {
      if (cleaned || !rawAction) return
      const action = adaptAction(rawAction, state)
      if (!action) return
      if (typeof options.onAction === 'function') options.onAction(action, handle)
      state = reducePicker(state, action)
      if (!draw()) return
      if (state.result) finish(state)
    }

    function finish (value) {
      cleanup()
      resolve(value)
    }

    function cleanup () {
      if (cleaned) return
      cleaned = true
      input.removeListener('keypress', onKeypress)
      signals.removeListener('SIGINT', onSigint)
      for (const listener of input.listeners('data')) {
        if (!dataListenersBefore.includes(listener)) input.removeListener('data', listener)
      }
      input.setRawMode(false)
      output.write(SHOW_CURSOR)
    }
  })
}

function adaptAction (action, state) {
  if (state.screen === 'exitConfirm') {
    if (action.type === 'step.confirm') return { type: 'exit.confirm' }
    if (action.type === 'step.back') return { type: 'exit.dismiss' }
    if (action.type === 'interrupt') return null
  }
  return action
}

function frameFor (lines, previousLineCount) {
  let out = '\r'
  if (previousLineCount > 1) out += `\u001b[${previousLineCount - 1}A`
  out += '\u001b[J'
  out += lines.join('\r\n')
  return out
}

function stripControl (value) {
  let out = ''
  for (const char of value) {
    const code = char.codePointAt(0)
    if (code < 0x20 || code === 0x7f) continue
    out += char
  }
  return out
}
