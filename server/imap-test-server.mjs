#!/usr/bin/env node
// imap-test-server.mjs — standalone minimal IMAP4rev1 test engine.
//
// Self-contained and dependency-free (node:net / node:tls only). Speaks just
// enough IMAP for end-to-end client tests: greeting, CAPABILITY, LOGIN (any
// credentials), LIST/LSUB (hierarchical mailboxes), CREATE / DELETE (dynamic
// mailbox set), SELECT, STATUS, UID FETCH (ENVELOPE summaries, RFC822.SIZE,
// BODY.PEEK[] bodies), STORE / UID STORE (flag changes: read/unread, star,
// ...), IDLE, NOOP, LOGOUT; anything else gets `BAD`.
//
// Deliberately independent from the mail clients and the extension: run it
// anywhere with plain Node.
//
//   node imap-test-server.mjs                    # 127.0.0.1:1143, plaintext
//   node imap-test-server.mjs --port 9931 --tls  # TLS (self-signed, needs openssl)
//   node imap-test-server.mjs --no-idle          # pretend IDLE doesn't exist
//   node imap-test-server.mjs --no-persist       # don't persist flag changes to disk
//   node imap-test-server.mjs --help
//
// Environment (backwards compatible with the older stub-imap.mjs):
//   STUB_PORT, STUB_TLS=0|1, STUB_NO_IDLE=0|1, STUB_CERT_DIR,
//   STUB_STATE_FILE, STUB_NO_PERSIST=0|1
//
// Test behaviors built in:
//   - simulates mail delivery ~3s into each connection: pushed as an untagged
//     `* N EXISTS` while the client is in IDLE, otherwise held back and
//     flushed with the next NOOP (exercises both the IDLE push and the
//     NOOP-poll fallback paths)
//   - every mailbox carries its own distinct set of seed messages
//   - every message keeps title, sender name and body in one locale; the
//     set spans en, fr, ru, zh, ja, ar and non-ASCII goes out as RFC 2047
//     encoded words so clients must decode them
//   - flag changes (STORE) are shared across connections and persisted to
//     disk, so a client reload sees them; --no-persist keeps them per-run
//
// Programmatic use:
//   import { startImapTestServer } from './imap-test-server.mjs';
//   const srv = await startImapTestServer({ port: 1143, tls: false });
//   ... srv.port ...
//   await srv.close();

import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// seeded mailbox content
// ---------------------------------------------------------------------------

const MAILBOXES = [
  "INBOX",
  "Archive",
  "Work",
  "Work/Projects",
  "Work/Meetings",
  "Sparse",
];

// RFC 2047 encoded word for non-ASCII header text, chunked so no single
// encoded word exceeds the 75-char limit (mid-character splits avoided)
function encodeWord(s) {
  if (!/[^\x00-\x7f]/.test(s)) return s;
  const chunks = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch, "utf8");
    if (cur && curBytes + b > 45) {
      chunks.push(cur);
      cur = "";
      curBytes = 0;
    }
    cur += ch;
    curBytes += b;
  }
  if (cur) chunks.push(cur);
  return chunks.map((c) => `=?utf-8?B?${Buffer.from(c, "utf8").toString("base64")}?=`).join(" ");
}

function stubMessage(uid, flags, from, to, subject, date, text, thread = {}) {
  const name = from.replace(/\s*<[^>]*>\s*$/, "").trim();
  const addr = from.match(/<[^>]*>/)?.[0] ?? "";
  const fromHeader = `${encodeWord(name)}${addr ? ` ${addr}` : ""}`;
  const msgid = thread.msgid ?? `<stub-${uid}@example.com>`;
  const irt = thread.inReplyTo ?? null;
  const refs = thread.references ?? null;
  let headers =
    `From: ${fromHeader}\r\n` +
    `To: ${to}\r\n` +
    `Subject: ${encodeWord(subject)}\r\n` +
    `Date: ${date}\r\n` +
    `Message-ID: ${msgid}\r\n`;
  if (irt) headers += `In-Reply-To: ${irt}\r\n`;
  if (refs) headers += `References: ${refs}\r\n`;
  return {
    uid,
    flags,
    from,
    to,
    subject,
    date,
    msgid,
    irt,
    refs,
    body: headers + "\r\n" + text,
  };
}

