import com.android.build.api.artifact.SingleArtifact
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
}

/** Shown in Android's app info, and part of the release APK's file name. */
val appVersion = "0.2.0"

android {
    namespace = "io.github.santoshban.streamora"
    compileSdk = 37

    defaultConfig {
        applicationId = "io.github.santoshban.streamora"
        minSdk = 26
        // 37 would add Android 17's local-network permission, which a LAN client
        // has to ask for before it can do anything. Raise it together with that.
        targetSdk = 36
        // Raise with every release: Android only installs an update with a higher code.
        versionCode = 2
        versionName = appVersion
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Signed with this machine's debug key so the APK can be sideloaded as is
            // (see android/README.md). Updates must be signed with the same key.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
        viewBinding = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_17
    }
}

// assembleRelease also writes android/release/Streamora-<version>.apk, named like
// the desktop installer (desktop/release/Streamora-Setup-<version>.exe).
androidComponents {
    onVariants(selector().withBuildType("release")) { variant ->
        // A plain string, not a lambda: the configuration cache can't store lambdas from this script.
        val apkName = "Streamora-$appVersion.apk"
        val copyApk = tasks.register<Copy>("copyReleaseApk") {
            from(variant.artifacts.get(SingleArtifact.APK)) { include("*.apk") }
            into(rootProject.layout.projectDirectory.dir("release"))
            rename(""".+\.apk""", apkName)
        }
        tasks.matching { it.name == "assembleRelease" }.configureEach { finalizedBy(copyApk) }
    }
}

dependencies {
    implementation(libs.androidx.activity)
    implementation(libs.androidx.core)
    implementation(libs.androidx.lifecycle.runtime)
    implementation(libs.androidx.webkit)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.media3.exoplayer)
    implementation(libs.media3.exoplayer.hls)
    implementation(libs.media3.ui)
    // AC3, E-AC3, DTS and TrueHD audio on phones without those decoders. GPL-3.0.
    implementation(libs.media3.ffmpeg.decoder)

    testImplementation(libs.junit)
}
