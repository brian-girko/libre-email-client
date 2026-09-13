//! Client-side conversation threading (Gmail-style), port of the JWZ
//! message-threading algorithm (https://www.jwz.org/doc/threading.html).
//!
//! Messages are grouped by their `Message-ID` / `References` /
//! `In-Reply-To` chains; roots whose subjects match after stripping
//! `Re:`/`Fwd:` prefixes are merged so that orphaned replies still land in
//! the right conversation. Works on every IMAP server — no server-side
//! THREAD support required.

use std::collections::HashMap;

use serde::Serialize;

/// One message as fed into the threader.
#[derive(Clone, Debug, Default)]
pub struct ThreadMsg {
    pub uid: u32,
    pub message_id: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Option<String>,
    pub subject: Option<String>,
    pub from: Option<String>,
    pub date: Option<String>,
    pub flags: Vec<String>,
}

/// One message inside a [`ThreadSummary`] (shape mirrors the flat list rows).
#[derive(Clone, Debug, Default, Serialize)]
pub struct ThreadMessageOut {
    pub uid: u32,
    pub flags: Vec<String>,
    pub subject: Option<String>,
    pub from: Option<String>,
    pub date: Option<String>,
}

/// An aggregated conversation, newest thread first; `messages` inside are
/// oldest first.
#[derive(Clone, Debug, Default, Serialize)]
pub struct ThreadSummary {
    pub uids: Vec<u32>,
    pub count: u32,
    pub unread: u32,
    pub flagged: bool,
    pub subject: Option<String>,
    pub from: Option<String>,
    pub date: Option<String>,
    pub messages: Vec<ThreadMessageOut>,
}

// ---------------------------------------------------------------------------
// id / subject helpers
// ---------------------------------------------------------------------------

/// First `<...>` token of a Message-ID-ish header, angle brackets stripped
/// and lowercased for matching.
fn first_id(raw: Option<&str>) -> Option<String> {
    let raw = raw?;
    let start = raw.find('<')?;
    let end = raw[start..].find('>')? + start;
    let id = raw[start + 1..end].trim();
    if id.is_empty() {
        None
    } else {
        Some(id.to_ascii_lowercase())
    }
}

/// All `<...>` tokens of a References header (lowercased, brackets stripped).
fn all_ids(raw: Option<&str>) -> Vec<String> {
    let mut out = Vec::new();
    let Some(raw) = raw else { return out };
    let mut rest = raw;
    while let Some(s) = rest.find('<') {
        let Some(e) = rest[s..].find('>') else { break };
        let id = rest[s + 1..s + e].trim();
        if !id.is_empty() {
            out.push(id.to_ascii_lowercase());
        }
        rest = &rest[s + e + 1..];
    }
    out
}

/// Strip reply/forward prefixes (`Re:`, `Fw:`, `Fwd:`, repeated, optionally
/// with `[2]`-style counters in between). Returns the normalized subject and
/// whether any prefix was found.
pub fn normalize_subject(subject: &str) -> (String, bool) {
    let mut s = subject.trim();
    let mut prefix = false;
    loop {
        let lower = s.to_ascii_lowercase();
        let kw = if lower.starts_with("fwd") {
            3
        } else if lower.starts_with("fw") || lower.starts_with("re") {
            2
        } else {
            break;
        };
        let b = s.as_bytes();
        let mut i = kw;
        let mut end = None;
        while i < b.len() {
            match b[i] {
                b'[' => match s[i..].find(']') {
                    Some(e) => i += e + 1,
                    None => break,
                },
                b' ' | b'\t' => i += 1,
                b':' => {
                    end = Some(i + 1);
                    break;
                }
                _ => break,
            }
        }
        match end {
            Some(e) => {
                prefix = true;
                s = s[e..].trim();
            }
            None => break,
        }
    }
    (s.to_string(), prefix)
}

fn is_unseen(flags: &[String]) -> bool {
    !flags.iter().any(|f| f.eq_ignore_ascii_case("\\Seen"))
}

