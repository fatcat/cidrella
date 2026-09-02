<!-- Certificates. Extracted from System.vue tab 4 (1:1): current cert info display,
     CSR generation form, certificate/key upload drag-drop zones with live PEM
     validation, and reset-to-self-signed. Loads cert info on mount. -->
<template>
  <div class="content-card">
    <div class="cert-section">
      <div class="setting-group">
        <h3>Current Certificate</h3>
        <div v-if="certInfo" class="cert-info-card">
          <div class="cert-row"><span class="cert-key">Subject:</span> {{ certInfo.subject || 'N/A' }}</div>
          <div class="cert-row"><span class="cert-key">Issuer:</span> {{ certInfo.issuer || 'N/A' }}</div>
          <div class="cert-row"><span class="cert-key">Valid From:</span> {{ certInfo.notbefore || 'N/A' }}</div>
          <div class="cert-row"><span class="cert-key">Valid Until:</span> {{ certInfo.notafter || 'N/A' }}</div>
          <div class="cert-row">
            <span class="cert-key">Type:</span>
            <span :class="certInfo.self_signed ? 'badge badge-yellow' : 'badge badge-green'">
              {{ certInfo.self_signed ? 'Self-Signed' : 'Custom' }}
            </span>
          </div>
        </div>
        <div v-else class="muted">Loading certificate info...</div>
      </div>

      <div class="setting-group">
        <h3>Generate Certificate Signing Request</h3>
        <p class="field-help" style="margin-bottom: 0.75rem;">Generate a private key and CSR for a certificate authority. The private key stays on this host; upload the signed certificate below when it is issued.</p>
        <div class="csr-form">
          <div class="field">
            <label>Common Name</label>
            <InputText v-model="csrForm.common_name" class="w-full" placeholder="cidrella.example.com" />
          </div>
          <div class="field">
            <label>Subject Alternative Names</label>
            <InputText v-model="csrForm.sanText" class="w-full" placeholder="cidrella.example.com, cidrella, 10.0.0.8" />
            <small class="field-help">Comma or newline separated. The Common Name is included automatically.</small>
          </div>
          <div class="cert-fields-row">
            <div class="field cert-field">
              <label>Organization</label>
              <InputText v-model="csrForm.organization" class="w-full" />
            </div>
            <div class="field cert-field">
              <label>Organizational Unit</label>
              <InputText v-model="csrForm.organizational_unit" class="w-full" />
            </div>
          </div>
          <div class="cert-fields-row">
            <div class="field cert-field">
              <label>Locality</label>
              <InputText v-model="csrForm.locality" class="w-full" />
            </div>
            <div class="field cert-field">
              <label>State</label>
              <InputText v-model="csrForm.state" class="w-full" />
            </div>
          </div>
          <div class="cert-fields-row">
            <div class="field cert-field">
              <label>Country</label>
              <InputText v-model="csrForm.country" class="w-full" maxlength="2" placeholder="US" />
            </div>
            <div class="field cert-field">
              <label>Key Type</label>
              <Select v-model="csrForm.key_profile" :options="csrKeyProfiles" optionLabel="label" optionValue="value" class="w-full" />
            </div>
          </div>
          <div class="csr-actions">
            <Button label="Generate CSR" icon="pi pi-file" data-track="sys-generate-csr"
                    @click="doGenerateCsr" :loading="generatingCsr" :disabled="!csrForm.common_name.trim()" />
            <Button v-if="generatedCsr" label="Copy CSR" icon="pi pi-copy" severity="secondary"
                    @click="copyGeneratedCsr" />
          </div>
          <textarea v-if="generatedCsr" v-model="generatedCsr" readonly class="cert-textarea csr-output"></textarea>
        </div>
      </div>

      <div class="setting-group">
        <h3>Upload Certificate</h3>
        <p class="field-help" style="margin-bottom: 0.75rem;">Upload PEM-encoded certificate and private key files. If you generated a CSR above, upload only the signed certificate and CIDRella will use the pending private key. Applied immediately to new connections.</p>
        <div class="cert-upload-form">
          <div class="cert-fields-row">
            <div class="field cert-field">
              <label>Certificate (.pem, .crt)</label>
              <div class="cert-drop-zone" :class="{ 'drop-active': certDragOver === 'cert' }"
                   @dragover.prevent="certDragOver = 'cert'" @dragleave="certDragOver = null"
                   @drop.prevent="onCertDrop($event, 'cert')">
                <textarea v-model="certUpload.cert" placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----&#10;&#10;Drop a .pem or .crt file here"
                          class="cert-textarea" :class="{ 'cert-valid': certValidation.cert === true, 'cert-invalid': certValidation.cert === false }"></textarea>
                <div v-if="certDragOver === 'cert'" class="drop-overlay">Drop certificate file</div>
              </div>
              <small v-if="certValidation.cert === true" class="cert-status cert-status-ok"><i class="pi pi-check-circle"></i> Valid PEM certificate</small>
              <small v-else-if="certValidation.cert === false" class="cert-status cert-status-err"><i class="pi pi-times-circle"></i> {{ certValidation.certError }}</small>
            </div>
            <div class="field cert-field">
              <label>Private Key (.pem, .key)</label>
              <div class="cert-drop-zone" :class="{ 'drop-active': certDragOver === 'key' }"
                   @dragover.prevent="certDragOver = 'key'" @dragleave="certDragOver = null"
                   @drop.prevent="onCertDrop($event, 'key')">
                <textarea v-model="certUpload.key" placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----&#10;&#10;Drop a .pem or .key file here"
                          class="cert-textarea" :class="{ 'cert-valid': certValidation.key === true, 'cert-invalid': certValidation.key === false }"></textarea>
                <div v-if="certDragOver === 'key'" class="drop-overlay">Drop key file</div>
              </div>
              <small v-if="certValidation.key === true" class="cert-status cert-status-ok"><i class="pi pi-check-circle"></i> Valid PEM private key</small>
              <small v-else-if="certValidation.key === false" class="cert-status cert-status-err"><i class="pi pi-times-circle"></i> {{ certValidation.keyError }}</small>
            </div>
          </div>
          <Button label="Upload Certificate" icon="pi pi-upload" data-track="sys-upload-cert"
                  @click="doUploadCert" :loading="uploadingCert"
                  :disabled="!certUpload.cert || certValidation.cert === false || certValidation.key === false" />
        </div>
      </div>

      <div class="setting-group">
        <h3>Reset to Self-Signed</h3>
        <p class="field-help" style="margin-bottom: 0.75rem;">Generate a new self-signed certificate. Applied immediately to new connections.</p>
        <Button label="Reset to Self-Signed" icon="pi pi-refresh" severity="secondary" @click="confirmResetCert" :loading="resettingCert" />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import Button from '../../ui/Button.js';
