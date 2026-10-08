<template>
  <div class="resolver-picker" :data-track="`${track}`">
    <div class="enc-row">
      <label :for="`${idPrefix}-choice`">{{ label }}</label>
      <Select
        :modelValue="modelValue.choice"
        :options="options"
        optionLabel="label"
        optionValue="value"
        size="small"
        :inputId="`${idPrefix}-choice`"
        style="width: 22rem"
        :data-track="`${track}-choice`"
        @update:modelValue="(choice) => emitSelection({ choice })"
      />
    </div>

    <p v-if="preset" class="forwarder-hint resolver-addresses">
      {{ encrypted ? `${preset.hostname}: ` : '' }}{{ preset.addresses.join(', ') }}
    </p>

    <template v-else-if="modelValue.choice === CUSTOM">
      <!-- Plaintext: one row per address, each tested on entry -->
      <div v-if="!encrypted" class="forwarders-list">
        <div v-for="(server, i) in modelValue.custom.servers" :key="i" class="forwarder-entry">
          <StatusDot :kind="dotKind(server)" :label="dotLabel(server)" />
          <InputText
            :modelValue="server.ip"
            size="small"
            :placeholder="placeholder"
            :aria-label="`${label} address ${i + 1}`"
            style="width: 12rem"
            @update:modelValue="(ip) => setServer(i, { ip, status: null })"
            @blur="testServer(i)"
            @keyup.enter="testServer(i)"
          />
          <i v-if="server.status === 'testing'" class="pi pi-spin pi-spinner fwd-testing"></i>
          <Button
            v-if="modelValue.custom.servers.length > 1"
            icon="pi pi-trash"
            severity="danger"
            text
            rounded
            size="small"
            title="Remove"
            @click="removeServer(i)"
          />
        </div>
        <div class="forwarder-actions">
          <Button
            label="Add address"
            icon="pi pi-plus"
            size="small"
            severity="secondary"
            :data-track="`${track}-add-address`"
            @click="addServer"
          />
        </div>
      </div>

      <!-- Encrypted: the name on its certificate, where to connect, the DoH URL -->
      <template v-else>
        <div class="enc-row">
          <label :for="`${idPrefix}-hostname`">Hostname</label>
          <InputText
            :id="`${idPrefix}-hostname`"
            :modelValue="modelValue.custom.hostname"
            size="small"
            placeholder="dns.example.com"
            style="width: 22rem"
            @update:modelValue="(hostname) => emitCustom({ hostname })"
          />
        </div>
        <div class="enc-row">
          <label :for="`${idPrefix}-addresses`">Addresses</label>
          <InputText
            :id="`${idPrefix}-addresses`"
            :modelValue="modelValue.custom.addresses"
            size="small"
            placeholder="9.9.9.10, 149.112.112.10"
            style="width: 22rem"
            @update:modelValue="(addresses) => emitCustom({ addresses })"
          />
        </div>
        <div v-if="mode === 'https'" class="enc-row">
          <label :for="`${idPrefix}-doh`">DoH URL</label>
          <InputText
            :id="`${idPrefix}-doh`"
            :modelValue="modelValue.custom.doh_url"
            size="small"
            placeholder="https://dns.example.com/dns-query"
            style="width: 22rem"
            @update:modelValue="(doh_url) => emitCustom({ doh_url })"
          />
        </div>
      </template>
    </template>
  </div>
</template>

<script setup>
/**
 * One resolver choice on Settings > DNS: a preset, a custom resolver, or (for
 * the backup) none. Selections are described in utils/resolvers.js.
 */
import { computed, onMounted, onUnmounted } from 'vue';
import Button from '../../ui/Button.js';
import InputText from '../../ui/InputText.js';
import Select from '../../ui/Select.js';
import StatusDot from '../StatusDot.vue';
import { useDnsStore } from '../../stores/dns.js';
import { useFeatures } from '../../composables/useFeatures.js';
import { isValidIpv4, isValidIpv6 } from '../../utils/ip.js';
import { CUSTOM, NONE } from '../../utils/resolvers.js';
import './upstream-form.css';

const props = defineProps({
  modelValue: { type: Object, required: true },
  providers: { type: Array, required: true },
  mode: { type: String, required: true }, // 'off' | 'tls' | 'https'
  label: { type: String, required: true },
  idPrefix: { type: String, required: true },
  track: { type: String, required: true },
  allowNone: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue']);

const store = useDnsStore();
const { ipv6: ipv6Supported } = useFeatures();
const encrypted = computed(() => props.mode !== 'off');
const placeholder = computed(() =>
  ipv6Supported.value ? 'e.g. 8.8.8.8 or 2606:4700:4700::1111' : 'e.g. 8.8.8.8',
);

const options = computed(() => [
  ...(props.allowNone ? [{ label: 'None', value: NONE }] : []),
  ...props.providers.map((p) => ({ label: p.label, value: p.id })),
  { label: 'Custom…', value: CUSTOM },
]);
const preset = computed(() => props.providers.find((p) => p.id === props.modelValue.choice));

function emitSelection(patch) {
  emit('update:modelValue', { ...props.modelValue, ...patch });
}
function emitCustom(patch) {
  emitSelection({ custom: { ...props.modelValue.custom, ...patch } });
}

const servers = () => props.modelValue.custom.servers;
function setServer(i, server) {
  emitCustom({ servers: servers().map((s, j) => (j === i ? server : s)) });
}
function addServer() {
  emitCustom({ servers: [...servers(), { ip: '', status: null }] });
}
function removeServer(i) {
  emitCustom({ servers: servers().filter((_, j) => j !== i) });
}

function dotKind(server) {
  if (server.status === 'reachable') return 'ok';
  if (server.status === 'unreachable') return 'err';
  return 'muted';
}
function dotLabel(server) {
  if (server.status === 'reachable') return 'Reachable';
  if (server.status === 'unreachable') return 'Unreachable';
  return 'Not yet tested';
}

async function testServer(i) {
  const ip = servers()[i]?.ip.trim();
  // The shared predicates range-check; an IPv6 address counts only with the switch on.
  if (!ip || !(isValidIpv4(ip) || (ipv6Supported.value && isValidIpv6(ip)))) return;
  setServer(i, { ip, status: 'testing' });
  let status = 'unreachable';
  try {
    status = (await store.testForwarder(ip)).reachable ? 'reachable' : 'unreachable';
  } catch {
    /* unreachable */
  }
  // The row may have changed while the test ran.
  if (servers()[i]?.ip.trim() === ip) setServer(i, { ip, status });
}

async function testAll() {
  if (encrypted.value || props.modelValue.choice !== CUSTOM) return;
  for (let i = 0; i < servers().length; i++) await testServer(i);
}

// Custom plaintext addresses are tested on entry and every 15 minutes.
let pollTimer = null;
onMounted(() => {
  testAll();
  pollTimer = setInterval(testAll, 15 * 60 * 1000);
});
onUnmounted(() => clearInterval(pollTimer));
</script>

<style scoped>
.resolver-picker {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
/* Under the Select: the label column is 6rem plus the 0.75rem row gap. */
.resolver-addresses,
.forwarders-list {
  margin-left: 6.75rem;
}
.resolver-addresses {
  margin-top: 0;
}
</style>
