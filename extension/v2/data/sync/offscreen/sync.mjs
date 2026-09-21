// sync.mjs — offlineimap-style two-way sync: one IMAP account <-> a local
// Maildir tree, driven exclusively through client.mjs (never core/).
//
// Pipeline: plan() = survey + classify, with NO writes. describePlan()
// renders it for humans/dry-run. apply(plan) is the only place with side
// effects: it executes the plan, reconciles against a post-apply survey and
// writes the new snapshot (.sync-state.json) as the FINAL step — an
// interrupted run therefore replays identical diffs next time.
//
// Conflict policy: server wins.
//   - flags edited on both sides          → server flags, local edit dropped
//   - deleted locally, edited on server   → kept on server, re-pulled
//   - moved locally, deleted on server    → local copy dropped
//   - moved both sides differently        → server position wins
//
// Classification: per folder we hold three known-good views:
//   K  the snapshot (uid → {msgid, flags})
//   S  the server rows (uid → {flags, size, ...})
//   L  local maildir files (uid → entry; filename carries uid/flags/FMD5)
// plus an identity index for every uid that is new on the server since K
// (downloaded once — the basis of move detection across folders).
//
//   K−S, still local       → server moved/relocated (msgid match) or purged
//   K−L, S still has it    → local deletion pushed to the server (unless
//                             the server edited it: conflict → re-pull);
//                             with no foreign-FMD5 file anywhere in the
//                             handle the delete asks the user first
//                             (confirmPurge gate, sync page)
//   L file with foreign FMD5 X → local move out of X, pushed as server move
//   S−K                    → new mail: pull — unless a pending-move file
//                             claims the uid while its snapshot record is
//                             gone (lost-snapshot shape): verified by msgid
//                             and replayed as a server MOVE (self-heal)
//   flag deltas vs K       → local edit pushes to server; server edit
//                             rewrites the local name (server wins on both)
//   uidvalidity mismatch   → resync: wipe the folder locally, re-pull all

'use strict';

import {KNOWN_FLAG_NAMES, knownFlags, md5hex, sameFlags} from '../maildir.mjs';
import {msgidOf, validateMail} from '../snapshot.mjs';

// server flags that never mean anything outside their session — never
// stored, never compared (a "\Recent" would churn the snapshot every run)
const SESSION_FLAGS = new Set(['\\Recent']);
const readableFlags = flags => (flags ?? []).filter(f => !SESSION_FLAGS.has(f));

const UID_WINDOW = 500;                 // floor stride: dense areas page this size
const UID_STRIDE_MAX = UID_WINDOW * 32; // 16000: the cap for skipping gaps
const RAW_BUDGET = 32 * 1024 * 1024;

// hard ceiling on one message FETCH: a wedged bridge stream never resolves
// (and the wasm FIFO chain stays jammed behind it — see core/rust-imap-client/
// api.mjs), so a hung fetch must abort the run and let withSession rebuild
// the whole stack; the timeout line tells the loop to rethrow
const FETCH_TIMEOUT = Number(globalThis.process?.env?.SYNC_FETCH_TIMEOUT_MS) || 2 * 60 * 1000;

/** size of one pull run in messages and bytes: above this the plan warns */
const HEAVY_MESSAGES = 200;
const HEAVY_BYTES = 50 * 1024 * 1024;

function humanBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) {
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  }
  if (bytes >= 1024 * 1024) {
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

/**
 * One message fetch under a hard ceiling: a wedged FETCH never resolves and
 * jams the wasm FIFO forever, so the race rejects for both phases (mining,
 * pull) and the run is torn down instead of sitting silent forever.
 */
function guardedFetch(promise, label) {
  let timer;
  const cap = new Promise((_, reject) => {
    timer = setTimeout(() =>
      reject(new Error(`${label}: FETCH timed out after ${FETCH_TIMEOUT / 1000}s`)),
    FETCH_TIMEOUT);
  });
  return Promise.race([promise, cap]).finally(() => clearTimeout(timer));
}

const fetchTimedOut = e => String(e?.message || '').includes('FETCH timed out');

/** [1,2,3,4] via 2 → [[1,2],[3,4]] */
function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) {
    out.push(list.slice(i, i + size));
  }
  return out;
}

const KIND2KEY = {
  resync: 'resyncs',
  deleteServerFolder: 'serverFolderDeletes',
  purgeLocal: 'removed',
  dropLocal: 'droppedDirs',
  relocate: 'localMoves',
  reflag: 'localFlagChanges',
  adopt: 'adopted',
  append: 'pushed',
  flagsServer: 'serverFlagChanges',
  deleteServer: 'serverDeletes',
  moveServer: 'serverMoves',
  pull: 'added'
};
const TIER = {
  resync: 0, deleteServerFolder: 0, purgeLocal: 1, dropLocal: 1, relocate: 2,
  reflag: 3, append: 4, flagsServer: 5, deleteServer: 6, moveServer: 7, pull: 8
};

function blankCounts() {
  return {
    added: 0, removed: 0, droppedDirs: 0, pushed: 0,
    localFlagChanges: 0, localMoves: 0,
    serverFlagChanges: 0, serverDeletes: 0, serverFolderDeletes: 0, serverMoves: 0,
    resyncs: 0, adopted: 0
  };
}

function blankSummary() {
  return {
    added: 0, removed: 0, droppedDirs: 0, localFlagChanges: 0, localMoves: 0,
    serverFlagChanges: 0, serverDeletes: 0, serverFolderDeletes: 0, serverMoves: 0,
    resyncs: 0, adopted: 0, skipped: 0, failed: 0,
    ops: {}, conflicts: 0, warnings: 0, folders: {}
  };
}

export function describeOp(op) {
  switch (op.kind) {
    case 'resync':
      return `resync ${op.folder} (${op.reason ?? 'uidvalidity changed'})`;
    case 'deleteServerFolder':
      return `delete server folder ${op.folder} (${op.reason ?? 'local dir deleted'})`;
    case 'pull':
      return `pull  ${op.folder}/${op.uid} to local${op.size != null ? ` (${op.size}B)` : ''}`;
    case 'purgeLocal':
      return `drop  local ${op.folder}/${op.uid}`;
    case 'dropLocal':
      return `drop  local dir ${op.folder} (${op.messages ?? 0} message(s))`;
    case 'relocate':
      return `move  local ${op.folder}/${op.uid} → ${op.toFolder}/${op.toUid}`;
    case 'reflag':
      return `flags local ${op.folder}/${op.uid} [${(op.flags ?? []).join(',')}]`;
    case 'flagsServer':
      return `push  flags ${op.folder}/${op.uid} +[${(op.add ?? []).join(',')}] -[${(op.remove ?? []).join(',')}]`;
    case 'append':
      return `upload ${op.folder}/${op.fileName}${op.size != null ? ` (${op.size}B)` : ''}`;
    case 'deleteServer':
      return `delete on server ${op.folder}/${op.uid}`;
    case 'moveServer':
      return `move  on server ${op.folder}/${op.uid} → ${op.toFolder}`;
    default:
      return JSON.stringify(op);
  }
}

/** true when op b can ride in one coalesced narration line with op a */
function sameGroup(a, b) {
  if (a.kind !== b.kind || a.folder !== b.folder) {
    return false;
  }
  switch (a.kind) {
    case 'pull':
    case 'purgeLocal':
    case 'deleteServer':
    case 'append':
      return true;
    case 'relocate':
    case 'moveServer':
      return a.toFolder === b.toFolder;
    case 'reflag':
      return (a.flags ?? []).join(',') === (b.flags ?? []).join(',');
    case 'flagsServer':
      return (a.add ?? []).join(',') === (b.add ?? []).join(',') &&
        (a.remove ?? []).join(',') === (b.remove ?? []).join(',');
    default:
      return false;
  }
}

/**
 * One narration line for a run of same-kind ops: a lone op keeps its
 * describeOp shape; a run of ≥2 collapses into a single count/range line
 * (per-message loop narration would otherwise flood the log pane).
 */
