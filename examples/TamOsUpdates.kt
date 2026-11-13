/*
 * TAM OS Update Manager — Android/Kotlin reference client.
 *
 * Shows how to:
 *   1. Read vehicles.json / apps.json from GitHub Raw (no token, public repo).
 *   2. Identify the current vehicle and filter COMPATIBLE apps (multi-criteria).
 *   3. Pick the right APK variant per vehicle / chipset / Android version.
 *   4. Compare installed versionCode with the available one.
 *   5. Download the APK from GitHub Releases and verify SHA-256.
 *
 * Dependencies (build.gradle):
 *   implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")
 *   implementation("com.squareup.okhttp3:okhttp:4.12.0")
 *   plugin: kotlin("plugin.serialization")
 *
 * IMPORTANT: never embed a GitHub token. The repo is public; raw JSON and
 * release assets are downloadable anonymously.
 */

package com.tam.updates

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.security.MessageDigest

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
object TamConfig {
    const val OWNER = "talebahmadc-prog"
    const val REPO = "tam-os-updates"
    const val BRANCH = "main"
    const val RAW_BASE = "https://raw.githubusercontent.com/$OWNER/$REPO/$BRANCH"
}

// ---------------------------------------------------------------------------
// Data models (match data/*.json)
// ---------------------------------------------------------------------------
@Serializable
data class VehiclesFile(val schemaVersion: Int, val vehicles: List<Vehicle>)

@Serializable
data class Vehicle(
    val id: String,
    val name: String,
    val brand: String,
    val model: String? = null,
    val androidVersion: Int,
    val hardware: Hardware? = null,
    val tags: List<String> = emptyList()
)

@Serializable
data class Hardware(
    val chipset: String? = null,
    val soc: String? = null,
    val ramMb: Int? = null,
    val screenInches: Double? = null
)

@Serializable
data class AppsFile(val schemaVersion: Int, val apps: List<AppEntry>)

@Serializable
data class AppEntry(
    val id: String,
    val name: String,
    val description: String? = null,
    val packageName: String,
    val category: String,
    val tags: List<String> = emptyList(),
    val enabled: Boolean = true,
    val compatibility: Compatibility = Compatibility(),
    val releases: List<Release> = emptyList()
)

@Serializable
data class Compatibility(
    val allVehicles: Boolean = false,
    val vehicles: List<String> = emptyList(),
    val require: Criteria? = null,
    val prefer: Criteria? = null,
    val exclude: Exclude? = null
)

@Serializable
data class Criteria(
    val chipset: List<String> = emptyList(),
    val minAndroidVersion: Int? = null,
    val tags: List<String> = emptyList()
)

@Serializable
data class Exclude(
    val vehicles: List<String> = emptyList(),
    val tags: List<String> = emptyList()
)

@Serializable
data class Release(
    val variant: String,
    val versionCode: Int,
    val versionName: String,
    val releaseTag: String,
    val apkFileName: String? = null,
    val apkUrl: String,
    val published: Boolean = false,
    val sha256: String = "PENDING",
    val sizeBytes: Long = 0,
    val minAndroidVersion: Int? = null,
    val compatibility: Compatibility? = null,
    val changelog: String? = null,
    val updatedAt: String? = null
)

// ---------------------------------------------------------------------------
// Compatibility engine (the core of the project)
// ---------------------------------------------------------------------------
object Compat {

    private fun matchesCriteria(vehicle: Vehicle, c: Criteria?): Boolean {
        if (c == null) return true
        if (c.chipset.isNotEmpty()) {
            val chip = vehicle.hardware?.chipset ?: return false
            if (chip !in c.chipset) return false
        }
        c.minAndroidVersion?.let { if (vehicle.androidVersion < it) return false }
        if (c.tags.isNotEmpty()) {
            val set = vehicle.tags.toSet()
            if (!c.tags.all { it in set }) return false
        }
        return true
    }

    private fun isExcluded(vehicle: Vehicle, ex: Exclude?): Boolean {
        if (ex == null) return false
        if (vehicle.id in ex.vehicles) return true
        if (ex.tags.isNotEmpty() && ex.tags.any { it in vehicle.tags }) return true
        return false
    }

    /** Multi-criteria compatibility — never a single-tag match. */
    fun isCompatible(app: AppEntry, vehicle: Vehicle): Boolean {
        if (!app.enabled) return false
        val c = app.compatibility
        val gate = c.allVehicles || vehicle.id in c.vehicles
        if (!gate) return false
        if (!matchesCriteria(vehicle, c.require)) return false
        if (isExcluded(vehicle, c.exclude)) return false
        return true
    }

    /** Pick the best APK variant for a vehicle. */
    fun pickRelease(app: AppEntry, vehicle: Vehicle): Release? {
        val candidates = app.releases.filter { r ->
            val rc = r.compatibility
            if (rc != null && rc.vehicles.isNotEmpty() && vehicle.id in rc.vehicles) return@filter true
            matchesCriteria(vehicle, rc?.require)
        }
        if (candidates.isEmpty()) return null
        fun score(r: Release): Long {
            val rc = r.compatibility
            var s = 0L
            if (rc != null && vehicle.id in rc.vehicles) s += 100
            if (rc?.require != null) s += 10
            return s * 1_000_000 + r.versionCode
        }
        return candidates.maxByOrNull { score(it) }
    }

