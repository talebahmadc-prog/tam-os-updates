// TAM OS — compatibility engine (reference implementation in JavaScript).
// Mirrors the Kotlin logic in examples/. No external dependencies.
//
// Usage:
//   node tools/compat.mjs <vehicleId>
//   node tools/compat.mjs neta-u
//
// Prints the apps compatible with the given vehicle and the chosen release
// (APK variant) for each.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function loadData() {
  const [apps, vehicles, categories] = await Promise.all([
    readFile(join(ROOT, "data/apps.json"), "utf8").then(JSON.parse),
    readFile(join(ROOT, "data/vehicles.json"), "utf8").then(JSON.parse),
    readFile(join(ROOT, "data/categories.json"), "utf8").then(JSON.parse),
  ]);
  return { apps: apps.apps, vehicles: vehicles.vehicles, categories: categories.categories };
}

// Does a vehicle satisfy a `require`/`criteria` block? All present rules must pass.
function matchesCriteria(vehicle, criteria) {
  if (!criteria) return true;
  if (Array.isArray(criteria.chipset) && criteria.chipset.length > 0) {
    const chipset = vehicle.hardware?.chipset;
    if (!chipset || !criteria.chipset.includes(chipset)) return false;
  }
  if (typeof criteria.minAndroidVersion === "number") {
    if ((vehicle.androidVersion ?? 0) < criteria.minAndroidVersion) return false;
  }
  if (Array.isArray(criteria.tags) && criteria.tags.length > 0) {
    const set = new Set(vehicle.tags || []);
    if (!criteria.tags.every((t) => set.has(t))) return false;
  }
  return true;
}

function isExcluded(vehicle, exclude) {
  if (!exclude) return false;
  if (Array.isArray(exclude.vehicles) && exclude.vehicles.includes(vehicle.id)) return true;
  if (Array.isArray(exclude.tags) && exclude.tags.length > 0) {
    const set = new Set(vehicle.tags || []);
    if (exclude.tags.some((t) => set.has(t))) return true;
  }
  return false;
}

// Multi-criteria compatibility: NOT a single-tag match.
// 1) app must be enabled
// 2) vehicle gate: allVehicles OR vehicle.id listed
// 3) all mandatory `require` rules must pass
// 4) `exclude` must not match
export function isAppCompatible(app, vehicle) {
  if (!app.enabled) return false;
  const c = app.compatibility || {};
  const gate = c.allVehicles === true || (Array.isArray(c.vehicles) && c.vehicles.includes(vehicle.id));
  if (!gate) return false;
  if (!matchesCriteria(vehicle, c.require)) return false;
  if (isExcluded(vehicle, c.exclude)) return false;
  return true;
}

// Pick the best release (APK variant) for a vehicle:
//   prefer a release that explicitly lists the vehicle,
//   then one that matches by require rules,
//   then a generic release; highest versionCode breaks ties.
export function pickRelease(app, vehicle) {
  const candidates = (app.releases || []).filter((r) => {
    const rc = r.compatibility || {};
    if (Array.isArray(rc.vehicles) && rc.vehicles.length > 0) {
      if (rc.vehicles.includes(vehicle.id)) return true;
    }
    if (!matchesCriteria(vehicle, rc.require)) return false;
    return true;
  });
  if (candidates.length === 0) return null;
  const score = (r) => {
    const rc = r.compatibility || {};
    let s = 0;
    if (Array.isArray(rc.vehicles) && rc.vehicles.includes(vehicle.id)) s += 100;
    if (rc.require && Object.keys(rc.require).length > 0) s += 10;
    return s * 1_000_000 + (r.versionCode || 0);
  };
  return candidates.sort((a, b) => score(b) - score(a))[0];
}

export function compatibleApps(apps, vehicle) {
  const out = [];
  for (const app of apps) {
    if (!isAppCompatible(app, vehicle)) continue;
    const release = pickRelease(app, vehicle);
    if (!release) continue;
    out.push({ app, release });
  }
  return out;
}

// CLI
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("compat.mjs")) {
  const vehicleId = process.argv[2];
  const { apps, vehicles } = await loadData();
  if (!vehicleId) {
    console.log("Vehicles:", vehicles.map((v) => v.id).join(", "));
    console.log("Usage: node tools/compat.mjs <vehicleId>");
    process.exit(0);
  }
  const vehicle = vehicles.find((v) => v.id === vehicleId);
  if (!vehicle) {
    console.error(`Unknown vehicle "${vehicleId}". Known: ${vehicles.map((v) => v.id).join(", ")}`);
    process.exit(1);
  }
  const result = compatibleApps(apps, vehicle);
  console.log(`\nCompatible apps for ${vehicle.name} (${vehicle.id}):`);
  if (result.length === 0) console.log("  (none)");
  for (const { app, release } of result) {
    const pub = release.published ? "" : "  [not yet published]";
    console.log(`  - ${app.name} (${app.id})  v${release.versionName} / code ${release.versionCode}  tag=${release.releaseTag}${pub}`);
  }
  console.log("");
}