function describeOpGroup(run) {
  if (run.length === 1) {
    return describeOp(run[0]);
  }
  const op = run[0];
  const n = run.length;
  const uids = run.map(o => Number(o.uid) || 0).filter(u => u > 0);
  const min = uids.length ? Math.min(...uids) : null;
  const max = uids.length ? Math.max(...uids) : null;
  const span = min == null ? '' : min === max ? `/${min}` : `/${min}…${max}`;
  const bytes = run.reduce((sum, o) => sum + (Number(o.size) || 0), 0);
  const size = bytes > 0 ? `, ~${humanBytes(bytes)}` : '';
  switch (op.kind) {
    case 'pull':
      return `pull  ${op.folder}${span} to local (${n} message(s)${size})`;
    case 'purgeLocal':
      return `drop  local ${op.folder}${span} (${n} message(s))`;
    case 'deleteServer':
      return `delete on server ${op.folder}${span} (${n} message(s))`;
    case 'append':
      return `upload ${op.folder} (${n} file(s)${size})`;
    case 'relocate':
      return `move  local ${op.folder} → ${op.toFolder} (${n} message(s))`;
    case 'moveServer':
      return `move  on server ${op.folder} → ${op.toFolder} (${n} message(s))`;
    case 'reflag':
      return `flags local ${op.folder} (${n} message(s)) [${(op.flags ?? []).join(',')}]`;
    case 'flagsServer':
      return `push  flags ${op.folder} (${n} message(s))` +
        ` +[${(op.add ?? []).join(',')}] -[${(op.remove ?? []).join(',')}]`;
    default:
      return run.map(o => describeOp(o)).join('\n   ');
  }
}

