<template>
  <div class="login-container">
    <div class="login-card">
      <h1>CIDRella</h1>
      <p class="subtitle">IP Address Management</p>
      <form v-if="challenge" @submit.prevent="handleTotp" data-track="login-totp-form">
        <div class="field">
          <label for="totp-code">Authentication code</label>
          <InputText
            id="totp-code"
            v-model="code"
            autocomplete="one-time-code"
            inputmode="text"
            autofocus
            :disabled="loading"
            class="w-full"
            placeholder="6-digit code or a backup code"
          />
          <small class="totp-hint">
            From your authenticator app. Lost it? A backup code works once.
          </small>
        </div>
        <Message v-if="error" severity="error" :closable="false" class="mb-3">{{ error }}</Message>
        <Button
          type="submit"
          label="Verify"
          :loading="loading"
          class="w-full"
          data-track="login-totp-submit"
        />
        <Button
          label="Start over"
          severity="secondary"
          text
          size="small"
          class="w-full totp-back"
          data-track="login-totp-back"
          @click="resetChallenge"
        />
      </form>
      <form v-else @submit.prevent="handleLogin">
        <div class="field">
          <label for="username">Username</label>
          <InputText
            id="username"
            v-model="username"
            autocomplete="username"
            :disabled="loading"
            class="w-full"
          />
        </div>
        <div class="field">
          <label for="password">Password</label>
          <Password
            id="password"
            v-model="password"
            :feedback="false"
            toggleMask
            autocomplete="current-password"
            :disabled="loading"
            class="w-full"
            inputClass="w-full"
          />
        </div>
        <Message v-if="error" severity="error" :closable="false" class="mb-3">{{ error }}</Message>
        <Button type="submit" label="Sign In" :loading="loading" class="w-full" />
      </form>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import { landingPath } from '../utils/landing.js';
import InputText from '../ui/InputText.js';
import Password from '../ui/Password.js';
import Button from '../ui/Button.js';
import Message from '../ui/Message.js';
import { apiError } from '../utils/format.js';

const router = useRouter();
const route = useRoute();
const auth = useAuthStore();

const username = ref('');
const password = ref('');
const loading = ref(false);
const error = ref('');
// Set when the password was right but the account has two-factor on.
const challenge = ref(null);
const code = ref('');

function resetChallenge() {
  challenge.value = null;
  code.value = '';
  password.value = '';
  error.value = '';
}

function landAfterLogin(data) {
  if (data.backup_codes_remaining != null && data.backup_codes_remaining <= 2) {
    // Not a toast: this page has none, and the count is worth reading.
    sessionStorage.setItem('cidrella_backup_codes_low', String(data.backup_codes_remaining));
  }
  if (data.user.setup_required) {
    // First run: the wizard owns the password change and everything after.
    router.push({ name: 'FirstRun' });
  } else if (data.user.must_change_password) {
    // Hand the destination on rather than dropping it. The change-password
    // step is in the way of where they were going, not the destination.
    router.push({
      path: '/change-password',
      query: route.query.redirect ? { redirect: route.query.redirect } : {},
    });
  } else {
    router.push(landingPath(router, data.user.username, route.query.redirect));
  }
}

async function handleLogin() {
  error.value = '';
  loading.value = true;
  try {
    const data = await auth.login(username.value, password.value);
    if (data.totp_required) {
      challenge.value = data.challenge;
      return;
    }
    landAfterLogin(data);
  } catch (err) {
    error.value = apiError(err);
  } finally {
    loading.value = false;
  }
}

async function handleTotp() {
  error.value = '';
  loading.value = true;
  try {
    landAfterLogin(await auth.loginTotp(challenge.value, code.value.trim()));
  } catch (err) {
    // An expired challenge (5 minutes) comes back as "Sign in again".
    error.value = apiError(err);
    if (err?.response?.status === 401 && /sign in again/i.test(error.value)) resetChallenge();
  } finally {
    loading.value = false;
  }
}
</script>

<style>
@import '../assets/auth-layout.css';
</style>

<style scoped>
.totp-hint {
  display: block;
  margin-top: 0.4rem;
  font-size: 0.8rem;
  color: var(--cid-text-muted-color);
}
.totp-back {
  margin-top: 0.5rem;
}
</style>

<style scoped>
/* Login-specific: primary color on the h1 title */
.login-card h1 {
  color: var(--cid-primary-color);
}
</style>
