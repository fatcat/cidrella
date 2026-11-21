<!-- Instances: the controller, which owns the data, and the members that hold
     a synced read-only copy of it and keep serving DNS. On the controller this
     is where a member is added (a join token) and removed; on a member it
     shows which controller it follows and how the sync stands. A single box
     is a controller with itself as the only row.

     One instance serves DHCP at a time. The controller's view moves it to a
     member and back; while the old one still owes its leases the page says so
     and re-reads the list until the move is done. -->
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

      <p v-if="handover" class="dhcp-moving" data-track="instances-dhcp-handover">
        <StatusDot kind="warn" label="DHCP is moving" />
        <span>{{ handoverLine }}</span>
        <Button
          v-if="canForce"
          label="Start without the old leases"
          severity="danger"
          text
          size="small"
          data-track="instances-dhcp-force"
          @click="forcing = true"
        />
      </p>

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
        <Column v-if="showDhcp" header="DHCP">
          <template #body="{ data }">
            <StatusDot
              v-if="dhcpState(data, handover)"
              :kind="dhcpState(data, handover).tone"
              :label="dhcpState(data, handover).words"
              show-label
            />
          </template>
        </Column>
        <Column v-if="isController" header="">
          <template #body="{ data }">
            <div class="action-buttons row-actions">
              <Button
                v-if="data.can_take_dhcp"
                label="Move DHCP here"
                severity="secondary"
                text
                size="small"
                data-track="instances-dhcp-move"
                @click="moving = data"
              />
              <Button
                v-if="!data.is_controller && !data.is_self"
                icon="pi pi-trash"
                severity="danger"
                text
                rounded
                size="small"
                :disabled="Boolean(data.dhcp)"
                :aria-label="`Remove ${data.name}`"
                :title="removeTitle(data)"
                data-track="instances-remove"
                @click="removing = data"
              />
            </div>
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

    <ConfirmDialog
      :visible="moving !== null"
      :header="`Move DHCP to ${moving?.name}?`"
      severity="warn"
      confirm-label="Move DHCP"
      width="34rem"
      :loading="moveBusy"
      data-track="instances-dhcp-move-dialog"
      confirm-track="instances-dhcp-move-confirm"
      cancel-track="instances-dhcp-move-cancel"
      @update:visible="(v) => !v && !moveBusy && (moving = null)"
      @confirm="moveDhcp"
    >
      <p>
        {{ servingName }} serves DHCP now. After the move, {{ moving?.name }} serves it and
        {{ servingName }} stops.
      </p>
      <p>
        Clients keep their leases: {{ servingName }} hands them over to {{ moving?.name }}. DHCP
        stops for a moment during the move.
      </p>
      <p>
        {{ moving?.name }} must be on a network where the clients can reach it: on the same
        segments, or with the DHCP relays pointed at it. CIDRella cannot check this.
      </p>
    </ConfirmDialog>

    <ConfirmDialog
      :visible="forcing"
      :header="`Start DHCP on ${handoverEnds.to} without the leases from ${handoverEnds.from}?`"
      confirm-label="Start without the old leases"
      width="34rem"
      :type-to-confirm="handoverEnds.from"
      :loading="forceBusy"
      data-track="instances-dhcp-force-dialog"
      confirm-track="instances-dhcp-force-confirm"
      cancel-track="instances-dhcp-force-cancel"
      @update:visible="(v) => !v && !forceBusy && (forcing = false)"
      @confirm="forceDhcp"
    >
      <p>Do this only when {{ handoverEnds.from }} is switched off or cut off for good.</p>
      <p>
        {{ handoverEnds.to }} starts with the leases the controller last heard about. A lease
        {{ handoverEnds.from }} gave after that is unknown to {{ handoverEnds.to }}.
      </p>
      <p>
        If {{ handoverEnds.from }} is still running, two DHCP servers will answer on the network.
      </p>
    </ConfirmDialog>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
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
import {
  behindText,
  dhcpServer,
  dhcpState,
  handoverNames,
  handoverText,
  handoverWaited,
  lastSyncText,
  syncState,
} from '../../utils/instances.js';
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

