import { ref, computed } from 'vue';
import api from '../api/client.js';

/**
 * One family's DHCP option catalog, as GET /dhcp/options answers it, with the
 * rows grouped the way the option tables show them. `load` returns the whole
 * response, so a caller can read the saved and shipped defaults from it.
 */
export function useDhcpOptionCatalog(family) {
  const catalog = ref([]);
  const groups = ref([]);
  const customRange = ref([128, 254]);
  const loading = ref(false);

  const rows = computed(() => {
    const byGroup = new Map();
    for (const opt of catalog.value) {
      const name = opt.group || 'Common';
      if (!byGroup.has(name)) byGroup.set(name, []);
      byGroup.get(name).push(opt);
    }
    const ordered = [
      ...groups.value.filter((g) => byGroup.has(g.name)),
      ...[...byGroup.keys()]
        .filter((name) => !groups.value.some((g) => g.name === name))
        .map((name) => ({ name, label: name })),
    ];
    return ordered.flatMap((g) =>
      byGroup.get(g.name).map((opt) => ({ ...opt, _group: g.label || g.name })),
    );
  });

  async function load() {
    loading.value = true;
    try {
      const res = await api.get('/dhcp/options', { params: { family: family() } });
      catalog.value = res.data.catalog;
      if (res.data.groups) groups.value = res.data.groups;
      if (Array.isArray(res.data.customRange)) customRange.value = res.data.customRange;
      return res.data;
    } finally {
      loading.value = false;
    }
  }

  return { catalog, rows, customRange, loading, load };
}

/** Replace a reactive code-keyed object's entries in place. */
export function fillByCode(target, entries) {
  for (const key of Object.keys(target)) delete target[key];
  for (const [code, value] of entries) target[Number(code)] = value;
}

/**
 * The { options, enabledDefaults } body the option editors send: every value
 * set for a catalog option, and the checked codes.
 */
export function optionEditorPayload(catalog, values, enabled) {
  const options = [];
  for (const opt of catalog) {
    const val = values[opt.code];
    if (val != null && val !== '') options.push({ code: opt.code, value: String(val) });
  }
  const enabledDefaults = Object.keys(enabled)
    .filter((code) => enabled[code])
    .map(Number);
  return { options, enabledDefaults };
}
