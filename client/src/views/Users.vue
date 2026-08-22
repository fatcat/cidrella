<template>
  <div class="users-page" style="display: flex; flex-direction: column; height: 100%;">
    <div class="card-header">
      <h3>Users</h3>
      <Button label="Add User" icon="pi pi-plus" size="small" data-track="sys-add-user" @click="openCreateDialog()" />
    </div>
    <DataTable :value="users" :loading="loading" stripedRows size="small"
               :paginator="users.length > 256" :rows="256"
               :rowsPerPageOptions="[64, 128, 256, 512]"
               @row-contextmenu="onUserRightClick" contextMenu
               scrollable scrollHeight="flex">
      <template #empty>
        <EmptyState icon="pi-users" title="No users" description="Add operator accounts with scoped roles."
                        :actions="[{ label: 'Add User', icon: 'pi-plus', dataTrack: 'sys-add-user-empty', onClick: () => openCreateDialog() }]" />
      </template>
      <Column field="username" header="Username" sortable style="min-width: 10rem" />
      <Column header="Type" sortable sortField="kind" style="min-width: 9rem">
        <template #body="{ data }">
          <span v-if="data.kind === 'service'" class="kind-tag" data-track="sys-user-service">
            <i class="pi pi-cog"></i> service
            <span class="token-count">{{ data.active_tokens || 0 }} token{{ data.active_tokens === 1 ? '' : 's' }}</span>
          </span>
          <span v-else class="kind-plain">person</span>
        </template>
      </Column>
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
      <Column header="Actions" style="width: 120px">
        <template #body="{ data }">
          <div style="display: flex; gap: 0.25rem;">
            <Button icon="pi pi-pencil" severity="info" text rounded size="small"
              @click="openEditDialog(data)" v-tooltip.top="'Edit Role'"
              :disabled="data.id === currentUserId" />
            <Button icon="pi pi-key" severity="warning" text rounded size="small"
              @click="confirmResetPassword(data)" v-tooltip.top="'Reset Password'" />
            <Button icon="pi pi-trash" severity="danger" text rounded size="small"
              @click="confirmDelete(data)" v-tooltip.top="'Delete'"
              :disabled="data.id === currentUserId" />
          </div>
        </template>
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
                  class="w-full" placeholder="Select role" :loading="rolesLoading" />
        </div>
        <div class="field">
          <label>Account type</label>
          <Select v-model="createForm.kind" :options="ACCOUNT_KINDS" optionLabel="label" optionValue="value"
                  class="w-full" data-track="sys-user-kind" />
          <small class="field-hint">
            {{ createForm.kind === 'service'
              ? 'For a machine. No password, cannot sign in, authenticates with an API token you issue after creating it.'
              : 'For a person. Gets a one-time password and must change it at first sign-in.' }}
          </small>
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
                  class="w-full" :loading="rolesLoading" />
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

    <!-- API Tokens Dialog -->
    <Dialog v-model:visible="showTokensDialog" :header="`API Tokens: ${tokenUser?.username || ''}`"
            modal :style="{ width: '40rem' }">
      <div class="tokens-panel">
        <p class="password-note">
          A token carries this account's role ({{ roleLabel(tokenUser?.role) }}) and nothing more.
          It is shown once when created. Revoke it here if it leaks.
        </p>

        <DataTable :value="tokenList" :loading="tokensLoading" size="small">
          <template #empty>
            <span class="kind-plain">No tokens yet.</span>
          </template>
          <Column field="name" header="Name" style="min-width: 8rem" />
          <Column header="Token" style="min-width: 9rem">
            <template #body="{ data }"><code>{{ data.prefix }}…</code></template>
          </Column>
          <Column header="Expires" style="min-width: 8rem">
            <template #body="{ data }">{{ data.expires_at ? formatDate(data.expires_at) : 'never' }}</template>
          </Column>
          <Column header="Last used" style="min-width: 8rem">
            <template #body="{ data }">{{ data.last_used_at ? formatDate(data.last_used_at) : 'never' }}</template>
          </Column>
          <Column header="" style="width: 6rem">
            <template #body="{ data }">
              <span v-if="data.revoked_at" class="kind-plain">revoked</span>
              <Button v-else icon="pi pi-ban" severity="danger" text size="small" title="Revoke"
                      data-track="sys-token-revoke" @click="revokeToken(data)" />
            </template>
          </Column>
        </DataTable>

        <div class="token-new">
          <div class="field">
            <label>New token name</label>
            <InputText v-model="tokenForm.name" class="w-full" placeholder="switchmap"
                       data-track="sys-token-name" />
          </div>
          <div class="field">
            <label>Expires in (days)</label>
            <InputText v-model="tokenForm.expires_in_days" class="w-full" placeholder="0" />
            <small class="field-hint">0 means never. An unattended poller has nobody to renew it.</small>
          </div>
          <Button label="Create token" icon="pi pi-plus" :loading="saving"
                  data-track="sys-token-create" @click="createToken" />
        </div>
      </div>
      <template #footer>
        <Button label="Close" @click="showTokensDialog = false" />
      </template>
    </Dialog>

    <!-- Token Reveal Dialog -->
    <Dialog v-model:visible="showTokenRevealDialog" header="API Token" modal
            :style="{ width: '34rem' }" :closable="false">
      <div class="password-reveal">
        <p class="password-warning">
          <i class="pi pi-exclamation-triangle" style="color: var(--p-orange-500)"></i>
          This token will not be shown again. Copy it now.
        </p>
        <div class="password-field">
          <InputText :modelValue="revealedToken" class="w-full" readonly />
          <Button icon="pi pi-copy" severity="secondary" size="small" title="Copy" @click="copyToken" />
        </div>
        <p class="password-note">Store it where the client reads it, not in a shell history or a ticket.</p>
      </div>
      <template #footer>
        <Button label="Done" @click="showTokenRevealDialog = false" />
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
import { useToast } from '../ui/useToast.js';
import Button from '../ui/Button.js';
import EmptyState from '../components/EmptyState.vue';
import DataTable from '../ui/DataTable.js';
import Column from '../ui/Column.js';
import ContextMenu from '../ui/ContextMenu.js';
import Dialog from '../ui/Dialog.js';
import InputText from '../ui/InputText.js';
import Select from '../ui/Select.js';
import Toast from '../ui/Toast.js';
import { useAuthStore } from '../stores/auth.js';
import api from '../api/client.js';
import { apiError } from '../utils/format.js';

