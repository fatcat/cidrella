<!-- Analytics "Resolution Map": every DNS answer CIDRella gives, drawn as a
     flight from this box to where GeoIP puts the answer. GeoIP blocks fly red
     and burst where they land, blocklist blocks flash a shield at home. Live: the feed
     is the server's last few thousand decisions (utils/resolution-feed.js),
     polled every two seconds. -->
<template>
  <div class="workspace resolution-map" data-track="analytics-map">
    <WorkspaceHead
      title="Resolution Map"
      lede="Where the answers this resolver hands out live, by GeoIP, as they happen."
      track="map"
      :loading="loading"
      @refresh="load"
    />

    <p v-if="error" class="notice" role="alert">{{ error }}</p>
    <p v-else-if="geoip && !geoip.loaded" class="notice">
      GeoIP is off, so answers have no country and nothing flies; blocklist blocks still show.
    </p>
    <p v-else-if="geoip && !geoip.cities" class="notice">
      City places are not installed, so answers land at their country's middle.
    </p>

    <section class="map-stage" aria-label="Resolution Map">
      <ResolutionCanvas
        ref="canvas"
        :mode="mode"
        :home="homePoint"
        :paused="paused"
        :picking="picking"
        @pick="saveHome"
      />

      <div class="hud stats" aria-label="Last minute">
        <div class="stat">
          <b>{{ formatNumber(kinds.answer) }}</b
          ><span>answers</span>
        </div>
        <div class="stat">
          <b>{{ formatNumber(summary.countries) }}</b
          ><span>countries</span>
        </div>
        <div class="stat geo">
          <b>{{ formatNumber(kinds.geoip) }}</b
          ><span>GeoIP blocks</span>
        </div>
        <div class="stat shield">
          <b>{{ formatNumber(kinds.blocklist) }}</b
          ><span>blocklist blocks</span>
        </div>
        <small>last minute</small>
      </div>

      <div class="hud controls" role="group" aria-label="View">
        <button
          type="button"
          :aria-pressed="mode === 'map'"
          data-track="map-projection-map"
          @click="mode = 'map'"
        >
          MAP
        </button>
        <button
          type="button"
          :aria-pressed="mode === 'globe'"
          data-track="map-projection-globe"
          @click="mode = 'globe'"
        >
          GLOBE
        </button>
        <button
          type="button"
          :aria-pressed="paused"
          data-track="map-pause"
          @click="paused = !paused"
        >
          PAUSE
        </button>
        <button
          v-if="canSetHome"
          type="button"
          :aria-pressed="picking"
          data-track="map-set-location"
          @click="picking = !picking"
        >
          {{ picking ? 'CLICK THE MAP' : 'SET LOCATION' }}
        </button>
      </div>

      <div class="hud top">
        <h2>Top destinations</h2>
        <p v-if="!summary.topCountries.length" class="quiet">No answers in the last minute.</p>
        <div v-for="row in topRows" :key="row.country" class="row" :title="row.name">
          <span>{{ row.flag }} {{ row.country }}</span>
          <i :style="{ width: row.share }"></i>
          <em>{{ formatNumber(row.count) }}</em>
        </div>
      </div>

      <div class="hud feed">
        <h2>Latest</h2>
        <p v-if="!latest.length" class="quiet">Waiting for queries.</p>
        <ol>
          <li v-for="event in latest" :key="event.seq" :class="event.kind">
            <span>{{ event.name || '(no name)' }}</span>
            <span>{{ whereLabel(event) }}</span>
          </li>
        </ol>
      </div>

      <div class="hud legend">
        <span class="l-ok">answered, permitted</span>
        <span class="l-geo">GeoIP block, bursts on arrival</span>
        <span class="l-shield">blocklist block at home</span>
        <span class="l-home">{{ homeLabel }}</span>
        <GeoAttribution />
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import api from '../api/client.js';
import WorkspaceHead from '../components/WorkspaceHead.vue';
import GeoAttribution from '../components/GeoAttribution.vue';
import ResolutionCanvas from '../components/analytics/ResolutionCanvas.vue';
import { useAutoRefresh } from '../composables/useAutoRefresh.js';
import { usePermissions } from '../composables/usePermissions.js';
import { COUNTRIES, countryFlag } from '../utils/countries.js';
import { apiError, formatNumber } from '../utils/format.js';
import { localeHome } from '../utils/resolution-map-geometry.js';
import '../assets/analytics-workspace.css';

