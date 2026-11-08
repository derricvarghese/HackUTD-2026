plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.beacon.mesh"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.beacon.mesh"
        minSdk = 26
        targetSdk = 36
        versionCode = 3
        versionName = "0.3"
        // Server this build uploads to. Override for local dev: ./gradlew -Pbeacon.backendUrl=https://host
        val backendUrl = (project.findProperty("beacon.backendUrl") as String?) ?: "https://hackutd.alecj.com"
        buildConfigField("String", "BACKEND_URL", "\"$backendUrl\"")
        // Build-time fallback backend public keys (base64 SPKI) so a phone that has NEVER been online can still
        // encrypt SOS payloads. Public halves only: ./gradlew -Pbeacon.encPublicKey=... -Pbeacon.signPublicKey=...
        val encPub = (project.findProperty("beacon.encPublicKey") as String?)?.trim() ?: ""
        val signPub = (project.findProperty("beacon.signPublicKey") as String?)?.trim() ?: ""
        buildConfigField("String", "BACKEND_ENC_PUBLIC_KEY", "\"$encPub\"")
        buildConfigField("String", "BACKEND_SIGN_PUBLIC_KEY", "\"$signPub\"")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    testOptions {
        unitTests.isReturnDefaultValues = true
        // Robolectric needs merged resources/manifest to run Compose UI tests on the JVM.
        unitTests.isIncludeAndroidResources = true
    }
    lint {
        // Keep the report readable: only fail on real errors.
        abortOnError = true
        warningsAsErrors = false
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        // Material 3 Expressive APIs (ButtonGroup, FloatingToolbar, LoadingIndicator, wavy progress,
        // MotionScheme.expressive, ...) are annotated experimental in material3 1.5 alphas.
        optIn.addAll(
            "androidx.compose.material3.ExperimentalMaterial3ExpressiveApi",
            "androidx.compose.material3.ExperimentalMaterial3Api",
            "androidx.compose.material3.adaptive.ExperimentalMaterial3AdaptiveApi",
            "androidx.compose.animation.ExperimentalSharedTransitionApi",
        )
    }
}

dependencies {
    // Compose BOM pins every androidx.compose.* artifact to one tested set of versions
    // (2025.10.01 -> material3 1.4.0, which contains the Expressive APIs; newer BOMs need AGP 9.1 + compileSdk 37).
    val composeBom = platform("androidx.compose:compose-bom:2026.03.01")
    implementation(composeBom)
    androidTestImplementation(composeBom)

    // Compose UI + foundation + Material 3 (MaterialExpressiveTheme, ButtonGroup, FloatingToolbar, ...).
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3:1.5.0-alpha14")
    // Material icon vectors used by the nav bar, chips and buttons.
    implementation("androidx.compose.material:material-icons-extended")
    // WindowSizeClass breakpoints for compact / medium / expanded layouts.
    implementation("androidx.compose.material3:material3-window-size-class")
    // Shape morphing (Morph, RoundedPolygon) used with MaterialShapes for expressive badges.
    implementation("androidx.graphics:graphics-shapes:1.1.0")
    // currentWindowAdaptiveInfo(), ListDetailPaneScaffold (list-detail with built-in predictive back).
    implementation("androidx.compose.material3.adaptive:adaptive")
    implementation("androidx.compose.material3.adaptive:adaptive-layout")
    implementation("androidx.compose.material3.adaptive:adaptive-navigation")
    debugImplementation("androidx.compose.ui:ui-tooling")

    // ComponentActivity + setContent, enableEdgeToEdge, predictive back handlers.
    implementation("androidx.activity:activity-compose:1.11.0")
    // Navigation Compose: back stack with predictive-back-aware transitions.
    implementation("androidx.navigation:navigation-compose:2.9.5")
    // ViewModel + collectAsStateWithLifecycle (lifecycle-aware StateFlow collection).
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.4")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.4")
    // Kotlin extensions + NotificationCompat for the foreground service notification.
    implementation("androidx.core:core-ktx:1.17.0")
    // Splash Screen API with backport to API 26.
    implementation("androidx.core:core-splashscreen:1.2.0")

    testImplementation("junit:junit:4.13.2")
    // Android's org.json is a stub in JVM unit tests; use the real one there.
    testImplementation("org.json:json:20240303")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
    // Compose UI tests on the JVM (createComposeRule + Robolectric), no device needed.
    testImplementation("org.robolectric:robolectric:4.16")
    testImplementation("androidx.compose.ui:ui-test-junit4")
    testImplementation("androidx.test.ext:junit:1.3.0")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