// every message keeps title, sender name and body in one locale; the set
// spans en, fr, ru, zh, ja and ar. Text is stored raw here; headers and
// ENVELOPE strings are turned into RFC 2047 encoded words on the wire.
const MAILBOX_MESSAGES = {
  INBOX: [
    stubMessage(
      101,
      ["\\Seen"],
      "Настя Иванова <nastya@example.com>",
      "user@example.com",
      "Тестовое письмо",
      "Mon, 7 Sep 2026 09:00:00 +0000",
      "Это тестовое письмо №1. Проверка локали.\r\n",
    ),
    stubMessage(
      102,
      [],
      "Alice Example <alice@example.com>",
      "user@example.com",
      "Second stub message",
      "Mon, 7 Sep 2026 10:30:00 +0000",
      "This is stub message #2.\r\n",
    ),
    // a reply to 101: groups {101, 103} into one conversation
    stubMessage(
      103,
      ["\\Seen"],
      "user@example.com",
      "Настя Иванова <nastya@example.com>",
      "Re: Тестовое письмо",
      "Mon, 7 Sep 2026 11:45:00 +0000",
      "Ответ на тестовое письмо №1.\r\n",
      {inReplyTo: "<stub-101@example.com>", references: "<stub-101@example.com>"},
    ),
    // a three-message conversation {104, 105, 106}
    stubMessage(
      104,
      [],
      "Dana Lead <dana@example.com>",
      "user@example.com",
      "Sprint planning Friday",
      "Tue, 8 Sep 2026 09:00:00 +0000",
      "Sprint planning moves to Friday 10am.\r\n",
    ),
    stubMessage(
      105,
      [],
      "Bob Build <bob@example.com>",
      "user@example.com",
      "Re: Sprint planning Friday",
      "Tue, 8 Sep 2026 10:00:00 +0000",
      "Friday works for me.\r\n",
      {inReplyTo: "<stub-104@example.com>", references: "<stub-104@example.com>"},
    ),
    stubMessage(
      106,
      ["\\Seen"],
      "Dana Lead <dana@example.com>",
      "user@example.com",
      "Re: Sprint planning Friday",
      "Tue, 8 Sep 2026 11:00:00 +0000",
      "Meeting invite sent, see you Friday.\r\n",
      {
        inReplyTo: "<stub-105@example.com>",
        references: "<stub-104@example.com> <stub-105@example.com>",
      },
    ),
    // a standalone single
    stubMessage(
      107,
      [],
      "Alice Example <alice@example.com>",
      "user@example.com",
      "Lunch tomorrow?",
      "Wed, 9 Sep 2026 08:00:00 +0000",
      "Soup place at noon, as usual?\r\n",
    ),
  ],
  Archive: [
    stubMessage(
      201,
      ["\\Seen"],
      "Service Facturation <facturation@services.example.com>",
      "user@example.com",
      "Facture #4211 payée",
      "Tue, 1 Sep 2026 08:15:00 +0000",
      "Votre facture n°4211 a bien été payée.\r\n",
    ),
    stubMessage(
      202,
      ["\\Seen"],
      "News Digest <news@lists.example.com>",
      "user@example.com",
      "September digest",
      "Wed, 2 Sep 2026 07:00:00 +0000",
      "Here is what happened in September.\r\n",
    ),
    stubMessage(
      203,
      ["\\Seen"],
      "Бухгалтерия <accounting@example.com>",
      "user@example.com",
      "Отчёт за август",
      "Thu, 3 Sep 2026 16:40:00 +0000",
      "Отчёт за август приложен к письму.\r\n",
    ),
  ],
  Work: [
    stubMessage(
      301,
      [],
      "Bureau de Projet <pm@example.com>",
      "user@example.com",
      "Planification du sprint 42",
      "Mon, 7 Sep 2026 11:00:00 +0000",
      "La planification commence à 14h00, merci d'apporter vos estimations.\r\n",
    ),
    stubMessage(
      302,
      ["\\Flagged"],
      "CIボット <ci@example.com>",
      "user@example.com",
      "ビルドが回復しました",
      "Mon, 7 Sep 2026 13:20:00 +0000",
      "パイプライン #8123 が回復しました。失敗は 2 回でした。\r\n",
    ),
  ],
  "Work/Projects": [
    stubMessage(
      401,
      ["\\Flagged"],
      "Dana Lead <dana@example.com>",
      "user@example.com",
      "Project Phoenix: kickoff notes",
      "Tue, 8 Sep 2026 09:10:00 +0000",
      "Kickoff notes are in the wiki.\r\n",
    ),
    stubMessage(
      402,
      [],
      "Коля Смирнов <kolya@example.com>",
      "user@example.com",
      "Задача: обновить сервер",
      "Tue, 8 Sep 2026 12:05:00 +0000",
      "Задача по обновлению сервера готова к проверке.\r\n",
    ),
    stubMessage(
      403,
      ["\\Seen"],
      "王伟 <wangwei@example.com>",
      "user@example.com",
      "截止日期改为周五",
      "Tue, 8 Sep 2026 17:45:00 +0000",
      "截止日期已更改为周五，请重新安排计划。\r\n",
    ),
  ],
  "Work/Meetings": [
    stubMessage(
      501,
      [],
      "سارة العلي <sara@example.com>",
      "user@example.com",
      "دعوة اجتماع الفريق",
      "Mon, 7 Sep 2026 08:00:00 +0000",
      "تم تغيير موعد الاجتماع إلى الثلاثاء الساعة العاشرة صباحًا.\r\n",
    ),
    stubMessage(
      502,
      ["\\Seen"],
      "佐藤 花子 <rita@example.com>",
      "user@example.com",
      "議事録: アーキテクチャレビュー",
      "Wed, 9 Sep 2026 10:30:00 +0000",
      "アーキテクチャレビューの議事録を公開しました。\r\n",
    ),
  ],
  // mailboxes on real servers have huge UID holes (expunged mail): few
  // messages, uidnext far ahead. Regression coverage for threading by
  // sequence number instead of walking the UID space.
  Sparse: [
    stubMessage(
      113929,
      [],
      "Dana Lead <dana@example.com>",
      "user@example.com",
      "Sparse root",
      "Tue, 8 Sep 2026 09:00:00 +0000",
      "Sparse mailbox thread root.\r\n",
    ),
    stubMessage(
      113930,
      [],
      "Bob Build <bob@example.com>",
      "user@example.com",
      "Re: Sparse root",
      "Tue, 8 Sep 2026 10:00:00 +0000",
      "Reply in the sparse mailbox.\r\n",
      {inReplyTo: "<stub-113929@example.com>", references: "<stub-113929@example.com>"},
    ),
    stubMessage(
      113931,
      ["\\Seen"],
      "Alice Example <alice@example.com>",
      "user@example.com",
      "Sparse lone",
      "Tue, 8 Sep 2026 11:00:00 +0000",
      "Standalone message in the sparse mailbox.\r\n",
    ),
  ],
};

