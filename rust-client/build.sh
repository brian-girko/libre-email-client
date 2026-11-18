#!/bin/sh
# Build the rust IMAP core to WASM and deploy the artifacts the extension
# needs into extension/v2/core/rust-imap-client/:
#   mail_core.mjs      wasm-bindgen glue (renamed from .js, all modules are .mjs)
#   mail_core_bg.wasm  the module
# js/api.mjs is NOT deployed: the extension's core/rust-imap-client/api.mjs is
# hand-maintained (it imports the shared ../mime.mjs decoder) — keep its
# MailApi surface in sync manually after changing the facade.
set -e
cd "$(dirname "$0")"

wasm-pack build --release --target web

DEST=../extension/v2/core/rust-imap-client
mkdir -p "$DEST"
cp pkg/mail_core_bg.wasm "$DEST/"
sed "s|'\./mail_core\.js'|'./mail_core.mjs'|" pkg/mail_core.js > "$DEST/mail_core.mjs"

echo "deployed: $DEST/{mail_core.mjs, mail_core_bg.wasm}"
