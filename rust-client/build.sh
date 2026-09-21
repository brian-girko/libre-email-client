#!/bin/sh
# Build the rust IMAP core to WASM and deploy the artifacts the extension
# needs into extension/core/rust-imap-client/:
#   mail_core.mjs      wasm-bindgen glue (renamed from .js, all modules are .mjs)
#   mail_core_bg.wasm  the module
#   api.mjs            MailApi facade (import path rewritten to sibling file)set -e
cd "$(dirname "$0")"

wasm-pack build --release --target web

DEST=../extension/core/rust-imap-client
mkdir -p "$DEST"
cp pkg/mail_core_bg.wasm "$DEST/"
sed "s|'\./mail_core\.js'|'./mail_core.mjs'|" pkg/mail_core.js > "$DEST/mail_core.mjs"
sed "s|'\.\./pkg/mail_core\.js'|'./mail_core.mjs'|" js/api.mjs > "$DEST/api.mjs"

echo "deployed: $DEST/{mail_core.mjs, mail_core_bg.wasm, api.mjs}"
