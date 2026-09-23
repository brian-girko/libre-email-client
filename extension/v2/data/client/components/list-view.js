import {starColorOf, threadStarColor} from '../star-colors.mjs';
import './star-toggle.js';

const timeFormat = new Intl.DateTimeFormat(undefined, {hour: '2-digit', minute: '2-digit'});
const dayFormat = new Intl.DateTimeFormat(undefined, {month: 'short', day: 'numeric'});
const fullFormat = new Intl.DateTimeFormat(undefined, {year: 'numeric', month: 'short', day: 'numeric'});

function senderName(from) {
  if (!from) {
    return '';
  }
  const s = String(from);
  const lt = s.lastIndexOf('<');
  const gt = s.lastIndexOf('>');
  if (lt > -1 && gt > lt) {
    const name = s.slice(0, lt).trim().replace(/^"+|"+$/g, '').trim();
    return name || s.slice(lt + 1, gt).trim();
  }
  return s.trim();
}

function formatDate(value) {
  if (!value) {
    return '';
  }
  const d = new Date(value);
  if (isNaN(d.getTime())) {
    return '';
  }
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (d >= startOfDay) {
    return timeFormat.format(d);
  }
  if (d.getFullYear() === now.getFullYear()) {
    return dayFormat.format(d);
  }
  return fullFormat.format(d);
}

function hasFlag(flags, name) {
  return Array.isArray(flags) && flags.some(f => String(f).toLowerCase() === name.toLowerCase());
}

// Text comparator: locale compare; empty/missing values always sort last
// regardless of direction; ties broken by the thread's newest UID.
function textComparator(get, desc) {
  const sign = desc ? -1 : 1;
  return (a, b) => {
    const va = get(a);
    const vb = get(b);
    if (!va && !vb) return newestUid(a, desc) - newestUid(b, desc);
    if (!va) return 1;
    if (!vb) return -1;
    return sign * va.localeCompare(vb) || newestUid(a, desc) - newestUid(b, desc);
  };
}

// Numeric comparator (timestamps): missing (null) values always sort last.
function numberComparator(get, desc) {
  const sign = desc ? -1 : 1;
  return (a, b) => {
    const va = get(a);
    const vb = get(b);
    if (va === null && vb === null) return newestUid(a, desc) - newestUid(b, desc);
    if (va === null) return 1;
    if (vb === null) return -1;
    return sign * (va - vb) || newestUid(a, desc) - newestUid(b, desc);
  };
}

// Deterministic tiebreak: equal values order by newest UID — ascending for
// asc sorts, descending for desc sorts (mirrors the value direction).
function newestUid(thread, desc) {
  const uid = thread.uids.length ? thread.uids[thread.uids.length - 1] : 0;
  return desc ? -uid : uid;
}

// Display path for folder pickers: server names join hierarchy levels with
// the server delimiter (usually "."), shown uniformly as "/" instead.
function formatDirPath(name, delimiter) {
  const d = String(delimiter || '');
  return d ? String(name).split(d).join('/') : String(name);
}

