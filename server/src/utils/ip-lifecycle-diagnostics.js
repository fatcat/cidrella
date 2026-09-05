import { DATA_DIR } from '../config/defaults.js';
import { readLifecycleMigrationReport } from '../db/ip-lifecycle-upgrade.js';
import { findEnabledScopeForIp } from '../models/dhcp-scope.js';
import { getLastRetirementDiagnostics } from '../services/ip-lifecycle-service.js';

const ALLOCATION_STATES = [
  'unassigned', 'reserved', 'static_dns', 'dynamic_dhcp', 'static_dhcp',
  'slaac', 'system', 'gateway', 'quarantined'
];

export function getIpLifecycleDiagnostics(db, { dataDir = DATA_DIR } = {}) {
  const allocationCounts = Object.fromEntries(ALLOCATION_STATES.map(state => [state, 0]));
  for (const row of db.prepare(`
    SELECT allocation_state, COUNT(*) AS count
    FROM ip_addresses
    GROUP BY allocation_state
  `).all()) {
    allocationCounts[row.allocation_state] = row.count;
  }

  let scopeConflicts = 0;
  const scopeCandidates = db.prepare(`
    SELECT subnet_id, ip_address, allocation_state, dhcp_version
    FROM ip_addresses
    WHERE allocation_state IN ('static_dns', 'dynamic_dhcp')
      AND address_family = 4
  `).all();
  for (const row of scopeCandidates) {
    const inScope = Boolean(findEnabledScopeForIp(db, row.subnet_id, row.ip_address));
    if (row.allocation_state === 'static_dns' && inScope) scopeConflicts++;
    if (row.allocation_state === 'dynamic_dhcp' && row.dhcp_version === 4 && !inScope) {
      scopeConflicts++;
    }
  }

  const migration = readLifecycleMigrationReport(dataDir);
  const migrationOutcome = migration?.outcome || 'not_required';
  const migrationConflicts = Number(migration?.summary?.blocking_conflicts) || 0;
  const retirementEvents = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN created_at >= datetime('now', '-24 hours') THEN 1 ELSE 0 END) AS last_24h
    FROM ip_events
    WHERE event_type = 'retired'
  `).get();

  return {
    allocations: allocationCounts,
    scope_conflicts: scopeConflicts,
    rogue_hosts: db.prepare(`
      SELECT COUNT(*) AS count
      FROM ip_addresses
      WHERE is_online = 1 AND is_rogue = 1 AND allocation_state = 'unassigned'
    `).get().count,
    retirement: {
      total: retirementEvents.total,
      last_24h: retirementEvents.last_24h || 0,
      last_run: getLastRetirementDiagnostics()
    },
    reconciliation: {
      outcome: migrationOutcome,
      blocking_conflicts: migrationConflicts,
      failures: ['blocked', 'reconciliation_pending', 'invalid'].includes(migrationOutcome) ? 1 : 0,
      generated_at: migration?.generated_at || null
    }
  };
}
