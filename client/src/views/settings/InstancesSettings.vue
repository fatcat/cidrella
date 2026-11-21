<!-- Instances: the controller, which owns the data, and the members that hold
     a synced read-only copy of it and keep serving DNS. On the controller this
     is where a member is added (a join token) and removed; on a member it
     shows which controller it follows and how the sync stands. A single box
     is a controller with itself as the only row. -->
<template>
  <div class="content-card">
    <EmptyState
      v-if="!auth.isAdmin"
      icon="pi-lock"
      title="Administrators only"
      description="Only an administrator can see the instances."
    />
    <template v-else>
      <div class="card-header">
        <h3>Instances</h3>
        <Button
          v-if="isController"
          label="Add member"
          icon="pi pi-plus"
          size="small"
          :loading="makingToken"
          data-track="instances-add-member"
          @click="addMember"
        />
      </div>

      <p v-if="isController" class="field-help intro">
        This instance is the controller: it owns the data, and changes are made here. A member holds
        a read-only copy, kept in sync, and keeps serving DNS when the controller is away.
      </p>

      <section v-if="state?.mode === 'member'" class="following" data-track="instances-following">
        <p>
          This instance is a member of <strong>{{ state.controller?.name }}</strong>
          <span v-if="controllerAddress" class="mono muted"> ({{ controllerAddress }})</span>. It
          holds a read-only copy of the controller's data. Make changes on the controller.
        </p>
        <p class="sync-line">
          <StatusDot :kind="sync.tone" :label="sync.words" show-label />
          <span class="muted">{{ lastSync }}</span>
        </p>
        <p v-if="state.sync?.last_error" class="field-error" data-track="instances-sync-error">
          {{ state.sync.last_error }}
        </p>
      </section>

      <DataTable :value="rows" :loading="loading" size="small" stripedRows data-key="id">
        <template #empty>
          <EmptyState icon="pi-sitemap" title="No instances" :description="emptyText" />
        </template>
        <Column header="Name">
          <template #body="{ data }">
            <span :data-instance-id="data.instance_id">{{ data.name }}</span>
            <span v-if="data.is_self" class="muted"> (this instance)</span>
          </template>
        </Column>
        <Column header="Address">
          <template #body="{ data }">
            <span class="mono">{{ addressOf(data) }}</span>
          </template>
        </Column>
        <Column header="Role">
          <template #body="{ data }">{{ data.is_controller ? 'Controller' : 'Member' }}</template>
        </Column>
        <Column header="Version">
          <template #body="{ data }">{{ data.version || EMPTY_CELL }}</template>
        </Column>
        <Column v-if="isController" header="Last contact">
          <template #body="{ data }">{{ lastContact(data) }}</template>
        </Column>
        <Column v-if="isController" header="Sync">
          <template #body="{ data }">{{ behindText(data) }}</template>
        </Column>
        <Column v-if="isController" header="" style="width: 3rem">
          <template #body="{ data }">
            <Button
              v-if="!data.is_controller && !data.is_self"
              icon="pi pi-trash"
              severity="danger"
              text
              rounded
              size="small"
              :aria-label="`Remove ${data.name}`"
              title="Remove"
              data-track="instances-remove"
              @click="removing = data"
            />
          </template>
        </Column>
      </DataTable>
    </template>

    <Dialog
      v-model:visible="showToken"
      header="Add a member"
      modal
      :style="{ width: '36rem' }"
      data-track="instances-token-dialog"
      @hide="load"
    >
      <ol class="steps">
        <li>Install CIDRella on the new box and finish its first sign-in.</li>
        <li>Choose <strong>Join an existing CIDRella</strong>.</li>
        <li>Enter this box's address and the token below.</li>
      </ol>
      <div class="input-with-action">
        <InputText
          :model-value="token?.token"
          readonly
          class="mono"
          aria-label="Join token"
          data-track="instances-token"
        />
        <Button
          icon="pi pi-copy"
          severity="secondary"
          size="small"
          :label="copied ? 'Copied' : 'Copy'"
          data-track="instances-token-copy"
          @click="copyToken"
        />
      </div>
      <p v-if="copyError" class="field-error">{{ copyError }}</p>
      <p class="field-help">
        The token works once and stops working at {{ formatDateTime(token?.expires_at) }} (15
        minutes after it was made).
      </p>
      <Message severity="warn" :closable="false">
        A member holds a full copy of the data, password hashes and two-factor secrets included.
        Give it the same protection as this box.
      </Message>
      <template #footer>
        <Button label="Done" data-track="instances-token-done" @click="showToken = false" />
      </template>
    </Dialog>

    <ConfirmDialog
      :visible="removing !== null"
      :header="`Remove ${removing?.name}?`"
      confirm-label="Remove"
      confirm-icon="pi pi-trash"
      width="30rem"
      :loading="removeBusy"
      confirm-track="instances-remove-confirm"
      cancel-track="instances-remove-cancel"
      @update:visible="(v) => !v && !removeBusy && (removing = null)"
      @confirm="removeMember"
    >
      <p>
        {{ removing?.name }} stops receiving changes from this controller. It keeps serving DNS from
        the copy it has, which goes out of date from now on.
      </p>
    </ConfirmDialog>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import Button from '../../ui/Button.js';
