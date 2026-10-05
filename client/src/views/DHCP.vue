<template>
  <div class="dhcp-page" style="display: flex; flex-direction: column; height: 100%">
    <!-- Option Defaults -->
    <div class="section-header">
      <Button
        label="Add Custom Option"
        icon="pi pi-plus"
        size="small"
        severity="secondary"
        @click="
          customOptionForm = { code: null, label: '', name: '', type: 'text', description: '' };
          showCustomOptionDialog = true;
        "
      />
      <Button
        label="Apply Config"
        icon="pi pi-refresh"
        size="small"
        :data-track="track('sys-apply-dhcp-config')"
        @click="applyConfig"
      />
      <Button
        label="Save Defaults"
        icon="pi pi-save"
        size="small"
        :data-track="track('dhcp-save-defaults')"
        @click="saveDefaults"
        :loading="savingDefaults"
        :disabled="!defaultsDirty"
      />
    </div>
    <p class="field-help dhcp-defaults-note">
      These settings are the defaults for newly created {{ familyLabel }} scopes. To give existing
      scopes these settings, use Bulk Change.
      <template v-if="isV6">
        Routers, prefixes and address lifetimes come from Router Advertisements and are not options;
        a SLAAC-only scope sends no options at all.
      </template>
    </p>
    <DhcpOptionTable
      :values="defaultValues"
      :enabled="defaultEnabled"
      :family="family"
      :rows="optionRows"
      :loading="loadingOptions"
      deletable-custom
      @delete-custom="deleteCustomOption"
    />

    <!-- Custom Option Dialog -->
    <Dialog
      v-model:visible="showCustomOptionDialog"
      header="Add Custom Option"
      modal
      :style="{ width: '26rem' }"
      :data-track="track('dialog-dhcp-custom-option')"
    >
      <div class="form-grid">
        <div class="field">
          <label>Option Code ({{ customRange[0] }}–{{ customRange[1] }}) *</label>
          <InputNumber
            v-model="customOptionForm.code"
            class="w-full"
            :min="customRange[0]"
            :max="customRange[1]"
            :useGrouping="false"
            placeholder="e.g. 200"
          />
        </div>
        <div class="field">
          <label>Label *</label>
          <InputText
            v-model="customOptionForm.label"
            class="w-full"
            placeholder="e.g. Vendor Config URL"
          />
        </div>
        <div class="field">
          <label>Type</label>
          <Select
            v-model="customOptionForm.type"
            :options="['ip', 'ip-list', 'text', 'text-list', 'number']"
            class="w-full"
          />
        </div>
        <div class="field">
          <label>Description</label>
          <InputText
            v-model="customOptionForm.description"
            class="w-full"
            placeholder="Brief explanation"
          />
        </div>
      </div>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showCustomOptionDialog = false" />
        <Button
          label="Create"
          @click="createCustomOption"
          :loading="savingCustomOption"
          :disabled="!customOptionForm.code || !customOptionForm.label"
        />
      </template>
    </Dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { useToast } from '../ui/useToast.js';
import Button from '../ui/Button.js';
import Dialog from '../ui/Dialog.js';
import InputText from '../ui/InputText.js';
import InputNumber from '../ui/InputNumber.js';
import Select from '../ui/Select.js';
import DhcpOptionTable from '../components/dhcp/DhcpOptionTable.vue';
import {
  useDhcpOptionCatalog,
  fillByCode,
  optionEditorPayload,
} from '../composables/useDhcpOptionCatalog.js';
import { useDhcpStore } from '../stores/dhcp.js';
import api from '../api/client.js';
import { apiError } from '../utils/format.js';

