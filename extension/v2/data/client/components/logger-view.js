// Unified activity logger view for the mail panel. It renders the persistent
// status line plus one line per entry from data/client/logger.mjs. Action
// entries may expose a cancel/dismiss button; worker-owned entries (filters)
// are read-only. This element is a dumb renderer: it forwards its
// button as a 'logger-cancel' / 'logger-dismiss' event and knows nothing else.

class LoggerView extends HTMLElement {
  #shadow;
  #statusEl;
  #container;
  #lines = new Map();
  #status = null;
  #entries = [];

  constructor() {
    super();
    this.#shadow = this.attachShadow({mode: 'open'});
    this.#shadow.innerHTML = `
      <style>
        :host {
          display: block;
          min-width: 0;
          max-height: 30vh;
          overflow-y: auto;
          background: var(--pane-bg, #ffffff);
          border: 1px solid var(--line, #d9dce1);
          border-radius: var(--radius, 10px);
          padding: 0;
          color: var(--fg, #1b1d21);
          font: calc(12px * var(--font-scale, 1))/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        }
        :host([hidden]) {
          display: none;
        }
        [hidden] {
          display: none !important;
        }
        * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }
        .status-line {
          display: flex;
          align-items: center;
          gap: calc(6px * var(--font-scale, 1));
          min-height: calc(22px * var(--font-scale, 1));
          padding: calc(4px * var(--font-scale, 1)) calc(12px * var(--font-scale, 1));
          color: var(--dim, #8a8f98);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .status-line.busy {
          color: var(--accent, AccentColor);
        }
        .status-line.error {
          color: light-dark(#b3261e, #f2b8b5);
        }
        .job-list {
          display: flex;
          flex-direction: column;
          gap: calc(2px * var(--font-scale, 1));
          padding: 0 0 calc(4px * var(--font-scale, 1));
        }
        .job-list:empty {
          display: none;
        }
        .line {
          display: flex;
          align-items: center;
          gap: calc(8px * var(--font-scale, 1));
          min-height: calc(22px * var(--font-scale, 1));
          padding: 0 calc(12px * var(--font-scale, 1));
        }
        .line.failed {
          color: light-dark(#b3261e, #f2b8b5);
        }
        .line.done {
          color: var(--dim, #8a8f98);
        }
        .spin {
          flex: none;
          width: 12px;
          height: 12px;
          border-radius: 50%;
          border: 2px solid var(--dim, #8a8f98);
          border-top-color: transparent;
          animation: jobs-spin 0.8s linear infinite;
        }
        @keyframes jobs-spin {
          to { transform: rotate(360deg); }
        }
        .label {
          flex: 0 1 auto;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .detail {
          flex: 0 1 auto;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-style: italic;
          opacity: 0.75;
        }
        .job-btn {
          flex: none;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 18px;
          height: 18px;
          padding: 0;
          font: inherit;
          font-size: 10px;
          color: var(--dim, #8a8f98);
          background: none;
          border: none;
          border-radius: 50%;
          cursor: pointer;
        }
        .job-btn:hover:enabled {
          color: var(--fg, #1b1d21);
          background: var(--bg, #f5f6f8);
        }
        .job-btn:disabled {
          opacity: 0.4;
          cursor: default;
        }
      </style>
      <div class="status-line" role="status" aria-live="polite" hidden>
        <span class="status-text"></span>
      </div>
      <div class="job-list" role="log" aria-live="polite"></div>
    `;
    this.#statusEl = this.#shadow.querySelector('.status-line');
    this.#container = this.#shadow.querySelector('.job-list');
  }

  connectedCallback() {
    this.#apply();
  }

  // entries: logger.getAll(); status: logger.getStatus()
  setEntries(entries, status) {
    this.#status = status || null;
    this.#entries = Array.isArray(entries) ? entries : [];
    this.#reconcileList(this.#entries);
    this.#apply();
  }

  #reconcileList(entries) {
    const seen = new Set();
    for (const entry of entries) {
      if (entry.quiet) {
        continue;
      }
      seen.add(entry.id);
      let row = this.#lines.get(entry.id);
      if (!row) {
        row = this.#createRow(entry);
        this.#lines.set(entry.id, row);
        this.#container.append(row);
      }
      this.#sync(row, entry);
    }
    for (const [id, row] of this.#lines) {
      if (!seen.has(id)) {
        row.remove();
        this.#lines.delete(id);
      }
    }
  }

  #apply() {
    // The status line shows only the persistent status text; running jobs
    // render as their own single row below (no mirrored duplicate line).
    let text = '';
    let tone = 'info';
    if (this.#status) {
      text = this.#status.text || '';
      tone = this.#status.tone || 'info';
    }
    this.#statusEl.hidden = !text;
    this.#statusEl.querySelector('.status-text').textContent = text;
    this.#statusEl.classList.toggle('busy', tone === 'busy');
    this.#statusEl.classList.toggle('error', tone === 'error');
    this.hidden = !text && this.#lines.size === 0;
  }

  #createRow(entry) {
    const row = document.createElement('div');
    row.className = 'line';
    const spin = document.createElement('span');
    spin.className = 'spin';
    const label = document.createElement('span');
    label.className = 'label';
    const detail = document.createElement('span');
    detail.className = 'detail';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'job-btn';
    btn.textContent = '✕';
    btn.addEventListener('click', () => {
      btn.disabled = true;
      const action = row.classList.contains('failed') ? 'dismiss' : 'cancel';
      this.dispatchEvent(new CustomEvent('logger-' + action, {
        detail: {id: entry.id},
        bubbles: true,
        composed: true
      }));
    });
    row.append(spin, label, detail, btn);
    return row;
  }

  #sync(row, entry) {
    const spin = row.querySelector('.spin');
    const label = row.querySelector('.label');
    const detail = row.querySelector('.detail');
    const btn = row.querySelector('.job-btn');
    const failed = entry.state === 'failed';
    const done = entry.state === 'done';
    row.classList.toggle('failed', failed);
    row.classList.toggle('done', done);
    spin.hidden = failed || done || entry.state === 'cancelled';
    label.textContent = failed
      ? (entry.label || '') + ' — ' + (entry.error || 'failed')
      : done
        ? (entry.doneLabel || entry.label || '')
        : (entry.label || '');
    // the newest engine log line rides along only while the run is live;
    // settled entries never show stale mid-run text
    detail.textContent = spin.hidden ? '' : (entry.detail ? '— ' + entry.detail : '');
    detail.hidden = spin.hidden || !entry.detail;
    btn.hidden = !(entry.cancelable || failed);
    btn.disabled = false;
    btn.title = failed ? 'Dismiss' : 'Cancel';
  }
}

customElements.define('logger-view', LoggerView);
