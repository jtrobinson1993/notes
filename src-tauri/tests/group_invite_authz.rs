//! **L2 — who may hand me a group key.** (spec/chat.md § Groups; spec/testing.md § L2)
//!
//! A `group-invite` is an ordinary sealed-sender mailbox envelope: opening one
//! proves that *somebody* signed it, nothing more. It used to be applied
//! unconditionally — no sender check at all (the sender was thrown away before
//! the drain ever saw it) and an `ON CONFLICT DO UPDATE SET group_key` behind
//! it. That is a complete E2EE break for groups: anyone who can enqueue into a
//! mailbox — the relay, for any group id it hosts, or any current member —
//! could replace the key of a group I was already in, and every message I sent
//! afterwards would be sealed under *their* key.
//!
//! These cases drive the real `mailbox_drain` against the shared hostile-capable
//! relay harness and pin the three rules that replaced it:
//!   * an invite from a **non-friend** is refused and persists nothing;
//!   * an invite from a **verified friend** for a **new** group is accepted;
//!   * an invite for a group I am **already in never changes its key** — not
//!     from a stranger, and not from the friend who runs the group — and the
//!     attempt raises a hard alarm;
//!   * an identical re-invite (the admin re-adds a member) is a silent no-op;
//!   * a friend whose key the **transparency log contradicts** is refused.

mod common;

use base64::Engine as _;
use ed25519_dalek::SigningKey;

use app_lib::{envelope, identity, message};
use common::{
    bob_identity, friend_accept, mailbox_row, publish, signed_root, Alarms, Core, Directory404,
    FakeRelay, B64, BOB_HANDLE,
};

/// A group this core is already in before any invite arrives.
const SEEDED_GROUP: &str = "grp:already-mine";
const SEEDED_KEY: [u8; 32] = [1u8; 32];

/// A DM-sealed `group-invite`, byte-identical in shape to what `group_add_member`
/// sends — the point being that its *shape* was never the problem.
fn group_invite(
    sender: &identity::RelayIdentity,
    recipient_sealing: [u8; 32],
    group_id: &str,
    group_key: &[u8; 32],
    name: &str,
) -> Vec<u8> {
    let payload = serde_json::json!({
        "groupId": group_id, "groupKey": B64.encode(group_key), "name": name,
    })
    .to_string();
    envelope::seal(
        &recipient_sealing,
        sender,
        message::KIND_GROUP_INVITE,
        payload.as_bytes(),
        common::now_ms(),
    )
    .unwrap()
}

/// A relay, a connected core, and **Bob as a log-verified friend** — the state
/// every case starts from, so "refused" is never just "this core has no
/// friends". Returns the relay, the core, its signing key, and Bob.
async fn scene() -> (FakeRelay, Core, SigningKey, identity::RelayIdentity) {
    let relay_key = SigningKey::from_bytes(&[42u8; 32]);
    let relay = FakeRelay::bare(relay_key.clone());
    let core = Core::connect(&relay.base).await;
    let fp = core.relay_fp();
    let bob = bob_identity(&fp, 9);

    // The log publishes Bob's real key under a root the relay signed.
    let (root, epoch, proof_json, vrf) = publish(BOB_HANDLE, &bob.signing_public()).await;
    relay.with(|st| {
        st.directory = Directory404::Entry {
            identity_pub_b64: B64.encode(bob.signing_public()),
            epoch,
            root: root.clone(),
            proof_json,
            vrf,
        };
        st.roots = vec![signed_root(&relay_key, 17, &root)];
        st.mailbox = vec![mailbox_row(1, &friend_accept(&bob, core.sealing_pub(), BOB_HANDLE))];
    });

    let alarms = Alarms::default();
    let report = app_lib::mailbox_drain(&core.vault, &core.relay, &alarms.sink()).await.unwrap();
    assert_eq!(report.friends, 1, "the scene needs Bob recorded as a friend");
    assert_eq!(core.friends()[0].kt_verified_epoch, Some(17), "…and log-verified");
    assert!(alarms.seen().is_empty());
    // Forget the handshake traffic so each case asserts on its own.
    relay.with(|st| {
        st.sends.clear();
        st.acked.clear();
        st.mailbox.clear();
    });
    (relay, core, relay_key, bob)
}

/// Does this core hold a local conversation row for `id`?
fn has_conversation(core: &Core, id: &str) -> bool {
    core.with_store(|s| {
        s.conversation_activity()
            .unwrap()
            .iter()
            .any(|c| c.conversation_id == id)
    })
}

