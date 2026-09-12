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

    <dl>
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

    <section class="panel-section">
      <span class="eyebrow">RELATED RESOURCES</span>
      <button class="related-button" @click="emit('navigate', 'dns')">
        <i class="pi pi-globe" /><span
          ><strong>DNS records</strong
          ><small>{{ dnsCount }} records reference this address</small></span
        ><i class="pi pi-chevron-right" />
      </button>
      <button class="related-button" @click="emit('navigate', 'dhcp')">
        <i class="pi pi-server" /><span
          ><strong>DHCP identity</strong><small>{{ dhcpCount }} related rows</small></span
        ><i class="pi pi-chevron-right" />
      </button>
    </section>

    <section class="panel-section">
      <span class="eyebrow">ADDRESS ACTIONS</span>
      <div class="quick-actions">
        <button
          v-if="canReserve"
          data-track="workspace-create-ip-reservation"
          @click="reservationMode = 'create'"
        >
          Create IP Reservation
        </button>
        <button
          v-if="isReserved"
          class="danger"
          data-track="workspace-release-ip-reservation"
          @click="reservationMode = 'release'"
        >
          Release IP Reservation
        </button>
        <button
          :disabled="busyAction === 'probe'"
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

    <section class="panel-section">
      <span class="eyebrow">SCANNING POLICY</span>
      <div class="segmented" aria-label="Address scanning policy">
        <button
          v-for="choice in scanChoices"
          :key="choice.label"
          :class="{ active: raw.scan_enabled === choice.value }"
          :disabled="busyAction === 'scan'"
          :data-track="`workspace-scan-${choice.track}`"
          @click="setScanEnabled(choice.value)"
        >
          {{ choice.label }}
        </button>
      </div>
      <small class="section-help"
        >Effective setting: {{ raw.scanning_enabled ? 'On' : 'Off' }}. Inherit follows the network
        and global defaults.</small
      >
    </section>

    <section class="panel-section lifecycle-section">
      <div class="section-title">
        <span class="eyebrow">IP LIFECYCLE</span>
        <button
          :disabled="eventsLoading"
          aria-label="Refresh lifecycle history"
          @click="loadEvents"
        >
          <i class="pi pi-refresh" />
        </button>
      </div>
      <div v-if="eventsLoading" class="events-state">
        <i class="pi pi-spin pi-spinner" /> Loading history…
      </div>
      <div v-else-if="!events.length" class="events-state">
        No lifecycle events recorded for this address.
      </div>
      <div v-else class="events-list">
        <div v-for="event in visibleEvents" :key="event.id" class="event-row">
          <span class="event-marker" :class="eventTone(event.event_type)"><i /></span>
          <div>
            <strong>{{ eventLabel(event.event_type) }}</strong
            ><small>{{ eventDetail(event) || 'State recorded' }}</small>
          </div>
          <time>{{ formatEventTime(event.created_at) }}</time>
        </div>
        <button
          v-if="events.length > 6"
          class="show-events"
          @click="showAllEvents = !showAllEvents"
        >
          {{ showAllEvents ? 'Show recent only' : `Show all ${events.length} events` }}
        </button>
      </div>
    </section>
  </aside>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import api from '../../api/client.js';
import { apiError, EMPTY_CELL } from '../../utils/format.js';

const props = defineProps({
  row: { type: Object, required: true },
  subnetId: { type: [Number, String], required: true },
  networkName: { type: String, default: '' },
  dnsCount: { type: Number, default: 0 },
  dhcpCount: { type: Number, default: 0 },
});
const emit = defineEmits(['close', 'navigate', 'changed']);

const dash = EMPTY_CELL;
const events = ref([]);
const eventsLoading = ref(false);
const showAllEvents = ref(false);
const reservationMode = ref(null);
const reservationNote = ref('');
const busyAction = ref('');
const feedback = ref(null);
let eventsRequest = 0;

const raw = computed(() => props.row.raw || {});
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
const visibleEvents = computed(() =>
  showAllEvents.value ? events.value : events.value.slice(0, 6),
);
const scanChoices = [
  { label: 'Inherit', value: null, track: 'inherit' },
  { label: 'On', value: 1, track: 'on' },
  { label: 'Off', value: 0, track: 'off' },
];

function setFeedback(message, tone = 'success') {
  feedback.value = { message, tone };
}

