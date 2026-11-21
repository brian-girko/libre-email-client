// zip.mjs — the explorer's zero-dependency ZIP writer ("Create ZIP
// Archive"). Builds a classic (non-ZIP64) archive in memory out of Blob
// parts: STORED (method 0) and DEFLATED (method 8) entries, the deflate
// stream coming from the platform's CompressionStream('deflate-raw') with a
// transparent fallback to STORED whenever compression is unavailable or
// does not actually shrink the bytes. UTF-8 entry names (general-purpose
// flag bit 11), MS-DOS timestamps taken from each file's lastModified.
//
// No imports on purpose: the file access flows in as the fs gateway facade
// (core/fs.mjs) the caller already prepared — reader.list/reader.read are
// the only members used — so the module also runs under plain node for
// zip.test.mjs behind a fake facade.
//
// The Maildir layout rules (collectMaildir): everything under the maildir
// directory except the tmp/ scratch FILES and the rebuildable .headers.json
// cache — cur/, new/ and tmp/ ship as directory entries even when empty
// (the complete maildir shape; tmp/ carries no files), and .uidvalidity
// rides along so a restored copy keeps its UIDVALIDITY identity. Entry
// names are rooted at the maildir's own name, so unzipping into an account
// directory restores it in place.
//
// Classic ZIP limits (no ZIP64): 65535 entries, entry sizes and archive
// offsets under 4 GB — exceeding them throws a plain-worded error instead
// of producing a truncated archive.

'use strict';

// ------------------------------------------------------------------ crc-32

// The ZIP checksum, IEEE CRC-32 (polynomial 0xEDB88320, reflected), as the
// standard 256-entry table walk.
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[n] = c >>> 0;
}

/** IEEE CRC-32 of the given bytes (the checksum every ZIP entry carries) */
export function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ------------------------------------------------------------------ deflate

/**
 * Raw-deflate bytes through the platform's CompressionStream — exactly what
 * a ZIP method-8 entry stores. null when the API is missing or the format
 * is not supported (the caller then keeps the STORED entry).
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array|null>}
 */
