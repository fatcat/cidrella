<template>
  <section class="fr-screen" data-track="first-run-step-totp">
    <div>
      <div class="fr-eyebrow">Step 2 of 5</div>
      <h1>Add a second factor?</h1>
      <p class="fr-lede">
        Optional. With it on, signing in as {{ auth.user?.username }} takes the password and a
        six-digit code from an authenticator app. Backup codes cover a lost phone.
      </p>
    </div>

    <div v-if="alreadyOn" class="fr-note ok">
      <span>Two-factor is already on for this account.</span>
    </div>

    <div v-else class="fr-cards fr-cards-2" role="group" aria-label="Second factor">
      <button
        type="button"
        class="fr-card"
        :aria-pressed="choice === 'app'"
        :disabled="!!backupCodes"
        data-track="first-run-totp-app"
        @click="choice = 'app'"
      >
        <span class="fr-card-title">
          Use an authenticator app <span class="fr-card-tag">recommended</span>
        </span>
        <span class="fr-card-desc">
          Any TOTP app: Aegis, Google Authenticator, 1Password, Bitwarden and the like.
        </span>
        <span class="fr-card-note"
          ><b>Two minutes.</b> Scan, type one code, save the backup codes.</span
        >
      </button>
      <button
        type="button"
        class="fr-card"
        :aria-pressed="choice === 'skip'"
        :disabled="!!backupCodes"
        data-track="first-run-totp-skip"
        @click="choice = 'skip'"
      >
        <span class="fr-card-title">Skip for now</span>
        <span class="fr-card-desc"
          >Password only. It can be turned on later under Settings &gt; Access &gt;
          Two-factor.</span
        >
        <span class="fr-card-note"><b>Fine on a trusted LAN.</b> Less so anywhere else.</span>
      </button>
    </div>

    <div v-if="choice === 'app' && !backupCodes && !alreadyOn" class="fr-detail">
      <TotpEnrollment @enabled="onEnabled" />
    </div>

    <div v-if="backupCodes" class="fr-detail">
      <BackupCodesPanel
        v-model:saved="saved"
        :codes="backupCodes"
        :username="auth.user?.username"
      />
    </div>

    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

    <div class="fr-actions">
      <span class="spacer"></span>
      <span v-if="blocker" class="fr-help">{{ blocker }}</span>
      <Button
        :label="choice === 'skip' && !alreadyOn ? 'Skip and continue' : 'Continue'"
        :disabled="!!blocker"
        :loading="saving"
        data-track="first-run-totp-continue"
        @click="submit"
      />
    </div>
  </section>
</template>

<script setup>
import { ref, computed } from 'vue';
import Button from '../../ui/Button.js';
import Message from '../../ui/Message.js';
import TotpEnrollment from '../TotpEnrollment.vue';
import BackupCodesPanel from '../BackupCodesPanel.vue';
import { useAuthStore } from '../../stores/auth.js';
import { useSetupStore } from '../../stores/setup.js';
import { apiError } from '../../utils/format.js';

const emit = defineEmits(['next']);
const auth = useAuthStore();
const setup = useSetupStore();

// Captured once at mount. The store flips totpEnabled the instant the server
// turns two-factor on, which is before this step has shown the backup codes;
// reacting to it there would unmount the enrolment and lose the one showing.
const alreadyOn = auth.totpEnabled;
const choice = ref(alreadyOn ? 'app' : null);
const backupCodes = ref(null);
const saved = ref(false);
const saving = ref(false);
const error = ref('');

function onEnabled(codes) {
  backupCodes.value = codes;
}

const blocker = computed(() => {
  if (alreadyOn) return '';
  if (!choice.value) return 'Pick one.';
  if (choice.value === 'app' && !backupCodes.value) return 'Verify a code from the app first.';
  if (backupCodes.value && !saved.value) return 'Confirm the backup codes are saved.';
  return '';
});

async function submit() {
  if (blocker.value || saving.value) return;
  saving.value = true;
  error.value = '';
  try {
    await setup.mark({ totp: auth.totpEnabled ? 'enabled' : 'skipped' });
    emit('next');
  } catch (err) {
    error.value = apiError(err);
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.fr-cards-2 {
  grid-template-columns: repeat(2, 1fr);
}
@media (max-width: 720px) {
  .fr-cards-2 {
    grid-template-columns: 1fr;
  }
}
</style>