const POLL_MS = 2000;
const LATEST = 7;
// A first poll can carry minutes of history; only the last poll's worth flies.
const BACKLOG_MS = POLL_MS;

const { can } = usePermissions();
const canSetHome = computed(() => can('system:write'));
const countryName = new Map(COUNTRIES.map((c) => [c.code, c.name]));

const canvas = ref(null);
const mode = ref('map');
const paused = ref(false);
const picking = ref(false);
const loading = ref(false);
const error = ref('');
const cursor = ref(0);
const home = ref(null);
const geoip = ref(null);
const summary = ref({ kinds: {}, countries: 0, topCountries: [] });
const latest = ref([]);

const fallbackHome = localeHome() || [0, 20];
const homePoint = computed(() => (home.value ? [home.value.lon, home.value.lat] : fallbackHome));
const homeLabel = computed(() =>
  home.value ? 'this CIDRella' : 'this CIDRella (location not set)',
);
const kinds = computed(() => ({ answer: 0, geoip: 0, blocklist: 0, ...summary.value.kinds }));

const topRows = computed(() => {
  const rows = summary.value.topCountries.slice(0, 8);
  const max = rows[0]?.count || 1;
  return rows.map((r) => ({
    ...r,
    flag: countryFlag(r.country),
    name: countryName.get(r.country) || r.country,
    share: `${Math.max(4, (r.count / max) * 100)}%`,
  }));
});

function whereLabel(event) {
  if (event.kind === 'blocklist') return 'BLOCKLIST';
  if (event.kind === 'geoip') return `${event.country || '??'} · GEOIP BLOCK`;
  return event.country || '';
}

async function load() {
  loading.value = true;
  try {
    const { data } = await api.get('/analytics/resolution-map', {
      params: { since: cursor.value },
    });
    const first = cursor.value === 0;
    cursor.value = data.seq;
    home.value = data.home;
    geoip.value = data.geoip;
    summary.value = data.summary;
    error.value = '';
    if (data.events.length) {
      latest.value = [...data.events.slice(-LATEST)]
        .reverse()
        .concat(latest.value)
        .slice(0, LATEST);
      const newest = data.events[data.events.length - 1].at;
      const flying = first ? data.events.filter((e) => newest - e.at <= BACKLOG_MS) : data.events;
      if (!paused.value) canvas.value?.enqueue(flying);
    }
  } catch (err) {
    error.value = `Could not load the map feed: ${apiError(err)}`;
  } finally {
    loading.value = false;
  }
}

async function saveHome([lon, lat]) {
  picking.value = false;
  const value = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  try {
    await api.put('/settings/map_home', { value });
    home.value = { lat: Number(lat.toFixed(4)), lon: Number(lon.toFixed(4)) };
    error.value = '';
  } catch (err) {
    error.value = `Could not save the location: ${apiError(err)}`;
  }
}

onMounted(load);
useAutoRefresh(load, POLL_MS);
</script>

<style scoped>
.notice {
  margin: 0;
  color: var(--cid-text-muted-color);
  font-size: 0.9rem;
}

