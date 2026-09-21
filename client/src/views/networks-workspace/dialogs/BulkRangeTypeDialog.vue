<template>
  <Dialog
    :visible="visible"
    header="Set Network Range Type"
    modal
    :style="{ width: '32rem' }"
    data-track="workspace-bulk-range-type"
    :close-on-escape="!overlap"
    @update:visible="emit('update:visible', $event)"
  >
    <p>{{ selectedRuns.length }} exact selected run{{ selectedRuns.length === 1 ? '' : 's' }}</p>
    <ul class="workspace-selected-runs">
      <li v-for="(run, index) in selectedRuns" :key="`${run.start_ip}-${run.end_ip}-${index}`">
        {{ run.start_ip }} to {{ run.end_ip }}
      </li>
    </ul>
    <label class="workspace-range-type-field">
      Network Range Type
      <Select
        v-model="rangeTypeId"
        :options="customTypes"
        optionLabel="name"
        optionValue="id"
        placeholder="Choose a type"
        class="w-full"
      />
    </label>
    <p class="workspace-range-help">
      This adds an organizational tag only. Address allocation and liveness are unchanged.
    </p>
    <p v-if="error" role="alert" class="workspace-range-error">{{ error }}</p>
    <template #footer>
      <Button label="Cancel" severity="secondary" @click="close" />
      <Button
        label="Review and apply"
        :loading="busy"
        :disabled="!rangeTypeId || selectedRuns.length === 0"
        data-track="workspace-bulk-range-type-save"
        @click="apply(false)"
      />
    </template>
  </Dialog>

  <ConfirmDialog
    :visible="Boolean(overlap)"
    header="Review replaced range labels"
    width="32rem"
    severity="warn"
    confirm-label="Accept replacement"
    cancel-label="Keep existing labels"
    :loading="busy"
    data-track="workspace-bulk-range-overlap"
    confirm-track="workspace-bulk-range-overlap-accept"
    @cancel="decline"
    @confirm="apply(true)"
  >
    <p>Only the exact selected runs will change. These existing labels overlap them:</p>
    <ul>
      <li v-for="item in overlap?.overlaps || []" :key="item.id">
        {{ item.type }}: {{ item.start_ip }} to {{ item.end_ip }}
      </li>
    </ul>
    <p>Unselected portions of those labels will be preserved.</p>
  </ConfirmDialog>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import Button from '../../../ui/Button.js';
import Dialog from '../../../ui/Dialog.js';
import ConfirmDialog from '../../../components/ConfirmDialog.vue';
import Select from '../../../ui/Select.js';
import { apiError } from '../../../utils/format.js';
import { useRangeActions } from '../composables/useRangeActions.js';
import './range-dialogs.css';

const props = defineProps({
  visible: { type: Boolean, default: false },
  subnetId: { type: [Number, String], required: true },
  selectedRuns: { type: Array, default: () => [] },
  rangeTypes: { type: Array, default: () => [] },
});
const emit = defineEmits(['update:visible', 'saved']);
const customTypes = computed(() => props.rangeTypes.filter((type) => !type.is_system));
const rangeTypeId = ref(null);
const overlap = ref(null);
const error = ref('');
const { busy, setRangeType } = useRangeActions();

watch(
  () => props.visible,
  (visible) => {
    if (!visible) return;
    rangeTypeId.value = customTypes.value[0]?.id ?? null;
    overlap.value = null;
    error.value = '';
  },
  { immediate: true },
);

function close() {
  overlap.value = null;
  emit('update:visible', false);
}

function decline() {
  overlap.value = null;
}

async function apply(acceptOverlaps) {
  error.value = '';
  try {
    const result = await setRangeType(
      props.subnetId,
      rangeTypeId.value,
      props.selectedRuns,
      acceptOverlaps,
    );
    overlap.value = null;
    emit('saved', result);
    emit('update:visible', false);
  } catch (err) {
    if (!acceptOverlaps && err.response?.status === 409 && err.response?.data?.can_accept) {
      overlap.value = err.response.data;
      return;
    }
    error.value = apiError(err);
  }
}
</script>

<style scoped>
.workspace-selected-runs {
  max-height: 10rem;
  overflow: auto;
}
.workspace-range-type-field {
  display: grid;
  gap: 0.35rem;
  font-weight: 600;
}
</style>
