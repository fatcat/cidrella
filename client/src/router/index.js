import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';

import Login from '../views/Login.vue';
import ChangePassword from '../views/ChangePassword.vue';
import SetupWizard from '../views/SetupWizard.vue';
import NotFound from '../views/NotFound.vue';
import AppLayout from '../components/AppLayout.vue';

const routes = [
  {
    path: '/setup',
    name: 'Setup',
    component: SetupWizard,
    meta: { public: true }
  },
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
      { path: '', redirect: '/dashboard' },
      { path: 'dashboard', name: 'Dashboard', component: () => import('../views/Dashboard.vue') },
      { path: 'networks', name: 'Networks', component: () => import('../views/SubnetsLayoutB.vue') },
      { path: 'system', name: 'System', component: () => import('../views/System.vue') },
      // Redirects for old bookmarks
      { path: 'subnets', redirect: '/networks' },
      { path: 'dns', redirect: '/' },
      { path: 'dhcp', redirect: '/' },
      { path: 'blocklists', redirect: '/system' },
      { path: 'geoip', redirect: '/system' },
      { path: 'range-types', redirect: '/system' }
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

  // Setup wizard disabled — always skip
  if (to.name === 'Setup') {
    return { name: 'Login' };
  }

  // Allow public routes (login page)
  if (to.meta.public && to.name !== 'Setup') {
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
