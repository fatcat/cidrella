"""SQLite storage for anomaly scores and model metadata."""

import json
import sqlite3
from datetime import datetime, timezone

from config import SQLITE_PATH, SCORE_RETENTION_DAYS


def _connect():
    """Connect to the CIDRella SQLite database."""
    con = sqlite3.connect(str(SQLITE_PATH), timeout=10)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    return con


def ensure_tables():
    """Create anomaly tables if they don't exist.

    Mirrors server/src/db/migrations/{042,043,055}_*.sql, which is the
    authoritative schema in real deployments (Node initializes the DB
    before this daemon ever runs). This only matters for a from-scratch
    environment where this module runs first.
    """
    con = _connect()
    try:
        con.executescript("""
            CREATE TABLE IF NOT EXISTS anomaly_scores (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                client_ip TEXT NOT NULL,
                identity TEXT,
                scored_at TEXT NOT NULL,
                window_start TEXT NOT NULL,
                window_end TEXT NOT NULL,
                anomaly_score REAL NOT NULL,
                is_anomaly INTEGER NOT NULL DEFAULT 0,
                severity TEXT,
                top_features TEXT,
                resolved INTEGER NOT NULL DEFAULT 0,
                resolved_at TEXT
            );

            CREATE TABLE IF NOT EXISTS anomaly_models (
                identity TEXT PRIMARY KEY,
                client_ip TEXT,
                trained_at TEXT NOT NULL,
                training_rows INTEGER NOT NULL,
                model_version INTEGER NOT NULL DEFAULT 1,
                status TEXT NOT NULL DEFAULT 'learning'
            );

            CREATE INDEX IF NOT EXISTS idx_anomaly_scores_active
                ON anomaly_scores(is_anomaly, resolved) WHERE is_anomaly = 1 AND resolved = 0;

            CREATE UNIQUE INDEX IF NOT EXISTS idx_anomaly_scores_identity_window
                ON anomaly_scores(identity, window_start);
        """)
        con.commit()
    finally:
        con.close()


def resolve_identity(client_ip):
    """Resolve a client IP to a stable identity: its current DHCP MAC if
    known, otherwise the IP itself.

    A MAC survives IP churn (a lease renewal), which client_ip alone does
    not: without this, a device that takes over a stale IP would silently
    inherit whatever baseline the previous holder had trained. The IP
    fallback covers hosts CIDRella has no lease for (static, out-of-pool).
    """
    con = _connect()
    try:
        row = con.execute(
            "SELECT mac_address FROM dhcp_leases WHERE ip_address = ?", (client_ip,)
        ).fetchone()
        return row["mac_address"] if row and row["mac_address"] else client_ip
    finally:
        con.close()


def get_whitelisted_identities():
    """Return set of whitelisted identities (MAC or IP-fallback)."""
    con = _connect()
    try:
        rows = con.execute("SELECT identity FROM anomaly_whitelist").fetchall()
        return {row["identity"] for row in rows}
    except sqlite3.OperationalError:
        # Table may not exist yet (pre-migration)
        return set()
    finally:
        con.close()


def is_enabled():
    """Check if anomaly detection is enabled in settings."""
    con = _connect()
    try:
        row = con.execute(
            "SELECT value FROM settings WHERE key = 'anomaly_detection_enabled'"
        ).fetchone()
        return row and row["value"] in ("true", "1")
    finally:
        con.close()


def get_setting(key, default=None):
    """Read a setting from the settings table."""
    con = _connect()
    try:
        row = con.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else default
    finally:
        con.close()


def save_score(identity, client_ip, window_start, window_end, anomaly_score,
               is_anomaly, severity=None, top_features=None):
    """Insert or update an anomaly score. client_ip is the IP actually
    observed for this window; identity is the resolved MAC (or client_ip
    itself, when no MAC is known) that scores/models are grouped under."""
    con = _connect()
    try:
        con.execute("""
            INSERT INTO anomaly_scores
                (client_ip, identity, scored_at, window_start, window_end,
                 anomaly_score, is_anomaly, severity, top_features)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(identity, window_start) DO UPDATE SET
                client_ip = excluded.client_ip,
                scored_at = excluded.scored_at,
                anomaly_score = excluded.anomaly_score,
                is_anomaly = excluded.is_anomaly,
                severity = excluded.severity,
                top_features = excluded.top_features
        """, (
            client_ip,
            identity,
            datetime.now(timezone.utc).isoformat(),
            window_start,
            window_end,
            anomaly_score,
            1 if is_anomaly else 0,
            severity,
            json.dumps(top_features) if top_features else None,
        ))
        con.commit()
    finally:
        con.close()


