// Client-side APK reader: extracts packageName, versionName, versionCode from an
// APK file in the browser (no upload, any size) by reading the zip's
// AndroidManifest.xml (binary AXML) and inflating it with DecompressionStream.
// Verified against real Play/store APKs. Exposes window.TamApk.parseApk(file).
(function () {
  "use strict";

  async function inflateRaw(comp) {
    const stream = new Blob([comp]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function findManifest(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const u16 = (o) => dv.getUint16(o, true), u32 = (o) => dv.getUint32(o, true);
    let eocd = -1;
    for (let i = u8.length - 22; i >= 0 && i > u8.length - 22 - 65536; i--) {
      if (u32(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("not a valid APK (no zip directory)");
    const cdOffset = u32(eocd + 16), cdCount = u16(eocd + 10);
    let p = cdOffset;
    for (let i = 0; i < cdCount; i++) {
      if (u32(p) !== 0x02014b50) break;
      const method = u16(p + 10), compSize = u32(p + 20);
      const nameLen = u16(p + 28), extraLen = u16(p + 30), commentLen = u16(p + 32), lho = u32(p + 42);
      const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
      if (name === "AndroidManifest.xml") {
        const lNameLen = u16(lho + 26), lExtraLen = u16(lho + 28);
        const dataStart = lho + 30 + lNameLen + lExtraLen;
        const comp = u8.subarray(dataStart, dataStart + compSize);
        return method === 0 ? comp : await inflateRaw(comp);
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    throw new Error("AndroidManifest.xml not found");
  }

  function decLen8(dv, o) { const b = dv.getUint8(o); return (b & 0x80) ? [((b & 0x7f) << 8) | dv.getUint8(o + 1), o + 2] : [b, o + 1]; }
  function decLen16(dv, o) { const v = dv.getUint16(o, true); return (v & 0x8000) ? [((v & 0x7fff) << 16) | dv.getUint16(o + 2, true), o + 4] : [v, o + 2]; }
  function readStr(dv, o, utf8) {
    if (utf8) { const [, o1] = decLen8(dv, o); const [blen, o2] = decLen8(dv, o1);
      return new TextDecoder("utf-8").decode(new Uint8Array(dv.buffer, dv.byteOffset + o2, blen)); }
    const [len, o1] = decLen16(dv, o); let s = "";
    for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint16(o1 + i * 2, true));
    return s;
  }
  function parseStringPool(dv, pos) {
    const u32 = (o) => dv.getUint32(o, true);
    const count = u32(pos + 8), flags = u32(pos + 16), stringsStart = u32(pos + 20);
    const utf8 = (flags & 0x100) !== 0, offsetsBase = pos + 28, dataBase = pos + stringsStart;
    const out = [];
    for (let i = 0; i < count; i++) out.push(readStr(dv, dataBase + u32(offsetsBase + i * 4), utf8));
    return out;
  }
  function parseAxml(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const u16 = (o) => dv.getUint16(o, true), u32 = (o) => dv.getUint32(o, true);
    const len = dv.byteLength;
    let strings = [], pos = 8, res = { packageName: null, versionName: null, versionCode: null };
    while (pos + 8 <= len) {
      const cType = u16(pos), cSize = u32(pos + 4);
      if (cSize < 8 || pos + cSize > len) break;
      if (cType === 0x0001) strings = parseStringPool(dv, pos);
      else if (cType === 0x0102) {
        const elName = strings[u32(pos + 20)];
        if (elName === "manifest") {
          const attrStart = u16(pos + 24), attrCount = u16(pos + 28);
          let ap = pos + 16 + attrStart;
          for (let i = 0; i < attrCount; i++) {
            const aName = u32(ap + 4), aRaw = u32(ap + 8), tvData = u32(ap + 16);
            const nm = strings[aName];
            if (nm === "package") res.packageName = aRaw !== 0xffffffff ? strings[aRaw] : null;
            else if (nm === "versionName") res.versionName = aRaw !== 0xffffffff ? strings[aRaw] : String(tvData);
            else if (nm === "versionCode") res.versionCode = tvData;
            ap += 20;
          }
          break;
        }
      }
      pos += cSize;
    }
    return res;
  }

  async function parseApk(file) {
    const u8 = new Uint8Array(await file.arrayBuffer());
    const manifest = await findManifest(u8);
    return parseAxml(manifest);
  }

  window.TamApk = { parseApk };
})();
