<!-- How long a signed-in session survives without anyone using it. Every
     session also ends 24 hours after sign-in, whatever this says. -->
<template>
  <div class="content-card">
    <div class="setting-group">
      <h3>Sign out after inactivity</h3>
      <p class="field-help">
        You will receive a warning 1 minute before being logged out. Every session ends 24 hours
        after sign-in regardless of the setting here.
      </p>

      <div v-if="minutes === null" class="muted">Loading</div>
      <template v-else>
        <SelectButton
          :model-value="minutes"
          :options="CHOICES"
          option-label="label"
          option-value="value"
          :allow-empty="false"
          :disabled="!auth.isAdmin || saving"
          aria-label="Sign out after inactivity"
          data-track="session-idle-timeout"
          @update:model-value="save"
        />
        <p v-if="!auth.isAdmin" class="field-help muted">Only an administrator can change this.</p>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import SelectButton from '../../ui/SelectButton.js';
import { useToast } from '../../ui/useToast.js';
import { useAuthStore } from '../../stores/auth.js';
import { useSubnetStore } from '../../stores/subnets.js';
import { apiError } from '../../utils/format.js';

const KEY = 'session_idle_timeout_minutes';
const DEFAULT_MINUTES = 60;
const CHOICES = [
  { label: 'Never', value: 0 },
  { label: '15 minutes', value: 15 },
  { label: '30 minutes', value: 30 },
  { label: '60 minutes', value: 60 },
];

const auth = useAuthStore();
const store = useSubnetStore();
const toast = useToast();

const minutes = ref(null);
const saving = ref(false);

onMounted(async () => {
  try {
    const n = Number((await store.getSettings())?.[KEY]);
    minutes.value = CHOICES.some((c) => c.value === n) ? n : DEFAULT_MINUTES;
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  }
});

async function save(value) {
  if (value == null || value === minutes.value) return;
  const before = minutes.value;
  minutes.value = value;
  saving.value = true;
  try {
    await store.updateSetting(KEY, String(value));
    // This session's deadline follows the new setting at once.
    await auth.refreshSession().catch(() => {});
    toast.add({
      severity: 'success',
      summary: 'Saved',
      detail: value
        ? `Sessions end after ${value} minutes without activity.`
        : 'Sessions no longer end for inactivity, only at 24 hours.',
      life: 4000,
    });
  } catch (err) {
    minutes.value = before;
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally {
    saving.value = false;
  }
}
</script>
