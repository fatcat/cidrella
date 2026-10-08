<template>
  <Button
    icon="pi pi-table"
    label="Columns"
    size="small"
    text
    class="column-chooser-trigger"
    @click="open"
  />

  <Dialog
    v-model:visible="visible"
    :header="`${tableName} Columns`"
    modal
    :style="{ width: '46rem' }"
  >
    <PickList
      v-model="filteredDraft"
      dataKey="key"
      striped
      scrollHeight="18rem"
      :showSourceControls="false"
      :showTargetControls="true"
      :buttonProps="{ severity: 'secondary', text: true }"
    >
      <template #sourceheader>
        <div class="available-header">
          <span>Available</span>
          <InputText
            v-model="availableFilter"
            aria-label="Filter available columns"
            placeholder="Filter columns"
            size="small"
            class="available-filter"
          />
        </div>
      </template>
      <template #targetheader>Visible</template>
      <template #option="{ option }">
        <span
          class="column-option"
          :title="
            locked.has(option.key)
              ? 'Always shown in this table. It can be moved, not hidden.'
              : undefined
          "
          ><i v-if="locked.has(option.key)" class="pi pi-lock column-lock" aria-hidden="true" />{{
            option.header
          }}<span v-if="locked.has(option.key)" class="sr-only"> (always shown)</span></span
        >
      </template>
    </PickList>

    <template #footer>
      <Button label="Reset" severity="secondary" text @click="reset" />
      <Button label="Cancel" severity="secondary" @click="visible = false" />
      <Button label="Apply" @click="apply" />
    </template>
  </Dialog>
</template>

<script setup>
import { computed, ref } from 'vue';
import Button from '../../ui/Button.js';
import Dialog from '../../ui/Dialog.js';
import InputText from '../../ui/InputText.js';
import PickList from '../../ui/PickList.js';

const props = defineProps({
  tableName: { type: String, required: true },
  allColumns: { type: Array, required: true },
  visibleColumns: { type: Array, required: true },
  // Columns that identify the table and cannot be hidden. They can still be
  // reordered; moving one out of Visible puts it straight back where it was.
  lockedKeys: { type: Array, default: () => [] },
});

const emit = defineEmits(['update:visibleColumns', 'reset']);

const visible = ref(false);
const draft = ref([[], []]);
const availableFilter = ref('');

function sortedAvailable(columns) {
  return [...columns].sort((a, b) =>
    a.header.localeCompare(b.header, undefined, { sensitivity: 'base' }),
  );
}

const locked = computed(() => new Set(props.lockedKeys));

// Put back any locked column the move took out, at the index it had.
function keepLocked(previous, requested) {
  const next = [...requested];
  const present = new Set(next.map((column) => column.key));
  previous.forEach((column, index) => {
    if (locked.value.has(column.key) && !present.has(column.key)) {
      next.splice(Math.min(index, next.length), 0, column);
    }
  });
  return next;
}

const filteredDraft = computed({
  get() {
    const query = availableFilter.value.trim().toLocaleLowerCase();
    const available = query
      ? draft.value[0].filter((column) => column.header.toLocaleLowerCase().includes(query))
      : draft.value[0];
    return [available, draft.value[1]];
  },
  set([, requested]) {
    const nextVisible = keepLocked(draft.value[1], requested);
    const visibleKeys = new Set(nextVisible.map((column) => column.key));
    draft.value = [
      sortedAvailable(props.allColumns.filter((column) => !visibleKeys.has(column.key))),
      nextVisible,
    ];
  },
});

function open() {
  availableFilter.value = '';
  const visibleKeys = new Set(props.visibleColumns.map((c) => c.key));
  draft.value = [
    sortedAvailable(props.allColumns.filter((c) => !visibleKeys.has(c.key))),
    [...props.visibleColumns],
  ];
  visible.value = true;
}

function apply() {
  emit('update:visibleColumns', draft.value[1]);
  visible.value = false;
}

function reset() {
  emit('reset');
  visible.value = false;
}
</script>

<style scoped>
.column-chooser-trigger {
  margin-left: auto;
}

.column-option {
  font-size: var(--app-fs-sm);
}

.column-lock {
  margin-right: 0.35rem;
  font-size: 0.7em;
  opacity: 0.7;
}

.available-header {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.available-filter {
  width: 100%;
}
</style>