const toast = useToast();
const auth = useAuthStore();
const currentUserId = auth.user?.id;

const FALLBACK_ROLES = [
  { value: 'admin', label: 'Administrator' },
  { value: 'dns_admin', label: 'DNS Administrator' },
  { value: 'dhcp_admin', label: 'DHCP Administrator' },
  { value: 'readonly_dns', label: 'DNS Read-Only' },
  { value: 'readonly_dhcp', label: 'DHCP Read-Only' },
  { value: 'readonly', label: 'Read-Only' }
];

const roles = ref(FALLBACK_ROLES);
const rolesLoading = ref(false);
const ROLES = computed(() => roles.value);
const ROLE_LABELS = computed(() => Object.fromEntries(roles.value.map(r => [r.value, r.label])));

function roleLabel(role) {
  return ROLE_LABELS.value[role] || role;
}

const formatDate = formatDateOnly;

const users = ref([]);
const loading = ref(false);
const saving = ref(false);

const ACCOUNT_KINDS = [
  { value: 'person', label: 'Person' },
  { value: 'service', label: 'Service account' }
];

const showCreateDialog = ref(false);
const createForm = ref({ username: '', role: 'readonly', kind: 'person' });

const showTokensDialog = ref(false);
const tokenUser = ref(null);
const tokenList = ref([]);
const tokensLoading = ref(false);
const tokenForm = ref({ name: '', expires_in_days: '0' });

const showTokenRevealDialog = ref(false);
const revealedToken = ref('');

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
    { label: 'Edit Role', icon: 'pi pi-pencil', command: () => openEditDialog(u) }
  ];
  if (u.kind === 'service') {
    items.push({ label: 'API Tokens', icon: 'pi pi-key', command: () => openTokensDialog(u) });
  } else {
    items.push({ label: 'Reset Password', icon: 'pi pi-key', command: () => confirmResetPassword(u) });
  }
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
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally {
    loading.value = false;
  }
}

async function loadRoles() {
  rolesLoading.value = true;
  try {
    const res = await api.get('/users/roles');
    roles.value = res.data.map(r => ({ value: r.value, label: r.label }));
  } catch (err) {
    roles.value = FALLBACK_ROLES;
    toast.add({ severity: 'warn', summary: 'Roles unavailable', detail: apiError(err), life: 5000 });
  } finally {
    rolesLoading.value = false;
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
    await loadUsers();
    if (res.data.kind === 'service') {
      // No password exists to show. Go straight to issuing a token, which is
      // the only way this account can be used at all.
      toast.add({ severity: 'success', summary: 'Service account created', life: 3000 });
      openTokensDialog(res.data);
      return;
    }
    revealedPassword.value = res.data.password;
    showPasswordDialog.value = true;
    toast.add({ severity: 'success', summary: 'User created', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
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
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
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
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
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
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally {
    saving.value = false;
  }
}

async function openTokensDialog(user) {
  tokenUser.value = user;
  tokenForm.value = { name: '', expires_in_days: '0' };
  showTokensDialog.value = true;
  await loadTokens();
}

async function loadTokens() {
  if (!tokenUser.value) return;
  tokensLoading.value = true;
  try {
    const res = await api.get(`/users/${tokenUser.value.id}/tokens`);
    tokenList.value = res.data;
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally {
    tokensLoading.value = false;
  }
}

async function createToken() {
  saving.value = true;
  try {
    const res = await api.post(`/users/${tokenUser.value.id}/tokens`, {
      name: tokenForm.value.name,
      expires_in_days: Number(tokenForm.value.expires_in_days || 0)
    });
    revealedToken.value = res.data.token;
    showTokenRevealDialog.value = true;
    tokenForm.value = { name: '', expires_in_days: '0' };
    await loadTokens();
    await loadUsers();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally {
    saving.value = false;
  }
}

async function revokeToken(token) {
  try {
    await api.delete(`/users/${tokenUser.value.id}/tokens/${token.id}`);
    toast.add({ severity: 'success', summary: 'Token revoked', life: 3000 });
    await loadTokens();
    await loadUsers();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  }
}

function copyToken() {
  navigator.clipboard.writeText(revealedToken.value);
  toast.add({ severity: 'info', summary: 'Copied to clipboard', life: 2000 });
}

function copyPassword() {
  navigator.clipboard.writeText(revealedPassword.value);
  toast.add({ severity: 'info', summary: 'Copied to clipboard', life: 2000 });
}

onMounted(async () => {
  await loadRoles();
  await loadUsers();
});


</script>

<style scoped>
.kind-tag {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.85rem;
}
.kind-tag .token-count {
  color: var(--p-text-muted-color);
  font-size: 0.78rem;
}
.kind-plain { color: var(--p-text-muted-color); }
.field-hint {
  display: block;
  margin-top: 0.25rem;
  color: var(--p-text-muted-color);
}
.tokens-panel { display: flex; flex-direction: column; gap: 1rem; }
.token-new {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--p-content-border-color);
}

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
