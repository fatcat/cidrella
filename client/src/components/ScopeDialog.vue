<template>
  <!-- Scope Create/Edit Dialog -->
  <Dialog v-model:visible="dialogVisible" :header="editing ? 'Edit Scope' : (showRangePicker ? 'Add Scope' : 'Configure DHCP Scope')"
          modal :style="{ width: '36rem' }" data-track="dialog-dhcp-scope">
    <div class="form-grid">
      <div class="field" v-if="showRangePicker">
        <label>Network *</label>
        <div style="display: flex; gap: 0.5rem; align-items: center;">
          <Select v-model="form.subnet_id" :options="subnetsList" optionLabel="_label" optionValue="id"
                  class="w-full" placeholder="Select network" :disabled="!!form.range_id" />
          <Button icon="pi pi-plus" severity="success" text rounded size="small"
                  title="Add Network" @click="openAddNetwork" :disabled="!!form.range_id" />
        </div>
      </div>
      <div class="field" v-if="showRangePicker">
        <label>DHCP Scope Range</label>
        <Select v-model="form.range_id" :options="filteredRanges" optionLabel="_label" optionValue="id"
                class="w-full" placeholder="Select an existing range" :loading="loadingRanges" showClear :disabled="!form.subnet_id" />
        <small class="field-help">Only DHCP Scope ranges without existing scopes are shown</small>
      </div>
      <template v-if="showRangePicker && !form.range_id">
        <div class="or-divider"><span>or define a new range</span></div>
        <div class="field-row">
          <div class="field" style="flex:1">
            <label>Start IP *</label>
            <InputText v-model="form.start_ip" class="w-full" placeholder="e.g. 192.168.1.10" :disabled="!form.subnet_id" />
          </div>
          <div class="field" style="flex:1">
            <label>End IP *</label>
            <InputText v-model="form.end_ip" class="w-full" placeholder="e.g. 192.168.1.254" :disabled="!form.subnet_id" />
          </div>
        </div>
      </template>
      <div class="field" v-if="editing">
        <label>Start IP</label>
        <InputText v-model="form.start_ip" class="w-full" placeholder="e.g. 192.168.1.10" />
      </div>
      <div class="field" v-if="editing">
        <label>End IP</label>
        <InputText v-model="form.end_ip" class="w-full" placeholder="e.g. 192.168.1.254" />
      </div>
      <div class="field">
        <label>Description</label>
        <InputText v-model="form.description" class="w-full" :disabled="showRangePicker && !form.subnet_id" />
      </div>
      <div class="field" v-if="editing">
        <label>Enabled</label>
        <ToggleSwitch v-model="form.enabled" />
      </div>
    </div>

    <!-- Inline Options Section -->
    <div class="scope-options-section" :class="{ 'options-disabled': showRangePicker && !form.subnet_id }">
      <div class="scope-options-header" @click="!(showRangePicker && !form.subnet_id) && (optionsExpanded = !optionsExpanded)">
        <i class="pi" :class="optionsExpanded ? 'pi-chevron-down' : 'pi-chevron-right'" style="font-size: 0.7rem"></i>
        <span class="scope-options-title">DHCP Options</span>
        <span class="scope-options-count" v-if="form.selectedOptions.length > 0">{{ form.selectedOptions.length }} selected</span>
      </div>
      <div v-if="optionsExpanded" class="scope-options-list">
        <template v-for="group in optionGroups" :key="group.name">
          <div class="scope-option-group-header">{{ group.label }}</div>
          <div v-for="opt in group.options" :key="opt.code" class="scope-option-row">
            <div class="scope-option-check">
              <input type="checkbox"
                     :checked="form.selectedOptions.includes(opt.code)"
                     @change="toggleOption(opt.code, $event.target.checked)" />
            </div>
            <div class="scope-option-info">
              <span class="scope-option-label">{{ opt.label }}</span>
              <span class="scope-option-code">({{ opt.code }})</span>
              <i class="pi pi-question-circle scope-option-help" @click="showOptionHelp($event, opt)" />
            </div>
            <div class="scope-option-value">
              <template v-if="form.selectedOptions.includes(opt.code)">
                <Select v-if="opt.type === 'select'" v-model="form.optionValues[opt.code]"
                        :options="opt.choices" size="small" :placeholder="defaultValues[opt.code] || '—'" showClear />
                <InputNumber v-else-if="opt.type === 'number'" v-model="form.optionValues[opt.code]"
                             size="small" :useGrouping="false" :placeholder="defaultValues[opt.code] || '0'" />
                <InputText v-else v-model="form.optionValues[opt.code]" size="small"
                           :placeholder="defaultValues[opt.code] || placeholderForType(opt.type)"
                           @blur="opt.type === 'ip-list' || opt.type === 'ip' ? resolveHostnameField(opt.code) : null" />
              </template>
              <span v-else-if="defaultValues[opt.code]" class="scope-option-default">
                default: {{ defaultValues[opt.code] }}
              </span>
            </div>
          </div>
        </template>
      </div>
    </div>

    <template #footer>
      <Button :label="editing ? 'Cancel' : (showRangePicker ? 'Cancel' : 'Skip')" severity="secondary" @click="dialogVisible = false" />
      <Button :label="editing ? 'Save' : 'Create Scope'" @click="save" :loading="saving" :disabled="showRangePicker && !form.subnet_id" />
    </template>
  </Dialog>

  <!-- Help Popover -->
  <Popover ref="helpPopoverRef">
    <div class="option-help-popover">
      <strong>{{ helpPopoverData.label }}</strong>
      <p>{{ helpPopoverData.description }}</p>
      <a v-if="helpPopoverData.rfcUrl" :href="helpPopoverData.rfcUrl" target="_blank" rel="noopener" class="rfc-link">
        {{ helpPopoverData.rfc }}
      </a>
    </div>
  </Popover>

  <NetworkDialogs ref="networkDialogsRef" :folders="subnetStore.folders" @network-created="onNetworkCreated" />
