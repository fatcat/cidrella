<!-- The appliance-wide password rule, part by part: a minimum length (0 for
     none) and whether a password needs mixed case, a number, a symbol. The
     first-run wizard's password step edits the same four settings. -->
<template>
  <div class="content-card">
    <div class="setting-group">
      <h3>Password rule</h3>
      <p class="field-help">
        Applies to every account on this appliance whenever a password is set or changed. Existing
        passwords are not re-checked.
      </p>

      <div v-if="policy === null" class="muted">Loading</div>
      <template v-else>
        <p class="rule-now" data-track="password-rule-description">{{ description }}</p>
        <PasswordPolicyEditor :policy="policy" :disabled="!auth.isAdmin || saving" @save="save" />
        <p v-if="!auth.isAdmin" class="field-help muted">Only an administrator can change this.</p>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import PasswordPolicyEditor from '../../components/PasswordPolicyEditor.vue';
import { useToast } from '../../ui/useToast.js';
import { useAuthStore } from '../../stores/auth.js';
import { useSubnetStore } from '../../stores/subnets.js';
import { apiError } from '../../utils/format.js';
import { describePolicy } from '../../utils/passwordPolicy.js';

const auth = useAuthStore();
const store = useSubnetStore();
const toast = useToast();

const KEYS = {
  minLength: 'password_min_length',
  requireMixedCase: 'password_require_mixed_case',
  requireNumber: 'password_require_number',
  requireSymbol: 'password_require_symbol',
};
const DEFAULTS = {
  minLength: 8,
  requireMixedCase: true,
  requireNumber: true,
  requireSymbol: false,
};

const policy = ref(null);
const saving = ref(false);
const description = computed(() => (policy.value ? describePolicy(policy.value) : ''));

function fromSettings(settings) {
  const bool = (key, fallback) => {
    const v = settings?.[key];
    return v === 'true' ? true : v === 'false' ? false : fallback;
  };
  const n = Number.parseInt(settings?.[KEYS.minLength], 10);
  return {
    minLength: Number.isInteger(n) && n >= 0 ? n : DEFAULTS.minLength,
    requireMixedCase: bool(KEYS.requireMixedCase, DEFAULTS.requireMixedCase),
    requireNumber: bool(KEYS.requireNumber, DEFAULTS.requireNumber),
    requireSymbol: bool(KEYS.requireSymbol, DEFAULTS.requireSymbol),
  };
}

onMounted(async () => {
  try {
    policy.value = fromSettings(await store.getSettings());
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  }
});

async function save(patch) {
  saving.value = true;
  const before = { ...policy.value };
  policy.value = { ...policy.value, ...patch };
  try {
    for (const [field, value] of Object.entries(patch)) {
      await store.updateSetting(KEYS[field], String(value));
    }
    toast.add({
      severity: 'success',
      summary: 'Password rule saved',
      detail: description.value,
      life: 4000,
    });
  } catch (err) {
    policy.value = before;
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.rule-now {
  margin: 0.5rem 0 0.75rem;
  font-weight: 500;
}
</style>
