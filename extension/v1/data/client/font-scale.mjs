export const FONT_SIZES = [
  {scale: 0.85, title: 'Small'},
  {scale: 1, title: 'Normal'},
  {scale: 1.2, title: 'Large'},
  {scale: 1.4, title: 'Extra Large'}
];

export const FONT_SCALES = FONT_SIZES.map(s => s.scale);

export const FONT_SCALE_DEFAULTS = {'ui.font.scale': 1};

export function normalizeFontScale(value) {
  return FONT_SCALES.includes(value) ? value : FONT_SCALE_DEFAULTS['ui.font.scale'];
}

export async function initFontScale() {
  const apply = prefs => {
    document.body.style.setProperty('--font-scale', String(normalizeFontScale(prefs['ui.font.scale'])));
  };

  apply(await chrome.storage.local.get(FONT_SCALE_DEFAULTS));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'ui.font.scale' in changes) {
      chrome.storage.local.get(FONT_SCALE_DEFAULTS).then(apply);
    }
  });
}