/* The map is one fixed dark look in either theme, like a radar screen. */
.map-stage {
  --map-text: #b9d7e6;
  --map-muted: #6d91a3;
  --map-ok: #3cf2c8;
  --map-geo: #ff4d5e;
  --map-shield: #c77dff;
  --map-home: #ffc95c;
  --map-panel: rgba(8, 18, 28, 0.74);
  --map-edge: rgba(70, 150, 190, 0.25);
  position: relative;
  flex: 1;
  min-height: 560px;
  border-radius: 8px;
  overflow: hidden;
  background: #04070c;
  color: var(--map-text);
  font-family: 'JetBrains Mono', 'SFMono-Regular', Menlo, Consolas, monospace;
}
.map-stage::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    repeating-linear-gradient(0deg, rgba(255, 255, 255, 0.018) 0 1px, transparent 1px 3px),
    radial-gradient(ellipse at center, transparent 55%, rgba(0, 0, 0, 0.6) 100%);
}
.map-stage > :deep(canvas) {
  position: absolute;
  inset: 0;
}
.hud {
  position: absolute;
  z-index: 1;
  background: var(--map-panel);
  border: 1px solid var(--map-edge);
  border-radius: 6px;
  padding: 10px 12px;
  backdrop-filter: blur(4px);
  font-size: 11px;
}
.hud h2 {
  margin: 0 0 8px;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--map-muted);
}
.quiet {
  margin: 0;
  color: var(--map-muted);
}
.stats {
  top: 14px;
  left: 14px;
  display: flex;
  gap: 22px;
  align-items: flex-end;
}
.stat b {
  display: block;
  font-size: 20px;
  font-weight: 600;
  color: #e8f6ff;
  font-variant-numeric: tabular-nums;
}
.stat span,
.stats small {
  font-size: 10px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--map-muted);
}
.stat.geo b {
  color: var(--map-geo);
}
.stat.shield b {
  color: var(--map-shield);
}
.controls {
  top: 14px;
  right: 14px;
  display: flex;
  gap: 6px;
  padding: 6px;
}
.controls button {
  font: inherit;
  letter-spacing: 0.08em;
  color: var(--map-text);
  background: transparent;
  border: 1px solid var(--map-edge);
  border-radius: 4px;
  padding: 5px 10px;
  cursor: pointer;
}
.controls button[aria-pressed='true'] {
  color: #031015;
  background: var(--map-ok);
  border-color: var(--map-ok);
}
.controls button:focus-visible {
  outline: 2px solid var(--map-home);
  outline-offset: 2px;
}
.top {
  top: 66px;
  right: 14px;
  width: 220px;
}
.row {
  display: grid;
  grid-template-columns: 54px 1fr 40px;
  align-items: center;
  gap: 8px;
  margin: 5px 0;
}
.row i {
  display: block;
  height: 4px;
  border-radius: 2px;
  background: linear-gradient(90deg, var(--map-ok), rgba(60, 242, 200, 0.35));
}
.row em {
  font-style: normal;
  text-align: right;
  color: var(--map-muted);
  font-variant-numeric: tabular-nums;
}
.feed {
  left: 14px;
  bottom: 14px;
  width: min(360px, 45%);
}
.feed ol {
  list-style: none;
  margin: 0;
  padding: 0;
}
.feed li {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
  padding: 2px 0;
  white-space: nowrap;
}
.feed li span:first-child {
  overflow: hidden;
  text-overflow: ellipsis;
}
.feed li.geoip {
  color: var(--map-geo);
}
.feed li.blocklist {
  color: var(--map-shield);
}
.legend {
  right: 14px;
  bottom: 14px;
  display: grid;
  gap: 5px;
}
.legend span::before {
  content: '';
  display: inline-block;
  width: 18px;
  height: 2px;
  margin-right: 8px;
  vertical-align: 3px;
}
.legend .l-ok::before {
  background: var(--map-ok);
}
.legend .l-geo::before {
  background: var(--map-geo);
}
.legend .l-shield::before,
.legend .l-home::before {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 18px;
  vertical-align: 0;
}
.legend .l-shield::before {
  background: var(--map-shield);
}
.legend .l-home::before {
  background: var(--map-home);
}
</style>
