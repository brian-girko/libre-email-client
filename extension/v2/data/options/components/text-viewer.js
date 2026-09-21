'use strict';

// text-viewer: a monospace editor with a line-number gutter, for the filter
// query box. One rule per line, no soft wrapping — horizontal and vertical
// overflow scroll inside a single container, with the gutter pinned (sticky)
// on the left so numbers stay visible during horizontal scrolling. The line
// containing the caret is highlighted.
//
// API (matches the textarea usage it replaces):
//   .value   get/set the text
//   .focus() focus the inner textarea
//   'input'  events from the inner textarea bubble out, retargeted to <text-viewer>

const template = document.createElement('template');
template.innerHTML = `
  <style>
    :host {
      display: block;
      font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      font-size: 13px;
      line-height: 1.45;
      /* single source of truth for the line height, shared by the textarea,
         the gutter numbers and the highlight band so rows stay aligned */
      --tv-line: 1.45em;
      --tv-pad-y: 7px;
      --tv-pad-x: 10px;
      --tv-gutter: 3.2em;
      /* mapped by the page theme, like prompt-view in index.css */
      --tv-border: var(--line, light-dark(#d9d9de, #48484a));
      --tv-card: var(--pane-bg, light-dark(#fff, #2c2c2e));
      --tv-text: var(--fg, light-dark(#1d1d1f, #f2f2f7));
      --tv-muted: var(--dim, light-dark(#6e6e73, #98989d));
      --tv-highlight: color-mix(in srgb, var(--tv-muted) 14%, transparent);
      /* keep the widest line from widening ancestors via min-content */
      min-width: 0;
      max-width: 100%;
    }

    /* the sole scroller: both axes; at least eight lines tall by default,
       freely resizable vertically */
    .viewer {
      min-width: 0;
      display: flex;
      align-items: flex-start;
      min-height: calc(8 * var(--tv-line) + 2 * var(--tv-pad-y));
      overflow: auto;
      resize: vertical;
      border: 1px solid var(--tv-border);
      border-radius: 8px;
      background: var(--tv-card);
      color: var(--tv-text);
    }

    .viewer:focus-within {
      border-color: var(--accent, light-dark(#0a84ff, #0a84ff));
    }

    /* sticky on the left so numbers stay put during horizontal scrolling;
       flex-start (not stretch) keeps its height tied to the content, so the
       numbers scroll vertically together with the text */
    .gutter {
      position: sticky;
      left: 0;
      z-index: 2;
      flex: none;
      display: flex;
      flex-direction: column;
      min-width: var(--tv-gutter);
      padding: var(--tv-pad-y) 6px;
      text-align: right;
      color: var(--tv-muted);
      background: var(--tv-card);
      border-right: 1px solid var(--tv-border);
      user-select: none;
    }

    .gutter span {
      flex: none;
      height: var(--tv-line);
    }

    /* sized by JS; flex-shrink 0 so a wide body overflows .viewer (making it
       scroll) instead of being squeezed back */
    .body {
      position: relative;
      flex: 1 0 auto;
    }

    /* active-line band behind the transparent textarea */
    .highlight {
      position: absolute;
      left: 0;
      right: 0;
      display: none;
      background: var(--tv-highlight);
      pointer-events: none;
    }

    .body:focus-within .highlight {
      display: block;
    }

    /* pinned to .body's top-left so nothing in flow can displace it; sized
       by JS to its content (widest line) so the outer .viewer handles both
       overflow axes — the textarea itself never scrolls */
    textarea {
      position: absolute;
      top: 0;
      left: 0;
      display: block;
      box-sizing: border-box;
      margin: 0;
      padding: var(--tv-pad-y) var(--tv-pad-x);
      border: none;
      background: transparent;
      color: inherit;
      font: inherit;
      line-height: var(--tv-line);
      white-space: pre;
      overflow: hidden;
      resize: none;
      outline: none;
    }

    textarea::placeholder {
      color: var(--tv-muted);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
  </style>
  <div class="viewer" part="viewer">
    <div class="gutter" aria-hidden="true"></div>
    <div class="body">
      <div class="highlight"></div>
      <textarea part="textarea" spellcheck="false" wrap="off"></textarea>
    </div>
  </div>
`;

// labels that already have their clicks forwarded to a text-viewer
const wiredLabels = new WeakSet();

class TextViewer extends HTMLElement {
  #textarea;
  #gutter;
  #highlight;
  #viewer;
  #body;
  #lineCount = -1;
  #prevWidth = 0;