</template>

<script setup>
import { ref, reactive, computed, watch } from 'vue';
import { useToast } from 'primevue/usetoast';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import InputNumber from 'primevue/inputnumber';
import Select from 'primevue/select';
import ToggleSwitch from 'primevue/toggleswitch';
import Popover from 'primevue/popover';
import { useDhcpStore } from '../stores/dhcp.js';
import { useSubnetStore } from '../stores/subnets.js';
import NetworkDialogs from './NetworkDialogs.vue';
import { parseCidr, longToIp } from '../utils/ip.js';
import api from '../api/client.js';

const toast = useToast();
const dhcpStore = useDhcpStore();
const subnetStore = useSubnetStore();

const dialogVisible = ref(false);
const editing = ref(null); // the scope object being edited, or null for create
const saving = ref(false);
const showRangePicker = ref(false); // true when creating from DHCP page (no pre-set range)
const form = ref(emptyForm());
const availableRanges = ref([]);
const loadingRanges = ref(false);
const subnetsList = ref([]);
const networkDialogsRef = ref(null);

// Options state
const optionCatalog = ref([]);
const defaultValues = reactive({});
const enabledDefaultCodes = ref([]);
const optionsExpanded = ref(false);
const optionGroupOrder = ref([]);

const filteredRanges = computed(() => {
  if (!form.value.subnet_id) return availableRanges.value;
  return availableRanges.value.filter(r => r.subnet_id === form.value.subnet_id);
});

const optionGroups = computed(() => {
  const order = optionGroupOrder.value.map(g => g.name);
  const groups = {};
  for (const opt of optionCatalog.value) {
    const g = opt.group || 'Common';
    if (!groups[g]) groups[g] = [];
    groups[g].push(opt);
  }
  const result = [];
  for (const name of order) {
    if (groups[name]?.length) {
      const meta = optionGroupOrder.value.find(g => g.name === name);
      result.push({ name, label: meta?.label || name, options: groups[name] });
    }
  }
  for (const [name, opts] of Object.entries(groups)) {
    if (!order.includes(name) && opts.length) {
      result.push({ name, label: name, options: opts });
    }
  }
  return result;
});

