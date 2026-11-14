import { ref, computed } from 'vue';
import api from '../api/client.js';
import { leaseSeconds } from '@shared/lease-time.js';

/**
 * DHCPv6 has no lease-time option: a scope's lease_time goes out as the
 * IA_NA lifetimes (stateful) or the RA prefix lifetimes (stateless, SLAAC).
 * The DHCPv6 option tables show it as an Address lifetime row keyed 0, a
 * code DHCPv6 reserves, so the code-keyed values and checks hold it beside
 * the options; requests carry it as `leaseTime`, never as an option.
 */
export const LIFETIME_KEY = 0;
export const ADDRESS_LIFETIME_ROW = Object.freeze({
  code: LIFETIME_KEY,
  label: 'Address lifetime',
  type: 'seconds',
  group: 'Common',
  lease: true,
  description:
    'How long a client keeps an address, in seconds. Stateful: the valid and preferred ' +
    'lifetimes of each lease. Stateless and SLAAC: the lifetimes of the advertised prefix. ' +
    'It is not a DHCPv6 option.',
});

/** A stored lease time ("1h", "3600") as whole seconds, or null. */
export function leaseTimeSeconds(text) {
  const seconds = leaseSeconds(text);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

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
    const entries = Number(family()) === 6 ? [ADDRESS_LIFETIME_ROW, ...catalog.value] : catalog.value;
    for (const opt of entries) {
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
 * The { options, enabledDefaults, leaseTime? } body the option editors send:
 * every value set for a catalog option, the checked codes, and the Address
 * lifetime row's seconds when it is checked and set (DHCPv6 only).
 */
export function optionEditorPayload(catalog, values, enabled) {
  const options = [];
  for (const opt of catalog) {
    const val = values[opt.code];
    if (val != null && val !== '') options.push({ code: opt.code, value: String(val) });
  }
  const enabledDefaults = Object.keys(enabled)
    .map(Number)
    .filter((code) => code !== LIFETIME_KEY && enabled[code]);
  const lifetime = values[LIFETIME_KEY];
  const leaseTime =
    enabled[LIFETIME_KEY] && lifetime != null && lifetime !== '' ? String(lifetime) : undefined;
  return { options, enabledDefaults, ...(leaseTime ? { leaseTime } : {}) };
}

/**
 * The code-keyed values and checks an option set loads into an editor: the
 * DHCPv6 lifetime joins as the LIFETIME_KEY row, `lifetimeChecked` when the
 * editor treats it as on.
 */
export function editorEntries(set, family, { lifetimeChecked = true } = {}) {
  const values = Object.entries(set.defaults || {});
  const enabled = (set.enabledDefaults || []).map((code) => [code, true]);
  if (Number(family) === 6) {
    const seconds = leaseTimeSeconds(set.leaseTime);
    if (seconds) values.push([LIFETIME_KEY, seconds]);
    if (lifetimeChecked) enabled.push([LIFETIME_KEY, true]);
  }
  return { values, enabled };
}
