// TAM OS Store — Cloudflare Worker backend.
//
// Responsibilities:
//   * Username/password auth (PBKDF2-SHA256) with roles: 'admin' | 'uploader'.
//   * Admins manage users; uploaders + admins upload APKs and define vehicles.
//   * Uploading an APK: create/reuse a GitHub Release, upload the asset,
//     compute its SHA-256, and update data/apps.json + releases/release-index.json
//     in the public repo via the GitHub API.
//
// The GitHub token lives ONLY here, as the GITHUB_TOKEN secret. It is never
// sent to browsers and never embedded in the Android app.

const PBKDF2_ITER = 100000; // Cloudflare caps deriveBits iterations at 100000
const COOKIE = "tamsid";

// -------------------------------------------------------------------------
// small helpers
// -------------------------------------------------------------------------
const enc = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const randomHex = (n) => toHex(crypto.getRandomValues(new Uint8Array(n)));

async function sha256hex(str) {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(str)));
}
async function sha256hexBytes(bytes) {
  return toHex(await crypto.subtle.digest("SHA-256", bytes));
}
async function pbkdf2(password, saltBytes, iter) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations: iter, hash: "SHA-256" }, key, 256,
  );
  return toHex(bits);
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status, headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}
const now = () => Math.floor(Date.now() / 1000);

// ---- Factory Pass install gate: single-use codes minted per distributor --------
// A distributor mints a fresh random 6-digit code (stored in factory_codes); the
// app verifies it once (single-use), and installs are then allowed until the next
// China (UTC+8) midnight.
function fpValidUntil(ms = Date.now()) {
  const chinaMs = ms + 8 * 3600 * 1000;
  const nextDayChinaMs = (Math.floor(chinaMs / 86400000) + 1) * 86400000;
  return nextDayChinaMs - 8 * 3600 * 1000; // epoch millis of the next China midnight
}

