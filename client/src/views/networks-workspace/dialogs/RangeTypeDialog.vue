<template>
  <Dialog
    :visible="visible"
    :header="rangeType ? 'Edit Network Range Type' : 'Add Network Range Type'"
    modal
    :style="{ width: '26rem' }"
    data-track="workspace-range-type-editor"
    :close-on-escape="!confirmingDelete"
    @update:visible="requestClose"
  >
    <form class="workspace-range-form" @submit.prevent="save">
      <label>Name <InputText v-model="form.name" class="w-full" maxlength="64" required /></label>
      <label class="workspace-color-field">
        Color
        <input v-model="form.color" type="color" />
        <InputText v-model="form.color" maxlength="7" />
      </label>
      <label>
        Description
        <InputText v-model="form.description" class="w-full" maxlength="1024" />
      </label>
      <p class="workspace-range-help">
        Network Range Types are visual organizational labels. They never allocate an address or
        change DHCP, DNS, scanning, or liveness.
      </p>
      <p v-if="error" class="workspace-range-error" role="alert">{{ error }}</p>
      <DiscardPrompt v-if="confirmingDiscard" @keep="keepEditing" @discard="discard" />
      <button type="submit" hidden>Save</button>
    </form>
    <template #footer>
      <Button
        v-if="rangeType && !rangeType.is_system"
        label="Delete"
        severity="danger"
        text
        data-track="workspace-range-type-delete"
        @click="confirmingDelete = true"
      />
      <Button label="Cancel" severity="secondary" @click="requestClose()" />
      <Button
        :label="rangeType ? 'Save' : 'Create'"
        :loading="busy"
        :disabled="!form.name.trim() || Boolean(rangeType?.is_system)"
        data-track="workspace-range-type-save"
        @click="save"
      />
    </template>
  </Dialog>

  <Dialog
    :visible="confirmingDelete"
    header="Delete Network Range Type"
    modal
    :style="{ width: '26rem' }"
    data-track="workspace-range-type-delete-confirm"
    @update:visible="confirmingDelete = $event"
  >
    <p>
      Delete <strong>{{ rangeType?.name }}</strong
      >? A type that is still assigned to ranges cannot be deleted.
    </p>
    <p v-if="error" class="workspace-range-error" role="alert">{{ error }}</p>
    <template #footer>
      <Button label="Cancel" severity="secondary" @click="confirmingDelete = false" />
      <Button
        label="Delete type"
        severity="danger"
        :loading="busy"
        data-track="workspace-range-type-delete-confirm-action"
        @click="remove"
      />
    </template>
  </Dialog>
</template>

<script setup>
import { reactive, ref, watch } from 'vue';
import Button from '../../../ui/Button.js';
import Dialog from '../../../ui/Dialog.js';
import InputText from '../../../ui/InputText.js';
import { apiError } from '../../../utils/format.js';
import { useRangeActions } from '../composables/useRangeActions.js';
import { useDiscardGuard } from '../composables/useDiscardGuard.js';
import DiscardPrompt from './DiscardPrompt.vue';

const props = defineProps({
  visible: { type: Boolean, default: false },
  rangeType: { type: Object, default: null },
});
const emit = defineEmits(['update:visible', 'saved', 'deleted']);
const { busy, createRangeType, updateRangeType, deleteRangeType } = useRangeActions();
const form = reactive({ name: '', color: '#14b8a6', description: '' });
let baseline = JSON.stringify(form);
const error = ref('');
const confirmingDelete = ref(false);

const {
  confirmingDiscard,
  requestClose,
  keepEditing,
  discard,
  reset: resetGuard,
} = useDiscardGuard({ busy, isDirty: () => JSON.stringify(form) !== baseline, close });

watch(
  () => [props.visible, props.rangeType],
  () => {
    form.name = props.rangeType?.name ?? '';
    form.color = props.rangeType?.color ?? '#14b8a6';
    form.description = props.rangeType?.description ?? '';
    error.value = props.rangeType?.is_system
      ? 'Functional system range types cannot be modified.'
      : '';
    confirmingDelete.value = false;
    baseline = JSON.stringify(form);
    resetGuard();
  },
  { immediate: true, deep: true },
);

function close() {
  confirmingDelete.value = false;
  emit('update:visible', false);
}

async function remove() {
  if (!props.rangeType || props.rangeType.is_system) return;
  error.value = '';
  try {
    await deleteRangeType(props.rangeType);
    confirmingDelete.value = false;
    emit('deleted', props.rangeType);
    emit('update:visible', false);
  } catch (err) {
    error.value = apiError(err);
  }
}

async function save() {
  if (!form.name.trim() || props.rangeType?.is_system) return;
  const payload = {
    name: form.name.trim(),
    color: form.color,
    description: form.description.trim(),
  };
  try {
    const saved = props.rangeType
      ? await updateRangeType(props.rangeType.id, payload)
      : await createRangeType(payload);
    emit('saved', saved);
    emit('update:visible', false);
  } catch (err) {
    error.value = apiError(err);
  }
}
</script>

<style scoped>
.workspace-range-form,
.workspace-range-form label {
  display: grid;
  gap: 0.5rem;
}
.workspace-range-form {
  gap: 0.9rem;
}
.workspace-color-field {
  grid-template-columns: auto 3rem 1fr;
  align-items: center;
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
