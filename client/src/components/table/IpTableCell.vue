<template>
  <StatusText
    v-if="column.key === 'status' && row.ip_display_status"
    :label="lifecycle.status"
    :className="lifecycle.statusSeverity === 'danger' ? 'state-err' : 'state-muted'"
  />
  <AddressTypePill
    v-else-if="column.key === 'type'"
    :display="lifecycle.addressType"
    :tooltip="lifecycle.tooltip"
  />
  <OnlineStatusCell v-else-if="column.key === 'is_online'" :value="row.is_online" />
  <StatusText
    v-else-if="column.key === 'scanning_enabled' && row.scanning_enabled != null"
    :label="row.scanning_enabled ? 'Enabled' : 'Disabled'"
    :className="row.scanning_enabled ? 'state-ok' : 'state-muted'"
  />
  <StatusText
    v-else-if="column.key === 'enabled' && row.enabled != null"
    :label="row.enabled ? 'Yes' : 'No'"
    :className="row.enabled ? 'state-ok' : 'state-muted'"
  />
  <StatusText
    v-else-if="column.key === 'lease' && leaseDisplay"
    :label="leaseDisplay.label"
    :className="leaseDisplay.className"
  />
  <span v-else-if="column.key === 'record_type' && row.record_type" class="type-badge">{{ row.record_type }}</span>
  <span v-else-if="column.key === 'source' && source !== EMPTY_CELL" class="type-badge">{{ source }}</span>
  <code v-else-if="column.key === 'mac_address' && plainValue !== EMPTY_CELL">{{ plainValue }}</code>
  <span v-else :class="[{ 'cell-muted': muted }, { 'ip-mono': mono }]">{{ plainValue }}</span>
</template>

<script setup>
import { computed } from 'vue';
import AddressTypePill from './AddressTypePill.vue';
import OnlineStatusCell from './OnlineStatusCell.vue';
import StatusText from './StatusText.vue';
import {
  displayCell,
  displayExpiry,
  displayHostnameCell,
  displayMacAddress,
  EMPTY_CELL
} from '../../utils/format.js';
import { formatDateTime } from '../../utils/dateFormat.js';
import { ipLifecycleDisplay } from '../../utils/ipLifecycleDisplay.js';
import { dhcpLeaseDisplay, ipSourceLabel } from '../../utils/ipTableDisplay.js';
import { IP_TABLE_VIEW } from '../../utils/ipTableColumns.js';

const props = defineProps({
  column: { type: Object, required: true },
  row: { type: Object, required: true },
  view: { type: String, required: true },
  domainName: { type: String, default: null },
  zoneName: { type: String, default: null },
  soaMinimumTtl: { type: [Number, String], default: null }
});

const lifecycle = computed(() => ipLifecycleDisplay(props.row));
const leaseDisplay = computed(() => dhcpLeaseDisplay(props.row.lease_status));
const source = computed(() => ipSourceLabel(props.row));
const mono = computed(() =>
  ['ip_address', 'record_name'].includes(props.column.key)
  || (props.column.key === 'value' && ['A', 'AAAA'].includes(props.row.record_type))
);
const muted = computed(() =>
  plainValue.value === EMPTY_CELL
  || props.column.key === 'record_name'
  || (props.column.key === 'ttl' && props.row.ttl == null)
);

function dnsHostname() {
  if (props.view === IP_TABLE_VIEW.DNS_REVERSE) return displayCell(props.row.value);
  if (!props.row.name) return EMPTY_CELL;
  if (props.row.name === '@') return props.zoneName || '@';
  return props.row.name;
}

const plainValue = computed(() => {
  switch (props.column.key) {
    case 'ip_address': return displayCell(props.row.ip_address);
    case 'hostname': return displayHostnameCell(props.row.hostname, props.domainName);
    case 'dns_hostname': return dnsHostname();
    case 'record_name': {
      if (!props.row.name) return EMPTY_CELL;
      return props.zoneName ? `${props.row.name}.${props.zoneName}` : props.row.name;
    }
    case 'value': return displayCell(props.row.value);
    case 'priority': return displayCell(props.row.priority);
    case 'port': return displayCell(props.row.port);
    case 'ttl': return displayCell(props.row.ttl ?? props.soaMinimumTtl);
    case 'source': return source.value;
    case 'mac_address': return displayMacAddress(props.row.mac_address || props.row.last_seen_mac);
    case 'vendor': return displayCell(props.row.vendor);
    case 'device': return displayCell(props.row.os_family || props.row.device_type);
    case 'last_seen_at': return props.row.last_seen_at ? formatDateTime(props.row.last_seen_at) : EMPTY_CELL;
    case 'network': return displayCell(props.row.subnet_name || props.row.subnet_cidr);
    case 'expires': return displayExpiry(
      props.row.expires_at ?? props.row.dhcp_expires_at,
      formatDateTime,
      { reserved: props.row.dhcp_assignment_type === 'reserved' }
    );
    default: return displayCell(props.row[props.column.field]);
  }
});
</script>

<style scoped>
.type-badge {
  font-family: monospace;
  font-size: var(--app-fs-xs);
  font-weight: 600;
  letter-spacing: 0.02em;
  padding: 2px 6px;
  border-radius: 4px;
}
</style>
