<template>
  <div class="totp-enrol" data-track="totp-enrollment">
    <div v-if="loading" class="help"><i class="pi pi-spinner pi-spin"></i> Preparing</div>
    <div v-else-if="enrolment" class="enrol">
      <img
        v-if="qrDataUrl"
        :src="qrDataUrl"
        alt="QR code for the authenticator app"
        class="qr"
        width="192"
        height="192"
      />
      <div class="enrol-text">
        <p class="help">
          Scan this with the app, or enter the key by hand. Then type the code the app shows.
        </p>
        <div class="field">
          <label for="totp-secret">Key</label>
          <code id="totp-secret" class="secret" data-track="totp-secret">{{ groupedSecret }}</code>
        </div>
        <div class="field">
          <label for="totp-code">Code from the app</label>
          <div class="code-row">
            <InputText
              id="totp-code"
              v-model="code"
              inputmode="numeric"
              autocomplete="one-time-code"
              placeholder="123456"
              maxlength="7"
              class="code"
              :disabled="verifying"
              @keyup.enter="verify"
            />
            <Button
              label="Verify"
              :loading="verifying"
              :disabled="!codeLooksRight"
              data-track="totp-verify"
              @click="verify"
            />
          </div>
        </div>
      </div>
    </div>
    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import QRCode from 'qrcode';
import Button from '../ui/Button.js';
import InputText from '../ui/InputText.js';
import Message from '../ui/Message.js';
import { useAuthStore } from '../stores/auth.js';
import { apiError } from '../utils/format.js';

// Authenticator enrolment for the signed-in user: asks the server for a
// secret, shows it as a QR code and as text, and proves a code from the app.
// Emits `enabled` with the backup codes once the server has turned
// two-factor on. Used by the first-run wizard and Settings > Access.
const emit = defineEmits(['enabled', 'failed']);
const auth = useAuthStore();

const loading = ref(false);
const enrolment = ref(null); // { secret, otpauth_url }
const qrDataUrl = ref('');
const code = ref('');
const verifying = ref(false);
const error = ref('');

const digits = computed(() => code.value.replace(/\s/g, ''));
const codeLooksRight = computed(() => /^\d{6}$/.test(digits.value));
const groupedSecret = computed(() =>
  (enrolment.value?.secret || '').replace(/(.{4})/g, '$1 ').trim(),
);

onMounted(async () => {
  loading.value = true;
  try {
    enrolment.value = await auth.totpSetup();
    qrDataUrl.value = await QRCode.toDataURL(enrolment.value.otpauth_url, {
      width: 192,
      margin: 1,
    });
  } catch (err) {
    error.value = apiError(err);
    emit('failed', error.value);
  } finally {
    loading.value = false;
  }
});

async function verify() {
  if (!codeLooksRight.value || verifying.value) return;
  verifying.value = true;
  error.value = '';
  try {
    const res = await auth.totpEnable(digits.value);
    emit('enabled', res.backup_codes);
  } catch (err) {
    error.value = apiError(err);
  } finally {
    verifying.value = false;
  }
}
</script>

<style scoped>
.totp-enrol {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.enrol {
  display: grid;
  grid-template-columns: 192px 1fr;
  gap: 18px;
  align-items: start;
}
.qr {
  border-radius: 8px;
  background: #fff;
  padding: 4px;
  box-sizing: content-box;
}
.enrol-text {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field label {
  font-weight: 500;
  font-size: 0.9rem;
}
.help {
  font-size: 0.85rem;
  color: var(--cid-text-muted-color);
  margin: 0;
}
.secret {
  display: block;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.95rem;
  letter-spacing: 0.04em;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--cid-content-background);
  user-select: all;
}
.code-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.code {
  width: 9rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: 0.15em;
}
@media (max-width: 720px) {
  .enrol {
    grid-template-columns: 1fr;
  }
}
</style>
