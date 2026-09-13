class EmailsView extends HTMLElement {
  #slot;
  #clearButton;

  constructor() {
    super();
    const root = this.attachShadow({mode: 'open'});
    root.innerHTML = `
      <style>
        :host {
          display: flex;
          flex-direction: column;
          min-width: 0;
          min-height: 0;
          overflow-y: auto;
          padding: 0 calc(8px * var(--font-scale, 1));
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
        * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }
        [hidden] {
          display: none !important;
        }
        .bar {
          flex: none;
          position: sticky;
          top: 0;
          z-index: 1;
          display: flex;
          justify-content: flex-end;
          padding: calc(8px * var(--font-scale, 1));
          background: var(--pane-bg, #ffffff);
        }
        .clear {
          min-height: calc(26px * var(--font-scale, 1));
          padding: calc(2px * var(--font-scale, 1)) calc(12px * var(--font-scale, 1));
          font: inherit;
          font-size: calc(12px * var(--font-scale, 1));
          color: var(--dim, #8a8f98);
          background: var(--pane-bg, #ffffff);
          border: 1px solid var(--line, #d9dce1);
          border-radius: var(--radius, 10px);
          cursor: pointer;
        }
        .clear:hover {
          color: var(--fg, #1b1d21);
          border-color: var(--dim, #8a8f98);
        }
        .clear u {
          text-underline-offset: 2px;
        }
        ::slotted(email-view) {
          flex: none;
          margin: 0 0 calc(8px * var(--font-scale, 1));
        }
      </style>
      <div class="bar" title="Open emails — Alt+3 focus · ↑/↓ switch emails">
        <button class="clear" type="button" hidden accesskey="l">C<u>l</u>ear all</button>
      </div>
      <slot></slot>`;
    this.#slot = root.querySelector('slot');
    this.#clearButton = root.querySelector('.clear');
    this.#slot.addEventListener('slotchange', () => {
      this.#clearButton.hidden = this.#slot.assignedElements().length === 0;
    });
    this.#clearButton.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('clear', {bubbles: true, composed: true}));
    });
    this.addEventListener('keydown', e => {
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.defaultPrevented) {
        const cards = [...this.children].filter(node => node.tagName === 'EMAIL-VIEW');
        if (!cards.length) {
          return;
        }
        e.preventDefault();
        const idx = cards.indexOf(document.activeElement);
        const start = idx === -1 ? (e.key === 'ArrowDown' ? -1 : cards.length) : idx;
        const next = cards[start + (e.key === 'ArrowDown' ? 1 : -1)];
        if (!next) {
          return;
        }
        next.focus({preventScroll: true});
        next.scrollIntoView({block: 'nearest'});
      }
    });
  }

  connectedCallback() {
    this.tabIndex = -1;
  }
}

customElements.define('emails-view', EmailsView);
