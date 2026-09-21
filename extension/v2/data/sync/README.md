# data/sync — standalone IMAP sync workspace

Everything an offlineimap-style sync engine needs lives in this directory.
A separate project (or a new tab page inside this extension) that imports
the offscreen engine's `client.mjs` works in complete isolation: it never
imports from `../..` and never has to know how the connection is actually
built.

```
data/sync/
  client/        ← the sync interface surface: <sync-view>, the sync
                   button of the client footer, the account registry
                   (accounts.mjs) and the initSyncPanel(...) wiring
                   (components/)
  disk.mjs       ← granted-handle gate, shared by both sides (bootSilent
                   for the offscreen, boot() stays the visible-page gate)
  maildir.mjs    ← Maildir store on the granted root handle (shared layer)
  snapshot.mjs   ← .sync-state.json (uid → msgid/flags last-good view)
  offscreen/     ← hidden host document (offscreen.html) running the engine
                   directly (offscreen.mjs), with the IMAP facade
                   (client.mjs) and the engine itself (sync.mjs) alongside
  README.md      ← this file
```

The sync interface is `<sync-view>`
(data/sync/client/components/sync-view.js), hosted by the sync client at
data/sync/client/index.html and wired by `initSyncPanel(...)`
(data/sync/client/sync-panel.mjs):

- The mail client (data/client/index.mjs) carries no sync interface: its
  Sync button (accesskey Y) in the footer opens this page on a new tab.
- Without parameters the Account/Dir selectors are shown; with
  `?account=<id>` the account is dictated and its selector hides.

In every case the panel talks chrome.runtime only: opening pulls the
engine's current logs (sync-ui-init) and then appends the 'sync-log'
broadcast batches; several panels, on several pages, receive the same
stream at once (dedupe keys on (gen, seq): the engine's seq restarts at 0
in every document, so each incarnation carries a generation stamp).
When the engine document is not up (no jobs since the last close), the
panel opens with an empty log pane and a "sync engine not running" note —
opening a panel never boots the engine; only a job request does (and
closing the panel merely drops the view). The offscreen document exists
only while the job queue has work: an empty queue closes it, the Stop
button closes it now. The log var itself is the only log store — it dies
with the document, by design.

Jobs are deduped per view, not in the queue: a submitted request carries a
rid, its own button stays pinned until the engine's 'sync-jobs' broadcast
drops the rid — other views (and other job kinds in the same view) can
still submit anything while jobs are pending.

## Accounts (accounts.mjs)

Accounts are the ones configured in the options page, read straight from
`chrome.storage.local` — no worker round-trip:

- the options page stores the account list in the `accounts` key as an
  array of metadata `{id, label, primary, order}`, and every per-account
  field flat under `<field>.<id>` (`imap.host.<id>`, `imap.port.<id>`,
  `imap.secure.<id>`, `imap.allowSelfSigned.<id>`, `user.name.<id>`,
  `user.pass.<id>`).
- **Passwords** are plain strings unless a master password is configured
  (`master.hash` in storage.local); encrypted values have the
  `enc1.<salt>.<iv>.<ct>` form from `/tools/crypto.mjs`. To decrypt them the
  sync takes the master password from `chrome.storage.session`
  (`master.pass`, cached there by whoever confirmed it during this browser
  session); when it is not cached yet, a `<prompt-view>` in the client's
  sync panel asks for it, verifies it against `master.hash` and caches it
  into session storage. No configured master password → no prompt ever.
- `lastSyncAt` lives under `sync.lastSyncAt.<id>` (written by `markSynced`,
  also kept in the account's `.sync-state.json` by the snapshot).

## Preferences (the status-bar gear)

The sync panel's footer status row carries a gear button (an inline,
theme-following icon) opening a preferences dialog: every confirm
the interface can be asked (Purge from server, Drop local dir, Discard
local copy) becomes a preference with three values — **Ask** (the default:
the confirmation prompt shows as always), **Yes** (the confirm is approved
silently, no prompt) and **No** (the confirm is declined as if the user
had aborted it). Preferences live in `chrome.storage.local` under flat
`sync-ui.`-prefixed keys — `sync-ui.purge`, `sync-ui.drop`,
`sync-ui.discard` — one value (`ask|yes|no`) per key; without an open panel
the engine's headless `DECISIONS` defaults still stand in (both destructive
gates decline), which the dialog states in each row's hint. The gate
answering happens panel-side (the offscreen engine has no `chrome.storage`):
a `sync-confirm-req` whose kind matches a non-`ask` preference is answered
over the normal `sync-confirm` port without ever showing the prompt, so the
port protocol, grace window and timeouts stay untouched.

