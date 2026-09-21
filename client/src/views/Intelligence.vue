<!-- Analytics "Intelligence": what the DNS filters let through, what they
     stopped, and which devices and domains were on each side. The verdict
     split leads, then the permitted side, then each filter's own lists, with
     the host-and-domain pairs under the blocklist since that is where the
     "one device, one domain" story usually is. Same grammar as the Dashboard. -->
<template>
  <div class="workspace intelligence" data-track="analytics-intelligence">
    <WorkspaceHead
      title="DNS filtering"
      lede="What the filters let through, what they stopped, and which devices and domains were on each side."
      track="intelligence"
      :range="selectedRange"
      :loading="store.loading"
      @update:range="onRange"
      @refresh="refreshAll"
    />

    <section class="status-rail" aria-label="Filters">
      <span v-for="chip in chips" :key="chip.key" class="chip" :title="chip.title">
        <StatusDot :kind="chip.tone" :label="chip.label" decorative /> {{ chip.label }}
        <b>{{ chip.value }}</b>
      </span>
    </section>

    <div class="board split">
      <section class="panel" aria-label="Verdicts">
        <div class="panel-head">
          <h2>Verdicts</h2>
          <span class="panel-note">{{ verdictNote }}</span>
        </div>
        <p v-if="failed('actionBreakdown')" class="unavailable">
          {{ unavailable('actionBreakdown') }}
        </p>
        <template v-else>
          <div class="figures" style="--figures: 2">
            <FigureCard
              label="Allowed"
              :value="formatNumber(verdicts.allowed)"
              :sub="verdicts.total ? `of ${formatNumber(verdicts.total)} queries` : 'no queries'"
              :series="[]"
            />
            <FigureCard
              label="Block rate"
              :value="verdicts.total ? verdicts.rate.toFixed(1) : null"
              unit="%"
              :sub="verdicts.total ? 'stopped by any filter' : 'no queries'"
              :series="[]"
            />
            <FigureCard
              label="Blocked by list"
              :value="formatNumber(verdicts.list)"
              :sub="categoriesSub"
              :series="[]"
            />
            <FigureCard
              label="Blocked by GeoIP"
              :value="formatNumber(verdicts.geoip)"
              :sub="countriesSub"
              :series="[]"
            />
          </div>
          <div class="panel-body">
            <StackedBar :segments="verdictSegments" noun="queries" :columns="3" />
          </div>
        </template>
      </section>

      <section class="panel" aria-label="Over time">
        <div class="panel-head">
          <h2>Allowed and blocked over time</h2>
          <span class="panel-note">{{ rangeLabel }} · click a legend chip to hide its line</span>
        </div>
        <div class="panel-body">
          <p v-if="failed('queryVolume')" class="unavailable">{{ unavailable('queryVolume') }}</p>
          <SeriesChart
            v-else
            :rows="verdictRows"
            :series="VERDICT_SERIES"
            :range="selectedRange"
            :stacked="false"
            :height="220"
            noun="queries"
          />
        </div>
      </section>
    </div>

    <section class="panel" aria-label="Permitted">
      <div class="panel-head">
        <h2>Permitted</h2>
        <span class="panel-note">answered, whatever the filters thought of the rest</span>
      </div>
      <div class="panel-body lists">
        <TopList
          title="Domains"
          :rows="domainRows(store.allowedTopDomains)"
          :empty-text="emptyFor('allowedTopDomains', 'No permitted queries in this range.')"
        />
        <TopList
          title="Clients"
          :rows="hostRows(store.allowedTopClients)"
          track="intelligence-allowed-client"
          :empty-text="emptyFor('allowedTopClients', 'No permitted queries in this range.')"
        />
      </div>
    </section>

    <section class="panel" aria-label="Blocked by list">
      <div class="panel-head">
        <h2>Blocked by list</h2>
        <span class="panel-note">{{ blocklistNote }}</span>
      </div>
      <p v-if="blocklistOff" class="unavailable">
        The blocklist is off, so nothing is blocked by category.
        <RouterLink :to="ROUTES.blocklist" data-track="intelligence-enable-blocklist">
          Turn it on in Settings › Filtering › Categories.
        </RouterLink>
      </p>
      <template v-else>
        <div class="panel-body lists" style="--lists: 3">
          <TopList
            title="Domains"
            :rows="domainRows(store.blocklistTopDomains)"
            :empty-text="emptyFor('blocklistTopDomains', 'Nothing blocked in this range.')"
          />
          <TopList
            title="Categories"
            :rows="categoryRows(store.blocklistTopCategories)"
            :empty-text="emptyFor('blocklistTopCategories', 'Nothing blocked in this range.')"
          />
          <TopList
            title="Hosts"
            :rows="hostRows(store.blocklistTopClients)"
            track="intelligence-blocked-host"
            :empty-text="emptyFor('blocklistTopClients', 'Nothing blocked in this range.')"
          />
        </div>
        <div class="panel-body pairs">
          <h3>Host and domain together</h3>
          <DataTable
            v-if="store.blocklistTopClientDomains.length"
            :value="store.blocklistTopClientDomains"
            size="small"
          >
            <Column header="Host">
              <template #body="{ data }">
                {{ data.hostname || data.client_ip }}
                <small v-if="data.hostname" class="muted">{{ data.client_ip }}</small>
              </template>
            </Column>
            <Column field="domain" header="Blocked domain" />
            <Column field="block_reason" header="Category">
              <template #body="{ data }">{{ data.block_reason || 'unknown' }}</template>
            </Column>
            <Column field="count" header="Queries" class="r">
              <template #body="{ data }">
                <span class="mono">{{ formatNumber(Number(data.count)) }}</span>
              </template>
            </Column>
          </DataTable>
          <p v-else class="unavailable">
            {{ emptyFor('blocklistTopClientDomains', 'Nothing blocked in this range.') }}
          </p>
        </div>
      </template>
    </section>

    <section class="panel" aria-label="Blocked by GeoIP">
      <div class="panel-head">
        <h2>Blocked by GeoIP</h2>
        <span class="panel-note">{{ geoipNote }}</span>
      </div>
      <p v-if="geoipOff" class="unavailable">
        GeoIP filtering is off, so nothing is blocked by country.
        <RouterLink :to="ROUTES.geoip" data-track="intelligence-enable-geoip">
          Turn it on in Settings › Filtering › GeoIP Rules.
        </RouterLink>
      </p>
      <div v-else class="panel-body lists" style="--lists: 3">
        <TopList
          title="Countries"
          :rows="countryRows(store.geoipHits)"
          :empty-text="emptyFor('geoipHits', 'Nothing blocked in this range.')"
        />
        <TopList
          title="Domains"
          :rows="domainRows(store.geoipTopDomains)"
          :empty-text="emptyFor('geoipTopDomains', 'Nothing blocked in this range.')"
        />
        <TopList
          title="Hosts"
          :rows="hostRows(store.geoipTopClients)"
          track="intelligence-geoip-host"
          :empty-text="emptyFor('geoipTopClients', 'Nothing blocked in this range.')"
        />
      </div>
    </section>

    <section class="panel" aria-label="Without DNSSEC">
      <div class="panel-head">
        <h2>Answered without DNSSEC</h2>
        <span class="panel-note">{{ dnssecNote }}</span>
      </div>
      <p v-if="dnssecOff" class="unavailable">
        DNSSEC validation is off, so no answer is checked.
        <RouterLink :to="ROUTES.dnssec" data-track="intelligence-enable-dnssec">
          Turn it on in Settings › DNS.
        </RouterLink>
      </p>
      <div v-else class="panel-body lists">
        <TopList
          title="Domains whose answers were not signed"
          :rows="domainRows(store.dnssecUnsupportedDomains)"
          :empty-text="
            emptyFor('dnssecUnsupportedDomains', 'Every answer in this range was signed.')
          "
        />
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted } from 'vue';
import { RouterLink } from 'vue-router';
import StatusDot from '../components/StatusDot.vue';
import WorkspaceHead from '../components/WorkspaceHead.vue';
import SeriesChart from '../components/SeriesChart.vue';
import StackedBar from '../components/StackedBar.vue';
import TopList from '../components/TopList.vue';
import FigureCard from '../components/dashboard/FigureCard.vue';
import DataTable from '../ui/DataTable.js';
import Column from '../ui/Column.js';
import { useDashboardStore } from '../stores/dashboard.js';
import { rangeLabel as rangeLabelOf } from '../utils/chart-config.js';
import { formatNumber } from '../utils/format.js';
import { serviceChips } from '../utils/service-chips.js';
import { useAutoRefresh } from '../composables/useAutoRefresh.js';
import '../assets/analytics-workspace.css';

