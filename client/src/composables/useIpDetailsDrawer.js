import { ref } from 'vue';

export function useIpDetailsDrawer() {
  const visible = ref(false);
  const host = ref(null);
  const subnetId = ref(null);
  const domainName = ref(null);

  function openIpDetails(row, options = {}) {
    if (!row?.ip_address) return false;
    host.value = row;
    subnetId.value = options.subnetId ?? row.subnet_id ?? null;
    domainName.value = options.domainName ?? null;
    visible.value = true;
    return true;
  }

  return { visible, host, subnetId, domainName, openIpDetails };
}
