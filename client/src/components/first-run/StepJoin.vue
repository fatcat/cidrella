<!-- Join an existing CIDRella: pair this box with a controller and make it a
     member. The controller's data and accounts replace this box's, so a
     success ends the session and goes to the sign-in page. -->
<template>
  <section class="fr-screen" data-track="first-run-step-join">
    <div>
      <StepEyebrow />
      <h1>Join an existing CIDRella</h1>
      <p class="fr-lede">
        This box becomes a member of the controller named here. Make a join token on the controller
        under Settings &gt; Instances &gt; Add member. A token works once and lasts 15 minutes.
      </p>
    </div>

    <form id="first-run-join" @submit.prevent="submit">
      <JoinTargetFields
        v-model:address="address"
        v-model:port="port"
        v-model:token="token"
        id-prefix="fr-join"
        track="first-run-join"
        :disabled="joining"
        first-run
      />
    </form>

    <div class="fr-note warn">
      <StatusDot kind="warn" label="Warning" class="fr-note-mark" />
      <span>
        Joining replaces everything on this box with the controller's data: networks, DNS, DHCP,
        settings and every account, the one you are signed in with included. Afterwards you sign in
        with an account from the controller.
      </span>
    </div>
    <label class="fr-join-confirm">
      <Checkbox
        v-model="understood"
        binary
        input-id="fr-join-understood"
        :disabled="joining"
        data-track="first-run-join-understood"
      />
      <span>Replace everything on this box with the controller's data.</span>
    </label>

    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

    <div class="fr-actions">
      <Button
        label="Back"
        severity="secondary"
        :disabled="joining"
        data-track="first-run-join-back"
        @click="emit('back')"
      />
      <span class="spacer"></span>
      <span v-if="blocker" class="fr-help">{{ blocker }}</span>
      <Button
        type="submit"
        form="first-run-join"
        label="Join"
        :disabled="!!blocker"
        :loading="joining"
        data-track="first-run-join-submit"
      />
    </div>
  </section>
</template>

<script setup>
import StepEyebrow from './StepEyebrow.vue';
import { computed, ref } from 'vue';
import Button from '../../ui/Button.js';
import Checkbox from '../../ui/Checkbox.js';
import Message from '../../ui/Message.js';
import StatusDot from '../StatusDot.vue';
import JoinTargetFields from '../instances/JoinTargetFields.vue';
import api from '../../api/client.js';
import { useJoinTarget } from '../../composables/useJoinTarget.js';
import { useSignInAgain } from '../../composables/useSignInAgain.js';
import { useSetupStore } from '../../stores/setup.js';
import { apiError } from '../../utils/format.js';

const emit = defineEmits(['back']);
const setup = useSetupStore();
const signInAgain = useSignInAgain();

const { address, port, token, blocker: targetBlocker, body } = useJoinTarget();
const understood = ref(false);
const joining = ref(false);
const error = ref('');

const blocker = computed(() => {
  if (targetBlocker.value) return targetBlocker.value;
  if (!understood.value) return 'Confirm that this box is replaced.';
  return '';
});

async function submit() {
  if (blocker.value || joining.value) return;
  joining.value = true;
  error.value = '';
  try {
    const { data } = await api.post('/setup/join', body());
    // The controller's accounts replaced this box's, so the session here
    // speaks for an account that is gone. The sign-in page says what happened.
    setup.reset();
    await signInAgain('joined', data?.controller?.name || null);
  } catch (err) {
    error.value = apiError(err);
  } finally {
    joining.value = false;
  }
}
</script>

<style scoped>
.fr-join-confirm {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 0.9rem;
}
</style>
