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
      compatibility: meta.compatibility || { allVehicles: false, vehicles: [], require: {} },
      releases: [],
    };
    appsDoc.apps.push(app);
  } else {
    if (meta.name) app.name = meta.name;
    if (meta.packageName) app.packageName = meta.packageName;
    if (meta.category) app.category = meta.category;
    if (meta.compatibility) app.compatibility = meta.compatibility;
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
      return json({ error: String(e.message || e) }, 500);
    }
  },
};

async function api(req, env, path) {
  const method = req.method;

  // ---- login ----
  // A local account (store admin) is tried first. Any other username is treated
  // as a DISTRIBUTOR and verified against the Neta licensing system over HTTP
  // (same username/password as the resellers there) — the store never touches
  // the licensing database, it only asks the licensing Worker to verify.
  if (path === "/api/login" && method === "POST") {
    const { username, password } = await req.json().catch(() => ({}));
    if (!username || !password) return json({ error: "username and password required" }, 400);
    const bad = () => json({ error: "invalid credentials" }, 401);

    const u = await env.DB.prepare(`SELECT * FROM users WHERE username = ?`).bind(username).first();
    if (u) {
      if (!u.active) return bad();
      if (u.locked_until > now()) return json({ error: "account locked, try later" }, 423);
      const hash = await pbkdf2(password, hexToBytes(u.pass_salt), u.pass_iter);
      if (!timingSafeEqual(hash, u.pass_hash)) {
        const tries = (u.failed_tries || 0) + 1;
        const lock = tries >= 5 ? now() + 300 : 0;
        await env.DB.prepare(`UPDATE users SET failed_tries=?, locked_until=? WHERE id=?`).bind(tries, lock, u.id).run();
        return bad();
      }
      await env.DB.prepare(`UPDATE users SET failed_tries=0, locked_until=0, last_login=? WHERE id=?`).bind(now(), u.id).run();
      const s = await createSession(env, u.username, u.role);
      return json({ ok: true, username: u.username, role: u.role, csrf: s.csrf },
        200, { "Set-Cookie": cookieHeader(s.token, s.ttl) });
    }

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
      } catch (_e) { /* fall through to invalid credentials */ }
    }
    return bad();
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
    return json({
      apps: apps.data || { apps: [] },
      vehicles: vehicles.data || { vehicles: [] },
      categories: categories.data || { categories: [] },
    });
  }

  // ---- upsert a vehicle ----
  if (path === "/api/vehicles" && method === "POST") {
    const v = await req.json();
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
      for (const k of ["name", "packageName", "category", "tags", "enabled", "compatibility", "description"]) {
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
    const appId = form.get("appId");
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
