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
    facets: resourceState(null),
    detail: resourceState(null),
    // What references the pinned address (details panel related resources).
    relatedDns: resourceState([]),
    relatedDhcp: resourceState([]),
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
        // An IPv6 network returns only the addresses it holds rows for.
        sparse: response.data.sparse === true,
      }),
    );
  }
  // The filter counts of one IP table, over its whole result. One row is
  // enough: only the facets and the column kinds are wanted.
  function loadFacets(view, { subnetId = null, ...params } = {}) {
    const request =
      view === 'addresses'
        ? () =>
            api.get(`/subnets/${subnetId}/ips`, {
              params: compactParams({ ...params, facets: 1, page: 1, pageSize: 1 }),
            })
        : () =>
            api.get(view === 'dns' ? '/workspace/dns-records' : '/workspace/dhcp-addresses', {
              params: compactParams({ ...params, facets: 1, page: 1, page_size: 1 }),
            });
    return read(
      'facets',
      view === 'dhcp' ? 'dhcp:read' : view === 'dns' ? 'dns:read' : 'subnets:read',
      request,
      (response) => ({
        facets: response.data?.facets || {},
        filter_kinds: response.data?.filter_kinds || null,
      }),
    );
  }
  function loadSummary(subnetId) {
    return read('summary', 'subnets:read', () => api.get(`/subnets/${subnetId}/summary`));
  }
  function loadRelatedDns(subnetId, ip) {
    return read(
      'relatedDns',
      'dns:read',
      () =>
        api.get('/workspace/dns-records', {
          params: { subnet_id: subnetId, ip_address: ip, page_size: 50 },
        }),
      (response) => response.data.items || [],
    );
  }
  function loadRelatedDhcp(subnetId, ip) {
    return read(
      'relatedDhcp',
      'dhcp:read',
      () =>
        api.get('/workspace/dhcp-addresses', {
          params: { subnet_id: subnetId, ip_address: ip, page_size: 50 },
        }),
      (response) => response.data.items || [],
    );
  }
  function loadAddressDetail(subnetId, ip) {
    return read(
      'detail',
      'subnets:read',
      () => api.get(`/subnets/${subnetId}/ips/${encodeURIComponent(ip)}`),
      (response) => response.data.ip,
    );
  }
  // The details panel pins a resource by identity, not by page row (W-06).
  // There is no single-record read for DNS records or DHCP addresses, so a
  // pinned row that fell off the current page is re-read through the
  // workspace list with the narrowest filter available and matched by ID.
  // All three detail reads share the `detail` generation so a late response
  // for a previous pin is dropped.
  function loadDnsRecordDetail({ zoneId, subnetId, name, recordId }) {
    return read(
      'detail',
      'dns:read',
      () =>
        api.get('/workspace/dns-records', {
          params: compactParams({
            zone_id: zoneId,
            subnet_id: subnetId,
            table_q: name,
            page: 1,
            page_size: 256,
          }),
        }),
      (response) =>
        (envelope(response).items || []).find((item) => Number(item.id) === Number(recordId)) ||
        null,
    );
  }
  function loadDhcpAddressDetail({ subnetId, scopeId, ip }) {
    return read(
      'detail',
      'dhcp:read',
      () =>
        api.get('/workspace/dhcp-addresses', {
          params: compactParams({
            subnet_id: subnetId,
            scope_id: scopeId,
            table_q: ip,
            page: 1,
            page_size: 256,
          }),
        }),
      (response) => (envelope(response).items || []).find((item) => item.ip_address === ip) || null,
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
    loadFacets,
    loadAddressDetail,
    loadRelatedDns,
    loadRelatedDhcp,
    loadDnsRecordDetail,
    loadDhcpAddressDetail,
    invalidate,
  };
}
