<template>
  <div class="login-container">
    <div class="login-card">
      <h1>Change Password</h1>
      <p class="subtitle">You must change your password before continuing.</p>
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
import Password from 'primevue/password';
import Button from 'primevue/button';
import Message from 'primevue/message';

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

  if (newPassword.value.length < 4) {
    error.value = 'Password must be at least 4 characters';
    return;
  }

  loading.value = true;
  try {
    await auth.changePassword(currentPassword.value, newPassword.value);
    router.push('/');
  } catch (err) {
    error.value = err.response?.data?.error || 'Failed to change password';
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.login-container {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background: var(--p-surface-ground);
}
.login-card {
  background: var(--p-surface-card);
  border: 1px solid var(--p-surface-border);
  border-radius: 12px;
  padding: 2.5rem;
  width: 100%;
  max-width: 400px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
}
.login-card h1 {
  margin: 0 0 0.25rem 0;
  text-align: center;
  font-size: 1.5rem;
}
.subtitle {
  text-align: center;
  color: var(--p-text-muted-color);
  margin: 0 0 1.5rem 0;
}
.field {
  margin-bottom: 1rem;
}
.field label {
  display: block;
  margin-bottom: 0.5rem;
  font-weight: 500;
}
.w-full {
  width: 100%;
}
.mb-3 {
  margin-bottom: 0.75rem;
}
</style>
