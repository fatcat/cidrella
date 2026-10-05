<template>
  <div class="bulk-page">
    <div class="bulk-toolbar">
      <SelectButton
        v-if="features.ipv6.value"
        v-model="family"
        :options="FAMILY_OPTIONS"
        optionLabel="label"
        optionValue="value"
        :allowEmpty="false"
        size="small"
        data-track="dhcp-bulk-family"
      />
      <span class="bulk-toolbar-spacer" />
      <Button
        label="Reset to shipped defaults"
        icon="pi pi-replay"
        size="small"
        severity="secondary"
        data-track="dhcp-bulk-reset-shipped"
        @click="loadSource('shipped')"
      />
      <Button
        label="Reload my defaults"
        icon="pi pi-refresh"
        size="small"
        severity="secondary"
        data-track="dhcp-bulk-reload-defaults"
        @click="loadSource('saved')"
      />
    </div>

    <p class="field-help bulk-lede">
      Set the options below, pick the scopes that should take them, and apply. Nothing changes until
      you do.
      <StatusDot
        :kind="source === 'saved' && !edited ? 'ok' : 'warn'"
        :label="sourceLabel"
        show-label
        data-track="dhcp-bulk-source"
      />
    </p>

    <div class="bulk-grid">
      <section class="bulk-panel">
        <header class="bulk-panel-head">Options to apply</header>
        <DhcpOptionTable
          :values="values"
          :enabled="enabled"
          :family="family"
          :rows="optionRows"
          :loading="loadingOptions"
          value-header="Value"
          enabled-header="Apply"
          :changed-codes="changedCodes"
          check-on-value
        />
      </section>

      <section class="bulk-panel">
        <header class="bulk-panel-head">
          <span>{{ familyLabel }} scopes</span>
          <span class="muted">{{ selected.length }} of {{ eligible.length }} selected</span>
        </header>
        <div class="bulk-scopes">
          <EmptyState
            v-if="!previewError && previewed && !scopes.length"
            icon="pi-server"
            :title="`No ${familyLabel} scopes`"
            description="Scopes are created with a network's DHCP settings."
          />
          <p v-else-if="previewError" class="field-error bulk-error">{{ previewError }}</p>
          <table v-else class="bulk-scope-table">
            <thead>
              <tr>
                <th class="col-check">
                  <Checkbox
                    :modelValue="allSelected"
                    :indeterminate="someSelected"
                    binary
                    ariaLabel="Select every scope"
                    :disabled="!eligible.length"
                    data-track="dhcp-bulk-select-all"
                    @update:modelValue="toggleAll"
                  />
                </th>
                <th>Scope</th>
                <th>Pool</th>
                <th class="col-change">Change</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="scope in scopes" :key="scope.id">
                <tr
                  :class="{
                    'is-selected': isSelected(scope.id),
                    'is-skipped': scope.skip_reason,
                  }"
                  :data-scope-id="scope.id"
                  :title="scope.skip_reason || undefined"
                >
                  <td class="col-check">
                    <Checkbox
                      :modelValue="isSelected(scope.id)"
                      binary
                      :disabled="!!scope.skip_reason"
                      :ariaLabel="`Apply to ${scopeName(scope)}`"
                      @update:modelValue="toggle(scope.id, $event)"
                    />
                  </td>
                  <td>
                    <div class="scope-name">{{ scopeName(scope) }}</div>
                    <div class="mono text-sm muted">{{ scope.subnet_cidr }}</div>
                  </td>
                  <td class="mono text-sm muted">
                    <template v-if="scope.pools[0]">
                      {{ scope.pools[0].start_ip }} – {{ scope.pools[0].end_ip }}
                    </template>
                    <template v-else>{{ EMPTY_CELL }}</template>
                  </td>
                  <td class="col-change">
                    <span v-if="scope.skip_reason" class="text-sm muted skip-reason">
                      {{ scope.skip_reason }}
                    </span>
                    <span v-else-if="!scope.changes.length" class="text-sm muted">Matches</span>
                    <Button
                      v-else
                      :label="`${scope.changes.length} ${plural(scope.changes.length, 'option')}`"
                      :icon="expanded.has(scope.id) ? 'pi pi-chevron-up' : 'pi pi-chevron-down'"
                      iconPos="right"
                      size="small"
                      text
                      data-track="dhcp-bulk-scope-changes"
                      @click="toggleExpanded(scope.id)"
                    />
                  </td>
                </tr>
                <tr v-if="expanded.has(scope.id) && scope.changes.length" class="change-row">
                  <td />
                  <td colspan="3">
                    <dl class="change-list">
                      <template v-for="change in scope.changes" :key="change.code">
                        <dt>{{ optionLabel(change.code) }} ({{ change.code }})</dt>
                        <dd class="mono">
                          <template v-if="change.before != null">
                            <s class="change-before">{{ change.before }}</s>
                            <span v-if="change.after != null" aria-hidden="true"> → </span>
                          </template>
                          <span v-if="change.after != null" class="change-after">
                            {{ change.after }}
                          </span>
                          <span v-else class="muted"> removed</span>
                        </dd>
                      </template>
                    </dl>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
        <footer class="bulk-panel-foot">
          <label class="save-defaults">
            <Checkbox
              v-model="saveDefaults"
              binary
              inputId="dhcp-bulk-save-defaults"
              data-track="dhcp-bulk-save-defaults"
            />
            <span>
              Also make these my {{ familyLabel }} defaults
              <span class="text-sm muted save-defaults-help">
                New scopes start with them too. Off: only the selected scopes change.
              </span>
            </span>
          </label>
          <div class="apply-row">
            <Button
              :label="`Apply to ${selected.length} ${plural(selected.length, 'scope')}`"
              size="small"
              :disabled="!selected.length || !!previewError"
              data-track="dhcp-bulk-apply"
              @click="showConfirm = true"
            />
            <span class="text-sm muted">{{ applySummary }}</span>
          </div>
        </footer>
      </section>
    </div>

    <ConfirmDialog
      v-model:visible="showConfirm"
      :header="`Change ${selected.length} ${familyLabel} ${plural(selected.length, 'scope')}`"
      severity="warn"
      :confirm-label="`Apply to ${selected.length} ${plural(selected.length, 'scope')}`"
      confirm-icon="pi pi-check"
      width="28rem"
      :loading="applying"
      data-track="dialog-dhcp-bulk-apply"
      @confirm="apply"
    >
      <p>
        Each selected scope gets exactly the options ticked under Apply; any other option it has is
        removed. Lease time and pools stay as they are.
      </p>
      <p>{{ applySummary }}.</p>
    </ConfirmDialog>
  </div>
