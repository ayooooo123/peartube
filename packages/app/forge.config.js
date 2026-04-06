const fs = require('fs')
const path = require('path')
const pkg = require('./pear-src/package.json')
const appName = pkg.productName ?? pkg.name
const { isWindows } = require('which-runtime')

function getWindowsKitVersion () {
  const programFiles = process.env['PROGRAMFILES(X86)'] || process.env.PROGRAMFILES
  if (!programFiles) return undefined
  const kitsDir = path.join(programFiles, 'Windows Kits')
  try {
    for (const kit of fs.readdirSync(kitsDir).sort().reverse()) {
      const binDir = path.join(kitsDir, kit, 'bin')
      if (!fs.existsSync(binDir)) continue
      const version = fs.readdirSync(binDir).filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d)).sort().pop()
      if (version) return version
    }
  } catch { return undefined }
}

let packagerConfig = {
  name: appName,
  icon: 'build/icon',
  protocols: [{ name: appName, schemes: [pkg.name] }],
  derefSymlinks: true,
  extraResource: ['./pear']
}

if (process.env.MAC_CODESIGN_IDENTITY) {
  packagerConfig = {
    ...packagerConfig,
    osxSign: {
      identity: process.env.MAC_CODESIGN_IDENTITY,
      optionsForFile: () => ({
        entitlements: path.join(__dirname, 'build', 'entitlements.mac.plist')
      })
    },
    osxNotarize: {
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID
    }
  }
}

module.exports = {
  packagerConfig,
  makers: [
    { name: '@electron-forge/maker-dmg', platforms: ['darwin'], config: {} },
    {
      name: '@electron-forge/maker-msix',
      platforms: ['win32'],
      config: {
        windowsKitVersion: getWindowsKitVersion(),
        ...(process.env.WINDOWS_CERTIFICATE_FILE ? {
          windowsSignOptions: {
            certificateFile: process.env.WINDOWS_CERTIFICATE_FILE,
            certificatePassword: process.env.WINDOWS_CERTIFICATE_PASSWORD
          }
        } : {})
      }
    },
    { name: '@electron-forge/maker-zip', platforms: ['darwin', 'linux'] }
  ],
  hooks: {
    preMake: async () => {
      fs.rmSync(path.join(__dirname, 'out', 'make'), { recursive: true, force: true })
    },
    postMake: async (forgeConfig, results) => {
      for (const result of results) {
        if (result.platform !== 'win32') continue
        for (const artifact of result.artifacts) {
          if (!artifact.endsWith('.msix')) continue
          const standardDir = path.join(__dirname, 'out', `${appName}-win32-${result.arch}`)
          fs.mkdirSync(standardDir, { recursive: true })
          const dest = path.join(standardDir, path.basename(artifact))
          fs.renameSync(artifact, dest)
          result.artifacts[result.artifacts.indexOf(artifact)] = dest
        }
      }
      if (isWindows) {
        fs.rmSync(path.join(__dirname, 'out', 'make'), { recursive: true, force: true })
      }
    }
  },
  plugins: [
    { name: 'electron-forge-plugin-universal-prebuilds', config: {} },
    { name: 'electron-forge-plugin-prune-prebuilds', config: {} }
  ]
}
