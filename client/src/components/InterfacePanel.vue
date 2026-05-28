<template>
  <div class="interface-panel">
    <div class="content-card settings-form">
      <h3>Web Ports</h3>
      <p class="field-help" style="margin-bottom: 0.75rem;">
        Ports the CIDRella web UI binds to. Changes take effect immediately — no service
        restart needed. You will be redirected to the new HTTPS port after saving.
      </p>
      <div class="web-ports-info">
        <div class="field field-inline">
          <label>HTTP Port</label>
          <input type="number" min="1" max="65535" step="1" class="port-input"
                 :class="{ 'port-input-invalid': httpRedirectEnabled && !httpPortValid }"
                 v-model.number="httpPortEdit" data-track="iface-http-port"
                 :disabled="!httpRedirectEnabled" />
        </div>
        <div class="field field-inline">
          <label>HTTPS Port</label>
          <input type="number" min="1" max="65535" step="1" class="port-input"
                 :class="{ 'port-input-invalid': !httpsPortValid }"
                 v-model.number="httpsPortEdit" data-track="iface-https-port" />
        </div>
        <div class="field field-inline">
          <label>Redirect HTTP → HTTPS</label>
          <ToggleSwitch v-model="httpRedirectEnabled" data-track="iface-http-redirect" />
        </div>
      </div>
      <small v-if="portValidationError" class="field-help warn-text" style="margin-top: 0.5rem; display: block;">
        {{ portValidationError }}
      </small>
    </div>

    <div class="content-card settings-form">
      <h3>Service Controls</h3>
      <p class="field-help" style="margin-bottom: 0.75rem;">
        Globally enable or disable DNS and DHCP services. When a service is disabled globally,
        per-interface toggles are overridden.
      </p>
      <div class="service-toggles">
        <div class="field field-inline">
          <label>DNS Service</label>
          <ToggleSwitch v-model="dnsEnabled" data-track="iface-dns-global" @update:modelValue="onGlobalDnsToggle" />
        </div>
        <div class="field field-inline">
          <label>DHCP Service</label>
          <ToggleSwitch v-model="dhcpEnabled" data-track="iface-dhcp-global" @update:modelValue="onGlobalDhcpToggle" />
        </div>
      </div>
      <small v-if="!dnsEnabled" class="field-help warn-text">DNS is disabled globally. DHCP requires DNS and is also disabled.</small>
    </div>

    <div class="content-card">
      <div class="card-header">
        <h3>Network Interfaces</h3>
        <Button icon="pi pi-refresh" size="small" text data-track="iface-refresh" @click="loadInterfaces" :loading="loading" />
      </div>

      <DataTable :value="mergedInterfaces" :loading="loading" stripedRows size="small"
                 emptyMessage="No network interfaces found.">
        <Column field="name" header="Interface" style="width: 8rem">
          <template #body="{ data }">
            <span class="iface-name">{{ data.name }}</span>
            <Tag v-if="data.state === 'down'" value="down" severity="warn" class="iface-badge" />
            <Tag v-if="data.missing" value="missing" severity="danger" class="iface-badge" />
          </template>
        </Column>
        <Column header="IP Address">
          <template #body="{ data }">
            <template v-if="data.addresses && data.addresses.length">
              <div v-for="addr in data.addresses" :key="addr.address">{{ addr.address }}</div>
            </template>
            <span v-else class="muted">—</span>
          </template>
        </Column>
        <Column header="MAC" style="width: 10rem">
          <template #body="{ data }">
            <span v-if="data.mac" class="mono">{{ data.mac }}</span>
            <span v-else class="muted">—</span>
          </template>
        </Column>
        <Column header="DNS" style="width: 5rem; text-align: center;">
          <template #body="{ data }">
            <ToggleSwitch v-model="data.dns" :disabled="!dnsEnabled || data.missing"
                          :data-track="'iface-dns-' + data.name"
                          @update:modelValue="val => onDnsToggle(data, val)" />
          </template>
        </Column>
        <Column header="DHCP" style="width: 5rem; text-align: center;">
          <template #body="{ data }">
            <ToggleSwitch v-model="data.dhcp" :disabled="!dhcpEnabled || !dnsEnabled || data.missing"
                          :data-track="'iface-dhcp-' + data.name"
                          @update:modelValue="val => onDhcpToggle(data, val)" />
          </template>
        </Column>
      </DataTable>

      <small class="field-help" style="margin-top: 0.5rem; display: block;">
        DHCP requires DNS — enabling DHCP will auto-enable DNS on that interface.
        Disabling DNS will auto-disable DHCP.
      </small>
    </div>

    <div class="settings-actions">
      <Button label="Save Configuration" icon="pi pi-save" data-track="iface-save"
              @click="saveConfig" :loading="saving" :disabled="saveDisabled" />
    </div>
  </div>
</template>

<!--
  v0.4.15: added the "Web Ports" section above Service Controls. HTTPS/HTTP
  port numbers are install-time-fixed (see the help text above) but the
  HTTP redirect toggle is live — saving applies it without a service restart.
-->


