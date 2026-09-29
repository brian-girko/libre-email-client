// core/fs.mjs — THE file-system gateway. Every file and directory read and
// write on the granted storage root (the extension's OPFS — the default —
// or the picker-granted external directory) goes through this module: no
// other file touches a FileSystemHandle's read/write methods. Each caller
// names itself once —
//
//   const fs = await prepare('client');                        // page
//   const fs = await prepare('offscreen', {silent: true});     // offscreen
//
// — and gets one facade with a .reader (list/read/readText/stat/exists)
// and a .writer (write/mkdir/move/remove/ensureWriteAccess). Everything
// works on ROOT-RELATIVE paths ("account/INBOX/cur/123…", '' = the root
// itself); handles never leave this module. The facade is cached per
// origin — repeated prepare() calls share one root resolution; a caller
// that re-checked the gate itself (the sync engine's per-session
// recheck) passes {fresh: true} to re-resolve. A context that already
// holds a verified handle (the explorer's own read-mode gate) injects it
// with {handle}.
//
// Every successful mutation emits one event over the runtime bus:
//
//   chrome.runtime.sendMessage({type:'fs-event', origin, operation, src, dest})
//
//   origin     the string the writer was prepared with ('client', ...)
//   operation  'create' | 'change' | 'delete' | 'move'
//   src        the affected path; for 'move' the OLD path
//   dest       the new path ('move' only), null otherwise
//
// Atomic writes that land via a scratch file (maildir tmp/ → new//cur/)
// write the scratch with {quiet: true} and emit ONE 'move' — the
// intermediate tmp/ state never reaches the bus, and the event's src
// telling that story is still there for anyone who wants it. Failed
// operations emit nothing. Nothing here waits for a responder.
//
// The service worker cannot resolve the root handle and prepares nothing;
// handle ACQUISITION stays where it lives (data/sync/root-handle.mjs +
// disk.mjs): prepare() reuses their gate (probe, permission check, picker
// bounce), and the access probes (.picker-probe, .panel-probe) remain
// gate checks — they are not data I/O and stay out of the event stream.

'use strict';

import {boot, bootSilent} from '/data/sync/disk.mjs';
import {MODE_EXTERNAL, getStorageMode} from '/data/sync/root-handle.mjs';

// ------------------------------------------------------------------ paths

/** splits and validates one root-relative path into its segments */
function splitPath(path) {
  const p = String(path ?? '').replace(/\/+$/, '');
  if (p.startsWith('/')) {
    throw new Error('fs: absolute paths are not allowed: "' + path + '"');
  }
  const segs = p ? p.split('/') : [];
  for (const seg of segs) {
    if (!seg || seg === '.' || seg === '..') {
      throw new Error('fs: bad path segment in "' + path + '"');
    }
  }
  return segs;
}

/** joins path fragments with '/' (empty fragments dropped) */
export function joinPath(...parts) {
  return parts
    .filter(part => part !== '' && part != null)
    .map(part => String(part).replace(/^\/+|\/+$/g, ''))
    .filter(part => part !== '')
    .join('/');
}

async function dirAt(root, segs, {create = false} = {}) {
  let dir = root;
  for (const seg of segs) {
    dir = await dir.getDirectoryHandle(seg, {create});
  }
  return dir;
}

// ------------------------------------------------------------------ errors

/**
 * Path-tagged wrapper for an escaping FS Access API error. The API's
 * DOMExceptions carry no path, so every consumer log would die with a bare
 * "NotFoundError: A requested file or directory could not be found…" and
 * one call site could never tell WHICH path went missing. PRESERVES e.name
 * so every caller's NotFoundError / TypeMismatchError branching keeps
 * working. Errors of the gateway's own composition (the "fs:" guards) pass
 * through untouched — they already say what went wrong.
 */
function tagged(e, what, path, dest = null) {
  if (e instanceof Error && /^fs[a-z.]*: /.test(e.message)) {
    return e;
  }
  const where = dest == null ? `'${path}'` : `'${path}' → '${dest}'`;
  const err = new Error(`fs ${what} ${where}: ${e?.name ?? 'Error'}: ` +
    String(e?.message ?? e));
  err.name = e?.name ?? 'Error';
  return err;
}

