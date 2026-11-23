// watcher.mjs — the fs-event → tombstone feed for message-file deletions
// that land WHILE a sync session runs. core/fs.mjs broadcasts every
// mutation as one {type:'fs-event', origin, operation, src, dest}, with
// operation spelled 'create' | 'change' | 'delete' | 'move' — a file
// removal is 'delete' (the gateway's fsRemove). The offscreen document
// routes those events through here into the live engines'
// noteTombstones(): a message deleted locally (another page's purge, a
// file removed through the gateway) must never be resurrected by the
// running sync's own pulls, pairings or arrival re-fetches.
//
// Pure: no chrome, no store — the caller owns the delivery and the
// logging, so the parsing is unit-testable under plain node.
//
// What this feed deliberately does NOT see: mutations done OUTSIDE the
// fs gateway (an OS file manager moving a file out of a picked external
// directory) emit no fs-event at all — the FS Access API does not report
// external changes. Such deletions surface at the next plan's local
// re-listing (the classifier's missing-file diff → the gated
// deleteServer), never mid-run.

'use strict';

import {folderFor, parseFilename} from './maildir.mjs';

/**
 * The tombstone entries one fs-event implies, or [] when the event is not
 * a message-file removal under the account's maildir tree.
 * @param {{type?: string, origin?: string, operation?: string,
 *   src?: string, dest?: string|null}} msg the runtime-bus fs-event
 * @param {{account?: string, delimiter?: string}} ctx the session's account
 *   dir (the maildir slug — root-relative paths start with it) and the
 *   account's IMAP hierarchy delimiter
 * @returns {{folder: string, uid: number, msgid: null, at: string}[]} the
 *   entries to feed the live engines; msgid is null (the file is already
 *   gone — the durable tombstone a purge wrote carries the msgid)
 */
export function tombstonesFromFsEvent(msg, {account, delimiter = '/'} = {}) {
  if (!msg || msg.type !== 'fs-event' ||
      msg.origin === 'offscreen' ||      // the engine's own writes
      msg.operation !== 'delete') {     // the gateway spells removals 'delete'
    return [];
  }
  const acc = String(account ?? '');
  const src = String(msg.src ?? '');
  if (!acc || !src.startsWith(acc + '/')) {
    return [];
  }
  // <account>/<dirName>/{new,cur,tmp}/<maildir filename>
  const segs = src.slice(acc.length + 1).split('/');
  if (segs.length !== 3 || (segs[1] !== 'cur' && segs[1] !== 'new')) {
    return [];   // a dir removal, a tmp/ scratch path, a dotfile, …
  }
  const parsed = parseFilename(segs[2]);
  if (!parsed || !Number.isInteger(parsed.uid) || parsed.uid <= 0) {
    return [];   // not a message file (a dropped .txt, a stray name, …)
  }
  return [{
    folder: folderFor(segs[0], delimiter),
    uid: parsed.uid,
    msgid: null,
    at: new Date().toISOString()
  }];
}
