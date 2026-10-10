#!/usr/bin/env node
// Regression tests for the sync engine's foreign-FMD5 (interloper) handling,
// plus the moveServer marker-removal hardening — and the pull-time filter
// routing (route-finder writes INTO the destination Maildir).
// Run: node data/sync/offscreen/sync.test.mjs
//
// The bugs these pin down:
// 1. a keepFmd5 pending-move file whose claimed source uid is gone from the
//    source folder's server AND snapshot (an earlier run already replayed
//    the move on the server but its marker-file removal failed) was never
//    claimed by any classifier path — it warned
//    `foreign file from "INBOX", left unmatched` on EVERY run, and the
//    post-run pending-move report re-marked the holding dirs dirty forever,
//    so the scheduler re-armed resyncs in an infinite loop. The plan() final
//    sweep now resolves such files by msgid and purges the stale copy.
// 2. a message whose snapshot msgid is null (a size-adopted row that never
//    learned its identity) was invisible to that msgid matcher, so markers
//    pointing at it stayed unmatched too. Server rows without a snapshot
//    identity now fall back to their canonical local file's msgid, and the
//    commit stops writing null identities.
// 3. a marker whose message is served NOWHERE (source uid gone from server
//    and snapshot, message nowhere on the server) is the only copy: it was
//    left on disk with the warning, which re-marked the dir dirty forever.
//    It is now uploaded to the folder it sits in (append) so the move
//    completes and the marker becomes resolvable.
//
// Pull-time routing (the `route` finder): a pulled INBOX message whose
// first matching filter is a MOVE is written STRAIGHT into the destination
// dir with the SOURCE folder's FMD5 (the pending-move marker the next run
// replays as a server MOVE) — the same end state the old
// write-into-INBOX-then-rename pass reached, minus the rename. Stop
// windows, self-targeted moves and no-matches keep landing in INBOX with
// their own FMD5, marked routed so the post-sync pass never re-filters
// them; a throwing finder leaves the message unrouted (INBOX, own FMD5).

import {register} from 'node:module';
register('./root-loader.mjs', import.meta.url);

const {md5hex, makeFilename} = await import('../maildir.mjs');
const {msgidOf} = await import('../snapshot.mjs');
const {createSync, describeOp} = await import('./sync.mjs');
// the pull-time routing tests drive the real filter walk (route.mjs — the
// postal-mime specifier resolves through the loader registered above)
const {routeMessage} = await import('../filters/route.mjs');

import assert from 'node:assert/strict';

const enc = new TextEncoder();
const rawOf = msgid => enc.encode(
  `From: a@b.c\r\nSubject: t\r\nMessage-Id: <${msgid}>\r\n\r\nbody\r\n`);
const idOf = async msgid => await msgidOf(rawOf(msgid));

// ---- mock mail (IMAP facade) + store (MaildirStore) ------------------------

function mockMail(server, {failMove = false} = {}) {
  return {
    fetches: 0,      // raw downloads (readMail/readMails)
    current: null,
    async folders() {
      return [...server.keys()].map(name => ({name, delimiter: '.', attrs: []}));
    },
    async readDir(name) {
      this.current = name;
      return server.get(name).status;
    },
    async listMails({fromUid, toUid}) {
      const rows = [];
      for (const [uid, row] of server.get(this.current).rows) {
        if (uid >= fromUid && uid <= toUid) {
          rows.push({uid, ...row});
        }
      }
      return rows.sort((a, b) => a.uid - b.uid);
    },
    async readMails(uids) {
      this.fetches++;
      const dir = server.get(this.current);
      return uids.map(uid => ({uid, raw: dir.raws.get(uid)}));
    },
    async readMail(uid) {
      this.fetches++;
      const dir = server.get(this.current);
      return {uid, folder: this.current, size: dir.raws.get(uid).length, raw: dir.raws.get(uid)};
    },
    async moveMail(uid, mailbox) {
      if (failMove) {
        throw new Error('mock-fs: move failed');
      }
      const dir = server.get(this.current);
      const raw = dir.raws.get(uid);
      const row = dir.rows.get(uid);
      dir.rows.delete(uid);
      dir.raws.delete(uid);
      const dst = server.get(mailbox);
      // MOVE assigns a FRESH uid in the destination: the next value in the
      // dest folder's uid space — the post-apply survey sees the arrival
      const newUid = dst.status.uidnext;
      dst.status.uidnext += 1;
      dst.raws.set(newUid, raw);
      dst.rows.set(newUid, {
        flags: row.flags, subject: row.subject ?? null,
        from: null, date: null, size: raw.length
      });
      return newUid;
    },
    /**
     * APPEND: the local-born upload path (`append` op). The server assigns
     * the next uid — mocked via status.uidnext so the post-apply survey
     * sees the arrival (uid beyond the pre-surveyed space) — and stores
     * the raw for the post-pull FETCH.
     */
    async uploadMail(mailbox, raw, flags = []) {
      const dst = server.get(mailbox);
      const uid = dst.status.uidnext;
      dst.status.uidnext += 1;
      dst.raws.set(uid, raw);
      dst.rows.set(uid, {flags: flags ?? [], subject: null, from: null, date: null, size: raw.length});
      return true;
    }
  };
}

function mockStore(snapshot, listings, delimiter = '/', failRenames = false) {
  const saved = [];
  return {
    delimiter,
    saved,
    // every writeMessage call the engine makes — {folder, uid, flags, bytes,
    // fmd5|null}: pull-time routing lands in the DESTINATION dir with the
    // SOURCE folder's md5, unrouted pulls land in their folder unmarked
    written: [],
    // every moveMessage call — {srcFolder, dstFolder, uid, keepFmd5,
    // flags}: the kept-copy rename of a replayed server move is a
    // same-folder call with keepFmd5 false, the fresh uid and the fresh
    // server row's flags
    moves: [],
    async loadState() {
      return structuredClone(snapshot);
    },
    async loadPrefs() {
      return {};
    },
    async listFolders() {
      return [...listings.keys()];
    },
    async listLocal(name) {
      return listings.get(name);
    },
    async readFile(entry) {
      if (entry.unreadable) {
        throw new Error('mock-fs: read failed');
      }
      return entry.raw;
    },
    async fileSize(entry) {
      return entry.raw.length;
    },
    async removeMessage() {
      return false;   // the wedged-FS failure mode
    },
    async moveMessage(srcFolder, entry, dstFolder, uid, opts) {
      if (failRenames) {
        throw new Error('mock-fs: rename failed');
      }
      this.moves.push({
        srcFolder,
        dstFolder,
        uid: Number(uid),
        keepFmd5: !!opts?.keepFmd5,
        flags: opts?.flags ?? null
      });
    },
    async writeMessage(folder, uid, flags, raw, opts) {
      this.written.push({
        folder,
        uid: Number(uid),
        flags: flags ?? [],
        bytes: raw?.byteLength ?? null,
        fmd5: opts?.fmd5 ?? null
      });
    },
    async writeUidValidity() {},
    async saveState(snap) {
      saved.push(snap);
    },
    async clearUidValidity() {}
  };
}

