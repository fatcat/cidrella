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
          :options="customTypes"
          optionLabel="name"
          optionValue="id"
          placeholder="Choose a type"
          class="w-full"
        />
      </label>
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

  <Dialog
    :visible="confirmingDelete"
    header="Delete Network Range"
    modal
    :style="{ width: '28rem' }"
    data-track="workspace-range-delete-confirm"
    @update:visible="confirmingDelete = $event"
  >
    <p>
      Delete {{ range?.start_ip }} to {{ range?.end_ip }}? This removes only the organizational
      label. It does not release or otherwise change the addresses.
    </p>
    <p v-if="error" class="workspace-range-error" role="alert">{{ error }}</p>
    <template #footer>
      <Button label="Cancel" severity="secondary" @click="confirmingDelete = false" />
      <Button
        label="Delete label"
        severity="danger"
        :loading="busy"
        data-track="workspace-range-delete-confirm-action"
        @click="remove"
      />
    </template>
  </Dialog>

  <Dialog
    :visible="Boolean(overlap)"
    header="Review overlapping range labels"
    modal
    :style="{ width: '32rem' }"
    data-track="workspace-range-overlap"
    @update:visible="cancelOverlap"
  >
    <p>The requested range overlaps these organizational labels:</p>
    <ul>
      <li v-for="item in overlap?.overlaps || []" :key="item.id">
        {{ item.type }}: {{ item.start_ip }} to {{ item.end_ip }}
      </li>
    </ul>
    <p>Accepting replaces only the requested addresses and preserves unaffected fragments.</p>
    <template #footer>
      <Button label="Keep existing labels" severity="secondary" @click="cancelOverlap" />
      <Button
        label="Accept replacement"
        severity="warn"
        :loading="busy"
        data-track="workspace-range-overlap-accept"
        @click="save(true)"
      />
    </template>
  </Dialog>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue';
import Button from '../../../ui/Button.js';
import Dialog from '../../../ui/Dialog.js';
import InputText from '../../../ui/InputText.js';
import Select from '../../../ui/Select.js';
import { apiError } from '../../../utils/format.js';
import { isProtectedRange, useRangeActions } from '../composables/useRangeActions.js';
import { useDiscardGuard } from '../composables/useDiscardGuard.js';
import DiscardPrompt from './DiscardPrompt.vue';

const props = defineProps({
  visible: { type: Boolean, default: false },
  subnetId: { type: [Number, String], required: true },
  range: { type: Object, default: null },
  rangeTypes: { type: Array, default: () => [] },
});
const emit = defineEmits(['update:visible', 'saved', 'deleted']);
const { busy, createRange, updateRange, deleteRange } = useRangeActions();
const overlap = ref(null);
const confirmingDelete = ref(false);
const error = ref('');
const form = reactive({ range_type_id: null, start_ip: '', end_ip: '', description: '' });
let baseline = JSON.stringify(form);
const customTypes = computed(() => props.rangeTypes.filter((type) => !type.is_system));
const isValid = computed(
  () => Number.isInteger(form.range_type_id) && form.start_ip.trim() && form.end_ip.trim(),
);

function reset() {
  if (props.range && isProtectedRange(props.range)) {
    error.value = 'Functional ranges must be changed through their network or DHCP editor.';
    return;
  }
  error.value = '';
  overlap.value = null;
  confirmingDelete.value = false;
  form.range_type_id = props.range?.range_type_id ?? customTypes.value[0]?.id ?? null;
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
} = useDiscardGuard({ busy, isDirty: () => JSON.stringify(form) !== baseline, close });

watch(() => [props.visible, props.range, props.rangeTypes], reset, { immediate: true, deep: true });

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

async function save(force) {
  if (!isValid.value || (props.range && isProtectedRange(props.range))) return;
  error.value = '';
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

<style scoped>
.workspace-range-form {
  display: grid;
  gap: 0.9rem;
}
.workspace-range-form label {
  display: grid;
  gap: 0.35rem;
  font-weight: 600;
}
.workspace-range-help,
.workspace-range-error {
  margin: 0;
  font-size: var(--cid-font-small, 0.8rem);
}
.workspace-range-help {
  color: var(--cid-text-muted);
}
.workspace-range-error {
  color: var(--cid-danger, #b42318);
}
</style>
