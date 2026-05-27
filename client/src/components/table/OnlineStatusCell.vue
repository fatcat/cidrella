<template>
  <span :class="state.className">{{ state.label }}</span>
</template>

<script setup>
import { computed } from 'vue';
import { displayOnlineStatus } from '../../utils/format.js';

const props = defineProps({
  value: { type: [Boolean, Number], default: null }
});

const state = computed(() => displayOnlineStatus(props.value));
</script>
