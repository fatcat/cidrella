<template>
  <div class="dns-page" style="display: flex; flex-direction: column; height: 100%;">
    <div class="dns-sections">
      <div class="dns-section">
        <h4>Upstream Forwarders</h4>
        <p class="section-hint">
          How CIDRella forwards queries upstream. Encrypted modes (DoT/DoH) use curated
          unfiltered providers. CIDRella still does all filtering.
        </p>

        <div class="recursion-row">
          <Checkbox v-model="noRecursion" :binary="true" inputId="no-recursion" data-track="dns-toggle-no-recursion" />
          <label for="no-recursion">Do not provide recursion</label>
          <span v-tooltip.top="recursionTip" class="soa-help">?</span>
        </div>

        <template v-if="!noRecursion">
          <div class="enc-row mode-row">
            <label>Mode</label>
            <div class="enc-modes" role="radiogroup" aria-label="Upstream forwarding mode">
              <div v-for="opt in encModeOptions" :key="opt.value" class="enc-mode-option">
                <RadioButton v-model="encForm.mode" :inputId="`enc-mode-${opt.value}`" name="enc-mode"
                             :value="opt.value" data-track="dns-forwarding-mode" />
                <label :for="`enc-mode-${opt.value}`">{{ opt.label }}</label>
              </div>
            </div>
          </div>

          <!-- Plaintext: enter upstream IPs -->
          <div v-if="encForm.mode === 'off'" class="forwarders-list">
            <div v-for="(fwd, i) in forwarders" :key="i" class="forwarder-entry">
              <StatusDot :kind="fwdDotKind(fwd)" :label="fwdDotLabel(fwd)" />
              <InputText v-model="forwarders[i].ip" size="small" placeholder="e.g. 8.8.8.8" style="width: 12rem"
                         @blur="onForwarderBlur(i)" @keyup.enter="onForwarderBlur(i)" />
              <i v-if="fwd.status === 'testing'" class="pi pi-spin pi-spinner fwd-testing"></i>
              <Button icon="pi pi-trash" severity="danger" text rounded size="small"
                      @click="removeForwarder(i)" v-if="forwarders.length > 1" title="Remove" />
            </div>
            <div class="forwarder-actions">
              <Button label="Add Forwarder" icon="pi pi-plus" size="small" severity="secondary" @click="addForwarder" />
            </div>
            <p class="forwarder-hint">
              Forwarders are tested via DNS resolution on entry and every 15 minutes.
              A failed test is retried once after 5 seconds before marking as down.
            </p>
          </div>

          <!-- Encrypted: pick a curated unfiltered provider -->
          <template v-else>
            <div class="enc-row">
              <label>Provider</label>
              <Select v-model="encForm.provider" :options="providerOptions" optionLabel="label" optionValue="value"
                      size="small" style="width: 22rem" data-track="dns-encryption-provider" />
            </div>
            <template v-if="encForm.provider === 'custom'">
              <div class="enc-row">
                <label>Hostname</label>
                <InputText v-model="encCustom.hostname" size="small" placeholder="dns.example.com" style="width: 22rem" />
              </div>
              <div class="enc-row">
                <label>Addresses</label>
                <InputText v-model="encCustom.addresses" size="small" placeholder="9.9.9.10, 149.112.112.10" style="width: 22rem" />
              </div>
              <div class="enc-row">
                <label>DoH URL</label>
                <InputText v-model="encCustom.doh_url" size="small" placeholder="https://dns.example.com/dns-query" style="width: 22rem" />
              </div>
            </template>
            <p v-if="encStatusLine" class="dnssec-status">
              <StatusDot :kind="encStatus?.recentErrors > 0 ? 'err' : 'ok'"
                         :label="encStatus?.recentErrors > 0 ? 'Recent errors' : 'Active'" />
              {{ encStatusLine }}
            </p>
            <p class="forwarder-hint">On failure, forwarding fails closed. There is no silent fallback to plaintext.</p>
          </template>
        </template>

        <p v-else class="forwarder-hint recursion-note">
          Recursion is disabled. CIDRella answers only for its own zones and records.
          Forwarders, encryption, and domain/GeoIP filtering do not apply.
        </p>

        <div class="forwarder-actions">
          <Button label="Save" icon="pi pi-save" size="small" data-track="dns-save-upstream"
                  @click="saveUpstream" :loading="savingForwarders" :disabled="!upstreamDirty" />
        </div>
      </div>

      <div class="dns-section">
        <h4>SOA Defaults</h4>
        <p class="section-hint">Default values applied when creating new DNS zones.</p>
        <div class="soa-defaults-form">
          <div class="field">
            <label>Primary Nameserver</label>
            <InputText v-model="soaForm.soa_primary_ns" size="small" placeholder="ns1.localhost" style="width: 100%" />
          </div>
          <div class="field">
            <label>Admin Email</label>
            <InputText v-model="soaForm.soa_admin_email" size="small" placeholder="admin.localhost" style="width: 100%" />
            <small class="field-help">Dotted notation (admin.example.com = admin@example.com)</small>
          </div>
          <div class="soa-grid">
            <div class="field">
              <label>Refresh (s) <span v-tooltip.top="'How often secondaries check for zone updates'" class="soa-help">?</span></label>
              <InputNumber v-model="soaForm.soa_refresh" size="small" :min="0" style="width: 100%" />
            </div>
            <div class="field">
              <label>Retry (s) <span v-tooltip.top="'How long secondaries wait before retrying a failed refresh'" class="soa-help">?</span></label>
              <InputNumber v-model="soaForm.soa_retry" size="small" :min="0" style="width: 100%" />
            </div>
            <div class="field">
              <label>Expire (s) <span v-tooltip.top="'How long secondaries serve the zone without a successful refresh'" class="soa-help">?</span></label>
              <InputNumber v-model="soaForm.soa_expire" size="small" :min="0" style="width: 100%" />
            </div>
            <div class="field">
              <label>Minimum TTL (s) <span v-tooltip.top="'Default negative-cache TTL: how long resolvers cache NXDOMAIN responses'" class="soa-help">?</span></label>
              <InputNumber v-model="soaForm.soa_minimum_ttl" size="small" :min="0" style="width: 100%" />
            </div>
          </div>
          <div class="forwarder-actions">
            <Button label="Save" icon="pi pi-save" size="small" data-track="dns-save-soa-defaults"
                    @click="saveSoaDefaults" :loading="savingSoa" :disabled="!soaDirty" />
          </div>
        </div>
      </div>

      <div class="dns-section">
        <h4>DNSSEC Validation</h4>
        <p class="section-hint">
          Cryptographically validate DNS responses against the root trust anchor.
          Blocklist and GeoIP filtering continue to apply to validated answers.
        </p>
        <div class="dnssec-form">
          <div class="dnssec-row">
            <ToggleSwitch v-model="dnssecForm.enabled" data-track="dns-toggle-dnssec"
                          :disabled="dnssecSupported === false" />
            <span>Enable DNSSEC validation</span>
          </div>
          <p v-if="dnssecSupported === false" class="dnssec-warn">
            This host's dnsmasq was not built with DNSSEC support, so validation cannot be enabled.
          </p>
          <p v-else-if="savedDnssec && savedDnssec.enabled" class="dnssec-status">
            <StatusDot :kind="ntpSynced ? 'ok' : 'muted'" :label="ntpSynced ? 'Clock synchronized' : 'Waiting for NTP sync'" />
            {{ ntpSynced
                 ? 'Clock synchronized. Signatures are fully validated.'
                 : 'Waiting for NTP sync. Validation stays lenient on signature timestamps until the clock syncs.' }}
          </p>
          <div class="forwarder-actions">
            <Button label="Save" icon="pi pi-save" size="small" data-track="dns-save-dnssec"
                    @click="saveDnssec" :loading="savingDnssec" :disabled="!dnssecDirty" />
          </div>
        </div>
      </div>

    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useToast } from '../ui/useToast.js';
