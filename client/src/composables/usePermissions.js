import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useAuthStore } from '../stores/auth.js';

/**
 * Permission checks backed only by capabilities projected by the server.
 * The client deliberately has no role-to-permission table.
 *
 * On a member the server marks the account read-only and projects no write
 * permission. `can` refuses every `:write` permission there even under the
 * admin wildcard, so a control gated on one is off for an admin too. What
 * acts on this box alone (interfaces, certificate, updates, logs, the
 * Instances page) is gated on `isAdmin`, which a member leaves as it is.
 */
export function usePermissions() {
  const auth = useAuthStore();
  const { permissions, isAdmin, user } = storeToRefs(auth);
  // Read off the store, not through storeToRefs: a server older than 0.7.0
  // sends no flag, and that reads as not read-only.
  const readOnly = computed(() => auth.readOnly === true);
  const permissionSet = computed(() => new Set(permissions.value));

  function can(permission) {
    if (readOnly.value && String(permission).endsWith(':write')) return false;
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

  return { permissions, isAdmin, readOnly, user, can, canAny, canAll, refreshCapabilities };
}