fn is_flagged(flags: &[String]) -> bool {
    flags.iter().any(|f| f.eq_ignore_ascii_case("\\Flagged"))
}

// ---------------------------------------------------------------------------
// container tree
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Container {
    /// Index into the message vec for the first message with this id.
    msg: Option<usize>,
    /// Messages sharing an already-claimed Message-ID (kept in the thread).
    dups: Vec<usize>,
    parent: Option<usize>,
    children: Vec<usize>,
    dead: bool,
}

#[derive(Default)]
struct Threader {
    containers: Vec<Container>,
    ids: HashMap<String, usize>,
}

impl Threader {
    fn container_for(&mut self, id: &str) -> usize {
        if let Some(&i) = self.ids.get(id) {
            return i;
        }
        let i = self.containers.len();
        self.containers.push(Container::default());
        self.ids.insert(id.to_string(), i);
        i
    }

    fn is_ancestor(&self, ancestor: usize, node: usize) -> bool {
        let mut cur = self.containers[node].parent;
        let mut guard = 0;
        while let Some(p) = cur {
            if p == ancestor {
                return true;
            }
            cur = self.containers[p].parent;
            guard += 1;
            if guard > self.containers.len() {
                return true; // cycle safety net
            }
        }
        false
    }

    /// Attach `child` under `parent`. With `force` an existing parent link is
    /// replaced (the JWZ "definitive parent from the actual message" rule);
    /// otherwise only parentless containers get linked. Loop-safe.
    fn attach(&mut self, parent: usize, child: usize, force: bool) {
        if parent == child || self.containers[parent].dead || self.containers[child].dead {
            return;
        }
        if self.is_ancestor(child, parent) {
            return;
        }
        if let Some(old) = self.containers[child].parent {
            if !force || old == parent {
                return;
            }
            self.containers[old].children.retain(|&c| c != child);
        }
        self.containers[child].parent = Some(parent);
        self.containers[parent].children.push(child);
    }

