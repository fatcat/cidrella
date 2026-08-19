<template>
  <div class="pihole-import-panel">
    <Tabs :value="piholeTab">
      <TabList>
        <Tab value="online"><i class="pi pi-globe" style="margin-right: 0.3rem" />Online</Tab>
        <Tab value="file"><i class="pi pi-upload" style="margin-right: 0.3rem" />File Upload</Tab>
      </TabList>
      <TabPanels>
        <TabPanel value="online">
          <div class="form-grid" style="margin-top: 0.5rem">
            <div class="field">
              <label>Pi-hole URL</label>
              <InputText v-model="piholeUrl" placeholder="http://pihole.local" class="w-full"
                         :class="{ 'pihole-reachable': probeStatus === 'ok', 'pihole-unreachable': probeStatus === 'fail' }" />
              <small v-if="probeStatus === 'fail'" class="field-error">{{ probeError }}</small>
              <small v-if="probeStatus === 'ok' && needsPassword && !piholePassword" class="field-warn">Password required</small>
            </div>
            <div class="field">
              <label>Password (optional)</label>
              <InputText v-model="piholePassword" type="password" class="w-full" placeholder="Leave empty if none" />
            </div>
            <div class="field" style="text-align: right">
              <Button label="Connect" icon="pi pi-download" size="small"
                      @click="fetchConfig" :loading="fetching"
                      :disabled="probeStatus !== 'ok' || (needsPassword && !piholePassword)" />
            </div>
          </div>
        </TabPanel>
        <TabPanel value="file">
          <div class="form-grid" style="margin-top: 0.5rem">
            <div class="field">
              <label>Select pihole.toml</label>
              <input type="file" accept=".toml" @change="onFileSelect" ref="fileInput" />
            </div>
            <div class="field" style="text-align: right" v-if="fileContent">
              <Button label="Parse" icon="pi pi-cog" size="small"
                      @click="parseFile" :loading="parsing" />
            </div>
          </div>
        </TabPanel>
      </TabPanels>
    </Tabs>

    <div v-if="preview" class="pihole-preview">
      <h4>Import Preview</h4>
      <div class="preview-summary">
        <div class="preview-item">
          <span class="preview-count">{{ preview.hosts.length }}</span>
          <span class="preview-label">A records</span>
        </div>
        <div class="preview-item">
          <span class="preview-count">{{ preview.cnames.length }}</span>
          <span class="preview-label">CNAME records</span>
        </div>
        <div class="preview-item">
          <span class="preview-count">{{ preview.dhcpHosts.length }}</span>
          <span class="preview-label">DHCP reservations</span>
        </div>
      </div>
      <small v-if="preview.zoneName" class="muted">Zone: {{ preview.zoneName }}</small>
    </div>

    <div v-if="importResults" class="pihole-results">
      <Message severity="success" :closable="false">
        Import complete:
        {{ importResults.a.created }} A created<template v-if="importResults.a.updated">, {{ importResults.a.updated }} updated</template>;
        {{ importResults.cname.created }} CNAME created<template v-if="importResults.cname.updated">, {{ importResults.cname.updated }} updated</template>;
        {{ importResults.dhcp.created }} DHCP created
        <template v-if="importResults.dhcp.noSubnet > 0">
          ({{ importResults.dhcp.noSubnet }} DHCP skipped: no matching subnet)
        </template>
      </Message>
    </div>

    <div class="import-actions">
      <Button v-if="showCancel" label="Cancel" severity="secondary" @click="$emit('cancel')" />
      <Button v-if="!importResults" label="Import" icon="pi pi-download"
              @click="executeImport" :loading="importing"
              :disabled="!preview" />
      <Button v-else label="Reset" icon="pi pi-refresh" severity="secondary"
              @click="resetState" />
    </div>
  </div>
</template>

<script setup>
import { useToast } from '../ui/useToast.js';
import Button from '../ui/Button.js';
import InputText from '../ui/InputText.js';
import Message from '../ui/Message.js';
import Tabs from '../ui/Tabs.js';
import TabList from '../ui/TabList.js';
import Tab from '../ui/Tab.js';
import TabPanels from '../ui/TabPanels.js';
import TabPanel from '../ui/TabPanel.js';
import { usePiholeImport } from '../composables/usePiholeImport.js';

defineProps({
  showCancel: { type: Boolean, default: false }
});

const emit = defineEmits(['imported', 'cancel']);
const toast = useToast();

// All of this used to live here and again, inline, in NetworkDialogs.vue's
// wizard step 3. See composables/usePiholeImport.js and audit #47.
const {
  tab: piholeTab, url: piholeUrl, password: piholePassword,
  probeStatus, probeError, needsPassword,
  fetching, parsing, importing, preview, importResults, fileContent, fileInput,
  fetchConfig, onFileSelect, parseFile, executeImport, resetState,
} = usePiholeImport({ toast, onImported: () => emit('imported') });

defineExpose({ resetState });
</script>

<style scoped>
.pihole-import-panel {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.form-grid {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.field label {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--p-text-muted-color);
}
.field-error {
  color: var(--p-red-500);
  font-size: 0.75rem;
}
.field-warn {
  color: var(--p-orange-500);
  font-size: 0.75rem;
}
.pihole-reachable {
  border-color: var(--p-green-500) !important;
  box-shadow: 0 0 0 1px var(--p-green-500);
}
.pihole-unreachable {
  border-color: var(--p-red-500) !important;
  box-shadow: 0 0 0 1px var(--p-red-500);
}
.pihole-preview {
  padding: 0.75rem;
  border: 1px solid var(--p-surface-border);
  border-radius: 6px;
  background: var(--p-surface-50);
}
.pihole-preview h4 {
  margin: 0 0 0.5rem;
  font-size: 0.85rem;
  font-weight: 600;
}
.preview-summary {
  display: flex;
  gap: 1.5rem;
}
.preview-item {
  display: flex;
  flex-direction: column;
  align-items: center;
}
.preview-count {
  font-size: 1.4rem;
  font-weight: 700;
  color: var(--p-primary-color);
}
.preview-label {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}
.import-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}
.muted {
  color: var(--p-text-muted-color);
}
</style>
