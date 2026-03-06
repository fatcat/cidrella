import { defineStore } from 'pinia';
import { ref } from 'vue';
import api from '../api/client.js';

export const useOperationsStore = defineStore('operations', () => {
  const backups = ref([]);
  const certInfo = ref(null);
  const loading = ref(false);

  // Backup operations
  async function createBackup() {
    const res = await api.post('/operations/backup');
    await fetchBackups();
    return res.data;
  }

  async function fetchBackups() {
    loading.value = true;
    try {
      const res = await api.get('/operations/backups');
      backups.value = res.data;
      return res.data;
    } finally {
      loading.value = false;
    }
  }

  async function deleteBackup(id) {
    await api.delete(`/operations/backups/${id}`);
    await fetchBackups();
  }

  function downloadBackupUrl(id) {
    return `/api/operations/backups/${id}/download`;
  }

  async function downloadBackup(id, filename) {
    const res = await api.get(`/operations/backups/${id}/download`, { responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'backup.tar.gz';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function restoreBackup(file) {
    const res = await api.post('/operations/restore', file, {
      headers: { 'Content-Type': 'application/gzip' },
      timeout: 120000
    });
    return res.data;
  }

  // Certificate operations
  async function fetchCertInfo() {
    const res = await api.get('/operations/certs/info');
    certInfo.value = res.data;
    return res.data;
  }

  async function uploadCert(keyPem, certPem) {
    const res = await api.post('/operations/certs/upload', { key: keyPem, cert: certPem });
    return res.data;
  }

  async function resetCert() {
    const res = await api.post('/operations/certs/reset');
    return res.data;
  }

  // Setup operations (no auth required)
  async function getSetupStatus() {
    const res = await api.get('/setup/status');
    return res.data;
  }

  async function completeSetup(data) {
    const res = await api.post('/setup', data);
    return res.data;
  }

  return {
    backups, certInfo, loading,
    createBackup, fetchBackups, deleteBackup, downloadBackupUrl, downloadBackup, restoreBackup,
    fetchCertInfo, uploadCert, resetCert,
    getSetupStatus, completeSetup
  };
});