const ROUTES = {
  blocklist: '/system?area=filtering&sec=categories',
  geoip: '/system?area=filtering&sec=geoip',
  dnssec: '/system?area=dns&sec=dns',
};

const VERDICT_SERIES = [
  { key: 'allowed', label: 'Allowed', color: 'info' },
  { key: 'blocked', label: 'Blocked', color: 'warn' },
];

const store = useDashboardStore();
const intel = store.intel;
const selectedRange = computed(() => store.selectedRange);
const rangeLabel = computed(() => rangeLabelOf(selectedRange.value));

const failed = (key) => intel.failed.includes(key);
function unavailable(key) {
  const names = {
    actionBreakdown: 'The verdict counts are unavailable right now.',
    queryVolume: 'The traffic series is unavailable right now.',
  };
  return names[key] || 'Unavailable right now.';
}
const emptyFor = (key, text) => (failed(key) ? 'Unavailable right now.' : text);

// Filter state, from the settings endpoints. null means the source did not
// answer (an analytics-only user cannot read settings), which is "unknown",
// not "off": the panels still show whatever the analytics store returned.
const blocklistOff = computed(() => intel.blocklistSettings?.blocklist_enabled === 'false');
const geoipOff = computed(() => intel.geoip !== null && intel.geoip.enabled === false);
const dnssecOff = computed(() => {
  const d = intel.system?.dnssec;
  return Boolean(d) && !d.enabled;
});

