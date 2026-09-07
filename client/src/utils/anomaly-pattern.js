// Classifies flagged clients by the *shape* of their recent anomaly history,
// not just their current score, so "45 flagged clients" stops meaning one
// thing. Built from /api/anomalies/events (is_anomaly=1 rows only, resolved
// or not) plus the anomaly_models 'learning' list.

export const PATTERNS = {
  escalating: { label: 'Escalating', icon: '▲' },
  recurring: { label: 'Recurring pattern', icon: '↻' },
  resolved: { label: 'One-off, resolved', icon: '●' },
  flagged: { label: 'Flagged', icon: '!' },
  learning: { label: 'Learning baseline', icon: '◐' },
};

const ESCALATION_DELTA = 0.15;
const HOUR_BUCKET_SIZE = 4;
const HOUR_CLUSTER_SHARE = 0.7;

// Shared with AnomalyHeatmap.vue, which buckets a client's full score history
// into the same local day/hour grid this classifier reasons about.
export function dayKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function hourBucket(iso) {
  return Math.floor(new Date(iso).getHours() / HOUR_BUCKET_SIZE);
}

function mean(nums) {
  return nums.reduce((a, b) => a + b, 0) / (nums.length || 1);
}

function trendDelta(sortedEvents) {
  if (sortedEvents.length < 2) return 0;
  const cut = Math.max(1, Math.floor(sortedEvents.length / 3));
  const earliest = mean(sortedEvents.slice(0, cut).map(e => e.anomaly_score));
  const latest = mean(sortedEvents.slice(-cut).map(e => e.anomaly_score));
  return latest - earliest;
}

function hourClusterShare(events) {
  const counts = new Map();
  for (const e of events) {
    const b = hourBucket(e.window_start);
    counts.set(b, (counts.get(b) || 0) + 1);
  }
  const modal = Math.max(...counts.values());
  return modal / events.length;
}

function classifyGroup(events) {
  const sorted = [...events].sort((a, b) => a.window_start.localeCompare(b.window_start));
  const distinctDays = new Set(sorted.map(e => dayKey(e.window_start))).size;
  const currentlyActive = sorted.some(e => !e.resolved);
  const delta = trendDelta(sorted);
  const clusterShare = hourClusterShare(sorted);

  let pattern = 'flagged';
  let note;
  if (currentlyActive && distinctDays >= 2 && delta > ESCALATION_DELTA) {
    pattern = 'escalating';
    note = `Anomaly score has climbed for ${distinctDays} days with no sign of leveling off.`;
  } else if (distinctDays >= 3 && clusterShare >= HOUR_CLUSTER_SHARE) {
    pattern = 'recurring';
    note = `Triggers at a consistent time of day across ${distinctDays} days — looks scheduled, not intrusive.`;
  } else if (!currentlyActive) {
    pattern = 'resolved';
    note = 'Already back to baseline after a brief spike.';
  } else {
    note = 'Currently flagged; not enough history yet to tell if it’s worsening or routine.';
  }

  const latest = sorted[sorted.length - 1];
  return {
    identity: latest.identity || latest.client_ip,
    client_ip: latest.client_ip,
    hostname: latest.hostname,
    pattern,
    note,
    currentlyActive,
    latestScore: latest.anomaly_score,
    latestSeverity: latest.severity,
    latestTopFeatures: latest.top_features,
    eventCount: sorted.length,
    distinctDays,
    firstAt: sorted[0].window_start,
    lastAt: latest.window_start,
    sparkline: sorted.map(e => ({ t: e.window_start, score: e.anomaly_score })),
  };
}

/**
 * @param {Array} events - rows from GET /api/anomalies/events (.events)
 * @param {Array} learning - rows from GET /api/anomalies/events (.learning)
 */
export function classifyClients(events, learning = []) {
  // Grouped by identity (a MAC when known, else the client's IP) rather
  // than client_ip, so a device that renewed its IP mid-window shows up as
  // one continuous client instead of two unrelated ones.
  const byClient = new Map();
  for (const e of events) {
    const key = e.identity || e.client_ip;
    if (!byClient.has(key)) byClient.set(key, []);
    byClient.get(key).push(e);
  }

  const clients = [...byClient.values()].map(classifyGroup);

  for (const l of learning) {
    const key = l.identity || l.client_ip;
    if (byClient.has(key)) continue; // already flagged; learning status is stale
    clients.push({
      identity: key,
      client_ip: l.client_ip,
      hostname: l.hostname,
      pattern: 'learning',
      note: `Collecting a baseline: ${l.training_rows} training windows so far.`,
      currentlyActive: false,
      latestScore: null,
      latestSeverity: null,
      latestTopFeatures: null,
      eventCount: 0,
      distinctDays: 0,
      firstAt: null,
      lastAt: null,
      sparkline: [],
      trainingRows: l.training_rows,
    });
  }

  const order = { escalating: 0, recurring: 1, flagged: 2, resolved: 3, learning: 4 };
  clients.sort((a, b) => {
    if (order[a.pattern] !== order[b.pattern]) return order[a.pattern] - order[b.pattern];
    return (b.latestScore || 0) - (a.latestScore || 0);
  });
  return clients;
}

export function summaryCounts(clients) {
  const counts = { escalating: 0, recurring: 0, resolved: 0, flagged: 0, learning: 0 };
  for (const c of clients) counts[c.pattern] = (counts[c.pattern] || 0) + 1;
  return counts;
}
