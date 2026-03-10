<template>
  <div class="interface-panel">
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
              @click="saveConfig" :loading="saving" />
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useToast } from 'primevue/usetoast';
import api from '../api/client.js';
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
const discoveredInterfaces = ref([]);
const savedConfig = ref({});
const mergedInterfaces = ref([]);

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
    mergeData();
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
  if (!val) {
    // DNS off → DHCP must also be off
    dhcpEnabled.value = false;
  }
}

function onGlobalDhcpToggle(val) {
  if (val && !dnsEnabled.value) {
    // Can't enable DHCP without DNS
    dhcpEnabled.value = false;
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
    await api.put('/interfaces/config', {
      interfaces,
      dns_enabled: dnsEnabled.value,
      dhcp_enabled: dhcpEnabled.value,
    });
    toast.add({ severity: 'success', summary: 'Saved', detail: 'Interface configuration applied', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: 'Failed to save configuration', life: 3000 });
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