// `quiet` is the re-read while DHCP moves: no spinner over the table, and a
// read that fails is tried again on the next turn instead of raising a toast
// every few seconds.
async function load({ quiet = false } = {}) {
  if (!auth.isAdmin) return;
  if (!quiet) loading.value = true;
  try {
    state.value = (await api.get('/instances')).data;
    // The header chip counts the members; a member that joined since the
    // last read of the features changes it.
    const members = rows.value.filter((row) => !row.is_controller).length;
    if (isController.value && members !== features.instance.value.members) {
      void features.reload();
    }
  } catch (err) {
    if (!quiet) fail('Instances not loaded', err);
  } finally {
    if (!quiet) loading.value = false;
  }
}

onMounted(() => load());

// DHCP. A server that says nothing about it predates moving DHCP: the
// controller serves, and the page shows nothing new.
const handover = computed(() => state.value?.dhcp?.handover || null);
const showDhcp = computed(() => Boolean(state.value?.dhcp) || rows.value.some((row) => row.dhcp));
const servingName = computed(
  () =>
    (dhcpServer(rows.value) || rows.value.find((row) => row.is_controller))?.name ||
    'The controller',
);
const handoverEnds = computed(() => handoverNames(handover.value, rows.value));

function removeTitle(row) {
  return row.dhcp ? `Move DHCP to another instance before removing ${row.name}` : 'Remove';
}

// While a handover is pending the line counts the wait and the list is read
// again every few seconds; both stop when it clears or the page is left.
const TICK_MS = 1000;
const POLL_EVERY_TICKS = 5;
const FORCE_AFTER_SECONDS = 60;
const now = ref(Date.now());
let ticker = null;
let ticks = 0;

function stopTicker() {
  clearInterval(ticker);
  ticker = null;
}
watch(
  () => handover.value !== null,
  (pending) => {
    stopTicker();
    if (!pending) {
      forcing.value = false;
      return;
    }
    now.value = Date.now();
    ticks = 0;
    ticker = setInterval(() => {
      now.value = Date.now();
      ticks += 1;
      if (ticks % POLL_EVERY_TICKS === 0) void load({ quiet: true });
    }, TICK_MS);
  },
);
onBeforeUnmount(stopTicker);

const handoverLine = computed(() => handoverText(handover.value, rows.value, now.value));
const canForce = computed(
  () => isController.value && handoverWaited(handover.value, now.value) > FORCE_AFTER_SECONDS,
);

const moving = ref(null);
const moveBusy = ref(false);

async function moveDhcp() {
  const row = moving.value;
  moveBusy.value = true;
  try {
    const { data } = await api.post(`/instances/${row.id}/dhcp`);
    toast.add({
      severity: 'success',
      summary: data?.handover ? `DHCP is moving to ${row.name}` : `${row.name} serves DHCP`,
      life: 4000,
    });
  } catch (err) {
    fail('DHCP not moved', err);
  } finally {
    moveBusy.value = false;
    moving.value = null;
    // A refusal usually means the list on screen is out of date.
    await Promise.all([load(), features.reload()]);
  }
}

const forcing = ref(false);
const forceBusy = ref(false);

async function forceDhcp() {
  const { to } = handoverEnds.value;
  forceBusy.value = true;
  try {
    await api.post('/instances/dhcp/force', { confirm: true });
    toast.add({ severity: 'success', summary: `${to} serves DHCP`, life: 4000 });
  } catch (err) {
    fail('DHCP not started', err);
  } finally {
    forceBusy.value = false;
    forcing.value = false;
    await Promise.all([load(), features.reload()]);
  }
}

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
.dhcp-moving {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0 0 0.75rem;
}
.row-actions {
  justify-content: flex-end;
  align-items: center;
}
.steps {
  margin: 0 0 1rem;
  padding-left: 1.25rem;
}
.steps li {
  margin-bottom: 0.25rem;
}
</style>