const chips = computed(() => {
  const list = serviceChips(failed('services') ? null : intel.services).filter(
    (c) => c.key !== 'forwarders',
  );
  const bs = intel.blocklistSettings;
  const st = intel.blocklistStats;
  if (!bs) list.push({ key: 'blocklist', label: 'Blocklist', value: 'unknown', tone: 'muted' });
  else if (bs.blocklist_enabled !== 'true')
    list.push({ key: 'blocklist', label: 'Blocklist', value: 'Off', tone: 'muted' });
  else
    list.push({
      key: 'blocklist',
      label: 'Blocklist',
      value: st
        ? `${st.enabled_categories} ${st.enabled_categories === 1 ? 'category' : 'categories'}`
        : 'On',
      tone: 'ok',
      title: st ? `${formatNumber(st.total_domains)} domains listed` : undefined,
    });
  const g = intel.geoip;
  if (!g) list.push({ key: 'geoip', label: 'GeoIP', value: 'unknown', tone: 'muted' });
  else if (!g.enabled) list.push({ key: 'geoip', label: 'GeoIP', value: 'Off', tone: 'muted' });
  else if (g.bypassed) list.push({ key: 'geoip', label: 'GeoIP', value: 'Bypassed', tone: 'warn' });
  else
    list.push({
      key: 'geoip',
      label: 'GeoIP',
      value:
        g.mode === 'allowlist'
          ? `Allow ${g.ruleCount} ${g.ruleCount === 1 ? 'country' : 'countries'}`
          : `Block ${g.ruleCount} ${g.ruleCount === 1 ? 'country' : 'countries'}`,
      tone: g.dbLoaded ? 'ok' : 'warn',
      title: g.dbLoaded ? undefined : 'GeoIP database not loaded',
    });
  const d = intel.system?.dnssec;
  if (!d) list.push({ key: 'dnssec', label: 'DNSSEC', value: 'unknown', tone: 'muted' });
  else if (!d.enabled) list.push({ key: 'dnssec', label: 'DNSSEC', value: 'Off', tone: 'muted' });
  else if (d.validating)
    list.push({ key: 'dnssec', label: 'DNSSEC', value: 'Validating', tone: 'ok' });
  else
    list.push({
      key: 'dnssec',
      label: 'DNSSEC',
      value: 'Not validating',
      tone: 'warn',
      title: 'Enabled, but dnsmasq is not validating (clock not yet synced, or unsupported)',
    });
  return list;
});

