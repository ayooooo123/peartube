const { withAndroidManifest } = require('@expo/config-plugins')

function withAndroidPiP(config) {
  return withAndroidManifest(config, (config) => {
    const application = config.modResults.manifest.application?.[0]
    const activities = application?.activity

    if (!application || !Array.isArray(activities)) {
      console.warn('[withAndroidPiP] Missing application activities; skipping Android PiP manifest wiring')
      return config
    }

    const mainActivity = activities.find((activity) => {
      const name = activity.$?.['android:name']
      return name === '.MainActivity' || name?.endsWith('.MainActivity')
    })

    if (mainActivity) {
      const existingConfigChanges = mainActivity.$['android:configChanges'] || ''
      const configChangesSet = new Set(existingConfigChanges.split('|').filter(Boolean))
      configChangesSet.add('screenSize')
      configChangesSet.add('smallestScreenSize')
      configChangesSet.add('screenLayout')

      mainActivity.$['android:supportsPictureInPicture'] = 'true'
      mainActivity.$['android:configChanges'] = Array.from(configChangesSet).join('|')
    }

    return config
  })
}

module.exports = withAndroidPiP
