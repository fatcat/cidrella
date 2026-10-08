<template>
  <section v-if="visible" class="apply-status" aria-label="Configuration apply status">
    <div>
      <strong>Appliance configuration needs attention</strong>
      <p v-for="generation in attentionGenerations" :key="generation.hook_name">
        {{ generationLabel(generation.hook_name) }}: desired {{ generation.desired_generation }},
        applied {{ generation.applied_generation }} · {{ generation.status
        }}<template v-if="generation.last_error"> · {{ generation.last_error }}</template>
      </p>
      <p v-if="diagnosticSummary">{{ diagnosticSummary }}</p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
    </div>
    <div class="apply-actions">
      <button v-if="canDnsWrite" :disabled="busy" @click="apply('dns')">Apply DNS</button>
      <button v-if="canDhcpWrite" :disabled="busy" @click="apply('dhcp')">Apply DHCP</button>
      <button v-if="isAdmin && !confirmRepair" :disabled="busy" @click="confirmRepair = true">
        Review repair
      </button>
      <template v-if="isAdmin && confirmRepair">
        <span>Repair server-derived network/DHCP projections?</span>
        <button :disabled="busy" @click="confirmRepair = false">Cancel</button>
        <button class="danger" :disabled="busy" @click="repair">Repair derived state</button>
      </template>
      <button :disabled="busy" aria-label="Refresh apply status" @click="refresh">Refresh</button>
    </div>
  </section>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import api from '../../api/client.js';
import { apiError } from '../../utils/format.js';

const props = defineProps({
  canRead: { type: Boolean, default: false },
  canDnsWrite: { type: Boolean, default: false },
  canDhcpWrite: { type: Boolean, default: false },
  isAdmin: { type: Boolean, default: false },
});
const emit = defineEmits(['changed']);
const generations = ref([]);
const lifecycleDiagnostics = ref(null);
const networkDhcpDiagnostics = ref(null);
const busy = ref(false);
const error = ref('');
const confirmRepair = ref(false);

const attentionGenerations = computed(() =>
  generations.value.filter(
    (item) =>
      item.status !== 'applied' ||
      Number(item.desired_generation) > Number(item.applied_generation) ||
      item.last_error,
  ),
);
const diagnosticCount = computed(
  () => issueCount(lifecycleDiagnostics.value) + issueCount(networkDhcpDiagnostics.value),
);
const diagnosticSummary = computed(() =>
  diagnosticCount.value
    ? `${diagnosticCount.value} lifecycle or network/DHCP diagnostic issue(s) reported by the server.`
    : '',
);
const visible = computed(
  () =>
    props.canRead && (attentionGenerations.value.length || diagnosticCount.value || error.value),
);

function issueCount(value) {
  if (!value || typeof value !== 'object') return 0;
  return Object.entries(value).reduce((total, [key, item]) => {
    if (!/(issue|mismatch|orphan|stale|invalid|missing|conflict)/i.test(key)) return total;
    if (Array.isArray(item)) return total + item.length;
    return total + (Number(item) || 0);
  }, 0);
}

function generationLabel(hookName) {
  return String(hookName || 'configuration')
    .replace(/^regenerate_/, '')
    .toUpperCase();
}

async function refresh() {
  if (!props.canRead || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const [generationResponse, lifecycleResponse, networkDhcpResponse] = await Promise.all([
      api.get('/metrics/configuration-generation'),
      api.get('/metrics/ip-lifecycle'),
      api.get('/metrics/network-dhcp'),
    ]);
    generations.value = generationResponse.data || [];
    lifecycleDiagnostics.value = lifecycleResponse.data || {};
    networkDhcpDiagnostics.value = networkDhcpResponse.data || {};
  } catch (requestError) {
    error.value = `Could not load configuration status: ${apiError(requestError)}`;
  } finally {
    busy.value = false;
  }
}

async function apply(kind) {
  if (busy.value || (kind === 'dns' ? !props.canDnsWrite : !props.canDhcpWrite)) return;
  busy.value = true;
  error.value = '';
  try {
    await api.post(`/${kind}/apply`);
    emit('changed', `${kind.toUpperCase()} configuration applied`);
  } catch (requestError) {
    error.value = `Could not apply ${kind.toUpperCase()}: ${apiError(requestError)}`;
  } finally {
    busy.value = false;
  }
  await refresh();
}

async function repair() {
  if (!props.isAdmin || busy.value || !confirmRepair.value) return;
  busy.value = true;
  error.value = '';
  try {
    await api.post('/operations/network-dhcp/repair-derived');
    confirmRepair.value = false;
    emit('changed', 'Derived network/DHCP state repaired');
  } catch (requestError) {
    error.value = `Could not repair derived state: ${apiError(requestError)}`;
  } finally {
    busy.value = false;
  }
  await refresh();
}

onMounted(refresh);
defineExpose({ refresh });
</script>

<style scoped>
.apply-status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  border-bottom: 1px solid var(--cid-orange-400, #f59e0b);
  padding: 0.65rem 0.85rem;
  background: color-mix(in srgb, var(--cid-orange-400, #f59e0b) 12%, var(--cid-surface-card));
}
.apply-status p {
  margin: 0.15rem 0 0;
  font-size: var(--workspace-font-small);
}
.apply-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 0.45rem;
}
.apply-actions button {
  border: 1px solid var(--preview-line);
  border-radius: 6px;
  padding: 0.4rem 0.65rem;
  background: var(--cid-surface-card);
  color: inherit;
  cursor: pointer;
}
.apply-actions .danger,
.error {
  color: var(--cid-red-600);
}
</style>
