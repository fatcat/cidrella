"""Configuration constants for the anomaly detection sidecar."""

import os
import pathlib

# Data directory — mirrors Node.js DATA_DIR convention
DATA_DIR = pathlib.Path(os.environ.get("DATA_DIR", str(pathlib.Path(__file__).resolve().parent.parent / "data")))

# Paths
SQLITE_PATH = DATA_DIR / "cidrella.db"
MODELS_DIR = DATA_DIR / "anomaly" / "models"

# Node.js API — anomaly sidecar queries DuckDB via the Node.js internal API
NODE_API_PORT = int(os.environ.get("HTTPS_PORT", "8443"))
NODE_API_BASE = f"https://127.0.0.1:{NODE_API_PORT}"

# Timing
SCORING_INTERVAL_SEC = 900          # 15 minutes
TRAINING_INTERVAL_SEC = 21600       # 6 hours
DISABLED_POLL_SEC = 60              # check enabled flag when disabled
MIN_TRAINING_HOURS = 48             # cold start threshold
FEATURE_WINDOW_HOURS = 1            # each scored window
TRAINING_LOOKBACK_DAYS = 7          # matches analytics retention

# Model parameters
ANOMALY_THRESHOLD_HIGH = -0.6       # strongly anomalous
ANOMALY_THRESHOLD_MEDIUM = -0.5     # moderately anomalous
AUTO_RESOLVE_WINDOWS = 4            # consecutive normal windows to auto-resolve
SCORE_RETENTION_DAYS = 30           # anomaly history retention

# Sensitivity presets → Isolation Forest contamination parameter
SENSITIVITY_MAP = {
    "low": 0.02,
    "medium": 0.05,
    "high": 0.10,
}

# Feature names (order must match features.py extract_features output)
FEATURE_NAMES = [
    "hour_sin", "hour_cos", "dow_sin", "dow_cos",
    "query_count", "burst_ratio",
    "unique_domain_count", "new_domain_ratio",
    "avg_domain_entropy", "max_domain_length",
    "subdomain_depth_mean", "tld_diversity",
    "nxdomain_ratio", "block_ratio",
    "type_a_ratio", "type_aaaa_ratio", "type_other_ratio", "type_diversity",
    "unique_resolved_ips", "null_resolved_ratio",
]

# Human-readable labels for feature explanation
FEATURE_LABELS = {
    "hour_sin": "Unusual time of day",
    "hour_cos": "Unusual time of day",
    "dow_sin": "Unusual day of week",
    "dow_cos": "Unusual day of week",
    "query_count": "Abnormal query volume",
    "burst_ratio": "Bursty query pattern",
    "unique_domain_count": "Unusual number of distinct domains",
    "new_domain_ratio": "High ratio of never-before-seen domains",
    "avg_domain_entropy": "High-entropy domains (possible DGA)",
    "max_domain_length": "Unusually long domain names",
    "subdomain_depth_mean": "Deep subdomain nesting",
    "tld_diversity": "Unusual TLD diversity",
    "nxdomain_ratio": "High NXDOMAIN rate",
    "block_ratio": "High blocked query rate",
    "type_a_ratio": "Unusual A record ratio",
    "type_aaaa_ratio": "Unusual AAAA record ratio",
    "type_other_ratio": "Unusual non-A/AAAA query types",
    "type_diversity": "Unusual query type diversity",
    "unique_resolved_ips": "Unusual number of resolved IPs",
    "null_resolved_ratio": "High unresolved query ratio",
}
