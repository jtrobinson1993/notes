// Emoji session lifecycle: what the app sets up when the vault opens, and what
// it must destroy when the vault locks.
//
// Nothing here is cosmetic. The emote registry holds blob: URLs minted from
// decrypted cache bytes, and the usage tally is behavioural metadata — both are
// master-key-derived state, so both die with the vault (App.vue).
import { clearEmotes, registerEmoteId, setEmoteRelayOrigin } from './index';
import { resetEmoteRender } from './render';
import { loadEmojiUsage, resetEmojiUsage } from './usage';
import { emoteCachedList, relayStatus } from '../native';

/**
 * Prepare emoji for an unlocked vault:
 *
 *  - pin the relay origin, the only remote origin an emote may be rendered
 *    from (`registerEmote` refuses everything else);
 *  - load the decayed usage tally out of the encrypted vault;
 *  - learn the ids of every emote already cached on this device, so a
 *    `:shortcode:` in content resolves straight to a cache read — no search,
 *    no fetch, works offline.
 *
 * Every step is best-effort: emoji must never be the reason an unlock fails.
 */
export async function initEmoji(): Promise<void> {
  try {
    const status = await relayStatus();
    setEmoteRelayOrigin(status.base_url);
  } catch {
    setEmoteRelayOrigin(null);
  }
  await loadEmojiUsage();
  try {
    for (const e of await emoteCachedList()) registerEmoteId(e.name, e.id);
  } catch {
    /* no vault / no cache yet — emotes just resolve the slow way */
  }
}

/** Drop every trace of the emoji session (lock, sign-out, account switch). */
export function teardownEmoji(): void {
  resetEmoteRender(); // revokes the blob: URLs holding decrypted emote bytes
  clearEmotes();
  resetEmojiUsage();
  setEmoteRelayOrigin(null);
}
