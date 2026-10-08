<template>
  <div class="dns-page" style="display: flex; flex-direction: column; height: 100%">
    <div class="dns-sections">
      <div class="dns-section upstream-form">
        <h4>Upstream Forwarders</h4>
        <p class="section-hint">
          Where CIDRella sends the queries it cannot answer itself: a primary resolver and,
          optionally, a backup. Encrypted modes (DoT/DoH) offer curated unfiltered providers.
          CIDRella still does all filtering.
        </p>

        <div class="recursion-row">
          <Checkbox
            v-model="noRecursion"
            :binary="true"
            inputId="no-recursion"
            data-track="dns-toggle-no-recursion"
          />
          <label for="no-recursion">Do not provide recursion</label>
          <span v-tooltip.top="recursionTip" class="soa-help">?</span>
        </div>

        <template v-if="!noRecursion && loaded">
          <div class="enc-row mode-row">
            <label>Mode</label>
            <div class="enc-modes" role="radiogroup" aria-label="Upstream forwarding mode">
              <div v-for="opt in encModeOptions" :key="opt.value" class="enc-mode-option">
                <RadioButton
                  v-model="mode"
                  :inputId="`enc-mode-${opt.value}`"
                  name="enc-mode"
                  :value="opt.value"
                  data-track="dns-forwarding-mode"
                />
                <label :for="`enc-mode-${opt.value}`">{{ opt.label }}</label>
              </div>
            </div>
          </div>

          <!-- One pair of pickers per kind of mode, so each keeps its own saved picks -->
          <template v-for="kind in ['plain', 'encrypted']" :key="kind">
            <template v-if="(kind === 'encrypted') === encrypted">
              <ResolverPicker
                :modelValue="pairs[kind].primary"
                :providers="providers"
                :mode="mode"
                label="Primary"
                :idPrefix="`dns-${kind}-primary`"
                track="dns-resolver-primary"
                @update:modelValue="(sel) => (pairs[kind].primary = sel)"
              />
              <ResolverPicker
                :modelValue="pairs[kind].backup"
                :providers="providers"
                :mode="mode"
                label="Backup"
                :idPrefix="`dns-${kind}-backup`"
                track="dns-resolver-backup"
                allowNone
                @update:modelValue="(sel) => (pairs[kind].backup = sel)"
              />
            </template>
          </template>

          <template v-if="hasBackup">
            <div class="enc-row">
              <label id="dns-backup-mode-label">Use backup</label>
              <SelectButton
                v-model="backupMode"
                :options="BACKUP_MODE_OPTIONS"
                optionLabel="label"
                optionValue="value"
                :allowEmpty="false"
                size="small"
                aria-labelledby="dns-backup-mode-label"
                data-track="dns-backup-mode"
              />
            </div>
            <p class="forwarder-hint">{{ backupHint }}</p>
          </template>

          <template v-if="encrypted">
            <p v-if="encStatusLine" class="dnssec-status">
              <StatusDot
                :kind="encStatus?.recentErrors > 0 ? 'err' : 'ok'"
                :label="encStatus?.recentErrors > 0 ? 'Recent errors' : 'Active'"
              />
              {{ encStatusLine }}
            </p>
            <p class="forwarder-hint">
              When no resolver answers, forwarding fails closed. There is no silent fallback to
              plaintext.
            </p>
          </template>
          <p v-else class="forwarder-hint">
            Custom addresses are tested on entry and every 15 minutes. A failed test is retried once
            after 5 seconds before marking as down.
          </p>
        </template>

        <p v-else-if="noRecursion" class="forwarder-hint recursion-note">
          Recursion is disabled. CIDRella answers only for its own zones and records. Forwarders,
          encryption, and domain/GeoIP filtering do not apply.
        </p>

        <div class="forwarder-actions">
          <Button
            label="Save"
            icon="pi pi-save"
            size="small"
            data-track="dns-save-upstream"
            @click="saveUpstream"
            :loading="savingForwarders"
            :disabled="!upstreamDirty"
          />
          <Button
            label="Test performance"
            icon="pi pi-gauge"
            size="small"
            severity="secondary"
            data-track="dns-resolver-test"
            :disabled="noRecursion || !loaded"
            @click="testOpen = true"
          />
        </div>
        <ResolverTestDialog
          v-model:visible="testOpen"
          :mode="mode"
          :custom="testCustom"
          @pick="onPick"
        />
      </div>
      <div class="dns-section">
        <h4>SOA Defaults</h4>
        <p class="section-hint">Default values applied when creating new DNS zones.</p>
        <div class="soa-defaults-form">
          <div class="field">
            <label>Primary Nameserver</label>
            <InputText
              v-model="soaForm.soa_primary_ns"
              size="small"
              placeholder="ns1.localhost"
              style="width: 100%"
            />
          </div>
          <div class="field">
            <label>Admin Email</label>
            <InputText
              v-model="soaForm.soa_admin_email"
              size="small"
              placeholder="admin.localhost"
              style="width: 100%"
            />
            <small class="field-help"
              >Dotted notation (admin.example.com = admin@example.com)</small
            >
          </div>
          <div class="soa-grid">
            <div class="field">
              <label
                >Refresh (s)
                <span
                  v-tooltip.top="'How often secondaries check for zone updates'"
                  class="soa-help"
                  >?</span
                ></label
              >
              <InputNumber
                v-model="soaForm.soa_refresh"
                size="small"
                :min="0"
                style="width: 100%"
              />
            </div>
            <div class="field">
              <label
                >Retry (s)
                <span
                  v-tooltip.top="'How long secondaries wait before retrying a failed refresh'"
                  class="soa-help"
                  >?</span
                ></label
              >
              <InputNumber v-model="soaForm.soa_retry" size="small" :min="0" style="width: 100%" />
            </div>
            <div class="field">
              <label
                >Expire (s)
                <span
                  v-tooltip.top="'How long secondaries serve the zone without a successful refresh'"
                  class="soa-help"
                  >?</span
                ></label
              >
              <InputNumber v-model="soaForm.soa_expire" size="small" :min="0" style="width: 100%" />
            </div>
            <div class="field">
              <label
                >Minimum TTL (s)
                <span
                  v-tooltip.top="
                    'Default negative-cache TTL: how long resolvers cache NXDOMAIN responses'
                  "
                  class="soa-help"
                  >?</span
                ></label
              >
              <InputNumber
                v-model="soaForm.soa_minimum_ttl"
                size="small"
                :min="0"
                style="width: 100%"
              />
            </div>
          </div>
          <div class="forwarder-actions">
            <Button
              label="Save"
              icon="pi pi-save"
              size="small"
              data-track="dns-save-soa-defaults"
              @click="saveSoaDefaults"
              :loading="savingSoa"
              :disabled="!soaDirty"
            />
          </div>
        </div>
      </div>

      <div class="dns-section">
        <h4>DNSSEC Validation</h4>
        <p class="section-hint">
          Cryptographically validate DNS responses against the root trust anchor. Blocklist and
          GeoIP filtering continue to apply to validated answers.
        </p>
        <div class="dnssec-form">
          <div class="dnssec-row">
            <ToggleSwitch
              v-model="dnssecForm.enabled"
              data-track="dns-toggle-dnssec"
              :disabled="dnssecSupported === false"
            />
            <span>Enable DNSSEC validation</span>
          </div>
          <p v-if="dnssecSupported === false" class="dnssec-warn">
            This host's dnsmasq was not built with DNSSEC support, so validation cannot be enabled.
          </p>
          <p v-else-if="savedDnssec && savedDnssec.enabled" class="dnssec-status">
            <StatusDot
              :kind="ntpSynced ? 'ok' : 'muted'"
              :label="ntpSynced ? 'Clock synchronized' : 'Waiting for NTP sync'"
            />
            {{
              ntpSynced
                ? 'Clock synchronized. Signatures are fully validated.'
                : 'Waiting for NTP sync. Validation stays lenient on signature timestamps until the clock syncs.'
            }}
          </p>
          <div class="forwarder-actions">
            <Button
              label="Save"
              icon="pi pi-save"
              size="small"
              data-track="dns-save-dnssec"
              @click="saveDnssec"
              :loading="savingDnssec"
              :disabled="!dnssecDirty"
            />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useToast } from '../ui/useToast.js';
