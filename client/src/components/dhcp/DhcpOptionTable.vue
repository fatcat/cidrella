<template>
  <DataTable
    :value="rows"
    size="small"
    :loading="loading"
    rowGroupMode="subheader"
    groupRowsBy="_group"
    :rowClass="(data) => (enabled[data.code] ? 'option-enabled-row' : '')"
    scrollable
    scrollHeight="flex"
    class="dhcp-option-table"
  >
    <template #groupheader="{ data }">
      <strong>{{ data._group }}</strong>
    </template>
    <template #empty>
      <EmptyState
        icon="pi-sliders-h"
        :title="`No ${familyLabel} options`"
        description="Options appear here once a scope or global option is defined."
      />
    </template>
    <Column field="code" header="Code" style="width: 4rem" />
    <Column field="label" header="Option" style="min-width: 12rem">
      <template #body="{ data }">
        {{ data.label }}
        <i class="pi pi-question-circle option-help-icon" @click="showOptionHelp($event, data)" />
      </template>
    </Column>
    <Column field="type" header="Type" style="width: 6rem">
      <template #body="{ data }">
        <span class="text-sm muted">{{ data.type }}</span>
      </template>
    </Column>
    <Column :header="valueHeader" style="min-width: 14rem">
      <template #body="{ data }">
        <div :class="{ 'option-changed': changedCodes.has(data.code) }">
          <!-- A built-in option (DHCPv6 Rapid Commit) is dnsmasq's to send:
               nothing to set, so it reads as always on. -->
          <span v-if="data.builtIn" class="text-sm muted" data-track="dhcp-option-built-in">
            Always on
          </span>
          <Select
            v-else-if="data.type === 'select'"
            :modelValue="values[data.code]"
            @update:modelValue="setValue(data.code, $event)"
            :options="data.choices"
            class="w-full"
            size="small"
            showClear
            placeholder="—"
          />
          <InputNumber
            v-else-if="data.type === 'number'"
            :modelValue="values[data.code]"
            @update:modelValue="setValue(data.code, $event)"
            @input="setValue(data.code, $event.value)"
            class="w-full"
            size="small"
            :useGrouping="false"
            placeholder="—"
          />
          <InputText
            v-else
            :modelValue="values[data.code]"
            @update:modelValue="setValue(data.code, $event)"
            class="w-full"
            size="small"
            :placeholder="getOptionPlaceholder(data.code, data.type)"
            @blur="data.type === 'ip-list' || data.type === 'ip' ? resolveValue(data.code) : null"
          />
        </div>
      </template>
    </Column>
    <Column :header="enabledHeader" style="width: 9rem; text-align: center">
      <template #body="{ data }">
        <Checkbox
          v-if="!data.builtIn"
          :modelValue="!!enabled[data.code]"
          binary
          :ariaLabel="`${enabledHeader}: ${data.label}`"
          @update:modelValue="enabled[data.code] = $event"
        />
      </template>
    </Column>
    <Column header="" style="width: 3rem">
      <template #body="{ data }">
        <div class="action-buttons">
          <Button
            v-if="!data.builtIn"
            icon="pi pi-times"
            severity="secondary"
            text
            rounded
            size="small"
            @click="values[data.code] = null"
            title="Clear"
          />
          <Button
            v-if="data.custom && deletableCustom"
            icon="pi pi-trash"
            severity="danger"
            text
            rounded
            size="small"
            @click="emit('delete-custom', data.code)"
            title="Delete custom option"
          />
        </div>
      </template>
    </Column>
  </DataTable>

  <Popover ref="helpPopoverRef">
    <div class="option-help-popover">
      <strong>{{ helpPopoverData.label }}</strong>
      <p>{{ helpPopoverData.description }}</p>
      <a
        v-if="helpPopoverData.rfcUrl"
        :href="helpPopoverData.rfcUrl"
        target="_blank"
        rel="noopener"
        class="rfc-link"
      >
        {{ helpPopoverData.rfc }}
      </a>
    </div>
  </Popover>
</template>

