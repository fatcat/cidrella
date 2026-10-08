<template>
  <Dialog
    :visible="visible"
    header="Resolver performance"
    modal
    :style="{ width: '56rem' }"
    data-track="resolver-test-dialog"
    @update:visible="(v) => !v && close()"
  >
    <p class="muted text-sm intro">
      Each resolver gets a query every 2 seconds for a minute, over {{ protocolLabel }}, straight
      from CIDRella with no local cache. Cached: common names, usually answered from the resolver's
      own cache. Uncached: a random name no resolver has, so it has to ask the domain's servers.
    </p>

    <p v-if="error" class="field-error">{{ error }}</p>

    <template v-else-if="running">
      <ProgressBar :value="progress" :showValue="true" />
      <p class="muted text-sm">Testing {{ countOf(rows.length, 'resolver') }}…</p>
    </template>

    <DataTable
      v-if="rows.length && !running"
      :value="rows"
      size="small"
      stripedRows
      dataKey="id"
      data-track="resolver-test-results"
    >
      <Column header="Resolver">
        <template #body="{ data }">
          <div class="resolver-cell">
            <span>{{ data.label }}</span>
            <StatusBadge v-if="data.fastest" kind="ok" label="Fastest" />
          </div>
          <div v-if="addressLine(data)" class="muted text-sm mono">{{ addressLine(data) }}</div>
        </template>
      </Column>
      <Column header="Cached p50 / p95" :bodyStyle="NOWRAP">
        <template #body="{ data }">{{ timing(data.cached) }}</template>
      </Column>
      <Column header="Uncached p50 / p95" :bodyStyle="NOWRAP">
        <template #body="{ data }">{{ timing(data.uncached) }}</template>
      </Column>
      <Column header="Failed" :bodyStyle="NOWRAP">
        <template #body="{ data }">
          <span :title="data.last_problem || ''">{{ data.failed }} of {{ data.sent }}</span>
        </template>
      </Column>
      <Column header="" :bodyStyle="NOWRAP">
        <template #body="{ data }">
          <div class="action-buttons">
            <Button
              label="Use as primary"
              size="small"
              severity="secondary"
              data-track="resolver-test-use-primary"
              @click="pick('primary', data)"
            />
            <Button
              label="Use as backup"
              size="small"
              severity="secondary"
              text
              data-track="resolver-test-use-backup"
              @click="pick('backup', data)"
            />
          </div>
        </template>
      </Column>
    </DataTable>

    <template #footer>
      <Button
        v-if="running"
        label="Cancel test"
        severity="secondary"
        data-track="resolver-test-cancel"
        @click="close"
      />
      <Button v-else label="Close" severity="secondary" @click="close" />
    </template>
  </Dialog>
</template>

<script setup>
/**
 * Runs the resolver performance test (POST /api/dns/resolver-test) when it
 * opens, polls for progress, and lists the results. Picking a row emits
 * `pick` with the role and the row; the form decides what to do with it and
 * nothing is saved here.
 */
import { computed, onUnmounted, ref, watch } from 'vue';
import Button from '../../ui/Button.js';
import Column from '../../ui/Column.js';
import DataTable from '../../ui/DataTable.js';
import Dialog from '../../ui/Dialog.js';
import ProgressBar from '../../ui/ProgressBar.js';
import StatusBadge from '../StatusBadge.vue';
import { useDnsStore } from '../../stores/dns.js';
import { apiError, countOf, EMPTY_CELL } from '../../utils/format.js';
import { formatMs } from '../../utils/proxy-perf.js';

const POLL_MS = 2000;
// Figures and the actions stay on one line; the resolver's name wraps instead.
const NOWRAP = 'white-space: nowrap';
const PROTOCOL_LABELS = { off: 'plain DNS', tls: 'DNS-over-TLS', https: 'DNS-over-HTTPS' };

const props = defineProps({
  visible: { type: Boolean, required: true },
  mode: { type: String, required: true }, // 'off' | 'tls' | 'https'
  custom: { type: Array, default: () => [] },
});
const emit = defineEmits(['update:visible', 'pick']);

const store = useDnsStore();
const runId = ref(null);
const state = ref(null);
const progress = ref(0);
const rows = ref([]);
const error = ref('');
let timer = null;

const running = computed(() => state.value === 'running');
const protocolLabel = computed(() => PROTOCOL_LABELS[props.mode] || props.mode);

function timing(t) {
  if (!t || t.p50 == null) return EMPTY_CELL;
  return `${formatMs(t.p50)} / ${formatMs(t.p95)} ms`;
}
// The hostname and addresses under the name; nothing when the name already
// is the addresses (a custom plaintext resolver).
function addressLine(row) {
  const addresses = row.addresses.join(', ');
  if (row.hostname && props.mode !== 'off') return `${row.hostname} · ${addresses}`;
  return row.label === addresses ? '' : addresses;
}

function stopPolling() {
  clearTimeout(timer);
  timer = null;
}

async function poll() {
  try {
    const run = await store.getResolverTest(runId.value);
    state.value = run.state;
    progress.value = run.progress_pct;
    rows.value = run.results;
    if (run.state === 'running') timer = setTimeout(poll, POLL_MS);
  } catch (err) {
    error.value = apiError(err);
    state.value = null;
  }
}

async function start() {
  stopPolling();
  error.value = '';
  rows.value = [];
  progress.value = 0;
  try {
    runId.value = (await store.startResolverTest(props.mode, props.custom)).id;
    state.value = 'running';
    timer = setTimeout(poll, POLL_MS);
  } catch (err) {
    // One test runs at a time. A test of this mode already going (the page
    // was left and opened again) is followed; one of another mode is named.
    const busy = err?.response?.status === 409 ? err.response.data : null;
    if (busy?.id && busy.mode === props.mode) {
      runId.value = busy.id;
      state.value = 'running';
      await poll();
      return;
    }
    error.value = busy?.mode
      ? `A ${PROTOCOL_LABELS[busy.mode] || busy.mode} test is already running. It ends within a minute.`
      : apiError(err);
  }
}

async function close() {
  stopPolling();
  if (running.value && runId.value) {
    state.value = 'cancelled';
    try {
      await store.cancelResolverTest(runId.value);
    } catch {
      /* it ends on its own within the minute */
    }
  }
  emit('update:visible', false);
}

function pick(role, row) {
  emit('pick', role, row);
}

watch(
  () => props.visible,
  (open) => (open ? start() : stopPolling()),
  { immediate: true },
);
onUnmounted(stopPolling);
</script>

<style scoped>
.intro {
  margin: 0 0 1rem;
  line-height: 1.4;
}
.resolver-cell {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
</style>
