//! v8 chat message-envelope payload + inbound-drain policy (spec/chat.md § v8,
//! D6/D11).
//!
//! The plaintext that rides inside a `kind = "msg"` envelope. Two invariants
//! shape it:
//!   - **Sender is authenticated at the envelope layer, not here.** The signed
//!     sender cert inside the ciphertext is the source of truth; a sender field
//!     in this payload would be spoofable, so there isn't one — the drain
//!     stamps the sender from the *verified* `sender_identity_pub`.
//!   - **Ordering is the relay's, not the author's.** `sent_at` is a display
//!     hint only; the ordering key is the relay's delivery `relay_ts` (D11),
//!     which the drain supplies — never a value from this payload.

use crate::envelope::{EnvelopeError, Opened};
use crate::store::ImportMessage;

/// Envelope `kind` that carries a chat message payload (distinct from the
/// message's own `kind`, which is text/system/…).
pub const KIND_MSG: &str = "msg";
/// Friend establishment (D4b): the invitee's accept (via the invite capability,
/// triggers reciprocation) and the inviter's confirm (via the normal mailbox,
/// no reply). Both carry the sender's addressing and record the sender a friend.
pub const KIND_FRIEND_ACCEPT: &str = "friend-accept";
pub const KIND_FRIEND_CONFIRM: &str = "friend-confirm";

const CURRENT_VERSION: u32 = 1;

/// A friend to record, extracted from a verified friend-accept/confirm envelope.
/// `identity_pub`/`contact_id` come from the VERIFIED envelope sender; the rest
/// from the signed payload.
pub struct FriendAcceptData {
    /// Stable local id for the friend = their identity key (base64).
    pub contact_id: String,
    pub handle: String,
    /// Friend's Ed25519 identity (raw), from the verified envelope sender.
    pub identity_pub: Vec<u8>,
    /// Friend's X25519 sealing key (raw), from the signed payload.
    pub sealing_pub: Vec<u8>,
    pub delivery_token: String,
    /// True for a friend-accept (we should reciprocate a confirm); false for a
    /// confirm (terminal — no reply, so the handshake can't loop).
    pub reciprocate: bool,
}

#[derive(serde::Deserialize)]
struct FriendPayload {
    handle: String,
    #[serde(rename = "deliveryToken")]
    delivery_token: String,
    #[serde(rename = "sealingPub")]
    sealing_pub: String,
}

impl FriendAcceptData {
    /// Parse a verified friend-accept/confirm envelope, or None if malformed.
    fn parse(opened: &Opened, reciprocate: bool) -> Option<Self> {
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD;
        let p: FriendPayload = serde_json::from_slice(&opened.payload).ok()?;
        let sealing_pub = b64.decode(&p.sealing_pub).ok()?;
        if sealing_pub.len() != 32 {
            return None;
        }
        let identity_pub = b64.decode(&opened.sender_identity_pub).ok()?;
        Some(FriendAcceptData {
            contact_id: opened.sender_identity_pub.clone(),
            handle: p.handle,
            identity_pub,
            sealing_pub,
            delivery_token: p.delivery_token,
            reciprocate,
        })
    }
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum MessageError {
    #[error("unknown message payload version {0} — buffer and retry after update")]
    UnknownVersion(u32),
    #[error("malformed message payload")]
    Malformed,
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, PartialEq)]
pub struct ChatMessagePayload {
    pub v: u32,
    /// Sender-assigned, globally-unique id: the key for idempotent ingest and
    /// dedup across at-least-once delivery + history backfill (D11).
    pub id: String,
    pub conversation_id: String,
    /// `None` == the conversation's default channel.
    #[serde(default)]
    pub channel_id: Option<String>,
    /// Author wall-clock (ms). Display hint only — NEVER the ordering key.
    pub sent_at: i64,
    /// Message kind: `text` | `system` | … (not the envelope kind).
    pub kind: String,
    #[serde(default)]
    pub content: Option<String>,
    /// Reply reference + attachments bags, pre-serialized as JSON strings to
    /// match the local store's columns; `None` when absent.
    #[serde(default)]
    pub reply_ref_json: Option<String>,
    #[serde(default)]
    pub attachments_json: Option<String>,
}

