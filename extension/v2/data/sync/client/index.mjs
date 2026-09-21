'use strict';

// data/sync/client/index.mjs — the sync client, hosted on its own tab. The mail
// client (data/client/index.mjs) opens this page from its Sync button; the
// picker hands off here too.
//
// Opened plainly, the panel shows the Account dir selectors; opened with
// ?account=<id> (the picker hands off that way), that account is dictated
// and its picker is hidden.
//
// The page follows the client's color theme: the same theme.css palette and
// the stored light/dark/special-theme prefs (live-switching included), plus
// the font scale the client exposes on its toolbar.

import {initSyncPanel} from './sync-panel.mjs';
import {initTheme} from '/data/client/theme.mjs';
import {initFontScale} from '/data/client/font-scale.mjs';

initTheme();
initFontScale();

const account = new URLSearchParams(location.search).get('account') || '';
initSyncPanel(
  document.getElementById('sync'),
  document.getElementById('prompt'),
  account ? {account} : {}
).open();