// local file entry as listLocal() would produce it
function fileEntry(fileName, uid, fmd5, raw, flags = []) {
  return {
    fileName, uid, fmd5, flags, raw,
    dir: 'cur', unique: fileName.split(',')[0], folder: null, maildir: null
  };
}

function listing(entries, interlopers = []) {
  return {
    entries: new Map(entries.map(e => [e.uid, e])),
    untracked: [],
    interlopers,
    excluded: [],
    stranded: []
  };
}

const quietLog = () => {};

// server picture helper: uid → {flags: []}, raws uid → raw
function dirState(uidvalidity, uidnext, rows) {
  return {
    status: {folder: 'x', exists: true, uidvalidity, uidnext},
    rows: new Map([...rows].map(([uid, msgid]) =>
      [uid, {flags: [], subject: msgid, from: null, date: null, size: rawOf(msgid).length}])),
    raws: new Map([...rows].map(([uid, msgid]) => [uid, rawOf(msgid)]))
  };
}

// ---- scenario A: the replayed-move orphan (the user's bug) -----------------
// K committed the move already: INBOX's snapshot lost uid 5, the server
// never serves it again, the message sits in the destination (uid 10) —
// yet the keepFmd5 marker file survived. Must purge the stale copy.
{
  const m5 = await idOf('m5');
  const m7 = await idOf('m7');
  const m8 = await idOf('m8');
  const server = new Map([
    ['INBOX', dirState(1000, 9, [[7, 'm7'], [8, 'm8']])],
    ['Silent.Broken Links', dirState(2000, 11, [[10, 'm5']])]
  ]);
  const snapshot = {
    version: 2, lastSyncAt: null,
    folders: {
      'INBOX': {uidvalidity: 1000, uidnext: 9, messages: {
        7: {msgid: m7, flags: []}, 8: {msgid: m8, flags: []}
      }},
      'Silent.Broken Links': {uidvalidity: 2000, uidnext: 11, messages: {
        10: {msgid: m5, flags: []}
      }}
    }
  };
  const interloperName = makeFilename('INBOX', 5, [], {unique: '1790237428.M147P299eQ1.sync', fmd5: md5hex('INBOX')});
  const listings = new Map([
    ['INBOX', listing([
      fileEntry('f7', 7, md5hex('INBOX'), rawOf('m7')),
      fileEntry('f8', 8, md5hex('INBOX'), rawOf('m8'))
    ])],
    ['Silent.Broken Links', listing([
      fileEntry('f10', 10, md5hex('Silent.Broken Links'), rawOf('m10'))
    ], [
      fileEntry(interloperName, 5, md5hex('INBOX'), rawOf('m5'))
    ])]
  ]);

  const engine = createSync(mockMail(server), mockStore(snapshot, listings), {log: quietLog});
  const {plan} = await engine.plan();

  assert.equal(plan.ops.length, 1, 'exactly one op: ' + JSON.stringify(plan.ops.map(describeOp)));
  assert.equal(plan.ops[0].kind, 'purgeLocal');
  assert.equal(plan.ops[0].folder, 'Silent.Broken Links');
  assert.equal(plan.ops[0].uid, 5);
  assert.equal(plan.ops[0].entry.fileName, interloperName);
  assert.ok(plan.warnings.some(w => w.includes('stale pending-move copy dropped')),
    'stale-copy warning present: ' + JSON.stringify(plan.warnings));
  assert.ok(!plan.warnings.some(w => w.includes('left unmatched')),
    'no "left unmatched" warning: ' + JSON.stringify(plan.warnings));
  assert.equal(plan.conflicts.length, 0);
}

// ---- scenario B: duplicate copy — the source still owns the uid ------------
// INBOX still has its own file for uid 5 (so the marker is a duplicate of
// server mail, not a pending move): must purge the marker, never plan a
// moveServer or a deleteServer for the source uid.
{
  const m5 = await idOf('m5');
  const m7 = await idOf('m7');
  const m9 = await idOf('m9');
  const server = new Map([
    ['INBOX', dirState(1000, 9, [[5, 'm5'], [7, 'm7']])],
    ['Silent.Broken Links', dirState(2000, 11, [[9, 'm9']])]
  ]);
  const snapshot = {
    version: 2, lastSyncAt: null,
    folders: {
      'INBOX': {uidvalidity: 1000, uidnext: 9, messages: {
        5: {msgid: m5, flags: []}, 7: {msgid: m7, flags: []}
      }},
      'Silent.Broken Links': {uidvalidity: 2000, uidnext: 11, messages: {
        9: {msgid: m9, flags: []}
      }}
    }
  };
  const interloperName = makeFilename('INBOX', 5, [], {unique: 'u5', fmd5: md5hex('INBOX')});
  const listings = new Map([
    ['INBOX', listing([
      fileEntry('f5', 5, md5hex('INBOX'), rawOf('m5')),
      fileEntry('f7', 7, md5hex('INBOX'), rawOf('m7'))
    ])],
    ['Silent.Broken Links', listing([
      fileEntry('f9', 9, md5hex('Silent.Broken Links'), rawOf('m9'))
    ], [
      fileEntry(interloperName, 5, md5hex('INBOX'), rawOf('m5'))
    ])]
  ]);

  const engine = createSync(mockMail(server), mockStore(snapshot, listings), {log: quietLog});
  const {plan} = await engine.plan();

  assert.deepEqual(plan.ops.map(o => o.kind), ['purgeLocal'],
    'only the stale marker is purged: ' + JSON.stringify(plan.ops.map(describeOp)));
  assert.equal(plan.ops[0].folder, 'Silent.Broken Links');
  assert.equal(plan.ops[0].uid, 5);
  assert.ok(!plan.warnings.some(w => w.includes('left unmatched')));
}