impl ChatMessagePayload {
    pub fn encode(&self) -> Result<Vec<u8>, MessageError> {
        serde_json::to_vec(self).map_err(|_| MessageError::Malformed)
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, MessageError> {
        let p: ChatMessagePayload =
            serde_json::from_slice(bytes).map_err(|_| MessageError::Malformed)?;
        if p.v != CURRENT_VERSION {
            return Err(MessageError::UnknownVersion(p.v));
        }
        Ok(p)
    }

    /// Map to a local-log row. `relay_ts` is the relay's delivery stamp (the
    /// ordering key, D11); `sender_contact_id` comes from the VERIFIED envelope
    /// sender — never from this payload.
    pub fn into_import(self, relay_ts: i64, sender_contact_id: Option<String>) -> ImportMessage {
        ImportMessage {
            id: self.id,
            conversation_id: self.conversation_id,
            channel_id: self.channel_id,
            sender_contact_id,
            relay_ts,
            content: self.content,
            kind: self.kind,
            reply_ref_json: self.reply_ref_json,
            attachments_json: self.attachments_json,
            edited_at: None,
        }
    }
}

/// What the drain does with one delivered envelope.
pub enum Disposition {
    /// Verified + decoded: ingest, then ack (remove from the queue).
    Ingest(Box<ImportMessage>),
    /// Version skew (envelope or payload) or a not-yet-handled kind: leave it
    /// queued so it redelivers and we process it after an app update — the
    /// "buffer, never drop" invariant.
    Buffer,
    /// Permanently invalid (undecryptable, forged signature, or authenticated
    /// but garbage payload): ack to drop it. Buffering these would let a single
    /// malformed/forged inject wedge the queue forever, so they are discarded.
    Discard,
    /// A verified friend-accept/confirm (D4b): record the sender a friend, then
    /// ack. `reciprocate` distinguishes accept (reply a confirm) from confirm.
    Friend(Box<FriendAcceptData>),
}

/// Decide the fate of one delivered envelope from the `open` result and its
/// relay delivery timestamp. Pure so the whole policy is unit-tested without a
/// network or live crypto.
pub fn disposition(open_result: Result<Opened, EnvelopeError>, relay_ts: i64) -> Disposition {
    match open_result {
        Ok(opened) => match opened.kind.as_str() {
            KIND_MSG => match ChatMessagePayload::decode(&opened.payload) {
                Ok(p) => Disposition::Ingest(Box::new(
                    p.into_import(relay_ts, Some(opened.sender_identity_pub)),
                )),
                // Authenticated sender, unknown payload version → wait for update.
                Err(MessageError::UnknownVersion(_)) => Disposition::Buffer,
                // Authenticated sender, unrecoverable garbage → drop.
                Err(MessageError::Malformed) => Disposition::Discard,
            },
            KIND_FRIEND_ACCEPT | KIND_FRIEND_CONFIRM => {
                let reciprocate = opened.kind == KIND_FRIEND_ACCEPT;
                match FriendAcceptData::parse(&opened, reciprocate) {
                    Some(f) => Disposition::Friend(Box::new(f)),
                    None => Disposition::Discard, // authed but garbage → drop
                }
            }
            // A known-good envelope of a kind we don't handle yet → wait for update.
            _ => Disposition::Buffer,
        },
        // Future envelope version → buffer and re-decode after update.
        Err(EnvelopeError::UnknownVersion(_)) => Disposition::Buffer,
        // Undecryptable / forged / malformed → never becomes valid → drop.
        Err(_) => Disposition::Discard,
    }
}

/// Result of a drain pass (for logs/UI + tests).
#[derive(serde::Serialize, Default)]
pub struct DrainReport {
    /// Rows newly inserted into the local log (idempotent — dupes not counted).
    pub ingested: usize,
    /// Queue entries removed (ingested + discarded).
    pub acked: usize,
    /// Queue entries left in place for a post-update retry.
    pub buffered: usize,
    /// Friends recorded from verified friend-accept/confirm envelopes (D4b).
    pub friends: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(id: &str) -> ChatMessagePayload {
        ChatMessagePayload {
            v: 1,
            id: id.to_string(),
            conversation_id: "c1".into(),
            channel_id: None,
            sent_at: 111,
            kind: "text".into(),
            content: Some("hi".into()),
            reply_ref_json: None,
            attachments_json: None,
        }
    }

    fn opened(kind: &str, payload: Vec<u8>) -> Opened {
        Opened {
            kind: kind.to_string(),
            payload,
            sender_identity_pub: "SENDERPUB".into(),
            sent_at: 111,
        }
    }

    #[test]
    fn encode_decode_roundtrip() {
        let p = payload("m1");
        let bytes = p.encode().unwrap();
        assert_eq!(ChatMessagePayload::decode(&bytes).unwrap(), p);
    }

    #[test]
    fn decode_rejects_unknown_version() {
        let mut v: serde_json::Value = serde_json::from_slice(&payload("m1").encode().unwrap()).unwrap();
        v["v"] = serde_json::json!(2);
        let bytes = serde_json::to_vec(&v).unwrap();
        assert_eq!(
            ChatMessagePayload::decode(&bytes),
            Err(MessageError::UnknownVersion(2))
        );
    }

    #[test]
    fn decode_rejects_missing_required_field() {
        // `conversation_id` absent → Malformed (not silently defaulted).
        let bytes = br#"{"v":1,"id":"m1","sent_at":1,"kind":"text"}"#;
        assert_eq!(ChatMessagePayload::decode(bytes), Err(MessageError::Malformed));
    }

