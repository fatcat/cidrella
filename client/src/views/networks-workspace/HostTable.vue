<template>
  <div class="table-scroll workspace-table" data-track="workspace-hosts">
    <table>
      <thead>
        <tr>
          <th class="expand-cell"><span class="sr-only">Expand</span></th>
          <th data-column="host">Host</th>
          <th data-column="identity">MAC or DUID</th>
          <th data-column="vendor">Vendor</th>
          <th data-column="device">Device</th>
          <th data-column="addresses">Addresses</th>
          <th data-column="last_seen">Last seen</th>
          <th data-column="online">Online</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="host in hosts" :key="host.key">
          <tr
            :data-row-id="`host:${host.key}`"
            :class="{ selected: holds(host, selectedAddress) }"
            tabindex="0"
            @click="toggle(host)"
            @keydown.enter.prevent="toggle(host)"
            @keydown.space.prevent="toggle(host)"
          >
            <td class="expand-cell">
              <button
                class="expand-button"
                :aria-expanded="isOpen(host)"
                :aria-label="`${isOpen(host) ? 'Collapse' : 'Expand'} ${hostLabel(host)}`"
                data-track="workspace-host-expand"
                @click.stop="toggle(host)"
              >
                <i :class="isOpen(host) ? 'pi pi-chevron-down' : 'pi pi-chevron-right'" />
              </button>
            </td>
            <td>
              <strong class="host-name">{{ hostLabel(host) }}</strong>
              <small
                v-if="host.hostnames.length > 1"
                class="muted"
                :title="host.hostnames.join(', ')"
              >
                +{{ host.hostnames.length - 1 }} more names
              </small>
            </td>
            <td class="mono" :class="{ muted: !host.mac && !host.duid }">
              {{ host.mac || host.duid || EMPTY_CELL }}
            </td>
            <td :class="{ muted: !host.vendor }">{{ host.vendor || EMPTY_CELL }}</td>
            <td :class="{ muted: !deviceLabel(host) }">{{ deviceLabel(host) || EMPTY_CELL }}</td>
            <td>
              <span class="mono">{{ stableLine(host) }}</span>
              <small v-if="host.other_count" class="muted"> · {{ host.other_count }} other</small>
            </td>
            <td :class="{ muted: !host.last_seen_at }">
              {{ formatTimestamp(host.last_seen_at) || EMPTY_CELL }}
            </td>
            <td>
              <StatusDot
                :kind="host.online ? 'ok' : 'muted'"
                :label="host.online ? 'Online' : 'Offline'"
                show-label
              />
            </td>
          </tr>
          <tr v-if="isOpen(host)" class="host-addresses">
            <td />
            <td colspan="7">
              <ul>
                <li v-for="address in shownAddresses(host)" :key="identity(address)">
                  <button
                    class="address-button"
                    :class="{ selected: identity(address) === selectedAddress }"
                    data-track="workspace-host-address"
                    :data-address="identity(address)"
                    @click.stop="emit('open-address', identity(address))"
                  >
                    <span class="mono">{{ identity(address) }}</span>
                    <AddressTypePill v-if="typeDisplay(address)" :display="typeDisplay(address)" />
                    <small class="muted">{{ KIND_LABELS[address.kind] || address.kind }}</small>
                  </button>
                </li>
              </ul>
              <button
                v-if="temporaries(host).length"
                class="temporaries-button"
                :aria-expanded="showingTemporaries(host)"
                data-track="workspace-host-temporaries"
                @click.stop="toggleTemporaries(host)"
              >
                {{ showingTemporaries(host) ? 'Hide' : 'Show' }}
                {{ temporaries(host).length }} temporary
                {{ temporaries(host).length === 1 ? 'address' : 'addresses' }}
              </button>
              <div v-if="host.other_family?.length" class="other-family">
                <span class="muted">{{ otherFamilyLabel(host) }}</span>
                <span
                  v-for="other in host.other_family"
                  :key="`${other.subnet_id}|${other.ip_address}`"
                  class="mono"
                >
                  {{ other.ip_address
                  }}<small v-if="other.cidr" class="muted"> in {{ other.cidr }}</small>
                </span>
              </div>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
    <EmptyState
      v-if="!hosts.length"
      icon="pi-desktop"
      title="No hosts"
      description="Nothing in this network has been seen or claimed yet, or the search matches no host."
    />
  </div>
</template>

