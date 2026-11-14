// Extract real launcher icons from each app's APK and publish them to the repo
// under icons/<appId>.png, then set iconUrl on every app in apps.json.
// Local-first: looks for the APK in D:\Apps (recursively) by file name; falls
// back to downloading the release asset. Needs GITHUB_TOKEN.
//
//   PowerShell:  $env:GITHUB_TOKEN="github_pat_xxx"; node tools/backfill-icons.mjs
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8"));
const { owner, repo, branch, rawBaseUrl } = cfg;
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) { console.error("Set GITHUB_TOKEN first."); process.exit(1); }
const API = `https://api.github.com/repos/${owner}/${repo}`;
const H = (e = {}) => ({ Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "tam-icons", "X-GitHub-Api-Version": "2022-11-28", ...e });
const APPS_DIR = "D:/Apps";

// index local apk files by name (recursive)
const localIndex = {};
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.toLowerCase().endsWith(".apk")) localIndex[e.name] = p;
  }
})(APPS_DIR);

// ---- minimal zip reader: list entries, extract one by name ----
function zipEntries(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const u16 = (o) => dv.getUint16(o, true), u32 = (o) => dv.getUint32(o, true);
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0 && i > u8.length - 22 - 65536; i--) if (u32(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("no EOCD");
  const cdOffset = u32(eocd + 16), cdCount = u16(eocd + 10);
  const out = [];
  let p = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (u32(p) !== 0x02014b50) break;
    const method = u16(p + 10), compSize = u32(p + 20), uncompSize = u32(p + 24);
    const nameLen = u16(p + 28), extraLen = u16(p + 30), commentLen = u16(p + 32), lho = u32(p + 42);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
    out.push({ name, method, compSize, uncompSize, lho });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
function extract(u8, entry) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const u16 = (o) => dv.getUint16(o, true);
  const lNameLen = u16(entry.lho + 26), lExtraLen = u16(entry.lho + 28);
  const start = entry.lho + 30 + lNameLen + lExtraLen;
  const comp = u8.subarray(start, start + entry.compSize);
  return entry.method === 0 ? Buffer.from(comp) : inflateRawSync(Buffer.from(comp));
}

// pick the best launcher PNG: biggest png in mipmap/drawable whose name hints icon
function pickIcon(entries) {
  const re = /res\/(mipmap|drawable)[^/]*\/(ic_launcher[^/]*|.*icon.*|.*launcher.*)\.png$/i;
  const cands = entries.filter((e) => re.test(e.name) && e.uncompSize > 0);
  if (cands.length === 0) return null;
  // prefer round/foreground-free ic_launcher, biggest size
  cands.sort((a, b) => b.uncompSize - a.uncompSize);
  return cands[0];
}

async function ghGet(p) {
  const r = await fetch(`${API}/contents/${p}?ref=${branch}`, { headers: H() });
  if (r.status === 404) return { sha: null, data: null };
  if (!r.ok) throw new Error(`${p}: ${r.status}`);
  const j = await r.json();
  return { sha: j.sha, data: JSON.parse(Buffer.from(j.content, "base64").toString("utf8")) };
}
async function ghPutRaw(p, buf, sha, msg) {
  const body = { message: msg, branch, content: buf.toString("base64") };
  if (sha) body.sha = sha;
  const r = await fetch(`${API}/contents/${p}`, { method: "PUT", headers: H(), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`put ${p}: ${r.status} ${await r.text()}`);
}
async function shaOf(p) { const r = await fetch(`${API}/contents/${p}?ref=${branch}`, { headers: H() }); return r.ok ? (await r.json()).sha : null; }
async function download(url) {
  const r = await fetch(url, { headers: { "User-Agent": "tam-icons" }, redirect: "follow" });
  if (!r.ok) throw new Error(`download ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

const appsF = await ghGet("data/apps.json");
const apps = appsF.data.apps || [];
let done = 0, skipped = 0;
for (const app of apps) {
  const rel = (app.releases || []).find((r) => r.published) || app.releases?.[0];
  const fileName = rel?.apkFileName;
  if (!fileName) { skipped++; continue; }
  try {
    let bytes;
    if (localIndex[fileName] && existsSync(localIndex[fileName])) bytes = readFileSync(localIndex[fileName]);
    else if (rel.apkUrl) bytes = await download(rel.apkUrl);
    else { skipped++; continue; }
    const u8 = new Uint8Array(bytes);
    const entries = zipEntries(u8);
    const icon = pickIcon(entries);
    if (!icon) { console.log(`- ${app.id}: no PNG icon (adaptive only)`); skipped++; continue; }
    const png = extract(u8, icon);
    const path = `icons/${app.id}.png`;
    await ghPutRaw(path, png, await shaOf(path), `icons: ${app.id}`);
    app.iconUrl = `${rawBaseUrl}/${path}`;
    done++;
    console.log(`✓ ${app.id}  (${(png.length / 1024).toFixed(0)} KB from ${icon.name})`);
  } catch (e) {
    console.log(`! ${app.id}: ${e.message}`);
    skipped++;
  }
}
// save iconUrls back (re-read sha to avoid conflict)
const fresh = await ghGet("data/apps.json");
for (const a of fresh.data.apps) { const m = apps.find((x) => x.id === a.id); if (m?.iconUrl) a.iconUrl = m.iconUrl; }
fresh.data.updatedAt = new Date().toISOString().slice(0, 10);
await ghPutRaw("data/apps.json", Buffer.from(JSON.stringify(fresh.data, null, 2) + "\n", "utf8"), fresh.sha, `icons: set iconUrl for ${done} apps`);
console.log(`\nDone. ${done} icons published, ${skipped} skipped.`);
