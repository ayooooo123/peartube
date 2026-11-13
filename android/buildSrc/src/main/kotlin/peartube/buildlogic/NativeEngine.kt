package peartube.buildlogic

import groovy.json.JsonSlurper
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.Project
import org.gradle.api.file.Directory
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.Property
import org.gradle.api.provider.Provider
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputFile
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction
import org.gradle.api.tasks.TaskProvider
import org.gradle.process.ExecOperations
import java.io.File
import javax.inject.Inject

/**
 * The Rust engine's libraries for one app variant: the pinned peartube-native release (or a local
 * checkout), libpeartube_jni.so built from android/jni/peartube_jni.c, and libc++_shared.so.
 * A debug variant links the release's dev-profile asset so it never carries a release-speed engine.
 */
abstract class NativeEngineTask @Inject constructor(private val exec: ExecOperations) : DefaultTask() {
    @get:InputFile
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val script: RegularFileProperty

    @get:InputFile
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val lock: RegularFileProperty

    @get:InputFile
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val jni: RegularFileProperty

    /** A peartube-native checkout to build locally; empty fetches the pinned release. */
    @get:Input
    abstract val local: Property<String>

    /** The native.lock asset key this variant links. */
    @get:Input
    abstract val asset: Property<String>

    /** The asset's published file name, renamed to libpeartube_native_ffi.so for the app. */
    @get:Input
    abstract val library: Property<String>

    @get:Input
    abstract val header: Property<String>

    @get:Internal
    abstract val repo: DirectoryProperty

    @get:Internal
    abstract val ndk: DirectoryProperty

    @get:OutputDirectory
    abstract val libsDir: DirectoryProperty

    @get:OutputDirectory
    abstract val fetchDir: DirectoryProperty

    @TaskAction
    fun run() {
        // A pinned engine must match this checkout's engine contract; a local checkout is the developer's call.
        if (local.get().isEmpty()) {
            exec.exec {
                it.workingDir = repo.get().asFile
                it.commandLine("python3", script.get().asFile.path, "check", "--strict")
            }
        }
        val fetched = fetchDir.get().asFile.apply { deleteRecursively(); mkdirs() }
        val out = libsDir.get().asFile.resolve("arm64-v8a").apply { deleteRecursively(); mkdirs() }
        exec.exec {
            it.workingDir = repo.get().asFile
            it.commandLine(
                buildList {
                    add("python3"); add(script.get().asFile.path); add("fetch")
                    if (local.get().isNotEmpty()) { add("--local"); add(local.get()) }
                    add(asset.get()); add("header"); add(fetched.path)
                },
            )
            // ffi/build.sh reads the NDK from this; the module's is the one Gradle resolved.
            it.environment("ANDROID_NDK_HOME", ndk.get().asFile.path)
        }
        val prefix = ndk.get().asFile.resolve("toolchains/llvm/prebuilt").listFiles()!!.single()
        val bin = prefix.resolve("bin")
        val clang = bin.resolve("aarch64-linux-android29-clang").path
        if (!fetched.resolve(header.get()).isFile) {
            throw GradleException("sync-native.py did not fetch ${header.get()}")
        }
        // The release's names become the ones the linker and System.loadLibrary() use.
        val link = fetched.resolve("link").apply { mkdirs() }
        fetched.resolve(library.get()).copyTo(link.resolve("libpeartube_native_ffi.so"), overwrite = true)
        prefix.resolve("sysroot/usr/lib/aarch64-linux-android/libc++_shared.so")
            .copyTo(out.resolve("libc++_shared.so"), overwrite = true)
        exec.exec {
            it.commandLine(
                clang, "-shared", "-fPIC", "-O2", "-Wall", "-Werror",
                "-o", out.resolve("libpeartube_jni.so").path, jni.get().asFile.path,
                "-I${fetched.path}", "-L${link.path}", "-lpeartube_native_ffi",
                "-Wl,-rpath-link,${link.path}", "-Wl,-z,max-page-size=16384",
            )
        }
        link.resolve("libpeartube_native_ffi.so").copyTo(out.resolve("libpeartube_native_ffi.so"), overwrite = true)
    }
}

/**
 * Registers the Rust engine's task for one variant: a debug build links native.lock's
 * `android-arm64-dev` asset (dev cargo profile), every other build type `android-arm64`.
 * The module wires the returned task's [NativeEngineTask.libsDir] into its jniLibs sources.
 */
fun Project.registerNativeEngine(variant: String, buildType: String?, local: String?, ndk: Provider<Directory>): TaskProvider<NativeEngineTask> {
    val checkout = rootDir.parentFile
    val lockFile = File(checkout, "native.lock")
    val assets = (JsonSlurper().parseText(lockFile.readText()) as Map<*, *>)["assets"] as Map<*, *>
    fun assetFile(key: String): String =
        (assets[key] as Map<*, *>?)?.get("file") as String? ?: throw GradleException("native.lock has no asset '$key'")
    val asset = if (buildType == "debug") "android-arm64-dev" else "android-arm64"
    return tasks.register("native${variant.replaceFirstChar { it.uppercase() }}", NativeEngineTask::class.java) {
        it.script.set(File(checkout, "sync-native.py"))
        it.lock.set(lockFile)
        it.jni.set(File(checkout, "android/jni/peartube_jni.c"))
        it.local.set(local ?: "")
        it.asset.set(asset)
        it.library.set(assetFile(asset))
        it.header.set(assetFile("header"))
        it.repo.set(checkout)
        it.ndk.set(ndk)
        it.libsDir.set(layout.buildDirectory.dir("native/$variant"))
        it.fetchDir.set(layout.buildDirectory.dir("native-fetch/$variant"))
        // Runs every build: the contract check reads the app's sources, and a local checkout changes
        // without its path changing. Pinned files come from the download cache, so this costs seconds.
        it.outputs.upToDateWhen { false }
    }
}
