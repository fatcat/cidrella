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
  status: '',
  type: '',
  online: '',
  scan: '',
  range: '',
  protocol: '',
});

const CONTEXTS = new Set(['all', 'folder', 'network', 'unallocated']);
const VIEWS = new Set(['networks', 'addresses', 'dns', 'dhcp', 'ranges']);
const PRESENTATIONS = new Set(['table', 'grid', 'compact']);

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
    status: typeof query.status === 'string' ? query.status : '',
    type: typeof query.type === 'string' ? query.type : '',
    online: ['true', 'false'].includes(query.online) ? query.online : '',
    scan: ['true', 'false'].includes(query.scan) ? query.scan : '',
    range: positiveInteger(query.range)?.toString() || '',
    protocol: typeof query.protocol === 'string' ? query.protocol : '',
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
  for (const key of ['status', 'type', 'online', 'scan', 'range', 'protocol']) {
    if (state[key]) query[key] = String(state[key]);
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
