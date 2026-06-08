<!--
  Host "more info" popup — shows the full metadata CIDRella knows about a single
  host: identity, liveness, and the passively-inferred device/OS fingerprint
  (device type, OS family, manufacturer, confidence, and the raw DHCP signals).
  Most fields come from the IP row already loaded; the raw fingerprint detail
  (opt55/opt60) is fetched per-MAC on open.
-->
<template>
  <Dialog :visible="visible" @update:visible="v => emit('update:visible', v)"
          :header="`Host — ${host?.ip_address || ''}`" modal :style="{ width: '32rem' }"
          data-track="dialog-host-info">
    <div v-if="host" class="host-info">
      <section>
        <h5>Identity</h5>
        <div class="hi-row"><span class="hi-label">IP address</span><span class="hi-val mono">{{ host.ip_address }}</span></div>
        <div class="hi-row"><span class="hi-label">Hostname</span><span class="hi-val">{{ host.hostname || dash }}</span></div>
        <div class="hi-row"><span class="hi-label">MAC</span><span class="hi-val mono">{{ mac || dash }}</span></div>
        <div class="hi-row"><span class="hi-label">Manufacturer</span><span class="hi-val">{{ host.vendor || dash }}</span></div>
      </section>

      <section>
        <h5>Device <span v-if="confidence" class="hi-conf">· {{ confidence }}% confidence</span></h5>
        <div class="hi-row"><span class="hi-label">Type</span><span class="hi-val">{{ deviceType || dash }}</span></div>
        <div class="hi-row"><span class="hi-label">OS family</span><span class="hi-val">{{ osFamily || dash }}</span></div>
        <div class="hi-row"><span class="hi-label">DHCP fingerprint</span><span class="hi-val mono small">{{ fp?.dhcp_fingerprint || dash }}</span></div>
        <div class="hi-row"><span class="hi-label">Vendor class</span><span class="hi-val mono small">{{ fp?.vendor_class || dash }}</span></div>
        <div class="hi-row"><span class="hi-label">Source</span><span class="hi-val">{{ fp?.source || dash }}</span></div>
        <p v-if="!loading && !deviceType && !osFamily" class="hi-hint">
          No DHCP fingerprint yet — the device will be identified the next time it requests/renews a DHCP lease (static hosts won't fingerprint via DHCP).
        </p>
      </section>

      <section>
        <h5>Liveness</h5>
        <div class="hi-row"><span class="hi-label">Status</span><span class="hi-val">{{ host.ip_display_status || host.status || dash }}</span></div>
        <div class="hi-row"><span class="hi-label">Online</span>
          <span class="hi-val"><span class="dot" :class="host.is_online ? 'dot-up' : 'dot-off'"></span>{{ host.is_online ? 'Online' : 'Offline' }}</span>
        </div>
        <div class="hi-row"><span class="hi-label">Last seen</span><span class="hi-val">{{ host.last_seen_at ? fmt(host.last_seen_at) : dash }}</span></div>
        <div class="hi-row" v-if="host.dhcp_expires_at"><span class="hi-label">Lease expires</span><span class="hi-val">{{ fmt(host.dhcp_expires_at) }}</span></div>
        <div class="hi-row" v-if="host.is_rogue"><span class="hi-label">Rogue</span><span class="hi-val hi-rogue">{{ host.rogue_reason || 'flagged' }}</span></div>
      </section>
    </div>
  </Dialog>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import Dialog from 'primevue/dialog';
import api from '../api/client.js';
import { formatDateTime } from '../utils/dateFormat.js';

const props = defineProps({
  visible: { type: Boolean, default: false },
  host: { type: Object, default: null },
});
const emit = defineEmits(['update:visible']);

const dash = '—';
const fmt = formatDateTime;
const fp = ref(null);
const loading = ref(false);

const mac = computed(() => props.host?.mac_address || props.host?.last_seen_mac || null);
// Prefer the row's enriched values; fall back to the fetched fingerprint row.
const deviceType = computed(() => props.host?.device_type || fp.value?.device_type || null);
const osFamily = computed(() => props.host?.os_family || fp.value?.os_family || null);
const confidence = computed(() => props.host?.device_confidence ?? fp.value?.confidence ?? null);

async function loadFingerprint() {
  fp.value = null;
  if (!mac.value) return;
  loading.value = true;
  try {
    const { data } = await api.get(`/devices/${encodeURIComponent(mac.value)}/fingerprint`);
    fp.value = data;
  } catch {
    fp.value = null;
  } finally {
    loading.value = false;
  }
}

watch(() => props.visible, (v) => { if (v) loadFingerprint(); });
</script>

<style scoped>
.host-info { display: flex; flex-direction: column; gap: 1rem; }
.host-info section h5 { margin: 0 0 0.4rem; font-size: var(--app-fs-sm); color: var(--p-text-color); }
.hi-conf { color: var(--p-text-muted-color); font-weight: 400; font-size: var(--app-fs-xs); }
.hi-row { display: grid; grid-template-columns: 9rem 1fr; gap: 0.5rem; padding: 0.15rem 0; font-size: var(--app-fs-sm); }
.hi-label { color: var(--p-text-muted-color); }
.hi-val { color: var(--p-text-color); word-break: break-word; }
.hi-val.mono { font-family: var(--font-mono, monospace); }
.hi-val.small { font-size: var(--app-fs-xs); }
.hi-rogue { color: var(--p-red-400); }
.hi-hint { font-size: var(--app-fs-xs); color: var(--p-text-muted-color); margin: 0.3rem 0 0; line-height: 1.4; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 0.4rem; vertical-align: middle; }
.dot-up { background: var(--p-green-500); }
.dot-off { background: var(--p-surface-400); }
</style>
