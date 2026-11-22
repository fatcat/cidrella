<!-- A controller that was replaced: another instance was made the controller
     while this one was away. It takes no changes now. Here an admin downloads
     the report of the changes the new controller never received, and rejoins
     this instance to the new controller as a member with a join token
     (RejoinForm.vue). When the instance that replaced it is gone, it can take
     the controller back instead. -->
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
    <RejoinForm
      :header="fenced.by_name ? `Rejoin as a member of ${fenced.by_name}?` : 'Rejoin as a member?'"
      @rejoined="(name) => emit('rejoined', name || fenced.by_name || null)"
    >
      <template #lost>
        <p>
          Changes made here that the new controller never received are not carried over.
          <template v-if="fenced.report">Download the report first if you need them.</template>
        </p>
      </template>
    </RejoinForm>

    <h4>No other controller?</h4>
    <p class="field-help">
      If the instance that replaced this one is gone, this instance can take the controller back.
    </p>
    <Button
      label="Take the controller back"
      severity="danger"
      outlined
      size="small"
      :loading="takingBack"
      data-track="instances-take-back"
      @click="askTakeBack"
    />
    <p v-if="takeBackError" class="field-error" data-track="instances-take-back-error">
      {{ takeBackError }}
    </p>

    <ConfirmDialog
      :visible="confirmingTakeBack"
      header="Take the controller back?"
      confirm-label="Take the controller back"
      width="36rem"
      :type-to-confirm="selfName"
      :loading="takingBack"
      data-track="instances-take-back-dialog"
      confirm-track="instances-take-back-confirm"
      cancel-track="instances-take-back-cancel"
      @update:visible="(v) => !v && !takingBack && (confirmingTakeBack = false)"
      @confirm="takeBack"
    >
      <p>Do this only when no other instance is the controller.</p>
      <p v-if="lossText">{{ lossText }}</p>
      <p>The other members follow this instance within about a minute.</p>
      <p>This instance restarts, and you sign in again.</p>
    </ConfirmDialog>
  </section>
</template>

<script setup>
import { computed, ref } from 'vue';
import Button from '../../ui/Button.js';
import ConfirmDialog from '../ConfirmDialog.vue';
import StatusDot from '../StatusDot.vue';
import RejoinForm from './RejoinForm.vue';
import api from '../../api/client.js';
import { useToast } from '../../ui/useToast.js';
import { saveBlob } from '../../utils/download.js';
import { apiError } from '../../utils/format.js';
import { fencedText, takeBackLossText } from '../../utils/instances.js';

const props = defineProps({
  // `promotion.fenced` of GET /api/instances:
  // { by_name, told_by, epoch, since, report }.
  fenced: { type: Object, required: true },
  // This instance's own name, typed to confirm taking the controller back.
  selfName: { type: String, default: 'this instance' },
});
// `rejoined`: the rejoin was accepted and this instance is restarting as a
// member of the named controller. `took-back`: it is restarting as the
// controller again. The page waits for the restart either way.
const emit = defineEmits(['rejoined', 'took-back']);
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

// Take the controller back: only the server knows whether another controller
// answers, and it refuses when one does.
const lossText = computed(() => takeBackLossText(props.fenced));
const confirmingTakeBack = ref(false);
const takingBack = ref(false);
const takeBackError = ref('');

function askTakeBack() {
  takeBackError.value = '';
  confirmingTakeBack.value = true;
}

async function takeBack() {
  takingBack.value = true;
  try {
    await api.post('/instances/promote-self', { confirm: true });
    emit('took-back');
  } catch (err) {
    // The refusal stays under the button, as the rejoin's does by its form.
    takeBackError.value = apiError(err);
  } finally {
    takingBack.value = false;
    confirmingTakeBack.value = false;
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
</style>