<script setup>
import { ref, computed, onMounted } from 'vue';
import { useToast } from 'primevue/usetoast';
import api from '../api/client.js';
import { apiError } from '../utils/format.js';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import ToggleSwitch from 'primevue/toggleswitch';
import Button from 'primevue/button';
import Tag from 'primevue/tag';

const toast = useToast();
const loading = ref(false);
const saving = ref(false);
const dnsEnabled = ref(true);
const dhcpEnabled = ref(true);
const httpRedirectEnabled = ref(true);
const webPorts = ref({ https_port: 0, http_port: 0, http_redirect_enabled: true });
const httpsPortEdit = ref(443);
const httpPortEdit = ref(80);
const discoveredInterfaces = ref([]);
const savedConfig = ref({});
const mergedInterfaces = ref([]);
const configSnapshot = ref('');

const configDirty = computed(() => {
  if (!configSnapshot.value) return false;
  const current = JSON.stringify({
    dns: dnsEnabled.value, dhcp: dhcpEnabled.value,
    http: httpRedirectEnabled.value,
    hps: httpsPortEdit.value, hpp: httpPortEdit.value,
    ifaces: mergedInterfaces.value.map(i => ({ n: i.name, d: i.dns, h: i.dhcp }))
  });
  return current !== configSnapshot.value;
});

// A port is valid when it's an integer in [1, 65535]. We check Number.isInteger
// explicitly because v-model.number on `<input type="number">` can return NaN
// (empty field) or a decimal (user typed "80.5"). The server backstops with
// the same check, but doing it client-side avoids a round-trip and gives the
// user immediate red-border feedback.
const httpsPortValid = computed(() => {
  const v = httpsPortEdit.value;
  return Number.isInteger(v) && v >= 1 && v <= 65535;
});
const httpPortValid = computed(() => {
  // HTTP port is only relevant when redirect is enabled; when disabled the
  // field is visually disabled and we don't validate it.
  if (!httpRedirectEnabled.value) return true;
  const v = httpPortEdit.value;
  return Number.isInteger(v) && v >= 1 && v <= 65535;
});
const portsValid = computed(() => {
  if (!httpsPortValid.value || !httpPortValid.value) return false;
  // HTTPS and HTTP must not collide — the server rejects this with a 400
  // too, but catch it here so the user doesn't have to wait for the round
  // trip.
  if (httpRedirectEnabled.value && httpsPortEdit.value === httpPortEdit.value) return false;
  return true;
});
const portValidationError = computed(() => {
  if (!httpsPortValid.value) return 'HTTPS Port must be an integer between 1 and 65535.';
  if (!httpPortValid.value)  return 'HTTP Port must be an integer between 1 and 65535.';
  if (httpRedirectEnabled.value && httpsPortEdit.value === httpPortEdit.value) {
    return 'HTTPS Port and HTTP Port must differ.';
  }
  return '';
});
const saveDisabled = computed(() => !configDirty.value || !portsValid.value);

function snapshotConfig() {
  configSnapshot.value = JSON.stringify({
    dns: dnsEnabled.value, dhcp: dhcpEnabled.value,
    http: httpRedirectEnabled.value,
    hps: httpsPortEdit.value, hpp: httpPortEdit.value,
    ifaces: mergedInterfaces.value.map(i => ({ n: i.name, d: i.dns, h: i.dhcp }))
  });
}

function mergeData() {
  const map = new Map();

  // Start with discovered interfaces
  for (const iface of discoveredInterfaces.value) {
    const cfg = savedConfig.value[iface.name] || { dns: false, dhcp: false };
    map.set(iface.name, {
      ...iface,
      dns: cfg.dns,
      dhcp: cfg.dhcp,
      missing: false,
    });
  }

  // Add saved-but-missing interfaces
  for (const [name, cfg] of Object.entries(savedConfig.value)) {
    if (!map.has(name)) {
      map.set(name, {
        name,
        mac: null,
        addresses: [],
        state: 'unknown',
        dns: cfg.dns,
        dhcp: cfg.dhcp,
        missing: true,
      });
    }
  }

  mergedInterfaces.value = Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

async function loadInterfaces() {
  loading.value = true;
  try {
    const [ifaceRes, configRes] = await Promise.all([
      api.get('/interfaces'),
      api.get('/interfaces/config'),
    ]);
    discoveredInterfaces.value = ifaceRes.data;
    savedConfig.value = configRes.data.interfaces || {};
    dnsEnabled.value = configRes.data.dns_enabled !== false;
    dhcpEnabled.value = configRes.data.dhcp_enabled !== false;
    // v0.4.15: web_ports block. Absent on pre-v0.4.15 backends — keep
    // sensible defaults if the field isn't there.
    if (configRes.data.web_ports) {
      webPorts.value = configRes.data.web_ports;
      httpRedirectEnabled.value = configRes.data.web_ports.http_redirect_enabled !== false;
      httpsPortEdit.value = configRes.data.web_ports.https_port || 443;
      httpPortEdit.value  = configRes.data.web_ports.http_port  || 80;
    }
    mergeData();
    snapshotConfig();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: 'Failed to load interfaces', life: 3000 });
  } finally {
    loading.value = false;
  }
}