// base64 <-> utf8 text (for GitHub Contents API)
function b64encodeUtf8(str) {
  const bytes = enc.encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64decodeUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// -------------------------------------------------------------------------
// auth / sessions
// -------------------------------------------------------------------------
function parseCookie(req, name) {
  const h = req.headers.get("cookie") || "";
  for (const part of h.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

async function currentUser(req, env) {
  const token = parseCookie(req, COOKIE);
  if (!token) return null;
  const sid = await sha256hex(token);
  const row = await env.DB.prepare(
    `SELECT id, username, role, csrf, expires_at FROM sessions WHERE id = ?`
  ).bind(sid).first();
  if (!row) return null;
  if (row.expires_at < now()) {
    await env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(sid).run();
    return null;
  }
  return { sid, csrf: row.csrf, username: row.username, role: row.role };
}

// Create a session row (self-contained: holds username + role, so it works for
// both local accounts and delegated distributor logins). Returns cookie material.
async function createSession(env, username, role) {
  const token = randomHex(32);
  const sid = await sha256hex(token);
  const csrf = randomHex(16);
  const ttl = parseInt(env.SESSION_TTL_SECONDS || "43200", 10);
  await env.DB.prepare(
    `INSERT INTO sessions (id, username, role, csrf, created_at, expires_at) VALUES (?,?,?,?,?,?)`
  ).bind(sid, username, role, csrf, now(), now() + ttl).run();
  return { token, csrf, ttl };
}

function cookieHeader(token, ttl) {
  const attrs = `Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${ttl}`;
  return `${COOKIE}=${token}; ${attrs}`;
}

async function audit(env, actor, action, target, detail) {
  await env.DB.prepare(
    `INSERT INTO audit_log (actor, action, target, detail, created_at) VALUES (?,?,?,?,?)`
  ).bind(actor, action, target || null, detail ? JSON.stringify(detail) : null, now()).run();
}

// -------------------------------------------------------------------------
// GitHub API
// -------------------------------------------------------------------------
class GitHub {
  constructor(env) {
    this.owner = env.GITHUB_OWNER;
    this.repo = env.GITHUB_REPO;
    this.branch = env.GITHUB_BRANCH || "main";
    this.token = env.GITHUB_TOKEN;
    this.base = `https://api.github.com/repos/${this.owner}/${this.repo}`;
  }
  headers(extra = {}) {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "tam-os-store",
      "X-GitHub-Api-Version": "2022-11-28",
      ...extra,
    };
  }
  async getFile(path) {
    const r = await fetch(`${this.base}/contents/${path}?ref=${this.branch}`, { headers: this.headers() });
    if (r.status === 404) return { sha: null, data: null };
    if (!r.ok) throw new Error(`GitHub getFile ${path}: ${r.status} ${await r.text()}`);
    const j = await r.json();
    return { sha: j.sha, data: JSON.parse(b64decodeUtf8(j.content)) };
  }
  async putFile(path, obj, sha, message) {
    const body = {
      message, branch: this.branch,
      content: b64encodeUtf8(JSON.stringify(obj, null, 2) + "\n"),
    };
    if (sha) body.sha = sha;
    const r = await fetch(`${this.base}/contents/${path}`, {
      method: "PUT", headers: this.headers(), body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`GitHub putFile ${path}: ${r.status} ${await r.text()}`);
    return r.json();
  }
  async ensureRelease(tag, name) {
    let r = await fetch(`${this.base}/releases/tags/${encodeURIComponent(tag)}`, { headers: this.headers() });
    if (r.ok) return r.json();
    if (r.status !== 404) throw new Error(`GitHub release lookup: ${r.status} ${await r.text()}`);
    r = await fetch(`${this.base}/releases`, {
      method: "POST", headers: this.headers(),
      body: JSON.stringify({ tag_name: tag, name: name || tag, target_commitish: this.branch }),
    });
    if (!r.ok) throw new Error(`GitHub create release: ${r.status} ${await r.text()}`);
    return r.json();
  }
  async uploadAsset(release, fileName, bytes, contentType) {
    // remove an existing asset with the same name (idempotent re-upload)
    const existing = (release.assets || []).find((a) => a.name === fileName);
    if (existing) {
      await fetch(`${this.base}/releases/assets/${existing.id}`, { method: "DELETE", headers: this.headers() });
    }
    const url = `https://uploads.github.com/repos/${this.owner}/${this.repo}/releases/${release.id}/assets?name=${encodeURIComponent(fileName)}`;
    const r = await fetch(url, {
      method: "POST",
      headers: this.headers({ "Content-Type": contentType || "application/vnd.android.package-archive" }),
      body: bytes,
    });
    if (!r.ok) throw new Error(`GitHub upload asset: ${r.status} ${await r.text()}`);
    return r.json(); // has browser_download_url
  }
}

// -------------------------------------------------------------------------
// data mutations (apps.json / vehicles.json / release-index.json)
// -------------------------------------------------------------------------
function upsertAppRelease(appsDoc, meta, release) {
  appsDoc.apps ||= [];
  let app = appsDoc.apps.find((a) => a.id === meta.appId);
  if (!app) {
    app = {
      id: meta.appId, name: meta.name || meta.appId,
      packageName: meta.packageName || "", category: meta.category || "tools",
      tags: meta.tags || [], enabled: true,
      private: !!meta.private, code: meta.code || "",
      compatibility: meta.compatibility || { allVehicles: false, vehicles: [], require: {} },
      releases: [],
    };
    appsDoc.apps.push(app);
  } else {
    if (meta.name) app.name = meta.name;
    if (meta.packageName) app.packageName = meta.packageName;
    if (meta.category) app.category = meta.category;
    if (meta.compatibility) app.compatibility = meta.compatibility;
    if (meta.private !== undefined) app.private = !!meta.private;
    if (meta.code !== undefined && meta.code !== "") app.code = meta.code;
  }
  app.releases = (app.releases || []).filter((r) => r.variant !== release.variant);
  app.releases.push(release);
  appsDoc.updatedAt = new Date().toISOString().slice(0, 10);
  return app;
}

function upsertReleaseIndex(idxDoc, tag, asset) {
  idxDoc.releases ||= [];
  let rel = idxDoc.releases.find((r) => r.tag === tag);
  if (!rel) { rel = { tag, name: tag, vehicles: [], assets: [] }; idxDoc.releases.push(rel); }
  rel.assets = (rel.assets || []).filter((a) => !(a.appId === asset.appId && a.fileName === asset.fileName));
  rel.assets.push(asset);
  idxDoc.updatedAt = new Date().toISOString().slice(0, 10);
}

// -------------------------------------------------------------------------
// router
// -------------------------------------------------------------------------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (!path.startsWith("/api/")) return env.ASSETS.fetch(req); // static (login UI, SPA)
      return await api(req, env, path);
    } catch (e) {
      console.log("api error", path, String(e && e.message || e));
      return json({ error: "internal error" }, 500);   // don't leak upstream/GitHub detail
    }
  },
};

// Per-isolate short cache for apps.json so brute-force on /api/private-app does not
// hammer the shared GitHub token (5000 req/hr) and DoS the rest of the store.
let _appsCache = { at: 0, apps: null };
async function cachedApps(env) {
  const t = Date.now();
  if (_appsCache.apps && t - _appsCache.at < 30000) return _appsCache.apps;
  const apps = (await new GitHub(env).getFile("data/apps.json")).data?.apps || [];
  _appsCache = { at: t, apps };
  return apps;
}
const clientIp = (req) => req.headers.get("cf-connecting-ip") || "0";
// Rate-limit helper: true = allowed, false = over limit. No-op when binding absent.
async function rl(env, key) {
  if (!env.RL) return true;
  try { return (await env.RL.limit({ key })).success; } catch (_e) { return true; }
}