import Button from '../ui/Button.js';
import InputText from '../ui/InputText.js';
import InputNumber from '../ui/InputNumber.js';
import ToggleSwitch from '../ui/ToggleSwitch.js';
import RadioButton from '../ui/RadioButton.js';
import SelectButton from '../ui/SelectButton.js';
import Checkbox from '../ui/Checkbox.js';
import StatusDot from '../components/StatusDot.vue';
import ResolverPicker from '../components/dns/ResolverPicker.vue';
import ResolverTestDialog from '../components/dns/ResolverTestDialog.vue';
import '../components/dns/upstream-form.css';
import { useDnsStore } from '../stores/dns.js';
import { apiError } from '../utils/format.js';
import {
  CUSTOM,
  NONE,
  selection,
  plainSelection,
  encryptedSelection,
  plainAddresses,
  encryptedUpstream,
  selectionKey,
  customCandidates,
  resultSelection,
} from '../utils/resolvers.js';

const store = useDnsStore();
const toast = useToast();

const savingForwarders = ref(false);
const noRecursion = ref(false);
const loaded = ref(false);
const providers = ref([]);
const mode = ref('off'); // 'off' (plaintext) | 'tls' | 'https'
const backupMode = ref('balance');
// The plaintext and encrypted picks are saved separately (two endpoints), so
// each keeps its own pair and switching the mode shows that mode's picks.
const pairs = ref({
  plain: { primary: selection(CUSTOM), backup: selection(NONE) },
  encrypted: { primary: selection(CUSTOM), backup: selection(NONE) },
});
const saved = ref(null);
const testOpen = ref(false);

