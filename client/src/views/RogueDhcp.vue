<template>
  <div class="rogue-dhcp-page">
    <p class="section-hint">
      Periodically broadcasts a DHCP DISCOVER and flags any DHCP server that answers but isn't
      CIDRella's own or on the authorized list.
      <template v-if="ipv6Supported">
        With IPv6 on it also solicits DHCPv6 servers and reads the routers the kernel accepted
        Router Advertisements from.
      </template>
      Detection only. CIDRella can't block a rogue server. Only servers on the same network segment
      as a CIDRella interface are visible.
    </p>

    <!-- Settings -->
    <div class="rd-section">
      <h4>Detection</h4>
      <div class="rd-settings">
        <div class="rd-row">
          <ToggleSwitch v-model="settingsForm.enabled" data-track="rogue-dhcp-toggle-enabled" />
          <span>Enable rogue DHCP detection</span>
        </div>
        <div class="rd-row">
          <label>Probe every</label>
          <InputNumber
            v-model="settingsForm.intervalMin"
            size="small"
            :min="5"
            :max="1440"
            :step="5"
            suffix=" min"
            style="width: 9rem"
          />
        </div>
        <p v-if="status && status.probeSupported === false" class="rd-warn">
          Could not bind UDP port 68 on this host (another DHCP client may be using it). Detection
          is unavailable until that's resolved.
        </p>
        <p v-else-if="status && status.stale" class="rd-warn" data-track="rogue-dhcp-stale-warning">
          Detection is enabled but has not probed
          {{ status.lastProbeAt ? 'since ' + formatDate(status.lastProbeAt) : 'at all yet' }}.
          Nothing is currently watching for rogue DHCP servers.
          <template v-if="status.lastProbeError">
            Last error: {{ status.lastProbeError }}.</template
          >
        </p>
        <p v-else-if="status" class="rd-status">
          Last probe: {{ status.lastProbeAt ? formatDate(status.lastProbeAt) : 'never' }}
        </p>
        <template v-if="ipv6Supported && status">
          <p class="rd-status" data-track="rogue-dhcpv6-status">DHCPv6: {{ dhcpv6Line }}</p>
          <p class="rd-status" data-track="rogue-ra-status">Router Advertisements: {{ raLine }}</p>
        </template>
        <div class="rd-actions">
          <Button
            label="Save"
            icon="pi pi-save"
            size="small"
            data-track="rogue-dhcp-save-settings"
            @click="saveSettings"
            :loading="savingSettings"
            :disabled="!settingsDirty"
          />
          <Button
            label="Probe now"
            icon="pi pi-search"
            size="small"
            severity="secondary"
            data-track="rogue-dhcp-probe-now"
            @click="probeNow"
            :loading="probing"
            :disabled="!settingsForm.enabled"
          />
        </div>
      </div>
    </div>

    <!-- Detected rogue servers -->
    <div class="rd-section">
      <div class="rd-section-head">
        <h4>Detected rogue servers</h4>
        <Button
          v-if="hasUnacknowledged"
          label="Acknowledge all"
          size="small"
          severity="secondary"
          data-track="rogue-dhcp-ack-all"
          @click="ackAll"
        />
      </div>
      <DataTable
        :value="store.events"
        :loading="store.loading"
        size="small"
        dataKey="id"
        :rows="10"
        paginator
        responsiveLayout="scroll"
        :pt="{ table: { style: 'min-width: 40rem' } }"
      >
        <template #empty>
          <EmptyState
            icon="pi-check-circle"
            title="No rogue DHCP servers detected"
            description="Probes run on the configured interval; anything answering DISCOVER that isn't authorized appears here."
          />
        </template>
        <Column header="Status" style="width: 6rem">
          <template #body="{ data }">
            <StatusBadge
              :kind="data.acknowledged ? 'muted' : 'warn'"
              :label="data.acknowledged ? 'Acked' : 'Rogue'"
            />
          </template>
        </Column>
        <Column header="Kind" style="width: 7rem">
          <template #body="{ data }">
            <StatusBadge kind="muted" :label="kindLabel(data.kind)" />
          </template>
        </Column>
        <Column field="server_ip" header="Server">
          <template #body="{ data }">
            <div>{{ data.server_ip }}</div>
            <div v-if="data.server_duid" class="rd-duid" :title="'DUID ' + data.server_duid">
              {{ data.server_duid }}
            </div>
            <div v-else-if="data.server_mac" class="rd-duid">{{ data.server_mac }}</div>
          </template>
        </Column>
        <Column field="offered_gateway" header="Offered gateway">
          <template #body="{ data }">{{ offeredGateway(data) }}</template>
        </Column>
        <Column field="offered_dns" header="Offered DNS">
          <template #body="{ data }">{{ data.offered_dns || EMPTY_CELL }}</template>
        </Column>
        <Column field="relay_ip" header="Via relay">
          <template #body="{ data }">
            <span
              v-if="data.relay_ip"
              v-tooltip.top="
                'Forwarded by a DHCP relay. The offer may originate from a server elsewhere, including this one.'
              "
            >
              {{ data.relay_ip }}
            </span>
            <span v-else v-tooltip.top="'Answered directly on this segment, no relay in the path'"
              >direct</span
            >
          </template>
        </Column>
        <Column field="iface" header="Interface">
          <template #body="{ data }">{{ data.iface || EMPTY_CELL }}</template>
        </Column>
        <Column field="last_seen_at" header="Last seen">
          <template #body="{ data }">{{ formatDate(data.last_seen_at) }}</template>
        </Column>
        <Column field="times_seen" header="Seen" style="width: 4rem" />
        <Column header="" style="width: 8rem">
          <template #body="{ data }">
            <Button
              v-if="!data.acknowledged"
              icon="pi pi-check"
              text
              rounded
              size="small"
              title="Acknowledge"
              @click="ack(data.id)"
            />
            <Button
              icon="pi pi-trash"
              text
              rounded
              size="small"
              severity="danger"
              title="Clear"
              @click="clear(data.id)"
            />
          </template>
        </Column>
      </DataTable>
    </div>

    <!-- Authorized servers -->
    <div class="rd-section">
      <h4>Authorized DHCP servers</h4>
      <p class="section-hint">
        CIDRella's own DHCP server is always trusted. Add other legitimate servers here so they
        aren't flagged.
        <template v-if="ipv6Supported">
          An entry needs at least one identity: an address of either family, a MAC (routers), or a
          DUID (DHCPv6 servers).
        </template>
      </p>
      <div class="rd-add-form">
        <InputText
          v-model="newAuth.server_ip"
          size="small"
          :placeholder="
            ipv6Supported ? 'Server IP (10.0.0.1 or fe80::1)' : 'Server IP (e.g. 10.0.0.1)'
          "
          style="width: 12rem"
        />
        <InputText
          v-model="newAuth.server_mac"
          size="small"
          placeholder="MAC (optional)"
          style="width: 11rem"
        />
        <InputText
          v-if="ipv6Supported"
          v-model="newAuth.server_duid"
          size="small"
          placeholder="DUID (DHCPv6 server)"
          style="width: 16rem"
          data-track="rogue-dhcp-auth-duid"
        />
        <InputText
          v-model="newAuth.description"
          size="small"
          placeholder="Description (optional)"
          style="width: 14rem"
        />
        <Button
          label="Add"
          icon="pi pi-plus"
          size="small"
          data-track="rogue-dhcp-add-authorized"
          @click="addAuth"
          :loading="addingAuth"
        />
      </div>
      <DataTable :value="store.authorized" size="small" dataKey="id" responsiveLayout="scroll">
        <template #empty>
          <EmptyState
            icon="pi-verified"
            title="No authorized servers"
            description="Add known-good DHCP servers so probes don't flag them as rogue."
          />
        </template>
        <Column field="server_ip" header="Server IP">
          <template #body="{ data }">{{ data.server_ip || EMPTY_CELL }}</template>
        </Column>
        <Column field="server_mac" header="MAC">
          <template #body="{ data }">{{ data.server_mac || EMPTY_CELL }}</template>
        </Column>
        <Column v-if="ipv6Supported" field="server_duid" header="DUID">
          <template #body="{ data }">{{ data.server_duid || EMPTY_CELL }}</template>
        </Column>
        <Column field="description" header="Description">
          <template #body="{ data }">{{ data.description || EMPTY_CELL }}</template>
        </Column>
        <Column header="" style="width: 4rem">
          <template #body="{ data }">
            <Button
              icon="pi pi-trash"
              text
              rounded
              size="small"
              severity="danger"
              title="Remove"
              @click="removeAuth(data.id)"
            />
          </template>
        </Column>
      </DataTable>
    </div>

    <Toast />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { formatDateTime } from '../utils/dateFormat.js';