    data class CompatibleApp(val app: AppEntry, val release: Release)

    fun compatibleApps(apps: List<AppEntry>, vehicle: Vehicle): List<CompatibleApp> =
        apps.mapNotNull { app ->
            if (!isCompatible(app, vehicle)) null
            else pickRelease(app, vehicle)?.let { CompatibleApp(app, it) }
        }
}

// ---------------------------------------------------------------------------
// Repository: fetch, cache, update-check, download + verify
// ---------------------------------------------------------------------------
class TamOsRepository(
    private val cacheDir: File,
    private val client: OkHttpClient = OkHttpClient(),
    private val json: Json = Json { ignoreUnknownKeys = true }
) {
    private fun cachedFetch(url: String, cacheName: String): String {
        val cacheFile = File(cacheDir, cacheName)
        val etagFile = File(cacheDir, "$cacheName.etag")
        val builder = Request.Builder().url(url)
        if (cacheFile.exists() && etagFile.exists()) {
            builder.header("If-None-Match", etagFile.readText())
        }
        return try {
            client.newCall(builder.build()).execute().use { resp ->
                when {
                    resp.code == 304 && cacheFile.exists() -> cacheFile.readText()
                    resp.isSuccessful -> {
                        val body = resp.body!!.string()
                        cacheDir.mkdirs()
                        cacheFile.writeText(body)
                        resp.header("ETag")?.let { etagFile.writeText(it) }
                        body
                    }
                    cacheFile.exists() -> cacheFile.readText() // fall back to cache on error
                    else -> error("HTTP ${resp.code} for $url")
                }
            }
        } catch (e: Exception) {
            if (cacheFile.exists()) cacheFile.readText() // offline: serve stale cache
            else throw e
        }
    }

    fun loadVehicles(): List<Vehicle> =
        json.decodeFromString<VehiclesFile>(
            cachedFetch("${TamConfig.RAW_BASE}/data/vehicles.json", "vehicles.json")
        ).vehicles

    fun loadApps(): List<AppEntry> =
        json.decodeFromString<AppsFile>(
            cachedFetch("${TamConfig.RAW_BASE}/data/apps.json", "apps.json")
        ).apps

    /** Represents an available update for an installed app. */
    data class UpdateInfo(
        val app: AppEntry,
        val release: Release,
        val installedVersionCode: Int,
        val isNew: Boolean // true if not installed at all
    )

    /**
     * Compare compatible apps against installed versionCodes.
     * @param installed map of packageName -> installed versionCode (-1 if not installed)
     */
    fun availableUpdates(
        apps: List<AppEntry>,
        vehicle: Vehicle,
        installed: Map<String, Int>
    ): List<UpdateInfo> = Compat.compatibleApps(apps, vehicle).mapNotNull { (app, release) ->
        if (!release.published) return@mapNotNull null // hide not-yet-uploaded APKs
        val current = installed[app.packageName] ?: -1
        when {
            current < 0 -> UpdateInfo(app, release, current, isNew = true)
            release.versionCode > current -> UpdateInfo(app, release, current, isNew = false)
            else -> null
        }
    }

    /** Download an APK and verify its SHA-256 before returning the file. */
    fun downloadAndVerify(release: Release, destDir: File): File {
        require(release.published) { "Release ${release.variant} is not published yet." }
        require(release.sha256.matches(Regex("^[a-f0-9]{64}$"))) {
            "Release ${release.variant} has no valid sha256."
        }
        destDir.mkdirs()
        val out = File(destDir, release.apkFileName ?: "${release.variant}-${release.versionName}.apk")
        client.newCall(Request.Builder().url(release.apkUrl).build()).execute().use { resp ->
            check(resp.isSuccessful) { "Download failed: HTTP ${resp.code}" }
            out.outputStream().use { fos -> resp.body!!.byteStream().copyTo(fos) }
        }
        val actual = sha256(out)
        if (!actual.equals(release.sha256, ignoreCase = true)) {
            out.delete()
            error("SHA-256 mismatch: expected ${release.sha256}, got $actual")
        }
        return out
    }

    private fun sha256(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { ins ->
            val buf = ByteArray(8192); var n: Int
            while (ins.read(buf).also { n = it } > 0) md.update(buf, 0, n)
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }
}

/*
 * Example usage (inside a coroutine / background thread):
 *
 *   val repo = TamOsRepository(cacheDir = context.cacheDir)
 *   val vehicles = repo.loadVehicles()
 *   val vehicle = vehicles.first { it.id == currentVehicleId }   // detected on device
 *   val apps = repo.loadApps()
 *
 *   val compatible = Compat.compatibleApps(apps, vehicle)        // show these in the UI
 *
 *   val installed = packageManager.getInstalledPackages(0)
 *       .associate { it.packageName to it.versionCode }
 *   val updates = repo.availableUpdates(apps, vehicle, installed)
 *
 *   for (u in updates) {
 *       val apk = repo.downloadAndVerify(u.release, context.getExternalFilesDir("apk")!!)
 *       // launch the Android package installer intent for `apk`
 *   }
 */
