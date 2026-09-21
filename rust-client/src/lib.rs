pub mod threading;
pub mod tls;
pub mod ws_stream;

use std::sync::{Arc, Mutex};

use js_sys::Uint8Array;
use send_wrapper::SendWrapper;
use serde::Serialize;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();
}

use crate::tls::ConnStream;
use crate::ws_stream::{RxState, WsStream};
use crate::threading::{group_threads, ThreadMsg, ThreadSummary};
use async_imap::extensions::idle::IdleResponse;
use async_imap::types::UnsolicitedResponse;
use tokio_util::compat::{Compat, FuturesAsyncReadCompatExt};

type ImapSession = async_imap::Session<Compat<ConnStream>>;

/// Interval between NOOP polls when the server does not support IDLE.
const NOOP_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);

/// Result of an `idle_once` wait.
#[derive(Serialize)]
struct IdleResult {
    #[serde(rename = "type")]
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    raw: Option<String>,
}

#[derive(Serialize)]
struct MailboxInfo {
    name: String,
    delimiter: Option<String>,
    attrs: Vec<String>,
}

#[derive(Serialize)]
struct MailboxStatus {
    exists: u32,
    uidvalidity: u32,
    uidnext: u32,
    unseen: Option<u32>,
}

#[derive(Serialize)]
struct MsgSummary {
    uid: u32,
    flags: Vec<String>,
    subject: Option<String>,
    from: Option<String>,
    date: Option<String>,
    size: Option<u32>,
}

#[wasm_bindgen]
pub struct MailClient {
    transport: SendWrapper<JsValue>,
    rx: Arc<Mutex<RxState>>,
    host: String,
    user: String,
    pass: String,
    insecure: bool,
    plaintext: bool,
    session: Option<ImapSession>,
}

#[wasm_bindgen]
impl MailClient {
    /// `rx` is a [`TransportRx`] created by the JS glue and wired to WS
    /// events (`push_bytes` / `transport_closed` / `transport_error`).
    /// `transport` is a duck-typed JS object with `send(bytes)` and `close()`.
    /// Note: `rx` is only borrowed — the JS glue keeps owning it.
    #[wasm_bindgen(constructor)]
    pub fn new(host: String, user: String, pass: String, rx: &crate::ws_stream::TransportRx, transport: JsValue) -> MailClient {
        MailClient {
            transport: SendWrapper::new(transport),
            rx: rx.shared(),
            host,
            user,
            pass,
            insecure: false,
            plaintext: false,
            session: None,
        }
    }

    /// Accept any server TLS certificate (testing against local stub servers).
    pub fn set_insecure(&mut self, insecure: bool) {
        self.insecure = insecure;
    }

    /// Speak plaintext IMAP (no TLS) — for local servers on e.g. port 143/1143.
    pub fn set_plaintext(&mut self, plaintext: bool) {
        self.plaintext = plaintext;
    }

    /// Opens the transport, performs the TLS handshake (inside WASM) and logs in.
    pub async fn connect(&mut self) -> Result<(), JsValue> {
        if self.session.is_some() {
            return Ok(());
        }
        let ws = WsStream::new(self.transport.clone(), self.rx.clone());
        let conn = if self.plaintext {
            ConnStream::Plain(ws)
        } else {
            ConnStream::Tls(tls::connect_tls(&self.host, ws, self.insecure).await?)
        };
        let client = async_imap::Client::new(conn.compat());
        let session = client
            .login(&self.user, &self.pass)
            .await
            .map_err(|(e, _)| JsValue::from_str(&e.to_string()))?;
        self.session = Some(session);
        Ok(())
    }

    pub async fn logout(&mut self) -> Result<(), JsValue> {
        if let Some(s) = self.session.as_mut() {
            s.logout().await.map_err(|e| JsValue::from_str(&e.to_string()))?;
        }
        self.session = None;
        Ok(())
    }

