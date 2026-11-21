<!-- A controller that was replaced: another instance was made the controller
     while this one was away. It takes no changes now. Here an admin downloads
     the report of the changes the new controller never received, and rejoins
     this instance to the new controller as a member with a join token. -->
<template>
  <section class="fenced" data-track="instances-fenced">
    <p class="fenced-what">
      <StatusDot kind="err" label="Replaced" />
      <span>{{ fencedText(fenced) }}</span>
    </p>

    <template v-if="fenced.report">
      <Button
        label="Download report of changes not received"
        icon="pi pi-download"
        severity="secondary"
        size="small"
        :loading="downloading"
        data-track="instances-divergence-report"
        @click="downloadReport"
      />
      <span class="field-help">
        The report lists the changes made here that the new controller never received. Enter them
        again on the new controller by hand.
      </span>
    </template>

    <h4>Rejoin as a member</h4>
    <p class="field-help">
      Make a join token on {{ newController }} under Settings &gt; System &gt; Instances &gt; Add
      member. A token works once and lasts 15 minutes.
    </p>
    <form @submit.prevent="ask">
      <JoinTargetFields
        v-model:address="address"
        v-model:port="port"
        v-model:token="token"
        id-prefix="instances-rejoin"
        track="instances-rejoin"
        :disabled="busy"
      />
      <p v-if="error" class="field-error" data-track="instances-rejoin-error">{{ error }}</p>
      <div class="rejoin-actions">
        <Button
          type="submit"
          label="Rejoin as a member"
          size="small"
          :disabled="!!blocker"
          :loading="busy"
          data-track="instances-rejoin-submit"
        />
        <span v-if="blocker" class="muted text-sm">{{ blocker }}</span>
      </div>
    </form>

    <ConfirmDialog
      :visible="confirming"
      :header="fenced.by_name ? `Rejoin as a member of ${fenced.by_name}?` : 'Rejoin as a member?'"
      confirm-label="Rejoin"
      width="34rem"
      :loading="busy"
      data-track="instances-rejoin-dialog"
      confirm-track="instances-rejoin-confirm"
      cancel-track="instances-rejoin-cancel"
      @update:visible="(v) => !v && !busy && (confirming = false)"
      @confirm="rejoin"
    >
      <p>
        The data on this instance is replaced by the new controller's: networks, DNS, DHCP, settings
        and every account. A copy of the database as it is now is saved first.
      </p>
      <p>
        Changes made here that the new controller never received are not carried over.
        <template v-if="fenced.report">Download the report first if you need them.</template>
      </p>
      <p>This instance restarts, and you sign in with an account from the new controller.</p>
    </ConfirmDialog>
  </section>
</template>

<script setup>
import { computed, ref } from 'vue';
import Button from '../../ui/Button.js';
import ConfirmDialog from '../ConfirmDialog.vue';
import StatusDot from '../StatusDot.vue';
import JoinTargetFields from './JoinTargetFields.vue';
import api from '../../api/client.js';
import { useToast } from '../../ui/useToast.js';
import { useJoinTarget } from '../../composables/useJoinTarget.js';
import { saveBlob } from '../../utils/download.js';
import { apiError } from '../../utils/format.js';
import { fencedText } from '../../utils/instances.js';

const props = defineProps({
  // `promotion.fenced` of GET /api/instances: { by_name, epoch, since, report }.
  fenced: { type: Object, required: true },
});
// The rejoin was accepted and this instance is restarting as a member of the
// named controller.
const emit = defineEmits(['rejoined']);
const toast = useToast();

const newController = computed(() => props.fenced.by_name || 'the new controller');

const downloading = ref(false);
async function downloadReport() {
  downloading.value = true;
  try {
    const res = await api.get('/instances/divergence-report', { responseType: 'blob' });
    saveBlob(res.data, 'cidrella-changes-not-received.json');
  } catch (err) {
    toast.add({
      severity: 'error',
      summary: 'Report not downloaded',
      detail: apiError(err),
      life: 6000,
    });
  } finally {
    downloading.value = false;
  }
}

const { address, port, token, blocker, body } = useJoinTarget();
const confirming = ref(false);
const busy = ref(false);
const error = ref('');

function ask() {
  if (blocker.value || busy.value) return;
  error.value = '';
  confirming.value = true;
}

async function rejoin() {
  busy.value = true;
  try {
    const { data } = await api.post('/instances/rejoin', body());
    emit('rejoined', data?.controller?.name || props.fenced.by_name || null);
  } catch (err) {
    // The refusal stays beside the form, which is where it is put right.
    error.value = apiError(err);
  } finally {
    busy.value = false;
    confirming.value = false;
  }
}
</script>

<style scoped>
.fenced {
  max-width: 44rem;
  margin-bottom: 1.25rem;
}
.fenced-what {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  margin: 0 0 0.75rem;
}
.fenced h4 {
  margin: 1.25rem 0 0.25rem;
}
.fenced form {
  margin-top: 0.75rem;
}
.rejoin-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
</style>
