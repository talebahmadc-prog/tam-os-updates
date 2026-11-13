// Generate a SQL INSERT for the first admin user. The password is PBKDF2-hashed
// with the same parameters the Worker uses, so it verifies at login.
//
// Usage:
//   node scripts/create-admin.mjs <username> <password> > admin.sql
//   wrangler d1 execute tam-os-store-db --remote --file=./admin.sql
//
// (Create further users — admins or uploaders — from the admin panel.)

const [username, password] = process.argv.slice(2);
if (!username || !password) {
  console.error("Usage: node scripts/create-admin.mjs <username> <password>");
  process.exit(1);
}
if (password.length < 8) { console.error("password must be >= 8 chars"); process.exit(1); }

const ITER = 100000; // must match PBKDF2_ITER in src/index.js
const enc = new TextEncoder();
const toHex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

const salt = new Uint8Array(16);
crypto.getRandomValues(salt);
const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: ITER, hash: "SHA-256" }, key, 256);
const hash = toHex(bits);
const nowSec = Math.floor(Date.now() / 1000);
const u = username.replace(/'/g, "''");

console.log(
  `INSERT INTO users (username, pass_hash, pass_salt, pass_iter, role, created_at) ` +
  `VALUES ('${u}', '${hash}', '${toHex(salt)}', ${ITER}, 'admin', ${nowSec});`,
);
