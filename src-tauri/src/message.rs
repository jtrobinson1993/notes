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
/// Delete a previously-sent message (D11 tombstone). Payload `{ id }` targets
/// the message; only the original sender may delete it (checked on apply).
pub const KIND_DELETE: &str = "delete";
/// Edit a previously-sent message. Payload `{ id, content, editedAt }`; only the
/// original sender may edit it (checked on apply).
pub const KIND_EDIT: &str = "edit";
/// Add/remove a reaction. Payload `{ id, emoji, op:"add"|"remove" }`; the
/// reactor is the verified sender (anyone may react to a message they can see).
pub const KIND_REACT: &str = "react";
/// A DM-sealed group invite (D14): a friend hands me a group's shared key so I
/// can decrypt its messages. Payload `{ groupId, groupKey, name }`.
pub const KIND_GROUP_INVITE: &str = "group-invite";
/// A voice call ring (v8 voice, single-relay): the caller seals `{ callId }`
/// into the callee's mailbox so the callee can `join` that call id on the
/// signaling socket (/api/relay/voice) and answer. The caller is the verified
/// envelope sender (spoof-proof); the SDP/ICE exchange then happens live over
/// the signaling socket, not in this envelope. Time-sensitive: a stale ring
/// (redelivered long after the caller gave up) is dropped at the drain, not
/// re-rung — voice does not honour the "buffer, never drop" message invariant.
pub const KIND_CALL_OFFER: &str = "call-offer";
/// A KT gossip beacon (D5 client verify): a friend piggybacks the latest signed
/// KT epoch root it has seen from the relay so the recipient can detect a **split
/// view** (the relay showing different logs to different users). Payload
/// `{ epoch, root, prev, sig }`; the recipient verifies the relay's signature
/// before treating a root mismatch as equivocation.
pub const KIND_KT_GOSSIP: &str = "kt-gossip";

/// A verified KT gossip beacon: the signed root a friend saw. `gossiper` is the
/// verified sender (unused for the check but handy for logs/UX).
pub struct KtGossipData {
    pub epoch: i64,
    pub root: String,
    pub prev: String,
    pub sig: String,
    pub gossiper: String,
}

#[derive(serde::Deserialize)]
struct KtGossipPayload {
    epoch: i64,
    root: String,
    #[serde(default)]
    prev: String,
    sig: String,
}

/// A verified incoming call: ring for `call_id` from `caller_id` (the verified
/// envelope sender), carrying the base64 `media_key` for the call's frame E2EE.
/// The drain judges staleness from the envelope's relay_ts. The media key rides
/// *inside* the already-sealed sealed-sender envelope, so only the callee reads
/// it — the SFU never sees it (media frames stay E2E-encrypted end to end).
pub struct CallOfferData {
    pub call_id: String,
    pub caller_id: String,
    pub media_key: String,
}

#[derive(serde::Deserialize)]
struct CallOfferPayload {
    #[serde(rename = "callId")]
    call_id: String,
    /// base64 32-byte frame key the caller minted for this call.
    #[serde(rename = "mediaKey")]
    media_key: String,
}

/// A verified group invite: a candidate `group_key` for `group_id`.
///
/// "Verified" here means only that the envelope's inner signature checked out —
/// i.e. whoever holds `inviter_id`'s secret key wrote this payload. That is NOT
/// authority to hand me a group key: `inviter_id` is carried precisely so the
/// drain can require it to be a **current friend on this relay whose key the
/// transparency log does not contradict** before anything is stored. It used to
/// be discarded, which left the invite unattributable — anyone who could enqueue
/// into my mailbox (including the relay) could mint group membership, and,
/// worse, silently re-key a group I was already in.
pub struct GroupInviteData {
    pub group_id: String,
    pub group_key: Vec<u8>,
    pub name: Option<String>,
    /// b64 Ed25519 of the VERIFIED envelope sender — never a payload field.
    pub inviter_id: String,
}

#[derive(serde::Deserialize)]
struct GroupInvitePayload {
    #[serde(rename = "groupId")]
    group_id: String,
    #[serde(rename = "groupKey")]
    group_key: String,
    #[serde(default)]
    name: Option<String>,
}

