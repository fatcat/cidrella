<template>
  <section class="fr-screen" data-track="first-run-step-import">
    <div>
      <div class="fr-eyebrow">Step 4 of 5</div>
      <h1>Bringing anything with you?</h1>
      <p class="fr-lede">
        Local DNS records, DHCP reservations and networks can come from a Pi-hole or from another
        CIDRella. Or start clean and add networks as you go.
      </p>
    </div>

    <div class="fr-cards" role="group" aria-label="Import source">
      <button
        v-for="k in KINDS"
        :key="k.id"
        type="button"
        class="fr-card"
        :aria-pressed="draft.importKind === k.id"
        :data-track="`first-run-import-${k.id}`"
        @click="draft.importKind = k.id"
      >
        <span class="fr-card-title">{{ k.title }}</span>
        <span class="fr-card-desc">{{ k.desc }}</span>
        <span class="fr-card-note"
          ><b>{{ k.noteLead }}</b> {{ k.note }}</span
        >
      </button>
    </div>

    <div v-if="draft.importKind === 'fresh'" class="fr-detail">
      <p class="fr-help">
        A Pi-hole can still be imported later from Settings &gt; Maintenance &gt; Import, and a
        backup restored from Backup &amp; Restore.
      </p>
    </div>

    <div v-else-if="draft.importKind === 'pihole'" class="fr-detail">
      <div class="fr-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          :aria-selected="pihole.tab.value === 'online'"
          @click="pihole.tab.value = 'online'"
        >
          Connect to it
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="pihole.tab.value === 'file'"
          @click="pihole.tab.value = 'file'"
        >
          Upload pihole.toml
        </button>
      </div>

      <div v-if="pihole.tab.value === 'online'" class="fr-row">
        <div class="fr-field">
          <label for="fr-pihole-url">Pi-hole URL</label>
          <InputText
            id="fr-pihole-url"
            v-model="pihole.url.value"
            placeholder="http://pihole.local"
            :class="{
              'fr-ok': pihole.probeStatus.value === 'ok',
              'fr-bad': pihole.probeStatus.value === 'fail',
            }"
          />
          <span v-if="pihole.probeStatus.value === 'fail'" class="fr-help fr-bad-text">{{
            pihole.probeError.value
          }}</span>
          <span v-else class="fr-help">Probed as you type. Nothing is written until Start.</span>
        </div>
        <div class="fr-field">
          <label for="fr-pihole-password">Web password</label>
          <Password
            v-model="pihole.password.value"
            input-id="fr-pihole-password"
            :input-props="{ autocomplete: 'off' }"
            :feedback="false"
            toggle-mask
            class="w-full"
            input-class="w-full"
          />
          <span class="fr-help">Used once for the fetch, never stored.</span>
        </div>
        <div class="fr-fetch">
          <Button
            label="Fetch configuration"
            size="small"
            :loading="pihole.fetching.value"
            :disabled="
              pihole.probeStatus.value !== 'ok' ||
              (pihole.needsPassword.value && !pihole.password.value)
            "
            data-track="first-run-pihole-fetch"
            @click="pihole.fetchConfig()"
          />
        </div>
      </div>

      <div v-else class="fr-row">
        <div class="fr-field">
          <label for="fr-pihole-file">pihole.toml</label>
          <input
            id="fr-pihole-file"
            :ref="pihole.fileInput"
            type="file"
            accept=".toml,text/plain"
            @change="pihole.onFileSelect"
          />
          <span class="fr-help">Parsed first so you can see what would come across.</span>
        </div>
        <div class="fr-fetch">
          <Button
            label="Parse file"
            size="small"
            :loading="pihole.parsing.value"
            :disabled="!pihole.fileContent.value"
            data-track="first-run-pihole-parse"
            @click="pihole.parseFile()"
          />
        </div>
      </div>

      <template v-if="preview">
        <div class="fr-note ok">
          <span class="fr-mono"
            >{{ preview.hosts.length }} hosts · {{ preview.cnames.length }} CNAMEs ·
            {{ preview.dhcpHosts.length }} static leases<template v-if="preview.zoneName">
              · zone {{ preview.zoneName }}</template
            ></span
          >
        </div>
        <p class="fr-help">
          Records need a DNS zone and reservations need a network, so one network is created at
          Start with these two values. Both can be changed afterwards.
        </p>
        <div class="fr-row">
          <div class="fr-field">
            <label for="fr-net-domain">Domain</label>
            <InputText id="fr-net-domain" v-model="draft.network.domain" placeholder="home.arpa" />
            <span v-if="domainError" class="fr-help fr-bad-text">{{ domainError }}</span>
          </div>
          <div class="fr-field">
            <label for="fr-net-cidr">Network</label>
            <InputText
              id="fr-net-cidr"
              v-model="draft.network.cidr"
              placeholder="192.168.1.0/24"
              class="fr-mono"
            />
            <span v-if="cidrError" class="fr-help fr-bad-text">{{ cidrError }}</span>
            <span v-else-if="inferredCidr" class="fr-help">
              Inferred from the leases; {{ leasesOutside }} of {{ preview.dhcpHosts.length }} fall
              outside it.
            </span>
          </div>
        </div>
      </template>
    </div>

    <div v-else class="fr-detail">
      <div class="fr-field">
        <label for="fr-restore-file">Backup file</label>
        <input
          id="fr-restore-file"
          type="file"
          accept=".tar.gz,application/gzip"
          data-track="first-run-restore-file"
          @change="onRestoreFile"
        />
        <span class="fr-help">
          A cidrella-backup-*.tar.gz. Compatibility is checked before anything is touched.
        </span>
      </div>
      <div class="fr-note warn">
        <span>
          A restore replaces this appliance's data, including the password you just set and the
          deployment choice: the backup's own users and settings win. The one thing carried across
          is <b>DHCP: {{ draft.role === 'dns' ? 'off' : 'on' }}</b> from step 2, so a copy of
          another appliance never starts serving that appliance's pools.
        </span>
      </div>
    </div>

    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

    <div class="fr-actions">
      <Button label="Back" severity="secondary" data-track="first-run-back" @click="emit('back')" />
      <span class="spacer"></span>
      <span v-if="blocker" class="fr-help">{{ blocker }}</span>
      <Button
        label="Continue"
        :disabled="!!blocker"
        :loading="saving"
        data-track="first-run-import-continue"
        @click="submit"
      />
    </div>
  </section>
