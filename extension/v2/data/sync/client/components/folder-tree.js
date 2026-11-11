// folder-tree.js — <folder-tree>: a checkbox tree of server folders, shared
// by the welcome wizard's step 4 (configure ignores before the first sync)
// and the options page's "Edit ignored folders" editor.
//
// Same semantics as the mail client's folder-pane edit mode (data/client/
// components/directory-view.js, whose buildTree this component reuses):
// one checkbox per selectable folder (INBOX and \Noselect hierarchy parents
// get none), checking a folder ignores its whole subtree, an ignored
// parent's descendants render checked+disabled (uncheck the parent first),
// and ignored folders show line-through.
//
// The component holds only the current selection: callers own storage and
// read the selection back with getIgnored() when they save.

import {buildTree} from '../../../client/components/directory-view.js';

class FolderTree extends HTMLElement {
  #shadow;
  #tree;
  #byName = new Map();
  #roots = [];
  #ignored = new Set();

  constructor() {
    super();
    this.#shadow = this.attachShadow({mode: 'open'});
    this.#shadow.innerHTML = `
      <style>
        :host {
          display: block;
          max-height: 40vh;
          overflow: auto;
          border: 1px solid var(--line, #d9dce1);
          border-radius: var(--radius, 10px);
          background: var(--pane-bg, #ffffff);
          color: var(--fg, #1b1d21);
          font: calc(13px * var(--font-scale, 1))/1.6 system-ui, -apple-system,
                "Segoe UI", Roboto, sans-serif;
          padding: calc(4px * var(--font-scale, 1));
          user-select: none;
        }
        :host([hidden]) { display: none; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        .empty {
          padding: calc(8px * var(--font-scale, 1));
          color: var(--dim, #8a8f98);
          font-size: calc(12px * var(--font-scale, 1));
        }
        .row {
          display: flex;
          align-items: center;
          gap: calc(5px * var(--font-scale, 1));
          min-height: calc(22px * var(--font-scale, 1));
          padding-right: calc(6px * var(--font-scale, 1));
          white-space: nowrap;
        }
        .label {
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .row.ignored .label {
          text-decoration: line-through;
          opacity: 0.55;
        }
        .row.checkable {
          cursor: pointer;
        }
        .row.disabled .label {
          color: var(--dim, #8a8f98);
        }
        .row input[type="checkbox"] {
          flex: none;
          width: calc(14px * var(--font-scale, 1));
          height: calc(14px * var(--font-scale, 1));
          accent-color: var(--accent, AccentColor);
          cursor: pointer;
        }
        .row input[type="checkbox"]:disabled {
          cursor: default;
          opacity: 0.45;
        }
      </style>
      <div class="tree"></div>`;
    this.#tree = this.#shadow.querySelector('.tree');
  }

  /**
   * The server folder list: [{name, delimiter, attrs}] exactly what the
   * facade's folders() answers (the probe normalizes it). Rebuilds the
   * tree; the current selection is kept only for names that still exist.
   */
  setFolders(folders, delimiter = '/') {
    const list = (Array.isArray(folders) ? folders : [])
      .filter(f => f && typeof f.name === 'string' && f.name);
    const built = buildTree(list);
    this.#byName = built.byName;
    this.#roots = built.roots;
    const alive = new Set(this.#byName.keys());
    this.#ignored = new Set([...this.#ignored].filter(name => alive.has(name)));
    this.#render();
  }

  /** seeds the checkboxes from the stored ignore list (server-spelled names) */
  setIgnored(names) {
    this.#ignored = new Set((Array.isArray(names) ? names : [])
      .filter(n => typeof n === 'string' && n));
    this.#render();
  }

  /** the current selection — the caller persists it */
  getIgnored() {
    return [...this.#ignored];
  }

  #selfIgnored(node) {
    return this.#ignored.has(node.name);
  }

  // effective ignore state: self on the list, or an ancestor is — the
  // subtree rule the sync engine applies (isIgnoredFolder in maildir.mjs)
  #effectiveIgnored(node) {
    return this.#ignored.has(node.name) || this.#ancestorIgnored(node);
  }

  #ancestorIgnored(node) {
    for (let p = node.parent; p; p = p.parent) {
      if (this.#ignored.has(p.name)) {
        return true;
      }
    }
    return false;
  }

  #visibleRows() {
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

  #render() {
    const rows = this.#visibleRows();
    this.#tree.replaceChildren();
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No folders';
      this.#tree.appendChild(empty);
      return;
    }
    for (const {node, depth} of rows) {
      this.#tree.appendChild(this.#row(node, depth));
    }
  }

  #row(node, depth) {
    const checkable = node.selectable && node.name.toUpperCase() !== 'INBOX';
    // a checkable row is a <label>: clicking anywhere on it (the folder
    // name included) toggles the checkbox, like the native association
    const row = document.createElement(checkable ? 'label' : 'div');
    const ignored = this.#effectiveIgnored(node);
    const self = this.#selfIgnored(node);
    // an ancestor-ignored row's checkbox is disabled — no clickable
    // affordance there, the label click would be a no-op
    const clickable = checkable && !(ignored && !self);
    row.className = 'row'
      + (clickable ? ' checkable' : '')
      + (node.selectable ? '' : ' disabled')
      + (ignored ? ' ignored' : '');
    row.style.paddingLeft = (depth * 16 + 4) + 'px';
    row.title = node.name;
    if (checkable) {
      const box = document.createElement('input');
      box.type = 'checkbox';
      const ancestor = ignored && !self;
      box.checked = ignored;
      box.disabled = ancestor;
      box.title = ancestor
        ? 'Ignored with the parent folder — uncheck the parent first'
        : self
          ? 'Ignored — not synced (the local copy stays; uncheck to sync again)'
          : 'Sync this folder (check to ignore it, its subfolders ignore with it)';
      box.addEventListener('change', () => {
        if (box.checked) {
          this.#ignored.add(node.name);
        }
        else {
          this.#ignored.delete(node.name);
        }
        this.#render();
      });
      row.appendChild(box);
    }
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = node.label;
    row.appendChild(label);
    return row;
  }
}

customElements.define('folder-tree', FolderTree);
