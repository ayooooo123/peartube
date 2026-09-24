import groovy.json.JsonSlurper
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// One version for the relay and the app: the root package.json.
@Suppress("UNCHECKED_CAST")
val appVersion = (JsonSlurper().parse(rootDir.resolve("../package.json")) as Map<String, Any>)["version"] as String
val (major, minor, patch) = appVersion.split(".").map { it.toInt() }

// Release signing lives outside the repo, in ~/.gradle/gradle.properties.
val keystore = providers.gradleProperty("peartube.keystore").orNull

android {
    namespace = "com.peartube.client"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.peartube.client"
        minSdk = 26
        targetSdk = 36
        versionCode = major * 10000 + minor * 100 + patch
        versionName = appVersion
    }

    signingConfigs {
        if (keystore != null) {
            create("release") {
                storeFile = file(keystore)
                storePassword = providers.gradleProperty("peartube.keystorePassword").get()
                keyAlias = providers.gradleProperty("peartube.keyAlias").get()
                keyPassword = providers.gradleProperty("peartube.keyPassword").get()
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release")
        }
    }

    // libVLC is native code: one APK per ABI keeps each download small.
    splits {
        abi {
            isEnable = true
            reset()
            include("arm64-v8a", "armeabi-v7a", "x86_64")
            isUniversalApk = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    implementation("org.videolan.android:libvlc-all:3.7.6")
}