// ---- scenario C: marker whose message is served nowhere — uploaded ---------
// The marker's message is served NOWHERE (source uid expunged, message not
// on the server in any folder): the file is the only copy. Leaving it keeps
// the warning AND re-marks the dir dirty on every run, so the move is
// completed as an APPEND into the folder it already sits in (no purge, no
// "left unmatched" warning left to loop the resync scheduler).
{
  const m5 = await idOf('m5');
  const m7 = await idOf('m7');
  const m9 = await idOf('m9');
  const server = new Map([
    ['INBOX', dirState(1000, 9, [[7, 'm7']])],
    ['Silent.Broken Links', dirState(2000, 11, [[9, 'm9']])]
  ]);
  const snapshot = {
    version: 2, lastSyncAt: null,
    folders: {
      'INBOX': {uidvalidity: 1000, uidnext: 9, messages: {
        5: {msgid: m5, flags: []}, 7: {msgid: m7, flags: []}
      }},
      'Silent.Broken Links': {uidvalidity: 2000, uidnext: 11, messages: {}}
    }
  };
  const interloperName = makeFilename('INBOX', 5, [], {unique: 'u5', fmd5: md5hex('INBOX')});
  const listings = new Map([
    ['INBOX', listing([
      fileEntry('f7', 7, md5hex('INBOX'), rawOf('m7'))
    ])],
    ['Silent.Broken Links', listing([
      fileEntry('f9', 9, md5hex('Silent.Broken Links'), rawOf('m9'))
    ], [
      fileEntry(interloperName, 5, md5hex('INBOX'), rawOf('m5'))
    ])]
  ]);

  const engine = createSync(mockMail(server), mockStore(snapshot, listings), {log: quietLog});
  const {plan} = await engine.plan();

  assert.ok(!plan.ops.some(o => o.kind === 'purgeLocal'),
    'genuine pending move is never purged: ' + JSON.stringify(plan.ops.map(describeOp)));
  const appendOp = plan.ops.find(o => o.kind === 'append');
  assert.ok(appendOp, 'the only-copy marker is uploaded: ' +
    JSON.stringify(plan.ops.map(describeOp)));
  assert.equal(appendOp.folder, 'Silent.Broken Links',
    'the marker is uploaded to the folder it sits in');
  assert.ok(!plan.warnings.some(w => w.includes('left unmatched')),
    'no "left unmatched" warning: ' + JSON.stringify(plan.warnings));
}

// ---- scenario E: size-adopted destination message with a null msgid --------
// The destination holds the moved message (canonical local file + server
// row) but its snapshot msgid is null — a size-adopted row that never
// learned its identity. The stale marker must still be purged: server rows
// without a snapshot identity fall back to their canonical local file.
{
  const m5 = await idOf('m5');
  const m7 = await idOf('m7');
  const m8 = await idOf('m8');
  const server = new Map([
    ['INBOX', dirState(1000, 9, [[7, 'm7'], [8, 'm8']])],
    ['Trash', dirState(3000, 20, [[10, 'm5']])]
  ]);
  const snapshot = {
    version: 2, lastSyncAt: null,
    folders: {
      'INBOX': {uidvalidity: 1000, uidnext: 9, messages: {
        7: {msgid: m7, flags: []}, 8: {msgid: m8, flags: []}
      }},
      'Trash': {uidvalidity: 3000, uidnext: 20, messages: {
        10: {msgid: null, flags: []}
      }}
    }
  };
  const interloperName = makeFilename('INBOX', 5, [], {unique: 'u5', fmd5: md5hex('INBOX')});
  const listings = new Map([
    ['INBOX', listing([
      fileEntry('f7', 7, md5hex('INBOX'), rawOf('m7')),
      fileEntry('f8', 8, md5hex('INBOX'), rawOf('m8'))
    ])],
    ['Trash', listing([
      fileEntry('f10', 10, md5hex('Trash'), rawOf('m5'))
    ], [
      fileEntry(interloperName, 5, md5hex('INBOX'), rawOf('m5'))
    ])]
  ]);

  const engine = createSync(mockMail(server), mockStore(snapshot, listings), {log: quietLog});
  const {plan} = await engine.plan();

  assert.deepEqual(plan.ops.map(o => o.kind), ['purgeLocal'],
    'the stale marker is purged via the local identity fallback: ' +
    JSON.stringify(plan.ops.map(describeOp)));
  assert.equal(plan.ops[0].folder, 'Trash');
  assert.ok(plan.warnings.some(w => w.includes('stale pending-move copy dropped')),
    'stale-copy warning present: ' + JSON.stringify(plan.warnings));
  assert.ok(!plan.warnings.some(w => w.includes('left unmatched')),
    'no "left unmatched" warning: ' + JSON.stringify(plan.warnings));
}

// ---- scenario D: a failed server MOVE keeps the marker, never commits -----
// The replay fails on the IMAP side (moveMail throws — the mock's fail path
// replaces the old failing-removeMarker shape, which no longer exists: the
// op keeps the file for the post-apply pairing). The op counts as failed,
// the snapshot stays uncommitted, and the next run re-detects the whole
// state instead of orphaning the file forever.
{
  const m5 = await idOf('m5');
  const server = new Map([
    ['INBOX', dirState(1000, 9, [[5, 'm5']])],
    ['Silent.Broken Links', dirState(2000, 11, [])]
  ]);
  const snapshot = {
    version: 2, lastSyncAt: null,
    folders: {
      'INBOX': {uidvalidity: 1000, uidnext: 9, messages: {
        5: {msgid: m5, flags: []}
      }},
      'Silent.Broken Links': {uidvalidity: 2000, uidnext: 11, messages: {}}
    }
  };
  const interloperName = makeFilename('INBOX', 5, [], {unique: 'u5', fmd5: md5hex('INBOX')});
  const listings = new Map([
    ['INBOX', listing([])],
    ['Silent.Broken Links', listing([], [
      fileEntry(interloperName, 5, md5hex('INBOX'), rawOf('m5'))
    ])]
  ]);

  const store = mockStore(snapshot, listings);
  const engine = createSync(mockMail(server, {failMove: true}), store, {log: quietLog});
  const {summary} = await engine.run({dry: false});

  assert.equal(summary.failed, 1, 'the moveServer op failed');
  assert.equal(summary.moveServer, 0, 'the moveServer op was not counted as done');
  assert.equal(store.saved.length, 0, 'snapshot NOT committed');
  assert.deepEqual(store.moves, [], 'no local rename happened on a failed MOVE');
}