</template>

<script setup>
// Settings, DHCP, Bulk Change: the defaults editor, applied to existing
// scopes. The editor starts from the family's saved defaults; the server
// previews what each scope would end up with (filling blank network values
// per scope, as for a new scope) and applies it to the selected ones.
import { ref, reactive, computed, watch, onMounted } from 'vue';
import Button from '../ui/Button.js';
import Checkbox from '../ui/Checkbox.js';
import SelectButton from '../ui/SelectButton.js';
import { useToast } from '../ui/useToast.js';
import EmptyState from '../components/EmptyState.vue';
import StatusDot from '../components/StatusDot.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import DhcpOptionTable from '../components/dhcp/DhcpOptionTable.vue';
import {
  useDhcpOptionCatalog,
  fillByCode,
  optionEditorPayload,
} from '../composables/useDhcpOptionCatalog.js';
import { useFeatures } from '../composables/useFeatures.js';
import api from '../api/client.js';
import { apiError, EMPTY_CELL } from '../utils/format.js';

const FAMILY_OPTIONS = [
  { label: 'IPv4', value: 4 },
  { label: 'IPv6', value: 6 },
];
const PREVIEW_DELAY_MS = 300;

const toast = useToast();
const features = useFeatures();
const family = ref(4);
const familyLabel = computed(() => (family.value === 6 ? 'DHCPv6' : 'DHCPv4'));

const {
  catalog,
  rows: optionRows,
  loading: loadingOptions,
  load: loadCatalog,
} = useDhcpOptionCatalog(() => family.value);

const values = reactive({});
const enabled = reactive({});
// What the editor was last loaded from, and the saved and shipped sets.
const source = ref('saved');
const saved = ref({ defaults: {}, enabledDefaults: [] });
const shipped = ref({ defaults: {}, enabledDefaults: [] });

