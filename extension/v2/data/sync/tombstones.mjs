// tombstones.mjs — ".tombstones.json": messages deleted LOCALLY that the
// sync engine must never re-add. Written at the moment of deletion (the
// client's purgeMessages records folder+uid+msgid before the file goes; the
// offscreen's fs-event watcher feeds the running engines directly), consulted
// by the classifier before any pull is planned and by the pull writers
// before every write, and pruned by the engine at commit time — only the
// entries it could NOT resolve survive a snapshot commit.
//
// Why the list exists: local deletion is otherwise inferred purely as "in
// the snapshot K, missing locally", so whenever the snapshot loses or never
// had the record (a purge landing mid-run, a uidvalidity resync, a
// declined/failed server delete) the deleted mail returns to the folder
// like fresh mail — the reported "deleted mail returns as new" bug.
//
// Entry shape: {folder, uid, msgid, at} — folder+uid is the primary
// identity; msgid (the parsed Message-ID or the synthetic sha256 the
// snapshot itself uses) is the resync-time fallback, null when it could not
// be extracted; `at` is the deletion timestamp (ISO). The file is advisory
// memory: a missing or corrupt file reads as an empty list and never fails
// a sync.

'use strict';

export const FILE = '.tombstones.json';

const TOMBSTONES_VERSION = 1;

/** normalize one raw entry; invalid shapes are dropped, never thrown */
export function tombstoneEntry(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const folder = typeof raw.folder === 'string' && raw.folder ? raw.folder : null;
  const uid = Number(raw.uid);
  if (!folder || !Number.isInteger(uid) || uid <= 0) {
    return null;
  }
  return {
    folder,
    uid,
    msgid: typeof raw.msgid === 'string' && raw.msgid ? raw.msgid : null,
    at: typeof raw.at === 'string' && raw.at ? raw.at : null
  };
}

/** the dedupe/lookup key of an entry */
export const tombKey = (folder, uid) => `${folder}/${Number(uid)}`;

/**
 * Reads the account's tombstone list (<slug>/.tombstones.json). Missing or
 * corrupt → [].
 * @param {object} fs an fs gateway facade ({reader, writer})
 * @param {string} accountPath the account dir, root-relative
 * @returns {Promise<object[]>} normalized entries
 */
export async function loadTombstones(fs, accountPath) {
  try {
    const parsed = JSON.parse(
      await fs.reader.readText(accountPath + '/' + FILE));
    if (parsed && parsed.version === TOMBSTONES_VERSION && Array.isArray(parsed.entries)) {
      return parsed.entries.map(tombstoneEntry).filter(Boolean);
    }
  }
  catch {}
  return [];
}

/** full rewrite of .tombstones.json */
export async function saveTombstones(fs, accountPath, entries) {
  await fs.writer.write(accountPath + '/' + FILE,
    JSON.stringify({version: TOMBSTONES_VERSION, entries}, null, 1));
}
