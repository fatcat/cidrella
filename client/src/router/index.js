import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';

import Login from '../views/Login.vue';
import ChangePassword from '../views/ChangePassword.vue';
import Dashboard from '../views/Dashboard.vue';
import NotFound from '../views/NotFound.vue';
import AppLayout from '../components/AppLayout.vue';

const routes = [
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
      { path: '', name: 'Dashboard', component: Dashboard },
      { path: 'subnets', name: 'Subnets', component: () => import('../views/Subnets.vue') },
      { path: 'subnets/:id', name: 'SubnetDetail', component: () => import('../views/SubnetDetail.vue') },
      { path: 'range-types', redirect: '/system' },
      { path: 'dns', name: 'DNS', component: () => import('../views/DNS.vue') },
      { path: 'dhcp', name: 'DHCP', component: () => import('../views/DHCP.vue') },
      { path: 'blocklists', name: 'Blocklists', component: () => import('../views/Placeholder.vue'), meta: { label: 'Blocklists' } },
      { path: 'system', name: 'System', component: () => import('../views/System.vue') }
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

  // Allow public routes
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
