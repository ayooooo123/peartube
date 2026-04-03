const fs = require('node:fs')
const path = require('node:path')
const { withAndroidManifest, withDangerousMod, withAppBuildGradle } = require('@expo/config-plugins')

function createPlayerActivitySource(packageName) {
  const templatePath = path.join(__dirname, 'templates', 'PlayerActivity.kt.template')
  const template = fs.readFileSync(templatePath, 'utf8')
  return template.replace('__PACKAGE__', packageName)
}

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

function normalizePipActivities(application) {
  const activities = application.activity || []
  if (!Array.isArray(activities)) {
    return { mainActivity: null, playerActivity: null }
  }

  const mainActivity = activities.find((activity) => {
    const name = activity.$?.['android:name']
    return name === '.MainActivity' || name?.endsWith('.MainActivity')
  }) ?? null

  if (mainActivity) {
    const existingConfigChanges = mainActivity.$['android:configChanges'] || ''
    const configChangesSet = new Set(existingConfigChanges.split('|').filter(Boolean))
    configChangesSet.add('screenSize')
    configChangesSet.add('smallestScreenSize')
    configChangesSet.add('screenLayout')

    mainActivity.$['android:configChanges'] = Array.from(configChangesSet).join('|')
    mainActivity.$['android:supportsPictureInPicture'] = 'true'
    mainActivity.$['android:resizeableActivity'] = 'true'
  }

  const playerActivity = ensureActivity(application, {
    $: {
      'android:name': '.PlayerActivity',
      'android:configChanges': 'keyboard|keyboardHidden|orientation|screenSize|screenLayout|uiMode|smallestScreenSize',
      'android:launchMode': 'singleTask',
      'android:windowSoftInputMode': 'adjustResize',
      'android:theme': '@style/PlayerActivityTheme',
      'android:exported': 'false',
      'android:screenOrientation': 'unspecified',
    },
  })

  delete playerActivity.$['android:supportsPictureInPicture']
  delete playerActivity.$['android:resizeableActivity']

  return { mainActivity, playerActivity }
}

function ensurePlayerActivitySource(config) {
  const packageName = config.android?.package
  if (!packageName) {
    console.warn('[withAndroidPiP] Missing android.package, skipping PlayerActivity source generation')
    return config
  }

  const packagePath = packageName.split('.').join(path.sep)
  const androidRoot = path.join(config.modRequest.platformProjectRoot, 'app', 'src', 'main', 'java')
  const activityDir = path.join(androidRoot, packagePath)
  const activityPath = path.join(activityDir, 'PlayerActivity.kt')
  const source = createPlayerActivitySource(packageName)

  fs.mkdirSync(activityDir, { recursive: true })
  if (!fs.existsSync(activityPath) || fs.readFileSync(activityPath, 'utf8') !== source) {
    fs.writeFileSync(activityPath, source)
    console.log(`[withAndroidPiP] Wrote PlayerActivity source: ${activityPath}`)
  }

  return config
}

function ensureMedia3Deps(buildGradle) {
  const media3Deps = [
    '    implementation("androidx.media3:media3-exoplayer:1.8.0")',
    '    implementation("androidx.media3:media3-ui:1.8.0")',
  ]

  let contents = buildGradle
  for (const dep of media3Deps) {
    if (!contents.includes(dep)) {
      contents = contents.replace(
        '    implementation("com.facebook.react:react-android")',
        `    implementation("com.facebook.react:react-android")\n${dep}`,
      )
    }
  }

  return contents
}

function ensurePlayerActivityTheme(config) {
  const stylesPath = path.join(
    config.modRequest.platformProjectRoot,
    'app',
    'src',
    'main',
    'res',
    'values',
    'styles.xml',
  )

  if (!fs.existsSync(stylesPath)) {
    return config
  }

  const themeBlock = [
    '  <style name="PlayerActivityTheme" parent="AppTheme">',
    '    <item name="android:windowIsTranslucent">true</item>',
    '    <item name="android:windowBackground">@android:color/transparent</item>',
    '    <item name="android:backgroundDimEnabled">false</item>',
    '    <item name="android:windowContentOverlay">@null</item>',
    '  </style>',
    '',
  ].join('\n')

  const current = fs.readFileSync(stylesPath, 'utf8')
  if (current.includes('<style name="PlayerActivityTheme"')) {
    return config
  }

  const updated = current.replace('  <style name="Theme.App.SplashScreen" parent="AppTheme">', `${themeBlock}  <style name="Theme.App.SplashScreen" parent="AppTheme">`)
  fs.writeFileSync(stylesPath, updated)
  return config
}

function withAndroidPiP(config) {
  config = withAndroidManifest(config, (config) => {
    const application = config.modResults.manifest.application?.[0]
    const activities = application?.activity

    if (!application || !Array.isArray(activities)) {
      console.warn('[withAndroidPiP] Missing application activities; skipping Android PiP manifest wiring')
      return config
    }

    const { mainActivity } = normalizePipActivities(application)
    if (!mainActivity) {
      console.warn('[withAndroidPiP] No MainActivity found in manifest')
    }

    return config
  })

  config = withAppBuildGradle(config, (config) => {
    config.modResults.contents = ensureMedia3Deps(config.modResults.contents)
    return config
  })

  config = withDangerousMod(config, [
    'android',
    (config) => {
      ensurePlayerActivityTheme(config)
      return ensurePlayerActivitySource(config)
    },
  ])

  return config
}

module.exports = withAndroidPiP
module.exports._normalizePipActivities = normalizePipActivities
