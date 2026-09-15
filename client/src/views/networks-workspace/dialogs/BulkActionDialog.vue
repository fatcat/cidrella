<template>
  <Dialog
    :visible="visible"
    modal
    :header="isReserve ? 'Create IP Reservations' : 'Release IP Reservations'"
    :style="{ width: '34rem', maxWidth: 'calc(100vw - 2rem)' }"
    @update:visible="requestClose"
  >
    <form class="bulk-action-form" @submit.prevent="submit">
      <p>
        {{ selectedCount }} selected address{{ selectedCount === 1 ? '' : 'es' }} in
        {{ runs.length }} exact run{{ runs.length === 1 ? '' : 's' }}.
      </p>
      <ul class="run-list" aria-label="Selected address runs">
        <li v-for="run in runs" :key="`${run.start_ip}-${run.end_ip}`">
          <code>{{ run.start_ip }}</code>
          <template v-if="run.end_ip !== run.start_ip">
            through <code>{{ run.end_ip }}</code></template
          >
          <span>({{ run.count }})</span>
        </li>
      </ul>
      <label v-if="isReserve">
        Reservation note
        <textarea v-model="note" required rows="3" maxlength="500" />
      </label>
      <p v-else class="warning">
        This releases only administrative IP Reservations. It does not release DHCP leases or remove
        DNS records.
      </p>
      <p v-if="ledger" class="result" :class="{ error: ledger.error }" role="status">
        {{ resultMessage }}
      </p>
      <DiscardPrompt v-if="confirmingDiscard" @keep="keepEditing" @discard="discard" />
      <div class="dialog-actions">
        <Button label="Cancel" severity="secondary" :disabled="busy" @click="requestClose()" />
        <Button
          type="submit"
          :label="submitLabel"
          :disabled="busy || !pendingRuns.length || (isReserve && !note.trim())"
          :loading="busy"
        />
      </div>
    </form>
  </Dialog>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import Button from '../../../ui/Button.js';
import Dialog from '../../../ui/Dialog.js';
import { useDiscardGuard } from '../composables/useDiscardGuard.js';
import DiscardPrompt from './DiscardPrompt.vue';
import { executeBulkAllocation } from '../workspace-actions.js';

const props = defineProps({
  visible: { type: Boolean, default: false },
  subnetId: { type: [Number, String], required: true },
  runs: { type: Array, default: () => [] },
  mode: {
    type: String,
    required: true,
    validator: (value) => ['reserve', 'release'].includes(value),
  },
});
const emit = defineEmits(['update:visible', 'complete', 'partial']);
const note = ref('');
const busy = ref(false);
const ledger = ref(null);
const pendingRuns = ref([]);
const isReserve = computed(() => props.mode === 'reserve');
const selectedCount = computed(() => props.runs.reduce((total, run) => total + run.count, 0));
const resultMessage = computed(() => {
  if (!ledger.value) return '';
  const result = `${ledger.value.updated} updated, ${ledger.value.skipped} skipped.`;
  return ledger.value.error
    ? `${result} Stopped with ${ledger.value.remaining.length} failed/not-started run(s).`
    : result;
});
const submitLabel = computed(() => {
  if (ledger.value?.error) return `Retry ${pendingRuns.value.length} remaining run(s)`;
  return isReserve.value ? 'Create reservations' : 'Release reservations';
});

// A typed note is the only thing to lose. After a partial failure the
// remaining runs are also worth a pause before closing.
const {
  confirmingDiscard,
  requestClose,
  keepEditing,
  discard,
  reset: resetGuard,
} = useDiscardGuard({
  busy,
  isDirty: () =>
    (isReserve.value && note.value.trim() !== '') ||
    Boolean(ledger.value?.error && pendingRuns.value.length),
  close: () => emit('update:visible', false),
});

watch(
  () => props.visible,
  (visible) => {
    if (visible) {
      ledger.value = null;
      pendingRuns.value = props.runs.map((run) => ({ ...run }));
      resetGuard();
    }
  },
  { immediate: true },
);

async function submit() {
  if (busy.value || !pendingRuns.value.length || (isReserve.value && !note.value.trim())) return;
  busy.value = true;
  const attempt = await executeBulkAllocation({
    subnetId: props.subnetId,
    runs: pendingRuns.value,
    allocationState: isReserve.value ? 'reserved' : 'unassigned',
    note: note.value,
  });
  const previous = ledger.value;
  ledger.value = {
    completed: [...(previous?.completed || []), ...attempt.completed],
    remaining: attempt.remaining,
    updated: Number(previous?.updated || 0) + attempt.updated,
    skipped: Number(previous?.skipped || 0) + attempt.skipped,
    error: attempt.error,
  };
  pendingRuns.value = attempt.remaining.map((run) => ({ ...run }));
  busy.value = false;
  if (ledger.value.error) emit('partial', ledger.value);
  else emit('complete', ledger.value);
}
</script>

<style scoped>
.bulk-action-form {
  display: grid;
  gap: 1rem;
}
.bulk-action-form p {
  margin: 0;
}
.run-list {
  max-height: 12rem;
  margin: 0;
  padding-left: 1.5rem;
  overflow: auto;
}
.run-list span {
  margin-left: 0.4rem;
  color: var(--cid-text-color-secondary);
}
label {
  display: grid;
  gap: 0.4rem;
  font-weight: 650;
}
textarea {
  width: 100%;
  resize: vertical;
  border: 1px solid var(--cid-surface-border);
  border-radius: 6px;
  padding: 0.65rem;
  background: var(--cid-surface-card);
  color: var(--cid-text-color);
  font: inherit;
}
.warning,
.result.error {
  color: var(--cid-red-600);
}
.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.6rem;
}
</style>
