<template>
  <section class="fr-screen" data-track="first-run-step-password">
    <div>
      <div class="fr-eyebrow">Step 1 of 5</div>
      <h1>Set the admin password</h1>
      <p class="fr-lede">
        The password printed by the installer is a one-time key. Replace it now; nothing else on
        this appliance is reachable until you do.
      </p>
    </div>

    <!-- A real form with named, autocomplete-typed fields: that is what
         password managers key on to offer a generated password. -->
    <form id="first-run-password" autocomplete="on" @submit.prevent="submit">
      <div class="fr-field">
        <label for="fr-username">Username</label>
        <InputText
          id="fr-username"
          name="username"
          autocomplete="username"
          :model-value="auth.user?.username || 'admin'"
          readonly
          class="fr-mono"
        />
        <span class="fr-help">
          Fixed for first run. More users and roles can be added later under Settings &gt; Access.
        </span>
      </div>
      <div class="fr-field fr-gap">
        <label for="fr-current">Current password</label>
        <Password
          v-model="current"
          input-id="fr-current"
          :input-props="{ name: 'current-password', autocomplete: 'current-password' }"
          :feedback="false"
          toggle-mask
          :disabled="loading"
          class="w-full"
          input-class="w-full"
        />
        <span class="fr-help">The one you just signed in with.</span>
      </div>
      <div class="fr-field fr-gap">
        <label for="fr-new">New password</label>
        <Password
          v-model="next"
          input-id="fr-new"
          :input-props="{ name: 'new-password', autocomplete: 'new-password' }"
          :feedback="false"
          toggle-mask
          :disabled="loading"
          class="w-full"
          input-class="w-full"
        />
        <label class="fr-switch-row">
          <Checkbox
            v-model="complexity"
            binary
            input-id="fr-complexity"
            :disabled="loading || complexitySaving"
            data-track="first-run-password-complexity"
            @update:model-value="saveComplexity"
          />
          <span>
            Require an uppercase letter, a lowercase letter and a digit
            <span class="fr-help"
              >(applies to every account on this appliance; length is always 8 or more)</span
            >
          </span>
        </label>
        <ul v-if="policy" class="fr-checks" aria-live="polite">
          <li :class="{ ok: checks.length }">
            {{ policy.minLength }} to {{ policy.maxLength }} characters
          </li>
          <li v-if="policy.requireUppercase" :class="{ ok: checks.upper }">an uppercase letter</li>
          <li v-if="policy.requireLowercase" :class="{ ok: checks.lower }">a lowercase letter</li>
          <li v-if="policy.requireDigit" :class="{ ok: checks.digit }">a digit</li>
        </ul>
      </div>
      <div class="fr-field fr-gap">
        <label for="fr-confirm">Confirm password</label>
        <Password
          v-model="confirm"
          input-id="fr-confirm"
          :input-props="{ name: 'confirm-password', autocomplete: 'new-password' }"
          :feedback="false"
          toggle-mask
          :disabled="loading"
          class="w-full"
          input-class="w-full"
        />
        <span class="fr-help" :class="{ 'fr-bad': confirm && !matches }">
          {{ confirm ? (matches ? 'Passwords match.' : 'Passwords do not match yet.') : '' }}
        </span>
      </div>
      <Message v-if="error" severity="error" :closable="false" class="fr-gap">{{ error }}</Message>
    </form>

    <div class="fr-actions">
      <span class="spacer"></span>
      <Button
        type="submit"
        form="first-run-password"
        label="Set password and continue"
        :disabled="!valid"
        :loading="loading"
        data-track="first-run-password-submit"
      />
    </div>
  </section>
</template>

<script setup>
import { ref, computed } from 'vue';
import InputText from '../../ui/InputText.js';
import Password from '../../ui/Password.js';
import Checkbox from '../../ui/Checkbox.js';
import Button from '../../ui/Button.js';
import Message from '../../ui/Message.js';
import { useAuthStore } from '../../stores/auth.js';
import { useSetupStore } from '../../stores/setup.js';
import { apiError } from '../../utils/format.js';

const emit = defineEmits(['next']);
const auth = useAuthStore();
const setup = useSetupStore();

const current = ref('');
const next = ref('');
const confirm = ref('');
const loading = ref(false);
const error = ref('');

// The complexity half of the rule is the operator's call, per appliance. The
// server answers with the policy it will enforce, so the checklist follows.
const complexity = ref(setup.passwordComplexity);
const complexitySaving = ref(false);
async function saveComplexity(value) {
  complexitySaving.value = true;
  error.value = '';
  try {
    await setup.mark({ password_complexity: value === true });
  } catch (err) {
    complexity.value = setup.passwordComplexity;
    error.value = apiError(err);
  } finally {
    complexitySaving.value = false;
  }
}

// The rule is the server's, served with the setup state, never restated
// here. With no policy in hand the form only checks the match and lets the
// server judge the rest.
const policy = computed(() => setup.passwordPolicy);
const checks = computed(() => {
  const v = next.value;
  const p = policy.value;
  if (!p) return { length: v.length > 0, upper: true, lower: true, digit: true };
  return {
    length: v.length >= p.minLength && v.length <= p.maxLength,
    upper: !p.requireUppercase || /[A-Z]/.test(v),
    lower: !p.requireLowercase || /[a-z]/.test(v),
    digit: !p.requireDigit || /\d/.test(v),
  };
});
const matches = computed(() => next.value.length > 0 && next.value === confirm.value);
const valid = computed(
  () => current.value.length > 0 && matches.value && Object.values(checks.value).every(Boolean),
);

async function submit() {
  if (!valid.value || loading.value) return;
  error.value = '';
  loading.value = true;
  try {
    await auth.changePassword(current.value, next.value);
    await setup.mark({ password: true });
    emit('next');
  } catch (err) {
    error.value = apiError(err);
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.fr-gap {
  margin-top: 18px;
}
.fr-switch-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 0.85rem;
  font-weight: 400;
  margin-top: 4px;
}
.fr-bad {
  color: var(--cid-red-500);
}
.w-full {
  width: 100%;
}
</style>