// Help popover
const helpPopoverRef = ref(null);
const helpPopoverData = ref({ label: '', description: '', rfc: '', rfcUrl: '' });

function showOptionHelp(event, opt) {
  helpPopoverData.value = { label: opt.label, description: opt.description || '', rfc: opt.rfc || '', rfcUrl: opt.rfcUrl || '' };
  helpPopoverRef.value.toggle(event);
}

function emptyForm() {
  return { range_id: null, subnet_id: null, start_ip: '', end_ip: '', lease_time: '24h', description: '', enabled: true, selectedOptions: [], optionValues: {} };
}

async function loadOptions() {
  if (optionCatalog.value.length > 0) return;
  try {
    const res = await api.get('/dhcp/options');
    optionCatalog.value = res.data.catalog;
    if (res.data.groups) optionGroupOrder.value = res.data.groups;
    Object.keys(defaultValues).forEach(k => delete defaultValues[k]);
    for (const [code, value] of Object.entries(res.data.defaults || {})) {
      defaultValues[Number(code)] = value;
    }
    enabledDefaultCodes.value = res.data.enabledDefaults || [];
  } catch (err) {
    console.error('Failed to load DHCP options:', err);
  }
}

// Reload defaults (called from parent when defaults are saved)
async function reloadOptions() {
  optionCatalog.value = [];
  await loadOptions();
}

const IP_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

async function resolveHostname(value) {
  if (!value || IP_RE.test(value.trim())) return value;
  const parts = value.split(',').map(s => s.trim()).filter(Boolean);
  const resolved = [];
  for (const part of parts) {
    if (IP_RE.test(part)) {
      resolved.push(part);
    } else {
      try {
        const res = await api.get(`/dns/resolve?name=${encodeURIComponent(part)}`);
        resolved.push(...res.data.ips);
      } catch {
        toast.add({ severity: 'warn', summary: `Could not resolve "${part}"`, life: 3000 });
        resolved.push(part);
      }
    }
  }
  return resolved.join(',');
}

async function resolveHostnameField(code) {
  const val = form.value.optionValues[code];
  if (!val) return;
  const resolved = await resolveHostname(val);
  if (resolved !== val) form.value.optionValues[code] = resolved;
}

function placeholderForType(type) {
  switch (type) {
    case 'ip': return 'e.g. 192.168.1.1';
    case 'ip-list': return 'e.g. 8.8.8.8, 1.1.1.1';
    case 'text': return 'Value';
    case 'text-list': return 'e.g. domain1.com, domain2.com';
    case 'number': return '0';
    default: return '';
  }
}

function toggleOption(code, checked) {
  if (checked) {
    if (!form.value.selectedOptions.includes(code)) {
      form.value.selectedOptions.push(code);
    }
    // Pre-fill from default if no value set
    if (form.value.optionValues[code] == null || form.value.optionValues[code] === '') {
      const def = defaultValues[code];
      if (def != null) {
        form.value.optionValues[code] = def;
      } else if ((code === 15 || code === 119) && editing.value?.subnet_domain_name) {
        form.value.optionValues[code] = editing.value.subnet_domain_name;
      } else if (code === 6 && editing.value?.server_ip) {
        form.value.optionValues[code] = `${editing.value.server_ip}, 9.9.9.9`;
      } else if (code === 28 && editing.value?.subnet_cidr) {
        form.value.optionValues[code] = computeBroadcast(editing.value.subnet_cidr);
      }
    }
  } else {
    form.value.selectedOptions = form.value.selectedOptions.filter(c => c !== code);
    delete form.value.optionValues[code];
  }
}

