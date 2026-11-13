// One-time bulk importer: upload the APKs sitting directly in a folder
// (default D:\Apps, NOT its subfolders) to GitHub Releases, then register each
// in data/apps.json and releases/release-index.json.
//
// Uploads go straight to GitHub (uploads.github.com), so there is no size limit
// issue — unlike the Worker, which is capped by Cloudflare's request body size.
//
// Each imported app is created inert: enabled=true but compatibility matches NO
// vehicle (allVehicles=false, vehicles=[]). Assign vehicles afterwards in the
// admin panel (Apps tab) — that is exactly what the panel is for.
//
// Usage (PowerShell):
//   $env:GITHUB_TOKEN="github_pat_xxx"
//   node scripts/bulk-upload.mjs "D:\Apps" apps-import-2026-11
//
// Usage (bash):
//   GITHUB_TOKEN=github_pat_xxx node scripts/bulk-upload.mjs "D:/Apps" apps-import-2026-11

import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const cfg = JSON.parse(readFileSync(join(REPO_ROOT, "config.json"), "utf8"));
const OWNER = cfg.owner, REPO = cfg.repo, BRANCH = cfg.branch;

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error("Set GITHUB_TOKEN first (the fine-grained PAT with Contents: read/write).");
  console.error('  PowerShell:  $env:GITHUB_TOKEN="github_pat_xxx"');
  process.exit(1);
}
const APK_DIR = process.argv[2] || "D:/Apps";
const TAG = process.argv[3] || `apps-import-${new Date().toISOString().slice(0, 7)}`;

const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const UPLOADS = `https://uploads.github.com/repos/${OWNER}/${REPO}`;
const H = (extra = {}) => ({
  Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json",
  "User-Agent": "tam-os-bulk-upload", "X-GitHub-Api-Version": "2022-11-28", ...extra,
});

const PKG_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-+/g, "-");
const title = (s) => s.split("-").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

function meta(fileName) {
  const base = basename(fileName, extname(fileName));
  let packageName = "", id, name;
  if (PKG_RE.test(base)) { packageName = base; id = slug(base.split(".").slice(-1)[0] + "-" + base.split(".").slice(1, -1).join("-")); }
  id = id || slug(base);
  if (!id) id = "app-" + Math.random().toString(36).slice(2, 7);
  name = title(id);
  const vm = base.match(/(\d+\.\d+(?:\.\d+)?)/);
  return { id, name, packageName, versionName: vm ? vm[1] : "1.0.0" };
}

