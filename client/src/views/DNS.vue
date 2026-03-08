<template>
  <div class="dns-page" style="display: flex; flex-direction: column; height: 100%;">
    <div class="forwarders-list">
      <div v-for="(fwd, i) in forwarders" :key="i" class="forwarder-entry">
        <span class="status-dot" :class="dotClass(fwd)"></span>
        <InputText v-model="forwarders[i].ip" size="small" placeholder="e.g. 8.8.8.8" style="width: 12rem"
                   @blur="onForwarderBlur(i)" @keyup.enter="onForwarderBlur(i)" />
        <i v-if="fwd.status === 'testing'" class="pi pi-spin pi-spinner fwd-testing"></i>
        <Button icon="pi pi-trash" severity="danger" text rounded size="small"
                @click="removeForwarder(i)" v-if="forwarders.length > 1" title="Remove" />
      </div>
      <div class="forwarder-actions">
        <Button label="Add Forwarder" icon="pi pi-plus" size="small" severity="secondary"
                @click="addForwarder" />
        <Button label="Save" icon="pi pi-save" size="small" data-track="dns-save-forwarders"
                @click="saveForwarders" :loading="savingForwarders" />
      </div>
      <p class="forwarder-hint">
        Forwarders are tested via DNS resolution on entry and every 15 minutes.
        A failed test is retried once after 5 seconds before marking as down.
      </p>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { useToast } from 'primevue/usetoast';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import { useDnsStore } from '../stores/dns.js';

const store = useDnsStore();
const toast = useToast();

const forwarders = ref([]);
const savingForwarders = ref(false);
let pollTimer = null;

const ipv4Re = /^(\d{1,3}\.){3}\d{1,3}$/;

function dotClass(fwd) {
  if (fwd.status === 'reachable') return 'dot-up';
  if (fwd.status === 'unreachable') return 'dot-down';
  return 'dot-unknown';
}

function addForwarder() {
  forwarders.value.push({ ip: '', status: null });
}

function removeForwarder(i) {
  forwarders.value.splice(i, 1);
}

async function onForwarderBlur(i) {
  const fwd = forwarders.value[i];
  if (!fwd) return;
  const ip = fwd.ip.trim();
  if (!ip || !ipv4Re.test(ip)) {
    fwd.status = null;
    return;
  }
  fwd.status = 'testing';
  try {
    const result = await store.testForwarder(ip);
    fwd.status = result.reachable ? 'reachable' : 'unreachable';
  } catch {
    fwd.status = 'unreachable';
  }
}

async function testAllForwarders() {
  for (const fwd of forwarders.value) {
    const ip = fwd.ip.trim();
    if (!ip || !ipv4Re.test(ip)) continue;
    fwd.status = 'testing';
    try {
      const result = await store.testForwarder(ip);
      fwd.status = result.reachable ? 'reachable' : 'unreachable';
    } catch {
      fwd.status = 'unreachable';
    }
  }
}

async function saveForwarders() {
  savingForwarders.value = true;
  try {
    const servers = forwarders.value.map(f => f.ip.trim()).filter(Boolean);
    await store.updateForwarders(servers);
    toast.add({ severity: 'success', summary: 'Forwarders saved', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    savingForwarders.value = false;
  }
}

onMounted(async () => {
  try {
    const servers = await store.getForwarders();
    forwarders.value = servers.map(ip => ({ ip, status: null }));
  } catch {
    forwarders.value = [{ ip: '8.8.8.8', status: null }, { ip: '1.1.1.1', status: null }];
  }
  testAllForwarders();
  pollTimer = setInterval(testAllForwarders, 15 * 60 * 1000);
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<style scoped>
.forwarders-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  max-width: 28rem;
}
.forwarder-entry {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.forwarder-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.25rem;
}
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.dot-up { background: #22c55e; }
.dot-down { background: #ef4444; }
.dot-unknown { background: var(--p-surface-400); }
.fwd-testing { color: var(--p-text-muted-color); font-size: 0.85rem; }
.forwarder-hint {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
  margin: 0.25rem 0 0;
  line-height: 1.4;
}
</style>
