// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config')
const { withNativeWind } = require('nativewind/metro')
const path = require('path')

let metroResolve = null
try {
  ;({ resolve: metroResolve } = require('metro-resolver'))
} catch {
  // Optional dependency; if missing, web builds may resolve to native react-native.
  metroResolve = null
}

// Monorepo root
const projectRoot = __dirname
const monorepoRoot = path.resolve(projectRoot, '../..')

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(projectRoot)

// For Pear desktop web exports we must avoid bundling React Native's native runtime.
// Metro's default pre-modules include `react-native/Libraries/Core/InitializeCore`, which
// expects a native bridge to inject `__fbBatchedBridgeConfig`.
const originalGetModulesRunBeforeMainModule = config.serializer?.getModulesRunBeforeMainModule
if (typeof originalGetModulesRunBeforeMainModule === 'function') {
  config.serializer.getModulesRunBeforeMainModule = () => {
    const pre = originalGetModulesRunBeforeMainModule()
    if (process.env.PEARTUBE_WEB_EXPORT === '1') {
      const shim = require.resolve('./web/native-module-proxy')
      const filtered = pre.filter(m => !m.includes(`${path.sep}Libraries${path.sep}Core${path.sep}InitializeCore`))
      return [shim, ...filtered]
    }
    return pre
  }
}

const originalGetPolyfills = config.serializer?.getPolyfills
if (typeof originalGetPolyfills === 'function') {
  config.serializer.getPolyfills = options => {
    const polyfills = originalGetPolyfills(options)
    if (process.env.PEARTUBE_WEB_EXPORT === '1' && options?.platform === 'web') {
      const shim = require.resolve('./web/native-module-proxy')
      return [shim, ...polyfills]
    }
    return polyfills
  }
}

// Ensure platform extensions work for web builds.
// @expo/metro-config defaults to native-only platforms.
config.resolver.platforms = Array.from(
  new Set([...(config.resolver.platforms ?? []), 'ios', 'android', 'native', 'web'])
)

// Watch all monorepo folders for changes
config.watchFolders = [monorepoRoot]

// Node modules resolution - check both local and root
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
]

// Enable hierarchical lookup for proper module resolution
config.resolver.disableHierarchicalLookup = false

// Spec module resolution + force shared singleton modules for symlinked packages
const specRoot = path.resolve(monorepoRoot, 'packages/spec')
config.resolver.extraNodeModules = {
  '@peartube/spec': path.resolve(specRoot, 'spec/hrpc/index.js'),
  '@peartube/spec/messages': path.resolve(specRoot, 'spec/hrpc/messages.js'),
  '@peartube/spec/schema': path.resolve(specRoot, 'spec/schema/index.js'),
  'react': path.resolve(projectRoot, 'node_modules/react'),
  // Browser polyfill for Node's events module — bare-events is native-only
  // and resolves to an empty stub on web, crashing streamx/protomux/HRPC.
  'events': path.resolve(projectRoot, 'node_modules/events'),
}

// Ensure web export never bundles native React Native.
if (process.env.PEARTUBE_WEB_EXPORT === '1') {
  config.resolver.extraNodeModules['react-native'] = require.resolve('react-native-web')
}

// Force web bundles to resolve react-native to react-native-web.
// Without this, Metro can bundle native react-native internals which crash at runtime
// with: __fbBatchedBridgeConfig is not set.
// Only override for web builds — applying a custom resolveRequest globally bypasses
// Metro's unstable_enablePackageExports handling and breaks native Android/iOS builds.
if (metroResolve && process.env.PEARTUBE_WEB_EXPORT === '1') {
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    if (platform === 'web' && moduleName === 'react-native') {
      return metroResolve(context, 'react-native-web', platform)
    }
    return metroResolve(context, moduleName, platform)
  }
}

// Force Metro to ignore paths that would cause duplicate module instances
const escapeForRegex = value => value.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
const rootSpecPath = path.resolve(monorepoRoot, 'node_modules/@peartube/spec')
const pearBuildPath = path.resolve(projectRoot, 'pear')
const electrobunBuildPath = path.resolve(projectRoot, 'build')
const hostNodeModules = path.resolve(monorepoRoot, 'packages/host/node_modules')
config.resolver.blockList = [
  new RegExp(`${escapeForRegex(rootSpecPath)}\\/.*`),
  new RegExp(`${escapeForRegex(pearBuildPath)}\\/.*`),
  new RegExp(`${escapeForRegex(electrobunBuildPath)}\\/.*`),
  new RegExp(`${escapeForRegex(hostNodeModules)}\\/.*`),
]

// Add .bundle.js extension to source extensions so Metro can resolve it
// The backend.bundle.js file is a CommonJS module that exports a string
config.resolver.sourceExts.push('bundle.js')

module.exports = withNativeWind(config, { input: './global.css' })