## Why this exists

The extension wires an IMAP session through three layers, all hidden behind
`client.mjs`:

```
         caller (sync engine / UI / service worker)
                        │  import {createClient} from '.../client.mjs'
                        ▼
        ┌───────── data/sync/offscreen/client.mjs ─────────┐
        │  lifecycle, retries, logging, facade   │
        └────────────────────────────────────────┘
                        │  internal only — never import these yourself
                        ▼
  core/native/ws-bridge-client.mjs   boot ws->tls bridge in com.add0n.node
                                     sandbox → ws://127.0.0.1:<port>/<token>
  core/rust-imap-client/api.mjs      wasm IMAP core (TLS inside wasm),
                                     exposes createMailApi({bridgeUrl,...})
  core/bridge.mjs                    refcounted worker-side host of the
                                     ws->tls bridge (the only connectNative
                                     user; any module acquires a named ref,
                                     the bridge drops after the last ref)
  core/ws-to-tls/ws-to-tls.js        the bridge script itself (mode 3:
                                     self-boots when pushed to the sandbox)
```

## Quick start

```js
import {createClient} from './client.mjs'; // offscreen/client.mjs — the engine's facade

// the ws->tls bridge endpoint comes from the service worker (chrome.runtime
// connectNative is not available everywhere; core/bridge.mjs owns that boot,
// refcounted: the run's ref is released when the run is over):
const {url: bridgeUrl} = await chrome.runtime.sendMessage({type: 'sync-bridge-ensure'});
...
await mail.close();
chrome.runtime.sendMessage({type: 'bridge-release', key: 'sync'});

const mail = createClient({
  host: '127.0.0.1',   // IMAP dial target (brokered through the bridge)
  port: 1143,
  secure: false,       // false => plaintext IMAP; TLS is wasm's job otherwise
  user: 'user',
  pass: 'pass',
  bridgeUrl            // required: the ready ws://127.0.0.1:<port>/<token>
});

await mail.connect();            // loads wasm + session lazily anyway
const info = await mail.info();  // {account, secure, dirs, status, selected}
```

## API

| call | meaning |
|---|---|
| `connect()` | idempotent bootstrap (bridge, wasm, login) |
| `info()` | snapshot: `{account, secure, connected, selected, dirs, status}` |
| `folders()` | every mailbox: `{name, delimiter, attrs}` |
| `readDir(name)` | SELECT a dir for the calls below; returns `{folder, exists, uidvalidity, uidnext}` |
| `listMails({page, pageSize, fromUid, toUid})` | summaries of the open dir, newest first |
| `listThreads()` | JWZ conversations of the open dir |
| `readMail(uid)` | raw RFC822: `{uid, folder, size, raw: Uint8Array}` |
| `markMail(uids, add, remove)` | UID STORE flags |
| `seeMail(uid)` | mark `\Seen` |
| `deleteMail(uids)` | STORE `\Deleted` + purge (when the core build exports expunge) |
| `moveMail(uids, mailbox)` | MOVE/COPY+delete into another maildir |
| `search(query, {dir, allFolders})` | server-side SEARCH, threaded output |
| `folderCounts(onProgress)` | per-folder unread/total sweep |
| `currentDir()` | the SELECTed dir or `null` |
| `close()` | LOGOUT + bridge teardown; the client is spent afterwards |

## How it works (for the sync engine author)

1. **Bridge** — the first command with no live session boots a persistent
   native-host port (`chrome.runtime.connectNative('com.add0n.node')`), pushes
   the bridge script text into the sandbox; the sandbox opens a localhost
   WebSocket server and reports its URL. No user-visible process is spawned.
