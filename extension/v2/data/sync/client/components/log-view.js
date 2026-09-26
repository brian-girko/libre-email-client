// log-view.js — a standalone typed log renderer.

class LogView extends HTMLElement {
  #shadow;
  #out;
  #entries = [];
  #timestamps = false;
  #maxLines = 500;
  #followThreshold = 2;
  #stick = true;

  static get observedAttributes() {
    return ['max-lines', 'timestamps', 'follow-threshold'];
  }

  constructor() {
    super();
    this.#shadow = this.attachShadow({mode: 'open'});
    this.#shadow.innerHTML = `
      <style>
        :host {
          display: block;
          min-height: 0;
          overflow: hidden;
          color: var(--fg, #1b1d21);
          background: var(--bg, #f5f6f8);
        }
        :host([hidden]) { display: none; }
        #out {
          box-sizing: border-box;
          height: 100%;
          min-height: 4rem;
          overflow: auto;
          padding: 8px 10px;
          font: calc(11px * var(--font-scale, 1))/1.45 ui-monospace, Menlo,
                Consolas, monospace;
          /* the class keeps its own scroll anchor (#anchorShift); the
             browser's would double-compensate with ours */
          overflow-anchor: none;
        }
        .entry {
          display: grid;
          grid-template-columns: 7rem 7rem minmax(0, 1fr);
          align-items: start;
          min-width: 0;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .timestamp, .type, .content {
          min-width: 0;
        }
        .timestamp, .type {
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .timestamp {
          color: var(--dim, #6f747d);
        }
        .type {
          color: var(--log-type-fg, var(--dim, #6f747d));
          font-weight: 600;
        }
        .content {
          white-space: pre-wrap;
        }
        .warn .content, .warn .type {
          color: light-dark(#8a6d00, #ffd54f);
        }
        .conflict .content, .conflict .type {
          color: light-dark(#b3261e, #ff8a80);
        }
        .hint .content {
          color: var(--dim, #6f747d);
          font-style: italic;
        }
        .system {
          border-block: 1px solid color-mix(in srgb, var(--line, #d9dce1) 60%, transparent);
          color: light-dark(#4d6474, #a9c3d4);
        }
        .system .type {
          color: light-dark(#36566d, #c1d9e8);
        }
      </style>
      <div id="out" role="log" aria-live="polite"></div>
    `;
    this.#out = this.#shadow.getElementById('out');
    // scroll-follow intent: cheap to keep, the flag only ever flips on a
    // scroll event — every write this class performs lands either at the
    // bottom (following) or back at the reader's restored position, so the
    // echoes of our own writes re-derive the same value and cannot cause
    // ping-pong. Hidden panels (clientHeight 0) keep following: their
    // arriving logs must be shown after re-open without user scroll input.
    this.#out.addEventListener('scroll', () => {
      this.#stick = this.#distanceFromBottom() <= this.#followThreshold;
    });
    this.#applyAttributes();
  }

  attributeChangedCallback() {
    this.#applyAttributes();
    this.#trim();
    this.#renderAll();
  }

  get timestamps() {
    return this.#timestamps;
  }

  set timestamps(value) {
    if (value) {
      this.setAttribute('timestamps', '');
    }
    else {
      this.removeAttribute('timestamps');
    }
  }

  get maxLines() {
    return this.#maxLines;
  }

  set maxLines(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 1) {
      throw new TypeError('maxLines must be a positive number');
    }
    this.setAttribute('max-lines', String(Math.floor(n)));
  }

  /** Add one entry: {type: string, content: string | object, ts?: Date|string|number}. */
  append(entry) {
    this.#entries.push(this.#normalize(entry));
    this.#renderNew(1, this.#trim());
  }

  /** Add multiple entries in one render pass. */
  appendLogs(entries) {
    const list = Array.isArray(entries) ? entries : [];
    if (!list.length) {
      return;
    }
    for (const entry of list) {
      this.#entries.push(this.#normalize(entry));
    }
    this.#renderNew(list.length, this.#trim());
  }

  /** Replace the current history with entries. */
  replaceLogs(entries) {
    this.#entries = (Array.isArray(entries) ? entries : [])
      .map(entry => this.#normalize(entry));
    this.#trim();
    this.#renderAll();
  }

  clearLogs() {
    this.#entries = [];
    this.#renderAll();
  }

  #applyAttributes() {
    this.#timestamps = this.hasAttribute('timestamps');
    const n = Number(this.getAttribute('max-lines'));
    if (Number.isFinite(n) && n >= 1) {
      this.#maxLines = Math.floor(n);
    }
    const t = Number(this.getAttribute('follow-threshold'));
    if (Number.isFinite(t) && t > 0) {
      this.#followThreshold = t;
    }
  }

  #normalize(entry) {
    if (typeof entry === 'string') {
      return {type: '', content: entry, ts: Date.now()};
    }
    if (!entry || typeof entry !== 'object') {
      return {type: '', content: String(entry ?? ''), ts: Date.now()};
    }
    return {
      type: entry.type == null ? '' : String(entry.type),
      content: entry.content == null ? '' : entry.content,
      ts: entry.ts == null ? Date.now() : entry.ts,
      cls: entry.cls == null ? '' : String(entry.cls)
    };
  }

  #trim() {
    if (this.#entries.length > this.#maxLines) {
      const excess = this.#entries.length - this.#maxLines;
      this.#entries.splice(0, excess);
      return excess;
    }
    return 0;
  }

  #contentText(content) {
    if (typeof content === 'string') {
      return content;
    }
    try {
      return JSON.stringify(content);
    }
    catch {
      return String(content);
    }
  }

  #timestampText(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleTimeString();
  }

  #typeText(type) {
    return type.startsWith('[') && type.endsWith(']')
      ? type.slice(1, -1)
      : type;
  }

  #row(entry) {
    const row = document.createElement('div');
    const classes = [entry.cls];
    if (entry.type === 'system') {
      classes.push('system');
    }
    row.className = 'entry ' + classes.filter(Boolean).join(' ');

    const timestamp = document.createElement('span');
    timestamp.className = 'timestamp';
    timestamp.textContent = this.#timestamps ? '[' + this.#timestampText(entry.ts) + ']' : '';
    row.appendChild(timestamp);

    const type = document.createElement('span');
    type.className = 'type';
    type.textContent = this.#typeText(entry.type);
    row.appendChild(type);

    const content = document.createElement('div');
    content.className = 'content';
    content.textContent = this.#contentText(entry.content);
    row.appendChild(content);
    return row;
  }

  #distanceFromBottom() {
    return this.#out.scrollHeight - this.#out.scrollTop - this.#out.clientHeight;
  }

  #scrollFollow(follow) {
    if (follow) {
      this.#out.scrollTop = this.#out.scrollHeight;
    }
  }

  #renderNew(added, removed) {
    const out = this.#out;
    // the follow intent is the #stick flag (scroll events maintain it): a
    // per-render distance read here could go stale between a layout clamp
    // and the next scroll event and would silently detach a user who never
    // scrolled — the reported regression. Not-yet-rendered containers
    // (display:none panel, first append) have no scroll positions at all:
    // follow them until a real user scroll says otherwise.
    const following = this.#stick || out.clientHeight === 0;
    // the freshly added tail: the last `added` entries are new rows —
    // also (and especially) at the line cap, where `removed` rows fell
    // off the FRONT while every appended entry still needs its row
    const from = Math.max(0, this.#entries.length - added);
    // capture the anchor BEFORE the DOM grows: the pre-mutation bottom of
    // the last existing row (identified by reference, not index — appending
    // and re-trimming shifts indices around) is what the viewport must keep
    // under it when the trim drags every kept row upward
    const anchorRow = out.lastElementChild;
    const preBottom = anchorRow
      ? anchorRow.offsetTop + anchorRow.offsetHeight
      : 0;
    const frag = document.createDocumentFragment();
    for (let i = from; i < this.#entries.length; i++) {
      frag.appendChild(this.#row(this.#entries[i]));
    }
    out.appendChild(frag);
    // mirror the buffer trim on the DOM: rows leaving the FRONT drag every
    // kept row upward by their combined height — restore the user's
    // pre-mutation viewport anchor right after, so a mid-history read
    // (or any cap-trim beside an append) can no longer wipe the position
    for (let i = 0; i < removed; i++) {
      out.firstElementChild?.remove();
    }
    if (removed > 0) {
      out.scrollTop += this.#anchorShift(anchorRow, preBottom);
    }
    this.#scrollFollow(following);
  }

  /**
   * Pixel shift needed to keep the viewport visually unmoved after a
   * cap-trim: the pre-trim bottom of the anchor row minus its post-trim
   * bottom. Measured directly on the kept row itself, so it is exact
   * regardless of row height, padding, borders or wrapping — it degrades
   * to 0 only when the anchor row itself was trimmed (the whole history
   * fell off in one flush; there is nothing left to stay anchored to).
   */
  #anchorShift(anchorRow, preBottom) {
    if (!anchorRow || anchorRow.parentNode !== this.#out) {
      return 0;
    }
    const postBottom = anchorRow.offsetTop + anchorRow.offsetHeight;
    return preBottom - postBottom;
  }

  #renderAll() {
    // a rebuilt list keeps the four states coherent with the follow intent:
    // following → snap to tail; detached → keep the reader's absolute
    // position (a full rebuild w/o rows in view clamps to the new bottom)
    const following = this.#stick || this.#out.clientHeight === 0;
    const previousTop = this.#out.scrollTop;
    const frag = document.createDocumentFragment();
    for (const entry of this.#entries) {
      frag.appendChild(this.#row(entry));
    }
    this.#out.replaceChildren(frag);
    this.#out.scrollTop = following ? this.#out.scrollHeight :
      Math.min(previousTop, this.#out.scrollHeight - this.#out.clientHeight);
  }
}

customElements.define('log-view', LogView);
