# rust-client (build source)

Build source for the WASM IMAP core deployed at
`extension/core/rust-imap-client/`. See that folder for the
deployed artifacts and their usage.

## Layout

```
Cargo.toml           crate manifest (wasm-bindgen cdylib + [patch.crates-io])
Cargo.lock           pinned dependency graph
src/
  lib.rs             exported API: MailClient, TransportRx
  threading.rs       JWZ conversation threading (Gmail-style group_threads)
  tls.rs             rustls client handshake over the WS stream
  ws_stream.rs       TransportRx: JS push-bytes receiver + WS transport glue
js/api.mjs            MailApi facade source (deployed as core/rust-client/api.mjs)
tests/parse.rs       response-parsing unit tests
vendor/async-imap    patched fork of async-imap (wasm32 support; REQUIRED —
                     referenced by [patch.crates-io], do not delete)
build.sh             build + deploy script (see below)
```

## Build & deploy

Requires Rust with the `wasm32-unknown-unknown` target and `wasm-pack`:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-pack    # or: curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh
```

Build and deploy the three files the extension needs
(`mail_core.mjs`, `mail_core_bg.wasm`, `api.mjs`) into
`extension/core/rust-imap-client/`:

```sh
./build.sh
```

## Tests

```sh
cargo test                          # host-side unit tests (tests/parse.rs)
```

End-to-end (after `./build.sh`):

```sh
node ../tests/test-threads.mjs
```
