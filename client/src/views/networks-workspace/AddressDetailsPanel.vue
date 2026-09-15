<template>
  <aside class="workspace-address-panel" data-track="workspace-address-details">
    <div class="panel-head">
      <div>
        <span class="eyebrow">IP ADDRESS</span><strong>{{ row.address }}</strong>
      </div>
      <button class="icon-button" aria-label="Close details" @click="emit('close')">
        <i class="pi pi-times" />
      </button>
    </div>

    <div class="identity">
      <span class="identity-orb" :class="row.online || 'unknown'"><i :class="identityIcon" /></span>
      <div>
        <strong>{{ row.hostname || row.address }}</strong>
        <small>{{ row.type || row.status || 'Available' }} · {{ networkName }}</small>
      </div>
    </div>

    <div v-if="feedback" class="feedback" :class="feedback.tone" role="status">
      <i :class="feedback.tone === 'error' ? 'pi pi-exclamation-circle' : 'pi pi-check-circle'" />
      <span>{{ feedback.message }}</span>
    </div>

    <div class="panel-tabs" role="tablist" aria-label="Address details">
      <button
        v-for="tab in availableTabs"
        :key="tab.id"
        role="tab"
        :aria-selected="activeTab === tab.id"
        :class="{ active: activeTab === tab.id }"
        @click="activeTab = tab.id"
      >
        {{ tab.label }}
      </button>
    </div>

    <dl v-if="activeTab === 'overview'">
      <dt>Status</dt>
      <dd>{{ row.status || dash }}</dd>
      <dt>Allocation</dt>
      <dd>{{ allocationLabel }}</dd>
      <dt>Hostname</dt>
      <dd>{{ row.hostname || dash }}</dd>
      <dt>MAC address</dt>
      <dd>{{ row.mac || dash }}</dd>
      <dt>Online</dt>
      <dd class="capitalize">{{ row.online || 'unknown' }}</dd>
      <dt>Last seen</dt>
      <dd>{{ row.lastSeen || dash }}</dd>
      <dt>Scanning</dt>
      <dd>{{ row.scanning || dash }}</dd>
      <dt>Source</dt>
      <dd>{{ row.source || dash }}</dd>
      <template v-if="raw.reservation_note">
        <dt>Reservation note</dt>
        <dd>{{ raw.reservation_note }}</dd>
      </template>
    </dl>

    <section v-if="activeTab === 'overview'" class="panel-section">
      <span class="eyebrow">RELATED RESOURCES</span>
      <button class="related-button" @click="navigateRelated('dns')">
        <i class="pi pi-globe" /><span
          ><strong>DNS records</strong
          ><small>{{ dnsCount }} records reference this address</small></span
        ><i class="pi pi-chevron-right" />
      </button>
      <button class="related-button" @click="navigateRelated('dhcp')">
        <i class="pi pi-server" /><span
          ><strong>DHCP identity</strong><small>{{ dhcpCount }} related rows</small></span
        ><i class="pi pi-chevron-right" />
      </button>
    </section>

    <section v-if="activeTab === 'overview'" class="panel-section">
      <span class="eyebrow">COPY</span>
      <div class="quick-actions">
        <button data-track="workspace-copy-address" @click="copyValue('address', row.address)">
          Copy address
        </button>
        <button v-if="row.hostname" @click="copyValue('hostname', row.hostname)">
          Copy hostname
        </button>
        <button v-if="macAddress" @click="copyValue('MAC address', macAddress)">Copy MAC</button>
        <button @click="openNetwork">Open network</button>
      </div>
    </section>

    <section v-if="activeTab === 'overview' && canWrite" class="panel-section">
      <span class="eyebrow">ADDRESS ACTIONS</span>
      <div class="quick-actions">
        <button
          v-if="canWrite && canReserve"
          data-track="workspace-create-ip-reservation"
          @click="reservationMode = 'create'"
        >
          Create IP Reservation
        </button>
        <button
          v-if="canWrite && isReserved"
          class="danger"
          data-track="workspace-release-ip-reservation"
          @click="reservationMode = 'release'"
        >
          Release IP Reservation
        </button>
        <button
          :disabled="busyAction === 'probe' || !supportsProbe"
          :title="
            supportsProbe ? '' : 'Manual probing is currently available for IPv4 addresses only.'
          "
          data-track="workspace-probe-address"
          @click="probeNow"
        >
          <i v-if="busyAction === 'probe'" class="pi pi-spin pi-spinner" /> Probe now
        </button>
      </div>

      <form
        v-if="reservationMode === 'create'"
        class="inline-action"
        @submit.prevent="createReservation"
      >
        <label for="workspace-reservation-note">Reservation note</label>
        <textarea
          id="workspace-reservation-note"
          v-model="reservationNote"
          maxlength="1024"
          rows="3"
          required
          placeholder="Why is this address being held?"
        />
        <div>
          <button type="button" @click="reservationMode = null">Cancel</button
          ><button class="primary" :disabled="!reservationNote.trim() || busyAction === 'reserve'">
            Reserve address
          </button>
        </div>
      </form>

      <div v-else-if="reservationMode === 'release'" class="inline-action confirm-action">
        <strong>Release this IP Reservation?</strong>
        <p>The address will return to DHCP Scope or available status according to server policy.</p>
        <div>
          <button @click="reservationMode = null">Cancel</button
          ><button
            class="danger solid"
            :disabled="busyAction === 'release'"
            @click="releaseReservation"
          >
            Release reservation
          </button>
        </div>
      </div>
    </section>

    <section v-if="activeTab === 'overview' && canWrite" class="panel-section">
      <span class="eyebrow">SCANNING POLICY</span>
      <div class="segmented" aria-label="Address scanning policy">
        <button
          v-for="choice in scanChoices"
          :key="choice.label"
          :class="{ active: scanOverride === choice.value }"
          :disabled="busyAction === 'scan'"
          :data-track="`workspace-scan-${choice.track}`"
          @click="setScanEnabled(choice.value)"
        >
          {{ choice.label }}
        </button>
      </div>
      <small class="section-help"
        >Effective setting: {{ effectiveScanningLabel }}. Inherit follows the network and global
        defaults.</small
      >
    </section>

    <section v-if="activeTab === 'lifecycle'" class="panel-section lifecycle-section">
      <div class="section-title">
        <span class="eyebrow">IP LIFECYCLE</span>
        <button
          :disabled="eventsLoading"
          aria-label="Refresh lifecycle history"
          @click="loadEvents(eventsLimit)"
        >
          <i class="pi pi-refresh" />
        </button>
      </div>
      <div v-if="eventsLoading" class="events-state">
        <i class="pi pi-spin pi-spinner" /> Loading history…
      </div>
      <div v-else-if="eventsError" class="events-state error-state">{{ eventsError }}</div>
      <div v-else-if="!events.length" class="events-state">
        No lifecycle events recorded for this address.
      </div>
      <div v-else class="events-list">
        <div class="history-scope">Latest {{ eventsLimit }}</div>
        <div
          v-for="(event, index) in events"
          :key="event.id || `${event.event_type}:${event.created_at}:${index}`"
          class="event-row"
        >
          <span class="event-marker" :class="eventTone(event.event_type)"><i /></span>
          <div>
            <strong>{{ eventLabel(event.event_type) }}</strong
            ><small>{{ eventDetail(event) || 'State recorded' }}</small>
          </div>
          <time>{{ formatEventTime(event.created_at) }}</time>
        </div>
        <button v-if="eventsLimit === 100" class="show-events" @click="loadEvents(500)">
          Load Latest 500
        </button>
      </div>
    </section>

    <section v-if="activeTab === 'device'" class="panel-section device-section">
      <div class="section-title">
        <span class="eyebrow">DEVICE FACTS</span>
        <button :disabled="deviceLoading" aria-label="Refresh device facts" @click="loadDevice">
          <i class="pi pi-refresh" />
        </button>
      </div>
      <div v-if="deviceLoading" class="events-state">
        <i class="pi pi-spin pi-spinner" /> Loading device facts…
      </div>
      <div v-else-if="deviceError" class="events-state error-state">{{ deviceError }}</div>
      <template v-else>
        <dl class="device-facts">
          <dt>MAC address</dt>
          <dd>{{ macAddress }}</dd>
          <dt>Vendor</dt>
          <dd>{{ device.vendor || raw.vendor || dash }}</dd>
          <dt>Device type</dt>
          <dd>{{ device.device_type || dash }}</dd>
          <dt>OS family</dt>
          <dd>{{ device.os_family || dash }}</dd>
          <dt>Confidence</dt>
          <dd>{{ deviceConfidence }}</dd>
          <dt>Source</dt>
          <dd>{{ device.source || raw.device_fingerprint_source || dash }}</dd>
          <dt>Fingerprint</dt>
          <dd>{{ device.dhcp_fingerprint || raw.dhcp_fingerprint || dash }}</dd>
          <dt>Vendor class</dt>
          <dd>
            {{ device.vendor_class || device.dhcp_vendor_class || raw.dhcp_vendor_class || dash }}
          </dd>
          <dt>Fingerprint hostname</dt>
          <dd>
            {{
              device.hostname ||
              device.dhcp_fingerprint_hostname ||
              raw.dhcp_fingerprint_hostname ||
              dash
            }}
          </dd>
        </dl>
        <form v-if="canWriteDevice" class="inline-action" @submit.prevent="saveDeviceOverride">
          <label for="workspace-device-type">Device type</label>
          <input id="workspace-device-type" v-model="deviceForm.device_type" maxlength="64" />
          <label for="workspace-os-family">OS family</label>
          <input id="workspace-os-family" v-model="deviceForm.os_family" maxlength="64" />
          <div>
            <button type="button" :disabled="deviceSaving" @click="resetDeviceOverride">
              Reset to detected
            </button>
            <button class="primary" :disabled="deviceSaving">Save override</button>
          </div>
        </form>
        <div class="device-history">
          <strong>Changes in the last 90 days</strong>
          <div v-if="!deviceHistory.length" class="events-state">
            No device classification changes.
          </div>
          <div
            v-for="(change, index) in deviceHistory"
            :key="change.id || index"
            class="device-change"
          >
            {{ formatEventTime(change.created_at || change.changed_at) }} ·
            {{ deviceChangeDetail(change) }}
          </div>
        </div>
      </template>
    </section>
  </aside>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import api from '../../api/client.js';
