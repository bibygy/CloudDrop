plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val persistentKeystore = file("clouddrop-signing.jks")
val hasPersistentKeystore = persistentKeystore.exists()
val ksPassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")?.ifBlank { null } ?: "clouddrop"
val ksAlias = System.getenv("ANDROID_KEY_ALIAS")?.ifBlank { null } ?: "clouddrop"
val ksKeyPassword = System.getenv("ANDROID_KEY_PASSWORD")?.ifBlank { null } ?: ksPassword
val ciVersionCode = System.getenv("ANDROID_VERSION_CODE")?.toIntOrNull() ?: 1

android {
    namespace = "com.clouddrop.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.clouddrop.app"
        minSdk = 26
        targetSdk = 35
        versionCode = ciVersionCode
        versionName = "0.1.$ciVersionCode"
    }

    signingConfigs {
        if (hasPersistentKeystore) {
            create("persistent") {
                storeFile = persistentKeystore
                storePassword = ksPassword
                keyAlias = ksAlias
                keyPassword = ksKeyPassword
            }
        }
    }

    buildTypes {
        debug {
            if (hasPersistentKeystore) {
                signingConfig = signingConfigs.getByName("persistent")
            }
        }
        release {
            isMinifyEnabled = false
            if (hasPersistentKeystore) {
                signingConfig = signingConfigs.getByName("persistent")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

val syncWebAssets = tasks.register<Sync>("syncWebAssets") {
    val webDir = rootProject.layout.projectDirectory.dir("../../web").asFile
    onlyIf { webDir.exists() }
    from(webDir)
    into(layout.projectDirectory.dir("src/main/assets"))
}

tasks.named("preBuild") {
    dependsOn(syncWebAssets)
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.activity:activity-ktx:1.9.3")
}
