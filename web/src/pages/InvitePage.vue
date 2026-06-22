<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../lib/api';
import RegisterFlow from '../components/RegisterFlow.vue';

const route = useRoute();
const router = useRouter();
const token = route.params.token as string;

// Gate the signup flow on the invite still being usable. An already-redeemed or
// expired link (e.g. an autofilled original invite for someone who already has an
// account) must not re-show the invited-user flow — send them to login instead.
const checking = ref(true);
const valid = ref(false);

api
  .inviteStatus(token)
  .then((r) => {
    valid.value = r.valid;
    if (!r.valid) router.replace('/login');
  })
  .catch(() => router.replace('/login'))
  .finally(() => {
    checking.value = false;
  });
</script>

<template>
  <div v-if="checking" class="flex min-h-full items-center justify-center p-6 text-sm text-zinc-400">
    Checking invite…
  </div>
  <RegisterFlow
    v-else-if="valid"
    :invite-token="token"
    title="You're invited"
    subtitle="Create your account to start taking notes."
  />
</template>