import { apiError, EMPTY_CELL } from '../../utils/format.js';
import { eventDetail, eventLabel, eventTone } from '../../utils/ipLifecycleEvents.js';

const props = defineProps({
  row: { type: Object, required: true },
  subnetId: { type: [Number, String], required: true },
  networkName: { type: String, default: '' },
  dnsCount: { type: Number, default: 0 },
  dhcpCount: { type: Number, default: 0 },
  canWrite: { type: Boolean, default: false },
  canReadDevice: { type: Boolean, default: false },
  canWriteDevice: { type: Boolean, default: false },
});
const emit = defineEmits(['close', 'navigate', 'changed', 'open-network']);

const dash = EMPTY_CELL;
const events = ref([]);
const eventsLoading = ref(false);
const eventsLimit = ref(100);
const eventsError = ref('');
const activeTab = ref('overview');
const device = ref({});
const deviceHistory = ref([]);
const deviceLoading = ref(false);
const deviceSaving = ref(false);
const deviceError = ref('');
const deviceForm = ref({ device_type: '', os_family: '' });
const reservationMode = ref(null);
const reservationNote = ref('');
const busyAction = ref('');
const feedback = ref(null);
let eventsRequest = 0;

const raw = computed(() => props.row.raw || {});
const macAddress = computed(() => {
  const value = raw.value.mac_address || props.row.mac;
  return value && value !== dash ? String(value) : '';
});
const availableTabs = computed(() => [
  { id: 'overview', label: 'Overview' },
  { id: 'lifecycle', label: 'Lifecycle' },
  ...(props.canReadDevice && macAddress.value ? [{ id: 'device', label: 'Device' }] : []),
]);
const isReserved = computed(() => raw.value.allocation_state === 'reserved');
const canReserve = computed(() => raw.value.allocation_state === 'unassigned');
const allocationLabel = computed(
  () => props.row.type || String(raw.value.allocation_state || 'unassigned').replaceAll('_', ' '),
);
const identityIcon = computed(() =>
  props.row.type === 'gateway'
    ? 'pi pi-directions'
    : props.row.type === 'system'
      ? 'pi pi-shield'
      : 'pi pi-desktop',
);
const scanOverride = computed(() => {
  if (raw.value.scan_enabled == null) return null;
  return raw.value.scan_enabled === true || raw.value.scan_enabled === 1 ? 1 : 0;
});
const effectiveScanningLabel = computed(() =>
  raw.value.scanning_enabled == null
    ? 'Unknown'
    : raw.value.scanning_enabled === true || raw.value.scanning_enabled === 1
      ? 'On'
      : 'Off',
);
const supportsProbe = computed(
  () => !raw.value.address_family || Number(raw.value.address_family) === 4,
);
const deviceConfidence = computed(() => {
  const value = device.value.confidence ?? raw.value.device_confidence;
  return value == null ? dash : `${value}%`;
});
const scanChoices = [
  { label: 'Inherit', value: null, track: 'inherit' },
  { label: 'On', value: 1, track: 'on' },
  { label: 'Off', value: 0, track: 'off' },
];

