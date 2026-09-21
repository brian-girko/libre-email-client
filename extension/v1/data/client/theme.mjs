import {ALL_THEMES, THEME_DEFAULTS} from './themes.mjs';

const QUERY = '(prefers-color-scheme: dark)';
let query = null;

function media() {
  query = query || matchMedia(QUERY);
  return query;
}

// picks the theme id for the stored prefs; auto follows the OS preference,
// manual light/dark forces the matching user-selected theme
function active(prefs) {
  const light = ALL_THEMES.has(prefs['ui.theme.light'])
    ? prefs['ui.theme.light']
    : THEME_DEFAULTS['ui.theme.light'];
  const dark = ALL_THEMES.has(prefs['ui.theme.dark'])
    ? prefs['ui.theme.dark']
    : THEME_DEFAULTS['ui.theme.dark'];
  const use = ['auto', 'light', 'dark'].includes(prefs['ui.theme.use'])
    ? prefs['ui.theme.use']
    : THEME_DEFAULTS['ui.theme.use'];
  if (use === 'light') {
    return light;
  }
  if (use === 'dark') {
    return dark;
  }
  return media().matches ? dark : light;
}

export async function initTheme() {
  const apply = prefs => {
    document.body.dataset.theme = active(prefs);
  };

  apply(await chrome.storage.local.get(THEME_DEFAULTS));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && Object.keys(changes).some(k => k in THEME_DEFAULTS)) {
      chrome.storage.local.get(THEME_DEFAULTS).then(apply);
    }
  });

  // live switching in auto mode; no-op while a manual mode is selected
  media().addEventListener('change', () => {
    chrome.storage.local.get(THEME_DEFAULTS).then(apply);
  });
}
