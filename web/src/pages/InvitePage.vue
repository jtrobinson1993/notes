<script setup lang="ts">
import { useRoute } from 'vue-router';
import RegisterFlow from '../components/RegisterFlow.vue';

const route = useRoute();
const token = route.params.token as string;
</script>

<template>
  <RegisterFlow
    :invite-token="token"
    title="You're invited"
    subtitle="Create your account to start taking notes."
  />
</template>
