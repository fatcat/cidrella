<!-- Join an existing CIDRella: pair this box with a controller and make it a
     member. The controller's data and accounts replace this box's, so a
     success ends the session and goes to the sign-in page. -->
<template>
  <section class="fr-screen" data-track="first-run-step-join">
    <div>
      <div class="fr-eyebrow">Join</div>
      <h1>Join an existing CIDRella</h1>
      <p class="fr-lede">
        This box becomes a member of the controller named here. Make a join token on the controller
        under Settings &gt; Instances &gt; Add member. A token works once and lasts 15 minutes.
      </p>
    </div>

    <form id="first-run-join" @submit.prevent="submit">
      <div class="fr-field">
        <label for="fr-join-address">Controller address</label>
        <InputText
          id="fr-join-address"
          v-model="address"
          :disabled="joining"
          autocomplete="off"
          spellcheck="false"
          class="fr-mono"
        />
        <span class="fr-help">The name or IP address you open the controller at.</span>
      </div>
      <div class="fr-field fr-gap">
        <label for="fr-join-port">Port</label>
        <InputNumber
          v-model="port"
          input-id="fr-join-port"
          :min="1"
          :max="65535"
          :use-grouping="false"
          :disabled="joining"
        />
        <span class="fr-help">The controller's HTTPS port.</span>
      </div>
      <div class="fr-field fr-gap">
        <label for="fr-join-token">Join token</label>
        <InputText
          id="fr-join-token"
          v-model="token"
          :disabled="joining"
          autocomplete="off"
          spellcheck="false"
          class="fr-mono"
        />
      </div>
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
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import Button from '../../ui/Button.js';
import Checkbox from '../../ui/Checkbox.js';
import InputNumber from '../../ui/InputNumber.js';
import InputText from '../../ui/InputText.js';
import Message from '../../ui/Message.js';
import StatusDot from '../StatusDot.vue';
import api from '../../api/client.js';
import { useAuthStore } from '../../stores/auth.js';
import { useFeaturesStore } from '../../stores/features.js';
import { useSetupStore } from '../../stores/setup.js';
import { apiError } from '../../utils/format.js';

const emit = defineEmits(['back']);
const router = useRouter();
const auth = useAuthStore();
const features = useFeaturesStore();
const setup = useSetupStore();

const address = ref('');
const port = ref(443);
const token = ref('');
const understood = ref(false);
const joining = ref(false);
const error = ref('');

const portOk = computed(
  () => Number.isInteger(port.value) && port.value >= 1 && port.value <= 65535,
);
const blocker = computed(() => {
  if (!address.value.trim()) return "Enter the controller's address.";
  if (!portOk.value) return 'Enter a port from 1 to 65535.';
  if (!token.value.trim()) return 'Enter the join token.';
  if (!understood.value) return 'Confirm that this box is replaced.';
  return '';
});

async function submit() {
  if (blocker.value || joining.value) return;
  joining.value = true;
  error.value = '';
  try {
    const { data } = await api.post('/setup/join', {
      address: address.value.trim(),
      port: port.value,
      token: token.value.trim(),
    });
    // The controller's accounts replaced this box's, so the session here
    // speaks for an account that is gone. The sign-in page says what happened.
    auth.logout('joined', data?.controller?.name || null);
    features.reset();
    setup.reset();
    router.push({ name: 'Login' });
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
