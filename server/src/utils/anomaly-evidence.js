// Per-signal evidence: which names in a flagged window back a given factor.
// The sidecar's explainer says "high-entropy domains" and keeps the number;
// this ranks the actual names by the same measure so the drawer can show
// them. Pure functions over the grouped rows from queryClientWindowDomains,
// so the ranking is unit-testable without DuckDB.

// Shannon entropy of a name in bits per character, the sidecar's measure
// (features.py _shannon_entropy).
export function shannonEntropy(text) {
  const s = String(text || '');
  if (!s.length) return 0;
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const labelDepth = (domain) => String(domain).split('.').filter(Boolean).length;
const tldOf = (domain) => {
  const parts = String(domain).split('.').filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : '';
};

// feature -> how its evidence is ranked. `value` is what the drawer prints
// beside each name; `filter` drops names that contribute nothing to the
// signal; missing features have no name-shaped evidence (time of day, query
// type mix) and are not offered.
export const SIGNAL_EVIDENCE = Object.freeze({
  avg_domain_entropy: {
    metric: 'entropy',
    unit: 'bits per character',
    value: (r) => shannonEntropy(r.domain),
  },
  max_domain_length: { metric: 'length', unit: 'characters', value: (r) => r.domain.length },
  subdomain_depth_mean: { metric: 'depth', unit: 'labels', value: (r) => labelDepth(r.domain) },
  nxdomain_ratio: {
    metric: 'nxdomain',
    unit: 'NXDOMAIN answers',
    value: (r) => r.nxdomain_count,
    filter: (r) => r.nxdomain_count > 0,
  },
  block_ratio: {
    metric: 'blocked',
    unit: 'blocked queries',
    value: (r) => r.blocked_count,
    filter: (r) => r.blocked_count > 0,
  },
  type_other_ratio: {
    metric: 'other_types',
    unit: 'non-A/AAAA queries',
    value: (r) => r.other_type_count,
    filter: (r) => r.other_type_count > 0,
  },
  null_resolved_ratio: {
    metric: 'unresolved',
    unit: 'unresolved queries',
    value: (r) => r.unresolved_count,
    filter: (r) => r.unresolved_count > 0,
  },
  unique_resolved_ips: {
    metric: 'resolved_ips',
    unit: 'distinct answers',
    value: (r) => r.resolved_ip_count,
    filter: (r) => r.resolved_ip_count > 1,
  },
  unique_domain_count: { metric: 'count', unit: 'queries', value: (r) => r.count },
  query_count: { metric: 'count', unit: 'queries', value: (r) => r.count },
  burst_ratio: { metric: 'count', unit: 'queries', value: (r) => r.count },
  tld_diversity: { metric: 'tld', unit: 'distinct names', group: tldOf },
  // Ranked from queryClientNewDomains instead of the window's full list.
  new_domain_ratio: { metric: 'new', unit: 'queries', value: (r) => r.count, external: true },
});

export function hasSignalEvidence(feature) {
  return Object.hasOwn(SIGNAL_EVIDENCE, feature);
}

// rows: [{ domain, count, nxdomain_count, blocked_count, other_type_count,
// unresolved_count, resolved_ip_count }] for one window. Returns the top
// `limit` names for the feature plus how many qualified in all.
export function rankDomainsForSignal(feature, rows, limit = 8) {
  const rule = SIGNAL_EVIDENCE[feature];
  if (!rule) return null;
  let items;
  if (rule.group) {
    const groups = new Map();
    for (const r of rows) {
      const key = rule.group(r.domain);
      const g = groups.get(key) || { domain: key || '(none)', count: 0, value: 0 };
      g.count += r.count;
      g.value += 1;
      groups.set(key, g);
    }
    items = [...groups.values()];
  } else {
    items = rows
      .filter((r) => (rule.filter ? rule.filter(r) : true))
      .map((r) => ({ domain: r.domain, count: r.count, value: rule.value(r) }));
  }
  items.sort((a, b) => b.value - a.value || b.count - a.count || a.domain.localeCompare(b.domain));
  return {
    feature,
    metric: rule.metric,
    unit: rule.unit,
    total: items.length,
    items: items.slice(0, limit).map((i) => ({
      domain: i.domain,
      count: i.count,
      value: Number.isInteger(i.value) ? i.value : Number(i.value.toFixed(3)),
    })),
  };
}
