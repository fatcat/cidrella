import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import api from '../api/client.js';

export const useAuthStore = defineStore('auth', () => {
  const token = ref(localStorage.getItem('cidrella_token') || null);
  const user = ref(null);

  const isAuthenticated = computed(() => !!token.value);
  const mustChangePassword = computed(() => user.value?.must_change_password ?? false);
  // First-run setup still to do. Server-decided: admin role and the setup
  // state not done. The router sends such a user to the wizard.
  const setupRequired = computed(() => user.value?.setup_required === true);
  const permissions = computed(() => user.value?.permissions || []);
  const isAdmin = computed(() => user.value?.is_admin === true);
  // Set if the current password was installed via a CLI reset rather than a
  // normal first-time login. The string is the actor label recorded by
  // reset-password.js, e.g. "cli:root@cidrella-prod". Cleared after a
  // successful /auth/change-password.
  const passwordResetBy = computed(() => user.value?.password_reset_by || null);
  const preferences = computed(() => user.value?.preferences || {});
  const timeFormat = computed(() => preferences.value.time_format || 'locale');

  function acceptSession(data) {
    token.value = data.token;
    user.value = data.user;
    localStorage.setItem('cidrella_token', data.token);
    return data;
  }

  // With two-factor on, the password earns { totp_required, challenge } and
  // no session; loginTotp turns the challenge into one.
  async function login(username, password) {
    const res = await api.post('/auth/login', { username, password });
    if (res.data.totp_required) return res.data;
    return acceptSession(res.data);
  }

  async function loginTotp(challenge, code) {
    const res = await api.post('/auth/login/totp', { challenge, code });
    return acceptSession(res.data);
  }

  const totpEnabled = computed(() => user.value?.totp_enabled === true);

  async function totpSetup() {
    const res = await api.post('/auth/totp/setup');
    return res.data; // { secret, otpauth_url }
  }

  async function totpEnable(code) {
    const res = await api.post('/auth/totp/enable', { code });
    if (user.value) user.value = { ...user.value, totp_enabled: true };
    return res.data; // { backup_codes }
  }

  async function totpStatus() {
    const res = await api.get('/auth/totp');
    return res.data; // { enabled, backup_codes_remaining }
  }

  async function totpRegenerateBackupCodes(password) {
    const res = await api.post('/auth/totp/backup-codes', { password });
    return res.data; // { backup_codes }
  }

  async function totpDisable(password) {
    const res = await api.post('/auth/totp/disable', { password });
    if (user.value) user.value = { ...user.value, totp_enabled: false };
    return res.data;
  }

  async function changePassword(currentPassword, newPassword) {
    const res = await api.post('/auth/change-password', {
      current_password: currentPassword,
      new_password: newPassword,
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
      return res.data;
    } catch {
      logout();
      return null;
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

  return {
    token,
    user,
    isAuthenticated,
    mustChangePassword,
    setupRequired,
    permissions,
    isAdmin,
    passwordResetBy,
    preferences,
    timeFormat,
    login,
    loginTotp,
    totpEnabled,
    totpSetup,
    totpEnable,
    totpStatus,
    totpRegenerateBackupCodes,
    totpDisable,
    changePassword,
    fetchUser,
    updatePreferences,
    logout,
  };
});
