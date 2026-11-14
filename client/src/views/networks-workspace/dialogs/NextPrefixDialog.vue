<template>
  <Dialog
    :visible="visible"
    modal
    header="Allocate next free prefix"
    :style="{ width: '32rem', maxWidth: 'calc(100vw - 2rem)' }"
    @update:visible="emit('update:visible', $event)"
  >
    <form class="workspace-range-form" @submit.prevent="submit">
      <label>
        Inside
        <Select
          v-model="chosenId"
          :options="parentOptions"
          optionLabel="label"
          optionValue="id"
          placeholder="Choose unallocated space"
          class="w-full"
          data-track="next-prefix-parent"
        />
      </label>
      <label>
        Prefix length
        <InputNumber
          v-model="prefix"
          :min="minPrefix"
          :max="maxPrefix"
          show-buttons
          prefix="/"
          class="w-full"
          data-track="next-prefix-length"
        />
      </label>
      <p class="workspace-range-help" role="status">{{ answerText }}</p>
      <div class="dialog-actions">
        <Button label="Cancel" severity="secondary" @click="emit('update:visible', false)" />
        <Button
          type="submit"
          :label="answer?.exact ? 'Allocate…' : 'Carve…'"
          :disabled="!answer"
          data-track="next-prefix-continue"
        />
      </div>
    </form>
  </Dialog>
</template>

<script setup>
// docs/IPV6-HANDLING.md, rule 4: the lowest free block of a size inside some
// unallocated space. Free space is the unallocated leaves a carve leaves
// behind, so the answer is one of them or a block carved from one; Continue
// hands it to the allocate or carve dialog, which does the writing.
import { computed, ref, watch } from 'vue';
import Button from '../../../ui/Button.js';
import Dialog from '../../../ui/Dialog.js';
import InputNumber from '../../../ui/InputNumber.js';
import Select from '../../../ui/Select.js';
import { parseNetwork } from '../../../utils/ip.js';
import {
  formatCoveragePercent,
  nextFreePrefix,
  prefixCoverage,
} from '../../networks-workspace-data.js';
import './range-dialogs.css';

const props = defineProps({
  visible: { type: Boolean, default: false },
  // The explorer's unallocated tree: folders of containers and free leaves.
  folders: { type: Array, default: () => [] },
  parentId: { type: Number, default: null },
});
const emit = defineEmits(['update:visible', 'continue']);

const chosenId = ref(null);
const prefix = ref(null);

const parents = computed(() => {
  const out = [];
  const walk = (node) => {
    out.push(node);
    for (const child of node.children || []) walk(child);
  };
  for (const folder of props.folders) for (const node of folder.networks) walk(node);
  return out.filter((node) => parseNetwork(node.cidr).prefix < parseNetwork(node.cidr).bits);
});
const parentOptions = computed(() =>
  parents.value.map((node) => ({
    id: node.id,
    label: `${node.cidr} · ${
      node.allocatable
        ? 'free'
        : `${formatCoveragePercent((node.coverage || prefixCoverage(node)).percent)} allocated`
    }`,
  })),
);
const parent = computed(() => parents.value.find((node) => node.id === chosenId.value) || null);
const parsedParent = computed(() => (parent.value ? parseNetwork(parent.value.cidr) : null));
const minPrefix = computed(() => (parsedParent.value ? parsedParent.value.prefix : 0));
const maxPrefix = computed(() => (parsedParent.value ? parsedParent.value.bits : 128));

// The usual next step down: a /64 from a /56 or longer and a /56 from a /48
// or shorter on IPv6; eight bits down, at most a /30, on IPv4.
function defaultPrefix(parsed) {
  if (parsed.family === 6) return parsed.prefix >= 56 ? 64 : parsed.prefix >= 48 ? 56 : 48;
  return Math.min(30, parsed.prefix + 8);
}

const answer = computed(() =>
  parent.value && Number.isInteger(prefix.value)
    ? nextFreePrefix(parent.value, prefix.value)
    : null,
);
const answerText = computed(() => {
  if (!parent.value) return 'Choose the space to plan in.';
  if (!answer.value) return `No free /${prefix.value} is left in ${parent.value.cidr}.`;
  return answer.value.exact
    ? `${answer.value.cidr} is free as it stands; allocate it next.`
    : `${answer.value.cidr}, carved from the free ${answer.value.leaf.cidr}.`;
});

watch(parsedParent, (parsed) => {
  if (parsed) prefix.value = Math.max(parsed.prefix, Math.min(parsed.bits, defaultPrefix(parsed)));
});
watch(
  () => props.visible,
  (visible) => {
    if (!visible) return;
    const preset = parents.value.some((node) => node.id === props.parentId) ? props.parentId : null;
    chosenId.value = preset ?? parents.value[0]?.id ?? null;
  },
  { immediate: true },
);

function submit() {
  if (!answer.value) return;
  emit('continue', answer.value);
  emit('update:visible', false);
}
</script>
