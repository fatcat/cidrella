<template>
  <div class="first-run">
    <div class="fr-frame">
      <aside class="fr-rail">
        <div class="fr-brand">
          <span class="fr-brand-dot"></span>
          <span>CIDRella<small>First run</small></span>
        </div>
        <ol class="fr-steps" data-track="first-run-steps">
          <li
            v-for="s in STEPS"
            :key="s.n"
            :class="{ active: step === s.n, done: step > s.n }"
            :data-step="s.n"
          >
            <span class="fr-step-n">{{ s.n }}</span>
            <span>
              <span class="fr-step-label">{{ s.label }}</span>
              <span class="fr-step-sub">{{ step > s.n ? subtitleFor(s.n) : '' }}</span>
            </span>
          </li>
        </ol>
        <div class="fr-foot">
          Signed in as <span class="fr-mono">{{ auth.user?.username }}</span>
        </div>
      </aside>

      <main class="fr-stage">
        <div v-if="!setup.loaded" class="fr-loading">
          <i class="pi pi-spinner pi-spin"></i>
        </div>
        <template v-else>
          <StepPassword v-if="step === 1" @next="go(2)" />
          <StepTwoFactor v-else-if="step === 2" @next="go(3)" />
          <StepDeployment v-else-if="step === 3" @next="go(4)" @back="go(2)" />
          <StepImport v-else-if="step === 4" @next="go(5)" @back="go(3)" />
          <StepReview
            v-else-if="step === 5"
            :starting="starting"
            :progress="progress"
            :error="error"
            :restarting="restarting"
            @back="go(4)"
            @start="start"
          />
        </template>
      </main>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, provide } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import { useSetupStore } from '../stores/setup.js';
import { useSubnetStore } from '../stores/subnets.js';
import { useOperationsStore } from '../stores/operations.js';
import { usePiholeImport } from '../composables/usePiholeImport.js';
import { useToast } from '../ui/useToast.js';
import api from '../api/client.js';
import { apiError } from '../utils/format.js';
import StepPassword from '../components/first-run/StepPassword.vue';
import StepTwoFactor from '../components/first-run/StepTwoFactor.vue';
import StepDeployment from '../components/first-run/StepDeployment.vue';
import StepImport from '../components/first-run/StepImport.vue';
import StepReview from '../components/first-run/StepReview.vue';

// The first-run wizard. Five screens, one job each: replace the installer's
// one-time password, optionally add a second factor, say what this appliance
// does and on which interfaces, say what it brings with it, then Start
// applies the lot and opens the workspace. Nothing but the password touches the appliance before Start, so
// closing the tab halfway through leaves it exactly as installed. The server
// keeps a marker per finished step (stores/setup.js) so a return visit
// resumes at the step that was not finished.

const STEPS = [
  { n: 1, label: 'Admin password' },
  { n: 2, label: 'Two-factor' },
  { n: 3, label: 'Deployment' },
  { n: 4, label: 'Import' },
  { n: 5, label: 'Review & start' },
];
const ROLE_LABEL = { both: 'DNS & DHCP', dns: 'DNS only', dhcp: 'DHCP only' };
const IMPORT_LABEL = { fresh: 'start fresh', pihole: 'Pi-hole', cidrella: 'restore backup' };

const router = useRouter();
const auth = useAuthStore();
const setup = useSetupStore();
const subnets = useSubnetStore();
const ops = useOperationsStore();
const toast = useToast();

// One Pi-hole import flow for the whole wizard: the import step drives the
// probe and preview, Start runs the import. Shared through provide so the
// composable's debounce timer lives and dies with this view.
const pihole = usePiholeImport({ toast, fallbackZoneName: () => setup.draft.network.domain });
provide('firstRunPihole', pihole);

const step = ref(1);
const starting = ref(false);
const restarting = ref(false);
const progress = ref('');
const error = ref('');

function firstUnfinishedStep() {
  const s = setup.state;
  if (!s.password || auth.mustChangePassword) return 1;
  if (!s.totp) return 2;
  if (!s.deployment) return 3;
  if (!s.import) return 4;
  return 5;
}

function subtitleFor(n) {
  if (n === 1) return auth.user?.username || '';
  if (n === 2) return auth.totpEnabled ? 'on' : 'skipped';
  if (n === 3) return ROLE_LABEL[setup.draft.role] || '';
  if (n === 4) return IMPORT_LABEL[setup.draft.importKind] || '';
  return '';
}

function go(n) {
  error.value = '';
  step.value = n;
  window.scrollTo({ top: 0 });
}

