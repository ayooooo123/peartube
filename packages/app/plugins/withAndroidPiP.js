const fs = require('node:fs');
const path = require('node:path');
const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');

function createPlayerActivitySource(packageName) {
  return `package ${packageName}

import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import expo.modules.ReactActivityDelegateWrapper
import to.holepunch.modules.mediasession.PipBridge

class PlayerActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    setTheme(R.style.AppTheme)
    super.onCreate(null)
  }

  override fun getMainComponentName(): String = "main"

  override fun createReactActivityDelegate(): ReactActivityDelegate {
    return ReactActivityDelegateWrapper(
      this,
      BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,
      object : DefaultReactActivityDelegate(
        this,
        mainComponentName,
        fabricEnabled,
      ) {},
    )
  }

  override fun invokeDefaultOnBackPressed() {
    if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.R) {
      if (!moveTaskToBack(false)) {
        super.invokeDefaultOnBackPressed()
      }
      return
    }

    super.invokeDefaultOnBackPressed()
  }

  override fun onUserLeaveHint() {
    super.onUserLeaveHint()
    PipBridge.onUserLeaveHint(this)
  }

  override fun onPictureInPictureModeChanged(
    isInPictureInPictureMode: Boolean,
    newConfig: Configuration,
  ) {
    super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
    PipBridge.notifyPipModeChanged(this, isInPictureInPictureMode, newConfig)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    if (isInPictureInPictureMode) {
      PipBridge.notifyPipModeChanged(this, true, newConfig)
    }
  }
}
`;
}

function ensurePlayerActivitySource(config) {
  const packageName = config.android?.package;
  if (!packageName) {
    console.warn('[withAndroidPiP] Missing android.package, skipping PlayerActivity source generation');
    return config;
  }

  const packagePath = packageName.split('.').join(path.sep);
  const androidRoot = path.join(config.modRequest.platformProjectRoot, 'app', 'src', 'main', 'java');
  const activityDir = path.join(androidRoot, packagePath);
  const activityPath = path.join(activityDir, 'PlayerActivity.kt');
  const source = createPlayerActivitySource(packageName);

  fs.mkdirSync(activityDir, { recursive: true });
  if (!fs.existsSync(activityPath) || fs.readFileSync(activityPath, 'utf8') !== source) {
    fs.writeFileSync(activityPath, source);
    console.log(`[withAndroidPiP] Wrote PlayerActivity source: ${activityPath}`);
  }

  return config;
}

function withAndroidPiP(config) {
  config = withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    
    const application = manifest.application?.[0];
    if (!application) {
      console.warn('[withAndroidPiP] No application found in manifest');
      return config;
    }
    
    const activities = application.activity;
    if (!activities || !Array.isArray(activities)) {
      console.warn('[withAndroidPiP] No activities found in manifest');
      return config;
    }
    
    let mainActivityFound = false;
    for (const activity of activities) {
      const activityName = activity.$?.['android:name'];
      if (activityName === '.MainActivity' || activityName?.endsWith('.MainActivity')) {
        mainActivityFound = true;
        console.log('[withAndroidPiP] Found MainActivity, adding PiP support');
        activity.$['android:supportsPictureInPicture'] = 'true';
        
        const existingConfigChanges = activity.$['android:configChanges'] || '';
        const configChangesSet = new Set(existingConfigChanges.split('|').filter(Boolean));
        configChangesSet.add('screenSize');
        configChangesSet.add('smallestScreenSize');
        configChangesSet.add('screenLayout');
        activity.$['android:configChanges'] = Array.from(configChangesSet).join('|');
        
        console.log('[withAndroidPiP] MainActivity updated:', activity.$);
        break;
      }
    }

    if (!mainActivityFound) {
      console.warn('[withAndroidPiP] MainActivity not found while applying PiP plugin');
    }

    const playerActivityName = '.PlayerActivity';
    const existingPlayerActivity = activities.find((activity) => {
      const name = activity.$?.['android:name'];
      return name === playerActivityName || name?.endsWith('.PlayerActivity');
    });

    if (!existingPlayerActivity) {
      console.log('[withAndroidPiP] Adding PlayerActivity for split-activity PiP flow');
      activities.push({
        $: {
          'android:name': playerActivityName,
          'android:configChanges': 'keyboard|keyboardHidden|orientation|screenSize|screenLayout|uiMode|smallestScreenSize',
          'android:launchMode': 'singleTask',
          'android:windowSoftInputMode': 'adjustResize',
          'android:theme': '@style/Theme.App.SplashScreen',
          'android:exported': 'false',
          'android:screenOrientation': 'unspecified',
          'android:supportsPictureInPicture': 'true',
        },
      });
    } else {
      existingPlayerActivity.$['android:supportsPictureInPicture'] = 'true';
      const existingConfigChanges = existingPlayerActivity.$['android:configChanges'] || '';
      const configChangesSet = new Set(existingConfigChanges.split('|').filter(Boolean));
      configChangesSet.add('screenSize');
      configChangesSet.add('smallestScreenSize');
      configChangesSet.add('screenLayout');
      existingPlayerActivity.$['android:configChanges'] = Array.from(configChangesSet).join('|');
    }
    
    return config;
  });

  config = withDangerousMod(config, [
    'android',
    (config) => ensurePlayerActivitySource(config),
  ]);

  return config;
}

module.exports = withAndroidPiP;
