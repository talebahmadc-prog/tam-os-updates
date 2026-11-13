# TAM OS Updates

A central, public **GitHub-based update system** for Android apps running on vehicle head units (TAM OS).
It is a single source of truth that update clients installed on vehicles query to discover which apps are
**compatible** with the current vehicle, check for **new versions**, and download **APK** files.

The system is designed to scale to **hundreds of apps** and **dozens of vehicle types** — not only NETA vehicles.

- **Repository:** `talebahmadc-prog/tam-os-updates` (public)
- **JSON data** is read over **GitHub Raw**.
- **APK files** are hosted as **GitHub Release assets** (never committed to git).
- **No GitHub token is ever stored in the Android app** — everything is public and anonymous.

---

## Repository structure

```
tam-os-updates/
├── config.json                 # Owner/repo, base URLs, cache policy
├── data/
│   ├── apps.json               # All apps (each registered once) + compatibility + releases
│   ├── vehicles.json           # Supported vehicles and their hardware/tags
│   └── categories.json         # App categories
├── releases/
│   └── release-index.json      # Index of GitHub Releases and their APK assets
├── schema/
│   ├── app.schema.json         # JSON Schema for apps.json
│   ├── vehicle.schema.json     # JSON Schema for vehicles.json
│   ├── release.schema.json     # JSON Schema for release-index.json
│   └── category.schema.json    # JSON Schema for categories.json
├── admin/
│   └── index.html              # Web UI: set which vehicles each app opens on
├── tools/
│   ├── validate.mjs            # Validate JSON + release links (Node)
│   ├── compat.mjs              # Compatibility engine + CLI (Node)
│   └── set-owner.mjs           # Rename owner/repo across all files
├── examples/
│   └── TamOsUpdates.kt         # Android/Kotlin reference client
└── README.md
```

> **APKs are never put in regular git.** Only JSON lives in the repo; binaries are Release Assets.

### Admin backend (multi-user) — `server/`

A Cloudflare Worker + D1 backend where **multiple users sign in with username/password**
to upload apps and define vehicles:
- Roles: **admin** (manages users + everything) and **uploader** (uploads apps, defines vehicles).
- A single **GitHub token lives as a Cloudflare secret** (never in the browser or the Android app);
  the Worker commits the JSON and uploads APKs to Releases on the users' behalf.

See [`server/README.md`](server/README.md) for the full deploy guide (token, D1, first admin, deploy)
and the one-time `D:\Apps` importer.

---

## Base URLs (real examples)

Read JSON over Raw:

```
https://raw.githubusercontent.com/talebahmadc-prog/tam-os-updates/main/data/apps.json
https://raw.githubusercontent.com/talebahmadc-prog/tam-os-updates/main/data/vehicles.json
https://raw.githubusercontent.com/talebahmadc-prog/tam-os-updates/main/data/categories.json
https://raw.githubusercontent.com/talebahmadc-prog/tam-os-updates/main/releases/release-index.json
```

Download an APK from a Release:

```
https://github.com/talebahmadc-prog/tam-os-updates/releases/download/neta-u-2026-11-1/tam-youtube-1.5.0.apk
```

---

## Data model

### `apps.json` — each app is registered **once**

An app has identity + metadata + a compatibility block + one or more **releases** (APK variants). This lets a
single app ship **different APKs per vehicle / chipset / Android version**.

```jsonc
{
  "id": "youtube",
  "name": "TAM YouTube",
  "packageName": "com.tam.youtube",
  "category": "media",
  "tags": ["media", "video"],
  "enabled": true,
  "compatibility": {
    "allVehicles": false,            // true = opens on every TAM OS vehicle
    "vehicles": ["neta-u", "neta-x", "byd-han"],  // used when allVehicles=false
    "require": { "minAndroidVersion": 10 },       // mandatory, ALL must match
    "prefer": { "tags": ["sa8295"] },             // optional, affects ranking only
    "exclude": { "vehicles": [], "tags": [] }     // hard exclusions
  },
  "releases": [
    {
      "variant": "neta-u",
      "versionCode": 5,
      "versionName": "1.5.0",
      "releaseTag": "neta-u-2026-11-1",
      "apkFileName": "tam-youtube-1.5.0.apk",
      "apkUrl": "https://github.com/talebahmadc-prog/tam-os-updates/releases/download/neta-u-2026-11-1/tam-youtube-1.5.0.apk",
      "published": false,             // false until the APK is actually uploaded
      "sha256": "PENDING",            // 64-hex when published
      "sizeBytes": 0,
      "minAndroidVersion": 10,
      "compatibility": { "vehicles": ["neta-u", "neta-x"] },
      "changelog": "Performance improvements",
      "updatedAt": "2026-11-13"
    }
  ]
}
```

> `published: false`, `sha256: "PENDING"` and `sizeBytes: 0` mark **placeholder** releases whose APK has not
> been uploaded yet. Clients hide these from the user. Fill them in when you publish the real file.

### `vehicles.json`

```jsonc
{
  "id": "neta-u",
  "name": "NETA U",
  "brand": "NETA",
  "model": "U / U-II",
  "androidVersion": 10,
  "hardware": { "chipset": "sa8155", "soc": "Qualcomm SA8155P", "ramMb": 4096, "screenInches": 15.6 },
  "tags": ["neta-u", "neta", "qualcomm", "sa8155", "android-10", "tam-os"]
}
```

The client reads the current vehicle, then filters apps using the vehicle's `id`, `hardware.chipset`,
`androidVersion` and `tags`.

### `categories.json`

Simple list of `{ id, name, description, icon }`.

### `releases/release-index.json`

A convenience index mapping each **Release tag** to its APK assets (one Release may hold several APKs).
Validated against `apps.json` so URLs stay consistent.

