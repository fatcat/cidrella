<!-- Two-factor sign-in for the signed-in account: turn it on with an
     authenticator app, get fresh backup codes, or turn it off. The first-run
     wizard offers the same enrolment; this is where it lives afterwards. -->
<template>
  <div class="content-card">
    <div class="setting-group">
      <h3>Two-factor sign-in</h3>
      <p class="field-help">
        Applies to <strong>{{ auth.user?.username }}</strong
        >. With it on, signing in takes the password and a six-digit code from an authenticator app.
        Each account sets up its own.
      </p>

      <div v-if="status === null" class="muted">Loading</div>

      <template v-else-if="!status.enabled && !enrolling && !freshCodes">
        <div class="status-row">
          <span class="badge badge-yellow">Off</span>
          <Button
            label="Set up an authenticator app"
            data-track="twofactor-enable"
            @click="enrolling = true"
          />
        </div>
      </template>

      <div v-else-if="enrolling" class="panel">
        <TotpEnrollment @enabled="onEnabled" />
        <Button
          label="Cancel"
          severity="secondary"
          text
          size="small"
          data-track="twofactor-enrol-cancel"
          @click="enrolling = false"
        />
      </div>

      <div v-else-if="freshCodes" class="panel">
        <BackupCodesPanel
          v-model:saved="saved"
          :codes="freshCodes"
          :username="auth.user?.username"
          :lead="codesLead"
        />
        <Button
          label="Done"
          :disabled="!saved"
          data-track="twofactor-codes-done"
          @click="finishCodes"
        />
      </div>

      <template v-else>
        <div class="status-row">
          <span class="badge badge-green">On</span>
          <span class="muted">
            {{ status.backup_codes_remaining }} of 10 backup codes unused
            <template v-if="status.backup_codes_remaining <= 2">, get a fresh set</template>
          </span>
        </div>
        <div class="password-form">
          <div class="field">
            <label for="twofactor-password">Your password</label>
            <Password
              v-model="password"
              input-id="twofactor-password"
              :input-props="{ autocomplete: 'current-password' }"
              :feedback="false"
              toggle-mask
              class="w-full"
              input-class="w-full"
            />
            <small class="field-help">Both actions below ask for it.</small>
          </div>
          <div class="actions">
            <Button
              label="New backup codes"
              severity="secondary"
              :disabled="!password"
              :loading="busy === 'codes'"
              data-track="twofactor-regenerate"
              @click="regenerate"
            />
            <Button
              label="Turn two-factor off"
              severity="danger"
              outlined
              :disabled="!password"
              :loading="busy === 'disable'"
              data-track="twofactor-disable"
              @click="disable"
            />
          </div>
        </div>
      </template>

      <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import Button from '../../ui/Button.js';
import Password from '../../ui/Password.js';
import Message from '../../ui/Message.js';
import TotpEnrollment from '../../components/TotpEnrollment.vue';
import BackupCodesPanel from '../../components/BackupCodesPanel.vue';
import { useAuthStore } from '../../stores/auth.js';
import { apiError } from '../../utils/format.js';

const auth = useAuthStore();

const status = ref(null); // { enabled, backup_codes_remaining }
const enrolling = ref(false);
const freshCodes = ref(null);
const codesLead = ref('Two-factor is on.');
const saved = ref(false);
const password = ref('');
const busy = ref('');
const error = ref('');

async function load() {
  try {
    status.value = await auth.totpStatus();
  } catch (err) {
    error.value = apiError(err);
  }
}
onMounted(load);

function onEnabled(codes) {
  enrolling.value = false;
  codesLead.value = 'Two-factor is on.';
  freshCodes.value = codes;
  saved.value = false;
}

async function finishCodes() {
  freshCodes.value = null;
  saved.value = false;
  await load();
}

async function regenerate() {
  busy.value = 'codes';
  error.value = '';
  try {
    const res = await auth.totpRegenerateBackupCodes(password.value);
    password.value = '';
    codesLead.value = 'Fresh backup codes. The old ones no longer work.';
    freshCodes.value = res.backup_codes;
    saved.value = false;
  } catch (err) {
    error.value = apiError(err);
  } finally {
    busy.value = '';
  }
}

async function disable() {
  busy.value = 'disable';
  error.value = '';
  try {
    await auth.totpDisable(password.value);
    password.value = '';
    await load();
  } catch (err) {
    error.value = apiError(err);
  } finally {
    busy.value = '';
  }
}
</script>

<style scoped>
.status-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0.75rem 0;
}
.panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 0.75rem;
  max-width: 640px;
}
.password-form {
  max-width: 420px;
  margin-top: 0.5rem;
}
.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 0.5rem;
}
</style>
