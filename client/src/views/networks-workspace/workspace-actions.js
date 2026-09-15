import api from '../../api/client.js';

const ACTION_DEFINITIONS = [
  {
    id: 'network.edit',
    label: 'Edit network',
    capability: 'subnets:write',
    targetKind: 'network',
  },
  {
    id: 'network.divide',
    label: 'Divide network',
    capability: 'subnets:write',
    targetKind: 'network',
    available: (target) => target.status === 'allocated' || target.allocated === true,
    disabledReason: 'Only allocated networks can be divided.',
  },
  {
    id: 'ip.reserve',
    label: 'Create IP Reservation',
    capability: 'subnets:write',
    targetKind: 'address',
    available: (target) => target.allocation_state === 'unassigned',
    disabledReason: 'Only an unassigned address can become an IP Reservation.',
  },
  {
    id: 'ip.release',
    label: 'Release IP Reservation',
    capability: 'subnets:write',
    targetKind: 'address',
    available: (target) => target.allocation_state === 'reserved',
    disabledReason: 'Only an IP Reservation can be released here.',
  },
  {
    id: 'ip.bulk-reserve',
    label: 'Create IP Reservations',
    capability: 'subnets:write',
    targetKind: 'address-selection',
    available: (target) =>
      target.count > 0 &&
      target.allocationStates?.length === target.count &&
      target.allocationStates.every((state) => state === 'unassigned'),
    disabledReason: 'Select only unassigned addresses to create IP Reservations.',
  },
  {
    id: 'ip.bulk-release',
    label: 'Release IP Reservations',
    capability: 'subnets:write',
    targetKind: 'address-selection',
    available: (target) =>
      target.count > 0 &&
      target.allocationStates?.length === target.count &&
      target.allocationStates.every((state) => state === 'reserved'),
    disabledReason: 'Select only IP Reservations to release them.',
  },
  {
    id: 'dns.record.edit',
    label: 'Edit DNS record',
    capability: 'dns:write',
    targetKind: 'dns-record',
  },
  {
    id: 'dhcp.reservation.create',
    label: 'Create DHCP Reservation',
    capability: 'dhcp:write',
    targetKind: 'address',
  },
];

export const WORKSPACE_ACTIONS = Object.freeze(
  Object.fromEntries(
    ACTION_DEFINITIONS.map((definition) => [
      definition.id,
      Object.freeze({
        available: () => true,
        disabledReason: '',
        ...definition,
      }),
    ]),
  ),
);

export function actionAvailability(actionId, target, can = () => false) {
  const action = WORKSPACE_ACTIONS[actionId];
  if (!action) return { available: false, reason: 'Unknown action.' };
  if (!target || target.kind !== action.targetKind) {
    return { available: false, reason: 'This action is not available for this resource.' };
  }
  if (!can(action.capability)) {
    return { available: false, reason: `Requires ${action.capability}.` };
  }
  if (!action.available(target)) {
    return { available: false, reason: action.disabledReason };
  }
  return { available: true, reason: '' };
}

export function createWorkspaceActionRegistry({ can, handlers = {} }) {
  function availability(actionId, target) {
    return actionAvailability(actionId, target, can);
  }

  async function invoke(actionId, target) {
    const action = WORKSPACE_ACTIONS[actionId];
    const state = availability(actionId, target);
    if (!state.available) return { invoked: false, reason: state.reason };
    const handler = handlers[actionId];
    if (typeof handler !== 'function') {
      return { invoked: false, reason: 'This action is not implemented yet.' };
    }
    const immutableTarget = Object.freeze({ ...target });
    return { invoked: true, result: await handler(immutableTarget, action) };
  }

  return { actions: WORKSPACE_ACTIONS, availability, invoke };
}

export function allocationPayload(allocationState, note = '') {
  if (!['reserved', 'unassigned'].includes(allocationState)) {
    throw new TypeError('Bulk allocation state must be reserved or unassigned.');
  }
  if (allocationState === 'reserved') {
    const cleanNote = note.trim();
    if (!cleanNote) throw new TypeError('An IP Reservation note is required.');
    return { allocation_state: 'reserved', note: cleanNote };
  }
  return { allocation_state: 'unassigned' };
}

export async function executeBulkAllocation({ subnetId, runs, allocationState, note, put }) {
  const send = put || api.put.bind(api);
  const allocation = allocationPayload(allocationState, note);
  const ledger = {
    completed: [],
    remaining: runs.map((run) => ({ ...run })),
    updated: 0,
    skipped: 0,
    error: null,
  };

  for (const run of runs) {
    const payload = { start_ip: run.start_ip, end_ip: run.end_ip, ...allocation };
    try {
      const response = await send(`/subnets/${subnetId}/ips/bulk-allocation`, payload);
      const result = response?.data || {};
      ledger.completed.push({ run: { ...run }, payload, result });
      ledger.remaining.shift();
      ledger.updated += Number(result.updated ?? result.count ?? 0);
      ledger.skipped += Number(result.skipped ?? 0);
    } catch (error) {
      ledger.error = error;
      break;
    }
  }
  return ledger;
}