#[tokio::test]
async fn a_group_invite_from_a_non_friend_is_refused_and_persists_nothing() {
    let (relay, core, _k, _bob) = scene().await;
    // Mallory holds no friendship with this account. She does hold my delivery
    // token in this scenario (a hostile relay needs no token at all — it owns
    // the queue), so nothing but the sender check stands between her and a
    // group I would then treat as real.
    let mallory = bob_identity(&core.relay_fp(), 200);
    let env = group_invite(&mallory, core.sealing_pub(), "grp:mallorys", &[7u8; 32], "Free Nitro");
    relay.with(|st| st.mailbox = vec![mailbox_row(2, &env)]);
    let alarms = Alarms::default();

    let report = app_lib::mailbox_drain(&core.vault, &core.relay, &alarms.sink()).await.unwrap();

    assert_eq!(report.groups_joined, 0);
    assert_eq!(report.group_invites_rejected, 1);
    // Nothing persisted: no key, no group row, no conversation.
    assert_eq!(core.group_key("grp:mallorys"), None);
    assert!(core.with_store(|s| s.list_groups().unwrap()).is_empty());
    assert!(!has_conversation(&core, "grp:mallorys"));
    // A stranger's invite is refused, not alarmed — it is not evidence about
    // any key the log published, and alarming on it would let anyone with
    // mailbox reach spam a non-dismissable banner.
    assert!(alarms.seen().is_empty());
    // Still acked: it is permanently unusable, and re-draining only re-refuses.
    assert_eq!(relay.with(|st| st.acked.clone()), vec![2]);
}

#[tokio::test]
async fn a_group_invite_from_a_verified_friend_creates_the_group() {
    let (relay, core, _k, bob) = scene().await;
    let key = [5u8; 32];
    let env = group_invite(&bob, core.sealing_pub(), "grp:bobs", &key, "Bob's Group");
    relay.with(|st| st.mailbox = vec![mailbox_row(2, &env)]);
    let alarms = Alarms::default();

    let report = app_lib::mailbox_drain(&core.vault, &core.relay, &alarms.sink()).await.unwrap();

    assert_eq!(report.groups_joined, 1);
    assert_eq!(report.group_invites_rejected, 0);
    assert_eq!(core.group_key("grp:bobs"), Some(key.to_vec()));
    let groups = core.with_store(|s| s.list_groups().unwrap());
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].name.as_deref(), Some("Bob's Group"));
    // The conversation row is what makes the group openable in the UI.
    assert!(has_conversation(&core, "grp:bobs"));
    assert!(alarms.seen().is_empty());
}

#[tokio::test]
async fn an_invite_for_a_group_i_am_already_in_never_changes_its_key() {
    let (relay, core, _k, bob) = scene().await;
    core.with_store(|s| {
        assert!(s.insert_group(SEEDED_GROUP, &SEEDED_KEY, Some("Ours")).unwrap());
    });

    // (a) A fresh identity nobody here has ever met — the relay's own move, since
    // it holds group state and can enqueue whatever it likes into my mailbox.
    let stranger = bob_identity(&core.relay_fp(), 123);
    let env = group_invite(&stranger, core.sealing_pub(), SEEDED_GROUP, &[9u8; 32], "Ours");
    relay.with(|st| st.mailbox = vec![mailbox_row(2, &env)]);
    let alarms = Alarms::default();

    let report = app_lib::mailbox_drain(&core.vault, &core.relay, &alarms.sink()).await.unwrap();

    assert_eq!(report.group_invites_rejected, 1);
    assert_eq!(report.groups_joined, 0);
    assert_eq!(core.group_key(SEEDED_GROUP), Some(SEEDED_KEY.to_vec()));
    assert_eq!(alarms.seen(), vec!["group-rekey-refused".to_string()]);

    // (b) The sharper half: a **current, log-verified friend** — exactly the
    // person a legitimate invite comes from — cannot re-key it either. Membership
    // is not authority to rotate; only a signed group-state record could be, and
    // no rotation flow exists.
    let env = group_invite(&bob, core.sealing_pub(), SEEDED_GROUP, &[9u8; 32], "Ours");
    relay.with(|st| st.mailbox = vec![mailbox_row(3, &env)]);
    let alarms = Alarms::default();

    let report = app_lib::mailbox_drain(&core.vault, &core.relay, &alarms.sink()).await.unwrap();

    assert_eq!(report.group_invites_rejected, 1);
    assert_eq!(report.groups_joined, 0);
    assert_eq!(core.group_key(SEEDED_GROUP), Some(SEEDED_KEY.to_vec()));
    assert_eq!(alarms.seen(), vec!["group-rekey-refused".to_string()]);
    // The name is untouched too — there is no rename flow to legitimise it.
    let groups = core.with_store(|s| s.list_groups().unwrap());
    assert_eq!(groups[0].name.as_deref(), Some("Ours"));
}

