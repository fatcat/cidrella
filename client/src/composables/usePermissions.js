import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useAuthStore } from '../stores/auth.js';

/**
 * Permission checks backed only by capabilities projected by the server.
 * The client deliberately has no role-to-permission table.
 */
export function usePermissions() {
  const auth = useAuthStore();
  const { permissions, isAdmin, user } = storeToRefs(auth);
  const permissionSet = computed(() => new Set(permissions.value));

  function can(permission) {
    return permissionSet.value.has('*') || permissionSet.value.has(permission);
  }

  function canAny(...required) {
    const list = required.length === 1 && Array.isArray(required[0]) ? required[0] : required;
    return list.some(can);
  }

  function canAll(...required) {
    const list = required.length === 1 && Array.isArray(required[0]) ? required[0] : required;
    return list.every(can);
  }

  function refreshCapabilities() {
    return auth.fetchUser();
  }

  return { permissions, isAdmin, user, can, canAny, canAll, refreshCapabilities };
}
