<!--
  IP details drawer shows the full metadata CIDRella knows about a single
  host: identity, liveness, and the passively-inferred device/OS fingerprint
  (device type, OS family, manufacturer, confidence, and the raw DHCP signals).
  Most fields come from the IP row already loaded. The raw fingerprint detail
  and lifecycle history are fetched when the drawer opens or changes hosts.
-->
<template>
  <Drawer :visible="visible" @update:visible="v => emit('update:visible', v)"
          :header="`IP details — ${host?.ip_address || ''}`" position="right"
          :modal="false" :dismissable="true" :style="{ width: 'min(27rem, 92vw)' }"
          data-track="dialog-host-info">
    <div v-if="host" class="host-info">
      <section>
        <h5>Identity</h5>
        <div class="hi-row"><span class="hi-label">IP address</span><span class="hi-val mono">{{ host.ip_address }}</span></div>
        <div class="hi-row"><span class="hi-label">Hostname</span><span class="hi-val">{{ displayHostnameCell(host.hostname, domainName) }}</span></div>
        <div class="hi-row"><span class="hi-label">MAC</span><span class="hi-val mono">{{ mac || dash }}</span></div>
        <div class="hi-row"><span class="hi-label">Manufacturer</span><span class="hi-val">{{ host.vendor || dash }}</span></div>
      </section>

      <section>
        <h5>Device <span v-if="confidence" class="hi-conf">· {{ confidence }}% confidence</span></h5>
        <div class="hi-row"><span class="hi-label">Type</span><span class="hi-val">{{ deviceType || dash }}</span></div>
        <div class="hi-row"><span class="hi-label">OS family</span><span class="hi-val">{{ osFamily || dash }}</span></div>
        <div class="hi-row"><span class="hi-label">DHCP fingerprint</span><span class="hi-val mono small">{{ fp?.dhcp_fingerprint || dash }}</span></div>
        <div class="hi-row"><span class="hi-label">Vendor class</span><span class="hi-val mono small">{{ fp?.vendor_class || dash }}</span></div>
        <div class="hi-row"><span class="hi-label">Source</span>
          <span class="hi-val">{{ fp?.source || dash }}
            <Button v-if="fp?.source === 'manual'" label="Reset to detected" size="small" text
                    icon="pi pi-undo" class="hi-reset" :loading="resetting"
                    data-track="host-info-reset-fingerprint" @click="resetFingerprint"
                    v-tooltip.top="'Remove the manual override; the device re-identifies on its next DHCP lease'" />
          </span>
        </div>
        <p v-if="!loading && !deviceType && !osFamily" class="hi-hint">
          No DHCP fingerprint yet. The device will be identified the next time it requests/renews a DHCP lease (static hosts won't fingerprint via DHCP).
        </p>
      </section>

      <section>
        <h5>Liveness</h5>
        <div class="hi-row"><span class="hi-label">Status</span><span class="hi-val">{{ host.ip_display_status || dash }}</span></div>
        <div class="hi-row"><span class="hi-label">Online</span>
          <span class="hi-val"><StatusDot :kind="onlineState.known ? (onlineState.label === 'Online' ? 'ok' : 'muted') : 'muted'" :label="onlineState.label" class="hi-dot" />{{ onlineState.label }}</span>
        </div>
        <div class="hi-row"><span class="hi-label">Last seen</span><span class="hi-val">{{ host.last_seen_at ? fmt(host.last_seen_at) : dash }}</span></div>
        <div class="hi-row" v-if="host.dhcp_expires_at"><span class="hi-label">Lease expires</span><span class="hi-val">{{ fmt(host.dhcp_expires_at) }}</span></div>
        <div class="hi-row" v-if="host.is_rogue"><span class="hi-label">Rogue</span><span class="hi-val hi-rogue">{{ host.rogue_reason || 'flagged' }}</span></div>
      </section>

      <section class="lifecycle-section">
        <h5>IP lifecycle</h5>
        <div v-if="eventsLoading" class="events-state">Loading events...</div>
        <div v-else-if="eventsData.length === 0" class="events-state">No events recorded for this IP.</div>
        <div v-else class="events-list">
          <div v-for="evt in eventsData" :key="evt.id" class="event-row">
            <span class="event-time">{{ fmt(evt.created_at) }}</span>
            <Tag :severity="eventSeverity(evt.event_type)" :value="eventLabel(evt.event_type)" class="event-tag" />
            <span class="event-detail">{{ eventDetail(evt) }}</span>
          </div>
        </div>
      </section>
    </div>
  </Drawer>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import Drawer from '../ui/Drawer.js';
import Button from '../ui/Button.js';
import Tag from '../ui/Tag.js';
import StatusDot from './StatusDot.vue';
import { displayOnlineStatus, EMPTY_CELL, displayHostnameCell } from '../utils/format.js';
import { useToast } from '../ui/useToast.js';
import api from '../api/client.js';
import { apiError } from '../utils/format.js';
import { formatDateTime } from '../utils/dateFormat.js';

const props = defineProps({
  visible: { type: Boolean, default: false },
  host: { type: Object, default: null },
  // The subnet's domain, so the hostname here reads the same as the hostname in
  // the table that opened this drawer. Without it the table showed 'laptop' and
  // the drawer showed 'laptop.home.lan' for the same row
  // (duplicate-logic audit #56).
  domainName: { type: String, default: null },
  subnetId: { type: [Number, String], default: null },
});
const emit = defineEmits(['update:visible']);
const toast = useToast();

const dash = EMPTY_CELL;

// Liveness read through the shared three-state flag. The inline
// `host.is_online ? ... : ...` this replaces treated the STRING '0' as online
// (non-empty strings are truthy) and reported an unknown address as Offline
// rather than unknown. See REVIEW.md, duplicate-logic audit #48.
const onlineState = computed(() => displayOnlineStatus(props.host?.is_online));
const fmt = formatDateTime;
const fp = ref(null);
const loading = ref(false);
const eventsData = ref([]);
const eventsLoading = ref(false);
let fingerprintRequest = 0;
let eventsRequest = 0;

const mac = computed(() => props.host?.mac_address || props.host?.last_seen_mac || null);
// Prefer the row's enriched values; fall back to the fetched fingerprint row.
const deviceType = computed(() => props.host?.device_type || fp.value?.device_type || null);
const osFamily = computed(() => props.host?.os_family || fp.value?.os_family || null);
const confidence = computed(() => props.host?.device_confidence ?? fp.value?.confidence ?? null);

async function loadFingerprint() {
  const request = ++fingerprintRequest;
  fp.value = null;
  loading.value = false;
  if (!mac.value) return;
  loading.value = true;
  try {
    const { data } = await api.get(`/devices/${encodeURIComponent(mac.value)}/fingerprint`);
    if (request === fingerprintRequest) fp.value = data;
  } catch {
    if (request === fingerprintRequest) fp.value = null;
  } finally {
    if (request === fingerprintRequest) loading.value = false;
  }
}

async function loadEvents() {
  const request = ++eventsRequest;
  eventsData.value = [];
  eventsLoading.value = false;
  const ip = props.host?.ip_address;
  if (!props.subnetId || !ip) return;

  eventsLoading.value = true;
  try {
    const { data } = await api.get(`/subnets/${props.subnetId}/ips/${encodeURIComponent(ip)}/events`);
    if (request === eventsRequest) eventsData.value = data.events || [];
  } catch {
    if (request === eventsRequest) eventsData.value = [];
  } finally {
    if (request === eventsRequest) eventsLoading.value = false;
  }
}

function eventLabel(type) {
  const labels = {
    online: 'Online', offline: 'Offline', scanned: 'Scanned',
    rogue_detected: 'Rogue', rogue_cleared: 'Rogue Cleared',
    dns_added: 'DNS Added', dns_removed: 'DNS Removed',
    lease_obtained: 'Lease', hostname_changed: 'Hostname',
    mac_changed: 'MAC Changed', allocation_changed: 'Allocation', status_changed: 'Legacy Status',
    scan_enabled_changed: 'Scan Toggle',
  };
  return labels[type] || type;
}

function eventSeverity(type) {
  if (type === 'online' || type === 'dns_added' || type === 'lease_obtained') return 'success';
  if (type === 'offline' || type === 'dns_removed') return 'secondary';
  if (type === 'rogue_detected') return 'danger';
  if (type === 'rogue_cleared') return 'warn';
  return 'info';
}

function sourceLabel(source) {
  const labels = {
    scanner: 'active scan', passive: 'passive (DNS log)', stale: 'staleness timeout',
    dns: 'DNS', dhcp_reservation: 'DHCP Reservation', dhcp_lease: 'DHCP Lease',
    manual: 'manual', offline: 'went offline',
  };
  return labels[source] || source || '';
}

function eventDetail(evt) {
  const parts = [];
  if (evt.old_value && evt.new_value) parts.push(`${evt.old_value} → ${evt.new_value}`);
  else if (evt.new_value) parts.push(evt.new_value);
  else if (evt.old_value) parts.push(evt.old_value);
  if (evt.source) parts.push(`(${sourceLabel(evt.source)})`);
  return parts.join(' ');
}

const resetting = ref(false);
async function resetFingerprint() {
  if (!mac.value) return;
  resetting.value = true;
  try {
    await api.delete(`/devices/${encodeURIComponent(mac.value)}/fingerprint`);
    await loadFingerprint();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Reset failed', detail: apiError(err), life: 5000 });
  } finally {
    resetting.value = false;
  }
}

watch([
  () => props.visible,
  () => props.host?.ip_address,
  () => props.subnetId,
  mac
], ([visible]) => {
  if (!visible) {
    fingerprintRequest += 1;
    eventsRequest += 1;
    return;
  }
  loadFingerprint();
  loadEvents();
}, { immediate: true });
</script>

<style scoped>
.host-info { display: flex; flex-direction: column; gap: 1rem; height: 100%; min-height: 0; }
.host-info section h5 { margin: 0 0 0.4rem; font-size: var(--app-fs-sm); color: var(--p-text-color); }
.hi-conf { color: var(--p-text-muted-color); font-weight: 400; font-size: var(--app-fs-xs); }
.hi-row { display: grid; grid-template-columns: 9rem 1fr; gap: 0.5rem; padding: 0.15rem 0; font-size: var(--app-fs-sm); }
.hi-label { color: var(--p-text-muted-color); }
.hi-val { color: var(--p-text-color); word-break: break-word; }
.hi-val.mono { font-family: var(--font-mono, monospace); }
.hi-val.small { font-size: var(--app-fs-xs); }
.hi-reset { margin-left: 0.5rem; padding: 0 0.4rem; font-size: var(--app-fs-xs); }
.hi-rogue { color: var(--p-red-400); }
.hi-hint { font-size: var(--app-fs-xs); color: var(--p-text-muted-color); margin: 0.3rem 0 0; line-height: 1.4; }
.hi-dot { margin-right: 0.4rem; }
.lifecycle-section { display: flex; flex-direction: column; flex: 1; min-height: 12rem; }
.events-state { padding: 1.5rem; text-align: center; color: var(--p-text-muted-color); font-size: var(--app-fs-sm); }
.events-list { flex: 1; min-height: 0; max-height: 24rem; overflow-y: auto; padding-right: 0.25rem; }
.event-row { display: flex; align-items: flex-start; gap: 0.5rem; padding: 0.45rem 0; border-bottom: 1px solid color-mix(in srgb, var(--p-surface-border) 50%, transparent); font-size: var(--app-fs-sm); }
.event-time { width: 8.5rem; flex-shrink: 0; color: var(--p-text-muted-color); font-family: monospace; font-size: var(--app-fs-xs); }
.event-tag { flex-shrink: 0; }
.event-detail { flex: 1; min-width: 0; color: var(--p-text-color); overflow-wrap: anywhere; }
</style>
