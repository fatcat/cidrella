<template>
  <Dialog
    :visible="visible"
    :header="range ? 'Edit Network Range' : 'Add Network Range'"
    modal
    :style="{ width: '30rem' }"
    data-track="workspace-range-editor"
    :close-on-escape="!confirmingDelete && !overlap"
    @update:visible="requestClose"
  >
    <form class="workspace-range-form" @submit.prevent="save(false)">
      <label>
        Network Range Type
        <Select
          v-model="form.range_type_id"
          :options="typeOptions"
          optionLabel="name"
          optionValue="id"
          placeholder="Choose a type"
          class="w-full"
          data-track="workspace-range-type-select"
        />
      </label>
      <!-- A new label is made here, in the same save as the range that
           wears it, instead of a trip to Settings first. -->
      <RangeTypeFields v-if="creatingType" v-model="newType" />
      <label>
        Start IP
        <InputText v-model="form.start_ip" class="w-full" required />
      </label>
      <label>
        End IP
        <InputText v-model="form.end_ip" class="w-full" required />
      </label>
      <label>
        Description
        <InputText v-model="form.description" class="w-full" maxlength="1024" />
      </label>
      <p class="workspace-range-help">
        This label is organizational only. It does not change allocation, DHCP, DNS, scanning, or
        whether an address is online.
      </p>
      <p v-if="error" class="workspace-range-error" role="alert">{{ error }}</p>
      <DiscardPrompt v-if="confirmingDiscard" @keep="keepEditing" @discard="discard" />
      <button type="submit" class="workspace-range-native-submit" hidden>Save</button>
    </form>

    <template #footer>
      <Button
        v-if="range && !isProtectedRange(range)"
        label="Delete"
        severity="danger"
        text
        data-track="workspace-range-delete"
        @click="confirmingDelete = true"
      />
      <Button label="Cancel" severity="secondary" @click="requestClose()" />
      <Button
        :label="range ? 'Save' : 'Create'"
        :loading="busy"
        :disabled="!isValid"
        data-track="workspace-range-save"
        @click="save(false)"
      />
    </template>
  </Dialog>

  <ConfirmDialog
    v-model:visible="confirmingDelete"
    header="Delete Network Range"
    width="28rem"
    confirm-label="Delete label"
    :loading="busy"
    data-track="workspace-range-delete-confirm"
    confirm-track="workspace-range-delete-confirm-action"
    @confirm="remove"
  >
    <p>
      Delete {{ range?.start_ip }} to {{ range?.end_ip }}? This removes only the organizational
      label. It does not release or otherwise change the addresses.
    </p>
    <p v-if="error" class="workspace-range-error" role="alert">{{ error }}</p>
  </ConfirmDialog>

  <ConfirmDialog
    :visible="Boolean(overlap)"
    header="Review overlapping range labels"
    width="32rem"
    severity="warn"
    confirm-label="Accept replacement"
    cancel-label="Keep existing labels"
    :loading="busy"
    data-track="workspace-range-overlap"
    confirm-track="workspace-range-overlap-accept"
    @cancel="cancelOverlap"
    @confirm="save(true)"
  >
    <p>The requested range overlaps these organizational labels:</p>
    <ul>
      <li v-for="item in overlap?.overlaps || []" :key="item.id">
        {{ item.type }}: {{ item.start_ip }} to {{ item.end_ip }}
      </li>
    </ul>
    <p>Accepting replaces only the requested addresses and preserves unaffected fragments.</p>
  </ConfirmDialog>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue';
import Button from '../../../ui/Button.js';
import Dialog from '../../../ui/Dialog.js';
import InputText from '../../../ui/InputText.js';
import Select from '../../../ui/Select.js';
import { apiError } from '../../../utils/format.js';
import RangeTypeFields from './RangeTypeFields.vue';
import { isProtectedRange, useRangeActions } from '../composables/useRangeActions.js';
import { useDiscardGuard } from '../composables/useDiscardGuard.js';
import './range-dialogs.css';
import DiscardPrompt from './DiscardPrompt.vue';
import ConfirmDialog from '../../../components/ConfirmDialog.vue';

