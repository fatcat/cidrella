import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import { rememberView } from '../utils/landing.js';

import Login from '../views/Login.vue';
import ChangePassword from '../views/ChangePassword.vue';
import NotFound from '../views/NotFound.vue';
import AppLayout from '../components/AppLayout.vue';

const routes = [
  ...(import.meta.env.DEV ? [
    {
      path: '/dev/theme-lab',
      name: 'ThemeLab',
      component: () => import('../views/ThemeLab.vue'),
      meta: { public: true }
    }
  ] : []),
  {
    path: '/login',
    name: 'Login',
    component: Login,
    meta: { public: true }
  },
  {
    path: '/change-password',
    name: 'ChangePassword',
    component: ChangePassword
  },
  {
    path: '/',
    component: AppLayout,
    children: [
      { path: '', redirect: '/analytics' },
      { path: 'analytics', name: 'Analytics', component: () => import('../views/Analytics.vue') },
      { path: 'networks', name: 'Networks', component: () => import('../views/SubnetsLayoutB.vue') },
      { path: 'networks-preview', name: 'NetworksWorkspacePreview', component: () => import('../views/NetworksWorkspacePreview.vue') },
      { path: 'anomalies-preview', name: 'AnomaliesWorkspacePreview', component: () => import('../views/AnomaliesWorkspacePreview.vue') },
      { path: 'system', name: 'System', component: () => import('../views/Settings.vue') },
      // Redirects for old bookmarks
      { path: 'dashboard', redirect: '/analytics' },
      { path: 'anomalies', redirect: '/analytics' },
      { path: 'subnets', redirect: '/networks' },
      { path: 'dns', redirect: { path: '/system', query: { area: 'dns' } } },
      { path: 'dhcp', redirect: { path: '/system', query: { area: 'dhcp' } } },
      { path: 'blocklists', redirect: { path: '/system', query: { area: 'filtering' } } },
      { path: 'geoip', redirect: { path: '/system', query: { area: 'filtering', sec: 'geoip' } } },
      { path: 'range-types', redirect: { path: '/system', query: { area: 'general' } } },
      { path: 'settings-preview', redirect: '/system' }
    ]
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'NotFound',
    component: NotFound
  }
];

const router = createRouter({
  history: createWebHistory(),
  routes
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();

  // Allow public routes (login page)
  if (to.meta.public) {
    return true;
  }

  // Redirect unauthenticated users to login, carrying where they were headed
  // so the login form can finish the trip.
  //
  // '/' is excluded, and so is anything the router redirected there from: by
  // the time this guard runs, '/' has already become '/analytics' via its
  // redirect route, and passing that on would look like the user asked for
  // analytics and would outrank the page they were actually last on. Someone
  // who types '/analytics' themselves still gets it, because then there is no
  // redirectedFrom.
  if (!auth.isAuthenticated) {
    const wantsDefault = to.fullPath === '/' || to.redirectedFrom?.fullPath === '/';
    return wantsDefault
      ? { name: 'Login' }
      : { name: 'Login', query: { redirect: to.fullPath } };
  }

  // Fetch user info if not loaded
  if (!auth.user) {
    await auth.fetchUser();
    if (!auth.isAuthenticated) {
      return { name: 'Login' };
    }
  }

  // Force password change
  if (auth.mustChangePassword && to.name !== 'ChangePassword') {
    return { name: 'ChangePassword' };
  }

  return true;
});

// Track the last real page each user visited. A session that expires mid-task
// then sends them back where they were rather than to the default view.
router.afterEach((to) => {
  const auth = useAuthStore();
  if (!auth.isAuthenticated) return;
  rememberView(auth.user?.username, to);
});

export default router;
