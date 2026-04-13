import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import api from '../api/client.js';

export const useAuthStore = defineStore('auth', () => {
  const token = ref(localStorage.getItem('cidrella_token') || null);
  const user = ref(null);

  const isAuthenticated = computed(() => !!token.value);
  const mustChangePassword = computed(() => user.value?.must_change_password ?? false);
  // Set if the current password was installed via a CLI reset rather than a
  // normal first-time login. The string is the actor label recorded by
  // reset-password.js, e.g. "cli:root@cidrella-prod". Cleared after a
  // successful /auth/change-password.
  const passwordResetBy = computed(() => user.value?.password_reset_by || null);
  const preferences = computed(() => user.value?.preferences || {});
  const timeFormat = computed(() => preferences.value.time_format || 'locale');

  async function login(username, password) {
    const res = await api.post('/auth/login', { username, password });
    token.value = res.data.token;
    user.value = res.data.user;
    localStorage.setItem('cidrella_token', res.data.token);
    return res.data;
  }

  async function changePassword(currentPassword, newPassword) {
    const res = await api.post('/auth/change-password', {
      current_password: currentPassword,
      new_password: newPassword
    });
    token.value = res.data.token;
    user.value = res.data.user;
    localStorage.setItem('cidrella_token', res.data.token);
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

  async function updatePreferences(prefs) {
    const res = await api.put('/auth/preferences', prefs);
    if (user.value) {
      user.value = { ...user.value, preferences: res.data };
    }
    return res.data;
  }

  function logout() {
    token.value = null;
    user.value = null;
    localStorage.removeItem('cidrella_token');
  }

  return { token, user, isAuthenticated, mustChangePassword, passwordResetBy, preferences, timeFormat, login, changePassword, fetchUser, updatePreferences, logout };
});
