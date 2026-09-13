// Theme catalog shared by the client/options pages (theme.mjs) and the
// service worker (context.mjs). Keep ids in sync with theme.css.

export const LIGHT_THEMES = [
  {id: 'light', title: 'Light'},
  {id: 'sepia', title: 'Sepia'},
  {id: 'solarized-light', title: 'Solarized Light'},
  {id: 'nord-light', title: 'Nord Light'}
];

export const DARK_THEMES = [
  {id: 'dark', title: 'Dark'},
  {id: 'groove-dark', title: 'Groove Dark'},
  {id: 'solarized-dark', title: 'Solarized Dark'},
  {id: 'nord-dark', title: 'Nord Dark'}
];

// storage keys -> defaults; also the set of keys that trigger re-resolution
export const THEME_DEFAULTS = {
  'ui.theme.light': 'light',
  'ui.theme.dark': 'dark',
  'ui.theme.use': 'auto'
};

export const ALL_THEMES = new Set([...LIGHT_THEMES, ...DARK_THEMES].map(t => t.id));
