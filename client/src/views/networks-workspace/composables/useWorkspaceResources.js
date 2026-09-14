import { reactive } from 'vue';
import api from '../../../api/client.js';
import { apiError } from '../../../utils/format.js';

function resourceState(initial) {
  return reactive({ data: initial, loading: false, error: '', request: 0 });
}

function envelope(response, fallback = []) {
  const data = response.data || {};
  return {
    items: Array.isArray(data) ? data : data.items || fallback,
    total: Array.isArray(data) ? data.length : Number(data.total ?? data.filteredTotal ?? 0),
    page: Number(data.page || 1),
    pageSize: Number(data.page_size || data.pageSize || 0),
  };
}

export function useWorkspaceResources({ can, onForbidden = null }) {
  const resources = {
    tree: resourceState({ folders: [] }),
    networks: resourceState({ items: [], total: 0 }),
    zones: resourceState([]),
    dns: resourceState({ items: [], total: 0, page: 1, pageSize: 50 }),
    dnsTotal: resourceState(0),
    scopes: resourceState([]),
    dhcp: resourceState({ items: [], total: 0, page: 1, pageSize: 50 }),
    dhcpTotal: resourceState(0),
    addresses: resourceState({
      items: [],
      ranges: [],
      total: 0,
      filteredTotal: 0,
      page: 1,
      totalPages: 1,
    }),
    summary: resourceState(null),
    detail: resourceState(null),
  };

  async function read(key, permission, request, map = (response) => response.data) {
    const state = resources[key];
    const generation = ++state.request;
    if (!can(permission)) {
      state.loading = false;
      state.error = '';
      return null;
    }
    state.loading = true;
    state.error = '';
    try {
      const response = await request();
      if (generation !== state.request) return null;
      state.data = map(response);
      return state.data;
    } catch (error) {
      if (generation === state.request) state.error = apiError(error);
      if (error?.response?.status === 403 && onForbidden) await onForbidden(permission);
      return null;
    } finally {
      if (generation === state.request) state.loading = false;
    }
  }

  const compactParams = (params) =>
    Object.fromEntries(
      Object.entries(params || {}).filter(([, value]) => value !== '' && value != null),
    );

  function loadTree() {
    return read('tree', 'subnets:read', () => api.get('/subnets'));
  }
  function loadNetworks(params = {}) {
    return read(
      'networks',
      'subnets:read',
      () => api.get('/workspace/networks', { params: compactParams(params) }),
      (response) => envelope(response),
    );
  }
  function loadZones(params = {}) {
    return read('zones', 'dns:read', () =>
      api.get('/dns/zones', { params: compactParams({ include_networks: 'true', ...params }) }),
    );
  }
  function loadDns(params = {}) {
    return read(
      'dns',
      'dns:read',
      () => api.get('/workspace/dns-records', { params: compactParams(params) }),
      (response) => envelope(response),
    );
  }
  function loadDnsTotal(params = {}) {
    return read(
      'dnsTotal',
      'dns:read',
      () =>
        api.get('/workspace/dns-records', {
          params: compactParams({ ...params, page: 1, page_size: 1 }),
        }),
      (response) => Number(response.data?.total || 0),
    );
  }
  function loadScopes(params = {}) {
    return read('scopes', 'dhcp:read', () =>
      api.get('/dhcp/scopes', { params: compactParams(params) }),
    );
  }
  function loadDhcp(params = {}) {
    return read(
      'dhcp',
      'dhcp:read',
      () => api.get('/workspace/dhcp-addresses', { params: compactParams(params) }),
      (response) => envelope(response),
    );
  }
  function loadDhcpTotal(params = {}) {
    return read(
      'dhcpTotal',
      'dhcp:read',
      () =>
        api.get('/workspace/dhcp-addresses', {
          params: compactParams({ ...params, page: 1, page_size: 1 }),
        }),
      (response) => Number(response.data?.total || 0),
    );
  }
  function loadAddresses(subnetId, params = {}) {
    return read(
      'addresses',
      'subnets:read',
      () => api.get(`/subnets/${subnetId}/ips`, { params: compactParams(params) }),
      (response) => ({
        items: response.data.ips || [],
        ranges: response.data.ranges || [],
        total: Number(response.data.totalIps || 0),
        filteredTotal: Number(response.data.filteredTotal ?? response.data.totalIps ?? 0),
        page: Number(response.data.page || 1),
        totalPages: Number(response.data.totalPages || 1),
      }),
    );
  }
  function loadSummary(subnetId) {
    return read('summary', 'subnets:read', () => api.get(`/subnets/${subnetId}/summary`));
  }
  function loadAddressDetail(subnetId, ip) {
    return read(
      'detail',
      'subnets:read',
      () => api.get(`/subnets/${subnetId}/ips/${encodeURIComponent(ip)}`),
      (response) => response.data.ip,
    );
  }
  function invalidate(...keys) {
    for (const key of keys) if (resources[key]) resources[key].request += 1;
  }

  return {
    resources,
    loadTree,
    loadNetworks,
    loadZones,
    loadDns,
    loadDnsTotal,
    loadScopes,
    loadDhcp,
    loadDhcpTotal,
    loadAddresses,
    loadSummary,
    loadAddressDetail,
    invalidate,
  };
}
