plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.beacon.mesh"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.beacon.mesh"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    // No runtime dependencies on purpose: platform BLE + org.json + SQLite only.
    testImplementation("junit:junit:4.13.2")
    // Android's org.json is a stub in JVM unit tests; use the real one there.
    testImplementation("org.json:json:20240303")
}
