// TAM OS Store admin — frontend logic.
"use strict";
const $ = (s) => document.querySelector(s);
const el = (t, p = {}) => Object.assign(document.createElement(t), p);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));

let ME = null;         // { username, role, csrf }
let DATA = { apps: { apps: [] }, vehicles: { vehicles: [] }, categories: { categories: [] } };
let SELECTED_APP = null;

// ---- API helper ----
async function api(path, { method = "GET", body, form } = {}) {
  const headers = {};
  if (ME && method !== "GET") headers["x-csrf-token"] = ME.csrf;
  let payload;
  if (form) { payload = form; }
  else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const r = await fetch(path, { method, headers, body: payload, credentials: "same-origin" });
  const text = await r.text();
  let j; try { j = text ? JSON.parse(text) : {}; } catch { j = { error: text }; }
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

function flash(message, kind = "ok") {
  const m = $("#msg");
  m.innerHTML = `<div class="notice ${kind}">${esc(message)}</div>`;
  setTimeout(() => { if (m.firstChild) m.innerHTML = ""; }, 6000);
}

// ---- compatibility engine (same rules as tools/compat.mjs) ----
function matchesCriteria(v, c) {
  if (!c) return true;
  if (Array.isArray(c.chipset) && c.chipset.length) { const chip = v.hardware?.chipset; if (!chip || !c.chipset.includes(chip)) return false; }
  if (typeof c.minAndroidVersion === "number" && (v.androidVersion ?? 0) < c.minAndroidVersion) return false;
  if (Array.isArray(c.tags) && c.tags.length) { const s = new Set(v.tags || []); if (!c.tags.every((t) => s.has(t))) return false; }
  return true;
}
function isAppCompatible(app, v) {
  if (!app.enabled) return false;
  const c = app.compatibility || {};
  const gate = c.allVehicles === true || (Array.isArray(c.vehicles) && c.vehicles.includes(v.id));
  if (!gate) return false;
  if (!matchesCriteria(v, c.require)) return false;
  if (c.exclude) { if ((c.exclude.vehicles || []).includes(v.id)) return false; if ((c.exclude.tags || []).some((t) => (v.tags || []).includes(t))) return false; }
  return true;
}

// ---- auth ----
async function doLogin() {
  const username = $("#u").value.trim(), password = $("#p").value;
  $("#loginErr").classList.add("hidden");
  try {
    const r = await api("/api/login", { method: "POST", body: { username, password } });
    ME = { username: r.username, role: r.role, csrf: r.csrf };
    await enterApp();
  } catch (e) {
    $("#loginErr").textContent = e.message; $("#loginErr").classList.remove("hidden");
  }
}
async function doLogout() { try { await api("/api/logout", { method: "POST" }); } catch {} ME = null; location.reload(); }

async function enterApp() {
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#whoami").textContent = `${ME.username} · ${ME.role}`;
  document.querySelectorAll(".admin-only").forEach((e) => e.classList.toggle("hidden", ME.role !== "admin"));
  await reloadData();
}

async function reloadData() {
  try {
    DATA = await api("/api/data");
    $("#repoLine").textContent = "";
    renderUploadForm(); renderApps(); renderVehicles();
    if (ME.role === "admin") { renderUsers(); renderAudit(); }
  } catch (e) { flash("Failed to load data: " + e.message, "err"); }
}

// ---- tabs ----
document.querySelectorAll("[role=tab]").forEach((b) => b.onclick = () => {
  document.querySelectorAll("[role=tab]").forEach((x) => x.setAttribute("aria-selected", x === b));
  document.querySelectorAll("[data-pane]").forEach((p) => p.classList.toggle("hidden", p.dataset.pane !== b.dataset.tab));
});

// ---- UPLOAD ----
function vehicleCheckboxes(containerSel, selected = []) {
  const box = $(containerSel); box.innerHTML = "";
  for (const v of DATA.vehicles.vehicles || []) {
    const id = `${containerSel}-${v.id}`.replace(/[^a-z0-9-]/gi, "");
    const lbl = el("label");
    lbl.innerHTML = `<input type="checkbox" value="${esc(v.id)}" ${selected.includes(v.id) ? "checked" : ""}/> ${esc(v.name)} <span class="muted">(${esc(v.id)})</span>`;
    box.appendChild(lbl);
  }
}
function renderUploadForm() {
  const sel = $("#up-app"); sel.innerHTML = `<option value="__new__">➕ New app…</option>`;
  for (const a of DATA.apps.apps || []) sel.appendChild(el("option", { value: a.id, textContent: `${a.name} (${a.id})` }));
  const cat = $("#up-cat"); cat.innerHTML = "";
  for (const c of DATA.categories.categories || []) cat.appendChild(el("option", { value: c.id, textContent: c.name }));
  vehicleCheckboxes("#up-vehchecks");
  sel.onchange = () => {
    const isNew = sel.value === "__new__";
    $("#up-newid-wrap").style.display = isNew ? "" : "none";
    const a = (DATA.apps.apps || []).find((x) => x.id === sel.value);
    if (a) { $("#up-name").value = a.name || ""; $("#up-pkg").value = a.packageName || ""; $("#up-cat").value = a.category || ""; }
  };
  sel.onchange();
  const toggleSpec = () => $("#up-vehchecks").style.opacity = $("#up-all").checked ? ".45" : "1";
  $("#up-all").onchange = toggleSpec; $("#up-spec").onchange = toggleSpec; toggleSpec();
}

async function doUpload() {
  const sel = $("#up-app");
  const appId = sel.value === "__new__" ? $("#up-newid").value.trim() : sel.value;
  const file = $("#up-file").files[0];
  if (!appId) return flash("App id is required", "err");
  if (!file) return flash("Choose an APK file", "err");

  const allV = $("#up-all").checked;
  const chosen = [...document.querySelectorAll("#up-vehchecks input:checked")].map((x) => x.value);
  const relCompat = allV ? {} : { vehicles: chosen };
  const appCompat = allV ? { allVehicles: true, vehicles: [], require: {} } : { allVehicles: false, vehicles: chosen, require: {} };

  const fd = new FormData();
  fd.set("apk", file);
  fd.set("appId", appId);
  fd.set("name", $("#up-name").value.trim());
  fd.set("packageName", $("#up-pkg").value.trim());
  fd.set("category", $("#up-cat").value);
  fd.set("variant", $("#up-variant").value.trim() || "universal");
  fd.set("versionName", $("#up-vname").value.trim() || "0.0.0");
  fd.set("versionCode", $("#up-vcode").value || "1");
  fd.set("releaseTag", $("#up-tag").value.trim() || `${$("#up-variant").value.trim() || "universal"}-${new Date().toISOString().slice(0,7)}`);
  if ($("#up-minos").value) fd.set("minAndroidVersion", $("#up-minos").value);
  fd.set("changelog", $("#up-changelog").value.trim());
  fd.set("compatibility", JSON.stringify(relCompat));
  fd.set("appCompatibility", JSON.stringify(appCompat));

  const btn = $("#up-submit"); btn.disabled = true; btn.textContent = "Uploading…";
  $("#up-result").innerHTML = `<div class="notice ok">Uploading ${esc(file.name)} (${(file.size/1048576).toFixed(1)} MB)…</div>`;
  try {
    const r = await api("/api/upload", { method: "POST", form: fd });
    $("#up-result").innerHTML = `<div class="notice ok">✓ Uploaded. SHA-256 ${r.sha256.slice(0,16)}… · ${(r.sizeBytes/1048576).toFixed(1)} MB<br><a href="${esc(r.apkUrl)}" target="_blank">${esc(r.apkUrl)}</a></div>`;
    await reloadData();
  } catch (e) {
    $("#up-result").innerHTML = `<div class="notice err">✗ ${esc(e.message)}</div>`;
  } finally { btn.disabled = false; btn.textContent = "Upload to GitHub Releases"; }
}

// ---- APPS ----
function renderApps() {
  const box = $("#apps-list"); box.innerHTML = "";
  const t = el("table");
  t.innerHTML = `<tr><th>App</th><th>Status</th><th>Opens on</th><th>Releases</th><th></th></tr>`;
  for (const app of DATA.apps.apps || []) {
    const n = (DATA.vehicles.vehicles || []).filter((v) => isAppCompatible(app, v)).length;
    const tr = el("tr");
    tr.innerHTML = `<td><b>${esc(app.name)}</b><br><span class="muted">${esc(app.id)}</span></td>
      <td><span class="pill ${app.enabled?'on':'off'}">${app.enabled?'enabled':'disabled'}</span></td>
      <td>${app.compatibility?.allVehicles ? "all vehicles" : `${(app.compatibility?.vehicles||[]).length} selected`} · ${n} match</td>
      <td>${(app.releases||[]).length}</td>`;
    const td = el("td");
    const edit = el("button", { textContent: "Edit" }); edit.onclick = () => editApp(app.id);
    td.appendChild(edit);
    tr.appendChild(td);
    t.appendChild(tr);
  }
  box.appendChild(t);
}

function editApp(id) {
  SELECTED_APP = id;
  const app = (DATA.apps.apps || []).find((a) => a.id === id);
  if (!app) return;
  const c = app.compatibility ||= {}; c.vehicles ||= []; c.require ||= {};
  $("#app-editor-card").classList.remove("hidden");
  $("#app-editor-title").textContent = `${app.name} — ${app.id}`;
  const chipsets = [...new Set((DATA.vehicles.vehicles || []).map((v) => v.hardware?.chipset).filter(Boolean))];
  const ed = $("#app-editor");
  ed.innerHTML = `
    <label class="row"><input type="checkbox" id="e-enabled" ${app.enabled?'checked':''}/> <b>Enabled</b></label>
    <div class="row" style="margin:8px 0;">
      <label><input type="radio" name="e-scope" id="e-all" ${c.allVehicles?'checked':''}/> All TAM OS vehicles</label>
      <label><input type="radio" name="e-scope" id="e-spec" ${!c.allVehicles?'checked':''}/> Specific vehicles</label>
    </div>
    <div class="checks" id="e-vehs">${(DATA.vehicles.vehicles||[]).map((v)=>`<label><input type="checkbox" class="e-veh" value="${esc(v.id)}" ${c.vehicles.includes(v.id)?'checked':''}/> ${esc(v.name)}</label>`).join("")}</div>
    <div style="margin-top:10px;">
      <span class="muted" style="font-size:12px;">Mandatory chipset(s):</span>
      <div class="checks">${chipsets.map((ch)=>`<label><input type="checkbox" class="e-chip" value="${ch}" ${(c.require.chipset||[]).includes(ch)?'checked':''}/> ${ch}</label>`).join("")||'<span class="muted">none</span>'}</div>
    </div>
    <label class="field" style="margin-top:8px;"><span>Min Android version (mandatory)</span><input id="e-minos" type="number" min="1" value="${c.require.minAndroidVersion ?? ''}"/></label>
    <label class="field"><span>Required tags (comma)</span><input id="e-reqtags" value="${(c.require.tags||[]).join(', ')}"/></label>
    <div class="row">
      <button class="primary" id="e-save">Save compatibility</button>
      <button id="e-toggle">${app.enabled?'Disable':'Enable'} app</button>
      ${ME.role==='admin'?`<button class="danger" id="e-del">Delete app</button>`:''}
    </div>
    <div id="e-preview" style="margin-top:10px;"></div>`;
  const preview = () => {
    const tmp = JSON.parse(JSON.stringify(app));
    tmp.enabled = $("#e-enabled").checked;
    tmp.compatibility.allVehicles = $("#e-all").checked;
    tmp.compatibility.vehicles = [...ed.querySelectorAll(".e-veh:checked")].map((x)=>x.value);
    const chips = [...ed.querySelectorAll(".e-chip:checked")].map((x)=>x.value);
    tmp.compatibility.require = {};
    if (chips.length) tmp.compatibility.require.chipset = chips;
    const ma = parseInt($("#e-minos").value,10); if (!isNaN(ma)) tmp.compatibility.require.minAndroidVersion = ma;
    const tags = $("#e-reqtags").value.split(",").map((s)=>s.trim()).filter(Boolean); if (tags.length) tmp.compatibility.require.tags = tags;
    $("#e-vehs").style.opacity = tmp.compatibility.allVehicles ? ".45" : "1";
    const list = (DATA.vehicles.vehicles||[]).map((v)=>`<span class="pill ${isAppCompatible(tmp,v)?'on':'off'}" style="margin:2px;">${isAppCompatible(tmp,v)?'✓':'–'} ${esc(v.name)}</span>`).join(" ");
    $("#e-preview").innerHTML = `<span class="muted" style="font-size:12px;">Opens on:</span><br>${list}`;
    return tmp;
  };
  ed.querySelectorAll("input").forEach((i)=>i.addEventListener("change",preview));
  ed.querySelectorAll("#e-reqtags,#e-minos").forEach((i)=>i.addEventListener("input",preview));
  preview();
  $("#e-save").onclick = async () => {
    const tmp = preview();
    try {
      await api("/api/apps", { method:"POST", body: { id: app.id, enabled: tmp.enabled, compatibility: tmp.compatibility } });
      flash("Saved compatibility for " + app.id); await reloadData(); editApp(app.id);
    } catch (e) { flash(e.message, "err"); }
  };
  $("#e-toggle").onclick = async () => {
    try { await api("/api/apps", { method:"POST", body: { id: app.id, enabled: !app.enabled } }); flash("Updated"); await reloadData(); editApp(app.id); }
    catch (e) { flash(e.message, "err"); }
  };
  if ($("#e-del")) $("#e-del").onclick = async () => {
    if (!confirm(`Delete app ${app.id}? This removes it from apps.json (APK assets on Releases stay).`)) return;
    try { await api("/api/apps/"+encodeURIComponent(app.id), { method:"DELETE" }); flash("Deleted"); $("#app-editor-card").classList.add("hidden"); await reloadData(); }
    catch (e) { flash(e.message, "err"); }
  };
}

// ---- VEHICLES ----
function renderVehicles() {
  const box = $("#veh-list"); box.innerHTML = "";
  const t = el("table");
  t.innerHTML = `<tr><th>Vehicle</th><th>Brand</th><th>Android</th><th>Chipset</th><th>Tags</th><th></th></tr>`;
  for (const v of DATA.vehicles.vehicles || []) {
    const tr = el("tr");
    tr.innerHTML = `<td><b>${esc(v.name)}</b><br><span class="muted">${esc(v.id)}</span></td>
      <td>${esc(v.brand)}</td><td>${esc(v.androidVersion)}</td><td>${esc(v.hardware?.chipset||'')}</td>
      <td class="muted" style="font-size:12px;">${esc((v.tags||[]).join(', '))}</td>`;
    const td = el("td");
    const e = el("button", { textContent:"Edit" }); e.onclick = () => fillVehicle(v); td.appendChild(e);
    if (ME.role === "admin") { const d = el("button", { textContent:"Delete", className:"danger" }); d.onclick = () => delVehicle(v.id); td.appendChild(d); }
    tr.appendChild(td); t.appendChild(tr);
  }
  box.appendChild(t);
}
function fillVehicle(v) {
  $("#v-id").value=v.id; $("#v-name").value=v.name||""; $("#v-brand").value=v.brand||"";
  $("#v-model").value=v.model||""; $("#v-os").value=v.androidVersion||""; $("#v-chip").value=v.hardware?.chipset||"";
  $("#v-tags").value=(v.tags||[]).join(", ");
  document.querySelector('[data-tab=vehicles]').click();
  window.scrollTo(0,0);
}
async function saveVehicle() {
  const id = $("#v-id").value.trim();
  if (!id || !$("#v-name").value.trim()) return flash("Vehicle id and name required","err");
  const v = {
    id, name:$("#v-name").value.trim(), brand:$("#v-brand").value.trim(), model:$("#v-model").value.trim(),
    androidVersion: parseInt($("#v-os").value,10)||10,
    hardware: { chipset: $("#v-chip").value.trim() || "unknown" },
    tags: $("#v-tags").value.split(",").map((s)=>s.trim()).filter(Boolean),
  };
  try { await api("/api/vehicles", { method:"POST", body: v }); flash("Saved vehicle "+id); await reloadData(); }
  catch (e) { flash(e.message,"err"); }
}
async function delVehicle(id) {
  if (!confirm(`Delete vehicle ${id}?`)) return;
  try { await api("/api/vehicles/"+encodeURIComponent(id), { method:"DELETE" }); flash("Deleted"); await reloadData(); }
  catch (e) { flash(e.message,"err"); }
}

// ---- USERS (admin) ----
async function renderUsers() {
  const box = $("#users-list");
  try {
    const { users } = await api("/api/users");
    const t = el("table");
    t.innerHTML = `<tr><th>User</th><th>Role</th><th>Status</th><th>Last login</th><th>Actions</th></tr>`;
    for (const u of users) {
      const tr = el("tr");
      tr.innerHTML = `<td>${esc(u.username)}</td>
        <td><span class="pill ${u.role}">${u.role}</span></td>
        <td><span class="pill ${u.active?'on':'off'}">${u.active?'active':'disabled'}</span></td>
        <td class="muted">${u.last_login ? new Date(u.last_login*1000).toLocaleString() : '—'}</td>`;
      const td = el("td");
      const role = el("button", { textContent: u.role==='admin'?'Make uploader':'Make admin' });
      role.onclick = () => updUser(u.id, { role: u.role==='admin'?'uploader':'admin' });
      const act = el("button", { textContent: u.active?'Disable':'Enable' });
      act.onclick = () => updUser(u.id, { active: !u.active });
      const pw = el("button", { textContent:'Reset pw' });
      pw.onclick = () => { const p = prompt("New password (min 8)"); if (p) updUser(u.id, { password: p }); };
      const del = el("button", { textContent:'Delete', className:'danger' });
      del.onclick = () => { if (confirm(`Delete user ${u.username}?`)) delUser(u.id); };
      td.append(role, act, pw, del); tr.appendChild(td); t.appendChild(tr);
    }
    box.innerHTML = ""; box.appendChild(t);
  } catch (e) { box.innerHTML = `<div class="notice err">${esc(e.message)}</div>`; }
}
async function createUser() {
  const username=$("#nu-name").value.trim(), password=$("#nu-pass").value, role=$("#nu-role").value;
  if (!username||!password) return flash("Username and password required","err");
  try { await api("/api/users",{method:"POST",body:{username,password,role}}); flash("User created"); $("#nu-name").value="";$("#nu-pass").value=""; renderUsers(); }
  catch (e) { flash(e.message,"err"); }
}
async function updUser(id, patch) { try { await api("/api/users/"+id,{method:"POST",body:patch}); flash("Updated"); renderUsers(); } catch (e) { flash(e.message,"err"); } }
async function delUser(id) { try { await api("/api/users/"+id,{method:"DELETE"}); flash("Deleted"); renderUsers(); } catch (e) { flash(e.message,"err"); } }

// ---- AUDIT ----
async function renderAudit() {
  const box = $("#audit-list");
  try {
    const { audit } = await api("/api/audit");
    const t = el("table");
    t.innerHTML = `<tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Detail</th></tr>`;
    for (const a of audit) {
      const tr = el("tr");
      tr.innerHTML = `<td class="muted">${new Date(a.created_at*1000).toLocaleString()}</td>
        <td>${esc(a.actor)}</td><td>${esc(a.action)}</td><td>${esc(a.target||'')}</td>
        <td class="muted" style="font-size:12px;">${esc(a.detail||'')}</td>`;
      t.appendChild(tr);
    }
    box.innerHTML=""; box.appendChild(t);
  } catch (e) { box.innerHTML = `<div class="notice err">${esc(e.message)}</div>`; }
}

// ---- wiring ----
$("#loginBtn").onclick = doLogin;
$("#p").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
$("#logoutBtn").onclick = doLogout;
$("#up-submit").onclick = doUpload;
$("#v-save").onclick = saveVehicle;
$("#nu-create").onclick = createUser;

// restore session if present
(async () => {
  try {
    const me = await api("/api/me");
    if (me.authenticated) { ME = { username: me.username, role: me.role, csrf: me.csrf }; await enterApp(); }
  } catch {}
})();
