<!-- Instances: the controller, which owns the data, and the members that hold
     a synced read-only copy of it and keep serving DNS. On the controller this
     is where a member is added (a join token) and removed; on a member it
     shows which controller it follows and how the sync stands. A single box
     is a controller with itself as the only row.

     One instance serves DHCP at a time. The controller's view moves it to a
     member and back; while the old one still owes its leases the page says so
     and re-reads the list until the move is done.

     The controller can change, and a person decides it. The controller's view
     hands the role to a member (Make controller): both stop taking changes,
     the member takes over and this instance restarts as a member of it. A
     member whose controller is gone for good promotes itself. A controller
     that comes back to find itself replaced takes no changes, and is rejoined
     to the new one as a member, or takes the controller back when the new one
     is gone (components/instances/FencedPanel.vue). A member that cannot reach
     its controller can join one again with a new token (RejoinForm.vue). After
     each of these the box restarts and the page goes to sign-in. -->
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
          v-if="canPromoteSelf"
          label="Promote this instance"
          severity="danger"
          outlined
          size="small"
          data-track="instances-promote-self"
          @click="promotingSelf = true"
        />
        <Button
          v-if="canAct"
          label="Add member"
          icon="pi pi-plus"
          size="small"
          :loading="makingToken"
          data-track="instances-add-member"
          @click="addMember"
        />
      </div>

      <p v-if="awaiting" class="status-line" data-track="instances-restarting">
        <StatusDot kind="warn" label="Restarting" />
        <span>{{ restartingText(awaiting) }}</span>
      </p>

      <FencedPanel
        v-if="fenced && !awaiting"
        :fenced="fenced"
        :self-name="selfName"
        @rejoined="onRejoined"
        @took-back="onPromoted"
      />

      <p v-if="isController && !fenced" class="field-help intro">
        This instance is the controller: it owns the data, and changes are made here. A member holds
        a read-only copy, kept in sync, and keeps serving DNS when the controller is away.
      </p>

      <section
        v-if="state?.mode === 'member' && !fenced"
        class="following"
        data-track="instances-following"
      >
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
        <template v-if="canJoinAgain">
          <Button
            label="Join a controller again"
            :icon="joiningAgain ? 'pi pi-chevron-down' : 'pi pi-chevron-right'"
            severity="secondary"
            text
            size="small"
            :aria-expanded="joiningAgain"
            data-track="instances-join-again"
            @click="joiningAgain = !joiningAgain"
          />
          <div v-if="joiningAgain" data-track="instances-join-again-form">
            <p class="field-help">
              Use this when the controller was replaced and the new one does not know this instance.
              Make a join token on the controller under Settings &gt; System &gt; Instances &gt; Add
              member.
            </p>
            <RejoinForm @rejoined="onRejoined" />
          </div>
        </template>
      </section>

      <p v-if="promoHandover" class="status-line" data-track="instances-promote-handover">
        <StatusDot kind="warn" label="Handing over" />
        <span>{{ promotionLine }}</span>
        <Button
          label="Cancel handover"
          severity="warn"
          text
          size="small"
          data-track="instances-promote-cancel"
          @click="cancelling = true"
        />
      </p>

      <p v-if="handover" class="status-line" data-track="instances-dhcp-handover">
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

      <p v-if="dnsLine" class="status-line" data-track="instances-dns-handout">
        <StatusDot kind="info" label="Not every DNS server is handed out" />
        <span>{{ dnsLine }}</span>
      </p>

      <p
        v-if="state?.restore_unfinished === true"
        class="status-line"
        data-track="instances-restore-unfinished"
      >
        <StatusDot kind="err" label="Restore not finished" />
        <span>
          The restore could not keep this box's instance list and epoch at boot, so it talks to no
          other instance and runs no scheduled jobs. Restart CIDRella to finish it; the service log
          says what failed.
        </span>
      </p>

      <p v-if="backupsOff" class="status-line" data-track="instances-backups-off">
        <StatusDot kind="warn" label="Backups off" />
        <span>
          Backups are switched off on this controller. Switch them on under
          <RouterLink :to="BACKUP_SETTINGS"
            >Settings &gt; Maintenance &gt; Backup &amp; Restore</RouterLink
          >.
        </span>
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
        <Column header="DNS">
          <template #body="{ data }">
            <StatusDot
              v-if="dnsState(data)"
              :kind="dnsState(data).tone"
              :label="dnsState(data).words"
              show-label
            />
            <span v-else class="muted">{{ EMPTY_CELL }}</span>
          </template>
        </Column>
        <Column header="DHCP">
          <template #body="{ data }">
            <span v-if="dhcpState(data, handover)" :title="dhcpState(data, handover).title">
              <StatusDot
                :kind="dhcpState(data, handover).tone"
                :label="dhcpState(data, handover).words"
                show-label
              />
            </span>
            <span v-else class="muted">{{ EMPTY_CELL }}</span>
          </template>
        </Column>
        <Column v-if="canAct" header="">
          <template #body="{ data }">
            <div class="action-buttons row-actions">
              <Button
                v-if="data.can_promote"
                label="Make controller"
                severity="secondary"
                text
                size="small"
                data-track="instances-promote"
                @click="promoting = data"
              />
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

    <ConfirmDialog
      :visible="promoting !== null"
      :header="`Make ${promoting?.name} the controller?`"
      severity="warn"
      confirm-label="Make controller"
      width="34rem"
      :loading="promoteBusy"
      data-track="instances-promote-dialog"
      confirm-track="instances-promote-confirm"
      cancel-track="instances-promote-dismiss"
      @update:visible="(v) => !v && !promoteBusy && (promoting = null)"
      @confirm="promote"
    >
      <p>{{ promoting?.name }} becomes the controller, and this instance becomes a member of it.</p>
      <p>
        No changes can be made on either until it is done, usually a few seconds. DHCP stays on the
        instance that serves it now.
      </p>
      <p>This instance restarts, and you sign in again.</p>
      <p>
        If {{ promoting?.name }} stops answering partway, this instance stays frozen until you
        cancel the handover. Cancelling at the wrong moment can leave this instance replaced anyway.
      </p>
    </ConfirmDialog>

    <ConfirmDialog
      :visible="cancelling"
      :header="`Cancel the handover to ${promotionTarget}?`"
      severity="warn"
      confirm-label="Cancel handover"
      cancel-label="Keep waiting"
      width="32rem"
      :loading="cancelBusy"
      data-track="instances-promote-cancel-dialog"
      confirm-track="instances-promote-cancel-confirm"
      cancel-track="instances-promote-cancel-dismiss"
      @update:visible="(v) => !v && !cancelBusy && (cancelling = false)"
      @confirm="cancelPromotion"
    >
      <p>
        This instance takes changes again. If {{ promotionTarget }} has already taken over, the
        cancel comes too late: this instance is replaced, and you rejoin it as a member.
      </p>
    </ConfirmDialog>

    <ConfirmDialog
      :visible="promotingSelf"
      :header="`Make ${selfName} the controller?`"
      confirm-label="Promote this instance"
      width="36rem"
      :type-to-confirm="selfName"
      :disabled="!lastSyncAt"
      :loading="promoteSelfBusy"
      data-track="instances-promote-self-dialog"
      confirm-track="instances-promote-self-confirm"
      cancel-track="instances-promote-self-cancel"
      @update:visible="(v) => !v && !promoteSelfBusy && (promotingSelf = false)"
      @confirm="promoteSelf"
    >
      <p>Do this only when {{ oldController }} is switched off or gone for good.</p>
      <p v-if="lastSyncAt" data-track="instances-promote-self-sync">
        The data here is from the last sync, {{ formatDateTime(lastSyncAt) }} ({{
          formatRelativeTime(lastSyncAt)
        }}). Changes made on {{ oldController }} after that are not here and will not come back by
        themselves.
      </p>
      <p v-else data-track="instances-promote-self-sync">
        This instance has not synced yet, so it has no data to take over with. It cannot be
        promoted.
      </p>
      <p>The other members follow this instance within about a minute.</p>
      <p>
        DHCP is not started here automatically. If {{ oldController }} served DHCP, start it from
        this page afterwards.
      </p>
      <p>
        If {{ oldController }} is in fact still running and clients can reach it, two controllers
        exist until it hears about this one.
      </p>
      <p>This instance restarts, and you sign in again.</p>
    </ConfirmDialog>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import Button from '../../ui/Button.js';
