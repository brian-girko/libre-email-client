use std::sync::Arc;

use rustls::pki_types::ServerName;
use rustls::{ClientConfig, RootCertStore};
use wasm_bindgen::prelude::*;

use crate::ws_stream::WsStream;

pub use futures_rustls::client::TlsStream;

pub type TlsConnector = futures_rustls::TlsConnector;

/// Accepts any server certificate (testing only, e.g. local stub servers).
#[derive(Debug)]
struct NoVerify;

impl rustls::client::danger::ServerCertVerifier for NoVerify {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        vec![
            rustls::SignatureScheme::RSA_PKCS1_SHA256,
            rustls::SignatureScheme::RSA_PKCS1_SHA384,
            rustls::SignatureScheme::RSA_PKCS1_SHA512,
            rustls::SignatureScheme::ECDSA_NISTP256_SHA256,
            rustls::SignatureScheme::ECDSA_NISTP384_SHA384,
            rustls::SignatureScheme::ED25519,
            rustls::SignatureScheme::RSA_PSS_SHA256,
            rustls::SignatureScheme::RSA_PSS_SHA384,
            rustls::SignatureScheme::RSA_PSS_SHA512,
        ]
    }
}

/// Terminates TLS inside WASM (rustls + ring) over the ws-tcp bridge stream.
/// Server certificate verification uses Mozilla root store (webpki-roots).
/// With `insecure = true` any server certificate is accepted (local testing).
pub async fn connect_tls(
    host: &str,
    stream: WsStream,
    insecure: bool,
) -> Result<TlsStream<WsStream>, JsValue> {    let provider = Arc::new(rustls::crypto::ring::default_provider());

    let builder = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    let config = if insecure {
        builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(NoVerify))
            .with_no_client_auth()
    } else {
        let mut roots = RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        builder
            .with_root_certificates(roots)
            .with_no_client_auth()
    };

    let connector: TlsConnector = Arc::new(config).into();
    let server_name = ServerName::try_from(host.to_string())
        .map_err(|e| JsValue::from_str(&format!("invalid server name {host:?}: {e}")))?;

    let tls = connector
        .connect(server_name, stream)
        .await
        .map_err(|e| {
            let msg = e.to_string();
            // The peer sent bytes that are not a TLS record — in practice this
            // means the dialed port speaks plaintext IMAP while the client
            // asked for TLS (e.g. a greeting like `* OK [CAPABILITY ...]`).
            let hint = if msg.contains("corrupt message")
                || msg.contains("InvalidContentType")
                || msg.contains("unexpected message")
            {
                " (HINT: the server on this port may be plaintext IMAP — set secure:false in createMailApi, or point the ws-bridge/startWsBridge dial at the server's TLS port)"
            } else {
                ""
            };
            JsValue::from_str(&format!("TLS handshake failed: {msg}{hint}"))
        })?;

    log::info!("TLS established");
    Ok(tls)
}

/// Connection stream: TLS (rustls inside WASM) or plaintext IMAP.
pub enum ConnStream {
    Tls(TlsStream<WsStream>),
    Plain(WsStream),
}

impl std::fmt::Debug for ConnStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConnStream::Tls(_) => f.write_str("ConnStream::Tls"),
            ConnStream::Plain(_) => f.write_str("ConnStream::Plain"),
        }
    }
}

impl futures::io::AsyncRead for ConnStream {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut [u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        match self.get_mut() {
            ConnStream::Tls(s) => std::pin::Pin::new(s).poll_read(cx, buf),
            ConnStream::Plain(s) => std::pin::Pin::new(s).poll_read(cx, buf),
        }
    }
}

impl futures::io::AsyncWrite for ConnStream {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        match self.get_mut() {
            ConnStream::Tls(s) => std::pin::Pin::new(s).poll_write(cx, buf),
            ConnStream::Plain(s) => std::pin::Pin::new(s).poll_write(cx, buf),
        }
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            ConnStream::Tls(s) => std::pin::Pin::new(s).poll_flush(cx),
            ConnStream::Plain(s) => std::pin::Pin::new(s).poll_flush(cx),
        }
    }

    fn poll_close(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            ConnStream::Tls(s) => std::pin::Pin::new(s).poll_close(cx),
            ConnStream::Plain(s) => std::pin::Pin::new(s).poll_close(cx),
        }
    }
}