const props = defineProps({
  visible: { type: Boolean, default: false },
  subnetId: { type: [Number, String], required: true },
  range: { type: Object, default: null },
  rangeTypes: { type: Array, default: () => [] },
});
const emit = defineEmits(['update:visible', 'saved', 'deleted', 'type-created']);
const { busy, createRange, createRangeType, updateRange, deleteRange } = useRangeActions();
const overlap = ref(null);
const confirmingDelete = ref(false);
const error = ref('');
const NEW_TYPE = 'new';
const form = reactive({ range_type_id: null, start_ip: '', end_ip: '', description: '' });
const newType = ref({ name: '', color: '#14b8a6', description: '' });
let baseline = JSON.stringify(form);
// Types made from this dialog join the list at once; the parent's list
// catches up when it reloads after the save. Cleared on every open, and
// merged by id, so a type that has since arrived in the prop is one entry.
const createdTypes = ref([]);
const customTypes = computed(() => {
  const byId = new Map();
  for (const type of [...props.rangeTypes, ...createdTypes.value]) {
    if (!type.is_system) byId.set(type.id, type);
  }
  return [...byId.values()];
});
const typeOptions = computed(() => [...customTypes.value, { id: NEW_TYPE, name: 'New type…' }]);
const creatingType = computed(() => form.range_type_id === NEW_TYPE);
const isValid = computed(
  () =>
    (Number.isInteger(form.range_type_id) || (creatingType.value && newType.value.name.trim())) &&
    form.start_ip.trim() &&
    form.end_ip.trim(),
);

function reset() {
  if (props.range && isProtectedRange(props.range)) {
    error.value = 'Functional ranges must be changed through their network or DHCP editor.';
    return;
  }
  error.value = '';
  overlap.value = null;
  confirmingDelete.value = false;
  createdTypes.value = [];
  // With no label yet the dialog opens ready to make one.
  form.range_type_id = props.range?.range_type_id ?? customTypes.value[0]?.id ?? NEW_TYPE;
  newType.value = { name: '', color: '#14b8a6', description: '' };
  form.start_ip = props.range?.start_ip ?? '';
  form.end_ip = props.range?.end_ip ?? '';
  form.description = props.range?.description ?? '';
  baseline = JSON.stringify(form);
  resetGuard();
}

const {
  confirmingDiscard,
  requestClose,
  keepEditing,
  discard,
  reset: resetGuard,
} = useDiscardGuard({
  busy,
  isDirty: () => JSON.stringify(form) !== baseline || Boolean(newType.value.name.trim()),
  close,
});

// Only opening the dialog, or pointing it at another range, resets the form.
// It used to reset on rangeTypes too, which meant the parent adding the type
// this dialog had just created wiped the half-filled range out from under
// the save. The parent loads the types before it opens the dialog.
watch(() => [props.visible, props.range], reset, { immediate: true, deep: true });

function close() {
  overlap.value = null;
  confirmingDelete.value = false;
  emit('update:visible', false);
}

async function remove() {
  if (!props.range || isProtectedRange(props.range)) return;
  error.value = '';
  try {
    await deleteRange(props.subnetId, props.range);
    confirmingDelete.value = false;
    emit('deleted', props.range);
    emit('update:visible', false);
  } catch (err) {
    error.value = apiError(err);
  }
}

function cancelOverlap() {
  overlap.value = null;
}

// The type is created first and the form switches to its id, so a retry
// after an overlap prompt saves the range under the type already made.
async function ensureType() {
  if (!creatingType.value) return;
  const created = await createRangeType({
    name: newType.value.name.trim(),
    color: newType.value.color,
    description: newType.value.description.trim(),
  });
  createdTypes.value = [...createdTypes.value, created];
  form.range_type_id = created.id;
  newType.value = { name: '', color: '#14b8a6', description: '' };
}

async function save(force) {
  if (!isValid.value || (props.range && isProtectedRange(props.range))) return;
  error.value = '';
  try {
    await ensureType();
  } catch (err) {
    error.value = apiError(err);
    return;
  }
  const payload = {
    range_type_id: form.range_type_id,
    start_ip: form.start_ip.trim(),
    end_ip: form.end_ip.trim(),
    description: form.description.trim(),
    ...(force ? { force: true } : {}),
  };
  try {
    const saved = props.range
      ? await updateRange(props.subnetId, props.range.id, payload)
      : await createRange(props.subnetId, payload);
    overlap.value = null;
    // Only what this open created. The list is cleared on every open, so a
    // later save under an existing type announces nothing.
    if (createdTypes.value.length) emit('type-created', createdTypes.value);
    emit('saved', saved);
    emit('update:visible', false);
  } catch (err) {
    if (!force && err.response?.status === 409 && err.response?.data?.can_force) {
      overlap.value = err.response.data;
      return;
    }
    error.value = apiError(err);
  }
}
</script>