import Button from '../ui/Button.js';
import InputText from '../ui/InputText.js';
import InputNumber from '../ui/InputNumber.js';
import ToggleSwitch from '../ui/ToggleSwitch.js';
import Select from '../ui/Select.js';
import RadioButton from '../ui/RadioButton.js';
import Checkbox from '../ui/Checkbox.js';
import StatusDot from '../components/StatusDot.vue';
import { useDnsStore } from '../stores/dns.js';
import { apiError } from '../utils/format.js';
import { isValidIpv4 } from '../utils/ip.js';

const store = useDnsStore();
const toast = useToast();

const forwarders = ref([]);
const savedForwarders = ref([]);
const savingForwarders = ref(false);
const noRecursion = ref(false);
const savedNoRecursion = ref(false);
let pollTimer = null;

const recursionTip =
  'When enabled, CIDRella is an authoritative-only DNS server: it answers for its own ' +
  'zones and records but will NOT forward or recursively resolve external domains for ' +
  'clients. Upstream forwarders, DNS encryption, and domain/GeoIP filtering have no ' +
  'effect while this is on. Use it for an internal-only / split-horizon DNS server.';

const forwardersDirty = computed(() => {
  if (noRecursion.value !== savedNoRecursion.value) return true;
  const current = forwarders.value.map(f => f.ip.trim()).filter(Boolean);
  const saved = savedForwarders.value;
  if (current.length !== saved.length) return true;
  return current.some((ip, i) => ip !== saved[i]);
});

