<script setup lang="ts">
// Key-transparency HARD alarm banner (spec/key-transparency.md). Shown when the
// Rust core's self-audit detects the relay may be equivocating on identities
// (bound my handle to a key I never minted, or served inconsistent roots). It's
// deliberately prominent + non-dismissable: the user should re-verify contacts
// via SAS or disconnect the relay before trusting further messages.
import { onMounted, onUnmounted, ref } from 'vue';
import IconShield from '~icons/mynaui/shield-x';
import { onKtAlarm, startKtAudit, stopKtAudit, type KtAlarm } from '../lib/nativeKt';
import { isNative } from '../lib/native';

const alarm = ref<KtAlarm | null>(null);
let off: (() => void) | null = null;

const message = (reason: string): string => {
  if (reason === 'split-view') {
    return 'This relay served inconsistent key-transparency logs — it may be showing different data to different people.';
  }
  if (reason === 'relay-identity-changed') {
    return 'This relay’s own identity is not the one pinned for your account — Accord refused the connection. That identity is the anchor the key-transparency log hangs off, so a substituted one invalidates every key check.';
  }
  if (reason === 'relay-delegation-invalid') {
    return 'This relay could not show a valid, current record — signed by the identity you pinned — naming the key it signs its key-transparency log with. Accord refused the connection: without it, that log proves nothing.';
  }
  if (reason === 'relay-delegation-rollback') {
    return 'This relay presented an older record of its signing key than one already accepted on this device. That is how somebody holding a retired key gets trusted again, so Accord refused the connection and kept the newer one.';
  }
  if (reason === 'group-rekey-refused') {
    return 'Someone tried to replace the encryption key of a group you are already in. Accord refused and kept your existing key, so nothing you send is readable by them — but a group key can only be handed over once, so there is no innocent reason for this.';
  }
  if (reason === 'contact-key-mismatch') {
    return 'A contact’s encryption key is not the one this relay’s key-transparency log publishes for their handle. That contact was not added, and nothing was sent back to them.';
  }
  return 'This relay bound your handle to an identity key you never created.';
};

onMounted(() => {
  if (!isNative) return;
  off = onKtAlarm((a) => (alarm.value = a));
  void startKtAudit();
});
onUnmounted(() => {
  off?.();
  void stopKtAudit();
});
</script>

<template>
  <div
    v-if="alarm"
    data-testid="kt-alarm"
    role="alert"
    class="fixed inset-x-0 top-0 z-tooltip flex items-start gap-2 bg-red-700 px-4 py-3 text-sm text-white shadow-lg"
  >
    <IconShield class="mt-0.5 h-5 w-5 shrink-0" />
    <div>
      <p class="font-semibold">Key-transparency alarm</p>
      <p class="opacity-90">
        {{ message(alarm.reason) }} Re-verify your contacts’ safety numbers, or disconnect this relay.
      </p>
    </div>
  </div>
</template>
