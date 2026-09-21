<!-- Analytics "Dashboard": a health board answering one question, is the
     network healthy right now. A status rail, the conditions that need a
     decision (each a link to where it is made), how resolution is doing,
     traffic as context, and the shape of the address plan. Same grammar as
     the anomaly triage page: head and lede, chip rail, uppercase panel heads. -->
<template>
  <div class="workspace health-board" data-track="dashboard-health">
    <header class="workspace-head">
      <div>
        <h1>Network health</h1>
        <p class="lede">
          What is running, what is answering, and what needs a decision. Everything here links to
          where you act on it.
        </p>
      </div>
      <div class="head-actions">
        <Select
          v-model="selectedRange"
          :options="rangeOptions"
          optionLabel="label"
          optionValue="value"
          size="small"
          style="width: 10rem"
          aria-label="Range"
          data-track="dashboard-range"
          @change="refreshRange"
        />
        <Button
          icon="pi pi-refresh"
          severity="secondary"
          text
          rounded
          size="small"
          aria-label="Refresh"
          data-track="dashboard-refresh"
          :loading="store.loading"
          @click="refreshAll"
        />
      </div>
    </header>

    <section class="status-rail" aria-label="Status">
      <span v-for="chip in serviceChips" :key="chip.key" class="chip" :title="chip.title">
        <StatusDot :kind="chip.tone" :label="chip.label" decorative /> {{ chip.label }}
        <b>{{ chip.value }}</b>
      </span>
      <span class="sep" aria-hidden="true"></span>
      <RouterLink
        v-for="chip in inventoryChips"
        :key="chip.key"
        class="chip link"
        :to="chip.to"
        :data-track="`dashboard-inventory-${chip.key}`"
      >
        {{ chip.label }} <b>{{ chip.value }}</b>
      </RouterLink>
    </section>

    <div class="board">
      <div class="col">
        <section class="panel" aria-label="Needs attention">
          <div class="panel-head">
            <h2>Needs attention</h2>
            <span class="panel-note">{{ attentionNote }}</span>
          </div>
          <AttentionList :rows="attention" />
        </section>

        <section class="panel" aria-label="Addresses">
          <div class="panel-head">
            <h2>Addresses</h2>
            <span class="panel-note">{{ addressNote }}</span>
          </div>
          <div class="panel-body">
            <AllocationBar v-if="lifecycle?.allocations" :allocations="lifecycle.allocations" />
            <p v-else class="unavailable">{{ unavailable('lifecycle') }}</p>
            <div v-if="lifecycle" class="alloc-note">{{ retirementNote }}</div>
          </div>
        </section>
      </div>

      <div class="col">
        <section class="panel" aria-label="Resolution">
          <div class="panel-head">
            <h2>Resolution</h2>
            <span class="panel-note">{{ resolutionNote }}</span>
          </div>
          <div v-if="health.failed.includes('proxyPerf')" class="panel-body">
            <p class="unavailable">{{ unavailable('proxyPerf') }}</p>
          </div>
          <div v-else class="figures">
            <FigureCard
              label="p95 latency"
              :value="resolution.p95"
              unit="ms"
              :sub="resolution.latencySub"
              :series="resolution.p95Series"
            />
            <FigureCard
              label="Cache hit rate"
              :value="resolution.hitRate"
              unit="%"
              :sub="resolution.cacheSub"
              tone="ok"
              :series="resolution.hitSeries"
            />
            <FigureCard
              label="Timeouts"
              :value="resolution.timeouts"
              :sub="resolution.timeouts > 0 ? 'upstream did not answer' : 'every query answered'"
              :tone="resolution.timeouts > 0 ? 'warn' : 'ok'"
              :series="resolution.timeoutSeries"
            />
          </div>
        </section>

        <section class="panel" aria-label="DNS traffic">
          <div class="panel-head">
            <h2>DNS traffic</h2>
            <span class="panel-note">{{ dnsNote }}</span>
          </div>
          <div class="panel-body">
            <p v-if="health.failed.includes('timeseries')" class="unavailable">
              {{ unavailable('timeseries') }}
            </p>
            <TrafficChart
              v-else
              :rows="dnsRows"
              :series="DNS_SERIES"
              :range="selectedRange"
              noun="queries"
            />
            <div class="tops">
              <table>
                <thead>
                  <tr>
                    <th>Top clients</th>
                    <th class="r">Queries</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in topClients" :key="row.key">
                    <td>
                      <RouterLink :to="row.to" data-track="dashboard-top-client">{{
                        row.label
                      }}</RouterLink>
                      <div class="bar" :style="{ width: `${row.pct}%` }"></div>
                    </td>
                    <td class="r mono">{{ formatNumber(row.count) }}</td>
                  </tr>
                  <tr v-if="!topClients.length">
                    <td colspan="2" class="unavailable">No queries in this range.</td>
                  </tr>
                </tbody>
              </table>
              <table>
                <thead>
                  <tr>
                    <th>Top domains</th>
                    <th class="r">Queries</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in topDomains" :key="row.key">
                    <td>
                      <RouterLink :to="row.to" data-track="dashboard-top-domain">{{
                        row.label
                      }}</RouterLink>
                      <div class="bar" :style="{ width: `${row.pct}%` }"></div>
                    </td>
                    <td class="r mono">{{ formatNumber(row.count) }}</td>
                  </tr>
                  <tr v-if="!topDomains.length">
                    <td colspan="2" class="unavailable">No queries in this range.</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section class="panel" aria-label="DHCP traffic">
          <div class="panel-head">
            <h2>DHCP traffic</h2>
            <span class="panel-note">{{ dhcpNote }}</span>
          </div>
          <div class="panel-body">
            <p v-if="health.failed.includes('timeseries')" class="unavailable">
              {{ unavailable('timeseries') }}
            </p>
            <TrafficChart
              v-else
              :rows="dhcpRows"
              :series="DHCP_SERIES"
              :range="selectedRange"
              :stacked="false"
              noun="DHCP messages"
            />
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted } from 'vue';
import { RouterLink } from 'vue-router';
import Select from '../ui/Select.js';
import Button from '../ui/Button.js';
import { useDashboardStore } from '../stores/dashboard.js';
import { RANGE_OPTIONS } from '../utils/chart-config.js';
import { formatNumber } from '../utils/format.js';
import { useAutoRefresh } from '../composables/useAutoRefresh.js';
import '../assets/analytics-workspace.css';
import { attentionItems, openCount } from '../utils/health-attention.js';
import StatusDot from '../components/StatusDot.vue';
import AttentionList from '../components/dashboard/AttentionList.vue';
import FigureCard from '../components/dashboard/FigureCard.vue';
import AllocationBar from '../components/dashboard/AllocationBar.vue';
import TrafficChart from '../components/dashboard/TrafficChart.vue';

