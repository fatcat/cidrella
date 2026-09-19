<!-- The appliance-wide password rule. One switch: whether a new password must
     carry an uppercase letter, a lowercase letter and a digit. The length
     floor of eight is not negotiable and is stated rather than offered. The
     first-run wizard sets the same setting on its password step. -->
<template>
  <div class="content-card">
    <div class="setting-group">
      <h3>Password rule</h3>
      <p class="field-help">
        Applies to every account on this appliance whenever a password is set or changed. Existing
        passwords are not re-checked.
      </p>

      <div v-if="complexity === null" class="muted">Loading</div>
      <template v-else>
        <label class="rule-row" for="password-complexity">
          <ToggleSwitch
            v-model="complexity"
            input-id="password-complexity"
            :disabled="!auth.isAdmin || saving"
            data-track="password-rule-complexity"
            @update:model-value="save"
          />
          <span>
            <span class="rule-title"
              >Require an uppercase letter, a lowercase letter and a digit</span
            >
            <span class="field-help">{{ effectiveRule }}</span>
          </span>
        </label>
        <p v-if="!auth.isAdmin" class="field-help muted">Only an administrator can change this.</p>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import ToggleSwitch from '../../ui/ToggleSwitch.js';
import { useToast } from '../../ui/useToast.js';
import { useAuthStore } from '../../stores/auth.js';
import { useSubnetStore } from '../../stores/subnets.js';
import { apiError } from '../../utils/format.js';

const auth = useAuthStore();
const store = useSubnetStore();
const toast = useToast();

const complexity = ref(null);
const saving = ref(false);

const effectiveRule = computed(() =>
  complexity.value
    ? 'At least 8 characters, including an uppercase letter, a lowercase letter and a digit.'
    : 'At least 8 characters. Nothing else is required.',
);

onMounted(async () => {
  try {
    const settings = await store.getSettings();
    complexity.value = settings?.password_complexity !== 'false';
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  }
});

async function save(value) {
  saving.value = true;
  try {
    await store.updateSetting('password_complexity', value ? 'true' : 'false');
    toast.add({
      severity: 'success',
      summary: value ? 'Complexity rule on' : 'Complexity rule off',
      detail: effectiveRule.value,
      life: 4000,
    });
  } catch (err) {
    complexity.value = !value;
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.rule-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin: 0.75rem 0 0.5rem;
  max-width: 640px;
  cursor: pointer;
}
.rule-row > span {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.rule-title {
  font-weight: 500;
}
</style>
