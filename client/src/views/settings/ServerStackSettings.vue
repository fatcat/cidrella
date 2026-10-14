<!-- Which servers answer DNS and DHCP: dnsmasq for both, or PowerDNS with Kea
     (and radvd for the IPv6 Router Advertisements). The switch moves every
     role and the leases (server/src/services/stack-switch.js). -->
<template>
  <div class="content-card">
    <div class="setting-group">
      <h3>Servers</h3>
      <p class="field-help">
        The servers that answer DNS and hand out addresses. Both choices serve the same networks,
        zones and scopes; they differ in the features each supports.
      </p>

      <div v-if="state === null" class="muted">Loading</div>
      <template v-else>
        <div class="stacks">
          <section
            v-for="stack in state.stacks"
            :key="stack.name"
            class="stack"
            :class="{ current: stack.name === state.current }"
            :data-stack="stack.name"
            data-track="server-stack-card"
          >
            <h4>{{ stack.label }}</h4>
            <p v-if="stack.daemons.join(', ') !== stack.label" class="muted text-sm">
              {{ stack.daemons.join(', ') }}
            </p>
            <StatusBadge v-if="stack.name === state.current" kind="ok" label="Serving now" />
            <StatusBadge v-else-if="!stack.installed.ok" kind="warn" label="Not installed" />
            <p v-if="stack.name !== state.current && !stack.installed.ok" class="field-help">
              {{ stack.installed.reason }}
            </p>
          </section>
        </div>

        <section
          v-for="target in state.targets"
          :key="target.name"
          class="switch-target"
          :data-target="target.name"
        >
          <h4>Switch to {{ target.label }}</h4>
          <p v-if="target.blocked" class="field-help" data-track="server-stack-blocked">
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
              addresses. DNS and DHCP stop for a few seconds while the servers change over. If
              {{ target.label }} does not come up, {{ state.label }} takes over again.
            </p>
          </template>
          <Button
            :label="`Switch to ${target.label}`"
            icon="pi pi-arrow-right-arrow-left"
            :disabled="!auth.isAdmin || Boolean(target.blocked) || state.switching"
            data-track="server-stack-switch"
            @click="confirming = target"
          />
        </section>
        <p v-if="!auth.isAdmin" class="field-help muted">Only an administrator can switch.</p>

        <div v-if="outcome" class="outcome" data-track="server-stack-outcome">
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
      :header="`Switch to ${confirming?.label}?`"
      confirm-label="Switch"
      confirm-icon="pi pi-arrow-right-arrow-left"
      severity="warn"
      width="30rem"
      :loading="switching"
      confirm-track="server-stack-switch-confirm"
      cancel-track="server-stack-switch-cancel"
      @update:visible="(v) => !v && !switching && (confirming = null)"
      @confirm="runSwitch"
    >
      <p>
        {{ state?.label }} stops, its leases move to {{ confirming?.label }}, and
        {{ confirming?.label }} starts answering DNS and DHCP. Lookups and new leases pause for a
        few seconds.
      </p>
      <p v-if="switching" class="muted">Switching. This can take up to a minute.</p>
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
    state.value = (await api.get('/backend-stack')).data;
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
    const { data } = await api.post('/backend-stack', { stack: target.name });
    outcome.value = {
      ...data,
      to: target.label,
      summary: `${target.label} serves DNS and DHCP. ${data.added} of ${data.leases} lease(s) moved.`,
    };
    toast.add({
      severity: data.failed.length || data.missing.length ? 'warn' : 'success',
      summary: `${target.label} serves DNS and DHCP`,
      detail: outcome.value.summary,
      life: 6000,
    });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Switch stopped', detail: apiError(err), life: 10000 });
  } finally {
    switching.value = false;
    confirming.value = null;
    // What the API allows, and what the header chips show, follow the servers.
    await Promise.all([load(), features.reload()]);
  }
}
</script>

<style scoped>
.stacks {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
  gap: 0.75rem;
  max-width: 44rem;
  margin: 0.75rem 0 1.25rem;
}
.stack {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.35rem;
  padding: 0.75rem 1rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 6px;
}
.stack.current {
  outline: 1px solid var(--p-primary-color);
  background: color-mix(in srgb, var(--p-primary-color) 8%, transparent);
}
.stack h4,
.stack p {
  margin: 0;
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
