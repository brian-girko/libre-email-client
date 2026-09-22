function buildTree(list) {
  const roots = [];
  const byName = new Map();
  const ensure = (name, delimiter, attrs, real) => {
    let node = byName.get(name);
    if (!node) {
      node = {
        name,
        delimiter: delimiter || null,
        attrs: real ? attrs : [],
        real: !!real,
        children: [],
        parent: null
      };
      byName.set(name, node);
      let parentName = null;
      if (node.delimiter) {
        let base = name;
        while (base.endsWith(node.delimiter)) {
          base = base.slice(0, -node.delimiter.length);
        }
        const idx = base.lastIndexOf(node.delimiter);
        if (idx > 0) {
          parentName = base.slice(0, idx);
        }
      }
      if (parentName != null) {
        const parent = ensure(parentName, node.delimiter, [], false);
        parent.children.push(node);
        node.parent = parent;
      }
      else {
        roots.push(node);
      }
    }
    else if (real) {
      node.real = true;
      node.attrs = attrs;
    }
    return node;
  };
  for (const dir of list) {
    if (dir && typeof dir.name === 'string' && dir.name) {
      ensure(dir.name, dir.delimiter, Array.isArray(dir.attrs) ? dir.attrs : [], true);
    }
  }
  const label = node => {
    const d = node.delimiter;
    if (d) {
      const idx = node.name.lastIndexOf(d);
      if (idx > -1 && idx + d.length < node.name.length) {
        return node.name.slice(idx + d.length) || node.name;
      }
    }
    return node.name;
  };
  const noselect = node => node.attrs.some(a => /^(\\Noselect|\\NonExistent)$/i.test(String(a)));
  const sort = nodes => {
    nodes.sort((a, b) => {
      const ai = a.name.toUpperCase() === 'INBOX' ? 0 : 1;
      const bi = b.name.toUpperCase() === 'INBOX' ? 0 : 1;
      return ai - bi || label(a).localeCompare(label(b), undefined, {sensitivity: 'base'});
    });
    for (const node of nodes) {
      sort(node.children);
    }
  };
  sort(roots);
  for (const node of byName.values()) {
    node.label = label(node);
    node.selectable = node.real && !noselect(node);
  }
  return {roots, byName};
}

class DirectoryView extends HTMLElement {
  #list = [];
  #roots = [];
  #byName = new Map();
  #expanded = new Set();
  #selected = null;
  #counts = new Map();
  #mode = 'loading';
  #message = '';
  #status;
  #statusText;
  #retryButton;
  #setupButton;
  #optionsButton;
  #tree;
  #actions;
  #addButton;
  #subButton;
  #deleteButton;
  #confirmDialog;
  #confirmMessage;
  #pendingDelete = null;
  #dirSelect;
  #optionsKey = '';
  #compactMQ = matchMedia('(max-width: 699.98px)');

