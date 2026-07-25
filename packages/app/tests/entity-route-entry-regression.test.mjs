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
      sources: [],
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
    tsconfigRaw: {
      compilerOptions: { jsx: 'react' },
    },
    write: false,
  })
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-entity-route-'))
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
      assert.ok(specifiers.length > 0, `${entry} must reexport a shared component`)
      assert.ok(specifiers.every(specifier => specifier === components[routeName]), `${entry} must only target its shared component`)
      assert.ok(specifiers.every(specifier => path.basename(specifier) !== '[id]'), `${entry} must not resolve back to itself`)
      if (routeName === 'media') {
        assert.match(source, /export \{ default, normalizeMediaEntityView \}/)
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
        if (routeName === 'media') {
          assert.equal(typeof route.normalizeMediaEntityView, 'function', `${entry} must preserve normalizeMediaEntityView`)
          assert.match(html, /authorized to publish/i)
        }
      })
    }
  }
})