const UID_VALIDITY = 1725700000;
const DELIVERY_AFTER_MS = 3000;

const uidNextFor = (msgs) => msgs.reduce((m, x) => Math.max(m, x.uid), 100) + 1;

// ---------------------------------------------------------------------------
// configuration: CLI flags > environment > defaults
// ---------------------------------------------------------------------------

export function resolveConfig({ argv = process.argv, env = process.env } = {}) {
  const args = argv.slice(2);
  const flag = (name) => args.includes(name);
  const value = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
  };
  if (flag("--help") || flag("-h")) {
    console.log(
      [
        "usage: node imap-test-server.mjs [options]",
        "",
        "options:",
        "  --port N          listen port (default 1143; env STUB_PORT)",
        "  --tls             TLS with self-signed cert (needs openssl)",
        "  --no-tls          plaintext IMAP (CLI default; env STUB_TLS=0|1)",
        "  --no-idle         do not advertise or accept IDLE (env STUB_NO_IDLE=1)",
        "  --no-delivery     disable the simulated mail delivery",
        "  --state-file FILE where to persist flag state (default .imap-test-state.json",
        "                    next to this script; env STUB_STATE_FILE)",
        "  --no-persist      keep flag state in memory only (env STUB_NO_PERSIST=1)",
        "  --cert-dir DIR    where to store generated certs (env STUB_CERT_DIR)",
        "  --quiet           suppress per-line logging",
        "  -h, --help",
      ].join("\n"),
    );
    process.exit(0);
  }
  const tlsFlag = flag("--tls");
  const noTlsFlag = flag("--no-tls");
  let tls;
  if (tlsFlag) tls = true;
  else if (noTlsFlag) tls = false;
  else if (env.STUB_TLS === "0") tls = false;
  else if (env.STUB_TLS === "1") tls = true;
  else tls = false; // CLI default: plaintext
  return {
    port: parseInt(value("--port", env.STUB_PORT || "1143"), 10),
    tls,
    noIdle: flag("--no-idle") || env.STUB_NO_IDLE === "1",
    noDelivery: flag("--no-delivery"),
    stateFile: flag("--no-persist") || env.STUB_NO_PERSIST === "1"
      ? null
      : value("--state-file", env.STUB_STATE_FILE || path.join(SCRIPT_DIR, ".imap-test-state.json")),
    certDir: value("--cert-dir", env.STUB_CERT_DIR || path.join(SCRIPT_DIR, "certs")),
    quiet: flag("--quiet"),
  };
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

function ensureCerts(cfg, log) {
  const key = path.join(cfg.certDir, "key.pem");
  const cert = path.join(cfg.certDir, "cert.pem");
  if (!fs.existsSync(cert) || !fs.existsSync(key)) {
    fs.mkdirSync(cfg.certDir, { recursive: true });
    log(`generating self-signed certificate into ${cfg.certDir}...`);
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${key}" -out "${cert}" -days 365 -nodes -subj "/CN=127.0.0.1"` +
      ` -addext "subjectAltName=IP:127.0.0.1,DNS:localhost"` +
      ` -addext "basicConstraints=critical,CA:FALSE"` +
      ` -addext "keyUsage=digitalSignature,keyEncipherment"` +
      ` -addext "extendedKeyUsage=serverAuth"`,
      { stdio: "ignore" },
    );
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

// flag state is persisted as { mailbox: { uid: [flags] } } so a client sees
// its STOREs again after a reload or even a server restart; corrupt or alien
// files fall back to the seed flags
function loadFlagState(file, log) {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const out = {};
    for (const [box, uids] of Object.entries(raw)) {
      if (!MAILBOX_MESSAGES[box] || typeof uids !== "object" || uids === null) continue;
      out[box] = {};
      for (const [uid, flags] of Object.entries(uids)) {
        if (Array.isArray(flags)) out[box][Number(uid)] = flags.filter((f) => typeof f === "string");
      }
    }
    return out;
  } catch (e) {
    log(`warning: ignoring unreadable state file ${file}: ${e.message}`);
    return null;
  }
}

