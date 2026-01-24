const { withAppBuildGradle } = require('@expo/config-plugins');

/**
 * Expo config plugin to enable ABI splits for separate APKs per architecture.
 * This produces smaller APKs (arm64-v8a, armeabi-v7a, x86, x86_64) instead of one fat APK.
 */
function withAndroidAbiSplits(config) {
  return withAppBuildGradle(config, (config) => {
    let buildGradle = config.modResults.contents;

    // Check if splits block already exists
    if (buildGradle.includes('splits {')) {
      console.log('[withAndroidAbiSplits] ABI splits already configured');
      return config;
    }

    // Find the closing brace of buildTypes and insert splits block after it
    // We need to find the buildTypes block and insert after it
    const buildTypesMatch = buildGradle.match(/buildTypes\s*\{[\s\S]*?\n    \}/);
    if (!buildTypesMatch) {
      console.warn('[withAndroidAbiSplits] Could not find buildTypes block');
      return config;
    }

    const buildTypesEnd = buildGradle.indexOf(buildTypesMatch[0]) + buildTypesMatch[0].length;
    
    const splitsBlock = `
    splits {
        abi {
            reset()
            enable true
            include "armeabi-v7a", "arm64-v8a", "x86", "x86_64"
            universalApk false
        }
    }`;

    buildGradle = 
      buildGradle.slice(0, buildTypesEnd) + 
      splitsBlock + 
      buildGradle.slice(buildTypesEnd);

    // Add version code mapping after the android block closing brace
    // Find the android block end (look for the closing brace at the right indentation level)
    const androidBlockEndRegex = /^android\s*\{[\s\S]*?\n\}/m;
    const androidMatch = buildGradle.match(androidBlockEndRegex);
    
    if (androidMatch) {
      const androidEnd = buildGradle.indexOf(androidMatch[0]) + androidMatch[0].length;
      
      const versionCodeBlock = `

// Map for ABI version codes
ext.abiCodes = ['armeabi-v7a': 1, 'arm64-v8a': 2, 'x86': 3, 'x86_64': 4]

android.applicationVariants.all { variant ->
    variant.outputs.each { output ->
        def baseVersionCode = variant.versionCode
        def abiFilter = output.getFilter(com.android.build.OutputFile.ABI)
        def abiCode = abiFilter != null ? abiCodes.get(abiFilter, 0) : 0
        if (abiCode != 0) {
            output.versionCodeOverride = baseVersionCode * 10 + abiCode
        }
    }
}
`;

      buildGradle = 
        buildGradle.slice(0, androidEnd) + 
        versionCodeBlock + 
        buildGradle.slice(androidEnd);
    }

    config.modResults.contents = buildGradle;
    console.log('[withAndroidAbiSplits] Added ABI splits configuration');
    
    return config;
  });
}

module.exports = withAndroidAbiSplits;