import InputText from '../../ui/InputText.js';
import Select from '../../ui/Select.js';
import { useToast } from '../../ui/useToast.js';
import { useOperationsStore } from '../../stores/operations.js';
import { apiError } from '../../utils/format.js';

const opsStore = useOperationsStore();
const toast = useToast();

const certInfo = ref(null);
const certUpload = ref({ cert: '', key: '' });
const certDragOver = ref(null);
const uploadingCert = ref(false);
const resettingCert = ref(false);
const generatingCsr = ref(false);
const generatedCsr = ref('');
const csrKeyProfiles = [
  { label: 'RSA 3072', value: 3072 },
  { label: 'RSA 2048', value: 2048 },
  { label: 'RSA 4096', value: 4096 },
  { label: 'ECDSA P-256', value: 'ecdsa-p256' },
  { label: 'ECDSA P-384', value: 'ecdsa-p384' },
];
const csrForm = ref({
  common_name: '',
  sanText: '',
  organization: '',
  organizational_unit: '',
  locality: '',
  state: '',
  country: '',
  key_profile: 3072,
});

const certValidation = computed(() => {
  const result = { cert: null, certError: '', key: null, keyError: '' };
  const certText = certUpload.value.cert.trim();
  const keyText = certUpload.value.key.trim();
  if (certText) {
    if (!certText.startsWith('-----BEGIN CERTIFICATE-----')) {
      result.cert = false;
      result.certError = 'Must start with -----BEGIN CERTIFICATE-----';
    } else if (!certText.includes('-----END CERTIFICATE-----')) {
      result.cert = false;
      result.certError = 'Missing -----END CERTIFICATE-----';
    } else {
      const body = certText.replace(/-----BEGIN CERTIFICATE-----/g, '').replace(/-----END CERTIFICATE-----/g, '').replace(/\s/g, '');
      if (!/^[A-Za-z0-9+/=]+$/.test(body) || body.length < 100) {
        result.cert = false;
        result.certError = 'Invalid base64 content';
      } else {
        result.cert = true;
      }
    }
  }
  if (keyText) {
    const keyHeaders = ['-----BEGIN PRIVATE KEY-----', '-----BEGIN RSA PRIVATE KEY-----', '-----BEGIN EC PRIVATE KEY-----'];
    const keyFooters = ['-----END PRIVATE KEY-----', '-----END RSA PRIVATE KEY-----', '-----END EC PRIVATE KEY-----'];
    const hasHeader = keyHeaders.some(h => keyText.startsWith(h));
    const hasFooter = keyFooters.some(f => keyText.includes(f));
    if (!hasHeader) {
      result.key = false;
      result.keyError = 'Must start with -----BEGIN PRIVATE KEY----- (or RSA/EC variant)';
    } else if (!hasFooter) {
      result.key = false;
      result.keyError = 'Missing -----END PRIVATE KEY-----';
    } else {
      const body = keyText.replace(/-----BEGIN [A-Z ]+-----/g, '').replace(/-----END [A-Z ]+-----/g, '').replace(/\s/g, '');
      if (!/^[A-Za-z0-9+/=]+$/.test(body) || body.length < 50) {
        result.key = false;
        result.keyError = 'Invalid base64 content';
      } else {
        result.key = true;
      }
    }
  }
  return result;
});