// Verdicts: the action split from the query log.
const verdicts = computed(() => {
  const by = Object.fromEntries(
    (store.actionBreakdown || []).map((r) => [r.action, Number(r.count) || 0]),
  );
  const allowed = by.allowed || 0;
  const list = by.blocked_blocklist || 0;
  const geoip = by.blocked_geoip || 0;
  const total = allowed + list + geoip;
  return { allowed, list, geoip, total, rate: total ? ((list + geoip) / total) * 100 : 0 };
});
const verdictSegments = computed(() => [
  { key: 'allowed', label: 'Allowed', count: verdicts.value.allowed, color: 'info' },
  { key: 'list', label: 'Blocked by list', count: verdicts.value.list, color: 'warn' },
  { key: 'geoip', label: 'Blocked by GeoIP', count: verdicts.value.geoip, color: 'err' },
]);
const verdictNote = computed(
  () => `${rangeLabel.value} · ${formatNumber(verdicts.value.total)} queries`,
);
const categoriesSub = computed(() => {
  const n = (store.blocklistTopCategories || []).length;
  if (!verdicts.value.list) return 'nothing on a list was asked for';
  return `${n} ${n === 1 ? 'category' : 'categories'} hit`;
});
const countriesSub = computed(() => {
  const n = (store.geoipHits || []).length;
  if (!verdicts.value.geoip) return 'no answer pointed at a blocked country';
  return `${n} ${n === 1 ? 'country' : 'countries'}`;
});

// Over time, from the same query log as the verdicts (the per-minute dnsmasq
// counters would not match: queries the proxy answers from cache never
// reach dnsmasq). Buckets arrive as ISO timestamps.
const verdictRows = computed(() =>
  (store.queryVolume || []).map((r) => ({
    ts: Math.round(Date.parse(r.bucket) / 1000),
    allowed: Number(r.allowed) || 0,
    blocked: Number(r.blocked) || 0,
  })),
);

// Row shapes for TopList.
const domainRows = (items) =>
  (items || []).map((r) => ({ key: r.domain, label: r.domain || 'unknown', count: r.count }));
const hostRows = (items) =>
  (items || []).map((r) => ({
    key: r.client_ip || r.hostname,
    label: r.hostname || r.client_ip || 'unknown',
    sub: r.hostname ? r.client_ip : undefined,
    count: r.count,
    to: r.client_ip
      ? `/networks?context=all&view=addresses&q=${encodeURIComponent(r.client_ip)}`
      : undefined,
  }));
const categoryRows = (items) =>
  (items || []).map((r) => ({
    key: r.block_reason,
    label: r.block_reason || 'unknown',
    count: r.count,
  }));
const regionNames = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    return null;
  }
})();
const countryRows = (items) =>
  (items || []).map((r) => {
    let name;
    try {
      name = regionNames?.of(r.country) || r.country;
    } catch {
      name = r.country;
    }
    return {
      key: r.country,
      label: name || 'unknown',
      sub: name && name !== r.country ? r.country : undefined,
      count: r.count,
    };
  });

const blocklistNote = computed(() => {
  const st = intel.blocklistStats;
  if (blocklistOff.value) return 'off';
  return st
    ? `${st.enabled_categories} ${st.enabled_categories === 1 ? 'category' : 'categories'} · ${formatNumber(st.total_domains)} domains listed`
    : rangeLabel.value;
});
const geoipNote = computed(() => {
  const g = intel.geoip;
  if (geoipOff.value) return 'off';
  if (!g) return rangeLabel.value;
  return g.mode === 'allowlist'
    ? `allow-only, ${g.ruleCount} ${g.ruleCount === 1 ? 'country' : 'countries'}`
    : `blocking ${g.ruleCount} ${g.ruleCount === 1 ? 'country' : 'countries'}`;
});
const dnssecNote = computed(() => {
  const d = intel.system?.dnssec;
  if (dnssecOff.value) return 'off';
  if (d && !d.validating) return 'enabled, not yet validating';
  return 'validation on, these providers do not sign';
});

async function refreshAll() {
  await store.fetchIntelligence(selectedRange.value);
}
async function onRange(value) {
  store.setRange(value);
  await store.fetchIntelligence(value, { rangeOnly: true });
}

onMounted(refreshAll);
useAutoRefresh(refreshAll);
</script>

<style scoped>
.panel > .unavailable {
  padding: 0 14px 14px;
}
.pairs {
  border-top: 1px solid var(--cid-surface-border);
  padding-top: 12px;
  margin-top: 4px;
}
.pairs h3 {
  margin: 0 0 8px;
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--cid-text-muted-color);
  font-weight: 600;
}
</style>
