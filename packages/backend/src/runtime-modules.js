import { requireOptionalModule } from './runtime-require.cjs'

function unwrapModule(mod) {
  return mod?.default || mod
}

let preloadedHyperswarmModule = null

export function setHyperswarmModuleForRuntime(mod) {
  preloadedHyperswarmModule = unwrapModule(mod)
}

function tryRequire(specifier) {
  // Bare exposes require globally; Node ESM must use the async loaders below.
  if (typeof require !== 'function') return null
  return requireOptionalModule(specifier)
}

export function resolveBareFsModuleSync() {
  return unwrapModule(tryRequire('bare-fs'))
}

export function resolveBarePathModuleSync() {
  return unwrapModule(tryRequire('bare-path'))
}

export function resolveBareFfmpegModuleSync() {
  // FFmpeg callers normalize default exports with ?? rather than the shared ||.
  return tryRequire('bare-ffmpeg')
}

export function resolveBareOrNodeFsModuleSync() {
  return resolveBareFsModuleSync() || unwrapModule(tryRequire('node:fs'))
}

export function resolveBareOrNodePathModuleSync() {
  return resolveBarePathModuleSync() || unwrapModule(tryRequire('node:path'))
}

export async function loadBareFsModule() {
  const required = resolveBareFsModuleSync()
  if (required) return required

  return unwrapModule(await import('bare-fs'))
}

export async function loadBarePathModule() {
  const required = resolveBarePathModuleSync()
  if (required) return required

  return unwrapModule(await import('bare-path'))
}

export async function loadBareOrNodeFsModule() {
  const required = resolveBareOrNodeFsModuleSync()
  if (required) return required

  try {
    return await loadBareFsModule()
  } catch {
    // Bare's optional filesystem addon is unavailable; try the Node runtime.
  }

  const nodeFsName = 'node:' + 'fs'
  return unwrapModule(await import(nodeFsName))
}

export async function loadBareOrNodePathModule() {
  const required = resolveBareOrNodePathModuleSync()
  if (required) return required

  try {
    return await loadBarePathModule()
  } catch {
    // Bare's optional path addon is unavailable; try the Node runtime.
  }

  const nodePathName = 'node:' + 'path'
  return unwrapModule(await import(nodePathName))
}

export async function loadHyperswarmModule() {
  if (preloadedHyperswarmModule) return preloadedHyperswarmModule

  const required = unwrapModule(tryRequire('hyperswarm'))
  if (required) return required

  return unwrapModule(await import('hyperswarm'))
}

export async function loadBareOrNodeHttpModule() {
  const required = unwrapModule(tryRequire('bare-http1'))
  if (required) return required

  try {
    return unwrapModule(await import('bare-http1'))
  } catch {
    // Bare's optional HTTP addon is unavailable; try the Node runtime.
  }

  const nodeHttpName = 'node:' + 'http'
  return unwrapModule(await import(nodeHttpName))
}
