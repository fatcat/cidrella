import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import api from '../api/client.js';

export const useAuthStore = defineStore('auth', () => {
  const token = ref(localStorage.getItem('ipam_token') || null);
  const user = ref(null);

  const isAuthenticated = computed(() => !!token.value);
  const mustChangePassword = computed(() => user.value?.must_change_password ?? false);

  async function login(username, password) {
    const res = await api.post('/auth/login', { username, password });
    token.value = res.data.token;
    user.value = res.data.user;
    localStorage.setItem('ipam_token', res.data.token);
    return res.data;
  }

  async function changePassword(currentPassword, newPassword) {
    const res = await api.post('/auth/change-password', {
      current_password: currentPassword,
      new_password: newPassword
    });
    token.value = res.data.token;
    user.value = res.data.user;
    localStorage.setItem('ipam_token', res.data.token);
    return res.data;
  }

  async function fetchUser() {
    try {
      const res = await api.get('/auth/me');
      user.value = res.data;
    } catch {
      logout();
    }
  }

  function logout() {
    token.value = null;
    user.value = null;
    localStorage.removeItem('ipam_token');
  }

  return { token, user, isAuthenticated, mustChangePassword, login, changePassword, fetchUser, logout };
});
