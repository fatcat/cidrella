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
      <RangeTypeFields v-model="form" />
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

  <ConfirmDialog
    v-model:visible="confirmingDelete"
    header="Delete Network Range Type"
    width="26rem"
    confirm-label="Delete type"
    :loading="busy"
    data-track="workspace-range-type-delete-confirm"
    confirm-track="workspace-range-type-delete-confirm-action"
    @confirm="remove"
  >
    <p>
      Delete <strong>{{ rangeType?.name }}</strong
      >? A type that is still assigned to ranges cannot be deleted.
    </p>
    <p v-if="error" class="workspace-range-error" role="alert">{{ error }}</p>
  </ConfirmDialog>
</template>

<script setup>
import { ref, watch } from 'vue';
import Button from '../../../ui/Button.js';
import Dialog from '../../../ui/Dialog.js';
import RangeTypeFields from './RangeTypeFields.vue';
import { apiError } from '../../../utils/format.js';
import { useRangeActions } from '../composables/useRangeActions.js';
import { useDiscardGuard } from '../composables/useDiscardGuard.js';
import './range-dialogs.css';
import DiscardPrompt from './DiscardPrompt.vue';
import ConfirmDialog from '../../../components/ConfirmDialog.vue';

const props = defineProps({
  visible: { type: Boolean, default: false },
  rangeType: { type: Object, default: null },
});
const emit = defineEmits(['update:visible', 'saved', 'deleted']);
const { busy, createRangeType, updateRangeType, deleteRangeType } = useRangeActions();
const form = ref({ name: '', color: '#14b8a6', description: '' });
let baseline = JSON.stringify(form.value);
const error = ref('');
const confirmingDelete = ref(false);

const {
  confirmingDiscard,
  requestClose,
  keepEditing,
  discard,
  reset: resetGuard,
} = useDiscardGuard({ busy, isDirty: () => JSON.stringify(form.value) !== baseline, close });

watch(
  () => [props.visible, props.rangeType],
  () => {
    form.value = {
      name: props.rangeType?.name ?? '',
      color: props.rangeType?.color ?? '#14b8a6',
      description: props.rangeType?.description ?? '',
    };
    error.value = props.rangeType?.is_system
      ? 'Functional system range types cannot be modified.'
      : '';
    confirmingDelete.value = false;
    baseline = JSON.stringify(form.value);
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
  if (!form.value.name.trim() || props.rangeType?.is_system) return;
  const payload = {
    name: form.value.name.trim(),
    color: form.value.color,
    description: form.value.description.trim(),
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