async function deflateRaw(bytes) {
  if (typeof CompressionStream !== 'function') {
    return null;
  }
  try {
    const stream = new Blob([bytes]).stream()
      .pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  catch {
    return null;
  }
}

// ------------------------------------------------------------------ names

/**
 * ZIP entry names are '/'-separated UTF-8. Maildir and file names come out
 * of the storage so they cannot contain '/', but backslashes and control
 * characters would still corrupt the archive's structure — they flatten
 * away.
 */
function sanitizeName(name) {
  return String(name)
    .replaceAll('\\', '_')
    .replace(/[\u0000-\u001F\u007F]/g, '');
}

// ------------------------------------------------------------------ dos time

/** MS-DOS date/time words (local time, 2-second resolution) for a stamp */
function dosDateTime(ms) {
  const n = Number(ms);
  const d = new Date(Number.isFinite(n) && n > 0 ? n : Date.now());
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  return {
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
  };
}

// ------------------------------------------------------------------ builder

const U16_MAX = 0xFFFF;
const U32_MAX = 0xFFFFFFFF;
const UTF8_FLAG = 0x0800;        // general-purpose bit 11: the name is UTF-8
const SIG_LOCAL = 0x04034b50;    // 'PK\x03\x04'
const SIG_CENTRAL = 0x02014b50;  // 'PK\x01\x02'
const SIG_EOCD = 0x06054b50;     // 'PK\x05\x06'

/**
 * Accumulates one classic ZIP archive as Blob parts and hands out the
 * finished Blob. Entries are added in full (sizes and CRC known upfront),
 * so no data descriptors are needed; the central directory and the end
 * record are appended by finish().
 */
export class ZipBuilder {
  #parts = [];
  #offset = 0;
  #central = [];
  #centralSize = 0;
  #entries = 0;
  #names = new Set();

  /** adds a directory entry (a trailing '/' is added when missing) */
  addDirectory(name, {lastModified} = {}) {
    name = sanitizeName(name);
    if (!name.endsWith('/')) {
      name += '/';
    }
    this.#add(name, new Uint8Array(0), {dir: true, lastModified});
  }

  /**
   * adds one file. DEFLATE is tried first and kept when it actually
   * shrinks the bytes; {compress: false} forces the STORED method.
   * @param {string} name '/'-separated archive path
   * @param {Uint8Array|ArrayBuffer} data the file's bytes
   * @param {{lastModified?: number, compress?: boolean}} [opts]
   */
  async addFile(name, data, {lastModified, compress = true} = {}) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    let method = 0;
    let payload = bytes;
    if (compress && bytes.length) {
      const deflated = await deflateRaw(bytes);
      if (deflated && deflated.length < bytes.length) {
        method = 8;
        payload = deflated;
      }
    }
    this.#add(sanitizeName(name), payload, {
      method,
      uncompressed: bytes.length,
      crc: crc32(bytes),
      lastModified
    });
  }

  /**
   * @param {string} name the SANITIZED entry name (directories carry '/')
   * @param {Uint8Array} payload the stored or deflated bytes
   */
  #add(name, payload, {dir = false, method = 0, uncompressed = 0, crc = 0, lastModified} = {}) {
    const nameBytes = new TextEncoder().encode(name);
    if (!nameBytes.length || nameBytes.length > U16_MAX) {
      throw new Error('zip: entry name is empty or too long: "' + name + '"');
    }
    if (this.#names.has(name)) {
      throw new Error('zip: duplicate entry: ' + name);
    }
    if (this.#entries >= U16_MAX) {
      throw new Error('zip: more than ' + U16_MAX + ' entries — too many for a classic zip');
    }
    if (uncompressed > U32_MAX || payload.length > U32_MAX) {
      throw new Error('zip: entry "' + name + '" exceeds the 4 GB classic-zip limit');
    }
    this.#names.add(name);
    const {date, time} = dosDateTime(lastModified);
    const localOffset = this.#offset;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, SIG_LOCAL, true);
    lv.setUint16(4, 20, true);            // version needed to extract (2.0)
    lv.setUint16(6, UTF8_FLAG, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, payload.length, true);
    lv.setUint32(22, uncompressed, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);            // extra field length
    local.set(nameBytes, 30);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, SIG_CENTRAL, true);
    cv.setUint16(4, 20, true);            // version made by (DOS, spec 2.0)
    cv.setUint16(6, 20, true);            // version needed to extract
    cv.setUint16(8, UTF8_FLAG, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, payload.length, true);
    cv.setUint32(24, uncompressed, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);            // extra field length
    cv.setUint16(32, 0, true);            // file comment length
    cv.setUint16(34, 0, true);            // disk number start
    cv.setUint16(36, 0, true);            // internal file attributes
    cv.setUint32(38, dir ? 0x10 : 0, true);  // external: the MS-DOS dir bit
    cv.setUint32(42, localOffset, true);
    central.set(nameBytes, 46);

    this.#parts.push(local, payload);
    this.#offset += local.length + payload.length;
    this.#central.push(central);
    this.#centralSize += central.length;
    this.#entries++;
  }

  /**
   * the finished archive; the builder is spent afterwards
   * @returns {Blob} the application/zip archive
   */
  finish() {
    if (this.#offset > U32_MAX || this.#centralSize > U32_MAX) {
      throw new Error('zip: archive exceeds the 4 GB classic-zip limit');
    }
    const centralOffset = this.#offset;
    const eocd = new Uint8Array(22);
    const v = new DataView(eocd.buffer);
    v.setUint32(0, SIG_EOCD, true);
    v.setUint16(4, 0, true);              // this disk
    v.setUint16(6, 0, true);              // disk holding the central directory
    v.setUint16(8, this.#entries, true);
    v.setUint16(10, this.#entries, true);
    v.setUint32(12, this.#centralSize, true);
    v.setUint32(16, centralOffset, true);
    v.setUint16(20, 0, true);             // comment length
    return new Blob([...this.#parts, ...this.#central, eocd],
      {type: 'application/zip'});
  }
}

// ------------------------------------------------------------------ maildir

/**
 * Walks one Maildir through the fs gateway and plans the archive: every
 * directory except the maildir's own tmp/ (scratch space) and the
 * rebuildable .headers.json cache, plus every file — as root-relative
 * {path}s and archive-relative {arc} names rooted at the maildir's name.
 * @param {object} fs an fs gateway facade (prepare()'s facade)
 * @param {string} dirPath root-relative path of the maildir directory
 * @param {string} name the maildir's own name (the archive root)
 * @returns {Promise<{dirs: string[], files: {path: string, arc: string}[]}>}
 */
export async function collectMaildir(fs, dirPath, name) {
  const dirs = [];
  const seen = new Set();
  const files = [];
  const base = sanitizeName(name) + '/';
  const ensureDir = arc => {
    if (!seen.has(arc)) {
      seen.add(arc);
      dirs.push(arc);
    }
  };
  ensureDir(base);

  const walk = async (path, arcBase) => {
    for (const {name: child, kind} of await fs.reader.list(path)) {
      if (kind === 'directory') {
        if (path === dirPath && child === 'tmp') {
          continue;   // tmp/ contents are scratch — the dir entry is ensured below
        }
        const arc = arcBase + sanitizeName(child) + '/';
        ensureDir(arc);
        await walk(path + '/' + child, arc);
      }
      else if (path === dirPath && child === '.headers.json') {
        continue;     // the client's header cache is rebuildable, not mail
      }
      else {
        files.push({path: path + '/' + child, arc: arcBase + sanitizeName(child)});
      }
    }
  };
  await walk(dirPath, base);

  // the maildir's three dirs belong in the archive even when empty (the
  // complete maildir shape) — the walk adds cur/new when present, tmp/ is
  // skipped wholesale by the walk (only its dir entry ships), so all three
  // are ensured here, catching races too
  ensureDir(base + 'cur/');
  ensureDir(base + 'new/');
  ensureDir(base + 'tmp/');

  dirs.sort();
  files.sort((a, b) => (a.arc < b.arc ? -1 : a.arc > b.arc ? 1 : 0));
  return {dirs, files};
}

// ------------------------------------------------------------------ build

/**
 * Builds the zip archive of one Maildir: collects the layout through the
 * gateway, packs every file (cur/ + new/ plus the maildir's own state,
 * minus tmp/ and the header cache) and returns the Blob for the browser's
 * download.
 * @param {object} fs an fs gateway facade (prepare()'s facade)
 * @param {string} dirPath root-relative path of the maildir directory
 * @param {string} name the maildir's own name (the archive root)
 * @param {{onProgress?: (info: {files: number, total: number}) => void}} [opts]
 * @returns {Promise<Blob>}
 */
export async function zipMaildir(fs, dirPath, name, {onProgress = null} = {}) {
  const {dirs, files} = await collectMaildir(fs, dirPath, name);
  const builder = new ZipBuilder();
  for (const dir of dirs) {
    builder.addDirectory(dir);
  }
  let done = 0;
  for (const file of files) {
    const blob = await fs.reader.read(file.path);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await builder.addFile(file.arc, bytes, {lastModified: blob.lastModified});
    done++;
    if (onProgress) {
      onProgress({files: done, total: files.length});
    }
  }
  return builder.finish();
}