  constructor() {
    super();
    const root = this.attachShadow({mode: 'open'});
    root.append(template.content.cloneNode(true));
    this.#viewer = root.querySelector('.viewer');
    this.#gutter = root.querySelector('.gutter');
    this.#highlight = root.querySelector('.highlight');
    this.#body = root.querySelector('.body');
    this.#textarea = root.querySelector('textarea');

    this.#textarea.addEventListener('input', () => this.#sync());
    for (const type of ['keyup', 'click', 'focus', 'blur']) {
      this.#textarea.addEventListener(type, () => this.#syncHighlight());
    }
    document.addEventListener('selectionchange', () => {
      if (this.#textarea.matches(':focus')) {
        this.#syncHighlight();
      }
    });
    // clicking the gutter (or the wrapping <label>) should focus the text
    this.addEventListener('click', () => {
      if (!this.#textarea.matches(':focus')) {
        this.#textarea.focus();
      }
    });
    // re-measure when the scroller changes size (e.g. editor shown while hidden)
    new ResizeObserver(() => this.#syncSize()).observe(this.#viewer);
    // initial gutter/sizing for the (possibly prerendered) value; also keeps
    // the ResizeObserver from firing against an uninitialized state
    this.#sync();
  }

  connectedCallback() {
    // a <label> cannot associate with form fields inside a shadow root, so
    // clicks on the surrounding label text are forwarded here
    const label = this.closest('label');
    if (label && !wiredLabels.has(label)) {
      wiredLabels.add(label);
      label.addEventListener('click', event => {
        if (event.target.closest('text-viewer') === this) {
          this.#textarea.focus();
        }
      });
    }
  }

  get value() {
    return this.#textarea.value;
  }

  set value(text) {
    this.#textarea.value = text;
    this.#sync();
    this.#syncHighlight();
  }

  focus() {
    this.#textarea.focus();
  }

  get placeholder() {
    return this.getAttribute('placeholder') ?? '';
  }

  set placeholder(text) {
    this.setAttribute('placeholder', text);
  }

  static get observedAttributes() {
    return ['placeholder'];
  }

  attributeChangedCallback(name, _old, value) {
    if (name === 'placeholder') {
      this.#textarea.placeholder = value ?? '';
    }
  }

  // rebuild the gutter when the line count changes and keep the textarea and
  // .body sized to the content so the shared scroller sees it all
  #sync() {
    const count = this.#textarea.value.split('\n').length;
    if (count !== this.#lineCount) {
      this.#lineCount = count;
      const frag = document.createDocumentFragment();
      for (let i = 1; i <= count; i++) {
        const n = document.createElement('span');
        n.textContent = i;
        frag.append(n);
      }
      this.#gutter.replaceChildren(frag);
    }
    this.#syncSize();
    this.#syncHighlight();
  }

  #syncSize() {
    // collapse first so scrollWidth reflects the widest line, not the box
    this.#textarea.style.width = '0px';
    const available = this.#viewer.clientWidth - this.#gutter.offsetWidth;
    // never shrink below the previously applied width when only the vertical
    // resize (or a scrollbar toggling) reduced the available space: the
    // content keeps its size and the scroller handles the overflow instead
    const floorWidth = Math.min(this.#prevWidth, available);
    const w = Math.max(this.#textarea.scrollWidth, available, floorWidth);
    // border-box height: line count plus the textarea's own padding, so the
    // gutter (same paddings) and the text stay line-aligned; the absolutely
    // positioned textarea does not size its parent, so .body gets the same
    // explicit size and drives .viewer's scrollable area and the highlight
    const h = `calc(${this.#lineCount} * var(--tv-line) + 2 * var(--tv-pad-y))`;
    // keep the floor in step with the width we hand out so successive
    // syncs during erasing/typing can still shrink it back
    this.#prevWidth = w;
    this.#textarea.style.width = w + 'px';
    this.#textarea.style.height = h;
    this.#body.style.width = w + 'px';
    this.#body.style.height = h;
    // clamp the body back if the applied width made the box grow/shrink
    // (e.g. a scrollbar appearing) so the round-trip cannot oscillate with
    // the ResizeObserver observing .viewer
    const settled = Math.max(
      Math.min(this.#textarea.scrollWidth, w),
      this.#viewer.clientWidth - this.#gutter.offsetWidth
    );
    if (settled !== w) {
      this.#textarea.style.width = settled + 'px';
      this.#body.style.width = settled + 'px';
    }
  }

  #syncHighlight() {
    const upto = this.#textarea.value.slice(0, this.#textarea.selectionStart);
    const line = upto.split('\n').length - 1;
    // offset by the textarea's top padding so the band sits on the line
    this.#highlight.style.top = `calc(var(--tv-pad-y) + ${line} * var(--tv-line))`;
    this.#highlight.style.height = 'var(--tv-line)';
  }
}

customElements.define('text-viewer', TextViewer);