// ------------------------------------------------------------------ events

// Same-context subscribers: sendMessage does NOT deliver to the sender, so
// a page that mutates through this gateway would never see its own events
// — the local echo closes that gap (the client's fs-events router relies on
// it to treat self-edits and external changes identically).
const localListeners = new Set();

/**
 * Subscribes to fs-events emitted by THIS context (synchronous, before the
 * runtime broadcast). @returns {Function} unsubscribe
 */
export function onFsEvent(fn) {
  localListeners.add(fn);
  return () => localListeners.delete(fn);
}

function emitFsEvent(origin, operation, src, dest) {
  const msg = {type: 'fs-event', origin, operation, src, dest: dest ?? null};
  for (const fn of [...localListeners]) {
    try {
      fn(msg);
    }
    catch {
      /* a broken listener must not break the operation's event */
    }
  }
  try {
    chrome.runtime.sendMessage(msg).catch(() => {});
  }
  catch {
    /* extension context gone (reload/close) — the operation itself still ran */
  }
}

// ------------------------------------------------------------------ reader

async function fsList(root, dirPath = '') {
  let dir;
  try {
    dir = await dirAt(root, splitPath(dirPath));
  }
  catch (e) {
    throw tagged(e, 'list', dirPath);
  }
  const out = [];
  for await (const [name, handle] of dir.entries()) {
    out.push({name, kind: handle.kind});
  }
  return out;
}

async function fsRead(root, filePath) {
  const segs = splitPath(filePath);
  let dir;
  let fh;
  try {
    dir = await dirAt(root, segs.slice(0, -1));
    fh = await dir.getFileHandle(segs[segs.length - 1]);
  }
  catch (e) {
    throw tagged(e, 'read', filePath);
  }
  try {
    return await fh.getFile();
  }
  catch (e) {
    throw tagged(e, 'read', filePath);
  }
}

async function fsStat(root, path) {
  const segs = splitPath(path);
  if (!segs.length) {
    return {exists: true, kind: 'directory', size: 0, lastModified: 0};
  }
  const name = segs[segs.length - 1];
  let parent;
  try {
    parent = await dirAt(root, segs.slice(0, -1));
  }
  catch (e) {
    // a missing PARENT means the path itself cannot exist ("exists" is a
    // predicate — the very shape every missing-dir caller depends on: the
    // initial sync's maildirOf() probes <acc>/<dir>/tmp before <acc>/<dir>
    // ever exists, and the client asks exists() on just-deleted dirs)
    if (e?.name === 'NotFoundError') {
      return {exists: false, kind: null, size: 0, lastModified: 0};
    }
    // a FILE blocks the parent chain (TypeMismatchError): a real shape error
    throw tagged(e, 'stat', path);
  }
  try {
    const file = await (await parent.getFileHandle(name)).getFile();
    return {exists: true, kind: 'file', size: file.size, lastModified: file.lastModified};
  }
  catch (e) {
    if (e?.name === 'NotFoundError') {
      return {exists: false, kind: null, size: 0, lastModified: 0};
    }
    if (e?.name === 'TypeMismatchError') {
      try {
        await parent.getDirectoryHandle(name);   // rethrows NotFoundError if truly gone
      }
      catch (e2) {
        throw tagged(e2, 'stat', path);
      }
      return {exists: true, kind: 'directory', size: 0, lastModified: 0};
    }
    throw tagged(e, 'stat', path);
  }
}

// ------------------------------------------------------------------ writer

