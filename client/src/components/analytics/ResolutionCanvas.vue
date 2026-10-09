<!-- The Resolution Map's drawing: a dark world (flat map or globe) with a
     flight from home to wherever GeoIP puts each answer. A permitted answer
     lands and rings, a GeoIP block is shot down partway, and a blocklist
     block flashes a shield over home. One fixed palette in either theme: the
     map is one deliberate look. The math lives in
     utils/resolution-map-geometry.js; this file only draws. -->
<template>
  <canvas
    ref="canvas"
    class="resolution-canvas"
    :class="{ picking, turning: mode === 'globe' }"
    role="img"
    :aria-label="label"
    @pointerdown="onPointerDown"
  ></canvas>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  geoDistance,
  geoGraticule10,
  geoInterpolate,
  geoNaturalEarth1,
  geoOrthographic,
  geoPath,
} from 'd3-geo';
import { feature } from 'topojson-client';
import world from 'world-atlas/countries-110m.json';
import { COUNTRY_GEO } from '../../utils/country-geo.js';
import {
  destinationOf,
  facesViewer,
  launchDelays,
  liftedPoint,
  wrapsAround,
} from '../../utils/resolution-map-geometry.js';

const props = defineProps({
  mode: { type: String, default: 'map' }, // 'map' | 'globe'
  home: { type: Array, required: true }, // [lon, lat]
  paused: { type: Boolean, default: false },
  picking: { type: Boolean, default: false }, // a click picks a point, emitted as 'pick'
});
const emit = defineEmits(['pick']);

const COLORS = {
  sea: '#04070c',
  sphere: '#060d15',
  land: '#0a1520',
  coast: '#1d6a86',
  coastGlow: 'rgba(29, 106, 134, 0.35)',
  grid: 'rgba(80, 160, 200, 0.07)',
  rim: 'rgba(70, 150, 190, 0.35)',
  ok: '#3cf2c8',
  geo: '#ff4d5e',
  shield: '#c77dff',
  home: '#ffc95c',
};
const MAX_IN_FLIGHT = 150;
const POLL_SPAN_MS = 2000;
const TRAIL_STEPS = 32;

const canvas = ref(null);
const label = computed(() =>
  props.mode === 'globe'
    ? 'Globe of where DNS answers resolve, live'
    : 'Map of where DNS answers resolve, live',
);

const land = feature(world, world.objects.countries);
const outlines = new Map(land.features.map((f) => [f.id, f]));
const graticule = geoGraticule10();
const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');

let ctx = null;
let width = 0;
let height = 0;
let dpr = 1;
let projection = null;
let path = null;
let base = null; // the map's land, drawn once per size
let rotate = [80, -20];
let frameId = null;
let last = 0;
let resizer = null;
let drag = null;

const shots = [];
const bursts = [];
const glow = new Map(); // outline id -> { heat, blocked }
const queue = []; // { due, event }

function fit() {
  if (!canvas.value) return;
  dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  width = canvas.value.clientWidth;
  height = canvas.value.clientHeight;
  canvas.value.width = Math.max(1, Math.round(width * dpr));
  canvas.value.height = Math.max(1, Math.round(height * dpr));
  ctx = canvas.value.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const sphere = { type: 'Sphere' };
  projection =
    props.mode === 'globe'
      ? geoOrthographic()
          .fitExtent(
            [
              [40, 40],
              [width - 40, height - 40],
            ],
            sphere,
          )
          .clipAngle(90)
          .rotate(rotate)
      : geoNaturalEarth1().fitExtent(
          [
            [16, 16],
            [width - 16, height - 16],
          ],
          sphere,
        );
  path = geoPath(projection, ctx);
  base = null;
}

const visible = (point) => props.mode === 'map' || facesViewer(point, rotate, geoDistance);
const at = (flight, t) => liftedPoint(projection, props.mode, flight, t);

