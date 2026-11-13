// TAM OS — JSON + Release link validator. No external dependencies (Node >= 18).
//
// Usage:
//   node tools/validate.mjs            Validate structure and cross-references
//   node tools/validate.mjs --check-urls   Also HTTP-check published APK URLs
//   node tools/validate.mjs --strict       Treat warnings as errors
//
// Exit code 0 = OK, 1 = validation errors.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const CHECK_URLS = args.includes("--check-urls");
const STRICT = args.includes("--strict");

const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TAG_RE = /^[a-z0-9][a-z0-9-]*$/;
const PKG_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
const SHA_RE = /^([a-f0-9]{64}|PENDING)$/;

async function loadJson(rel) {
  const path = join(ROOT, rel);
  const raw = await readFile(path, "utf8");
  try {
    return JSON.parse(raw);
  } catch (e) {
    err(`${rel}: invalid JSON — ${e.message}`);
    return null;
  }
}

function req(obj, key, ctx) {
  if (obj == null || obj[key] === undefined) {
    err(`${ctx}: missing required field "${key}"`);
    return false;
  }
  return true;
}

async function main() {
  const config = await loadJson("config.json");
  const apps = await loadJson("data/apps.json");
  const vehicles = await loadJson("data/vehicles.json");
  const categories = await loadJson("data/categories.json");
  const releaseIndex = await loadJson("releases/release-index.json");

  if (!apps || !vehicles || !categories || !releaseIndex) return finish();

  // ---- categories ----
  const categoryIds = new Set();
  for (const c of categories.categories || []) {
    const ctx = `categories[${c.id}]`;
    req(c, "id", ctx);
    req(c, "name", ctx);
    if (c.id && !TAG_RE.test(c.id)) err(`${ctx}: id must be kebab-case`);
    if (categoryIds.has(c.id)) err(`${ctx}: duplicate category id`);
    categoryIds.add(c.id);
  }

  // ---- vehicles ----
  const vehicleIds = new Set();
  for (const v of vehicles.vehicles || []) {
    const ctx = `vehicles[${v.id}]`;
    req(v, "id", ctx);
    req(v, "name", ctx);
    req(v, "brand", ctx);
    req(v, "androidVersion", ctx);
    if (v.id && !TAG_RE.test(v.id)) err(`${ctx}: id must be kebab-case`);
    if (vehicleIds.has(v.id)) err(`${ctx}: duplicate vehicle id`);
    vehicleIds.add(v.id);
    if (v.hardware?.chipset && !TAG_RE.test(v.hardware.chipset)) err(`${ctx}: chipset must be kebab-case`);
  }

  // ---- release index ----
  const releaseTags = new Set();
  const assetUrls = new Set();
  const publishedAssets = [];
  for (const r of releaseIndex.releases || []) {
    const ctx = `release[${r.tag}]`;
    req(r, "tag", ctx);
    if (releaseTags.has(r.tag)) err(`${ctx}: duplicate release tag`);
    releaseTags.add(r.tag);
    for (const vId of r.vehicles || []) {
      if (!vehicleIds.has(vId)) warn(`${ctx}: references unknown vehicle "${vId}"`);
    }
    for (const a of r.assets || []) {
      const actx = `${ctx}.asset[${a.appId}/${a.fileName}]`;
      req(a, "appId", actx);
      req(a, "fileName", actx);
      req(a, "url", actx);
      if (a.sha256 && !SHA_RE.test(a.sha256)) err(`${actx}: sha256 must be 64 hex chars or "PENDING"`);
      if (a.url && !a.url.startsWith("https://")) err(`${actx}: url must be https`);
      if (a.published === true && a.sha256 === "PENDING") err(`${actx}: published asset must have a real sha256`);
      if (a.published === true && (a.sizeBytes ?? 0) <= 0) warn(`${actx}: published asset has sizeBytes 0`);
      assetUrls.add(a.url);
      if (a.published === true && a.url) publishedAssets.push({ ctx: actx, url: a.url });
    }
  }

  // ---- apps ----
  const appIds = new Set();
  const packageNames = new Set();
  for (const app of apps.apps || []) {
    const ctx = `apps[${app.id}]`;
    req(app, "id", ctx);
    req(app, "name", ctx);
    req(app, "packageName", ctx);
    req(app, "category", ctx);
    req(app, "enabled", ctx);
    req(app, "compatibility", ctx);
    req(app, "releases", ctx);

    if (app.id && !TAG_RE.test(app.id)) err(`${ctx}: id must be kebab-case`);
    if (appIds.has(app.id)) err(`${ctx}: DUPLICATE app id — each app must be registered once`);
    appIds.add(app.id);

    if (app.packageName && !PKG_RE.test(app.packageName)) err(`${ctx}: invalid Android package name`);
    if (app.packageName && packageNames.has(app.packageName)) err(`${ctx}: duplicate packageName`);
    packageNames.add(app.packageName);

    if (app.category && !categoryIds.has(app.category)) err(`${ctx}: unknown category "${app.category}"`);

    const c = app.compatibility || {};
    for (const vId of c.vehicles || []) {
      if (!vehicleIds.has(vId)) err(`${ctx}.compatibility: unknown vehicle "${vId}"`);
    }
    if (c.allVehicles !== true && (!Array.isArray(c.vehicles) || c.vehicles.length === 0)) {
      if (!(c.require && (c.require.chipset || c.require.tags || c.require.minAndroidVersion))) {
        warn(`${ctx}.compatibility: not allVehicles and no vehicles/require rules — app matches nothing`);
      }
    }
    for (const vId of c.exclude?.vehicles || []) {
      if (!vehicleIds.has(vId)) warn(`${ctx}.compatibility.exclude: unknown vehicle "${vId}"`);
    }

    if (!Array.isArray(app.releases) || app.releases.length === 0) {
      err(`${ctx}: must have at least one release`);
    }
    const seenVersionCodes = new Set();
    for (const r of app.releases || []) {
      const rctx = `${ctx}.release[${r.variant}]`;
      req(r, "variant", rctx);
      req(r, "versionCode", rctx);
      req(r, "versionName", rctx);
      req(r, "releaseTag", rctx);
      req(r, "apkUrl", rctx);
      req(r, "sha256", rctx);
      req(r, "published", rctx);

      if (r.sha256 && !SHA_RE.test(r.sha256)) err(`${rctx}: sha256 must be 64 hex chars or "PENDING"`);
      if (r.apkUrl && !r.apkUrl.startsWith("https://")) err(`${rctx}: apkUrl must be https`);
      if (r.published === true && r.sha256 === "PENDING") err(`${rctx}: published release must have a real sha256`);

      const key = `${r.variant}:${r.versionCode}`;
      if (seenVersionCodes.has(key)) warn(`${rctx}: duplicate variant+versionCode`);
      seenVersionCodes.add(key);

      if (r.releaseTag && !releaseTags.has(r.releaseTag)) {
        warn(`${rctx}: releaseTag "${r.releaseTag}" not found in release-index.json`);
      }
      if (r.apkUrl && !assetUrls.has(r.apkUrl)) {
        warn(`${rctx}: apkUrl not listed in release-index.json assets`);
      }
      for (const vId of r.compatibility?.vehicles || []) {
        if (!vehicleIds.has(vId)) err(`${rctx}.compatibility: unknown vehicle "${vId}"`);
      }
    }
  }

  // release-index assets should reference known apps
  for (const r of releaseIndex.releases || []) {
    for (const a of r.assets || []) {
      if (a.appId && !appIds.has(a.appId)) warn(`release[${r.tag}].asset: references unknown app "${a.appId}"`);
    }
  }

  // ---- optional URL checks ----
  if (CHECK_URLS) {
    if (publishedAssets.length === 0) {
      console.log("ℹ  --check-urls: no published assets to check (all PENDING).");
    }
    for (const { ctx, url } of publishedAssets) {
      try {
        const res = await fetch(url, { method: "HEAD", redirect: "follow" });
        if (!res.ok) err(`${ctx}: URL returned HTTP ${res.status} — ${url}`);
        else console.log(`✓ ${res.status} ${url}`);
      } catch (e) {
        err(`${ctx}: URL unreachable — ${url} (${e.message})`);
      }
    }
  }

  finish();
}

function finish() {
  console.log("");
  for (const w of warnings) console.log(`⚠  ${w}`);
  for (const e of errors) console.log(`✗  ${e}`);
  const effectiveErrors = STRICT ? errors.length + warnings.length : errors.length;
  console.log("");
  console.log(`Result: ${errors.length} error(s), ${warnings.length} warning(s)${STRICT ? " [strict]" : ""}`);
  if (effectiveErrors === 0) {
    console.log("✓ All TAM OS data files are valid.");
    process.exit(0);
  } else {
    console.log("✗ Validation failed.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
