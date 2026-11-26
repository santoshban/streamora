plugins {
    alias(libs.plugins.android.application) apply false
    // Not applied anywhere: it only pins the Kotlin version of AGP's built-in Kotlin support.
    alias(libs.plugins.kotlin.android) apply false
}
