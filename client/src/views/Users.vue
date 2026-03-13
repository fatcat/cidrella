<template>
  <div class="users-page" style="display: flex; flex-direction: column; height: 100%;">
    <div class="card-header">
      <h3>Users</h3>
      <Button label="Add User" icon="pi pi-plus" size="small" data-track="sys-add-user" @click="openCreateDialog()" />
    </div>
    <DataTable :value="users" :loading="loading" stripedRows size="small" emptyMessage="No users found."
               :paginator="users.length > 256" :rows="256"
               :rowsPerPageOptions="[64, 128, 256, 512]"
               @row-contextmenu="onUserRightClick" contextMenu
               scrollable scrollHeight="flex">
      <Column field="username" header="Username" sortable style="min-width: 10rem" />
      <Column header="Role" sortable sortField="role" style="min-width: 10rem">
        <template #body="{ data }">{{ roleLabel(data.role) }}</template>
      </Column>
      <Column header="Must Change Password" style="width: 10rem">
        <template #body="{ data }">
          <span :class="data.must_change_password ? 'badge-warn' : 'badge-ok'">
            {{ data.must_change_password ? 'Yes' : 'No' }}
          </span>
        </template>
      </Column>
      <Column header="Created" field="created_at" sortable style="width: 10rem">
        <template #body="{ data }">{{ formatDate(data.created_at) }}</template>
      </Column>
    </DataTable>

    <!-- User Context Menu -->
    <ContextMenu ref="userContextMenuRef" :model="userContextMenuItems" />

    <!-- Create User Dialog -->
    <Dialog v-model:visible="showCreateDialog" header="Create User" modal :style="{ width: '24rem' }">
      <div class="form-grid">
        <div class="field">
          <label>Username *</label>
          <InputText v-model="createForm.username" class="w-full" placeholder="Enter username" />
        </div>
        <div class="field">
          <label>Role *</label>
          <Select v-model="createForm.role" :options="ROLES" optionLabel="label" optionValue="value"
                  class="w-full" placeholder="Select role" />
        </div>
      </div>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showCreateDialog = false" />
        <Button label="Create" @click="createUser" :loading="saving" />
      </template>
    </Dialog>

    <!-- Edit User Dialog -->
    <Dialog v-model:visible="showEditDialog" header="Edit User" modal :style="{ width: '24rem' }">
      <div class="form-grid">
        <div class="field">
          <label>Username</label>
          <InputText :modelValue="editingUser?.username" class="w-full" disabled />
        </div>
        <div class="field">
          <label>Role *</label>
          <Select v-model="editForm.role" :options="ROLES" optionLabel="label" optionValue="value"
                  class="w-full" />
        </div>
      </div>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showEditDialog = false" />
        <Button label="Save" @click="updateUser" :loading="saving" />
      </template>
    </Dialog>

    <!-- Password Reveal Dialog -->
    <Dialog v-model:visible="showPasswordDialog" header="User Password" modal :style="{ width: '28rem' }" :closable="false">
      <div class="password-reveal">
        <p class="password-warning">
          <i class="pi pi-exclamation-triangle" style="color: var(--p-orange-500)"></i>
          This password will not be shown again. Copy it now and provide it to the user.
        </p>
        <div class="password-field">
          <InputText :modelValue="revealedPassword" class="w-full" readonly ref="passwordInput" />
          <Button icon="pi pi-copy" severity="secondary" size="small" title="Copy" @click="copyPassword" />
        </div>
        <p class="password-note">The user will be required to change this password on first login.</p>
      </div>
      <template #footer>
        <Button label="Done" @click="showPasswordDialog = false" />
      </template>
    </Dialog>

    <!-- Reset Password Confirmation -->
    <Dialog v-model:visible="showResetDialog" header="Reset Password" modal :style="{ width: '24rem' }">
      <p>Reset password for <strong>{{ resettingUser?.username }}</strong>?</p>
      <p class="text-sm muted">A new random password will be generated. The user will be required to change it on next login.</p>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showResetDialog = false" />
        <Button label="Reset Password" severity="warning" @click="resetPassword" :loading="saving" />
      </template>
    </Dialog>

    <!-- Delete User Confirmation -->
    <Dialog v-model:visible="showDeleteDialog" header="Delete User" modal :style="{ width: '24rem' }">
      <p>Delete user <strong>{{ deletingUser?.username }}</strong>?</p>
      <p class="text-sm muted">This action cannot be undone.</p>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showDeleteDialog = false" />
        <Button label="Delete" severity="danger" @click="deleteUser" :loading="saving" />
      </template>
    </Dialog>

    <Toast />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { formatDateOnly } from '../utils/dateFormat.js';
import { useToast } from 'primevue/usetoast';
import Button from 'primevue/button';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import ContextMenu from 'primevue/contextmenu';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import Toast from 'primevue/toast';
import { useAuthStore } from '../stores/auth.js';
import api from '../api/client.js';

