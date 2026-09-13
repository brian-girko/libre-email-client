import './components/email-view.js';
import './components/emails-view.js';
import {getMailApi} from './mail.mjs';
import {FONT_SCALE_DEFAULTS, normalizeFontScale} from './font-scale.mjs';

let el = null;
let list = null;

const MODES = ['remote', 'block', 'text'];

async function displayMode(accountId) {
  const res = await chrome.storage.local.get({
    ['email.displayMode.' + accountId]: null,
    ['email.showRemoteContent.' + accountId]: false
  });
  if (MODES.includes(res['email.displayMode.' + accountId])) {
    return res['email.displayMode.' + accountId];
  }
  return res['email.showRemoteContent.' + accountId] ? 'remote' : 'block';
}

async function fontScale() {
  const res = await chrome.storage.local.get(FONT_SCALE_DEFAULTS);
  return normalizeFontScale(res['ui.font.scale']);
}

function cardFor(uid) {
  return [...el.children].find(node => Number(node.uid) === Number(uid)) ?? null;
}

function add(accountId, uid) {
  if (cardFor(uid)) {
    return;
  }
  const card = document.createElement('email-view');
  card.uid = uid;
  card.flagged = list.isFlagged(uid);
  el.append(card);
  (async () => {
    try {
      card.displayMode = await displayMode(accountId);
      card.fontScale = await fontScale();
    }
    catch {}
    try {
      const api = await getMailApi(accountId);
      const raw = await api.readFile(uid);
      if (cardFor(uid) !== card) {
        return;
      }
      card.raw = raw;
    }
    catch (e) {
      if (cardFor(uid) !== card) {
        return;
      }
      card.fail(e?.message || String(e));
    }
  })();
}

function remove(uid) {
  cardFor(uid)?.remove();
}

function clear() {
  for (const card of [...el.children]) {
    card.remove();
  }
}

function showAll(accountId, uids) {
  clear();
  for (const uid of uids) {
    if (uid != null) {
      add(accountId, uid);
    }
  }
}

function init(element, listView, dirsView) {
  el = element;
  list = listView;
  el.addEventListener('close', e => {
    const uid = e.detail?.uid;
    if (uid == null) {
      return;
    }
    remove(uid);
  });
  el.addEventListener('clear', () => {
    clear();
  });
  list.addEventListener('email-preview', e => {
    const {accountId, uids} = e.detail ?? {};
    if (accountId == null || !Array.isArray(uids)) {
      return;
    }
    showAll(accountId, uids);
  });
  list.addEventListener('email-gone', e => {
    for (const uid of e.detail?.uids ?? []) {
      remove(uid);
    }
  });
  el.addEventListener('star', e => {
    const detail = e.detail;
    if (!detail || detail.uid == null) {
      return;
    }
    list.dispatchEvent(new CustomEvent('star', {
      detail: {uid: detail.uid, flagged: !!detail.flagged},
      bubbles: true,
      composed: true
    }));
  });
  const forwardMove = type => e => {
    const uid = e.detail?.uid;
    if (uid == null) {
      return;
    }
    list.dispatchEvent(new CustomEvent(type, {
      detail: {uids: [uid]},
      bubbles: true,
      composed: true
    }));
  };
  el.addEventListener('trash', forwardMove('trash'));
  el.addEventListener('archive', forwardMove('archive'));
  list.addEventListener('flags-applied', e => {
    for (const uid of e.detail?.uids ?? []) {
      const card = cardFor(uid);
      if (card) {
        card.flagged = list.isFlagged(uid);
      }
    }
  });
  dirsView.addEventListener('dir-selected', () => {
    clear();
  });
}

export {init};