import { apiError, EMPTY_CELL } from '../utils/format.js';
import { useToast } from '../ui/useToast.js';
import Button from '../ui/Button.js';
import EmptyState from '../components/EmptyState.vue';
import InputText from '../ui/InputText.js';
import InputNumber from '../ui/InputNumber.js';
import DataTable from '../ui/DataTable.js';
import Column from '../ui/Column.js';
import Toast from '../ui/Toast.js';
import ToggleSwitch from '../ui/ToggleSwitch.js';
import StatusBadge from '../components/StatusBadge.vue';
import { useRogueDhcpStore } from '../stores/rogueDhcp.js';
import { useFeatures } from '../composables/useFeatures.js';

const store = useRogueDhcpStore();
const toast = useToast();
const { ipv6: ipv6Supported } = useFeatures();

const KIND_LABELS = { dhcp: 'DHCPv4', dhcpv6: 'DHCPv6', ra: 'Router' };
function kindLabel(kind) {
  return KIND_LABELS[kind] || 'DHCPv4';
}
// A router advertises prefixes, not a gateway; the gateway column is its own address.
function offeredGateway(event) {
  if (event.kind === 'ra') return event.advertised_prefixes || event.offered_gateway || EMPTY_CELL;
  return event.offered_gateway || EMPTY_CELL;
}