</template>

<script setup>
import { ref, computed, inject, watch } from 'vue';
import Button from '../../ui/Button.js';
import InputText from '../../ui/InputText.js';
import Password from '../../ui/Password.js';
import Message from '../../ui/Message.js';
import { useSetupStore } from '../../stores/setup.js';
import { apiError } from '../../utils/format.js';
import {
  ipToLong,
  longToIp,
  isValidIpv4,
  isIpInSubnet,
  cidrValidationError,
  isValidDomain,
} from '../../utils/ip.js';

const emit = defineEmits(['next', 'back']);
const setup = useSetupStore();
const draft = setup.draft;
// The one Pi-hole flow shared with FirstRun.vue, which runs the import at Start.
const pihole = inject('firstRunPihole');

const KINDS = [
  {
    id: 'fresh',
    title: 'Start fresh',
    desc: 'Empty IPAM. The first thing you will do after setup is create a network.',
    noteLead: 'Fastest.',
    note: 'Nothing to upload.',
  },
  {
    id: 'pihole',
    title: 'From a Pi-hole',
    desc: 'Reads local DNS records, CNAMEs and static DHCP leases from pihole.toml.',
    noteLead: 'Needs',
    note: 'its URL and password, or the file.',
  },
  {
    id: 'cidrella',
    title: 'From a CIDRella backup',
    desc: 'Restores everything: networks, records, scopes, users and settings.',
    noteLead: 'Replaces',
    note: "steps 1 and 2 with the backup's own values.",
  },
];

const saving = ref(false);
const error = ref('');
const preview = computed(() => pihole.preview.value);

// The /24 most of the static leases live in. A guess the operator can edit,
// never silently applied: the field shows it and the count of leases it
// would leave out.
function inferCidr(dhcpHosts) {
  const counts = new Map();
  for (const h of dhcpHosts || []) {
    if (!isValidIpv4(h.ip)) continue;
    const net = longToIp(ipToLong(h.ip) & 0xffffff00);
    counts.set(net, (counts.get(net) || 0) + 1);
  }
  let best = null;
  for (const [net, n] of counts) if (!best || n > best.n) best = { net, n };
  return best ? `${best.net}/24` : '';
}
const inferredCidr = computed(() => inferCidr(preview.value?.dhcpHosts));

watch(preview, (p) => {
  if (!p) return;
  if (!draft.network.domain && p.zoneName) draft.network.domain = p.zoneName;
  if (!draft.network.cidr && inferredCidr.value) draft.network.cidr = inferredCidr.value;
});

const cidrError = computed(() => {
  if (!preview.value) return null;
  const cidr = draft.network.cidr.trim();
  if (!cidr) return 'A network is required for the reservations.';
  return cidrValidationError(cidr);
});
const domainError = computed(() => {
  if (!preview.value) return null;
  const d = draft.network.domain.trim();
  if (!d) return 'A domain is required for the records.';
  return isValidDomain(d) ? null : 'Not a valid domain name.';
});
const leasesOutside = computed(() => {
  if (!preview.value || cidrError.value) return 0;
  const cidr = draft.network.cidr.trim();
  return preview.value.dhcpHosts.filter((h) => !isValidIpv4(h.ip) || !isIpInSubnet(h.ip, cidr))
    .length;
});

const blocker = computed(() => {
  if (draft.importKind === 'pihole') {
    if (!preview.value) return 'Fetch or parse the Pi-hole configuration first.';
    if (cidrError.value || domainError.value) return 'Fix the network fields.';
  }
  if (draft.importKind === 'cidrella' && !draft.restoreFile) return 'Choose a backup file.';
  return '';
});

function onRestoreFile(event) {
  draft.restoreFile = event.target.files?.[0] || null;
}

async function submit() {
  if (blocker.value || saving.value) return;
  saving.value = true;
  error.value = '';
  try {
    await setup.mark({ import: { kind: draft.importKind } });
    emit('next');
  } catch (err) {
    error.value = apiError(err);
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.fr-tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--cid-surface-border);
}
.fr-tabs button {
  background: transparent;
  border: 0;
  padding: 6px 10px;
  color: var(--cid-text-muted-color);
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  font: inherit;
  cursor: pointer;
}
.fr-tabs button[aria-selected='true'] {
  color: var(--cid-text-color);
  border-bottom-color: var(--cid-primary-color);
}
.fr-fetch {
  grid-column: 1 / -1;
  display: flex;
  justify-content: flex-end;
}
.fr-ok :deep(input),
.fr-ok {
  border-color: var(--cid-green-500);
}
.fr-bad :deep(input),
.fr-bad {
  border-color: var(--cid-red-500);
}
.fr-bad-text {
  color: var(--cid-red-500);
}
.w-full {
  width: 100%;
}
</style>
