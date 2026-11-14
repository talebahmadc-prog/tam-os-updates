// Set app iconUrl (from the dashboard-icons CDN) and vehicle imageUrl (from
// Wikipedia/Wikimedia), verifying each URL returns a real image. Hotlinks the
// CDN/Wikimedia URLs (no re-hosting). Needs GITHUB_TOKEN.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8"));
const { owner, repo, branch } = cfg;
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) { console.error("Set GITHUB_TOKEN"); process.exit(1); }
const API = `https://api.github.com/repos/${owner}/${repo}`;
const H = (e = {}) => ({ Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "tam-media", "X-GitHub-Api-Version": "2022-11-28", ...e });
async function ghGet(p) { const r = await fetch(`${API}/contents/${p}?ref=${branch}`, { headers: H() }); const j = await r.json(); return { sha: j.sha, data: JSON.parse(Buffer.from(j.content, "base64").toString("utf8")) }; }
async function ghPut(p, obj, sha, msg) { const r = await fetch(`${API}/contents/${p}`, { method: "PUT", headers: H(), body: JSON.stringify({ message: msg, branch, sha, content: Buffer.from(JSON.stringify(obj, null, 2) + "\n", "utf8").toString("base64") }) }); if (!r.ok) throw new Error(`put ${p}: ${r.status} ${await r.text()}`); }

async function isImage(url) {
  try {
    const r = await fetch(url, { method: "GET", headers: { "User-Agent": "tam-media" }, redirect: "follow" });
    const ct = r.headers.get("content-type") || "";
    return r.ok && ct.startsWith("image/") ? r.url : null;
  } catch { return null; }
}

const CDN = "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png";
const APP_CANDIDATES = {
  "beta-chrome": ["google-chrome", "chrome"],
  "maps-google-android-apps": ["google-maps"],
  "gboard-1": ["gboard", "google-keyboard"],
  "vradio-v2-7-1": ["vradio", "radio"],
  "cm-aptoide-pt": ["aptoide"],
  "firefox-155-0-1-arm64": ["firefox"],
  "microg": ["microg"],
  "gms-mgoogle-android": ["microg"],
  "revancedmanager-revanced-net": ["revanced"],
  "app-revanced-android-youtube-qsm": ["revanced", "youtube"],
  "y-keyboard": ["yandex"],
  "youtube": ["youtube"],
};

const VEHICLE_WIKI = {
  "neta-u-large-2022": "Neta U", "neta-u-large-2023": "Neta U", "neta-u-small-screen": "Neta U",
  "neta-v": "Neta V", "neta-aya": "Neta Aya", "neta-x": "Neta X", "neta-s": "Neta S", "neta-gt": "Neta GT",
  "byd-dilink-2-0": "BYD Tang", "byd-dilink-3-0": "BYD Song", "byd-dilink-4-0": "BYD Han",
  "byd-dilink-5-0": "BYD Seal", "byd-dilink-6-0": "BYD Han",
};

async function wikiImage(title) {
  try {
    const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`, { headers: { "User-Agent": "tam-media" } });
    if (!r.ok) return null;
    const j = await r.json();
    const u = j.originalimage?.source || j.thumbnail?.source;
    if (!u) return null;
    return await isImage(u);
  } catch { return null; }
}

// ---- apps ----
const appsF = await ghGet("data/apps.json");
let ai = 0;
for (const app of appsF.data.apps || []) {
  const cands = APP_CANDIDATES[app.id];
  if (!cands) continue;
  for (const slug of cands) {
    const ok = await isImage(`${CDN}/${slug}.png`);
    if (ok) { app.iconUrl = ok; ai++; console.log(`icon ${app.id} -> ${slug}`); break; }
  }
}
appsF.data.updatedAt = new Date().toISOString().slice(0, 10);
await ghPut("data/apps.json", appsF.data, appsF.sha, `media: set ${ai} app icons`);

// ---- vehicles ----
const vehF = await ghGet("data/vehicles.json");
let vi = 0;
for (const v of vehF.data.vehicles || []) {
  const title = VEHICLE_WIKI[v.id];
  if (!title) continue;
  const img = await wikiImage(title);
  if (img) { v.imageUrl = img; vi++; console.log(`image ${v.id} -> ${title}`); }
  else console.log(`image ${v.id}: none (${title})`);
}
vehF.data.updatedAt = new Date().toISOString().slice(0, 10);
await ghPut("data/vehicles.json", vehF.data, vehF.sha, `media: set ${vi} vehicle images`);

console.log(`\nDone. ${ai} app icons, ${vi} vehicle images.`);
