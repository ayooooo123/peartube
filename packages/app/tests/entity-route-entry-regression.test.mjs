import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const appRoot = path.resolve(import.meta.dirname, '..')

const appUiStubPlugin = {
  name: 'app-ui-stubs',
  setup(context) {
    context.onResolve({ filter: /^@expo\/vector-icons$/ }, () => ({
      path: 'vector-icons',
      namespace: 'test-stub',
    }))
    context.onResolve({ filter: /^expo-router$/ }, () => ({
      path: 'expo-router',
      namespace: 'test-stub',
    }))
    context.onResolve({ filter: /^@\/lib\/AppContext$/ }, () => ({
      path: 'app-context',
      namespace: 'test-stub',
    }))
    context.onLoad({ filter: /^vector-icons$/, namespace: 'test-stub' }, () => ({
      contents: "import React from 'react'; export const Ionicons = (props) => React.createElement('span', props);",
      loader: 'js',
    }))
    context.onLoad({ filter: /^expo-router$/, namespace: 'test-stub' }, () => ({
      contents: 'export const useLocalSearchParams = () => ({}); export const useRouter = () => ({ back() {} });',
      loader: 'js',
    }))
    context.onLoad({ filter: /^app-context$/, namespace: 'test-stub' }, () => ({
      // Cards resolve swarm cover art through the context directly, so the stub
      // has to offer the context as well as the hook.
      contents: "import React from 'react'; export const AppContext = React.createContext(null); export const useApp = () => ({ rpc: {} });",
      loader: 'js',
    }))
  },
}
const routeNames = ['collection', 'creator', 'media']
const platforms = [
  {
    name: 'native',
    suffix: '.tsx',
    resolveExtensions: ['.tsx', '.ts', '.jsx', '.js', '.json'],
  },
  {
    name: 'web',
    suffix: '.web.tsx',
    resolveExtensions: ['.web.tsx', '.web.ts', '.tsx', '.ts', '.web.jsx', '.web.js', '.jsx', '.js', '.json'],
  },
]

const routeProps = {
  collection: {
    id: 'collection-one',
    collection: {
      title: 'Collection One',
      items: [{ entityId: 'media-one', title: 'Media One', available: true }],
      missingMembers: [{ entityId: 'media-missing', title: 'Missing Episode' }],
      completeness: { known: 1, missing: 1, hasTrustedStructure: true },
    },
  },
  creator: {
    id: 'creator-one',
    agent: { name: 'Creator One' },
    contributions: [{ agentId: 'creator-one', name: 'Creator One', role: 'director', publisherId: 'publisher-one' }],
  },
  media: {
    id: 'media-one',
    entity: {
      entityId: 'media-one',
      title: 'Media One',
      sources: [{
        publicationId: 'publication-one',
        renditionId: 'rendition-one',
        publisherId: 'publisher-one',
        available: true,
        selected: true,
      }],
      selectedPublicationId: 'publication-one',
      provenance: [{ claimId: 'claim-one', publisherId: 'publisher-one' }],
      conflicts: [{ field: 'title' }],
      archiveStatus: { pledgeCount: 2 },
      contributions: [{ role: 'uploader' }, { role: 'performer' }, { role: 'director' }],
      publisherDeviceStatus: {
        success: true,
        status: 'authorized',
        canPublish: true,
        canPlayLocal: true,
        canExportLocal: true,
        canDeleteLocal: true,
        canRootTransition: true,
      },
    },
  },
}

async function loadRouteModule(entry, resolveExtensions) {
  const result = await build({
    entryPoints: [path.join(appRoot, entry)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    resolveExtensions,
    alias: { 'react-native': 'react-native-web' },
    external: ['react', 'react-dom', 'react-native-web'],
    plugins: [appUiStubPlugin],
    tsconfigRaw: {
      compilerOptions: { jsx: 'react-jsx', baseUrl: appRoot, paths: { '@/*': ['./*'] } },
    },
    write: false,
  })
  const directory = fs.mkdtempSync(path.join(appRoot, '.tmp-entity-route-'))
  const output = path.join(directory, 'route.mjs')
  fs.writeFileSync(output, result.outputFiles[0].text)
  try {
    return await import(`${pathToFileURL(output).href}?v=${Date.now()}-${Math.random()}`)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test('entity route entries target shared components and never import their own basename', () => {
  const components = {
    collection: '../../components/routes/CollectionPage',
    creator: '../../components/routes/CreatorPage',
    media: '../../components/routes/MediaEntityPage',
  }
  for (const routeName of routeNames) {
    for (const { suffix } of platforms) {
      const entry = `app/${routeName}/[id]${suffix}`
      const source = fs.readFileSync(path.join(appRoot, entry), 'utf8')
      const specifiers = [...source.matchAll(/\bfrom\s+['\"]([^'\"]+)['\"]/g)].map(match => match[1])
      assert.ok(specifiers.includes(components[routeName]), `${entry} must import its shared route component`)
      assert.ok(specifiers.includes('@/lib/AppContext'), `${entry} must inject the initialized app RPC facade`)
      assert.ok(specifiers.every(specifier => path.basename(specifier) !== '[id]'), `${entry} must not resolve back to itself`)
      if (routeName === 'media') {
        assert.match(source, /export \{ normalizeMediaEntityView \}/)
        assert.match(source, /export type \{ MediaEntityView \}/)
      }
    }
  }
})

test('native and web entity route entries resolve and server-render', async t => {
  for (const routeName of routeNames) {
    for (const { name, suffix, resolveExtensions } of platforms) {
      await t.test(`${routeName} ${name}`, async () => {
        const entry = `app/${routeName}/[id]${suffix}`
        const route = await loadRouteModule(entry, resolveExtensions)
        assert.equal(typeof route.default, 'function', `${entry} must resolve a default route component`)
        const html = renderToStaticMarkup(React.createElement(route.default, routeProps[routeName]))
        assert.match(html, new RegExp(`${routeName} one`, 'i'))
        if (routeName === 'collection') {
          assert.match(html, /1 missing/i)
          assert.match(html, /Missing Episode/i)
          assert.match(html, /trusted structure/i)
        }
        if (routeName === 'creator') {
          assert.match(html, /Role attribution and publisher claims/i)
          assert.match(html, /director/i)
        }
        if (routeName === 'media') {
          assert.equal(typeof route.normalizeMediaEntityView, 'function', `${entry} must preserve normalizeMediaEntityView`)
          // The media route is the consumer surface: it leads with the title,
          // availability, and one action. Publication and provenance
          // diagnostics stay behind the details disclosure.
          assert.match(html, /Details and other sources/i)
          assert.doesNotMatch(html, /Playable publications and renditions/i)
          assert.doesNotMatch(html, /authorized to publish/i)
        }
      })
    }
  }
})
