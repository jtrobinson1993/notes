<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../lib/api';
import { enablePush, isPushSupported, shouldOfferPush, NOTIF_OPTIN_SEEN_KEY } from '../lib/push';
import IconBell from '~icons/mynaui/bell';
import IconX from '~icons/mynaui/x';

/**
 * First-open notification opt-in. Asks once per device whether to turn on
 * background message notifications, then records the choice in localStorage
 * (`NOTIF_OPTIN_SEEN_KEY`) so it never pops up again — whichever option is
 * picked. The OS permission request fires from the Enable button (a user
 * gesture, as browsers require). Mounted only while signed in (see App.vue); the
 * Settings toggle remains the way to change this later.
 */
const show = ref(false);

onMounted(async () => {
  if (typeof window === 'undefined' || !isPushSupported()) return;
  if (localStorage.getItem(NOTIF_OPTIN_SEEN_KEY)) return; // already asked here
  if (Notification.permission !== 'default') return; // already decided at the OS level
  // Only ask if the server can actually deliver pushes (VAPID configured).
  let hasServerKey = false;
  try {
    hasServerKey = !!(await api.pushKey()).publicKey;
  } catch {
    return;
  }
  show.value = shouldOfferPush({
    supported: true,
    permission: Notification.permission,
    hasServerKey,
    seen: false,
  });
});

/** Record that we've asked (so we never prompt again on this device). */
function markSeen() {
  try {
    localStorage.setItem(NOTIF_OPTIN_SEEN_KEY, '1');
  } catch {
    /* private mode / storage disabled — worst case we ask again next open */
  }
  show.value = false;
}

function dismiss() {
  markSeen();
}

function enable() {
  // Dismiss immediately, whichever option is chosen — then request OS permission
  // + subscribe in the background (the prompt shouldn't linger behind it).
  markSeen();
  void enablePush().catch(() => {
    /* server error / permission refused — the choice is already recorded */
  });
}
</script>

<template>
  <!-- Slide up from the bottom edge and settle with a slight overshoot bounce
       (the back-ease cubic-bezier overshoots past its resting point); slides
       back down on dismiss. -->
  <Transition
    enter-active-class="transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]"
    enter-from-class="translate-y-full"
    leave-active-class="transition-transform duration-150 ease-in"
    leave-to-class="translate-y-full"
  >
    <div
      v-if="show"
      class="app-safe fixed inset-x-0 bottom-0 z-tooltip flex justify-center px-3"
      role="dialog"
      aria-label="Enable notifications"
    >
      <div
        class="mb-4 flex w-full max-w-md items-start gap-3 rounded-xl border border-zinc-200 bg-white p-3 shadow-pop dark:border-zinc-700 dark:bg-zinc-800"
      >
        <span class="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-600/10 text-blue-600 dark:text-blue-400">
          <IconBell class="h-5 w-5" />
        </span>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold">Turn on notifications?</p>
          <p class="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
            Get notified of new messages when the app is closed. Notifications never
            include message content. You can change this anytime in Settings.
          </p>
          <div class="mt-2.5 flex items-center gap-2">
            <button
              type="button"
              class="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
              @click="enable"
            >
              Enable
            </button>
            <button
              type="button"
              class="rounded-lg px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-700"
              @click="dismiss"
            >
              Not now
            </button>
          </div>
        </div>
        <button
          type="button"
          class="-mr-1 -mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
          aria-label="Dismiss"
          @click="dismiss"
        >
          <IconX class="h-4 w-4" />
        </button>
      </div>
    </div>
  </Transition>
</template>