// One editor for both families. The family decides which catalog is
// fetched, which rows a save replaces and how the request is shaped; the
// server keeps DHCPv4 and DHCPv6 defaults in separate namespaces.
const props = defineProps({
  family: { type: Number, default: 4 },
});
const isV6 = computed(() => Number(props.family) === 6);
const familyLabel = computed(() => (isV6.value ? 'DHCPv6' : 'DHCPv4'));
// The IPv4 editor keeps its historic tracking ids; the IPv6 one is suffixed.
const track = (id) => (isV6.value ? `${id}-v6` : id);

const store = useDhcpStore();
const toast = useToast();

// DHCP Options
const {
  catalog: optionCatalog,
  rows: optionRows,
  customRange,
  loading: loadingOptions,
  load: loadCatalog,
} = useDhcpOptionCatalog(() => props.family);
const defaultValues = reactive({});
const defaultEnabled = reactive({});
const savingDefaults = ref(false);
const savedDefaultsSnapshot = ref('');

const defaultsDirty = computed(() => {
  if (!savedDefaultsSnapshot.value) return false;
  const current = JSON.stringify({ v: defaultValues, e: defaultEnabled });
  return current !== savedDefaultsSnapshot.value;
});

function snapshotDefaults() {
  savedDefaultsSnapshot.value = JSON.stringify({
    v: { ...defaultValues },
    e: { ...defaultEnabled },
  });
}

// Custom option dialog
const showCustomOptionDialog = ref(false);
const savingCustomOption = ref(false);
const customOptionForm = ref({ code: null, label: '', name: '', type: 'text', description: '' });

async function createCustomOption() {
  savingCustomOption.value = true;
  try {
    const f = customOptionForm.value;
    await api.post('/dhcp/options/custom', {
      code: f.code,
      label: f.label,
      name: f.name || `custom-${f.code}`,
      type: f.type,
      description: f.description,
      address_family: props.family,
    });
    showCustomOptionDialog.value = false;
    toast.add({ severity: 'success', summary: 'Custom option created', life: 3000 });
    await loadOptions();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally {
    savingCustomOption.value = false;
  }
}

async function deleteCustomOption(code) {
  try {
    await api.delete(`/dhcp/options/custom/${code}`, { params: { family: props.family } });
    toast.add({ severity: 'success', summary: 'Custom option deleted', life: 3000 });
    await loadOptions();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  }
}

async function loadOptions() {
  try {
    const data = await loadCatalog();
    fillByCode(defaultValues, Object.entries(data.defaults || {}));
    fillByCode(
      defaultEnabled,
      (data.enabledDefaults || []).map((code) => [code, true]),
    );
    snapshotDefaults();
  } catch (err) {
    console.error('Failed to load DHCP options:', err);
  }
}

async function saveDefaults() {
  savingDefaults.value = true;
  try {
    const { options, enabledDefaults } = optionEditorPayload(
      optionCatalog.value,
      defaultValues,
      defaultEnabled,
    );
    await api.put('/dhcp/options/defaults', { family: props.family, options, enabledDefaults });
    snapshotDefaults();
    toast.add({ severity: 'success', summary: 'Defaults saved', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally {
    savingDefaults.value = false;
  }
}

async function applyConfig() {
  try {
    const result = await store.applyConfig();
    const reservationLabel = `DHCP Reservation${result.reservations === 1 ? '' : 's'}`;
    toast.add({
      severity: 'success',
      summary: 'Config applied',
      detail: `${result.scopes} scopes, ${result.reservations} ${reservationLabel}`,
      life: 3000,
    });
    for (let i = 0; i < 3; i++) {
      setTimeout(() => window.dispatchEvent(new Event('ipam:stats-changed')), (i + 1) * 2000);
    }
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  }
}

onMounted(async () => {
  await loadOptions();
});
</script>

<style scoped>
.section-header {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-bottom: 0.35rem;
}

.dhcp-defaults-note {
  margin: 0 0 0.75rem;
}

.form-grid {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.field label {
  display: block;
  margin-bottom: 0.4rem;
  font-size: var(--app-fs-sm);
  font-weight: 500;
}
</style>
