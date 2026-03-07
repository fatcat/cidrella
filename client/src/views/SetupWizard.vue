<template>
  <div class="setup-container">
    <div class="setup-card">
      <h1>CIDRella Setup</h1>
      <p class="subtitle">Create your administrator account</p>

      <form @submit.prevent="handleSetup" v-if="!completed">
        <div class="field">
          <label for="username">Username</label>
          <InputText id="username" v-model="username" autocomplete="username" :disabled="loading" class="w-full" />
        </div>
        <div class="field">
          <label for="password">Password</label>
          <Password id="password" v-model="password" :feedback="false" toggleMask autocomplete="new-password"
                    :disabled="loading" class="w-full" inputClass="w-full" />
        </div>
        <div class="field">
          <label for="confirmPassword">Confirm Password</label>
          <Password id="confirmPassword" v-model="confirmPassword" :feedback="false" toggleMask
                    autocomplete="new-password" :disabled="loading" class="w-full" inputClass="w-full" />
        </div>
        <Message v-if="error" severity="error" :closable="false" class="mb-3">{{ error }}</Message>
        <Button type="submit" label="Complete Setup" :loading="loading" class="w-full" />
        <div class="skip-row">
          <Button label="Skip Setup" severity="secondary" text size="small" @click="handleSkip" :loading="skipping" />
          <span class="skip-hint">Uses auto-generated admin credentials from server log</span>
        </div>
      </form>

      <div v-else class="setup-complete">
        <i class="pi pi-check-circle" style="font-size: 3rem; color: var(--p-green-500);"></i>
        <p>Setup complete! Redirecting to login...</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import InputText from 'primevue/inputtext';
import Password from 'primevue/password';
import Button from 'primevue/button';
import Message from 'primevue/message';
import { useOperationsStore } from '../stores/operations.js';

const router = useRouter();
const opsStore = useOperationsStore();

const username = ref('');
const password = ref('');
const confirmPassword = ref('');
const loading = ref(false);
const skipping = ref(false);
const error = ref('');
const completed = ref(false);

async function handleSetup() {
  error.value = '';

  if (!username.value || username.value.length < 3) {
    error.value = 'Username must be at least 3 characters';
    return;
  }
  if (!password.value || password.value.length < 8) {
    error.value = 'Password must be at least 8 characters';
    return;
  }
  if (password.value !== confirmPassword.value) {
    error.value = 'Passwords do not match';
    return;
  }

  loading.value = true;
  try {
    await opsStore.completeSetup({ username: username.value, password: password.value });
    completed.value = true;
    setTimeout(() => router.push('/login'), 2000);
  } catch (err) {
    error.value = err.response?.data?.error || 'Setup failed';
  } finally {
    loading.value = false;
  }
}

async function handleSkip() {
  skipping.value = true;
  try {
    await opsStore.completeSetup({ skip: true });
    completed.value = true;
    setTimeout(() => router.push('/login'), 2000);
  } catch (err) {
    error.value = err.response?.data?.error || 'Setup failed';
  } finally {
    skipping.value = false;
  }
}
</script>

<style scoped>
.setup-container {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background: var(--p-surface-ground);
}
.setup-card {
  background: var(--p-surface-card);
  border: 1px solid var(--p-surface-border);
  border-radius: 12px;
  padding: 2.5rem;
  width: 100%;
  max-width: 420px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
}
.setup-card h1 {
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
.skip-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 1rem;
  justify-content: center;
}
.skip-hint {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}
.setup-complete {
  text-align: center;
  padding: 2rem 0;
}
.setup-complete p {
  margin-top: 1rem;
  color: var(--p-text-muted-color);
}
</style>
