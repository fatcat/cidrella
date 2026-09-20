<template>
  <section class="fr-screen" data-track="first-run-step-deployment">
    <div>
      <div class="fr-eyebrow">Step 3 of 5</div>
      <h1>What should this appliance do?</h1>
      <p class="fr-lede">
        DHCP is off until a role that serves it is chosen and applied at the last step. Choose the
        role first, then which interfaces it applies to.
      </p>
    </div>

    <div class="fr-cards" role="group" aria-label="Role">
      <button
        v-for="r in ROLES"
        :key="r.id"
        type="button"
        class="fr-card"
        :aria-pressed="draft.role === r.id"
        :data-track="`first-run-role-${r.id}`"
        @click="draft.role = r.id"
      >
        <span class="fr-card-title">{{ r.title }}</span>
        <span class="fr-card-desc">{{ r.desc }}</span>
        <span class="fr-card-note"
          ><b>{{ r.noteLead }}</b> {{ r.note }}</span
        >
      </button>
    </div>

    <div v-if="loading" class="fr-note">
      <i class="pi pi-spinner pi-spin"></i> Reading interfaces
    </div>
    <div v-else-if="draft.interfaces.length === 0" class="fr-note warn">
      No network interfaces found. The role is saved; interfaces can be set later under Settings
      &gt; General &gt; Interfaces.
    </div>
    <table v-else class="fr-table">
      <thead>
        <tr>
          <th>Interface</th>
          <th>Address</th>
          <th class="c">DNS</th>
          <th class="c">DHCP</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="iface in draft.interfaces" :key="iface.name">
          <td>
            <span class="fr-mono">{{ iface.name }}</span>
            <Tag v-if="iface.state === 'down'" value="down" severity="warn" class="fr-badge" />
          </td>
          <td class="fr-mono">
            <template v-if="iface.addresses?.length">
              <div v-for="addr in iface.addresses" :key="addr.address">{{ addr.address }}</div>
            </template>
            <span v-else class="muted">no address</span>
          </td>
          <td class="c">
            <ToggleSwitch
              v-model="iface.dns"
              :disabled="draft.role === 'dhcp'"
              :aria-label="`DNS on ${iface.name}`"
              data-track="first-run-iface-dns"
            />
          </td>
          <td class="c">
            <ToggleSwitch
              v-model="iface.dhcp"
              :disabled="draft.role === 'dns'"
              :aria-label="`DHCP on ${iface.name}`"
              data-track="first-run-iface-dhcp"
            />
          </td>
        </tr>
      </tbody>
    </table>

    <div class="fr-note" :class="{ warn: draft.role !== 'both' }">{{ roleNote }}</div>
    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

    <div class="fr-actions">
      <Button label="Back" severity="secondary" data-track="first-run-back" @click="emit('back')" />
      <span class="spacer"></span>
      <span v-if="!selectionOk" class="fr-help">Pick at least one interface for the role.</span>
      <Button
        label="Continue"
        :disabled="!selectionOk"
        :loading="saving"
        data-track="first-run-deployment-continue"
        @click="submit"
      />
    </div>
  </section>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import Button from '../../ui/Button.js';
import Message from '../../ui/Message.js';
import Tag from '../../ui/Tag.js';
import ToggleSwitch from '../../ui/ToggleSwitch.js';
import api from '../../api/client.js';
import { useSetupStore } from '../../stores/setup.js';
import { apiError } from '../../utils/format.js';

const emit = defineEmits(['next', 'back']);
const setup = useSetupStore();
const draft = setup.draft;

const ROLES = [
  {
    id: 'both',
    title: 'DNS & DHCP',
    desc: 'Resolver, blocklists and address leasing for the LAN, with IPAM driven by both.',
    noteLead: 'Leases start',
    note: 'once you create a network with a scope.',
  },
  {
    id: 'dns',
    title: 'DNS only',
    desc: 'Resolver and blocklists. Another server keeps handing out addresses.',
    noteLead: 'DHCP stays off',
    note: 'on every interface until you turn it on.',
  },
  {
    id: 'dhcp',
    title: 'DHCP only',
    desc: 'Address leasing and IPAM. Clients keep using their current resolver.',
    noteLead: 'Port 53 stays closed,',
    note: 'so nothing on the LAN changes its DNS.',
  },
];
const ROLE_NOTE = {
  both: 'dnsmasq will answer DNS and DHCP on the interfaces ticked above. DHCP answers nothing until a network with a scope exists.',
  dns: 'DHCP is switched off globally. The DHCP column is locked; it can be enabled per interface later from Settings > General > Interfaces.',
  dhcp: 'DNS is switched off globally, so port 53 stays closed. Clients keep whatever resolver they have now.',
};

const loading = ref(false);
const saving = ref(false);
const error = ref('');

const roleNote = computed(() => ROLE_NOTE[draft.role]);
// An interface count of zero is allowed through (the role still gets saved);
// with interfaces present the role needs at least one to apply to.
const selectionOk = computed(
  () => draft.interfaces.length === 0 || Object.keys(setup.interfaceConfig).length > 0,
);

onMounted(async () => {
  if (draft.interfaces.length > 0) return;
  loading.value = true;
  try {
    const res = await api.get('/interfaces');
    // Default: every interface that is up with an address serves both. The
    // saved choice from an earlier visit wins over that default.
    draft.interfaces = res.data.map((iface) => {
      const usable = iface.state !== 'down' && (iface.addresses?.length ?? 0) > 0;
      return { ...iface, dns: usable, dhcp: usable };
    });
    setup.applyInterfaceState(setup.state.deployment?.interfaces);
  } catch (err) {
    error.value = apiError(err);
  } finally {
    loading.value = false;
  }
});

async function submit() {
  if (!selectionOk.value || saving.value) return;
  saving.value = true;
  error.value = '';
  try {
    await setup.mark({ deployment: { role: draft.role, interfaces: setup.interfaceConfig } });
    emit('next');
  } catch (err) {
    error.value = apiError(err);
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.fr-badge {
  margin-left: 0.4rem;
  font-size: 0.7rem;
}
</style>