// Starts empty and is filled from GET /api/dns/soa-defaults on load. These used
// to be literals that had drifted from the server (soa_minimum_ttl 900 here
// against 1800 there, audit #38). If the fetch fails the fields stay blank and
// savedSoa stays null, which already keeps the Save button disabled, so the
// control refuses itself rather than offering invented numbers.
const soaForm = ref({
  soa_primary_ns: '', soa_admin_email: '',
  soa_refresh: null, soa_retry: null, soa_expire: null, soa_minimum_ttl: null
});
const savedSoa = ref(null);
const savingSoa = ref(false);

const dnssecForm = ref({ enabled: false });
const savedDnssec = ref(null);
const savingDnssec = ref(false);
const dnssecSupported = ref(null);  // null = unknown until loaded
const ntpSynced = ref(false);

const dnssecDirty = computed(() =>
  savedDnssec.value !== null && dnssecForm.value.enabled !== savedDnssec.value.enabled
);

// ── DNS Encryption (forwarders DoT/DoH) ──
const encForm = ref({ mode: 'off', provider: 'cloudflare' });
const encCustom = ref({ hostname: '', addresses: '', doh_url: '' });
const encProviders = ref([]);
const encStatus = ref(null);
const savedEnc = ref(null);

const encModeOptions = [
  { label: 'Plaintext', value: 'off' },
  { label: 'DoT', value: 'tls' },
  { label: 'DoH', value: 'https' },
];
const providerOptions = computed(() => [
  ...encProviders.value.map(p => ({ label: p.label, value: p.id })),
  { label: 'Custom…', value: 'custom' },
]);
const encDirty = computed(() => {
  if (!savedEnc.value) return false;
  const s = savedEnc.value;
  if (encForm.value.mode !== s.mode) return true;
  if (encForm.value.mode === 'off') return false;
  if (encForm.value.provider !== s.provider) return true;
  if (encForm.value.provider === 'custom') {
    return encCustom.value.hostname !== s.custom.hostname ||
      encCustom.value.addresses !== s.custom.addresses ||
      encCustom.value.doh_url !== s.custom.doh_url;
  }
  return false;
});
const encStatusLine = computed(() => {
  if (encForm.value.mode === 'off' || !savedEnc.value || savedEnc.value.mode === 'off') return '';
  const st = encStatus.value;
  if (st?.recentErrors > 0) return `Encrypted forwarding active, but ${st.recentErrors} recent error(s). DNS fails closed on the encrypted path.`;
  return `Encrypted forwarding active (${savedEnc.value.mode === 'tls' ? 'DoT' : 'DoH'}).`;
});

function encSnapshot() {
  savedEnc.value = {
    mode: encForm.value.mode,
    provider: encForm.value.provider,
    custom: { ...encCustom.value },
  };
}

async function loadEncryption() {
  try {
    const d = await store.getEncryption();
    encProviders.value = d.providers || [];
    encStatus.value = d.status || null;
    encForm.value.mode = d.mode || 'off';
    const up = (d.upstreams || [])[0];
    if (up) {
      const match = encProviders.value.find(p => p.hostname === up.hostname);
      if (match) {
        encForm.value.provider = match.id;
      } else {
        encForm.value.provider = 'custom';
        encCustom.value = { hostname: up.hostname || '', addresses: (up.addresses || []).join(', '), doh_url: up.doh_url || '' };
      }
    } else {
      encForm.value.provider = encProviders.value[0]?.id || 'custom';
    }
    encSnapshot();
  } catch { /* leave defaults */ }
}

