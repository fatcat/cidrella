<template>
  <div class="empty-state-block">
    <i v-if="icon" :class="['pi', icon, 'empty-state-icon']" />
    <h3 v-if="title" class="empty-state-title">{{ title }}</h3>
    <p v-if="description" class="empty-state-description">{{ description }}</p>
    <div v-if="actions?.length" class="empty-state-actions">
      <Button
        v-for="(action, i) in actions"
        :key="i"
        :label="action.label"
        :icon="action.icon ? `pi ${action.icon}` : null"
        :severity="action.severity || 'primary'"
        :data-track="action.dataTrack || null"
        size="small"
        @click="action.onClick?.()"
      />
    </div>
  </div>
</template>

<script setup>
import Button from 'primevue/button';

defineProps({
  icon: { type: String, default: null },
  title: { type: String, default: null },
  description: { type: String, default: null },
  actions: { type: Array, default: () => [] },
});
</script>

<style scoped>
.empty-state-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-width: 320px;
  min-height: 240px;
  padding: 32px 16px;
  text-align: center;
  color: var(--p-text-muted-color);
  margin: 0 auto;
}
.empty-state-icon {
  font-size: 48px;
  color: var(--p-text-muted-color);
  opacity: 0.65;
  margin-bottom: 8px;
}
.empty-state-title {
  margin: 0;
  font-size: var(--app-fs-lg);
  font-weight: 600;
  color: var(--p-text-color);
}
.empty-state-description {
  margin: 0;
  font-size: var(--app-fs-sm);
  color: var(--p-text-muted-color);
  max-width: 360px;
  line-height: 1.5;
}
.empty-state-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
</style>
