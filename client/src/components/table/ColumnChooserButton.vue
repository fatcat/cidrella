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
      v-model="draft"
      dataKey="key"
      striped
      scrollHeight="18rem"
      :showSourceControls="false"
      :showTargetControls="true"
      :buttonProps="{ severity: 'secondary', text: true }"
    >
      <template #sourceheader>Available</template>
      <template #targetheader>Visible</template>
      <template #option="{ option }">
        <span class="column-option">{{ option.header }}</span>
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
import { ref } from 'vue';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import PickList from 'primevue/picklist';

const props = defineProps({
  tableName: { type: String, required: true },
  allColumns: { type: Array, required: true },
  visibleColumns: { type: Array, required: true }
});

const emit = defineEmits(['update:visibleColumns', 'reset']);

const visible = ref(false);
const draft = ref([[], []]);

function open() {
  const visibleKeys = new Set(props.visibleColumns.map(c => c.key));
  draft.value = [
    props.allColumns.filter(c => !visibleKeys.has(c.key)),
    [...props.visibleColumns]
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
</style>