function onDnsToggle(iface, val) {
  if (!val) {
    // Disabling DNS auto-disables DHCP
    iface.dhcp = false;
  }
}

function onDhcpToggle(iface, val) {
  if (val) {
    // Enabling DHCP auto-enables DNS
    iface.dns = true;
  }
}

function onGlobalDnsToggle(val) {
  if (val) {
    // DNS on → enable DNS on all available interfaces
    for (const iface of mergedInterfaces.value) {
      if (!iface.missing) iface.dns = true;
    }
  } else {
    // DNS off → DHCP must also be off
    dhcpEnabled.value = false;
  }
}

function onGlobalDhcpToggle(val) {
  if (val && !dnsEnabled.value) {
    // Can't enable DHCP without DNS
    dhcpEnabled.value = false;
  } else if (val) {
    // DHCP on → enable DHCP (and DNS) on all available interfaces
    for (const iface of mergedInterfaces.value) {
      if (!iface.missing) {
        iface.dhcp = true;
        iface.dns = true;
      }
    }
  }
}

async function saveConfig() {
  saving.value = true;
  try {
    const interfaces = {};
    for (const iface of mergedInterfaces.value) {
      if (iface.dns || iface.dhcp) {
        interfaces[iface.name] = { dns: iface.dns, dhcp: iface.dhcp };
      }
    }
    const originalHttpsPort = webPorts.value.https_port;
    const { data } = await api.put('/interfaces/config', {
      interfaces,
      dns_enabled: dnsEnabled.value,
      dhcp_enabled: dhcpEnabled.value,
      http_redirect_enabled: httpRedirectEnabled.value,
      https_port: httpsPortEdit.value,
      http_port: httpPortEdit.value,
    });
    snapshotConfig();
    if (data.dnsmasq === 'restart_failed') {
      toast.add({ severity: 'warn', summary: 'Saved with warning', detail: 'Configuration saved but dnsmasq failed to restart. Check server logs.', life: 5000 });
    } else {
      toast.add({ severity: 'success', summary: 'Saved', detail: 'Configuration applied', life: 3000 });
    }

    // If the HTTPS port changed, the browser is still connected on the old
    // port. Redirect to the new port after a brief settle so the live-swap
    // new listener has accepted a connection or two. Keep the same path +
    // query so the user lands back where they were.
    const newHttpsPort = data?.web_ports?.https_port;
    if (newHttpsPort && newHttpsPort !== originalHttpsPort) {
      const host = window.location.hostname;
      const target = `https://${host}${newHttpsPort === 443 ? '' : ':' + newHttpsPort}${window.location.pathname}${window.location.search}`;
      toast.add({
        severity: 'info',
        summary: 'Reconnecting',
        detail: `HTTPS moved to port ${newHttpsPort}. Redirecting…`,
        life: 4000
      });
      // 1500ms gives the old in-flight toast a moment to render.
      setTimeout(() => { window.location.assign(target); }, 1500);
    }
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally {
    saving.value = false;
  }
}

onMounted(loadInterfaces);
</script>

<style scoped>
.service-toggles {
  display: flex;
  gap: 2rem;
  align-items: center;
}
.web-ports-info {
  display: flex;
  gap: 2rem;
  align-items: center;
  flex-wrap: wrap;
}
.port-readout {
  font-weight: 600;
  color: var(--p-text-color);
}
.port-input {
  width: 6em;
  padding: 0.375rem 0.5rem;
  font-family: var(--font-mono, monospace);
  background: var(--p-inputtext-background, var(--p-surface-0));
  color: var(--p-inputtext-color, var(--p-text-color));
  border: 1px solid var(--p-inputtext-border-color, var(--p-surface-300));
  border-radius: var(--p-inputtext-border-radius, 4px);
}
.port-input:focus {
  outline: 2px solid var(--p-primary-color);
  outline-offset: -1px;
}
.port-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.port-input-invalid {
  border-color: var(--p-red-500, #ef4444);
  background: color-mix(in srgb, var(--p-red-500, #ef4444) 8%, transparent);
}
.port-input-invalid:focus {
  outline-color: var(--p-red-500, #ef4444);
}
/* Hide the native up/down spinners — users requested plain entry fields. */
.port-input::-webkit-outer-spin-button,
.port-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.port-input {
  -moz-appearance: textfield;
  appearance: textfield;
}
/* v0.4.15: small explicit spacer above Save button per user request. */
.settings-actions {
  margin-top: 4px;
}
.field-inline {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.field-inline label {
  margin-bottom: 0;
  font-weight: 500;
}
.iface-name {
  font-weight: 600;
  font-family: var(--font-mono, monospace);
}
.iface-badge {
  margin-left: 0.5rem;
  font-size: 0.7rem;
}
.mono {
  font-family: var(--font-mono, monospace);
  font-size: 0.85em;
}
.muted {
  color: var(--p-text-muted-color);
}
.warn-text {
  color: var(--p-orange-400);
}
</style>
