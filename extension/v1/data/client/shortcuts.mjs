// Key events from inside a sandboxed email-body iframe never reach this page,
// so shortcuts and accesskeys are inert while an email body has focus.
function focusPane(el) {
  if (!el || el.checkVisibility?.() === false) {
    return false;
  }
  el.focus();
  return true;
}

function paneFor(code, panes) {
  if (code === 'Digit1') {
    return panes.dirs;
  }
  if (code === 'Digit2') {
    return panes.list;
  }
  if (code === 'Digit3') {
    return panes.preview;
  }
  return null;
}

function init({dirs, list, preview, prompt}) {
  const panes = {dirs, list, preview};
  document.addEventListener('keydown', e => {
    if (e.defaultPrevented || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) {
      return;
    }
    if (prompt && !prompt.hidden) {
      return;
    }
    if (e.target?.closest?.('input, select, textarea, [contenteditable="true"], dialog')) {
      return;
    }
    const pane = paneFor(e.code, panes);
    if (!pane || !focusPane(pane)) {
      return;
    }
    e.preventDefault();
  });
}

export {init};