function setFeedback(message, tone = 'success') {
  feedback.value = { message, tone };
}

async function loadEvents(limit = 100) {
  const request = ++eventsRequest;
  eventsLoading.value = true;
  eventsError.value = '';
  try {
    const { data } = await api.get(
      `/subnets/${props.subnetId}/ips/${encodeURIComponent(props.row.address)}/events?limit=${limit}`,
    );
    if (request === eventsRequest) {
      events.value = data.events || [];
      eventsLimit.value = limit;
    }
  } catch (error) {
    if (request === eventsRequest)
      eventsError.value = `Could not load lifecycle history: ${apiError(error)}`;
  } finally {
    if (request === eventsRequest) eventsLoading.value = false;
  }
}

function stableIdentity() {
  return {
    kind: 'ip',
    subnet_id: props.subnetId,
    ip_address: raw.value.ip_address || props.row.address,
    address_family: raw.value.address_family || null,
  };
}

function navigateRelated(view) {
  emit('navigate', view, stableIdentity());
}

function openNetwork() {
  emit('open-network', { kind: 'network', subnet_id: props.subnetId });
}

async function copyValue(label, value) {
  try {
    await navigator.clipboard.writeText(String(value));
    setFeedback(`${label[0].toUpperCase()}${label.slice(1)} copied.`);
  } catch {
    setFeedback(`Could not copy ${label}.`, 'error');
  }
}