def update_model_metadata(identity, client_ip, training_rows, status="active"):
    """Update model training metadata."""
    con = _connect()
    try:
        con.execute("""
            INSERT INTO anomaly_models (identity, client_ip, trained_at, training_rows, model_version, status)
            VALUES (?, ?, ?, ?, 1, ?)
            ON CONFLICT(identity) DO UPDATE SET
                client_ip = excluded.client_ip,
                trained_at = excluded.trained_at,
                training_rows = excluded.training_rows,
                model_version = model_version + 1,
                status = excluded.status
        """, (identity, client_ip, datetime.now(timezone.utc).isoformat(), training_rows, status))
        con.commit()
    finally:
        con.close()


def set_model_status(identity, status):
    """Update just the status field for a model."""
    con = _connect()
    try:
        con.execute(
            "UPDATE anomaly_models SET status = ? WHERE identity = ?",
            (status, identity),
        )
        con.commit()
    finally:
        con.close()


def get_model_metadata(identity):
    """Get model metadata for an identity."""
    con = _connect()
    try:
        row = con.execute(
            "SELECT * FROM anomaly_models WHERE identity = ?", (identity,)
        ).fetchone()
        return dict(row) if row else None
    finally:
        con.close()


def auto_resolve(identity, consecutive_normal_windows):
    """
    Auto-resolve old anomalies if the identity has had N consecutive normal windows.
    Returns number of resolved anomalies.
    """
    con = _connect()
    try:
        # Check last N scores for this identity
        rows = con.execute("""
            SELECT is_anomaly FROM anomaly_scores
            WHERE identity = ?
            ORDER BY window_start DESC
            LIMIT ?
        """, (identity, consecutive_normal_windows)).fetchall()

        if len(rows) < consecutive_normal_windows:
            return 0

        # All must be normal (is_anomaly = 0)
        if any(r["is_anomaly"] for r in rows):
            return 0

        # Resolve all unresolved anomalies for this identity
        cursor = con.execute("""
            UPDATE anomaly_scores
            SET resolved = 1, resolved_at = ?
            WHERE identity = ? AND is_anomaly = 1 AND resolved = 0
        """, (datetime.now(timezone.utc).isoformat(), identity))
        con.commit()
        return cursor.rowcount
    finally:
        con.close()


def update_daemon_status(**kwargs):
    """Write daemon cycle status to settings as JSON. Merges non-None values.

    Every status write also refreshes last_seen. The Node API uses this field
    as the sidecar heartbeat, so scheduler-only writes and disabled-mode polls
    must keep it current even when no scoring/training cycle completes.
    """
    con = _connect()
    try:
        row = con.execute(
            "SELECT value FROM settings WHERE key = 'anomaly_daemon_status'"
        ).fetchone()
        try:
            status = json.loads(row["value"]) if row and row["value"] else {}
            if not isinstance(status, dict):
                status = {}
        except (json.JSONDecodeError, TypeError):
            now = datetime.now(timezone.utc).isoformat()
            status = {
                "status_reset_reason": "invalid_json",
                "status_reset_at": now,
            }

        for key, value in kwargs.items():
            if value is not None:
                status[key] = value
        status["last_seen"] = datetime.now(timezone.utc).isoformat()

        con.execute(
            """INSERT INTO settings (key, value) VALUES ('anomaly_daemon_status', ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value""",
            (json.dumps(status),),
        )
        con.commit()
    finally:
        con.close()


def prune_old_scores(retention_days=None):
    """Delete anomaly scores older than retention period."""
    days = retention_days or SCORE_RETENTION_DAYS
    con = _connect()
    try:
        cursor = con.execute(
            "DELETE FROM anomaly_scores WHERE scored_at < datetime('now', ?)",
            (f"-{int(days)} days",),
        )
        con.commit()
        return cursor.rowcount
    finally:
        con.close()