function computeBroadcast(cidr) {
  if (!cidr) return null;
  const [netIp, pfx] = cidr.split('/');
  const p = parseInt(pfx, 10);
  if (p < 0 || p > 32) return null;
  const m = p === 0 ? 0 : (0xFFFFFFFF << (32 - p)) >>> 0;
  const parts = netIp.split('.').map(Number);
  const ipL = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  const bcast = (ipL | ~m) >>> 0;
  return [((bcast) >>> 24) & 255, ((bcast) >>> 16) & 255, ((bcast) >>> 8) & 255, bcast & 255].join('.');
}

function computeMask(cidr) {
  if (!cidr) return null;
  const pfx = parseInt(cidr.split('/')[1], 10);
  if (pfx < 0 || pfx > 32) return null;
  const m = pfx === 0 ? 0 : (0xFFFFFFFF << (32 - pfx)) >>> 0;
  return [(m >>> 24) & 255, (m >>> 16) & 255, (m >>> 8) & 255, m & 255].join('.');
}

// Auto-populate network-dependent options when a subnet is selected
watch(() => form.value.subnet_id, (subnetId, oldSubnetId) => {
  if (!subnetId || editing.value) return;
  // Clear range if it doesn't belong to the newly selected subnet
  if (form.value.range_id && oldSubnetId !== subnetId) {
    const range = availableRanges.value.find(r => r.id === form.value.range_id);
    if (range && range.subnet_id !== subnetId) {
      form.value.range_id = null;
    }
  }
  if (form.value.range_id) return;
  const subnet = subnetsList.value.find(s => s.id === subnetId);
  if (!subnet) return;

  // Enable all enabled-by-default options
  for (const code of enabledDefaultCodes.value) {
    if (!form.value.selectedOptions.includes(code)) form.value.selectedOptions.push(code);
    if (defaultValues[code] != null && !form.value.optionValues[code]) {
      form.value.optionValues[code] = defaultValues[code];
    }
  }

  if (subnet.cidr) {
    const mask = computeMask(subnet.cidr);
    if (mask) form.value.optionValues[1] = mask;
  }
  if (subnet.gateway_address) {
    form.value.optionValues[3] = subnet.gateway_address;
  }
  if (subnet.domain_name) {
    if (!form.value.optionValues[15]) form.value.optionValues[15] = subnet.domain_name;
    if (!form.value.optionValues[119]) form.value.optionValues[119] = subnet.domain_name;
  }
  if (subnet.name && !form.value.description) {
    form.value.description = `${subnet.name} DHCP Scope`;
  }

  // Pre-fill suggested start/end IPs from subnet CIDR
  if (subnet.cidr && !form.value.start_ip && !form.value.end_ip) {
    try {
      const { network, broadcast } = parseCidr(subnet.cidr);
      form.value.start_ip = longToIp(network + 1);
      form.value.end_ip = longToIp(broadcast - 1);
    } catch { /* ignore */ }
  }
});

// Auto-populate options when a range is selected (new scope from DHCP page)
watch(() => form.value.range_id, (rangeId) => {
  if (!rangeId || editing.value) return;
  // Clear manual IP fields when a range is selected
  form.value.start_ip = '';
  form.value.end_ip = '';
  const range = availableRanges.value.find(r => r.id === rangeId);
  if (range) form.value.subnet_id = range.subnet_id;
  if (!range) return;

  // Subnet mask + broadcast
  if (range.subnet_cidr) {
    const mask = computeMask(range.subnet_cidr);
    if (mask) {
      if (!form.value.selectedOptions.includes(1)) form.value.selectedOptions.push(1);
      form.value.optionValues[1] = mask;
    }
    const bcast = computeBroadcast(range.subnet_cidr);
    if (bcast) {
      if (!form.value.selectedOptions.includes(28)) form.value.selectedOptions.push(28);
      form.value.optionValues[28] = bcast;
    }
  }
  // Gateway
  if (range.subnet_gateway) {
    if (!form.value.selectedOptions.includes(3)) form.value.selectedOptions.push(3);
    form.value.optionValues[3] = range.subnet_gateway;
  }
  // DNS servers
  if (range.server_ip) {
    if (!form.value.selectedOptions.includes(6)) form.value.selectedOptions.push(6);
    if (!form.value.optionValues[6]) form.value.optionValues[6] = `${range.server_ip}, 9.9.9.9`;
  }
  // Domain name + DNS search list
  if (range.subnet_domain_name) {
    for (const code of [15, 119]) {
      if (!form.value.selectedOptions.includes(code)) form.value.selectedOptions.push(code);
      if (!form.value.optionValues[code]) form.value.optionValues[code] = range.subnet_domain_name;
    }
  }
});