/** Queues one poll's events, spread over the next two seconds. */
function enqueue(events) {
  const now = performance.now();
  const delays = launchDelays(events, POLL_SPAN_MS);
  events.forEach((event, i) => queue.push({ due: now + delays[i], event }));
}
defineExpose({ enqueue });

function launch(event) {
  if (event.kind === 'blocklist') {
    bursts.push({ kind: 'shield', at: props.home, t: 0 });
    return;
  }
  const dest = destinationOf(event);
  if (!dest) return;
  const blocked = event.kind === 'geoip';
  const outline = COUNTRY_GEO[event.country]?.outline || null;
  if (reducedMotion?.matches) {
    // No flights: the destination pulses where it is.
    bursts.push({ kind: blocked ? 'geo-still' : 'land', at: dest, t: 0 });
    if (outline) glow.set(outline, { heat: 1, blocked });
    return;
  }
  if (shots.length >= MAX_IN_FLIGHT) {
    const oldest = shots.find((s) => !s.done);
    if (oldest) finish(oldest);
  }
  shots.push({
    home: props.home,
    dest,
    interp: geoInterpolate(props.home, dest),
    t: 0,
    speed: 0.5 + Math.random() * 0.35,
    blocked,
    stopAt: blocked ? 0.55 + Math.random() * 0.2 : 1,
    outline,
  });
}

function finish(shot) {
  bursts.push(
    shot.blocked
      ? { kind: 'geo', at: shot.interp(shot.t), flight: shot, tt: shot.t, t: 0 }
      : { kind: 'land', at: shot.dest, t: 0 },
  );
  if (shot.outline) glow.set(shot.outline, { heat: 1, blocked: shot.blocked });
  shot.done = true;
  shot.fade = 1;
}

function paintBase(target) {
  const p = geoPath(projection, target);
  target.fillStyle = COLORS.sea;
  target.fillRect(0, 0, width, height);
  if (props.mode === 'globe') {
    const [cx, cy] = projection.translate();
    const r = projection.scale();
    const halo = target.createRadialGradient(cx, cy, r * 0.7, cx, cy, r * 1.25);
    halo.addColorStop(0, 'rgba(40, 140, 190, 0.10)');
    halo.addColorStop(1, 'rgba(40, 140, 190, 0)');
    target.fillStyle = halo;
    target.beginPath();
    target.arc(cx, cy, r * 1.25, 0, 2 * Math.PI);
    target.fill();
  }
  target.beginPath();
  p({ type: 'Sphere' });
  target.fillStyle = COLORS.sphere;
  target.fill();
  target.beginPath();
  p(graticule);
  target.strokeStyle = COLORS.grid;
  target.lineWidth = 0.6;
  target.stroke();
  target.beginPath();
  p(land);
  target.fillStyle = COLORS.land;
  target.fill();
  // A wide faint stroke under a thin bright one: a glow without shadowBlur.
  target.strokeStyle = COLORS.coastGlow;
  target.lineWidth = 2.6;
  target.stroke();
  target.strokeStyle = COLORS.coast;
  target.lineWidth = 0.7;
  target.stroke();
  target.beginPath();
  p({ type: 'Sphere' });
  target.strokeStyle = COLORS.rim;
  target.lineWidth = 1;
  target.stroke();
}

