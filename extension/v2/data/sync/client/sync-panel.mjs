'use strict';

// sync-panel.mjs — the wiring behind the <sync-view> surface of the sync
// client (data/sync/client/index.html), hosted on its own tab: opened plain,
// the
// Account select is shown; opened with ?account=<id> (e.g. from the picker)
// that account is locked. The mail client (data/client/index.mjs) carries
// no sync interface anymore — its sync button just opens this page.
//
// Gate confirmations (purge / dir drop) answer over a long-lived
// 'sync-confirm' port (chrome.runtime.connect): the engine resolves a
// pending gate on the port's answer OR the port's onDisconnect (the last
// interface closed = instant decline), and an explicit Keep/Cancel answer
// carries reason:'rejected' so its decline is narrated distinctly.
//
// The sync engine itself lives in an offscreen document (data/sync/
// offscreen.html): the host page only configures it, requests runs
// and shows its logs. Logs travel chrome.runtime.sendMessage both ways:
// opening the panel pulls the engine's current log array (sync-ui-init)
// and then appends the broadcast batches ('sync-log'). Several panels —
// on several pages, at once — all receive the same stream. Opening a
// panel does NOT boot the engine: the offscreen document only exists
// while the job queue has work; when its list is empty the panel says
// so instead ('sync engine not running'). Closing the panel only drops
// the view's local history; the offscreen stream carries on for the
// panels that are still open.
//
// Filter runs (the filter row) are the one job that never reaches the
// offscreen: they execute right here — the page owns the granted handle,
// a MaildirStore and chrome.storage (the options-page filter list) — and
// narrate through the same log pane.

import '../../components/prompt-view.js';
import './components/sync-view.js';
import {loadAccounts, decryptPassword} from './accounts.mjs';
import {MaildirStore} from '../maildir.mjs';
import {bootSilent} from '../disk.mjs';
import {getRootHandle} from '../../client/local-api.mjs';
import {loadFilters} from '../filters/route.mjs';
import {runFilter} from '../filters/run.mjs';

/**
 * Wires one <sync-view> element to the offscreen sync engine.
 * @param {SyncView} syncView the panel element
 * @param {PromptView} promptEl a prompt host for passwords / confirms
 * @param {object} [opts]
 * @param {string} [opts.account] fixed account id to dictate at boot
 * @return {{open, close, isOpen, setAccount}}
 */