---

## Compatibility rules (the core)

Compatibility is **multi-criteria** — an app is **never** shown just because one tag matched. For a given
vehicle, an app is compatible when **all** of these hold:

1. `app.enabled == true`.
2. **Vehicle gate:** `compatibility.allVehicles == true`, **or** the vehicle `id` is in `compatibility.vehicles`.
3. **Mandatory `require`** — every present rule passes:
   - `chipset`: `vehicle.hardware.chipset` is in the list.
   - `minAndroidVersion`: `vehicle.androidVersion >= value`.
   - `tags`: the vehicle has **all** listed tags.
4. **`exclude`** does not match (vehicle id or any tag).

`prefer` never filters — it only ranks. Then the client picks the best **release** for the vehicle:
a release that explicitly lists the vehicle wins over one matched by rules, which wins over a generic release;
ties break on the highest `versionCode`.

Try it:

```bash
node tools/compat.mjs neta-u
node tools/compat.mjs neta-x
```

---

## The admin page (`admin/`)

A static, token-free web UI to decide **whether an app opens on all vehicles or on specific vehicles**:

- Select an app → choose **All TAM OS vehicles** or **Specific vehicles only** (checkboxes).
- Add mandatory requirements (chipset / min Android / required tags).
- See a **live preview** of exactly which vehicles the app opens on and which APK variant each gets.
- A **compatibility matrix** (apps × vehicles).
- Click **Download apps.json** and commit the file to publish. *Nothing is written to GitHub directly, so no token is needed.*

Open it locally with any static server, or publish it via **GitHub Pages** (Settings → Pages → `main` / root),
then visit `https://talebahmadc-prog.github.io/tam-os-updates/admin/`.

---

## How to… (maintainer guide)

### Add a new vehicle
1. Add an object to `data/vehicles.json` with a unique `id`, plus `name`, `brand`, `androidVersion`,
   `hardware.chipset`, and `tags`.
2. Run `node tools/validate.mjs`.
3. Commit. **No change to the update app is required** — it picks up new vehicles automatically.

### Add a new app
1. Add one object to `data/apps.json` (register the app **once**) with a unique `id` and `packageName`.
2. Set `compatibility` (all vehicles or specific) and add at least one `release`.
3. Run `node tools/validate.mjs` and commit.

### Link an app to several vehicles
Set `compatibility.vehicles` (e.g. `["neta-u", "neta-x", "byd-han"]`) or `allVehicles: true`.
Use `require.tags`/`require.chipset` for broad, rule-based targeting (e.g. every `tam-os` vehicle).

### Publish a new version / release
1. Create a **GitHub Release** with a stable tag, e.g. `neta-u-2026-11-1` (one Release may hold several APKs).
2. Upload the APK(s) as **Release assets**.
3. Compute the checksum:
   ```bash
   sha256sum tam-youtube-1.5.0.apk          # Linux/macOS
   CertUtil -hashfile tam-youtube-1.5.0.apk SHA256   # Windows
   ```
4. In `data/apps.json`, add/update the matching `release`: set `versionCode`, `versionName`, `releaseTag`,
   `apkUrl`, `sha256`, `sizeBytes`, and `published: true`. Mirror it in `releases/release-index.json`.
5. `node tools/validate.mjs --check-urls` then commit.

### Provide a different APK per vehicle / chipset
Add multiple entries to the app's `releases[]`, each with its own `compatibility` (e.g. `vehicles: ["neta-x"]`
or `require.chipset: ["sa8295"]`). The client auto-selects the best one per vehicle.

### Temporarily disable an app
Set `"enabled": false`. It disappears from every vehicle until re-enabled.

---

## Validation

```bash
node tools/validate.mjs              # structure + cross-references (ids, categories, vehicles, tags)
node tools/validate.mjs --check-urls # also HTTP-check PUBLISHED APK URLs
node tools/validate.mjs --strict     # treat warnings as errors
```

Checks performed: valid JSON, no duplicate app ids / packageNames, category & vehicle references exist,
kebab-case ids, Android package-name format, `sha256` is 64-hex or `PENDING`, `apkUrl` is https and listed in
the release index, and `published` releases have a real checksum.

Formal JSON Schemas are in `schema/` for use with any validator (e.g. [ajv](https://ajv.js.org/)):

```bash
npx ajv-cli validate -s schema/app.schema.json -d data/apps.json --spec=draft2020
```

---

## Android client flow

1. Read current vehicle info on the device.
2. Download `vehicles.json`, `apps.json` (GitHub Raw, with ETag cache).
3. Resolve the vehicle (id / chipset / Android version).
4. Apply compatibility rules → show compatible apps only.
5. Compare installed `versionCode` with the available one.
6. Show available updates; download APK from GitHub Releases.
7. Verify **SHA-256** before installing.
8. Launch the installer per available Android permissions.

See [`examples/TamOsUpdates.kt`](examples/TamOsUpdates.kt) for a complete Kotlin implementation
(models, fetch + ETag cache, compatibility engine, update-check, download + SHA-256 verify).

### Caching & freshness
JSON is cached with HTTP **ETag** / `If-None-Match`; a `304 Not Modified` serves the cache. On network
errors the client falls back to the last cached copy (offline-tolerant). `config.json.cache.ttlSeconds`
suggests a refresh interval.

---

## Changing the owner/repo

All URLs embed `talebahmadc-prog/tam-os-updates`. To move the project, run:

```bash
node tools/set-owner.mjs <new-owner> [new-repo]
node tools/validate.mjs
```

---

## Security notes
- The repository is **public**; JSON and APK links work without authentication.
- **Never** embed a GitHub token in the Android app.
- Always verify **SHA-256** after download before installing.
- Treat downloaded APKs as untrusted until the checksum matches.