import Column from '../../ui/Column.js';
import DataTable from '../../ui/DataTable.js';
import Dialog from '../../ui/Dialog.js';
import InputText from '../../ui/InputText.js';
import Message from '../../ui/Message.js';
import ConfirmDialog from '../../components/ConfirmDialog.vue';
import EmptyState from '../../components/EmptyState.vue';
import StatusDot from '../../components/StatusDot.vue';
import FencedPanel from '../../components/instances/FencedPanel.vue';
import RejoinForm from '../../components/instances/RejoinForm.vue';
import api from '../../api/client.js';
import { useToast } from '../../ui/useToast.js';
import { useAuthStore } from '../../stores/auth.js';
import { useFeatures } from '../../composables/useFeatures.js';
import { useSignInAgain } from '../../composables/useSignInAgain.js';
import { apiError, EMPTY_CELL } from '../../utils/format.js';
import { formatDateTime, formatRelativeTime } from '../../utils/dateFormat.js';
import {
  behindText,
  dhcpServer,
  dhcpState,
  dnsHandoutLine,
  dnsState,
  handoverNames,
  handoverText,
  handoverWaited,
  lastSyncText,
  promotionText,
  restartingText,
  syncState,
} from '../../utils/instances.js';
import { formatHostPort } from '@shared/address.js';

