plugins {
    id("com.android.application") version "8.13.2" apply false
    // Kotlin 2.x ships the Compose compiler as a Gradle plugin; it must match the Kotlin version.
    id("org.jetbrains.kotlin.android") version "2.2.21" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.2.21" apply false
}

// Optional: -Pbeacon.buildRoot=/tmp/beacon-gradle puts build output on another disk.
// Needed when the repo lives on an exFAT drive: macOS adds ._ AppleDouble files there,
// and Gradle then fails to clean its own output directories.
providers.gradleProperty("beacon.buildRoot").orNull?.let { root ->
    allprojects { layout.buildDirectory.set(file("$root/${project.name}")) }
}
