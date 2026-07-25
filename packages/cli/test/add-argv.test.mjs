import test from 'brittle'
import { parsePeartubeArgv, PeartubeUsageError } from '../src/add/argv.js'

const tty = {
  stdin: { isTTY: true },
  stderr: { isTTY: true }
}

const nonTty = {
  stdin: { isTTY: false },
  stderr: { isTTY: false }
}

test('parsePeartubeArgv returns exact config and help result shapes', (t) => {
  t.alike(parsePeartubeArgv([
    'config',
    '--storage', '/srv/content',
    '--config', '/etc/peartube.yml',
    '--no-color',
    '--json',
    '--no-input'
  ], nonTty), {
    command: 'config',
    query: null,
    fetchUrl: null,
    flags: {
      storage: '/srv/content',
      config: '/etc/peartube.yml',
      noColor: true,
      json: true,
      noInput: true
    },
    mode: 'interactive'
  })
  t.alike(parsePeartubeArgv(['help'], nonTty), {
    command: 'help',
    query: null,
    fetchUrl: null,
    flags: {},
    mode: 'scripted'
  })
  t.alike(parsePeartubeArgv(['--help'], nonTty), {
    command: 'help',
    query: null,
    fetchUrl: null,
    flags: { help: true },
    mode: 'scripted'
  })
  t.alike(parsePeartubeArgv([], nonTty), {
    command: 'help',
    query: null,
    fetchUrl: null,
    flags: {},
    mode: 'scripted'
  })
})

test('double dash preserves --help as positional add text', (t) => {
  t.alike(parsePeartubeArgv(['add', '--', '--help'], tty), {
    command: 'add',
    query: '--help',
    fetchUrl: null,
    flags: {},
    mode: 'interactive'
  })
})

test('interactive add preserves all positional search text', (t) => {
  const parsed = parsePeartubeArgv(['add', 'breaking', 'bad', 'season', 'two'], tty)

  t.alike(parsed, {
    command: 'add',
    query: 'breaking bad season two',
    fetchUrl: null,
    flags: {},
    mode: 'interactive'
  })
})

test('scripted episode syntax preserves the runtime fetch URL and coordinates', (t) => {
  const sourceUrl = 'https://media.example/watch?v=episode-token'
  const parsed = parsePeartubeArgv([
    'add', sourceUrl,
    '--type', 'episode',
    '--provider', 'tmdb',
    '--show-id', '1399',
    '--season', '2',
    '--episode', '8',
    '--yes'
  ], nonTty)

  t.alike(parsed, {
    command: 'add',
    query: sourceUrl,
    fetchUrl: sourceUrl,
    flags: {
      type: 'episode',
      provider: 'tmdb',
      showId: '1399',
      season: '2',
      episode: '8',
      yes: true
    },
    mode: 'scripted'
  })
})

test('scripted movie syntax preserves the runtime fetch URL and coordinates', (t) => {
  const sourceUrl = 'https://media.example/movie/550'
  const parsed = parsePeartubeArgv([
    'add', sourceUrl,
    '--type', 'movie',
    '--provider', 'tmdb',
    '--movie-id', '550',
    '--yes'
  ], nonTty)

  t.alike(parsed, {
    command: 'add',
    query: sourceUrl,
    fetchUrl: sourceUrl,
    flags: {
      type: 'movie',
      provider: 'tmdb',
      movieId: '550',
      yes: true
    },
    mode: 'scripted'
  })
})

test('parser exposes common execution intent without changing it', (t) => {
  const parsed = parsePeartubeArgv([
    'add', 'https://media.example/movie/550',
    '--type=movie',
    '--provider=tmdb',
    '--movie-id=550',
    '--storage', '/srv/peartube',
    '--config', '/etc/peartube.yml',
    '--no-color',
    '--json',
    '--no-input',
    '--yes',
    '--force'
  ], nonTty)

  t.alike(parsed.flags, {
    type: 'movie',
    provider: 'tmdb',
    movieId: '550',
    storage: '/srv/peartube',
    config: '/etc/peartube.yml',
    noColor: true,
    json: true,
    noInput: true,
    yes: true,
    force: true
  })
  t.is(parsed.mode, 'scripted')
})

test('episode mode rejects every missing or contradictory coordinate', (t) => {
  const required = [
    ['--provider', 'tmdb'],
    ['--show-id', '1399'],
    ['--season', '2'],
    ['--episode', '8']
  ]

  for (let missing = 0; missing < required.length; missing += 1) {
    const coordinates = required.flatMap((pair, index) => index === missing ? [] : pair)
    t.exception(
      () => parsePeartubeArgv([
        'add', 'https://media.example/episode',
        '--type', 'episode',
        ...coordinates,
        '--yes'
      ], nonTty),
      /Episode mode requires --provider tmdb, --show-id, --season, and --episode/
    )
  }

  t.exception(
    () => parsePeartubeArgv([
      'add', 'https://media.example/episode',
      '--type', 'episode',
      ...required.flat(),
      '--movie-id', '550',
      '--yes'
    ], nonTty),
    /Episode mode does not accept --movie-id/
  )
})