// ---- scenario F: duplicate-uid, same message → purge, no rename -----------
// A leftover duplicate of uid 9 (same Message-ID as the tracked file) must
// be classified as a stale copy and purged — never renamed to a surrogate
// uid, never left to warn on every run.
{
  const m9 = await idOf('m9');
  const server = new Map([
    ['INBOX', dirState(1000, 10, [[9, 'm9']])]
  ]);
  const snapshot = {
    version: 2, lastSyncAt: null,
    folders: {
      'INBOX': {uidvalidity: 1000, uidnext: 10, messages: {
        9: {msgid: m9, flags: []}
      }}
    }
  };
  const dupName = makeFilename('INBOX', 9, [], {unique: 'dup1', fmd5: md5hex('INBOX')});
  const loser = fileEntry(dupName, 9, md5hex('INBOX'), rawOf('m9'));
  const listings = new Map([
    ['INBOX', listing([fileEntry('f9', 9, md5hex('INBOX'), rawOf('m9'))])]
  ]);
  listings.get('INBOX').excluded.push(loser);

  const engine = createSync(mockMail(server), mockStore(snapshot, listings), {log: quietLog});
  const {plan} = await engine.plan();

  assert.deepEqual(plan.ops.map(o => o.kind), ['purgeLocal'],
    'the same-message duplicate is purged: ' + JSON.stringify(plan.ops.map(describeOp)));
  assert.equal(plan.ops[0].uid, 9);
  assert.ok(!plan.ops.some(o => o.kind === 'append'),
    'no append for an already-served message');
}

// ---- scenario G: duplicate-uid, different message → APPEND this run --------
// The loser carries DIFFERENT mail under the winner's uid. It must join the
// ordinary local-born classification and be planned for upload in the SAME
// sync — no surrogate rename, no "kept on disk" warning loop.
{
  const m9 = await idOf('m9');
  const m20 = await idOf('m20');
  const server = new Map([
    ['INBOX', dirState(1000, 10, [[9, 'm9']])]
  ]);
  const snapshot = {
    version: 2, lastSyncAt: null,
    folders: {
      'INBOX': {uidvalidity: 1000, uidnext: 10, messages: {
        9: {msgid: m9, flags: []}
      }}
    }
  };
  const dupName = makeFilename('INBOX', 9, [], {unique: 'dup1', fmd5: md5hex('INBOX')});
  const loser = fileEntry(dupName, 9, md5hex('INBOX'), rawOf('m20'));
  const listings = new Map([
    ['INBOX', listing([fileEntry('f9', 9, md5hex('INBOX'), rawOf('m9'))])]
  ]);
  listings.get('INBOX').excluded.push(loser);

  const engine = createSync(mockMail(server), mockStore(snapshot, listings), {log: quietLog});
  const {plan} = await engine.plan();

  assert.deepEqual(plan.ops.map(o => o.kind), ['append'],
    'the different-message duplicate is uploaded this run: ' +
    JSON.stringify(plan.ops.map(describeOp)));
  assert.equal(plan.ops[0].msgid, m20, 'the upload carries the loser message');
  assert.ok(!plan.warnings.some(w => w.includes('already tracked by another file')),
    'no permanent duplicate-uid warning: ' + JSON.stringify(plan.warnings));
}

// ---- scenario H: duplicate-uid whose message lives in ANOTHER folder -------
// Cross-folder identity: the loser's Message-ID is served in Trash, so the
// local copy is dropped instead of being APPENDed twice.
{
  const m9 = await idOf('m9');
  const server = new Map([
    ['INBOX', dirState(1000, 10, [[9, 'm9']])],
    ['Trash', dirState(3000, 30, [[20, 'm9']])]
  ]);
  const snapshot = {
    version: 2, lastSyncAt: null,
    folders: {
      'INBOX': {uidvalidity: 1000, uidnext: 10, messages: {
        9: {msgid: m9, flags: []}
      }},
      'Trash': {uidvalidity: 3000, uidnext: 30, messages: {
        20: {msgid: m9, flags: []}
      }}
    }
  };
  // loser shares the winner's uid in INBOX but its message is m9 — whose
  // identity is ALSO served in Trash; the winner file serves it in INBOX,
  // so the loser is a plain duplicate of the served message
  const dupName = makeFilename('INBOX', 9, [], {unique: 'dup1', fmd5: md5hex('INBOX')});
  const loser = fileEntry(dupName, 9, md5hex('INBOX'), rawOf('m9'));
  const listings = new Map([
    ['INBOX', listing([fileEntry('f9', 9, md5hex('INBOX'), rawOf('m9'))])],
    ['Trash', listing([fileEntry('f20', 20, md5hex('Trash'), rawOf('m9'))])]
  ]);
  listings.get('INBOX').excluded.push(loser);

  const engine = createSync(mockMail(server), mockStore(snapshot, listings), {log: quietLog});
  const {plan} = await engine.plan();

  assert.deepEqual(plan.ops.map(o => o.kind), ['purgeLocal'],
    'same-uid duplicate of a served message is purged, not appended: ' +
    JSON.stringify(plan.ops.map(describeOp)));
}

// ---- scenario I: unreadable duplicate-uid loser → kept + warned ------------
// A loser whose bytes cannot be read must stay on disk with its warning —
// never a plan op that would fail the run later.
{
  const m9 = await idOf('m9');
  const server = new Map([
    ['INBOX', dirState(1000, 10, [[9, 'm9']])]
  ]);
  const snapshot = {
    version: 2, lastSyncAt: null,
    folders: {
      'INBOX': {uidvalidity: 1000, uidnext: 10, messages: {
        9: {msgid: m9, flags: []}
      }}
    }
  };
  const dupName = makeFilename('INBOX', 9, [], {unique: 'dup1', fmd5: md5hex('INBOX')});
  const loser = fileEntry(dupName, 9, md5hex('INBOX'), rawOf('m9'));
  loser.unreadable = true;
  const listings = new Map([
    ['INBOX', listing([fileEntry('f9', 9, md5hex('INBOX'), rawOf('m9'))])]
  ]);
  listings.get('INBOX').excluded.push(loser);

  const engine = createSync(mockMail(server), mockStore(snapshot, listings), {log: quietLog});
  const {plan} = await engine.plan();

  assert.deepEqual(plan.ops.map(o => o.kind), [],
    'no ops for an unreadable loser: ' + JSON.stringify(plan.ops.map(describeOp)));
  assert.ok(plan.warnings.some(w => w.includes('unreadable local file left alone')),
    'the unreadable duplicate is warned about: ' + JSON.stringify(plan.warnings));
}