function buildEncUpstreams() {
  if (encForm.value.mode === 'off') return [];
  if (encForm.value.provider === 'custom') {
    return [{
      label: 'Custom',
      hostname: encCustom.value.hostname.trim(),
      addresses: encCustom.value.addresses.split(',').map(s => s.trim()).filter(Boolean),
      doh_url: encCustom.value.doh_url.trim(),
    }];
  }
  const p = encProviders.value.find(x => x.id === encForm.value.provider);
  return p ? [{ label: p.label, hostname: p.hostname, addresses: p.addresses, doh_url: p.doh_url }] : [];
}

// Converged save for the whole "Upstream Forwarders" card. The two concerns map
// to two endpoints: the forwarders endpoint carries the plaintext IP list + the
// recursion flag (always persisted so the IP list survives mode switches); the
// encryption endpoint carries the mode + provider. Saved sequentially with
// part-aware error reporting.
const upstreamDirty = computed(() => forwardersDirty.value || encDirty.value);

async function saveUpstream() {
  savingForwarders.value = true;
  let savedFwd = false;
  try {
    if (forwardersDirty.value) {
      const servers = forwarders.value.map(f => f.ip.trim()).filter(Boolean);
      const res = await store.updateForwarders(servers, noRecursion.value);
      savedForwarders.value = [...(res.servers || servers)];
      savedNoRecursion.value = !!res.no_recursion;
      savedFwd = true;
    }
    // Persist encryption whenever it's dirty (even with recursion off, so a
    // pending mode change isn't lost and the dirty state clears). The backend
    // keeps the stub stopped while no-recursion is set.
    if (encDirty.value) {
      const res = await store.updateEncryption(encForm.value.mode, buildEncUpstreams());
      encStatus.value = res.status || null;
      encSnapshot();
    }
    toast.add({ severity: 'success', summary: 'Upstream forwarders saved', life: 3000 });
  } catch (err) {
    const detail = savedFwd
      ? `Forwarders saved, but encryption update failed: ${apiError(err)}`
      : apiError(err);
    toast.add({ severity: 'error', summary: 'Error', detail, life: 6000 });
  } finally {
    savingForwarders.value = false;
  }
}

const soaDirty = computed(() => {
  if (!savedSoa.value) return false;
  const f = soaForm.value;
  const s = savedSoa.value;
  return f.soa_primary_ns !== s.soa_primary_ns || f.soa_admin_email !== s.soa_admin_email ||
    f.soa_refresh !== s.soa_refresh || f.soa_retry !== s.soa_retry ||
    f.soa_expire !== s.soa_expire || f.soa_minimum_ttl !== s.soa_minimum_ttl;
});

// Was a local /^(\d{1,3}\.){3}\d{1,3}$/, which checks shape but not octet range,
// so 999.999.999.999 passed the gate and got sent to the forwarder-test endpoint.
// utils/ip.js already exports the range-checking predicate.
// See REVIEW.md, duplicate-logic audit #43.

function fwdDotKind(fwd) {
  if (fwd.status === 'reachable') return 'ok';
  if (fwd.status === 'unreachable') return 'err';
  return 'muted';
}
function fwdDotLabel(fwd) {
  if (fwd.status === 'reachable') return 'Reachable';
  if (fwd.status === 'unreachable') return 'Unreachable';
  return 'Not yet tested';
}

function addForwarder() {
  forwarders.value.push({ ip: '', status: null });
}

function removeForwarder(i) {
  forwarders.value.splice(i, 1);
}

async function testForwarder(fwd) {
  const ip = fwd.ip.trim();
  if (!ip || !isValidIpv4(ip)) {
    fwd.status = null;
    return;
  }
  fwd.status = 'testing';
  try {
    const result = await store.testForwarder(ip);
    fwd.status = result.reachable ? 'reachable' : 'unreachable';
  } catch {
    fwd.status = 'unreachable';
  }
}

async function onForwarderBlur(i) {
  const fwd = forwarders.value[i];
  if (!fwd) return;
  await testForwarder(fwd);
}

async function testAllForwarders() {
  for (const fwd of forwarders.value) {
    await testForwarder(fwd);
  }
}