/// A verified reaction: add or remove `emoji` on `target_id` by `reactor_id`.
pub struct ReactData {
    pub target_id: String,
    pub reactor_id: String,
    pub emoji: String,
    pub add: bool,
}

#[derive(serde::Deserialize)]
struct ReactPayload {
    id: String,
    emoji: String,
    op: String,
}

/// A verified delete request: drop `target_id` iff its recorded sender equals
/// `editor_id` (the verified envelope sender).
pub struct DeleteData {
    pub target_id: String,
    pub editor_id: String,
}

/// A verified edit request: replace `target_id`'s content iff its recorded
/// sender equals `editor_id`.
pub struct EditData {
    pub target_id: String,
    pub editor_id: String,
    pub content: String,
    pub edited_at: i64,
}

#[derive(serde::Deserialize)]
struct DeletePayload {
    id: String,
}

#[derive(serde::Deserialize)]
struct EditPayload {
    id: String,
    content: String,
    #[serde(rename = "editedAt")]
    edited_at: i64,
}

const CURRENT_VERSION: u32 = 1;

/// A friend to record, extracted from a verified friend-accept/confirm envelope.
/// `identity_pub`/`contact_id` come from the VERIFIED envelope sender; the rest
/// from the signed payload.
pub struct FriendAcceptData {
    /// Stable local id for the friend = their identity key (base64).
    pub contact_id: String,
    pub handle: String,
    /// Friend's chosen display name (E2EE, from the signed payload), if they set
    /// one — so the friends list shows their real name, not just the handle.
    pub display_name: Option<String>,
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
    #[serde(rename = "displayName", default)]
    display_name: Option<String>,
    #[serde(rename = "deliveryToken")]
    delivery_token: String,
    #[serde(rename = "sealingPub")]
    sealing_pub: String,
}

/// Add a member (by identity key) to a group-state record and bump its version
/// (D14). Idempotent on the member (no duplicate), but always advances the
/// version so the signed update is accepted (anti-rollback). Returns the new
/// record JSON string to sign + PUT.
///
/// `record` arrives from the **relay**, and the caller is about to sign it, so
/// two things are checked before it will:
///   - it is the record for `group_id` — signing an authority record for some
///     *other* group would hand the relay my signature over a document I never
///     inspected; and
///   - `me` is in it as `owner`/`admin` — I have no standing to re-sign a record
///     that does not name me an admin (the relay rejects such a PUT anyway, so
///     this only fails earlier and louder).
///
/// What it deliberately does **not** claim to catch: a relay that returns a
/// record with an *extra* member spliced in. Detecting that needs a locally
/// mirrored, version-monotonic copy of the record, which does not exist yet —
/// see roadmap § Group state is trusted from the relay. The spliced member never
/// gets the group key (that only travels in a DM-sealed invite), so the exposure
/// is fan-out ciphertext and blob reach, not content.
pub fn group_record_add_member(
    record: &str,
    group_id: &str,
    me: &str,
    identity_pub_b64: &str,
) -> Result<String, MessageError> {
    let mut v: serde_json::Value = serde_json::from_str(record).map_err(|_| MessageError::Malformed)?;
    if v.get("groupId").and_then(|x| x.as_str()) != Some(group_id) {
        return Err(MessageError::UntrustedRecord("record is for a different group"));
    }
    let version = v.get("version").and_then(|x| x.as_i64()).ok_or(MessageError::Malformed)?;
    let members = v
        .get_mut("members")
        .and_then(|m| m.as_array_mut())
        .ok_or(MessageError::Malformed)?;
    let i_may_sign = members.iter().any(|m| {
        m.get("identityPubKey").and_then(|k| k.as_str()) == Some(me)
            && matches!(m.get("role").and_then(|r| r.as_str()), Some("owner") | Some("admin"))
    });
    if !i_may_sign {
        return Err(MessageError::UntrustedRecord("this record does not name you an admin"));
    }
    let exists = members
        .iter()
        .any(|m| m.get("identityPubKey").and_then(|k| k.as_str()) == Some(identity_pub_b64));
    if !exists {
        members.push(serde_json::json!({ "identityPubKey": identity_pub_b64, "role": "member" }));
    }
    v["version"] = serde_json::json!(version + 1);
    serde_json::to_string(&v).map_err(|_| MessageError::Malformed)
}

