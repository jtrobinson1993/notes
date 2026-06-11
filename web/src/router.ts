import { createRouter, createWebHistory } from 'vue-router';
import { useSessionStore } from './stores/session';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: () => import('./pages/NotesPage.vue') },
    { path: '/settings', component: () => import('./pages/SettingsPage.vue') },
    { path: '/setup', component: () => import('./pages/SetupPage.vue'), meta: { public: true } },
    { path: '/login', component: () => import('./pages/LoginPage.vue'), meta: { public: true } },
    { path: '/recover', component: () => import('./pages/RecoverPage.vue'), meta: { public: true } },
    { path: '/invite/:token', component: () => import('./pages/InvitePage.vue'), meta: { public: true } },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

router.beforeEach(async (to) => {
  const session = useSessionStore();
  await session.init();
  if (session.needsSetup && to.path !== '/setup') return '/setup';
  if (!session.needsSetup && to.path === '/setup') return '/';
  if (!to.meta.public && !session.loggedIn) return '/login';
  if ((to.path === '/login' || to.path === '/recover') && session.loggedIn) return '/';
  return true;
});
