#!/usr/bin/env node
// Regression tests for the sync engine's foreign-FMD5 (interloper) handling,
// plus the moveServer marker-removal hardening.
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

import {register} from 'node:module';
register('./root-loader.mjs', import.meta.url);

const {md5hex, makeFilename} = await import('../maildir.mjs');
const {msgidOf} = await import('../snapshot.mjs');
const {createSync, describeOp} = await import('./sync.mjs');

import assert from 'node:assert/strict';

const enc = new TextEncoder();
const rawOf = msgid => enc.encode(
  `From: a@b.c\r\nSubject: t\r\nMessage-Id: <${msgid}>\r\n\r\nbody\r\n`);
const idOf = async msgid => await msgidOf(rawOf(msgid));

// ---- mock mail (IMAP facade) + store (MaildirStore) ------------------------

function mockMail(server) {
  return {
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
      const dir = server.get(this.current);
      return uids.map(uid => ({uid, raw: dir.raws.get(uid)}));
    },
    async readMail(uid) {
      const dir = server.get(this.current);
      return {uid, folder: this.current, size: dir.raws.get(uid).length, raw: dir.raws.get(uid)};
    },
    async moveMail(uid, mailbox) {
      const dir = server.get(this.current);
      const raw = dir.raws.get(uid);
      const row = dir.rows.get(uid);
      dir.rows.delete(uid);
      dir.raws.delete(uid);
      const dst = server.get(mailbox);
      dst.raws.set(20, raw);
      dst.rows.set(20, {flags: row.flags, subject: row.subject ?? null, from: null, date: null, size: raw.length});
    }
  };
}

function mockStore(snapshot, listings) {
  const saved = [];
  return {
    delimiter: '/',
    saved,
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
    async writeMessage() {},
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

// ---- scenario D: moveServer whose marker removal fails must not commit -----
// The replay lands on the server (moveMail ok) but the marker file cannot
// be removed: the op counts as failed, the snapshot stays uncommitted, and
// the next run re-detects the state instead of orphaning the file forever.
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
  const engine = createSync(mockMail(server), store, {log: quietLog});
  const {summary} = await engine.run({dry: false});

  assert.equal(summary.failed, 1, 'the moveServer op failed');
  assert.equal(summary.moveServer, 0, 'the moveServer op was not counted as done');
  assert.equal(store.saved.length, 0, 'snapshot NOT committed');
  assert.ok(true);
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

console.log('sync.test: all scenarios pass');