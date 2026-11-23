<!-- The question between the password and the rest of first run: is this box
     set up on its own, or joined to a controller as a member. -->
<template>
  <section class="fr-screen" data-track="first-run-step-kind">
    <div>
      <StepEyebrow />
      <h1>Set up this box, or join another?</h1>
      <p class="fr-lede">
        A CIDRella runs on its own, or as a member of another one. A member holds a read-only copy
        of its controller's data, kept in sync, and serves DNS from it.
      </p>
    </div>

    <div class="fr-cards fr-cards-2" role="group" aria-label="Set up or join">
      <button
        type="button"
        class="fr-card"
        :aria-pressed="choice === 'setup'"
        data-track="first-run-kind-setup"
        @click="choice = 'setup'"
      >
        <span class="fr-card-title">Set up this CIDRella</span>
        <span class="fr-card-desc">
          The usual path. This box holds its own data and is the controller. Members can join it
          later.
        </span>
      </button>
      <button
        type="button"
        class="fr-card"
        :aria-pressed="choice === 'join'"
        data-track="first-run-kind-join"
        @click="choice = 'join'"
      >
        <span class="fr-card-title">Join an existing CIDRella</span>
        <span class="fr-card-desc">
          This box becomes a member of a controller that is already running. The controller's data
          replaces everything on this box.
        </span>
      </button>
    </div>

    <div class="fr-actions">
      <span class="spacer"></span>
      <span v-if="!choice" class="fr-help">Pick one.</span>
      <Button
        label="Continue"
        :disabled="!choice"
        data-track="first-run-kind-continue"
        @click="emit(choice)"
      />
    </div>
  </section>
</template>

<script setup>
import StepEyebrow from './StepEyebrow.vue';
import { ref } from 'vue';
import Button from '../../ui/Button.js';

const emit = defineEmits(['setup', 'join']);
const choice = ref(null);
</script>