function saveFlagState(boxes, file, log) {
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const serial = {};
    for (const box of [...boxes.keys()].sort()) {
      serial[box] = {};
      for (const m of boxes.get(box)) serial[box][m.uid] = m.flags;
    }
    fs.writeFileSync(tmp, JSON.stringify(serial, null, 2) + "\n");
    fs.renameSync(tmp, file);
  } catch (e) {
    log(`warning: could not write state file ${file}: ${e.message}`);
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
  }
}

/**
 * Start the IMAP test server.
 * @param {{port?: number, tls?: boolean, noIdle?: boolean, noDelivery?: boolean,
 *          stateFile?: string|null, certDir?: string, quiet?: boolean,
 *          log?: (msg: string) => void}} [options]
 * @returns {Promise<{port: number, close: () => Promise<void>}>}
 */
export async function startImapTestServer(options = {}) {
  const cfg = {
    port: options.port ?? 1143,
    tls: !!options.tls,
    noIdle: !!options.noIdle,
    noDelivery: !!options.noDelivery,
    stateFile: options.stateFile === undefined
      ? path.join(SCRIPT_DIR, ".imap-test-state.json")
      : options.stateFile,
    certDir: options.certDir || path.join(SCRIPT_DIR, "certs"),
    quiet: !!options.quiet,
  };
  const log = (msg) => {
    if (options.log) options.log(msg);
    else if (!cfg.quiet) console.log(`[imap-test] ${msg}`);
  };

  // flag state is shared by every connection of this server instance; seeds
  // get overlaid with whatever a previous run persisted
  const boxes = new Map(
    MAILBOXES.map((name) => [
      name,
      MAILBOX_MESSAGES[name].map((m) => ({ ...m, flags: [...m.flags] })),
    ]),
  );
  if (cfg.stateFile) {
    const saved = loadFlagState(cfg.stateFile, log);
    if (saved) {
      for (const [box, uids] of Object.entries(saved)) {
        const msgs = boxes.get(box);
        for (const [uid, flags] of Object.entries(uids)) {
          const msg = msgs.find((m) => m.uid === Number(uid));
          if (msg) msg.flags = [...flags];
        }
      }
      log(`flag state loaded from ${cfg.stateFile}`);
    }
  }
  const persist = () => {
    if (cfg.stateFile) saveFlagState(boxes, cfg.stateFile, log);
  };

  let credentials = null;
  if (cfg.tls) {
    credentials = ensureCerts(cfg, log);
  }

  const state = { boxes, persist };
  const server = cfg.tls
    ? tls.createServer(credentials, (sock) => handleConnection(sock, cfg, log, state))
    : net.createServer((sock) => handleConnection(sock, cfg, log, state));

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, "127.0.0.1", resolve);
  });
  const boundPort = server.address().port;

  log(`IMAP test server listening on 127.0.0.1:${boundPort} (${cfg.tls ? "TLS" : "plaintext"}${cfg.noIdle ? ", no IDLE" : ""}${cfg.stateFile ? "" : ", no persist"})`);

  return {
    port: boundPort,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

// ---------------------------------------------------------------------------
// per-connection IMAP state machine
// ---------------------------------------------------------------------------

function handleConnection(sock, cfg, log, { boxes, persist }) {
  log("client connected");
  sock.setEncoding("latin1");

  let idle = false;
  let idleTag = "?";
  let lineBuf = "";
  let delivered = false;
  let pendingExists = false;
  let selected = null;

  const currentMessages = () => boxes.get(selected ?? "INBOX");

  const capability = `IMAP4rev1${cfg.noIdle ? "" : " IDLE"} UIDPLUS`;
  const write = (s) => {
    log(`<< ${s.length > 90 ? s.slice(0, 90) + "..." : s}`);
    sock.write(s);
  };

  // Simulated mail delivery DELIVERY_AFTER_MS into the connection: pushed
  // immediately while idling, otherwise held back until a NOOP/IDLE arrives.
  if (!cfg.noDelivery) {
    const timer = setTimeout(() => {
      if (delivered) return;
      delivered = true;
      if (idle) {
        write(`* ${currentMessages().length + 1} EXISTS\r\n`);
      } else {
        pendingExists = true;
      }
    }, DELIVERY_AFTER_MS);
    if (typeof timer.unref === "function") timer.unref();
  }

  sock.write(`* OK [CAPABILITY ${capability}] imap-test-server ready\r\n`);

  const flushPending = () => {
    if (pendingExists) {
      pendingExists = false;
      write(`* ${currentMessages().length + 1} EXISTS\r\n`);
      return true;
    }
    return false;
  };

  sock.on("data", (chunk) => {
    lineBuf += chunk;
    let idx;
    while ((idx = lineBuf.indexOf("\r\n")) !== -1) {
      const line = lineBuf.slice(0, idx);
      lineBuf = lineBuf.slice(idx + 2);
      handleLine(line);
    }
  });

  function handleLine(line) {
    log(`>> ${JSON.stringify(line)}`);
    if (!line.trim()) return;
    if (line.trim() === "DONE") {
      // bare DONE: respond with the IDLE command's tag
      write(`${idleTag} OK IDLE terminated\r\n`);
      idle = false;
      return;
    }
    const m = line.match(/^(\S+)\s+(.*)$/);
    if (!m) return;
    const [, tag, cmdLine] = m;
    const [cmd, ...args] = cmdLine.split(/\s+/);
    const C = cmd.toUpperCase();

    if (C === "LOGIN" || C === "AUTHENTICATE") {
      // accept any credentials: this is a test server
      write(`${tag} OK [CAPABILITY ${capability}] logged in\r\n`);
    } else if (C === "CAPABILITY") {
      write(`* CAPABILITY ${capability}\r\n${tag} OK done\r\n`);
    } else if (C === "LIST" || C === "LSUB") {
      const names = [...boxes.keys()].sort();
      for (const box of names) {
        const hasChildren = names.some((b) => b.startsWith(box + "/"));
        write(`* ${C} (${hasChildren ? "\\HasChildren" : "\\HasNoChildren"}) "/" "${box}"\r\n`);
      }
      write(`${tag} OK ${C} done\r\n`);
    } else if (C === "SUBSCRIBE" || C === "UNSUBSCRIBE") {
      write(`${tag} OK done\r\n`);
    } else if (C === "CREATE") {
      const name = unquote(args[0] || "");
      if (!name || name.toUpperCase() === "INBOX") {
        write(`${tag} NO cannot create ${JSON.stringify(name || "")}\r\n`);
      } else if (boxes.has(name)) {
        write(`${tag} NO [ALREADYEXISTS] mailbox exists\r\n`);
      } else {
        // RFC 3501 §6.3.3: superior hierarchical names are created as needed
        let prefix = "";
        for (const part of name.split("/")) {
          prefix = prefix ? `${prefix}/${part}` : part;
          if (!boxes.has(prefix)) boxes.set(prefix, []);
        }
        persist();
        write(`${tag} OK CREATE done\r\n`);
      }
    } else if (C === "DELETE") {
      const name = unquote(args[0] || "");
      if (!name || name.toUpperCase() === "INBOX") {
        write(`${tag} NO cannot delete ${JSON.stringify(name || "")}\r\n`);
      } else if (!boxes.has(name)) {
        write(`${tag} NO no such mailbox\r\n`);
      } else if ([...boxes.keys()].some((b) => b.startsWith(name + "/"))) {
        write(`${tag} NO mailbox has inferior hierarchical names\r\n`);
      } else {
        boxes.delete(name);
        if (selected === name) {
          selected = null;
        }
        persist();
        write(`${tag} OK DELETE done\r\n`);
      }
    } else if (C === "SELECT" || C === "EXAMINE") {
      const box = (args[0] || "").replace(/^"|"$/g, "");
      if (!boxes.has(box)) {
        selected = null;
        write(`${tag} NO [TRYCREATE] no such mailbox\r\n`);
        return;
      }
      selected = box;
      const msgs = boxes.get(box);
      const firstUnseen = msgs.findIndex((m) => !m.flags.includes("\\Seen")) + 1;
      write(`* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n`);
      write(`* ${msgs.length} EXISTS\r\n`);
      write(`* 0 RECENT\r\n`);
      write(`* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)] flags permitted\r\n`);
      if (firstUnseen > 0) write(`* OK [UNSEEN ${firstUnseen}] first unseen\r\n`);
      write(`* OK [UIDVALIDITY ${UID_VALIDITY}] UIDs valid\r\n`);
      write(`* OK [UIDNEXT ${uidNextFor(msgs)}] next uid\r\n`);
      write(`${tag} OK [${C === "EXAMINE" ? "READ-ONLY" : "READ-WRITE"}] ${C} done\r\n`);
    } else if (C === "STATUS") {
      const box = (args[0] || '""').replace(/^"|"$/g, "");
      const msgs = boxes.get(box);
      if (!msgs) {
        write(`${tag} NO no such mailbox\r\n`);
        return;
      }
      const unseen = msgs.filter((m) => !m.flags.includes("\\Seen")).length;
      write(
        `* STATUS "${box}" (MESSAGES ${msgs.length} UIDNEXT ${uidNextFor(msgs)} UIDVALIDITY ${UID_VALIDITY} UNSEEN ${unseen})\r\n`,
      );
      write(`${tag} OK STATUS done\r\n`);
    } else if (C === "STORE") {
      handleStore(tag, false, args);
    } else if (C === "UID" && (args[0] || "").toUpperCase() === "STORE") {
      handleStore(tag, true, args.slice(1));
    } else if (C === "UID" && (args[0] || "").toUpperCase() === "EXPUNGE") {
      handleExpunge(tag, true, args.slice(1));
    } else if (C === "EXPUNGE") {
      handleExpunge(tag, false, args);
    } else if (C === "UID" && (args[0] || "").toUpperCase() === "FETCH") {
      handleFetch(tag, true, args.slice(1));
    } else if (C === "FETCH") {
      handleFetch(tag, false, args);
    } else if (C === "UID" && (args[0] || "").toUpperCase() === "SEARCH") {
      handleSearch(tag, true, args.slice(1));
    } else if (C === "SEARCH") {
      handleSearch(tag, false, args);
    } else if (C === "IDLE" && !cfg.noIdle) {
      idle = true;
      idleTag = tag;
      write(`+ idling\r\n`);
      // if delivery fired while we were not idling, flush it right away
      flushPending();
    } else if (C === "NOOP") {
      flushPending();
      write(`${tag} OK NOOP done\r\n`);
    } else if (C === "CHECK" || C === "CLOSE") {
      write(`${tag} OK ${C} done\r\n`);
    } else if (C === "LOGOUT") {
      write(`* BYE imap-test-server logging out\r\n${tag} OK LOGOUT done\r\n`);
      sock.end();
    } else {
      write(`${tag} BAD unknown command ${C}\r\n`);
    }
  }

  function handleFetch(tag, byUid, args) {
    const msgs = currentMessages();
    const maxRef = byUid
      ? msgs.reduce((m, x) => Math.max(m, x.uid), 0)
      : msgs.length;
    const set = (args[0] || "").replace(/\*/g, String(maxRef));
    const query = args.slice(1).join(" ");
    const ids = parseSet(set);
    log(`fetch${byUid ? " uid" : ""}: set=${JSON.stringify(set)} query=${JSON.stringify(query)}`);
    const wantsFlags = /\bFLAGS\b/i.test(query);
    const wantsUid = byUid || /\bUID\b/i.test(query);
    const wantsEnvelope = /\bENVELOPE\b/i.test(query);
    const wantsSize = /\bRFC822\.SIZE\b/i.test(query);
    const wantsBody = /BODY\.PEEK\[/i.test(query) || /BODY\[/i.test(query);
    // BODY.PEEK[HEADER.FIELDS (NAME ...)]: answer with just the requested
    // header lines instead of the whole body
    const headerFields = query.match(/HEADER\.FIELDS\s*\(([^)]*)\)/i);
    const none = !wantsFlags && !wantsEnvelope && !wantsSize && !wantsBody;
    for (const id of ids) {
      const msg = msgs.find((x) =>
        byUid ? x.uid === id : msgs.indexOf(x) + 1 === id,
      );
      if (!msg) continue;
      const seq = msgs.indexOf(msg) + 1;
      const size = Buffer.byteLength(msg.body, "utf8");
      const parts = [];
      if (wantsUid) parts.push(`UID ${msg.uid}`);
      if (headerFields) {
        const wanted = headerFields[1]
          .split(/\s+/)
          .filter(Boolean)
          .map((n) => n.toUpperCase());
        const head = msg.body.slice(0, msg.body.indexOf("\r\n\r\n"));
        const lines = head.split("\r\n").filter((l) => {
          const i = l.indexOf(":");
          return i > 0 && wanted.includes(l.slice(0, i).trim().toUpperCase());
        });
        const block = lines.length ? lines.join("\r\n") + "\r\n\r\n" : "\r\n";
        parts.push(`BODY[HEADER.FIELDS (${headerFields[1]})] {${Buffer.byteLength(block, "latin1")}}\r\n${block}`);
      } else if (wantsBody) {
        parts.push(`BODY[] {${size}}\r\n${msg.body}`);
      }
      if (wantsFlags || none) parts.push(`FLAGS (${msg.flags.join(" ")})`);
      if (wantsEnvelope || none) parts.push(`ENVELOPE ${envFor(msg)}`);
      if (wantsSize || none) parts.push(`RFC822.SIZE ${size}`);
      write(`* ${seq} FETCH (${parts.join(" ")})\r\n`);
    }
    write(`${tag} OK ${byUid ? "UID " : ""}FETCH done\r\n`);
  }

  // SEARCH / UID SEARCH: supports the keys our client emits — TEXT, FROM,
  // TO, SUBJECT, BODY, UNSEEN, FLAGGED, SEEN, SINCE, BEFORE — plus bare
  // quoted/plain strings (treated as TEXT). Multiple keys are ANDed.
  function handleSearch(tag, byUid, args) {
    const msgs = currentMessages();
    let tokens = (args || []).slice();
    // drop an optional CHARSET prefix (e.g. "CHARSET UTF-8")
    if ((args[0] || "").toUpperCase() === "CHARSET") {
      args = args.slice(2);
    }
    const keys = [];
    for (let i = 0; i < args.length; i++) {
      const up = (args[i] || "").toUpperCase();
      if (["TEXT", "FROM", "TO", "SUBJECT", "BODY"].includes(up)) {
        keys.push({key: up, value: unquote(args[i + 1] ?? "")});
        i++;
      } else if (["SINCE", "BEFORE", "ON"].includes(up)) {
        keys.push({key: up, value: unquote(args[i + 1] ?? "")});
        i++;
      } else if (["UNSEEN", "SEEN", "FLAGGED", "ANSWERED", "DELETED", "DRAFT", "RECENT"].includes(up)) {
        keys.push({key: up, value: null});
      } else {
        // bare word or stray string: treat as TEXT
        keys.push({key: "TEXT", value: unquote(args[i])});
      }
    }
    const hits = msgs.filter((msg) => keys.every((k) => matchKey(msg, k)));
    const ids = hits
      .map((m) => (byUid ? m.uid : msgs.indexOf(m) + 1))
      .sort((a, b) => a - b);
    log(`search${byUid ? " uid" : ""}: ${keys.map(k => `${k.key}${k.value ? " " + JSON.stringify(k.value) : ""}`).join(", ")} -> ${ids.length} hits`);
    write(`* SEARCH${ids.length ? " " + ids.join(" ") : ""}\r\n`);
    write(`${tag} OK ${byUid ? "UID " : ""}SEARCH done\r\n`);
  }

  function unquote(s) {
    if (s === undefined || s === null) return "";
    s = String(s);
    if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
      return s.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    return s;
  }

  function matchKey(msg, {key, value}) {
    const body = msg.body;
    switch (key) {
      case "TEXT": {
        // substring over headers + body, case-insensitive
        return body.toLowerCase().includes(value.toLowerCase());
      }
      case "FROM": {
        return msg.body.slice(0, msg.body.indexOf("\r\n\r\n")).toLowerCase()
          .includes("from:") && headerHas(body, "from", value);
      }
      case "TO": {
        return headerHas(body, "to", value);
      }
      case "SUBJECT": {
        return headerHas(body, "subject", value);
      }
      case "BODY": {
        const text = body.slice(body.indexOf("\r\n\r\n") + 4);
        return text.toLowerCase().includes(value.toLowerCase());
      }
      case "UNSEEN": {
        return !msg.flags.includes("\\Seen");
      }
      case "SEEN": {
        return msg.flags.includes("\\Seen");
      }
      case "FLAGGED": {
        return msg.flags.includes("\\Flagged");
      }
      case "ANSWERED":
      case "DRAFT":
      case "DELETED":
      case "RECENT": {
        return false;
      }
      case "SINCE":
      case "BEFORE":
      case "ON": {
        const target = parseImapDate(value);
        const msgDate = parseImapDate(msg.date);
        if (!target || !msgDate) return false;
        if (key === "SINCE") return msgDate >= target;
        if (key === "BEFORE") return msgDate < target;
        return msgDate.getTime() === target.getTime();
      }
      default: {
        return false;
      }
    }
  }

  function parseImapDate(s) {
    // accept both "8-Sep-2026" (SEARCH syntax) and full RFC 5322 dates
    // ("Tue, 8 Sep 2026 09:00:00 +0000") — message dates arrive in the latter
    const bare = String(s || "").trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
    if (bare) {
      return fromParts(bare[1], bare[2], bare[3]);
    }
    const rfc = String(s || "").match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
    if (rfc) {
      return fromParts(rfc[1], rfc[2], rfc[3]);
    }
    return null;
  }

  function fromParts(day, mon, year) {
    const months = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
    const mi = months.indexOf(String(mon).toLowerCase());
    if (mi < 0) return null;
    return new Date(Number(year), mi, Number(day));
  }

  function headerHas(body, name, value) {
    const head = body.slice(0, body.indexOf("\r\n\r\n"));
    const re = new RegExp("^" + name + "\\s*:", "i");
    let hit = "";
    for (const line of head.split("\r\n")) {
      if (hit && /^[ \t]/.test(line)) {
        hit += " " + line.trim();
        continue;
      }
      if (hit) break;
      const i = line.indexOf(":");
      if (i > 0 && line.slice(0, i).trim().toLowerCase() === name) {
        hit = line.slice(i + 1).trim();
      }
    }
    // strip RFC 2047 encoded words so plain-text search sees the raw text
    const plain = hit.replace(/=\?[^?]+\?[BbQq]\?[^?]*\?=/g, "");
    return plain.toLowerCase().includes(value.toLowerCase());
  }

  function handleStore(tag, byUid, rest) {
    const msgs = currentMessages();
    const maxRef = byUid ? msgs.reduce((m, x) => Math.max(m, x.uid), 0) : msgs.length;
    const set = (rest[0] || "").replace(/\*/g, String(maxRef));
    const op = (rest[1] || "").toUpperCase();
    let flagStr = rest.slice(2).join(" ").trim();
    if (flagStr.startsWith("(") && flagStr.endsWith(")")) flagStr = flagStr.slice(1, -1);
    const flags = flagStr.split(/\s+/).filter(Boolean).map((f) => (f.startsWith("\\") ? f : "\\" + f));
    if (!set || !op || !flags.length) {
      write(`${tag} BAD STORE needs a set, [+|-]FLAGS[.SILENT] and flags\r\n`);
      return;
    }
    const silent = op.endsWith(".SILENT");
    const mode = op.startsWith("+") ? "add" : op.startsWith("-") ? "remove" : "set";
    const ids = parseSet(set);
    const targets = msgs.filter((msg) =>
      ids.includes(byUid ? msg.uid : msgs.indexOf(msg) + 1),
    );
    for (const msg of targets) {
      if (mode === "add") {
        for (const f of flags) if (!msg.flags.includes(f)) msg.flags.push(f);
      } else if (mode === "remove") {
        msg.flags = msg.flags.filter((f) => !flags.includes(f));
      } else {
        msg.flags = [...flags];
      }
      if (!silent) {
        const seq = msgs.indexOf(msg) + 1;
        write(`* ${seq} FETCH (UID ${msg.uid} FLAGS (${msg.flags.join(" ")}))\r\n`);
      }
    }
    if (!targets.length) write(`${tag} NO no matching messages\r\n`);
    else {
      persist();
      write(`${tag} OK ${byUid ? "UID " : ""}STORE done\r\n`);
    }
  }

  // RFC 3501 §6.4.3 / RFC 4315 §2.1: permanently remove \Deleted messages.
  // UID EXPUNGE restricts the purge to the given UID set; plain EXPUNGE
  // removes every \Deleted message in the selected mailbox. Untagged
  // `* n EXPUNGE` lines use the sequence numbers BEFORE any removal,
  // renumbered as the server processes them (each removal shifts the
  // remaining messages down by one).
  function handleExpunge(tag, byUid, rest) {
    if (!selected) {
      write(`${tag} NO no mailbox selected\r\n`);
      return;
    }
    const msgs = boxes.get(selected);
    let uids = null;
    if (byUid) {
      const set = (rest[0] || "").replace(/\*/g, String(msgs.reduce((m, x) => Math.max(m, x.uid), 0)));
      uids = parseSet(set);
      if (!uids.length) {
        write(`${tag} BAD UID EXPUNGE needs a uid set\r\n`);
        return;
      }
    }
    // snapshot original sequence numbers, ascending
    const doomed = msgs
      .map((msg, i) => ({ msg, seq: i + 1 }))
      .filter(({ msg }) => msg.flags.includes("\\Deleted") && (!uids || uids.includes(msg.uid)));
    for (let i = 0; i < doomed.length; i++) {
      write(`* ${doomed[i].seq - i} EXPUNGE\r\n`);
    }
    if (!doomed.length) write(`${tag} OK EXPUNGE nothing to expunge\r\n`);
    else {
      const gone = new Set(doomed.map(({ msg }) => msg));
      boxes.set(selected, msgs.filter((m) => !gone.has(m)));
      persist();
      write(`${tag} OK EXPUNGE completed\r\n`);
    }
  }

  sock.on("error", (e) => log(`error: ${e.message}`));
  sock.on("close", () => log("client gone"));
}

// "101,103:105" -> [101, 103, 104, 105]
function parseSet(set) {
  const out = [];
  for (const part of (set || "").split(",")) {
    const [a, b] = part.split(":").map((n) => parseInt(n, 10));
    if (Number.isNaN(a)) continue;
    if (b === undefined || Number.isNaN(b)) out.push(a);
    else for (let i = a; i <= b; i++) out.push(i);
  }
  return out;
}

// envelope strings must stay ASCII: quoted strings can't carry raw 8-bit, so
// non-ASCII goes out as an RFC 2047 encoded word and specials get escaped
function envString(s) {
  if (/[^\x00-\x7f]/.test(s)) {
    return `"${encodeWord(s)}"`;
  }
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function envFor(msg) {
  const addr = msg.from.match(/<([^>]*)>/)?.[1] || "unknown@example.com";
  const local = addr.split("@")[0] || "unknown";
  const domain = addr.split("@")[1] || "example.com";
  const namePart = msg.from.replace(/\s*<[^>]*>\s*$/, "").trim();
  const name = namePart ? envString(namePart) : "NIL";
  const address = `(${name} NIL ${JSON.stringify(local)} ${JSON.stringify(domain)})`;
  const inReplyTo = msg.irt ? envString(msg.irt) : "NIL";
  const messageId = msg.msgid ? envString(msg.msgid) : "NIL";
  return `(${envString(msg.date)} ${envString(msg.subject)} (${address}) NIL NIL (${address}) NIL NIL ${inReplyTo} ${messageId})`;
}

// ---------------------------------------------------------------------------
// CLI entry point (ignored when imported programmatically)
// ---------------------------------------------------------------------------

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const cfg = resolveConfig();
  startImapTestServer(cfg).catch((e) => {
    console.error(`[imap-test] failed to start: ${e.message}`);
    process.exit(1);
  });
}
