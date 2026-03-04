import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import api from '../api/client.js';

export const useSubnetStore = defineStore('subnets', () => {
  const tree = ref([]);
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
    return count(tree.value);
  });

  function ipToLong(ip) {
    const parts = ip.split('.').map(Number);
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  }

  // Convert API tree to PrimeVue Tree format (sorted by network address)
  function toTreeNodes(nodes) {
    const sorted = [...nodes].sort((a, b) => {
      const aNet = ipToLong(a.network_address);
      const bNet = ipToLong(b.network_address);
      if (aNet !== bNet) return aNet - bNet;
      return a.prefix_length - b.prefix_length;
    });
    return sorted.map(s => ({
      key: String(s.id),
      label: s.status === 'allocated' ? `${s.cidr} — ${s.name}` : s.cidr,
      data: s,
      leaf: (s.child_count || 0) === 0 && (!s.children || s.children.length === 0),
      children: s.children && s.children.length > 0 ? toTreeNodes(s.children) : undefined,
      styleClass: s.status === 'unallocated' ? 'node-unallocated' : 'node-allocated'
    }));
  }

  const treeNodes = computed(() => toTreeNodes(tree.value));

  async function fetchTree() {
    loading.value = true;
    try {
      const res = await api.get('/subnets');
      tree.value = res.data.tree;
    } finally {
      loading.value = false;
    }
  }

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

  async function getSubnetDetail(id) {
    const res = await api.get(`/subnets/${id}/ips`);
    return res.data;
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

  // Range types
  async function getRangeTypes() {
    const res = await api.get('/range-types');
    return res.data;
  }

  async function createRangeType(data) {
    const res = await api.post('/range-types', data);
    return res.data;
  }

  async function updateRangeType(id, data) {
    const res = await api.put(`/range-types/${id}`, data);
    return res.data;
  }

  async function deleteRangeType(id) {
    await api.delete(`/range-types/${id}`);
  }

  return {
    tree, treeNodes, loading, subnetCount,
    fetchTree, createSupernet, updateSubnet, deleteSubnet,
    divideSubnet, configureSubnet,
    getSubnetDetail, previewMerge, mergeSubnets, applyTemplate,
    getSettings, updateSetting,
    getRanges, createRange, updateRange, deleteRange,
    getRangeTypes, createRangeType, updateRangeType, deleteRangeType
  };
});
