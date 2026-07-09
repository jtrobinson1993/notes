//! Voice signaling consumer (spec/voice.md § v8, client half).
//!
//! Holds a WebSocket to the relay's `/api/relay/voice` and pumps it both ways:
//! outbound `join`/`signal`/`leave` frames from the UI (via an mpsc channel) go
//! up, and inbound `hello`/`joined`/`peer-join`/`peer-leave`/`signal`/`error`
//! frames are forwarded to the webview as `voice:frame` Tauri events. Unlike the
//! one-way mail nudge (relay_live), this is a bidirectional signaling channel.
//!
//! Auth is the same short-lived device token, refreshed per connect from the
//! device key alone (survives a locked vault). Best-effort with backoff: a
//! dropped socket ends the current call's live signaling; the UI re-joins on
//! reconnect. The SDP/ICE inside `signal` frames is E2E-sealed — this layer only
//! moves opaque payloads.

use ed25519_dalek::SigningKey;
use futures_util::{SinkExt, StreamExt};
use tauri::Emitter;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest, http::header::AUTHORIZATION, Message,
};

pub use crate::relay_live::backoff_delay;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// Tauri-managed handle for the voice signaling link. Holds the outbound frame
/// sender (the UI commands push `join`/`signal`/`leave` onto it) and hands the
/// receiver to `run_forever` exactly once, on the first relay connect.
pub struct VoiceSignal {
    tx: mpsc::Sender<String>,
    rx: Mutex<Option<mpsc::Receiver<String>>>,
    begun: AtomicBool,
}

impl Default for VoiceSignal {
    fn default() -> Self {
        // A small bound: signaling is best-effort, so a full queue drops rather
        // than blocks (try_send). 64 covers a burst of ICE candidates.
        let (tx, rx) = mpsc::channel(64);
        Self { tx, rx: Mutex::new(Some(rx)), begun: AtomicBool::new(false) }
    }
}

impl VoiceSignal {
    /// Take the receiver and mark the link begun — returns `Some` exactly once.
    pub fn begin(&self) -> Option<mpsc::Receiver<String>> {
        if self.begun.swap(true, Ordering::SeqCst) {
            return None;
        }
        self.rx.lock().unwrap().take()
    }

    /// Enqueue an outbound frame (non-blocking; dropped if the queue is full or
    /// the link isn't up — the UI re-issues on reconnect).
    pub fn enqueue(&self, frame: String) {
        let _ = self.tx.try_send(frame);
    }
}

/// Derive the voice signaling WS URL from an `http(s)` relay base URL. `https` →
/// `wss`, `http` → `ws`; anything else is rejected (never silently downgraded).
pub fn voice_ws_url_from_base(base_url: &str) -> Result<String, String> {
    let base = base_url.trim_end_matches('/');
    let ws_base = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        return Err(format!("relay url must be http(s): {base_url}"));
    };
    Ok(format!("{ws_base}/api/relay/voice"))
}

/// Build a `join` frame for a call id.
pub fn join_frame(call_id: &str) -> String {
    serde_json::json!({ "type": "join", "callId": call_id }).to_string()
}

/// Build a `leave` frame for a call id.
pub fn leave_frame(call_id: &str) -> String {
    serde_json::json!({ "type": "leave", "callId": call_id }).to_string()
}

/// Build a `signal` frame carrying an opaque (E2E-sealed) payload for a call id.
pub fn signal_frame(call_id: &str, payload: serde_json::Value) -> String {
    serde_json::json!({ "type": "signal", "callId": call_id, "payload": payload }).to_string()
}

/// The `type` of an inbound frame, if it is a well-formed object with a string
/// `type`. Used to filter what we forward (and to unit-test the classifier).
pub fn inbound_kind(text: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|v| v.get("type").and_then(|t| t.as_str()).map(str::to_string))
}

/// Frame types the relay sends that are worth forwarding to the webview.
fn is_forwardable(kind: &str) -> bool {
    matches!(
        kind,
        "hello" | "joined" | "peer-join" | "peer-leave" | "signal" | "error"
    )
}