const plural = (n, word) => (n === 1 ? word : `${word}s`);

function editorState(set) {
  return {
    values: Object.fromEntries(
      Object.entries(set.defaults || {}).map(([code, value]) => [Number(code), String(value)]),
    ),
    enabled: new Set((set.enabledDefaults || []).map(Number)),
  };
}

function differsFrom(set) {
  const state = editorState(set);
  const codes = new Set();
  for (const code of new Set([...Object.keys(values), ...Object.keys(state.values)].map(Number))) {
    const current = values[code] == null || values[code] === '' ? undefined : String(values[code]);
    if (current !== state.values[code]) codes.add(code);
  }
  for (const code of new Set([...Object.keys(enabled).map(Number), ...state.enabled])) {
    if (Boolean(enabled[code]) !== state.enabled.has(code)) codes.add(code);
  }
  return codes;
}

// Highlighted: what differs from the saved defaults, so a reset to shipped
// shows what it changed.
const changedCodes = computed(() => differsFrom(saved.value));
const edited = computed(
  () => differsFrom(source.value === 'shipped' ? shipped.value : saved.value).size > 0,
);
const sourceLabel = computed(() => {
  const from =
    source.value === 'shipped'
      ? 'Shipped defaults'
      : `Loaded from your ${familyLabel.value} defaults`;
  if (!edited.value) {
    return source.value === 'shipped' ? `${from}, not saved yet` : from;
  }
  return `${source.value === 'shipped' ? 'Shipped defaults' : `Your ${familyLabel.value} defaults`}, edited`;
});

function loadSource(which) {
  const set = which === 'shipped' ? shipped.value : saved.value;
  fillByCode(values, Object.entries(set.defaults || {}));
  fillByCode(
    enabled,
    (set.enabledDefaults || []).map((code) => [code, true]),
  );
  source.value = which;
}

async function loadOptions() {
  try {
    const data = await loadCatalog();
    saved.value = { defaults: data.defaults || {}, enabledDefaults: data.enabledDefaults || [] };
    shipped.value = data.shipped || { defaults: {}, enabledDefaults: [] };
    loadSource('saved');
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  }
}

// Scopes and what each would get, from the server's preview.
const scopes = ref([]);
const previewed = ref(false);
const previewError = ref('');
const selected = ref([]);
const expanded = reactive(new Set());
const saveDefaults = ref(true);
const showConfirm = ref(false);
const applying = ref(false);

const eligible = computed(() => scopes.value.filter((scope) => !scope.skip_reason));
const isSelected = (id) => selected.value.includes(id);
const allSelected = computed(
  () => eligible.value.length > 0 && selected.value.length === eligible.value.length,
);
const someSelected = computed(() => selected.value.length > 0 && !allSelected.value);

// Ticking a scope opens its changes, so what Apply will do is in view;
// unticking closes them. The "N options" button still opens any scope.
function toggle(id, on) {
  selected.value = on
    ? [...new Set([...selected.value, id])]
    : selected.value.filter((other) => other !== id);
  if (on) expanded.add(id);
  else expanded.delete(id);
}
function toggleAll(on) {
  selected.value = on ? eligible.value.map((scope) => scope.id) : [];
  expanded.clear();
  for (const id of selected.value) expanded.add(id);
}
function toggleExpanded(id) {
  if (expanded.has(id)) expanded.delete(id);
  else expanded.add(id);
}

const scopeName = (scope) => scope.subnet_name || scope.description || scope.subnet_cidr;
const optionLabel = (code) => catalog.value.find((opt) => opt.code === code)?.label || 'Option';

const applySummary = computed(() => {
  const changes = scopes.value
    .filter((scope) => isSelected(scope.id))
    .reduce((sum, scope) => sum + scope.changes.length, 0);
  const parts = [`${changes} option ${plural(changes, 'change')}`];
  if (saveDefaults.value) parts.push('and your defaults');
  return parts.join(', ');
});

function requestBody() {
  return {
    family: family.value,
    ...optionEditorPayload(catalog.value, values, enabled),
    save_defaults: saveDefaults.value,
  };
}