async function loadDevice() {
  if (!props.canReadDevice || !macAddress.value) return;
  deviceLoading.value = true;
  deviceError.value = '';
  try {
    const encodedMac = encodeURIComponent(macAddress.value);
    const [{ data: facts }, { data: history }] = await Promise.all([
      api.get(`/devices/${encodedMac}/fingerprint`),
      api.get(`/devices/${encodedMac}/fingerprint/history?days=90`),
    ]);
    device.value = facts || {};
    deviceHistory.value = Array.isArray(history) ? history : history?.history || [];
    deviceForm.value = {
      device_type: facts?.device_type || '',
      os_family: facts?.os_family || '',
    };
  } catch (error) {
    deviceError.value = `Could not load device facts: ${apiError(error)}`;
  } finally {
    deviceLoading.value = false;
  }
}

async function saveDeviceOverride() {
  if (!props.canWriteDevice || deviceSaving.value) return;
  deviceSaving.value = true;
  try {
    await api.put(`/devices/${encodeURIComponent(macAddress.value)}/fingerprint`, {
      device_type: deviceForm.value.device_type.trim() || null,
      os_family: deviceForm.value.os_family.trim() || null,
    });
    setFeedback('Device classification override saved.');
    await loadDevice();
    emit('changed', 'Device classification override saved');
  } catch (error) {
    setFeedback(apiError(error), 'error');
  } finally {
    deviceSaving.value = false;
  }
}

async function resetDeviceOverride() {
  if (!props.canWriteDevice || deviceSaving.value) return;
  deviceSaving.value = true;
  try {
    await api.delete(`/devices/${encodeURIComponent(macAddress.value)}/fingerprint`);
    setFeedback('Device classification reset to detected values.');
    await loadDevice();
    emit('changed', 'Device classification reset');
  } catch (error) {
    setFeedback(apiError(error), 'error');
  } finally {
    deviceSaving.value = false;
  }
}

