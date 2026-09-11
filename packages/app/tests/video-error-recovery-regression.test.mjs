import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { test } from 'node:test'

const inlineViewPath = new URL('../components/video-player/PearInlineVideoView.tsx', import.meta.url)

async function source(url) {
  return readFile(url, 'utf8')
}

async function loadErrorHandler() {
  const appRoot = fileURLToPath(new URL('..', import.meta.url))
  const stubs = {
    'react-native-stub': "export * from 'react-native-web'\n",
    'expo-stub': 'export const useEventListener = () => {}\n',
    'expo-video-stub': 'export const useVideoPlayer = () => null\nexport const VideoView = () => null\n',
    'player-stub': 'export const createPlayerPort = () => null\n',
    'mse-stub': 'export const WebMseVideoBackend = () => null\n',
  }
  const plugin = {
    name: 'instrument-player-error-handler',
    setup(builder) {
      builder.onResolve({ filter: /^react-native$/ }, () => ({ path: 'react-native-stub', namespace: 'error-stub' }))
      builder.onResolve({ filter: /^expo$/ }, () => ({ path: 'expo-stub', namespace: 'error-stub' }))
      builder.onResolve({ filter: /^expo-video$/ }, () => ({ path: 'expo-video-stub', namespace: 'error-stub' }))
      builder.onResolve({ filter: /^@\/lib\/video-player$/ }, () => ({ path: 'player-stub', namespace: 'error-stub' }))
      builder.onResolve({ filter: /\/WebMseVideoBackend$/ }, () => ({ path: 'mse-stub', namespace: 'error-stub' }))
      builder.onLoad({ filter: /.*/, namespace: 'error-stub' }, args => ({
        contents: stubs[args.path],
        loader: 'js',
        resolveDir: appRoot,
      }))
      builder.onLoad({ filter: /PearInlineVideoView\.tsx$/ }, async args => ({
        contents: `${await readFile(args.path, 'utf8')}
export { handleStatusChangeError }
`,
        loader: 'tsx',
        resolveDir: path.dirname(args.path),
      }))
    },
  }
  const result = await build({
    stdin: {
      contents: "export { handleStatusChangeError } from './components/video-player/PearInlineVideoView.tsx'",
      resolveDir: appRoot,
      sourcefile: 'player-error-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['react', 'react-dom'],
    plugins: [plugin],
    tsconfigRaw: { compilerOptions: { jsx: 'react-jsx', baseUrl: appRoot, paths: { '@/*': ['./*'] } } },
    write: false,
  })
  const directory = await mkdtemp(path.join(appRoot, '.player-error-'))
  const output = path.join(directory, 'handler.cjs')
  await writeFile(output, result.outputFiles[0].text)
  try {
    return await import(`${pathToFileURL(output).href}?${Math.random()}`)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}


test('fatal playback errors trigger automatic source recovery instead of freezing', async () => {
  const { handleStatusChangeError } = await loadErrorHandler()
  let recoveryCalls = 0
  const errors = []
  const handled = handleStatusChangeError({
    error: { message: 'peer range temporarily unavailable' },
    tryRecoverFromPlaybackError: () => {
      recoveryCalls += 1
      return true
    },
    terminalPlaybackErrorRef: { current: null },
    errorRecoveryTimerRef: { current: null },
    clearAutoplayVerify: () => {},
    onError: error => errors.push(error),
  })

  assert.equal(handled, undefined, 'a recovered error should not surface a terminal callback')
  assert.equal(recoveryCalls, 1, 'the actual status handler should attempt bounded recovery')
  assert.deepEqual(errors, [], 'recoverable playback errors stay inside the recovery path')
})

test('error recovery re-attaches the source and resumes from the last playback position', async () => {
  const src = await source(inlineViewPath)
  const recoveryStart = src.indexOf('const tryRecoverFromPlaybackError')
  assert.notEqual(recoveryStart, -1, 'expected tryRecoverFromPlaybackError callback')
  const recovery = src.slice(recoveryStart, src.indexOf('const tryRecoverFromPlaybackErrorRef', recoveryStart))

  assert.match(recovery, /PLAYBACK_ERROR_RECOVERY_MAX_ATTEMPTS/, 'recovery attempts must be bounded')
  assert.match(recovery, /replaceAsync\(videoSource\)/, 'recovery must re-attach the current video source')
  assert.match(recovery, /player\.currentTime = resumeAt/, 'recovery must resume from the last playback position')
  assert.match(recovery, /isPlayingRef\.current/, 'recovery must only auto-play when playback was desired')
  assert.match(recovery, /sourceReplaceGenerationRef\.current !== generation/, 'recovery must abort when a newer source replaced the failed one')
})

test('recovery attempt budget refills once playback advances past the stall', async () => {
  const src = await source(inlineViewPath)
  const handlerStart = src.indexOf("useEventListener(player, 'timeUpdate'")
  assert.notEqual(handlerStart, -1, 'expected expo-video timeUpdate handler')
  const handler = src.slice(handlerStart, src.indexOf("useEventListener(player, 'playingChange'", handlerStart))

  assert.match(
    handler,
    /errorRecoveryResumePositionRef\.current \+ PLAYBACK_ERROR_RECOVERY_PROGRESS_SEC[\s\S]*errorRecoveryAttemptsRef\.current = 0/,
    'advancing past the recovery point must reset the attempt budget so later stalls can recover again'
  )
})

test('a terminal source error latches, stops automatic fetches, and preserves the media error code', async () => {
  const { handleStatusChangeError } = await loadErrorHandler()
  const terminalPlaybackErrorRef = { current: null }
  const errors = []
  let clearAutoplayCalls = 0

  handleStatusChangeError({
    error: { error: { code: 4, message: 'unsupported source' } },
    tryRecoverFromPlaybackError: () => {
      throw new Error('terminal media errors must not enter recovery')
    },
    terminalPlaybackErrorRef,
    errorRecoveryTimerRef: { current: null },
    clearAutoplayVerify: () => { clearAutoplayCalls += 1 },
    onError: error => errors.push(error),
  })

  assert.equal(terminalPlaybackErrorRef.current, 'NO_COMPATIBLE_SOURCE')
  assert.equal(clearAutoplayCalls, 1)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].code, 4, 'the nested platform MediaError code reaches the parent callback')
})
