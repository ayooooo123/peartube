/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs')
const path = require('node:path')
const { withDangerousMod } = require('@expo/config-plugins')

const SOURCE_TEMPLATES = [
  'PeartubeNetworkDiscovery.kt',
  'PeartubeNetworkDiscoveryModule.kt',
  'PeartubeNetworkDiscoveryPackage.kt',
]

const DISCOVERY_FIELDS = [
  '  private val networkDiscovery by lazy { PeartubeNetworkDiscovery(this) }',
  '  private var startedActivityCount = 0',
].join('\n')

const STARTUP_BLOCK = [
  '    try {',
  '      networkDiscovery.start()',
  '    } catch (t: Throwable) {',
  '      networkDiscovery.logException("startup", t)',
  '    }',
].join('\n')

const LIFECYCLE_BLOCK = [
  '    registerActivityLifecycleCallbacks(object : ActivityLifecycleCallbacks {',
  '      override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit',
  '      override fun onActivityStarted(activity: Activity) {',
  '        startedActivityCount += 1',
  '        if (startedActivityCount == 1) {',
  '          try {',
  '            networkDiscovery.start()',
  '          } catch (t: Throwable) {',
  '            networkDiscovery.logException("foreground", t)',
  '          }',
  '        }',
  '      }',
  '      override fun onActivityResumed(activity: Activity) = Unit',
  '      override fun onActivityPaused(activity: Activity) = Unit',
  '      override fun onActivityStopped(activity: Activity) {',
  '        startedActivityCount = (startedActivityCount - 1).coerceAtLeast(0)',
  '        if (startedActivityCount == 0) {',
  '          try {',
  '            networkDiscovery.stop()',
  '          } catch (t: Throwable) {',
  '            networkDiscovery.logException("background", t)',
  '          }',
  '        }',
  '      }',
  '      override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit',
  '      override fun onActivityDestroyed(activity: Activity) = Unit',
  '    })',
].join('\n')

function getPackageName(config) {
  const packageName = config.android?.package
  if (!packageName) {
    throw new Error('[withAndroidNetworkDiscovery] Missing expo.android.package')
  }
  return packageName
}

function getApplicationSourcePath(config, packageName) {
  const packagePath = packageName.split('.').join(path.sep)
  return path.join(config.modRequest.platformProjectRoot, 'app', 'src', 'main', 'java', packagePath, 'MainApplication.kt')
}

function ensureImport(source, importLine) {
  if (source.includes(importLine)) return source

  const orderedAnchors = new Map([
    ['import android.app.Activity', { marker: 'import android.app.Application', position: 'before' }],
    ['import android.os.Bundle', { marker: 'import android.content.res.Configuration', position: 'after' }],
  ])
  const orderedAnchor = orderedAnchors.get(importLine)
  if (orderedAnchor && source.includes(orderedAnchor.marker)) {
    if (orderedAnchor.position === 'before') {
      return source.replace(orderedAnchor.marker, `${importLine}\n${orderedAnchor.marker}`)
    }
    return source.replace(orderedAnchor.marker, `${orderedAnchor.marker}\n${importLine}`)
  }

  if (importLine.includes('.PeartubeNetworkDiscovery') && source.includes('import expo.modules.ExpoReactHostFactory')) {
    return source.replace(
      'import expo.modules.ExpoReactHostFactory',
      `import expo.modules.ExpoReactHostFactory\n\n${importLine}`,
    )
  }

  const imports = [...source.matchAll(/^import .+$/gm)]
  if (imports.length === 0) {
    return source.replace(/^package .+$/m, (match) => `${match}\n\n${importLine}`)
  }

  const lastImport = imports[imports.length - 1]
  const insertAt = lastImport.index + lastImport[0].length
  return `${source.slice(0, insertAt)}\n${importLine}${source.slice(insertAt)}`
}

function ensureMainApplicationWiring(source, packageName) {
  let contents = source

  for (const importLine of [
    'import android.app.Activity',
    'import android.os.Bundle',
    `import ${packageName}.PeartubeNetworkDiscovery`,
  ]) {
    contents = ensureImport(contents, importLine)
  }

  if (!contents.includes('private val networkDiscovery by lazy')) {
    contents = contents.replace(
      /(class MainApplication : Application\(\), ReactApplication \{\n)/,
      `$1\n${DISCOVERY_FIELDS}\n`,
    )
  }

  if (!contents.includes('add(PeartubeNetworkDiscoveryPackage())')) {
    if (contents.includes('          // add(MyReactNativePackage())')) {
      contents = contents.replace(
        '          // add(MyReactNativePackage())',
        '          // add(MyReactNativePackage())\n          add(PeartubeNetworkDiscoveryPackage())',
      )
    } else {
      contents = contents.replace(
        /(PackageList\(this\)\.packages\.apply\s*\{\n)/,
        '$1          add(PeartubeNetworkDiscoveryPackage())\n',
      )
    }
  }

  if (!contents.includes('networkDiscovery.logException("startup", t)')) {
    contents = contents.replace(
      /(\n {4}loadReactNative\(this\))/,
      `\n${STARTUP_BLOCK}$1`,
    )
  }

  if (!contents.includes('registerActivityLifecycleCallbacks')) {
    contents = contents.replace(
      /(\n {4}ApplicationLifecycleDispatcher\.onApplicationCreate\(this\))/,
      `\n${LIFECYCLE_BLOCK}$1`,
    )
  }

  return contents
}

function writeDiscoverySources(config, packageName) {
  const packagePath = packageName.split('.').join(path.sep)
  const outputDir = path.join(config.modRequest.platformProjectRoot, 'app', 'src', 'main', 'java', packagePath)
  fs.mkdirSync(outputDir, { recursive: true })

  for (const sourceFile of SOURCE_TEMPLATES) {
    const templatePath = path.join(__dirname, 'templates', `${sourceFile}.template`)
    const outputPath = path.join(outputDir, sourceFile)
    const source = fs.readFileSync(templatePath, 'utf8').replaceAll('__PACKAGE__', packageName)
    if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, 'utf8') !== source) {
      fs.writeFileSync(outputPath, source)
    }
  }
}

function patchMainApplication(config, packageName) {
  const applicationPath = getApplicationSourcePath(config, packageName)
  if (!fs.existsSync(applicationPath)) {
    throw new Error('[withAndroidNetworkDiscovery] MainApplication.kt was not generated')
  }

  const current = fs.readFileSync(applicationPath, 'utf8')
  const updated = ensureMainApplicationWiring(current, packageName)
  if (updated !== current) {
    fs.writeFileSync(applicationPath, updated)
  }
}

function withAndroidNetworkDiscovery(config) {
  return withDangerousMod(config, [
    'android',
    (config) => {
      const packageName = getPackageName(config)
      writeDiscoverySources(config, packageName)
      patchMainApplication(config, packageName)
      console.log('[withAndroidNetworkDiscovery] Android network discovery sources ready')
      return config
    },
  ])
}

module.exports = withAndroidNetworkDiscovery
module.exports._ensureMainApplicationWiring = ensureMainApplicationWiring