/** writes (creates or overwrites) one file; emits 'create' or 'change' */
async function fsWrite(origin, root, filePath, data, {quiet = false} = {}) {
  const segs = splitPath(filePath);
  if (!segs.length) {
    throw new Error('fs: cannot write the root itself');
  }
  const dir = await dirAt(root, segs.slice(0, -1), {create: true});
  const name = segs[segs.length - 1];
  let existed = true;
  if (!quiet) {
    // probe BEFORE creating — the event must tell create from change
    try {
      await dir.getFileHandle(name);
    }
    catch (e) {
      if (e?.name !== 'NotFoundError') {
        throw e;   // e.g. a DIRECTORY sits at this path — surface it
      }
      existed = false;
    }
  }
  try {
    const fh = await dir.getFileHandle(name, {create: true});
    const w = await fh.createWritable();
    await w.write(data);
    await w.close();
  }
  catch (e) {
    throw tagged(e, 'write', filePath);
  }
  if (!quiet) {
    emitFsEvent(origin, existed ? 'change' : 'create', segs.join('/'), null);
  }
  return filePath;
}

/** creates one directory (recursively); emits 'create' once, for the path */
async function fsMkdir(origin, root, dirPath, {quiet = false} = {}) {
  const segs = splitPath(dirPath);
  if (!segs.length) {
    throw new Error('fs: the root always exists');
  }
  try {
    await dirAt(root, segs);
    return false;   // already there (a dir) — not an event
  }
  catch (e) {
    if (e?.name !== 'NotFoundError') {
      throw tagged(e, 'mkdir', dirPath);   // e.g. a FILE sits at this path — surface the mismatch
    }
  }
  try {
    await dirAt(root, segs, {create: true});
  }
  catch (e) {
    throw tagged(e, 'mkdir', dirPath);
  }
  if (!quiet) {
    emitFsEvent(origin, 'create', segs.join('/'), null);
  }
  return true;
}

/** renames within a dir or moves across dirs; emits 'move' {src, dest} */
async function fsMove(origin, root, srcPath, destPath, {quiet = false} = {}) {
  const src = splitPath(srcPath);
  const dest = splitPath(destPath);
  if (!src.length || !dest.length) {
    throw new Error('fs.move: empty path');
  }
  try {
    const srcParent = await dirAt(root, src.slice(0, -1));
    let handle;
    try {
      handle = await srcParent.getFileHandle(src[src.length - 1]);
    }
    catch (e) {
      if (e?.name === 'TypeMismatchError') {
        // a directory rename attempt — same call the explorer made directly
        handle = await srcParent.getDirectoryHandle(src[src.length - 1]);
      }
      else {
        throw e;
      }
    }
    if (typeof handle.move !== 'function') {
      throw new Error('this browser does not support renaming');
    }
    const destDir = await dirAt(root, dest.slice(0, -1));
    const destName = dest[dest.length - 1];
    if (src.slice(0, -1).join('/') === dest.slice(0, -1).join('/')) {
      await handle.move(destName);
    }
    else {
      await handle.move(destDir, destName);
    }
    if (!quiet) {
      emitFsEvent(origin, 'move', src.join('/'), dest.join('/'));
    }
    return dest.join('/');
  }
  catch (e) {
    throw tagged(e, 'move', src.join('/'), dest.join('/'));
  }
}

/** deletes one file or directory tree; emits 'delete'; missing → false */
async function fsRemove(origin, root, path, {recursive = false, quiet = false} = {}) {
  const segs = splitPath(path);
  if (!segs.length) {
    throw new Error('fs: refusing to remove the root itself');
  }
  let parent;
  try {
    parent = await dirAt(root, segs.slice(0, -1));
  }
  catch (e) {
    if (e?.name === 'NotFoundError') {
      return false;   // parent gone → the entry cannot exist: same no-op
    }
    throw tagged(e, 'remove', path);
  }
  try {
    await parent.removeEntry(segs[segs.length - 1], {recursive: !!recursive});
  }
  catch (e) {
    if (e?.name === 'NotFoundError') {
      return false;   // gone already — a successful no-op, no event
    }
    throw e;
  }
  if (!quiet) {
    emitFsEvent(origin, 'delete', segs.join('/'), null);
  }
  return true;
}

/**
 * The lazy readwrite upgrade for read-gated pages (the explorer): OPFS
 * grants write implicitly; an external directory prompts from the calling
 * gesture. Returns true when writes may proceed.
 */