let previewTimer = null;
let previewSeq = 0;
async function preview() {
  const seq = ++previewSeq;
  try {
    const res = await api.post('/dhcp/scopes/bulk-options/preview', requestBody());
    if (seq !== previewSeq) return;
    scopes.value = res.data.scopes;
    const ids = new Set(eligible.value.map((scope) => scope.id));
    selected.value = selected.value.filter((id) => ids.has(id));
    previewError.value = '';
  } catch (err) {
    if (seq !== previewSeq) return;
    previewError.value = apiError(err);
  } finally {
    if (seq === previewSeq) previewed.value = true;
  }
}
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(preview, PREVIEW_DELAY_MS);
}

watch([values, enabled, saveDefaults], schedulePreview, { deep: true });
watch(family, async () => {
  selected.value = [];
  expanded.clear();
  scopes.value = [];
  previewed.value = false;
  await loadOptions();
});

async function apply() {
  applying.value = true;
  try {
    const res = await api.post('/dhcp/scopes/bulk-options', {
      ...requestBody(),
      scope_ids: selected.value,
    });
    const count = res.data.applied.length;
    showConfirm.value = false;
    toast.add({
      severity: 'success',
      summary: `${count} ${familyLabel.value} ${plural(count, 'scope')} changed`,
      detail: saveDefaults.value ? 'Your defaults were saved too.' : undefined,
      life: 4000,
    });
    if (saveDefaults.value) {
      saved.value = {
        defaults: Object.fromEntries(
          requestBody().options.map((option) => [option.code, option.value]),
        ),
        enabledDefaults: requestBody().enabledDefaults,
      };
      source.value = 'saved';
    }
    expanded.clear();
    selected.value = [];
    await preview();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally {
    applying.value = false;
  }
}

onMounted(loadOptions);
</script>

<style scoped>
.bulk-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.bulk-toolbar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}
.bulk-toolbar-spacer {
  flex: 1;
}
.bulk-lede {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin: 0 0 0.75rem;
}
.bulk-grid {
  flex: 1 1 0;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
  gap: 1rem;
}
.bulk-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1px solid var(--cid-content-border-color);
  border-radius: var(--cid-form-field-border-radius);
  background: var(--cid-content-background);
  overflow: hidden;
}
.bulk-panel-head {
  display: flex;
  justify-content: space-between;
  padding: 0.6rem 0.75rem;
  border-bottom: 1px solid var(--cid-content-border-color);
  font-size: var(--app-fs-xs);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.bulk-scopes {
  flex: 1 1 0;
  min-height: 0;
  overflow: auto;
}
.bulk-error {
  padding: 0.75rem;
}
.bulk-scope-table {
  width: 100%;
  border-collapse: collapse;
}
.bulk-scope-table th {
  position: sticky;
  top: 0;
  background: var(--cid-content-background);
  text-align: left;
  font-weight: 600;
  font-size: var(--app-fs-sm);
  padding: 0.5rem;
  border-bottom: 1px solid var(--cid-content-border-color);
}
.bulk-scope-table td {
  padding: 0.5rem;
  vertical-align: top;
  border-bottom: 1px solid var(--cid-content-border-color);
}
.bulk-scope-table .col-check {
  width: 2.25rem;
}
.bulk-scope-table .col-change {
  white-space: nowrap;
}
.skip-reason {
  white-space: normal;
}
.bulk-scope-table tr.is-selected td {
  background: var(--cid-highlight-background);
}
.bulk-scope-table tr.is-skipped td {
  opacity: 0.55;
}
.scope-name {
  font-weight: 600;
}
.change-row td {
  padding-top: 0;
}
.change-list {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 0.35rem 1rem;
  margin: 0;
  font-size: var(--app-fs-sm);
}
.change-list dt {
  color: var(--cid-text-muted-color);
}
.change-list dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.change-before {
  color: var(--cid-red-400);
}
.change-after {
  color: var(--cid-green-400);
}
.bulk-panel-foot {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 0.75rem;
  border-top: 1px solid var(--cid-content-border-color);
}
.save-defaults {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  cursor: pointer;
}
.save-defaults-help {
  display: block;
}
.apply-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
</style>
