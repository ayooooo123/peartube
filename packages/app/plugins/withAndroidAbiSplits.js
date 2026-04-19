const { withAppBuildGradle } = require('@expo/config-plugins');

function withAndroidAbiSplits(config) {
  return withAppBuildGradle(config, (config) => {
    let buildGradle = config.modResults.contents;

    if (buildGradle.includes('splits {')) {
      console.log('[withAndroidAbiSplits] ABI splits already configured');
      return config;
    }

    const splitsBlock = `    def configuredSplitAbis = (findProperty('targetAbis') ?: findProperty('reactNativeArchitectures') ?: 'armeabi-v7a,arm64-v8a,x86,x86_64')
        .toString()
        .split(',')
        .collect { it.trim() }
        .findAll { it }

    splits {
        abi {
            reset()
            enable true
            include(*configuredSplitAbis)
            universalApk false
        }
    }
    `;

    const packagingOptionsIndex = buildGradle.indexOf('packagingOptions {');
    if (packagingOptionsIndex === -1) {
      console.warn('[withAndroidAbiSplits] Could not find packagingOptions block');
      return config;
    }

    buildGradle = 
      buildGradle.slice(0, packagingOptionsIndex) + 
      splitsBlock + 
      buildGradle.slice(packagingOptionsIndex);

    const versionCodeBlock = `
// ABI version codes for split APKs
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

    const dependenciesIndex = buildGradle.indexOf('dependencies {');
    if (dependenciesIndex !== -1) {
      buildGradle = 
        buildGradle.slice(0, dependenciesIndex) + 
        versionCodeBlock + 
        buildGradle.slice(dependenciesIndex);
    }

    config.modResults.contents = buildGradle;
    console.log('[withAndroidAbiSplits] Added ABI splits configuration');
    
    return config;
  });
}

module.exports = withAndroidAbiSplits;
