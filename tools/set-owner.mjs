// TAM OS — replace the GitHub owner/repo across the whole repository in one step.
// No external dependencies.
//
// Usage:
//   node tools/set-owner.mjs <newOwner> [newRepo]
//   node tools/set-owner.mjs my-github-user
//   node tools/set-owner.mjs my-github-user my-repo-name
//
// It reads the CURRENT owner/repo from config.json and replaces every
// occurrence in config.json, data/*.json, releases/*.json, admin/*.html,
// examples/*.kt and README.md.

import { readFile, writeFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const newOwner = process.argv[2];
const newRepo = process.argv[3];
if (!newOwner) {
  console.error("Usage: node tools/set-owner.mjs <newOwner> [newRepo]");
  process.exit(1);
}

const config = JSON.parse(await readFile(join(ROOT, "config.json"), "utf8"));
const oldOwner = config.owner;
const oldRepo = config.repo;
const repo = newRepo || oldRepo;

const targets = [
  "config.json",
  "README.md",
  "data/apps.json",
  "data/vehicles.json",
  "data/categories.json",
  "releases/release-index.json",
];
for (const dir of ["schema", "admin", "examples"]) {
  try {
    const files = await readdir(join(ROOT, dir));
    for (const f of files) targets.push(join(dir, f));
  } catch {}
}

const fromPath = `${oldOwner}/${oldRepo}`;
const toPath = `${newOwner}/${repo}`;
let changed = 0;

for (const rel of targets) {
  let text;
  try {
    text = await readFile(join(ROOT, rel), "utf8");
  } catch {
    continue;
  }
  let out = text.split(fromPath).join(toPath);
  // config.json owner/repo fields
  if (rel === "config.json") {
    out = out
      .replace(new RegExp(`("owner":\\s*)"${oldOwner}"`), `$1"${newOwner}"`)
      .replace(new RegExp(`("repo":\\s*)"${oldRepo}"`), `$1"${repo}"`);
  }
  if (out !== text) {
    await writeFile(join(ROOT, rel), out, "utf8");
    changed++;
    console.log(`updated ${rel}`);
  }
}

console.log(`\nReplaced "${fromPath}" -> "${toPath}" in ${changed} file(s).`);
console.log("Run: node tools/validate.mjs");
