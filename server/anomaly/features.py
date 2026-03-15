"""Feature engineering — queries DuckDB via the Node.js internal API."""

import json
import math
import ssl
import urllib.request
from datetime import datetime, timedelta

import numpy as np

from config import NODE_API_BASE, FEATURE_NAMES

# SSL context for self-signed certs (localhost only)
_ssl_ctx = ssl.create_default_context()
_ssl_ctx.check_hostname = False
_ssl_ctx.verify_mode = ssl.CERT_NONE

_API_URL = f"{NODE_API_BASE}/api/internal/analytics/query"


def _parse_ts(s):
    """Parse an ISO timestamp string to a datetime object."""
    if s is None:
        return None
    if isinstance(s, datetime):
        return s
    # Handle Z suffix for Python < 3.11 compat
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def _query(sql, params=None):
    """Execute a SELECT query against DuckDB via the Node.js internal API."""
    body = json.dumps({"sql": sql, "params": params or []}).encode()
    req = urllib.request.Request(
        _API_URL,
        data=body,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, context=_ssl_ctx, timeout=30) as resp:
        result = json.loads(resp.read())
        return result.get("rows", [])


def _query_one(sql, params=None):
    """Execute a query and return the first row."""
    rows = _query(sql, params)
    return rows[0] if rows else None


def _shannon_entropy(s):
    """Shannon entropy of a string (bits)."""
    if not s:
        return 0.0
    freq = {}
    for c in s:
        freq[c] = freq.get(c, 0) + 1
    length = len(s)
    return -sum((count / length) * math.log2(count / length) for count in freq.values())


def get_active_clients(hours=24):
    """Return list of distinct client IPs seen in the last N hours."""
    hours = int(hours)
    rows = _query(
        f"SELECT DISTINCT client_ip FROM dns_queries "
        f"WHERE ts >= NOW() - INTERVAL '{hours} HOURS'",
    )
    return [r["client_ip"] for r in rows]


def get_client_history_hours(client_ip):
    """How many hours of data exist for this client."""
    row = _query_one(
        "SELECT EXTRACT(EPOCH FROM (MAX(ts) - MIN(ts))) / 3600.0 AS hours "
        "FROM dns_queries WHERE client_ip = ?",
        [client_ip],
    )
    return row["hours"] if row and row.get("hours") else 0.0