/// Serialize a friend-accept/confirm payload (D4b) — my handle + delivery token
/// + sealing key (base64). Symmetric with `FriendAcceptData::parse`, and matches
/// the TS `redeemFriendInvite` shape, so either side can produce what the other
/// decodes. Used by the drain to reciprocate a confirm.
pub fn friend_payload(
    handle: &str,
    delivery_token: &str,
    sealing_pub_b64: &str,
    display_name: Option<&str>,
) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "handle": handle,
        "displayName": display_name,
        "deliveryToken": delivery_token,
        "sealingPub": sealing_pub_b64,
    }))
    .unwrap_or_default()
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
            display_name: p.display_name.filter(|s| !s.trim().is_empty()),
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
    /// A relay-supplied group-state record we refuse to sign as-is (D14).
    #[error("group state record refused: {0}")]
    UntrustedRecord(&'static str),
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
    /// A v1 outbound text message. The caller assigns a globally-unique `id` and
    /// puts the same id in both the sealed payload and the local-log tee (via
    /// `into_import`), so the sender's copy and the recipient's ingest dedup.
    pub fn new_text(
        id: String,
        conversation_id: String,
        channel_id: Option<String>,
        content: String,
        sent_at: i64,
        attachments_json: Option<String>,
    ) -> Self {
        ChatMessagePayload {
            v: CURRENT_VERSION,
            id,
            conversation_id,
            channel_id,
            sent_at,
            kind: "text".into(),
            content: Some(content),
            reply_ref_json: None,
            attachments_json,
        }
    }

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
    /// A verified delete (D11): tombstone the target iff the verified sender is
    /// its original author, then ack.
    Delete(Box<DeleteData>),
    /// A verified edit (D11): replace the target's content iff the verified
    /// sender is its original author, then ack.
    Edit(Box<EditData>),
    /// A verified reaction (D11): add/remove the emoji by the verified reactor.
    React(Box<ReactData>),
    /// A verified group invite (D14): store the group key → I'm a member.
    GroupInvite(Box<GroupInviteData>),
    /// A verified voice call ring: surface an incoming call, then ack (a ring is
    /// ephemeral — always removed from the queue, never re-buffered).
    CallOffer(Box<CallOfferData>),
    /// A verified KT gossip beacon: check the friend's signed root for a split
    /// view, then ack (ephemeral — never re-buffered).
    KtGossip(Box<KtGossipData>),
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
                // Authenticated sender, unrecoverable garbage → drop. Listed
                // explicitly rather than `_`, so a future error variant that
                // deserves buffering has to be classified here, not silently
                // discarded.
                Err(MessageError::Malformed | MessageError::UntrustedRecord(_)) => Disposition::Discard,
            },
            KIND_FRIEND_ACCEPT | KIND_FRIEND_CONFIRM => {
                let reciprocate = opened.kind == KIND_FRIEND_ACCEPT;
                match FriendAcceptData::parse(&opened, reciprocate) {
                    Some(f) => Disposition::Friend(Box::new(f)),
                    None => Disposition::Discard, // authed but garbage → drop
                }
            }
            KIND_DELETE => match serde_json::from_slice::<DeletePayload>(&opened.payload) {
                Ok(p) => Disposition::Delete(Box::new(DeleteData {
                    target_id: p.id,
                    editor_id: opened.sender_identity_pub,
                })),
                Err(_) => Disposition::Discard,
            },
            KIND_EDIT => match serde_json::from_slice::<EditPayload>(&opened.payload) {
                Ok(p) => Disposition::Edit(Box::new(EditData {
                    target_id: p.id,
                    editor_id: opened.sender_identity_pub,
                    content: p.content,
                    edited_at: p.edited_at,
                })),
                Err(_) => Disposition::Discard,
            },
            KIND_REACT => match serde_json::from_slice::<ReactPayload>(&opened.payload) {
                Ok(p) if p.op == "add" || p.op == "remove" => Disposition::React(Box::new(ReactData {
                    target_id: p.id,
                    reactor_id: opened.sender_identity_pub,
                    emoji: p.emoji,
                    add: p.op == "add",
                })),
                _ => Disposition::Discard,
            },
            KIND_GROUP_INVITE => match serde_json::from_slice::<GroupInvitePayload>(&opened.payload) {
                Ok(p) => {
                    use base64::Engine as _;
                    match base64::engine::general_purpose::STANDARD.decode(&p.group_key) {
                        Ok(key) if key.len() == 32 => Disposition::GroupInvite(Box::new(GroupInviteData {
                            group_id: p.group_id,
                            group_key: key,
                            name: p.name,
                            inviter_id: opened.sender_identity_pub,
                        })),
                        _ => Disposition::Discard,
                    }
                }
                Err(_) => Disposition::Discard,
            },
            KIND_KT_GOSSIP => match serde_json::from_slice::<KtGossipPayload>(&opened.payload) {
                // A well-formed beacon (non-empty root + sig). The relay-signature
                // check happens at the drain (it has the pinned relay key).
                Ok(p) if !p.root.is_empty() && !p.sig.is_empty() => {
                    Disposition::KtGossip(Box::new(KtGossipData {
                        epoch: p.epoch,
                        root: p.root,
                        prev: p.prev,
                        sig: p.sig,
                        gossiper: opened.sender_identity_pub,
                    }))
                }
                _ => Disposition::Discard,
            },
            KIND_CALL_OFFER => match serde_json::from_slice::<CallOfferPayload>(&opened.payload) {
                // A non-empty call id (to join the room) + a 32-byte media key
                // (for frame E2EE) are both required — otherwise it's unusable.
                Ok(p) if !p.call_id.is_empty() && is_b64_32(&p.media_key) => {
                    Disposition::CallOffer(Box::new(CallOfferData {
                        call_id: p.call_id,
                        caller_id: opened.sender_identity_pub,
                        media_key: p.media_key,
                    }))
                }
                _ => Disposition::Discard,
            },
            // A known-good envelope of a kind we don't handle yet → wait for update.
            _ => Disposition::Buffer,
        },
        // Future envelope version → buffer and re-decode after update.
        Err(EnvelopeError::UnknownVersion(_)) => Disposition::Buffer,
        // Undecryptable / forged / malformed → never becomes valid → drop.
        Err(_) => Disposition::Discard,
    }
}

