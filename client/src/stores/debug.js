import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

export const useDebugStore = defineStore('debug', () => {
  const entries = ref([]);
  const maxEntries = 200;

  const maxAgeMs = 24 * 60 * 60 * 1000; // 1 day retention

  function pruneOld() {
    const cutoff = Date.now() - maxAgeMs;
    entries.value = entries.value.filter(e => e.timestamp.getTime() > cutoff);
  }

  function add(type, message, detail = null) {
    pruneOld();
    entries.value.unshift({
      id: Date.now() + Math.random(),
      type,
      message,
      detail,
      timestamp: new Date()
    });
    if (entries.value.length > maxEntries) {
      entries.value.length = maxEntries;
    }
  }

  function logError(message, detail) { add('error', message, detail); }
  function logWarn(message, detail) { add('warn', message, detail); }
  function logInfo(message, detail) { add('info', message, detail); }
  function logApi(message, detail) { add('api', message, detail); }

  function clear() { entries.value = []; }

  const errorCount = computed(() => entries.value.filter(e => e.type === 'error').length);

  return { entries, errorCount, logError, logWarn, logInfo, logApi, clear };
});
