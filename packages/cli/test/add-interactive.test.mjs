import test from 'brittle'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { runTerminal } from '../src/add/terminal.js'
import { createPickerState } from '../src/add/picker-state.js'
import { createInteractiveDriver } from '../src/add/interactive.js'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const KEY = { enter: '\r', tab: '\t', down: '\u001b[B', up: '\u001b[A' }

class FakeInput extends PassThrough {
  constructor () {
    super()
    this.isTTY = true
  }

  setRawMode () {
    return this
  }
}

class FakeOutput {
  constructor () {
    this.isTTY = true
    this.columns = 100
    this.rows = 30
    this.chunks = []
  }

  write (chunk) {
    this.chunks.push(String(chunk))
    return true
  }
}

function harness () {
  return { input: new FakeInput(), output: new FakeOutput(), signals: new EventEmitter() }
}

function fakeTmdb () {
  return {
    async search () {
      return [
        { kind: 'movie', id: 'tmdb:movie:603', title: 'The Matrix', year: 1999, mediaId: '603', description: '', artwork: [] },
        { kind: 'tv', id: 'tmdb:tv:1396', title: 'Breaking Bad', year: 2008, mediaId: '1396', description: '', artwork: [] }
      ]
    },
    async getShow (id) {
      return {
        kind: 'channel',
        profileKind: 'tvShow',
        mediaProvider: 'tmdb',
        mediaId: String(id),
        name: 'Breaking Bad',
        description: '',
        artwork: [],
        seasons: [{ seasonNumber: 1, name: 'Season 1', episodeCount: 2 }]
      }
    },
    async getSeason (id, seasonNumber) {
      return [
        { seasonNumber, episodeNumber: 1, title: 'Pilot', airDate: '2008-01-20', artwork: [] },
        { seasonNumber, episodeNumber: 2, title: "Cat's in the Bag", airDate: null, artwork: [] }
      ]
    },
    async getMovie (id) {
      return { kind: 'channel', mediaId: String(id), title: 'The Matrix' }
    }
  }
}

function fakeYtDlp () {
  return {
    async listProfile () {
      return {
        creator: { name: 'Creator One', platform: 'youtube', canonicalUrl: 'https://youtube.com/@creator', sourceId: 'c1' },
        items: [
          { title: 'Vid A', canonicalUrl: 'https://youtu.be/aaa', sourceProvider: 'youtube', sourceVideoId: 'aaa', thumbnail: null },
          { title: 'Vid B', canonicalUrl: 'https://youtu.be/bbb', sourceProvider: 'youtube', sourceVideoId: 'bbb', thumbnail: null }
        ]
      }
    }
  }
}

function driveTerminal ({ initialQuery, tmdb, ytDlp, execute }) {
  const h = harness()
  const driver = createInteractiveDriver({ tmdb, ytDlp, execute })
  const done = runTerminal({
    ...h,
    initialState: createPickerState({ query: initialQuery }),
    onReady: driver.onReady,
    onState: driver.onState,
    onAction: driver.onAction
  })
  return { ...h, done }
}

test('interactive movie: search selects a movie, accepts a URL source, and publishes', async (t) => {
  let executed = null
  const term = driveTerminal({
    initialQuery: 'matrix',
    tmdb: fakeTmdb(),
    execute: async (plan, emit) => {
      executed = plan
      emit('Downloading https://x')
      emit('Uploading 50%')
      return { status: 'replicationPending', videoId: 'v1', jobId: 'add_1' }
    }
  })

  await delay(40) // initial search (immediate) resolves
  term.input.write(Buffer.from(KEY.enter)) // select The Matrix (index 0) -> movieSource
  await delay(40)
  term.input.write(Buffer.from('https://example.com/clip.mp4')) // paste URL
  await delay(200) // source debounce
  term.input.write(Buffer.from(KEY.enter)) // commit "Use URL" -> review
  await delay(40)
  term.input.write(Buffer.from(KEY.enter)) // review -> progress -> execute

  const finalState = await term.done
  t.is(finalState.result.status, 'completed')
  t.is(finalState.result.value.status, 'replicationPending')
  t.ok(executed, 'execute was invoked')
  t.is(executed.fetchUrl, 'https://example.com/clip.mp4')
  t.is(executed.itemDraft.contentKind, 'movie')
  t.is(executed.channelDraft.mediaId, '603')
})

