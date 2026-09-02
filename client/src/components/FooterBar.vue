<template>
  <footer class="footer-bar">
    <span v-if="env" class="foot-chip" :class="env === 'prod' ? 'env-prod' : 'env-dev'">
      <span class="foot-dot"></span>{{ env }}
    </span>
    <span v-if="version" class="foot-item">v{{ version }}</span>
    <span v-if="lastSyncText" class="foot-item">SYNCED {{ lastSyncText }}</span>
    <span class="foot-push"></span>
    <span v-if="sessionText" class="foot-item" :class="{ 'session-amber': sessionExpiringSoon }">
      SESSION {{ sessionText }}
    </span>
  </footer>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { formatRelativeTime } from '../utils/dateFormat.js';
import { EMPTY_CELL } from '../utils/format.js';
import { useAuthStore } from '../stores/auth.js';
import api from '../api/client.js';

const auth = useAuthStore();

const env = import.meta.env.DEV ? 'dev' : 'prod';
const version = ref(null);
const lastSync = ref(null);
const now = ref(Date.now());

// Parse JWT exp claim without a library. JWTs are base64url(header).body.signature.
function parseJwtExp(token) {
  if (!token) return null;
  try {
    const payload = token.split('.')[1];
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const { exp } = JSON.parse(json);
    return exp ? exp * 1000 : null;
  } catch { return null; }
}

const sessionExpiresAt = computed(() => parseJwtExp(auth.token));

const sessionText = computed(() => {
  if (!sessionExpiresAt.value) return null;
  const remaining = Math.max(0, sessionExpiresAt.value - now.value);
  const totalMin = Math.floor(remaining / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (h > 0) return `${pad(h)}H${pad(m)}M`;
  return `${pad(m)}M`;
});

const sessionExpiringSoon = computed(() => {
  if (!sessionExpiresAt.value) return false;
  return (sessionExpiresAt.value - now.value) < 120_000; // < 2 min
});

const lastSyncText = computed(() => {
  if (!lastSync.value) return null;
  // Reading the shared clock keeps this recomputing every tick.
  // formatRelativeTime reads Date.now() itself, so without this the footer
  // would freeze at whatever it said when the component mounted.
  void now.value;
  // The local copy that used to live here had no days bucket and no finite
  // guard, so 30 hours rendered "30h AGO" and an unparseable timestamp
  // rendered "NaNh AGO" (duplicate-logic audit #57, sibling of #42).
  const rel = formatRelativeTime(lastSync.value);
  if (rel === EMPTY_CELL) return null;
  // The footer is uppercase by design, hence the fold rather than a second
  // formatter.
  return rel.toUpperCase();
});

async function fetchVersion() {
  try {
    const res = await api.get('/health/system');
    version.value = res.data?.version || null;
    lastSync.value = Date.now();
  } catch { /* keep previous value */ }
}

let tick, poll;
onMounted(() => {
  fetchVersion();
  tick = setInterval(() => { now.value = Date.now(); }, 1000);
  poll = setInterval(fetchVersion, 60_000);
});
onUnmounted(() => {
  if (tick) clearInterval(tick);
  if (poll) clearInterval(poll);
});
</script>

<style scoped>
.footer-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  height: 28px;
  padding: 0 12px;
  background: var(--p-surface-card);
  border-top: 1px solid var(--p-surface-border);
  font-family: monospace;
  font-size: var(--app-fs-xs);
  letter-spacing: 0.04em;
  color: var(--p-text-muted-color);
  flex-shrink: 0;
  user-select: none;
}
.foot-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  text-transform: uppercase;
  font-weight: 600;
  letter-spacing: 0.08em;
}
.foot-dot {
  width: 6px; height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.env-prod { color: var(--p-primary-color); }
.env-dev  { color: var(--p-orange-500); }
.foot-item {
  text-transform: uppercase;
  letter-spacing: 0.08em;
  white-space: nowrap;
}
.foot-push { flex: 1; }
.session-amber {
  color: var(--p-orange-500);
  font-weight: 600;
}
</style>
