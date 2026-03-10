<template>
  <div class="dns-page" style="display: flex; flex-direction: column; height: 100%;">
    <div class="dns-sections">
      <div class="dns-section">
        <h4>Upstream Forwarders</h4>
        <div class="forwarders-list">
          <div v-for="(fwd, i) in forwarders" :key="i" class="forwarder-entry">
            <span class="status-dot" :class="dotClass(fwd)"></span>
            <InputText v-model="forwarders[i].ip" size="small" placeholder="e.g. 8.8.8.8" style="width: 12rem"
                       @blur="onForwarderBlur(i)" @keyup.enter="onForwarderBlur(i)" />
            <i v-if="fwd.status === 'testing'" class="pi pi-spin pi-spinner fwd-testing"></i>
            <Button icon="pi pi-trash" severity="danger" text rounded size="small"
                    @click="removeForwarder(i)" v-if="forwarders.length > 1" title="Remove" />
          </div>
          <div class="forwarder-actions">
            <Button label="Add Forwarder" icon="pi pi-plus" size="small" severity="secondary"
                    @click="addForwarder" />
            <Button label="Save" icon="pi pi-save" size="small" data-track="dns-save-forwarders"
                    @click="saveForwarders" :loading="savingForwarders" />
          </div>
          <p class="forwarder-hint">
            Forwarders are tested via DNS resolution on entry and every 15 minutes.
            A failed test is retried once after 5 seconds before marking as down.
          </p>
        </div>
      </div>

      <div class="dns-section">
        <h4>SOA Defaults</h4>
        <p class="section-hint">Default values applied when creating new DNS zones.</p>
        <div class="soa-defaults-form">
          <div class="field">
            <label>Primary Nameserver</label>
            <InputText v-model="soaForm.soa_primary_ns" size="small" placeholder="ns1.localhost" style="width: 100%" />
          </div>
          <div class="field">
            <label>Admin Email</label>
            <InputText v-model="soaForm.soa_admin_email" size="small" placeholder="admin.localhost" style="width: 100%" />
            <small class="field-help">Dotted notation (admin.example.com = admin@example.com)</small>
          </div>
          <div class="soa-grid">
            <div class="field">
              <label>Refresh (s) <span v-tooltip.top="'How often secondaries check for zone updates'" class="soa-help">?</span></label>
              <InputNumber v-model="soaForm.soa_refresh" size="small" :min="0" style="width: 100%" />
            </div>
            <div class="field">
              <label>Retry (s) <span v-tooltip.top="'How long secondaries wait before retrying a failed refresh'" class="soa-help">?</span></label>
              <InputNumber v-model="soaForm.soa_retry" size="small" :min="0" style="width: 100%" />
            </div>
            <div class="field">
              <label>Expire (s) <span v-tooltip.top="'How long secondaries serve the zone without a successful refresh'" class="soa-help">?</span></label>
              <InputNumber v-model="soaForm.soa_expire" size="small" :min="0" style="width: 100%" />
            </div>
            <div class="field">
              <label>Minimum TTL (s) <span v-tooltip.top="'Default negative-cache TTL — how long resolvers cache NXDOMAIN responses'" class="soa-help">?</span></label>
              <InputNumber v-model="soaForm.soa_minimum_ttl" size="small" :min="0" style="width: 100%" />
            </div>
          </div>
          <div class="forwarder-actions">
            <Button label="Save" icon="pi pi-save" size="small" data-track="dns-save-soa-defaults"
                    @click="saveSoaDefaults" :loading="savingSoa" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { useToast } from 'primevue/usetoast';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import InputNumber from 'primevue/inputnumber';
import { useDnsStore } from '../stores/dns.js';

const store = useDnsStore();
const toast = useToast();

const forwarders = ref([]);
const savingForwarders = ref(false);
let pollTimer = null;

