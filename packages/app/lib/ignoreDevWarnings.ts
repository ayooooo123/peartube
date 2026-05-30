import { LogBox } from 'react-native'

const IGNORED_DEV_WARNINGS = [
  'SafeAreaView has been deprecated and will be removed in a future release.',
]

const WARN_PATCH_KEY = '__PEARTUBE_DEV_WARNINGS_PATCHED__'
const ORIGINAL_WARN_KEY = '__PEARTUBE_ORIGINAL_CONSOLE_WARN__'

if (typeof __DEV__ !== 'undefined' && __DEV__) {
  LogBox.ignoreLogs(IGNORED_DEV_WARNINGS)
  LogBox.clearAllLogs()
  setTimeout(() => LogBox.clearAllLogs(), 0)

  const g = globalThis as Record<string, any>
  if (!g[ORIGINAL_WARN_KEY]) {
    g[ORIGINAL_WARN_KEY] = console.warn
  }

  if (!g[WARN_PATCH_KEY]) {
    const originalWarn = g[ORIGINAL_WARN_KEY]
    console.warn = (...args: any[]) => {
      const message = args.map((arg) => String(arg)).join(' ')
      if (IGNORED_DEV_WARNINGS.some((ignored) => message.includes(ignored))) {
        return
      }
      originalWarn(...args)
    }
    g[WARN_PATCH_KEY] = true
  }
}

export { IGNORED_DEV_WARNINGS }
