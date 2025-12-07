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

// Disable hierarchical lookup for pnpm compatibility
config.resolver.disableHierarchicalLookup = true

// Add .bundle.js extension to source extensions so Metro can resolve it
// The backend.bundle.js file is a CommonJS module that exports a string
config.resolver.sourceExts.push('bundle.js')

module.exports = withNativeWind(config, { input: './global.css' })
