let binding

try {
  binding = require.addon()
} catch (err) {
  const os = require('bare-os')
  const path = require('bare-path')
  
  const platform = os.platform()
  const arch = os.arch()
  const target = `${platform}-${arch}`
  const prebuildPath = path.join(__dirname, 'prebuilds', target, 'bare-mpv.bare')
  
  const message = [
    `Failed to load bare-mpv native addon for ${target}`,
    '',
    `Looked for prebuild at: ${prebuildPath}`,
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
    `Original error: ${err.message}`
  ].join('\n')
  
  throw new Error(message)
}

module.exports = binding