<script setup>
// The DHCP option editor table: one row per catalog option with its value and
// a checkbox column. Settings uses it for the family's defaults ("Enabled by
// Default") and Bulk Change for what scopes get ("Apply"). Values and checks
// are code-keyed objects the parent owns.
import { ref, computed } from 'vue';
import Button from '../../ui/Button.js';
import Checkbox from '../../ui/Checkbox.js';
import DataTable from '../../ui/DataTable.js';
import Column from '../../ui/Column.js';
import InputText from '../../ui/InputText.js';
import InputNumber from '../../ui/InputNumber.js';
import Select from '../../ui/Select.js';
import Popover from '../../ui/Popover.js';
import EmptyState from '../EmptyState.vue';
import api from '../../api/client.js';
import { useToast } from '../../ui/useToast.js';
import { resolveHostname, placeholderForType } from '../../utils/resolveHostname.js';

const props = defineProps({
  family: { type: Number, default: 4 },
  rows: { type: Array, required: true },
  loading: { type: Boolean, default: false },
  valueHeader: { type: String, default: 'Default Value' },
  enabledHeader: { type: String, default: 'Enabled by Default' },
  // Codes whose value or check differs from where the editor started.
  changedCodes: { type: Set, default: () => new Set() },
  deletableCustom: { type: Boolean, default: false },
  // Tick a row when a value is typed into it while blank (Bulk Change,
  // where a value only reaches a scope with Apply ticked).
  checkOnValue: { type: Boolean, default: false },
});
// The parent's reactive objects, edited in place (never replaced).
const values = defineModel('values', { type: Object, required: true });
const enabled = defineModel('enabled', { type: Object, required: true });
const emit = defineEmits(['delete-custom']);

const toast = useToast();
const isV6 = computed(() => Number(props.family) === 6);
const familyLabel = computed(() => (isV6.value ? 'DHCPv6' : 'DHCPv4'));

const DHCP_PLACEHOLDERS = {
  4: {
    1: "Defaults to network's mask",
    3: "Defaults to network's gateway",
    15: "Defaults to network's domain",
    119: "Defaults to network's domain",
  },
  6: {
    23: "Defaults to CIDRella's IPv6 address on the network",
    24: "Defaults to network's domain",
  },
};

function getOptionPlaceholder(code, type) {
  return DHCP_PLACEHOLDERS[isV6.value ? 6 : 4][code] || placeholderForType(type, props.family);
}

const isBlank = (value) => value == null || value === '';

// InputNumber commits its model only on blur, so its typing arrives through
// @input; both paths land here.
function setValue(code, value) {
  if (props.checkOnValue && isBlank(values.value[code]) && !isBlank(value)) {
    enabled.value[code] = true;
  }
  values.value[code] = value;
}

async function resolveValue(code) {
  const val = values.value[code];
  if (!val) return;
  const resolved = await resolveHostname(val, api, toast, props.family);
  if (resolved !== val) values.value[code] = resolved;
}

const helpPopoverRef = ref(null);
const helpPopoverData = ref({ label: '', description: '', rfc: '', rfcUrl: '' });

function showOptionHelp(event, opt) {
  helpPopoverData.value = {
    label: opt.label,
    description: opt.description || '',
    rfc: opt.rfc || '',
    rfcUrl: opt.rfcUrl || '',
  };
  helpPopoverRef.value.toggle(event);
}
</script>

<style scoped>
/* The flex-scroll table sizes itself to 100% of its parent and ignores
   siblings above it, so its last rows would sit under the panel's clip edge.
   Let it take the remaining height instead. */
.dhcp-option-table.p-datatable-flex-scrollable {
  flex: 1 1 0;
  min-height: 0;
  height: auto;
}

.option-help-icon {
  font-size: var(--app-fs-xs);
  color: var(--cid-text-muted-color);
  cursor: pointer;
  margin-left: 0.3rem;
  vertical-align: middle;
}
.option-help-icon:hover {
  color: var(--cid-primary-color);
}

/* Subtle highlight for checked rows */
:deep(.option-enabled-row) {
  background: color-mix(in srgb, var(--cid-primary-color) 6%, transparent) !important;
}

/* A value changed from where the editor started. */
.option-changed :deep(.p-inputtext),
.option-changed :deep(.p-select),
.option-changed :deep(.p-inputnumber-input) {
  border-color: var(--cid-primary-color);
}
</style>