async function createReservation() {
  const note = reservationNote.value.trim();
  if (!note || busyAction.value) return;
  busyAction.value = 'reserve';
  feedback.value = null;
  try {
    await api.put(
      `/subnets/${props.subnetId}/ips/${encodeURIComponent(props.row.address)}/allocation`,
      { allocation_state: 'reserved', note },
    );
    reservationMode.value = null;
    setFeedback('IP Reservation created.');
    await loadEvents();
    emit('changed', 'IP Reservation created');
  } catch (error) {
    setFeedback(apiError(error), 'error');
  } finally {
    busyAction.value = '';
  }
}

async function releaseReservation() {
  if (busyAction.value) return;
  busyAction.value = 'release';
  feedback.value = null;
  try {
    await api.put(
      `/subnets/${props.subnetId}/ips/${encodeURIComponent(props.row.address)}/allocation`,
      { allocation_state: 'unassigned', note: null },
    );
    reservationMode.value = null;
    reservationNote.value = '';
    setFeedback('IP Reservation released.');
    await loadEvents();
    emit('changed', 'IP Reservation released');
  } catch (error) {
    setFeedback(apiError(error), 'error');
  } finally {
    busyAction.value = '';
  }
}

async function setScanEnabled(value) {
  if (busyAction.value || scanOverride.value === value) return;
  busyAction.value = 'scan';
  feedback.value = null;
  try {
    await api.put(
      `/subnets/${props.subnetId}/ips/${encodeURIComponent(props.row.address)}/scan-enabled`,
      { scan_enabled: value === null ? null : Boolean(value) },
    );
    const label =
      value === null
        ? 'Scanning now inherits network policy.'
        : `Scanning turned ${value ? 'on' : 'off'} for this address.`;
    setFeedback(label);
    await loadEvents();
    emit('changed', label);
  } catch (error) {
    setFeedback(apiError(error), 'error');
  } finally {
    busyAction.value = '';
  }
}

async function probeNow() {
  if (busyAction.value || !supportsProbe.value) return;
  busyAction.value = 'probe';
  feedback.value = null;
  try {
    const { data } = await api.post('/scans/probe', {
      ip: props.row.address,
      subnet_id: props.subnetId,
    });
    const method = String(data.method || 'probe').toUpperCase();
    const message = data.responded
      ? `${props.row.address} responded via ${method}${data.mac ? ` · ${data.mac}` : ''}.`
      : `${props.row.address} did not respond via ${method}.`;
    setFeedback(message, data.responded ? 'success' : 'warning');
    await loadEvents();
    emit('changed', message);
  } catch (error) {
    setFeedback(apiError(error), 'error');
  } finally {
    busyAction.value = '';
  }
}

