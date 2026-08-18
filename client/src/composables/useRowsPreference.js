import { ref, watch } from 'vue';
import { saveJson } from '../utils/storage.js';

export function useRowsPreference(storageKey, defaultRows = 100, allowedRows = [50, 100, 250, 500]) {
  const rows = ref(defaultRows);

  try {
    const saved = Number(JSON.parse(localStorage.getItem(storageKey)));
    if (allowedRows.includes(saved)) rows.value = saved;
  } catch {
    // Keep default.
  }

  watch(rows, (value) => {
    if (!allowedRows.includes(value)) return;
    saveJson(storageKey, value)
  });

  function onPage(event) {
    if (allowedRows.includes(event.rows)) rows.value = event.rows;
  }

  return { rows, onPage };
}