const auth = useAuthStore();
const toast = useToast();
const features = useFeatures();
const signInAgain = useSignInAgain();

// GET /api/instances, null until the first read answers.
const state = ref(null);
const loading = ref(false);
const rows = computed(() => state.value?.instances || []);
// Only what the server says is a controller offers the controller's actions.
const isController = computed(() => state.value?.mode === 'controller');
// A change of controller. A server that says nothing about it predates it:
// no handover, not replaced, and none of the controls.
const promotion = computed(() => state.value?.promotion || null);
const promoHandover = computed(() => promotion.value?.handover || null);
const fenced = computed(() => {
  if (promotion.value?.fenced) return promotion.value.fenced;
  // The list could not be read, but the features say it.
  const self = features.instance.value;
  return self?.fenced ? { by_name: self.fenced_by || null, since: null, report: false } : null;
});
// Set once this box was told to restart as something else:
// `{ mode, reason, name }`, the mode it comes back in and what the sign-in
// page then says (utils/session.js).
const awaiting = ref(null);
// The controller's own actions: not while it hands over, and not once replaced.
const canAct = computed(
  () => isController.value && !promoHandover.value && !fenced.value && !awaiting.value,
);
// A controller with backups off has nothing to restore from if it is lost.
const BACKUP_SETTINGS = '/system?area=maintenance&sec=backup';
// More instances answer DNS than DHCP clients are given.
const dnsLine = computed(() => dnsHandoutLine(state.value?.dns_handed_out));
const backupsOff = computed(
  () => isController.value && !fenced.value && state.value?.backups_off === true,
);
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
  if (row.silent_since_takeover) return 'Not heard from since the takeover';
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
const servingName = computed(
  () =>
    (dhcpServer(rows.value) || rows.value.find((row) => row.is_controller))?.name ||
    'The controller',
);
const handoverEnds = computed(() => handoverNames(handover.value, rows.value));

function removeTitle(row) {
  return row.dhcp ? `Move DHCP to another instance before removing ${row.name}` : 'Remove';
}

// While something is pending (DHCP moving, the controller handing over, this
// box restarting) one timer counts the wait and reads again every few
// seconds; it stops when all of it clears or the page is left.
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
const pending = computed(
  () => handover.value !== null || promoHandover.value !== null || awaiting.value !== null,
);
watch(pending, (on) => {
  stopTicker();
  if (!on) return;
  now.value = Date.now();
  ticks = 0;
  ticker = setInterval(() => {
    now.value = Date.now();
    ticks += 1;
    if (ticks % POLL_EVERY_TICKS === 0) void poll();
  }, TICK_MS);
});
watch(handover, (value) => {
  if (!value) forcing.value = false;
});
watch(promoHandover, (value) => {
  if (!value) cancelling.value = false;
});

// What this box is expected to come back as: what an action here asked for,
// or a member of the instance the controller is handing over to.
const awaited = computed(
  () =>
    awaiting.value ||
    (promoHandover.value
      ? { mode: 'member', reason: 'joined', name: promoHandover.value.to_name || null }
      : null),
);
// A request failed for want of a server: the restart has begun.
let wentAway = false;
let polling = false;

async function poll() {
  if (polling) return;
  polling = true;
  try {
    if (awaited.value && (await arrived())) return;
    if (!awaiting.value) await load({ quiet: true });
  } finally {
    polling = false;
  }
}

