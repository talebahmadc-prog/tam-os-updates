// Set the vehicle fleet and make every app available on ALL vehicles.
// Race-safe (GitHub API read-modify-write). Needs GITHUB_TOKEN.
//   PowerShell:  $env:GITHUB_TOKEN="github_pat_xxx"; node tools/set-fleet.mjs
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8"));
const { owner, repo, branch } = cfg;
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) { console.error("Set GITHUB_TOKEN first."); process.exit(1); }
const API = `https://api.github.com/repos/${owner}/${repo}`;
const H = (e = {}) => ({ Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "tam-fleet", "X-GitHub-Api-Version": "2022-11-28", ...e });
async function ghGet(p) { const r = await fetch(`${API}/contents/${p}?ref=${branch}`, { headers: H() }); if (!r.ok) throw new Error(`${p}: ${r.status}`); const j = await r.json(); return { sha: j.sha, data: JSON.parse(Buffer.from(j.content, "base64").toString("utf8")) }; }
async function ghPut(p, obj, sha, msg) { const r = await fetch(`${API}/contents/${p}`, { method: "PUT", headers: H(), body: JSON.stringify({ message: msg, branch, sha, content: Buffer.from(JSON.stringify(obj, null, 2) + "\n", "utf8").toString("base64") }) }); if (!r.ok) throw new Error(`put ${p}: ${r.status} ${await r.text()}`); }

const V = (id, name, brand, androidVersion, chipset, extraTags = []) => ({
  id, name, brand, model: name.replace(brand, "").trim() || name, androidVersion,
  hardware: { chipset: chipset || "unknown" },
  tags: [brand.toLowerCase(), ...(brand === "NETA" ? ["tam-os"] : []), ...extraTags, id],
});

const FLEET = [
  V("neta-u-large-2022", "NETA U Large Screen 2022", "NETA", 10, "sa8155", ["neta-u"]),
  V("neta-u-large-2023", "NETA U Large Screen 2023", "NETA", 11, "sa8155", ["neta-u"]),
  V("neta-u-small-screen", "NETA U Small Screen", "NETA", 10, "unknown", ["neta-u"]),
  V("neta-v", "NETA V", "NETA", 10, "mediatek", []),
  V("neta-aya", "NETA Aya", "NETA", 11, "unknown", []),
  V("neta-x", "NETA X", "NETA", 11, "sa8295", []),
  V("neta-s", "NETA S", "NETA", 12, "unknown", []),
  V("neta-gt", "NETA GT", "NETA", 11, "unknown", []),
  V("byd-dilink-2-0", "BYD DiLink 2.0", "BYD", 9, "unknown", ["dilink"]),
  V("byd-dilink-3-0", "BYD DiLink 3.0", "BYD", 10, "unknown", ["dilink"]),
  V("byd-dilink-4-0", "BYD DiLink 4.0", "BYD", 11, "unknown", ["dilink"]),
  V("byd-dilink-5-0", "BYD DiLink 5.0", "BYD", 12, "unknown", ["dilink"]),
  V("byd-dilink-6-0", "BYD DiLink 6.0", "BYD", 13, "unknown", ["dilink"]),
];

// 1) vehicles.json -> the fleet
const vf = await ghGet("data/vehicles.json");
vf.data.vehicles = FLEET;
vf.data.updatedAt = new Date().toISOString().slice(0, 10);
await ghPut("data/vehicles.json", vf.data, vf.sha, "fleet: set 13 NETA/BYD vehicles");
console.log("set fleet:", FLEET.length, "vehicles");

// 2) apps.json -> every app available on ALL vehicles; clear per-release restrictions
const af = await ghGet("data/apps.json");
for (const a of af.data.apps || []) {
  a.compatibility = { allVehicles: true, vehicles: [], require: {} };
  for (const r of a.releases || []) delete r.compatibility; // match every vehicle
}
af.data.updatedAt = new Date().toISOString().slice(0, 10);
await ghPut("data/apps.json", af.data, af.sha, "apps: show every app on all vehicles");
console.log("updated", (af.data.apps || []).length, "apps -> allVehicles");
