<template>
  <div class="range-types-page" style="display: flex; flex-direction: column; height: 100%;">
    <div class="page-header">
      <h2>Address Types</h2>
      <Button label="Add Type" icon="pi pi-plus" @click="showDialog = true" />
    </div>

    <DataTable :value="types" :loading="loading" stripedRows emptyMessage="No address types found."
               :paginator="types.length > 256" :rows="256"
               :rowsPerPageOptions="[64, 128, 256, 512]"
               scrollable scrollHeight="flex">
      <Column header="Color" style="width: 4rem">
        <template #body="{ data }">
          <span class="color-swatch" :style="{ background: data.color }"></span>
        </template>
      </Column>
      <Column field="name" header="Name" sortable />
      <Column field="description" header="Description">
        <template #body="{ data }">{{ data.description ?? '—' }}</template>
      </Column>
      <Column header="Type" style="width: 7rem">
        <template #body="{ data }">
          <span :class="data.is_system ? 'badge-system' : 'badge-custom'">
            {{ data.is_system ? 'System' : 'Custom' }}
          </span>
        </template>
      </Column>
      <Column header="" style="width: 5rem">
        <template #body="{ data }">
          <div class="action-buttons" v-if="!data.is_system">
            <Button icon="pi pi-pencil" severity="secondary" text rounded size="small"
                    @click="edit(data)" />
            <Button icon="pi pi-trash" severity="danger" text rounded size="small"
                    @click="confirmDelete(data)" />
          </div>
        </template>
      </Column>
    </DataTable>

    <Dialog v-model:visible="showDialog" :header="editing ? 'Edit Address Type' : 'Add Address Type'"
            modal :style="{ width: '24rem' }">
      <div class="form-grid">
        <div class="field">
          <label>Name *</label>
          <InputText v-model="form.name" class="w-full" />
        </div>
        <div class="field">
          <label>Color</label>
          <div class="color-picker-row">
            <input type="color" v-model="form.color" />
            <InputText v-model="form.color" style="width: 8rem; font-family: monospace;" />
          </div>
        </div>
        <div class="field">
          <label>Description</label>
          <InputText v-model="form.description" class="w-full" />
        </div>
      </div>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="closeDialog" />
        <Button :label="editing ? 'Save' : 'Create'" @click="save" :loading="saving" />
      </template>
    </Dialog>

    <Dialog v-model:visible="showDeleteDialog" header="Delete Address Type" modal :style="{ width: '24rem' }">
      <p>Delete address type <strong>{{ deleting?.name }}</strong>?</p>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showDeleteDialog = false" />
        <Button label="Delete" severity="danger" @click="doDelete" :loading="saving" />
      </template>
    </Dialog>

    <Toast />
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useToast } from 'primevue/usetoast';
import Button from 'primevue/button';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import Toast from 'primevue/toast';
import { useSubnetStore } from '../stores/subnets.js';

const store = useSubnetStore();
const toast = useToast();

const types = ref([]);
const loading = ref(false);
const saving = ref(false);
const showDialog = ref(false);
const showDeleteDialog = ref(false);
const editing = ref(null);
const deleting = ref(null);
const form = ref({ name: '', color: '#6b7280', description: '' });

async function loadTypes() {
  loading.value = true;
  try {
    types.value = await store.getRangeTypes();
  } finally {
    loading.value = false;
  }
}

function edit(type) {
  editing.value = type;
  form.value = { name: type.name, color: type.color, description: type.description || '' };
  showDialog.value = true;
}

function closeDialog() {
  showDialog.value = false;
  editing.value = null;
  form.value = { name: '', color: '#6b7280', description: '' };
}

async function save() {
  saving.value = true;
  try {
    if (editing.value) {
      await store.updateRangeType(editing.value.id, form.value);
      toast.add({ severity: 'success', summary: 'Address type updated', life: 3000 });
    } else {
      await store.createRangeType(form.value);
      toast.add({ severity: 'success', summary: 'Address type created', life: 3000 });
    }
    closeDialog();
    await loadTypes();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    saving.value = false;
  }
}

function confirmDelete(type) {
  deleting.value = type;
  showDeleteDialog.value = true;
}

async function doDelete() {
  saving.value = true;
  try {
    await store.deleteRangeType(deleting.value.id);
    showDeleteDialog.value = false;
    toast.add({ severity: 'success', summary: 'Range type deleted', life: 3000 });
    await loadTypes();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    saving.value = false;
  }
}

onMounted(loadTypes);
</script>

<style scoped>
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
}
.page-header h2 {
  margin: 0;
}
.color-swatch {
  display: inline-block;
  width: 24px;
  height: 24px;
  border-radius: 4px;
  border: 1px solid rgba(0,0,0,0.1);
}
.badge-system {
  font-size: 0.75rem;
  background: var(--p-surface-ground);
  color: var(--p-text-muted-color);
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
}
.badge-custom {
  font-size: 0.75rem;
  background: color-mix(in srgb, var(--p-primary-color) 20%, transparent);
  color: var(--p-primary-color);
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
}
.action-buttons {
  display: flex;
  gap: 0.25rem;
}
.form-grid {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.field label {
  display: block;
  margin-bottom: 0.35rem;
  font-size: 0.85rem;
  font-weight: 600;
}
.color-picker-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.color-picker-row input[type="color"] {
  width: 36px;
  height: 36px;
  border: none;
  padding: 0;
  cursor: pointer;
}
</style>
