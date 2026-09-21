import postalMime from '/core/parser/postal-mime.mjs';

const dateTimeFormat = new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short'});

const BLOCK_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:;";

function formatAddress(a) {
  if (!a) {
    return '';
  }
  const name = a.name || '';
  const address = a.address || '';
  if (name && address) {
    return name + ' <' + address + '>';
  }
  return name || address;
}

function formatAddressList(list) {
  if (Array.isArray(list)) {
    return list.map(formatAddress).filter(Boolean).join(', ');
  }
  return formatAddress(list);
}

function injectCsp(html, csp) {
  const meta = '<meta http-equiv="Content-Security-Policy" content="' + csp.replace(/"/g, '&quot;') + '">';
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, m => m + meta);
  }
  return meta + html;
}

// the sandbox/CSP do not stop the iframe from navigating itself to a remote
// url via meta refresh; once navigated, our CSP is gone and remote content loads
function stripMetaRefresh(html) {
  return html.replace(/<meta[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, '');
}

function injectZoom(html, scale) {
  if (!(scale > 0) || scale === 1) {
    return html;
  }
  return '<style>body{zoom:' + scale + ';}</style>' + html;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceCids(html, map) {
  let out = html;
  for (const [cid, url] of map) {
    out = out.replace(new RegExp('cid:\\s*' + escapeRegex(cid), 'gi'), url);
  }
  return out;
}

function formatSize(bytes) {
  if (bytes == null) {
    return '';
  }
  if (bytes < 1024) {
    return bytes + ' B';
  }
  if (bytes < 1024 * 1024) {
    return (bytes / 1024).toFixed(1) + ' KB';
  }
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

class EmailView extends HTMLElement {
  #uid = null;
  #displayMode = 'block';
  #fontScale = 1;
  #flagged = false;
  #state = 'loading';
  #error = '';
  #urls = [];
  #observer = null;
  #parseToken = 0;
  #status;
  #statusText;
  #chips;
  #body;
  #star;
  #trash;
  #archive;

  constructor() {
    super();
    const root = this.attachShadow({mode: 'open'});
    root.innerHTML = `
      <style>
        :host {
          display: block;
          min-width: 0;
          background: var(--pane-bg, #ffffff);
          border: 1px solid var(--line, #d9dce1);
          border-radius: var(--radius, 10px);
          overflow: hidden;
          color: var(--fg, #1b1d21);
          font: calc(14px * var(--font-scale, 1))/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        }
        :host([hidden]) {
          display: none;
        }
        :host(:focus) {
          outline: 2px solid color-mix(in srgb, var(--accent, AccentColor) 55%, transparent);
          outline-offset: 2px;
        }
        * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }
        [hidden] {
          display: none !important;
        }
        header {
          display: flex;
          align-items: flex-start;
          gap: calc(8px * var(--font-scale, 1));
          padding: calc(10px * var(--font-scale, 1)) calc(12px * var(--font-scale, 1));
          border-bottom: 1px solid var(--line, #d9dce1);
        }
        .meta {
          flex: 1;
          min-width: 0;
        }
        .subject {
          font-size: calc(14px * var(--font-scale, 1));
          font-weight: 600;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .line {
          display: flex;
          align-items: baseline;
          gap: calc(8px * var(--font-scale, 1));
          color: var(--dim, #8a8f98);
          font-size: calc(12px * var(--font-scale, 1));
        }
        .from {
          flex: 1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .date {
          flex: none;
        }
        .to {
          display: block;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .close {
          flex: none;
          width: calc(24px * var(--font-scale, 1));
          height: calc(24px * var(--font-scale, 1));
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border: 0;
          background: none;
          color: var(--dim, #8a8f98);
          font-size: calc(16px * var(--font-scale, 1));
          border-radius: var(--radius, 10px);
          cursor: pointer;
        }
        .close:hover {
          color: var(--fg, #1b1d21);
          background: var(--bg, #f5f6f8);
        }
        .actions {
          flex: none;
          display: flex;
          align-items: center;
          gap: calc(4px * var(--font-scale, 1));
        }
        .star {
          flex: none;
          width: calc(24px * var(--font-scale, 1));
          height: calc(24px * var(--font-scale, 1));
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border: 0;
          padding: 0;
          background: none;
          cursor: pointer;
          color: var(--line, #d9dce1);
        }
        .star:hover {
          color: var(--dim, #8a8f98);
        }
        .star svg {
          width: calc(16px * var(--font-scale, 1));
          height: calc(16px * var(--font-scale, 1));
          fill: none;
          stroke: currentColor;
          stroke-width: 1.5;
          stroke-linejoin: round;
        }
        .star[aria-pressed="true"] {
          color: light-dark(#e8a013, #f5b301);
        }
        .star[aria-pressed="true"] svg {
          fill: currentColor;
        }
        .trash,
        .archive {
          flex: none;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: calc(24px * var(--font-scale, 1));
          height: calc(24px * var(--font-scale, 1));
          padding: 0;
          font: inherit;
          color: var(--fg, #1b1d21);
          background: none;
          border: 1px solid var(--line, #d9dce1);
          border-radius: var(--radius, 10px);
          cursor: pointer;
        }
        .trash:hover,
        .archive:hover {
          border-color: var(--dim, #8a8f98);
        }
        .trash svg {
          width: calc(16px * var(--font-scale, 1));
          height: calc(16px * var(--font-scale, 1));
          fill: currentColor;
          stroke: none;
        }
        .archive svg {
          width: calc(16px * var(--font-scale, 1));
          height: calc(16px * var(--font-scale, 1));
          fill: currentColor;
          stroke: none;
        }
        .chips {
          display: flex;
          flex-wrap: wrap;
          gap: calc(6px * var(--font-scale, 1));
          padding: calc(8px * var(--font-scale, 1)) calc(12px * var(--font-scale, 1)) 0;
        }
        .chip {
          font-size: calc(12px * var(--font-scale, 1));
          color: var(--dim, #8a8f98);
          border: 1px solid var(--line, #d9dce1);
          border-radius: var(--radius, 10px);
          padding: calc(2px * var(--font-scale, 1)) calc(10px * var(--font-scale, 1));
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          max-width: 100%;
        }
        .status {
          padding: calc(20px * var(--font-scale, 1)) calc(12px * var(--font-scale, 1));
          text-align: center;
          color: var(--dim, #8a8f98);
          font-size: calc(13px * var(--font-scale, 1));
          user-select: none;
        }
        .status.error p {
          color: light-dark(#b3261e, #f2b8b5);
        }
        .status p {
          overflow-wrap: anywhere;
        }
        pre {
          padding: calc(12px * var(--font-scale, 1));
          font: calc(12px * var(--font-scale, 1))/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
          color: var(--fg, #1b1d21);
        }
        iframe {
          display: block;
          width: 100%;
          border: 0;
          background: #ffffff;
        }
      </style>
      <header>
        <div class="meta">
          <div class="subject"></div>
          <div class="line"><span class="from"></span><span class="date"></span></div>
          <span class="to"></span>
        </div>
        <div class="actions">
          <button class="star" type="button" accesskey="f" title="Flag (F)" aria-pressed="false" aria-label="Flag message"></button>
          <button class="trash" type="button" accesskey="h" title="Trash (H)" aria-label="Trash"><svg viewBox="0 0 1024 1024" aria-hidden="true"><path d="M 160,256 H 96 C 78.326876,256 64.000014,241.67311 64.000014,224 64.000014,206.32689 78.326876,192 96,192 H 352 V 95.936 c 0,-17.673112 14.32689,-32 32,-32 h 256 c 17.67311,0 32,14.326888 32,32 V 192 h 256 c 17.67312,0 31.99999,14.32689 31.99999,32 0,17.67311 -14.32687,32 -31.99999,32 h -64 v 672 c 0,17.67311 -14.32689,32 -32,32 H 192 c -17.67311,0 -32,-14.32689 -32,-32 z M 608,192 V 128 H 416 v 64 z M 239.36,880.64 H 784.64 V 271.36 H 239.36 Z M 416,768 c -17.67311,0 -32,-14.32689 -32,-32 V 416 c 0,-17.67312 14.32689,-31.99999 32,-31.99999 17.67311,0 32,14.32687 32,31.99999 v 320 c 0,17.67311 -14.32689,32 -32,32 z m 192,0 c -17.67311,0 -32,-14.32689 -32,-32 V 416 c 0,-17.67312 14.32689,-31.99999 32,-31.99999 17.67311,0 32,14.32687 32,31.99999 v 320 c 0,17.67311 -14.32689,32 -32,32 z"/></svg></button>
          <button class="archive" type="button" accesskey="c" title="Archive (C)" aria-label="Archive"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 10C7.44772 10 7 10.4477 7 11C7 11.5523 7.44772 12 8 12H16C16.5523 12 17 11.5523 17 11C17 10.4477 16.5523 10 16 10H8Z"/><path fill-rule="evenodd" clip-rule="evenodd" d="M23 4C23 2.34315 21.6569 1 20 1H4C2.34315 1 1 2.34315 1 4V5C1 6.30622 1.83481 7.41746 3 7.82929V20C3 21.6569 4.34315 23 6 23H18C19.6569 23 21 21.6569 21 20V7.82929C22.1652 7.41746 23 6.30622 23 5V4ZM20 6H4C3.44772 6 3 5.55228 3 5V4C3 3.44772 3.44772 3 4 3H20C20.5523 3 21 3.44772 21 4V5C21 5.55228 20.5523 6 20 6ZM5 20V8H19V20C19 20.5523 18.5523 21 18 21H6C5.44772 21 5 20.5523 5 20Z"/></svg></button>
        </div>
        <button class="close" type="button" accesskey="o" title="Close (O)" aria-label="Close">×</button>
      </header>
      <div class="chips" hidden></div>
      <div class="status"><p></p></div>
      <div class="body"></div>`;
    this.#status = root.querySelector('.status');
    this.#statusText = root.querySelector('.status p');
    this.#chips = root.querySelector('.chips');
    this.#body = root.querySelector('.body');
    this.#star = root.querySelector('.star');
    this.#trash = root.querySelector('.trash');
    this.#archive = root.querySelector('.archive');
    this.#star.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.6l2.9 6 6.6.9-4.8 4.6 1.2 6.5-5.9-3.2-5.9 3.2 1.2-6.5-4.8-4.6 6.6-.9z"/></svg>';
    this.#star.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('star', {
        detail: {uid: this.#uid, flagged: !this.#flagged},
        bubbles: true,
        composed: true
      }));
    });
    this.#trash.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('trash', {
        detail: {uid: this.#uid},
        bubbles: true,
        composed: true
      }));
    });
    this.#archive.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('archive', {
        detail: {uid: this.#uid},
        bubbles: true,
        composed: true
      }));
    });
    root.querySelector('.subject').textContent = 'Loading...';
    this.#statusText.textContent = 'Loading...';
    root.querySelector('.close').addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('close', {
        detail: {uid: this.#uid},
        bubbles: true,
        composed: true
      }));
    });
  }

  connectedCallback() {
    this.tabIndex = -1;
  }

  disconnectedCallback() {
    this.#cleanup();
  }

  get uid() {
    return this.#uid;
  }

  set uid(value) {
    this.#uid = value;
  }

  set displayMode(value) {
    this.#displayMode = ['remote', 'block', 'text'].includes(value) ? value : 'block';
  }

  set fontScale(value) {
    const scale = Number(value);
    this.#fontScale = scale > 0 ? scale : 1;
  }

  set flagged(value) {
    this.#flagged = !!value;
    this.#star.setAttribute('aria-pressed', String(this.#flagged));
    this.#star.setAttribute('aria-label', this.#flagged ? 'Unflag message' : 'Flag message');
    this.#star.title = this.#flagged ? 'Unflag (F)' : 'Flag (F)';
  }

  set raw(bytes) {
    const token = ++this.#parseToken;
    (async () => {
      try {
        const email = await postalMime.parse(bytes);
        if (token !== this.#parseToken) {
          return;
        }
        this.#renderEmail(email);
      }
      catch (e) {
        if (token !== this.#parseToken) {
          return;
        }
        this.fail(e?.message || String(e));
      }
    })();
  }

  fail(message) {
    this.#state = 'error';
    this.#error = String(message ?? 'Something went wrong');
    this.#render();
  }

  #cleanup() {
    if (this.#observer) {
      this.#observer.disconnect();
      this.#observer = null;
    }
    for (const url of this.#urls) {
      URL.revokeObjectURL(url);
    }
    this.#urls = [];
  }

  #renderEmail(email) {
    const root = this.shadowRoot;
    root.querySelector('.subject').textContent = email.subject || '(no subject)';
    root.querySelector('.from').textContent = formatAddress(email.from);
    const to = formatAddressList(email.to);
    root.querySelector('.to').textContent = to ? 'to: ' + to : '';
    const d = email.date;
    root.querySelector('.date').textContent = d
      ? dateTimeFormat.format(d instanceof Date ? d : new Date(d))
      : '';

    const attachments = Array.isArray(email.attachments) ? email.attachments : [];
    const cids = new Map();
    const chips = [];
    for (const a of attachments) {
      const contentId = a.contentId ? String(a.contentId).replace(/^<|>$/g, '') : '';
      if (contentId && a.content) {
        const url = URL.createObjectURL(new Blob([a.content], {type: a.mimeType || 'application/octet-stream'}));
        this.#urls.push(url);
        cids.set(contentId, url);
      }
      else {
        chips.push(a);
      }
    }
    this.#chips.replaceChildren(...chips.map(a => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      const size = formatSize(a.size);
      chip.textContent = (a.filename || 'attachment') + (size ? ' - ' + size : '');
      if (a.content) {
        chip.title = chip.textContent + ' - double-click to download';
        chip.style.cursor = 'pointer';
        chip.addEventListener('dblclick', () => this.#download(a));
      }
      else {
        chip.title = chip.textContent;
      }
      return chip;
    }));
    this.#chips.hidden = !chips.length;

    this.#body.replaceChildren();
    const html = typeof email.html === 'string' ? email.html : '';
    if (html && this.#displayMode !== 'text') {
      let content = replaceCids(html, cids);
      if (this.#displayMode !== 'remote') {
        content = injectCsp(stripMetaRefresh(content), BLOCK_CSP);
      }
      content = injectZoom(content, this.#fontScale);
      const iframe = document.createElement('iframe');
      iframe.setAttribute('sandbox', 'allow-same-origin allow-popups');
      iframe.setAttribute('title', 'Email body');
      iframe.addEventListener('load', () => {
        let doc = null;
        try {
          doc = iframe.contentDocument;
        }
        catch {}
        if (!doc) {
          iframe.style.height = '420px';
          return;
        }
        // open links in new tab
        const base = doc.createElement('base');
        base.target = '_blank';
        doc.head.prepend(base);
        // resize
        const measure = () => {
          iframe.style.height = Math.max(120, doc.documentElement.scrollHeight) + 'px';
        };
        measure();
        if (this.#observer) {
          this.#observer.disconnect();
        }
        this.#observer = new ResizeObserver(measure);
        this.#observer.observe(doc.documentElement);
      });
      iframe.srcdoc = content;
      this.#body.append(iframe);
    }
    else {
      const pre = document.createElement('pre');
      pre.textContent = email.text || (html ? '(no plain text version)' : '(empty message)');
      this.#body.append(pre);
    }
    this.#state = 'ready';
    this.#render();
  }

  #download(a) {
    const url = URL.createObjectURL(new Blob([a.content], {type: a.mimeType || 'application/octet-stream'}));
    const link = document.createElement('a');
    link.href = url;
    link.download = a.filename || 'attachment';
    this.shadowRoot.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  #render() {
    const ready = this.#state === 'ready';
    this.#status.hidden = ready;
    this.#status.classList.toggle('error', this.#state === 'error');
    this.#statusText.textContent = ready ? '' : (this.#state === 'error' ? this.#error : 'Loading...');
  }
}

customElements.define('email-view', EmailView);

export {formatAddress, formatAddressList, injectCsp, replaceCids, formatSize};
