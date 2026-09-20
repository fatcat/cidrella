<!-- One dot per monitored device. Horizontal: how far the latest window sits
     from the device's own baseline (the model score, negative is anomalous,
     the flag boundary is the middle gridline). Vertical: threat shape, the
     sidecar's rule score over entropy, NXDOMAIN rate, name length, subdomain
     depth and block rate. Top right is where both agree something is wrong. -->
<template>
  <section class="panel map-panel" aria-label="Triage map">
    <div class="panel-head">
      <h2>Triage map</h2>
      <span class="panel-note">Hover to find the device in the queue. Click to open.</span>
    </div>
    <div class="map-body">
      <svg
        class="map-svg"
        :viewBox="`0 0 ${W} ${H}`"
        role="img"
        aria-label="Devices plotted by deviation from their own baseline against threat shape"
      >
        <rect
          :x="mx(50)"
          :y="my(100)"
          :width="mx(100) - mx(50)"
          :height="my(50) - my(100)"
          :fill="errColor"
          opacity="0.07"
        />
        <g v-for="tick in TICKS" :key="tick">
          <line :x1="mx(tick)" :y1="my(0)" :x2="mx(tick)" :y2="my(100)" :stroke="gridColor" />
          <line :x1="mx(0)" :y1="my(tick)" :x2="mx(100)" :y2="my(tick)" :stroke="gridColor" />
          <text :x="mx(tick)" :y="H - PAD.b + 16" text-anchor="middle" class="axis-num">
            {{ tick }}
          </text>
          <text :x="PAD.l - 8" :y="my(tick) + 4" text-anchor="end" class="axis-num">
            {{ tick }}
          </text>
        </g>
        <text :x="(mx(0) + mx(100)) / 2" :y="H - 8" text-anchor="middle" class="axis-label">
          Deviation from this device's own baseline (right of center is flagged)
        </text>
        <text
          :x="14"
          :y="(my(0) + my(100)) / 2"
          text-anchor="middle"
          class="axis-label"
          :transform="`rotate(-90 14 ${(my(0) + my(100)) / 2})`"
        >
          Threat shape
        </text>
        <text :x="mx(98)" :y="my(96)" text-anchor="end" class="quad hot">INVESTIGATE</text>
        <text :x="mx(2)" :y="my(96)" class="quad">SUSPICIOUS, STEADY</text>
        <text :x="mx(98)" :y="my(3)" text-anchor="end" class="quad">JUST UNUSUAL</text>

        <g v-for="dot in dots" :key="dot.id">
          <circle
            v-if="dot.ringed"
            :cx="dot.cx"
            :cy="dot.cy"
            :r="dot.r + 4"
            fill="none"
            :stroke="dot.color"
            stroke-opacity="0.6"
          />
          <circle
            class="mdot"
            :class="{ open: dot.id === openId, hover: dot.id === hoverId, hollow: dot.hollow }"
            :cx="dot.cx"
            :cy="dot.cy"
            :r="dot.r"
            :fill="dot.color"
            :fill-opacity="dot.hollow ? 0.12 : dot.actionable ? 0.9 : 0.55"
            :stroke="dot.hollow ? dot.color : 'transparent'"
            stroke-width="1.5"
            role="button"
            tabindex="0"
            :aria-label="`Open ${dot.name}`"
            data-track="triage-map-dot"
            data-triage-target
            @click="emit('select', dot.id)"
            @keydown.enter.prevent="emit('select', dot.id)"
            @keydown.space.prevent="emit('select', dot.id)"
            @mouseenter="emit('hover', dot.id)"
            @mouseleave="emit('hover', null)"
            @focus="emit('hover', dot.id)"
            @blur="emit('hover', null)"
          >
            <title>{{ dot.title }}</title>
          </circle>
        </g>
      </svg>
    </div>
    <div class="map-legend">
      <span><i class="sw" :style="{ background: errColor }"></i> Flagged, high</span>
      <span><i class="sw" :style="{ background: warnColor }"></i> Flagged, medium</span>
      <span><i class="sw" :style="{ background: infoColor }"></i> Flagged, low</span>
      <span><i class="sw within"></i> Within baseline</span>
      <span v-if="unscored"><i class="sw hollow"></i> Threat shape not scored yet</span>
    </div>
    <p class="map-foot">
      Dot size is how many of the last 24 windows were flagged. A ring means 3 or more.
      <template v-if="unscored">
        Hollow dots sit on the bottom edge until the detector's next scoring cycle fills in their
        threat shape.
      </template>
    </p>
  </section>
