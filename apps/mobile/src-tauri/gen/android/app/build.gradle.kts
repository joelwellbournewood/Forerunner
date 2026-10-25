import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Release signing (docs/maintainers/release.md, "Signing"). scripts/android-keystore.mjs writes
// keystore.properties into the Android project root (gen/android, gitignored) with storeFile,
// keyAlias, storePassword and keyPassword: the release key decoded from the CI secret, or a
// generated development key. The file is optional so a checkout without it still configures;
// then the release APK is left unsigned and CI's scripts/android-apk-verify.mjs fails the job.
val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.exists()) {
        keystorePropertiesFile.inputStream().use { load(it) }
    }
}
val hasReleaseKeystore = keystorePropertiesFile.exists()

fun keystoreProperty(name: String): String =
    keystoreProperties.getProperty(name) ?: error(
        "${keystorePropertiesFile.path}: '$name' is missing (the file is written by scripts/android-keystore.mjs)"
    )

// Push (ADR 0085 point 9, docs/maintainers/apps.md "Android push"). Firebase Cloud Messaging is
// wired only when google-services.json is in this module: scripts/android-google-services.mjs
// writes it (gitignored) from the GOOGLE_SERVICES_JSON_BASE64 secret, or a maintainer copies it
// from the Firebase console. Then the firebase-messaging dependency, the src/fcm sources and
// manifest (FirebaseMessagingService, token startup, POST_NOTIFICATIONS) and the Google services
// plugin are added and BuildConfig.FCM_CONFIGURED is true. Without it the build is exactly the
// polling stand-in it was. -PforerunnerFcmCompileCheck=true compiles src/fcm with the dependency
// but without the file or the plugin (CI's check that the FCM code still builds); such an APK
// has no Firebase configuration and stays polling.
val googleServicesFile = file("google-services.json")
val hasGoogleServices = googleServicesFile.exists()
val fcmCompileCheck = providers.gradleProperty("forerunnerFcmCompileCheck").orNull == "true"
val withFcmSources = hasGoogleServices || fcmCompileCheck
if (hasGoogleServices) {
    logger.lifecycle("google-services.json found: FCM push is built in (ADR 0085)")
} else {
    logger.lifecycle(
        "google-services.json not found: push stays the polling stand-in. Run `node scripts/android-google-services.mjs` with GOOGLE_SERVICES_JSON_BASE64 set to build it in."
    )
}

android {
    compileSdk = 37
    namespace = "app.forerunner.mobile"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "app.forerunner.mobile"
        minSdk = 29
        targetSdk = 37
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
        buildConfigField("boolean", "FCM_CONFIGURED", hasGoogleServices.toString())
    }
    if (withFcmSources) {
        sourceSets.getByName("main").java.srcDir("src/fcm/java")
        // A build-type manifest is merged over main; there is no src/debug or src/release here.
        for (buildType in listOf("debug", "release")) {
            sourceSets.getByName(buildType).manifest.srcFile("src/fcm/AndroidManifest.xml")
        }
    }
    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                storeFile = rootProject.file(keystoreProperty("storeFile"))
                storePassword = keystoreProperty("storePassword")
                keyAlias = keystoreProperty("keyAlias")
                keyPassword = keystoreProperty("keyPassword")
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            if (hasReleaseKeystore) {
                signingConfig = signingConfigs.getByName("release")
            } else {
                logger.warn(
                    "${keystorePropertiesFile.path} not found: the release APK will be unsigned and cannot be installed. Run `node scripts/android-keystore.mjs` first."
                )
            }
            optimization {
               enable = true
            }
            proguardFiles(
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    if (withFcmSources) {
        implementation("com.google.firebase:firebase-messaging:25.1.3")
    }
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = file("tauri.build.gradle.kts"))

if (hasGoogleServices) {
    // Reads google-services.json and generates the Firebase resources (project, app id, key).
    apply(plugin = "com.google.gms.google-services")
}
