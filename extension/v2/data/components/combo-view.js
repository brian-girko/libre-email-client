// Tool bar widget that joins several buttons into one visual button.
// Slotted <button> children are re-slotted into segments separated by a
// single line, so they share one border and one label while staying fully
// independent: own accesskey, title, click handler and disabled state.
// An optional "Mark as" style prefix comes from the label attribute (or a
// slot="label" child); with neither present no label is rendered.

class ComboView extends HTMLElement {
  static observedAttributes = ['label'];

  #shadow;
  #label;
  #labelText;
  #labelSlot;
  #body;
  #probe;
  #known = null;

  constructor() {
    super();
    this.#shadow = this.attachShadow({mode: 'open'});
    this.#shadow.innerHTML = `
      <style>
        :host {
          display: inline-flex;
          align-items: center;
          min-height: calc(26px * var(--font-scale, 1));
          color: var(--fg, #1b1d21);
          background: none;
          border: 1px solid var(--line, #d9dce1);
          border-radius: var(--radius, 10px);
          overflow: hidden;
          vertical-align: middle;
          white-space: nowrap;
        }
        :host([hidden]) {
          display: none;
        }
        * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }
        [hidden] {
          display: none !important;
        }
        .label {
          display: inline-flex;
          align-items: center;
          padding: 0 calc(6px * var(--font-scale, 1)) 0 calc(12px * var(--font-scale, 1));
          font: inherit;
          font-size: calc(12px * var(--font-scale, 1));
        }
        .body {
          display: flex;
          align-items: stretch;
        }
        .segment {
          display: inline-flex;
          align-items: stretch;
          padding-inline: calc(6px * var(--font-scale, 1));
        }
        .segment + .segment {
          border-left: 1px solid var(--line, #d9dce1);
        }
        ::slotted(button) {
          display: inline-flex;
          align-items: center;
          min-height: 100%;
          padding: calc(2px * var(--font-scale, 1)) calc(12px * var(--font-scale, 1));
          font: inherit;
          font-size: calc(12px * var(--font-scale, 1));
          color: var(--fg, #1b1d21);
          background: none;
          border: none;
          border-radius: 0;
          cursor: pointer;
          outline-offset: -1px;
        }
        ::slotted(button:hover:not(:disabled)) {
          background: color-mix(in srgb, var(--fg, #1b1d21) 8%, transparent);
        }
        ::slotted(button:disabled) {
          opacity: 0.5;
          cursor: default;
        }
      </style>
      <span class="label" part="label" hidden>
        <span class="label-text"></span>
        <slot name="label" hidden></slot>
      </span>
      <slot id="probe" hidden></slot>
      <span class="body" part="body"></span>`;

    this.#label = this.#shadow.querySelector('.label');
    this.#labelText = this.#shadow.querySelector('.label-text');
    this.#labelSlot = this.#shadow.querySelector('slot[name="label"]');
    this.#body = this.#shadow.querySelector('.body');
    this.#probe = this.#shadow.getElementById('probe');
    this.#probe.addEventListener('slotchange', () => this.#sync());
    this.#labelSlot.addEventListener('slotchange', () => this.#updateLabel());
  }

  connectedCallback() {
    if (!this.hasAttribute('role')) {
      this.setAttribute('role', 'group');
    }
    this.#updateLabel();
  }

  attributeChangedCallback(name) {
    if (name === 'label') {
      this.#updateLabel();
    }
  }

  get label() {
    return this.getAttribute('label');
  }

  set label(value) {
    if (value === null) {
      this.removeAttribute('label');
    }
    else {
      this.setAttribute('label', value);
    }
  }

  #updateLabel() {
    const text = this.getAttribute('label');
    const hasText = text !== null && text !== '';
    const custom = this.#labelSlot.assignedNodes().some(node => node.textContent.trim());
    this.#labelText.textContent = text ?? '';
    this.#labelText.hidden = !hasText;
    this.#labelSlot.hidden = hasText || !custom;
    this.#label.hidden = !hasText && !custom;
    if (hasText) {
      this.setAttribute('aria-label', text);
    }
    else {
      this.removeAttribute('aria-label');
    }
  }

  // Re-slot the light children into per-child named slots so a divider can
  // be drawn between any pair (::slotted has no sibling selectors).
  #sync() {
    const items = this.#probe.assignedElements();
    if (!items.length && [...this.children].some(child => child.slot !== 'label')) {
      // The probe was emptied by our own re-slotting below, not by removal.
      return;
    }
    const names = items.map((item, index) => {
      if (item.slot !== 'c' + index) {
        item.slot = 'c' + index;
      }
      return item.tagName;
    });
    const signature = names.join('>');
    if (signature === this.#known) {
      return;
    }
    this.#known = signature;
    const segments = items.map((item, index) => {
      const segment = document.createElement('span');
      segment.className = 'segment';
      segment.part = index ? 'segment divider' : 'segment';
      const slot = document.createElement('slot');
      slot.setAttribute('name', 'c' + index);
      segment.append(slot);
      return segment;
    });
    this.#body.replaceChildren(...segments);
  }
}

customElements.define('combo-view', ComboView);
