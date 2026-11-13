// Add one vehicle by display name (race-safe, GitHub API). Needs GITHUB_TOKEN.
//   node tools/add-vehicle.mjs "NETA U Blue Mic" [brand] [androidVersion] [chipset]
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8"));
const { owner, repo, branch } = cfg;
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) { console.error("Set GITHUB_TOKEN first."); process.exit(1); }

const name = process.argv[2];
if (!name) { console.error('Usage: node tools/add-vehicle.mjs "<name>" [brand] [android] [chipset]'); process.exit(1); }
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-+/g, "-");
const brand = process.argv[3] || (/^neta/i.test(name) ? "NETA" : /^byd/i.test(name) ? "BYD" : "Other");
const androidVersion = parseInt(process.argv[4] || "10", 10);
const chipset = process.argv[5] || (brand === "NETA" && /u\b/i.test(name) ? "sa8155" : "unknown");
const id = slug(name);

const API = `https://api.github.com/repos/${owner}/${repo}`;
const H = (e = {}) => ({ Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "tam-addveh", "X-GitHub-Api-Version": "2022-11-28", ...e });
const r = await fetch(`${API}/contents/data/vehicles.json?ref=${branch}`, { headers: H() });
if (!r.ok) throw new Error(`get vehicles: ${r.status}`);
const j = await r.json();
const doc = JSON.parse(Buffer.from(j.content, "base64").toString("utf8"));
doc.vehicles ||= [];
if (doc.vehicles.some((v) => v.id === id)) { console.log(`vehicle "${id}" already exists — nothing to do`); process.exit(0); }
const vehicle = {
  id, name, brand, model: name.replace(brand, "").trim() || name, androidVersion,
  hardware: { chipset },
  tags: [brand.toLowerCase(), ...(brand === "NETA" ? ["tam-os"] : []), id],
};
doc.vehicles.push(vehicle);
doc.updatedAt = new Date().toISOString().slice(0, 10);
const put = await fetch(`${API}/contents/data/vehicles.json`, {
  method: "PUT", headers: H(),
  body: JSON.stringify({ message: `fleet: add vehicle ${id}`, branch, sha: j.sha, content: Buffer.from(JSON.stringify(doc, null, 2) + "\n", "utf8").toString("base64") }),
});
if (!put.ok) throw new Error(`put: ${put.status} ${await put.text()}`);
console.log(`added vehicle: ${id} (${name}) — now ${doc.vehicles.length} vehicles. Apps set to all-vehicles show on it automatically.`);