2. **Wasm core** — `mail_core_bg.wasm` bytes are fetched from the extension
   and initialized; the IMAP client runs entirely inside wasm, doing its own
   TLS. The bridge only tunnels plaintext TCP to the dialed host:port.
3. **Session** — the client's job is to make every call look synchronous and
   stateful: first failure tears the stack down and retries once on a fresh
   stack; the second failure surfaces as a normal exception.
   `readDir()` state ("the open dir") is tracked by the facade and
   re-established after rebuilds — the caller just keeps calling.

## Rules for future code in data/sync

- The offscreen engine imports **only** `client.mjs` (offscreen/client.mjs).
  If the layer under it changes (different native host, no bridge, another
  transport), nothing here changes. `accounts.mjs` is the intentional
  exception (interface-side; storage, crypto and the shared `prompt-view`
  component), not a license to layer imports.
- Config (host/user/pass) comes from the caller; the facade does not persist
  anything. The sync engine will store it in the granted directory or
  `chrome.storage`.
- UID stability is guaranteed per `uidvalidity`; any caching switch must
  invalidate on a UIDVALIDITY change, not on folder names.
- `listMails`/`readMail`/`deleteMail` require `readDir()` first; nothing else
  is implicit for the sync engine's multi-folder passes.

## The sync engine (sync.mjs)