function drawBase() {
  if (props.mode === 'map') {
    if (!base) {
      base = document.createElement('canvas');
      base.width = canvas.value.width;
      base.height = canvas.value.height;
      const b = base.getContext('2d');
      b.setTransform(dpr, 0, 0, dpr, 0, 0);
      paintBase(b);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(base, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  } else paintBase(ctx);
  // Countries hit recently glow, fading over a few seconds.
  for (const [id, g] of glow) {
    const outline = outlines.get(id);
    if (!outline || g.heat < 0.02) continue;
    ctx.beginPath();
    path(outline);
    ctx.fillStyle = g.blocked
      ? `rgba(255, 77, 94, ${0.22 * g.heat})`
      : `rgba(60, 242, 200, ${0.16 * g.heat})`;
    ctx.fill();
  }
}

function drawHome(now) {
  if (!visible(props.home)) return;
  const p = projection(props.home);
  if (!p) return;
  const pulse = (now / 1400) % 1;
  ctx.strokeStyle = `rgba(255, 201, 92, ${1 - pulse})`;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(p[0], p[1], 4 + pulse * 16, 0, 2 * Math.PI);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255, 201, 92, 0.25)';
  ctx.beginPath();
  ctx.arc(p[0], p[1], 7, 0, 2 * Math.PI);
  ctx.fill();
  ctx.fillStyle = COLORS.home;
  ctx.beginPath();
  ctx.arc(p[0], p[1], 3.2, 0, 2 * Math.PI);
  ctx.fill();
}

function drawShots(dt) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = shots.length - 1; i >= 0; i--) {
    const s = shots[i];
    if (s.done) s.fade -= dt * 0.7;
    else s.t = Math.min(s.stopAt, s.t + dt * s.speed);
    if (s.done && s.fade <= 0) {
      shots.splice(i, 1);
      continue;
    }
    const color = s.blocked ? COLORS.geo : COLORS.ok;
    const fade = s.done ? s.fade : 1;
    // The contrail as two strokes: the whole flight so far, faint, and the
    // last stretch bright. A segment behind the globe breaks the line.
    const trail = new Path2D();
    const head = new Path2D();
    let drawing = false;
    let headDrawing = false;
    let prev = null;
    for (let k = 0; k <= TRAIL_STEPS; k++) {
      const t = (s.t * k) / TRAIL_STEPS;
      const p = visible(s.interp(t)) ? at(s, t) : null;
      // Off the globe's face, or across the flat map's edge: lift the pen.
      if (!p || wrapsAround(prev, p, width)) drawing = headDrawing = false;
      prev = p;
      if (!p) continue;
      if (drawing) trail.lineTo(p[0], p[1]);
      else trail.moveTo(p[0], p[1]);
      drawing = true;
      if (!s.done && s.t - t < 0.3) {
        if (headDrawing) head.lineTo(p[0], p[1]);
        else head.moveTo(p[0], p[1]);
        headDrawing = true;
      }
    }
    ctx.strokeStyle = color;
    ctx.globalAlpha = fade * 0.2;
    ctx.lineWidth = 0.8;
    ctx.stroke(trail);
    if (!s.done) {
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 1.8;
      ctx.stroke(head);
      const tip = visible(s.interp(s.t)) ? at(s, s.t) : null;
      if (tip) {
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(tip[0], tip[1], 4.5, 0, 2 * Math.PI);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(tip[0], tip[1], 1.8, 0, 2 * Math.PI);
        ctx.fill();
      }
      if (s.t >= s.stopAt) finish(s);
    }
  }
  ctx.restore();
}