const encrypted = computed(() => mode.value !== 'off');
const currentPair = computed(() => pairs.value[encrypted.value ? 'encrypted' : 'plain']);
const hasBackup = computed(() => currentPair.value.backup.choice !== NONE);

const BACKUP_MODE_OPTIONS = [
  { label: 'On failure', value: 'failover' },
  { label: 'Load balance', value: 'balance' },
];
// Both modes go through CIDRella's forwarder, so the toggle means the same in each.
const backupHint = computed(() =>
  backupMode.value === 'failover'
    ? 'Every query goes to the primary. The backup gets it only when the primary gives no answer.'
    : 'Queries take turns between the two, and each answers for the other when it fails.',
);

const pairKey = (kind) => {
  const enc = kind === 'encrypted';
  const p = pairs.value[kind];
  return JSON.stringify([
    selectionKey(providers.value, p.primary, enc),
    selectionKey(providers.value, p.backup, enc),
  ]);
};
function snapshot() {
  saved.value = {
    noRecursion: noRecursion.value,
    mode: mode.value,
    backupMode: backupMode.value,
    plain: pairKey('plain'),
    encrypted: pairKey('encrypted'),
  };
}

const recursionTip =
  'When enabled, CIDRella is an authoritative-only DNS server: it answers for its own ' +
  'zones and records but will NOT forward or recursively resolve external domains for ' +
  'clients. Upstream forwarders, DNS encryption, and domain/GeoIP filtering have no ' +
  'effect while this is on. Use it for an internal-only / split-horizon DNS server.';

// PUT /forwarders carries the plaintext pair, the backup mode (both modes use
// it) and the recursion flag; PUT /encryption the mode and encrypted pair.
const forwardersDirty = computed(
  () =>
    !!saved.value &&
    (noRecursion.value !== saved.value.noRecursion ||
      backupMode.value !== saved.value.backupMode ||
      pairKey('plain') !== saved.value.plain),
);
const encDirty = computed(
  () =>
    !!saved.value &&
    (mode.value !== saved.value.mode ||
      (encrypted.value && pairKey('encrypted') !== saved.value.encrypted)),
);
const upstreamDirty = computed(() => forwardersDirty.value || encDirty.value);