async function loadEvents() {
  const request = ++eventsRequest;
  eventsLoading.value = true;
  try {
    const { data } = await api.get(
      `/subnets/${props.subnetId}/ips/${encodeURIComponent(props.row.address)}/events`,
    );
    if (request === eventsRequest) events.value = data.events || [];
  } catch (error) {
    if (request === eventsRequest)
      setFeedback(`Could not load lifecycle history: ${apiError(error)}`, 'error');
  } finally {
    if (request === eventsRequest) eventsLoading.value = false;
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
  if (busyAction.value || raw.value.scan_enabled === value) return;
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
  if (busyAction.value) return;
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

function eventLabel(type) {
  const labels = {
    online: 'Online',
    offline: 'Offline',
    scanned: 'Scanned',
    rogue_detected: 'Rogue detected',
    rogue_cleared: 'Rogue cleared',
    dns_added: 'DNS added',
    dns_removed: 'DNS removed',
    lease_obtained: 'Lease obtained',
    hostname_changed: 'Hostname changed',
    mac_changed: 'MAC changed',
    allocation_changed: 'Allocation changed',
    status_changed: 'Legacy status changed',
    scan_enabled_changed: 'Scan setting changed',
    retired: 'Metadata Expired',
  };
  return labels[type] || String(type || 'Event').replaceAll('_', ' ');
}

function eventTone(type) {
  if (['online', 'dns_added', 'lease_obtained'].includes(type)) return 'good';
  if (type === 'rogue_detected') return 'danger';
  if (['offline', 'dns_removed', 'retired'].includes(type)) return 'muted';
  return 'info';
}

function eventDetail(event) {
  const values =
    event.old_value && event.new_value
      ? `${event.old_value} → ${event.new_value}`
      : event.new_value || event.old_value || '';
  return [values, event.source ? `via ${String(event.source).replaceAll('_', ' ')}` : '']
    .filter(Boolean)
    .join(' · ');
}

function formatEventTime(value) {
  if (!value) return dash;
  const date = new Date(String(value).match(/Z|[+-]\d{2}:\d{2}$/) ? value : `${value}Z`);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

watch(
  () => [props.subnetId, props.row.address],
  () => {
    events.value = [];
    feedback.value = null;
    reservationMode.value = null;
    reservationNote.value = raw.value.reservation_note || '';
    showAllEvents.value = false;
    loadEvents();
  },
  { immediate: true },
);
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
  color: var(--p-text-color);
  background: var(--p-surface-card);
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
  color: var(--p-green-600);
  background: color-mix(in srgb, var(--p-green-500) 12%, transparent);
}
.identity-orb.offline,
.identity-orb.unknown {
  color: var(--preview-muted);
  background: var(--p-surface-ground);
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
  color: var(--p-green-700);
  background: color-mix(in srgb, var(--p-green-500) 9%, transparent);
  font-size: var(--workspace-font-small);
}
.feedback.warning {
  color: var(--p-orange-700);
  background: color-mix(in srgb, var(--p-orange-500) 10%, transparent);
}
.feedback.error {
  color: var(--p-red-700);
  background: color-mix(in srgb, var(--p-red-500) 9%, transparent);
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
  color: var(--p-red-600);
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
.inline-action textarea {
  width: 100%;
  resize: vertical;
  box-sizing: border-box;
  padding: 0.45rem;
  border: 1px solid var(--preview-line);
  border-radius: 6px;
  outline: 0;
  color: inherit;
  background: var(--p-surface-card);
  font: inherit;
}
.inline-action textarea:focus {
  border-color: var(--preview-accent);
}
.inline-action > div {
  display: flex;
  justify-content: flex-end;
  gap: 0.35rem;
}
.inline-action button.primary {
  border-color: var(--preview-accent);
  color: var(--p-primary-contrast-color, white);
  background: var(--preview-accent);
}
.inline-action button.danger.solid {
  border-color: var(--p-red-500);
  color: white;
  background: var(--p-red-500);
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
  background: var(--p-surface-ground);
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
  background: var(--p-surface-card);
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
  background: var(--p-green-500);
}
.event-marker.danger i {
  background: var(--p-red-500);
}
.event-marker.muted i {
  background: var(--p-surface-400);
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
@media (max-width: 820px) {
  .workspace-address-panel {
    position: fixed;
  }
}
</style>
