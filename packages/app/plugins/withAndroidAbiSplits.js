/* eslint-disable @typescript-eslint/no-require-imports */
const { withAppBuildGradle } = require('@expo/config-plugins');

const abiResolverBlock = `def resolveAndroidTargetAbis = {
    def targetAbiProperty = (findProperty('targetAbis') ?: findProperty('reactNativeArchitectures') ?: '').toString()
    return targetAbiProperty ? targetAbiProperty.split(',').collect { it.trim() }.findAll { it } : ["armeabi-v7a", "arm64-v8a", "x86", "x86_64"]
}

`;

const defaultAndroidAbis = ['armeabi-v7a', 'arm64-v8a', 'x86', 'x86_64'];

const bareAddonPruneBlock = `def bareAndroidAddonsRoot = file("$projectRoot/node_modules/react-native-bare-kit/android/src/main/addons")

tasks.register("ensureBackendBundles", Exec) {
    workingDir file(projectRoot)
    commandLine "node", "scripts/ensure-backend-bundles.js"
    inputs.file(file("$projectRoot/backend-bundles.manifest.mjs"))
    inputs.dir(file("$projectRoot/backend"))
    inputs.dir(file("$projectRoot/../backend/src"))
    inputs.dir(file("$projectRoot/../host/src"))
    inputs.dir(file("$projectRoot/../protocol/src"))
    inputs.dir(file("$projectRoot/../platform/src"))
    inputs.file(file("$projectRoot/package.json"))
    inputs.file(file("$projectRoot/../backend/package.json"))
    inputs.file(file("$projectRoot/../host/package.json"))
    inputs.file(file("$projectRoot/../protocol/package.json"))
    inputs.file(file("$projectRoot/../platform/package.json"))
    inputs.file(file("$projectRoot/../spec/package.json"))
    inputs.file(file("$projectRoot/../spec/schema.cjs"))
    outputs.files(
        file("$projectRoot/backend.bundle.js"),
        file("$projectRoot/downloader-worker.bundle.js")
    )
}

tasks.register("pruneBareAndroidAddons", Exec) {
    workingDir file(projectRoot)
    commandLine "node", "scripts/prune-android-bare-addons.mjs", "--addons-root", bareAndroidAddonsRoot.absolutePath
    resolveAndroidTargetAbis().each { abi ->
        args "--abi", abi
    }
    inputs.file(file("$projectRoot/backend-bundles.manifest.mjs"))
    inputs.files(
        file("$projectRoot/backend.bundle.js"),
        file("$projectRoot/downloader-worker.bundle.js")
    )
    inputs.dir(bareAndroidAddonsRoot)
    outputs.dir(bareAndroidAddonsRoot)
    outputs.upToDateWhen { false }
    dependsOn(tasks.named("ensureBackendBundles"))
}

gradle.projectsEvaluated {
    def ensureBundlesTask = tasks.named("ensureBackendBundles")
    def pruneTask = tasks.named("pruneBareAndroidAddons")

    tasks.matching {
        it.name.startsWith("createBundle") && it.name.endsWith("JsAndAssets")
    }.configureEach {
        dependsOn(ensureBundlesTask)
    }

    def bareKitProject = rootProject.subprojects.find { it.name == "react-native-bare-kit" }
    if (bareKitProject != null) {
        def bareKitLinkTask = bareKitProject.tasks.findByName("link")
        if (bareKitLinkTask != null) {
            pruneTask.configure {
                dependsOn(bareKitLinkTask)
            }
        }

        bareKitProject.tasks.matching {
            it.name == "preReleaseBuild" ||
            it.name == "mergeReleaseNativeLibs" ||
            it.name == "mergeReleaseJniLibFolders" ||
            it.name == "stripReleaseDebugSymbols"
        }.configureEach {
            dependsOn(pruneTask)
        }
    }

    tasks.matching { it.name == "preReleaseBuild" || it.name == "mergeReleaseNativeLibs" }.configureEach {
        dependsOn(pruneTask)
    }
}

`;

function ensureBlockBeforeAndroid(buildGradle, marker, block) {
  if (buildGradle.includes(marker)) return buildGradle;

  const androidIndex = buildGradle.indexOf('android {');
  if (androidIndex === -1) {
    console.warn(`[withAndroidAbiSplits] Could not find android block for ${marker}`);
    return buildGradle;
  }

  return buildGradle.slice(0, androidIndex) + block + buildGradle.slice(androidIndex);
}

function normalizeAbiSplitInclude(buildGradle) {
  const legacyIncludePattern = new RegExp(
    `include ${defaultAndroidAbis.map((abi) => `"${abi}"`).join(', ')}`,
    'g',
  );

  return buildGradle.replace(
    legacyIncludePattern,
    'include(*resolveAndroidTargetAbis())',
  );
}

function withAndroidAbiSplits(config) {
  return withAppBuildGradle(config, (config) => {
    let buildGradle = config.modResults.contents;

    buildGradle = ensureBlockBeforeAndroid(buildGradle, 'def resolveAndroidTargetAbis', abiResolverBlock);
    buildGradle = ensureBlockBeforeAndroid(buildGradle, 'pruneBareAndroidAddons', bareAddonPruneBlock);
    buildGradle = normalizeAbiSplitInclude(buildGradle);

    if (buildGradle.includes('splits {')) {
      console.log('[withAndroidAbiSplits] ABI splits already configured');
      config.modResults.contents = buildGradle;
      return config;
    }

    const splitsBlock = `    splits {
        abi {
            reset()
            enable true
            include(*resolveAndroidTargetAbis())
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