    /// JWZ step 4: drop empty childless containers, promote children of empty
    /// containers upwards (a root-level empty container with several children
    /// stays as the thread's virtual root so the thread does not split).
    fn prune_empty(&mut self) {
        loop {
            let mut changed = false;
            for i in 0..self.containers.len() {
                if self.containers[i].dead || self.containers[i].msg.is_some() || !self.containers[i].dups.is_empty() {
                    continue;
                }
                if self.containers[i].children.is_empty() {
                    if let Some(p) = self.containers[i].parent.take() {
                        self.containers[p].children.retain(|&c| c != i);
                    }
                    self.containers[i].dead = true;
                    changed = true;
                } else if self.containers[i].parent.is_some() || self.containers[i].children.len() == 1 {
                    let kids = std::mem::take(&mut self.containers[i].children);
                    let p = self.containers[i].parent.take();
                    for k in kids {
                        self.containers[k].parent = p;
                        if let Some(pp) = p {
                            self.containers[pp].children.push(k);
                        }
                    }
                    if let Some(pp) = p {
                        self.containers[pp].children.retain(|&c| c != i);
                    }
                    self.containers[i].dead = true;
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
    }

    /// First message index found at/below this container (tree order).
    fn first_msg(&self, c: usize) -> Option<usize> {
        let mut stack = vec![c];
        while let Some(cur) = stack.pop() {
            if let Some(m) = self.containers[cur].msg {
                return Some(m);
            }
            if let Some(&d) = self.containers[cur].dups.first() {
                return Some(d);
            }
            stack.extend(self.containers[cur].children.iter().copied());
        }
        None
    }

    fn subject_of(&self, c: usize, msgs: &[ThreadMsg]) -> Option<String> {
        self.first_msg(c).and_then(|m| msgs[m].subject.clone())
    }

    /// JWZ step 5: merge root containers whose normalized subjects match, so
    /// orphaned replies ("Re: x" with a broken/absent References chain) join
    /// the conversation started by "x".
    fn merge_by_subject(&mut self, msgs: &[ThreadMsg]) {
        let roots: Vec<usize> = self
            .containers
            .iter()
            .enumerate()
            .filter(|(_, c)| !c.dead && c.parent.is_none())
            .map(|(i, _)| i)
            .collect();
        if roots.len() <= 1 {
            return;
        }
        let mut buckets: HashMap<String, Vec<usize>> = HashMap::new();
        for r in roots {
            let key = self
                .subject_of(r, msgs)
                .map(|s| normalize_subject(&s).0)
                .unwrap_or_default();
            buckets.entry(key).or_default().push(r);
        }
        // Deterministic iteration order (by first root index) keeps output stable.
        let mut ordered: Vec<(String, Vec<usize>)> = buckets.into_iter().collect();
        ordered.sort_by_key(|(_, g)| g[0]);
        for (key, group) in ordered {
            if group.len() <= 1 {
                continue;
            }
            // Messages without any subject never merge with each other.
            if key.is_empty() {
                continue;
            }
            let empty = group
                .iter()
                .copied()
                .find(|&r| self.containers[r].msg.is_none() && self.containers[r].dups.is_empty());
            let parent = match empty {
                Some(e) => e,
                None => {
                    let any_reply = group.iter().any(|&r| {
                        self.subject_of(r, msgs)
                            .map(|s| normalize_subject(&s).1)
                            .unwrap_or(false)
                    });
                    if group.len() == 2 && !any_reply {
                        // Two unrelated conversations that merely share a subject.
                        continue;
                    }
                    let n = self.containers.len();
                    self.containers.push(Container::default());
                    n
                }
            };
            for &r in &group {
                if r != parent {
                    self.attach(parent, r, false);
                }
            }
        }
    }

    /// Collect all message indices of the (live) subtree rooted at `c`.
    fn collect(&self, c: usize, out: &mut Vec<usize>) {
        let mut stack = vec![c];
        while let Some(cur) = stack.pop() {
            let cont = &self.containers[cur];
            if cont.dead {
                continue;
            }
            if let Some(m) = cont.msg {
                out.push(m);
            }
            out.extend(cont.dups.iter().copied());
            stack.extend(cont.children.iter().copied());
        }
    }

    fn roots(&self) -> Vec<usize> {
        self.containers
            .iter()
            .enumerate()
            .filter(|(_, c)| !c.dead && c.parent.is_none())
            .map(|(i, _)| i)
            .collect()
    }
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/// Group messages into conversations. Input order is irrelevant; threads come
/// back newest-first and contain their messages oldest-first.
pub fn group_threads(msgs: Vec<ThreadMsg>) -> Vec<ThreadSummary> {
    let mut t = Threader::default();

    for (i, m) in msgs.iter().enumerate() {
        // Reference chain: References header, else fall back to In-Reply-To.
        let mut refs = all_ids(m.references.as_deref());
        if refs.is_empty() {
            if let Some(p) = first_id(m.in_reply_to.as_deref()) {
                refs.push(p);
            }
        }
        let own = first_id(m.message_id.as_deref());
        if let Some(mid) = &own {
            refs.retain(|r| r != mid); // no self-references
        }

        let mut prev: Option<usize> = None;
        for r in refs {
            let c = t.container_for(&r);
            if let Some(p) = prev {
                t.attach(p, c, false);
            }
            prev = Some(c);
        }

        match own {
            Some(id) => {
                let claimed = t.ids.get(&id).copied().filter(|&e| t.containers[e].msg.is_some());
                match claimed {
                    Some(e) => {
                        // Duplicate Message-ID: keep the message, same thread.
                        t.containers[e].dups.push(i);
                        if let Some(p) = prev {
                            t.attach(p, e, false);
                        }
                        continue;
                    }
                    None => {
                        let c = t.container_for(&id);
                        t.containers[c].msg = Some(i);
                        if let Some(p) = prev {
                            // The actual message defines the definitive parent.
                            t.attach(p, c, true);
                        }
                    }
                }
            }
            None => {
                let c = t.containers.len();
                t.containers.push(Container {
                    msg: Some(i),
                    ..Container::default()
                });
                if let Some(p) = prev {
                    t.attach(p, c, false);
                }
            }
        }
    }

    t.prune_empty();
    t.merge_by_subject(&msgs);

    let mut threads: Vec<ThreadSummary> = Vec::new();
    for root in t.roots() {
        let mut idxs = Vec::new();
        t.collect(root, &mut idxs);
        if idxs.is_empty() {
            continue;
        }
        idxs.sort_by_key(|&i| msgs[i].uid);
        idxs.dedup_by_key(|i| msgs[*i].uid);

        let first = msgs[idxs[0]].clone();
        let last = msgs[*idxs.last().unwrap()].clone();
        let mut uids = Vec::with_capacity(idxs.len());
        let mut messages = Vec::with_capacity(idxs.len());
        let mut unread = 0;
        let mut flagged = false;
        for &i in &idxs {
            let m = &msgs[i];
            uids.push(m.uid);
            if is_unseen(&m.flags) {
                unread += 1;
            }
            flagged |= is_flagged(&m.flags);
            messages.push(ThreadMessageOut {
                uid: m.uid,
                flags: m.flags.clone(),
                subject: m.subject.clone(),
                from: m.from.clone(),
                date: m.date.clone(),
            });
        }
        threads.push(ThreadSummary {
            count: uids.len() as u32,
            uids,
            unread,
            flagged,
            subject: first.subject,
            from: first.from,
            date: last.date,
            messages,
        });
    }
    // Newest conversation first (highest newest-UID wins; UID order matches
    // arrival order within a mailbox).
    threads.sort_by(|a, b| b.uids.last().cmp(&a.uids.last()));
    threads
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn m(uid: u32, mid: &str, refs: &str, subject: &str) -> ThreadMsg {
        ThreadMsg {
            uid,
            message_id: if mid.is_empty() { None } else { Some(mid.into()) },
            references: if refs.is_empty() { None } else { Some(refs.into()) },
            subject: Some(subject.into()),
            from: Some("a@example.com".into()),
            date: Some("Mon, 7 Sep 2026 09:00:00 +0000".into()),
            flags: vec![],
            ..ThreadMsg::default()
        }
    }

    fn uids(threads: &[ThreadSummary]) -> Vec<Vec<u32>> {
        threads.iter().map(|t| t.uids.clone()).collect()
    }

    #[test]
    fn chain_via_references() {
        let threads = group_threads(vec![
            m(1, "<a@x>", "", "hello"),
            m(2, "<b@x>", "<a@x>", "Re: hello"),
            m(3, "<c@x>", "<a@x> <b@x>", "Re: hello"),
        ]);
        assert_eq!(uids(&threads), vec![vec![1, 2, 3]]);
        assert_eq!(threads[0].count, 3);
        assert_eq!(threads[0].subject.as_deref(), Some("hello"));
        assert_eq!(threads[0].messages[2].uid, 3);
    }

    #[test]
    fn missing_middle_links_to_root() {
        let threads = group_threads(vec![
            m(1, "<a@x>", "", "hello"),
            m(3, "<c@x>", "<a@x> <b@x>", "Re: hello"),
        ]);
        assert_eq!(uids(&threads), vec![vec![1, 3]]);
    }

    #[test]
    fn in_reply_to_fallback() {
        let mut b = m(2, "<b@x>", "", "Re: hello");
        b.in_reply_to = Some("<a@x>".into());
        let threads = group_threads(vec![m(1, "<a@x>", "", "hello"), b]);
        assert_eq!(uids(&threads), vec![vec![1, 2]]);
    }

    #[test]
    fn subject_merge_of_orphaned_reply() {
        let threads = group_threads(vec![
            m(1, "<a@x>", "", "budget"),
            m(2, "<r@x>", "", "Re: budget"), // broken chain, no references
        ]);
        assert_eq!(uids(&threads), vec![vec![1, 2]]);
    }

    #[test]
    fn unrelated_same_subject_stay_apart() {
        let threads = group_threads(vec![
            m(1, "<a@x>", "", "lunch"),
            m(2, "<b@x>", "", "lunch"),
        ]);
        assert_eq!(uids(&threads), vec![vec![2], vec![1]]);
    }

    #[test]
    fn three_nonreplies_same_subject_merge() {
        // >2 members with no reply marker: JWZ merges them conservatively.
        let threads = group_threads(vec![
            m(1, "<a@x>", "", "lunch"),
            m(2, "<b@x>", "", "lunch"),
            m(3, "<c@x>", "", "lunch"),
        ]);
        assert_eq!(uids(&threads), vec![vec![1, 2, 3]]);
    }

    #[test]
    fn ghost_reference_is_pruned() {
        let threads = group_threads(vec![m(1, "<a@x>", "<ghost@x>", "solo")]);
        assert_eq!(uids(&threads), vec![vec![1]]);
        assert_eq!(threads[0].subject.as_deref(), Some("solo"));
    }

    #[test]
    fn duplicate_message_ids_share_thread() {
        let threads = group_threads(vec![
            m(1, "<a@x>", "", "hello"),
            m(2, "<a@x>", "", "hello"),
            m(3, "<b@x>", "<a@x>", "Re: hello"),
        ]);
        assert_eq!(uids(&threads), vec![vec![1, 2, 3]]);
    }

    #[test]
    fn reference_loop_is_broken() {
        let threads = group_threads(vec![
            m(1, "<a@x>", "<b@x>", "one"),
            m(2, "<b@x>", "<a@x>", "two"),
        ]);
        assert_eq!(uids(&threads), vec![vec![1, 2]]);
    }

    #[test]
    fn self_reference_is_ignored() {
        let threads = group_threads(vec![m(1, "<a@x>", "<a@x>", "me")]);
        assert_eq!(uids(&threads), vec![vec![1]]);
    }

    #[test]
    fn aggregates_flags_and_dates() {
        let mut unread = m(2, "<b@x>", "<a@x>", "Re: hello");
        unread.flags = vec!["\\Flagged".into()];
        let threads = group_threads(vec![m(1, "<a@x>", "", "hello"), unread]);
        assert_eq!(threads[0].count, 2);
        assert_eq!(threads[0].unread, 2);
        assert!(threads[0].flagged);
        assert_eq!(threads[0].date.as_deref(), Some("Mon, 7 Sep 2026 09:00:00 +0000"));
    }

    #[test]
    fn threads_sorted_newest_first() {
        let threads = group_threads(vec![
            m(1, "<a@x>", "", "old"),
            m(2, "<b@x>", "", "mid"),
            m(3, "<c@x>", "", "new"),
        ]);
        assert_eq!(uids(&threads), vec![vec![3], vec![2], vec![1]]);
    }

    #[test]
    fn forward_prefixes_normalize() {
        assert_eq!(normalize_subject("Re: hello"), ("hello".into(), true));
        assert_eq!(normalize_subject("RE[2]: hello"), ("hello".into(), true));
        assert_eq!(normalize_subject("Fwd: hello"), ("hello".into(), true));
        assert_eq!(normalize_subject("Re: Fwd: Re: hello"), ("hello".into(), true));
        assert_eq!(normalize_subject("retro meeting"), ("retro meeting".into(), false));
        assert_eq!(normalize_subject("re"), ("re".into(), false));
    }

    #[test]
    fn id_extraction() {
        assert_eq!(first_id(Some("Re: x <Abc@X>")), Some("abc@x".into()));
        assert_eq!(first_id(Some("no brackets")), None);
        assert_eq!(
            all_ids(Some("<a@x> junk <b@x>")),
            vec!["a@x".to_string(), "b@x".to_string()]
        );
    }

    #[test]
    fn empty_input() {
        assert!(group_threads(vec![]).is_empty());
    }

    #[test]
    fn subjectless_messages_stay_apart() {
        let mut a = m(1, "<a@x>", "", "");
        a.subject = None;
        let mut b = m(2, "<b@x>", "", "");
        b.subject = None;
        let threads = group_threads(vec![a, b]);
        assert_eq!(uids(&threads), vec![vec![2], vec![1]]);
    }
}