class ListView extends HTMLElement {
  #rows = [];
  #selected = new Set();
  #expanded = new Set();
  #mode = 'loading';
  #message = '';
  #status;
  #statusText;
  #retryButton;
  #setupButton;
  #grid;
  #count;
  #note;
  #buttons;
  #filter;
  #clearFilter;
  #sort;
  #sortMode = '';
  #flaggedOnTop = false;
  #filterQuery = '';
  #moveDialog;
  #moveForm;
  #moveMessage;
  #moveTarget;
  #movePending = null;
  #moveQueue = Promise.resolve();
  #afterSaveDialog;
  #afterSaveMessage;
  #afterSaveSub;
  #afterSaveMove;
  #afterSavePending = null;
  #afterSaveQueue = Promise.resolve();
  #purgeDialog;
  #purgeMessage;
  #purgePending = null;
  #purgeQueue = Promise.resolve();
  // per-message save errors (uid -> message) from a native save job; rows
  // carrying one get a visible failure marker until the folder reloads
  #failures = new Map();
  #busy = false;
  #pager = null;
  #pagerEl;
  #pageInfo;
  #pageFirst;
  #pagePrev;
  #pageNext;
  #pageLast;
  #unreadToggle;
  #threadToggle;
  #refreshBtn;
  #unreadOnly = false;
  #threadMode = true;
  #actions;
  #btnsWrap;
  #searchWrap;
  #stacked = false;
  #ro;
  #selectAll;
  // uids of the row last toggled by a plain click; anchor for shift-click
  // range selection
  #lastChecked = null;
  // shiftKey captured from the click that precedes a checkbox change event
  #lastShift = false;

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
          overflow: auto;
          background: var(--pane-bg, #ffffff);
          border: 1px solid var(--line, #d9dce1);
          border-radius: var(--radius, 10px);
          color: var(--fg, #1b1d21);
          font: calc(14px * var(--font-scale, 1))/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
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
        .setup {
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
        .setup:hover {
          border-color: var(--dim, #8a8f98);
        }
        .actions {
          flex: none;
          position: sticky;
          top: 0;
          z-index: 1;
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: calc(6px * var(--font-scale, 1));
          padding: calc(6px * var(--font-scale, 1)) calc(8px * var(--font-scale, 1));
          background: var(--pane-bg, #ffffff);
          border-bottom: 1px solid var(--line, #d9dce1);
          user-select: none;
        }
        .count {
          flex: none;
          align-self: center;
          color: var(--dim, #8a8f98);
          font-size: calc(12px * var(--font-scale, 1));
          min-width: calc(72px * var(--font-scale, 1));
        }
        .all {
          flex: none;
          display: inline-flex;
          align-items: center;
        }
        .all input {
          margin: 0;
          cursor: pointer;
        }
        .btns {
          flex: 1 1 0;
          min-width: 0;
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: calc(6px * var(--font-scale, 1));
        }
        .search {
          flex: none;
          display: flex;
          align-items: center;
          gap: calc(4px * var(--font-scale, 1));
        }
        .action {
          min-height: calc(26px * var(--font-scale, 1));
          padding: calc(2px * var(--font-scale, 1)) calc(12px * var(--font-scale, 1));
          font: inherit;
          font-size: calc(12px * var(--font-scale, 1));
          color: var(--fg, #1b1d21);
          background: none;
          border: 1px solid var(--line, #d9dce1);
          border-radius: var(--radius, 10px);
          cursor: pointer;
          white-space: nowrap;
        }
        .action:hover:not(:disabled) {
          border-color: var(--dim, #8a8f98);
        }
        .action:disabled {
          opacity: 0.5;
          cursor: default;
        }
        .action u {
          text-underline-offset: 2px;
        }
        .btns combo-view button {
          border: none;
          border-radius: 0;
          background: none;
        }
        .action.icon {
          flex: none;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: calc(26px * var(--font-scale, 1));
          min-height: calc(26px * var(--font-scale, 1));
          padding: 0;
        }
        .action.icon svg {
          width: calc(16px * var(--font-scale, 1));
          height: calc(16px * var(--font-scale, 1));
          fill: currentColor;
          stroke: none;
        }
        .action.icon[data-action="spam"] svg {
          fill: none;
          stroke: currentColor;
          stroke-width: 2;
          stroke-linecap: round;
          stroke-linejoin: round;
        }
        .action.icon[data-action="unread-only"] svg {
          fill: none;
          stroke: currentColor;
          stroke-width: 2;
          stroke-linecap: round;
          stroke-linejoin: round;
        }
        .action.icon[data-action="thread-mode"] svg {
          fill: none;
          stroke: currentColor;
          stroke-width: 2;
          stroke-linecap: round;
          stroke-linejoin: round;
        }
        .action.icon[data-action="refresh"] svg {
          fill: none;
          stroke: currentColor;
          stroke-width: 2;
          stroke-linecap: round;
          stroke-linejoin: round;
        }
        .action.icon[aria-pressed="true"] {
          color: var(--accent, AccentColor);
          background: color-mix(in srgb, var(--accent, AccentColor) 18%, transparent);
          border-color: color-mix(in srgb, var(--accent, AccentColor) 55%, transparent);
        }
        .pager {
          display: flex;
          align-items: center;
          gap: 4px;
        }
        .page {
          min-height: 26px;
          min-width: 26px;
          padding: 2px 8px;
          font: inherit;
          font-size: 12px;
          color: var(--fg, #1b1d21);
          background: none;
          border: 1px solid var(--line, #d9dce1);
          border-radius: var(--radius, 10px);
          cursor: pointer;
        }
        .page:hover:not(:disabled) {
          border-color: var(--dim, #8a8f98);
        }
        .page:disabled {
          opacity: 0.5;
          cursor: default;
        }
        .page-info {
          color: var(--dim, #8a8f98);
          font-size: 12px;
          white-space: nowrap;
        }
        .note {
          flex-basis: 100%;
          color: var(--dim, #8a8f98);
          font-size: calc(12px * var(--font-scale, 1));
          overflow-wrap: anywhere;
        }
        .note.error {
          color: light-dark(#b3261e, #f2b8b5);
        }
        .grid {
          flex: 1 0 auto;
          display: grid;
          grid-template-columns: auto auto auto auto auto minmax(0, 1fr) max-content;
          align-content: start;
          align-items: center;
          padding: calc(4px * var(--font-scale, 1));
          user-select: none;
        }
        .row {
          grid-column: 1 / -1;
          display: grid;
          grid-template-columns: subgrid;
          align-items: center;
          min-height: calc(36px * var(--font-scale, 1));
          padding: 0 calc(8px * var(--font-scale, 1)) 0 calc(6px * var(--font-scale, 1));
          border-radius: var(--radius, 10px);
          cursor: default;
        }
        .row.sub {
          min-height: calc(32px * var(--font-scale, 1));
        }
        .row.sub.failed {
          outline: 1px solid light-dark(#b3261e, #f2b8b5);
          outline-offset: -1px;
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
        .row.checked {
          background: var(--bg, #f5f6f8);
        }
        .check {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: calc(22px * var(--font-scale, 1));
          height: calc(26px * var(--font-scale, 1));
        }
        .check input {
          margin: 0;
          cursor: pointer;
        }
        .chev {
          flex: none;
          width: calc(24px * var(--font-scale, 1));
          height: calc(26px * var(--font-scale, 1));
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border: 0;
          padding: 0;
          background: none;
          cursor: pointer;
          color: var(--line, #d9dce1);
        }
        .chev:hover {
          color: var(--dim, #8a8f98);
        }
        .chev svg {
          width: calc(16px * var(--font-scale, 1));
          height: calc(16px * var(--font-scale, 1));
          fill: none;
          stroke: currentColor;
          stroke-width: 1.5;
          stroke-linejoin: round;
        }
        .chev svg {
          transition: transform 0.12s ease;
        }
        .row.expanded .chev svg {
          transform: rotate(90deg);
        }
        .chev-slot {
          width: calc(24px * var(--font-scale, 1));
          flex: none;
        }
        .sender {
          min-width: 0;
          max-width: min-content;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          padding-right: calc(12px * var(--font-scale, 1));
          color: var(--dim, #8a8f98);
        }
        .title {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          padding-right: calc(8px * var(--font-scale, 1));
          color: var(--dim, #8a8f98);
        }
        .tcount {
          color: var(--dim, #6f747d);
          white-space: nowrap;
        }
        .date {
          padding-left: calc(8px * var(--font-scale, 1));
          white-space: nowrap;
          color: var(--dim, #8a8f98);
        }
        .row.unread .sender,
        .row.unread .title,
        .row.unread .date {
          color: var(--fg, #1b1d21);
          font-weight: 600;
        }
        .row.unread .tcount {
          color: var(--fg, #1b1d21);
        }
        .filter {
          width: calc(100px * var(--font-scale, 1));
          min-height: calc(26px * var(--font-scale, 1));
          padding: calc(2px * var(--font-scale, 1)) calc(8px * var(--font-scale, 1));
          font: inherit;
          font-size: calc(12px * var(--font-scale, 1));
          color: var(--fg, #1b1d21);
          background: var(--pane-bg, #ffffff);
          border: 1px solid var(--line, #d9dce1);
          border-radius: var(--radius, 10px);
        }
        .filter::placeholder {
          color: var(--dim, #8a8f98);
        }
        .filter:focus {
          outline: none;
          border-color: var(--dim, #8a8f98);
          field-sizing: content;
          width: auto;
          min-width: calc(100px * var(--font-scale, 1));
          max-width: calc(240px * var(--font-scale, 1));
        }
        .clear-filter {
          flex: none;
          width: calc(22px * var(--font-scale, 1));
          min-height: calc(26px * var(--font-scale, 1));
          margin-left: calc(-4px * var(--font-scale, 1));
          font: inherit;
          font-size: calc(12px * var(--font-scale, 1));
          color: var(--dim, #8a8f98);
          background: none;
          border: 0;
          cursor: pointer;
        }
        .clear-filter:hover {
          color: var(--fg, #1b1d21);
        }
        .sort {
          flex: none;
          min-height: calc(26px * var(--font-scale, 1));
          padding: calc(2px * var(--font-scale, 1)) calc(4px * var(--font-scale, 1));
          font: inherit;
          font-size: calc(12px * var(--font-scale, 1));
          color: var(--fg, #1b1d21);
          background: var(--pane-bg, #ffffff);
          border: 1px solid var(--line, #d9dce1);
          border-radius: var(--radius, 10px);
          cursor: pointer;
        }
        .sort:focus {
          outline: none;
          border-color: var(--dim, #8a8f98);
        }
        .actions.stacked .search {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: calc(4px * var(--font-scale, 1));
        }
        .actions.stacked .sort {
          grid-area: 1 / 1 / 2 / 3;
          width: 100%;
        }
        .actions.stacked .filter {
          width: 100%;
          min-width: 0;
        }
        .actions.stacked .filter:focus {
          field-sizing: fixed;
          width: 100%;
          min-width: 0;
          max-width: none;
        }
        .move-dialog {
          width: min(90vw, 380px);
          padding: calc(18px * var(--font-scale, 1));
          color: var(--fg, #1b1d21);
          background: var(--pane-bg, #ffffff);
          border: 1px solid var(--line, #d9dce1);
          border-radius: var(--radius, 10px);
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
          margin: auto;
        }
        .move-dialog::backdrop {
          background: rgba(0, 0, 0, 0.4);
        }
        .move-dialog form {
          display: flex;
          flex-direction: column;
          gap: calc(12px * var(--font-scale, 1));
          margin: 0;
        }
        .move-dialog .message {
          margin: 0;
          font-size: calc(14px * var(--font-scale, 1));
          overflow-wrap: anywhere;
        }
        .move-dialog select {
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
        .move-dialog select:focus {
          outline: none;
          border-color: var(--dim, #8a8f98);
        }
        .move-dialog .row {
          display: flex;
          justify-content: flex-end;
          gap: calc(8px * var(--font-scale, 1));
        }
        .move-dialog button {
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
        .move-dialog button:hover {
          border-color: var(--dim, #8a8f98);
        }
        .move-dialog .cancel {
          color: var(--dim, #7d828a);
        }
        .move-dialog .submessage {
          margin: 0;
          font-size: calc(12px * var(--font-scale, 1));
          color: var(--dim, #8a8f98);
        }
        .after-save-dialog .delete {
          color: light-dark(#b3261e, #f2b8b5);
        }
        .purge-dialog .danger {
          color: light-dark(#b3261e, #f2b8b5);
        }
      </style>
      <div class="actions" title="Message list — Alt+2 focus · ↑/↓ move · Space check · Enter/double-click preview · Ctrl+A select all">
        <label class="all">
          <input type="checkbox" aria-label="Select all messages" title="Check all; unchecked clears all. Shift-click rows to check a range." hidden>
        </label>
        <span class="count"></span>
        <span class="btns">
          <button class="action icon" type="button" data-action="archive" accesskey="a" title="Archive (A)" aria-label="Archive"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 10C7.44772 10 7 10.4477 7 11C7 11.5523 7.44772 12 8 12H16C16.5523 12 17 11.5523 17 11C17 10.4477 16.5523 10 16 10H8Z"/><path fill-rule="evenodd" clip-rule="evenodd" d="M23 4C23 2.34315 21.6569 1 20 1H4C2.34315 1 1 2.34315 1 4V5C1 6.30622 1.83481 7.41746 3 7.82929V20C3 21.6569 4.34315 23 6 23H18C19.6569 23 21 21.6569 21 20V7.82929C22.1652 7.41746 23 6.30622 23 5V4ZM20 6H4C3.44772 6 3 5.55228 3 5V4C3 3.44772 3.44772 3 4 3H20C20.5523 3 21 3.44772 21 4V5C21 5.55228 20.5523 6 20 6ZM5 20V8H19V20C19 20.5523 18.5523 21 18 21H6C5.44772 21 5 20.5523 5 20Z"/></svg></button>
          <button class="action icon" type="button" data-action="trash" accesskey="t" title="Trash (T)" aria-label="Trash"><svg viewBox="0 0 1024 1024" aria-hidden="true"><path d="M 160,256 H 96 C 78.326876,256 64.000014,241.67311 64.000014,224 64.000014,206.32689 78.326876,192 96,192 H 352 V 95.936 c 0,-17.673112 14.32689,-32 32,-32 h 256 c 17.67311,0 32,14.326888 32,32 V 192 h 256 c 17.67312,0 31.99999,14.32689 31.99999,32 0,17.67311 -14.32687,32 -31.99999,32 h -64 v 672 c 0,17.67311 -14.32689,32 -32,32 H 192 c -17.67311,0 -32,-14.32689 -32,-32 z M 608,192 V 128 H 416 v 64 z M 239.36,880.64 H 784.64 V 271.36 H 239.36 Z M 416,768 c -17.67311,0 -32,-14.32689 -32,-32 V 416 c 0,-17.67312 14.32689,-31.99999 32,-31.99999 17.67311,0 32,14.32687 32,31.99999 v 320 c 0,17.67311 -14.32689,32 -32,32 z m 192,0 c -17.67311,0 -32,-14.32689 -32,-32 V 416 c 0,-17.67312 14.32689,-31.99999 32,-31.99999 17.67311,0 32,14.32687 32,31.99999 v 320 c 0,17.67311 -14.32689,32 -32,32 z"/></svg></button>
          <button class="action icon" type="button" data-action="spam" accesskey="s" title="Spam (S)" aria-label="Spam"><svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="16 3 21 8 21 16 16 21 8 21 3 16 3 8 8 3"/><path d="M12 8v5"/><line x1="12" y1="16" x2="12" y2="16"/></svg></button>
          <button class="action icon" type="button" data-action="move" accesskey="m" title="Move (M)" aria-label="Move"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" d="M 4.1139706,4.8308824 C 3.9819908,4.8308824 3.875,4.9378731 3.875,5.0698529 V 18.930147 c 0,0.131912 0.1070588,0.238971 0.2389706,0.238971 H 19.886029 c 0.13198,0 0.238971,-0.106991 0.238971,-0.238971 V 7.8772794 c 0,-0.1319798 -0.106991,-0.2389706 -0.238971,-0.2389706 H 11.78875 c -0.553658,1.677e-4 -1.071532,-0.2736219 -1.383162,-0.73125 L 9.0635294,4.9360294 C 9.0189217,4.8700335 8.9443628,4.8306033 8.8647059,4.8308824 Z M 2,4.75 C 2,3.784 2.784,3 3.75,3 h 4.971 c 0.58,0 1.12,0.286 1.447,0.765 l 1.404,2.063 c 0.04647,0.068748 0.12402,0.1099591 0.207,0.11 h 8.471 c 0.966,0 1.75,0.783 1.75,1.75 V 19.25 C 22,20.216498 21.216498,21 20.25,21 H 3.75 C 2.7835017,21 2,20.216498 2,19.25 Z"/></svg></button>
          <button class="action icon" type="button" data-action="preview" accesskey="p" title="Preview (P)" aria-label="Preview"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M 4,3 C 2.9,3 2,3.9 2,5 v 14 c 0,1.1 0.9,2 2,2 h 16 c 1.1,0 2,-0.9 2,-2 V 5 C 22,3.9 21.1,3 20,3 Z M 4,5 H 20 V 19 H 4 Z m 8,3 c -3.3,0 -6,3.3 -6,4 0,0.7 2.7,4 6,4 3.3,0 6,-3.5 6,-4 0,-0.5 -2.7,-4 -6,-4 z m 0,1.5 V 11 c 0,0.6 0.4,1 1,1 h 1.5 c 0,1.6 -1.5,2.8 -3.2,2.4 C 10.5,14.2 9.8,13.5 9.5,12.6 9.2,11 10.4,9.5 12,9.5 Z"/></svg></button>
          <button class="action icon" type="button" data-action="unread-only" accesskey="n" title="Show unread only (N)" aria-label="Show unread only" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.8874 5.17157C7.46546 4.59351 7.75449 4.30448 8.12203 4.15224C8.48957 4 8.89832 4 9.71582 4H14.326C15.1517 4 15.5646 4 15.9351 4.15505C16.3056 4.31011 16.5954 4.60419 17.175 5.19234L18.849 6.89105C19.4171 7.46745 19.7011 7.75566 19.8505 8.12024C20 8.48482 20 8.88945 20 9.69871V14.3431C20 15.1606 20 15.5694 19.8478 15.9369C19.6955 16.3045 19.4065 16.5935 18.8284 17.1716L17.1716 18.8284C16.5935 19.4065 16.3045 19.6955 15.9369 19.8478C15.5694 20 15.1606 20 14.3431 20H9.69871C8.88945 20 8.48482 20 8.12024 19.8505C7.75566 19.7011 7.46745 19.4171 6.89105 18.849L5.19235 17.175C4.60419 16.5954 4.31011 16.3056 4.15505 15.9351C4 15.5646 4 15.1517 4 14.326V9.71583C4 8.89832 4 8.48957 4.15224 8.12203C4.30448 7.75449 4.59351 7.46546 5.17157 6.8874L6.8874 5.17157Z"/><path d="M8 11L8.42229 11.2111C10.6745 12.3373 13.3255 12.3373 15.5777 11.2111L16 11"/><path d="M12 12.5V14"/><path d="M9 12L8.5 13"/><path d="M15 12L15.5 13"/></svg></button>
          <button class="action icon" type="button" data-action="thread-mode" accesskey="r" title="Show single messages (R)" aria-label="Show single messages" aria-pressed="true"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 15h13.01m0 0a6 6 0 0 1-5.23-3.058l-1.06-1.884A6 6 0 0 0 4.49 7H3m13.01 8H21m0 0-3 3m3-3-3-3"/></svg></button>
          <button class="action icon" type="button" data-action="refresh" title="Refresh (re-read from local copy)" aria-label="Refresh list from the local copy"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg></button>
          <combo-view label="Mark as" type="button">
            <button data-action="mark-read" accesskey="r"><u>r</u>ead</button>
            <button data-action="mark-unread" accesskey="u"><u>u</u>nread</button>
          </combo-view>
          <span class="pager" hidden>
            <button class="page" type="button" data-page="first" title="First page" aria-label="First page">«</button>
            <button class="page" type="button" data-page="-1" title="Previous page" aria-label="Previous page">‹</button>
            <span class="page-info"></span>
            <button class="page" type="button" data-page="1" title="Next page" aria-label="Next page">›</button>
            <button class="page" type="button" data-page="last" title="Last page" aria-label="Last page">»</button>
          </span>
        </span>
        <span class="search">
          <input class="filter" type="text" role="searchbox" placeholder="Match…"
                 aria-label="Select matching messages" spellcheck="false" autocomplete="off">
          <button class="clear-filter" type="button" hidden title="Clear filter"
                  aria-label="Clear selection filter">✕</button>
          <select class="sort" aria-label="Sort conversations" title="Sort conversations (current view only)">
            <option value="">Newest first</option>
            <option value="date-asc">Date oldest first</option>
            <option value="subject-asc">Subject A→Z</option>
            <option value="subject-desc">Subject Z→A</option>
            <option value="sender-asc">Sender A→Z</option>
            <option value="sender-desc">Sender Z→A</option>
          </select>
        </span>
        <span class="note" hidden></span>
      </div>
      <div class="status" title="Message list — Alt+2 focus · ↑/↓ move · Space check · Enter/double-click preview · Ctrl+A select all">
        <p></p>
        <button class="retry" type="button" hidden>Retry</button>
        <button class="setup" type="button" hidden>Run Setup</button>
      </div>
      <div class="grid" title="Message list — Alt+2 focus · ↑/↓ move · Space check · Enter/double-click preview · Ctrl+A select all" hidden></div>
      <dialog class="move-dialog">
        <form>
          <p class="message"></p>
          <select class="move-target"></select>
          <div class="row">
            <button type="button" class="cancel">Cancel</button>
            <button class="ok">Move</button>
          </div>
        </form>
      </dialog>
      <dialog class="move-dialog after-save-dialog">
        <form>
          <p class="message"></p>
          <p class="submessage"></p>
          <div class="row">
            <button type="button" class="cancel">Do nothing</button>
            <button type="button" class="delete">Delete locally</button>
            <button class="ok">Move</button>
          </div>
        </form>
      </dialog>
      <dialog class="move-dialog purge-dialog">
        <form>
          <p class="message"></p>
          <p class="submessage">The files are removed from disk — the server
            copies are purged at the next sync.</p>
          <div class="row">
            <button type="button" class="cancel">Cancel</button>
            <button type="submit" class="danger">Delete permanently</button>
          </div>
        </form>
      </dialog>`;
    this.#status = root.querySelector('.status');
    this.#statusText = root.querySelector('.status p');
    this.#retryButton = root.querySelector('.retry');
    this.#setupButton = root.querySelector('.setup');
    this.#grid = root.querySelector('.grid');
    this.#count = root.querySelector('.count');
    this.#selectAll = root.querySelector('.all input');
    this.#note = root.querySelector('.note');
    this.#buttons = [...root.querySelectorAll('[data-action]')].filter(button => button.dataset.action !== 'unread-only' && button.dataset.action !== 'thread-mode' && button.dataset.action !== 'refresh');
    this.#unreadToggle = root.querySelector('[data-action="unread-only"]');
    this.#threadToggle = root.querySelector('[data-action="thread-mode"]');
    this.#refreshBtn = root.querySelector('[data-action="refresh"]');
    this.#filter = root.querySelector('.filter');
    this.#clearFilter = root.querySelector('.clear-filter');
    this.#sort = root.querySelector('.sort');
    this.#actions = root.querySelector('.actions');
    this.#btnsWrap = root.querySelector('.btns');
    this.#searchWrap = root.querySelector('.search');
    this.#ro = new ResizeObserver(() => this.#syncStacked());
    this.#moveDialog = root.querySelector('.move-dialog');
    this.#moveForm = this.#moveDialog.querySelector('form');
    this.#moveMessage = this.#moveDialog.querySelector('.message');
    this.#moveTarget = this.#moveDialog.querySelector('.move-target');
    this.#afterSaveDialog = root.querySelector('.after-save-dialog');
    this.#afterSaveMessage = this.#afterSaveDialog.querySelector('.message');
    this.#afterSaveSub = this.#afterSaveDialog.querySelector('.submessage');
    this.#afterSaveMove = this.#afterSaveDialog.querySelector('.ok');
    this.#purgeDialog = root.querySelector('.purge-dialog');
    this.#purgeMessage = this.#purgeDialog.querySelector('.message');
    this.#pagerEl = root.querySelector('.pager');
    this.#pageInfo = root.querySelector('.page-info');
    this.#pageFirst = root.querySelector('.page[data-page="first"]');
    this.#pagePrev = root.querySelector('.page[data-page="-1"]');
    this.#pageNext = root.querySelector('.page[data-page="1"]');
    this.#pageLast = root.querySelector('.page[data-page="last"]');
    for (const [button, type] of [
      [this.#pageFirst, 'page-first'],
      [this.#pagePrev, 'page-prev'],
      [this.#pageNext, 'page-next'],
      [this.#pageLast, 'page-last']
    ]) {
      button.addEventListener('click', () => {
        if (button.disabled) {
          return;
        }
        this.dispatchEvent(new CustomEvent(type, {
          bubbles: true,
          composed: true
        }));
      });
    }
    this.#retryButton.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('retry', {bubbles: true, composed: true}));
    });
    this.#setupButton.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('open-setup', {bubbles: true, composed: true}));
    });
    for (const button of this.#buttons) {
      button.addEventListener('click', () => {
        if (!this.#selected.size || this.#busy) {
          return;
        }
        this.dispatchEvent(new CustomEvent(button.dataset.action, {
          detail: {uids: [...this.#selected]},
          bubbles: true,
          composed: true
        }));
      });
    }
    // view toggle: independent of the selection, always clickable
    this.#unreadToggle.addEventListener('click', () => {
      this.unreadOnly = !this.#unreadOnly;
    });
    // thread-mode toggle: independent of the selection, always clickable
    this.#threadToggle.addEventListener('click', () => {
      this.threadMode = !this.#threadMode;
    });
    // refresh: independent of the selection, always clickable
    this.#refreshBtn.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('refresh', {
        bubbles: true,
        composed: true
      }));
    });
    this.#filter.addEventListener('input', () => this.#applyFilter(this.#filter.value));
    this.#clearFilter.addEventListener('click', () => {
      this.#filter.value = '';
      this.#applyFilter('');
      this.#filter.focus();
    });
    this.#filter.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.#filter.value = '';
        this.#applyFilter('');
        this.#grid?.focus();
      }
      else if (e.key === 'Enter' && this.#selected.size) {
        e.preventDefault();
        this.dispatchEvent(new CustomEvent('preview', {
          detail: {uids: [...this.#selected]},
          bubbles: true,
          composed: true
        }));
      }
    });
    this.#sort.addEventListener('change', () => {
      this.sortMode = this.#sort.value;
      this.dispatchEvent(new CustomEvent('sort-changed', {
        detail: {mode: this.#sortMode},
        bubbles: true,
        composed: true
      }));
    });
    // destination picker dialog: one request at a time; native cancel (Esc)
    // and any other close path resolve as cancelled
    this.#moveForm.addEventListener('submit', e => {
      e.preventDefault();
      if (this.#movePending) {
        const target = this.#moveTarget.value;
        this.#settleMove(target || null);
      }
    });
    this.#moveDialog.addEventListener('cancel', e => {
      e.preventDefault();
      this.#settleMove(null);
    });
    this.#moveDialog.addEventListener('close', () => {
      if (this.#movePending) {
        this.#settleMove(null);
      }
    });
    this.#moveDialog.querySelector('.cancel').addEventListener('click', () => {
      this.#settleMove(null);
    });
    // after-save choice dialog: same one-request-at-a-time pattern; Esc and
    // every other close path resolve as "do nothing"
    this.#afterSaveDialog.querySelector('.cancel').addEventListener('click', () => {
      this.#settleAfterSave(null);
    });
    this.#afterSaveDialog.querySelector('.delete').addEventListener('click', () => {
      this.#settleAfterSave('deleted');
    });
    this.#afterSaveDialog.querySelector('form').addEventListener('submit', e => {
      e.preventDefault();
      this.#settleAfterSave('move');
    });
    this.#afterSaveDialog.addEventListener('cancel', e => {
      e.preventDefault();
      this.#settleAfterSave(null);
    });
    this.#afterSaveDialog.addEventListener('close', () => {
      if (this.#afterSavePending) {
        this.#settleAfterSave(null);
      }
    });
    // permanent-delete confirm (Trash pressed inside the trash folder):
    // same one-request-at-a-time pattern; Esc and every other close path
    // resolve as "cancel"
    this.#purgeDialog.querySelector('.cancel').addEventListener('click', () => {
      this.#settlePurge(false);
    });
    this.#purgeDialog.querySelector('form').addEventListener('submit', e => {
      e.preventDefault();
      this.#settlePurge(true);
    });
    this.#purgeDialog.addEventListener('cancel', e => {
      e.preventDefault();
      this.#settlePurge(false);
    });
    this.#purgeDialog.addEventListener('close', () => {
      if (this.#purgePending) {
        this.#settlePurge(false);
      }
    });
    // global select-all: on when anything is checked and not everything is,
    // on-click clears; when nothing is checked, on-click checks all visible
    this.#selectAll.addEventListener('change', () => {
      this.#toggleAll();
    });
    this.addEventListener('keydown', e => {
      // typing in the filter box is text editing, not list navigation; the
      // native select owns its own arrow/type-ahead keys
      const target = e.composedPath()[0];
      if (target === this.#filter || target === this.#sort) {
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && String(e.key).toLowerCase() === 'a') {
        if (this.#mode === 'ready' && this.#rows.length) {
          e.preventDefault();
          this.selectAll();
        }
      }
      else if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        this.#filter.focus();
      }
      else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.defaultPrevented) {
        if (this.#mode !== 'ready' || !this.#rows.length) {
          return;
        }
        e.preventDefault();
        const rows = [...this.#grid.querySelectorAll('.row')];
        const anchor = this.shadowRoot.activeElement?.closest('.row');
        const idx = rows.indexOf(anchor);
        const step = e.key === 'ArrowDown' ? 1 : -1;
        const start = idx === -1 ? (e.key === 'ArrowDown' ? -1 : rows.length) : idx;
        rows[start + step]?.focus();
      }
    });
  }

  connectedCallback() {
    this.#ro.observe(this.#btnsWrap);
    this.#ro.observe(this.#searchWrap);
  }

  disconnectedCallback() {
    this.#ro.disconnect();
  }

  // When on (default), conversations are grouped into thread rows; when off,
  // every message renders as its own flat single-message row. Persistence is
  // the host's job via the "thread-changed" event.
  get threadMode() {
    return this.#threadMode;
  }

  set threadMode(on) {
    const next = !!on;
    this.#threadToggle.setAttribute('aria-pressed', String(next));
    if (this.#threadMode === next) {
      return;
    }
    this.#threadMode = next;
    this.#render();
    this.dispatchEvent(new CustomEvent('thread-changed', {
      detail: {on: next},
      bubbles: true,
      composed: true
    }));
  }

  // Map server threads into the rows the view builds on. Thread mode keeps
  // them as-is; flat mode reshapes each thread into one pseudo-row per
  // message (single-message "conversation"), so all selection, action,
  // filter and rollback logic below works unchanged on both shapes.
  #flatten(rows) {
    if (this.#threadMode) {
      return rows;
    }
    const out = [];
    for (const thread of Array.isArray(rows) ? rows : []) {
      const messages = Array.isArray(thread?.messages) ? thread.messages : [];
      if (!messages.length) {
        out.push(thread);
        continue;
      }
      for (const item of messages) {
        const flags = Array.isArray(item.flags) ? item.flags.map(String) : [];
        out.push({
          uids: [Number(item.uid)],
          messages: [item],
          count: 1,
          unread: flags.includes('\\Seen') ? 0 : 1,
          flagged: flags.includes('\\Flagged'),
          subject: item.subject || thread.subject || '',
          from: item.from || thread.from || '',
          date: item.date || thread.date || ''
        });
      }
    }
    return out;
  }

  build(rows) {
    this.#rows = this.#flatten(rows);
    this.#selected = new Set();
    this.#expanded = new Set();
    this.#lastChecked = null;
    this.#mode = 'ready';
    this.#message = '';
    this.busy(false);
    this.status('');
    // the filter query survives page changes and folder reloads; the checked
    // set is re-derived from it so selection == matches stays true
    this.#applyFilter(this.#filter.value);
  }

  // Reconcile the list with a fresh server snapshot without resetting the
  // view: new conversations appear, vanished ones are dropped, survivors are
  // re-rendered. Selection (the user's, when no filter query is active),
  // expansion and the scroll position survive; no loading state is shown.
  sync(rows) {
    const next = Array.isArray(rows) ? rows : [];
    const oldUids = new Set();
    for (const thread of this.#rows) {
      for (const uid of thread.uids) {
        oldUids.add(Number(uid));
      }
    }
    const present = new Set();
    for (const thread of next) {
      for (const uid of thread.uids) {
        present.add(Number(uid));
      }
    }
    const gone = [...oldUids].filter(uid => !present.has(uid));
    this.#selected = new Set([...this.#selected].filter(uid => present.has(Number(uid))));
    const keys = new Set(next.map(thread => thread.uids[0]));
    this.#expanded = new Set([...this.#expanded].filter(key => keys.has(key)));
    this.#rows = this.#flatten(next);
    this.#mode = 'ready';
    this.#message = '';
    const scrollTop = this.scrollTop;
    // With an active selection filter, checked == matches must stay true, so
    // re-derive the selection from the query; otherwise keep it and render.
    if (this.#filterQuery) {
      this.#applyFilter(this.#filterQuery);
    }
    else {
      this.#rerenderKeepingFocus();
    }
    this.scrollTop = scrollTop;
    if (gone.length) {
      this.dispatchEvent(new CustomEvent('email-gone', {
        detail: {uids: gone},
        bubbles: true,
        composed: true
      }));
    }
  }

  // Active sort mode ("" = natural newest-first). Setting it syncs the
  // toolbar select and re-renders; persistence is the host's job (the
  // component stays chrome-free) via the "sort-changed" event.
  get sortMode() {
    return this.#sortMode;
  }

  set sortMode(mode) {
    const known = ['', 'date-asc', 'subject-asc', 'subject-desc', 'sender-asc', 'sender-desc'];
    this.#sortMode = known.includes(mode) ? mode : '';
    this.#sort.value = this.#sortMode;
    this.#render();
  }

  // When on, flagged conversations always sort above unflagged ones (the
  // active sort runs once per partition).
  get flaggedOnTop() {
    return this.#flaggedOnTop;
  }

  set flaggedOnTop(on) {
    const next = !!on;
    if (this.#flaggedOnTop === next) {
      return;
    }
    this.#flaggedOnTop = next;
    this.#render();
  }

  // When on, the list shows only conversations with unread messages (read
  // ones are hidden), and expanded conversations only their unread
  // messages. Purely view-local: #rows keeps everything, so turning the
  // toggle off (or a flag rollback) brings rows back. Persistence is the
  // host's job via the "unread-changed" event.
  get unreadOnly() {
    return this.#unreadOnly;
  }

  set unreadOnly(on) {
    const next = !!on;
    this.#unreadToggle.setAttribute('aria-pressed', String(next));
    if (this.#unreadOnly === next) {
      return;
    }
    this.#unreadOnly = next;
    this.#render();
    this.dispatchEvent(new CustomEvent('unread-changed', {
      detail: {on: next},
      bubbles: true,
      composed: true
    }));
  }

  // Ask for a move destination with a modal folder picker.
  // dirs: [{name, delimiter, attrs}] as delivered by api.listDirs();
  // resolves the picked folder name, or null when cancelled. Mailboxes with
  // \NoSelect cannot receive mail and are omitted; the current folder is
  // disabled (moving onto itself would lose mail).
  askDestination(dirs, {current = null, count = 0} = {}) {
    // prompts from concurrent jobs queue up instead of resolving null
    const turn = this.#moveQueue.then(() => new Promise(resolve => {
      let list;
      if (this.#movePending) {
        resolve(null);
        return;
      }
      list = (Array.isArray(dirs) ? dirs : [])
        .filter(d => d && d.name && !hasFlag(d.attrs, '\\NoSelect'))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      if (!list.length) {
        resolve(null);
        return;
      }
      this.#moveMessage.textContent = count
        ? 'Move ' + count + (count === 1 ? ' message' : ' messages') + ' to:'
        : 'Move messages to:';
      this.#moveTarget.replaceChildren(...list.map(dir => {
        const opt = document.createElement('option');
        opt.value = dir.name;
        opt.textContent = formatDirPath(dir.name, dir.delimiter);
        if (dir.name === current) {
          opt.disabled = true;
          opt.textContent += ' (current)';
        }
        return opt;
      }));
      this.#moveTarget.value = list.find(d => d.name !== current)?.name ?? '';
      this.#movePending = resolve;
      this.#moveDialog.showModal();
      this.#moveTarget.focus();
    }));
    this.#moveQueue = turn.then(() => {}, () => {});
    return turn;
  }

  #settleMove(result) {
    const resolve = this.#movePending;
    if (!resolve) {
      return;
    }
    this.#movePending = null;
    if (this.#moveDialog.open) {
      this.#moveDialog.close();
    }
    resolve(typeof result === 'string' && result ? result : null);
    this.#grid?.focus({preventScroll: true});
  }

  // Ask what to do with the originals after a native save (the "Actions"
  // override ran without its delete checkbox). Resolves 'deleted' (the local
  // copies are purged from the maildir now — the sync engine replays the
  // removals as server purges at the next sync, behind sync's purge confirm),
  // 'move' (local move into the server's special folder, same replay) or
  // null when dismissed; the copies on disk stay untouched either way.
  // {move: false} hides the move choice (originals already sit in the
  // target folder, e.g. Trash pressed inside the trash).
  askAfterSave(count, label, {move = true} = {}) {
    // prompts from concurrent save jobs queue up instead of resolving null
    const turn = this.#afterSaveQueue.then(() => new Promise(resolve => {
      if (this.#afterSavePending) {
        resolve(null);
        return;
      }
      this.#afterSaveMessage.textContent =
        'Saved ' + count + (count === 1 ? ' message' : ' messages') + ' to disk.';
      this.#afterSaveSub.textContent =
        'What should happen to the original copies? "Delete" removes them from the maildir now ' +
        '(the server purge replays at the next sync); "Move" stages them into this server\u2019s ' +
        label + ' folder instead.';
      this.#afterSaveMove.textContent = 'Move to ' + label;
      this.#afterSaveMove.hidden = !move;
      this.#afterSavePending = resolve;
      this.#afterSaveDialog.showModal();
      (move ? this.#afterSaveMove : this.#afterSaveDialog.querySelector('.delete')).focus();
    }));
    this.#afterSaveQueue = turn.then(() => {}, () => {});
    return turn;
  }

  #settleAfterSave(result) {
    const resolve = this.#afterSavePending;
    if (!resolve) {
      return;
    }
    this.#afterSavePending = null;
    if (this.#afterSaveDialog.open) {
      this.#afterSaveDialog.close();
    }
    resolve(result === 'deleted' || result === 'move' ? result : null);
    this.#grid?.focus({preventScroll: true});
  }

  // Permanent-delete warning for Trash pressed inside the trash folder.
  // Resolves true (delete the local files) or false (cancelled).
  confirmPurge(count, label) {
    // prompts from concurrent purge jobs queue up instead of resolving false
    const turn = this.#purgeQueue.then(() => new Promise(resolve => {
      this.#purgeMessage.textContent =
        'Permanently delete ' + count + (count === 1 ? ' message' : ' messages') +
        ' from the ' + label + ' folder?';
      this.#purgePending = resolve;
      this.#purgeDialog.showModal();
      this.#purgeDialog.querySelector('.danger').focus();
    }));
    this.#purgeQueue = turn.then(() => {}, () => {});
    return turn;
  }

  #settlePurge(result) {
    const resolve = this.#purgePending;
    if (!resolve) {
      return;
    }
    this.#purgePending = null;
    if (this.#purgeDialog.open) {
      this.#purgeDialog.close();
    }
    this.#grid?.focus({preventScroll: true});
    resolve(result === true);
  }

  loading(message = 'Loading emails...') {
    this.#mode = 'loading';
    this.#message = String(message);
    this.#failures.clear();
    this.#render();
    this.#clearFilter.hidden = !this.#filter.value;
  }

  error(message) {
    this.#mode = 'error';
    this.#message = String(message ?? 'Something went wrong');
    this.#render();
    this.#clearFilter.hidden = !this.#filter.value;
  }

  // Error screen with a "Run Setup" offer instead of Retry: shown when the
  // folder load failed because there is no usable bridge (no remote ws
  // server configured and no native client) and the account list is empty,
  // so no account can be fixed either — exactly the condition the setup
  // popup fixes.
  setupNeeded(message) {
    this.#mode = 'setup';
    this.#message = String(message ?? 'Setup is not finished');
    this.#render();
    this.#clearFilter.hidden = !this.#filter.value;
  }

  busy(on) {
    const next = !!on;
    if (this.#busy === next) {
      return;
    }
    this.#busy = next;
    if (next) {
      this.#note.hidden = true;
    }
    this.#updateActions();
  }

  status(message, isError = false) {
    this.#note.textContent = message ? String(message) : '';
    this.#note.hidden = !message;
    this.#note.classList.toggle('error', !!isError);
  }

  setPager(pager) {
    this.#pager = pager && Number.isInteger(pager.page) && pager.pageSize > 0
      ? {page: pager.page, pageSize: pager.pageSize, total: Number(pager.total) || 0}
      : null;
    this.#updatePager();
  }

  #updatePager() {
    const info = this.#mode === 'ready' && this.#pager ? this.#pager : null;
    const pages = info ? Math.max(1, Math.ceil(info.total / info.pageSize)) : 1;
    this.#pagerEl.hidden = !info || info.total <= info.pageSize;
    this.#pageInfo.textContent = info ? (info.page + 1) + '/' + pages : '';
    this.#pageFirst.disabled = !info || info.page <= 0 || this.#busy;
    this.#pagePrev.disabled = !info || info.page <= 0 || this.#busy;
    this.#pageNext.disabled = !info || info.page + 1 >= pages || this.#busy;
    this.#pageLast.disabled = !info || info.page + 1 >= pages || this.#busy;
  }

  // When the action buttons need more than one row the toolbar is too narrow
  // for the horizontal search group, so it switches to a vertical layout
  // (sort select on top, match input below). Leaving stacked mode is checked
  // with the search back at its horizontal width, so the toggle cannot
  // oscillate at the width where the buttons just barely fit.
  #syncStacked() {
    const kids = [...this.#btnsWrap.children].filter(el => !el.hidden);
    const wrapped = kids.length > 1 && kids.some(el => el.offsetTop > kids[0].offsetTop + 1);
    if (wrapped) {
      if (!this.#stacked) {
        this.#stacked = true;
        this.#actions.classList.add('stacked');
      }
      return;
    }
    if (!this.#stacked) {
      return;
    }
    // buttons fit on one row while stacked; keep stacking only if they would
    // wrap again with the search back at its horizontal width
    this.#actions.classList.remove('stacked');
    if (kids.some(el => el.offsetTop > kids[0].offsetTop + 1)) {
      this.#actions.classList.add('stacked');
    }
    else {
      this.#stacked = false;
    }
  }

  applyFlags(uids, addFlags, removeFlags) {
    const add = Array.isArray(addFlags) ? addFlags.map(String) : [];
    const remove = Array.isArray(removeFlags) ? removeFlags.map(String) : [];
    const wanted = new Set((Array.isArray(uids) ? uids : []).map(Number));
    const touched = [];
    for (const thread of this.#rows) {
      let hit = false;
      for (const item of thread.messages) {
        if (!wanted.has(Number(item.uid))) {
          continue;
        }
        hit = true;
        const flags = new Set((Array.isArray(item.flags) ? item.flags : []).map(String));
        for (const flag of add) {
          flags.add(flag);
        }
        for (const flag of remove) {
          flags.delete(flag);
        }
        item.flags = [...flags];
      }
      if (!hit) {
        continue;
      }
      touched.push(...thread.messages.filter(m => wanted.has(Number(m.uid))).map(m => m.uid));
      thread.unread = thread.messages.filter(m => !hasFlag(m.flags, '\\Seen')).length;
      thread.flagged = thread.messages.some(m => hasFlag(m.flags, '\\Flagged'));
      this.#syncThreadDom(thread);
    }
    if (touched.length && this.#unreadOnly) {
      // messages just marked read must drop out of the unread-only view at
      // once (and come back on rollback); #rows keeps them either way
      this.#rerenderKeepingFocus();
    }
    if (touched.length) {
      this.dispatchEvent(new CustomEvent('flags-applied', {
        detail: {uids: touched},
        bubbles: true,
        composed: true
      }));
    }
  }

  #syncThreadDom(thread) {
    const key = thread.uids[0];
    const row = this.#grid.querySelector('.row.thread[data-key="' + key + '"]');
    if (row) {
      row.classList.toggle('unread', thread.unread > 0);
      const star = row.querySelector('.star');
      if (star) {
        star.color = threadStarColor(thread.messages);
      }
      const tcount = row.querySelector('.tcount');
      if (tcount && thread.count > 1) {
        tcount.textContent = thread.unread + '/' + thread.count;
        tcount.setAttribute('aria-label', thread.unread + ' unread of ' + thread.count + ' messages in conversation');
      }
    }
    for (const item of thread.messages) {
      const sub = this.#grid.querySelector('.row.sub[data-uid="' + item.uid + '"]');
      if (sub) {
        sub.classList.toggle('unread', !hasFlag(item.flags, '\\Seen'));
        const star = sub.querySelector('.star');
        if (star) {
          star.color = starColorOf(item.flags);
        }
      }
    }
  }

  isFlagged(uid) {
    const item = this.#findMsg(uid);
    return !!item && hasFlag(item.flags, '\\Flagged');
  }

  starColor(uid) {
    const item = this.#findMsg(uid);
    return item ? starColorOf(item.flags) : 0;
  }

  isRead(uid) {
    const item = this.#findMsg(uid);
    return !!item && hasFlag(item.flags, '\\Seen');
  }

  #findMsg(uid) {
    for (const thread of this.#rows) {
      for (const item of thread.messages) {
        if (Number(item.uid) === Number(uid)) {
          return item;
        }
      }
    }
    return null;
  }

  // Mark rows whose native save failed: the message stays visible (it is
  // still on the server) and gets tagged with the reason.
  markRowError(uids, message) {
    const wanted = (Array.isArray(uids) ? uids : []).map(Number);
    let visible = false;
    for (const uid of wanted) {
      this.#failures.set(uid, String(message ?? 'save failed'));
      const row = this.#grid.querySelector('.row.sub[data-uid="' + uid + '"]');
      if (row) {
        this.#applyFailure(row, uid, false);
      }
    }
    // rows may be hidden (collapsed thread, unseen-only view): rebuild and
    // #msgRow re-applies the stored marker
    if (this.#mode === 'ready' && wanted.some(uid =>
      !this.#grid.querySelector('.row.sub[data-uid="' + uid + '"]'))) {
      this.#rerenderKeepingFocus();
    }
  }

  #applyFailure(row, uid, fromRender) {
    const message = this.#failures.get(Number(uid));
    if (message == null) {
      return;
    }
    row.classList.add('failed');
    if (!fromRender) {
      // rerender-safe: #msgRow also sets it for rows built later
      row.title = (row.title ? row.title + ' — ' : '') + 'Save failed: ' + message;
    }
    else {
      row.title = 'Save failed: ' + message;
    }
  }

  // Replace the whole selection with exactly the given uids: everything
  // previously checked is unchecked, the given uids are checked. Used by
  // double-click/Enter so the open/previewed email is also the only one
  // selected.
  #selectOnly(uids) {
    this.#selected = new Set((Array.isArray(uids) ? uids : []).map(Number));
    for (const row of this.#grid.querySelectorAll('.row')) {
      const rowUids = row.classList.contains('thread')
        ? String(row.dataset.uids || '').split(',').filter(Boolean).map(Number)
        : [Number(row.dataset.uid)];
      const checked = rowUids.length > 0 && rowUids.every(uid => this.#selected.has(uid));
      row.classList.toggle('checked', checked);
      row.setAttribute('aria-selected', String(checked));
      const input = row.querySelector('input');
      if (input) {
        input.checked = checked;
      }
    }
    this.status('');
    this.#updateActions();
  }

  // Open/preview: one or several messages (a whole conversation) as cards in
  // the preview pane. First the selection collapses to exactly these uids
  // (everything previously checked is unchecked), then the host marks them
  // read and shows them.
  #open(uids) {
    this.#selectOnly(uids);
    this.dispatchEvent(new CustomEvent('preview', {
      detail: {uids: [...uids]},
      bubbles: true,
      composed: true
    }));
  }

  #toggleExpand(thread, row) {
    if (thread.count < 2) {
      return;
    }
    const key = thread.uids[0];
    if (this.#expanded.has(key)) {
      this.#expanded.delete(key);
    }
    else {
      this.#expanded.add(key);
    }
    row.classList.toggle('expanded', this.#expanded.has(key));
    row.setAttribute('aria-expanded', String(this.#expanded.has(key)));
    this.#render();
    const again = this.#grid.querySelector('.row.thread[data-key="' + key + '"]');
    again?.focus({preventScroll: true});
  }

  // Selection filter: the checked set always equals "the rows matching the
  // query". Terms are space-separated and all must match (AND), against the
  // decoded sender/subject of the thread or of any of its messages. A
  // matching thread selects the whole conversation; an empty query clears
  // the selection.
  #applyFilter(query) {
    this.#filterQuery = String(query ?? '');
    this.#clearFilter.hidden = !this.#filterQuery;
    if (this.#mode !== 'ready') {
      return;
    }
    const terms = this.#filterQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
    this.#selected = new Set();
    if (terms.length) {
      for (const thread of this.#rows) {
        if (this.#threadMatches(thread, terms)) {
          for (const uid of thread.uids) {
            this.#selected.add(uid);
          }
        }
      }
    }
    this.#render();
  }

  #threadMatches(thread, terms) {
    const level = [thread.subject, thread.from];
    return terms.every(term => {
      if (level.some(t => this.#contains(t, term))) {
        return true;
      }
      // a message-level hit pulls in the whole conversation
      return thread.messages.some(m => this.#contains(m.subject, term) || this.#contains(m.from, term));
    });
  }

  #contains(text, term) {
    return !!text && String(text).toLowerCase().includes(term);
  }

  selectAll() {
    if (this.#mode !== 'ready') {
      return;
    }
    for (const thread of this.#rows) {
      for (const item of thread.messages) {
        this.#selected.add(item.uid);
      }
    }
    this.#lastChecked = null;
    this.#render();
    this.#updateActions();
  }

  // Toolbar select-all: acts on the rows currently visible. Checking checks
  // every visible message; unchecking (any click while some are checked)
  // clears the whole selection.
  #toggleAll() {
    if (this.#mode !== 'ready') {
      return;
    }
    const visible = this.#visibleRows();
    const anyChecked = visible.some(thread => thread.messages.some(item => this.#selected.has(item.uid)));
    if (anyChecked) {
      this.#selected = new Set();
    }
    else {
      for (const thread of visible) {
        for (const item of thread.messages) {
          this.#selected.add(item.uid);
        }
      }
    }
    this.#lastChecked = null;
    this.#rerenderKeepingFocus();
    this.status('');
    this.#updateActions();
  }

  // Selected set of every visible message uid; drives the toolbar checkbox.
  #visibleUids() {
    const uids = [];
    for (const thread of this.#visibleRows()) {
      for (const item of thread.messages) {
        uids.push(item.uid);
      }
    }
    return uids;
  }

  #updateActions() {
    const ready = this.#mode === 'ready';
    const count = this.#selected.size;
    // Action buttons stay enabled while background jobs run so the user can
    // chain more actions; only a not-ready list disables them now. `#busy`
    // still gates the pager during a folder load.
    const enabled = ready && count > 0;
    for (const button of this.#buttons) {
      button.disabled = !enabled;
    }
    this.#selectAll.hidden = !ready;
    if (ready) {
      const visible = this.#visibleUids();
      const checkedCount = visible.reduce((n, uid) => n + (this.#selected.has(uid) ? 1 : 0), 0);
      this.#selectAll.checked = visible.length > 0 && checkedCount === visible.length;
      this.#selectAll.indeterminate = checkedCount > 0 && checkedCount < visible.length;
    }
    else {
      this.#selectAll.checked = false;
      this.#selectAll.indeterminate = false;
    }
    this.#count.textContent = count
      ? count + ' selected'
      : 'No selection';
    this.#updatePager();
  }

  #render() {
    const ready = this.#mode === 'ready';
    this.#status.hidden = ready;
    this.#grid.hidden = !ready;
    if (!ready) {
      this.#status.classList.toggle('error', this.#mode === 'error');
      this.#retryButton.hidden = this.#mode !== 'error';
      this.#setupButton.hidden = this.#mode !== 'setup';
      this.#statusText.textContent = this.#message;
      this.#grid.replaceChildren();
      this.#updateActions();
      return;
    }
    if (!this.#rows.length || (this.#unreadOnly && !this.#rows.some(thread => thread.unread > 0))) {
      this.#status.hidden = false;
      this.#status.classList.remove('error');
      this.#retryButton.hidden = true;
      this.#statusText.textContent = this.#unreadOnly ? 'No unread messages' : 'No messages';
      this.#grid.replaceChildren();
      this.#updateActions();
      return;
    }
    const nodes = [];
    for (const thread of this.#sortedRows()) {
      nodes.push(this.#threadRow(thread));
      if (this.#expanded.has(thread.uids[0])) {
        const messages = this.#unreadOnly
          ? thread.messages.filter(item => !hasFlag(item.flags, '\\Seen'))
          : thread.messages;
        for (const item of messages) {
          nodes.push(this.#msgRow(thread, item));
        }
      }
    }
    this.#grid.replaceChildren(...nodes);
    this.#updateActions();
  }

  // Threads the unread-only filter lets through; the full set stays in
  // #rows so the filter is reversible at any time.
  #visibleRows() {
    return this.#unreadOnly ? this.#rows.filter(thread => thread.unread > 0) : this.#rows;
  }

  // View-local sorting: reorders only the threads currently built into the
  // list (the loaded page). `#rows` keeps its natural newest-first order, so
  // switching back to "Newest first" needs no stored copy. With
  // `flaggedOnTop`, the active comparator (or natural order) runs once per
  // partition and flagged conversations are placed first.
  #sortedRows() {
    const rows = this.#visibleRows();
    if (this.#flaggedOnTop) {
      const flagged = [];
      const rest = [];
      for (const thread of rows) {
        (thread.flagged ? flagged : rest).push(thread);
      }
      return [...this.#sortPartition(flagged), ...this.#sortPartition(rest)];
    }
    return this.#sortPartition(rows);
  }

  // Re-render without losing keyboard focus: the row that had focus (thread
  // row by data-key, message row by data-uid) is focused again if it is
  // still part of the new rendering.
  #rerenderKeepingFocus() {
    const active = this.shadowRoot.activeElement?.closest?.('.row');
    const key = active?.dataset.key;
    const uid = active?.dataset.uid;
    this.#render();
    const again = key != null
      ? this.#grid.querySelector('.row.thread[data-key="' + key + '"]')
      : (uid != null ? this.#grid.querySelector('.row.sub[data-uid="' + uid + '"]') : null);
    again?.focus({preventScroll: true});
  }

  #sortPartition(rows) {
    if (!this.#sortMode) {
      return rows;
    }
    const [key, dir] = this.#sortMode.split('-');
    const cmp = this.#comparator(key, dir === 'desc');
    // Array.prototype.sort is stable; comparators also tiebreak on UID, so
    // the result is fully deterministic.
    return [...rows].sort(cmp);
  }

  #comparator(key, desc) {
    switch (key) {
      case 'subject': {
        const val = t => (t.subject || '').trim().toLowerCase();
        return textComparator(val, desc);
      }
      case 'sender': {
        const val = t => senderName(t.from).trim().toLowerCase();
        return textComparator(val, desc);
      }
      case 'date': {
        const val = t => {
          const d = new Date(t.date || '');
          return isNaN(d.getTime()) ? null : d.getTime();
        };
        return numberComparator(val, desc);
      }
      default:
        return () => 0;
    }
  }

  // Shift-click range: rows are in visible render order, so the range walks
  // the DOM between the anchor row (#lastChecked from the last plain click)
  // and the clicked row, applying the clicked row's resulting checked state
  // to every row in between (inclusive). Thread rows participate with their
  // whole conversation.
  #applyRange(uids, checked) {
    const anchor = this.#lastChecked;
    if (!anchor || !anchor.length) {
      return;
    }
    const rows = [...this.#grid.querySelectorAll('.row')];
    const rowUids = row => row.classList.contains('thread')
      ? String(row.dataset.uids || '').split(',').filter(Boolean).map(Number)
      : (row.dataset.uid != null ? [Number(row.dataset.uid)] : []);
    const has = (row, uid) => rowUids(row).includes(Number(uid));
    const a = rows.find(row => has(row, anchor[0]));
    const t = rows.find(row => has(row, uids[0]));
    if (!a || !t) {
      return;
    }
    let lo = rows.indexOf(a);
    let hi = rows.indexOf(t);
    if (lo > hi) {
      [lo, hi] = [hi, lo];
    }
    for (const row of rows.slice(lo, hi + 1)) {
      const span = rowUids(row);
      if (checked) {
        for (const uid of span) {
          this.#selected.add(uid);
        }
      }
      else {
        for (const uid of span) {
          this.#selected.delete(uid);
        }
      }
    }
  }

  // Shared shift-click path for row and message toggles: applies the range,
  // re-renders so thread/sub checkboxes stay consistent, and moves the
  // anchor to the clicked row. Returns false when there is nothing to range
  // against (no anchor, or shift-clicking the anchor itself).
  #shiftToggle(uids, checked) {
    const anchor = this.#lastChecked;
    if (!anchor || !anchor.length || anchor.length === uids.length && anchor.every((uid, i) => Number(uid) === Number(uids[i]))) {
      return false;
    }
    this.#applyRange(uids, checked);
    this.#rerenderKeepingFocus();
    this.status('');
    this.#updateActions();
    return true;
  }

  #toggleUids(uids, input, row, shift = false) {
    const checked = !uids.every(uid => this.#selected.has(uid));
    if (shift && this.#shiftToggle(uids, checked)) {
      return;
    }
    this.#lastChecked = [...uids];
    if (checked) {
      for (const uid of uids) {
        this.#selected.add(uid);
      }
    }
    else {
      for (const uid of uids) {
        this.#selected.delete(uid);
      }
    }
    input.checked = checked;
    row.classList.toggle('checked', checked);
    row.setAttribute('aria-selected', String(checked));
    this.#syncRowUids(uids, checked);
    this.status('');
    this.#updateActions();
  }

  #syncRowUids(uids, checked) {
    // check the sub-rows belonging to a thread toggle
    for (const uid of uids) {
      const row = this.#grid.querySelector('.row.sub[data-uid="' + uid + '"]');
      if (row) {
        row.classList.toggle('checked', checked);
        row.setAttribute('aria-selected', String(checked));
        row.querySelector('input').checked = checked;
      }
    }
  }

  #threadChecked(thread) {
    return thread.messages.every(item => this.#selected.has(item.uid)) && thread.messages.length > 0;
  }

   #chevSvg() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5.5l7 6.5-7 6.5"/></svg>';
  }

  #threadRow(thread) {
    const expanded = this.#expanded.has(thread.uids[0]);
    const unread = thread.unread > 0;
    const checked = this.#threadChecked(thread);
    const row = document.createElement('div');
    row.className = 'row thread' + (unread ? ' unread' : '') + (checked ? ' checked' : '') + (expanded ? ' expanded' : '');
    row.dataset.key = thread.uids[0];
    row.dataset.uids = thread.uids.join(',');
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-selected', String(checked));
    row.setAttribute('aria-label', senderName(thread.from) + ' - ' + (thread.subject || 'no subject'));

    const uids = thread.uids;
    const multi = thread.count > 1;
    if (multi) {
      row.setAttribute('aria-expanded', String(expanded));
    }

    const check = document.createElement('span');
    check.className = 'check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.setAttribute('aria-label', 'Select conversation');
    check.append(input);
    check.addEventListener('click', e => {
      e.stopPropagation();
      this.#lastShift = e.shiftKey;
    });
    input.addEventListener('change', () => this.#toggleUids(uids, input, row, this.#lastShift));

    const star = document.createElement('star-toggle');
    star.className = 'star';
    star.color = threadStarColor(thread.messages);
    star.addEventListener('star', e => {
      e.stopPropagation();
      this.dispatchEvent(new CustomEvent('star', {
        detail: {uids: [...uids], color: e.detail.color},
        bubbles: true,
        composed: true
      }));
    });

    const tcount = document.createElement('span');
    if (multi) {
      tcount.className = 'tcount';
      tcount.textContent = thread.unread + '/' + thread.count;
      tcount.setAttribute('aria-label', thread.unread + ' unread of ' + thread.count + ' messages in conversation');
    }

    const chevSlot = document.createElement('span');
    chevSlot.className = 'chev-slot';
    let chev = null;
    if (multi) {
      chev = document.createElement('button');
      chev.type = 'button';
      chev.className = 'chev';
      chev.setAttribute('aria-label', expanded ? 'Collapse conversation' : 'Expand conversation');
      chev.innerHTML = this.#chevSvg();
      chev.addEventListener('click', e => {
        e.stopPropagation();
        this.#toggleExpand(thread, row);
      });
    }

    const sender = document.createElement('span');
    sender.className = 'sender';
    sender.textContent = senderName(thread.from);

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = thread.subject || '(no subject)';

    const date = document.createElement('span');
    date.className = 'date';
    date.textContent = formatDate(thread.date);

    row.append(check, star, tcount, chevSlot, sender, title, date);
    if (chev) {
      chevSlot.append(chev);
    }
    row.addEventListener('click', e => {
      this.#lastShift = e.shiftKey;
      this.#toggleUids(uids, input, row, this.#lastShift);
    });
    row.addEventListener('dblclick', e => {
      if (e.target.closest('.check, .star, .chev')) {
        return;
      }
      e.preventDefault();
      this.#open(uids);
    });
    row.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.#open(uids);
      }
      else if (e.key === ' ') {
        e.preventDefault();
        this.#lastShift = false;
        this.#toggleUids(uids, input, row, false);
      }
      else if (multi && e.key === 'ArrowRight' && !expanded) {
        e.preventDefault();
        this.#toggleExpand(thread, row);
      }
      else if (multi && e.key === 'ArrowLeft' && expanded) {
        e.preventDefault();
        this.#toggleExpand(thread, row);
      }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const rows = [...this.#grid.querySelectorAll('.row')];
        const next = rows[rows.indexOf(row) + (e.key === 'ArrowDown' ? 1 : -1)];
        if (next) {
          next.focus();
        }
      }
    });
    return row;
  }

  #msgRow(thread, item) {
    const unread = !hasFlag(item.flags, '\\Seen');
    const checked = this.#selected.has(item.uid);
    const failed = this.#failures.has(Number(item.uid));
    const row = document.createElement('div');
    row.className = 'row sub' + (unread ? ' unread' : '') + (checked ? ' checked' : '') + (failed ? ' failed' : '');
    row.dataset.uid = item.uid;
    if (failed) {
      this.#applyFailure(row, item.uid, true);
    }
    row.tabIndex = 0;
    row.setAttribute('aria-selected', String(checked));
    row.setAttribute('aria-label', senderName(item.from) + ' - ' + (item.subject || 'no subject'));

    const check = document.createElement('span');
    check.className = 'check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.setAttribute('aria-label', 'Select message');
    check.append(input);
    check.addEventListener('click', e => {
      e.stopPropagation();
      this.#lastShift = e.shiftKey;
    });
    input.addEventListener('change', () => this.#toggleMsg(item, input, row, this.#lastShift));

    const star = document.createElement('star-toggle');
    star.className = 'star';
    star.color = starColorOf(item.flags);
    star.addEventListener('star', e => {
      e.stopPropagation();
      this.dispatchEvent(new CustomEvent('star', {
        detail: {uids: [item.uid], color: e.detail.color},
        bubbles: true,
        composed: true
      }));
    });

    const tcountSlot = document.createElement('span');
    tcountSlot.className = 'tcount-slot';

    const indent = document.createElement('span');
    indent.className = 'chev-slot';

    const sender = document.createElement('span');
    sender.className = 'sender';
    sender.textContent = senderName(item.from);

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = item.subject || '(no subject)';

    const date = document.createElement('span');
    date.className = 'date';
    date.textContent = formatDate(item.date);

    row.append(check, star, tcountSlot, indent, sender, title, date);
    row.addEventListener('click', e => {
      this.#lastShift = e.shiftKey;
      this.#toggleMsg(item, input, row, this.#lastShift);
    });
    row.addEventListener('dblclick', e => {
      if (e.target.closest('.check, .star')) {
        return;
      }
      e.preventDefault();
      this.#open([item.uid]);
    });
    row.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.#open([item.uid]);
      }
      else if (e.key === ' ') {
        e.preventDefault();
        this.#lastShift = false;
        this.#toggleMsg(item, input, row, false);
      }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const rows = [...this.#grid.querySelectorAll('.row')];
        const next = rows[rows.indexOf(row) + (e.key === 'ArrowDown' ? 1 : -1)];
        if (next) {
          next.focus();
        }
      }
    });
    return row;
  }

  #toggleMsg(item, input, row, shift = false) {
    const checked = !this.#selected.has(item.uid);
    if (shift && this.#shiftToggle([item.uid], checked)) {
      return;
    }
    this.#lastChecked = [item.uid];
    if (checked) {
      this.#selected.add(item.uid);
    }
    else {
      this.#selected.delete(item.uid);
    }
    input.checked = checked;
    row.classList.toggle('checked', checked);
    row.setAttribute('aria-selected', String(checked));
    // keep the parent thread's checkbox/checked state in sync
    const thread = this.#rows.find(t => t.uids.includes(item.uid));
    if (thread) {
      const trow = this.#grid.querySelector('.row.thread[data-key="' + thread.uids[0] + '"]');
      if (trow) {
        const all = this.#threadChecked(thread);
        trow.classList.toggle('checked', all);
        trow.setAttribute('aria-selected', String(all));
        const tinput = trow.querySelector('input');
        if (tinput) {
          tinput.checked = all;
        }
      }
    }
    this.status('');
    this.#updateActions();
  }
}

customElements.define('list-view', ListView);

export {senderName, formatDate, hasFlag};