const toast = useToast();
const auth = useAuthStore();
const currentUserId = auth.user?.id;

const ROLES = [
  { value: 'admin', label: 'Administrator' },
  { value: 'dns_admin', label: 'DNS Administrator' },
  { value: 'dhcp_admin', label: 'DHCP Administrator' },
  { value: 'readonly_dns', label: 'DNS Read-Only' },
  { value: 'readonly_dhcp', label: 'DHCP Read-Only' },
  { value: 'readonly', label: 'Read-Only' }
];

const ROLE_LABELS = Object.fromEntries(ROLES.map(r => [r.value, r.label]));

function roleLabel(role) {
  return ROLE_LABELS[role] || role;
}

const formatDate = formatDateOnly;

const users = ref([]);
const loading = ref(false);
const saving = ref(false);

const showCreateDialog = ref(false);
const createForm = ref({ username: '', role: 'readonly' });

const showEditDialog = ref(false);
const editingUser = ref(null);
const editForm = ref({ role: '' });

const showPasswordDialog = ref(false);
const revealedPassword = ref('');

const showResetDialog = ref(false);
const resettingUser = ref(null);

const showDeleteDialog = ref(false);
const deletingUser = ref(null);

// User context menu
const userContextMenuRef = ref();
const selectedUser = ref(null);
const userContextMenuItems = computed(() => {
  const u = selectedUser.value;
  if (!u) return [];
  const items = [
    { label: 'Edit Role', icon: 'pi pi-pencil', command: () => openEditDialog(u) },
    { label: 'Reset Password', icon: 'pi pi-key', command: () => confirmResetPassword(u) }
  ];
  if (u.id !== currentUserId) {
    items.push({ label: 'Delete User', icon: 'pi pi-trash', command: () => confirmDelete(u) });
  }
  return items;
});
function onUserRightClick(event) {
  selectedUser.value = event.data;
  userContextMenuRef.value.show(event.originalEvent);
}

async function loadUsers() {
  loading.value = true;
  try {
    const res = await api.get('/users');
    users.value = res.data;
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    loading.value = false;
  }
}

function openCreateDialog() {
  createForm.value = { username: '', role: 'readonly' };
  showCreateDialog.value = true;
}

async function createUser() {
  saving.value = true;
  try {
    const res = await api.post('/users', createForm.value);
    showCreateDialog.value = false;
    revealedPassword.value = res.data.password;
    showPasswordDialog.value = true;
    toast.add({ severity: 'success', summary: 'User created', life: 3000 });
    await loadUsers();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    saving.value = false;
  }
}

function openEditDialog(user) {
  editingUser.value = user;
  editForm.value = { role: user.role };
  showEditDialog.value = true;
}

async function updateUser() {
  saving.value = true;
  try {
    await api.put(`/users/${editingUser.value.id}`, editForm.value);
    showEditDialog.value = false;
    toast.add({ severity: 'success', summary: 'User updated', life: 3000 });
    await loadUsers();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    saving.value = false;
  }
}

function confirmResetPassword(user) {
  resettingUser.value = user;
  showResetDialog.value = true;
}

async function resetPassword() {
  saving.value = true;
  try {
    const res = await api.post(`/users/${resettingUser.value.id}/reset-password`);
    showResetDialog.value = false;
    revealedPassword.value = res.data.password;
    showPasswordDialog.value = true;
    toast.add({ severity: 'success', summary: 'Password reset', life: 3000 });
    await loadUsers();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    saving.value = false;
  }
}

function confirmDelete(user) {
  deletingUser.value = user;
  showDeleteDialog.value = true;
}

async function deleteUser() {
  saving.value = true;
  try {
    await api.delete(`/users/${deletingUser.value.id}`);
    showDeleteDialog.value = false;
    toast.add({ severity: 'success', summary: 'User deleted', life: 3000 });
    await loadUsers();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    saving.value = false;
  }
}

function copyPassword() {
  navigator.clipboard.writeText(revealedPassword.value);
  toast.add({ severity: 'info', summary: 'Copied to clipboard', life: 2000 });
}

onMounted(loadUsers);


</script>

<style scoped>
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.75rem;
}
.card-header h3 {
  margin: 0;
}
.section-header {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 0.75rem;
}

.form-grid {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.field label {
  display: block;
  font-size: 0.85rem;
  font-weight: 500;
  margin-bottom: 0.25rem;
}

.badge-warn {
  color: var(--p-orange-500);
  font-weight: 500;
}

.badge-ok {
  color: var(--p-green-500);
}

.password-reveal {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.password-warning {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0;
  font-weight: 500;
}

.password-field {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.password-field :deep(input) {
  font-family: monospace;
  font-size: 1rem;
}

.password-note {
  margin: 0;
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}

.text-sm {
  font-size: 0.85rem;
}

.muted {
  color: var(--p-text-muted-color);
}
</style>
