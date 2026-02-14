const { withDangerousMod } = require('@expo/config-plugins')
const path = require('path')
const { spawnSync } = require('child_process')

let hasEnsured = false

function ensureBackendBundles(projectRoot) {
  if (hasEnsured) return

  const scriptPath = path.join(projectRoot, 'scripts', 'ensure-backend-bundles.js')
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
  })

  if (result.status !== 0) {
    throw new Error('Failed to ensure backend bundles before prebuild')
  }

  hasEnsured = true
}

function withEnsureBackendBundles(config) {
  const applyEnsure = (platform) => withDangerousMod(config, [platform, (cfg) => {
    ensureBackendBundles(cfg.modRequest.projectRoot)
    return cfg
  }])

  config = applyEnsure('ios')
  config = applyEnsure('android')
  return config
}

module.exports = withEnsureBackendBundles