function confirmResetCert() {
  if (!confirm('Are you sure you want to reset to a self-signed certificate? The current certificate will be replaced and a server restart will be required.')) return;
  doResetCert();
}

function onCertDrop(event, field) {
  certDragOver.value = null;
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { certUpload.value[field] = reader.result; };
  reader.readAsText(file);
}

async function doUploadCert() {
  uploadingCert.value = true;
  try {
    const keyText = certUpload.value.key.trim();
    const result = keyText
      ? await opsStore.uploadCert(keyText, certUpload.value.cert)
      : await opsStore.uploadSignedCert(certUpload.value.cert);
    certUpload.value = { cert: '', key: '' };
    toast.add({ severity: 'warn', summary: 'Certificate installed', detail: result.message, life: 10000 });
    await opsStore.fetchCertInfo().then(c => certInfo.value = c);
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Upload failed', detail: apiError(err), life: 5000 });
  } finally {
    uploadingCert.value = false;
  }
}

async function doGenerateCsr() {
  generatingCsr.value = true;
  try {
    const san = csrForm.value.sanText
      .split(/[\n,]/)
      .map(s => s.trim())
      .filter(Boolean);
    const keyProfile = csrForm.value.key_profile;
    const keyFields = typeof keyProfile === 'number'
      ? { key_algorithm: 'rsa', key_size: keyProfile }
      : { key_algorithm: 'ecdsa', curve: keyProfile === 'ecdsa-p384' ? 'secp384r1' : 'prime256v1' };
    const result = await opsStore.generateCsr({
      common_name: csrForm.value.common_name.trim(),
      san,
      organization: csrForm.value.organization.trim(),
      organizational_unit: csrForm.value.organizational_unit.trim(),
      locality: csrForm.value.locality.trim(),
      state: csrForm.value.state.trim(),
      country: csrForm.value.country.trim().toUpperCase(),
      ...keyFields,
    });
    generatedCsr.value = result.csr;
    toast.add({ severity: 'success', summary: 'CSR generated', detail: 'Send this CSR to your certificate authority, then upload the signed certificate.', life: 7000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'CSR failed', detail: apiError(err), life: 5000 });
  } finally {
    generatingCsr.value = false;
  }
}