// Has this box come back as what it was to become? Requests fail for a few
// seconds while it restarts; that is expected, and the next turn asks again.
// When it answers in the new mode the session here is for the box it was, so
// the page goes to sign-in and says why.
async function arrived() {
  const want = awaited.value;
  let instance;
  try {
    instance = (await api.get('/features', { ownSessionEnd: true })).data?.instance;
  } catch (err) {
    const status = err.response?.status;
    // Back, with the session gone: only a restart does that mid-wait.
    if (status === 401 && (awaiting.value || wentAway)) return leave(want, null);
    if (!status || status >= 500) wentAway = true;
    return false;
  }
  const mode = instance?.mode === 'member' ? 'member' : 'controller';
  if (mode !== want.mode) return false;
  // A replaced controller that is taking the role back is not there yet.
  if (want.mode === 'controller' && instance?.fenced) return false;
  return leave(want, instance?.controller_name);
}

function leave(want, name) {
  stopTicker();
  void signInAgain(want.reason, want.mode === 'member' ? name || want.name || null : null);
  return true;
}

onBeforeUnmount(stopTicker);

const handoverLine = computed(() => handoverText(handover.value, rows.value, now.value));
const canForce = computed(
  () => isController.value && handoverWaited(handover.value, now.value) > FORCE_AFTER_SECONDS,
);

const promotionLine = computed(() => promotionText(promoHandover.value, now.value));
const promotionTarget = computed(() => promoHandover.value?.to_name || 'the new controller');

// Make controller: hand the role to a member, from the controller's view.
const promoting = ref(null);
const promoteBusy = ref(false);

async function promote() {
  const row = promoting.value;
  promoteBusy.value = true;
  let started = false;
  try {
    const { data } = await api.post(`/instances/${row.id}/promote`);
    // Shown at once: this box may restart before the list can be read again.
    const handing = data?.handover || {
      to_instance_id: row.instance_id,
      to_name: row.name,
      since: new Date().toISOString(),
    };
    state.value = { ...state.value, promotion: { ...state.value?.promotion, handover: handing } };
    started = true;
  } catch (err) {
    fail('Controller not changed', err);
  } finally {
    promoteBusy.value = false;
    promoting.value = null;
    await Promise.all([load({ quiet: started }), features.reload()]);
  }
}

const cancelling = ref(false);
const cancelBusy = ref(false);

async function cancelPromotion() {
  cancelBusy.value = true;
  try {
    await api.post('/instances/promote/cancel');
    toast.add({ severity: 'success', summary: 'Handover cancelled', life: 4000 });
  } catch (err) {
    fail('Handover not cancelled', err);
  } finally {
    cancelBusy.value = false;
    cancelling.value = false;
    await Promise.all([load({ quiet: true }), features.reload()]);
  }
}

// Promote this instance: a member takes over from a controller that is gone.
// Offered only by a server that knows how.
const canPromoteSelf = computed(
  () =>
    state.value?.mode === 'member' && Boolean(promotion.value) && !fenced.value && !awaiting.value,
);
const selfName = computed(() => state.value?.self?.name || 'this instance');
const oldController = computed(() => state.value?.controller?.name || 'the controller');
// The data a promoted member has is from its last sync.
const lastSyncAt = computed(
  () => features.instance.value?.sync?.last_sync_at || state.value?.sync?.last_sync_at || null,
);
const promotingSelf = ref(false);
const promoteSelfBusy = ref(false);

async function promoteSelf() {
  promoteSelfBusy.value = true;
  try {
    await api.post('/instances/promote-self', { confirm: true });
    onPromoted();
  } catch (err) {
    fail('Not promoted', err);
    await load();
  } finally {
    promoteSelfBusy.value = false;
    promotingSelf.value = false;
  }
}

// This instance was promoted (a member, or a replaced controller taking the
// role back) and is restarting as the controller.
function onPromoted() {
  awaiting.value = { mode: 'controller', reason: 'promoted', name: null };
}

// This instance joined a controller (a replaced controller, or a member that
// lost its own) and is restarting as a member of it.
function onRejoined(name) {
  awaiting.value = { mode: 'member', reason: 'joined', name };
}

// Join a controller again: for a member whose controller does not answer.
// The form stays open once opened, whatever the next read says.
const joiningAgain = ref(false);
const canJoinAgain = computed(
  () => !awaiting.value && (state.value?.sync?.state === 'offline' || joiningAgain.value),
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
.status-line {
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
