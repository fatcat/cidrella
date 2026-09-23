import { computed, inject, ref, watch } from 'vue';
import { routeLocationKey, routerKey } from 'vue-router';
import { loadJson, saveJson } from '../../../utils/storage.js';

export const WORKSPACE_CONTEXT_VERSION = 1;
export const WORKSPACE_DEFAULT_STATE = Object.freeze({
  context: 'all',
  folder: null,
  network: null,
  view: 'networks',
  zone: null,
  scope: null,
  ip: null,
  presentation: 'table',
  q: '',
  tableQ: '',
  page: 1,
  pageSize: 256,
  filters: {},
});

const CONTEXTS = new Set(['all', 'folder', 'network', 'unallocated']);
const VIEWS = new Set(['networks', 'addresses', 'dns', 'dhcp', 'ranges']);
const PRESENTATIONS = new Set(['table', 'grid', 'compact']);

// Column filters: { column: [value, ...] }, a value being a string, a
// boolean, or null for "none". Anything else in a hand-edited link is dropped.
function decodeFilters(raw) {
  if (typeof raw !== 'string' || !raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const filters = {};
  for (const [key, values] of Object.entries(parsed)) {
    if (!/^[a-z_]{1,40}$/.test(key) || !Array.isArray(values)) continue;
    const kept = values.filter(
      (value) => value === null || typeof value === 'boolean' || typeof value === 'string',
    );
    if (kept.length) filters[key] = kept;
  }
  return filters;
}

// Links written before column filters (the Dashboard's rogue link among
// them) name a filter by its old key, whose column depended on the table.
const LEGACY_FILTERS = {
  type: { addresses: 'type', dns: 'record_type', dhcp: 'assignment' },
  protocol: { addresses: 'source', dns: 'record_source', dhcp: 'assignment' },
  status: { addresses: 'status' },
};
function legacyFilters(query, view) {
  const filters = {};
  for (const [param, columns] of Object.entries(LEGACY_FILTERS)) {
    const column = columns[view];
    if (column && typeof query[param] === 'string' && query[param])
      filters[column] = [query[param]];
  }
  if (view === 'dns' && ['enabled', 'disabled'].includes(query.status)) {
    filters.record_enabled = [query.status === 'enabled'];
  }
  if (['true', 'false'].includes(query.online)) filters.is_online = [query.online === 'true'];
  if (['true', 'false'].includes(query.scan)) {
    filters.scanning_enabled = [query.scan === 'true'];
  }
  return filters;
}

function positiveInteger(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

export function decodeWorkspaceQuery(query = {}) {
  const context = CONTEXTS.has(query.context) ? query.context : WORKSPACE_DEFAULT_STATE.context;
  const view = VIEWS.has(query.view) ? query.view : WORKSPACE_DEFAULT_STATE.view;
  const presentation = PRESENTATIONS.has(query.presentation)
    ? query.presentation
    : WORKSPACE_DEFAULT_STATE.presentation;
  const state = {
    context,
    folder: positiveInteger(query.folder),
    network: positiveInteger(query.network),
    view,
    zone: positiveInteger(query.zone),
    scope: positiveInteger(query.scope),
    ip: typeof query.ip === 'string' && query.ip ? query.ip : null,
    presentation,
    q: typeof query.q === 'string' ? query.q : '',
    tableQ: typeof query.tableQ === 'string' ? query.tableQ : '',
    page: positiveInteger(query.page) || 1,
    pageSize: positiveInteger(query.pageSize) || WORKSPACE_DEFAULT_STATE.pageSize,
    filters: { ...legacyFilters(query, view), ...decodeFilters(query.filters) },
  };

  if (state.context === 'folder' && !state.folder) state.context = 'all';
  if (state.context === 'network' && !state.network) state.context = 'all';
  if (state.ip && !state.network) state.ip = null;
  return state;
}

export function encodeWorkspaceQuery(state) {
  const query = {};
  if (state.context !== 'all') query.context = state.context;
  if (state.context === 'folder' && positiveInteger(state.folder))
    query.folder = String(state.folder);
  if (state.context === 'network' && positiveInteger(state.network))
    query.network = String(state.network);
  if (state.view !== 'networks') query.view = state.view;
  if (positiveInteger(state.zone)) query.zone = String(state.zone);
  if (positiveInteger(state.scope)) query.scope = String(state.scope);
  if (state.ip && state.network) query.ip = state.ip;
  if (state.presentation !== 'table') query.presentation = state.presentation;
  if (state.q) query.q = state.q;
  if (state.tableQ) query.tableQ = state.tableQ;
  if (state.page > 1) query.page = String(state.page);
  if (state.pageSize !== WORKSPACE_DEFAULT_STATE.pageSize) query.pageSize = String(state.pageSize);
  if (state.filters && Object.keys(state.filters).length) {
    query.filters = JSON.stringify(state.filters);
  }
  return query;
}

function sameQuery(left, right) {
  return (
    JSON.stringify(encodeWorkspaceQuery(decodeWorkspaceQuery(left))) ===
    JSON.stringify(encodeWorkspaceQuery(decodeWorkspaceQuery(right)))
  );
}

export function useWorkspaceContext({ storageKey = 'cidrella_workspace_v1', route, router } = {}) {
  const injectedRoute = route || inject(routeLocationKey, null);
  const injectedRouter = router || inject(routerKey, null);
  const saved = decodeWorkspaceQuery(loadJson(storageKey, {}));
  const hasRouteQuery = Boolean(injectedRoute && Object.keys(injectedRoute.query || {}).length);
  const state = ref(hasRouteQuery ? decodeWorkspaceQuery(injectedRoute.query) : saved);
  const detailIdentity = computed(() =>
    state.value.ip && state.value.network
      ? { kind: 'address', subnetId: state.value.network, ip: state.value.ip }
      : state.value.zone
        ? { kind: 'zone', id: state.value.zone }
        : state.value.scope
          ? { kind: 'scope', id: state.value.scope }
          : null,
  );

  async function navigate(patch, { replace = false } = {}) {
    state.value = decodeWorkspaceQuery({ ...encodeWorkspaceQuery(state.value), ...patch });
    saveJson(storageKey, encodeWorkspaceQuery(state.value));
    if (injectedRouter) {
      await injectedRouter[replace ? 'replace' : 'push']({
        query: encodeWorkspaceQuery(state.value),
      });
    }
  }

  function clearDetails() {
    return navigate({ zone: undefined, scope: undefined, ip: undefined }, { replace: true });
  }

  if (injectedRoute) {
    watch(
      () => injectedRoute.query,
      (query) => {
        if (!sameQuery(query, encodeWorkspaceQuery(state.value)))
          state.value = decodeWorkspaceQuery(query);
      },
      { deep: true },
    );
  }

  return { state, detailIdentity, navigate, clearDetails };
}
