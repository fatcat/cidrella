<template>
  <div class="login-container">
    <div class="login-card">
      <h1>Change Password</h1>
      <p class="subtitle">You must change your password before continuing.</p>
      <Message v-if="auth.passwordResetBy" severity="warn" :closable="false" class="mb-3">
        <div class="reset-warning">
          <strong>Your password was reset via the command line.</strong>
          <div class="reset-actor">
            Actor recorded: <code>{{ auth.passwordResetBy }}</code>
          </div>
          <div class="reset-hint">
            If you did not perform this reset, someone with root access to this
            host ran <code>cidrella-reset-password</code> (or an equivalent SQL
            update) on your account. Treat this host as potentially compromised
            and investigate who has shell access.
          </div>
        </div>
      </Message>
      <form @submit.prevent="handleChange">
        <div class="field">
          <label for="current">Current Password</label>
          <Password id="current" v-model="currentPassword" :feedback="false" toggleMask :disabled="loading" class="w-full" inputClass="w-full" />
        </div>
        <div class="field">
          <label for="newpass">New Password</label>
          <Password id="newpass" v-model="newPassword" :feedback="false" toggleMask :disabled="loading" class="w-full" inputClass="w-full" />
        </div>
        <div class="field">
          <label for="confirm">Confirm New Password</label>
          <Password id="confirm" v-model="confirmPassword" :feedback="false" toggleMask :disabled="loading" class="w-full" inputClass="w-full" />
        </div>
        <Message v-if="error" severity="error" :closable="false" class="mb-3">{{ error }}</Message>
        <Button type="submit" label="Change Password" :loading="loading" class="w-full" />
      </form>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import Password from '../ui/Password.js';
import Button from '../ui/Button.js';
import Message from '../ui/Message.js';
import { apiError } from '../utils/format.js';

const router = useRouter();
const auth = useAuthStore();

const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const loading = ref(false);
const error = ref('');

async function handleChange() {
  error.value = '';

  if (newPassword.value !== confirmPassword.value) {
    error.value = 'Passwords do not match';
    return;
  }

  if (newPassword.value.length < 8) {
    error.value = 'Password must be at least 8 characters';
    return;
  }

  loading.value = true;
  try {
    await auth.changePassword(currentPassword.value, newPassword.value);
    router.push('/');
  } catch (err) {
    error.value = apiError(err);
  } finally {
    loading.value = false;
  }
}
</script>

<style>
@import '../assets/auth-layout.css';
</style>

<style scoped>
/* ChangePassword-specific: font-size override on the h1 title */
.login-card h1 {
  font-size: 1.5rem;
}
.reset-warning { font-size: 0.85rem; }
.reset-warning strong { display: block; margin-bottom: 0.4rem; }
.reset-actor { margin-bottom: 0.4rem; }
.reset-actor code,
.reset-hint code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8rem; background: rgba(0,0,0,0.08); padding: 1px 4px; border-radius: 3px; }
.reset-hint { line-height: 1.4; }
</style>