/// Hold one connection: authenticate with the bearer, then pump outbound frames
/// from `outbound` up and forward inbound signaling frames to `on_frame` until
/// the socket closes or errors. Replies to server pings. Returns when it ends.
pub async fn connect_and_run<F: FnMut(serde_json::Value)>(
    ws_url: &str,
    bearer: &str,
    outbound: &mut mpsc::Receiver<String>,
    mut on_frame: F,
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
    loop {
        tokio::select! {
            // Outbound: a UI-issued frame to send. Channel closed → stop.
            out = outbound.recv() => match out {
                Some(frame) => {
                    if write.send(Message::Text(frame.into())).await.is_err() {
                        break; // socket gone; supervisor reconnects
                    }
                }
                None => break,
            },
            // Inbound: a relay frame, a ping to answer, or a close.
            msg = read.next() => match msg {
                Some(Ok(Message::Text(t))) => {
                    if let Some(kind) = inbound_kind(t.as_str()) {
                        if is_forwardable(&kind) {
                            if let Ok(v) = serde_json::from_str::<serde_json::Value>(t.as_str()) {
                                on_frame(v);
                            }
                        }
                    }
                }
                Some(Ok(Message::Ping(p))) => {
                    let _ = write.send(Message::Pong(p)).await;
                }
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => {}
                Some(Err(e)) => return Err(format!("ws read failed: {e}")),
            },
        }
    }
    Ok(())
}

/// Supervise the voice link forever: refresh a bearer, hold a connection, and on
/// any drop back off and reconnect. Each forwarded frame emits `voice:frame`.
pub async fn run_forever(
    base_url: String,
    relay_fp: String,
    signing: SigningKey,
    app: tauri::AppHandle,
    mut outbound: mpsc::Receiver<String>,
) {
    let ws_url = match voice_ws_url_from_base(&base_url) {
        Ok(u) => u,
        Err(e) => {
            log::warn!("voice live: {e}");
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
                let _ = connect_and_run(&ws_url, &bearer, &mut outbound, move |frame| {
                    let _ = app.emit("voice:frame", frame);
                })
                .await;
            }
            Err(e) => log::debug!("voice live: bearer refresh failed: {e}"),
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

    #[test]
    fn ws_url_targets_the_voice_path() {
        assert_eq!(
            voice_ws_url_from_base("https://relay.example").unwrap(),
            "wss://relay.example/api/relay/voice"
        );
        assert_eq!(
            voice_ws_url_from_base("http://127.0.0.1:3000/").unwrap(),
            "ws://127.0.0.1:3000/api/relay/voice"
        );
        assert!(voice_ws_url_from_base("ftp://relay.example").is_err());
    }

    #[test]
    fn frame_builders_and_classifier() {
        assert_eq!(inbound_kind(&join_frame("c1")).as_deref(), Some("join"));
        assert_eq!(inbound_kind(&leave_frame("c1")).as_deref(), Some("leave"));
        let sig = signal_frame("c1", serde_json::json!("sealed"));
        let v: serde_json::Value = serde_json::from_str(&sig).unwrap();
        assert_eq!(v["type"], "signal");
        assert_eq!(v["callId"], "c1");
        assert_eq!(v["payload"], "sealed");
        assert!(inbound_kind("not json").is_none());
        assert!(inbound_kind("{}").is_none());
    }

    #[test]
    fn only_relay_frames_are_forwardable() {
        for k in ["hello", "joined", "peer-join", "peer-leave", "signal", "error"] {
            assert!(is_forwardable(k), "{k} should forward");
        }
        // Our own outbound kinds are never forwarded back up.
        for k in ["join", "leave", "ping", "bogus"] {
            assert!(!is_forwardable(k), "{k} must not forward");
        }
    }

    #[tokio::test]
    async fn pumps_outbound_up_and_forwards_inbound_frames() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let got_join = Arc::new(AtomicU32::new(0));
        let got_join_srv = got_join.clone();

        // Server: accept, read one text frame (the client's join), assert it, then
        // push a forwardable `signal` + a non-forwardable `pong`, and close.
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            let (mut write, mut read) = ws.split();
            if let Some(Ok(Message::Text(t))) = read.next().await {
                if inbound_kind(t.as_str()).as_deref() == Some("join") {
                    got_join_srv.store(1, Ordering::SeqCst);
                }
            }
            write
                .send(Message::Text(r#"{"type":"signal","callId":"c1","payload":"x"}"#.into()))
                .await
                .unwrap();
            write.send(Message::Text(r#"{"type":"pong"}"#.into())).await.unwrap();
            write.send(Message::Close(None)).await.unwrap();
        });

        let ws_url = format!("ws://{addr}/api/relay/voice");
        let (tx, mut rx) = mpsc::channel::<String>(8);
        tx.send(join_frame("c1")).await.unwrap();
        let forwarded = Arc::new(AtomicU32::new(0));
        let fwd_cb = forwarded.clone();
        connect_and_run(&ws_url, "test-token", &mut rx, move |v| {
            assert_eq!(v["type"], "signal"); // only forwardable frames arrive
            fwd_cb.fetch_add(1, Ordering::SeqCst);
        })
        .await
        .unwrap();
        server.await.unwrap();

        assert_eq!(got_join.load(Ordering::SeqCst), 1, "outbound join reached the server");
        assert_eq!(forwarded.load(Ordering::SeqCst), 1, "only the signal frame forwarded");
    }
}
