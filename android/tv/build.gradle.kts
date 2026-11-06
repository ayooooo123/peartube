import javax.inject.Inject

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Standalone Dumb TV Receiver APK (`com.peartube.receiver`): ships only the 10-foot idle QR screen,
// native libpeartube.so video player, and headless P2P/private-P2P receiver worklet — zero library,
// channels, search, CameraX, or phone settings UI.
val checkout: File = rootDir.parentFile
val worklet = File(checkout, "worklet")
val appVersion = (groovy.json.JsonSlurper().parseText(File(checkout, "package.json").readText()) as Map<*, *>)["version"] as String

abstract class TvWorkletTask @Inject constructor(private val exec: ExecOperations) : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val sources: ConfigurableFileCollection

    @get:Internal
    abstract val repo: DirectoryProperty

    @get:OutputDirectory
    abstract val assetsDir: DirectoryProperty

    @get:OutputDirectory
    abstract val libsDir: DirectoryProperty

    @TaskAction
    fun run() {
        exec.exec {
            workingDir = repo.get().asFile
            commandLine("node", "android/worklet.mjs", assetsDir.get().asFile.path, libsDir.get().asFile.path, temporaryDir.path, "v8")
        }
    }
}

val workletTask = tasks.register<TvWorkletTask>("worklet") {
    repo.set(checkout)
    sources.from(
        File(checkout, "android/worklet.mjs"),
        File(worklet, "worker.js"), File(worklet, "build.mjs"), File(worklet, "pack.cjs"), File(worklet, "imports.json"), fileTree(File(worklet, "crypto")),
        fileTree(File(worklet, "vendor/bare-kit/android-v8/arm64-v8a")),
        fileTree(File(checkout, "src")), File(checkout, "package.json"), File(checkout, "package-lock.json"),
    )
    assetsDir.set(layout.buildDirectory.dir("worklet/assets"))
    libsDir.set(layout.buildDirectory.dir("worklet/jniLibs"))
}

abstract class TvCargoTask @Inject constructor(private val exec: ExecOperations) : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val sources: ConfigurableFileCollection

    @get:Input
    abstract val profile: Property<String>

    @get:Internal
    abstract val crate: DirectoryProperty

    @get:Internal
    abstract val ndk: DirectoryProperty

    @get:OutputDirectory
    abstract val libsDir: DirectoryProperty

    @TaskAction
    fun run() {
        val bin = ndk.get().asFile.resolve("toolchains/llvm/prebuilt").listFiles()!!.single().resolve("bin")
        val clang = bin.resolve("aarch64-linux-android29-clang").path
        val cargo = File(System.getProperty("user.home"), ".cargo/bin/cargo").takeIf { it.exists() }?.path ?: "cargo"
        val manifest = crate.get().asFile.resolve("Cargo.toml")
        exec.exec {
            commandLine(cargo, "build", "--manifest-path", manifest.path, "--target", "aarch64-linux-android", "--profile", profile.get())
            environment("CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER", clang)
            environment("CC_aarch64_linux_android", clang)
            environment("CXX_aarch64_linux_android", "$clang++")
            environment("AR_aarch64_linux_android", bin.resolve("llvm-ar").path)
            val home = System.getProperty("user.home")
            environment("CARGO_ENCODED_RUSTFLAGS", listOf("-Clink-arg=-Wl,-z,max-page-size=16384", "--remap-path-prefix=$home=~").joinToString("\u001f"))
        }
        val built = crate.get().asFile.resolve("target/aarch64-linux-android/${if (profile.get() == "dev") "debug" else "release"}/libpeartube.so")
        val out = libsDir.get().asFile.resolve("arm64-v8a").apply { deleteRecursively(); mkdirs() }
        built.copyTo(out.resolve("libpeartube.so"))
    }
}

val nativeCrate = File(checkout, "android/native")
val signing = listOf("keystore", "keystorePassword", "keyAlias", "keyPassword")
    .associateWith { providers.gradleProperty("peartube.$it").orNull }

android {
    namespace = "com.peartube.receiver"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.peartube.receiver"
        minSdk = 29
        targetSdk = 34
        val (major, minor, patch) = appVersion.split(".").map { it.toInt() }
        versionCode = major * 10_000 + minor * 100 + patch
        versionName = appVersion
        ndk { abiFilters += "arm64-v8a" }
    }
    ndkVersion = "29.0.14206865"

    sourceSets {
        getByName("main") {
            java.srcDirs("src/main/kotlin", "../app/src/main/java", "../app/src/main/kotlin/com/peartube/app/player", "../app/src/main/kotlin/com/peartube/shared")
            res.srcDirs("src/main/res", "../app/src/main/res")
        }
    }

    signingConfigs {
        if (signing.values.all { it != null }) {
            create("release") {
                storeFile = file(signing.getValue("keystore")!!)
                storePassword = signing.getValue("keystorePassword")
                keyAlias = signing.getValue("keyAlias")
                keyPassword = signing.getValue("keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".dev"
            versionNameSuffix = "-dev"
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release")
            if (providers.gradleProperty("peartube.dev").isPresent) {
                applicationIdSuffix = ".dev"
                versionNameSuffix = "-dev"
                signingConfig = signingConfigs.getByName("debug")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
    }

    packaging {
        jniLibs.useLegacyPackaging = false
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(workletTask, TvWorkletTask::assetsDir)
        variant.sources.jniLibs?.addGeneratedSourceDirectory(workletTask, TvWorkletTask::libsDir)
        val cargo = tasks.register<TvCargoTask>("cargo${variant.name.replaceFirstChar { it.uppercase() }}") {
            crate.set(nativeCrate)
            sources.from(fileTree(nativeCrate.resolve("src")), nativeCrate.resolve("Cargo.toml"), nativeCrate.resolve("Cargo.lock"), checkout.parentFile.resolve("peartube-media/crates").takeIf { it.isDirectory }?.let { fileTree(it) } ?: files())
            profile.set(if (variant.buildType == "release") "release" else "dev")
            ndk.set(androidComponents.sdkComponents.ndkDirectory)
            libsDir.set(layout.buildDirectory.dir("cargo/${variant.name}"))
        }
        variant.sources.jniLibs?.addGeneratedSourceDirectory(cargo, TvCargoTask::libsDir)
    }
}

dependencies {
    val compose = platform("androidx.compose:compose-bom:2025.08.01")
    implementation(compose)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.lifecycle:lifecycle-process:2.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.3")
    implementation("com.google.zxing:core:3.5.3")
}
