<template>
  <div class="login-container">
    <div class="login-card">
      <h1>IPAM</h1>
      <p class="subtitle">IP Address Management</p>
      <form @submit.prevent="handleLogin">
        <div class="field">
          <label for="username">Username</label>
          <InputText id="username" v-model="username" autocomplete="username" :disabled="loading" class="w-full" />
        </div>
        <div class="field">
          <label for="password">Password</label>
          <Password id="password" v-model="password" :feedback="false" toggleMask autocomplete="current-password" :disabled="loading" class="w-full" inputClass="w-full" />
        </div>
        <Message v-if="error" severity="error" :closable="false" class="mb-3">{{ error }}</Message>
        <Button type="submit" label="Sign In" :loading="loading" class="w-full" />
      </form>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import InputText from 'primevue/inputtext';
import Password from 'primevue/password';
import Button from 'primevue/button';
import Message from 'primevue/message';

const router = useRouter();
const auth = useAuthStore();

const username = ref('');
const password = ref('');
const loading = ref(false);
const error = ref('');

async function handleLogin() {
  error.value = '';
  loading.value = true;
  try {
    const data = await auth.login(username.value, password.value);
    if (data.user.must_change_password) {
      router.push('/change-password');
    } else {
      router.push('/');
    }
  } catch (err) {
    error.value = err.response?.data?.error || 'Login failed';
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
  color: var(--p-primary-color);
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