<script setup>
// The Hosts view of a network's Addresses tab (docs/IPV6-HANDLING.md rule 5):
// one row per device, its addresses under it. The server groups them
// (GET /subnets/:id/hosts); this only shows the page it is given. Clicking
// an address opens the address details panel as the Addresses table does.
import { ref } from 'vue';
import AddressTypePill from '../../components/table/AddressTypePill.vue';
import EmptyState from '../../components/EmptyState.vue';
import StatusDot from '../../components/StatusDot.vue';
import { EMPTY_CELL } from '../../utils/format.js';
import { ipLifecycleDisplay } from '../../utils/ipLifecycleDisplay.js';
import { formatTimestamp } from '../networks-workspace-data.js';
import './workspace-table.css';

const props = defineProps({
  hosts: { type: Array, required: true },
  // The address open in the details panel ('fe80::1%eth0' for link-local).
  selectedAddress: { type: String, default: null },
});
const emit = defineEmits(['open-address']);

const KIND_LABELS = {
  'link-local': 'link-local',
  reservation: 'reservation',
  static: 'static',
  dhcp: 'DHCP lease',
  eui64: 'EUI-64',
  slaac: 'SLAAC',
  temporary: 'temporary',
  other: 'other',
};

const open = ref(new Set());
const temporariesOpen = ref(new Set());

const identity = (address) =>
  address.interface_id ? `${address.ip_address}%${address.interface_id}` : address.ip_address;
const holds = (host, address) => !!address && host.addresses.some((a) => identity(a) === address);
const isOpen = (host) => open.value.has(host.key) || holds(host, props.selectedAddress);
const showingTemporaries = (host) => temporariesOpen.value.has(host.key);
const temporaries = (host) => host.addresses.filter((a) => a.kind === 'temporary');

function flip(set, key) {
  const next = new Set(set.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  set.value = next;
}
function toggle(host) {
  flip(open, host.key);
}
function toggleTemporaries(host) {
  flip(temporariesOpen, host.key);
}

// Temporaries last, and only once asked for.
function shownAddresses(host) {
  const kept = host.addresses.filter((a) => a.kind !== 'temporary');
  return showingTemporaries(host) ? [...kept, ...temporaries(host)] : kept;
}

function hostLabel(host) {
  return host.name || host.addresses[0]?.ip_address || host.key;
}
function deviceLabel(host) {
  return [host.device_type, host.os_family].filter(Boolean).join(' · ');
}
function stableLine(host) {
  const stable = host.addresses.filter((a) =>
    ['link-local', 'reservation', 'static', 'dhcp', 'eui64'].includes(a.kind),
  );
  const shown = (stable.length ? stable : host.addresses).filter((a) => a.kind !== 'link-local');
  const first = (shown[0] || host.addresses[0])?.ip_address || EMPTY_CELL;
  return shown.length > 1 ? `${first} +${shown.length - 1}` : first;
}
function otherFamilyLabel(host) {
  return host.addresses[0]?.ip_address?.includes(':') ? 'IPv4' : 'IPv6';
}
function typeDisplay(address) {
  return ipLifecycleDisplay({ address_type: address.address_type || null }).addressType;
}
</script>

<style scoped>
button {
  font: inherit;
  color: inherit;
}
.expand-cell {
  width: 1.6rem;
  padding-right: 0;
}
.expand-button {
  display: inline-flex;
  width: 1.3rem;
  height: 1.3rem;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--preview-muted);
  cursor: pointer;
}
.expand-button i {
  font-size: 0.6rem;
}
.host-name {
  font-weight: 650;
}
tr.host-addresses {
  cursor: default;
}
tr.host-addresses:hover {
  background: none;
}
tr.host-addresses td {
  height: auto;
  padding-block: 0.35rem 0.55rem;
  white-space: normal;
}
.host-addresses ul {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
.address-button {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.18rem 0.4rem;
  border: 1px solid transparent;
  border-radius: 5px;
  background: none;
  cursor: pointer;
}
.address-button:hover {
  background: var(--preview-accent-soft);
}
.address-button.selected {
  border-color: var(--preview-accent);
  background: var(--preview-accent-soft);
}
.temporaries-button {
  margin-top: 0.25rem;
  padding: 0.1rem 0.4rem;
  border: 0;
  background: none;
  color: var(--preview-accent);
  cursor: pointer;
}
.other-family {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
  margin-top: 0.35rem;
  padding-left: 0.4rem;
}
</style>
