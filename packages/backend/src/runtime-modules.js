/* eslint-disable no-empty, @typescript-eslint/no-require-imports */
function unwrapModule(mod) {
  return mod?.default || mod
}

let preloadedHyperswarmModule = null

export function setHyperswarmModuleForRuntime(mod) {
  preloadedHyperswarmModule = unwrapModule(mod)
}

function tryRequire(specifier) {
  if (typeof require !== 'function') return null

  try {
    return unwrapModule(require(specifier))
  } catch {
    return null
  }
}

export function resolveBareFsModuleSync() {
  return tryRequire('bare-fs')
}

export function resolveBarePathModuleSync() {
  return tryRequire('bare-path')
}

export function resolveBareOrNodeFsModuleSync() {
  return resolveBareFsModuleSync() || tryRequire('node:fs')
}

export function resolveBareOrNodePathModuleSync() {
  return resolveBarePathModuleSync() || tryRequire('node:path')
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
  } catch {}

  const nodeFsName = 'node:' + 'fs'
  return unwrapModule(await import(nodeFsName))
}

export async function loadBareOrNodePathModule() {
  const required = resolveBareOrNodePathModuleSync()
  if (required) return required

  try {
    return await loadBarePathModule()
  } catch {}

  const nodePathName = 'node:' + 'path'
  return unwrapModule(await import(nodePathName))
}

export async function loadHyperswarmModule() {
  if (preloadedHyperswarmModule) return preloadedHyperswarmModule

  const required = tryRequire('hyperswarm')
  if (required) return required

  return unwrapModule(await import('hyperswarm'))
}

export async function loadBareOrNodeHttpModule() {
  const required = tryRequire('bare-http1')
  if (required) return required

  try {
    return unwrapModule(await import('bare-http1'))
  } catch {}

  const nodeHttpName = 'node:' + 'http'
  return unwrapModule(await import(nodeHttpName))
}
