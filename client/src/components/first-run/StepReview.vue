<template>
  <section class="fr-screen" data-track="first-run-step-review">
    <div>
      <div class="fr-eyebrow">Step 5 of 5</div>
      <h1>{{ restore ? 'Ready to restore' : 'Ready to start' }}</h1>
      <p class="fr-lede">
        <template v-if="restore">
          Restoring replaces this appliance with the backup and restarts the service. Sign in
          afterwards with the backup's own admin password.
        </template>
        <template v-else>
          Nothing has been applied yet except the password. Starting writes the deployment below and
          opens the workspace.
        </template>
      </p>
    </div>

    <dl class="fr-summary">
      <dt>Admin</dt>
      <dd>{{ auth.user?.username }}, password set</dd>
      <dt>Two-factor</dt>
      <dd>{{ auth.totpEnabled ? 'on, authenticator app with backup codes' : 'off' }}</dd>
      <dt>Role</dt>
      <dd>{{ ROLE_LABEL[draft.role] }}</dd>
      <dt>DNS on</dt>
      <dd>{{ draft.role === 'dhcp' ? 'off' : listFor('dns') }}</dd>
      <dt>DHCP on</dt>
      <dd>{{ draft.role === 'dns' ? 'off' : listFor('dhcp') }}</dd>
      <dt>Upstream DNS</dt>
      <dd>Defaults, change under Settings &gt; DNS</dd>
      <dt>Import</dt>
      <dd>{{ importLine }}</dd>
    </dl>

    <div v-if="!restore">
      <div class="fr-eyebrow fr-next-head">What happens next</div>
      <div class="fr-next">
        <div v-for="n in nextSteps" :key="n.title">
          <b>{{ n.title }}</b>
          <span>{{ n.text }}</span>
        </div>
      </div>
    </div>

    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
    <div v-if="starting" class="fr-progress" aria-live="polite">
      <i class="pi pi-spinner pi-spin"></i>
      <span>{{ progress }}</span>
    </div>
    <div v-if="restarting" class="fr-note ok">
      <span>
        The backup is in place and the service is restarting. You will be sent to the sign-in page
        when it is back.
      </span>
    </div>

    <div class="fr-actions">
      <Button
        label="Back"
        severity="secondary"
        :disabled="starting"
        data-track="first-run-back"
        @click="emit('back')"
      />
      <span class="spacer"></span>
      <Button
        :label="restore ? 'Restore and restart' : 'Start CIDRella'"
        :severity="restore ? 'danger' : undefined"
        :loading="starting"
        :disabled="starting"
        data-track="first-run-start"
        @click="emit('start')"
      />
    </div>
  </section>
</template>

<script setup>
import { computed } from 'vue';
import Button from '../../ui/Button.js';
import Message from '../../ui/Message.js';
import { useAuthStore } from '../../stores/auth.js';
import { useSetupStore } from '../../stores/setup.js';

defineProps({
  starting: { type: Boolean, default: false },
  restarting: { type: Boolean, default: false },
  progress: { type: String, default: '' },
  error: { type: String, default: '' },
});
const emit = defineEmits(['back', 'start']);

const auth = useAuthStore();
const setup = useSetupStore();
const draft = setup.draft;

const ROLE_LABEL = { both: 'DNS & DHCP', dns: 'DNS only', dhcp: 'DHCP only' };

const restore = computed(() => draft.importKind === 'cidrella');

function listFor(svc) {
  const names = Object.entries(setup.interfaceConfig)
    .filter(([, cfg]) => cfg[svc])
    .map(([name]) => name);
  return names.length ? names.join(', ') : 'no interface selected';
}

const importLine = computed(() => {
  if (draft.importKind === 'pihole') {
    return `Pi-hole into ${draft.network.cidr} with domain ${draft.network.domain}`;
  }
  if (draft.importKind === 'cidrella') return `CIDRella backup ${draft.restoreFile?.name || ''}`;
  return 'none, start fresh';
});

// First DNS interface's IPv4 address, for the "point clients here" hint.
const resolverIp = computed(() => {
  for (const iface of draft.interfaces) {
    if (!setup.interfaceConfig[iface.name]?.dns) continue;
    const v4 = iface.addresses?.find((a) => /^\d+\.\d+\.\d+\.\d+/.test(a.address));
    if (v4) return v4.address.split('/')[0];
  }
  return 'this appliance';
});

const nextSteps = computed(() => {
  const out = [];
  if (draft.importKind === 'pihole') {
    out.push({
      title: 'Import runs first',
      text: `Records land in ${draft.network.domain}, reservations in ${draft.network.cidr}.`,
    });
  } else {
    out.push({
      title: 'Create your first network',
      text:
        draft.role === 'dns'
          ? 'A CIDR and a domain. Reverse DNS comes with it.'
          : 'A CIDR, gateway and a DHCP scope. Leases begin once it is saved.',
    });
  }
  if (draft.role !== 'dhcp') {
    out.push({
      title: 'Point clients at it',
      text: `Set ${resolverIp.value} as the resolver in your router or DHCP options.`,
    });
  }
  if (draft.role !== 'dns') {
    out.push({
      title: 'Retire the old DHCP server',
      text: 'Two servers on one LAN fight. Rogue detection will tell you if one is still there.',
    });
  }
  return out;
});
</script>

<style scoped>
.fr-next-head {
  margin-bottom: 8px;
}
</style>
