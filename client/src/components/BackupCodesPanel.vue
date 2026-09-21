<template>
  <div class="backup-codes" data-track="backup-codes-panel">
    <div class="fr-note ok">
      <span
        ><b>{{ lead }}</b> These backup codes are shown once. Each works one time.</span
      >
    </div>
    <ol class="codes">
      <li v-for="c in codes" :key="c" class="mono">{{ c }}</li>
    </ol>
    <div class="code-actions">
      <Button
        label="Copy"
        severity="secondary"
        size="small"
        icon="pi pi-copy"
        data-track="backup-codes-copy"
        @click="copyCodes"
      />
      <Button
        label="Download"
        severity="secondary"
        size="small"
        icon="pi pi-download"
        data-track="backup-codes-download"
        @click="downloadCodes"
      />
      <span v-if="copied" class="help">Copied.</span>
      <span v-if="error" class="help bad">{{ error }}</span>
    </div>
    <label class="saved-row">
      <Checkbox
        :model-value="saved"
        binary
        input-id="backup-codes-saved"
        data-track="backup-codes-saved"
        @update:model-value="emit('update:saved', $event === true)"
      />
      <span>I have saved these codes somewhere other than this appliance.</span>
    </label>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import Button from '../ui/Button.js';
import Checkbox from '../ui/Checkbox.js';

// One-time display of backup codes, with copy, download and the "I saved
// them" confirmation. Used by the first-run wizard and Settings > Access.
const props = defineProps({
  codes: { type: Array, required: true },
  username: { type: String, default: '' },
  lead: { type: String, default: 'Two-factor is on.' },
  saved: { type: Boolean, default: false },
});
const emit = defineEmits(['update:saved']);

const copied = ref(false);
const error = ref('');

const codesText = () =>
  `CIDRella backup codes for ${props.username}\nEach code works once.\n\n${props.codes.join('\n')}\n`;

async function copyCodes() {
  error.value = '';
  try {
    await navigator.clipboard.writeText(codesText());
    copied.value = true;
  } catch {
    error.value = 'Copy failed. Select the codes and copy them by hand, or download them.';
  }
}

function downloadCodes() {
  const blob = new Blob([codesText()], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'cidrella-backup-codes.txt';
  a.click();
  URL.revokeObjectURL(url);
}
</script>

<style scoped>
.backup-codes {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.fr-note {
  display: flex;
  gap: 10px;
  font-size: 0.85rem;
  color: var(--cid-text-muted-color);
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--cid-content-background);
  border-left: 3px solid var(--cid-green-500);
}
.codes {
  margin: 0;
  padding: 0 0 0 1.4rem;
  columns: 2;
  column-gap: 2rem;
  font-size: 1rem;
  line-height: 1.8;
}
.code-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
.help {
  font-size: 0.8rem;
  color: var(--cid-text-muted-color);
}
.bad {
  color: var(--cid-red-500);
}
.saved-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 0.9rem;
}
@media (max-width: 720px) {
  .codes {
    columns: 1;
  }
}
</style>