    pub async fn list_mailboxes(&mut self) -> Result<JsValue, JsValue> {
        let s = self.session_mut()?;
        let mut out = Vec::new();
        let names = s
            .list(None, Some("*"))
            .await
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        use futures::StreamExt;
        let mut names = names;
        while let Some(n) = names.next().await {
            let n = n.map_err(|e| JsValue::from_str(&e.to_string()))?;
            out.push(MailboxInfo {
                name: n.name().to_string(),
                delimiter: n.delimiter().map(|d| d.to_string()),
                attrs: n.attributes().iter().map(name_attr_to_string).collect(),
            });
        }
        to_value(&out)
    }

    pub async fn select(&mut self, mailbox: &str) -> Result<JsValue, JsValue> {
        let s = self.session_mut()?;
        let m = s
            .select(mailbox)
            .await
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let status = MailboxStatus {
            exists: m.exists,
            uidvalidity: m.uid_validity.unwrap_or(0),
            uidnext: m.uid_next.unwrap_or(0),
            unseen: m.unseen,
        };
        to_value(&status)
    }

    /// CREATE a mailbox (RFC 3501 §6.3.3). Errors on `INBOX` and on names
    /// that already exist; servers create superior hierarchy names as needed.
    pub async fn create_mailbox(&mut self, mailbox: &str) -> Result<(), JsValue> {
        let s = self.session_mut()?;
        s.create(mailbox)
            .await
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// DELETE a mailbox (RFC 3501 §6.3.4). Errors on `INBOX`, unknown names,
    /// and mailboxes with inferior hierarchical names.
    pub async fn delete_mailbox(&mut self, mailbox: &str) -> Result<(), JsValue> {
        let s = self.session_mut()?;
        s.delete(mailbox)
            .await
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Fetch UID+FLAGS+ENVELOPE for a UID set (e.g. "1:500" or "3,7,9").
    pub async fn fetch_summaries(&mut self, uid_set: &str) -> Result<JsValue, JsValue> {
        let s = self.session_mut()?;
        let query = "(UID FLAGS ENVELOPE RFC822.SIZE)";
        let stream = s
            .uid_fetch(uid_set, query)
            .await
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        use futures::StreamExt;
        let mut stream = stream;
        let mut out = Vec::new();
        while let Some(f) = stream.next().await {
            let f = f.map_err(|e| JsValue::from_str(&e.to_string()))?;
            let env = f.envelope();
            out.push(MsgSummary {
                uid: f.uid.unwrap_or(0),
                flags: f.flags().map(flag_to_string).collect(),
                subject: env.and_then(|e| e.subject.as_deref()).map(bytes_to_string),
                from: env.and_then(|e| e.from.as_deref()).map(addr_list_string),
                date: env.and_then(|e| e.date.as_deref()).map(bytes_to_string),
                size: f.size,
            });
        }
        to_value(&out)
    }

    /// Group the whole mailbox into conversations (Gmail-style threading).
    ///
    /// Fetches UID+FLAGS+ENVELOPE plus the threading headers
    /// (Message-ID / In-Reply-To / References) for every message of the
    /// selected mailbox in UID batches, then runs the JWZ algorithm
    /// ([`threading::group_threads`]) in Rust. Returns a JSON array of
    /// thread summaries, newest conversation first:
    /// `[{uids, count, unread, flagged, subject, from, date, messages}]`.
    pub async fn fetch_threads(&mut self, mailbox: &str) -> Result<JsValue, JsValue> {
        // (Re)select so EXISTS reflects the mailbox we thread; the facade
        // keeps its openDir state in sync by passing the same name.
        let total = {
            let s = self.session_mut()?;
            let m = s
                .select(mailbox)
                .await
                .map_err(|e| JsValue::from_str(&e.to_string()))?;
            m.exists
        };

        // Batch by SEQUENCE number, not UID: real mailboxes have huge UID
        // holes (expunged mail), and walking 1..=uid_next by UID would issue
        // hundreds of empty round trips before reaching the first message.
        // Sequence numbers are contiguous 1..=exists, so the batch count is
        // proportional to the real message count; each response carries its
        // UID via the UID FETCH item.
        let mut msgs: Vec<ThreadMsg> = Vec::new();
        const BATCH: u32 = 500;
        let mut lo = 1u32;
        while total > 0 && lo <= total {
            let hi = (lo + BATCH - 1).min(total);
            let set = format!("{lo}:{hi}");
            let batch = self.fetch_thread_batch(&set).await?;
            msgs.extend(batch);
            lo = hi + 1;
        }

        to_value(&group_threads(msgs))
    }

    /// Server-side IMAP search on `mailbox`, grouped into conversations.
    ///
    /// `criteria` is a raw IMAP SEARCH query (e.g. `TEXT "sprint"` or
    /// `FROM "dana" SINCE 7-Sep-2026`). Runs `UID SEARCH <criteria>`, then
    /// fetches everything the threader needs for the matching UIDs and runs
    /// the JWZ algorithm. Returns the same JSON shape as [`Self::fetch_threads`]
    /// (newest conversation first) so the UI can render results like a
    /// normal folder.
    pub async fn search_threads(&mut self, mailbox: &str, criteria: &str) -> Result<JsValue, JsValue> {
        let criteria = criteria.trim();
        if criteria.is_empty() {
            return to_value(&Vec::<ThreadSummary>::new());
        }

        let uids: Vec<u32> = {
            let s = self.session_mut()?;
            s.select(mailbox)
                .await
                .map_err(|e| JsValue::from_str(&e.to_string()))?;
            let mut set: Vec<u32> = s
                .uid_search(criteria)
                .await
                .map_err(|e| JsValue::from_str(&e.to_string()))?
                .into_iter()
                .collect();
            set.sort_unstable();
            set
        };
        if uids.is_empty() {
            return to_value(&Vec::<ThreadSummary>::new());
        }

        let msgs = self.fetch_thread_batch_uids(&uid_set(&uids)).await?;
        to_value(&group_threads(msgs))
    }

    /// One batched FETCH of everything the threader needs for a UID set.
    async fn fetch_thread_batch_uids(&mut self, set: &str) -> Result<Vec<ThreadMsg>, JsValue> {
        let query = "(UID FLAGS ENVELOPE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (MESSAGE-ID IN-REPLY-TO REFERENCES)])";
        let s = self.session_mut()?;
        let stream = s
            .uid_fetch(set, query)
            .await
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        use futures::StreamExt;
        let mut stream = stream;
        let mut out = Vec::new();
        while let Some(f) = stream.next().await {
            let f = f.map_err(|e| JsValue::from_str(&e.to_string()))?;
            let env = f.envelope();
            let headers = f.header().map(parse_headers).unwrap_or_default();
            let hdr = |name: &str| header_value(&headers, name).map(str::to_string);
            out.push(ThreadMsg {
                uid: f.uid.unwrap_or(0),
                flags: f.flags().map(flag_to_string).collect(),
                // Header values win; ENVELOPE is the fallback for servers
                // that mangle HEADER.FIELDS responses.
                message_id: hdr("message-id")
                    .or_else(|| env.and_then(|e| e.message_id.as_deref()).map(bytes_to_string)),
                in_reply_to: hdr("in-reply-to")
                    .or_else(|| env.and_then(|e| e.in_reply_to.as_deref()).map(bytes_to_string)),
                references: hdr("references"),
                subject: env.and_then(|e| e.subject.as_deref()).map(bytes_to_string),
                from: env.and_then(|e| e.from.as_deref()).map(addr_list_string),
                date: env.and_then(|e| e.date.as_deref()).map(bytes_to_string),
            });
        }
        Ok(out)
    }

    /// One batched FETCH of everything the threader needs for a sequence set.
    async fn fetch_thread_batch(&mut self, set: &str) -> Result<Vec<ThreadMsg>, JsValue> {
        let query = "(UID FLAGS ENVELOPE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (MESSAGE-ID IN-REPLY-TO REFERENCES)])";
        let s = self.session_mut()?;
        let stream = s
            .fetch(set, query)
            .await
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        use futures::StreamExt;
        let mut stream = stream;
        let mut out = Vec::new();
        while let Some(f) = stream.next().await {
            let f = f.map_err(|e| JsValue::from_str(&e.to_string()))?;
            let env = f.envelope();
            let headers = f.header().map(parse_headers).unwrap_or_default();
            let hdr = |name: &str| header_value(&headers, name).map(str::to_string);
            out.push(ThreadMsg {
                uid: f.uid.unwrap_or(0),
                flags: f.flags().map(flag_to_string).collect(),
                // Header values win; ENVELOPE is the fallback for servers
                // that mangle HEADER.FIELDS responses.
                message_id: hdr("message-id")
                    .or_else(|| env.and_then(|e| e.message_id.as_deref()).map(bytes_to_string)),
                in_reply_to: hdr("in-reply-to")
                    .or_else(|| env.and_then(|e| e.in_reply_to.as_deref()).map(bytes_to_string)),
                references: hdr("references"),
                subject: env.and_then(|e| e.subject.as_deref()).map(bytes_to_string),
                from: env.and_then(|e| e.from.as_deref()).map(addr_list_string),
                date: env.and_then(|e| e.date.as_deref()).map(bytes_to_string),
            });
        }
        Ok(out)
    }

    /// Fetch one full message (raw RFC822) by UID.
    pub async fn fetch_message(&mut self, uid: u32) -> Result<Uint8Array, JsValue> {
        let s = self.session_mut()?;
        let stream = s
            .uid_fetch(uid.to_string(), "(UID BODY.PEEK[])")
            .await
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        use futures::StreamExt;
        let mut stream = stream;
        while let Some(f) = stream.next().await {
            let f = f.map_err(|e| JsValue::from_str(&e.to_string()))?;
            if let Some(body) = f.body() {
                return Ok(Uint8Array::from(body));
            }
        }
        Err(JsValue::from_str("no body returned"))
    }

    /// UID STORE flags on the selected mailbox: adds/removes IMAP flags
    /// (e.g. `\Seen`) for the given UIDs via `+FLAGS.SILENT` / `-FLAGS.SILENT`.
    pub async fn store_flags(
        &mut self,
        uids: Vec<u32>,
        add: Vec<String>,
        remove: Vec<String>,
    ) -> Result<(), JsValue> {
        if uids.is_empty() || (add.is_empty() && remove.is_empty()) {
            return Ok(());
        }
        let set = uid_set(&uids);
        use futures::StreamExt;
        let mut ops: Vec<(bool, &Vec<String>)> = Vec::with_capacity(2);
        if !add.is_empty() {
            ops.push((true, &add));
        }
        if !remove.is_empty() {
            ops.push((false, &remove));
        }
        // Each uid_store's fetch stream borrows the session; drain it fully
        // before issuing the next operation.
        let s = self.session_mut()?;
        for (is_add, flags) in ops {
            let query = format!(
                "{}FLAGS.SILENT ({})",
                if is_add { "+" } else { "-" },
                flags.iter().map(|f| flag_token(f)).collect::<Vec<_>>().join(" ")
            );
            let stream = s
                .uid_store(set.as_str(), query.as_str())
                .await
                .map_err(|e| JsValue::from_str(&e.to_string()))?;
            let mut stream = stream;
            while let Some(f) = stream.next().await {
                f.map_err(|e| JsValue::from_str(&e.to_string()))?;
            }
        }
        Ok(())
    }

    /// UID MOVE the given UIDs to `mailbox` (RFC 6851). When the server does
    /// not advertise the `MOVE` capability, falls back to
    /// COPY + `\Deleted` + EXPUNGE.
    pub async fn move_messages(&mut self, uids: Vec<u32>, mailbox: String) -> Result<(), JsValue> {
        if uids.is_empty() {
            return Ok(());
        }
        let set = uid_set(&uids);
        use futures::StreamExt;
        let s = self.session_mut()?;
        if matches!(s.capabilities().await, Ok(caps) if caps.has_str("MOVE")) {
            s.uid_mv(set.as_str(), mailbox.as_str())
                .await
                .map_err(|e| JsValue::from_str(&e.to_string()))?;
            return Ok(());
        }
        // Fallback: COPY + \Deleted + EXPUNGE (semantics of RFC 6851 §3.1).
        s.uid_copy(set.as_str(), mailbox.as_str())
            .await
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let stream = s
            .uid_store(set.as_str(), "+FLAGS.SILENT (\\Deleted)")
            .await
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let mut stream = stream;
        while let Some(f) = stream.next().await {
            f.map_err(|e| JsValue::from_str(&e.to_string()))?;
        }
        drop(stream);
        let expunged = s
            .expunge()
            .await
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        futures::pin_mut!(expunged);
        while let Some(seq) = expunged.next().await {
            seq.map_err(|e| JsValue::from_str(&e.to_string()))?;
        }
        Ok(())
    }

    /// UID EXPUNGE the given UIDs (RFC 4315): permanently removes messages
    /// that both carry the `\Deleted` flag (set via `store_flags`) and have
    /// one of the given UIDs. Requires the server to advertise `UIDPLUS`;
    /// without it this is a no-op — the flag stays set and the server purges
    /// the messages on its next expunge, so other clients' pending deletions
    /// are never touched.
    pub async fn expunge_messages(&mut self, uids: Vec<u32>) -> Result<(), JsValue> {
        if uids.is_empty() {
            return Ok(());
        }
        let set = uid_set(&uids);
        use futures::StreamExt;
        let s = self.session_mut()?;
        if !matches!(s.capabilities().await, Ok(caps) if caps.has_str("UIDPLUS")) {
            return Ok(());
        }
        let expunged = s
            .uid_expunge(set.as_str())
            .await
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        futures::pin_mut!(expunged);
        while let Some(seq) = expunged.next().await {
            seq.map_err(|e| JsValue::from_str(&e.to_string()))?;
        }
        Ok(())
    }

    /// APPEND a raw RFC822 message to `mailbox` (RFC 3501 §6.3.11).
    ///
    /// `content` is the full message (headers + body, CRLF line endings).
    /// `flags` is a list of IMAP flags to set initially (e.g. `["\\Seen"]`);
    /// pass an empty list for none. `internaldate` is an optional RFC 3501
    /// `date-time` string like `"16-Sep-2026 10:39:00 +0000"`. Targets a
    /// mailbox without disturbing the currently selected one — APPEND is the
    /// canonical way the facade uploads new `.eml` files.
    pub async fn upload_mail(
        &mut self,
        mailbox: &str,
        content: Vec<u8>,
        flags: Vec<String>,
        internaldate: Option<String>,
    ) -> Result<(), JsValue> {
        if content.is_empty() {
            return Err(JsValue::from_str("upload_mail: empty message content"));
        }
        if mailbox.is_empty() {
            return Err(JsValue::from_str("upload_mail: mailbox name required"));
        }
        let flags_str = if flags.is_empty() {
            None
        } else {
            Some(format!(
                "({})",
                flags
                    .iter()
                    .map(|f| flag_token(f))
                    .collect::<Vec<_>>()
                    .join(" ")
            ))
        };
        let s = self.session_mut()?;
        s.append(
            mailbox,
            flags_str.as_deref(),
            internaldate.as_deref(),
            content.as_slice(),
        )
        .await
        .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Enter IDLE on `mailbox` and wait up to `timeout_ms` for server updates.
    ///
    /// RFC 2177: the `IDLE` command is only used when the server advertises the
    /// `IDLE` capability. Otherwise (or if the server rejects IDLE anyway) this
    /// falls back to periodic NOOP polling and still resolves with the same
    /// result shape: `{type: "timeout" | "new-data" | "interrupt", raw?}`.
    pub async fn idle_once(&mut self, mailbox: &str, timeout_ms: u32) -> Result<JsValue, JsValue> {
        let dur = std::time::Duration::from_millis(timeout_ms.max(1000) as u64);

        {
            let s = self.session_mut()?;
            s.select(mailbox)
                .await
                .map_err(|e| JsValue::from_str(&e.to_string()))?;
        }

        // Take ownership of the session for the duration of the wait so the
        // IDLE handle (or the polling loop) can use it. It is always put back
        // before returning — on success and on error paths alike.
        let mut session = self
            .session
            .take()
            .ok_or_else(|| JsValue::from_str("not connected; call connect() first"))?;

        let mut idle_rejected: Option<String> = None;
        if server_supports_idle(&mut session).await {
            let mut handle = session.idle();
            match handle.init().await {
                Ok(()) => {
                    let (fut, _stop) = handle.wait_with_timeout(dur);
                    match fut.await {
                        Ok(res) => {
                            self.session = Some(
                                handle
                                    .done()
                                    .await
                                    .map_err(|e| JsValue::from_str(&e.to_string()))?,
                            );
                            let out = match res {
                                IdleResponse::Timeout => IdleResult {
                                    kind: "timeout".into(),
                                    raw: None,
                                },
                                IdleResponse::ManualInterrupt => IdleResult {
                                    kind: "interrupt".into(),
                                    raw: None,
                                },
                                IdleResponse::NewData(d) => IdleResult {
                                    kind: "new-data".into(),
                                    raw: Some(format!("{:?}", d.parsed())),
                                },
                            };
                            return to_value(&out);
                        }
                        Err(_e) => {
                            // Keep the session for the polling fallback below;
                            // if the transport is really dead, the first NOOP
                            // will surface the transport error.
                            session = handle.recover();
                        }
                    }
                }
                Err(e) => {
                    // e.g. `BAD Invalid command IDLE` from servers that reject
                    // IDLE despite (or without) advertising it.
                    idle_rejected = Some(e.to_string());
                    session = handle.recover();
                }
            }
        }

        let mut out = poll_by_noop(&mut session, dur).await?;
        if let Some(rej) = idle_rejected {
            out.raw = Some(match out.raw.take() {
                Some(r) => format!("{rej}; polled: {r}"),
                None => rej,
            });
        }
        self.session = Some(session);
        to_value(&out)
    }

    fn session_mut(&mut self) -> Result<&mut ImapSession, JsValue> {
        self.session
            .as_mut()
            .ok_or_else(|| JsValue::from_str("not connected; call connect() first"))
    }
}

fn to_value<T: Serialize>(v: &T) -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(v).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Comma-joined UID set for UID commands, e.g. `3,7,9`.
fn uid_set(uids: &[u32]) -> String {
    uids.iter().map(|u| u.to_string()).collect::<Vec<_>>().join(",")
}

/// One IMAP flag as a wire token. ATOM-safe values and `\`-prefixed flag
/// extensions (e.g. `\Seen`) are sent bare; anything else is sent as an
/// escaped quoted string.
fn flag_token(f: &str) -> String {
    let atom_ok = !f.is_empty()
        && f.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(
                    b,
                    b'!' | b'#' | b'$' | b'&' | b'\'' | b'+' | b'-' | b'.'
                        | b'/' | b':' | b'<' | b'=' | b'>' | b'@' | b'['
                        | b']' | b'^' | b'_' | b'`' | b'|' | b'}' | b'~'
                )
        });
    let flag_ext_ok = f.len() > 1
        && f.starts_with('\\')
        && f[1..]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
    if atom_ok || flag_ext_ok {
        return f.to_string();
    }
    let mut out = String::with_capacity(f.len() + 2);
    out.push('"');
    for c in f.chars() {
        if c == '"' || c == '\\' {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('"');
    out
}

/// RFC 2177: only use IDLE if the server advertises it. If the CAPABILITY
/// round trip itself fails we conservatively report "no IDLE" — the NOOP
/// polling fallback works everywhere.
async fn server_supports_idle(session: &mut ImapSession) -> bool {
    matches!(session.capabilities().await, Ok(caps) if caps.has_str("IDLE"))
}

/// Wait up to `dur` for mailbox updates by polling with NOOP. Untagged
/// `EXISTS` / `RECENT` / `EXPUNGE` responses that the server sends along the
/// way are treated as "new-data".
async fn poll_by_noop(
    session: &mut ImapSession,
    dur: std::time::Duration,
) -> Result<IdleResult, JsValue> {
    let mut elapsed = std::time::Duration::ZERO;
    loop {
        let remaining = dur.saturating_sub(elapsed);
        if remaining.is_zero() {
            return Ok(IdleResult {
                kind: "timeout".into(),
                raw: None,
            });
        }
        let step = remaining.min(NOOP_POLL_INTERVAL);
        futures_timer::Delay::new(step).await;
        elapsed += step;

        session
            .noop()
            .await
            .map_err(|e| JsValue::from_str(&format!("noop poll failed: {e}")))?;

        while let Ok(evt) = session.unsolicited_responses.try_recv() {
            let is_update = matches!(
                evt,
                UnsolicitedResponse::Exists(_)
                    | UnsolicitedResponse::Recent(_)
                    | UnsolicitedResponse::Expunge(_)
            );
            if is_update {
                return Ok(IdleResult {
                    kind: "new-data".into(),
                    raw: Some(format!("{evt:?}")),
                });
            }
        }
    }
}

fn name_attr_to_string(a: &imap_proto::types::NameAttribute<'_>) -> String {
    use imap_proto::types::NameAttribute as NA;
    match a {
        NA::NoInferiors => "\\Noinferiors".into(),
        NA::NoSelect => "\\Noselect".into(),
        NA::Marked => "\\Marked".into(),
        NA::Unmarked => "\\Unmarked".into(),
        NA::All => "\\All".into(),
        NA::Archive => "\\Archive".into(),
        NA::Drafts => "\\Drafts".into(),
        NA::Flagged => "\\Flagged".into(),
        NA::Junk => "\\Junk".into(),
        NA::Sent => "\\Sent".into(),
        NA::Trash => "\\Trash".into(),
        NA::Extension(s) => s.clone().into_owned(),
        _ => format!("{a:?}"),
    }
}

fn bytes_to_string(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

/// Parse a raw header block into `(lowercased-name, unfolded-value)` pairs.
/// Continuation lines (leading space/tab) are folded back onto the previous
/// header; malformed lines are skipped.
pub fn parse_headers(block: &[u8]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for line in String::from_utf8_lossy(block).lines() {
        if line.starts_with(' ') || line.starts_with('\t') {
            if let Some(last) = out.last_mut() {
                last.1.push(' ');
                last.1.push_str(line.trim());
            }
            continue;
        }
        let Some(colon) = line.find(':') else { continue };
        let name = line[..colon].trim().to_ascii_lowercase();
        if name.is_empty() {
            continue;
        }
        out.push((name, line[colon + 1..].trim().to_string()));
    }
    out
}

pub fn header_value<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    let name = name.to_ascii_lowercase();
    headers
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, v)| v.as_str())
}

fn flag_to_string(f: async_imap::types::Flag<'_>) -> String {
    match f {
        async_imap::types::Flag::Seen => "\\Seen".into(),
        async_imap::types::Flag::Answered => "\\Answered".into(),
        async_imap::types::Flag::Flagged => "\\Flagged".into(),
        async_imap::types::Flag::Deleted => "\\Deleted".into(),
        async_imap::types::Flag::Draft => "\\Draft".into(),
        async_imap::types::Flag::Recent => "\\Recent".into(),
        async_imap::types::Flag::MayCreate => "\\*".into(),
        async_imap::types::Flag::Custom(k) => k.into_owned(),
    }
}

fn addr_list_string(addrs: &[imap_proto::types::Address<'_>]) -> String {
    addrs
        .iter()
        .map(|a| {
            let mbox = a.mailbox.as_deref().map(bytes_to_string).unwrap_or_default();
            let host = a.host.as_deref().map(bytes_to_string).unwrap_or_default();
            match a.name.as_deref() {
                Some(n) => format!("{} <{}@{}>", bytes_to_string(n), mbox, host),
                None => format!("{}@{}", mbox, host),
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}