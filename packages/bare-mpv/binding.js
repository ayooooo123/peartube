let binding
const os = require('bare-os')
const path = require('bare-path')

const platform = os.platform()
const arch = os.arch()
const target = `${platform}-${arch}`
const localPrebuildPath = path.join(__dirname, 'prebuilds', target, 'bare-mpv.bare')
const bundledPrebuildRoot = process.env.BARE_MPV_PREBUILD_ROOT
const bundledPrebuildPath = bundledPrebuildRoot
  ? path.join(bundledPrebuildRoot, target, 'bare-mpv.bare')
  : null

try {
  if (bundledPrebuildPath) {
    binding = require.addon(bundledPrebuildPath, __filename)
  } else {
    binding = require.addon('.', __filename)
  }
} catch (err) {
  const prebuildPath = bundledPrebuildPath || localPrebuildPath

  try {
    binding = require.addon(prebuildPath, __filename)
  } catch (fallbackErr) {
    const rootHint = bundledPrebuildRoot
      ? `Bundled prebuild root: ${bundledPrebuildRoot}`
      : 'Bundled prebuild root: not set'

  const message = [
    `Failed to load bare-mpv native addon for ${target}`,
    '',
    `Looked for prebuild at: ${prebuildPath}`,
    rootHint,
    '',
    'This can happen if:',
    '  1. No prebuild exists for your platform',
    '  2. The prebuild failed to download during install',
    '  3. Building from source failed',
    '',
    'To build from source:',
    '  cd packages/bare-mpv',
    '  npm run build',
    '',
    'Prerequisites: cmake, ninja, meson, pkg-config, python3, nasm',
    'See README.md for platform-specific instructions.',
    '',
    `Original error: ${fallbackErr.message}`
  ].join('\n')

    throw new Error(message)
  }
}

module.exports = binding
