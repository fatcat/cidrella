<!--
  Filtering › Search: look up whether a domain is blocked and by which
  categories. Extracted from Blocklists.vue's inner "Search" TabPanel when
  the Filtering area's nested tabs were flattened (v0.4.16).
-->
<template>
  <div class="blocklist-search" style="display: flex; flex-direction: column; height: 100%;">
    <div class="settings-row">
      <InputText v-model="searchQuery" placeholder="Search blocked domains..." style="width: 20rem"
                 @keyup.enter="doSearch()" />
      <Button label="Search" icon="pi pi-search" size="small" @click="doSearch()" :loading="searching" />
    </div>
    <DataTable v-if="searchResults.items.length > 0 || searchPerformed" :value="searchResults.items"
               stripedRows size="small"
               :paginator="searchResults.items.length > 256" :rows="256"
               :rowsPerPageOptions="[64, 128, 256, 512]"
               scrollable scrollHeight="flex">
      <template #empty>
        <EmptyState icon="pi-search" title="No matching domains" description="Try a different search. Matches include every enabled category." />
      </template>
      <Column field="domain" header="Domain" />
      <Column field="categories" header="Categories" />
      <Column header="Status" style="width: 8rem">
        <template #body="{ data }">
          <span v-if="data.whitelisted" class="badge badge-green">Whitelisted</span>
          <span v-else class="badge badge-red">Blocked</span>
        </template>
      </Column>
    </DataTable>
    <EmptyState v-else icon="pi-search" title="Search the blocklists"
                description="Enter a domain (or part of one) to see whether the enabled categories block it." />
    <!--
      Page number without a total. The server cannot produce an exact match
      count without a second full scan of a table that holds millions of rows,
      so it reports only whether another page exists. See the comment on
      GET /api/blocklists/search.
    -->
    <div class="search-pagination" v-if="searchResults.hasMore || searchPage > 1">
      <Button label="Previous" severity="secondary" size="small" :disabled="searchPage <= 1"
              @click="searchPage--; doSearch(true)" />
      <span class="page-info">Page {{ searchPage }}</span>
      <Button label="Next" severity="secondary" size="small"
              :disabled="!searchResults.hasMore"
              @click="searchPage++; doSearch(true)" />
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useToast } from 'primevue/usetoast';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import EmptyState from '../../components/EmptyState.vue';
import { apiError } from '../../utils/format.js';
import { useBlocklistStore } from '../../stores/blocklists.js';

const store = useBlocklistStore();
const toast = useToast();

const searchQuery = ref('');
const searchResults = ref({ items: [], hasMore: false });
const searchPage = ref(1);
const searchLimit = 50;
const searching = ref(false);
const searchPerformed = ref(false);

async function doSearch(fromPagination = false) {
  if (!searchQuery.value.trim() || searchQuery.value.trim().length < 2) return;
  if (!fromPagination) searchPage.value = 1;
  searching.value = true;
  searchPerformed.value = true;
  try {
    searchResults.value = await store.searchDomains(searchQuery.value.trim(), searchPage.value, searchLimit);
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Search failed', detail: apiError(err), life: 5000 });
  } finally {
    searching.value = false;
  }
}
</script>

<style scoped>
.settings-row { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem; flex-wrap: wrap; }
.search-pagination {
  display: flex;
  align-items: center;
  gap: 1rem;
  justify-content: center;
  margin-top: 0.5rem;
}
.page-info { font-size: var(--app-fs-sm); color: var(--p-text-muted-color); }
</style>
