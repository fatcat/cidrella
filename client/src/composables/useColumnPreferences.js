import { computed, ref } from 'vue';
import { saveJson } from '../utils/storage.js';

function readKeys(storageKey, defaults) {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey));
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  return defaults;
}

export function useColumnPreferences(storageKey, columns) {
  const defaultKeys = columns.map(c => c.key);
  const visibleKeys = ref(readKeys(storageKey, defaultKeys));

  const normalizedKeys = computed(() => {
    const valid = new Set(columns.map(c => c.key));
    return visibleKeys.value.filter(k => valid.has(k));
  });

  const visibleColumns = computed(() => {
    const byKey = new Map(columns.map(c => [c.key, c]));
    return normalizedKeys.value.map(k => byKey.get(k)).filter(Boolean);
  });

  function setVisibleColumns(nextColumns) {
    visibleKeys.value = nextColumns.map(c => c.key);
    saveJson(storageKey, visibleKeys.value)
  }

  function resetColumns() {
    setVisibleColumns(columns);
  }

  return {
    visibleColumns,
    setVisibleColumns,
    resetColumns
  };
}
