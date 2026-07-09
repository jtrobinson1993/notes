//! Relay live-delivery consumer (spec/relay.md § live delivery, client half).
//!
//! A background task holds a WebSocket to the relay's `/api/relay/ws` and, on
//! the relay's content-free `{"type":"mail"}` nudge, emits a `relay:mail` Tauri
//! event so the webview drains its mailbox immediately instead of polling. The
//! REST mailbox stays authoritative (hold-until-ack); a dropped socket only
//! adds latency, never loss — so this task is best-effort with plain backoff.
//!
//! The WS bearer is an ordinary short-lived device token, refreshed per connect
//! attempt from the device key alone (no vault involvement) — the live link,
//! like the rest of relay auth, survives a locked vault.

use ed25519_dalek::SigningKey;
use futures_util::{SinkExt, StreamExt};
use std::time::Duration;
use tauri::Emitter;
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest, http::header::AUTHORIZATION, Message,
};

/// Reconnect backoff: quick first retry, capped exponential thereafter. Attempt
/// is 1-based (the count of consecutive failures/disconnects so far).
pub fn backoff_delay(attempt: u32) -> Duration {
    const CAP_SECS: u64 = 30;
    let secs = 1u64.checked_shl(attempt.saturating_sub(1)).unwrap_or(CAP_SECS);
    Duration::from_secs(secs.min(CAP_SECS))
}

/// Derive the WebSocket URL from an `http(s)` relay base URL. `https` → `wss`,
/// `http` → `ws`; anything else is rejected (never silently downgraded).
pub fn ws_url_from_base(base_url: &str) -> Result<String, String> {
    let base = base_url.trim_end_matches('/');
    let ws_base = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        return Err(format!("relay url must be http(s): {base_url}"));
    };
    Ok(format!("{ws_base}/api/relay/ws"))
}

/// True for the relay's live-delivery nudge frame. Deliberately strict: only a
/// `{"type":"mail"}` object counts; anything else (hello, unknown) is ignored.
pub fn is_mail_frame(text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|v| v.get("type").and_then(|t| t.as_str()).map(|s| s == "mail"))
        .unwrap_or(false)
}

/// Hold one WS connection: authenticate with the bearer, then relay every mail
/// nudge to `on_mail` until the socket closes or errors. Replies to server
/// pings so the heartbeat keeps the link alive. Returns when the socket ends.
pub async fn connect_and_listen<F: FnMut()>(
    ws_url: &str,
    bearer: &str,
    mut on_mail: F,
) -> Result<(), String> {
    let mut request = ws_url
        .into_client_request()
        .map_err(|e| format!("bad ws url: {e}"))?;
    request.headers_mut().insert(
        AUTHORIZATION,
        format!("Bearer {bearer}")
            .parse()
            .map_err(|_| "invalid bearer header".to_string())?,
    );
    let (stream, _resp) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| format!("ws connect failed: {e}"))?;
    let (mut write, mut read) = stream.split();
    while let Some(msg) = read.next().await {
        match msg.map_err(|e| format!("ws read failed: {e}"))? {
            Message::Text(t) if is_mail_frame(t.as_str()) => on_mail(),
            Message::Ping(payload) => {
                // Keep the heartbeat alive; ignore send errors (next read ends).
                let _ = write.send(Message::Pong(payload)).await;
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    Ok(())
}

/// Supervise the live link forever: refresh a bearer, hold a connection, and on
/// any drop back off and reconnect. Each delivered nudge emits `relay:mail`.
pub async fn run_forever(
    base_url: String,
    relay_fp: String,
    signing: SigningKey,
    app: tauri::AppHandle,
) {
    let ws_url = match ws_url_from_base(&base_url) {
        Ok(u) => u,
        Err(e) => {
            log::warn!("relay live: {e}");
            return;
        }
    };
    let mut attempt = 0u32;
    loop {
        match crate::relay_client::RelayClient::issue_bearer_static(&base_url, &relay_fp, &signing)
            .await
        {
            Ok(bearer) => {
                let app = app.clone();
                let _ = connect_and_listen(&ws_url, &bearer, move || {
                    let _ = app.emit("relay:mail", ());
                })
                .await;
            }
            Err(e) => log::debug!("relay live: bearer refresh failed: {e}"),
        }
        attempt = attempt.saturating_add(1);
        tokio::time::sleep(backoff_delay(attempt)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::Message;

    #[test]
    fn ws_url_scheme_maps_and_rejects() {
        assert_eq!(
            ws_url_from_base("https://relay.example").unwrap(),
            "wss://relay.example/api/relay/ws"
        );
        assert_eq!(
            ws_url_from_base("http://127.0.0.1:3000/").unwrap(),
            "ws://127.0.0.1:3000/api/relay/ws"
        );
        assert!(ws_url_from_base("ftp://relay.example").is_err());
    }

    #[test]
    fn only_mail_frames_count() {
        assert!(is_mail_frame(r#"{"type":"mail"}"#));
        assert!(!is_mail_frame(r#"{"type":"hello"}"#));
        assert!(!is_mail_frame(r#"{"type":"other"}"#));
        assert!(!is_mail_frame("not json"));
        assert!(!is_mail_frame("{}"));
    }

    #[test]
    fn backoff_is_capped_and_monotonic_early() {
        assert_eq!(backoff_delay(1), Duration::from_secs(1));
        assert_eq!(backoff_delay(2), Duration::from_secs(2));
        assert_eq!(backoff_delay(3), Duration::from_secs(4));
        assert_eq!(backoff_delay(6), Duration::from_secs(30)); // 32 capped to 30
        assert_eq!(backoff_delay(64), Duration::from_secs(30)); // shift overflow → cap
    }

    #[tokio::test]
    async fn listens_and_fires_on_mail_only() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen_auth = Arc::new(AtomicU32::new(0));
        let seen_auth_srv = seen_auth.clone();

        // Server: accept one connection, assert it carried the bearer, then push
        // hello (ignored) + mail (counted) + mail, and close.
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let ws = tokio_tungstenite::accept_hdr_async(
                tcp,
                |req: &tokio_tungstenite::tungstenite::handshake::server::Request, resp| {
                    if req
                        .headers()
                        .get("authorization")
                        .and_then(|v| v.to_str().ok())
                        == Some("Bearer test-token")
                    {
                        seen_auth_srv.store(1, Ordering::SeqCst);
                    }
                    Ok(resp)
                },
            )
            .await
            .unwrap();
            let (mut write, _read) = ws.split();
            write.send(Message::Text(r#"{"type":"hello"}"#.into())).await.unwrap();
            write.send(Message::Text(r#"{"type":"mail"}"#.into())).await.unwrap();
            write.send(Message::Text(r#"{"type":"mail"}"#.into())).await.unwrap();
            write.send(Message::Close(None)).await.unwrap();
        });

        let ws_url = format!("ws://{addr}/api/relay/ws");
        let count = Arc::new(AtomicU32::new(0));
        let count_cb = count.clone();
        connect_and_listen(&ws_url, "test-token", move || {
            count_cb.fetch_add(1, Ordering::SeqCst);
        })
        .await
        .unwrap();
        server.await.unwrap();

        assert_eq!(seen_auth.load(Ordering::SeqCst), 1, "bearer must ride the handshake");
        assert_eq!(count.load(Ordering::SeqCst), 2, "only the two mail frames fire");
    }

    #[tokio::test]
    async fn rejects_a_non_http_base_before_connecting() {
        assert!(ws_url_from_base("wss://already-ws").is_err());
    }
}
