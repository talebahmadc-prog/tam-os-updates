# TAM OS Store — admin backend (Cloudflare Worker)

A small Cloudflare Worker + D1 backend that lets **multiple users sign in with a
username and password** and:

- **admin** — manage users (create/disable/delete, set role, reset password) **and** everything an uploader can do.
- **uploader** — upload app APKs and define vehicles & compatibility.

The Worker holds a single **GitHub token as a Cloudflare secret** and acts on the
public `talebahmadc-prog/tam-os-updates` repo on the users' behalf: it commits
`data/apps.json` / `data/vehicles.json` and uploads APKs to **GitHub Releases**.
The token is never sent to the browser and never embedded in the Android app.

```
server/
├── wrangler.jsonc        # worker + D1 + vars (edit database_id after creating D1)
├── schema.sql            # users, sessions, audit_log
├── src/index.js          # auth (PBKDF2), roles, GitHub integration
├── public/               # login UI + admin SPA (served as static assets)
│   ├── index.html
│   ├── app.js
│   └── style.css
└── scripts/
    ├── create-admin.mjs  # make the first admin
    └── bulk-upload.mjs    # import D:\Apps (root) into Releases
```

---

## 1. Create the GitHub token (fine-grained)

1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**
   (direct: `https://github.com/settings/personal-access-tokens/new`).
2. **Token name:** `tam-os-store-worker`.
3. **Expiration:** pick a period (e.g. 1 year).
4. **Resource owner:** `talebahmadc-prog`.
5. **Repository access → Only select repositories →** `tam-os-updates`.
6. **Permissions → Repository permissions:**
   - **Contents → Read and write** (covers JSON commits **and** Release asset upload).
   - **Metadata → Read-only** (auto-selected).
   - Leave everything else **No access**.
7. **Generate token** and copy it (`github_pat_...`, shown once).

> Keep it secret. It goes into Cloudflare (step 4) and, for the one-time import,
> a temporary env var (step 6). Never commit it.

---

## 2. Create the D1 database

From the `server/` folder:

```bash
wrangler d1 create tam-os-store-db
```

Copy the printed `database_id` into `wrangler.jsonc` (replace `PASTE_DATABASE_ID_AFTER_wrangler_d1_create`).

Apply the schema to the remote database:

```bash
wrangler d1 execute tam-os-store-db --remote --file=./schema.sql
```

---

## 3. Create the first admin

```bash
node scripts/create-admin.mjs <username> <password> > admin.sql
wrangler d1 execute tam-os-store-db --remote --file=./admin.sql
```

(Delete `admin.sql` afterwards. Create further users from the panel.)

---

## 4. Set the GitHub token as a secret & deploy

```bash
wrangler secret put GITHUB_TOKEN
```

Paste the token when prompted. Then deploy:

```bash
wrangler deploy
```

Wrangler prints the URL, e.g. `https://tam-os-store.<your-subdomain>.workers.dev`.
Open it, sign in, and you'll land on the admin panel.

> If `wrangler deploy` complains about permissions, run `wrangler login` again and
> approve full access (the current token may be read-only).

---

## 5. Use the panel

- **Upload APK** — pick/create an app, choose **all vehicles** or **specific vehicles**,
  attach the APK → it is uploaded to a GitHub Release, checksummed (SHA-256) and
  written into `apps.json` automatically.
- **Apps** — edit compatibility (all/specific + mandatory chipset/Android/tags) with a
  live preview of which vehicles each app opens on; enable/disable; (admin) delete.
- **Vehicles** — add/edit vehicles (id, brand, Android version, chipset, tags).
- **Users** (admin) — create admins/uploaders, reset passwords, disable, delete.
- **Audit** (admin) — who uploaded/changed what.

> **Worker upload size:** Cloudflare caps the request body (~100 MB free / 200 MB paid).
> For APKs larger than that, use the bulk-upload script (step 6), which uploads straight
> to GitHub with no size limit.

---

## 6. One-time import of `D:\Apps` (root only)

Uploads the APKs sitting **directly** in `D:\Apps` (not its subfolders) to a Release and
registers them in `apps.json`. They are created **enabled but matching no vehicle** — assign
vehicles afterwards in the panel (Apps tab).

PowerShell:

```powershell
$env:GITHUB_TOKEN="github_pat_xxx"; node scripts/bulk-upload.mjs "D:\Apps" apps-import-2026-11
```

The script prints each uploaded file and the imported app ids. `packageName` and
`versionName` are guessed from filenames — refine them in the panel.

---

## Local development

```bash
wrangler d1 execute tam-os-store-db --local --file=./schema.sql
node scripts/create-admin.mjs admin admin123 > admin.local.sql
wrangler d1 execute tam-os-store-db --local --file=./admin.local.sql
wrangler dev
```

GitHub calls still use the real token; set it locally in a `.dev.vars` file
(`GITHUB_TOKEN=github_pat_xxx`) which is git-ignored.

## Security
- GitHub token: Cloudflare secret only — never in the browser, Android app, or git.
- Passwords: PBKDF2-SHA256 (100k iterations, per-user salt). Sessions are HttpOnly+Secure cookies with CSRF tokens.
- Login lockout after 5 failed tries (5 min).