const store = useDashboardStore();
const health = store.health;
const rangeOptions = RANGE_OPTIONS;
const selectedRange = computed({ get: () => store.selectedRange, set: (v) => store.setRange(v) });

const DNS_SERIES = [
  { key: 'answered', label: 'Answered', color: 'info' },
  { key: 'blocklist_blocks', label: 'Blocked by list', color: 'warn' },
  { key: 'geoip_blocks', label: 'Blocked by GeoIP', color: 'err' },
];
// The two halves of the DHCP conversation. Rows from before migration 079
// only carry the combined dhcp_requests, so they draw as client messages.
const DHCP_SERIES = [
  { key: 'dhcp_client', label: 'Client requests', color: 'info' },
  { key: 'dhcp_server', label: 'Server replies', color: 'ok' },
];

const lifecycle = computed(() => health.lifecycle);

function unavailable(key) {
  const names = {
    lifecycle: 'Address figures are unavailable right now.',
    proxyPerf: 'Resolution figures are unavailable right now.',
    timeseries: 'Traffic figures are unavailable right now.',
  };
  return names[key] || 'Unavailable right now.';
}

// Rail: services with a dot, then inventory as links.
const serviceChips = computed(() => {
  const s = health.services;
  const a = health.anomalies;
  const chips = [];
  if (health.failed.includes('services') || !s) {
    chips.push({ key: 'services', label: 'Services', value: 'unknown', tone: 'muted' });
  } else {
    chips.push({
      key: 'dnsmasq',
      label: 'dnsmasq',
      value: s.dnsmasq ? 'Running' : 'Stopped',
      tone: s.dnsmasq ? 'ok' : 'err',
    });
    chips.push({
      key: 'proxy',
      label: 'DNS proxy',
      value: s.geoip_bypassed ? 'Bypassed' : s.geoip_proxy ? 'Running' : 'Stopped',
      tone: s.geoip_bypassed ? 'warn' : s.geoip_proxy ? 'ok' : 'err',
    });
    const fw = s.forwarders || [];
    const up = fw.filter((f) => f.reachable).length;
    chips.push({
      key: 'forwarders',
      label: 'Forwarders',
      value: fw.length ? `${up} of ${fw.length}` : 'none',
      tone: !fw.length ? 'muted' : up === fw.length ? 'ok' : up ? 'warn' : 'err',
      title: fw.map((f) => `${f.ip} ${f.reachable ? 'reachable' : 'unreachable'}`).join('\n'),
    });
  }
  if (a) {
    const d = a.daemon || {};
    chips.push({
      key: 'detector',
      label: 'Detector',
      value: !a.enabled ? 'Off' : d.last_score ? 'Scoring' : 'Idle',
      tone: !a.enabled ? 'muted' : 'ok',
    });
  }
  return chips;
});

