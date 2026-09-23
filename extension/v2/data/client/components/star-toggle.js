// star-toggle.js — the star button shared by list rows and the preview card.
//
// Click toggles to the plain yellow star when unstarred. When already
// starred, the click opens a small popover with the color palette
// (including "none" to unstar). Fires a bubbling, composed 'star'
// CustomEvent with {color} — the host attaches uids and forwards it.

import {STAR_COLORS} from '../star-colors.mjs';

const SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.6l2.9 6 6.6.9-4.8 4.6 1.2 6.5-5.9-3.2-5.9 3.2 1.2-6.5-4.8-4.6 6.6-.9z"/></svg>';

const CSS = `
:host {
  flex: none;
  width: calc(24px * var(--font-scale, 1));
  height: calc(26px * var(--font-scale, 1));
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
button {
  border: 0;
  padding: 0;
  background: none;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  color: var(--line, #d9dce1);
}
button:hover {
  color: var(--dim, #8a8f98);
}
svg {
  width: calc(16px * var(--font-scale, 1));
  height: calc(16px * var(--font-scale, 1));
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linejoin: round;
}
button[aria-pressed="true"] {
  color: light-dark(#e8a013, #f5b301);
}
button[data-color="1"] {
  color: light-dark(#d93025, #f28b82);
}
button[data-color="2"] {
  color: light-dark(#e8710a, #fcad70);
}
button[data-color="4"] {
  color: light-dark(#188038, #81c995);
}
button[data-color="5"] {
  color: light-dark(#1a73e8, #8ab4f8);
}
button[data-color="6"] {
  color: light-dark(#9334e6, #c58af9);
}
button[aria-pressed="true"] svg {
  fill: currentColor;
}
button {
  anchor-name: --starbtn;
}
#pop {
  position: fixed;
  position-anchor: --starbtn;
  position-area: block-start span-inline-end;
  position-try-fallbacks: flip-block, flip-inline;
  position-visibility: anchors-visible;
  margin: 0 0 6px 0;
  max-height: calc(100vh - 16px);
  overflow: auto;
  border: 1px solid var(--line, #d9dce1);
  border-radius: var(--radius, 10px);
  background: var(--pane-bg, #ffffff);
  color: var(--fg, #1b1d21);
  padding: calc(4px * var(--font-scale, 1));
  z-index: 10;
}
#pop:not(:popover-open) {
  display: none;
}
#pop:popover-open {
  display: flex;
  gap: calc(2px * var(--font-scale, 1));
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
}
#pop .swatch {
  width: calc(22px * var(--font-scale, 1));
  height: calc(22px * var(--font-scale, 1));
  border: 0;
  border-radius: 50%;
  padding: 0;
  background: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: var(--line, #d9dce1);
}
#pop .swatch svg {
  width: calc(16px * var(--font-scale, 1));
  height: calc(16px * var(--font-scale, 1));
  fill: currentColor;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linejoin: round;
}
#pop .swatch[data-swatch="1"] {
  color: light-dark(#d93025, #f28b82);
}
#pop .swatch[data-swatch="2"] {
  color: light-dark(#e8710a, #fcad70);
}
#pop .swatch[data-swatch="3"] {
  color: light-dark(#e8a013, #f5b301);
}
#pop .swatch[data-swatch="4"] {
  color: light-dark(#188038, #81c995);
}
#pop .swatch[data-swatch="5"] {
  color: light-dark(#1a73e8, #8ab4f8);
}
#pop .swatch[data-swatch="6"] {
  color: light-dark(#9334e6, #c58af9);
}
#pop .swatch:hover,
#pop .swatch:focus-visible {
  outline: 2px solid var(--accent, #4a90d9);
  outline-offset: 1px;
}
#pop .swatch[aria-checked="true"] {
  outline: 2px solid var(--fg, #1b1d21);
  outline-offset: 1px;
}
`;

// True while any star color picker popover is on screen. The mirror-driven
// folder reconcile (filters.mjs) skips the in-place list sync while this is
// open — the reconcile rebuilds every row, which would detach the popover's
// host element and make the browser drop the open popover.
let openCount = 0;

export function starPickerOpen() {
  return openCount > 0;
}

class StarToggle extends HTMLElement {
  #btn;
  #pop;
  #color = 0;

  constructor() {
    super();
    const root = this.attachShadow({mode: 'open'});
    root.innerHTML = `<style>${CSS}</style>`
      + `<button type="button" aria-pressed="false" aria-label="Flag">${SVG}</button>`
      + `<div id="pop" popover="auto" role="menu"></div>`;
    this.#btn = root.querySelector('button');
    this.#pop = root.querySelector('#pop');
    const swatches = document.createElement('div');
    swatches.style.display = 'contents';
    for (let i = 1; i < STAR_COLORS.length; i++) {
      const c = STAR_COLORS[i];
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'swatch';
      sw.dataset.swatch = String(i);
      sw.setAttribute('role', 'menuitemradio');
      sw.setAttribute('aria-label', 'Star with color ' + c.name);
      sw.innerHTML = SVG;
      sw.addEventListener('click', e => {
        e.stopPropagation();
        this.#choose(i);
      });
      this.#pop.append(sw);
    }
    this.#btn.addEventListener('click', e => {
      e.stopPropagation();
      if (this.#color) {
        this.#emit(0);
      }
      else {
        this.#emit(3);
        // the hosts apply flags synchronously; let the yellow land before opening
        requestAnimationFrame(() => this.#open());
      }
    });
    this.#pop.addEventListener('keydown', e => {
      const items = [...this.#pop.querySelectorAll('.swatch')];
      const cur = items.indexOf(document.activeElement);
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        items[(cur + 1) % items.length]?.focus();
      }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        items[(cur - 1 + items.length) % items.length]?.focus();
      }
      else if (e.key === 'Escape') {
        this.#btn.focus();
      }
    });
  }

  set color(value) {
    this.#color = Number(value) || 0;
    const on = !!this.#color;
    this.#btn.setAttribute('aria-pressed', String(on));
    if (on && this.#color !== 3) {
      this.#btn.dataset.color = String(this.#color);
    }
    else {
      this.#btn.removeAttribute('data-color');
    }
    for (const sw of this.#pop.querySelectorAll('.swatch')) {
      sw.setAttribute('aria-checked', String(Number(sw.dataset.swatch) === this.#color));
    }
    this.#btn.setAttribute('aria-label', on ? 'Unflag' : 'Flag');
    this.#btn.setAttribute('aria-haspopup', on ? 'menu' : 'false');
  }

  get color() {
    return this.#color;
  }

  #open() {
    const swatches = [...this.#pop.querySelectorAll('.swatch')];
    (this.#pop.querySelector('.swatch[aria-checked="true"]') ?? swatches[0])?.focus();
    this.#pop.addEventListener('toggle', e => {
      if (e.newState === 'open') {
        openCount++;
      }
      else if (e.newState === 'closed') {
        openCount = Math.max(0, openCount - 1);
      }
    }, {once: true});
    this.#pop.showPopover();
  }

  #choose(color) {
    if (this.#pop.matches(':popover-open')) {
      this.#pop.hidePopover();
    }
    this.#btn.focus();
    if (color !== this.#color) {
      this.#emit(color);
    }
  }

  #emit(color) {
    this.dispatchEvent(new CustomEvent('star', {
      detail: {color},
      bubbles: true,
      composed: true
    }));
  }
}

customElements.define('star-toggle', StarToggle);
