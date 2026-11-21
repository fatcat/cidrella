import { computed, ref } from 'vue';

/**
 * The controller a box joins: its address, HTTPS port and a join token, with
 * the one validation for them. First run's Join step and the rejoin of a
 * replaced controller both send `body()`; `components/instances/JoinTargetFields.vue`
 * is the three inputs.
 */
export function useJoinTarget() {
  const address = ref('');
  const port = ref(443);
  const token = ref('');

  const portOk = computed(
    () => Number.isInteger(port.value) && port.value >= 1 && port.value <= 65535,
  );
  // What still stops the request, in words, or '' when it can be sent.
  const blocker = computed(() => {
    if (!address.value.trim()) return "Enter the controller's address.";
    if (!portOk.value) return 'Enter a port from 1 to 65535.';
    if (!token.value.trim()) return 'Enter the join token.';
    return '';
  });

  const body = () => ({
    address: address.value.trim(),
    port: port.value,
    token: token.value.trim(),
  });

  return { address, port, token, blocker, body };
}
