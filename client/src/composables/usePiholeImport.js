import { ref, watch, onUnmounted } from 'vue';
import api from '../api/client.js';
import { apiError } from '../utils/format.js';

/**
 * The Pi-hole import flow: probe, fetch or parse, preview, import.
 *
 * This existed twice, once in PiholeImportPanel.vue (Settings > Integrations)
 * and once inline in NetworkDialogs.vue (step 3 of the network wizard), about
 * 120 lines of near-identical script each. They had already parted company on
 * one line: the wizard fell back to the domain typed in step 2 when the
 * pihole.toml carried no `dns.domain`, and the panel did not, so the same file
 * imported through the wizard and failed with "No zone found" through Settings.
 *
 * That difference is real and contextual (Settings has no wizard domain to fall
 * back to), which is exactly why it belongs as a parameter rather than as a
 * second copy of everything around it. `fallbackZoneName` is a getter so the
 * caller can hand over a reactive value.
 *
 * The two templates stay separate on purpose. They are genuinely different
 * layouts, one a settings panel and one a wizard step wired into the wizard's
 * own footer, and merging them is a UI change rather than a de-duplication.
 * What mattered was that the LOGIC was duplicated, because that is where the
 * drift landed. See REVIEW.md, duplicate-logic audit #47.
 */
export function usePiholeImport({ toast, fallbackZoneName = null, onImported = null } = {}) {
  const tab = ref('online');
  const url = ref('');
  const password = ref('');
  const probeStatus = ref(null);
  const probeError = ref('');
  const needsPassword = ref(false);
  const fetching = ref(false);
  const parsing = ref(false);
  const importing = ref(false);
  const preview = ref(null);
  const importResults = ref(null);
  const fileContent = ref(null);
  const fileInput = ref(null);

  function cleanUrl(raw) {
    let value = String(raw || '').trim();
    if (!value) return '';
    if (!/^https?:\/\//i.test(value)) value = 'http://' + value;
    try {
      const parsed = new URL(value);
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      return value;
    }
  }

  let probeTimer = null;

  async function probe() {
    const cleaned = cleanUrl(url.value);
    if (!cleaned) { probeStatus.value = null; return; }
    if (cleaned !== url.value.trim()) url.value = cleaned;
    try {
      const res = await api.post('/pihole/probe', { url: cleaned, password: password.value || undefined });
      if (res.data.reachable) {
        probeStatus.value = 'ok';
        needsPassword.value = res.data.needsPassword;
        probeError.value = '';
      } else {
        probeStatus.value = 'fail';
        probeError.value = res.data.error || 'Could not connect';
      }
    } catch (err) {
      probeStatus.value = 'fail';
      probeError.value = apiError(err);
    }
  }

  watch(url, (val) => {
    clearTimeout(probeTimer);
    probeStatus.value = null;
    probeError.value = '';
    const trimmed = val?.trim();
    if (!trimmed) return;
    probeTimer = setTimeout(() => probe(), 600);
  });

  // The debounce outlived the component before, because the timer was only ever
  // cleared by the next keystroke.
  onUnmounted(() => clearTimeout(probeTimer));

  async function fetchConfig() {
    fetching.value = true;
    try {
      const res = await api.post('/pihole/fetch', {
        url: url.value.trim(),
        password: password.value || undefined
      });
      preview.value = res.data;
      importResults.value = null;
    } catch (err) {
      toast?.add({ severity: 'error', summary: 'Fetch failed', detail: apiError(err), life: 5000 });
    } finally { fetching.value = false; }
  }

  function onFileSelect(event) {
    const file = event.target.files[0];
    if (!file) { fileContent.value = null; return; }
    const reader = new FileReader();
    reader.onload = (e) => { fileContent.value = e.target.result; };
    reader.readAsText(file);
  }

  async function parseFile() {
    parsing.value = true;
    try {
      const res = await api.post('/pihole/parse', fileContent.value, {
        headers: { 'Content-Type': 'text/plain' }
      });
      preview.value = res.data;
      importResults.value = null;
    } catch (err) {
      toast?.add({ severity: 'error', summary: 'Parse failed', detail: apiError(err), life: 5000 });
    } finally { parsing.value = false; }
  }

  /** The zone this import targets: what the file declares, else the caller's fallback. */
  function resolveZoneName() {
    const declared = preview.value?.zoneName;
    if (declared) return declared;
    return typeof fallbackZoneName === 'function' ? fallbackZoneName() : fallbackZoneName;
  }

  async function executeImport() {
    if (!preview.value) return;
    importing.value = true;
    try {
      const { useDnsStore } = await import('../stores/dns.js');
      const dnsStore = useDnsStore();
      await dnsStore.fetchZones();
      const domainName = resolveZoneName();

      let zone = dnsStore.zones.find(z => z.name === domainName && z.type === 'forward');
      if (!zone && domainName) {
        zone = await dnsStore.createZone({ name: domainName, type: 'forward' });
      }
      if (!zone) {
        toast?.add({
          severity: 'error',
          summary: 'No zone found',
          detail: 'Could not find or create a forward DNS zone for import',
          life: 5000
        });
        return;
      }

      const res = await api.post('/pihole/import', {
        zoneId: zone.id,
        hosts: preview.value.hosts,
        cnames: preview.value.cnames,
        dhcpHosts: preview.value.dhcpHosts,
      });
      importResults.value = res.data.results;
      toast?.add({ severity: 'success', summary: 'Pi-hole import complete', life: 3000 });
      onImported?.();
    } catch (err) {
      toast?.add({ severity: 'error', summary: 'Import failed', detail: apiError(err), life: 5000 });
    } finally { importing.value = false; }
  }

  function resetState() {
    clearTimeout(probeTimer);
    tab.value = 'online';
    url.value = '';
    password.value = '';
    probeStatus.value = null;
    probeError.value = '';
    needsPassword.value = false;
    preview.value = null;
    importResults.value = null;
    fileContent.value = null;
    if (fileInput.value) fileInput.value.value = '';
  }

  return {
    tab, url, password, probeStatus, probeError, needsPassword,
    fetching, parsing, importing, preview, importResults, fileContent, fileInput,
    cleanUrl, probe, fetchConfig, onFileSelect, parseFile, executeImport,
    resolveZoneName, resetState,
  };
}
