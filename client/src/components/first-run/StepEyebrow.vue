<!-- "Step N of M" above each first-run screen. FirstRun.vue owns the numbering
     and provides it, so a screen never states its own place in the wizard. -->
<template>
  <div class="fr-eyebrow">{{ label }}</div>
</template>

<script setup>
import { inject } from 'vue';

const label = inject('firstRunStepLabel');
</script>