// The Probe now toast, one clause per detector that ran.
function probeSummary(res) {
  const parts = [
    `${res.rogueCount} rogue server(s), ${res.offers} offer(s) across ${res.interfaces} interface(s)`,
  ];
  if (ipv6Supported.value && res.dhcpv6 && !res.dhcpv6.disabled) {
    parts.push(
      res.dhcpv6.supported === false
        ? 'DHCPv6 probe unavailable'
        : `${res.dhcpv6.advertisements} DHCPv6 advertisement(s)`,
    );
  }
  if (ipv6Supported.value && res.routerAdvertisements && !res.routerAdvertisements.disabled) {
    parts.push(
      res.routerAdvertisements.supported === false
        ? 'Router Advertisement check unavailable'
        : `${res.routerAdvertisements.routers} advertising router(s)`,
    );
  }
  return `${parts.join('; ')}.`;
}

// One line per IPv6 detector, honest about off, unsupported and unprobed.
const dhcpv6Line = computed(() => {
  const s = status.value?.dhcpv6;
  if (!s) return 'no data';
  if (s.disabled) return 'off (IPv6 support is disabled)';
  if (s.probeSupported === false)
    return `unavailable (${s.lastProbeError || 'cannot bind UDP 546'})`;
  return s.lastProbeAt ? `last probe ${formatDate(s.lastProbeAt)}` : 'not probed yet';
});
const raLine = computed(() => {
  const s = status.value?.routerAdvertisements;
  if (!s) return 'no data';
  if (s.disabled) return 'off (IPv6 support is disabled)';
  if (s.supported === false) {
    const off = (s.unsupportedInterfaces || []).join(', ');
    return `unavailable (accept_ra is off${off ? ' on ' + off : ''})`;
  }
  return s.lastCheckAt ? `last check ${formatDate(s.lastCheckAt)}` : 'not checked yet';
});

const formatDate = formatDateTime;

const status = ref(null);
const settingsForm = ref({ enabled: false, intervalMin: 15 });
const savedSettings = ref(null);
const savingSettings = ref(false);
const probing = ref(false);

const settingsDirty = computed(() => {
  if (!savedSettings.value) return false;
  return (
    settingsForm.value.enabled !== savedSettings.value.enabled ||
    settingsForm.value.intervalMin !== savedSettings.value.intervalMin
  );
});

