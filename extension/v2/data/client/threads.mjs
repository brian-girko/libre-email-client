/**
 * threads.mjs — local JWZ-style conversation grouping.
 *
 * The old client got thread groups from the wasm IMAP core (fetch_threads —
 * requires a live server). Here the grouping runs over the locally parsed
 * Message-ID / References / In-Reply-To headers instead, producing the same
 * ThreadSummary shape the list view consumes:
 *
 *   {uids, count, unread, flagged, subject, from, date, messages}
 *
 * Grouping rules (Gmail-like simplification of JWZ):
 *   - messages whose References/In-Reply-To chain hits a message of a group
 *     join that group;
 *   - a group's topic is the base subject of its oldest message; later
 *     replies with a different Message-ID but the same base subject join too
 *     (covers clients that drop References);
 *   - unlinked messages form their own thread, so one-thread-per-message is
 *     the degenerate case. list-view's thread toggle works as before.
 */

const RE_PREFIX_RE = /^\s*(?:(?:re|fwd|aw|fw|sv|antw)(?:\s*\[\d+\])?\s*:\s*|\[\d+\]\s+)*/i;

/** "re: re: foo" → "foo" (compare RFC-mime-decoded text) */
export function baseSubject(subject) {
  let name = String(subject ?? '');
  for (;;) {
    const stripped = name.replace(RE_PREFIX_RE, '').trim();
    if (!stripped || stripped === name) {
      break;
    }
    name = stripped;
  }
  return name.toLowerCase();
}

function normId(id) {
  if (!id) {
    return null;
  }
  const m = String(id).match(/<[^<>]+>/);
  return m ? m[0] : (String(id).trim() || null);
}

function timeOf(v) {
  const ms = Date.parse(String(v ?? ''));
  return Number.isNaN(ms) ? 0 : ms;
}

const hasFlag = (flags, flag) => (Array.isArray(flags) ? flags : []).includes(flag);

/**
 * Group message rows (uid, flags, subject, from, date, messageId,
 * references, inReplyTo) into conversations.
 * @param {Array<object>} rows
 * @returns {Array<object>} ThreadSummary[], newest thread first
 */
export function groupThreads(rows) {
  const messages = (Array.isArray(rows) ? rows : [])
    .map(m => ({...m, uid: Number(m.uid)}))
    .sort((a, b) => (a.uid - b.uid) || (timeOf(a.date) - timeOf(b.date)));

  // msgid -> message, for chain linking
  const byMsgId = new Map();
  for (const m of messages) {
    const id = normId(m.messageId);
    if (id && !byMsgId.has(id)) {
      byMsgId.set(id, m);
    }
  }

  // union-find over message objects
  const parent = new Map(messages.map(m => [m, m]));
  const find = m => {
    let root = m;
    while (parent.get(root) !== root) {
      root = parent.get(root);
    }
    while (parent.get(m) !== root) {
      const next = parent.get(m);
      parent.set(m, root);
      m = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      parent.set(ra, rb);
    }
  };

  // 1. References/In-Reply-To chains (messages sorted by uid, chains run
  // parent-first, so joining produced groups stays deterministic)
  for (const m of messages) {
    const refs = [];
    for (const ref of String(m.references ?? '').split(/\s+/)) {
      const id = normId(ref);
      if (id) {
        refs.push(id);
      }
    }
    if (m.inReplyTo) {
      const id = normId(m.inReplyTo);
      if (id) {
        refs.push(id);
      }
    }
    for (const id of refs) {
      const hit = byMsgId.get(id);
      if (hit && hit !== m) {
        union(m, hit);
      }
    }
  }

  // 2. same base subject: applied on the merged groups of step 1 so replies
  // that dropped their references land on the right conversation
  const groups = new Map();
  for (const m of messages) {
    const root = find(m);
    let g = groups.get(root);
    if (!g) {
      g = [];
      groups.set(root, g);
    }
    g.push(m);
  }
  const subjectRoots = new Map();
  for (const group of groups.values()) {
    const key = baseSubject(group[0].subject);
    if (!key) {
      continue;
    }
    const prior = subjectRoots.get(key);
    if (prior) {
      union(group[0], prior[0]);
    }
    else {
      subjectRoots.set(key, group);
    }
  }

  // regroup with the subject links applied
  const final = new Map();
  for (const m of messages) {
    const root = find(m);
    let g = final.get(root);
    if (!g) {
      g = [];
      final.set(root, g);
    }
    g.push(m);
  }

  // build the ThreadSummary shape
  const out = [];
  for (const group of final.values()) {
    const sorted = [...group]
      .sort((a, b) => (a.uid - b.uid) || (timeOf(a.date) - timeOf(b.date)));
    const oldest = sorted[0];
    const newest = sorted[sorted.length - 1];
    const dates = sorted
      .map(m => ({t: timeOf(m.date), d: m.date}))
      .filter(x => x.t)
      .sort((a, b) => b.t - a.t);
    out.push({
      uids: sorted.map(m => m.uid),
      count: sorted.length,
      unread: sorted.filter(m => !hasFlag(m.flags, '\\Seen')).length,
      flagged: sorted.some(m => hasFlag(m.flags, '\\Flagged')),
      subject: oldest.subject ?? null,
      from: oldest.from ?? null,
      date: dates[0]?.d ?? newest?.date ?? null,
      messages: sorted.map(m => ({
        uid: m.uid,
        flags: Array.isArray(m.flags) ? [...m.flags] : [],
        subject: m.subject ?? null,
        from: m.from ?? null,
        date: m.date ?? null,
      })),
    });
  }
  out.sort((a, b) => (timeOf(b.date) - timeOf(a.date)) || (lastUid(b) - lastUid(a)));
  return out;
}

function lastUid(thread) {
  return thread.uids.length ? thread.uids[thread.uids.length - 1] : 0;
}
