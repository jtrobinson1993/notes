<script setup lang="ts">
// The app chrome: the side rail plus the routed page. Lock/unlock is owned
// entirely by the vault gate (NativeGate), which only renders its slot — and so
// this layout — once the vault is unlocked. There is therefore no in-layout lock
// wall or "logged in" concept left here.
import AppSidebar from './AppSidebar.vue';
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <div class="flex min-h-0 grow">
      <AppSidebar />
      <main class="relative min-h-0 min-w-0 grow overflow-y-auto">
        <slot />
      </main>
    </div>
  </div>
</template>