onMounted(async () => {
  try {
    await setup.load();
  } catch (err) {
    error.value = apiError(err);
  }
  step.value = firstUnfinishedStep();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The service exits after a restore and systemd brings it back. Any HTTP
// answer means it is up again, including a 401 from a token the restored
// database does not know, so this uses fetch rather than the API client and
// its 401 interceptor.
async function waitForRestart() {
  await sleep(3000);
  for (let i = 0; i < 60; i++) {
    try {
      await fetch('/api/health', { cache: 'no-store' });
      return;
    } catch {
      await sleep(2000);
    }
  }
}

async function restoreAndRestart() {
  progress.value = 'Restoring the backup';
  await ops.restoreBackup(setup.draft.restoreFile, {
    dhcp: setup.draft.role === 'dns' ? 'disabled' : 'enabled',
  });
  restarting.value = true;
  progress.value = 'Service is restarting';
  await waitForRestart();
  auth.logout();
  router.push({ name: 'Login' });
}

async function start() {
  if (starting.value) return;
  starting.value = true;
  error.value = '';
  try {
    if (setup.draft.importKind === 'cidrella') {
      await restoreAndRestart();
      return;
    }

    progress.value = 'Applying the deployment';
    await api.put('/interfaces/config', setup.deploymentPayload);

    if (setup.draft.importKind === 'pihole') {
      progress.value = 'Creating the network';
      const { cidr, domain } = setup.draft.network;
      const created = await subnets.createSupernet({ cidr });
      await subnets.configureSubnet(created.id, {
        name: cidr,
        domain_name: domain,
        create_reverse_dns: true,
        create_dhcp_scope: false,
      });
      progress.value = 'Importing from the Pi-hole';
      await pihole.executeImport();
      if (!pihole.importResults.value) {
        throw new Error(
          'The Pi-hole import did not complete. The network was created; retry the import from Settings > Maintenance > Import.',
        );
      }
    }

    progress.value = 'Finishing';
    await subnets.updateSetting('setup_wizard_completed', 'true');
    await setup.mark({ done: true });
    await auth.fetchUser();
    router.push('/networks');
  } catch (err) {
    error.value = apiError(err);
  } finally {
    starting.value = false;
  }
}
</script>

<style>
/* Shared by the step components, so not scoped. Everything is prefixed fr-. */
.first-run {
  min-height: 100vh;
  background: var(--cid-surface-ground);
  color: var(--cid-text-color);
  padding: 24px 16px 48px;
  box-sizing: border-box;
}
.fr-frame {
  max-width: 980px;
  margin: 0 auto;
  background: var(--cid-surface-card);
  border: 1px solid var(--cid-surface-border);
  border-radius: 14px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
  display: grid;
  grid-template-columns: 240px 1fr;
  min-height: 560px;
  overflow: hidden;
}
.fr-rail {
  background: var(--cid-content-background);
  border-right: 1px solid var(--cid-surface-border);
  padding: 28px 22px;
  display: flex;
  flex-direction: column;
  gap: 28px;
}
.fr-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 600;
}
.fr-brand small {
  display: block;
  font-weight: 400;
  color: var(--cid-text-muted-color);
  font-size: 0.75rem;
}
.fr-brand-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--cid-primary-color);
}
.fr-steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.fr-steps li {
  display: grid;
  grid-template-columns: 26px 1fr;
  gap: 10px;
  align-items: start;
  padding: 8px 6px;
  border-radius: 8px;
  color: var(--cid-text-muted-color);
}
.fr-step-n {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 1.5px solid var(--cid-surface-border);
  display: grid;
  place-items: center;
  font-size: 0.75rem;
  font-weight: 600;
}
.fr-steps li.active {
  color: var(--cid-text-color);
  background: var(--cid-surface-card);
}
.fr-steps li.active .fr-step-n {
  border-color: var(--cid-primary-color);
  background: var(--cid-primary-color);
  color: var(--cid-primary-contrast-color, #fff);
}
.fr-steps li.done {
  color: var(--cid-text-color);
}
.fr-steps li.done .fr-step-n {
  border-color: var(--cid-green-500);
  color: var(--cid-green-500);
}
.fr-step-label {
  font-weight: 500;
  line-height: 1.3;
}
.fr-step-sub {
  display: block;
  font-size: 0.75rem;
  color: var(--cid-text-muted-color);
  min-height: 1em;
  margin-top: 2px;
}
.fr-foot {
  margin-top: auto;
  font-size: 0.75rem;
  color: var(--cid-text-muted-color);
}
.fr-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--cid-text-color);
}
.fr-stage {
  padding: 36px 40px 28px;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.fr-loading {
  margin: auto;
  font-size: 1.5rem;
  color: var(--cid-text-muted-color);
}
.fr-screen {
  display: flex;
  flex-direction: column;
  gap: 22px;
  flex: 1;
}
.fr-eyebrow {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--cid-text-muted-color);
  font-weight: 600;
}
.fr-screen h1 {
  font-size: 1.6rem;
  font-weight: 600;
  margin: 4px 0 0;
  text-wrap: balance;
}
.fr-lede {
  color: var(--cid-text-muted-color);
  max-width: 60ch;
  margin: 6px 0 0;
}
.fr-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 420px;
}
.fr-field label {
  font-weight: 500;
  font-size: 0.9rem;
}
.fr-help {
  font-size: 0.8rem;
  color: var(--cid-text-muted-color);
}
.fr-checks {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 18px;
  font-size: 0.8rem;
  color: var(--cid-text-muted-color);
  max-width: 420px;
}
.fr-checks li::before {
  content: '○ ';
}
.fr-checks li.ok {
  color: var(--cid-green-500);
}
.fr-checks li.ok::before {
  content: '● ';
}
.fr-cards {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}
.fr-card {
  text-align: left;
  background: var(--cid-surface-card);
  color: inherit;
  font: inherit;
  border: 1.5px solid var(--cid-surface-border);
  border-radius: 10px;
  padding: 16px 16px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 128px;
  cursor: pointer;
}
.fr-card:hover {
  border-color: var(--cid-text-muted-color);
}
.fr-card[aria-pressed='true'] {
  border-color: var(--cid-primary-color);
  background: color-mix(in srgb, var(--cid-primary-color) 12%, var(--cid-surface-card));
}
.fr-card:focus-visible {
  outline: 2px solid var(--cid-primary-color);
  outline-offset: 2px;
}
.fr-card-title {
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}
.fr-card-tag {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--cid-primary-color);
}
.fr-card-desc {
  font-size: 0.85rem;
  color: var(--cid-text-muted-color);
}
.fr-card-note {
  font-size: 0.85rem;
  margin-top: auto;
  padding-top: 6px;
}
.fr-card-note b {
  font-weight: 500;
}
.fr-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.fr-table th {
  text-align: left;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--cid-text-muted-color);
  font-weight: 600;
  padding: 6px 10px;
  border-bottom: 1px solid var(--cid-surface-border);
}
.fr-table td {
  padding: 9px 10px;
  border-bottom: 1px solid var(--cid-surface-border);
  vertical-align: top;
}
.fr-table .c {
  text-align: center;
  width: 90px;
}
.fr-table .muted {
  color: var(--cid-text-muted-color);
}
.fr-note {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  font-size: 0.85rem;
  color: var(--cid-text-muted-color);
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--cid-content-background);
}
.fr-note.warn {
  border-left: 3px solid var(--cid-orange-400);
}
.fr-note.ok {
  border-left: 3px solid var(--cid-green-500);
}
.fr-detail {
  border: 1px solid var(--cid-surface-border);
  border-radius: 10px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.fr-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.fr-summary {
  display: grid;
  grid-template-columns: 160px 1fr;
  gap: 8px 16px;
  font-size: 0.9rem;
  border: 1px solid var(--cid-surface-border);
  border-radius: 10px;
  padding: 16px 18px;
  margin: 0;
}
.fr-summary dt {
  color: var(--cid-text-muted-color);
}
.fr-summary dd {
  margin: 0;
}
.fr-next {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}
.fr-next div {
  border: 1px solid var(--cid-surface-border);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 0.85rem;
}
.fr-next b {
  display: block;
  font-weight: 500;
  margin-bottom: 2px;
}
.fr-next span {
  color: var(--cid-text-muted-color);
}
.fr-actions {
  margin-top: auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding-top: 14px;
  border-top: 1px solid var(--cid-surface-border);
}
.fr-actions .spacer {
  flex: 1;
}
.fr-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--cid-text-muted-color);
  font-size: 0.9rem;
}
@media (max-width: 720px) {
  .fr-frame {
    grid-template-columns: 1fr;
  }
  .fr-rail {
    padding: 18px 16px;
    gap: 14px;
    border-right: 0;
    border-bottom: 1px solid var(--cid-surface-border);
  }
  .fr-steps {
    flex-direction: row;
    overflow-x: auto;
  }
  .fr-steps li {
    grid-template-columns: 26px;
  }
  .fr-step-label,
  .fr-step-sub,
  .fr-foot {
    display: none;
  }
  .fr-stage {
    padding: 22px 16px;
  }
  .fr-cards,
  .fr-next,
  .fr-row,
  .fr-checks {
    grid-template-columns: 1fr;
  }
  .fr-summary {
    grid-template-columns: 1fr;
  }
}
</style>
