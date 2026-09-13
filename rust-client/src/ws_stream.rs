use std::collections::VecDeque;
use std::fmt;
use std::io::ErrorKind;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

use futures::io::{AsyncRead, AsyncWrite};
use js_sys::{Function, Reflect, Uint8Array};
use send_wrapper::SendWrapper;
use wasm_bindgen::prelude::*;

pub struct RxState {
    pub buf: VecDeque<u8>,
    pub closed: bool,
    pub err: Option<String>,
    waker: Option<Waker>,
}

impl RxState {
    pub fn new() -> Self {
        RxState {
            buf: VecDeque::new(),
            closed: false,
            err: None,
            waker: None,
        }
    }

    pub fn push(&mut self, data: &[u8]) {
        self.buf.extend(data.iter().copied());
        if let Some(w) = self.waker.take() {
            w.wake();
        }
    }

    pub fn wake(&mut self) {
        if let Some(w) = self.waker.take() {
            w.wake();
        }
    }
}

impl Default for RxState {
    fn default() -> Self {
        Self::new()
    }
}

/// JS-facing receiver handle. The JS glue calls these methods from WS event
/// handlers; they never touch `MailClient`, so no wasm-bindgen `RefCell`
/// borrow conflict can occur while an async `&mut self` method (e.g.
/// `connect`) is suspended at an await point.
#[wasm_bindgen]
pub struct TransportRx {
    inner: Arc<Mutex<RxState>>,
}

#[wasm_bindgen]
impl TransportRx {
    #[wasm_bindgen(constructor)]
    pub fn new() -> TransportRx {
        TransportRx {
            inner: Arc::new(Mutex::new(RxState::new())),
        }
    }

    /// Called by JS glue for every binary WS message received.
    pub fn push_bytes(&self, data: &[u8]) {
        self.inner.lock().unwrap().push(data);
    }

    /// Called by JS glue when the WS closed.
    pub fn transport_closed(&self) {
        let mut st = self.inner.lock().unwrap();
        st.closed = true;
        st.wake();
    }

    /// Called by JS glue when the WS errored.
    pub fn transport_error(&self, msg: String) {
        let mut st = self.inner.lock().unwrap();
        st.err = Some(msg);
        st.closed = true;
        st.wake();
    }
}

impl Default for TransportRx {
    fn default() -> Self {
        Self::new()
    }
}

impl Clone for TransportRx {
    fn clone(&self) -> Self {
        TransportRx {
            inner: self.inner.clone(),
        }
    }
}

impl TransportRx {
    pub fn shared(&self) -> Arc<Mutex<RxState>> {
        self.inner.clone()
    }
}
/// Adapts a JS WebSocket-like object (with `send(bytes)` and `close()`) to
/// `futures::io::AsyncRead + AsyncWrite`. Inbound bytes are delivered via the
/// shared [`TransportRx`]; outbound bytes are sent synchronously via `send()`
/// (WebSocket buffers internally).
pub struct WsStream {
    transport: SendWrapper<JsValue>,
    send_fn: SendWrapper<Function>,
    close_fn: SendWrapper<Function>,
    rx: Arc<Mutex<RxState>>,
}

impl WsStream {
    pub fn new(transport: SendWrapper<JsValue>, rx: Arc<Mutex<RxState>>) -> Self {
        let send_fn = SendWrapper::new(
            Reflect::get(transport.as_ref(), &"send".into())
                .expect("transport.send missing")
                .dyn_into::<Function>()
                .expect("transport.send is not a function"),
        );
        let close_fn = SendWrapper::new(
            Reflect::get(transport.as_ref(), &"close".into())
                .expect("transport.close missing")
                .dyn_into::<Function>()
                .expect("transport.close is not a function"),
        );
        WsStream {
            transport,
            send_fn,
            close_fn,
            rx,
        }
    }

    fn send_js(&self, data: &[u8]) -> Result<(), JsValue> {
        let arr = Uint8Array::from(data);
        self.send_fn.call1(self.transport.as_ref(), &arr.into())?;
        Ok(())
    }

    fn close_js(&self) {
        let _ = self.close_fn.call0(self.transport.as_ref());
    }
}

impl fmt::Debug for WsStream {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("WsStream")
    }
}

impl AsyncRead for WsStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut [u8],
    ) -> Poll<std::io::Result<usize>> {
        let mut st = self.rx.lock().unwrap();
        if !st.buf.is_empty() {
            let n = buf.len().min(st.buf.len());
            for b in buf.iter_mut().take(n) {
                *b = st.buf.pop_front().unwrap();
            }
            return Poll::Ready(Ok(n));
        }
        if let Some(e) = &st.err {
            return Poll::Ready(Err(std::io::Error::new(
                ErrorKind::ConnectionAborted,
                e.clone(),
            )));
        }
        if st.closed {
            return Poll::Ready(Ok(0));
        }
        st.waker = Some(cx.waker().clone());
        Poll::Pending
    }
}

impl AsyncWrite for WsStream {
    fn poll_write(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        match self.send_js(buf) {
            Ok(()) => Poll::Ready(Ok(buf.len())),
            Err(e) => Poll::Ready(Err(std::io::Error::new(
                ErrorKind::ConnectionAborted,
                format!("ws send failed: {e:?}"),
            ))),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_close(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        self.close_js();
        Poll::Ready(Ok(()))
    }
}
