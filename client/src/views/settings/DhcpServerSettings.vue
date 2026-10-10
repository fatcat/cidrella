<!-- Which server hands out addresses, and the switch to the other one with its
     leases (server/src/services/dhcp-backend-switch.js). dnsmasq keeps DNS and
     the IPv6 Router Advertisements whichever server serves DHCP. -->
<template>
  <div class="content-card">
    <div class="setting-group">
      <h3>DHCP server</h3>
      <p class="field-help">
        The server that hands out addresses. dnsmasq answers DNS and sends the IPv6 Router
        Advertisements whichever one serves DHCP.
      </p>

      <div v-if="state === null" class="muted">Loading</div>
      <template v-else>
        <p class="server-now" data-track="dhcp-server-current">
          <StatusBadge kind="ok" :label="`${state.label} serves DHCP`" />
        </p>

        <section
          v-for="target in state.targets"
          :key="target.name"
          class="switch-target"
          :data-target="target.name"
        >
          <h4>Switch to {{ target.label }}</h4>
          <p v-if="target.blocked" class="muted" data-track="dhcp-server-blocked">
            {{ target.blocked }}
          </p>
          <template v-else>
            <p v-if="target.gained.length" class="change">
              <span class="change-label">Adds</span>
              {{ featureList(target.gained) }}
            </p>
            <p v-if="target.lost.length" class="change">
              <span class="change-label">Loses</span>
              {{ featureList(target.lost) }}
            </p>
            <p class="field-help">
              Every lease moves to {{ target.label }}, IPv4 and IPv6, and clients keep their
              addresses. DHCP stops for a few seconds while they move, and the DNS server restarts
              once, so lookups pause briefly. If {{ target.label }} does not start,
              {{ state.label }} takes DHCP back.
            </p>
          </template>
          <Button
            :label="`Switch to ${target.label}`"
            icon="pi pi-arrow-right-arrow-left"
            :disabled="!auth.isAdmin || Boolean(target.blocked) || state.switching"
            data-track="dhcp-server-switch"
            @click="confirming = target"
          />
        </section>
        <p v-if="!auth.isAdmin" class="field-help muted">Only an administrator can switch.</p>

        <div v-if="outcome" class="outcome" data-track="dhcp-server-outcome">
          <p>{{ outcome.summary }}</p>
          <p v-if="outcome.failed.length" class="field-error">
            {{ outcome.to }} refused {{ outcome.failed.length }} lease(s):
            {{ outcome.failed.map((f) => `${f.ip} (${f.error})`).join(', ') }}
          </p>
          <p v-if="outcome.missing.length" class="field-error">
            {{ outcome.to }} took but does not show {{ outcome.missing.length }} lease(s):
            {{ outcome.missing.join(', ') }}
          </p>
          <p v-if="outcome.failed.length || outcome.missing.length" class="field-help">
            Every lease that moved is kept in {{ outcome.snapshot }}.
          </p>
        </div>
      </template>
    </div>

    <ConfirmDialog
      :visible="confirming !== null"
      :header="`Switch DHCP to ${confirming?.label}?`"
      confirm-label="Switch"
      confirm-icon="pi pi-arrow-right-arrow-left"
      severity="warn"
      width="30rem"
      :loading="switching"
      confirm-track="dhcp-server-switch-confirm"
      cancel-track="dhcp-server-switch-cancel"
      @update:visible="(v) => !v && !switching && (confirming = null)"
      @confirm="runSwitch"
    >
      <p>
        {{ state?.label }} stops answering DHCP, its leases move to {{ confirming?.label }}, and
        {{ confirming?.label }} starts answering. DNS lookups pause while the DNS server restarts.
      </p>
      <p v-if="switching" class="muted">Moving the leases. This can take up to a minute.</p>
    </ConfirmDialog>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import Button from '../../ui/Button.js';
import ConfirmDialog from '../../components/ConfirmDialog.vue';
import StatusBadge from '../../components/StatusBadge.vue';
import api from '../../api/client.js';
import { useToast } from '../../ui/useToast.js';
import { useAuthStore } from '../../stores/auth.js';
import { useFeatures } from '../../composables/useFeatures.js';
import { apiError } from '../../utils/format.js';

const auth = useAuthStore();
const toast = useToast();
const features = useFeatures();

const state = ref(null);
const confirming = ref(null);
const switching = ref(false);
const outcome = ref(null);

const featureList = (list) => list.map((f) => f.label).join(', ');

async function load() {
  try {
    state.value = (await api.get('/dhcp/server')).data;
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  }
}

onMounted(load);

async function runSwitch() {
  const target = confirming.value;
  switching.value = true;
  outcome.value = null;
  try {
    const { data } = await api.post('/dhcp/server', { target: target.name });
    outcome.value = {
      ...data,
      to: target.label,
      summary: `${target.label} serves DHCP. ${data.added} of ${data.leases} lease(s) moved.`,
    };
    toast.add({
      severity: data.failed.length || data.missing.length ? 'warn' : 'success',
      summary: `${target.label} serves DHCP`,
      detail: outcome.value.summary,
      life: 6000,
    });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Switch stopped', detail: apiError(err), life: 10000 });
  } finally {
    switching.value = false;
    confirming.value = null;
    // What the API allows, and what the header chips show, follow the server.
    await Promise.all([load(), features.reload()]);
  }
}
</script>

<style scoped>
.server-now {
  margin: 0.5rem 0 1rem;
}
.switch-target {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.5rem;
  max-width: 44rem;
}
.switch-target h4,
.switch-target p {
  margin: 0;
}
.change-label {
  font-weight: 600;
  margin-right: 0.35rem;
}
.outcome {
  margin-top: 1rem;
}
</style>