export function describePlan(plan) {
  const lines = [];
  if (!plan.ops.length && !plan.conflicts.length) {
    lines.push({type: 'plan', content: 'no changes — server and local copies agree'});
  }
  const byFolder = new Map();
  for (const op of plan.ops) {
    (byFolder.get(op.folder) ?? byFolder.set(op.folder, []).get(op.folder)).push(op);
  }
  for (const [folder, list] of [...byFolder.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push({type: 'plan', content: folder});
    for (let i = 0; i < list.length;) {
      let j = i + 1;
      while (j < list.length && sameGroup(list[j - 1], list[j])) {
        j++;
      }
      lines.push({type: 'plan', content: '   ' + describeOpGroup(list.slice(i, j))});
      i = j;
    }
  }
  for (const c of plan.conflicts) {
    lines.push({
      type: 'conflict',
      content: `${c.folder}/${c.uid}: ${c.detail} → ${c.resolution}`,
      cls: 'conflict'
    });
  }
  for (const w of plan.warnings) {
    lines.push({type: 'warn', content: w, cls: 'warn'});
  }
  return lines;
}

function summarize(plan) {
  const summary = {
    ops: {},
    folders: {},
    conflicts: plan.conflicts.length,
    warnings: plan.warnings.length,
    skipped: 0,
    failed: 0
  };
  for (const op of plan.ops) {
    summary.ops[op.kind] = (summary.ops[op.kind] ?? 0) + 1;
    const folder = summary.folders[op.folder] ?? (summary.folders[op.folder] = blankCounts());
    const key = KIND2KEY[op.kind];
    if (key) {
      folder[key]++;
    }
  }
  return summary;
}

// When `only` names one folder, the whole pipeline (survey, plan, apply,
// snapshot) is scoped to that single dir: the rest of the account keeps its
// snapshot untouched and only that dir's entry is rewritten.
export function createSync(mail, store, {account = null, log = console.log, onProgress = null, only = null, confirmPurge = null, confirmDropDirectory = null, pullBatch = 8, pullQuantum = 10, miningBatch = 100} = {}) {
  pullQuantum = Math.max(1, Math.floor(Number(pullQuantum) || 10));
  miningBatch = Math.max(1, Math.floor(Number(miningBatch) || 100));
  const emitLog = (type, content, cls = '') =>
    log({type, content, cls});
  let selected = null;
  let last = null;

  async function select(name, {force = false} = {}) {
    if (selected !== name || force) {
      selected = name;
      return mail.readDir(name);
    }
    return null;
  }

/** uid ≤ uidnext of one folder: uid → {flags, size, subject, ...}
 *  Sweeps the full UID space with an adaptive stride: 500 rows per call in
 *  dense areas; every empty window implies a gap of expunged uids, so the
 *  stride quadruples (up to UID_STRIDE_MAX) until mail shows up again.
 *  Windows always tile [1, uidnext) without overlap (next lo is always the
 *  previous hi + 1), so changing stride can never skip or double-cover a
 *  range. The stride is learned per folder and reset at the 500 floor for
 *  each folder: dense folders always page small, sparse gaps are skipped
 *  logarithmically, and per-call memory stays bounded for million-mail
 *  folders. */
async function rowsFor(name, uidnext) {
  const out = new Map();
  const high = uidnext - 1;
  let lo = 1;
  let stride = UID_WINDOW;
  while (lo <= high) {
    const hi = Math.min(lo + stride - 1, high);
    const rows = await mail.listMails({fromUid: lo, toUid: hi});
    for (const r of rows) {
      out.set(Number(r.uid), {
        flags: readableFlags(r.flags),
        subject: r.subject ?? null,
        from: r.from ?? null,
        date: r.date ?? null,
        size: r.size ?? null
      });
    }
    if (rows.length === 0) {
      stride = Math.min(stride * 4, UID_STRIDE_MAX);
    }
    else {
      stride = Math.max(UID_WINDOW, stride >> 1);
    }
    lo = hi + 1;
  }
  return out;
}

  /**
   * The full server+local picture in one read-only pass.
    * @returns {Promise<{snap, folders: Map<string,Folder>, localOnly: string[]}>}
    *   Folder: {name, uidvalidity, uidnext, server, last, resync, local, localMissing}
    */
  async function surveyNow() {
    const snap = await store.loadState();
    const all = (await mail.folders())
      .filter(f => !(f.attrs ?? []).includes('\\Noselect'));
    const selectable = only ? all.filter(f => f.name === only) : all;
    if (only && !selectable.length) {
      throw new Error(`survey: folder "${only}" not found on the server`);
    }
    const folders = new Map();
    const localCache = new Map();   // folder → listing (avoids double disk reads)
    async function listLocalCached(name) {
      if (!localCache.has(name)) {
        localCache.set(name, await store.listLocal(name));
      }
      return localCache.get(name);
    }
    let done = 0;
    let total = selectable.length;

    async function surveyFolder(f) {
      const st = await select(f.name);
      const uidvalidity = Number(st?.uidvalidity || 0);
      const uidnext = Number(st?.uidnext || 0);
      const server = await rowsFor(f.name, uidnext);
      const current = snap.folders[f.name] ?? null;
      const resync = !!current?.uidvalidity && Number(current.uidvalidity) !== uidvalidity;
      store.delimiter = f.delimiter || '/';
      const local = resync ? null : (await listLocalCached(f.name));
      // null when the whole Maildir dir is gone (or not a Maildir) — the
      // dir-level form of "vanished locally" (see plan()'s resync branch)
      const localMissing = !local && !resync;

      /** @type {Folder} */
      const F = {
        name: f.name,
        delimiter: f.delimiter || '/',
        uidvalidity,
        uidnext,
        server,
        last: current,
        resync,
        localMissing,
        local
      };
      folders.set(f.name, F);
      onProgress?.({phase: 'survey', folder: f.name, done: ++done, total});
      emitLog('survey', `${f.name}: server=${server.size} local=${local ? local.entries.size : '?'} foreign=${local ? local.interlopers.length : 0} untracked=${local ? local.untracked.length : 0} ignored=${local ? local.excluded.length : 0} tmp=${local ? local.stranded.length : 0}${resync ? '  ⟳ RESYNC (uidvalidity changed)' : localMissing ? '  ⟳ RESYNC (local dir missing)' : ''}`);
      // keyword visibility: unencodable IMAP keywords ($Filtered, …) cannot
      // live in Maildir filenames, so they ride the SNAPSHOT only —
      // server-owned state, never encoded, never compared against files.
      // One line per folder, and one extra line when the server-side set
      // changed since the last snapshot (no per-message chatter).
      const encodable = new Set(KNOWN_FLAG_NAMES);
      const kwCounts = new Map();
      for (const [, row] of server) {
        for (const f of row.flags ?? []) {
          if (!encodable.has(f) && !SESSION_FLAGS.has(f)) {
            kwCounts.set(f, (kwCounts.get(f) ?? 0) + 1);
          }
        }
      }
      if (kwCounts.size) {
        const usage = [...kwCounts.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([kw, n]) => `${kw}×${n}`).join(', ');
          emitLog('survey', `${f.name}: keyword usage: ${usage} (server-managed, tracked in the snapshot only)`);
        // a change vs nothing is not a change: compare only against a
        // snapshot that already carries folder state (first sync stays quiet)
        const prevMsgs = F.last?.messages ?? {};
        if (Object.keys(prevMsgs).length) {
          const prevKw = new Set();
          for (const m of Object.values(prevMsgs)) {
            for (const f of m.flags ?? []) {
              if (!encodable.has(f) && !SESSION_FLAGS.has(f)) {
                prevKw.add(f);
              }
            }
          }
          const addedKw = [...kwCounts.keys()].filter(k => !prevKw.has(k));
          const goneKw = [...prevKw].filter(k => !kwCounts.has(k));
          if (addedKw.length || goneKw.length) {
            emitLog('survey', `${f.name}: keyword changes on the server` +
              (addedKw.length ? `: +${addedKw.sort().join(', +')}` : '') +
              (goneKw.length ? `: -${goneKw.sort().join(', -')}` : ''));
          }
        }
      }
    }

    for (const f of selectable) {
      await surveyFolder(f);
    }
    // Scoped run: also survey (read-only) folders involved in local moves,
    // so a move is detected as moveServer on whichever dir the user asked
    // about — never as an unrelated destructive delete. Two directions:
    //   - into the dir: files IN the dir carry another folder's FMD5 →
    //     survey their source folders
    //   - out of the dir: folders elsewhere hold files stamped with THIS
    //     folder's FMD5 for a uid that the snapshot still lists but the
    //     dir no longer has → survey their destination folders
    if (only) {
      const fmd5ToServerFolder = new Map(all.map(f => [md5hex(f.name), f.name]));
      const extras = new Set();
      for (const F of folders.values()) {
        for (const e of F.local?.interlopers ?? []) {
          const src = fmd5ToServerFolder.get(e.fmd5);
          if (src && !folders.has(src)) {
            extras.add(src);
          }
        }
      }
      const scopedF = folders.get(only);
      const kMessages = scopedF?.last?.messages ?? {};
      const goneLocally = scopedF?.local
        ? new Set(Object.keys(kMessages).map(Number).filter(uid => !scopedF.local.entries.has(uid)))
        : null;
      const ownFmd5 = md5hex(only);
      for (const f of all.filter(x => x.name !== only)) {
        const listing = await listLocalCached(f.name);
        for (const e of listing?.interlopers ?? []) {
          if (e.fmd5 !== ownFmd5) {
            continue;
          }
          if (kMessages[e.uid]) {
            // classic shape: the snapshot still tracks the uid, its file
            // moved out of this dir
            if (!goneLocally || goneLocally.has(Number(e.uid))) {
              extras.add(f.name);
              break;
            }
          }
          else if (scopedF && scopedF.server.has(Number(e.uid)) &&
            !scopedF.local?.entries.has(Number(e.uid))) {
            // lost-snapshot shape: the snapshot record is gone but the
            // server still serves the uid and a pending-move file claims
            // it — surveyed so healLostMove can replay the move
            extras.add(f.name);
            break;
          }
        }
      }
      if (extras.size) {
        total += extras.size;
        for (const name of extras) {
          const f = all.find(x => x.name === name);
          if (f && !folders.has(name)) {
            await surveyFolder(f);
          }
        }
      }
    }
    const localOnly = only
      ? []
      : (await store.listFolders()).filter(name => !folders.has(name));
    // INBOX first, then smallest dirs: their maildir structure lands locally (and the
    // snapshot commits a folder entry per apply) while the big folders are
    // still being surveyed/planned — new mail in them reads sooner.
    const ordered = [...folders.values()]
      .sort((a, b) => (Number(b.name.toUpperCase() === 'INBOX') - Number(a.name.toUpperCase() === 'INBOX')) ||
        (a.server.size - b.server.size) || a.name.localeCompare(b.name));
    if (ordered.length > 1) {
      emitLog('survey', `pull order (INBOX first, then smallest): ${ordered.map(x =>
        `${x.name}(${x.server.size})`).join(' → ')}`);
    }
    folders.clear();
    for (const F of ordered) {
      folders.set(F.name, F);
    }
    return {snap, folders, localOnly, allFolders: all};
  }

  async function plan() {
    selected = null;
    const survey = await surveyNow();
    const {snap, folders, allFolders = []} = survey;

    const ops = [];
    const conflicts = [];
    const warnings = [];
    const claim = new Set();   // `${folder}/${uid}` consumed by another op
    const claimedInterlopers = new Set();

    // local-move candidates indexed by the SOURCE folder's fmd5 — built
    // before mining so the heal-aware mining gate can see pending moves
    const interlopersBy = new Map();
    for (const F of folders.values()) {
      for (const entry of F.local?.interlopers ?? []) {
        if (!interlopersBy.has(entry.fmd5)) {
          interlopersBy.set(entry.fmd5, []);
        }
        interlopersBy.get(entry.fmd5).push({folder: F.name, entry});
      }
    }
    const fmd5ToFolder = new Map(allFolders.map(f => [md5hex(f.name), f.name]));
    const findInterloper = (srcFolder, uid) => {
      for (const item of interlopersBy.get(md5hex(srcFolder)) ?? []) {
        if (!item.entry.claimed && item.entry.uid === uid) {
          item.entry.claimed = true;
          claimedInterlopers.add(item.entry);
          return item;
        }
      }
      return null;
    };
    /** non-claiming variant: "is there a pending local move of src/uid?" */
    const peekInterloper = (srcFolder, uid) => {
      for (const item of interlopersBy.get(md5hex(srcFolder)) ?? []) {
        if (!item.entry.claimed && item.entry.uid === uid) {
          return item;
        }
      }
      return null;
    };

    // ---- mining: every uid that is new on the server gets one raw
    // download so msgid classification works across folder changes.
    // A folder whose mirror is FULLY re-pulled this run (uidvalidity changed
    // or the local dir missing — e.g. a first sync of a new account) is
    // skipped: the plan ignores the snapshot there, so msgid classification
    // changes nothing and the pull phase fetches it all anyway — mining
    // would only double every download of the heaviest first runs.
    const newIds = new Map();  // folder → Map(msgid → uid)
    const raws = new Map();    // `${folder}/${uid}` → raw bytes (apply reuses)
    let budget = RAW_BUDGET;
    const mining = [];
    // Raw mining is only needed to distinguish a new UID from a server-side
    // move. If no snapshot message disappeared from its old folder, every
    // fresh UID is genuinely new and can go straight to the pull scheduler.
    const moveCandidates = [...folders.values()].some(F =>
      !F.resync && !F.localMissing &&
      Object.keys(F.last?.messages ?? {}).some(uid => !F.server.has(Number(uid))));
    // uids the snapshot lost while the server kept them AND a pending local
    // move claims them (a lost-snapshot shape — see healLostMove): their raws
    // must be mined even with no other possible server-side move, so the
    // local file's identity can be verified before replaying the MOVE.
    const healUids = new Map();   // folder → Set(uid)
    if (!moveCandidates) {
      for (const F of folders.values()) {
        if (F.resync || F.localMissing) {
          continue;
        }
        for (const uid of F.server.keys()) {
          if (F.last?.messages?.[uid]) {
            continue;
          }
          const hit = peekInterloper(F.name, uid);
          if (hit && fmd5ToFolder.get(md5hex(F.name))) {
            (healUids.get(F.name) ?? healUids.set(F.name, new Set()).get(F.name)).add(uid);
          }
        }
      }
    }
    for (const F of folders.values()) {
      const fresh = !F.resync && !F.localMissing
        ? [...F.server.keys()].filter(uid => !F.last?.messages?.[uid])
        : [];
      const heal = healUids.get(F.name);
      const mine = moveCandidates ? fresh : [...(heal ?? [])];
      const state = {F, ids: new Map(), chunks: chunks(mine, miningBatch), total: mine.length, next: 0, done: 0, started: mine.length ? Date.now() : 0};
      newIds.set(F.name, state.ids);
      if (mine.length) {
        emitLog('mining', `${F.name}: ${mine.length} new message(s) to classify — downloading raws in batches of ${miningBatch}`);
        onProgress?.({phase: 'mining', folder: F.name, done: 0, total: mine.length});
        mining.push(state);
      }
    }
    if (!moveCandidates && [...folders.values()].some(F =>
      !F.resync && !F.localMissing && [...F.server.keys()].some(uid =>
        !F.last?.messages?.[uid] && !healUids.get(F.name)?.has(uid)))) {
      emitLog('mining', 'skipped: no possible server-side moves; new messages go straight to pulls');
    }
    // Mine in the same fair order as pulls: one quantum per folder per round.
    for (let active = mining.length; active; ) {
      active = 0;
      for (const state of mining) {
        if (state.next >= state.chunks.length) {
          continue;
        }
        active++;
        const {F, ids} = state;
        const chunk = state.chunks[state.next++];
        await select(F.name);
        try {
          const mails = await guardedFetch(
            mail.readMails(chunk, {concurrency: pullBatch}),
            `mining fetch ${F.name} [${chunk[0]}…${chunk[chunk.length - 1]}]`);
          for (const m of mails) {
            ids.set(await msgidOf(m.raw), m.uid);
            if (m.raw.byteLength <= budget) {
              raws.set(`${F.name}/${m.uid}`, m.raw);
              budget -= m.raw.byteLength;
            }
          }
        }
        catch (e) {
          if (fetchTimedOut(e)) {
            emitLog('mining', `${F.name}: ${e.message} — run aborted, the bridge will be rebuilt`, 'warn');
            throw e;
          }
          for (const uid of chunk) {
            try {
              const raw = (await guardedFetch(mail.readMail(uid),
                `mining fetch ${F.name}/${uid}`)).raw;
              ids.set(await msgidOf(raw), uid);
              if (raw.byteLength <= budget) {
                raws.set(`${F.name}/${uid}`, raw);
                budget -= raw.byteLength;
              }
            }
            catch (e2) {
              if (fetchTimedOut(e2)) {
                emitLog('mining', `${F.name}/${uid}: ${e2.message} — run aborted, the bridge will be rebuilt`, 'warn');
                throw e2;
              }
              warnings.push(`fetch failed ${F.name}/${uid}: ${e2?.message || e2}`);
            }
          }
        }
        state.done += chunk.length;
        onProgress?.({phase: 'mining', folder: F.name, done: Math.min(state.done, state.total), total: state.total});
        if (state.done % pullQuantum === 0 || state.done >= state.total) {
          emitLog('mining', `${F.name}: ${state.done}/${state.total} fetched in ${Math.round((Date.now() - state.started) / 1000)}s`);
        }
      }
    }

    const findNewByMsgid = (msgid, exclude) => {
      if (!msgid) {
        return null;
      }
      for (const [name, ids] of newIds) {
        if (name !== exclude && ids.has(msgid)) {
          return {folder: name, uid: ids.get(msgid)};
        }
      }
      return null;
    };

    const messagesOf = (F) => F.last?.messages ?? {};

    /** does the message with this msgid already sit on the server in some
     *  folder (the destination included)? — guards double-copies of a move
     *  that was already replayed once. `skip` is the `${folder}/${uid}` key
     *  of the row under reconciliation. */
    const msgidServedElsewhere = (msgid, skip) => {
      if (!msgid) {
        return null;
      }
      for (const [name, F] of folders) {
        for (const [uid, row] of F.server) {
          const key = `${name}/${uid}`;
          if (key === skip) {
            continue;
          }
          if (messagesOf(F)[uid]?.msgid === msgid ||
            (newIds.get(name)?.get(msgid) === uid && row)) {
            return {folder: name, uid};
          }
        }
      }
      return null;
    };

    /** the local file's identity (cheap, local-only) */
    const localMsgid = async (entry) => {
      try {
        return await msgidOf(await store.readFile(entry));
      }
      catch {
        return null;
      }
    };

    /**
     * Duplicates of a claimed message file: a second file with the same uid
     * (duplicate-uid excluded) whose content is the SAME message has no
     * future — plan its removal so it does not warn forever. Different
     * content stays on disk with a warning.
     * @returns {Promise<boolean>} true when at least one duplicate is planned away
     */
    async function sweepDuplicates(folder, claimedEntry) {
      let swept = false;
      for (const ex of folders.get(folder)?.local?.excluded ?? []) {
        if (ex.claimed || ex.uid !== claimedEntry.uid) {
          continue;
        }
        ex.claimed = true;
        const exId = await localMsgid(ex);
        const id = await localMsgid(claimedEntry);
        if (exId && id && exId === id) {
          ops.push({kind: 'purgeLocal', folder, uid: ex.uid, entry: ex});
          warnings.push(`${folder}: duplicate copy of the moved message dropped: ${ex.fileName}`);
          swept = true;
        }
        else {
          warnings.push(`${folder}: second file claims uid ${ex.uid} with different content — kept on disk: ${ex.fileName}`);
        }
      }
      return swept;
    }

    /**
     * A pending local move whose snapshot record is GONE while the server
     * still lists the source uid: the classifier would read the source uid
     * as brand-new mail (revert pull) and leave the moved file unclaimed.
     * Verify the file's identity against the server's raw and, when it
     * matches, replay the move as a server MOVE (the file is removed and
     * the canonical copy arrives with the post-apply pull) — the self-heal
     * for a snapshot that lost a uid to an earlier interrupted/garbled run.
     * @returns {Promise<boolean>} true when the move was replayed (no pull
     *   op wanted for this uid); null lets the normal pull proceed.
     */
    async function healLostMove(name, uid, row) {
      const hit = peekInterloper(name, uid);
      if (!hit || !fmd5ToFolder.has(md5hex(name))) {
        return null;
      }
      const {folder: dst, entry} = hit;
      const raw = raws.get(`${name}/${uid}`) ?? null;
      const fileId = await localMsgid(entry);
      let verified = false;
      if (raw) {
        verified = !!fileId && (await msgidOf(raw)) === fileId;
      }
      else {
        // no mined raw (budget): fall back to size equality
        const size = await store.fileSize(entry);
        verified = row?.size != null && size != null && row.size === size;
        if (verified) {
          emitLog('plan', `${name}: uid ${uid} healed by size match (raw unavailable)`);
        }
      }
      if (!verified) {
        warnings.push(`${name}: local file in "${dst}" claims uid ${uid} (from "${name}") but its content does not match the server copy — file kept: ${entry.fileName}`);
        return null;
      }
      const served = msgidServedElsewhere(fileId, `${name}/${uid}`);
      if (served) {
        // the move was already replayed once (the message already sits on
        // the server in another folder): the file is a stale stray; the
        // source uid itself is genuine mail and still gets its pull
        entry.claimed = true;
        claimedInterlopers.add(entry);
        ops.push({kind: 'purgeLocal', folder: dst, uid: entry.uid, entry});
        warnings.push(`${dst}: pending move of ${name}/${uid} was already replayed on the server — stale copy dropped: ${entry.fileName}`);
        await sweepDuplicates(dst, entry);
        return null;
      }
      entry.claimed = true;
      claimedInterlopers.add(entry);
      ops.push({
        kind: 'moveServer',
        folder: name,
        uid,
        entry,
        toFolder: dst,
        msgid: fileId,
        healed: true
      });
      emitLog('plan', `${name}: uid ${uid} snapshot record lost, pending move to "${dst}" verified by msgid — replayed as a server move`);
      await sweepDuplicates(dst, entry);
      return true;
    }

    // ---- classify (phase order matters: destination uids are claimed
    // before "new on server" pulls are emitted, so a server move and a
    // fresh deliverance cannot produce a double pull).
    // Extra folders pulled into the survey under `only` (interloper source
    // folders) are "restricted": classification is limited to machine B —
    // claiming awaited interlopers and pushing them as moveServer — so a
    // scoped run never plans writes in dirs the user did not ask for.
    for (const [name, F] of folders) {
      const restricted = only != null && name !== only;

      // (A) in K, gone from the server (or the whole folder is stale)
      if (restricted) {
        // skipped for restricted folders: full diffs belong to their own run
      }
      else if (F.resync) {
        ops.push({kind: 'resync', folder: name});
      }
      else if (F.localMissing && F.last) {
        // the server folder still exists but its local Maildir dir was
        // deleted: the snapshot decides the heading — engine-managed dirs
        // are real mirror deletions, never accidental wipes.
        //   - the dir held nothing (empty snapshot) → the server folder
        //     follows it (deleteServerFolder), but ONLY when the server
        //     copy is empty too; a server that still holds mail triggers
        //     the re-pull below so nothing server-side can vanish silently
        //   - the dir held mail → server folder kept, warning logged,
        //     the mirror is re-created and re-pulled (previous behavior)
        const count = Object.keys(F.last.messages).length;
        if (count === 0 && F.server.size === 0) {
          ops.push({kind: 'deleteServerFolder', folder: name, reason: 'local dir deleted'});
        }
        else if (count === 0) {
          emitLog('plan', `${name}: dir deleted locally, but the server copy still holds ${F.server.size} message(s) — re-pulled instead of deleted`);
          ops.push({kind: 'resync', folder: name, reason: 'local dir missing'});
        }
        else {
          emitLog('plan', `${name}: dir deleted locally, but the snapshot holds ${count} message(s) — server folder kept, mirror re-pulled`);
          ops.push({kind: 'resync', folder: name, reason: 'local dir missing'});
        }
      }
      else if (F.last?.messages) {
        for (const [uidTxt, k] of Object.entries(F.last.messages)) {
          const uid = Number(uidTxt);
          if (F.server.has(uid)) {
            continue;
          }
          const target = findNewByMsgid(k.msgid, name);
          const entry = F.local?.entries.get(uid) ?? null;
          if (entry && target) {
            ops.push({
              kind: 'relocate',
              folder: name,
              uid,
              entry,
              toFolder: target.folder,
              toUid: target.uid,
              msgid: k.msgid ?? null
            });
            claim.add(`${target.folder}/${target.uid}`);
          }
          else if (entry) {
            ops.push({kind: 'purgeLocal', folder: name, uid, entry});
          }
          else if (target) {
            // deleted locally, moved on the server → server wins
            conflicts.push({
              folder: name,
              uid,
              resolution: 'server-wins',
              detail: `deleted locally, moved on server to ${target.folder}`
            });
            ops.push({
              kind: 'pull',
              folder: target.folder,
              uid: target.uid,
              size: F.server.get(target.uid)?.size ?? null
            });
            claim.add(`${target.folder}/${target.uid}`);
          }
        }
      }

      // (B) uid present on the server — reconcile K, S and L
      if (F.resync || F.localMissing) {
        // full re-pull: a stale uidvalidity or a vanished local dir means
        // the local mirror is untrustworthy; K is ignored for this folder
        for (const [uid, row] of F.server) {
          ops.push({
            kind: 'pull',
            folder: name,
            uid,
            size: row.size ?? null,
            raw: raws.get(`${name}/${uid}`) ?? null,
            initial: true
          });
        }
        continue;
      }
      const messages = F.last?.messages ?? {};
      if (restricted) {
        for (const uidTxt of Object.keys(messages)) {
          const uid = Number(uidTxt);
          const row = F.server.get(uid);
          if (!row || F.local?.entries.has(uid)) {
            continue;
          }
        const moved = findInterloper(name, uid);
        if (moved) {
          ops.push({
            kind: 'moveServer',
            folder: name,
            uid,
            entry: moved.entry,
            toFolder: moved.folder,
            msgid: messages[uid]?.msgid ?? null
          });
          await sweepDuplicates(moved.folder, moved.entry);
        }
        }
        continue;
      }
      for (const [uid, row] of F.server) {
        const k = messages[uid] ?? null;
        const entry = F.local?.entries.get(uid) ?? null;
        if (!k) {
          if (entry) {
            // uid exists on the server but the snapshot has no record;
            // matching size smuggle-stamps it as pulled
            const size = await store.fileSize(entry);
            if (row.size != null && row.size === size) {
              emitLog('plan', `adopt ${name}/${uid}: local copy matches server size`);
              // the local file is the only snapshot-free evidence of this
              // message, so ITS flags are the freshest state: a local read/
              // un-read/flag edit must push up, never be rewritten back to
              // the server's row (that would unmark local flag changes)
              const sFlags = knownFlags(row.flags);
              if (!sameFlags(entry.flags, row.flags)) {
                const lFlags = knownFlags(entry.flags);
                ops.push({
                  kind: 'flagsServer',
                  folder: name,
                  uid,
                  add: lFlags.filter(f => !sFlags.includes(f)),
                  remove: sFlags.filter(f => !lFlags.includes(f))
                });
                emitLog('plan', `adopt ${name}/${uid}: local flags win, pushed to the server`);
              }
            }
            else {
              warnings.push(`${name}/${uid}: local file rejected (size differs from server), server copy re-pulled: ${entry.fileName}`);
              ops.push({kind: 'purgeLocal', folder: name, uid, entry});
              ops.push({kind: 'pull', folder: name, uid, size: row.size ?? null});
            }
            continue;
          }
          if (claim.has(`${name}/${uid}`)) {
            continue;
          }
          // a pending local move whose snapshot record vanished: verify the
          // moved file's identity and replay the move instead of pulling
          // the source copy back (a "revert" the user never asked for)
          const healed = await healLostMove(name, uid, row);
          if (healed) {
            claim.add(`${name}/${uid}`);
            continue;
          }
          ops.push({
            kind: 'pull',
            folder: name,
            uid,
            size: row.size ?? null,
            raw: raws.get(`${name}/${uid}`) ?? null
          });
          claim.add(`${name}/${uid}`);
          continue;
        }
        if (entry) {
          const sFlags = knownFlags(row.flags);
          const kFlags = knownFlags(k.flags);
          const lFlags = knownFlags(entry.flags);
          const sChanged = !sameFlags(sFlags, kFlags);
          const lChanged = !sameFlags(lFlags, kFlags);
          if (sChanged) {
            if (!sameFlags(sFlags, lFlags)) {
              ops.push({kind: 'reflag', folder: name, uid, entry, flags: sFlags});
            }
            if (lChanged) {
              conflicts.push({
                folder: name,
                uid,
                resolution: 'server-wins',
                detail: 'flag edit on both sides; server kept'
              });
            }
            continue;
          }
          if (lChanged) {
            ops.push({
              kind: 'flagsServer',
              folder: name,
              uid,
              add: lFlags.filter(f => !kFlags.includes(f)),
              remove: kFlags.filter(f => !lFlags.includes(f))
            });
          }
          continue;
        }
        // in K, gone locally, still on the server
        const moved = findInterloper(name, uid);
        if (moved) {
          ops.push({
            kind: 'moveServer',
            folder: name,
            uid,
            entry: moved.entry,
            toFolder: moved.folder,
            msgid: k.msgid ?? null
          });
          await sweepDuplicates(moved.folder, moved.entry);
          continue;
        }
        if (!sameFlags(knownFlags(row.flags), knownFlags(k.flags))) {
          conflicts.push({
            folder: name,
            uid,
            resolution: 'server-wins',
            detail: 'deleted locally, edited on server; re-pulled'
          });
          ops.push({
            kind: 'pull',
            folder: name,
            uid,
            size: row.size ?? null,
            raw: raws.get(`${name}/${uid}`) ?? null
          });
          continue;
        }
        ops.push({kind: 'deleteServer', folder: name, uid, msgid: k.msgid ?? null});
      }

      // (C) local-only files born outside the sync cycle (duplicate-uid
      // files are warned once, in the final sweep below)
      const serverIds = new Set();
      for (const uid of F.server) {
        const kMsgid = messages[uid]?.msgid;
        if (kMsgid) {
          serverIds.add(kMsgid);
        }
      }
      for (const id of newIds.get(name)?.keys() ?? []) {
        serverIds.add(id);
      }
      for (const [uid, entry] of F.local?.entries ?? []) {
        if (!F.server.has(uid) && !messages[uid]) {
          if (restricted) {
            continue;
          }
          await classifyLocalBorn(name, entry, messages, serverIds, `uid ${uid} is neither on the server nor in the snapshot`);
        }
      }
      for (const entry of F.local?.untracked ?? []) {
        if (restricted) {
          continue;
        }
        await classifyLocalBorn(name, entry, messages, serverIds, 'no FMD5 — dropped file');
      }
    }

    function classifyLocalBorn(name, entry, messages, serverIds, whyQuiet) {
      return (async () => {
        let raw = null;
        try {
          raw = await store.readFile(entry);
        }
        catch (e) {
          warnings.push(`${name}: unreadable local file left alone: ${entry.fileName}`);
          return;
        }
        // not everything in a Maildir folder is mail — uploads must be
        // RFC822; anything else stays on disk, only surfaced in the log
        const v = await validateMail(raw);
        if (!v.ok) {
          warnings.push(`${name}: "${entry.fileName}" is not an email (${v.reason}) — ignored, file kept: ${whyQuiet}`);
          entry.ignored = v.reason;
          return;
        }
        const id = await msgidOf(raw);
        if (id && (serverIds.has(id) || Object.values(messages).some(m => m.msgid === id))) {
          warnings.push(`${name}: dropped file "${entry.fileName}" (${whyQuiet}) duplicates a message already on the server; local copy discarded`);
          entry.claimed = true;
          ops.push({kind: 'purgeLocal', folder: name, uid: entry.uid ?? 0, entry});
          return;
        }
        entry.claimed = true;
        ops.push({
          kind: 'append',
          folder: name,
          entry,
          fileName: entry.fileName,
          flags: knownFlags(entry.flags ?? []),
          msgid: id,
          size: await store.fileSize(entry)
        });
        emitLog('plan', `local file ${name}/${entry.fileName} (${whyQuiet}) → append`);
      })();
    }

    // interlopers nobody claimed: source folder gone from the server?
    // FMD5s resolve against the FULL server folder list (fmd5ToFolder,
    // built with the interloper index above) — under `only`, the scoped
    // survey alone would misread an existing folder as gone and wrongly
    // drop the file.
    for (const [fmd5, list] of interlopersBy) {
      const src = fmd5ToFolder.get(fmd5) ?? null;
      for (const {folder, entry} of list) {
        if (claimedInterlopers.has(entry)) {
          continue;
        }
        if (!src) {
          warnings.push(`${folder}: file for a folder the server no longer has (${fmd5.slice(0, 8)}…), dropping: ${entry.fileName}`);
          ops.push({kind: 'purgeLocal', folder, uid: entry.uid, entry});
        }
        else if (only != null && !folders.has(src)) {
          warnings.push(`${folder}: foreign file from "${src}" (unverified under --dir), left unmatched: ${entry.fileName}`);
        }
        else {
          warnings.push(`${folder}: foreign file from "${src}", left unmatched: ${entry.fileName}`);
        }
      }
    }
    for (const F of folders.values()) {
      for (const entry of F.local?.untracked ?? []) {
        if (entry.claimed) {
          continue;
        }
        warnings.push(`${F.name}: untracked file kept (no FMD5 — another tool's mail?): ${entry.fileName}`);
      }
      for (const stat of F.local?.excluded ?? []) {
        if (stat.claimed) {
          continue;
        }
        warnings.push(`${F.name}: ignored "${stat.fileName}" (${stat.reason}: uid ${stat.uid} already tracked by another file); kept on disk`);
      }
      for (const stat of F.local?.stranded ?? []) {
        warnings.push(`${F.name}: file in tmp/ ignored (scratched/dropped too early?): ${stat.fileName}`);
      }
    }
    // local dirs whose server folder is gone (never under a scoped `only`
    // run): dirs whose files are ALL engine-tracked mail classify as one
    // `dropLocal` op behind the dir-drop gate; anything never confirmed
    // server-side (untracked drops, foreign-FMD5 pending moves, tmp strays,
    // duplicate-uid files) keeps the dir on disk — the sync never destroys
    // unpushed local copies.
    for (const name of survey.localOnly) {
      let listing = null;
      try {
        listing = await store.listLocal(name);
      }
      catch {}
      if (!listing) {
        continue; // dir is already gone — nothing to drop
      }
      const buried = listing.untracked.length +
        listing.interlopers.length + listing.excluded.length + listing.stranded.length;
      if (buried) {
        warnings.push(`${name}: server folder gone, but ${buried} file(s) were never uploaded — dir kept on disk (move them out and re-sync, or Discard the account copy)`);
        continue;
      }
      ops.push({
        kind: 'dropLocal',
        folder: name,
        messages: listing.entries.size
      });
    }

    const plan = {
      account,
      only,
      generatedAt: new Date().toISOString(),
      ops,
      conflicts,
      warnings: [...new Set(warnings)]
    };
    const summary = summarize(plan);
    emitLog('plan', `${ops.length} op(s), ${conflicts.length} conflict(s), ${plan.warnings.length} warning(s)`);
    return {plan, summary, survey};
  }

  /**
   * Executes the ops — the only mutating phase on local + server state —
   * then reconciles with a fresh post-apply survey and rewrites the
   * snapshot as the final act. Returns the apply summary.
   */
  async function apply(plan) {
    const survey = plan.__survey;
    selected = null;
    const summary = summarize(plan);
    // executed counts start at zero; summarize() only carries intent
    for (const [key, value] of Object.entries(summary.folders)) {
      summary.folders[key] = blankCounts();
    }
    for (const key of Object.keys(KIND2KEY)) {
      summary[key] = 0;
    }
    for (const key of Object.values(KIND2KEY)) {
      summary[key] = 0;
    }
    const folderOf = (name) => summary.folders[name] ?? (summary.folders[name] = blankCounts());
    const recMsgid = new Map();   // `${folder}/${uid}` → msgid (this run)
    const deadFolders = new Set(); // folders deleted on the server this run
    // pull order follows the survey's INBOX-first, smallest-first ranking;
    // the round-robin scheduler below gives each folder a fair quantum.
    const folderRank = new Map([...survey.folders.keys()].map((name, i) => [name, i]));
    const rankOf = op => folderRank.get(op.folder) ?? 9999;
    let ops = [...plan.ops].sort((a, b) =>
      ((TIER[a.kind] ?? 9) - (TIER[b.kind] ?? 9)) ||
      (rankOf(a) - rankOf(b)) ||
      ((a.uid ?? 0) - (b.uid ?? 0)));
    // Pulls are scheduled fairly: each folder gets one quantum before the
    // scheduler returns to the highest-priority folder. This keeps INBOX
    // first, then follows the survey's folder ranking, without allowing one
    // large folder to monopolize the session.
    const pullByFolder = new Map();
    const nonPulls = [];
    for (const op of ops) {
      if (op.kind === 'pull') {
        const list = pullByFolder.get(op.folder) ?? (pullByFolder.set(op.folder, []).get(op.folder));
        list.push(op);
      }
      else {
        nonPulls.push(op);
      }
    }
    const scheduledPulls = [];
    const pullFolders = [...pullByFolder.keys()].sort((a, b) => rankOf(a) - rankOf(b));
    let pullsLeft = true;
    while (pullsLeft) {
      pullsLeft = false;
      for (const folder of pullFolders) {
        const list = pullByFolder.get(folder);
        if (!list.length) {
          continue;
        }
        pullsLeft = true;
        scheduledPulls.push(...list.splice(0, pullQuantum));
      }
    }
    ops = [...nonPulls, ...scheduledPulls];
    let done = 0;
    const counted = (op) => {
      const key = KIND2KEY[op.kind];
      summary[key] = (summary[key] ?? 0) + 1;
      folderOf(op.folder)[key] = (folderOf(op.folder)[key] ?? 0) + 1;
      op.__counted = true;
      onProgress?.({phase: 'apply', op: op.kind, folder: op.folder, done: ++done, total: ops.length});
    };
    /** counts one op as failed (tolerated, the snapshot stays uncommitted) */
    const failedOp = (op, message) => {
      summary.skipped++;
      summary.failed++;
      op.__counted = true;
      emitLog('apply', `FAILED ${op.kind} ${op.folder}/${op.fileName ?? op.uid ?? '*'}: ${message}`, 'warn');
      onProgress?.({phase: 'apply', op: op.kind, folder: op.folder, done: ++done, total: ops.length});
    };
    /** write one landed pull op (the narration is per chunk, see pullLine) */
    const pullRow = async (op, raw) => {
      const row = survey.folders.get(op.folder)?.server.get(op.uid);
      await store.writeMessage(op.folder, op.uid, knownFlags(row?.flags ?? []), raw);
      recMsgid.set(`${op.folder}/${op.uid}`, await msgidOf(raw));
    };
    /** one narration line per landed chunk: 1 message keeps the old shape */
    const pullLine = (folder, pulled) => {
      if (pulled.length === 1) {
        return `pulled ${folder}/${pulled[0].uid} (${pulled[0].bytes} bytes)`;
      }
      const uids = pulled.map(p => p.uid);
      const bytes = pulled.reduce((sum, p) => sum + p.bytes, 0);
      return `pulled ${folder}/${Math.min(...uids)}…${Math.max(...uids)} ` +
        `(${pulled.length} message(s), ${humanBytes(bytes)})`;
    };
    /**
     * One folder's contiguous pull ops, in pullBatch-sized chunks: each
     * chunk's uids are fetched OVERLAPPED (mail.readMails) and written
     * right away, so memory stays bounded by the chunk — an interrupted
     * run simply leaves the rest to the next run (no snapshot commit).
     */
    async function pullFolderRun(folder, list) {
      try {
        await select(folder, {force: true});
      }
      catch (e) {
        for (const sop of list) {
          failedOp(sop, e?.message || e);
        }
        if (fetchTimedOut(e)) {
          throw e;
        }
        return;
      }
      for (const chunk of chunks(list, pullBatch)) {
        const landed = new Map();
        for (const sop of chunk) {
          if (sop.raw) {
            landed.set(Number(sop.uid), sop.raw);
          }
        }
        const need = chunk.filter(sop => !sop.raw);
        if (need.length) {
          try {
            const mails = await guardedFetch(
              mail.readMails(need.map(sop => Number(sop.uid)), {concurrency: pullBatch}),
              `apply pull ${folder} [${chunk[0].uid}…${chunk[chunk.length - 1].uid}]`);
            for (const m of mails) {
              landed.set(m.uid, m.raw);
            }
          }
          catch (e) {
            if (fetchTimedOut(e)) {
              // the wasm FIFO is jammed behind the hung FETCH: the run
              // cannot limp on — abort and let withSession rebuild
              emitLog('apply', `pull ${folder}: ${e.message} — run aborted, the bridge will be rebuilt`, 'warn');
              throw e;
            }
            // the batch shares one failure path (readMails rejects on the
            // first ruined lane) — retry the chunk's uids one by one
            emitLog('apply', `pull ${folder}: batched fetch failed (${e?.message || e}) — retrying per message`);
            for (const sop of need) {
              try {
                const raw = (await guardedFetch(mail.readMail(Number(sop.uid)),
                  `apply pull ${folder}/${sop.uid}`)).raw;
                landed.set(Number(sop.uid), raw);
              }
              catch (e2) {
                if (fetchTimedOut(e2)) {
                  throw e2;
                }
                // fall through to the per-op accounting below
              }
            }
          }
        }
        const pulled = [];
        for (const sop of chunk) {
          const raw = sop.raw ?? landed.get(Number(sop.uid)) ?? null;
          try {
            if (!raw) {
              throw new Error(`${folder}/${sop.uid}: FETCH failed`);
            }
            await pullRow(sop, raw);
            counted(sop);
            pulled.push({uid: Number(sop.uid), bytes: raw.byteLength});
          }
          catch (e) {
            failedOp(sop, e?.message || e);
            if (fetchTimedOut(e)) {
              throw e;
            }
          }
        }
        if (pulled.length) {
          emitLog('apply', pullLine(folder, pulled));
        }
      }
    }

    for (let i = 0; i < ops.length; ) {
      const op = ops[i];
      if (op.kind === 'pull') {
        let j = i;
        while (j < ops.length && ops[j].kind === 'pull' && ops[j].folder === op.folder) {
          j++;
        }
        const seg = ops.slice(i, j);
        i = j;
        const label = `pull ${op.folder} [${seg.length} message(s)]`;
        try {
          await pullFolderRun(op.folder, seg);
        }
        catch (e) {
          if (fetchTimedOut(e)) {
            emitLog('apply', 'run aborted — the wedged pipe is torn down; the next run re-detects this diff', 'warn');
            throw e;
          }
          emitLog('apply', `pull segment FAILED ${label}: ${e?.message || e}`, 'warn');
          for (const sop of seg) {
            if (!sop.__counted) {
              failedOp(sop, e?.message || e);
            }
          }
        }
        continue;
      }
      if (op.kind === 'deleteServer') {
        let j = i;
        while (j < ops.length && ops[j].kind === 'deleteServer' && ops[j].folder === op.folder) {
          j++;
        }
        const seg = ops.slice(i, j);
        i = j;
        const label = `delete on server ${op.folder} [${seg.length} message(s)]`;
        try {
          await select(op.folder, {force: true});
          await mail.deleteMail(seg.map(sop => Number(sop.uid)));
          emitLog('apply', label);
          for (const sop of seg) {
            counted(sop);
          }
        }
        catch (e) {
          if (fetchTimedOut(e)) {
            emitLog('apply', 'run aborted — the wedged pipe is torn down; the next run re-detects this diff', 'warn');
            throw e;
          }
          // the batch shares one failure path — retry the segment's uids
          // one by one so a single bad uid cannot sink the whole folder
          emitLog('apply', `${label}: batched delete failed (${e?.message || e}) — retrying per message`);
          for (const sop of seg) {
            if (sop.__counted) {
              continue;
            }
            try {
              await select(sop.folder, {force: true});
              await mail.deleteMail(Number(sop.uid));
              counted(sop);
            }
            catch (e2) {
              if (fetchTimedOut(e2)) {
                emitLog('apply', 'run aborted — the wedged pipe is torn down; the next run re-detects this diff', 'warn');
                throw e2;
              }
              failedOp(sop, e2?.message || e2);
            }
          }
        }
        continue;
      }
      i++;
      const tag = `${op.kind === 'append' ? 'upload' : op.kind} ${op.folder}/${op.fileName ?? op.uid ?? '*'}`;
      try {
        switch (op.kind) {
          case 'resync': {
            await store.wipe(op.folder);
            store.clearUidValidity(op.folder).catch(() => {});
            emitLog('apply', `wiped ${op.folder}`);
            break;
          }
          case 'deleteServerFolder': {
            await select(op.folder, {force: true});
            await mail.deleteDir(op.folder);
            deadFolders.add(op.folder);
            emitLog('apply', `deleted server folder ${op.folder}`);
            break;
          }
          case 'purgeLocal': {
            await store.removeMessage(op.entry);
            emitLog('apply', `dropped local ${op.folder}/${op.uid}`);
            break;
          }
          case 'dropLocal': {
            const out = await store.removeFolder(op.folder);
            emitLog('apply', `dropped local dir ${op.folder} (${out.files} message file(s) freed)`);
            break;
          }
          case 'relocate': {
            await store.moveMessage(op.folder, op.entry, op.toFolder, op.toUid);
            if (op.msgid) {
              recMsgid.set(`${op.toFolder}/${op.toUid}`, op.msgid);
            }
            emitLog('apply', `relocated local ${op.folder}/${op.uid} → ${op.toFolder}/${op.toUid}`);
            break;
          }
          case 'reflag': {
            await store.renameMessage(op.folder, op.entry, {flags: op.flags});
            emitLog('apply', `local flags ${op.folder}/${op.uid} [${(op.flags ?? []).join(',')}]`);
            break;
          }
          case 'append': {
            const raw = await store.readFile(op.entry);
            await select(op.folder, {force: true});
            await mail.uploadMail(op.folder, raw, op.flags ?? []);
            await store.removeMessage(op.entry);
            emitLog('apply', `uploaded ${op.folder}/${op.fileName ?? 'file'} (${raw.byteLength} bytes); canonical copy arrives with the post-pull`);
            break;
          }
          case 'flagsServer': {
            await select(op.folder, {force: true});
            await mail.markMail(Number(op.uid), op.add, op.remove);
            emitLog('apply', `server flags ${op.folder}/${op.uid} +[${(op.add ?? []).join(',')}] -[${(op.remove ?? []).join(',')}]`);
            break;
          }
          case 'moveServer': {
            await select(op.folder, {force: true});
            await mail.moveMail(Number(op.uid), op.toFolder);
            await store.removeMessage(op.entry);
            emitLog('apply', `server move ${op.folder}/${op.uid} → ${op.toFolder}`);
            break;
          }
          default:
            throw new Error(`unknown op kind "${op.kind}"`);
        }
        counted(op);
      }
      catch (e) {
        summary.skipped++;
        summary.failed++;
        emitLog('apply', `FAILED ${tag}: ${e?.message || e}`, 'warn');
        if (fetchTimedOut(e)) {
          // a wedged FETCH jams the wasm FIFO for good: every later op
          // would fail the same way — abort and let withSession rebuild
          emitLog('apply', 'run aborted — the wedged pipe is torn down; the next run re-detects this diff', 'warn');
          throw e;
        }
      }
    }

    // post-apply survey: the truth the snapshot must now describe; anything
    // new also gets pulled right away (e.g. a moved message's fresh uid in
    // its destination folder). readDir() again — uidnext/uidvalidity may
    // have moved because of this run's own ops (APPEND, MOVE, …), and a
    // cached "already open dir" must not show a stale status.
    // Scoped run (only): start from the pre-sync snapshot and rewrite just
    // the synced dir's entry — untouched dirs keep their old state lines.
    const snapOut = {version: 2, lastSyncAt: null, folders: only ? structuredClone(survey.snap.folders ?? {}) : {}};
    for (const F of survey.folders.values()) {
      if (deadFolders.has(F.name)) {
        // deleted on the server by this run: a SELECT would fail and the
        // old entry must not re-enter the snapshot
        emitLog('post', `${F.name}: deleted on the server this run — snapshot entry dropped`);
        continue;
      }
      const restricted = only != null && F.name !== only;
      selected = null;
      const st = await select(F.name);
      const uidvalidity = Number(st?.uidvalidity || 0);
      const uidnext = Number(st?.uidnext || 0);
      const post = await rowsFor(F.name, uidnext);
      if (!restricted) {
        await store.writeUidValidity(F.name, uidvalidity);
      }
      const messages = restricted ? null : {};
      for (const [uid, row] of post) {
        const key = `${F.name}/${uid}`;
        if (!F.server.has(uid) && !recMsgid.has(key)) {
          try {
            await select(F.name);
            const raw = (await guardedFetch(mail.readMail(uid),
              `post-pull ${F.name}/${uid}`)).raw;
            recMsgid.set(key, await msgidOf(raw));
            await store.writeMessage(F.name, uid, knownFlags(row.flags), raw);
            folderOf(F.name).added++;
            emitLog('apply', `pulled ${F.name}/${uid} (arrived during the run)`);
          }
          catch (e) {
            summary.skipped++;
            emitLog('apply', `FAILED ${key} post-pull: ${e?.message || e}`, 'warn');
            if (fetchTimedOut(e)) {
              throw e;   // wedged FETCH — abort before the snapshot commit
            }
          }
        }
        if (restricted) {
          // scoped extra folder: pulled arrivals land locally, but its
          // snapshot entry keeps the old state — a later full run or its
          // own sync reconciles it (never destructively)
          continue;
        }
        messages[uid] = {
          msgid: recMsgid.get(key) ?? F.last?.messages?.[uid]?.msgid ?? null,
          // full flags: standard letters PLUS server keywords ($Filtered, …)
          // — unencodable in filenames, so the snapshot carries them; the
          // classifier only ever diffs the standard-letter subset
          flags: readableFlags(row.flags)
        };
      }
      if (restricted) {
        emitLog('post', `${F.name}: arrivals pulled, snapshot kept (outside the scoped dir)`);
        continue;
      }
      snapOut.folders[F.name] = {uidvalidity, uidnext, messages};
      emitLog('post', `${F.name}: ${Object.keys(messages).length} message(s), uidvalidity=${uidvalidity}, uidnext=${uidnext}`);
    }
    snapOut.lastSyncAt = new Date().toISOString();
    summary.finishedAt = snapOut.lastSyncAt;
    if (summary.failed > 0) {
      // SAFETY: a partially applied run must not rewrite the snapshot as if
      // everything succeeded — uids the engine failed to pull would be
      // classified as *local deletions* next run and pushed to the server.
      // Keeping the old snapshot makes the next run replay the same diffs.
      summary.finishedAt = null;
      emitLog('sync', `SNAPSHOT NOT COMMITTED: ${summary.failed} op(s) failed; the next run will re-detect these diffs`, 'warn');
      return summary;
    }
    await store.saveState(snapOut);
    emitLog('sync', `committed state: ${Object.values(snapOut.folders).reduce((n, f) => n + Object.keys(f.messages).length, 0)} message(s) total`);
    return summary;
  }

  /**
   * One full cycle. With {dry: true} only survey+plan run (read-only) and
   * the plan object is returned so a caller may display or apply it later;
   * otherwise plan.executed. Returns {dry, plan, summary}.
   */
  async function run({dry = false} = {}) {
    const {plan: planned, summary, survey} = await plan();
    for (const entry of describePlan(planned)) {
      emitLog(entry.type, entry.content, entry.cls);
    }
    // volume heads-up: what a first sync (or a long-absent account) pulls
    // from the server — no more silent runs on full re-pull folders
    const pulls = planned.ops.filter(op => op.kind === 'pull');
    if (pulls.length) {
      const perFolder = new Map();    // folder → {count, bytes}
      for (const op of pulls) {
        const row = survey.folders.get(op.folder)?.server.get(op.uid);
        const stat = perFolder.get(op.folder) ?? (perFolder.set(op.folder, {count: 0, bytes: 0, known: 0}).get(op.folder));
        stat.count++;
        if (row?.size != null) {
          stat.bytes += row.size;
          stat.known++;
        }
      }
      for (const [folder, stat] of perFolder) {
        if (stat.count > 50 || stat.bytes > HEAVY_BYTES / 2) {
          emitLog('plan', `${folder}: ${stat.count} message(s), ~${humanBytes(stat.bytes)} will be fetched from the server` +
            (survey.folders.get(folder)?.localMissing ? ' (full re-pull — no local copy yet)' : ''));
        }
      }
      let count = 0;
      let bytes = 0;
      let fullyKnown = true;
      for (const stat of perFolder.values()) {
        count += stat.count;
        bytes += stat.bytes;
        fullyKnown = fullyKnown && stat.known === stat.count;
      }
      if (count > HEAVY_MESSAGES || (fullyKnown && bytes > HEAVY_BYTES)) {
        emitLog('plan', `heavy sync: ${count} message(s), ~${humanBytes(bytes)} total across ` +
          `${perFolder.size} folder(s) — this may take a while`, 'warn');
      }
    }
    if (dry) {
      return {dry: true, plan: planned, summary};
    }
    // pullQuantum controls fairness only. Every planned message is fetched
    // during this run; there is no per-folder initial-pull limit.
    // Purge gate: a uid in the snapshot that is gone locally with no
    // foreign-FMD5 file anywhere in the handle means the file was taken
    // outside the granted directory (or removed by another tool). Nothing
    // on disk vouches for it any more, so the server delete is destructive
    // and ambiguous — the user must confirm it before apply() runs.
    const purges = planned.ops.filter(op => op.kind === 'deleteServer');
    if (purges.length && typeof confirmPurge === 'function') {
      let ok = false;
      try {
        ok = (await confirmPurge({ops: purges, describe: describeOp, count: purges.length})) === true;
      }
      catch (e) {
        emitLog('sync', `purge gate FAILED (${e?.message || e}) — server deletes declined`, 'warn');
      }
      if (!ok) {
        planned.ops = planned.ops.filter(op => op.kind !== 'deleteServer');
        summary.serverDeletes = 0;
        summary.skipped += purges.length;
        emitLog('sync', `server purge declined for ${purges.length} message(s) — kept on the server`);
      }
      else {
        emitLog('sync', `server purge confirmed for ${purges.length} message(s)`);
      }
    }
    // Dir-drop gate: a local Maildir whose server folder is gone is only
    // ever planned when every file in it is confirmed server-side mail —
    // still a destructive op, so the user confirms it before apply() runs.
    const drops = planned.ops.filter(op => op.kind === 'dropLocal');
    if (drops.length && typeof confirmDropDirectory === 'function') {
      let ok = false;
      try {
        ok = (await confirmDropDirectory({ops: drops, describe: describeOp, count: drops.length})) === true;
      }
      catch (e) {
        emitLog('sync', `dir-drop gate FAILED (${e?.message || e}) — local dirs kept`, 'warn');
      }
      if (!ok) {
        planned.ops = planned.ops.filter(op => op.kind !== 'dropLocal');
        summary.droppedDirs = 0;
        summary.skipped += drops.length;
        emitLog('sync', `local dir drop declined for ${drops.length} dir(s) — kept on disk`);
      }
      else {
        emitLog('sync', `local dir drop confirmed for ${drops.length} dir(s)`);
      }
    }
    planned.__survey = survey;
    planned.__summary = summary;
    const applied = await apply(planned);
    return {dry: false, plan: planned, summary: applied};
  }

  return {
    plan,
    run,
    describePlan
  };
}
