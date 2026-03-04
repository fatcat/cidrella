import { defineStore } from 'pinia';
import { ref } from 'vue';
import api from '../api/client.js';

export const useDhcpStore = defineStore('dhcp', () => {
  const scopes = ref([]);
  const reservations = ref([]);
  const leases = ref([]);
  const loading = ref(false);

  async function fetchScopes() {
    loading.value = true;
    try {
      const res = await api.get('/dhcp/scopes');
      scopes.value = res.data;
      return res.data;
    } finally {
      loading.value = false;
    }
  }

  async function createScope(data) {
    const res = await api.post('/dhcp/scopes', data);
    await fetchScopes();
    return res.data;
  }

  async function updateScope(id, data) {
    const res = await api.put(`/dhcp/scopes/${id}`, data);
    await fetchScopes();
    return res.data;
  }

  async function deleteScope(id) {
    await api.delete(`/dhcp/scopes/${id}`);
    await fetchScopes();
  }

  async function fetchAvailableRanges() {
    const res = await api.get('/dhcp/available-ranges');
    return res.data;
  }

  async function fetchReservations(subnetId) {
    const params = subnetId ? { subnet_id: subnetId } : {};
    const res = await api.get('/dhcp/reservations', { params });
    reservations.value = res.data;
    return res.data;
  }

  async function createReservation(data) {
    const res = await api.post('/dhcp/reservations', data);
    await fetchReservations();
    return res.data;
  }

  async function updateReservation(id, data) {
    const res = await api.put(`/dhcp/reservations/${id}`, data);
    await fetchReservations();
    return res.data;
  }

  async function deleteReservation(id) {
    await api.delete(`/dhcp/reservations/${id}`);
    await fetchReservations();
  }

  async function fetchLeases() {
    const res = await api.get('/dhcp/leases');
    leases.value = res.data;
    return res.data;
  }

  async function syncLeases() {
    const res = await api.post('/dhcp/sync-leases');
    await fetchLeases();
    return res.data;
  }

  async function applyConfig() {
    const res = await api.post('/dhcp/apply');
    return res.data;
  }

  return {
    scopes, reservations, leases, loading,
    fetchScopes, createScope, updateScope, deleteScope, fetchAvailableRanges,
    fetchReservations, createReservation, updateReservation, deleteReservation,
    fetchLeases, syncLeases, applyConfig
  };
});
