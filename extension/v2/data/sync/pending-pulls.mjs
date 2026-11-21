// pending-pulls.mjs — ".pending-pulls.json": messages THIS ENGINE pulled
// from the server during a run that never committed its snapshot.
//
// Why the list exists: a half-done run leaves its pulled files on disk
// while the snapshot stays untouched (apply commits only on full success),
// so on the next run those files' uids are neither in the snapshot nor —
// after ANOTHER client deleted the mail on the server in the window — in
// the survey. The classifier's local-born rule ("uid neither on the server
// nor in the snapshot → APPEND") then mistakes the engine's own leftovers
// for mail born outside the sync cycle and re-uploads the deleted mail:
// the reported "the offline client pushed deleted emails back to the
// server" bug. The journal is the missing memory: written BEFORE each pull
// chunk's files land (an interrupted run can never lose the record), it
// lets the classifier drop the orphan copy instead — the server's
// deletion wins, exactly like the committed-record path.
//
// Entry shape: {folder, uid, uidvalidity, at} — folder+uid is the primary
// identity, keyed by the folder whose UID space the uid belongs to (the
// SOURCE folder of a filter-routed landing included); uidvalidity is that
// folder's SELECT value at pull time, so a folder rebuild (uidvalidity
// change) retires every old entry — uids are not comparable across the
// epoch line; `at` is the pull timestamp (ISO). The file is advisory
// memory: a missing or corrupt file reads as an empty list and never fails
// a sync. Entries are pruned by the engine at commit time — only the
// folders whose snapshot entry a run actually (re)wrote clear their
// records, and within those only the uids the committed snapshot now
// tracks; everything else (a failed run's pulls, a scoped run's arrivals
// in unsurveyed dirs, a uid a third party expunged mid-run) survives until
// a later run resolves it.

'use strict';

export const FILE = '.pending-pulls.json';

const PENDING_PULLS_VERSION = 1;

/** normalize one raw entry; invalid shapes are dropped, never thrown */
export function pendingPullEntry(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const folder = typeof raw.folder === 'string' && raw.folder ? raw.folder : null;
  const uid = Number(raw.uid);
  if (!folder || !Number.isInteger(uid) || uid <= 0) {
    return null;
  }
  const uidvalidity = Number(raw.uidvalidity);
  return {
    folder,
    uid,
    uidvalidity: Number.isFinite(uidvalidity) && uidvalidity > 0 ? uidvalidity : null,
    at: typeof raw.at === 'string' && raw.at ? raw.at : null
  };
}

/** the dedupe/lookup key of an entry */
export const pullKey = (folder, uid) => `${folder}/${Number(uid)}`;

/**
 * Reads the account's pending-pull journal (<slug>/.pending-pulls.json).
 * Missing or corrupt → [].
 * @param {object} fs an fs gateway facade ({reader, writer})
 * @param {string} accountPath the account dir, root-relative
 * @returns {Promise<object[]>} normalized entries
 */
export async function loadPendingPulls(fs, accountPath) {
  try {
    const parsed = JSON.parse(
      await fs.reader.readText(accountPath + '/' + FILE));
    if (parsed && parsed.version === PENDING_PULLS_VERSION && Array.isArray(parsed.entries)) {
      return parsed.entries.map(pendingPullEntry).filter(Boolean);
    }
  }
  catch {}
  return [];
}

/** full rewrite of .pending-pulls.json */
export async function savePendingPulls(fs, accountPath, entries) {
  await fs.writer.write(accountPath + '/' + FILE,
    JSON.stringify({version: PENDING_PULLS_VERSION, entries}, null, 1));
}