async function api(req, env, path) {
  const method = req.method;

  // ---- login ----
  // The store has NO separate accounts: every login (distributor AND admin) is a
  // Neta licensing account (https://neta-licensing.netau.workers.dev). A reseller
  // signs in as a distributor ("uploader"); a licensing admin signs in as the store
  // admin. The store only asks the licensing Worker to verify — it never keeps its
  // own user table.
  if (path === "/api/login" && method === "POST") {
    const { username, password } = await req.json().catch(() => ({}));
    if (!username || !password) return json({ error: "username and password required" }, 400);
    const bad = () => json({ error: "invalid credentials" }, 401);

    // distributor (reseller) login — delegated to the licensing Worker through a
    // service binding (same account; a plain fetch to its workers.dev URL is
    // blocked with Cloudflare error 1042). The store calls only the licensing
    // HTTP endpoint; it has no access to the licensing database.
    if (env.LICENSING) {
      try {
        const resp = await env.LICENSING.fetch(new Request("https://licensing/api/reseller/login", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ username, password }),
        }));
        if (resp.ok) {
          const s = await createSession(env, username, "uploader");
          await audit(env, username, "login_distributor", username);
          return json({ ok: true, username, role: "uploader", csrf: s.csrf },
            200, { "Set-Cookie": cookieHeader(s.token, s.ttl) });
        }
      } catch (_e) { /* fall through */ }

      // licensing ADMIN -> store ADMIN (same account as neta-licensing /admin).
      try {
        const resp = await env.LICENSING.fetch(new Request("https://licensing/api/admin/login", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ username, password }),
        }));
        if (resp.ok) {
          const d = await resp.json().catch(() => ({}));
          if (d && d.token) {
            const s = await createSession(env, username, "admin");
            await audit(env, username, "login_admin_licensing", username);
            return json({ ok: true, username, role: "admin", csrf: s.csrf },
              200, { "Set-Cookie": cookieHeader(s.token, s.ttl) });
          }
        }
      } catch (_e) { /* fall through to invalid credentials */ }
    }
    return bad();
  }

  // ---- activate (app first-use): validate a distributor's credentials online ----
  // No session is created — the app just needs a yes/no. Delegates to the
  // licensing system (same reseller accounts) via the service binding.
  if (path === "/api/activate" && method === "POST") {
    const { code, username, password, device_id } = await req.json().catch(() => ({}));
    if (!device_id) return json({ ok: false, error: "device id required" }, 400);
    const byCode = !!code;
    if (!byCode && (!username || !password)) return json({ ok: false, error: "username and password required" }, 400);
    if (env.LICENSING) {
      try {
        // charges the 'tam-store' product (2 tokens) once per device. Either a
        // one-time distributor code, or the distributor's own credentials.
        const payload = byCode ? { code, device_id } : { username, password, device_id };
        const resp = await env.LICENSING.fetch(new Request("https://licensing/api/reseller/store-activate", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }));
        const data = await resp.json().catch(() => ({}));
        if (resp.ok && data.ok) {
          await audit(env, byCode ? "code" : username, "activate_store", device_id, { via: data.via, tokens_left: data.tokens_left, reused: !!data.reused });
          return json({ ok: true, username: username || null, via: data.via, tokens_left: data.tokens_left, distributor: data.distributor || null });
        }
        return json({ ok: false, error: data.error || "activation failed" }, resp.status || 401);
      } catch (_e) { /* fall through */ }
    }
    return json({ ok: false, error: "invalid credentials" }, 401);
  }

  // ---- PUBLIC catalog + self-update version, fresh from GitHub (no CDN cache) ----
  // The app reads these instead of raw.githubusercontent so new apps/updates and
  // store self-updates appear instantly instead of after GitHub's ~5-min CDN TTL.
  if (path === "/api/catalog" && method === "GET") {
    try {
      const g = new GitHub(env);
      const [apps, vehicles, categories] = await Promise.all([
        g.getFile("data/apps.json"), g.getFile("data/vehicles.json"), g.getFile("data/categories.json"),
      ]);
      return json({
        apps: (apps.data?.apps || []).filter((a) => !a.private),   // private apps are code-only
        vehicles: vehicles.data?.vehicles || [],
        categories: categories.data?.categories || [],
      }, 200, { "cache-control": "no-store", "access-control-allow-origin": "*" });
    } catch (_e) { return json({ error: "catalog unavailable" }, 502, { "access-control-allow-origin": "*" }); }
  }

  // ---- private app by 6-digit code ("Private apps" button in the app) ----
  if (path === "/api/private-app" && method === "POST") {
    const H = { "cache-control": "no-store", "access-control-allow-origin": "*" };
    if (!(await rl(env, "pa:" + clientIp(req)))) return json({ error: "too many attempts, slow down" }, 429, H);
    const { code } = await req.json().catch(() => ({}));
    const c = String(code || "").replace(/\D/g, "");
    if (c.length < 6) return json({ error: "bad code" }, 400, H);
    try {
      const apps = await cachedApps(env);   // cached so brute force can't exhaust the GitHub token
      const app = apps.find((a) => a.private && String(a.code || "") === c && a.enabled !== false);
      if (!app) return json({ error: "invalid code" }, 404, H);
      return json({ ok: true, app }, 200, H);
    } catch (_e) { return json({ error: "unavailable" }, 502, H); }
  }
  if (path === "/api/store-version" && method === "GET") {
    try {
      const g = new GitHub(env);
      const f = await g.getFile("releases/tam-store.json");
      return json(f.data || {}, 200, { "cache-control": "no-store", "access-control-allow-origin": "*" });
    } catch (_e) { return json({ error: "version unavailable" }, 502, { "access-control-allow-origin": "*" }); }
  }

  // ---- per-vehicle install recipe (fetched by the app; kept OUT of the APK) ----
  if (path === "/api/install-method" && method === "GET") {
    try {
      const vehicle = new URL(req.url).searchParams.get("vehicle") || "";
      const g = new GitHub(env);
      let cfg = {};
      try { cfg = (await g.getFile("data/install-methods.json")).data || {}; } catch (_e) { /* use defaults */ }
      const def = cfg.default || { installer: "session", installerPackage: "", reinstall: true, allowDowngrade: true, grantAll: true };
      const veh = (cfg.vehicles && cfg.vehicles[vehicle]) || {};
      return json({ ok: true, vehicle, recipe: { ...def, ...veh } }, 200, { "cache-control": "no-store", "access-control-allow-origin": "*" });
    } catch (_e) { return json({ error: "unavailable" }, 502, { "access-control-allow-origin": "*" }); }
  }

  // ---- distributor contact (name + phone) by username, for the app's Factory Pass screen ----
  if (path === "/api/distributor" && method === "GET") {
    const username = new URL(req.url).searchParams.get("username") || "";
    const H = { "cache-control": "no-store", "access-control-allow-origin": "*" };
    if (!(await rl(env, "dist:" + clientIp(req)))) return json({ ok: false, error: "rate limited" }, 429, H);
    if (!username) return json({ ok: false, error: "bad request" }, 400, H);
    if (!env.STORE_BRIDGE_SECRET || !env.LICENSING) return json({ ok: false }, 200, H);
    try {
      const resp = await env.LICENSING.fetch(new Request("https://licensing/api/reseller/store-distributor", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Store-Bridge": env.STORE_BRIDGE_SECRET },
        body: JSON.stringify({ username }),
      }));
      const data = await resp.json().catch(() => ({}));
      if (resp.ok && data.ok) return json({ ok: true, name: data.name, phone: data.phone }, 200, H);
      return json({ ok: false }, 200, H);
    } catch (_e) { return json({ ok: false }, 200, H); }
  }

  // ---- online license re-check: the app calls this on launch to stay activated ----
  // Makes the platform authoritative: a device is "active" only if the licensing
  // system still has a tam-store activation for it (by device_id OR VIN) and the
  // distributor account is active. Editing local prefs cannot fake this.
  if (path === "/api/check" && method === "POST") {
    const H = { "cache-control": "no-store", "access-control-allow-origin": "*" };
    const { device_id, vin } = await req.json().catch(() => ({}));
    if (!device_id) return json({ active: false, error: "bad request" }, 400, H);
    if (!env.STORE_BRIDGE_SECRET || !env.LICENSING) return json({ active: false, error: "unavailable" }, 200, H);
    try {
      const resp = await env.LICENSING.fetch(new Request("https://licensing/api/reseller/store-check", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Store-Bridge": env.STORE_BRIDGE_SECRET },
        body: JSON.stringify({ device_id, vin: vin || "" }),
      }));
      const data = await resp.json().catch(() => ({}));
      return json({ active: !!data.active, distributor: data.distributor || null }, 200, H);
    } catch (_e) { return json({ active: false, error: "unreachable" }, 200, H); }
  }

  // ---- APP verifies a factory code: single-use, 24h, minted by a distributor ----
  if (path === "/api/factory-pass/verify" && method === "POST") {
    const H = { "cache-control": "no-store", "access-control-allow-origin": "*" };
    if (!(await rl(env, "fp:" + clientIp(req)))) return json({ ok: false, error: "rate limited" }, 429, H);
    const b = await req.json().catch(() => ({}));
    const vin = String(b.vin || "").trim().toUpperCase();
    const code = String(b.code || "").replace(/\D/g, "");
    const vehicle = String(b.vehicle || "").trim();
    if (code.length < 4) return json({ ok: false, error: "bad input" }, 400, H);
    const nowS = now();
    const row = await env.DB.prepare("SELECT vin, expires_at, used_at FROM factory_codes WHERE code=?").bind(code).first();
    if (!row || row.used_at || row.expires_at <= nowS) return json({ ok: false }, 200, H);
    // NOTE: we intentionally do NOT reject on a VIN mismatch. The code's VIN (if any)
    // is informational only — "one vehicle only" is guaranteed by single-use + 24h,
    // not by matching the head-unit's VIN (which often differs by a char from what the
    // distributor typed, and the distributor shouldn't be forced to type it at all).
    // single-use: claim atomically
    const claim = await env.DB.prepare("UPDATE factory_codes SET used_at=? WHERE code=? AND used_at IS NULL").bind(nowS, code).run();
    if (!claim.meta || claim.meta.changes !== 1) return json({ ok: false }, 200, H);
    // The 6-digit gate was valid & claimed. Now hand the app the REAL head-unit
    // factory code (dev_adb_auth_passwd), derived server-side from VIN + China date
    // (last 9 chars of base64(AES-ECB(VIN+YYYYMMDD, FACTORY_KEY))). The licensing
    // worker holds FACTORY_KEY; this no-charge bridge returns the same value the old
    // FactoryTool produced. The app writes it to the vehicle to unlock installs.
    // Only released against a just-redeemed single-use code, and only for a real
    // 17-char VIN (the AES input must be exact or the code won't match the car).
    // Scope: only vehicles on the server's factoryCodeVehicles list need it (e.g.
    // NETA U large-screen / V / Aya). For any other vehicle we return no code and
    // the app writes nothing. The list lives in data/install-methods.json (never
    // baked into the APK). Fail-safe: if the list can't be read, we write nothing.
    let factory_code = null;
    let needsFactory = false;
    try {
      const g = new GitHub(env);
      const cfg = (await g.getFile("data/install-methods.json")).data || {};
      needsFactory = Array.isArray(cfg.factoryCodeVehicles) && cfg.factoryCodeVehicles.includes(vehicle);
    } catch (_e) { /* config unreadable → no factory code (safe default) */ }
    if (needsFactory && env.STORE_BRIDGE_SECRET && env.LICENSING && /^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) {
      try {
        const resp = await env.LICENSING.fetch(new Request("https://licensing/api/reseller/store-factory", {
          method: "POST",
          headers: { "content-type": "application/json", "X-Store-Bridge": env.STORE_BRIDGE_SECRET },
          body: JSON.stringify({ vin }),
        }));
        const d = await resp.json().catch(() => ({}));
        if (d && d.ok && d.code) factory_code = d.code;
      } catch (_e) { /* licensing unreachable — the gate still passed */ }
    }
    return json({ ok: true, valid_until: fpValidUntil(), factory_code }, 200, H);
  }

  // ---- distributor mints a NEW single-use factory code (fresh each time, valid 24h) ----
  if (path === "/api/factory-pass/create" && method === "POST") {
    const u = await currentUser(req, env);
    if (!u) return json({ error: "unauthorized" }, 401);
    const b = await req.json().catch(() => ({}));
    const vin = String(b.vin || "").trim().toUpperCase() || null;   // optional: bind to one vehicle
    const nowS = now();
    const expires = nowS + 24 * 3600;
    let code = null;
    for (let i = 0; i < 8; i++) {
      const c = String(Math.floor(100000 + Math.random() * 900000));  // 6 random digits
      const live = await env.DB.prepare("SELECT 1 FROM factory_codes WHERE code=? AND used_at IS NULL AND expires_at>?").bind(c, nowS).first();
      if (!live) { code = c; break; }
    }
    if (!code) return json({ error: "try again" }, 503);
    await env.DB.prepare("INSERT OR REPLACE INTO factory_codes (code, vin, created_by, created_at, expires_at, used_at) VALUES (?,?,?,?,?,NULL)")
      .bind(code, vin, u.username, nowS, expires).run();
    await audit(env, u.username, "factory_code_create", code, { vin: vin || "any" });
    return json({ ok: true, code, vin: vin || "", scope: vin ? "vin" : "any", expires_at: expires * 1000 });
  }

  // ---- a distributor's own codes (factory + activation) with live status ----
  if (path === "/api/my-codes" && method === "GET") {
    const u = await currentUser(req, env);
    if (!u) return json({ error: "unauthorized" }, 401);
    const fc = await env.DB.prepare(
      "SELECT code, vin, created_at*1000 AS created_ms, expires_at*1000 AS expires_ms, " +
      "CASE WHEN used_at IS NULL THEN NULL ELSE used_at*1000 END AS used_ms " +
      "FROM factory_codes WHERE created_by=? ORDER BY created_at DESC LIMIT 300"
    ).bind(u.username).all();
    const factory = (fc.results || []).map((r) => ({ ...r, type: "factory" }));
    let activation = [];
    if (env.STORE_BRIDGE_SECRET && env.LICENSING) {
      try {
        const resp = await env.LICENSING.fetch(new Request("https://licensing/api/reseller/store-codes-list", {
          method: "POST",
          headers: { "content-type": "application/json", "X-Store-Bridge": env.STORE_BRIDGE_SECRET },
          body: JSON.stringify({ username: u.username }),
        }));
        const d = await resp.json().catch(() => ({}));
        activation = (d.codes || []).map((r) => ({ ...r, type: "activation" }));
      } catch (_e) { /* licensing unreachable */ }
    }
    return json({ ok: true, factory, activation });
  }

  // ---- distributor mints a one-time activation code (24h, single use) ----
  // Needs a logged-in distributor session (an uploader = a reseller account).
  // The charge happens later, in /api/activate, when the code is used.
  if (path === "/api/store-code/create" && method === "POST") {
    const u = await currentUser(req, env);
    if (!u) return json({ error: "unauthorized" }, 401);
    if (u.role !== "uploader") return json({ error: "only distributor accounts can create activation codes" }, 403);
    if (!env.STORE_BRIDGE_SECRET) return json({ error: "server not configured for codes" }, 500);
    if (!env.LICENSING) return json({ error: "licensing unavailable" }, 500);
    const b = await req.json().catch(() => ({}));
    const vin = typeof b.vin === "string" ? b.vin : "";
    const products = Array.isArray(b.products) ? b.products : [];
    try {
      const resp = await env.LICENSING.fetch(new Request("https://licensing/api/reseller/store-code-create", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Store-Bridge": env.STORE_BRIDGE_SECRET },
        body: JSON.stringify({ username: u.username, vin, products }),
      }));
      const data = await resp.json().catch(() => ({}));
      if (resp.ok && data.ok) {
        await audit(env, u.username, "store_code_create", data.code, { vin: data.vin, services: (data.services || []).map((s) => s.key), total: data.total });
        return json({ ok: true, code: data.code, expires_at: data.expires_at, vin: data.vin, services: data.services, total: data.total });
      }
      return json({ error: data.error || "could not create code" }, resp.status || 400);
    } catch (_e) { return json({ error: "licensing unavailable" }, 502); }
  }

  // ---- services (licensing products) a distributor can put on a code ----
  if (path === "/api/store-products" && method === "GET") {
    const u = await currentUser(req, env);
    if (!u) return json({ error: "unauthorized" }, 401);
    if (u.role !== "uploader") return json({ ok: true, products: [] });
    if (!env.STORE_BRIDGE_SECRET || !env.LICENSING) return json({ ok: true, products: [] });
    try {
      const resp = await env.LICENSING.fetch(new Request("https://licensing/api/reseller/store-products", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Store-Bridge": env.STORE_BRIDGE_SECRET },
        body: JSON.stringify({ username: u.username }),
      }));
      const data = await resp.json().catch(() => ({}));
      if (resp.ok && data.ok) return json({ ok: true, products: data.products || [] });
      return json({ ok: true, products: [] });
    } catch (_e) { return json({ ok: true, products: [] }); }
  }

  // everything below needs a session
  const user = await currentUser(req, env);
  if (path === "/api/me") {
    if (!user) return json({ authenticated: false }, 200);
    return json({ authenticated: true, username: user.username, role: user.role, csrf: user.csrf });
  }
  if (!user) return json({ error: "unauthorized" }, 401);

  // CSRF for mutating requests
  if (method !== "GET") {
    const tok = req.headers.get("x-csrf-token");
    if (!tok || !timingSafeEqual(tok, user.csrf)) return json({ error: "bad csrf" }, 403);
  }
  const isAdmin = user.role === "admin";
  const needAdmin = () => json({ error: "admin only" }, 403);

  // ---- logout ----
  if (path === "/api/logout" && method === "POST") {
    await env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(user.sid).run();
    return json({ ok: true }, 200, { "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
  }

  // ---- read current data (from GitHub) ----
  const gh = new GitHub(env);
  if (path === "/api/data" && method === "GET") {
    const [apps, vehicles, categories] = await Promise.all([
      gh.getFile("data/apps.json"), gh.getFile("data/vehicles.json"), gh.getFile("data/categories.json"),
    ]);
    let appsDoc = apps.data || { apps: [] };
    // Non-admins (distributors) must NOT see private apps or their install codes.
    if (!isAdmin) {
      appsDoc = { ...appsDoc, apps: (appsDoc.apps || []).filter((a) => !a.private).map(({ code, ...rest }) => rest) };
    }
    return json({
      apps: appsDoc,
      vehicles: vehicles.data || { vehicles: [] },
      categories: categories.data || { categories: [] },
    });
  }

  // ---- upsert a vehicle ----
  if (path === "/api/vehicles" && method === "POST") {
    const v = await req.json();
    if (v && v.id) v.id = slugId(v.id);
    if (!v.id || !v.name) return json({ error: "vehicle id and name required" }, 400);
    const f = await gh.getFile("data/vehicles.json");
    const doc = f.data || { schemaVersion: 1, vehicles: [] };
    doc.vehicles = (doc.vehicles || []).filter((x) => x.id !== v.id);
    doc.vehicles.push(v);
    doc.updatedAt = new Date().toISOString().slice(0, 10);
    await gh.putFile("data/vehicles.json", doc, f.sha, `admin: upsert vehicle ${v.id} (${user.username})`);
    await audit(env, user.username, "edit_vehicle", v.id, { name: v.name });
    return json({ ok: true });
  }
  if (path.startsWith("/api/vehicles/") && method === "DELETE") {
    if (!isAdmin) return needAdmin();
    const id = decodeURIComponent(path.split("/").pop());
    const f = await gh.getFile("data/vehicles.json");
    const doc = f.data || { vehicles: [] };
    doc.vehicles = (doc.vehicles || []).filter((x) => x.id !== id);
    await gh.putFile("data/vehicles.json", doc, f.sha, `admin: delete vehicle ${id} (${user.username})`);
    await audit(env, user.username, "delete_vehicle", id);
    return json({ ok: true });
  }

  // ---- upsert app metadata / compatibility (no file) ----
  if (path === "/api/apps" && method === "POST") {
    const body = await req.json();
    if (body && body.id) body.id = slugId(body.id);
    if (!body.id) return json({ error: "app id required" }, 400);
    const f = await gh.getFile("data/apps.json");
    const doc = f.data || { schemaVersion: 1, apps: [] };
    let app = (doc.apps ||= []).find((a) => a.id === body.id);
    if (!app) {
      app = { id: body.id, name: body.name || body.id, packageName: body.packageName || "",
        category: body.category || "tools", tags: body.tags || [], enabled: body.enabled ?? true,
        compatibility: body.compatibility || { allVehicles: false, vehicles: [], require: {} }, releases: [] };
      doc.apps.push(app);
    } else {
      for (const k of ["name", "packageName", "category", "tags", "enabled", "compatibility", "description", "private", "code"]) {
        if (body[k] !== undefined) app[k] = body[k];
      }
    }
    doc.updatedAt = new Date().toISOString().slice(0, 10);
    await gh.putFile("data/apps.json", doc, f.sha, `admin: edit app ${body.id} (${user.username})`);
    await audit(env, user.username, "edit_app", body.id);
    return json({ ok: true });
  }
  if (path.startsWith("/api/apps/") && method === "DELETE") {
    if (!isAdmin) return needAdmin();
    const id = decodeURIComponent(path.split("/").pop());
    const f = await gh.getFile("data/apps.json");
    const doc = f.data || { apps: [] };
    doc.apps = (doc.apps || []).filter((a) => a.id !== id);
    await gh.putFile("data/apps.json", doc, f.sha, `admin: delete app ${id} (${user.username})`);
    await audit(env, user.username, "delete_app", id);
    return json({ ok: true });
  }

  // ---- upload an APK -> GitHub Release + apps.json + release-index.json ----
  if (path === "/api/upload" && method === "POST") {
    const form = await req.formData();
    const file = form.get("apk");
    const appId = slugId(form.get("appId") || "");
    if (!file || typeof file === "string") return json({ error: "apk file required" }, 400);
    if (!appId) return json({ error: "appId required" }, 400);
    const variant = form.get("variant") || "universal";
    const versionName = form.get("versionName") || "0.0.0";
    const versionCode = parseInt(form.get("versionCode") || "1", 10);
    const releaseTag = form.get("releaseTag") || `${variant}-${new Date().toISOString().slice(0, 7)}`;
    const minAndroidVersion = form.get("minAndroidVersion") ? parseInt(form.get("minAndroidVersion"), 10) : undefined;
    const changelog = form.get("changelog") || "";
    const relCompat = safeJson(form.get("compatibility"));
    const appMeta = {
      appId,
      name: form.get("name") || undefined,
      packageName: form.get("packageName") || undefined,
      category: form.get("category") || undefined,
      compatibility: safeJson(form.get("appCompatibility")) || undefined,
      private: form.get("private") === "true",
      code: (form.get("code") || "").trim(),
    };

    const bytes = new Uint8Array(await file.arrayBuffer());
    const sha256 = await sha256hexBytes(bytes);
    const fileName = file.name || `${appId}-${versionName}.apk`;

    const release = await gh.ensureRelease(releaseTag, releaseTag);
    const asset = await gh.uploadAsset(release, fileName, bytes, "application/vnd.android.package-archive");

    const relEntry = {
      variant, versionCode, versionName, releaseTag,
      apkFileName: fileName, apkUrl: asset.browser_download_url,
      published: true, sha256, sizeBytes: bytes.length,
      ...(minAndroidVersion ? { minAndroidVersion } : {}),
      ...(relCompat ? { compatibility: relCompat } : {}),
      changelog, updatedAt: new Date().toISOString().slice(0, 10),
    };

    const appsF = await gh.getFile("data/apps.json");
    const appsDoc = appsF.data || { schemaVersion: 1, apps: [] };
    upsertAppRelease(appsDoc, appMeta, relEntry);
    await gh.putFile("data/apps.json", appsDoc, appsF.sha, `upload: ${appId} ${versionName} (${user.username})`);

    const idxF = await gh.getFile("releases/release-index.json");
    const idxDoc = idxF.data || { schemaVersion: 1, releases: [] };
    upsertReleaseIndex(idxDoc, releaseTag, {
      appId, fileName, versionName, versionCode, published: true, sha256,
      sizeBytes: bytes.length, url: asset.browser_download_url,
    });
    await gh.putFile("releases/release-index.json", idxDoc, idxF.sha, `upload index: ${appId} ${versionName} (${user.username})`);

    await audit(env, user.username, "upload_apk", appId, { versionName, versionCode, releaseTag, sha256, sizeBytes: bytes.length });
    return json({ ok: true, apkUrl: asset.browser_download_url, sha256, sizeBytes: bytes.length });
  }

  // ---- user management (admin only) ----
  if (path === "/api/users" && method === "GET") {
    if (!isAdmin) return needAdmin();
    const { results } = await env.DB.prepare(
      `SELECT id, username, role, active, created_at, last_login FROM users ORDER BY id`
    ).all();
    return json({ users: results });
  }
  if (path === "/api/users" && method === "POST") {
    if (!isAdmin) return needAdmin();
    const { username, password, role } = await req.json();
    if (!username || !password) return json({ error: "username and password required" }, 400);
    if (password.length < 8) return json({ error: "password must be >= 8 chars" }, 400);
    if (!["admin", "uploader"].includes(role)) return json({ error: "role must be admin or uploader" }, 400);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await pbkdf2(password, salt, PBKDF2_ITER);
    try {
      await env.DB.prepare(
        `INSERT INTO users (username, pass_hash, pass_salt, pass_iter, role, created_at) VALUES (?,?,?,?,?,?)`
      ).bind(username, hash, toHex(salt), PBKDF2_ITER, role, now()).run();
    } catch (e) {
      return json({ error: "username already exists" }, 409);
    }
    await audit(env, user.username, "user_create", username, { role });
    return json({ ok: true });
  }
  if (path.startsWith("/api/users/") && method === "POST") {
    if (!isAdmin) return needAdmin();
    const id = parseInt(path.split("/").pop(), 10);
    const body = await req.json();
    if (body.password) {
      if (body.password.length < 8) return json({ error: "password must be >= 8 chars" }, 400);
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const hash = await pbkdf2(body.password, salt, PBKDF2_ITER);
      await env.DB.prepare(`UPDATE users SET pass_hash=?, pass_salt=?, pass_iter=?, failed_tries=0, locked_until=0 WHERE id=?`)
        .bind(hash, toHex(salt), PBKDF2_ITER, id).run();
    }
    if (body.role && ["admin", "uploader"].includes(body.role))
      await env.DB.prepare(`UPDATE users SET role=? WHERE id=?`).bind(body.role, id).run();
    if (body.active !== undefined)
      await env.DB.prepare(`UPDATE users SET active=? WHERE id=?`).bind(body.active ? 1 : 0, id).run();
    await audit(env, user.username, "user_update", String(id), { role: body.role, active: body.active, passwordReset: !!body.password });
    return json({ ok: true });
  }
  if (path.startsWith("/api/users/") && method === "DELETE") {
    if (!isAdmin) return needAdmin();
    const id = parseInt(path.split("/").pop(), 10);
    const target = await env.DB.prepare(`SELECT username FROM users WHERE id = ?`).bind(id).first();
    if (target && target.username === user.username) return json({ error: "cannot delete yourself" }, 400);
    if (target) await env.DB.prepare(`DELETE FROM sessions WHERE username = ?`).bind(target.username).run();
    await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(id).run();
    await audit(env, user.username, "user_delete", String(id));
    return json({ ok: true });
  }

  // ---- audit log (admin) ----
  if (path === "/api/audit" && method === "GET") {
    if (!isAdmin) return needAdmin();
    const { results } = await env.DB.prepare(
      `SELECT actor, action, target, detail, created_at FROM audit_log ORDER BY id DESC LIMIT 200`
    ).all();
    return json({ audit: results });
  }

  return json({ error: "not found" }, 404);
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function safeJson(s) { if (!s) return null; try { return JSON.parse(s); } catch { return null; } }
function slugId(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-+/g, "-"); }
