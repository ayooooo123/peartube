import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { build } from 'esbuild'

const contextPath = new URL('../lib/VideoPlayerContext.tsx', import.meta.url)
const stateMachinePath = new URL('../lib/playerStateMachine.ts', import.meta.url)
async function loadNudgeHelper() {
  const appRoot = fileURLToPath(new URL('..', import.meta.url))
  const instrumentContext = {
    name: 'instrument-video-player-context',
    setup(builder) {
      builder.onLoad({ filter: /VideoPlayerContext\.tsx$/ }, async args => ({
        contents: `${await readFile(args.path, 'utf8')}
export { nudgeForegroundPlayer }
`,
        loader: 'tsx',
        resolveDir: path.dirname(args.path),
      }))
    },
  }
  const result = await build({
    stdin: {
      contents: "export { nudgeForegroundPlayer } from './lib/VideoPlayerContext.tsx'",
      resolveDir: appRoot,
      sourcefile: 'foreground-nudge-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['react', 'react-dom'],
    alias: { 'react-native': 'react-native-web' },
    define: { __DEV__: 'false' },
    plugins: [instrumentContext],
    tsconfigRaw: { compilerOptions: { jsx: 'react-jsx', baseUrl: appRoot, paths: { '@/*': ['./*'] } } },
    write: false,
  })
  const directory = await mkdtemp(path.join(appRoot, '.android-background-'))
  const output = path.join(directory, 'nudge.cjs')
  await writeFile(output, result.outputFiles[0].text)
  try {
    return await import(`${pathToFileURL(output).href}?${Math.random()}`)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('foreground return only nudges a paused player that was playing before backgrounding', async (t) => {
  const { nudgeForegroundPlayer } = await loadNudgeHelper()
  const seeks = []
  t.mock.timers.enable({ apis: ['setTimeout'] })

  nudgeForegroundPlayer({
    wasInPip: false,
    wasPlayingWhenBackgrounded: true,
    isPlaying: false,
    duration: 120,
    currentTime: 30,
    setSeekPosition: value => seeks.push(value),
  })

  assert.deepEqual(seeks, [0.25], 'the real foreground helper should issue its recovery seek')
  t.mock.timers.tick(100)
  assert.deepEqual(seeks, [0.25, undefined], 'the recovery seek should be cleared after the nudge')

  const activeSeeks = []
  nudgeForegroundPlayer({
    wasInPip: false,
    wasPlayingWhenBackgrounded: true,
    isPlaying: true,
    duration: 120,
    currentTime: 30,
    setSeekPosition: value => activeSeeks.push(value),
  })
  assert.deepEqual(activeSeeks, [], 'an already-playing foreground return needs no nudge')
})


test('foreground restoration distinguishes continued playback, paused mini, and PiP return', async () => {
  const appRoot = fileURLToPath(new URL('..', import.meta.url))
  const bundle = await build({
    entryPoints: [fileURLToPath(stateMachinePath)],
    absWorkingDir: appRoot,
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    external: ['react', 'react-dom'],
    alias: { 'react-native': 'react-native-web' },
    define: { __DEV__: 'false' },
  })
  const directory = await mkdtemp(path.join(appRoot, '.foreground-reducer-'))
  try {
    const output = path.join(directory, 'reducer.cjs')
    await writeFile(output, bundle.outputFiles[0].text)
    const { playerReducer } = await import(pathToFileURL(output).href)
    const video = {
      id: 'background-session',
      title: 'Background session',
      description: '',
      path: '/video.mp4',
      size: 1024,
      uploadedAt: 1,
      channelKey: 'ab'.repeat(32),
    }
    const state = {
      mode: 'mini',
      video,
      url: 'http://127.0.0.1/video.mp4',
      wasPlayingWhenBackgrounded: true,
      wasPlayingWhenPipEntered: false,
      modeBeforePip: 'mini',
    }
    const foreground = {
      type: 'APP_FOREGROUND',
      source: 'appStateForegroundHiddenRestore',
      appState: 'active',
      wasInPip: false,
      suppressRestore: false,
      resumedWithBackgroundPlayback: true,
    }
    const resumed = playerReducer(state, foreground)
    assert.equal(resumed.mode, 'fullscreen')
    assert.equal(resumed.video, video, 'foreground restoration retains the active session')
    assert.equal(resumed.url, state.url)

    const paused = playerReducer(
      { ...state, wasPlayingWhenBackgrounded: false },
      { ...foreground, resumedWithBackgroundPlayback: false },
    )
    assert.equal(paused.mode, 'mini', 'ordinary foreground does not open a paused player')
    const pipReturn = playerReducer(
      { ...state, wasPlayingWhenBackgrounded: false },
      { ...foreground, wasInPip: true, resumedWithBackgroundPlayback: false },
    )
    assert.equal(pipReturn.mode, 'fullscreen', 'PiP return restores independently of background playback')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
