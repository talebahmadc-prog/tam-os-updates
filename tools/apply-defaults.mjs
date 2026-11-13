// One-off, race-safe data fixer via the GitHub API (reads the latest file + sha,
// so it respects edits made in the admin panel). Needs GITHUB_TOKEN.
//   PowerShell:  $env:GITHUB_TOKEN="github_pat_xxx"; node tools/apply-defaults.mjs
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8"));
const { owner, repo, branch } = cfg;
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) { console.error("Set GITHUB_TOKEN first."); process.exit(1); }
const API = `https://api.github.com/repos/${owner}/${repo}`;
const H = (e = {}) => ({ Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "tam-defaults", "X-GitHub-Api-Version": "2022-11-28", ...e });
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-+/g, "-");
const KEBAB = /^[a-z0-9][a-z0-9-]*$/;

async function ghGet(p) {
  const r = await fetch(`${API}/contents/${p}?ref=${branch}`, { headers: H() });
  if (!r.ok) throw new Error(`${p}: ${r.status}`);
  const j = await r.json();
  return { sha: j.sha, data: JSON.parse(Buffer.from(j.content, "base64").toString("utf8")) };
}
async function ghPut(p, obj, sha, msg) {
  const r = await fetch(`${API}/contents/${p}`, {
    method: "PUT", headers: H(),
    body: JSON.stringify({ message: msg, branch, sha, content: Buffer.from(JSON.stringify(obj, null, 2) + "\n", "utf8").toString("base64") }),
  });
  if (!r.ok) throw new Error(`put ${p}: ${r.status} ${await r.text()}`);
}

// 1) slugify any non-kebab vehicle ids
const vf = await ghGet("data/vehicles.json");
const idmap = {};
for (const v of vf.data.vehicles || []) {
  if (!KEBAB.test(v.id)) { const n = slug(v.id) || `vehicle-${Math.random().toString(36).slice(2, 6)}`; idmap[v.id] = n; v.id = n; }
}
if (Object.keys(idmap).length) {
  vf.data.updatedAt = new Date().toISOString().slice(0, 10);
  await ghPut("data/vehicles.json", vf.data, vf.sha, "fix: slugify vehicle ids");
  console.log("fixed vehicle ids:", idmap);
} else console.log("vehicle ids already clean");

// 2) assign still-empty imported apps to NETA vehicles + remap any fixed refs
const af = await ghGet("data/apps.json");
const NETA = ["neta-u", "neta-x", "neta-v"];
let n = 0;
for (const a of af.data.apps || []) {
  if (a.compatibility?.vehicles) a.compatibility.vehicles = a.compatibility.vehicles.map((x) => idmap[x] || x);
  if ((a.tags || []).includes("imported")) {
    const c = a.compatibility || {};
    if (c.allVehicles !== true && (!c.vehicles || c.vehicles.length === 0)) {
      a.compatibility = { allVehicles: false, vehicles: NETA.slice(), require: {} }; n++;
    }
  }
}
af.data.updatedAt = new Date().toISOString().slice(0, 10);
await ghPut("data/apps.json", af.data, af.sha, "data: default-assign imported apps to NETA vehicles");
console.log(`assigned ${n} imported apps to NETA vehicles`);