const hasUnacknowledged = computed(() => store.events.some((e) => !e.acknowledged));

const newAuth = ref({ server_ip: '', server_mac: '', server_duid: '', description: '' });
const addingAuth = ref(false);

async function loadStatus() {
  try {
    const s = await store.fetchStatus();
    status.value = s;
    settingsForm.value = { enabled: !!s.enabled, intervalMin: s.intervalMin || 15 };
    savedSettings.value = { ...settingsForm.value };
  } catch {
    /* ignore */
  }
}

async function saveSettings() {
  savingSettings.value = true;
  try {
    const res = await store.updateSettings({
      enabled: settingsForm.value.enabled,
      intervalMin: settingsForm.value.intervalMin,
    });
    savedSettings.value = { enabled: res.enabled, intervalMin: res.intervalMin };
    settingsForm.value = { ...savedSettings.value };
    toast.add({ severity: 'success', summary: 'Settings saved', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally {
    savingSettings.value = false;
  }
}

async function probeNow() {
  probing.value = true;
  try {
    const res = await store.probeNow();
    if (res.supported === false) {
      toast.add({
        severity: 'warn',
        summary: 'Probe unavailable',
        detail: 'Could not bind UDP port 68 on this host.',
        life: 6000,
      });
    } else if (res.skipped) {
      toast.add({
        severity: 'warn',
        summary: 'Probe skipped',
        detail:
          res.skipReason === 'in-progress'
            ? 'A probe is already running. Try again in a few seconds.'
            : 'The probe did not run, so nothing was checked.',
        life: 6000,
      });
    } else {
      toast.add({
        severity: 'success',
        summary: 'Probe complete',
        detail: probeSummary(res),
        life: 4000,
      });
    }
    await Promise.all([store.fetchEvents(), loadStatus()]);
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally {
    probing.value = false;
  }
}

async function ack(id) {
  try {
    await store.acknowledge(id);
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  }
}
async function ackAll() {
  try {
    await store.acknowledgeAll();
    toast.add({ severity: 'success', summary: 'All acknowledged', life: 2500 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  }
}
async function clear(id) {
  try {
    await store.clearEvent(id);
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  }
}

async function addAuth() {
  const ip = newAuth.value.server_ip.trim();
  const mac = newAuth.value.server_mac.trim();
  const duid = (newAuth.value.server_duid || '').trim();
  if (!ip && !mac && !duid) {
    toast.add({ severity: 'warn', summary: 'An IP, MAC or DUID is required', life: 3000 });
    return;
  }
  addingAuth.value = true;
  try {
    await store.addAuthorized({
      server_ip: ip || undefined,
      server_mac: mac || undefined,
      server_duid: duid || undefined,
      description: newAuth.value.description.trim() || undefined,
    });
    newAuth.value = { server_ip: '', server_mac: '', server_duid: '', description: '' };
    toast.add({ severity: 'success', summary: 'Server authorized', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally {
    addingAuth.value = false;
  }
}

async function removeAuth(id) {
  try {
    await store.deleteAuthorized(id);
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  }
}

onMounted(async () => {
  await loadStatus();
  await Promise.all([store.fetchEvents(), store.fetchAuthorized()]);
});
</script>

<style scoped>
.rogue-dhcp-page {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  max-width: 60rem;
}
.section-hint {
  font-size: var(--app-fs-xs);
  color: var(--cid-text-muted-color);
  margin: 0 0 0.5rem;
  line-height: 1.4;
}
.rd-section h4 {
  margin: 0 0 0.5rem;
}
.rd-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}
.rd-settings {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.rd-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: var(--app-fs-sm);
}
.rd-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.25rem;
}
.rd-status {
  font-size: var(--app-fs-xs);
  color: var(--cid-text-muted-color);
  margin: 0;
}
.rd-duid {
  font-family: var(--cid-font-mono, monospace);
  font-size: 0.75rem;
  color: var(--cid-text-muted-color);
  word-break: break-all;
}
.rd-warn {
  font-size: var(--app-fs-xs);
  color: var(--cid-status-warn);
  margin: 0;
}
.rd-add-form {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
  align-items: center;
}
</style>