  constructor() {
    super();
    this.tabIndex = -1;
    const root = this.attachShadow({mode: 'open'});
    root.innerHTML = `
      <style>
        :host {
          display: flex;
          flex-direction: column;
          min-width: 0;
          overflow: hidden;
          background: var(--pane-bg, #ffffff);
          border: 1px solid var(--line, #d9dce1);
          border-radius: var(--radius, 10px);
          color: var(--fg, #1b1d21);
          font: calc(13px * var(--font-scale, 1))/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        }
        :host([hidden]) {
          display: none;
        }
        :host(:focus) {
          outline: 2px solid color-mix(in srgb, var(--accent, AccentColor) 55%, transparent);
          outline-offset: -2px;
        }
        [hidden] {
          display: none !important;
        }
        * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }
        .status {
          flex: 1 0 auto;
          min-height: calc(120px * var(--font-scale, 1));
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: calc(12px * var(--font-scale, 1));
          padding: calc(24px * var(--font-scale, 1)) calc(16px * var(--font-scale, 1));
          text-align: center;
          color: var(--dim, #8a8f98);
          font-size: calc(14px * var(--font-scale, 1));
          letter-spacing: 0.02em;
          user-select: none;
        }
        .status p {
          overflow-wrap: anywhere;
        }
        .status.error p {
          color: light-dark(#b3261e, #f2b8b5);
        }
        .retry,
        .setup,
        .options {
          min-height: calc(30px * var(--font-scale, 1));
          padding: calc(4px * var(--font-scale, 1)) calc(14px * var(--font-scale, 1));
          font: inherit;
          font-size: calc(13px * var(--font-scale, 1));
          color: var(--fg, #1b1d21);
          background: var(--pane-bg, #ffffff);
          border: 1px solid var(--line, #d9dce1);
          border-radius: var(--radius, 10px);
          cursor: pointer;
        }
        .retry:hover,
        .setup:hover,
        .options:hover {
          border-color: var(--dim, #8a8f98);
        }
        .status-actions {
          display: flex;
          gap: calc(8px * var(--font-scale, 1));
          flex-wrap: wrap;
          justify-content: center;
        }
        .tree {
          flex: 1;
          min-height: 0;
          overflow: auto;
          padding: calc(6px * var(--font-scale, 1)) calc(4px * var(--font-scale, 1));
          user-select: none;
        }
        .row {
          display: flex;
          align-items: center;
          gap: calc(2px * var(--font-scale, 1));
          min-height: calc(26px * var(--font-scale, 1));
          padding-right: calc(8px * var(--font-scale, 1));
          border-radius: var(--radius, 10px);
          cursor: default;
          white-space: nowrap;
        }
        .row:focus {
          outline: none;
        }
        .row:focus-visible {
          outline: 1px solid var(--dim, #8a8f98);
          outline-offset: -1px;
        }
        .row:hover {
          background: color-mix(in srgb, var(--fg, #1b1d21) 8%, var(--pane-bg, #ffffff));
        }
        .row.selected {
          background: color-mix(in srgb, var(--accent, AccentColor) 16%, transparent);
          color: var(--accent, AccentColor);
          font-weight: 600;
        }
        .row.disabled {
          color: var(--dim, #8a8f98);
        }
        .twist {
          flex: none;
          width: calc(20px * var(--font-scale, 1));
          height: calc(20px * var(--font-scale, 1));
          display: inline-flex;
          align-items: center;
          justify-content: center;
          visibility: hidden;
        }
        .twist::before {
          content: "";
          border-style: solid;
          border-width: 4px 0 4px 6px;
          border-color: transparent transparent transparent currentColor;
          transition: transform 0.12s;
        }
        .row.parent .twist {
          visibility: visible;
          cursor: pointer;
        }
        .row.parent[data-expanded] .twist::before {
          transform: rotate(90deg);
        }
        .label {
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .counts {
          flex: none;
          margin-left: auto;
          color: var(--dim, #8a8f98);
          font-size: calc(11px * var(--font-scale, 1));
          font-variant-numeric: tabular-nums;
          letter-spacing: 0.02em;
        }
        .actions {
          flex: none;
          display: flex;
          gap: calc(6px * var(--font-scale, 1));
          padding: calc(6px * var(--font-scale, 1)) calc(4px * var(--font-scale, 1));
          background: var(--pane-bg, #ffffff);
          border-top: 1px solid var(--line, #d9dce1);
          user-select: none;
        }
        .dir-btn {
          min-height: calc(26px * var(--font-scale, 1));
          padding: calc(2px * var(--font-scale, 1)) calc(12px * var(--font-scale, 1));
          font: inherit;
          font-size: calc(12px * var(--font-scale, 1));
          color: var(--fg, #1b1d21);
          background: var(--pane-bg, #ffffff);
          border: 1px solid var(--line, #d9dce1);
          border-radius: var(--radius, 10px);
          cursor: pointer;
        }
        .dir-btn:hover:enabled {
          border-color: var(--dim, #8a8f98);
        }
        .dir-btn:disabled {
          opacity: 0.45;
          cursor: default;
        }
        .dir-select {
          display: none;
        }
        .confirm-dialog {
          width: min(90vw, 380px);
          padding: calc(18px * var(--font-scale, 1));
          color: var(--fg, #1b1d21);
          background: var(--pane-bg, #ffffff);
          border: 1px solid var(--line, #d9dce1);
          border-radius: var(--radius, 10px);
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
          margin: auto;
        }
        .confirm-dialog::backdrop {
          background: rgba(0, 0, 0, 0.4);
        }
        .confirm-dialog form {
          display: flex;
          flex-direction: column;
          gap: calc(12px * var(--font-scale, 1));
          margin: 0;
        }
        .confirm-dialog .message {
          margin: 0;
          font-size: calc(14px * var(--font-scale, 1));
          overflow-wrap: anywhere;
        }
        .confirm-dialog .row {
          display: flex;
          justify-content: flex-end;
          gap: calc(8px * var(--font-scale, 1));
        }
        .confirm-dialog button {
          min-height: calc(30px * var(--font-scale, 1));
          padding: calc(4px * var(--font-scale, 1)) calc(14px * var(--font-scale, 1));
          font: inherit;
          font-size: calc(13px * var(--font-scale, 1));
          color: var(--fg, #1b1d21);
          background: var(--pane-bg, #ffffff);
          border: 1px solid var(--line, #d9dce1);
          border-radius: var(--radius, 10px);
          cursor: pointer;
        }
        .confirm-dialog button:hover {
          border-color: var(--dim, #8a8f98);
        }
        .confirm-dialog .cancel {
          color: var(--dim, #7d828a);
        }
        .confirm-dialog .danger {
          color: light-dark(#b3261e, #f2b8b5);
          border-color: light-dark(#b3261e, #f2b8b5);
        }
        @media (max-width: 699.98px) {
          :host {
            flex-direction: row;
            align-items: center;
          }
          .tree {
            display: none;
          }
          .dir-select {
            display: block;
            flex: 1 1 auto;
            min-width: 0;
            min-height: calc(26px * var(--font-scale, 1));
            margin: calc(6px * var(--font-scale, 1)) calc(8px * var(--font-scale, 1)) calc(6px * var(--font-scale, 1)) calc(2px * var(--font-scale, 1));
            padding: calc(2px * var(--font-scale, 1)) calc(4px * var(--font-scale, 1));
            font: inherit;
            font-size: calc(12px * var(--font-scale, 1));
            color: var(--fg, #1b1d21);
            background: var(--pane-bg, #ffffff);
            border: 1px solid var(--line, #d9dce1);
            border-radius: var(--radius, 10px);
          }
          .actions {
            border-top: none;
            padding-right: 0;
          }
          .status {
            flex: 1 1 auto;
            flex-direction: row;
            align-items: center;
            justify-content: flex-start;
            gap: calc(8px * var(--font-scale, 1));
            min-height: calc(26px * var(--font-scale, 1));
            padding: calc(6px * var(--font-scale, 1)) calc(10px * var(--font-scale, 1));
            text-align: left;
          }
          .status p {
            flex: 1;
            text-align: left;
          }
        }
      </style>
      <div class="status" title="Folders — Alt+1 focus · ↑/↓ select · →/← expand/collapse · Enter open" hidden>
        <p></p>
        <div class="status-actions">
          <button class="retry" type="button" hidden>Retry</button>
          <button class="setup" type="button" hidden>Run Setup</button>
          <button class="options" type="button" hidden>Open Options</button>
        </div>
      </div>
      <div class="tree" role="tree" title="Folders — Alt+1 focus · ↑/↓ select · →/← expand/collapse · Enter open" hidden></div>
      <div class="actions" hidden>
        <combo-view label="Add">
          <button class="add-sub" type="button" title="New subfolder of the selected folder" disabled>Sub</button>
          <button class="add" type="button" title="New top-level folder">Dir</button>
        </combo-view>
        <button class="dir-btn delete" type="button" title="Delete the selected folder" disabled>Delete</button>
      </div>
      <select class="dir-select" aria-label="Folders" hidden></select>
      <dialog class="confirm-dialog">
        <form>
          <p class="message"></p>
          <div class="row">
            <button type="button" class="cancel">Cancel</button>
            <button type="submit" class="danger">Delete</button>
          </div>
        </form>
      </dialog>`;
    this.#status = root.querySelector('.status');
    this.#statusText = root.querySelector('.status p');
    this.#retryButton = root.querySelector('.retry');
    this.#setupButton = root.querySelector('.setup');
    this.#optionsButton = root.querySelector('.options');
    this.#tree = root.querySelector('.tree');
    this.#actions = root.querySelector('.actions');
    this.#addButton = root.querySelector('combo-view .add');
    this.#subButton = root.querySelector('combo-view .add-sub');
    this.#deleteButton = root.querySelector('.dir-btn.delete');
    this.#dirSelect = root.querySelector('.dir-select');
    this.#confirmDialog = root.querySelector('.confirm-dialog');
    this.#confirmMessage = root.querySelector('.confirm-dialog .message');
    this.#retryButton.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('retry', {bubbles: true, composed: true}));
    });
    this.#setupButton.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('open-setup', {bubbles: true, composed: true}));
    });
    this.#optionsButton.addEventListener('click', () => {
      // 'sync' mode borrows the options button slot: the offer is "run a
      // sync", not "go configure the account"
      this.dispatchEvent(new CustomEvent(
        this.#mode === 'sync' ? 'open-sync' : 'open-options',
        {bubbles: true, composed: true}
      ));
    });
    this.#addButton.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('create-dir', {
        detail: {parent: null, delimiter: null},
        bubbles: true,
        composed: true
      }));
    });
    this.#subButton.addEventListener('click', () => {
      const node = this.#selected ? this.#byName.get(this.#selected) : null;
      if (!node) {
        return;
      }
      this.dispatchEvent(new CustomEvent('create-dir', {
        detail: {parent: node.name, delimiter: node.delimiter ?? null},
        bubbles: true,
        composed: true
      }));
    });
    this.#deleteButton.addEventListener('click', () => {
      const node = this.#selected ? this.#byName.get(this.#selected) : null;
      if (!this.#deletable(node)) {
        return;
      }
      this.#pendingDelete = node.name;
      this.#confirmMessage.textContent = `Delete folder "${node.label}" and its messages?`;
      this.#confirmDialog.showModal();
    });
    this.#dirSelect.addEventListener('change', () => {
      const node = this.#byName.get(this.#dirSelect.value);
      if (node?.selectable) {
        this.#activate(node);
      }
    });
    this.#confirmDialog.querySelector('.cancel').addEventListener('click', () => {
      this.#pendingDelete = null;
      this.#confirmDialog.close();
    });
    this.#confirmDialog.addEventListener('close', () => {
      this.#pendingDelete = null;
    });
    this.#confirmDialog.addEventListener('submit', e => {
      e.preventDefault();
      const name = this.#pendingDelete;
      this.#pendingDelete = null;
      this.#confirmDialog.close();
      if (!name) {
        return;
      }
      this.dispatchEvent(new CustomEvent('delete-dir', {
        detail: {name},
        bubbles: true,
        composed: true
      }));
    });
    this.addEventListener('keydown', e => {
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.defaultPrevented) {
        // compact select mode: the tree rows are hidden, nothing to walk
        if (this.#compactMQ.matches || this.#mode !== 'ready' || !this.#tree.children.length) {
          return;
        }
        e.preventDefault();
        const anchor = this.shadowRoot.activeElement?.closest('.row');
        const idx = anchor ? [...this.#tree.children].indexOf(anchor) : -1;
        const start = idx === -1 ? (e.key === 'ArrowDown' ? -1 : this.#tree.children.length) : idx;
        const next = this.#visibleRows()[start + (e.key === 'ArrowDown' ? 1 : -1)];
        if (!next) {
          return;
        }
        if (next.node.selectable) {
          this.#activate(next.node);
        }
        const target = [...this.#tree.children].find(el => el.dataset.name === next.node.name);
        if (target) {
          target.focus();
        }
      }
    });
  }

  set dirs(list) {
    this.#list = Array.isArray(list) ? list : [];
    this.#build();
    this.#mode = 'ready';
    this.#message = '';
    this.#render();
  }

  get dirs() {
    return this.#list;
  }

  get selected() {
    return this.#selected;
  }

  // One folder's unread/total arrived: store it and refresh the shown column
  // in place when the tree is on screen; unknown folders (created after the
  // sweep started) only land in the map and appear on the next render.
  addCount(name, counts) {
    if (!name || !(Number(counts?.unread) >= 0 && Number(counts?.total) >= 0)) {
      return;
    }
    this.#counts.set(name, {unread: Number(counts.unread), total: Number(counts.total)});
    if (this.#mode !== 'ready') {
      return;
    }
    const countsEl = this.#tree.querySelector(`.row[data-name="${CSS.escape(name)}"] .counts`);
    if (countsEl) {
      countsEl.textContent = `${counts.unread}/${counts.total}`;
    }
  }

  loading(message = 'Loading directories...') {
    this.#mode = 'loading';
    this.#message = String(message);
    this.#render();
  }

  error(message) {
    this.#mode = 'error';
    this.#message = String(message ?? 'Something went wrong');
    this.#render();
  }

  // Error screen with a "Run Setup" offer: shown when the folder load failed
  // because there is no usable bridge (no remote ws server configured and no
  // native client) — exactly the condition the setup popup fixes.
  setupNeeded(message) {
    this.#mode = 'setup';
    this.#message = String(message ?? 'Setup is not finished');
    this.#render();
  }

  // Error screen with an "Open Options" offer instead of Retry: shown when
  // the account itself is gone or unusable ("Account not found"). Retrying
  // can never fix that — the user needs to add or fix the account.
  optionsNeeded(message) {
    this.#mode = 'options';
    this.#message = String(message ?? 'This account is not configured');
    this.#render();
  }

  // Error screen with a "Run Sync" offer: shown when the account is fine but
  // empty because nothing was switched against the server yet. The sync
  // client builds the {tmp,new,cur} tree; retrying the folder read cannot.
  syncNeeded(message) {
    this.#mode = 'sync';
    this.#message = String(message ?? 'No folders yet');
    this.#render();
  }

  select(name) {
    const node = this.#byName.get(name);
    if (!node) {
      return false;
    }
    for (let p = node.parent; p; p = p.parent) {
      this.#expanded.add(p.name);
    }
    this.#selected = name;
    this.#render();
    return true;
  }

  #build() {
    const {roots, byName} = buildTree(this.#list);
    this.#expanded = new Set([...this.#expanded].filter(name => byName.has(name)));
    for (const node of roots) {
      if (node.children.length) {
        this.#expanded.add(node.name);
      }
    }
    if (this.#selected && !byName.has(this.#selected)) {
      this.#selected = null;
    }
    this.#roots = roots;
    this.#byName = byName;
  }

  #visibleRows() {
    const rows = [];
    const walk = (nodes, depth) => {
      for (const node of nodes) {
        rows.push({node, depth});
        if (node.children.length && this.#expanded.has(node.name)) {
          walk(node.children, depth + 1);
        }
      }
    };
    walk(this.#roots, 0);
    return rows;
  }

  // Flat walk of every node regardless of expansion, in the tree's sort
  // order (INBOX first, then A→Z per level).
  #allRows() {
    const rows = [];
    const walk = (nodes, depth) => {
      for (const node of nodes) {
        rows.push({node, depth});
        walk(node.children, depth + 1);
      }
    };
    walk(this.#roots, 0);
    return rows;
  }

  // Compact single-line mode: the select mirrors the tree's selectable nodes
  // (non-selectable \Noselect parents are skipped) and shows each folder's
  // full path with the delimiter as "/" (raw names use the server delimiter,
  // usually "."). Options are rebuilt only when
  // the folder set changes so an open dropdown survives unrelated re-renders;
  // the value follows #selected on every render.
  #syncSelect() {
    const rows = this.#allRows().filter(({node}) => node.selectable);
    const key = rows.map(({node}) => node.name).join('\n');
    if (key !== this.#optionsKey) {
      this.#optionsKey = key;
      const els = rows.map(({node}) => {
        const opt = document.createElement('option');
        opt.value = node.name;
        opt.textContent = node.delimiter
          ? node.name.split(node.delimiter).join('/')
          : node.name;
        return opt;
      });
      this.#dirSelect.replaceChildren(...els);
    }
    this.#dirSelect.value = this.#selected ?? '';
  }

  #activate(node) {
    this.#selected = node.name;
    this.#render();
    this.dispatchEvent(new CustomEvent('select', {
      detail: {name: node.name},
      bubbles: true,
      composed: true
    }));
  }

  #toggle(node) {
    if (this.#expanded.has(node.name)) {
      this.#expanded.delete(node.name);
    }
    else {
      this.#expanded.add(node.name);
    }
    this.#render();
  }

  #deletable(node) {
    return !!node && node.selectable
      && node.name.toUpperCase() !== 'INBOX'
      && !node.children.length;
  }

  #updateActions() {
    const node = this.#selected ? this.#byName.get(this.#selected) : null;
    const noInferiors = !!node && node.attrs.some(a => /\\Noinferiors/i.test(String(a)));
    const deletable = this.#deletable(node);
    this.#addButton.disabled = false;
    this.#addButton.title = 'New top-level folder';
    this.#subButton.disabled = !node || noInferiors;
    this.#subButton.title = noInferiors
      ? 'This folder cannot contain subfolders'
      : (node ? `New subfolder under "${node.label}"` : 'Select a folder to create a subfolder');
    this.#deleteButton.disabled = !deletable;
    this.#deleteButton.title = deletable
      ? `Delete "${node.label}"`
      : 'Select a folder to delete (INBOX and parent folders are protected)';
  }

  #row(node, depth) {
    const row = document.createElement('div');
    const selected = this.#selected === node.name;
    row.className = 'row'
      + (node.children.length ? ' parent' : '')
      + (selected ? ' selected' : '')
      + (node.selectable ? '' : ' disabled');
    row.dataset.name = node.name;
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', String(depth + 1));
    row.setAttribute('aria-selected', String(selected));
    if (node.children.length) {
      row.setAttribute('aria-expanded', String(this.#expanded.has(node.name)));
      if (this.#expanded.has(node.name)) {
        row.dataset.expanded = '';
      }
    }
    row.style.paddingLeft = (depth * 16 + 4) + 'px';
    row.tabIndex = 0;
    const twist = document.createElement('span');
    twist.className = 'twist';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = node.label;
    const counts = document.createElement('span');
    counts.className = 'counts';
    const c = this.#counts.get(node.name);
    counts.textContent = c ? `${c.unread}/${c.total}` : '-/-';
    counts.hidden = !node.selectable;
    counts.title = 'Unread/total messages';
    row.append(twist, label, counts);
    row.addEventListener('click', e => {
      if (e.target === twist && node.children.length) {
        this.#toggle(node);
        return;
      }
      if (node.selectable) {
        this.#activate(node);
      }
    });
    row.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (node.selectable) {
          this.#activate(node);
        }
      }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const entries = this.#visibleRows();
        const idx = entries.findIndex(entry => entry.node === node);
        const next = entries[idx + (e.key === 'ArrowDown' ? 1 : -1)];
        if (next) {
          if (next.node.selectable) {
            this.#activate(next.node);
          }
          const target = [...this.#tree.children].find(el => el.dataset.name === next.node.name);
          if (target) {
            target.focus();
          }
        }
      }
      else if (e.key === 'ArrowRight' && node.children.length) {
        e.preventDefault();
        this.#expanded.add(node.name);
        this.#render();
      }
      else if (e.key === 'ArrowLeft' && node.children.length && this.#expanded.has(node.name)) {
        e.preventDefault();
        this.#expanded.delete(node.name);
        this.#render();
      }
    });
    return row;
  }

  #render() {
    const ready = this.#mode === 'ready';
    this.#status.hidden = ready;
    this.#tree.hidden = !ready;
    this.#actions.hidden = !ready;
    this.#dirSelect.hidden = !ready;
    if (ready) {
      this.#updateActions();
      this.#syncSelect();
    }
    if (!ready) {
      this.#status.classList.toggle('error', this.#mode === 'error' || this.#mode === 'options' || this.#mode === 'sync');
      this.#retryButton.hidden = this.#mode !== 'error';
      this.#setupButton.hidden = this.#mode !== 'setup';
      this.#optionsButton.hidden = this.#mode !== 'options' && this.#mode !== 'sync';
      this.#optionsButton.textContent = this.#mode === 'sync' ? 'Run Sync' : 'Open Options';
      this.#statusText.textContent = this.#message;
      this.#tree.replaceChildren();
      return;
    }
    const rows = this.#visibleRows();
    if (!rows.length) {
      this.#status.hidden = false;
      this.#status.classList.remove('error');
      this.#retryButton.hidden = true;
      this.#statusText.textContent = 'No directories';
      this.#tree.replaceChildren();
      this.#dirSelect.hidden = true;
      return;
    }
    const activeName = this.shadowRoot.activeElement?.dataset?.name;
    const els = rows.map(({node, depth}) => this.#row(node, depth));
    this.#tree.replaceChildren(...els);
    if (activeName) {
      els.find(el => el.dataset.name === activeName)?.focus();
    }
  }
}

customElements.define('directory-view', DirectoryView);

export {buildTree};
