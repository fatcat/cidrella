<!-- Instances > Leases, on the member that serves DHCP: the leases and reservations it
     answers for, read-only. The member's synced copy holds its own lease set (it reports
     its leases to the controller, which syncs them back), so the list is one report and
     one sync behind the daemon. Scopes and reservations are changed on the controller. -->
<template>
  <div class="content-card fill-panel member-leases" data-track="member-leases">
    <div class="card-header">
      <h3>Leases</h3>
      <IconField>
        <InputIcon class="pi pi-search" />
        <InputText
          v-model="search"
          size="small"
          placeholder="Filter leases"
          aria-label="Filter leases"
          data-track="member-leases-filter"
        />
      </IconField>
    </div>
    <p class="field-help help-line">
      The leases this member has handed out and the reservations it serves, as of its last lease
      report to {{ controllerName }} and the sync after it. Scopes and reservations are managed on
      {{ controllerName }}.
    </p>
    <p v-if="error" class="status-line" data-track="member-leases-error">
      <StatusDot kind="err" label="Not loaded" />
      <span>{{ error }}</span>
    </p>
    <DataTable
      :value="rows"
      :loading="loading"
      stripedRows
      size="small"
      scrollable
      scrollHeight="flex"
      :paginator="rows.length > 256"
      :rows="256"
      dataKey="key"
    >
      <template #empty>
        <EmptyState
          icon="pi-server"
          :title="search ? 'No leases match' : 'No leases'"
          :description="
            search
              ? `Nothing matches “${search}”.`
              : 'This member has no leases or reservations yet.'
          "
        />
      </template>
      <Column field="address" header="Address" bodyClass="mono" />
      <Column field="client" header="MAC or DUID" bodyClass="mono" sortable />
      <Column field="hostname" header="Hostname" sortable />
      <Column field="network" header="Network" sortable />
      <Column field="type" header="Type" sortable style="width: 7rem" />
      <Column field="state" header="State" sortable style="width: 7rem">
        <template #body="{ data }">
          <span :class="data.stateClass">{{ data.state }}</span>
        </template>
      </Column>
      <Column field="expires" header="Expires" style="width: 11rem" />
    </DataTable>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import DataTable from '../../ui/DataTable.js';
import Column from '../../ui/Column.js';
import IconField from '../../ui/IconField.js';
import InputIcon from '../../ui/InputIcon.js';
import InputText from '../../ui/InputText.js';
import EmptyState from '../EmptyState.vue';
import StatusDot from '../StatusDot.vue';
import { useDhcpStore } from '../../stores/dhcp.js';
import { useFeatures } from '../../composables/useFeatures.js';
import {
  EMPTY_CELL,
  apiError,
  displayCell,
  displayExpiry,
  displayHostnameCell,
  displayMacAddress,
} from '../../utils/format.js';
import { formatDateTime } from '../../utils/dateFormat.js';
import { dhcpLeaseDisplay } from '../../utils/ipTableDisplay.js';

const dhcp = useDhcpStore();
const { instance } = useFeatures();
const controllerName = computed(() => instance.value.controller_name || 'the controller');

const loading = ref(false);
const error = ref('');
const search = ref('');

const TYPE_LABEL = { reserved: 'Reserved', dynamic: 'Dynamic' };

// One display row per lease or reservation, every cell already worded, so the
// filter matches what is on screen.
function displayRow(row) {
  const reserved = row.dhcp_assignment_type === 'reserved';
  const state = dhcpLeaseDisplay(row.lease_status);
  return {
    key: `${row.dhcp_assignment_type}:${row.id}:${row.ip_address}`,
    address: row.ip_address,
    client: row.duid ? displayCell(row.duid) : displayMacAddress(row.mac_address),
    hostname: displayHostnameCell(row.hostname, row.subnet_domain_name),
    network: displayCell(row.subnet_name || row.subnet_cidr),
    type: TYPE_LABEL[row.dhcp_assignment_type] || EMPTY_CELL,
    state: state?.label || EMPTY_CELL,
    stateClass: state ? `status-text ${state.className}` : 'cell-muted',
    expires: displayExpiry(row.expires_at, formatDateTime, {
      reserved: reserved && !row.expires_at,
    }),
  };
}

const allRows = computed(() => (dhcp.leases || []).map(displayRow));
const rows = computed(() => {
  const needle = search.value.trim().toLowerCase();
  if (!needle) return allRows.value;
  return allRows.value.filter((row) =>
    [row.address, row.client, row.hostname, row.network, row.type, row.state].some((cell) =>
      cell.toLowerCase().includes(needle),
    ),
  );
});

onMounted(async () => {
  loading.value = true;
  try {
    await dhcp.fetchLeases();
    error.value = '';
  } catch (err) {
    error.value = `The leases could not be read: ${apiError(err)}`;
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.help-line {
  margin: 0 0 0.75rem;
}
</style>
