import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';

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

  // Redirect unauthenticated users to login
  if (!auth.isAuthenticated) {
    return { name: 'Login' };
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

export default router;
