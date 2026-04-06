const { withAppBuildGradle } = require('@expo/config-plugins')

/**
 * Adds NextLib (prebuilt FFmpeg decoder extension for Media3) to enable
 * AC3/EAC3/DTS and other audio codecs that Android's stock MediaCodec
 * doesn't support.
 */
function withNextLib(config) {
  return withAppBuildGradle(config, (config) => {
    let contents = config.modResults.contents

    if (contents.includes('nextlib-media3ext')) {
      return config
    }

    // Add NextLib dependency after the media3 dependencies
    contents = contents.replace(
      '    implementation("androidx.media3:media3-exoplayer:1.8.0")',
      '    implementation("androidx.media3:media3-exoplayer:1.8.0")\n' +
      '    implementation("io.github.nicegamer7:nextlib-media3ext:0.8.3")',
    )

    config.modResults.contents = contents
    return config
  })
}

module.exports = withNextLib
