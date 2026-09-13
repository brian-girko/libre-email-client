# rust-client (deployed artifacts)

WASM IMAP core for the extension. **Do not edit — build artifacts.** Sources
and build instructions: `rust-client/` (run `./build.sh`).

- `mail_core.mjs` — wasm-bindgen glue (ESM)
- `mail_core_bg.wasm` — the compiled module
- `api.mjs` — MailApi facade (same contract as `../nodejs-client/api.mjs`)

Usage:

```js
import { createMailApi } from './api.mjs';

const api = await createMailApi({
  bridgeUrl,          // ws://127.0.0.1:<port>[/<token>] of the ws-bridge
  host, port,         // IMAP server; secure: true => rustls inside WASM
  user, pass,
  wasmBytes,          // fetched mail_core_bg.wasm bytes
});
await api.connect();
const dirs = await api.listDirs();
await api.openDir('INBOX');
const files = await api.listFiles({ page: 0, pageSize: 20 }); // newest first
const raw = await api.readFile(files[0].uid);                 // one FETCH per call
await api.idle({ timeoutMs: 20000 });                         // IDLE or NOOP-poll fallback
await api.close();

// Gmail-style conversations: the whole folder is grouped inside the wasm
// core (JWZ over Message-ID/References/In-Reply-To), newest thread first.
// Cached per dir until openDir/setFlags/moveTo runs again.
const threads = await api.listThreads();
// threads[0] = {uids, count, unread, flagged, subject, from, date, messages}
```
