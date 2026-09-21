/* @ts-self-types="./mail_core.d.ts" */

export class MailClient {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        MailClientFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_mailclient_free(ptr, 0);
    }
    /**
     * Opens the transport, performs the TLS handshake (inside WASM) and logs in.
     * @returns {Promise<void>}
     */
    connect() {
        const ret = wasm.mailclient_connect(this.__wbg_ptr);
        return ret;
    }
    /**
     * CREATE a mailbox (RFC 3501 §6.3.3). Errors on `INBOX` and on names
     * that already exist; servers create superior hierarchy names as needed.
     * @param {string} mailbox
     * @returns {Promise<void>}
     */
    create_mailbox(mailbox) {
        const ptr0 = passStringToWasm0(mailbox, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.mailclient_create_mailbox(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * DELETE a mailbox (RFC 3501 §6.3.4). Errors on `INBOX`, unknown names,
     * and mailboxes with inferior hierarchical names.
     * @param {string} mailbox
     * @returns {Promise<void>}
     */
    delete_mailbox(mailbox) {
        const ptr0 = passStringToWasm0(mailbox, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.mailclient_delete_mailbox(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * UID EXPUNGE the given UIDs (RFC 4315): permanently removes messages
     * that both carry the `\Deleted` flag (set via `store_flags`) and have
     * one of the given UIDs. Requires the server to advertise `UIDPLUS`;
     * without it this is a no-op — the flag stays set and the server purges
     * the messages on its next expunge, so other clients' pending deletions
     * are never touched.
     * @param {Uint32Array} uids
     * @returns {Promise<void>}
     */
    expunge_messages(uids) {
        const ptr0 = passArray32ToWasm0(uids, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.mailclient_expunge_messages(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * Fetch one full message (raw RFC822) by UID.
     * @param {number} uid
     * @returns {Promise<Uint8Array>}
     */
    fetch_message(uid) {
        const ret = wasm.mailclient_fetch_message(this.__wbg_ptr, uid);
        return ret;
    }
    /**
     * Fetch UID+FLAGS+ENVELOPE for a UID set (e.g. "1:500" or "3,7,9").
     * @param {string} uid_set
     * @returns {Promise<any>}
     */
    fetch_summaries(uid_set) {
        const ptr0 = passStringToWasm0(uid_set, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.mailclient_fetch_summaries(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * Group the whole mailbox into conversations (Gmail-style threading).
     *
     * Fetches UID+FLAGS+ENVELOPE plus the threading headers
     * (Message-ID / In-Reply-To / References) for every message of the
     * selected mailbox in UID batches, then runs the JWZ algorithm
     * ([`threading::group_threads`]) in Rust. Returns a JSON array of
     * thread summaries, newest conversation first:
     * `[{uids, count, unread, flagged, subject, from, date, messages}]`.
     * @param {string} mailbox
     * @returns {Promise<any>}
     */
    fetch_threads(mailbox) {
        const ptr0 = passStringToWasm0(mailbox, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.mailclient_fetch_threads(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * Enter IDLE on `mailbox` and wait up to `timeout_ms` for server updates.
     *
     * RFC 2177: the `IDLE` command is only used when the server advertises the
     * `IDLE` capability. Otherwise (or if the server rejects IDLE anyway) this
     * falls back to periodic NOOP polling and still resolves with the same
     * result shape: `{type: "timeout" | "new-data" | "interrupt", raw?}`.
     * @param {string} mailbox
     * @param {number} timeout_ms
     * @returns {Promise<any>}
     */
    idle_once(mailbox, timeout_ms) {
        const ptr0 = passStringToWasm0(mailbox, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.mailclient_idle_once(this.__wbg_ptr, ptr0, len0, timeout_ms);
        return ret;
    }
    /**
     * @returns {Promise<any>}
     */
    list_mailboxes() {
        const ret = wasm.mailclient_list_mailboxes(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {Promise<void>}
     */
    logout() {
        const ret = wasm.mailclient_logout(this.__wbg_ptr);
        return ret;
    }
    /**
     * UID MOVE the given UIDs to `mailbox` (RFC 6851). When the server does
     * not advertise the `MOVE` capability, falls back to
     * COPY + `\Deleted` + EXPUNGE.
     * @param {Uint32Array} uids
     * @param {string} mailbox
     * @returns {Promise<void>}
     */
    move_messages(uids, mailbox) {
        const ptr0 = passArray32ToWasm0(uids, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(mailbox, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.mailclient_move_messages(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        return ret;
    }
    /**
     * `rx` is a [`TransportRx`] created by the JS glue and wired to WS
     * events (`push_bytes` / `transport_closed` / `transport_error`).
     * `transport` is a duck-typed JS object with `send(bytes)` and `close()`.
     * Note: `rx` is only borrowed — the JS glue keeps owning it.
     * @param {string} host
     * @param {string} user
     * @param {string} pass
     * @param {TransportRx} rx
     * @param {any} transport
     */
    constructor(host, user, pass, rx, transport) {
        const ptr0 = passStringToWasm0(host, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(user, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(pass, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        _assertClass(rx, TransportRx);
        const ret = wasm.mailclient_new(ptr0, len0, ptr1, len1, ptr2, len2, rx.__wbg_ptr, transport);
        this.__wbg_ptr = ret;
        MailClientFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Server-side IMAP search on `mailbox`, grouped into conversations.
     *
     * `criteria` is a raw IMAP SEARCH query (e.g. `TEXT "sprint"` or
     * `FROM "dana" SINCE 7-Sep-2026`). Runs `UID SEARCH <criteria>`, then
     * fetches everything the threader needs for the matching UIDs and runs
     * the JWZ algorithm. Returns the same JSON shape as [`Self::fetch_threads`]
     * (newest conversation first) so the UI can render results like a
     * normal folder.
     * @param {string} mailbox
     * @param {string} criteria
     * @returns {Promise<any>}
     */
    search_threads(mailbox, criteria) {
        const ptr0 = passStringToWasm0(mailbox, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(criteria, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.mailclient_search_threads(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        return ret;
    }
    /**
     * @param {string} mailbox
     * @returns {Promise<any>}
     */
    select(mailbox) {
        const ptr0 = passStringToWasm0(mailbox, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.mailclient_select(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * Accept any server TLS certificate (testing against local stub servers).
     * @param {boolean} insecure
     */
    set_insecure(insecure) {
        wasm.mailclient_set_insecure(this.__wbg_ptr, insecure);
    }
    /**
     * Speak plaintext IMAP (no TLS) — for local servers on e.g. port 143/1143.
     * @param {boolean} plaintext
     */
    set_plaintext(plaintext) {
        wasm.mailclient_set_plaintext(this.__wbg_ptr, plaintext);
    }
    /**
     * UID STORE flags on the selected mailbox: adds/removes IMAP flags
     * (e.g. `\Seen`) for the given UIDs via `+FLAGS.SILENT` / `-FLAGS.SILENT`.
     * @param {Uint32Array} uids
     * @param {string[]} add
     * @param {string[]} remove
     * @returns {Promise<void>}
     */
    store_flags(uids, add, remove) {
        const ptr0 = passArray32ToWasm0(uids, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayJsValueToWasm0(add, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArrayJsValueToWasm0(remove, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.mailclient_store_flags(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
        return ret;
    }
    /**
     * APPEND a raw RFC822 message to `mailbox` (RFC 3501 §6.3.11).
     *
     * `content` is the full message (headers + body, CRLF line endings).
     * `flags` is a list of IMAP flags to set initially (e.g. `["\\Seen"]`);
     * pass an empty list for none. `internaldate` is an optional RFC 3501
     * `date-time` string like `"16-Sep-2026 10:39:00 +0000"`. Targets a
     * mailbox without disturbing the currently selected one — APPEND is the
     * canonical way the facade uploads new `.eml` files.
     * @param {string} mailbox
     * @param {Uint8Array} content
     * @param {string[]} flags
     * @param {string | null} [internaldate]
     * @returns {Promise<void>}
     */
    upload_mail(mailbox, content, flags, internaldate) {
        const ptr0 = passStringToWasm0(mailbox, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(content, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArrayJsValueToWasm0(flags, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        var ptr3 = isLikeNone(internaldate) ? 0 : passStringToWasm0(internaldate, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len3 = WASM_VECTOR_LEN;
        const ret = wasm.mailclient_upload_mail(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
        return ret;
    }
}
if (Symbol.dispose) MailClient.prototype[Symbol.dispose] = MailClient.prototype.free;

/**
 * JS-facing receiver handle. The JS glue calls these methods from WS event
 * handlers; they never touch `MailClient`, so no wasm-bindgen `RefCell`
 * borrow conflict can occur while an async `&mut self` method (e.g.
 * `connect`) is suspended at an await point.
 */
export class TransportRx {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TransportRxFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_transportrx_free(ptr, 0);
    }
    constructor() {
        const ret = wasm.transportrx_new();
        this.__wbg_ptr = ret;
        TransportRxFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Called by JS glue for every binary WS message received.
     * @param {Uint8Array} data
     */
    push_bytes(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.transportrx_push_bytes(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Called by JS glue when the WS closed.
     */
    transport_closed() {
        wasm.transportrx_transport_closed(this.__wbg_ptr);
    }
    /**
     * Called by JS glue when the WS errored.
     * @param {string} msg
     */
    transport_error(msg) {
        const ptr0 = passStringToWasm0(msg, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.transportrx_transport_error(this.__wbg_ptr, ptr0, len0);
    }
}
if (Symbol.dispose) TransportRx.prototype[Symbol.dispose] = TransportRx.prototype.free;

export function start() {
    wasm.start();
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_String_8564e559799eccda: function(arg0, arg1) {
            const ret = String(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_debug_string_0e68cf47c9cbd9b0: function(arg0, arg1) {
            const ret = debugString(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_is_function_fcda5e3902d732fe: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_object_edb6b15aa3afe12e: function(arg0) {
            const val = arg0;
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_string_c4f7cb494a2a21f1: function(arg0) {
            const ret = typeof(arg0) === 'string';
            return ret;
        },
        __wbg___wbindgen_is_undefined_8c687d0b90d5b524: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_string_get_92ab86bb19cbc12f: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_5d9e815e6fdf150f: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg__wbg_cb_unref_997e73d32238e655: function(arg0) {
            arg0._wbg_cb_unref();
        },
        __wbg_call_6bcf8d3e20937e46: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.call(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_clearTimeout_3629d6209dfcc46e: function(arg0) {
            const ret = clearTimeout(arg0);
            return ret;
        },
        __wbg_crypto_38df2bab126b63dc: function(arg0) {
            const ret = arg0.crypto;
            return ret;
        },
        __wbg_error_757e9472f8410341: function(arg0, arg1) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg0;
                deferred0_1 = arg1;
                console.error(getStringFromWasm0(arg0, arg1));
            } finally {
                wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
            }
        },
        __wbg_getRandomValues_c44a50d8cfdaebeb: function() { return handleError(function (arg0, arg1) {
            arg0.getRandomValues(arg1);
        }, arguments); },
        __wbg_get_989d0a1309644f2b: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_length_31bdaf014f5fbde2: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_msCrypto_bd5a034af96bcba6: function(arg0) {
            const ret = arg0.msCrypto;
            return ret;
        },
        __wbg_new_227d7c05414eb861: function() {
            const ret = new Error();
            return ret;
        },
        __wbg_new_bebc3f4757acf305: function() {
            const ret = new Object();
            return ret;
        },
        __wbg_new_ffa92086ea89f79c: function() {
            const ret = new Array();
            return ret;
        },
        __wbg_new_from_slice_4ee02165f9de919e: function(arg0, arg1) {
            const ret = new Uint8Array(getArrayU8FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_typed_6f8b0d724fe26c07: function(arg0, arg1) {
            try {
                var state0 = {a: arg0, b: arg1};
                var cb0 = (arg0, arg1) => {
                    const a = state0.a;
                    state0.a = 0;
                    try {
                        return wasm_bindgen_92ba3fdee574c949___convert__closures_____invoke___js_sys_fd9f84c7f3fef61d___Function_fn_wasm_bindgen_92ba3fdee574c949___JsValue_____wasm_bindgen_92ba3fdee574c949___sys__Undefined___js_sys_fd9f84c7f3fef61d___Function_fn_wasm_bindgen_92ba3fdee574c949___JsValue_____wasm_bindgen_92ba3fdee574c949___sys__Undefined_______true_(a, state0.b, arg0, arg1);
                    } finally {
                        state0.a = a;
                    }
                };
                const ret = new Promise(cb0);
                return ret;
            } finally {
                state0.a = 0;
            }
        },
        __wbg_new_with_length_5ffeddb9d9fbb96f: function(arg0) {
            const ret = new Uint8Array(arg0 >>> 0);
            return ret;
        },
        __wbg_node_84ea875411254db1: function(arg0) {
            const ret = arg0.node;
            return ret;
        },
        __wbg_now_d1fb6650485d7f3e: function() {
            const ret = Date.now();
            return ret;
        },
        __wbg_process_44c7a14e11e9f69e: function(arg0) {
            const ret = arg0.process;
            return ret;
        },
        __wbg_prototypesetcall_ae9f5e7459250748: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_queueMicrotask_85c90f6987555d65: function(arg0) {
            const ret = arg0.queueMicrotask;
            return ret;
        },
        __wbg_queueMicrotask_f6a1fa10b81d1fc0: function(arg0) {
            queueMicrotask(arg0);
        },
        __wbg_randomFillSync_6c25eac9869eb53c: function() { return handleError(function (arg0, arg1) {
            arg0.randomFillSync(arg1);
        }, arguments); },
        __wbg_require_b4edbdcf3e2a1ef0: function() { return handleError(function () {
            const ret = module.require;
            return ret;
        }, arguments); },
        __wbg_resolve_35ec7e0c6af4c82c: function(arg0) {
            const ret = Promise.resolve(arg0);
            return ret;
        },
        __wbg_setTimeout_56bcdccbad22fd44: function() { return handleError(function (arg0, arg1) {
            const ret = setTimeout(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_set_13d25b81ab403f5e: function(arg0, arg1, arg2) {
            arg0[arg1 >>> 0] = arg2;
        },
        __wbg_set_6be42768c690e380: function(arg0, arg1, arg2) {
            arg0[arg1] = arg2;
        },
        __wbg_stack_3b0d974bbf31e44f: function(arg0, arg1) {
            const ret = arg1.stack;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_static_accessor_GLOBAL_8eb4cd83130a11a0: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_THIS_1e7044f654e934db: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_d8b50611246a6d92: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_fd0bc376bf0f8b42: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_subarray_1daff70dde20c145: function(arg0, arg1, arg2) {
            const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
            return ret;
        },
        __wbg_then_b830475380919203: function(arg0, arg1) {
            const ret = arg0.then(arg1);
            return ret;
        },
        __wbg_versions_276b2795b1c6a219: function(arg0) {
            const ret = arg0.versions;
            return ret;
        },
        __wbindgen_generic_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Externref], shim_idx: 1073, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen_92ba3fdee574c949___convert__closures_____invoke___wasm_bindgen_92ba3fdee574c949___JsValue__core_ed718c3d60ebd546___result__Result_____wasm_bindgen_92ba3fdee574c949___JsError___true_);
            return ret;
        },
        __wbindgen_generic_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [], shim_idx: 406, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen_92ba3fdee574c949___convert__closures_____invoke_______true_);
            return ret;
        },
        __wbindgen_generic_0000000000000003: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_generic_0000000000000004: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
            const ret = getArrayU8FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_generic_0000000000000005: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./mail_core_bg.js": import0,
    };
}

function wasm_bindgen_92ba3fdee574c949___convert__closures_____invoke_______true_(arg0, arg1) {
    wasm.wasm_bindgen_92ba3fdee574c949___convert__closures_____invoke_______true_(arg0, arg1);
}

function wasm_bindgen_92ba3fdee574c949___convert__closures_____invoke___wasm_bindgen_92ba3fdee574c949___JsValue__core_ed718c3d60ebd546___result__Result_____wasm_bindgen_92ba3fdee574c949___JsError___true_(arg0, arg1, arg2) {
    const ret = wasm.wasm_bindgen_92ba3fdee574c949___convert__closures_____invoke___wasm_bindgen_92ba3fdee574c949___JsValue__core_ed718c3d60ebd546___result__Result_____wasm_bindgen_92ba3fdee574c949___JsError___true_(arg0, arg1, arg2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

function wasm_bindgen_92ba3fdee574c949___convert__closures_____invoke___js_sys_fd9f84c7f3fef61d___Function_fn_wasm_bindgen_92ba3fdee574c949___JsValue_____wasm_bindgen_92ba3fdee574c949___sys__Undefined___js_sys_fd9f84c7f3fef61d___Function_fn_wasm_bindgen_92ba3fdee574c949___JsValue_____wasm_bindgen_92ba3fdee574c949___sys__Undefined_______true_(arg0, arg1, arg2, arg3) {
    wasm.wasm_bindgen_92ba3fdee574c949___convert__closures_____invoke___js_sys_fd9f84c7f3fef61d___Function_fn_wasm_bindgen_92ba3fdee574c949___JsValue_____wasm_bindgen_92ba3fdee574c949___sys__Undefined___js_sys_fd9f84c7f3fef61d___Function_fn_wasm_bindgen_92ba3fdee574c949___JsValue_____wasm_bindgen_92ba3fdee574c949___sys__Undefined_______true_(arg0, arg1, arg2, arg3);
}

const MailClientFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_mailclient_free(ptr, 1));
const TransportRxFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_transportrx_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

const CLOSURE_DTORS = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(state => wasm.__wbindgen_destroy_closure(state.a, state.b));

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function makeMutClosure(arg0, arg1, f) {
    const state = { a: arg0, b: arg1, cnt: 1 };
    const real = (...args) => {

        // First up with a closure we increment the internal reference
        // count. This ensures that the Rust closure environment won't
        // be deallocated while we're invoking it.
        state.cnt++;
        const a = state.a;
        state.a = 0;
        try {
            return f(a, state.b, ...args);
        } finally {
            state.a = a;
            real._wbg_cb_unref();
        }
    };
    real._wbg_cb_unref = () => {
        if (--state.cnt === 0) {
            wasm.__wbindgen_destroy_closure(state.a, state.b);
            state.a = 0;
            CLOSURE_DTORS.unregister(state);
        }
    };
    CLOSURE_DTORS.register(real, state, state);
    return real;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayJsValueToWasm0(array, malloc) {
    const ptr = malloc(array.length * 4, 4) >>> 0;
    for (let i = 0; i < array.length; i++) {
        const add = addToExternrefTable0(array[i]);
        getDataViewMemory0().setUint32(ptr + 4 * i, add, true);
    }
    WASM_VECTOR_LEN = array.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('mail_core_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