</template>

<script setup>
import { computed } from 'vue';
import { chartColor, chartThemeVersion } from '../../utils/chart-config.js';
import { mapX } from '../../utils/anomaly-score.js';

const props = defineProps({
  // { id, name, ip, score, threat, severity, flagged24h, actionable, color }
  points: { type: Array, required: true },
  openId: { type: String, default: null },
  hoverId: { type: String, default: null },
});
const emit = defineEmits(['select', 'hover']);

const W = 760;
const H = 440;
const PAD = { l: 52, r: 18, t: 22, b: 46 };
const TICKS = [0, 25, 50, 75, 100];
const mx = (v) => PAD.l + (v / 100) * (W - PAD.l - PAD.r);
const my = (v) => H - PAD.b - (v / 100) * (H - PAD.t - PAD.b);

const themed = (key) =>
  computed(() => {
    chartThemeVersion.value;
    return chartColor(key);
  });
const errColor = themed('err');
const warnColor = themed('warn');
const infoColor = themed('info');
const gridColor = themed('grid');

const dots = computed(() =>
  props.points.map((p) => {
    const hollow = typeof p.threat !== 'number';
    const r = 5 + 2 * Math.min(p.flagged24h || 0, 6);
    return {
      id: p.id,
      name: p.name,
      cx: Number(mx(mapX(p.score)).toFixed(1)),
      cy: Number(my(hollow ? 0 : Math.max(0, Math.min(1, p.threat)) * 100).toFixed(1)),
      r,
      color: p.color,
      hollow,
      actionable: p.actionable,
      ringed: (p.flagged24h || 0) >= 3,
      title: `${p.name} · ${p.ip}${
        typeof p.score === 'number' ? ` · score ${p.score.toFixed(2)}` : ' · not scored yet'
      }${hollow ? ' · threat shape not scored yet' : ` · threat ${Math.round(p.threat * 100)}`}`,
    };
  }),
);
const unscored = computed(() => dots.value.some((d) => d.hollow));
</script>

<style scoped>
.map-panel {
  min-width: 0;
}
.map-body {
  padding: 4px 14px 8px;
}
.map-svg {
  display: block;
  width: 100%;
  height: auto;
}
.axis-num,
.axis-label {
  font-size: 11px;
  fill: var(--cid-text-muted-color);
}
.axis-num {
  font-family: var(--mono, ui-monospace, monospace);
}
.quad {
  font-size: 11px;
  letter-spacing: 0.06em;
  fill: var(--cid-text-muted-color);
}
.quad.hot {
  fill: var(--cid-red-500, #bf616a);
  font-weight: 600;
}
.mdot {
  cursor: pointer;
  /* A hollow dot is mostly unpainted; without this only its 1.5px stroke
     would take the click. */
  pointer-events: all;
}
.mdot.hover,
.mdot.open {
  stroke: var(--cid-text-color);
  stroke-width: 2;
}
.mdot:focus-visible {
  outline: none;
  stroke: var(--cid-primary-color);
  stroke-width: 2;
}
.map-legend {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  font-size: 0.78rem;
  color: var(--cid-text-muted-color);
  padding: 4px 14px 0;
}
.map-legend span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.sw {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
}
.sw.within {
  background: var(--cid-surface-ground);
  border: 1px solid var(--cid-surface-border);
}
.sw.hollow {
  background: none;
  border: 1.5px solid var(--cid-text-muted-color);
}
.map-foot {
  font-size: 0.78rem;
  color: var(--cid-text-muted-color);
  padding: 6px 14px 12px;
  margin: 0;
}
</style>
