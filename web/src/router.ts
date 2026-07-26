import { createRouter, createWebHistory } from 'vue-router';
import { chatPane } from './lib/mobileNav';

// The last in-app view, restored on a cold start so the app reopens where you
// left off (the shell always boots at '/').
const LAST_ROUTE_KEY = 'last-route';
let restoredInitial = false;

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: () => import('./pages/NotesPage.vue') },
    { path: '/friends', component: () => import('./pages/FriendsPage.vue') },
    { path: '/dm', component: () => import('./pages/NativeChatPage.vue') },
    { path: '/settings', component: () => import('./pages/SettingsPage.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

// The vault gate (NativeGate) owns auth + onboarding, so there are no
// public/private routes and no session redirects — the only thing to do on the
// first navigation of an app load is restore the last open view.
router.beforeEach((to) => {
  if (restoredInitial) return true;
  restoredInitial = true;
  if (to.path === '/') {
    const last = localStorage.getItem(LAST_ROUTE_KEY);
    if (last && last !== to.fullPath) {
      if (last.startsWith('/dm')) chatPane.value = 'messages';
      return last;
    }
  } else if (to.path.startsWith('/dm')) {
    chatPane.value = 'messages';
  }
  return true;
});

router.afterEach((to) => {
  localStorage.setItem(LAST_ROUTE_KEY, to.fullPath);
});
