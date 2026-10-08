<template>
  <Dialog
    :visible="visible"
    :header="header"
    modal
    :style="{ width }"
    :close-on-escape="!loading"
    @update:visible="setVisible"
    @hide="typed = ''"
  >
    <slot />
    <template v-if="typeToConfirm">
      <p class="confirm-type">
        Type <strong>{{ typeToConfirm }}</strong> to confirm:
      </p>
      <InputText
        v-model="typed"
        class="confirm-type-input"
        :placeholder="typeToConfirm"
        autocomplete="off"
        data-track="confirm-dialog-typed"
      />
    </template>
    <template #footer>
      <Button
        :label="cancelLabel"
        severity="secondary"
        :disabled="loading"
        :data-track="cancelTrack"
        @click="cancel"
      />
      <Button
        :label="confirmLabel"
        :icon="confirmIcon"
        :severity="severity"
        :loading="loading"
        :disabled="confirmDisabled"
        :data-track="confirmTrack"
        @click="emit('confirm')"
      />
    </template>
  </Dialog>
</template>

<script setup>
import { computed, ref } from 'vue';
import Dialog from '../ui/Dialog.js';
import Button from '../ui/Button.js';
import InputText from '../ui/InputText.js';

// The one confirmation dialog. A destructive or risky action asks here,
// with the body as the slot, and nowhere else: scripts/check-confirm-dialogs.js
// refuses a Dialog that grows its own danger or warn button. Attributes such
// as data-track fall through to the Dialog root, so tests and the tracker
// find the dialog by the same id they always did.
const props = defineProps({
  visible: { type: Boolean, default: false },
  header: { type: String, required: true },
  confirmLabel: { type: String, default: 'Delete' },
  confirmIcon: { type: String, default: undefined },
  // danger for something that removes data, warn for something that changes
  // it in a way the user should look at twice (overlaps, merges, resets).
  severity: { type: String, default: 'danger', validator: (v) => ['danger', 'warn'].includes(v) },
  cancelLabel: { type: String, default: 'Cancel' },
  loading: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  width: { type: String, default: '24rem' },
  // When set, the confirm button stays disabled until the user types this
  // word. Used where a mistake is not undoable (a zone with records, the
  // database reset).
  typeToConfirm: { type: String, default: '' },
  confirmTrack: { type: String, default: undefined },
  cancelTrack: { type: String, default: undefined },
});
const emit = defineEmits(['update:visible', 'confirm', 'cancel']);

const typed = ref('');
const confirmDisabled = computed(
  () => props.disabled || (props.typeToConfirm !== '' && typed.value !== props.typeToConfirm),
);

function setVisible(value) {
  emit('update:visible', value);
  if (!value) emit('cancel');
}

function cancel() {
  setVisible(false);
}
</script>

<style scoped>
.confirm-type {
  margin: 0.75rem 0 0.35rem;
}
.confirm-type-input {
  width: 100%;
}
</style>
