// compose-view — the compose pane: a Gmail-style floating window for
// writing a new message into the currently selected folder.
//
// The element owns only the EDITING; the page wires the rest:
//   open({from, fromName, folder})  → resets, fills the read-only From,
//                                    shows the pane (focus on To)
//   'compose-save'                 → detail {from, fromName, to, cc, bcc,
//                                    subject, html} — raw editor html; the
//                                    api layer sanitizes and builds RFC822
//
// The pane is NOT a modal: <dialog popover="manual"> keeps it in the top
// layer (always above the page's content) while the page stays fully
// interactive — emails keep previewing and folders keep switching while
// a message is being written. "manual" means no dismissal on outside
// clicks either: a stray click on the mail list must never eat a
// half-written message, so the pane only leaves through its own
// controls — Save, or the discard path. A true modal opened later
// (settings, the master-password prompt) still stacks above the pane,
// exactly like Gmail's own dialogs cover its compose window.
//
// Escape runs the unsent-work guard from a keydown listener on the form
// (popover="manual" dismisses nothing by itself, and a non-modal dialog
// never fires cancel events): the first Esc asks — an inline confirm
// row, its space pre-reserved with visibility so no control moves under
// the pointer, offers Keep editing / Discard — and a second Esc hides.
// While the link row is open, Esc just closes that first.
//
// Rich text: contenteditable + document.execCommand — the same engine
// Gmail's own basic toolbar drove for years, and the only dependency-free
// way to get bold/italic/underline/lists in a pane this size. The output
// is a small tag set (b/i/u, ul/ol/li, a) that compose.mjs's sanitizer
// keeps wholesale, so what the user formats is what the file carries.

'use strict';

class ComposeView extends HTMLElement {
  #dialog;
  #form;
  #folderTag;
  #from;
  #fromName = '';
  #fromInput;
  #to;
  #cc;
  #bcc;
  #ccRow;
  #bccRow;
  #ccToggle;
  #bccToggle;
  #subject;
  #tools;
  #toolButtons = new Map();
  #body;
  #linkRow;
  #linkInput;
  #err;
  #confirmRow;
  #savedRange = null;
  #dirty = false;

