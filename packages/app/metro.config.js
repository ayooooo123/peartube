// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config')
const { withNativeWind } = require('nativewind/metro')
const path = require('path')

// Monorepo root
const projectRoot = __dirname
const monorepoRoot = path.resolve(projectRoot, '../..')

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(projectRoot)

// Watch all monorepo folders for changes
config.watchFolders = [monorepoRoot]

// Node modules resolution - check both local and root
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
]

// Enable hierarchical lookup for proper module resolution
config.resolver.disableHierarchicalLookup = false

// Spec module resolution
const specRoot = path.resolve(monorepoRoot, 'packages/spec')
config.resolver.extraNodeModules = {
  '@peartube/spec': path.resolve(specRoot, 'spec/hrpc/index.js'),
  '@peartube/spec/messages': path.resolve(specRoot, 'spec/hrpc/messages.js'),
  '@peartube/spec/schema': path.resolve(specRoot, 'spec/schema/index.js'),
}

// Force Metro to ignore the hoisted spec in the monorepo root.
const escapeForRegex = value => value.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
const rootSpecPath = path.resolve(monorepoRoot, 'node_modules/@peartube/spec')
config.resolver.blockList = [new RegExp(`${escapeForRegex(rootSpecPath)}\\/.*`)]

// Add .bundle.js extension to source extensions so Metro can resolve it
// The backend.bundle.js file is a CommonJS module that exports a string
config.resolver.sourceExts.push('bundle.js')

module.exports = withNativeWind(config, { input: './global.css' })
