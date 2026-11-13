plugins {
    `java-library`
    kotlin("jvm") version "2.2.10"
}

// Build logic only: the tasks both app modules wire into their Rust engine variants.
dependencies {
    implementation(gradleApi())
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}