import Column from '../../ui/Column.js';
import DataTable from '../../ui/DataTable.js';
import Dialog from '../../ui/Dialog.js';
import InputText from '../../ui/InputText.js';
import Message from '../../ui/Message.js';
import ConfirmDialog from '../../components/ConfirmDialog.vue';
import EmptyState from '../../components/EmptyState.vue';
import StatusDot from '../../components/StatusDot.vue';
import api from '../../api/client.js';
import { useToast } from '../../ui/useToast.js';
import { useAuthStore } from '../../stores/auth.js';
import { useFeatures } from '../../composables/useFeatures.js';
import { apiError, EMPTY_CELL } from '../../utils/format.js';
import { formatDateTime, formatRelativeTime } from '../../utils/dateFormat.js';
import { behindText, lastSyncText, syncState } from '../../utils/instances.js';
import { formatHostPort } from '@shared/address.js';

const auth = useAuthStore();
const toast = useToast();
const features = useFeatures();

// GET /api/instances, null until the first read answers.
const state = ref(null);
const loading = ref(false);
const rows = computed(() => state.value?.instances || []);
// Only what the server says is a controller offers the controller's actions.
const isController = computed(() => state.value?.mode === 'controller');
const emptyText = computed(() =>
  state.value ? 'No instance is listed.' : 'The list of instances could not be read.',
);

const sync = computed(() => syncState(state.value?.sync));
const lastSync = computed(() => lastSyncText(state.value?.sync));
const addressOf = (row) => (row?.address ? formatHostPort(row.address, row.port) : EMPTY_CELL);
const controllerAddress = computed(() =>
  state.value?.controller?.address ? addressOf(state.value.controller) : '',
);

// The controller's own row has no last contact: it is the one being called.
function lastContact(row) {
  if (row.is_controller) return EMPTY_CELL;
  return row.last_contact_at ? formatRelativeTime(row.last_contact_at) : 'Never';
}

function fail(summary, err) {
  toast.add({ severity: 'error', summary, detail: apiError(err), life: 6000 });
}

async function load() {
  if (!auth.isAdmin) return;
  loading.value = true;
  try {
    state.value = (await api.get('/instances')).data;
    // The header chip counts the members; a member that joined since the
    // last read of the features changes it.
    const members = rows.value.filter((row) => !row.is_controller).length;
    if (isController.value && members !== features.instance.value.members) {
      void features.reload();
    }
  } catch (err) {
    fail('Instances not loaded', err);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

// Add member: a one-use join token, shown once.
const showToken = ref(false);
const token = ref(null);
const makingToken = ref(false);
const copied = ref(false);
const copyError = ref('');

async function addMember() {
  if (makingToken.value) return;
  makingToken.value = true;
  try {
    token.value = (await api.post('/instances/join-token')).data;
    copied.value = false;
    copyError.value = '';
    showToken.value = true;
  } catch (err) {
    fail('No join token made', err);
  } finally {
    makingToken.value = false;
  }
}

async function copyToken() {
  copyError.value = '';
  try {
    await navigator.clipboard.writeText(token.value.token);
    copied.value = true;
  } catch {
    copyError.value = 'Copy failed. Select the token and copy it by hand.';
  }
}

const removing = ref(null);
const removeBusy = ref(false);

async function removeMember() {
  const row = removing.value;
  removeBusy.value = true;
  try {
    await api.delete(`/instances/${row.id}`);
    toast.add({ severity: 'success', summary: `${row.name} removed`, life: 4000 });
  } catch (err) {
    fail('Member not removed', err);
  } finally {
    removeBusy.value = false;
    removing.value = null;
    // The header chip counts the members, so it follows the list.
    await Promise.all([load(), features.reload()]);
  }
}
</script>

<style scoped>
.intro {
  max-width: 44rem;
  margin: 0 0 1rem;
}
.following {
  max-width: 44rem;
  margin-bottom: 1rem;
}
.following p {
  margin: 0 0 0.5rem;
}
.sync-line {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.steps {
  margin: 0 0 1rem;
  padding-left: 1.25rem;
}
.steps li {
  margin-bottom: 0.25rem;
}
</style>
