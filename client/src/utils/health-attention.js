// The "Needs attention" rows on the Analytics dashboard, derived from the
// status endpoints the page already fetches. Pure, so the ordering and tones
// are testable without mounting anything.
//
// snapshot fields (any may be null when its fetch failed):
//   services      GET /api/metrics/services
//   lifecycle     GET /api/metrics/ip-lifecycle
//   networkDhcp   GET /api/metrics/network-dhcp
//   rogueDhcp     GET /api/dhcp/rogue/status
//   anomalies     GET /api/anomalies/summary
//
// Each row: { id, tone: 'err' | 'warn' | 'muted', title, detail, count, to }.
// err rows come first, then warn, then muted, and within a tone the order
// below is kept: the things a person acts on first sit higher.

const TONE_ORDER = { err: 0, warn: 1, muted: 2 };
const ROGUE_NETWORK_ROWS = 3;

const plural = (n, one, many) => (n === 1 ? one : many);

export const ATTENTION_ROUTES = {
  serviceDown: '/system?area=maintenance&sec=logs',
  rogueDhcp: '/system?area=dhcp&sec=rogue',
  // Rogue hosts are listed per network; there is no all-networks addresses view.
  rogueHosts: (subnetId) =>
    `/networks?context=network&network=${subnetId}&view=addresses&type=rogue`,
  anomalies: '/analytics?view=anomalies',
  scopeConflicts: '/networks?context=all&view=dhcp',
  dhcpReview: '/networks?context=all&view=networks',
  reconciliation: '/system?area=maintenance&sec=updates',
};

export function attentionItems(snapshot = {}) {
  const { services, lifecycle, networkDhcp, rogueDhcp, anomalies } = snapshot;
  const rows = [];

  if (services && services.dnsmasq === false) {
    rows.push({
      id: 'dnsmasq-down',
      tone: 'err',
      title: 'dnsmasq is not running',
      detail: 'No DNS answers or DHCP leases until it is back',
      count: null,
      to: ATTENTION_ROUTES.serviceDown,
    });
  }

  const reconciliation = lifecycle?.reconciliation;
  if (
    reconciliation &&
    (reconciliation.outcome !== 'complete' ||
      reconciliation.failures > 0 ||
      reconciliation.blocking_conflicts > 0)
  ) {
    const parts = [];
    if (reconciliation.blocking_conflicts > 0) {
      parts.push(`${reconciliation.blocking_conflicts} blocking`);
    }
    if (reconciliation.failures > 0) parts.push(`${reconciliation.failures} failed`);
    rows.push({
      id: 'reconciliation',
      tone: 'err',
      title: 'IP reconciliation did not complete',
      detail: parts.length ? parts.join(', ') : `Outcome: ${reconciliation.outcome}`,
      count: null,
      to: ATTENTION_ROUTES.reconciliation,
    });
  }

  if (lifecycle?.scope_conflicts > 0) {
    rows.push({
      id: 'scope-conflicts',
      tone: 'err',
      title: 'DHCP scope conflicts',
      detail: 'Addresses claimed by more than one pool',
      count: lifecycle.scope_conflicts,
      to: ATTENTION_ROUTES.scopeConflicts,
    });
  }

  if (rogueDhcp?.unacknowledged > 0) {
    const n = rogueDhcp.unacknowledged;
    rows.push({
      id: 'rogue-dhcp',
      tone: 'warn',
      title: plural(n, 'Rogue DHCP server', 'Rogue DHCP servers'),
      detail: 'Answering clients on your network without authorization',
      count: n,
      to: ATTENTION_ROUTES.rogueDhcp,
    });
  }

  // One row per network, busiest first, since each links into that network.
  // Past ROGUE_NETWORK_ROWS the last row names how many more there are.
  const rogueNetworks = lifecycle?.rogue_hosts_by_network || [];
  rogueNetworks.slice(0, ROGUE_NETWORK_ROWS).forEach((network, i, shown) => {
    const more = rogueNetworks.length - shown.length;
    rows.push({
      id: `rogue-hosts-${network.subnet_id}`,
      tone: 'warn',
      title: `Rogue hosts in ${network.name || network.cidr}`,
      detail:
        i === shown.length - 1 && more > 0
          ? `Online at addresses nothing assigned them. ${more} more ${plural(more, 'network has', 'networks have')} them too`
          : 'Online at addresses nothing assigned them',
      count: network.count,
      to: ATTENTION_ROUTES.rogueHosts(network.subnet_id),
    });
  });

  if (anomalies?.unacknowledged_active > 0) {
    const sev = anomalies.by_severity || {};
    const serious = (sev.high || 0) + (sev.critical || 0);
    rows.push({
      id: 'anomalies',
      tone: serious > 0 ? 'err' : 'warn',
      title: 'Anomalous devices',
      detail:
        serious > 0
          ? `${serious} flagged high or critical`
          : 'Unacknowledged, none high or critical',
      count: anomalies.unacknowledged_active,
      to: ATTENTION_ROUTES.anomalies,
    });
  }

  const review = networkDhcp?.summary?.review_required || 0;
  const safe = networkDhcp?.summary?.safe_repairs || 0;
  if (review > 0 || safe > 0) {
    rows.push({
      id: 'dhcp-review',
      tone: review > 0 ? 'warn' : 'muted',
      title: review > 0 ? 'DHCP needs review' : 'DHCP repairs available',
      detail:
        review > 0 && safe > 0
          ? `${safe} more can be repaired safely`
          : review > 0
            ? 'Changes that need a decision before they apply'
            : `${safe} ${plural(safe, 'issue', 'issues')} can be repaired safely`,
      count: review > 0 ? review : safe,
      to: ATTENTION_ROUTES.dhcpReview,
    });
  }

  if (rogueDhcp && rogueDhcp.enabled && rogueDhcp.healthy === false) {
    rows.push({
      id: 'rogue-probe',
      tone: 'muted',
      title: 'Rogue DHCP probe cannot run here',
      detail: rogueDhcp.lastProbeError
        ? `${rogueDhcp.lastProbeError}. Findings above come from lease watching only.`
        : 'Findings above come from lease watching only.',
      count: null,
      to: ATTENTION_ROUTES.rogueDhcp,
    });
  }

  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => TONE_ORDER[a.row.tone] - TONE_ORDER[b.row.tone] || a.index - b.index)
    .map(({ row }) => row);
}

/** Count of rows a person has to decide on: everything that is not muted. */
export function openCount(rows) {
  return rows.filter((row) => row.tone !== 'muted').length;
}
