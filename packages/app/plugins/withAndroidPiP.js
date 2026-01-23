const { withAndroidManifest } = require('@expo/config-plugins');

function withAndroidPiP(config) {
  return withAndroidManifest(config, (config) => {
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
    
    for (const activity of activities) {
      const activityName = activity.$?.['android:name'];
      if (activityName === '.MainActivity' || activityName?.endsWith('.MainActivity')) {
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
    
    return config;
  });
}

module.exports = withAndroidPiP;