test('interactive tv: drills show -> season -> episode, then publishes a local source', async (t) => {
  let executed = null
  const term = driveTerminal({
    initialQuery: 'breaking',
    tmdb: fakeTmdb(),
    execute: async (plan) => {
      executed = plan
      return { status: 'replicationPending', videoId: 'v2', jobId: 'add_2' }
    }
  })

  await delay(40) // search
  term.input.write(Buffer.from(KEY.down)) // move to Breaking Bad (tv, index 1)
  term.input.write(Buffer.from(KEY.enter)) // -> tvSeason
  await delay(40) // getShow
  term.input.write(Buffer.from(KEY.enter)) // Season 1 -> episodeSelection
  await delay(40) // getSeason
  term.input.write(Buffer.from(KEY.enter)) // auto-select Pilot -> sourceSelection
  await delay(40)
  term.input.write(Buffer.from('/tmp/ep.mp4'))
  await delay(200)
  term.input.write(Buffer.from(KEY.enter)) // Use file -> review
  await delay(40)
  term.input.write(Buffer.from(KEY.enter)) // publish

  const finalState = await term.done
  t.is(finalState.result.value.status, 'replicationPending')
  t.is(executed.itemDraft.contentKind, 'episode')
  t.is(executed.itemDraft.episodeNumber, 1)
  t.is(executed.channelDraft.profileKind, 'tvShow')
  t.is(executed.channelDraft.mediaId, '1396')
})

test('interactive creator: a channel URL lists recent videos and publishes the pick', async (t) => {
  let executed = null
  const term = driveTerminal({
    initialQuery: 'https://youtube.com/@creator',
    tmdb: fakeTmdb(),
    ytDlp: fakeYtDlp(),
    execute: async (plan) => {
      executed = plan
      return { status: 'replicationPending', videoId: 'v3', jobId: 'add_3' }
    }
  })

  await delay(40) // search yields a single creator candidate
  term.input.write(Buffer.from(KEY.enter)) // select creator -> creatorContent
  await delay(60) // listProfile
  term.input.write(Buffer.from(KEY.enter)) // pick Vid A -> creatorAttachment (auto) -> sourceSelection (auto) -> review
  await delay(60)
  term.input.write(Buffer.from(KEY.enter)) // review -> publish

  const finalState = await term.done
  t.is(finalState.result.value.status, 'replicationPending')
  t.ok(executed, 'execute invoked for creator flow')
  t.is(executed.fetchUrl, 'https://youtu.be/aaa')
  t.is(executed.itemDraft.contentKind, 'video')
  t.is(executed.channelDraft.profileKind, 'creator')
})

test('interactive cancel: Ctrl-C on search resolves without executing', async (t) => {
  let executed = false
  const term = driveTerminal({
    initialQuery: 'matrix',
    tmdb: fakeTmdb(),
    execute: async () => {
      executed = true
      return { status: 'replicationPending' }
    }
  })

  await delay(40)
  term.signals.emit('SIGINT')

  const finalState = await term.done
  t.is(finalState.result.status, 'cancelled')
  t.absent(executed, 'no execution on cancel')
})

test('interactive movie: a multi-line URL paste at the source uses only the first URL', async (t) => {
  let executed = null
  const term = driveTerminal({
    initialQuery: 'matrix',
    tmdb: fakeTmdb(),
    execute: async (plan) => {
      executed = plan
      return { status: 'replicationPending', videoId: 'v9', jobId: 'add_9' }
    }
  })

  await delay(40)
  term.input.write(Buffer.from(KEY.enter)) // select The Matrix -> movieSource
  await delay(40)
  term.input.write(Buffer.from('\u001b[200~https://cdn/a.mp4\nhttps://cdn/b.mp4\nhttps://cdn/c.mp4\u001b[201~'))
  await delay(220)
  term.input.write(Buffer.from(KEY.enter)) // commit first URL -> review
  await delay(40)
  term.input.write(Buffer.from(KEY.enter)) // publish

  const finalState = await term.done
  t.is(finalState.result.value.status, 'replicationPending')
  t.is(executed.fetchUrl, 'https://cdn/a.mp4', 'only the first pasted URL is used')
})