const inventoryChips = computed(() => {
  const st = health.system?.stats || {};
  const v = (n) => (n === undefined || n === null ? '?' : formatNumber(n));
  return [
    { key: 'networks', label: 'Networks', value: v(st.subnets), to: '/networks?context=all' },
    {
      key: 'zones',
      label: 'Zones',
      value: v(st.dns_zones),
      to: '/networks?context=all&view=dns',
    },
    {
      key: 'scopes',
      label: 'Scopes',
      value: v(st.dhcp_scopes),
      to: '/networks?context=all&view=dhcp',
    },
    {
      key: 'leases',
      label: 'Leases',
      value: v(st.dhcp_leases),
      to: '/networks?context=all&view=dhcp',
    },
  ];
});

// Attention rows, from the pure helper so the ordering is tested on its own.
const attention = computed(() =>
  attentionItems({
    services: health.services,
    lifecycle: health.lifecycle,
    networkDhcp: health.networkDhcp,
    rogueDhcp: health.rogueDhcp,
    anomalies: health.anomalies,
  }),
);
const attentionNote = computed(() => {
  const n = openCount(attention.value);
  const failed = health.failed.filter((k) =>
    ['services', 'lifecycle', 'networkDhcp', 'rogueDhcp', 'anomalies'].includes(k),
  );
  const open = n === 0 ? 'nothing open' : `${n} open`;
  return failed.length
    ? `${open}, ${failed.length} source${failed.length > 1 ? 's' : ''} unavailable`
    : open;
});

// Resolution: from the proxy performance minute rows.
const resolution = computed(() => {
  const rows = store.proxyPerf || [];
  const withQueries = rows.filter((r) => (r.query_count || 0) > 0);
  const queries = rows.reduce((s, r) => s + (r.query_count || 0), 0);
  const hits = rows.reduce((s, r) => s + (r.cache_hits || 0), 0);
  const misses = rows.reduce((s, r) => s + (r.cache_misses || 0), 0);
  const timeouts = rows.reduce((s, r) => s + (r.timeouts || 0), 0);
  const p95Values = withQueries.map((r) => r.latency_p95).filter((v) => typeof v === 'number');
  const p95 = p95Values.length
    ? Math.round(p95Values.reduce((s, v) => s + v, 0) / p95Values.length / 1000)
    : null;
  const mins = withQueries.map((r) => r.latency_min).filter((v) => typeof v === 'number');
  const avgs = withQueries.map((r) => r.latency_avg).filter((v) => typeof v === 'number');
  const hitRate = hits + misses ? Math.round((hits / (hits + misses)) * 100) : null;
  return {
    queries,
    p95,
    latencySub:
      mins.length && avgs.length
        ? `min ${Math.round(Math.min(...mins) / 1000)} · avg ${Math.round(
            avgs.reduce((s, v) => s + v, 0) / avgs.length / 1000,
          )}`
        : 'no queries in this range',
    p95Series: rows.map((r) => (typeof r.latency_p95 === 'number' ? r.latency_p95 / 1000 : null)),
    hitRate,
    cacheSub:
      hits + misses
        ? `${formatNumber(hits)} hits · ${formatNumber(misses)} misses`
        : 'no cache activity',
    hitSeries: rows.map((r) =>
      r.cache_hits + r.cache_misses ? (r.cache_hits / (r.cache_hits + r.cache_misses)) * 100 : null,
    ),
    timeouts,
    timeoutSeries: rows.map((r) => r.timeouts || 0),
  };
});
const resolutionNote = computed(
  () => `${rangeLabel.value} · ${formatNumber(resolution.value.queries)} queries`,
);

// Traffic: answered is total minus the two block counts, so the stack sums to the total.
const dnsRows = computed(() =>
  (store.timeseries || []).map((r) => ({
    ts: r.ts,
    answered: Math.max(0, (r.dns_queries || 0) - (r.blocklist_blocks || 0) - (r.geoip_blocks || 0)),
    blocklist_blocks: r.blocklist_blocks || 0,
    geoip_blocks: r.geoip_blocks || 0,
  })),
);
const dhcpRows = computed(() =>
  (store.timeseries || []).map((r) => {
    const split = (r.dhcp_client_msgs || 0) + (r.dhcp_server_msgs || 0) > 0;
    return {
      ts: r.ts,
      dhcp_client: split ? r.dhcp_client_msgs || 0 : r.dhcp_requests || 0,
      dhcp_server: split ? r.dhcp_server_msgs || 0 : 0,
    };
  }),
);
const dnsNote = computed(() => {
  const total = (store.timeseries || []).reduce((s, r) => s + (r.dns_queries || 0), 0);
  const blocked = (store.timeseries || []).reduce(
    (s, r) => s + (r.blocklist_blocks || 0) + (r.geoip_blocks || 0),
    0,
  );
  if (!total) return rangeLabel.value;
  return `${rangeLabel.value} · ${((blocked / total) * 100).toFixed(1)}% blocked`;
});
const dhcpNote = computed(() => {
  const c = dhcpRows.value.reduce((s, r) => s + r.dhcp_client, 0);
  const sv = dhcpRows.value.reduce((s, r) => s + r.dhcp_server, 0);
  if (!c && !sv) return rangeLabel.value;
  if (!sv) return `${rangeLabel.value} · ${formatNumber(c)} messages`;
  return `${rangeLabel.value} · ${formatNumber(c)} requests, ${formatNumber(sv)} replies`;
});

