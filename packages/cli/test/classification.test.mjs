import test from 'brittle'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseTitleForTmdb, createTmdbClassifier } from '../src/classification/tmdb.js'
import { RelayClassificationStore, classificationKey } from '../src/classification/store.js'
import { RelaySettings, resolveTmdbOptions } from '../src/settings.js'

function tmpStorage() {
  return mkdtempSync(join(tmpdir(), 'peartube-classify-'))
}

test('parseTitleForTmdb strips release noise and extracts year', function (t) {
  t.alike(parseTitleForTmdb('The Matrix (1999) 1080p BluRay x264'), { query: 'The Matrix', year: 1999 })
  t.alike(parseTitleForTmdb('Breaking Bad S01E03 [WEB-DL]'), { query: 'Breaking Bad', year: null })
  t.alike(parseTitleForTmdb('Some.Movie.2020.HDR.2160p'), { query: 'Some Movie', year: 2020 })
  t.alike(parseTitleForTmdb(''), { query: '', year: null })
})

test('classificationKey is stable for the same title', function (t) {
  t.is(classificationKey({ title: 'The Matrix (1999)' }), classificationKey({ title: 'the matrix 1999' }))
  t.is(classificationKey({ videoId: 'abc' }), 'id:abc')
})

test('createTmdbClassifier returns unknown when disabled', async function (t) {
  const classifier = createTmdbClassifier({ apiKey: '' })
  t.is(classifier.enabled, false)
  const result = await classifier.classify({ title: 'Anything' })
  t.is(result.type, 'unknown')
})

test('createTmdbClassifier picks the most popular movie/tv match', async function (t) {
  const calls = []
  const fetchFn = async (url) => {
    calls.push(url)
    const kind = url.includes('/search/movie') ? 'movie' : 'tv'
    return {
      ok: true,
      async json() {
        if (kind === 'movie') {
          return { results: [{ id: 603, title: 'The Matrix', release_date: '1999-03-30', popularity: 90, poster_path: '/m.jpg' }] }
        }
        return { results: [{ id: 1, name: 'Matrix Show', first_air_date: '2010-01-01', popularity: 5 }] }
      }
    }
  }
  const classifier = createTmdbClassifier({ apiKey: 'key', fetchFn })
  const result = await classifier.classify({ title: 'The Matrix 1999' })
  t.is(classifier.enabled, true)
  t.is(result.type, 'movie')
  t.is(result.tmdbId, 603)
  t.is(result.title, 'The Matrix')
  t.is(result.year, 1999)
  t.is(calls.length, 2, 'queries both movie and tv endpoints')
})

test('RelayClassificationStore caches results and avoids re-classifying', async function (t) {
  const storagePath = tmpStorage()
  t.teardown(() => rmSync(storagePath, { recursive: true, force: true }))

  let classifyCalls = 0
  const classifier = {
    enabled: true,
    async classify() {
      classifyCalls += 1
      return { type: 'movie', tmdbId: 1, title: 'X', year: 2000 }
    }
  }

  const store = await RelayClassificationStore.open({ storagePath })
  const first = await store.classifyVideo({ classifier, videoId: 'v1', title: 'X (2000)' })
  const second = await store.classifyVideo({ classifier, videoId: 'v1', title: 'X (2000)' })
  t.is(first.type, 'movie')
  t.is(second.type, 'movie')
  t.is(classifyCalls, 1, 'cached on the second call')

  const reopened = await RelayClassificationStore.open({ storagePath })
  t.is(reopened.get({ videoId: 'v1' }).tmdbId, 1, 'cache persists to disk')
})

test('RelayClassificationStore returns null when classifier disabled and uncached', async function (t) {
  const storagePath = tmpStorage()
  t.teardown(() => rmSync(storagePath, { recursive: true, force: true }))
  const store = await RelayClassificationStore.open({ storagePath })
  const result = await store.classifyVideo({ classifier: { enabled: false }, videoId: 'v9', title: 'Nope' })
  t.is(result, null)
})

test('resolveTmdbOptions lets runtime settings override config', async function (t) {
  const storagePath = tmpStorage()
  t.teardown(() => rmSync(storagePath, { recursive: true, force: true }))
  const settings = await RelaySettings.open({ storagePath })

  const config = { classification: { tmdb: { enabled: false, apiKey: '', baseUrl: 'https://api', language: 'en-US' } } }
  t.is(resolveTmdbOptions(config, settings).enabled, false)

  await settings.set('tmdbApiKey', 'runtime-key')
  await settings.set('tmdbEnabled', true)
  const resolved = resolveTmdbOptions(config, settings)
  t.is(resolved.apiKey, 'runtime-key')
  t.is(resolved.enabled, true)
})