// ---- scenario J: scoped run never touches other folders' duplicates -------
// `only` = INBOX: a duplicate-uid loser in Trash must produce zero ops and
// zero classification there.
{
  const m9 = await idOf('m9');
  const server = new Map([
    ['INBOX', dirState(1000, 10, [[9, 'm9']])],
    ['Trash', dirState(3000, 30, [])]
  ]);
  const snapshot = {
    version: 2, lastSyncAt: null,
    folders: {
      'INBOX': {uidvalidity: 1000, uidnext: 10, messages: {
        9: {msgid: m9, flags: []}
      }},
      'Trash': {uidvalidity: 3000, uidnext: 30, messages: {}}
    }
  };
  const dupName = makeFilename('Trash', 9, [], {unique: 'dup1', fmd5: md5hex('Trash')});
  const loser = fileEntry(dupName, 9, md5hex('Trash'), rawOf('m9'));
  const listings = new Map([
    ['INBOX', listing([fileEntry('f9', 9, md5hex('INBOX'), rawOf('m9'))])],
    ['Trash', listing([])]
  ]);
  listings.get('Trash').excluded.push(loser);

  const engine = createSync(mockMail(server), mockStore(snapshot, listings), {log: quietLog, only: 'INBOX'});
  const {plan} = await engine.plan();

  assert.deepEqual(plan.ops.map(o => o.kind), [],
    'scoped run plans nothing for the out-of-scope duplicate: ' +
    JSON.stringify(plan.ops.map(describeOp)));
}

// `only` resolved onto the server's own spelling: a '/'-typed dir scope
// ('Zoo/Test' — the spelling the dirty marks carry from the client's
// tree, or a user-typed badge folder) on a '.'-delimiter server whose
// folder is 'Zoo.Test' must run against that folder, not throw.
{
  const m1 = await idOf('m1');
  const server = new Map([
    ['INBOX', dirState(1000, 10, [[1, 'm1']])],
    ['Zoo.Test', dirState(2000, 20, [])]
  ]);
  const snapshot = {
    version: 2, lastSyncAt: null,
    folders: {
      'INBOX': {uidvalidity: 1000, uidnext: 10, messages: {}},
      'Zoo.Test': {uidvalidity: 2000, uidnext: 20, messages: {}}
    }
  };
  const listings = new Map([
    ['INBOX', listing([])],
    ['Zoo.Test', listing([])]
  ]);
  const engine = createSync(mockMail(server), mockStore(snapshot, listings),
    {log: quietLog, only: 'Zoo/Test'});
  // the plan itself is the assertion: a strict `f.name === only` survey
  // would have thrown "survey: folder "Zoo/Test" not found on the server"
  // BEFORE resolving; a resolved plan returns cleanly
  const {plan} = await engine.plan();
  assert.ok(Array.isArray(plan.ops), "the '/'-typed scope resolved to 'Zoo.Test': plan ran");

  // resolution runs how the sync-dirs path consumes it: the whole scoped
  // diff runs against the RESOLVED folder — INBOX's new mail stays out
  {
    const m2 = await idOf('m2');
    const server = new Map([
      ['INBOX', dirState(1000, 10, [[1, 'm1']])],
      ['Zoo.Test', dirState(2000, 20, [[2, 'm2']])]
    ]);
    const snapshotZoo = structuredClone(snapshot);
    snapshotZoo.folders['INBOX'].messages = {1: {msgid: m1, flags: []}};   // INBOX is clean
    const engine = createSync(mockMail(server), mockStore(snapshotZoo, listings),
      {log: quietLog, only: 'Zoo/Test'});
    const {plan} = await engine.plan();
    const described = plan.ops.map(describeOp);
    assert.deepEqual(described.filter(op => op.includes('INBOX')), [],
      'INBOX stays out of the resolved scoped run: ' + JSON.stringify(described));
    assert.ok(described.some(op => op.includes('Zoo.Test')),
      "the pull runs in the resolved 'Zoo.Test': " + JSON.stringify(described));
  }

  // and a scope that matches NO spelling (before or after normalization)
  // still reports the not-found error
  const missing = createSync(mockMail(server), mockStore(snapshot, listings),
    {log: quietLog, only: 'Nowhere/None'});
  await assert.rejects(() => missing.plan(),
    /survey: folder "Nowhere\/None" not found on the server/,
    'an unmatched dir scope still fails loudly');
}

// ---- helpers for the pull-time routing scenarios ---------------------------

// a raw message with a DISTINCT subject (routing matches on subject:)
const rawOfSubject = (msgid, subject) => enc.encode(
  `From: a@b.c\r\nSubject: ${subject}\r\nMessage-Id: <${msgid}>\r\n\r\nbody\r\n`);

// like dirState, but the rows carry custom raw bytes (subject matters for
// the filter walk; the engine routes on the raw, never on the row)
function dirRawState(uidvalidity, uidnext, rows) {
  return {
    status: {folder: 'x', exists: true, uidvalidity, uidnext},
    rows: new Map([...rows].map(([uid, raw]) =>
      [uid, {flags: [], subject: null, from: null, date: null, size: raw.length}])),
    raws: new Map(rows)
  };
}

const MOVE_TO_WORK = {id: 'f1', enabled: true, accountId: '', action: 'move',
  query: 'subject: routed', folder: 'Work', description: 'to Work'};
const STOP_FILTER = {id: 's1', enabled: true, accountId: '', action: 'stop',
  query: 'subject: stop', folder: '', description: 'guard'};

const emptyFolders = () => ({
  INBOX: {uidvalidity: 1000, uidnext: 7, messages: {}},
  Work: {uidvalidity: 2000, uidnext: 2, messages: {}}
});

