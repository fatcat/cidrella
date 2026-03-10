<template>
  <div class="debug-container">
    <button class="debug-btn" :class="{ 'has-errors': debugStore.errorCount > 0 }" @click="open = !open">
      <i class="pi pi-bug"></i>
      <span class="debug-label">Debug</span>
      <span v-if="debugStore.errorCount > 0" class="error-badge">{{ debugStore.errorCount }}</span>
    </button>

    <div v-if="open" class="debug-panel">
      <div class="debug-header">
        <span class="debug-title">Debug Console</span>
        <div class="debug-actions">
          <select v-model="filter" class="debug-filter">
            <option value="all">All</option>
            <option value="error">Errors</option>
            <option value="warn">Warnings</option>
            <option value="api">API</option>
            <option value="info">Info</option>
          </select>
          <button class="debug-action" title="Clear" @click="debugStore.clear()">
            <i class="pi pi-trash"></i>
          </button>
          <button class="debug-action" title="Close" @click="open = false">
            <i class="pi pi-times"></i>
          </button>
        </div>
      </div>

      <div class="debug-info-bar">
        <span>Vue {{ vueVersion }}</span>
        <span>Session {{ sessionDuration }}</span>
        <span>Entries: {{ filteredEntries.length }}</span>
      </div>

      <div class="debug-entries">
        <div v-if="filteredEntries.length === 0" class="debug-empty">No entries</div>
        <div v-for="entry in filteredEntries" :key="entry.id"
             class="debug-entry" :class="'entry-' + entry.type"
             @click="expandedId = expandedId === entry.id ? null : entry.id">
          <div class="entry-row">
            <span class="entry-type">{{ entry.type.toUpperCase() }}</span>
            <span class="entry-msg">{{ entry.message }}</span>
            <span class="entry-time">{{ formatTime(entry.timestamp) }}</span>
          </div>
          <pre v-if="expandedId === entry.id && entry.detail" class="entry-detail">{{ formatDetail(entry.detail) }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { version as vueVersion } from 'vue';
import { useDebugStore } from '../stores/debug.js';

const debugStore = useDebugStore();
const open = ref(false);
const filter = ref('all');
const expandedId = ref(null);
const sessionStart = Date.now();
const now = ref(Date.now());
let timer;

const filteredEntries = computed(() => {
  if (filter.value === 'all') return debugStore.entries;
  return debugStore.entries.filter(e => e.type === filter.value);
});

const sessionDuration = computed(() => {
  const ms = now.value - sessionStart;
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
});

function formatTime(date) {
  return date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDetail(detail) {
  if (typeof detail === 'string') return detail;
  try { return JSON.stringify(detail, null, 2); } catch { return String(detail); }
}

onMounted(() => {
  debugStore.logInfo('Debug panel initialized');
  timer = setInterval(() => { now.value = Date.now(); }, 60000);
});

onUnmounted(() => {
  clearInterval(timer);
});
</script>

<style scoped>
.debug-container {
  position: fixed;
  bottom: 1rem;
  right: 1rem;
  z-index: 9999;
}

.debug-btn {
  height: 28px;
  padding: 0 0.6rem;
  border-radius: 6px;
  border: 1px solid var(--p-surface-border);
  background: var(--p-surface-card);
  color: var(--p-text-muted-color);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  position: relative;
  font-size: 0.8rem;
  transition: all 0.15s;
}
.debug-btn:hover {
  background: var(--p-surface-hover);
  color: var(--p-text-color);
}
.debug-btn.has-errors {
  border-color: var(--p-red-500);
  color: var(--p-red-500);
}

.debug-label {
  font-size: 0.7rem;
  font-weight: 600;
}

.error-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  background: var(--p-red-500);
  color: var(--p-surface-0);
  font-size: 0.6rem;
  font-weight: 700;
  min-width: 16px;
  height: 16px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 3px;
}

.debug-panel {
  position: absolute;
  bottom: 44px;
  right: 0;
  width: 520px;
  max-height: 400px;
  background: var(--p-surface-card);
  border: 1px solid var(--p-surface-border);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 4px 24px rgba(0,0,0,0.2);
}

.debug-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--p-surface-border);
  flex-shrink: 0;
}
.debug-title {
  font-weight: 600;
  font-size: 0.85rem;
}
.debug-actions {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}
.debug-filter {
  font-size: 0.75rem;
  padding: 0.15rem 0.3rem;
  border: 1px solid var(--p-surface-border);
  border-radius: 4px;
  background: var(--p-surface-ground);
  color: var(--p-text-color);
}
.debug-action {
  background: none;
  border: none;
  color: var(--p-text-muted-color);
  cursor: pointer;
  padding: 0.2rem;
  font-size: 0.8rem;
}
.debug-action:hover { color: var(--p-text-color); }

.debug-info-bar {
  display: flex;
  gap: 1rem;
  padding: 0.3rem 0.75rem;
  font-size: 0.7rem;
  color: var(--p-text-muted-color);
  border-bottom: 1px solid var(--p-surface-border);
  flex-shrink: 0;
}

.debug-entries {
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}
.debug-empty {
  padding: 2rem;
  text-align: center;
  color: var(--p-text-muted-color);
  font-size: 0.8rem;
}

.debug-entry {
  padding: 0.35rem 0.75rem;
  border-bottom: 1px solid var(--p-surface-border);
  cursor: pointer;
  font-size: 0.75rem;
}
.debug-entry:hover { background: var(--p-surface-hover); }

.entry-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.entry-type {
  font-weight: 700;
  font-size: 0.65rem;
  padding: 0.05rem 0.3rem;
  border-radius: 3px;
  flex-shrink: 0;
}
.entry-error .entry-type { background: color-mix(in srgb, var(--p-red-500) 20%, transparent); color: var(--p-red-500); }
.entry-warn .entry-type { background: color-mix(in srgb, var(--p-yellow-500) 20%, transparent); color: var(--p-yellow-500); }
.entry-api .entry-type { background: color-mix(in srgb, var(--p-blue-500) 20%, transparent); color: var(--p-blue-500); }
.entry-info .entry-type { background: color-mix(in srgb, var(--p-indigo-500) 20%, transparent); color: var(--p-indigo-500); }

.entry-msg {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.entry-time {
  color: var(--p-text-muted-color);
  font-size: 0.65rem;
  flex-shrink: 0;
}

.entry-detail {
  margin: 0.35rem 0 0;
  padding: 0.4rem;
  background: var(--p-surface-ground);
  border-radius: 4px;
  font-size: 0.7rem;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 150px;
  overflow-y: auto;
}
</style>