def extract_features(client_ip, window_start, window_end):
    """
    Extract ~20 features for a single client in a time window.
    Returns a numpy array matching FEATURE_NAMES order, or None if no data.
    """
    rows = _query(
        "SELECT ts, domain, query_type, response_code, action, resolved_ip "
        "FROM dns_queries "
        "WHERE client_ip = ? AND ts >= ? AND ts < ? "
        "ORDER BY ts",
        [client_ip, window_start, window_end],
    )

    if not rows:
        return None

    # Unpack
    timestamps = [_parse_ts(r["ts"]) for r in rows]
    domains = [r["domain"] for r in rows]
    query_types = [r["query_type"] for r in rows]
    response_codes = [r["response_code"] for r in rows]
    actions = [r["action"] for r in rows]
    resolved_ips = [r["resolved_ip"] for r in rows]

    n = len(rows)

    # --- Temporal features ---
    # Use the median timestamp's hour and day-of-week
    mid_ts = timestamps[n // 2]
    hour = mid_ts.hour + mid_ts.minute / 60.0
    dow = mid_ts.weekday()
    hour_sin = math.sin(2 * math.pi * hour / 24)
    hour_cos = math.cos(2 * math.pi * hour / 24)
    dow_sin = math.sin(2 * math.pi * dow / 7)
    dow_cos = math.cos(2 * math.pi * dow / 7)

    query_count = n

    # Burst ratio: max queries in any 1-minute bucket / mean per minute
    minute_buckets = {}
    for ts in timestamps:
        key = ts.replace(second=0, microsecond=0)
        minute_buckets[key] = minute_buckets.get(key, 0) + 1
    bucket_counts = list(minute_buckets.values())
    mean_per_min = n / max(len(bucket_counts), 1)
    burst_ratio = max(bucket_counts) / max(mean_per_min, 1)

    # --- Domain features ---
    unique_domains = set(domains)
    unique_domain_count = len(unique_domains)

    # New domain ratio: placeholder — filled by caller with historical context
    new_domain_ratio = 0.0

    entropies = [_shannon_entropy(d) for d in domains]
    avg_domain_entropy = sum(entropies) / n
    max_domain_length = max(len(d) for d in domains)

    depths = [d.count(".") + 1 for d in domains]
    subdomain_depth_mean = sum(depths) / n

    tlds = set(d.rsplit(".", 1)[-1] for d in domains if "." in d)
    tld_diversity = len(tlds)

    # --- Response features ---
    nxdomain_count = sum(1 for rc in response_codes if rc and "NXDOMAIN" in str(rc).upper())
    nxdomain_ratio = nxdomain_count / n

    block_count = sum(1 for a in actions if a and a != "allowed")
    block_ratio = block_count / n

    # --- Query type features ---
    type_a = sum(1 for qt in query_types if qt == "A")
    type_aaaa = sum(1 for qt in query_types if qt == "AAAA")
    type_other = n - type_a - type_aaaa
    type_a_ratio = type_a / n
    type_aaaa_ratio = type_aaaa / n
    type_other_ratio = type_other / n
    type_diversity = len(set(query_types))

    # --- Network features ---
    resolved = [ip for ip in resolved_ips if ip]
    unique_resolved_ips = len(set(resolved))
    null_resolved_ratio = (n - len(resolved)) / n

    features = np.array([
        hour_sin, hour_cos, dow_sin, dow_cos,
        query_count, burst_ratio,
        unique_domain_count, new_domain_ratio,
        avg_domain_entropy, max_domain_length,
        subdomain_depth_mean, tld_diversity,
        nxdomain_ratio, block_ratio,
        type_a_ratio, type_aaaa_ratio, type_other_ratio, type_diversity,
        unique_resolved_ips, null_resolved_ratio,
    ], dtype=np.float64)

    return features


def extract_features_with_history(client_ip, window_start, window_end,
                                  lookback_days=7, historical_domains=None):
    """
    Extract features and fill in the new_domain_ratio.
    If historical_domains set is provided, use it directly (avoids redundant query).
    """
    features = extract_features(client_ip, window_start, window_end)
    if features is None:
        return None

    # Compute new domain ratio
    window_domains = set(
        r["domain"] for r in _query(
            "SELECT DISTINCT domain FROM dns_queries "
            "WHERE client_ip = ? AND ts >= ? AND ts < ?",
            [client_ip, window_start, window_end],
        )
    )

    if window_domains and historical_domains is not None:
        new_count = sum(1 for d in window_domains if d not in historical_domains)
        new_ratio = new_count / len(window_domains)
    elif window_domains:
        # Fallback: query historical domains (used during single-window scoring)
        days = int(lookback_days)
        hist = set(
            r["domain"] for r in _query(
                "SELECT DISTINCT domain FROM dns_queries "
                f"WHERE client_ip = ? AND ts >= ? - INTERVAL '{days} DAYS' AND ts < ?",
                [client_ip, window_start, window_start],
            )
        )
        new_count = sum(1 for d in window_domains if d not in hist)
        new_ratio = new_count / len(window_domains)
    else:
        new_ratio = 0.0

    idx = FEATURE_NAMES.index("new_domain_ratio")
    features[idx] = new_ratio
    return features


def extract_training_data(client_ip, lookback_days=7):
    """
    Extract feature vectors for all 1-hour windows in the lookback period.
    Returns a 2D numpy array (n_windows x n_features) or None.
    """
    # Get time range
    days = int(lookback_days)
    row = _query_one(
        "SELECT MIN(ts) AS min_ts, MAX(ts) AS max_ts FROM dns_queries "
        f"WHERE client_ip = ? AND ts >= NOW() - INTERVAL '{days} DAYS'",
        [client_ip],
    )

    if not row or not row.get("min_ts"):
        return None

    min_ts = _parse_ts(row["min_ts"])
    max_ts = _parse_ts(row["max_ts"])

    # Generate 1-hour windows
    windows = []
    current = min_ts.replace(minute=0, second=0, microsecond=0)
    while current + timedelta(hours=1) <= max_ts:
        window_end = current + timedelta(hours=1)
        windows.append((current, window_end))
        current = window_end

    if not windows:
        return None

    # Pre-fetch ALL historical domains for this client in the lookback period.
    # This avoids the O(N^2) per-window historical query.
    all_historical = _query(
        "SELECT DISTINCT domain, MIN(ts) AS first_seen FROM dns_queries "
        f"WHERE client_ip = ? AND ts >= NOW() - INTERVAL '{days} DAYS' "
        "GROUP BY domain",
        [client_ip],
    )
    # Build a dict: domain → first_seen timestamp
    domain_first_seen = {r["domain"]: _parse_ts(r["first_seen"]) for r in all_historical}

    # Extract features for each window with incremental historical domain set
    feature_vectors = []
    for ws, we in windows:
        # Historical domains = all domains first seen before this window start
        hist_domains = {d for d, first in domain_first_seen.items() if first < ws}
        fv = extract_features_with_history(client_ip, ws, we, lookback_days,
                                           historical_domains=hist_domains)
        if fv is not None:
            feature_vectors.append(fv)

    if not feature_vectors:
        return None

    return np.array(feature_vectors)
