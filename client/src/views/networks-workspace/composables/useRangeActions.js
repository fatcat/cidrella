import { ref } from 'vue';
import api from '../../../api/client.js';

const PROTECTED_SYSTEM_TYPES = new Set(['Network', 'Broadcast']);

export function rangeLayer(range) {
  if (!range?.range_type_is_system && !range?.is_system) return 'organizational';
  if (range.range_type_name === 'Gateway') return 'gateway';
  if (range.range_type_name === 'DHCP Scope') return 'dhcp';
  return 'system';
}

export function rangeAction(range) {
  const layer = rangeLayer(range);
  if (layer === 'organizational') return 'edit-range';
  if (layer === 'gateway') return 'edit-network';
  if (layer === 'dhcp') return 'edit-dhcp-scope';
  return null;
}

export function isProtectedRange(range) {
  return rangeLayer(range) !== 'organizational';
}

export function isImmutableTopologyRange(range) {
  return rangeLayer(range) === 'system' && PROTECTED_SYSTEM_TYPES.has(range?.range_type_name);
}

export function exactRangeRuns(selectedRuns) {
  if (!Array.isArray(selectedRuns) || selectedRuns.length === 0) {
    throw new TypeError('Select at least one contiguous address run');
  }
  return selectedRuns.map((run) => {
    const startIp = run?.start_ip;
    const endIp = run?.end_ip;
    if (typeof startIp !== 'string' || typeof endIp !== 'string') {
      throw new TypeError('Every selected run needs start_ip and end_ip');
    }
    return { start_ip: startIp, end_ip: endIp };
  });
}

export function useRangeActions() {
  const busy = ref(false);

  async function request(method, url, data) {
    busy.value = true;
    try {
      const response = data === undefined ? await api[method](url) : await api[method](url, data);
      return response.data;
    } finally {
      busy.value = false;
    }
  }

  const listRanges = (subnetId) => request('get', `/subnets/${subnetId}/ranges`);
  const listRangeTypes = () => request('get', '/range-types');
  const createRange = (subnetId, payload) =>
    request('post', `/subnets/${subnetId}/ranges`, payload);
  const updateRange = (subnetId, rangeId, payload) =>
    request('put', `/subnets/${subnetId}/ranges/${rangeId}`, payload);
  const deleteRange = (subnetId, range) => {
    if (!range?.id) throw new TypeError('A range row is required');
    if (isProtectedRange(range)) {
      throw new TypeError('Functional ranges must be changed through their owning editor');
    }
    return request('delete', `/subnets/${subnetId}/ranges/${range.id}`);
  };
  const createRangeType = (payload) => request('post', '/range-types', payload);
  const updateRangeType = (rangeTypeId, payload) =>
    request('put', `/range-types/${rangeTypeId}`, payload);
  const deleteRangeType = (rangeType) => {
    if (!rangeType?.id) throw new TypeError('A Network Range Type row is required');
    if (rangeType.is_system) {
      throw new TypeError('Functional system range types cannot be deleted');
    }
    return request('delete', `/range-types/${rangeType.id}`);
  };
  const setRangeType = (subnetId, rangeTypeId, selectedRuns, acceptOverlaps = false) =>
    request('put', `/subnets/${subnetId}/ranges/set-type`, {
      range_type_id: rangeTypeId,
      ranges: exactRangeRuns(selectedRuns),
      accept_overlaps: acceptOverlaps,
    });

  return {
    busy,
    listRanges,
    listRangeTypes,
    createRange,
    updateRange,
    deleteRange,
    createRangeType,
    updateRangeType,
    deleteRangeType,
    setRangeType,
  };
}
