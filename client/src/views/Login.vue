<template>
  <div class="login-container">
    <div class="login-card">
      <h1>CIDRella</h1>
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
import { apiError } from '../utils/format.js';

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
/* Login-specific: primary color on the h1 title */
.login-card h1 {
  color: var(--p-primary-color);
}
</style>