async function loadSubnetsList() {
  try {
    const res = await api.get('/subnets');
    const result = [];
    const flattenNodes = (nodes) => {
      for (const n of nodes) {
        if (n.type === 'subnet' || n.cidr) {
          result.push({ ...n, _label: `${n.name} (${n.cidr})` });
        }
        if (n.children?.length) flattenNodes(n.children);
      }
    };
    for (const folder of res.data.folders || []) {
      if (folder.subnets?.length) flattenNodes(folder.subnets);
    }
    subnetsList.value = result;
  } catch { /* ignore */ }
}

function openAddNetwork() {
  networkDialogsRef.value?.openCreateNetwork(null);
}

async function onNetworkCreated() {
  const oldIds = new Set(subnetsList.value.map(s => s.id));
  await loadSubnetsList();
  const newSubnet = subnetsList.value.find(s => !oldIds.has(s.id));
  if (newSubnet) {
    form.value.subnet_id = newSubnet.id;
  }
}

const emit = defineEmits(['saved']);

async function save() {
  saving.value = true;
  try {
    const options = form.value.selectedOptions
      .filter(code => form.value.optionValues[code] != null && form.value.optionValues[code] !== '')
      .map(code => ({ code, value: String(form.value.optionValues[code]) }));

    const payload = {
      lease_time: form.value.lease_time || '24h',
      description: form.value.description || null,
      enabled: form.value.enabled,
      options
    };

    if (editing.value) {
      if (form.value.start_ip) payload.start_ip = form.value.start_ip;
      if (form.value.end_ip) payload.end_ip = form.value.end_ip;
      await dhcpStore.updateScope(editing.value.id, payload);
      toast.add({ severity: 'success', summary: 'Scope updated', life: 3000 });
    } else {
      let rangeId = form.value.range_id;
      let subnetId = form.value.subnet_id;

      if (!rangeId && showRangePicker.value) {
        // Create a new DHCP Scope range from manual start/end IPs
        if (!form.value.start_ip || !form.value.end_ip) {
          toast.add({ severity: 'error', summary: 'Start IP and End IP are required', life: 5000 });
          saving.value = false;
          return;
        }
        if (!subnetId) {
          toast.add({ severity: 'error', summary: 'Please select a network', life: 5000 });
          saving.value = false;
          return;
        }

        // Look up DHCP Scope range type
        const rangeTypes = await subnetStore.getRangeTypes();
        const dhcpScopeType = rangeTypes.find(rt => rt.name === 'DHCP Scope' && rt.is_system);
        if (!dhcpScopeType) {
          toast.add({ severity: 'error', summary: 'DHCP Scope range type not found', life: 5000 });
          saving.value = false;
          return;
        }

        // Create range (server validates IPs are in subnet, checks overlaps, reserved IPs)
        const newRange = await subnetStore.createRange(subnetId, {
          range_type_id: dhcpScopeType.id,
          start_ip: form.value.start_ip,
          end_ip: form.value.end_ip,
          description: form.value.description || null
        });
        rangeId = newRange.id;
      } else if (rangeId) {
        const range = availableRanges.value.find(r => r.id === rangeId);
        if (range) subnetId = range.subnet_id;
      }

      await dhcpStore.createScope({
        range_id: rangeId,
        subnet_id: subnetId,
        ...payload
      });
      toast.add({ severity: 'success', summary: 'DHCP scope created', life: 3000 });
    }
    dialogVisible.value = false;
    window.dispatchEvent(new Event('ipam:stats-changed'));
    emit('saved');
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    saving.value = false;
  }
}

