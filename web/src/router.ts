import { createRouter, createWebHistory } from 'vue-router';
import { useSessionStore } from './stores/session';
import { chatPane } from './lib/mobileNav';

// The last in-app view, restored on a cold start so the app reopens where you
// left off (the PWA/start URL is always '/').
const LAST_ROUTE_KEY = 'last-route';
let restoredInitial = false;

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: () => import('./pages/NotesPage.vue') },
    { path: '/chat/:id/:channelId?', component: () => import('./pages/ConversationPage.vue') },
    { path: '/friends', component: () => import('./pages/FriendsPage.vue') },
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
  // An already-signed-in user following an invite link (e.g. an autofilled
  // original invite) belongs in the app, not the invited-user signup flow.
  if (to.path.startsWith('/invite/') && session.loggedIn) return '/';
  // First navigation of this app load: a PWA cold start lands on '/' and we
  // redirect to the last open view; a direct load or reload lands on the URL
  // itself. Either way, opening a chat means its messages (a full-screen leaf
  // on mobile), not the channel list — otherwise reloading a chat would drop
  // you on the sidebar.
  if (!restoredInitial) {
    restoredInitial = true;
    if (session.loggedIn) {
      if (to.path === '/') {
        const last = localStorage.getItem(LAST_ROUTE_KEY);
        if (last && last !== to.fullPath) {
          if (last.startsWith('/chat/')) chatPane.value = 'messages';
          return last;
        }
      } else if (to.path.startsWith('/chat/')) {
        chatPane.value = 'messages';
      }
    }
  }
  return true;
});

router.afterEach((to) => {
  if (!to.meta.public) localStorage.setItem(LAST_ROUTE_KEY, to.fullPath);
});