test('movie mode rejects every missing or contradictory coordinate', (t) => {
  const required = [
    ['--provider', 'tmdb'],
    ['--movie-id', '550']
  ]

  for (let missing = 0; missing < required.length; missing += 1) {
    const coordinates = required.flatMap((pair, index) => index === missing ? [] : pair)
    t.exception(
      () => parsePeartubeArgv([
        'add', 'https://media.example/movie',
        '--type', 'movie',
        ...coordinates,
        '--yes'
      ], nonTty),
      /Movie mode requires --provider tmdb and --movie-id/
    )
  }

  for (const coordinate of [
    ['--show-id', '1399'],
    ['--season', '2'],
    ['--episode', '8']
  ]) {
    t.exception(
      () => parsePeartubeArgv([
        'add', 'https://media.example/movie',
        '--type', 'movie',
        ...required.flat(),
        ...coordinate,
        '--yes'
      ], nonTty),
      /Movie mode does not accept --show-id, --season, or --episode/
    )
  }
})

test('complete coordinates require --yes for scripted mode', (t) => {
  const episode = [
    'add', 'https://media.example/episode',
    '--type', 'episode',
    '--provider', 'tmdb',
    '--show-id', '1399',
    '--season', '2',
    '--episode', '8'
  ]
  const movie = [
    'add', 'https://media.example/movie',
    '--type', 'movie',
    '--provider', 'tmdb',
    '--movie-id', '550'
  ]

  for (const argv of [episode, movie]) {
    t.exception(
      () => parsePeartubeArgv(argv, nonTty),
      /Complete scripted coordinates require --yes/
    )
    t.exception(
      () => parsePeartubeArgv([...argv, '--no-input'], tty),
      /Complete scripted coordinates require --yes/
    )
    t.is(parsePeartubeArgv(argv, tty).mode, 'interactive')
  }
})

test('non-TMDB providers fail with an explicit unavailable error', (t) => {
  t.exception(
    () => parsePeartubeArgv([
      'add', 'https://media.example/episode',
      '--type', 'episode',
      '--provider', 'tvdb',
      '--show-id', '81189',
      '--season', '1',
      '--episode', '1'
    ], nonTty),
    /Provider "tvdb" is unavailable; only "tmdb" is supported/
  )
})

test('missing coordinates become interactive only with both TTYs and input enabled', (t) => {
  const interactive = parsePeartubeArgv([
    'add', 'https://media.example/episode',
    '--type', 'episode',
    '--provider', 'tmdb'
  ], tty)

  t.is(interactive.mode, 'interactive')
  t.is(interactive.fetchUrl, 'https://media.example/episode')

  for (const streams of [
    nonTty,
    { stdin: { isTTY: true }, stderr: { isTTY: false } },
    { stdin: { isTTY: false }, stderr: { isTTY: true } }
  ]) {
    t.exception(
      () => parsePeartubeArgv([
        'add', 'https://media.example/episode',
        '--type', 'episode',
        '--provider', 'tmdb'
      ], streams),
      /Episode mode requires --provider tmdb, --show-id, --season, and --episode/
    )
  }

  t.exception(
    () => parsePeartubeArgv([
      'add', 'breaking bad',
      '--no-input'
    ], tty),
    /Non-interactive add requires --type and complete provider coordinates/
  )
})

test('--yes and --force do not bypass coordinate validation', (t) => {
  for (const flag of ['--yes', '--force']) {
    t.exception(
      () => parsePeartubeArgv([
        'add', 'https://media.example/movie',
        '--type', 'movie',
        '--provider', 'tmdb',
        flag
      ], nonTty),
      /Movie mode requires --provider tmdb and --movie-id/
    )
  }
})

test('unknown commands, flags, duplicate flags, and contradictory coordinates are usage errors', (t) => {
  t.exception(() => parsePeartubeArgv(['publish'], nonTty), /Unknown command "publish"/)
  t.exception(() => parsePeartubeArgv(['config', '--bogus'], nonTty), /Unknown argument --bogus/)
  t.exception(() => parsePeartubeArgv(['config', '--movie-id', '550'], nonTty), /--movie-id is only valid with add/)
  t.exception(() => parsePeartubeArgv(['config', '--storage', 'one', '--storage', 'two'], nonTty), /Duplicate argument --storage/)
  t.exception(
    () => parsePeartubeArgv([
      'add', 'https://media.example/item',
      '--show-id', '1399',
      '--movie-id', '550'
    ], tty),
    /Cannot combine movie and episode coordinates/
  )
})

test('repeatable --relay collects authenticated relay keys and removed mirror flags fail closed', (t) => {
  const parsed = parsePeartubeArgv([
    'add', 'https://media.example/clip.mp4',
    '--type', 'video',
    '--title', 'Clip',
    '--relay', 'k1',
    '--relay', 'k2',
    '--yes'
  ], nonTty)
  t.alike(parsed.flags.relay, ['k1', 'k2'], 'relay keys accumulate')
  t.exception(
    () => parsePeartubeArgv(['add', 'clip', '--blind-peer', 'm1'], nonTty),
    /Unknown argument --blind-peer/
  )
})
