// sync-view.js — the sync interface of the sync client (data/sync/
// index.html): a full-height panel hosting every element of the interface —
// account select, dir select, combo-wrapped Sync / Dry run / Sync dir / Dry
// run dir buttons, the filter row (filter select, candidate scope select
// and combo-wrapped Run / Dry run filter buttons), the suggested-dirs row
// (the dirs the dirty report marks as needing a resync, plus the Sync
// suggested dirs button that runs one scoped sync per listed dir), the
// Discard local copy button and the Stop button (kills the ongoing sync —
// the engine document is closed and every queued job dropped) — plus the
// log pane fed by the engine's log stream.
//
// Dumb renderer: it forwards 'sync-request' CustomEvents
// {kind:'sync'|'dry'|'sync-dir'|'dry-dir'|'sync-dirs'|'discard'|
// 'filter-dir'|'dry-filter-dir', account, dir[, dirs][, filterId, scope]}
// and exposes setters consumed by the wiring in the client/sync-panel.mjs.

import '../../../components/combo-view.js';
import './log-view.js';

// pseudo-id of the "Use all filters" select entry (setFilters offers it
// with more than one filter; the wiring resolves it to the whole set)
const ALL_FILTERS = '__all__';

class SyncView extends HTMLElement {
  #shadow;
  #account;
  #accountLabel;
  #dir;
  #filter;
  #scope;
  #dirtyline;
  #status;
  #regrant;
  #out;
  #buttons = {};   // id → button element
  #filters = [];   // [{id, label}] offered by the wiring (setFilters)
  #lines = [];     // {seq, gen, ts, type, content, cls} from the engine's log var
  #last = null;    // {gen, seq} of the newest accepted line: the engine's
                   // seq restarts at 0 in every document, so dedupe keys on
                   // the generation stamp too
  #pending = new Set(); // request-button ids pinned by the wiring (a
                        // submitted job keeps its button disabled until
                        // the engine reports it done)
  #suggested = []; // dirty-report dir names (setSuggested) — the Sync
                   // suggested dirs button stays disabled while empty
  #rendered = 0;  // how many of #lines the log-view already holds: only the
                  // tail beyond this index is handed over on each flush
  #busy = false;   // live lock from sync-ui-init / sync-running
  #lockedId = '';  // fixed account id ('' = selectors shown)
  #prefs = {purge: 'ask', drop: 'ask', discard: 'ask'};

