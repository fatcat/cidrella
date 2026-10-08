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

  // `dhcp` is 'enabled' or 'disabled': whether this appliance serves DHCP
  // after the restart. Omitted keeps the backup's own setting.
  async function restoreBackup(file, { dhcp } = {}) {
    const res = await api.post('/operations/restore', file, {
      headers: { 'Content-Type': 'application/gzip' },
      timeout: 120000,
      ...(dhcp ? { params: { dhcp } } : {}),
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

  async function uploadSignedCert(certPem) {
    const res = await api.post('/operations/certs/upload', { cert: certPem });
    return res.data;
  }

  async function generateCsr(payload) {
    const res = await api.post('/operations/certs/csr', payload);
    return res.data;
  }

  async function resetCert() {
    const res = await api.post('/operations/certs/reset');
    return res.data;
  }

  return {
    backups,
    certInfo,
    loading,
    createBackup,
    fetchBackups,
    deleteBackup,
    downloadBackup,
    restoreBackup,
    fetchCertInfo,
    uploadCert,
    uploadSignedCert,
    generateCsr,
    resetCert,
  };
});
