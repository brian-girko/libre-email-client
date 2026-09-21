import {getPref, setPref} from './prefs.mjs';

const root = document.body;
const toggle = document.getElementById('layout-toggle');
const split = document.getElementById('mails-split');
const splitter = document.getElementById('splitter');

const LABELS = {
  horizontal: {html: '⇄ Hori<u>z</u>ontal', key: 'z'},
  vertical: {html: '⇅ <u>V</u>ertical', key: 'v'}
};
const MIN_EMAILS = 160;
const MIN_PREVIEW = 160;

let layout = await getPref('previewLayout', 'horizontal');
const emailsSize = {
  horizontal: await getPref('emails-panel.width', null),
  vertical: await getPref('emails-panel.height', null)
};

function sizeKey() {
  return layout === 'horizontal' ? 'emails-panel.width' : 'emails-panel.height';
}

function applyEmailsSize() {
  const size = emailsSize[layout];
  const value = size ? Math.round(size) + 'px' : '';
  if (layout === 'horizontal') {
    split.style.setProperty('--emails-width', value);
    split.style.removeProperty('--emails-height');
  }
  else {
    split.style.setProperty('--emails-height', value);
    split.style.removeProperty('--emails-width');
  }
}

function apply() {
  root.dataset.previewLayout = layout;
  toggle.innerHTML = LABELS[layout].html;
  toggle.accessKey = LABELS[layout].key;
  splitter.setAttribute('aria-orientation', layout === 'horizontal' ? 'vertical' : 'horizontal');
  applyEmailsSize();
}

toggle.addEventListener('click', () => {
  layout = layout === 'horizontal' ? 'vertical' : 'horizontal';
  apply();
  setPref('previewLayout', layout);
});

splitter.addEventListener('pointerdown', e => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();
  splitter.setPointerCapture(e.pointerId);
  splitter.classList.add('dragging');
  const rect = split.getBoundingClientRect();
  const horizontal = layout === 'horizontal';
  const limit = (horizontal ? rect.width : rect.height) - MIN_PREVIEW;
  const onMove = ev => {
    const pos = horizontal ? ev.clientX - rect.left : ev.clientY - rect.top;
    emailsSize[layout] = Math.max(MIN_EMAILS, Math.min(limit, pos));
    applyEmailsSize();
  };
  const onEnd = () => {
    splitter.classList.remove('dragging');
    splitter.removeEventListener('pointermove', onMove);
    splitter.removeEventListener('pointerup', onEnd);
    splitter.removeEventListener('pointercancel', onEnd);
    setPref(sizeKey(), Math.round(emailsSize[layout]));
  };
  splitter.addEventListener('pointermove', onMove);
  splitter.addEventListener('pointerup', onEnd);
  splitter.addEventListener('pointercancel', onEnd);
});

splitter.addEventListener('dblclick', () => {
  emailsSize[layout] = null;
  applyEmailsSize();
  setPref(sizeKey(), null);
});

window.addEventListener('resize', () => {
  const size = emailsSize[layout];
  if (!size) return;
  const rect = split.getBoundingClientRect();
  const max = (layout === 'horizontal' ? rect.width : rect.height) - MIN_PREVIEW;
  if (size > max) {
    emailsSize[layout] = Math.max(MIN_EMAILS, max);
    applyEmailsSize();
  }
});

function init() {
  apply();
}

export {init};
