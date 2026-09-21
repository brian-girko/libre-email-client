import {getPref, setPref} from './prefs.mjs';
import {load as loadDirs} from './dirs.mjs';

let select = null;

async function loadAccounts() {
  const {accounts} = await chrome.storage.local.get('accounts');
  if (!Array.isArray(accounts) || !accounts.length) {
    const opt = document.createElement('option');
    opt.textContent = 'No accounts';
    opt.disabled = true;
    opt.selected = true;
    select.replaceChildren(opt);
    loadDirs(select.value);
    return;
  }
  const sorted = [...accounts].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  select.replaceChildren(...sorted.map(account => {
    const opt = document.createElement('option');
    opt.value = account.id;
    opt.textContent = account.label || account.id;
    return opt;
  }));
  const saved = await getPref('account', null);
  const match = saved && sorted.find(a => a.id === saved);
  select.value = match ? match.id : sorted.find(a => a.primary)?.id ?? sorted[0].id;
  loadDirs(select.value);
}

function init(element) {
  select = element;
  select.addEventListener('change', () => {
    setPref('account', select.value);
    loadDirs(select.value);
  });
  loadAccounts();
}

export {init};