// Starts empty and is filled from GET /api/dns/soa-defaults on load. These used
// to be literals that had drifted from the server (soa_minimum_ttl 900 here
// against 1800 there, audit #38). If the fetch fails the fields stay blank and
// savedSoa stays null, which already keeps the Save button disabled, so the
// control refuses itself rather than offering invented numbers.
const soaForm = ref({
  soa_primary_ns: '',
  soa_admin_email: '',
  soa_refresh: null,
  soa_retry: null,
  soa_expire: null,
  soa_minimum_ttl: null,
});
const savedSoa = ref(null);
const savingSoa = ref(false);

const dnssecForm = ref({ enabled: false });
const savedDnssec = ref(null);
const savingDnssec = ref(false);
const dnssecSupported = ref(null); // null = unknown until loaded
const ntpSynced = ref(false);

const dnssecDirty = computed(
  () => savedDnssec.value !== null && dnssecForm.value.enabled !== savedDnssec.value.enabled,
);

// ── Encrypted forwarding status ──
const encStatus = ref(null);
const encModeOptions = [
  { label: 'Plaintext', value: 'off' },
  { label: 'DoT', value: 'tls' },
  { label: 'DoH', value: 'https' },
];
const encStatusLine = computed(() => {
  if (!encrypted.value || !saved.value || saved.value.mode === 'off') return '';
  const st = encStatus.value;
  if (st?.recentErrors > 0)
    return `Encrypted forwarding active, but ${st.recentErrors} recent error(s). DNS fails closed on the encrypted path.`;
  return `Encrypted forwarding active (${saved.value.mode === 'tls' ? 'DoT' : 'DoH'}).`;
});

// Keep the reachability dots of addresses that are still there after a save.
function withStatuses(sel, previous) {
  const status = new Map(previous.custom.servers.map((s) => [s.ip, s.status]));
  if (sel.choice !== CUSTOM) return sel;
  return {
    ...sel,
    custom: {
      ...sel.custom,
      servers: sel.custom.servers.map((s) => ({ ...s, status: status.get(s.ip) ?? null })),
    },
  };
}

function applyForwarders(fwd) {
  const p = pairs.value.plain;
  pairs.value.plain = {
    primary: withStatuses(plainSelection(providers.value, fwd.servers || []), p.primary),
    backup: withStatuses(
      plainSelection(providers.value, fwd.backup_servers || [], { allowNone: true }),
      p.backup,
    ),
  };
  backupMode.value = fwd.backup_mode || 'balance';
  noRecursion.value = !!fwd.no_recursion;
}

async function loadUpstream() {
  let fwd = { servers: [], backup_servers: [], backup_mode: 'balance', no_recursion: false };
  let enc = { mode: 'off', upstreams: [], providers: [] };
  try {
    fwd = await store.getForwarders();
  } catch {
    /* leave defaults */
  }
  try {
    enc = await store.getEncryption();
  } catch {
    /* leave defaults */
  }
  providers.value = enc.providers || [];
  encStatus.value = enc.status || null;
  mode.value = enc.mode || 'off';
  applyForwarders(fwd);
  const [primary, backup] = enc.upstreams || [];
  pairs.value.encrypted = {
    primary: encryptedSelection(providers.value, primary),
    backup: encryptedSelection(providers.value, backup, { allowNone: true }),
  };
  snapshot();
  loaded.value = true;
}

