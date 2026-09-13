import {tools} from './helper.mjs';
import {LIGHT_THEMES, DARK_THEMES, THEME_DEFAULTS} from './data/client/themes.mjs';
import {FONT_SIZES, normalizeFontScale} from './data/client/font-scale.mjs';
import {checkNow} from './badge.mjs';

const MASTER_PASS = 'master.pass';
const PASS_PREFIX = 'user.pass.';

const THEME_USES = [
  {id: 'auto', title: 'Auto (OS theme)'},
  {id: 'light', title: 'Manual — Light'},
  {id: 'dark', title: 'Manual — Dark'}
];

chrome.runtime.onInstalled.addListener(async () => {
  // start from scratch so reloads/updates don't hit duplicate-id errors
  await chrome.contextMenus.removeAll();

  chrome.contextMenus.create({
    id: 'client-mode-parent',
    title: 'Open In',
    contexts: ['action']
  });

  const mode = await tools.view.mode.get();
  chrome.contextMenus.create({
    id: 'mode.tab',
    parentId: 'client-mode-parent',
    type: 'radio',
    title: 'New Tab',
    checked: mode === 'tab',
    contexts: ['action']
  });
  chrome.contextMenus.create({
    id: 'mode.popup',
    parentId: 'client-mode-parent',
    type: 'radio',
    title: 'Popup Window',
    checked: mode !== 'tab',
    contexts: ['action']
  });

  const prefs = await chrome.storage.local.get(THEME_DEFAULTS);
  // invalid stored values fall back to the defaults so a radio is always checked
  const themeUse = ['auto', 'light', 'dark'].includes(prefs['ui.theme.use'])
    ? prefs['ui.theme.use']
    : THEME_DEFAULTS['ui.theme.use'];
  const themeLight = LIGHT_THEMES.some(t => t.id === prefs['ui.theme.light'])
    ? prefs['ui.theme.light']
    : THEME_DEFAULTS['ui.theme.light'];
  const themeDark = DARK_THEMES.some(t => t.id === prefs['ui.theme.dark'])
    ? prefs['ui.theme.dark']
    : THEME_DEFAULTS['ui.theme.dark'];

  chrome.contextMenus.create({
    id: 'theme.parent',
    title: 'Theme',
    contexts: ['action']
  });

  chrome.contextMenus.create({
    id: 'theme.light',
    parentId: 'theme.parent',
    title: 'Light Theme',
    contexts: ['action']
  });
  for (const t of LIGHT_THEMES) {
    chrome.contextMenus.create({
      id: 'theme.light.' + t.id,
      parentId: 'theme.light',
      type: 'radio',
      title: t.title,
      checked: themeLight === t.id,
      contexts: ['action']
    });
  }

  chrome.contextMenus.create({
    id: 'theme.dark',
    parentId: 'theme.parent',
    title: 'Dark Theme',
    contexts: ['action']
  });
  for (const t of DARK_THEMES) {
    chrome.contextMenus.create({
      id: 'theme.dark.' + t.id,
      parentId: 'theme.dark',
      type: 'radio',
      title: t.title,
      checked: themeDark === t.id,
      contexts: ['action']
    });
  }

  chrome.contextMenus.create({
    id: 'theme.use',
    parentId: 'theme.parent',
    title: 'Use',
    contexts: ['action']
  });
  for (const u of THEME_USES) {
    chrome.contextMenus.create({
      id: 'theme.use.' + u.id,
      parentId: 'theme.use',
      type: 'radio',
      title: u.title,
      checked: themeUse === u.id,
      contexts: ['action']
    });
  }

  chrome.contextMenus.create({
    id: 'font-size.parent',
    title: 'Font Size',
    contexts: ['action']
  });
  const fontScale = normalizeFontScale((await chrome.storage.local.get({'ui.font.scale': 1}))['ui.font.scale']);
  for (const size of FONT_SIZES) {
    chrome.contextMenus.create({
      id: 'font-size.' + size.scale,
      parentId: 'font-size.parent',
      type: 'radio',
      title: size.title,
      checked: fontScale === size.scale,
      contexts: ['action']
    });
  }

  chrome.contextMenus.create({
    id: 'clear.parent',
    title: 'Clear',
    contexts: ['action']
  });
  chrome.contextMenus.create({
    id: 'clear-session-passwords',
    parentId: 'clear.parent',
    title: 'Clear Session Passwords',
    contexts: ['action']
  });
  chrome.contextMenus.create({
    id: 'clear-all-caches',
    parentId: 'clear.parent',
    title: 'Clear All Caches',
    contexts: ['action']
  });

  chrome.contextMenus.create({
    id: 'badge-check-now',
    title: 'Update badge',
    contexts: ['action']
  });
});

// Drops everything the session keeps in plain form: cached account passwords
// (user.pass.*) and the confirmed master password. Persisted values in local
// storage are not touched; the next connect asks for passwords again.
async function clearSessionPasswords() {
  const all = await chrome.storage.session.get(null);
  const keys = Object.keys(all)
    .filter(k => k === MASTER_PASS || k.startsWith(PASS_PREFIX));
  if (keys.length) {
    await chrome.storage.session.remove(keys);
  }
}

chrome.contextMenus.onClicked.addListener(async info => {
  const id = info.menuItemId;
  // radio menus update their own check marks, only the stored pref changes
  if (id.startsWith('theme.light.')) {
    chrome.storage.local.set({'ui.theme.light': id.slice(12)});
    return;
  }
  if (id.startsWith('theme.dark.')) {
    chrome.storage.local.set({'ui.theme.dark': id.slice(11)});
    return;
  }
  if (id.startsWith('theme.use.')) {
    chrome.storage.local.set({'ui.theme.use': id.slice(10)});
    return;
  }
  if (id.startsWith('mode.')) {
    const mode = id.replace('mode.', '');
    chrome.storage.local.set({
      'ui.client.open': mode
    });
    tools.view.mode.apply(mode, false);
    return;
  }
  if (id.startsWith('font-size.')) {
    const scale = Number(id.slice(10));
    if (scale > 0) {
      chrome.storage.local.set({'ui.font.scale': scale});
    }
    return;
  }
  if (id === 'clear-session-passwords') {
    await clearSessionPasswords();
  }
  if (id === 'clear-all-caches') {
    chrome.runtime.sendMessage({type: 'clear-all-caches'}).catch(() => {});
  }
  if (id === 'badge-check-now') {
    checkNow();
  }
});
