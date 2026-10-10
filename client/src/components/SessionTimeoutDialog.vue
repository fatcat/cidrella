<template>
  <Dialog
    :visible="idleWarning || expiryWarning"
    :header="idleWarning ? 'Still there?' : 'Session ending soon'"
    modal
    :style="{ width: '26rem' }"
    data-track="session-timeout-dialog"
    @update:visible="close"
  >
    <p v-if="idleWarning" class="session-timeout-text">
      You will be signed out in <strong class="mono">{{ clock(idleSecondsLeft) }}</strong>
      because nothing has happened on this page for a while.
    </p>
    <p v-else class="session-timeout-text">
      Every session ends 24 hours after sign-in. This one ends at
      <strong>{{ endsAt }}</strong
      >, in <strong class="mono">{{ clock(expirySecondsLeft) }}</strong
      >. Sign in again now so nothing you are working on is lost when it does.
    </p>
    <template #footer>
      <template v-if="idleWarning">
        <Button
          label="Sign out"
          severity="secondary"
          data-track="session-timeout-sign-out"
          @click="emit('sign-out')"
        />
        <Button label="Stay signed in" data-track="session-timeout-stay" @click="emit('stay')" />
      </template>
      <template v-else>
        <Button
          label="Dismiss"
          severity="secondary"
          data-track="session-expiry-dismiss"
          @click="emit('dismiss')"
        />
        <Button
          label="Sign in again"
          data-track="session-expiry-sign-in"
          @click="emit('sign-out')"
        />
      </template>
    </template>
  </Dialog>
</template>

<script setup>
import { computed } from 'vue';
import Dialog from '../ui/Dialog.js';
import Button from '../ui/Button.js';
import { formatTimeOnly } from '../utils/dateFormat.js';

// The warnings before a session ends (composables/useSessionActivity.js).
// Not a ConfirmDialog: closing it is the safe choice, so the X and Escape
// mean "stay" (for inactivity) or "dismiss" (for the 24 hour limit).
const props = defineProps({
  idleWarning: { type: Boolean, default: false },
  expiryWarning: { type: Boolean, default: false },
  idleSecondsLeft: { type: Number, default: null },
  expirySecondsLeft: { type: Number, default: null },
});
const emit = defineEmits(['stay', 'sign-out', 'dismiss']);

const endsAt = computed(() =>
  props.expirySecondsLeft == null
    ? ''
    : formatTimeOnly(new Date(Date.now() + props.expirySecondsLeft * 1000).toISOString()),
);

function clock(seconds) {
  const s = Math.max(0, seconds ?? 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function close(visible) {
  if (visible) return;
  emit(props.idleWarning ? 'stay' : 'dismiss');
}
</script>

<style scoped>
.session-timeout-text {
  margin: 0;
  line-height: 1.5;
}
</style>