async function saveUpstream() {
  savingForwarders.value = true;
  let savedFwd = false;
  try {
    if (forwardersDirty.value) {
      const p = pairs.value.plain;
      const res = await store.updateForwarders({
        servers: plainAddresses(providers.value, p.primary),
        backup_servers: plainAddresses(providers.value, p.backup),
        backup_mode: backupMode.value,
        no_recursion: noRecursion.value,
      });
      applyForwarders(res); // shows what was stored, in its canonical spelling
      savedFwd = true;
    }
    // Persist encryption whenever it's dirty (even with recursion off, so a
    // pending mode change isn't lost and the dirty state clears). The backend
    // keeps the stub stopped while no-recursion is set.
    if (encDirty.value) {
      const p = pairs.value.encrypted;
      const upstreams = encrypted.value
        ? [p.primary, p.backup]
            .map((sel) => encryptedUpstream(providers.value, sel))
            .filter(Boolean)
        : [];
      const res = await store.updateEncryption(mode.value, upstreams);
      encStatus.value = res.status || null;
    }
    snapshot();
    toast.add({ severity: 'success', summary: 'Upstream forwarders saved', life: 3000 });
  } catch (err) {
    if (savedFwd) snapshot();
    const detail = savedFwd
      ? `Forwarders saved, but encryption update failed: ${apiError(err)}`
      : apiError(err);
    toast.add({ severity: 'error', summary: 'Error', detail, life: 6000 });
  } finally {
    savingForwarders.value = false;
  }
}

// ── Resolver performance test ──
const testCustom = computed(() =>
  customCandidates(
    providers.value,
    [currentPair.value.primary, currentPair.value.backup],
    mode.value,
  ),
);

// A result row fills the form; nothing is saved until Save.
function onPick(role, row) {
  const pair = currentPair.value;
  const picked = resultSelection(row, encrypted.value);
  const key = (sel) => selectionKey(providers.value, sel, encrypted.value);
  if (role === 'backup' && key(picked) === key(pair.primary)) {
    toast.add({ severity: 'info', summary: `${row.label} is already the primary`, life: 3000 });
    return;
  }
  // Picking the backup as the primary swaps the two.
  if (role === 'primary' && key(picked) === key(pair.backup)) pair.backup = pair.primary;
  pair[role] = picked;
  toast.add({
    severity: 'info',
    summary: `${row.label} set as ${role}`,
    detail: 'Save to apply it.',
    life: 3000,
  });
}

const soaDirty = computed(() => {
  if (!savedSoa.value) return false;
  const f = soaForm.value;
  const s = savedSoa.value;
  return (
    f.soa_primary_ns !== s.soa_primary_ns ||
    f.soa_admin_email !== s.soa_admin_email ||
    f.soa_refresh !== s.soa_refresh ||
    f.soa_retry !== s.soa_retry ||
    f.soa_expire !== s.soa_expire ||
    f.soa_minimum_ttl !== s.soa_minimum_ttl
  );
});

// Was a local /^(\d{1,3}\.){3}\d{1,3}$/, which checks shape but not octet range,
// so 999.999.999.999 passed the gate and got sent to the forwarder-test endpoint.
// utils/ip.js already exports the range-checking predicate.
// See REVIEW.md, duplicate-logic audit #43.

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
  } catch {
    /* leave defaults */
  }
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
      life: 3000,
    });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally {
    savingDnssec.value = false;
  }
}

onMounted(async () => {
  try {
    const defaults = await store.getSoaDefaults();
    soaForm.value = defaults;
    savedSoa.value = { ...defaults };
  } catch {
    /* use local defaults */
  }
  await loadDnssec();
  await loadUpstream();
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
  color: var(--cid-text-muted-color);
  margin: 0 0 0.75rem;
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
  background: var(--cid-surface-200);
  color: var(--cid-text-muted-color);
  font-size: var(--app-fs-xs);
  font-weight: 700;
  cursor: help;
  margin-left: 0.25rem;
  vertical-align: middle;
}
.field-help {
  display: block;
  font-size: var(--app-fs-xs);
  color: var(--cid-text-muted-color);
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
  color: var(--cid-text-muted-color);
  margin: 0;
  line-height: 1.4;
}
.dnssec-warn {
  color: var(--cid-red-400);
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
  color: var(--cid-text-muted-color);
  font-style: italic;
}
.enc-form {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
</style>