async function saveSoaDefaults() {
  savingSoa.value = true;
  try {
    await store.updateSoaDefaults(soaForm.value);
    savedSoa.value = { ...soaForm.value };
    toast.add({ severity: 'success', summary: 'SOA defaults saved', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally {
    savingSoa.value = false;
  }
}

async function loadDnssec() {
  try {
    const d = await store.getDnssec();
    dnssecForm.value = { enabled: !!d.enabled };
    savedDnssec.value = { enabled: !!d.enabled };
    dnssecSupported.value = d.supported;
    ntpSynced.value = !!d.ntp?.synchronized;
  } catch { /* leave defaults */ }
}

async function saveDnssec() {
  savingDnssec.value = true;
  try {
    const res = await store.updateDnssec(dnssecForm.value.enabled);
    savedDnssec.value = { enabled: dnssecForm.value.enabled };
    ntpSynced.value = !!res.ntp?.synchronized;
    toast.add({
      severity: 'success',
      summary: `DNSSEC ${dnssecForm.value.enabled ? 'enabled' : 'disabled'}`,
      life: 3000
    });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally {
    savingDnssec.value = false;
  }
}

onMounted(async () => {
  try {
    const { servers, no_recursion } = await store.getForwarders();
    forwarders.value = (servers || []).map(ip => ({ ip, status: null }));
    savedForwarders.value = [...(servers || [])];
    noRecursion.value = !!no_recursion;
    savedNoRecursion.value = !!no_recursion;
  } catch {
    forwarders.value = [];
    savedForwarders.value = [];
  }
  testAllForwarders();
  pollTimer = setInterval(testAllForwarders, 15 * 60 * 1000);
  try {
    const defaults = await store.getSoaDefaults();
    soaForm.value = defaults;
    savedSoa.value = { ...defaults };
  } catch { /* use local defaults */ }
  await loadDnssec();
  await loadEncryption();
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<style scoped>
.dns-sections {
  display: flex;
  flex-direction: column;
  gap: 2rem;
  max-width: 28rem;
}
.dns-section h4 {
  margin: 0 0 0.5rem;
}
.section-hint {
  font-size: var(--app-fs-xs);
  color: var(--p-text-muted-color);
  margin: 0 0 0.75rem;
  line-height: 1.4;
}
.forwarders-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.forwarder-entry {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.forwarder-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.25rem;
}
.fwd-testing { color: var(--p-text-muted-color); font-size: var(--app-fs-sm); }
.forwarder-hint {
  font-size: var(--app-fs-xs);
  color: var(--p-text-muted-color);
  margin: 0.25rem 0 0;
  line-height: 1.4;
}
.soa-defaults-form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.soa-defaults-form .field label {
  display: block;
  font-size: var(--app-fs-sm);
  font-weight: 600;
  margin-bottom: 0.25rem;
}
.soa-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
}
.soa-help {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1rem;
  height: 1rem;
  border-radius: 50%;
  background: var(--p-surface-200);
  color: var(--p-text-muted-color);
  font-size: var(--app-fs-xs);
  font-weight: 700;
  cursor: help;
  margin-left: 0.25rem;
  vertical-align: middle;
}
.field-help {
  display: block;
  font-size: var(--app-fs-xs);
  color: var(--p-text-muted-color);
  margin-top: 0.2rem;
}
.dnssec-form {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.dnssec-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: var(--app-fs-sm);
}
.dnssec-status,
.dnssec-warn {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: var(--app-fs-xs);
  color: var(--p-text-muted-color);
  margin: 0;
  line-height: 1.4;
}
.dnssec-warn {
  color: var(--p-red-400);
}
.recursion-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
  font-size: var(--app-fs-sm);
}
.dimmed {
  opacity: 0.45;
}
.recursion-note {
  color: var(--p-text-muted-color);
  font-style: italic;
}
.enc-form {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.enc-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.enc-row label {
  width: 6rem;
  font-size: var(--app-fs-sm);
  font-weight: 600;
}
.enc-modes {
  display: flex;
  align-items: center;
  gap: 1.25rem;
}
.enc-mode-option {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.enc-row .enc-modes label {
  width: auto;
  font-weight: 400;
  cursor: pointer;
}
.enc-row.mode-row {
  margin-bottom: 4px;
}
</style>
