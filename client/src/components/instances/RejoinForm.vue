<!-- Join this instance to a controller as a member, from an instance that
     already holds data: the three fields naming the controller, the danger
     confirmation that says the data here is replaced, and the request. A
     replaced controller (FencedPanel.vue) and a member that lost its
     controller (Settings > Instances) both use it. The `lost` slot is one more
     paragraph of the confirmation, for what is not carried over. -->
<template>
  <form class="rejoin-form" @submit.prevent="ask">
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
    :header="header || `Join ${address.trim()} as a member?`"
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
    <slot name="lost" />
    <p>This instance restarts, and you sign in with an account from the new controller.</p>
  </ConfirmDialog>
</template>

<script setup>
import { ref } from 'vue';
import Button from '../../ui/Button.js';
import ConfirmDialog from '../ConfirmDialog.vue';
import JoinTargetFields from './JoinTargetFields.vue';
import api from '../../api/client.js';
import { useJoinTarget } from '../../composables/useJoinTarget.js';
import { apiError } from '../../utils/format.js';

defineProps({
  // The confirmation's header. Without one it names the address entered.
  header: { type: String, default: '' },
});
// The rejoin was accepted and this instance is restarting as a member; the
// argument is the controller's name when the answer gives one, else null.
const emit = defineEmits(['rejoined']);

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
    emit('rejoined', data?.controller?.name || null);
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
.rejoin-form {
  margin-top: 0.75rem;
}
.rejoin-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
</style>