// ---- routing scenario 1: a matching MOVE lands in the destination dir ------
// The old shape wrote every pull into INBOX and renamed it afterwards; the
// routed pull must be written into "Work" carrying the SOURCE folder's
// FMD5 (the pending-move marker), INBOX must get NOTHING for it, and the
// snapshot must still describe the server row (INBOX/uid). The un-matched
// message keeps landing in INBOX, marked routed (no-match ends the walk).
{
  const server = new Map([
    ['INBOX', dirRawState(1000, 7, new Map([
      [5, rawOfSubject('r5', 'routed')],
      [6, rawOfSubject('r6', 'plain news')]
    ]))],
    ['Work', dirState(2000, 2, [])]
  ]);
  const snapshot = {version: 2, lastSyncAt: null, folders: emptyFolders()};
  const listings = new Map([
    ['INBOX', listing([])],
    ['Work', listing([])]
  ]);
  const routeLogs = [];
  const store = mockStore(snapshot, listings);
  const engine = createSync(mockMail(server), store,
    {log: (l) => routeLogs.push(l), route: raw => routeMessage(raw, {
      filters: [MOVE_TO_WORK], accountId: null
    })});
  const {summary} = await engine.run({dry: false});

  assert.equal(summary.failed, 0, 'the run is clean');
  assert.equal(store.saved.length, 1, 'the snapshot committed');
  assert.deepEqual(
    store.written.map(w => [w.folder, w.uid, w.fmd5 === md5hex('INBOX') ? 'SOURCE' : 'own']),
    [['Work', 5, 'SOURCE'], ['INBOX', 6, 'own']],
    'routed uid 5 lands in Work with the SOURCE FMD5, uid 6 stays INBOX: ' +
      JSON.stringify(store.written));
  const snap = store.saved[0];
  assert.deepEqual(Object.keys(snap.folders['INBOX'].messages), ['5', '6'],
    'the snapshot still describes the server rows (INBOX/uid)');
  assert.equal(snap.folders['INBOX'].messages[5].msgid, await idOf('r5'),
    'the routed message keeps its INBOX identity in the snapshot');
  assert.deepEqual([...engine.landedInboxUids()].sort((a, b) => a - b), [5, 6],
    'both pulls are "received"');
  assert.deepEqual([...engine.routedInboxUids()].sort((a, b) => a - b), [5, 6],
    'both routings were evaluated (a no-match is final too)');
  assert.deepEqual(engine.routeStats(), {moved: 1, kept: 0, unmatched: 1, failed: 0},
    'route counters: 1 move, 1 unmatched');
  assert.ok(routeLogs.some(l => l.type === 'filter' && l.content.includes('-> Work')),
    'the match narration line is logged: ' + JSON.stringify(routeLogs));
  assert.ok(routeLogs.some(l => l.content.includes('filter routing: 2 message(s) evaluated — 1 moved, 0 kept, 1 unmatched')),
    'the end-of-apply route summary is logged');
}

// ---- routing scenario 2: a stop filter shields a message from later moves --
// stop-above-move: the stop match keeps uid 5 in INBOX (no rename, later
// filters skipped) and the move filter still routes uid 6 into Work.
{
  const server = new Map([
    ['INBOX', dirRawState(1000, 7, new Map([
      [5, rawOfSubject('r5', 'stop me')],
      [6, rawOfSubject('r6', 'routed')]
    ]))],
    ['Work', dirState(2000, 2, [])]
  ]);
  const snapshot = {version: 2, lastSyncAt: null, folders: emptyFolders()};
  const listings = new Map([
    ['INBOX', listing([])],
    ['Work', listing([])]
  ]);
  const routeLogs = [];
  const store = mockStore(snapshot, listings);
  const engine = createSync(mockMail(server), store,
    {log: (l) => routeLogs.push(l), route: raw => routeMessage(raw, {
      filters: [STOP_FILTER, MOVE_TO_WORK], accountId: null
    })});
  const {summary} = await engine.run({dry: false});

  assert.equal(summary.failed, 0, 'the run is clean');
  assert.deepEqual(
    store.written.map(w => [w.folder, w.uid, w.fmd5 === md5hex('INBOX') ? 'SOURCE' : 'own']),
    [['INBOX', 5, 'own'], ['Work', 6, 'SOURCE']],
    'the stop match stays INBOX (own FMD5), the move match lands in Work: ' +
      JSON.stringify(store.written));
  assert.deepEqual(engine.routeStats(), {moved: 1, kept: 1, unmatched: 0, failed: 0},
    'route counters: 1 move, 1 stop-anchored');
  assert.ok(routeLogs.some(l => l.type === 'filter' && l.content.includes('stop filters (message stays in INBOX')),
    'the stop narration line is logged');
}

// ---- routing scenario 3: a throwing finder leaves the message unrouted ----
// A finder failure must degrade to today's behavior: the message lands in
// INBOX with its OWN FMD5, is NOT marked routed, and the post-sync pass
// (which is readonly-notified via the landed set plus routed set) re-tries.
{
  const server = new Map([
    ['INBOX', dirRawState(1000, 7, new Map([
      [5, rawOfSubject('r5', 'boom me')]]))],
    ['Work', dirState(2000, 2, [])]
  ]);
  const snapshot = {version: 2, lastSyncAt: null, folders: emptyFolders()};
  const listings = new Map([
    ['INBOX', listing([])],
    ['Work', listing([])]
  ]);
  const routeLogs = [];
  const store = mockStore(snapshot, listings);
  const engine = createSync(mockMail(server), store, {
    log: (l) => routeLogs.push(l),
    route: async () => {
      throw new Error('boom');
    }
  });
  const {summary} = await engine.run({dry: false});

  assert.equal(summary.failed, 0, 'the pull itself still succeeds');
  assert.deepEqual(
    store.written.map(w => [w.folder, w.uid, w.fmd5 === md5hex('INBOX') ? 'SOURCE' : 'own']),
    [['INBOX', 5, 'own']],
    'the pull lands in INBOX with its own FMD5: ' + JSON.stringify(store.written));
  assert.deepEqual([...engine.landedInboxUids()], [5], 'the pull is received');
  assert.equal(engine.routedInboxUids().size, 0,
    'the finder never decided — nothing is marked routed');
  assert.deepEqual(engine.routeStats(), {moved: 0, kept: 0, unmatched: 0, failed: 1},
    'the finder failure is counted, never turned into a failed pull');
  assert.ok(routeLogs.some(l => l.cls === 'warn' && l.content.includes('routing INBOX/5 FAILED')),
    'the failure is warned');
}

// ---- routing scenario 4: a destination folder the server does not have ----
// Warn once, still land locally: the file is a pending move the next run
// replays once the folder exists (the engine's localOnly/create machinery
// already covers the "local dir without a server folder" case).
{
  const server = new Map([
    ['INBOX', dirRawState(1000, 7, new Map([
      [5, rawOfSubject('r5', 'routed')]]))],
    ['Work', dirState(2000, 2, [])]
  ]);
  const snapshot = {version: 2, lastSyncAt: null, folders: emptyFolders()};
  const listings = new Map([
    ['INBOX', listing([])],
    ['Work', listing([])]
  ]);
  const routeLogs = [];
  const store = mockStore(snapshot, listings);
  const engine = createSync(mockMail(server), store, {
    log: (l) => routeLogs.push(l),
    route: raw => routeMessage(raw, {
      filters: [{...MOVE_TO_WORK, folder: 'Ghost'}], accountId: null
    })
  });
  const {summary} = await engine.run({dry: false});

  assert.equal(summary.failed, 0, 'the run is clean');
  assert.deepEqual(
    store.written.map(w => [w.folder, w.uid, w.fmd5 === md5hex('INBOX') ? 'SOURCE' : 'own']),
    [['Ghost', 5, 'SOURCE']],
    'the message lands in the missing destination anyway');
  assert.ok(routeLogs.some(l => l.cls === 'warn' &&
      l.content.includes('destination "Ghost" is not a folder of this server')),
    'the missing-destination warning is logged');
}