/**
 * Open dialog to edit an existing scope.
 * @param {Object} scope - scope object with options array, subnet_cidr, server_ip, subnet_domain_name
 */
async function openEdit(scope) {
  await loadOptions();
  editing.value = scope;
  showRangePicker.value = false;

  const selOpts = [];
  const optVals = {};
  if (scope.options && Array.isArray(scope.options)) {
    for (const o of scope.options) {
      selOpts.push(o.option_code);
      optVals[o.option_code] = o.value;
    }
  }
  form.value = {
    range_id: scope.range_id,
    subnet_id: scope.subnet_id,
    start_ip: scope.start_ip || '',
    end_ip: scope.end_ip || '',
    lease_time: scope.lease_time || '24h',
    description: scope.description || '',
    enabled: !!scope.enabled,
    selectedOptions: selOpts,
    optionValues: optVals
  };
  optionsExpanded.value = selOpts.length > 0;
  dialogVisible.value = true;
}

/**
 * Open dialog to create a new scope with the range picker (DHCP page flow).
 */
/**
 * Open dialog to create a new scope with the range picker.
 * @param {Object} [subnetCtx] - Optional subnet context { id, cidr, gateway_address, domain_name }
 */
async function openNewWithPicker(subnetCtx) {
  await loadOptions();
  editing.value = null;
  showRangePicker.value = true;

  const autoSelected = [];
  const autoValues = {};

  // Auto-select all enabled-by-default options
  for (const code of enabledDefaultCodes.value) {
    autoSelected.push(code);
    if (defaultValues[code] != null) autoValues[code] = defaultValues[code];
  }

  // Network-dependent overrides from subnet context
  if (subnetCtx) {
    if (subnetCtx.gateway_address) autoValues[3] = subnetCtx.gateway_address;
    if (subnetCtx.cidr) {
      const mask = computeMask(subnetCtx.cidr);
      if (mask) autoValues[1] = mask;
    }
    if (subnetCtx.domain_name) {
      autoValues[15] = subnetCtx.domain_name;
      autoValues[119] = subnetCtx.domain_name;
    }
  }

  form.value = {
    ...emptyForm(),
    subnet_id: subnetCtx?.id || null,
    description: (subnetCtx?.name || subnetCtx?.cidr) ? `${subnetCtx.name || subnetCtx.cidr} DHCP Scope` : '',
    selectedOptions: autoSelected,
    optionValues: autoValues
  };

  loadingRanges.value = true;
  try {
    const [ranges] = await Promise.all([
      dhcpStore.fetchAvailableRanges(),
      loadSubnetsList()
    ]);
    availableRanges.value = ranges.map(r => ({
      ...r,
      _label: `${r.subnet_name} (${r.start_ip} — ${r.end_ip})`
    }));
  } finally {
    loadingRanges.value = false;
  }
  optionsExpanded.value = autoSelected.length > 0;
  dialogVisible.value = true;
}

/**
 * Open dialog to create a new scope for a specific range (SubnetDetail flow).
 * @param {Object} opts - { rangeId, subnetId, gateway, cidr, domainName }
 */