async function copyGeneratedCsr() {
  try {
    await navigator.clipboard.writeText(generatedCsr.value);
    toast.add({ severity: 'success', summary: 'CSR copied', life: 2500 });
  } catch {
    toast.add({ severity: 'warn', summary: 'Copy failed', detail: 'Select the CSR text and copy it manually.', life: 5000 });
  }
}

async function doResetCert() {
  resettingCert.value = true;
  try {
    const result = await opsStore.resetCert();
    toast.add({ severity: 'warn', summary: 'Certificate reset', detail: result.message, life: 10000 });
    await opsStore.fetchCertInfo().then(c => certInfo.value = c);
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Reset failed', detail: apiError(err), life: 5000 });
  } finally {
    resettingCert.value = false;
  }
}

onMounted(() => {
  opsStore.fetchCertInfo().then(c => certInfo.value = c).catch(() => {});
});
</script>

<style scoped>
.content-card {
  margin: 0;
  padding: 1.25rem;
  background: var(--p-surface-card);
  border: 1px solid var(--p-surface-border);
  border-radius: 8px;
}
.content-card h3 {
  font-size: var(--app-fs-lg);
  margin: 0 0 0.75rem;
  color: var(--p-text-color);
}
.muted {
  color: var(--p-text-muted-color);
}
.setting-group {
  margin-bottom: 1.5rem;
  padding-bottom: 1.5rem;
  border-bottom: 1px solid var(--p-surface-border);
}
.setting-group:last-child {
  border-bottom: none;
  padding-bottom: 0;
}
.setting-group h3 {
  margin: 0 0 0.75rem 0;
  font-size: var(--app-fs-lg);
  color: var(--p-text-color);
}
.field {
  margin-bottom: 1rem;
}
.field label {
  display: block;
  margin-bottom: 0.4rem;
  font-size: var(--app-fs-sm);
  font-weight: 500;
}
.field-help {
  display: block;
  margin-top: 0.25rem;
  font-size: var(--app-fs-xs);
  color: var(--p-text-muted-color);
}
.cert-section {
  max-width: 48rem;
}
.cert-info-card {
  background: var(--p-surface-ground);
  border: 1px solid var(--p-surface-border);
  border-radius: 8px;
  padding: 1rem;
  font-size: var(--app-fs-sm);
}
.cert-row {
  padding: 0.25rem 0;
}
.cert-key {
  font-weight: 600;
  display: inline-block;
  width: 7rem;
}
.cert-upload-form {
  max-width: 32rem;
}
.csr-form {
  max-width: 32rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.csr-actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}
.csr-output {
  height: 12rem;
}
.cert-fields-row {
  display: flex;
  gap: 1rem;
}
.cert-field {
  flex: 1;
  min-width: 0;
}
.cert-drop-zone {
  position: relative;
}
.cert-drop-zone.drop-active .cert-textarea {
  border-color: var(--p-primary-color);
  border-style: dashed;
}
.drop-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--p-primary-color) 10%, transparent);
  border-radius: 6px;
  font-size: var(--app-fs-md);
  font-weight: 600;
  color: var(--p-primary-color);
  pointer-events: none;
}
.cert-textarea {
  width: 100%;
  height: 24rem;
  font-family: monospace;
  font-size: var(--app-fs-sm);
  padding: 0.5rem;
  border: 1px solid var(--p-surface-border);
  border-radius: 6px;
  resize: vertical;
  overflow-y: auto;
}
.cert-textarea.cert-valid {
  border-color: var(--p-green-500);
}
.cert-textarea.cert-invalid {
  border-color: var(--p-red-500);
}
.cert-status {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  margin-top: 0.4rem;
  font-size: var(--app-fs-xs);
}
.cert-status-ok { color: var(--p-green-500); }
.cert-status-err { color: var(--p-red-500); }
.w-full { width: 100%; }
</style>
