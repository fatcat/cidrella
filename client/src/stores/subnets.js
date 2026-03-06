import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import api from '../api/client.js';

export const useSubnetStore = defineStore('subnets', () => {
  const folders = ref([]);
  const loading = ref(false);

  // Flat count of all subnets for dashboard
  const subnetCount = computed(() => {
    function count(nodes) {
      let c = 0;
      for (const n of nodes) {
        c++;
        if (n.children) c += count(n.children);
      }
      return c;
    }
    let total = 0;
    for (const f of folders.value) {
      if (f.subnets) total += count(f.subnets);
    }
    return total;
  });

  function ipToLong(ip) {
    const parts = ip.split('.').map(Number);
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  }

  // Convert subnet nodes to PrimeVue Tree format
  function toSubnetNodes(nodes) {
    const sorted = [...nodes].sort((a, b) => {
      const aNet = ipToLong(a.network_address);
      const bNet = ipToLong(b.network_address);
      if (aNet !== bNet) return aNet - bNet;
      return a.prefix_length - b.prefix_length;
    });
    return sorted.map(s => ({
      key: `subnet-${s.id}`,
      label: s.status === 'allocated' ? `${s.cidr} — ${s.name}` : s.cidr,
      data: { ...s, type: 'subnet' },
      leaf: (s.child_count || 0) === 0 && (!s.children || s.children.length === 0),
      children: s.children && s.children.length > 0 ? toSubnetNodes(s.children) : undefined,
      styleClass: s.status === 'unallocated' ? 'node-unallocated' : 'node-allocated',
      icon: s.status === 'allocated' ? 'pi pi-check-circle' : 'pi pi-circle'
    }));
  }

  // Full tree with folders as top-level nodes
  const treeNodes = computed(() => {
    return folders.value.map(f => ({
      key: `folder-${f.id}`,
      label: f.name,
      data: { ...f, type: 'folder' },
      leaf: !f.subnets || f.subnets.length === 0,
      children: f.subnets && f.subnets.length > 0 ? toSubnetNodes(f.subnets) : [],
      icon: 'pi pi-folder',
      styleClass: 'node-folder'
    }));
  });

  // Allocated-only tree: flat two-tier (folders -> allocated subnets, no nesting)
  const allocatedTreeNodes = computed(() => {
    function collectAllocated(nodes) {
      const result = [];
      for (const n of nodes) {
        if (n.status === 'allocated') result.push(n);
        if (n.children) result.push(...collectAllocated(n.children));
      }
      return result;
    }
    return folders.value.map(f => {
      const allocated = f.subnets ? collectAllocated(f.subnets) : [];
      const sorted = [...allocated].sort((a, b) => {
        const aNet = ipToLong(a.network_address);
        const bNet = ipToLong(b.network_address);
        if (aNet !== bNet) return aNet - bNet;
        return a.prefix_length - b.prefix_length;
      });
      return {
        key: `folder-${f.id}`,
        label: f.name,
        data: { ...f, type: 'folder' },
        leaf: sorted.length === 0,
        children: sorted.map(s => ({
          key: `subnet-${s.id}`,
          label: s.name ? `${s.cidr} — ${s.name}` : s.cidr,
          data: { ...s, type: 'subnet' },
          leaf: true,
          children: [],
          styleClass: 'node-allocated',
          icon: 'pi pi-check-circle'
        })),
        icon: 'pi pi-building',
        styleClass: 'node-folder'
      };
    });
  });

  // Unallocated tree: flat list of subnet hierarchies (no folder grouping) for browse pane
  const unallocatedTreeNodes = computed(() => {
    function filterForBrowse(nodes) {
      return nodes
        .map(s => {
          const filteredChildren = s.children ? filterForBrowse(s.children) : [];
          if (filteredChildren.length > 0 || s.status === 'unallocated') {
            return { ...s, children: filteredChildren };
          }
          return null;
        })
        .filter(Boolean);
    }
    // Collect all unallocated subnet trees across all folders (no folder nodes)
    const all = [];
    for (const f of folders.value) {
      if (f.subnets) all.push(...filterForBrowse(f.subnets));
    }
    return toSubnetNodes(all);
  });

  // Legacy tree ref for backward compatibility (flat list of all subnets)
  const tree = computed(() => {
    const all = [];
    for (const f of folders.value) {
      if (f.subnets) all.push(...f.subnets);
    }
    return all;
  });

  async function fetchTree() {
    loading.value = true;
    try {
      const res = await api.get('/subnets');
      folders.value = res.data.folders;
    } finally {
      loading.value = false;
    }
  }

  // Folder operations
  async function createFolder(data) {
    const res = await api.post('/folders', data);
    await fetchTree();
    return res.data;
  }

  async function updateFolder(id, data) {
    const res = await api.put(`/folders/${id}`, data);
    await fetchTree();
    return res.data;
  }

  async function deleteFolder(id) {
    const res = await api.delete(`/folders/${id}`);
    await fetchTree();
    return res.data;
  }

  async function fetchFolders() {
    const res = await api.get('/folders');
    return res.data;
  }

  // Subnet operations
  async function createSupernet(data) {
    const res = await api.post('/subnets', data);
    await fetchTree();
    return res.data;
  }

  async function updateSubnet(id, data) {
    const res = await api.put(`/subnets/${id}`, data);
    await fetchTree();
    return res.data;
  }

  async function deleteSubnet(id) {
    const res = await api.delete(`/subnets/${id}`);
    await fetchTree();
    return res.data;
  }

  async function divideSubnet(id, { new_prefix, cidr, force }) {
    const payload = { force };
    if (new_prefix !== undefined) payload.new_prefix = new_prefix;
    if (cidr) payload.cidr = cidr;
    const res = await api.post(`/subnets/${id}/divide`, payload);
    await fetchTree();
    return res.data;
  }

  async function configureSubnet(id, config) {
    const res = await api.post(`/subnets/${id}/configure`, config);
    await fetchTree();
    return res.data;
  }

  async function configureSubnetNoRefresh(id, config) {
    const res = await api.post(`/subnets/${id}/configure`, config);
    return res.data;
  }

  // Subnet detail cache: keyed by "id:page:pageSize", holds { data, timestamp }
  const _detailCache = new Map();
  const DETAIL_CACHE_TTL = 30_000; // 30 seconds
  const DETAIL_CACHE_MAX = 20;

  async function getSubnetDetail(id, page = 1, pageSize = 256, { skipCache = false } = {}) {
    const cacheKey = `${id}:${page}:${pageSize}`;
    if (!skipCache) {
      const cached = _detailCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < DETAIL_CACHE_TTL) {
        return cached.data;
      }
    }
    const res = await api.get(`/subnets/${id}/ips`, { params: { page, pageSize } });
    // Evict oldest entries if cache is full
    if (_detailCache.size >= DETAIL_CACHE_MAX) {
      const oldest = _detailCache.keys().next().value;
      _detailCache.delete(oldest);
    }
    _detailCache.set(cacheKey, { data: res.data, timestamp: Date.now() });
    return res.data;
  }

  function invalidateDetailCache(subnetId) {
    if (subnetId) {
      for (const key of _detailCache.keys()) {
        if (key.startsWith(`${subnetId}:`)) _detailCache.delete(key);
      }
    } else {
      _detailCache.clear();
    }
  }

  // Merge
  async function previewMerge(subnetIds) {
    const res = await api.post('/subnets/merge/preview', { subnet_ids: subnetIds });
    return res.data;
  }

  async function mergeSubnets(subnetIds) {
    const res = await api.post('/subnets/merge', { subnet_ids: subnetIds });
    await fetchTree();
    return res.data;
  }

  // Apply template
  async function applyTemplate(subnetIds) {
    const res = await api.post('/subnets/apply-template', { subnet_ids: subnetIds });
    await fetchTree();
    return res.data;
  }

  // Settings
  async function getSettings() {
    const res = await api.get('/settings');
    return res.data;
  }

  async function updateSetting(key, value) {
    const res = await api.put(`/settings/${key}`, { value });
    return res.data;
  }

  // Range operations
  async function getRanges(subnetId) {
    const res = await api.get(`/subnets/${subnetId}/ranges`);
    return res.data;
  }

  async function createRange(subnetId, data) {
    const res = await api.post(`/subnets/${subnetId}/ranges`, data);
    return res.data;
  }

  async function updateRange(subnetId, rangeId, data) {
    const res = await api.put(`/subnets/${subnetId}/ranges/${rangeId}`, data);
    return res.data;
  }

  async function deleteRange(subnetId, rangeId) {
    await api.delete(`/subnets/${subnetId}/ranges/${rangeId}`);
  }

  async function setIpStatus(subnetId, ipAddress, status, note) {
    const res = await api.put(`/subnets/${subnetId}/ips/${ipAddress}/status`, { status, note });
    return res.data;
  }

  // Address types (cached — rarely changes)
  let _rangeTypesCache = null;
  let _rangeTypesCacheTime = 0;

  async function getRangeTypes() {
    if (_rangeTypesCache && Date.now() - _rangeTypesCacheTime < 60_000) {
      return _rangeTypesCache;
    }
    const res = await api.get('/range-types');
    _rangeTypesCache = res.data;
    _rangeTypesCacheTime = Date.now();
    return res.data;
  }

  async function createRangeType(data) {
    const res = await api.post('/range-types', data);
    _rangeTypesCache = null;
    return res.data;
  }

  async function updateRangeType(id, data) {
    const res = await api.put(`/range-types/${id}`, data);
    _rangeTypesCache = null;
    return res.data;
  }

  async function deleteRangeType(id) {
    await api.delete(`/range-types/${id}`);
    _rangeTypesCache = null;
  }

  // Network scans
  async function startScan(subnetId) {
    const res = await api.post('/scans', { subnet_id: subnetId });
    return res.data;
  }

  async function getScan(scanId) {
    const res = await api.get(`/scans/${scanId}`);
    return res.data;
  }

  async function getScans(subnetId) {
    const res = await api.get('/scans', { params: { subnet_id: subnetId } });
    return res.data;
  }

  async function deleteScan(scanId) {
    await api.delete(`/scans/${scanId}`);
  }

  async function calculateSubnets(cidr, newPrefix) {
    const res = await api.post('/subnets/calculate', { cidr, new_prefix: newPrefix });
    return res.data;
  }

  return {
    folders, tree, treeNodes, allocatedTreeNodes, unallocatedTreeNodes, loading, subnetCount, toSubnetNodes,
    fetchTree, createFolder, updateFolder, deleteFolder, fetchFolders,
    createSupernet, updateSubnet, deleteSubnet,
    divideSubnet, configureSubnet, configureSubnetNoRefresh,
    getSubnetDetail, invalidateDetailCache, previewMerge, mergeSubnets, applyTemplate,
    getSettings, updateSetting,
    getRanges, createRange, updateRange, deleteRange, setIpStatus,
    getRangeTypes, createRangeType, updateRangeType, deleteRangeType,
    startScan, getScan, getScans, deleteScan,
    calculateSubnets
  };
});
