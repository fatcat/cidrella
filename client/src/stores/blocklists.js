import { defineStore } from 'pinia';
import { ref } from 'vue';
import api from '../api/client.js';

export const useBlocklistStore = defineStore('blocklists', () => {
  const categories = ref([]);
  const whitelist = ref([]);
  const stats = ref({ enabled_categories: 0, total_domains: 0, whitelist_count: 0, last_update: null });
  const settings = ref({ blocklist_enabled: 'true', blocklist_redirect_ip: '', blocklist_update_schedule: 'daily' });
  const loading = ref(false);

  async function fetchCategories() {
    loading.value = true;
    try {
      const res = await api.get('/blocklists/categories');
      categories.value = res.data;
      return res.data;
    } finally {
      loading.value = false;
    }
  }

  async function toggleCategory(slug, enabled) {
    const res = await api.put(`/blocklists/categories/${slug}`, { enabled });
    await fetchCategories();
    return res.data;
  }

  async function updateCategoryUrl(slug, sourceUrl) {
    const res = await api.put(`/blocklists/categories/${slug}/url`, { source_url: sourceUrl });
    await fetchCategories();
    return res.data;
  }

  async function refreshCategory(slug) {
    const res = await api.post(`/blocklists/categories/${slug}/refresh`);
    await fetchCategories();
    return res.data;
  }

  async function refreshAll() {
    const res = await api.post('/blocklists/refresh');
    await fetchCategories();
    return res.data;
  }

  async function fetchStats() {
    const res = await api.get('/blocklists/stats');
    stats.value = res.data;
    return res.data;
  }

  async function fetchSettings() {
    const res = await api.get('/blocklists/settings');
    settings.value = res.data;
    return res.data;
  }

  async function updateSettings(data) {
    const res = await api.put('/blocklists/settings', data);
    await fetchSettings();
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

  return {
    categories, whitelist, stats, settings, loading,
    fetchCategories, toggleCategory, updateCategoryUrl, refreshCategory, refreshAll,
    fetchStats, fetchSettings, updateSettings,
    fetchWhitelist, addWhitelist, removeWhitelist,
    searchDomains
  };
});
