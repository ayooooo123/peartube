package peartube.buildlogic

import org.gradle.api.Project

/**
 * The Gradle property only android/release.sh and android/release-tv.sh pass. Without it no build reads a signing
 * password: `releaseSigning()` returns null before touching gradle properties or the Keychain, and a release
 * build comes out unsigned (check-signer.sh refuses it).
 */
const val SIGN_RELEASE_PROPERTY = "peartube.signRelease"

/** The macOS login Keychain service that holds the release key passwords (generic passwords). */
const val KEYCHAIN_SERVICE = "peartube-release"

class ReleaseSigning(val keystore: String, val keyAlias: String, val storePassword: String, val keyPassword: String)

/**
 * The release key both apps sign with, or null when [SIGN_RELEASE_PROPERTY] is absent, `peartube.dev`
 * is present, or this machine cannot sign releases. The gate prevents password reads for other builds.
 * The keystore path and alias come from gradle properties (`peartube.keystore`, `peartube.keyAlias`, kept in
 * ~/.gradle/gradle.properties). Each password comes from its gradle property (`peartube.keystorePassword`,
 * `peartube.keyPassword`) when set, else from the login Keychain: service [KEYCHAIN_SERVICE], account
 * `keystorePassword` or `keyPassword`. Passwords are never logged; `security` output is captured, not printed.
 */
fun Project.releaseSigning(): ReleaseSigning? {
    if (providers.gradleProperty(SIGN_RELEASE_PROPERTY).orNull == null) return null
    if (providers.gradleProperty("peartube.dev").isPresent) return null

    fun property(name: String) = providers.gradleProperty("peartube.$name").orNull
    val keystore = property("keystore") ?: return null
    val keyAlias = property("keyAlias") ?: return null
    val storePassword = property("keystorePassword") ?: keychainPassword("keystorePassword") ?: return null
    val keyPassword = property("keyPassword") ?: keychainPassword("keyPassword") ?: return null
    return ReleaseSigning(keystore, keyAlias, storePassword, keyPassword)
}

private fun Project.keychainPassword(account: String): String? {
    if (!System.getProperty("os.name").startsWith("Mac")) return null
    val found = providers.exec { spec ->
        spec.commandLine("security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w")
        spec.isIgnoreExitValue = true
    }
    if (found.result.get().exitValue != 0) return null
    return found.standardOutput.asText.get().removeSuffix("\n")
}