    #[test]
    fn into_import_uses_delivery_ts_and_verified_sender() {
        let row = payload("m1").into_import(999, Some("VERIFIED".into()));
        assert_eq!(row.relay_ts, 999); // delivery stamp, not sent_at (111)
        assert_eq!(row.sender_contact_id.as_deref(), Some("VERIFIED"));
        assert_eq!(row.id, "m1");
    }

    #[test]
    fn disposition_ingests_a_valid_msg_with_verified_sender() {
        let bytes = payload("m1").encode().unwrap();
        match disposition(Ok(opened(KIND_MSG, bytes)), 555) {
            Disposition::Ingest(m) => {
                assert_eq!(m.relay_ts, 555);
                assert_eq!(m.sender_contact_id.as_deref(), Some("SENDERPUB"));
            }
            _ => panic!("expected ingest"),
        }
    }

    #[test]
    fn disposition_buffers_version_skew_and_unknown_kinds() {
        // Future envelope version.
        assert!(matches!(
            disposition(Err(EnvelopeError::UnknownVersion(9)), 1),
            Disposition::Buffer
        ));
        // Future payload version inside a msg envelope.
        let mut v: serde_json::Value = serde_json::from_slice(&payload("m1").encode().unwrap()).unwrap();
        v["v"] = serde_json::json!(2);
        let future = serde_json::to_vec(&v).unwrap();
        assert!(matches!(
            disposition(Ok(opened(KIND_MSG, future)), 1),
            Disposition::Buffer
        ));
        // Known-good envelope of an unhandled kind.
        assert!(matches!(
            disposition(Ok(opened("reaction", b"{}".to_vec())), 1),
            Disposition::Buffer
        ));
    }

    #[test]
    fn disposition_discards_unrecoverable_items() {
        // Forged signature / undecryptable never become valid → drop.
        assert!(matches!(
            disposition(Err(EnvelopeError::BadSignature), 1),
            Disposition::Discard
        ));
        assert!(matches!(
            disposition(Err(EnvelopeError::Decrypt), 1),
            Disposition::Discard
        ));
        // Authenticated sender but garbage payload → drop (can't wedge queue).
        assert!(matches!(
            disposition(Ok(opened(KIND_MSG, b"not json".to_vec())), 1),
            Disposition::Discard
        ));
    }

    fn friend_envelope(kind: &str, handle: &str, token: &str, sealing: [u8; 32], sender: [u8; 32]) -> Opened {
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD;
        let payload = serde_json::to_vec(&serde_json::json!({
            "handle": handle,
            "deliveryToken": token,
            "sealingPub": b64.encode(sealing),
        }))
        .unwrap();
        Opened { kind: kind.into(), payload, sender_identity_pub: b64.encode(sender), sent_at: 0 }
    }

    #[test]
    fn friend_accept_records_the_verified_sender() {
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD;
        let env = friend_envelope(KIND_FRIEND_ACCEPT, "Bob#0002", "bob-deliv", [8u8; 32], [7u8; 32]);
        match disposition(Ok(env), 5) {
            Disposition::Friend(f) => {
                assert!(f.reciprocate); // accept → reply a confirm
                assert_eq!(f.contact_id, b64.encode([7u8; 32]));
                assert_eq!(f.handle, "Bob#0002");
                assert_eq!(f.identity_pub, vec![7u8; 32]); // from the VERIFIED sender
                assert_eq!(f.sealing_pub, vec![8u8; 32]); // from the signed payload
                assert_eq!(f.delivery_token, "bob-deliv");
            }
            _ => panic!("expected Friend"),
        }
    }

    #[test]
    fn friend_confirm_is_terminal() {
        let env = friend_envelope(KIND_FRIEND_CONFIRM, "A#1", "t", [1u8; 32], [2u8; 32]);
        match disposition(Ok(env), 1) {
            Disposition::Friend(f) => assert!(!f.reciprocate), // confirm → no reply (no loop)
            _ => panic!("expected Friend"),
        }
    }

    #[test]
    fn friend_accept_garbage_is_discarded() {
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD;
        // Not JSON.
        let env = Opened {
            kind: KIND_FRIEND_ACCEPT.into(),
            payload: b"not json".to_vec(),
            sender_identity_pub: b64.encode([1u8; 32]),
            sent_at: 0,
        };
        assert!(matches!(disposition(Ok(env), 1), Disposition::Discard));
        // Wrong-length sealing key.
        let env = friend_envelope(KIND_FRIEND_ACCEPT, "h", "t", [0u8; 32], [1u8; 32]);
        let mut v: serde_json::Value = serde_json::from_slice(&env.payload).unwrap();
        v["sealingPub"] = serde_json::json!(b64.encode([1u8; 10])); // 10 bytes ≠ 32
        let env = Opened { payload: serde_json::to_vec(&v).unwrap(), ..env };
        assert!(matches!(disposition(Ok(env), 1), Disposition::Discard));
    }
}