async function ghGet(path) {
  const r = await fetch(`${API}/contents/${path}?ref=${BRANCH}`, { headers: H() });
  if (r.status === 404) return { sha: null, data: null };
  if (!r.ok) throw new Error(`getFile ${path}: ${r.status} ${await r.text()}`);
  const j = await r.json();
  return { sha: j.sha, data: JSON.parse(Buffer.from(j.content, "base64").toString("utf8")) };
}
async function ghPut(path, obj, sha, message) {
  const body = { message, branch: BRANCH, content: Buffer.from(JSON.stringify(obj, null, 2) + "\n", "utf8").toString("base64") };
  if (sha) body.sha = sha;
  const r = await fetch(`${API}/contents/${path}`, { method: "PUT", headers: H(), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`putFile ${path}: ${r.status} ${await r.text()}`);
}
async function ensureRelease(tag) {
  let r = await fetch(`${API}/releases/tags/${encodeURIComponent(tag)}`, { headers: H() });
  if (r.ok) return r.json();
  if (r.status !== 404) throw new Error(`release lookup: ${r.status} ${await r.text()}`);
  r = await fetch(`${API}/releases`, { method: "POST", headers: H(), body: JSON.stringify({ tag_name: tag, name: tag, target_commitish: BRANCH }) });
  if (!r.ok) throw new Error(`create release: ${r.status} ${await r.text()}`);
  return r.json();
}
async function uploadAsset(release, fileName, buf) {
  const existing = (release.assets || []).find((a) => a.name === fileName);
  if (existing) await fetch(`${API}/releases/assets/${existing.id}`, { method: "DELETE", headers: H() });
  const r = await fetch(`${UPLOADS}/releases/${release.id}/assets?name=${encodeURIComponent(fileName)}`, {
    method: "POST", headers: H({ "Content-Type": "application/vnd.android.package-archive" }), body: buf,
  });
  if (!r.ok) throw new Error(`upload ${fileName}: ${r.status} ${await r.text()}`);
  return r.json();
}

// ---- main ----
const files = readdirSync(APK_DIR)
  .filter((f) => f.toLowerCase().endsWith(".apk"))
  .filter((f) => statSync(join(APK_DIR, f)).isFile()); // root only, no subfolders
if (files.length === 0) { console.error(`No .apk files directly in ${APK_DIR}`); process.exit(1); }

console.log(`Found ${files.length} APK(s) in ${APK_DIR} (root only). Release tag: ${TAG}\n`);
const release = await ensureRelease(TAG);

const imported = [];
for (const f of files) {
  const path = join(APK_DIR, f);
  const buf = readFileSync(path);
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const m = meta(f);
  process.stdout.write(`↑ ${f}  (${(buf.length / 1048576).toFixed(1)} MB) … `);
  const asset = await uploadAsset(release, f, buf);
  console.log("done");
  imported.push({ ...m, fileName: f, sha256, sizeBytes: buf.length, url: asset.browser_download_url });
}

// update apps.json
const appsF = await ghGet("data/apps.json");
const appsDoc = appsF.data || { schemaVersion: 1, apps: [] };
appsDoc.apps ||= [];
for (const it of imported) {
  let app = appsDoc.apps.find((a) => a.id === it.id);
  const rel = {
    variant: "universal", versionCode: 1, versionName: it.versionName, releaseTag: TAG,
    apkFileName: it.fileName, apkUrl: it.url, published: true, sha256: it.sha256, sizeBytes: it.sizeBytes,
    compatibility: {}, changelog: "Imported from D:\\Apps", updatedAt: new Date().toISOString().slice(0, 10),
  };
  if (!app) {
    appsDoc.apps.push({
      id: it.id, name: it.name, packageName: it.packageName, category: "tools", tags: ["imported"],
      enabled: true, compatibility: { allVehicles: false, vehicles: [], require: {} }, releases: [rel],
    });
  } else {
    app.releases = (app.releases || []).filter((r) => r.variant !== "universal");
    app.releases.push(rel);
  }
}
appsDoc.updatedAt = new Date().toISOString().slice(0, 10);
await ghPut("data/apps.json", appsDoc, appsF.sha, `bulk import ${imported.length} apps from D:\\Apps`);

// update release-index.json
const idxF = await ghGet("releases/release-index.json");
const idxDoc = idxF.data || { schemaVersion: 1, releases: [] };
idxDoc.releases ||= [];
let rel = idxDoc.releases.find((r) => r.tag === TAG);
if (!rel) { rel = { tag: TAG, name: TAG, vehicles: [], assets: [] }; idxDoc.releases.push(rel); }
for (const it of imported) {
  rel.assets = rel.assets.filter((a) => a.fileName !== it.fileName);
  rel.assets.push({ appId: it.id, fileName: it.fileName, versionName: it.versionName, versionCode: 1, published: true, sha256: it.sha256, sizeBytes: it.sizeBytes, url: it.url });
}
idxDoc.updatedAt = new Date().toISOString().slice(0, 10);
await ghPut("releases/release-index.json", idxDoc, idxF.sha, `bulk import index (${imported.length} assets)`);

console.log(`\n✓ Imported ${imported.length} apps into release "${TAG}".`);
console.log("  They are ENABLED but match no vehicle yet. Open the admin panel → Apps to assign vehicles.");
console.log("\nImported ids:");
for (const it of imported) console.log(`  - ${it.id}  (${it.packageName || "no package"})  v${it.versionName}`);