/// True iff `s` is base64 (standard) for exactly 32 bytes — a media/frame key.
fn is_b64_32(s: &str) -> bool {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .map(|b| b.len() == 32)
        .unwrap_or(false)
}

/// An incoming call ring surfaced to the UI from a drained call-offer envelope
/// (v8 voice). `relay_ts` lets the UI drop a stale ring (redelivered long after
/// the caller gave up) rather than ring for a call that's already over.
/// `media_key` is the base64 frame key for the call's E2EE (only the callee, who
/// opened the sealed envelope, sees it).
#[derive(serde::Serialize)]
pub struct CallRing {
    #[serde(rename = "callId")]
    pub call_id: String,
    #[serde(rename = "callerId")]
    pub caller_id: String,
    #[serde(rename = "relayTs")]
    pub relay_ts: i64,
    #[serde(rename = "mediaKey")]
    pub media_key: String,
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
    /// Incoming voice call rings from verified call-offer envelopes (v8 voice).
    #[serde(default)]
    pub calls: Vec<CallRing>,
    /// Friend handshakes refused because the transparency log does not publish
    /// that key for that handle (D5 — key-transparency.md § Contact
    /// verification). Nothing was recorded and nothing was sealed back.
    #[serde(default)]
    pub kt_rejected: usize,
    /// Groups joined from an admitted `group-invite` (chat.md § Groups).
    #[serde(default)]
    pub groups_joined: usize,
    /// `group-invite` envelopes refused: not from a current friend, from a
    /// friend the transparency log contradicts, or an attempt to re-key a group
    /// I am already in. Nothing was written for any of them.
    #[serde(default)]
    pub group_invites_rejected: usize,
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
    fn new_text_and_its_tee_share_id_and_content() {
        let p = ChatMessagePayload::new_text(
            "m9".into(),
            "conv1".into(),
            Some("chan1".into()),
            "hello".into(),
            111,
            Some("[{\"blobId\":\"b1\"}]".into()),
        );
        assert_eq!(p.v, 1);
        assert_eq!(p.kind, "text");
        assert_eq!(p.attachments_json.as_deref(), Some("[{\"blobId\":\"b1\"}]"));
        // The sealed payload (sent) and the local tee row must agree on id +
        // content so both sides dedup; the tee's relay_ts is the send stamp.
        let bytes = p.encode().unwrap();
        let sent = ChatMessagePayload::decode(&bytes).unwrap();
        let tee = p.into_import(999, Some("self".into()));
        assert_eq!(sent.id, tee.id);
        assert_eq!(tee.content.as_deref(), Some("hello"));
        assert_eq!(tee.relay_ts, 999);
        assert_eq!(tee.sender_contact_id.as_deref(), Some("self"));
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
    fn friend_payload_round_trips_through_parse() {
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD;
        let sealing = b64.encode([4u8; 32]);
        let bytes = friend_payload("Me#0009", "my-deliv", &sealing, Some("Jarrod"));
        // What I seal as a confirm is exactly what a recipient's parse expects.
        let opened = Opened {
            kind: KIND_FRIEND_CONFIRM.into(),
            payload: bytes,
            sender_identity_pub: b64.encode([5u8; 32]),
            sent_at: 0,
        };
        let f = FriendAcceptData::parse(&opened, false).expect("parse");
        assert_eq!(f.handle, "Me#0009");
        assert_eq!(f.display_name.as_deref(), Some("Jarrod")); // display name round-trips
        assert_eq!(f.delivery_token, "my-deliv");
        assert_eq!(f.sealing_pub, vec![4u8; 32]);
        assert!(!f.reciprocate);
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
    fn delete_carries_target_and_verified_editor() {
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD;
        let payload = serde_json::to_vec(&serde_json::json!({ "id": "m7" })).unwrap();
        let opened = Opened {
            kind: KIND_DELETE.into(),
            payload,
            sender_identity_pub: b64.encode([3u8; 32]),
            sent_at: 0,
        };
        match disposition(Ok(opened), 1) {
            Disposition::Delete(d) => {
                assert_eq!(d.target_id, "m7");
                assert_eq!(d.editor_id, b64.encode([3u8; 32])); // verified sender
            }
            _ => panic!("expected Delete"),
        }
        // Garbage delete payload → discard.
        let bad = Opened {
            kind: KIND_DELETE.into(),
            payload: b"nope".to_vec(),
            sender_identity_pub: "x".into(),
            sent_at: 0,
        };
        assert!(matches!(disposition(Ok(bad), 1), Disposition::Discard));
    }

    #[test]
    fn edit_carries_target_content_and_verified_editor() {
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD;
        let payload =
            serde_json::to_vec(&serde_json::json!({ "id": "m7", "content": "fixed", "editedAt": 42 }))
                .unwrap();
        let opened = Opened {
            kind: KIND_EDIT.into(),
            payload,
            sender_identity_pub: b64.encode([3u8; 32]),
            sent_at: 0,
        };
        match disposition(Ok(opened), 1) {
            Disposition::Edit(e) => {
                assert_eq!(e.target_id, "m7");
                assert_eq!(e.content, "fixed");
                assert_eq!(e.edited_at, 42);
                assert_eq!(e.editor_id, b64.encode([3u8; 32]));
            }
            _ => panic!("expected Edit"),
        }
        // Missing content → discard.
        let bad = Opened {
            kind: KIND_EDIT.into(),
            payload: serde_json::to_vec(&serde_json::json!({ "id": "m7" })).unwrap(),
            sender_identity_pub: "x".into(),
            sent_at: 0,
        };
        assert!(matches!(disposition(Ok(bad), 1), Disposition::Discard));
    }

    #[test]
    fn react_carries_target_emoji_op_and_verified_reactor() {
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD;
        let mk = |op: &str| {
            let payload =
                serde_json::to_vec(&serde_json::json!({ "id": "m7", "emoji": "👍", "op": op })).unwrap();
            Opened {
                kind: KIND_REACT.into(),
                payload,
                sender_identity_pub: b64.encode([9u8; 32]),
                sent_at: 0,
            }
        };
        match disposition(Ok(mk("add")), 1) {
            Disposition::React(r) => {
                assert_eq!(r.target_id, "m7");
                assert_eq!(r.emoji, "👍");
                assert!(r.add);
                assert_eq!(r.reactor_id, b64.encode([9u8; 32]));
            }
            _ => panic!("expected React"),
        }
        assert!(matches!(disposition(Ok(mk("remove")), 1), Disposition::React(r) if !r.add));
        // Unknown op → discard.
        assert!(matches!(disposition(Ok(mk("nope")), 1), Disposition::Discard));
    }

    #[test]
    fn group_record_add_member_appends_and_bumps_version() {
        let rec = serde_json::json!({
            "groupId": "g1", "version": 3,
            "members": [{ "identityPubKey": "OWNER", "role": "owner" }],
        })
        .to_string();
        let out = group_record_add_member(&rec, "g1", "OWNER", "NEWB").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["version"], 4);
        let members = v["members"].as_array().unwrap();
        assert_eq!(members.len(), 2);
        assert!(members.iter().any(|m| m["identityPubKey"] == "NEWB" && m["role"] == "member"));

        // Re-adding an existing member doesn't duplicate but still bumps version.
        let again = group_record_add_member(&out, "g1", "OWNER", "NEWB").unwrap();
        let v2: serde_json::Value = serde_json::from_str(&again).unwrap();
        assert_eq!(v2["version"], 5);
        assert_eq!(v2["members"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn a_relay_supplied_group_record_is_not_signed_blindly() {
        // The record comes from the relay and the caller signs whatever comes
        // back, so the two things a signature over it would concede are checked.
        let rec = serde_json::json!({
            "groupId": "g1", "version": 3,
            "members": [
                { "identityPubKey": "OWNER", "role": "owner" },
                { "identityPubKey": "PLAIN", "role": "member" },
            ],
        })
        .to_string();

        // Some *other* group's record — signing it would hand the relay my
        // signature over an authority document I never asked to see.
        assert_eq!(
            group_record_add_member(&rec, "g2", "OWNER", "NEWB"),
            Err(MessageError::UntrustedRecord("record is for a different group"))
        );

        // A record that does not name me an admin: I have no standing to re-sign
        // it (and the relay would reject the PUT anyway).
        assert_eq!(
            group_record_add_member(&rec, "g1", "PLAIN", "NEWB"),
            Err(MessageError::UntrustedRecord("this record does not name you an admin"))
        );
        assert_eq!(
            group_record_add_member(&rec, "g1", "STRANGER", "NEWB"),
            Err(MessageError::UntrustedRecord("this record does not name you an admin"))
        );

        // An admin (not just the owner) may add.
        let rec = serde_json::json!({
            "groupId": "g1", "version": 3,
            "members": [
                { "identityPubKey": "OWNER", "role": "owner" },
                { "identityPubKey": "ADMIN", "role": "admin" },
            ],
        })
        .to_string();
        assert!(group_record_add_member(&rec, "g1", "ADMIN", "NEWB").is_ok());
    }

    #[test]
    fn group_invite_carries_the_group_key_and_the_verified_inviter() {
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD;
        // A payload that also *claims* an inviter: the claim must be ignored in
        // favour of the signed envelope sender, or the authorization check the
        // drain does on `inviter_id` would be attacker-chosen.
        let payload = serde_json::to_vec(&serde_json::json!({
            "groupId": "grp:abc", "groupKey": b64.encode([4u8; 32]), "name": "Team",
            "inviterId": b64.encode([7u8; 32]),
        }))
        .unwrap();
        let opened = Opened {
            kind: KIND_GROUP_INVITE.into(),
            payload,
            sender_identity_pub: b64.encode([1u8; 32]),
            sent_at: 0,
        };
        match disposition(Ok(opened), 1) {
            Disposition::GroupInvite(g) => {
                assert_eq!(g.group_id, "grp:abc");
                assert_eq!(g.group_key, vec![4u8; 32]);
                assert_eq!(g.name.as_deref(), Some("Team"));
                assert_eq!(g.inviter_id, b64.encode([1u8; 32]));
            }
            _ => panic!("expected GroupInvite"),
        }
        // Wrong-length key → discard.
        let bad = serde_json::to_vec(&serde_json::json!({
            "groupId": "g", "groupKey": b64.encode([1u8; 10]),
        }))
        .unwrap();
        let opened = Opened { kind: KIND_GROUP_INVITE.into(), payload: bad, sender_identity_pub: "x".into(), sent_at: 0 };
        assert!(matches!(disposition(Ok(opened), 1), Disposition::Discard));
    }

    #[test]
    fn call_offer_rings_with_the_verified_caller_and_call_id() {
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD;
        let caller = b64.encode([9u8; 32]);
        let media_key = b64.encode([5u8; 32]);
        let payload =
            serde_json::to_vec(&serde_json::json!({ "callId": "call-abc123", "mediaKey": media_key })).unwrap();
        let opened = Opened {
            kind: KIND_CALL_OFFER.into(),
            payload,
            sender_identity_pub: caller.clone(),
            sent_at: 0,
        };
        match disposition(Ok(opened), 42) {
            Disposition::CallOffer(c) => {
                assert_eq!(c.call_id, "call-abc123");
                // The caller is the verified envelope sender, never a payload claim.
                assert_eq!(c.caller_id, caller);
                assert_eq!(c.media_key, media_key); // frame key rides the sealed offer
            }
            _ => panic!("expected CallOffer"),
        }

        // An empty call id is unusable (can't join a room) → discard, not buffer.
        let empty = serde_json::to_vec(&serde_json::json!({ "callId": "", "mediaKey": media_key })).unwrap();
        let opened = Opened { kind: KIND_CALL_OFFER.into(), payload: empty, sender_identity_pub: caller.clone(), sent_at: 0 };
        assert!(matches!(disposition(Ok(opened), 1), Disposition::Discard));

        // A missing / wrong-length media key is unusable for E2EE → discard.
        let nokey = serde_json::to_vec(&serde_json::json!({ "callId": "call-x" })).unwrap();
        let opened = Opened { kind: KIND_CALL_OFFER.into(), payload: nokey, sender_identity_pub: caller.clone(), sent_at: 0 };
        assert!(matches!(disposition(Ok(opened), 1), Disposition::Discard));
        let shortkey =
            serde_json::to_vec(&serde_json::json!({ "callId": "call-x", "mediaKey": b64.encode([1u8; 10]) })).unwrap();
        let opened = Opened { kind: KIND_CALL_OFFER.into(), payload: shortkey, sender_identity_pub: caller.clone(), sent_at: 0 };
        assert!(matches!(disposition(Ok(opened), 1), Disposition::Discard));

        // Garbage payload → discard (authenticated but unusable).
        let opened = Opened { kind: KIND_CALL_OFFER.into(), payload: b"not json".to_vec(), sender_identity_pub: caller, sent_at: 0 };
        assert!(matches!(disposition(Ok(opened), 1), Disposition::Discard));
    }

    #[test]
    fn kt_gossip_carries_the_signed_root_from_the_verified_sender() {
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD;
        let gossiper = b64.encode([4u8; 32]);
        let payload = serde_json::to_vec(&serde_json::json!({
            "epoch": 42, "root": "ROOT", "prev": "PREV", "sig": "SIG",
        }))
        .unwrap();
        let opened = Opened { kind: KIND_KT_GOSSIP.into(), payload, sender_identity_pub: gossiper.clone(), sent_at: 0 };
        match disposition(Ok(opened), 1) {
            Disposition::KtGossip(g) => {
                assert_eq!((g.epoch, g.root.as_str(), g.prev.as_str(), g.sig.as_str()), (42, "ROOT", "PREV", "SIG"));
                assert_eq!(g.gossiper, gossiper); // the verified sender, not a payload claim
            }
            _ => panic!("expected KtGossip"),
        }

        // Missing root or sig is unusable → discard (prev defaults to empty).
        let no_sig = serde_json::to_vec(&serde_json::json!({ "epoch": 1, "root": "R", "sig": "" })).unwrap();
        let opened = Opened { kind: KIND_KT_GOSSIP.into(), payload: no_sig, sender_identity_pub: gossiper, sent_at: 0 };
        assert!(matches!(disposition(Ok(opened), 1), Disposition::Discard));
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