const rangeLabel = computed(() =>
  (RANGE_OPTIONS.find((o) => o.value === selectedRange.value)?.label || 'Last 24 hours')
    .replace('Last ', 'last ')
    .replace(/ 1 (hour|week)$/, ' $1'),
);

function topRows(items, labelOf, keyOf, toOf) {
  const list = (items || []).slice(0, 5);
  const max = Math.max(1, ...list.map((r) => Number(r.count) || 0));
  return list.map((r) => ({
    key: keyOf(r),
    label: labelOf(r),
    count: Number(r.count) || 0,
    pct: ((Number(r.count) || 0) / max) * 100,
    to: toOf(r),
  }));
}
const topClients = computed(() =>
  topRows(
    store.topClients,
    (r) => r.hostname || r.client_ip || 'unknown',
    (r) => r.client_ip || r.hostname,
    (r) => `/networks?context=all&view=addresses&q=${encodeURIComponent(r.client_ip || '')}`,
  ),
);
const topDomains = computed(() =>
  topRows(
    store.topDomains,
    (r) => r.domain || 'unknown',
    (r) => r.domain,
    (r) => `/analytics?view=intelligence&q=${encodeURIComponent(r.domain || '')}`,
  ),
);

// Addresses panel notes.
const addressNote = computed(() => {
  const a = lifecycle.value?.allocations;
  if (!a) return '';
  const total = Object.values(a).reduce((s, n) => s + (Number(n) || 0), 0);
  const st = health.system?.stats || {};
  return st.subnets
    ? `${formatNumber(total)} managed across ${st.subnets} networks`
    : `${formatNumber(total)} managed`;
});
const retirementNote = computed(() => {
  const l = lifecycle.value;
  if (!l) return '';
  const parts = [];
  const retired = l.retirement?.last_24h;
  if (typeof retired === 'number') {
    parts.push(
      `${formatNumber(retired)} ${retired === 1 ? 'address' : 'addresses'} retired in the last 24h`,
    );
  }
  const r = l.reconciliation;
  if (r) {
    parts.push(
      r.outcome === 'complete' && !r.blocking_conflicts && !r.failures
        ? 'reconciliation complete, no conflicts'
        : `reconciliation ${r.outcome}`,
    );
  }
  return parts.join(' · ');
});

async function refreshAll() {
  await store.fetchHealthBoard(selectedRange.value);
}
async function refreshRange() {
  await store.fetchHealthBoard(selectedRange.value, { rangeOnly: true });
}

onMounted(refreshAll);
useAutoRefresh(refreshAll);
</script>

<style scoped>
.board {
  display: grid;
  grid-template-columns: minmax(300px, 5fr) minmax(0, 7fr);
  gap: 14px;
  align-items: start;
}
.col {
  display: grid;
  gap: 14px;
}
.alloc-note {
  font-size: 0.78rem;
  color: var(--cid-text-muted-color);
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--cid-surface-border);
}
.figures {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  padding: 0 14px 14px;
}
.tops {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  margin-top: 14px;
}
.tops table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}
.tops th {
  text-align: left;
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--cid-text-muted-color);
  font-weight: 600;
  padding: 0 0 6px;
  border-bottom: 1px solid var(--cid-surface-border);
}
.tops th.r,
.tops td.r {
  text-align: right;
}
.tops td {
  padding: 5px 0;
  border-bottom: 1px solid var(--cid-surface-border);
}
.tops tr:last-child td {
  border-bottom: 0;
}
.tops td a {
  color: inherit;
  text-decoration: none;
}
.tops td a:hover {
  color: var(--cid-primary-color);
}
.tops .bar {
  height: 3px;
  background: var(--cid-primary-color);
  border-radius: 2px;
  margin-top: 3px;
  opacity: 0.7;
}
@media (max-width: 860px) {
  .board {
    grid-template-columns: 1fr;
  }
  .figures {
    grid-template-columns: 1fr 1fr;
  }
  .tops {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 480px) {
  .figures {
    grid-template-columns: 1fr;
  }
}
</style>