#[tokio::test]
async fn an_identical_re_invite_is_a_silent_no_op() {
    let (relay, core, _k, bob) = scene().await;
    let key = [5u8; 32];
    let env = group_invite(&bob, core.sealing_pub(), "grp:bobs", &key, "Bob's Group");

    relay.with(|st| st.mailbox = vec![mailbox_row(2, &env)]);
    let alarms = Alarms::default();
    let first = app_lib::mailbox_drain(&core.vault, &core.relay, &alarms.sink()).await.unwrap();
    assert_eq!(first.groups_joined, 1);

    // `group_add_member` is idempotent on the record and re-sends the same key,
    // so a duplicate invite is ordinary traffic: no join, no refusal, no alarm.
    relay.with(|st| st.mailbox = vec![mailbox_row(3, &env)]);
    let second = app_lib::mailbox_drain(&core.vault, &core.relay, &alarms.sink()).await.unwrap();

    assert_eq!(second.groups_joined, 0);
    assert_eq!(second.group_invites_rejected, 0);
    assert_eq!(core.group_key("grp:bobs"), Some(key.to_vec()));
    assert!(alarms.seen().is_empty());
    assert_eq!(relay.with(|st| st.acked.clone()), vec![2, 3]);
}

#[tokio::test]
async fn two_conflicting_invites_for_one_new_group_in_a_single_batch() {
    // The "already a member?" check happens before the drain writes anything, so
    // two invites for the same *new* id in one fetch both pass it. The first
    // wins on INSERT; the second must not overwrite it, and — since it carries a
    // different key — the race was itself a takeover attempt, so it alarms.
    let (relay, core, _k, bob) = scene().await;
    let first = [5u8; 32];
    relay.with(|st| {
        st.mailbox = vec![
            mailbox_row(2, &group_invite(&bob, core.sealing_pub(), "grp:race", &first, "Real")),
            mailbox_row(3, &group_invite(&bob, core.sealing_pub(), "grp:race", &[6u8; 32], "Real")),
        ]
    });
    let alarms = Alarms::default();

    let report = app_lib::mailbox_drain(&core.vault, &core.relay, &alarms.sink()).await.unwrap();

    assert_eq!(report.groups_joined, 1);
    assert_eq!(report.group_invites_rejected, 1);
    assert_eq!(core.group_key("grp:race"), Some(first.to_vec()));
    assert_eq!(alarms.seen(), vec!["group-rekey-refused".to_string()]);
}

#[tokio::test]
async fn a_group_invite_from_a_friend_the_log_contradicts_is_refused() {
    let (relay, core, relay_key, bob) = scene().await;
    // The relay now publishes a different key for Bob's handle, under a root it
    // genuinely signed: either Bob re-keyed or the relay is substituting him.
    // The core cannot tell, so it refuses to take a group key on that basis.
    let (root, epoch, proof_json, vrf) = publish(BOB_HANDLE, &[8u8; 32]).await;
    relay.with(|st| {
        st.directory = Directory404::Entry {
            identity_pub_b64: B64.encode([8u8; 32]),
            epoch,
            root: root.clone(),
            proof_json,
            vrf,
        };
        st.roots = vec![signed_root(&relay_key, 18, &root)];
        st.mailbox = vec![mailbox_row(
            2,
            &group_invite(&bob, core.sealing_pub(), "grp:bobs", &[5u8; 32], "Bob's Group"),
        )];
    });
    let alarms = Alarms::default();

    let report = app_lib::mailbox_drain(&core.vault, &core.relay, &alarms.sink()).await.unwrap();

    assert_eq!(report.groups_joined, 0);
    assert_eq!(report.group_invites_rejected, 1);
    assert_eq!(core.group_key("grp:bobs"), None);
    assert!(!has_conversation(&core, "grp:bobs"));
    assert_eq!(alarms.seen(), vec!["contact-key-mismatch".to_string()]);
}