async function fsEnsureWriteAccess(root) {
  if (await getStorageMode() !== MODE_EXTERNAL) {
    return true;
  }
  if (!root || !(root instanceof FileSystemDirectoryHandle)) {
    return false;
  }
  if (await root.queryPermission({mode: 'readwrite'}) === 'granted') {
    return true;
  }
  return await root.requestPermission({mode: 'readwrite'}) === 'granted';
}

async function fsExists(root, path) {
  return (await fsStat(root, path)).exists;
}

// ------------------------------------------------------------------ facade

/** every reader/writer call refuses to run without a confirmed gate */
function guarded(gate, fn) {
  return (...args) => {
    if (!gate.ok) {
      return Promise.reject(new Error(
        'fs: no granted storage root (' + (gate.reason ?? 'not prepared') + ')'));
    }
    return fn(...args);
  };
}

class FsRoot {
  constructor(origin, root, gate) {
    this.origin = origin;
    this.root = root;
    this.gate = gate;
    this.reader = {
      list: guarded(gate, path => fsList(root, path)),
      read: guarded(gate, path => fsRead(root, path)),
      readText: guarded(gate, async path => await (await fsRead(root, path)).text()),
      stat: guarded(gate, path => fsStat(root, path)),
      exists: guarded(gate, path => fsExists(root, path))
    };
    this.writer = {
      write: guarded(gate, (path, data, opts) => fsWrite(origin, root, path, data, opts)),
      mkdir: guarded(gate, (path, opts) => fsMkdir(origin, root, path, opts)),
      move: guarded(gate, (src, dest, opts) => fsMove(origin, root, src, dest, opts)),
      remove: guarded(gate, (path, opts) => fsRemove(origin, root, path, opts)),
      ensureWriteAccess: guarded(gate, () => fsEnsureWriteAccess(root))
    };
  }
}

// ------------------------------------------------------------------ prepare

const prepared = new Map();   // origin → Promise<FsRoot>

async function resolveRoot({silent, handle}) {
  if (handle) {
    // injected: the caller verified this handle itself (the explorer's
    // read-mode gate) — the gateway only wraps it
    return {
      root: handle,
      gate: {ok: true, raw: 'granted', reason: null, name: handle.name || null, injected: true}
    };
  }
  if (silent) {
    // offscreen-safe: verdict only, no navigation
    const verdict = await bootSilent();
    const {handle: root, ...gate} = verdict;
    return {root: root ?? null, gate};
  }
  const root = await boot();
  if (root instanceof FileSystemDirectoryHandle) {
    return {root, gate: {ok: true, raw: 'granted', reason: null, name: root.name || null}};
  }
  // boot() could not confirm access — it already bounced to the picker
  return {root: null, gate: {ok: false, raw: null, reason: 'redirected', name: null}};
}

/**
 * The one entry point: asks for this context's file-system facade, named
 * by origin. The origin rides every fs-event this facade emits.
 * @param {string} origin the caller's identity ('client', 'offscreen', ...)
 * @param {{silent?: boolean, handle?: FileSystemDirectoryHandle, fresh?: boolean}} [opts]
 *   silent: verdict-only gate (offscreen documents cannot redirect);
 *   handle: wrap an already-verified root instead of resolving one;
 *   fresh:  skip/renew the per-origin cache (a deliberate re-check)
 * @returns {Promise<FsRoot>} facade with .reader/.writer/.gate/.origin —
 *   when the gate failed, methods reject with a clear error and .gate
 *   carries the verdict ({ok, raw, reason, name, error})
 */
export function prepare(origin, {silent = false, handle = null, fresh = false} = {}) {
  const key = String(origin ?? '').trim();
  if (!key) {
    throw new Error('fs: prepare() requires an origin (e.g. prepare("client"))');
  }
  if (!fresh && prepared.has(key)) {
    return prepared.get(key);
  }
  const pending = resolveRoot({silent, handle})
    .then(({root, gate}) => new FsRoot(key, root, gate))
    .catch(e => {
      prepared.delete(key);   // a failed resolution must be retryable
      throw e;
    });
  prepared.set(key, pending);
  return pending;
}
