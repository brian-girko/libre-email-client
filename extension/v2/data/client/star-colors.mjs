// star-colors.mjs — colored stars (Gmail palette), shared by every view.
//
// A star's color is an index into STAR_COLORS. The plain yellow star is a
// bare \Flagged flag (what every IMAP client shows); the other five colors
// ride as IMAP keywords ($star-*, encoded in maildir filenames as letters
// a..e — see data/sync/maildir.mjs). Starred always means \Flagged set, and
// at most one color keyword sits on a message: these helpers build the
// add/remove lists that keep that invariant.

import {STAR_COLOR_KEYWORDS} from '../sync/maildir.mjs';

export const STAR_COLORS = [
  {name: 'none', keyword: null},
  {name: 'red', keyword: STAR_COLOR_KEYWORDS[0]},
  {name: 'orange', keyword: STAR_COLOR_KEYWORDS[1]},
  {name: 'yellow', keyword: null},           // plain \Flagged, no keyword
  {name: 'green', keyword: STAR_COLOR_KEYWORDS[2]},
  {name: 'blue', keyword: STAR_COLOR_KEYWORDS[3]},
  {name: 'purple', keyword: STAR_COLOR_KEYWORDS[4]}
];

const ALL_COLOR_KEYWORDS = new Set(STAR_COLOR_KEYWORDS);

const FLAGGED = '\\Flagged';

/** color index (0..6) for one message's flags; 0 = no star */
export function starColorOf(flags = []) {
  const list = Array.isArray(flags) ? flags : [];
  for (let i = 1; i < STAR_COLORS.length; i++) {
    if (STAR_COLORS[i].keyword && list.includes(STAR_COLORS[i].keyword)) {
      return i;
    }
  }
  return list.includes(FLAGGED) ? 3 : 0;
}

/** the color a star click lands on, given the current color */
export function nextColor(color) {
  return ((Number(color) || 0) + 1) % STAR_COLORS.length;
}

/** color of a conversation: the newest starred message wins */
export function threadStarColor(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = starColorOf(messages[i]?.flags);
    if (c) {
      return c;
    }
  }
  return 0;
}

/**
 * setFlags add/remove lists that move message(s) to `color`:
 * yellow/plain keeps just \Flagged; a color adds its keyword and drops
 * every other; "none" removes the flag and all keywords.
 */
export function starFlagOps(color) {
  const keep = STAR_COLORS[color]?.keyword ?? null;
  const others = [...ALL_COLOR_KEYWORDS].filter(kw => kw !== keep);
  if (!color) {
    return {add: [], remove: [FLAGGED, ...others]};
  }
  const add = [FLAGGED];
  if (keep) {
    add.push(keep);
  }
  return {add, remove: others};
}
