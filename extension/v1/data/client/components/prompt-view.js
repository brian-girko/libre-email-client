class PromptView extends HTMLElement {
  #dialog;
  #form;
  #message;
  #input;
  #choiceRow;
  #pending = null;
  #queue = [];

  constructor() {
    super();
    const root = this.attachShadow({mode: 'open'});
    root.innerHTML = `
      <style>
        :host {
          display: contents;
        }
        :host([hidden]) {
          display: none;
        }
        * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }
        dialog {
          width: min(90vw, 380px);
          padding: calc(18px * var(--font-scale, 1));
          color: var(--fg, #1b1d21);
          background: var(--pane-bg, #ffffff);
          border: 1px solid var(--line, #d9dce1);
          border-radius: var(--radius, 10px);
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
          margin: auto;
        }
        dialog::backdrop {
          background: rgba(0, 0, 0, 0.4);
        }
        form {
          display: flex;
          flex-direction: column;
          gap: calc(12px * var(--font-scale, 1));
          margin: 0;
        }
        .message {
          margin: 0;
          font-size: calc(14px * var(--font-scale, 1));
          overflow-wrap: anywhere;
        }
        input {
          width: 100%;
          min-width: 0;
          min-height: calc(32px * var(--font-scale, 1));
          padding: calc(6px * var(--font-scale, 1)) calc(10px * var(--font-scale, 1));
          font: inherit;
          font-size: calc(13px * var(--font-scale, 1));
          color: var(--fg, #1b1d21);
          background: var(--bg, #f5f6f8);
          border: 1px solid var(--line, #d9dce1);
          border-radius: var(--radius, 10px);
        }
        input:focus {
          outline: none;
          border-color: var(--dim, #8a8f98);
        }
        .row {
          display: flex;
          justify-content: flex-end;
          gap: calc(8px * var(--font-scale, 1));
        }
        button {
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
        button:hover {
          border-color: var(--dim, #8a8f98);
        }
        .cancel {
          color: var(--dim, #7d828a);
        }
        .choices {
          display: flex;
          flex-wrap: wrap;
          gap: calc(6px * var(--font-scale, 1));
        }
        .choices button {
          min-height: calc(30px * var(--font-scale, 1));
          padding: calc(4px * var(--font-scale, 1)) calc(12px * var(--font-scale, 1));
          font: inherit;
          font-size: calc(13px * var(--font-scale, 1));
          color: var(--fg, #1b1d21);
          background: var(--bg, #f5f6f8);
          border: 1px solid var(--line, #d9dce1);
          border-radius: calc(999px * var(--font-scale, 1));
          cursor: pointer;
        }
        .choices button:hover {
          border-color: var(--accent, AccentColor);
        }
      </style>
      <dialog>
        <form>
          <p class="message"></p>
          <input type="text">
          <div class="choices" hidden></div>
          <div class="row">
            <button type="button" class="cancel">Cancel</button>
            <button class="ok">OK</button>
          </div>
        </form>
      </dialog>`;
    this.#dialog = root.querySelector('dialog');
    this.#form = root.querySelector('form');
    this.#message = root.querySelector('.message');
    this.#input = root.querySelector('input');
    this.#choiceRow = root.querySelector('.choices');
    this.#form.addEventListener('submit', e => {
      e.preventDefault();
      this.#settle(this.#input.value);
    });
    this.#dialog.addEventListener('cancel', e => {
      e.preventDefault();
      this.#settle(new Error('cancelled'));
    });
    this.#dialog.addEventListener('close', () => {
      if (this.#pending) {
        this.#settle(new Error('cancelled'));
      }
    });
    root.querySelector('.cancel').addEventListener('click', () => {
      this.#settle(new Error('cancelled'));
    });
  }

  ask(message, {password = false, placeholder = ''} = {}) {
    return new Promise((resolve, reject) => {
      this.#queue.push({
        message: String(message ?? ''),
        password: !!password,
        placeholder: String(placeholder ?? ''),
        choices: null,
        resolve,
        reject
      });
      if (!this.#pending) {
        this.#next();
      }
    });
  }

  // Choice dialog: replaces the input with one button per option; Esc or the
  // Cancel button cancels (the caller decides what cancelling means)
  askChoice(message, choices = [], {label = 'Cancel'} = {}) {
    return new Promise((resolve, reject) => {
      this.#queue.push({
        message: String(message ?? ''),
        password: false,
        placeholder: '',
        choices: choices.map(c => typeof c === 'object' ? c : {value: c, label: String(c)}),
        resolve,
        reject
      });
      if (!this.#pending) {
        this.#next();
      }
    });
  }

  #next() {
    const job = this.#queue.shift();
    if (!job) return;
    this.#pending = job;
    this.#message.textContent = job.message;
    const choices = Array.isArray(job.choices) && job.choices.length ? job.choices : null;
    this.#input.hidden = !!choices;
    this.#choiceRow.hidden = !choices;
    this.#choiceRow.replaceChildren();
    if (choices) {
      for (const c of choices) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = String(c.label ?? c.value);
        btn.addEventListener('click', () => {
          this.#settle(c.value);
        });
        this.#choiceRow.append(btn);
      }
      // hide the OK button in choice mode: one click on a choice settles
      this.#form.querySelector('.ok').hidden = true;
    }
    else {
      this.#form.querySelector('.ok').hidden = false;
    }
    this.#input.type = job.password ? 'password' : 'text';
    this.#input.autocomplete = job.password ? 'new-password' : 'off';
    this.#input.placeholder = job.placeholder;
    this.#input.value = '';
    this.removeAttribute('hidden');
    this.#dialog.showModal();
    if (!choices) {
      this.#input.focus();
    }
  }

  #settle(result) {
    const job = this.#pending;
    if (!job) return;
    this.#pending = null;
    if (this.#dialog.open) {
      this.#dialog.close();
    }
    if (result instanceof Error) {
      job.reject(result);
    }
    else {
      job.resolve(result);
    }
    if (this.#queue.length) {
      setTimeout(() => this.#next(), 0);
    }
    else {
      this.setAttribute('hidden', '');
    }
  }
}

customElements.define('prompt-view', PromptView);
