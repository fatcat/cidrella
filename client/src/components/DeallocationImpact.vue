<!-- The removed / disabled / kept list under the Delete and Deallocate network
     dialogs, built from GET /api/subnets/:id/deallocation-preview. Only lines
     with something to say render. -->
<template>
  <div class="deallocation-impact" data-track="deallocation-impact">
    <p v-if="error" class="warn-text">{{ error }}</p>
    <p v-else-if="!preview" class="impact-loading">Checking what this affects...</p>
    <template v-else>
      <p v-if="preview.reservations > 0" class="warn-text impact-blocked">
        Remove the {{ preview.reservations }} DHCP
        {{ preview.reservations === 1 ? 'reservation' : 'reservations' }} in this network first.
      </p>
      <dl>
        <template v-if="removed.length">
          <dt>Removed</dt>
          <dd v-for="line in removed" :key="line" class="warn-text">{{ line }}</dd>
        </template>
        <template v-if="disabled.length">
          <dt>Disabled</dt>
          <dd v-for="zone in disabled" :key="zone.name">
            reverse zone <code>{{ zone.name }}</code>
          </dd>
        </template>
        <template v-if="kept.length">
          <dt>Kept</dt>
          <dd v-for="line in kept" :key="line">{{ line }}</dd>
        </template>
      </dl>
    </template>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  preview: { type: Object, default: null },
  error: { type: String, default: '' },
});

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const removed = computed(() => {
  const p = props.preview;
  if (!p) return [];
  const lines = [];
  if (p.scopes || p.leases) {
    lines.push(
      [
        p.scopes && plural(p.scopes, 'DHCP scope', 'DHCP scopes'),
        p.leases && plural(p.leases, 'lease', 'leases'),
      ]
        .filter(Boolean)
        .join(' and '),
    );
  }
  if (p.generated_ptr)
    lines.push(plural(p.generated_ptr, 'generated PTR record', 'generated PTR records'));
  if (p.generated_address_records) {
    lines.push(
      plural(p.generated_address_records, 'generated A/AAAA record', 'generated A/AAAA records'),
    );
  }
  lines.push('IP assignments and ranges');
  if (p.children) lines.push(plural(p.children, 'child network', 'child networks'));
  return lines;
});

const disabled = computed(() => (props.preview?.reverse_zones || []).filter((z) => z.will_disable));

const kept = computed(() => {
  const p = props.preview;
  if (!p) return [];
  const lines = (p.forward_zones || []).map(
    (name) => `forward zone ${name} and its manual records`,
  );
  for (const zone of p.reverse_zones || []) {
    if (!zone.will_disable) lines.push(`reverse zone ${zone.name} (still used by another network)`);
  }
  return lines;
});
</script>

<style scoped>
.deallocation-impact {
  margin-top: 0.5rem;
  font-size: 0.85rem;
}
.impact-loading {
  color: var(--cid-text-muted-color);
}
.impact-blocked {
  font-weight: 600;
}
dl {
  display: grid;
  grid-template-columns: auto 1fr;
  column-gap: 0.75rem;
  row-gap: 0.15rem;
  margin: 0.5rem 0 0;
}
dt {
  grid-column: 1;
  color: var(--cid-text-muted-color);
  text-transform: uppercase;
  font-size: 0.68rem;
  letter-spacing: 0.06em;
  padding-top: 0.15rem;
}
dd {
  grid-column: 2;
  margin: 0;
}
dd + dt {
  margin-top: 0.35rem;
}
dd + dt + dd {
  margin-top: 0.35rem;
}
.warn-text {
  color: var(--cid-red-500);
}
</style>
