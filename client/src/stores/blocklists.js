import { defineStore } from 'pinia';
import { ref } from 'vue';
import api from '../api/client.js';

export const useBlocklistStore = defineStore('blocklists', () => {
  const sources = ref([]);
  const whitelist = ref([]);
  const stats = ref({ total_sources: 0, enabled_sources: 0, total_domains: 0, whitelist_count: 0, last_update: null });
  const loading = ref(false);

  async function fetchSources() {
    loading.value = true;
    try {
      const res = await api.get('/blocklists/sources');
      sources.value = res.data;
      return res.data;
    } finally {
      loading.value = false;
    }
  }

  async function createSource(data) {
    const res = await api.post('/blocklists/sources', data);
    await fetchSources();
    return res.data;
  }

  async function updateSource(id, data) {
    const res = await api.put(`/blocklists/sources/${id}`, data);
    await fetchSources();
    return res.data;
  }

  async function deleteSource(id) {
    await api.delete(`/blocklists/sources/${id}`);
    await fetchSources();
  }

  async function refreshSource(id) {
    const res = await api.post(`/blocklists/sources/${id}/refresh`);
    await fetchSources();
    return res.data;
  }

  async function refreshAll() {
    const res = await api.post('/blocklists/refresh');
    await fetchSources();
    return res.data;
  }

  async function fetchStats() {
    const res = await api.get('/blocklists/stats');
    stats.value = res.data;
    return res.data;
  }

  async function fetchWhitelist() {
    const res = await api.get('/blocklists/whitelist');
    whitelist.value = res.data;
    return res.data;
  }

  async function addWhitelist(domain, reason) {
    const res = await api.post('/blocklists/whitelist', { domain, reason });
    await fetchWhitelist();
    return res.data;
  }

  async function removeWhitelist(id) {
    await api.delete(`/blocklists/whitelist/${id}`);
    await fetchWhitelist();
  }

  async function searchDomains(q, page = 1, limit = 50) {
    const res = await api.get('/blocklists/search', { params: { q, page, limit } });
    return res.data;
  }

  async function fetchCategories() {
    const res = await api.get('/blocklists/categories');
    return res.data;
  }

  async function toggleCategory(name, enabled) {
    const res = await api.put(`/blocklists/categories/${name}`, { enabled });
    await fetchSources();
    return res.data;
  }

  return {
    sources, whitelist, stats, loading,
    fetchSources, createSource, updateSource, deleteSource,
    refreshSource, refreshAll, fetchStats,
    fetchWhitelist, addWhitelist, removeWhitelist,
    searchDomains, fetchCategories, toggleCategory
  };
});