  constructor() {
    super();
    const root = this.attachShadow({mode: 'open'});
    root.innerHTML = `
      <style>
        :host {
          display: contents;
        }
        * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }
        /* component classes set display; the hidden attribute must still win */
        [hidden] {
          display: none !important;
        }
        dialog {
          /* Gmail-style floating pane: flush into the bottom-right corner
             of the viewport, framed, square corners. The pane is a
             WINDOW, not a balloon: a fixed frame relative to the
             viewport — the editor body is the one flexible element
             inside it, so long text compresses and scrolls the body
             alone and the actions row never moves. overflow: hidden
             overrides the UA popover's overflow:auto — the box itself
             must never scroll (the UA pins [popover] with inset: 0 —
             inset: auto first, then the anchor sides) */
          position: fixed;
          inset: auto;
          bottom: 0;
          right: 0;
          width: min(560px, 94vw);
          height: min(600px, 85dvh);
          padding: calc(14px * var(--font-scale, 1));
          color: var(--fg, #1b1d21);
          background: var(--pane-bg, #ffffff);
          border: 1px solid var(--line, #d9dce1);
          border-radius: 0;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
          font: inherit;
          font-size: calc(13px * var(--font-scale, 1));
          overflow: hidden;
          /* scroll gestures inside the pane must never chain to the page
             underneath it */
          overscroll-behavior: contain;
        }
        dialog:popover-open {
          /* the form is the pane's one child and fills the fixed frame */
          display: flex;
        }
        form {
          /* the app-shell grid: the fields zone and the bottom zone are
             exactly their content, the editor takes every remaining
             pixel (1fr) — the rows resolve inside the pane's fixed
             frame, so the Save row can never move or clip, whatever
             the body's length does */
          display: grid;
          grid-template-rows: min-content 1fr min-content;
          gap: calc(8px * var(--font-scale, 1));
          flex: 1;
          min-height: 0;
        }
        .foot {
          display: flex;
          flex-direction: column;
          gap: calc(8px * var(--font-scale, 1));
        }
        .head {
          /* the window's title bar: bordered off from the fields below so
             the destination stays visually separate from the editor */
          padding-bottom: calc(8px * var(--font-scale, 1));
          border-bottom: 1px solid var(--line, #d9dce1);
        }
        .title-row {
          display: flex;
          align-items: baseline;
          gap: calc(8px * var(--font-scale, 1));
        }
        .head h2 {
          font-size: calc(15px * var(--font-scale, 1));
          font-weight: 600;
          min-width: 0;
          overflow-wrap: anywhere;
        }
        .head .folder {
          color: var(--dim, #7d828a);
          font-weight: 400;
          overflow-wrap: anywhere;
        }
        .head .close {
          margin-left: auto;
          flex: none;
        }
        .hint {
          margin-top: calc(4px * var(--font-scale, 1));
          color: var(--dim, #7d828a);
          font-size: calc(11px * var(--font-scale, 1));
          line-height: 1.4;
        }
        /* the title bar's separation line keeps its distance from the
           fields below: extra clearance beyond the pane's own gap */
        .head + .row {
          margin-top: calc(6px * var(--font-scale, 1));
        }
        .row {
          display: grid;
          grid-template-columns: calc(48px * var(--font-scale, 1)) 1fr auto;
          align-items: center;
          gap: calc(8px * var(--font-scale, 1));
          min-width: 0;
        }
        /* breathing room the field rows read with: beyond the pane's own
           gap, From/To/Cc/Bcc/Subject get clear separation from each other */
        .row + .row {
          margin-top: calc(5px * var(--font-scale, 1));
        }
        .row label {
          color: var(--dim, #7d828a);
          font-size: calc(12px * var(--font-scale, 1));
          text-align: right;
          white-space: nowrap;
        }
        .row input {
          width: 100%;
          min-width: 0;
          min-height: calc(30px * var(--font-scale, 1));
          padding: calc(4px * var(--font-scale, 1)) calc(8px * var(--font-scale, 1));
          font: inherit;
          font-size: calc(13px * var(--font-scale, 1));
          color: var(--fg, #1b1d21);
          background: var(--bg, #f5f6f8);
          border: 1px solid var(--line, #d9dce1);
          border-radius: var(--radius, 10px);
        }
        .row input:focus {
          outline: none;
          border-color: var(--dim, #8a8f98);
        }
        .row input[readonly] {
          color: var(--dim, #7d828a);
          background: none;
        }
        .rev {
          display: flex;
          gap: calc(4px * var(--font-scale, 1));
        }
        .rev button,
        .head .close,
        .confirm button,
        .linkrow button {
          min-height: calc(26px * var(--font-scale, 1));
          padding: calc(2px * var(--font-scale, 1)) calc(10px * var(--font-scale, 1));
          font: inherit;
          font-size: calc(12px * var(--font-scale, 1));
          color: var(--dim, #7d828a);
          background: none;
          border: 1px solid var(--line, #d9dce1);
          border-radius: var(--radius, 10px);
          cursor: pointer;
        }
        .rev button:hover,
        .head .close:hover,
        .confirm button:hover,
        .linkrow button:hover {
          border-color: var(--dim, #8a8f98);
          color: var(--fg, #1b1d21);
        }
        .tools {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          flex-wrap: wrap;
          gap: calc(4px * var(--font-scale, 1));
          /* keep clear of the editor box above */
          margin-top: calc(6px * var(--font-scale, 1));
        }
        .tools .tool {
          min-height: calc(26px * var(--font-scale, 1));
          min-width: calc(26px * var(--font-scale, 1));
          padding: calc(2px * var(--font-scale, 1)) calc(8px * var(--font-scale, 1));
          font: inherit;
          font-size: calc(12px * var(--font-scale, 1));
          color: var(--fg, #1b1d21);
          background: none;
          border: 1px solid transparent;
          border-radius: var(--radius, 10px);
          cursor: pointer;
        }
        .tools .tool:hover {
          border-color: var(--line, #d9dce1);
        }
        .tools .tool[aria-pressed="true"] {
          background: color-mix(in srgb, var(--fg, #1b1d21) 12%, transparent);
        }
        .tools .tool:focus-visible,
        .rev button:focus-visible,
        .head .close:focus-visible,
        .confirm button:focus-visible,
        .linkrow button:focus-visible,
        .actions button:focus-visible {
          outline: 2px solid var(--fg, #1b1d21);
          outline-offset: 1px;
        }
        .t-bold { font-weight: 700; }
        .t-italic { font-style: italic; }
        .t-under { text-decoration: underline; }
        .body {
          /* the 1fr row of the pane grid: min-height 0 lets the row size
             itself to the frame's leftover space (never to its content),
             overflow keeps the scroll inside the editor alone; the frame
             is the only cap — the body carries no max of its own */
          min-height: 0;
          overflow-y: auto;
          overscroll-behavior: contain;
          margin-top: calc(6px * var(--font-scale, 1));
          padding: calc(8px * var(--font-scale, 1)) calc(10px * var(--font-scale, 1));
          font: inherit;
          line-height: 1.5;
          color: var(--fg, #1b1d21);
          background: var(--bg, #f5f6f8);
          border: 1px solid var(--line, #d9dce1);
          border-radius: var(--radius, 10px);
          overflow-wrap: anywhere;
        }
        .body:focus {
          outline: none;
          border-color: var(--dim, #8a8f98);
        }
        .body.empty::before {
          content: attr(data-placeholder);
          color: var(--dim, #7d828a);
        }
        .body a {
          color: inherit;
          text-decoration: underline;
        }
        .err {
          min-height: calc(18px * var(--font-scale, 1));
          font-size: calc(12px * var(--font-scale, 1));
          color: color-mix(in srgb, #e5484d 75%, var(--fg, #1b1d21));
          visibility: hidden;
        }
        .err.show {
          visibility: visible;
        }
        .linkrow {
          display: flex;
          align-items: center;
          gap: calc(6px * var(--font-scale, 1));
        }
        .linkrow input {
          flex: 1;
          min-width: 0;
          min-height: calc(28px * var(--font-scale, 1));
          padding: calc(4px * var(--font-scale, 1)) calc(8px * var(--font-scale, 1));
          font: inherit;
          font-size: calc(12px * var(--font-scale, 1));
          color: var(--fg, #1b1d21);
          background: var(--bg, #f5f6f8);
          border: 1px solid var(--line, #d9dce1);
          border-radius: var(--radius, 10px);
        }
        .linkrow input:focus {
          outline: none;
          border-color: var(--dim, #8a8f98);
        }
        /* screen-reader-only text (the link row's label and hint) */
        .sr:where(:not(:focus-within, :active)) {
          position: absolute !important;
          clip-path: inset(50%) !important;
          overflow: hidden !important;
          width: 1px !important;
          height: 1px !important;
          margin: -1px !important;
          padding: 0 !important;
          border: 0 !important;
          white-space: nowrap !important;
        }
        .confirm {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: calc(6px * var(--font-scale, 1));
          min-height: calc(32px * var(--font-scale, 1));
          padding: calc(4px * var(--font-scale, 1)) calc(8px * var(--font-scale, 1));
          border: 1px solid color-mix(in srgb, #e5484d 35%, var(--line, #d9dce1));
          border-radius: var(--radius, 10px);
          background: color-mix(in srgb, #e5484d 8%, var(--pane-bg, #ffffff));
          font-size: calc(12px * var(--font-scale, 1));
          visibility: hidden;
        }
        .confirm.show {
          visibility: visible;
        }
        .confirm .msg {
          margin-right: auto;
          color: var(--fg, #1b1d21);
        }
        .actions {
          display: flex;
          justify-content: flex-end;
          gap: calc(8px * var(--font-scale, 1));
        }
        .actions button {
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
        .actions button:hover {
          border-color: var(--dim, #8a8f98);
        }
        .actions .save {
          font-weight: 600;
        }
      </style>
      <dialog popover="manual" aria-labelledby="compose-title">
        <form novalidate>
          <div class="top">
            <div class="head">
              <div class="title-row">
                <h2 id="compose-title">New message</h2>
                <span class="folder" id="compose-folder"></span>
                <button type="button" class="close" title="Close"
                        aria-label="Close">✕</button>
              </div>
              <p class="hint" id="c-hint">This client does not send mail — Save
                writes the message into the folder shown above as a local note;
                the next sync uploads it to the server copy of that folder.</p>
            </div>
            <div class="row">
              <label for="c-from">From</label>
              <input id="c-from" type="text" readonly tabindex="-1">
            </div>
            <div class="row">
              <label for="c-to">To</label>
              <input id="c-to" type="text" autofocus autocomplete="email"
                     aria-describedby="c-err" spellcheck="false">
              <span class="rev">
                <button type="button" id="c-cc-toggle" aria-expanded="false"
                        aria-controls="c-cc-row">Cc</button>
                <button type="button" id="c-bcc-toggle" aria-expanded="false"
                        aria-controls="c-bcc-row">Bcc</button>
              </span>
            </div>
            <div class="row" id="c-cc-row" hidden>
              <label for="c-cc">Cc</label>
              <input id="c-cc" type="text" autocomplete="email" spellcheck="false">
            </div>
            <div class="row" id="c-bcc-row" hidden>
              <label for="c-bcc">Bcc</label>
              <input id="c-bcc" type="text" autocomplete="email" spellcheck="false">
            </div>
            <div class="row">
              <label for="c-subject">Subject</label>
              <input id="c-subject" type="text" autocomplete="off">
            </div>
          </div>
          <div class="body" id="c-body" contenteditable="true" spellcheck="true"
               aria-label="Message body" aria-multiline="true"
               data-placeholder="Write your message…"></div>
          <div class="foot">
            <div class="tools" role="toolbar" aria-label="Message formatting">
              <button type="button" class="tool t-bold" data-cmd="bold"
                      title="Bold" aria-label="Bold" aria-pressed="false">B</button>
              <button type="button" class="tool t-italic" data-cmd="italic"
                      title="Italic" aria-label="Italic" aria-pressed="false">I</button>
              <button type="button" class="tool t-under" data-cmd="underline"
                      title="Underline" aria-label="Underline" aria-pressed="false">U</button>
              <button type="button" class="tool" data-cmd="insertUnorderedList"
                      title="Bulleted list" aria-label="Bulleted list"
                      aria-pressed="false">• List</button>
              <button type="button" class="tool" data-cmd="insertOrderedList"
                      title="Numbered list" aria-label="Numbered list"
                      aria-pressed="false">1. List</button>
              <button type="button" class="tool" data-cmd="createLink"
                      title="Insert link" aria-label="Insert link">Link</button>
              <button type="button" class="tool" data-cmd="removeFormat"
                      title="Remove formatting" aria-label="Remove formatting">Tx</button>
            </div>
            <div class="linkrow" id="c-link-row" hidden>
              <label class="sr" for="c-link">Link URL</label>
              <input id="c-link" type="url" placeholder="https://…"
                     aria-describedby="c-link-hint">
              <span class="sr" id="c-link-hint">Applies to the selection; with no
                selection the address is inserted as new link text.</span>
              <button type="button" data-link-apply title="Apply link">Apply</button>
              <button type="button" data-link-remove
                      title="Remove link from selection"
                      aria-label="Remove link from selection">Remove</button>
              <button type="button" data-link-cancel>Cancel</button>
            </div>
            <p class="err" id="c-err">Add at least one recipient before saving.</p>
            <div class="confirm" id="c-confirm">
              <span class="msg" id="c-confirm-msg">Discard this message?</span>
              <button type="button" id="c-keep" aria-describedby="c-confirm-msg">Keep
                editing</button>
              <button type="button" id="c-discard">Discard</button>
            </div>
            <div class="actions">
              <button type="button" class="cancel">Cancel</button>
              <button type="submit" class="save" aria-describedby="c-hint">Save</button>
            </div>
          </div>
        </form>
      </dialog>`;
    this.#dialog = root.querySelector('dialog');
    this.#form = root.querySelector('form');
    this.#folderTag = root.getElementById('compose-folder');
    this.#fromInput = root.getElementById('c-from');
    this.#to = root.getElementById('c-to');
    this.#cc = root.getElementById('c-cc');
    this.#bcc = root.getElementById('c-bcc');
    this.#ccRow = root.getElementById('c-cc-row');
    this.#bccRow = root.getElementById('c-bcc-row');
    this.#ccToggle = root.getElementById('c-cc-toggle');
    this.#bccToggle = root.getElementById('c-bcc-toggle');
    this.#subject = root.getElementById('c-subject');
    this.#tools = root.querySelector('.tools');
    this.#body = root.getElementById('c-body');
    this.#linkRow = root.getElementById('c-link-row');
    this.#linkInput = root.getElementById('c-link');
    this.#err = root.getElementById('c-err');
    this.#confirmRow = root.getElementById('c-confirm');

    for (const btn of this.#tools.querySelectorAll('.tool')) {
      this.#toolButtons.set(btn.dataset.cmd, btn);
    }

    // any edit marks the pane dirty — the guard below keys on it
    this.#form.addEventListener('input', () => {
      this.#dirty = true;
      this.#placeholder();
    });

    // toolbar presses keep the body's selection: swallowing mousedown stops
    // the click from stealing focus, so execCommand edits the live range
    this.#tools.addEventListener('mousedown', e => e.preventDefault());
    this.#tools.addEventListener('click', e => {
      const btn = e.target.closest('.tool');
      if (btn) {
        this.#runTool(btn);
      }
    });
    this.#body.addEventListener('keyup', () => this.#syncTools());
    this.#body.addEventListener('mouseup', () => this.#syncTools());

    // Cc/Bcc disclosure (Gmail pattern): the row opens under To and the
    // focus moves into it so the next keystroke lands where the eye is
    const disclose = (toggle, row, input) => {
      toggle.addEventListener('click', () => {
        const open = row.hidden;
        row.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
        if (open) {
          input.focus();
        }
      });
    };
    disclose(this.#ccToggle, this.#ccRow, this.#cc);
    disclose(this.#bccToggle, this.#bccRow, this.#bcc);

    // link row: Enter applies (IME-safe: composing keys never commit)
    this.#linkInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        this.#applyLink();
      }
    });
    this.#linkRow.querySelector('[data-link-apply]').addEventListener('click', () => {
      this.#applyLink();
    });
    this.#linkRow.querySelector('[data-link-remove]').addEventListener('click', () => {
      // the link input's caret displaced the body selection: the saved
      // range goes back before unlink can act on it
      this.#restoreSelection();
      document.execCommand('unlink');
      this.#savedRange = null;
      this.#hideLinkRow();
    });
    this.#linkRow.querySelector('[data-link-cancel]').addEventListener('click', () => {
      this.#hideLinkRow(true);
    });

    // Escape inside the pane runs the unsent-work guard (popover="manual"
    // never dismisses on its own, and non-modal dialogs fire no cancel
    // events): the link row closes first, dirty work asks once, a second
    // Esc hides, a clean pane hides immediately
    this.#form.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || e.isComposing || e.keyCode === 229) {
        return;
      }
      e.preventDefault();
      if (!this.#linkRow.hidden) {
        this.#hideLinkRow(true);
        return;
      }
      this.#cancel();
    });

    root.querySelector('.head .close').addEventListener('click', () => this.#cancel());
    root.querySelector('.actions .cancel').addEventListener('click', () => this.#cancel());
    this.#confirmRow.querySelector('#c-keep').addEventListener('click', () => {
      this.#confirmRow.classList.remove('show');
      this.#focusBody();
    });
    this.#confirmRow.querySelector('#c-discard').addEventListener('click', () => {
      this.#dialog.hidePopover();
    });

    this.#form.addEventListener('submit', e => {
      e.preventDefault();
      this.#save();
    });
  }

  /**
   * Resets the form and shows the floating pane.
   * @param {object} opts
   * @param {string} opts.from the sender's address (read-only display)
   * @param {string} [opts.fromName] sender display name, echoed on save
   * @param {string} [opts.folder] the destination folder, shown in the
   *   heading so the user sees where the message lands
   */
  open({from, fromName = '', folder = ''} = {}) {
    // a pane already up never resets: typed work stays, focus comes back
    // (Gmail opens a fresh window here, which would silently discard it)
    if (this.#dialog.matches(':popover-open')) {
      this.#to.focus();
      return;
    }
    this.#from = String(from ?? '');
    this.#fromName = String(fromName ?? '');
    this.#fromInput.value = this.#from;
    this.#folderTag.textContent = folder ? '→ ' + folder : '';
    this.#to.value = '';
    this.#cc.value = '';
    this.#bcc.value = '';
    this.#subject.value = '';
    this.#body.innerHTML = '';
    this.#ccRow.hidden = true;
    this.#bccRow.hidden = true;
    this.#ccToggle.setAttribute('aria-expanded', 'false');
    this.#bccToggle.setAttribute('aria-expanded', 'false');
    this.#err.classList.remove('show');
    this.#confirmRow.classList.remove('show');
    this.#hideLinkRow();
    this.#dirty = false;
    this.#savedRange = null;
    this.#placeholder();
    this.#syncTools();
    this.#dialog.showPopover();
    this.#to.focus();
  }

  #cancel() {
    if (this.#dirty && !this.#confirmRow.classList.contains('show')) {
      this.#askDiscard();
      return;
    }
    this.#dialog.hidePopover();
  }

  #askDiscard() {
    this.#confirmRow.classList.add('show');
    this.#confirmRow.querySelector('#c-keep').focus();
  }

  #focusBody() {
    this.#body.focus();
  }

  #placeholder() {
    this.#body.classList.toggle('empty', !this.#body.innerText.trim());
  }

  #runTool(btn) {
    const cmd = btn.dataset.cmd;
    if (cmd === 'createLink') {
      // remember the picked range BEFORE the link input takes focus — the
      // selection cannot survive the focus move on its own
      this.#saveSelection();
      this.#linkRow.hidden = false;
      this.#linkInput.value = '';
      this.#linkInput.focus();
      return;
    }
    this.#focusBody();
    document.execCommand(cmd);
    this.#syncTools();
    this.#placeholder();
  }

  /** snapshots the selection when it lives inside the body */
  #saveSelection() {
    const sel = document.getSelection();
    this.#savedRange = sel && sel.rangeCount &&
      this.#body.contains(sel.getRangeAt(0).commonAncestorContainer)
      ? sel.getRangeAt(0).cloneRange()
      : null;
  }

  /** puts the saved body selection back and focuses the editor */
  #restoreSelection() {
    if (this.#savedRange) {
      const sel = document.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(this.#savedRange);
    }
    this.#focusBody();
  }

  #applyLink() {
    const url = this.#linkInput.value.trim();
    if (!url) {
      this.#linkInput.focus();
      return;
    }
    this.#restoreSelection();
    const sel = document.getSelection();
    const collapsed = !sel || sel.isCollapsed || !String(sel).trim();
    // no text picked: insert the address itself as the link text (Gmail's
    // behavior); a picked range wraps in place
    const ok = collapsed
      ? document.execCommand('insertHTML', false,
        '<a href="' + escapeAttr(url) + '">' + escapeText(url) + '</a>')
      : document.execCommand('createLink', false, url);
    if (ok) {
      this.#dirty = true;
      this.#savedRange = null;
      this.#hideLinkRow();
      this.#placeholder();
    }
    else {
      this.#linkInput.focus();
    }
  }

  #hideLinkRow(refocus = false) {
    this.#linkRow.hidden = true;
    if (refocus) {
      this.#restoreSelection();
    }
  }

  // pressed-state mirror for B/I/U and the two list commands; anything the
  // engine cannot answer stays unpressed
  #syncTools() {
    for (const [cmd, btn] of this.#toolButtons) {
      if (btn.dataset.cmd === 'createLink' || btn.dataset.cmd === 'removeFormat') {
        continue;
      }
      let pressed = false;
      try {
        pressed = document.queryCommandState(cmd);
      }
      catch {}
      btn.setAttribute('aria-pressed', String(pressed));
    }
  }

  #save() {
    const to = this.#to.value.trim();
    const cc = this.#cc.value.trim();
    const bcc = this.#bcc.value.trim();
    if (!to && !cc && !bcc) {
      this.#err.classList.add('show');
      this.#to.focus();
      return;
    }
    this.#err.classList.remove('show');
    this.#dirty = false;
    this.dispatchEvent(new CustomEvent('compose-save', {
      detail: {
        from: this.#from,
        fromName: this.#fromName,
        to,
        cc,
        bcc,
        subject: this.#subject.value.trim(),
        html: this.#body.innerHTML
      },
      bubbles: true,
      composed: true
    }));
    this.#dialog.hidePopover();
  }
}

function escapeText(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeAttr(text) {
  return escapeText(text).replaceAll('"', '&quot;');
}

customElements.define('compose-view', ComposeView);