async function openNewForRange(opts) {
  await loadOptions();
  editing.value = null;
  showRangePicker.value = false;

  // Auto-select enabled-by-default options
  const autoSelected = [];
  const autoValues = {};
  for (const code of enabledDefaultCodes.value) {
    autoSelected.push(code);
    if (defaultValues[code] != null) {
      autoValues[code] = defaultValues[code];
    }
  }

  // Override gateway from subnet if available
  if (opts.gateway) autoValues[3] = opts.gateway;

  // Auto-populate mask from CIDR
  if (opts.cidr) {
    const mask = computeMask(opts.cidr);
    if (mask) autoValues[1] = mask;
  }

  // Domain name + DNS search list
  if (opts.domainName) {
    if (!autoValues[15]) autoValues[15] = opts.domainName;
    if (!autoValues[119]) autoValues[119] = opts.domainName;
  }

  form.value = {
    ...emptyForm(),
    range_id: opts.rangeId,
    subnet_id: opts.subnetId,
    selectedOptions: autoSelected,
    optionValues: autoValues
  };
  optionsExpanded.value = autoSelected.length > 0;
  dialogVisible.value = true;
}

defineExpose({ openEdit, openNewWithPicker, openNewForRange, reloadOptions });
</script>

<style scoped>
.form-grid {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.field-row {
  display: flex;
  gap: 0.75rem;
}
.field label {
  display: block;
  margin-bottom: 0.35rem;
  font-size: 0.85rem;
  font-weight: 600;
}
.field-help {
  display: block;
  margin-top: 0.2rem;
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}
.or-divider {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
  margin: -0.25rem 0;
}
.or-divider::before,
.or-divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--p-surface-border);
}

/* Scope dialog inline options */
.scope-options-section {
  margin-top: 1rem;
  border: 1px solid var(--p-surface-border);
  border-radius: 6px;
  overflow: hidden;
}
.scope-options-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  cursor: pointer;
  user-select: none;
  background: var(--p-surface-ground);
  transition: background 0.1s;
}
.scope-options-header:hover {
  background: color-mix(in srgb, var(--p-primary-color) 5%, var(--p-surface-ground));
}
.scope-options-title {
  font-size: 0.85rem;
  font-weight: 600;
}
.scope-options-count {
  font-size: 0.75rem;
  color: var(--p-primary-color);
  margin-left: auto;
}
.scope-options-list {
  max-height: 18rem;
  overflow-y: auto;
}
.scope-option-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.35rem 0.75rem;
  border-top: 1px solid color-mix(in srgb, var(--p-surface-border) 50%, transparent);
  font-size: 0.8rem;
}
.scope-option-row:first-child {
  border-top: 1px solid var(--p-surface-border);
}
.scope-option-check {
  flex-shrink: 0;
}
.scope-option-info {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  min-width: 10rem;
  flex-shrink: 0;
}
.scope-option-label {
  font-weight: 500;
}
.scope-option-code {
  font-size: 0.7rem;
  color: var(--p-text-muted-color);
}
.scope-option-help {
  font-size: 0.7rem;
  color: var(--p-text-muted-color);
  cursor: pointer;
  margin-left: 0.15rem;
}
.scope-option-help:hover {
  color: var(--p-primary-color);
}
.scope-option-group-header {
  padding: 0.3rem 0.75rem;
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--p-text-muted-color);
  background: var(--p-surface-ground);
  border-top: 1px solid var(--p-surface-border);
}
.scope-option-value {
  flex: 1;
  min-width: 0;
}
.scope-option-value :deep(.p-inputtext),
.scope-option-value :deep(.p-select),
.scope-option-value :deep(.p-inputnumber) {
  width: 100%;
  font-size: 0.8rem;
}
.scope-option-default {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
  font-style: italic;
}

.options-disabled {
  opacity: 0.5;
  pointer-events: none;
}

/* Help popover */
.option-help-popover {
  max-width: 20rem;
  font-size: 0.8rem;
  line-height: 1.4;
}
.option-help-popover strong {
  display: block;
  margin-bottom: 0.3rem;
}
.option-help-popover p {
  margin: 0 0 0.4rem 0;
  color: var(--p-text-muted-color);
}
.rfc-link {
  font-size: 0.75rem;
  color: var(--p-primary-color);
  text-decoration: none;
}
.rfc-link:hover { text-decoration: underline; }
</style>