function formatEventTime(value) {
  if (!value) return dash;
  const date = new Date(String(value).match(/Z|[+-]\d{2}:\d{2}$/) ? value : `${value}Z`);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function deviceChangeDetail(change) {
  if (change.field) {
    const field = String(change.field).replaceAll('_', ' ');
    const values = [change.previous_value, change.new_value]
      .map((value) => value || dash)
      .join(' → ');
    return `${field}: ${values}`;
  }
  return change.device_type || change.os_family || change.vendor_class || 'Classification changed';
}

watch(
  () => [props.subnetId, props.row.address],
  () => {
    events.value = [];
    feedback.value = null;
    reservationMode.value = null;
    reservationNote.value = raw.value.reservation_note || '';
    activeTab.value = 'overview';
    device.value = {};
    deviceHistory.value = [];
    loadEvents(100);
  },
  { immediate: true },
);

watch(activeTab, (tab) => {
  if (tab === 'device' && !deviceLoading.value) loadDevice();
});
</script>

<style scoped>
.workspace-address-panel {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 4;
  display: flex;
  width: min(350px, 92%);
  flex-direction: column;
  overflow-y: auto;
  border-left: 1px solid var(--preview-line);
  color: var(--cid-text-color);
  background: var(--cid-surface-card);
  box-shadow: -12px 0 32px rgba(15, 23, 42, 0.13);
}
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.85rem;
  border-bottom: 1px solid var(--preview-line);
}
.panel-head > div {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.panel-head strong {
  font-size: 0.92rem;
}
.icon-button {
  display: inline-flex;
  width: 2rem;
  height: 2rem;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 7px;
  background: transparent;
  cursor: pointer;
}
.icon-button:hover {
  color: var(--preview-accent);
  background: var(--preview-accent-soft);
}
.eyebrow {
  color: var(--preview-accent);
  font-size: var(--workspace-font-small);
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.identity {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  padding: 0.9rem;
  border-bottom: 1px solid var(--preview-line);
}
.identity-orb {
  display: inline-flex;
  width: 2.5rem;
  height: 2.5rem;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  color: var(--cid-green-600);
  background: color-mix(in srgb, var(--cid-green-500) 12%, transparent);
}
.identity-orb.offline,
.identity-orb.unknown {
  color: var(--preview-muted);
  background: var(--cid-surface-ground);
}
.identity > div {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 0.14rem;
}
.identity strong {
  overflow: hidden;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--workspace-font-body);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.identity small {
  overflow: hidden;
  color: var(--preview-muted);
  font-size: var(--workspace-font-small);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.feedback {
  display: flex;
  align-items: flex-start;
  gap: 0.4rem;
  padding: 0.55rem 0.9rem;
  border-bottom: 1px solid var(--preview-line);
  color: var(--cid-green-700);
  background: color-mix(in srgb, var(--cid-green-500) 9%, transparent);
  font-size: var(--workspace-font-small);
}
.feedback.warning {
  color: var(--cid-orange-700);
  background: color-mix(in srgb, var(--cid-orange-500) 10%, transparent);
}
.feedback.error {
  color: var(--cid-red-700);
  background: color-mix(in srgb, var(--cid-red-500) 9%, transparent);
}
.panel-tabs {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  padding: 0.35rem 0.9rem 0;
  border-bottom: 1px solid var(--preview-line);
}
.panel-tabs button {
  padding: 0.5rem 0.25rem;
  border: 0;
  border-bottom: 2px solid transparent;
  color: var(--preview-muted);
  background: transparent;
  font-size: var(--workspace-font-body);
  cursor: pointer;
}
.panel-tabs button.active {
  border-bottom-color: var(--preview-accent);
  color: var(--preview-accent);
  font-weight: 700;
}
dl {
  display: grid;
  grid-template-columns: 42% 58%;
  margin: 0;
  padding: 0.7rem 0.9rem;
  border-bottom: 1px solid var(--preview-line);
  font-size: var(--workspace-font-body);
}
dt,
dd {
  padding: 0.32rem 0;
  border-bottom: 1px solid color-mix(in srgb, var(--preview-line) 55%, transparent);
}
dt {
  color: var(--preview-muted);
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.capitalize {
  text-transform: capitalize;
}
.panel-section {
  display: grid;
  gap: 0.42rem;
  padding: 0.75rem 0.9rem;
  border-bottom: 1px solid var(--preview-line);
}
.related-button {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 0.5rem;
  padding: 0.48rem;
  border: 1px solid var(--preview-line);
  border-radius: 7px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.related-button:hover {
  border-color: var(--preview-accent);
  background: var(--preview-accent-soft);
}
.related-button > i:first-child {
  color: var(--preview-accent);
}
.related-button > i:last-child {
  color: var(--preview-muted);
  font-size: var(--workspace-font-small);
}
.related-button span {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 0.1rem;
}
.related-button strong {
  font-size: var(--workspace-font-body);
}
.related-button small,
.section-help {
  color: var(--preview-muted);
  font-size: var(--workspace-font-small);
}
.quick-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.32rem;
}
.quick-actions button,
.inline-action button {
  display: inline-flex;
  min-height: 1.9rem;
  align-items: center;
  gap: 0.3rem;
  padding: 0 0.5rem;
  border: 1px solid var(--preview-line);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font-size: var(--workspace-font-body);
  cursor: pointer;
}
.quick-actions button:hover,
.inline-action button:hover {
  color: var(--preview-accent);
  border-color: var(--preview-accent);
}
.quick-actions button.danger,
.inline-action button.danger {
  color: var(--cid-red-600);
}
.quick-actions button:disabled,
.inline-action button:disabled {
  opacity: 0.55;
  cursor: wait;
}
.inline-action {
  display: grid;
  gap: 0.4rem;
  margin-top: 0.25rem;
  padding: 0.6rem;
  border: 1px solid color-mix(in srgb, var(--preview-accent) 35%, var(--preview-line));
  border-radius: 8px;
  background: var(--preview-accent-soft);
}
.inline-action label,
.inline-action strong {
  font-size: var(--workspace-font-body);
}
.inline-action textarea,
.inline-action input {
  width: 100%;
  resize: vertical;
  box-sizing: border-box;
  padding: 0.45rem;
  border: 1px solid var(--preview-line);
  border-radius: 6px;
  outline: 0;
  color: inherit;
  background: var(--cid-surface-card);
  font: inherit;
}
.inline-action textarea:focus,
.inline-action input:focus {
  border-color: var(--preview-accent);
}
.inline-action > div {
  display: flex;
  justify-content: flex-end;
  gap: 0.35rem;
}
.inline-action button.primary {
  border-color: var(--preview-accent);
  color: var(--cid-primary-contrast-color, white);
  background: var(--preview-accent);
}
.inline-action button.danger.solid {
  border-color: var(--cid-red-500);
  color: white;
  background: var(--cid-red-500);
}
.confirm-action p {
  margin: 0;
  color: var(--preview-muted);
  font-size: var(--workspace-font-small);
  line-height: 1.4;
}
.segmented {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  padding: 0.16rem;
  border-radius: 7px;
  background: var(--cid-surface-ground);
}
.segmented button {
  min-height: 1.8rem;
  border: 0;
  border-radius: 5px;
  color: var(--preview-muted);
  background: transparent;
  font-size: var(--workspace-font-body);
  cursor: pointer;
}
.segmented button.active {
  color: var(--preview-accent);
  background: var(--cid-surface-card);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}
.segmented button:disabled {
  opacity: 0.55;
  cursor: wait;
}
.lifecycle-section {
  flex: 1;
  align-content: start;
}
.section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.section-title button {
  width: 1.7rem;
  height: 1.7rem;
  border: 0;
  border-radius: 5px;
  color: var(--preview-muted);
  background: transparent;
  cursor: pointer;
}
.section-title button:hover {
  color: var(--preview-accent);
  background: var(--preview-accent-soft);
}
.events-state {
  display: flex;
  min-height: 5rem;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  color: var(--preview-muted);
  font-size: var(--workspace-font-body);
  text-align: center;
}
.events-state.error-state {
  color: var(--cid-red-700);
}
.history-scope {
  padding: 0.2rem 0 0.35rem;
  color: var(--preview-muted);
  font-size: var(--workspace-font-small);
  font-weight: 700;
}
.events-list {
  display: grid;
}
.event-row {
  display: grid;
  grid-template-columns: 0.7rem 1fr auto;
  align-items: start;
  gap: 0.42rem;
  padding: 0.48rem 0;
  border-bottom: 1px solid color-mix(in srgb, var(--preview-line) 55%, transparent);
}
.event-marker {
  display: inline-flex;
  width: 0.55rem;
  height: 0.55rem;
  margin-top: 0.18rem;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: color-mix(in srgb, var(--preview-accent) 18%, transparent);
}
.event-marker i {
  width: 0.25rem;
  height: 0.25rem;
  border-radius: 50%;
  background: var(--preview-accent);
}
.event-marker.good i {
  background: var(--cid-green-500);
}
.event-marker.danger i {
  background: var(--cid-red-500);
}
.event-marker.muted i {
  background: var(--cid-surface-400);
}
.event-marker.warn i {
  background: var(--cid-orange-500);
}
.event-row > div {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 0.08rem;
}
.event-row strong {
  font-size: var(--workspace-font-body);
}
.event-row small,
.event-row time {
  color: var(--preview-muted);
  font-size: var(--workspace-font-small);
}
.event-row time {
  white-space: nowrap;
}
.show-events {
  justify-self: start;
  margin-top: 0.4rem;
  padding: 0;
  border: 0;
  color: var(--preview-accent);
  background: none;
  font-size: var(--workspace-font-body);
  font-weight: 700;
  cursor: pointer;
}
.device-section {
  align-content: start;
}
.device-facts {
  margin: 0 -0.9rem;
  border-top: 1px solid var(--preview-line);
}
.device-history {
  display: grid;
  gap: 0.35rem;
  margin-top: 0.25rem;
  font-size: var(--workspace-font-body);
}
.device-change {
  padding: 0.35rem 0;
  border-bottom: 1px solid color-mix(in srgb, var(--preview-line) 55%, transparent);
  color: var(--preview-muted);
  font-size: var(--workspace-font-small);
}
@media (max-width: 820px) {
  .workspace-address-panel {
    position: fixed;
  }
}
</style>
