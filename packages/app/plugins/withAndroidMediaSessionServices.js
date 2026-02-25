const { withAndroidManifest } = require('@expo/config-plugins');

function ensurePermission(manifest, permission) {
  const usesPermission = manifest['uses-permission'] || [];
  if (!usesPermission.some((item) => item.$?.['android:name'] === permission)) {
    usesPermission.push({ $: { 'android:name': permission } });
    manifest['uses-permission'] = usesPermission;
  }
}

function ensureService(application, serviceConfig) {
  const services = application.service || [];
  const existing = services.find((service) => service.$?.['android:name'] === serviceConfig.$['android:name']);
  if (!existing) {
    services.push(serviceConfig);
    application.service = services;
  }
}

function ensureIntentFilter(activity, intentFilter) {
  const filters = activity['intent-filter'] || [];
  const exists = filters.some((filter) => {
    const actions = (filter.action || []).map((a) => a.$?.['android:name']);
    const categories = (filter.category || []).map((c) => c.$?.['android:name']);
    const hasAction = intentFilter.action?.some((a) => actions.includes(a.$['android:name']));
    const hasCategory = intentFilter.category?.some((c) => categories.includes(c.$['android:name']));
    return hasAction && hasCategory;
  });
  if (!exists) {
    filters.push(intentFilter);
    activity['intent-filter'] = filters;
  }
}

function withAndroidMediaSessionServices(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;

    ensurePermission(manifest, 'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK');
    ensurePermission(manifest, 'android.permission.FOREGROUND_SERVICE');
    ensurePermission(manifest, 'android.permission.WAKE_LOCK');
    ensurePermission(manifest, 'android.permission.POST_NOTIFICATIONS');
    ensurePermission(manifest, 'android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE');
    ensurePermission(manifest, 'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS');

    const application = manifest.application?.[0];
    if (!application) {
      console.warn('[withAndroidMediaSessionServices] No application found in manifest');
      return config;
    }

    const activities = application.activity || [];
    const mainActivity = activities.find((activity) => {
      const name = activity.$?.['android:name'];
      return name === '.MainActivity' || name?.endsWith('.MainActivity');
    });
    if (!mainActivity) {
      console.warn('[withAndroidMediaSessionServices] No MainActivity found in manifest');
    } else {
      ensureIntentFilter(mainActivity, {
        action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }],
        category: [{ $: { 'android:name': 'android.intent.category.APP_MUSIC' } }],
      });
      ensureIntentFilter(mainActivity, {
        action: [{ $: { 'android:name': 'android.intent.action.MUSIC_PLAYER' } }],
        category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }],
      });
    }

    ensureService(application, {
      $: {
        'android:name': 'to.holepunch.modules.mediasession.PearTubeMediaBrowserService',
        'android:exported': 'true',
        'android:permission': 'android.permission.BIND_MEDIA_BROWSER_SERVICE',
      },
      'intent-filter': [
        {
          action: [
            { $: { 'android:name': 'android.media.browse.MediaBrowserService' } },
          ],
        },
      ],
    });

    ensureService(application, {
      $: {
        'android:name': 'to.holepunch.modules.mediasession.MediaPlaybackService',
        'android:exported': 'false',
        'android:foregroundServiceType': 'mediaPlayback|connectedDevice',
      },
    });

    return config;
  });
}

module.exports = withAndroidMediaSessionServices;
