<template>
  <div class="log-viewer">
    <div class="log-toolbar">
      <div class="log-tabs">
        <button :class="['log-tab', { active: activeFilter === 'all' }]" @click="switchFilter('all')">All</button>
        <button :class="['log-tab', { active: activeFilter === 'dns' }]" @click="switchFilter('dns')">DNS</button>
        <button :class="['log-tab', { active: activeFilter === 'dhcp' }]" @click="switchFilter('dhcp')">DHCP</button>
      </div>
      <div class="log-actions">
        <InputText v-model="searchText" placeholder="Filter..." size="small" class="log-search" />
        <Button icon="pi pi-pause" v-if="!paused" size="small" severity="secondary" text
                title="Pause auto-scroll" @click="paused = true" />
        <Button icon="pi pi-play" v-else size="small" severity="success" text
                title="Resume auto-scroll" @click="resumeScroll" />
        <Button icon="pi pi-trash" size="small" severity="danger" text
                title="Clear logs" @click="clearLogs" />
      </div>
    </div>
    <div class="log-status">
      <span :class="['status-dot', connected ? 'connected' : 'disconnected']"></span>
      {{ connected ? 'Live' : 'Disconnected' }}
      <span class="log-count">{{ filteredLines.length }} lines</span>
    </div>
    <pre ref="logPre" class="log-output" @scroll="onScroll"><template v-for="(line, i) in filteredLines" :key="i"><span :class="lineClass(line)">{{ line }}</span>
</template></pre>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import { useAuthStore } from '../stores/auth.js';

const auth = useAuthStore();
const logPre = ref(null);
const lines = ref([]);
const connected = ref(false);
const paused = ref(false);
const searchText = ref('');
const activeFilter = ref('all');
const MAX_LINES = 5000;

let eventSource = null;

const filteredLines = computed(() => {
  if (!searchText.value) return lines.value;
  const term = searchText.value.toLowerCase();
  return lines.value.filter(l => l.toLowerCase().includes(term));
});

function lineClass(line) {
  if (/DHCP(DISCOVER|OFFER|REQUEST|ACK|NAK|RELEASE|INFORM|DECLINE)/i.test(line)) return 'log-dhcp';
  if (/query\[/i.test(line)) return 'log-query';
  if (/reply|cached/i.test(line)) return 'log-reply';
  if (/forwarded/i.test(line)) return 'log-forward';
  return '';
}

function connect() {
  if (eventSource) {
    eventSource.close();
  }

  const url = `/api/logs/stream?filter=${activeFilter.value}&token=${encodeURIComponent(auth.token)}`;
  eventSource = new EventSource(url);

  eventSource.addEventListener('connected', () => {
    connected.value = true;
  });

  eventSource.addEventListener('backlog-end', () => {
    scrollToBottom();
  });

  eventSource.onmessage = (event) => {
    lines.value.push(event.data);
    if (lines.value.length > MAX_LINES) {
      lines.value.splice(0, lines.value.length - MAX_LINES);
    }
    if (!paused.value) {
      nextTick(scrollToBottom);
    }
  };

  eventSource.onerror = () => {
    connected.value = false;
  };
}

function switchFilter(filter) {
  activeFilter.value = filter;
  lines.value = [];
  connect();
}

function scrollToBottom() {
  if (logPre.value) {
    logPre.value.scrollTop = logPre.value.scrollHeight;
  }
}

function onScroll() {
  if (!logPre.value) return;
  const el = logPre.value;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  if (atBottom && paused.value) {
    paused.value = false;
  }
}

function resumeScroll() {
  paused.value = false;
  nextTick(scrollToBottom);
}

async function clearLogs() {
  try {
    const { default: api } = await import('../api/client.js');
    await api.post('/logs/clear');
    lines.value = [];
  } catch { /* ignore */ }
}

onMounted(() => {
  connect();
});

onUnmounted(() => {
  if (eventSource) {
    eventSource.close();
  }
});
</script>

<style scoped>
.log-viewer {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 400px;
}

.log-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.4rem 0.6rem;
  background: var(--p-surface-ground);
  border-bottom: 1px solid var(--p-surface-border);
  border-radius: 6px 6px 0 0;
  gap: 0.5rem;
}

.log-tabs {
  display: flex;
  gap: 2px;
}

.log-tab {
  padding: 0.3rem 0.75rem;
  border: none;
  background: transparent;
  color: var(--p-text-muted-color);
  font-size: 0.8rem;
  font-weight: 600;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s;
}
.log-tab:hover { background: var(--p-surface-hover); }
.log-tab.active {
  background: var(--p-primary-color);
  color: var(--p-primary-contrast-color);
}

.log-actions {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.log-search {
  width: 160px;
  font-size: 0.8rem;
}

.log-status {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.2rem 0.6rem;
  font-size: 0.7rem;
  color: var(--p-text-muted-color);
  background: var(--p-surface-ground);
  border-bottom: 1px solid var(--p-surface-border);
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.status-dot.connected { background: #22c55e; }
.status-dot.disconnected { background: #ef4444; }

.log-count {
  margin-left: auto;
}

.log-output {
  flex: 1;
  margin: 0;
  padding: 0.5rem 0.75rem;
  background: #0d1117;
  color: #c9d1d9;
  font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
  font-size: 0.75rem;
  line-height: 1.5;
  overflow-y: auto;
  overflow-x: auto;
  white-space: pre;
  border-radius: 0 0 6px 6px;
  min-height: 300px;
}

.log-output .log-dhcp { color: #f0883e; }
.log-output .log-query { color: #58a6ff; }
.log-output .log-reply { color: #3fb950; }
.log-output .log-forward { color: #d2a8ff; }
</style>