One-way-looking two-way sync, offlineimap-style. Layout on disk is flat
(offlineimap's MaildirPlusPlus naming), rooted at `<root>/<account-slug>/`:

```
<account>/INBOX/{tmp,new,cur}                     ← server INBOX
<account>/Work/{tmp,new,cur}                      ← server "Work"
<account>/Archive.Test/{tmp,new,cur}              ← server "Archive/Test" (flat!)
```

The mapping is injective: server folders are flat dir names with '%' →
'%25', a literal '.' → '%2e', and the hierarchy delimiter → '.' — no
casual collision between "Work" and "Work.Test" even on '.'-delimiter
servers. Maildirs are exactly one directory level deep; anything else in
the account dir (`.sync-state.json`, dot-files, stray dirs — including a
stale nested tree of a pre-flat version) is ignored by the layout code.

Everything metadata-ish lives in the filename (no message database):

    <ts>.M<n>P<pid>Q<seq>.sync,U=<uid>,FMD5=<md5-of-folder>,I=2,<letters>

- `U` server UID, `FMD5` md5 of the source folder name (a foreign FMD5 in a
  folder = a local move nobody has confirmed server-side yet).
- `I=2,S` is the Maildir info section spelled *browser-safe*: the FS Access
  API rejects ':' in filenames, so the classic ":2,S" is written as
  ",I=2,S" (parseFilename accepts both). Letters: S=Seen R=Answered
  F=Flagged T=Deleted D=Draft; other IMAP keywords can't be encoded and
  are ignored by diffs.
  **Importing mail from offlineimap / another Maildir:** before dropping
  files into `new/` or `cur/`, rewrite the classic info suffix
  `:2,<FLAGS>` to the browser-safe `,I=2,<FLAGS>`. Files whose names
  contain ':' are not surfaced by the File System Access API's directory
  enumeration, so the scanner never sees them — they appear neither in
  `local=` counts nor in any warning bucket, and silently stay unsynced
  (e.g. `1727778354_0.55641.host,U=18768,FMD5=…:2,S` must become
  `…,I=2,S`).

The snapshot is the classifier's baseline ("K"): uid → {msgid, flags}, where
msgid comes from the bundled postal-mime parser (sha-256 fallback for broken
headers). Three-way diff K/S/L produces an explicit op list first
(`planSync`), rendered by `describePlan` for the dry-run button; `apply` is
the only mutating step and rewrites the snapshot at the very end, so a
half-done run simply replays the same diffs. Files dropped into a folder's
`cur/`/`new/` are visible no matter how they are named: a `1.eml` and a
full offlineimap-style name (`…,U=<uid>,FMD5=<md5>,I=2,<flags>` / classic
`…:2,S`) are treated identically — locally inserted mail whose UID is
neither on the server nor in the snapshot is deduped against the server by
Message-ID and pushed via APPEND (duplicate drops are discarded locally,
with a warning); the next server survey materializes them under the
canonical offlineimap filename with the server-assigned UID. Local-born
mail is validated before anything happens: the raw payload must lead with
RFC822 header lines (From or Date present, `validateMail` — the
header/body separator is searched within the first 64KB, so mail carrying
an >8KB Received/DKIM header stack survives; a leading mbox `From `
sentinel line is tolerated) and parse as a
message — a stray `.DS_Store` from a macOS drop therefore never reaches
the server; it is left on disk and reported `[warn] … is not an email`,
visible in the plan/dry-run like every other ignored file. Every file in
`cur/`, `new/` or `tmp/` shows up in exactly one accounted bucket
(`entries`/`untracked`/`interlopers`/`excluded`/`stranded`) — a file in
`tmp/` is never live mail, but it is reported in the plan's warnings so
nothing can be ignored silently.

Server surveys page the UID space with an adaptive stride: dense folders
page 500 uids per call; an empty window means a gap of expunged uids and
the stride quadruples (up to 16k) — windows always tile `[1, uidnext)` as a
partition, so nothing can be skipped regardless of stride changes.

**Keyword handling:** unencodable IMAP keywords (`$Filtered`, …) never hit
filenames and are never "ignored": `\Recent` (a session pseudo-flag) is
dropped at intake, everything else rides the SNAPSHOT verbatim (message
entries' `flags` array gains members; the classifier only ever diffs the
standard-letter subset, so filenames, FMD5 markers and offlineimap interop
stay untouched). Keyword changes carry exactly two narrations per sync: one
usage line per folder (`keyword usage: $Filtered×120 …`) and one line when
the folder's server-side keyword set changed.

**Default decisions (headless mode):** sync must work with and without a
UI. The offscreen document's `DECISIONS` block answers every
destructive/shape question when no sync panel is open —
`pullQuantum`/`pullBatch` (see below) and `noUiPurgeServer` /
`noUiDropLocalDir` (destructive `deleteServer`/`dropLocal` ops are
declined by default without a UI, instead of hanging on the 90 s gate
timeout). Gate transport is port-only: every `sync-confirm-req` broadcast
goes out even when nobody is connected — a panel that survived an engine
restart re-establishes its `chrome.runtime.connect` port when it sees the
request (or the first log of a new generation), and if no port has
(re)connected within `DECISIONS.gateGraceMs` the headless default answers
on the user's behalf.

**Batched pulls & dir priority:** message fetches run through a bounded
worker pool (`mail.readMails(uids, {concurrency})` in offscreen/
client.mjs) — `pullBatch` concurrent lanes of `readMail()`, so network
latency overlaps instead of a serial round-trip per message; chunk retries
fall back per message. Surveys, mining, and applies prioritize `INBOX`, then
walk folders by ascending `server.size`. Each folder gets one
`DECISIONS.pullQuantum` batch (default 10) before the next folder gets a
turn. This is a fairness quantum, not a cap: large folders are fetched in
full during the same sync run. The default quantum can be changed in
`DECISIONS.pullQuantum` (or with `SYNC_PULL_QUANTUM`); `pullBatch` remains the
within-quantum concurrency setting. Cross-folder move detection is mined only
when a previously-synced message disappeared from a folder, and uses larger
raw batches controlled by `DECISIONS.miningBatch` (default 100, or
`SYNC_MINING_BATCH`). Otherwise new messages skip mining and go straight to
the pull scheduler.

Conflict policy: **server wins**. Local deletions/moves/flag edits
propagate (real `DELETE`+expunge, `MOVE`, flag STORE); when the server also
touched the same message since the last sync, the server state wins and the
local edit is dropped (and logged as a conflict). Moves are recognized by
md5-of-folder name comparison on the local side (FMD5) and by msgid
matching between "vanished from server" and "new in another server folder".
Flag edits on a message that is missing from the snapshot (adoption path)
are the exception: the local file is the only evidence that message has, so
its flags push to the server (local flag edits never get rewritten back to
the server's rows).

**Lost-move self-heal:** a pending local move whose snapshot record is gone
while the server still serves the source uid used to misfire twice at once —
the source uid classified as brand-new mail (a re-pull that *reverted* the
user's move) and the moved file was left unmatched forever. The classifier
now reconciles that shape: a foreign-FMD5 file claiming a `S−K` uid of its
stamped source folder is verified against the server (msgid from the mined
raw — the mining gate fetches it even when no other server-side move is
possible; byte-size equality is the fallback when the raw budget is
exhausted). A match replays the move as one server MOVE (plus removal of
same-content duplicate-uid files shadowing it); a match whose message
already sits in the destination on the server drops only the stale local
file; a mismatch (uid reused by different mail) keeps the file, warns, and
takes the normal re-pull. Scoped (`--dir`) runs survey the folder holding
the pending-move file as a restricted extra, so a sync of the *source* dir
replays the move too.

- Facade: `createClient(...).uploadMail(mailbox, raw)` → calls `api.appendMail`.
- Layered below it in `core/rust-imap-client/api.mjs` (shared MailApi): the
  wasm core may or may not export APPEND. Add this passthrough next to the
  other mutation wrappers; when the build lacks it, uploadMail fails with a
  "no appendMail" error and the sync engine keeps the local file (snapshot
  stays uncommitted, no server deletes):

    ```js
    async appendMail(mailbox, raw) {
        assertConnected();
        if (typeof client.append_message !== 'function') {
            throw new Error('appendMail: mail core build does not support APPEND; rebuild rust-client with append_message export');
        }
        const t0 = Date.now();
        try {
            await clientCall('append_message', [mailbox, toU8(raw), []], {postCheck: false});
            log(`appendMail(${JSON.stringify(mailbox)}, ${toU8(raw).length}B) (${Date.now() - t0}ms)`);
        } catch (e) {
            log(`appendMail(${JSON.stringify(mailbox)}) FAILED: ${e.message}`);
            throw e;
        }
    },
    ```

  and extend the `MailApi` typedef with
  `@property {(mailbox: string, raw: Uint8Array) => Promise<void>} appendMail`.

Partially applied runs behave sanely: whenever any op failed, the snapshot
is NOT rewritten, so the next sync only re-detects the missing pulls — no
failed pull can ever look like a local deletion and delete mail on the
server. UIDVALIDITY mismatch (`uidvalidity changed` line) triggers a full
folder resync: local files are wiped, everything re-pulled. The **Discard
local copy** button does the same on demand (plus a `lastSyncAt = null`
stamp in storage.local) — use it once if a pull was cut off by the older
message-grammar bug or the folder layout changes.

**Mining & volume, visibly:** after the survey, the plan mines msgids —
one raw download per uid the snapshot does not know — for cross-folder
move detection. Full re-pull folders (uidvalidity changed or the local
dir missing; a first sync of a new account) are SKIPPED there: the plan
ignores the snapshot for them, so mining would only double the heaviest
downloads. The mining pass narrates itself in the log (`(mining INBOX: N
new message(s) to classify …)` plus a progress line every 10 fetches with
elapsed time); heavy pulls get a heads-up BEFORE apply (`[plan] INBOX: N
message(s), ~size will be fetched from the server` and a run-level
`heavy sync` warning above ~200 messages / ~50 MB), so a first sync of a
mailbox full of mail is announced instead of silent. Loop narration is
coalesced: describePlan renders a contiguous run of same-kind ops (same
folder, same flags/toFolder where the op carries them) as ONE
count/range line (`pull  INBOX/99…108 to local (10 message(s), ~10 KB)`),
and apply narrates one `pulled` line per landed fetch chunk instead of
per message — lone ops keep the old per-item shape. The engine's log
batches flush via microtask (never DOM timers — the offscreen document is
a permanently hidden renderer whose timers Chrome throttles), and a
rate-limited console diagnostic reports broadcast delivery failures.
Every message FETCH rides a 2-minute ceiling (`SYNC_FETCH_TIMEOUT_MS`
overrides it in tests): a wedged bridge stream never resolves and jams
the wasm FIFO behind it, so a hung fetch aborts the run — the offscreen
tears the stack down and the next run re-detects the diff (the snapshot
is only committed after a fully successful apply).

**Purge gate:** a message that is in the snapshot but gone from the
Maildir with *no* foreign-FMD5 file anywhere in the handle (the user took
the file outside the granted directory) classifies as `deleteServer` — a
destructive, ambiguous op. `createSync(mail, store, {confirmPurge})`
receives a callback (the offscreen engine asks the open sync panel; the
answers travel over a long-lived `sync-confirm` port — `runtime.sendMessage`
stays as a legacy fallback. The engine resolves the gate on the port's
answer or its `onDisconnect`: when the last interface closed, the gate
declines instantly, and with no responder at all it waits out a generous
timeout and auto-declines. An explicit Keep/Cancel arrives as
`reason:'rejected'` and gets its own log line); declining it strips the `deleteServer` ops from the
plan for that run, so the server copy is kept and the questions re-ask
on the next sync. Local Trash moves stay unaffected: a rename inside the
handle keeps the SOURCE folder's FMD5 in the filename
(`moveMessage(..., {keepFmd5: true})`), producing the foreign-FMD5
interloper the engine replays as a single server MOVE, never a purge.
Flag renames preserve a filename's own FMD5 too (`renameFile` no longer
recomputes it), so marking a moved-but-unsynced message read cannot
erase the pending-move marker. Server-directed relocations (`relocate`
op) still stamp the destination FMD5 — server wins, the file adopts its
new home.

**Missing local dir:** the survey distinguishes an *empty* Maildir from a
*vanished* one (`listLocal()` returning `null` while the server folder is
still selectable). The heading of a dir the engine managed before (snapshot
entry) whose dir was deleted locally follows the snapshot **and** the server:
an empty folder classifies as a `deleteServerFolder` op (`reason: local dir
deleted`) — the server mailbox is deleted too, and only ever when the server
copy is empty as well (a server that still holds messages re-pulls instead,
so nothing server-side can vanish silently). A dir that held mail keeps the
server folder with a `[plan]` warning and re-creates + re-pulls the mirror
(the whole-folder mirror is never allowed to cascade into mass server
purges). The survey flags the re-pull form in the log (`⟳ RESYNC (local dir
missing)`). Folders with no snapshot state stay silent (nothing to heal).
The `deleteDir(name)` facade (`client.mjs`) issues the IMAP `DELETE`; like
`appendMail`, it needs the wasm core build to export a folder-delete
passthrough (`core/rust-imap-client/api.mjs`).

**Dir-drop gate:** when a server folder is deleted (from the mail client or
anywhere else), the local Maildir it mirrored becomes a `dropLocal` op —
planned only when every file in that dir is engine-tracked mail already
confirmed server-side (no untracked drops, foreign-FMD5 pending moves, tmp
strays or duplicate-uid files; such dirs stay on disk with a warning since
they contain mail the server never acknowledged). `createSync(mail, store,
{confirmDropDirectory})` receives a callback (the offscreen engine asks
the open sync panel; as with the purge gate the answers travel over the
`sync-confirm` port, a disconnect of the last port or an explicit
Keep/Cancel declines instantly — see the purge gate above); declining
strips the `dropLocal` ops so the local dir survives and the question
re-asks on the next sync. The op removes the whole local dir (files, the
`.uidvalidity` marker, `tmp/new/cur` — `removeEntry({recursive})` on the
account dir with a manual-sweep fallback), the snapshot's folder entry
disappears with the post-apply rebuild, and scoped (`--dir`) runs are
never affected since local-only dirs are only computed in full runs.

Known v1 limitations: IMAP keywords beyond the five letters give warnings
(local-born mail is uploaded: the APPEND uplink routes locally inserted
messages through the same msgid-dedupe as dropped files); server folder
renames leave a resync footprint via `purgeLocal` + re-pull.