function drawBursts(dt) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = bursts.length - 1; i >= 0; i--) {
    const b = bursts[i];
    b.t += dt;
    const life = b.kind === 'shield' ? 0.9 : b.kind === 'land' ? 1.1 : 0.8;
    const k = b.t / life;
    if (k >= 1) {
      bursts.splice(i, 1);
      continue;
    }
    if (!visible(b.at)) continue;
    const p = b.kind === 'geo' ? at(b.flight, b.tt) : projection(b.at);
    if (!p) continue;
    ctx.globalAlpha = 1 - k;
    if (b.kind === 'land') {
      ctx.strokeStyle = COLORS.ok;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(p[0], p[1], 2 + k * 14, 0, 2 * Math.PI);
      ctx.stroke();
    } else if (b.kind === 'shield') {
      // A dome over home that flashes and fades.
      ctx.strokeStyle = COLORS.shield;
      ctx.globalAlpha = (1 - k) * 0.9;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(p[0], p[1], 18 + k * 6, Math.PI * 1.05, Math.PI * 1.95);
      ctx.stroke();
    } else {
      // The interception: a starburst of shards.
      ctx.strokeStyle = COLORS.geo;
      ctx.lineWidth = 1.2;
      const spin = (b.tt || 0) * 7;
      for (let a = 0; a < 10; a++) {
        const angle = (a / 10) * 2 * Math.PI + spin;
        const r1 = 2 + k * 10;
        const r2 = 4 + k * 22;
        ctx.beginPath();
        ctx.moveTo(p[0] + Math.cos(angle) * r1, p[1] + Math.sin(angle) * r1);
        ctx.lineTo(p[0] + Math.cos(angle) * r2, p[1] + Math.sin(angle) * r2);
        ctx.stroke();
      }
      ctx.fillStyle = COLORS.geo;
      ctx.globalAlpha = (1 - k) * 0.5;
      ctx.beginPath();
      ctx.arc(p[0], p[1], 6 * (1 - k) + 2, 0, 2 * Math.PI);
      ctx.fill();
    }
  }
  ctx.restore();
}

function frame(now) {
  frameId = requestAnimationFrame(frame);
  if (!ctx || document.hidden) {
    last = now;
    return;
  }
  const dt = props.paused ? 0 : Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!props.paused) {
    while (queue.length && queue[0].due <= now) launch(queue.shift().event);
    if (props.mode === 'globe' && !drag) {
      rotate = [rotate[0] + dt * 6, rotate[1]];
      projection.rotate(rotate);
    }
    for (const [id, g] of glow) {
      g.heat *= 1 - dt * 0.6;
      if (g.heat < 0.02) glow.delete(id);
    }
  }
  drawBase();
  drawHome(now);
  drawShots(dt);
  drawBursts(dt);
}

function onPointerDown(e) {
  if (props.picking) {
    const rect = canvas.value.getBoundingClientRect();
    const point = projection?.invert?.([e.clientX - rect.left, e.clientY - rect.top]);
    if (point && Number.isFinite(point[0]) && Number.isFinite(point[1])) emit('pick', point);
    return;
  }
  if (props.mode === 'globe') drag = [e.clientX, e.clientY, ...rotate];
}
function onPointerMove(e) {
  if (!drag) return;
  rotate = [
    drag[2] + (e.clientX - drag[0]) * 0.3,
    Math.max(-60, Math.min(60, drag[3] - (e.clientY - drag[1]) * 0.3)),
  ];
  projection.rotate(rotate);
}
function onPointerUp() {
  drag = null;
}

// Hidden for a while: what queued up meanwhile would land as one volley.
function onVisibility() {
  if (document.hidden) queue.length = 0;
}

watch(
  () => props.mode,
  () => {
    if (props.mode === 'globe')
      rotate = [-props.home[0], -Math.max(-60, Math.min(60, props.home[1]))];
    fit();
  },
);
watch(
  () => props.home,
  () => {
    base = null;
  },
);

onMounted(() => {
  fit();
  resizer = new ResizeObserver(() => fit());
  resizer.observe(canvas.value);
  globalThis.addEventListener('pointermove', onPointerMove);
  globalThis.addEventListener('pointerup', onPointerUp);
  document.addEventListener('visibilitychange', onVisibility);
  last = performance.now();
  frameId = requestAnimationFrame(frame);
});
onUnmounted(() => {
  cancelAnimationFrame(frameId);
  resizer?.disconnect();
  globalThis.removeEventListener('pointermove', onPointerMove);
  globalThis.removeEventListener('pointerup', onPointerUp);
  document.removeEventListener('visibilitychange', onVisibility);
});
</script>

<style scoped>
.resolution-canvas {
  display: block;
  width: 100%;
  height: 100%;
  touch-action: none;
}
.resolution-canvas.turning {
  cursor: grab;
}
.resolution-canvas.picking {
  cursor: crosshair;
}
</style>