// ---- routing scenario 5: a message arriving DURING the run also routes ----
// The local-born dup upload (append op) lands a fresh uid; the post-apply
// survey fetches it ("arrived during the run") and the finder routes it
// into Work with the INBOX marker — the snapshot still records INBOX/uid.
{
  const winner = rawOfSubject('r9', 'already mine');
  const loser = rawOfSubject('ap', 'routed');
  const server = new Map([
    ['INBOX', dirRawState(1000, 10, new Map([[9, winner]]))],
    ['Work', dirState(2000, 2, [])]
  ]);
  const snapshot = {
    version: 2, lastSyncAt: null,
    folders: {
      INBOX: {uidvalidity: 1000, uidnext: 10, messages: {}},
      Work: {uidvalidity: 2000, uidnext: 2, messages: {}}
    }
  };
  const dupName = makeFilename('INBOX', 9, [], {unique: 'dup1', fmd5: md5hex('INBOX')});
  const loserEntry = fileEntry(dupName, 9, md5hex('INBOX'), loser);
  const listings = new Map([
    ['INBOX', listing([fileEntry('f9', 9, md5hex('INBOX'), winner)])],
    ['Work', listing([])]
  ]);
  listings.get('INBOX').excluded.push(loserEntry);

  const store = mockStore(snapshot, listings);
  const engine = createSync(mockMail(server), store, {
    log: quietLog,
    route: raw => routeMessage(raw, {filters: [MOVE_TO_WORK], accountId: null})
  });
  const {summary} = await engine.run({dry: false});

  assert.equal(summary.failed, 0, 'the run is clean');
  // uid 9 is size-ADOPTED (winner matches the server size): no pull, no
  // write — the loser joins the ordinary local-born classification as an
  // `append` op; its fresh server uid (10) becomes the mid-run arrival
  assert.ok(!store.written.some(w => w.folder === 'INBOX' && w.uid === 9),
    'the winner is adopted (no write)');
  const arrival = store.written.filter(w => w.uid === 10);
  assert.deepEqual(
    arrival.map(w => [w.folder, w.fmd5 === md5hex('INBOX') ? 'SOURCE' : 'own']),
    [['Work', 'SOURCE']],
    'the mid-run arrival was uploaded (uid 10) and routed into Work: ' +
      JSON.stringify(store.written.filter(w => w.uid === 10)));
  assert.ok(engine.landedInboxUids().has(10), 'the arrival counts as received');
  assert.ok(engine.routedInboxUids().has(10), 'the arrival counts as routed');
  assert.equal(store.saved.length, 1, 'the snapshot committed');
  assert.deepEqual(Object.keys(store.saved[0].folders['INBOX'].messages).sort(), ['10', '9'],
    'the snapshot records the arrival under its INBOX uid');
}

// ---- routing scenario 6: a '/'-typed destination on a '.'-delimiter server
// The filter's folder is spelled with '/' (the options page normalizes on
// save; already-stored rows defend here): normalizeFolderPath maps it onto
// the account delimiter BEFORE the survey comparison or the write, so the
// write targets the SERVER spelling and no missing-destination warning
// fires for a folder that does exist.
{
  const server = new Map([
    ['INBOX', dirRawState(1000, 7, new Map([
      [5, rawOfSubject('r5', 'routed')]]))],
    ['Work.Test', dirState(2000, 2, [])]
  ]);
  const snapshot = {
    version: 2, lastSyncAt: null,
    folders: {
      INBOX: {uidvalidity: 1000, uidnext: 7, messages: {}},
      'Work.Test': {uidvalidity: 2000, uidnext: 2, messages: {}}
    }
  };
  const listings = new Map([
    ['INBOX', listing([])],
    ['Work.Test', listing([])]
  ]);
  const routeLogs = [];
  const store = mockStore(snapshot, listings, '.');
  const engine = createSync(mockMail(server), store, {
    log: (l) => routeLogs.push(l),
    route: raw => routeMessage(raw, {
      filters: [{...MOVE_TO_WORK, folder: 'Work/Test'}], accountId: null
    })
  });
  const {summary} = await engine.run({dry: false});

  assert.equal(summary.failed, 0, 'the run is clean');
  assert.deepEqual(
    store.written.map(w => [w.folder, w.uid, w.fmd5 === md5hex('INBOX') ? 'SOURCE' : 'own']),
    [['Work.Test', 5, 'SOURCE']],
    "the '/'-typed destination is written in the account delimiter's spelling");
  assert.ok(!routeLogs.some(l => l.content.includes('not a folder of this server')),
    'no missing-destination warning for an existing folder');
}
// ---- scenario K1: a replayed server move KEEPS the local copy -------------
// The marker survives the move; the post-apply survey pairs it with the
// message's FRESH destination uid (unique byte size) and renames it in
// place — msgid from the local file, ZERO re-download.
{
  const m5 = await idOf('m5');
  const server = new Map([
    ['INBOX', dirState(1000, 9, [[5, 'm5']])],
    ['Work', dirState(2000, 11, [])]
  ]);
  const snapshot = {
    version: 2, lastSyncAt: null,
    folders: {
      'INBOX': {uidvalidity: 1000, uidnext: 9, messages: {
        5: {msgid: m5, flags: []}
      }},
      'Work': {uidvalidity: 2000, uidnext: 11, messages: {}}
    }
  };
  const interloperName = makeFilename('INBOX', 5, [], {unique: 'u5', fmd5: md5hex('INBOX')});
  const listings = new Map([
    ['INBOX', listing([])],
    ['Work', listing([], [
      fileEntry(interloperName, 5, md5hex('INBOX'), rawOf('m5'))
    ])]
  ]);

  const moveLogs = [];
  const store = mockStore(snapshot, listings);
  const mail = mockMail(server);
  const engine = createSync(mail, store, {log: l => moveLogs.push(l)});
  const {summary} = await engine.run({dry: false});

  assert.equal(summary.failed, 0, 'the run is clean');
  assert.equal(summary.serverMoves, 1, 'the server move landed');
  assert.equal(summary.keptLocalMoves, 1, 'the local copy was kept');
  assert.equal(mail.fetches, 0,
    'no re-download: the moved bytes were already on disk');
  assert.deepEqual(store.moves, [{
    srcFolder: 'Work', dstFolder: 'Work', uid: 11, keepFmd5: false, flags: []
  }], 'the copy was renamed in place: fresh uid, dest FMD5, server flags');
  const snap = store.saved[0];
  assert.equal(snap.folders['Work'].messages[11].msgid, m5,
    'the snapshot carries the kept copy\'s identity under the fresh uid');
  assert.ok(!snap.folders['INBOX'].messages?.[5],
    'the source uid left the snapshot with the move');
  assert.ok(moveLogs.some(l => l.content.includes('moved copy kept: INBOX/5 → Work/11 (no refetch)')),
    'the kept-copy narration line is logged');
}

