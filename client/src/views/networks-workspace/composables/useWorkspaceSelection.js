import { computed, ref } from 'vue';

const MAX_BULK_ADDRESSES = 1024;

function parseIpv4(address) {
  if (typeof address !== 'string') return null;
  const octets = address.split('.');
  if (octets.length !== 4) return null;
  let value = 0;
  for (const octet of octets) {
    if (!/^\d{1,3}$/.test(octet)) return null;
    const number = Number(octet);
    if (number > 255 || String(number) !== octet) return null;
    value = value * 256 + number;
  }
  return value;
}

function formatIpv4(value) {
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join('.');
}

export function addressIdentity(value) {
  if (typeof value === 'string') return value.startsWith('address:') ? value : `address:${value}`;
  const address = value?.ip_address || value?.address || value?.ip;
  return address ? `address:${address}` : null;
}

export function identityAddress(identity) {
  return typeof identity === 'string' && identity.startsWith('address:')
    ? identity.slice('address:'.length)
    : null;
}

export function contiguousIpv4Runs(values, maxRunSize = MAX_BULK_ADDRESSES) {
  if (!Number.isInteger(maxRunSize) || maxRunSize < 1 || maxRunSize > MAX_BULK_ADDRESSES) {
    throw new RangeError(`Run size must be between 1 and ${MAX_BULK_ADDRESSES}.`);
  }
  const addresses = [...new Set(values.map(addressIdentity).map(identityAddress))]
    .map((address) => ({ address, value: parseIpv4(address) }))
    .filter((item) => item.value != null)
    .sort((left, right) => left.value - right.value);
  const runs = [];
  for (const item of addresses) {
    let run = runs.at(-1);
    const contiguous = run && item.value === run.endValue + 1;
    const hasRoom = run && run.count < maxRunSize;
    if (!contiguous || !hasRoom) {
      run = { startValue: item.value, endValue: item.value, count: 1 };
      runs.push(run);
    } else {
      run.endValue = item.value;
      run.count += 1;
    }
  }
  return runs.map((run) => ({
    start_ip: formatIpv4(run.startValue),
    end_ip: formatIpv4(run.endValue),
    count: run.count,
  }));
}

export function useWorkspaceSelection() {
  const identities = ref(new Set());
  const anchor = ref(null);
  const selectedIds = computed(() => [...identities.value]);
  const selectedCount = computed(() => identities.value.size);
  const runs = computed(() => contiguousIpv4Runs(selectedIds.value));

  function replace(next) {
    identities.value = new Set(next.map(addressIdentity).filter(Boolean));
  }

  function toggle(value, selected) {
    const identity = addressIdentity(value);
    if (!identity) return;
    const next = new Set(identities.value);
    const shouldSelect = selected ?? !next.has(identity);
    if (shouldSelect) next.add(identity);
    else next.delete(identity);
    identities.value = next;
    anchor.value = identity;
  }

  function selectVisibleRange(visibleRows, target) {
    const targetId = addressIdentity(target);
    const visibleIds = visibleRows.map(addressIdentity).filter(Boolean);
    const start = visibleIds.indexOf(anchor.value);
    const end = visibleIds.indexOf(targetId);
    if (start < 0 || end < 0) return toggle(targetId, true);
    const next = new Set(identities.value);
    for (const identity of visibleIds.slice(Math.min(start, end), Math.max(start, end) + 1)) {
      next.add(identity);
    }
    identities.value = next;
  }

  function toggleVisible(visibleRows, selected) {
    const visibleIds = visibleRows.map(addressIdentity).filter(Boolean);
    const next = new Set(identities.value);
    const shouldSelect = selected ?? visibleIds.some((identity) => !next.has(identity));
    for (const identity of visibleIds) {
      if (shouldSelect) next.add(identity);
      else next.delete(identity);
    }
    identities.value = next;
  }

  function clear() {
    identities.value = new Set();
    anchor.value = null;
  }

  function isSelected(value) {
    return identities.value.has(addressIdentity(value));
  }

  return {
    identities,
    selectedIds,
    selectedCount,
    runs,
    anchor,
    replace,
    toggle,
    selectVisibleRange,
    toggleVisible,
    clear,
    isSelected,
  };
}

export { MAX_BULK_ADDRESSES };
