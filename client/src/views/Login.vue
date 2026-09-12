<template>
  <div class="login-container">
    <div class="login-card">
      <h1>CIDRella</h1>
      <p class="subtitle">IP Address Management</p>
      <form @submit.prevent="handleLogin">
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

async function handleLogin() {
  error.value = '';
  loading.value = true;
  try {
    const data = await auth.login(username.value, password.value);
    if (data.user.must_change_password) {
      // Hand the destination on rather than dropping it. The change-password
      // step is in the way of where they were going, not the destination.
      router.push({
        path: '/change-password',
        query: route.query.redirect ? { redirect: route.query.redirect } : {},
      });
    } else {
      router.push(landingPath(router, data.user.username, route.query.redirect));
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
