const workspacePackageSourceRoots = [
  'packages/backend/src',
  'packages/host/src',
  'packages/protocol/src',
  'packages/platform/src',
  'packages/spec/spec',
]

const workspacePackageSourceFiles = [
  'packages/backend/package.json',
  'packages/host/package.json',
  'packages/protocol/package.json',
  'packages/platform/package.json',
  'packages/spec/package.json',
  'packages/spec/schema.cjs',
]

const commonSourceRoots = [
  'packages/app/backend',
  ...workspacePackageSourceRoots,
]

const commonSourceFiles = [
  'packages/app/package.json',
  ...workspacePackageSourceFiles,
]

export const backendBundlesManifest = {
  bundles: [
    {
      id: 'backend',
      cacheId: 'backend',
      entry: 'packages/app/backend/index.mjs',
      output: 'packages/app/backend.bundle.js',
      sourceRoots: commonSourceRoots,
      sourceFiles: commonSourceFiles,
      pack: {
        command: 'bare-pack',
        flags: ['--preset', 'mobile', '--linked'],
        target: 'mobile',
      },
      runtime: {
        role: 'mobile-backend',
        workletId: '/peartube-backend-core.bundle',
        cacheFilename: 'backend.bundle',
        required: true,
      },
    },
    {
      id: 'downloader-worker',
      cacheId: 'downloader-worker',
      entry: 'packages/app/backend/downloader-worker.mjs',
      output: 'packages/app/downloader-worker.bundle.js',
      sourceRoots: commonSourceRoots,
      sourceFiles: commonSourceFiles,
      pack: {
        command: 'bare-pack',
        flags: ['--preset', 'mobile', '--linked'],
        target: 'mobile',
      },
      runtime: {
        role: 'downloader-worker',
        cacheFilename: 'downloader-worker.bundle.js',
        required: true,
        launchArg: true,
      },
    },
  ],
  watch: {
    extensions: ['.js', '.mjs', '.cjs', '.ts', '.json'],
    ignoredDirectories: ['node_modules', '.git'],
  },
}

export default backendBundlesManifest