// ---- scenario K2: ambiguous byte size → drop + refetch (today's shape) ----
// Two replayed moves whose copies have EQUAL byte sizes cannot be paired by
// size alone: both markers are dropped and the fresh uids are re-fetched.
{
  const m7 = await idOf('m7');
  const m8 = await idOf('m8');
  const server = new Map([
    ['INBOX', dirState(1000, 9, [[7, 'm7'], [8, 'm8']])],
    ['Work', dirState(2000, 11, [])]
  ]);
  const snapshot = {
    version: 2, lastSyncAt: null,
    folders: {
      'INBOX': {uidvalidity: 1000, uidnext: 9, messages: {
        7: {msgid: m7, flags: []}, 8: {msgid: m8, flags: []}
      }},
      'Work': {uidvalidity: 2000, uidnext: 11, messages: {}}
    }
  };
  const listings = new Map([
    ['INBOX', listing([])],
    ['Work', listing([], [
      fileEntry('i7', 7, md5hex('INBOX'), rawOf('m7')),
      fileEntry('i8', 8, md5hex('INBOX'), rawOf('m8'))
    ])]
  ]);

  const moveLogs = [];
  const store = mockStore(snapshot, listings);
  const mail = mockMail(server);
  const engine = createSync(mail, store, {log: l => moveLogs.push(l)});
  const {summary} = await engine.run({dry: false});

  assert.equal(summary.failed, 0, 'the run is clean (fallback refetch)');
  assert.equal(summary.keptLocalMoves, 0, 'nothing was kept: sizes are ambiguous');
  assert.deepEqual(store.moves, [], 'no blind rename under ambiguity');
  assert.equal(mail.fetches, 2, 'both fresh uids were re-fetched instead');
  const snap = store.saved[0];
  assert.equal(snap.folders['Work'].messages[11].msgid, m7,
    'the fetched copies restore the right identities');
  assert.ok(moveLogs.some(l => l.cls === 'warn' &&
      l.content.includes('2 fresh uid(s) match its byte size')),
    'the ambiguity warns and explains the refetch');
}

// ---- scenario K3: a failed rename falls back to drop + refetch ------------
// The move replayed, the copy kept, but the rename throws: the fallback
// warns, drops the marker (best effort) and the fresh uid is re-fetched.
{
  const m5 = await idOf('m5');
  const server = new Map([
    ['INBOX', dirState(1000, 9, [[5, 'm5']])],
    ['Work', dirState(2000, 11, [])]
  ]);
  const snapshot = {
    version: 2, lastSyncAt: null,
    folders: {
      'INBOX': {uidvalidity: 1000, uidnext: 9, messages: {
        5: {msgid: m5, flags: []}
      }},
      'Work': {uidvalidity: 2000, uidnext: 11, messages: {}}
    }
  };
  const interloperName = makeFilename('INBOX', 5, [], {unique: 'u5', fmd5: md5hex('INBOX')});
  const listings = new Map([
    ['INBOX', listing([])],
    ['Work', listing([], [
      fileEntry(interloperName, 5, md5hex('INBOX'), rawOf('m5'))
    ])]
  ]);

  const moveLogs = [];
  const store = mockStore(snapshot, listings, '/', true);
  const mail = mockMail(server);
  const engine = createSync(mail, store, {log: l => moveLogs.push(l)});
  const {summary} = await engine.run({dry: false});

  assert.equal(summary.failed, 0, 'the rename failure never fails the run');
  assert.equal(summary.keptLocalMoves, 0, 'the rename failed — nothing kept, no count');
  assert.equal(mail.fetches, 1, 'the fresh uid was re-fetched');
  const snap = store.saved[0];
  assert.equal(snap.folders['Work'].messages[11].msgid, m5,
    'the snapshot carries the identity from the fetched raw');
  assert.ok(moveLogs.some(l => l.cls === 'warn' && l.content.includes('the keep failed')),
    'the failed rename warns');
}

// ---- scenario K4: the heal path (lost-snapshot replay) also keeps ---------
// healLostMove plans the same moveServer op: verification mined the raw,
// the move replayed and the kept copy is renamed to the fresh uid with no
// additional download.
{
  const m5 = await idOf('m5');
  const server = new Map([
    ['INBOX', dirState(1000, 9, [[5, 'm5']])],
    ['Work', dirState(2000, 11, [])]
  ]);
  const snapshot = {
    version: 2, lastSyncAt: null,
    folders: {
      'INBOX': {uidvalidity: 1000, uidnext: 9, messages: {}},
      'Work': {uidvalidity: 2000, uidnext: 11, messages: {}}
    }
  };
  const interloperName = makeFilename('INBOX', 5, [], {unique: 'u5', fmd5: md5hex('INBOX')});
  const listings = new Map([
    ['INBOX', listing([])],
    ['Work', listing([], [
      fileEntry(interloperName, 5, md5hex('INBOX'), rawOf('m5'))
    ])]
  ]);

  const moveLogs = [];
  const store = mockStore(snapshot, listings);
  const mail = mockMail(server);
  const engine = createSync(mail, store, {log: l => moveLogs.push(l)});
  const {summary} = await engine.run({dry: false});

  assert.equal(summary.failed, 0, 'the run is clean');
  assert.equal(summary.serverMoves, 1, 'the healed move replayed');
  assert.equal(summary.keptLocalMoves, 1, 'the local copy was kept');
  assert.equal(mail.fetches, 1,
    'the only download is the heal-verification mining raw — no post-pull');
  assert.deepEqual(
    store.moves,
    [{srcFolder: 'Work', dstFolder: 'Work', uid: 11, keepFmd5: false, flags: []}],
    'the healed copy was renamed in place too');
  assert.equal(store.saved[0].folders['Work'].messages[11].msgid, m5,
    'the sweep-kept copy\'s identity reaches the snapshot');
  assert.ok(moveLogs.some(l => l.content.includes('moved copy kept: INBOX/5 → Work/11 (no refetch)')),
    'the heal replay keeps the copy with the same narration');
}

console.log('sync.test: all scenarios pass');