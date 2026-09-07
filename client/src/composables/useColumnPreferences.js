import { computed, ref } from 'vue';
import { saveJson } from '../utils/storage.js';

function readKeys(storageKey, defaults, aliases) {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey));
    if (Array.isArray(parsed)) {
      return [...new Set(parsed.map(key => aliases[key] || key))];
    }
  } catch {}
  return defaults;
}

export function useColumnPreferences(storageKey, columns, options = {}) {
  const defaultKeys = options.defaultKeys || columns.map(c => c.key);
  const aliases = options.aliases || {};
  const visibleKeys = ref(readKeys(storageKey, defaultKeys, aliases));

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
    const byKey = new Map(columns.map(c => [c.key, c]));
    setVisibleColumns(defaultKeys.map(key => byKey.get(key)).filter(Boolean));
  }

  return {
    visibleColumns,
    setVisibleColumns,
    resetColumns
  };
}