const soaForm = ref({
  soa_primary_ns: 'ns1.localhost', soa_admin_email: 'admin.localhost',
  soa_refresh: 3600, soa_retry: 900, soa_expire: 604800, soa_minimum_ttl: 900
});
const savingSoa = ref(false);

const ipv4Re = /^(\d{1,3}\.){3}\d{1,3}$/;

function dotClass(fwd) {
  if (fwd.status === 'reachable') return 'dot-up';
  if (fwd.status === 'unreachable') return 'dot-down';
  return 'dot-unknown';
}

function addForwarder() {
  forwarders.value.push({ ip: '', status: null });
}

function removeForwarder(i) {
  forwarders.value.splice(i, 1);
}

async function onForwarderBlur(i) {
  const fwd = forwarders.value[i];
  if (!fwd) return;
  const ip = fwd.ip.trim();
  if (!ip || !ipv4Re.test(ip)) {
    fwd.status = null;
    return;
  }
  fwd.status = 'testing';
  try {
    const result = await store.testForwarder(ip);
    fwd.status = result.reachable ? 'reachable' : 'unreachable';
  } catch {
    fwd.status = 'unreachable';
  }
}

async function testAllForwarders() {
  for (const fwd of forwarders.value) {
    const ip = fwd.ip.trim();
    if (!ip || !ipv4Re.test(ip)) continue;
    fwd.status = 'testing';
    try {
      const result = await store.testForwarder(ip);
      fwd.status = result.reachable ? 'reachable' : 'unreachable';
    } catch {
      fwd.status = 'unreachable';
    }
  }
}

async function saveForwarders() {
  savingForwarders.value = true;
  try {
    const servers = forwarders.value.map(f => f.ip.trim()).filter(Boolean);
    await store.updateForwarders(servers);
    toast.add({ severity: 'success', summary: 'Forwarders saved', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    savingForwarders.value = false;
  }
}

async function saveSoaDefaults() {
  savingSoa.value = true;
  try {
    await store.updateSoaDefaults(soaForm.value);
    toast.add({ severity: 'success', summary: 'SOA defaults saved', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    savingSoa.value = false;
  }
}

onMounted(async () => {
  try {
    const servers = await store.getForwarders();
    forwarders.value = servers.map(ip => ({ ip, status: null }));
  } catch {
    forwarders.value = [];
  }
  testAllForwarders();
  pollTimer = setInterval(testAllForwarders, 15 * 60 * 1000);
  try {
    const defaults = await store.getSoaDefaults();
    soaForm.value = defaults;
  } catch { /* use local defaults */ }
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<style scoped>
.dns-sections {
  display: flex;
  flex-direction: column;
  gap: 2rem;
  max-width: 28rem;
}
.dns-section h4 {
  margin: 0 0 0.5rem;
}
.section-hint {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
  margin: 0 0 0.75rem;
  line-height: 1.4;
}
.forwarders-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.forwarder-entry {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.forwarder-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.25rem;
}
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.dot-up { background: var(--p-green-500); }
.dot-down { background: var(--p-red-500); }
.dot-unknown { background: var(--p-surface-400); }
.fwd-testing { color: var(--p-text-muted-color); font-size: 0.85rem; }
.forwarder-hint {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
  margin: 0.25rem 0 0;
  line-height: 1.4;
}
.soa-defaults-form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.soa-defaults-form .field label {
  display: block;
  font-size: 0.8rem;
  font-weight: 600;
  margin-bottom: 0.25rem;
}
.soa-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
}
.soa-help {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1rem;
  height: 1rem;
  border-radius: 50%;
  background: var(--p-surface-200);
  color: var(--p-text-muted-color);
  font-size: 0.65rem;
  font-weight: 700;
  cursor: help;
  margin-left: 0.25rem;
  vertical-align: middle;
}
.field-help {
  display: block;
  font-size: 0.7rem;
  color: var(--p-text-muted-color);
  margin-top: 0.2rem;
}
</style>