  constructor() {
    super();
    this.#shadow = this.attachShadow({mode: 'open'});
    this.#shadow.innerHTML = `
      <style>
         :host {
           display: flex;
           flex-direction: column;
           height: 100%;
           width: 100%;
           min-height: 0;
           box-sizing: border-box;
          background: var(--pane-bg, #ffffff);
          border: 1px solid var(--line, #d9dce1);
          border-radius: var(--radius, 10px);
          color: var(--fg, #1b1d21);
          font: calc(12px * var(--font-scale, 1))/1.5 system-ui, -apple-system,
                "Segoe UI", Roboto, sans-serif;
        }
        :host([hidden]) { display: none; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
         header, footer {
           flex: 0 0 auto;
         }
         main {
           flex: 1 1 auto;
           min-height: 0;
           overflow: hidden;
           border-top: 1px solid var(--line, #d9dce1);
           border-bottom: 1px solid var(--line, #d9dce1);
         }
         log-view {
           display: block;
           height: 100%;
         }
         .row {
           display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
          padding: 8px;
        }
      .row[hidden] {
          display: none;
      }
        select, #discard, #kill, #clearlog, #syncdirs {
          font: inherit;
          min-height: 28px;
          padding: 2px 10px;
          border: 1px solid var(--line, #d9dce1);
          border-radius: var(--radius, 10px);
          background: var(--bg, #f5f6f8);
          color: var(--fg, #1b1d21);
        }
        #discard, #kill, #clearlog, #syncdirs { cursor: pointer; }
        #discard:hover:enabled, #kill:hover:enabled,
        #clearlog:hover:enabled, #syncdirs:hover:enabled {
          border-color: var(--dim, #6f747d);
        }
        #discard:disabled, #kill:disabled, #clearlog:disabled,
        #syncdirs:disabled, select:disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }
        .dirbox {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 3px 6px;
          border: 1px dashed var(--line, #d9dce1);
          border-radius: var(--radius, 10px);
        }
         #discard, #kill { border-color: #8c3a3a; color: light-dark(#b3261e, #f2b8b5); }
        .note {
          color: var(--dim, #6f747d);
          font-size: 11px;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
        }
         .note a { color: inherit; text-decoration: underline; }
         footer .note {
           display: block;
         }
        .footer-row {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px;
        }
        #prefs, dialog button {
          font: inherit;
          min-height: 28px;
          padding: 2px 10px;
          border: 1px solid var(--line, #d9dce1);
          border-radius: var(--radius, 10px);
          background: var(--bg, #f5f6f8);
          color: var(--fg, #1b1d21);
          cursor: pointer;
        }
        #prefs, #clearlog {
          margin-left: auto;
          flex: 0 0 auto;
        }
        #clearlog + #prefs {
          margin-left: 0;
        }
        #prefs {
          width: 28px;
          padding: 2px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        #prefs:hover { border-color: var(--dim, #6f747d); }
        #prefs svg { width: 16px; height: 16px; display: block; }
        dialog {
          position: fixed;
          inset: 0;
          margin: auto;
          border: 1px solid var(--line, #d9dce1);
          border-radius: var(--radius, 10px);
          background: var(--pane-bg, #ffffff);
          color: var(--fg, #1b1d21);
          font: inherit;
          padding: 14px;
          width: min(480px, 92vw);
        }
        dialog::backdrop { background: rgba(0, 0, 0, 0.35); }
        .prefs-head {
          font-weight: 600;
          margin-bottom: 10px;
        }
        .prefs-row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          align-items: center;
          gap: 10px;
          padding: 6px 0;
          border-top: 1px solid var(--line, #d9dce1);
        }
        .prefs-label { min-width: 0; }
        .prefs-label .title { display: block; }
        .prefs-label .hint {
          display: block;
          color: var(--dim, #6f747d);
          font-size: 11px;
        }
        .prefs-row select {
          font: inherit;
          min-height: 28px;
          border: 1px solid var(--line, #d9dce1);
          border-radius: var(--radius, 10px);
          background: var(--bg, #f5f6f8);
          color: var(--fg, #1b1d21);
        }
        .prefs-actions {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
          margin-top: 12px;
        }
        </style>
       <header>
         <div class="row">
           <label id="account-label" for="account">Account</label>
           <select id="account"></select>
           <combo-view label="Account">
             <button id="sync" type="button">Sync</button>
             <button id="dry" type="button">Dry run</button>
           </combo-view>
           <span class="dirbox">
              <label for="dir">Dir</label>
              <select id="dir" disabled></select>
              <combo-view label="Dir">
                <button id="syncdir" type="button" disabled>Sync</button>
                <button id="drydir" type="button" disabled>Dry run</button>
              </combo-view>
            </span>
            <button id="discard" type="button">Discard local copy</button>
            <button id="kill" type="button" hidden>Stop</button>
          </div>
          <div class="row">
            <label for="filter">Filter</label>
            <select id="filter" disabled></select>
            <label for="scope">Match</label>
            <select id="scope">
              <option value="unread">All unread</option>
              <option value="10m">Newer than 10 min</option>
              <option value="30m">Newer than 30 min</option>
              <option value="1h">Newer than 1 hour</option>
              <option value="5h">Newer than 5 hours</option>
            </select>
            <combo-view label="Filter">
              <button id="filterrun" type="button" disabled>Run</button>
              <button id="filterdry" type="button" disabled>Dry run</button>
            </combo-view>
          </div>
          <div class="row" id="dirtyrow">
            <span class="note" id="dirtyline">checking the dirty report…</span>
            <button id="syncdirs" type="button" disabled>Sync suggested dirs</button>
          </div>
        </header>
       <main>
         <log-view id="out" timestamps max-lines="500"></log-view>
       </main>
        <footer>
          <div class="row footer-row">
            <span class="note status" hidden></span>
            <button id="clearlog" type="button" title="Clear the log pane">Clear</button>
            <button id="prefs" type="button" title="Preferences">
              <svg viewBox="0 0 30 30" aria-hidden="true">
              <path transform="translate(-101,-360)" fill-rule="evenodd" d="M128.52,381.134 L127.528,382.866 C127.254,383.345 126.648,383.508 126.173,383.232 L123.418,381.628 C122.02,383.219 120.129,384.359 117.983,384.799 L117.983,387 C117.983,387.553 117.54,388 116.992,388 L115.008,388 C114.46,388 114.017,387.553 114.017,387 L114.017,384.799 C111.871,384.359 109.98,383.219 108.582,381.628 L105.827,383.232 C105.352,383.508 104.746,383.345 104.472,382.866 L103.48,381.134 C103.206,380.656 103.369,380.044 103.843,379.769 L106.609,378.157 C106.28,377.163 106.083,376.106 106.083,375 C106.083,373.894 106.28,372.838 106.609,371.843 L103.843,370.232 C103.369,369.956 103.206,369.345 103.48,368.866 L104.472,367.134 C104.746,366.656 105.352,366.492 105.827,366.768 L108.582,368.372 C109.98,366.781 111.871,365.641 114.017,365.201 L114.017,363 C114.017,362.447 114.46,362 115.008,362 L116.992,362 C117.54,362 117.983,362.447 117.983,363 L117.983,365.201 C120.129,365.641 122.02,366.781 123.418,368.372 L126.173,366.768 C126.648,366.492 127.254,366.656 127.528,367.134 L128.52,368.866 C128.794,369.345 128.631,369.956 128.157,370.232 L125.391,371.843 C125.72,372.838 125.917,373.894 125.917,375 C125.917,376.106 125.72,377.163 125.391,378.157 L128.157,379.769 C128.631,380.044 128.794,380.656 128.52,381.134 L128.52,381.134 Z M130.008,378.536 L127.685,377.184 C127.815,376.474 127.901,375.749 127.901,375 C127.901,374.252 127.815,373.526 127.685,372.816 L130.008,371.464 C130.957,370.912 131.281,369.688 130.733,368.732 L128.75,365.268 C128.203,364.312 126.989,363.983 126.041,364.536 L123.694,365.901 C122.598,364.961 121.352,364.192 119.967,363.697 L119.967,362 C119.967,360.896 119.079,360 117.983,360 L114.017,360 C112.921,360 112.033,360.896 112.033,362 L112.033,363.697 C110.648,364.192 109.402,364.961 108.306,365.901 L105.959,364.536 C105.011,363.983 103.797,364.312 103.25,365.268 L101.267,368.732 C100.719,369.688 101.044,370.912 101.992,371.464 L104.315,372.816 C104.185,373.526 104.099,374.252 104.099,375 C104.099,375.749 104.185,376.474 104.315,377.184 L101.992,378.536 C101.044,379.088 100.719,380.312 101.267,381.268 L103.25,384.732 C103.797,385.688 105.011,386.017 105.959,385.464 L108.306,384.099 C109.402,385.039 110.648,385.809 112.033,386.303 L112.033,388 C112.033,389.104 112.921,390 114.017,390 L117.983,390 C119.079,390 119.967,389.104 119.967,388 L119.967,386.303 C121.352,385.809 122.598,385.039 123.694,384.099 L126.041,385.464 C126.989,386.017 128.203,385.688 128.75,384.732 L130.733,381.268 C131.281,380.312 130.957,379.088 130.008,378.536 L130.008,378.536 Z M116,378 C114.357,378 113.025,376.657 113.025,375 C113.025,373.344 114.357,372 116,372 C117.643,372 118.975,373.344 118.975,375 C118.975,376.657 117.643,378 116,378 L116,378 Z M116,370 C113.261,370 111.042,372.238 111.042,375 C111.042,377.762 113.261,380 116,380 C118.739,380 120.959,377.762 120.959,375 C120.959,372.238 118.739,370 116,370 L116,370 Z" fill="currentColor"/>
            </svg>
            </button>
          </div>
          <dialog id="prefs-dialog">
            <div class="prefs-head">Sync preferences</div>
            <div class="prefs-row">
              <span class="prefs-label">
                <span class="title">Purge from server</span>
                <span class="hint">Messages gone from the local Maildir are
                  deleted on the server too. No panel open: declined
                  automatically.</span>
              </span>
              <select data-pref="purge">
                <option value="ask">Ask</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </div>
            <div class="prefs-row">
              <span class="prefs-label">
                <span class="title">Drop local dir</span>
                <span class="hint">A server folder was deleted — its local
                  Maildir is dropped too. No panel open: declined
                  automatically.</span>
              </span>
              <select data-pref="drop">
                <option value="ask">Ask</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </div>
            <div class="prefs-row">
              <span class="prefs-label">
                <span class="title">Discard local copy</span>
                <span class="hint">Wipes every message from the granted
                  directory (the server copy is NOT touched). No headless
                  default — prompted when pressed.</span>
              </span>
              <select data-pref="discard">
                <option value="ask">Ask</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </div>
            <div class="prefs-actions">
              <button id="prefs-cancel" type="button">Cancel</button>
              <button id="prefs-save" type="button">Save</button>
            </div>
          </dialog>
         <div class="row" id="regrant" hidden>
           <span class="note">
             Directory access needs a re-grant —
             <a href="/data/picker/index.html" target="_blank">open the picker</a>
             to grant the folder again.
           </span>
         </div>
       </footer>
     `;
    this.#account = this.#shadow.getElementById('account');
    this.#accountLabel = this.#shadow.getElementById('account-label');
    this.#dir = this.#shadow.getElementById('dir');
    this.#filter = this.#shadow.getElementById('filter');
    this.#scope = this.#shadow.getElementById('scope');
    this.#status = this.#shadow.querySelector('.status');
    this.#regrant = this.#shadow.getElementById('regrant');
    this.#out = this.#shadow.getElementById('out');
    // the status bar's gear opens the preferences dialog
    const dialog = this.#shadow.getElementById('prefs-dialog');
    const selects = [...dialog.querySelectorAll('select[data-pref]')];
    this.#shadow.getElementById('prefs').addEventListener('click', () => {
      for (const sel of selects) {
        sel.value = this.#prefs[sel.dataset.pref] || 'ask';
      }
      dialog.showModal();
    });
    // the log pane's Clear: view-only — the engine's log var is untouched,
    // so other panels (and a re-open) still pull the full history; #last
    // stays as-is to keep the (gen, seq) dedupe state valid
    this.#shadow.getElementById('clearlog').addEventListener('click', () => {
      this.clearLogs();
      this.localNote('(log pane cleared)', 'hint');
    });
    this.#shadow.getElementById('prefs-cancel').addEventListener('click',
      () => dialog.close());
    this.#shadow.getElementById('prefs-save').addEventListener('click', () => {
      const prefs = {};
      for (const sel of selects) {
        prefs[sel.dataset.pref] = ['ask', 'yes', 'no'].includes(sel.value)
          ? sel.value : 'ask';
      }
      this.#prefs = prefs;
      dialog.close();
      this.dispatchEvent(new CustomEvent('sync-prefs', {
        detail: prefs,
        bubbles: true,
        composed: true
      }));
    });
    for (const id of ['sync', 'dry', 'syncdir', 'drydir', 'discard', 'kill',
      'filterrun', 'filterdry', 'syncdirs']) {
      this.#buttons[id] = this.#shadow.getElementById(id);
    }
    this.#dirtyline = this.#shadow.getElementById('dirtyline');
    const KINDS = new Map([
      ['sync', 'sync'],
      ['dry', 'dry'],
      ['syncdir', 'sync-dir'],
      ['drydir', 'dry-dir'],
      ['syncdirs', 'sync-dirs'],
      ['discard', 'discard'],
      ['filterrun', 'filter-dir'],
      ['filterdry', 'dry-filter-dir']
    ]);
    // filter jobs name their filter and candidate scope in the request;
    // the suggested-dirs job carries the current dirty-report dir list
    const FILTER_KINDS = new Set(['filter-dir', 'dry-filter-dir']);
    for (const [id, kind] of KINDS) {
      this.#buttons[id].addEventListener('click', () => {
        const account = this.pickedAccount();
        if (!account) {
          return;
        }
        const dir = kind.endsWith('-dir') ? this.pickedDir() : null;
        if (kind.endsWith('-dir') && !dir) {
          return;
        }
        const detail = {kind, account, dir};
        if (kind === 'sync-dirs') {
          if (!this.#suggested.length) {
            return;
          }
          detail.dirs = this.#suggested.slice();
        }
        if (FILTER_KINDS.has(kind)) {
          const filterId = this.pickedFilterId();
          if (!filterId) {
            return;
          }
          detail.filterId = filterId;
          detail.scope = this.#scope.value || 'unread';
        }
        this.dispatchEvent(new CustomEvent('sync-request', {
          detail,
          bubbles: true,
          composed: true
        }));
      });
    }
    // urgent stop — no account/dir involved
    this.#buttons.kill.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('sync-kill', {
        bubbles: true,
        composed: true
      }));
    });
    this.#account.addEventListener('change', () => {
      this.dispatchEvent(new CustomEvent('sync-account-changed', {
        detail: {account: this.#account.value},
        bubbles: true,
        composed: true
      }));
    });
    this.#dir.addEventListener('change', () => {
      this.dispatchEvent(new CustomEvent('sync-dir-changed', {
        detail: {dir: this.pickedDir()},
        bubbles: true,
        composed: true
      }));
      this.#apply();
    });
    // filter/scope picks are announced so the wiring can remember them
    // (sync-ui.* prefs) — silently, without disturbing the buttons
    const emitFilterPick = () => {
      this.dispatchEvent(new CustomEvent('sync-filter-changed', {
        detail: {filterId: this.pickedFilterId(), scope: this.#scope.value},
        bubbles: true,
        composed: true
      }));
    };
    this.#filter.addEventListener('change', () => {
      this.#apply();
      emitFilterPick();
    });
    this.#scope.addEventListener('change', emitFilterPick);
  }

  pickedDir() {
    const v = this.#dir?.value ?? '';
    return v && v !== '__none__' ? v : null;
  }

  /** the selected filter id (null when nothing usable is picked) */
  pickedFilterId() {
    const v = this.#filter?.value ?? '';
    return v || null;
  }

  /** the selected account id ('' when nothing is picked) */
  pickedAccount() {
    return this.#lockedId || this.#account?.value || '';
  }

  /**
   * Selects an account by id in the picker (standalone mode) — ignored
   * when the id is not among the options; the locked mode dictates its
   * own value (setLockedAccount), so this never fights it.
   */
  pickAccount(id) {
    if (!this.#lockedId && this.#account &&
        [...this.#account.options].some(opt => opt.value === id)) {
      this.#account.value = id;
      this.#apply();
    }
  }

  /**
   * client-dictated mode: name the account that owns the panel — the
   * Account pickers hide entirely (the sync target is announced to the
   * log pane instead); '' unlocks the selectors again (standalone use)
   */
  setLockedAccount(id = '') {
    this.#lockedId = id || '';
    this.#applyAccount();
    this.#apply();
  }

  #applyAccount() {
    const locked = !!this.#lockedId;
    this.#accountLabel.hidden = locked;
    this.#account.hidden = locked;
    if (locked) {
      this.#account.value = this.#lockedId;
    }
  }

  /**
   * A wiring-side remark in the log pane (sync target announce, local
   * hints, filter-run output) — engine-log shaped. Default renders as a
   * bordered system line; a custom type (e.g. 'filter') and cls
   * ('' plain, 'hint', 'warn') style the run output.
   */
  localNote(line, cls = 'system', type = 'system') {
    this.#lines.push({
      ts: Date.now(),
      type,
      content: line,
      cls
    });
    this.#flush();
  }

  // ---- setters (wiring in sync-panel.mjs) ----------------------------------

  /** accounts: [{id, label}] from the stored IMAP configs */
  setAccounts(accounts) {
    this.#account.replaceChildren();
    if (!accounts.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No accounts configured';
      opt.disabled = true;
      opt.selected = true;
      this.#account.appendChild(opt);
    }
    for (const account of accounts) {
      const opt = document.createElement('option');
      opt.value = account.id;
      opt.textContent = account.label;
      this.#account.appendChild(opt);
    }
    this.#applyAccount();
    this.#apply();
  }

  /**
   * names: local Maildir folder names of the picked account; preferred:
   * the dir to re-select once the list is in (when still present) — the
   * wiring passes the account's remembered pick here
   */
  setDirs(names, preferred = null) {
    this.#dir.replaceChildren();
    const none = document.createElement('option');
    none.value = '__none__';
    none.textContent = '— dir —';
    this.#dir.appendChild(none);
    for (const name of names) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      this.#dir.appendChild(opt);
    }
    if (preferred && names.includes(preferred)) {
      this.#dir.value = preferred;
    }
    this.#dir.disabled = !names.length;
    this.#apply();
  }

  /**
   * filters: [{id, label}] the wiring offers for the picked account;
   * preferred: the id to re-select once the list is in (the remembered
   * pick) — the first filter stands in when there is no preference.
   * With more than one filter an extra "all filters" entry runs the
   * whole set in one go (the wiring resolves '__all__'). An empty list
   * disables the row's select (placeholder option).
   */
  setFilters(filters, preferred = null) {
    this.#filters = Array.isArray(filters) ? filters : [];
    this.#filter.replaceChildren();
    const none = document.createElement('option');
    none.value = '';
    none.textContent = this.#filters.length ? '— filter —' : 'No filters configured';
    none.disabled = true;
    none.selected = true;
    this.#filter.appendChild(none);
    for (const filter of this.#filters) {
      const opt = document.createElement('option');
      opt.value = filter.id;
      opt.textContent = filter.label;
      this.#filter.appendChild(opt);
    }
    if (this.#filters.length > 1) {
      const all = document.createElement('option');
      all.value = ALL_FILTERS;
      all.textContent = 'Use all filters';
      this.#filter.appendChild(all);
    }
    const pick = preferred && (this.#filters.some(f => f.id === preferred) ||
        (preferred === ALL_FILTERS && this.#filters.length > 1))
      ? preferred
      : this.#filters[0]?.id ?? '';
    if (pick) {
      this.#filter.value = pick;
    }
    this.#filter.disabled = !this.#filters.length;
    this.#apply();
  }

  /** candidate scope of the filter row ('unread'|'10m'|'30m'|'1h'|'5h') */
  setScope(value) {
    if (['unread', '10m', '30m', '1h', '5h'].includes(value)) {
      this.#scope.value = value;
    }
  }

  /**
   * The dirty report for the picked account: dir names needing a resync,
   * offered as the suggested-dirs line. An empty list clears the line to
   * its "nothing needs resync" text and keeps the Sync suggested dirs
   * button disabled (the wiring re-queries after every change it knows of).
   */
  setSuggested(dirs) {
    this.#suggested = (Array.isArray(dirs) ? dirs : [])
      .filter(d => typeof d === 'string' && d)
      .sort((a, b) => a.localeCompare(b));
    this.#dirtyline.textContent = this.#suggested.length
      ? 'needs resync (' + this.#suggested.length + '): ' +
        this.#suggested.join(', ')
      : 'nothing needs resync';
    this.#dirtyline.title = this.#suggested.join('\n');
    this.#apply();
  }

  /** granted:false shows the re-grant hint row */
  setGranted(granted) {
    this.#regrant.hidden = !!granted;
  }

  /**
   * Seeds the dialog's selects from the wiring (the stored sync-ui.*
   * preferences); a plain preferences state is remembered locally so the
   * dialog re-opens with the current values even before the setter ran.
   */
  setPrefs(prefs = {}) {
    this.#prefs = {
      purge: ['yes', 'no'].includes(prefs.purge) ? prefs.purge : 'ask',
      drop: ['yes', 'no'].includes(prefs.drop) ? prefs.drop : 'ask',
      discard: ['yes', 'no'].includes(prefs.discard) ? prefs.discard : 'ask'
    };
  }

  /** short note next to the controls ("syncing · INBOX", "…busy") */
  setStatus(label = null) {
    this.#status.hidden = !label;
    this.#status.textContent = label || '';
  }

  replaceLogs(lines) {
    this.#lines = Array.isArray(lines) ? lines : [];
    this.#last = null;
    this.#trimLines();
    for (const line of this.#lines) {
      this.#bump(line);
    }
    this.#out.clearLogs();
    this.#flush();
  }

  /**
   * (gen, seq) knowledge update: returns whether the line is new to this
   * view. Same generation → strict seq increase only; a new generation (a
   * fresh engine document) restarts the stream from that line on.
   */
  #bump(line) {
    if (typeof line?.gen !== 'number' || typeof line?.seq !== 'number') {
      return true;   // untagged local lines: no dedupe possible or needed
    }
    const cur = this.#last;
    if (cur && line.gen === cur.gen && line.seq <= cur.seq) {
      return false;
    }
    this.#last = {gen: line.gen, seq: line.seq};
    return true;
  }

  appendLogs(lines) {
    for (const line of Array.isArray(lines) ? lines : []) {
      if (this.#bump(line)) {
        this.#lines.push(line);
      }
    }
    this.#flush();
  }

  #flush() {
    this.#trimLines();
    this.#out.appendLogs(this.#lines.slice(this.#rendered));
    this.#rendered = this.#lines.length;
  }

  #trimLines() {
    const excess = this.#lines.length - 500;
    if (excess > 0) {
      this.#lines.splice(0, excess);
      this.#rendered = Math.max(0, this.#rendered - excess);
    }
  }

  /**
   * Pins/unpins request buttons per this view's own submitted jobs. A pin
   * means "the engine still has this rid pending": the button is disabled
   * regardless of busy state, while everything else stays submittable —
   * several job kinds and other views never lock each other.
   */
  setPendingButtons(ids = []) {
    this.#pending = new Set(ids);
    this.#apply();
  }

  clearLogs() {
    this.#lines = [];
    this.#rendered = 0;
    this.#out.clearLogs();
  }

  /** busy = the engine reports a run going (locks the panel while open) */
  setBusy(busy, label = null) {
    this.#busy = !!busy;
    if (label) {
      this.setStatus(label);
    }
    this.#apply();
  }

  // ---- internal ------------------------------------------------------------

  #apply() {
    // pickedAccount(): locked mode (dictated account by slug, select value
    // stays empty) must still see an account. Account/dir availability —
    // NOT busy state — decides base usability: jobs queue, so a run going
    // never locks the request buttons (only this view's own pending locks)
    const hasAccount = !!this.pickedAccount();
    const hasDir = !!this.pickedDir();
    const hasFilter = !!this.pickedFilterId();
    const dirBtns = new Set(['syncdir', 'drydir']);
    const filterBtns = new Set(['filterrun', 'filterdry']);
    for (const [id, btn] of Object.entries(this.#buttons)) {
      if (id === 'kill') {
        continue;
      }
      const base = dirBtns.has(id)
        ? !hasAccount || !hasDir
        : filterBtns.has(id)
          ? !hasAccount || !hasDir || !hasFilter
          : id === 'syncdirs'
            ? !hasAccount || !this.#suggested.length
            : !hasAccount;
      btn.disabled = this.#pending.has(id) || base;
    }
    // the Stop button lives with the run: only meaningful while busy
    this.#buttons.kill.hidden = !this.#busy;
    this.#buttons.kill.disabled = !this.#busy;
  }
}

customElements.define('sync-view', SyncView);