export function initSyncPanel(syncView, promptEl, opts = {}) {
  const {account = ''} = opts;
  const PROTO = 1;                    // log protocol stamp (see offscreen.mjs)
  let syncOpen = false;
  let forcedAccount = account;        // client-fashioned account lock
  let accounts = [];                  // last loadAccounts() result
  let announced = '';                 // last announced sync target (dedupes)
  // this view's own submitted jobs: rid → request-button id. The matching
  // button stays disabled until the engine's sync-jobs broadcast drops the
  // rid (done/rejected/killed) — other views' requests are other views' pins
  const BTN_OF_KIND = new Map([
    ['sync', 'sync'],
    ['dry', 'dry'],
    ['sync-dir', 'syncdir'],
    ['dry-dir', 'drydir'],
    ['discard', 'discard'],
    ['filter-dir', 'filterrun'],
    ['dry-filter-dir', 'filterdry']
  ]);
  const FILTER_KINDS = new Set(['filter-dir', 'dry-filter-dir']);
  const FILTER_SCOPES = ['unread', '10m', '30m', '1h', '5h'];
  const pendingRids = new Map();
  let ridSeq = 0;
  // panel-side filter runs pin both filter buttons while in flight (no
  // offscreen rid exists for them — the run executes right here)
  let filterRunning = false;
  // user preferences over the confirm gates (chrome.storage.local, the
  // 'sync-ui.' prefix): 'ask' prompts, 'yes' approves silently, 'no'
  // declines like an aborted confirm
  const PREF_KEYS = ['purge', 'drop', 'discard'];
  const prefs = {purge: 'ask', drop: 'ask', discard: 'ask'};
  // the gate channel: one long-lived port while the panel is open ('sync-
  // confirm'); dead when the engine document is gone — the engine restarts
  // per job, so the port is re-established on first contact with a new one
  let gatePort = null;
  let deadPort = false;
  let lastGen = null;                 // log generation stamp (engine restarts)

  /** drops the old gate port and connects a fresh one (idempotent) */
  function ensureGatePort() {
    if (!gatePort || deadPort) {
      gatePort = connectGate();
    }
  }

  function applyPending() {
    const ids = [...pendingRids.values()];
    if (filterRunning) {
      ids.push('filterrun', 'filterdry');
    }
    syncView.setPendingButtons(ids);
  }

  /**
   * Lookup by storage id OR local slug id: the client's folder pane
   * dictates accounts by the granted-directory tree (what the client's
   * listAccounts() walks), while the sync registry keys them by the
   * options-page id — both spell the same account.
   */
  function findAccount(id) {
    return accounts.find(a => a.id === id) ??
      accounts.find(a => a.slug === id) ?? null;
  }

  function labelOf(engine) {
    return engine?.label ? 'syncing · ' + engine.label : 'syncing…';
  }

  /** loads the stored sync-ui.* preferences ('ask' when absent) */
  async function loadPrefs() {
    const stored = await chrome.storage.local
      .get(PREF_KEYS.map(key => 'sync-ui.' + key)).catch(() => ({}));
    for (const key of PREF_KEYS) {
      const value = stored['sync-ui.' + key];
      prefs[key] = ['yes', 'no'].includes(value) ? value : 'ask';
    }
    syncView.setPrefs(prefs);
  }

  /** reads one remembered sync-ui.* selection ('' when absent) */
  async function getLastPref(key) {
    const stored = await chrome.storage.local
      .get('sync-ui.' + key).catch(() => ({}));
    return stored['sync-ui.' + key] || '';
  }

  /** remembers one sync-ui.* selection (silently best-effort) */
  function setLastPref(key, value) {
    chrome.storage.local
      .set({['sync-ui.' + key]: value})
      .catch(e => console.error('[sync] preference save failed:', e));
  }

  /** persists the dialog's edit (one flat 'sync-ui.<key>' per preference) */
  function savePrefs(next) {
    for (const key of PREF_KEYS) {
      prefs[key] = ['yes', 'no'].includes(next?.[key]) ? next[key] : 'ask';
    }
    syncView.setPrefs(prefs);
    chrome.storage.local
      .set(Object.fromEntries(PREF_KEYS.map(key => ['sync-ui.' + key, prefs[key]])))
      .catch(e => syncView.localNote(
        'saving preferences failed: ' + (e?.message || e), 'conflict'));
    syncView.localNote(
      '(preferences saved: purge=' + prefs.purge + ', drop=' + prefs.drop +
      ', discard=' + prefs.discard + ')');
  }

  /** the gate's preference for a confirm kind ('ask' when unknown) */
  function prefOf(kind) {
    return ['yes', 'no'].includes(prefs[kind]) ? prefs[kind] : 'ask';
  }

  /** a readable preference kind for the log pane */
  function kindLabel(kind) {
    return kind === 'purge' ? 'purge from server'
      : kind === 'drop' ? 'drop local dir' : kind;
  }

  chrome.runtime.onMessage.addListener(msg => {
    // log stream: the offscreen tags every batch; panels filter by protocol
    // stamp and de-dupe by (gen, seq) — a late init snapshot may overlap
    // the stream, and a new engine document (new gen) resets everything
    if (msg?.type === 'sync-log') {
      if (msg.proto !== PROTO) {
        return;
      }
      // a new generation = a fresh engine document: our gate port points at
      // the dead one, so re-connect before anything answers over the old one
      if (msg.gen && msg.gen !== lastGen) {
        lastGen = msg.gen;
        ensureGatePort();
      }
      syncView.appendLogs(msg.lines || []);
      return;
    }
    // queue state: unpin this view's rids that are no longer pending; the
    // broadcast carries every pending job, but only OUR rids were pinned
    if (msg?.type === 'sync-jobs') {
      const live = new Set((msg.items || []).map(j => j.rid));
      let dirty = false;
      for (const rid of [...pendingRids.keys()]) {
        if (!live.has(rid)) {
          pendingRids.delete(rid);
          dirty = true;
        }
      }
      if (dirty) {
        applyPending();
      }
      return;
    }
    if (msg?.type === 'sync-running') {
      if (syncOpen) {
        syncView.setBusy(!!msg.busy, msg.busy ? labelOf(msg) : null);
        if (!msg.busy) {
          syncView.setStatus('run finished');
        }
      }
      return;
    }
    // destructive-delete gates: the host page answers over its long-lived
    // 'sync-confirm' port (the engine resolves the gate on the port's message
    // or its onDisconnect — every interface closed = instant decline, and a
    // declined-by-user answer carries reason:'rejected' for its own log line)
    if (msg?.type === 'sync-confirm-req') {
      // answering happens over the 'sync-confirm' port: a request may arrive
      // while our port still points at a dead engine document — re-connect
      // NOW (the engine is listening again) so the answer finds a live gate
      if (syncOpen && promptEl) {
        ensureGatePort();
      }
      if (!syncOpen || !promptEl) {
        replyConfirm(msg.requestId, false, 'rejected');
        return;
      }
      const GATES = new Map([
        ['purge', ['Purge']],
        ['drop', ['Drop']]
      ]);
      const verbs = GATES.get(msg.kind) || ['Remove'];
      const verb = verbs[0];
      const pref = prefOf(msg.kind);
      // 'yes' approves silently, 'no' declines like an aborted confirm;
      // 'ask' shows the user the choice prompt as always
      if (pref === 'yes') {
        syncView.localNote(
          '(' + kindLabel(msg.kind) + ' approved automatically by preference)',
          'hint'
        );
        replyConfirm(msg.requestId, true);
        return;
      }
      if (pref === 'no') {
        syncView.localNote(
          '(' + kindLabel(msg.kind) + ' declined automatically by ' +
          'preference — nothing was deleted)', 'hint'
        );
        replyConfirm(msg.requestId, false, 'rejected');
        return;
      }
      promptEl.askChoice(msg.text, [verb, 'Keep'])
        .then(choice =>
          replyConfirm(msg.requestId, choice === verb,
            choice === verb ? undefined : 'rejected'))
        .catch(() => replyConfirm(msg.requestId, false, 'rejected'));
      return;
    }
  });

  /**
   * Gate answers travel over the 'sync-confirm' port (runtime.sendMessage
   * turned out not to reach the offscreen document reliably); a dead port
   * is reconnected once — the fresh connection will be dead too when the
   * engine is gone, and the failure is narrated without throwing.
   */
  function replyConfirm(requestId, ok, reason, value) {
    const post = port => {
      const message = {type: 'sync-confirm', requestId, ok, reason};
      if (value !== undefined) {
        message.value = value;
      }
      port.postMessage(message);
      return true;
    };
    try {
      if (gatePort && !deadPort) {
        post(gatePort);
        return;
      }
      gatePort = connectGate();
      if (gatePort) {
        post(gatePort);
      }
      else {
        syncView.localNote(
          'confirm lost — the sync engine is gone; the run treats it as declined',
          'conflict'
        );
      }
    }
    catch (e) {
      console.error('[sync] confirm answer failed:', e?.message || e);
    }
  }

  /** one port per panel open; the offscreen resolves gates on its death too */
  function connectGate() {
    const port = chrome.runtime.connect({name: 'sync-confirm'});
    deadPort = false;
    port.onDisconnect.addListener(() => {
      deadPort = true;
    });
    return port;
  }

  /** account/dir dropdowns: accounts from storage, dirs from the Maildir tree */
  async function populateSelects() {
    // metadata only: no passwords decrypted here, no master-password prompt —
    // decryption happens just-in-time when a run is dispatched
    accounts = await loadAccounts(promptEl, {decrypt: false}).catch(() => []);
    syncView.setAccounts(accounts.map(a => ({
      id: a.id,
      label: (a.name || a.id) + ' — ' + a.user + '@' + a.host
    })));
    if (forcedAccount) {
      syncView.setLockedAccount(forcedAccount);
    }
    else {
      // recall the last picked account (sync-ui.lastAccount) — only in the
      // standalone panel: a forced account dictates its own selection
      const last = await getLastPref('lastAccount');
      if (last && findAccount(last)) {
        syncView.pickAccount(last);
      }
    }
    await refreshDirs();
    return refreshFilters();
  }

  async function refreshDirs() {
    const acc = findAccount(syncView.pickedAccount());
    const root = await getRootHandle().catch(() => null);
    let names = [];
    if (acc && root) {
      try {
        const store = new MaildirStore(root, acc.slug);
        await store.open();
        names = (await store.listFolders()).sort((a, b) => a.localeCompare(b));
      }
      catch (e) {
        names = [];
      }
    }
    // the dir list is ready: re-select the account's remembered pick
    // (sync-ui.lastDir.<id>) when it still exists in the fresh list —
    // the forced-account mode dictates its own target, no recall there
    const preferred = acc && !forcedAccount
      ? await getLastPref('lastDir.' + acc.id)
      : '';
    syncView.setDirs(names, preferred || null);
  }

  /**
   * The filter row's select: every ENABLED filter of the options page
   * that applies to the picked account (accountId '' = all accounts),
   * labeled with the filter's destination folder — the query itself is
   * the user's own, so the select just says where matching moves land.
   * The last pick (sync-ui.lastFilter.<id>) is re-selected when still
   * offered; the scope choice is global.
   */
  async function refreshFilters() {
    const acc = findAccount(syncView.pickedAccount());
    let stored = [];
    try {
      stored = await loadFilters();
    }
    catch {
      stored = [];
    }
    const list = stored
      .filter(f => f && f.enabled !== false &&
        typeof f.query === 'string' && f.folder &&
        (!f.accountId || (acc && f.accountId === acc.id)))
      .map(f => ({
        id: f.id,
        label: `Your query moves to '${f.folder}' (remote folder)`
      }));
    const preferred = acc ? await getLastPref('lastFilter.' + acc.id) : '';
    syncView.setFilters(list, preferred || null);
    syncView.setScope(await getLastPref('lastFilterScope'));
  }

  async function open() {
    if (syncOpen) {
      return;
    }
    // the gate channel: a fresh port per open (a closed interface declines
    // pending gates — the engine's port onDisconnect is the live signal)
    gatePort = connectGate();
    // the engine array is the only log store: when the offscreen document
    // is not up (no jobs since the last one closed), this send fails and
    // the panel starts empty — it never boots the engine itself
    const data = await chrome.runtime.sendMessage({type: 'sync-ui-init'})
      .catch(() => null);
    syncView.replaceLogs(data?.logs || []);
    if (!data?.ok) {
      // a dead engine holds no jobs: this view's old pins can't complete
      pendingRids.clear();
      applyPending();
    }
    syncView.setBusy(!!data?.running, data?.running ? labelOf(data) : null);
    await loadPrefs();
    await applyAccessVerdict(data);
    await populateSelects();
    syncOpen = true;
    syncView.hidden = false;
    if (forcedAccount) {
      syncView.setLockedAccount(forcedAccount);
      announceAccount();       // label now known (populateSelects resolved)
    }
    else if (!data?.ok) {
      syncView.localNote('(sync engine not running — press Sync to start a job)', 'hint');
    }
  }

  function close() {
    // closing the interface only drops its view: the engine log var is
    // untouched — the next open pulls the accumulated logs if the engine
    // is still alive (kill and the empty-queue close clear it for good);
    // per-view job pins reset too (a re-open starts pin-free)
    pendingRids.clear();
    applyPending();
    // drop the gate channel: the engine hears the disconnect and, when the
    // LAST interface closed, declines any pending confirm instantly
    if (gatePort) {
      try {
        gatePort.disconnect();
      }
      catch {}
      gatePort = null;
      deadPort = true;
    }
    syncView.hidden = true;
    syncOpen = false;
    announced = '';              // the next open re-announces the target
    syncView.clearLogs();
    syncView.setBusy(false);
  }

  function isOpen() {
    return syncOpen;
  }

  /**
   * Announces the dictated sync target in the log pane — the embedded panel
   * shows no account UI, so this line is how the user sees what will sync.
   * The label resolves from the loaded account metadata (empty accounts
   * before open() would be premature); re-announces when it changes.
   */
  function announceAccount() {
    if (!syncOpen || !forcedAccount) {
      return;
    }
    const acc = findAccount(forcedAccount);
    const label = acc
      ? (acc.name || acc.id) + ' — ' + acc.user + '@' + acc.host
      : '"' + forcedAccount + '" is not configured (options page)';
    if (label === announced) {
      return;
    }
    announced = label;
    syncView.localNote(
      'sync target: ' + label + ' (this page\'s selection)',
      acc ? 'hint' : 'conflict'
    );
  }

  /**
   * Dictates the panel's account (the client selection) — an empty id
   * re-shows the selectors.
   */
  function setAccount(id) {
    forcedAccount = id || '';
    syncView.setLockedAccount(forcedAccount);
    announceAccount();
  }

  /**
   * Renders the access verdict, WITHOUT phishing the user into a re-grant:
   * the picker's probe-backed grant is the real check, and an extension
   * page's own queryPermission can read 'prompt'/'denied' with no real
   * lapse. A 'denied' verdict is never trusted on its own — it is backed by
   * a picker-style write probe first (a page-context misread of a live
   * grant is the common false alarm); only a probe that actually fails
   * trips the re-grant row. 'no-handle' (nothing ever picked) goes straight
   * to the row; 'prompt' and other odd verdicts render as granted with a
   * soft note (the engine still re-checks for real at every job start). A
   * granted verdict reported by a live engine init (data.granted) is
   * trusted outright.
   */
  async function applyAccessVerdict(data) {
    if (data?.granted) {
      syncView.setGranted(true);
      syncView.setStatus(null);
      return;
    }
    const gate = await bootSilent().catch(e =>
      ({ok: false, raw: null, error: e?.message || String(e)}));
    if (gate.ok) {
      syncView.setGranted(true);
      syncView.setStatus(null);
      return;
    }
    if (gate.reason === 'no-handle') {
      syncView.setGranted(false);
      syncView.setStatus('access: no stored handle — run the picker');
      return;
    }
    if (gate.raw === 'denied') {
      // the query says revoked, but page-context checks misread live grants:
      // a successful write proves the access, so the row stays down
      if (await probeAccess(gate.handle)) {
        syncView.setGranted(true);
        syncView.setStatus(
          'access: queryPermission → "denied" (probe wrote fine — re-checked at run start)'
        );
        return;
      }
      syncView.setGranted(false);
      syncView.setStatus('access: revoked — run the picker to grant the folder again');
      return;
    }
    // 'prompt' / unroutable checks: not a revoked grant — never scare the user
    syncView.setGranted(true);
    syncView.setStatus(
      'access: ' + (gate.raw
        ? `queryPermission → "${gate.raw}" — re-checked at run start`
        : `checking failed (${gate.error}) — re-checked at run start`)
    );
  }

  /**
   * Picker-style write probe (data/picker/index.js): one '.panel-probe'
   * file create + overwrite; dot-names are ignored by the maildir walkers
   * and the sync engine. Success proves real readwrite access no matter
   * what queryPermission claimed.
   */
  async function probeAccess(handle) {
    try {
      const file = await handle.getFileHandle('.panel-probe', {create: true});
      const writable = await file.createWritable();
      await writable.close();
      return true;
    }
    catch {
      return false;
    }
  }

  // remembering the selection (same sync-ui.* prefix as the gate prefs):
  // the account pick and each account's last dir — the forced-account
  // mode dictates its own target and never touches these keys
  syncView.addEventListener('sync-account-changed', e => {
    const id = e?.detail?.account;
    if (!forcedAccount && id) {
      setLastPref('lastAccount', id);
    }
    return Promise.all([refreshDirs(), refreshFilters()]);
  });
  syncView.addEventListener('sync-dir-changed', e => {
    const acc = findAccount(syncView.pickedAccount());
    const dir = e?.detail?.dir;
    if (acc && dir) {
      setLastPref('lastDir.' + acc.id, dir);
    }
  });
  // remembering the filter row's picks: the filter per account, the scope
  // globally (same sync-ui.* namespace as the other selections)
  syncView.addEventListener('sync-filter-changed', e => {
    const acc = findAccount(syncView.pickedAccount());
    const {filterId, scope} = e?.detail ?? {};
    if (acc && filterId) {
      setLastPref('lastFilter.' + acc.id, filterId);
    }
    if (FILTER_SCOPES.includes(scope)) {
      setLastPref('lastFilterScope', scope);
    }
  });
  syncView.addEventListener('sync-prefs', e => savePrefs(e.detail));

  // the Stop button: red button for an urgent stop — the worker asks the
  // engine goodbye, closes the document (current job included) and drops
  // its bridge ref; every open panel hears the goodbye log line
  syncView.addEventListener('sync-kill', () => {
    syncView.setStatus('stopping the sync…');
    chrome.runtime.sendMessage({type: 'sync-kill'})
      .then(res => {
        if (!res?.ok) {
          syncView.setStatus('stop failed: ' + (res?.error || 'unknown'));
          return;
        }
        // nothing of ours survives the kill: unpin everything at once
        // (the goodbye broadcast would too, but the engine doc is gone)
        pendingRids.clear();
        applyPending();
        syncView.setBusy(false, null);
        syncView.setStatus('sync stopped');
      })
      .catch(e => syncView.setStatus('stop failed: ' + (e?.message || String(e))));
  });

  /**
   * The offscreen engine has no chrome.storage: the resolved IMAP config —
   * including the password — travels IN the request message. Encrypted
   * passwords are decrypted here, just-in-time, only for the account that is
   * actually being synced (prompting for the master password via prompt-view
   * only ever happens when a run needs a password).
   * @returns the sendable account config or null (with a status line set)
   */
  async function resolveSyncAccount(account) {
    if (!account.encrypted) {
      return account;
    }
    const storage = await chrome.storage.local.get('user.pass.' + account.id)
      .catch(() => ({}));
    const stored = storage['user.pass.' + account.id];
    let pass;
    try {
      pass = await decryptPassword(stored, promptEl, account.name || account.id);
    }
    catch (e) {
      syncView.setStatus(
        (e?.message || String(e)) + ' — confirm it, then press again'
      );
      return null;
    }
    return {...account, pass};
  }

  /**
   * Panel-side filter run/dry run: no offscreen job — the granted handle
   * and the Maildir store live here too. The filter object is re-read
   * from storage (never a stale copy), candidates come from the local
   * mirror and every output line lands in the log pane. The '__all__'
   * pick resolves to every runnable filter of the picked account, run
   * one after another (stop on the first failure — the individual runs
   * are atomic renames, so the settled part is safe). A run in flight
   * pins both filter buttons (applyPending) until it settles; closing
   * the panel mid-run lets it finish — every moveMessage is an
   * independent atomic rename, so partial runs are always safe.
   */
  async function runFilterJob(kind, accountId, dir, detail) {
    const picked = findAccount(accountId);
    if (!picked) {
      syncView.setStatus('account "' + accountId + '" is not configured (options page)');
      return;
    }
    if (!dir) {
      return;   // the view keeps the buttons disabled without a dir anyway
    }
    const filters = await loadFilters().catch(() => []);
    const runnable = f => f && f.enabled !== false &&
      typeof f.query === 'string' && f.folder &&
      (!f.accountId || f.accountId === picked.id);
    let chosen;
    if (detail?.filterId === '__all__') {
      chosen = filters.filter(runnable);
      if (!chosen.length) {
        syncView.setStatus('no runnable filters — re-check the options page');
        return;
      }
    }
    else {
      const filter = filters.find(f => f && f.id === detail?.filterId);
      if (!filter || !runnable(filter)) {
        syncView.setStatus('the selected filter is gone or not runnable — re-check the options page');
        return;
      }
      chosen = [filter];
    }
    const root = await getRootHandle().catch(() => null);
    if (!root) {
      syncView.setStatus('no granted directory — run the picker first');
      return;
    }
    let store = null;
    try {
      store = new MaildirStore(root, picked.slug);
      await store.open();
    }
    catch (e) {
      syncView.setStatus('cannot open the local mirror: ' + (e?.message || e));
      return;
    }
    const dry = kind === 'dry-filter-dir';
    const scope = FILTER_SCOPES.includes(detail?.scope) ? detail.scope : 'unread';
    // log(content, cls) → the pane's 'filter' type ('' plain, 'hint',
    // 'warn', 'system' bordered — the run.mjs output contract)
    const note = (content, cls = '') => syncView.localNote(content, cls, 'filter');
    filterRunning = true;
    applyPending();
    const t0 = Date.now();
    try {
      syncView.setStatus((dry ? 'dry-running' : 'running') + ' filter' +
        (chosen.length > 1 ? 's' : '') + ' on ' + dir + '…');
      const totals = {candidates: 0, matched: 0, moved: 0};
      for (const filter of chosen) {
        const res = await runFilter(store, {
          dir,
          filter,
          accountId: picked.id,
          scope,
          dry,
          log: note
        });
        totals.candidates += res.candidates;
        totals.matched += res.matched;
        totals.moved += res.moved;
      }
      const secs = Math.max(1, Math.round((Date.now() - t0) / 1000));
      note(`filter ${dry ? 'dry run' : 'run'} finished` +
        (chosen.length > 1 ? ` (${chosen.length} filter(s))` : '') + ': ' +
        `${totals.candidates} candidate(s), ${totals.matched} matched` +
        (dry ? '' : `, ${totals.moved} moved`) + ` (${secs}s)`, 'system');
      syncView.setStatus(null);
    }
    catch (e) {
      syncView.setStatus('filter run failed: ' + (e?.message || e));
      note('filter run FAILED: ' + (e?.stack || e), 'warn');
    }
    finally {
      filterRunning = false;
      applyPending();
    }
  }

  syncView.addEventListener('sync-request', async e => {
    const {kind, account: accountId, dir} = e.detail;
    if (FILTER_KINDS.has(kind)) {
      await runFilterJob(kind, accountId, dir, e.detail);
      return;
    }
    const picked = findAccount(accountId);
    if (!picked) {
      syncView.setStatus('account "' + accountId + '" is not configured (options page)');
      return;
    }
    const account = await resolveSyncAccount(picked);
    if (!account) {
      return;
    }
    // dedupe happens per view, not in the queue: one job keeps ITS button
    // pinned until it is done — other views may submit the same thing
    const rid = 'job-' + Date.now().toString(36) + '-' + (++ridSeq);
    const btnOf = BTN_OF_KIND.get(kind);
    if (kind !== 'discard' || await confirmDiscard(account)) {
      pendingRids.set(rid, btnOf);
      applyPending();
      const res = await chrome.runtime.sendMessage({
        type: 'sync-request', rid, kind, account, dir
      }).catch(err => ({ok: false, error: err?.message || String(err)}));
      if (!res?.ok || res?.started === false) {
        // never enqueued: unpin and explain
        pendingRids.delete(rid);
        applyPending();
        syncView.setStatus(
          'request rejected: ' + (res?.reason || res?.error || 'unknown')
        );
      }
      else {
        syncView.setStatus(null);
      }
    }
  });

  async function confirmDiscard(account) {
    const pref = prefOf('discard');
    if (pref === 'yes') {
      syncView.localNote('(discard approved automatically by preference)', 'hint');
      return true;
    }
    if (pref === 'no') {
      syncView.localNote('(discard declined automatically by preference)', 'hint');
      return false;
    }
    try {
      const choice = await promptEl.askChoice(
        'Discard the local copy of "' + (account?.name || account?.id) + '"?\n\n' +
        'Every message is wiped from the granted directory and lastSyncAt ' +
        'resets. The server copy is NOT touched; press Sync for the full ' +
        're-pull.',
        ['Discard', 'Keep'],
        {label: 'Cancel'}
      );
      return choice === 'Discard';
    }
    catch {
      return false;
    }
  }

  return {open, close, isOpen, setAccount};
}
