const { withAndroidManifest } = require('@expo/config-plugins')

function ensureActivity(application, activityConfig) {
  const activities = application.activity || []
  const existing = activities.find((activity) => activity.$?.['android:name'] === activityConfig.$['android:name'])
  if (!existing) {
    activities.push(activityConfig)
    application.activity = activities
    return activityConfig
  }
  Object.assign(existing.$, activityConfig.$)
  return existing
}

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

    ensureActivity(application, {
      $: {
        'android:name': '.PlayerActivity',
        'android:configChanges': 'keyboard|keyboardHidden|orientation|screenSize|screenLayout|uiMode|smallestScreenSize',
        'android:launchMode': 'singleTask',
        'android:windowSoftInputMode': 'adjustResize',
        'android:theme': '@style/AppTheme',
        'android:exported': 'false',
        'android:screenOrientation': 'unspecified',
        'android:supportsPictureInPicture': 'true',
        'android:resizeableActivity': 'true',
      },
    })

    return config
  })
}

module.exports = withAndroidPiP
