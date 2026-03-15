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
    """Create anomaly tables if they don't exist."""
    con = _connect()
    try:
        con.executescript("""
            CREATE TABLE IF NOT EXISTS anomaly_scores (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                client_ip TEXT NOT NULL,
                scored_at TEXT NOT NULL,
                window_start TEXT NOT NULL,
                window_end TEXT NOT NULL,
                anomaly_score REAL NOT NULL,
                is_anomaly INTEGER NOT NULL DEFAULT 0,
                severity TEXT,
                top_features TEXT,
                resolved INTEGER NOT NULL DEFAULT 0,
                resolved_at TEXT,
                UNIQUE(client_ip, window_start)
            );

            CREATE TABLE IF NOT EXISTS anomaly_models (
                client_ip TEXT PRIMARY KEY,
                trained_at TEXT NOT NULL,
                training_rows INTEGER NOT NULL,
                model_version INTEGER NOT NULL DEFAULT 1,
                status TEXT NOT NULL DEFAULT 'learning'
            );

            CREATE INDEX IF NOT EXISTS idx_anomaly_scores_active
                ON anomaly_scores(is_anomaly, resolved) WHERE is_anomaly = 1 AND resolved = 0;

            CREATE INDEX IF NOT EXISTS idx_anomaly_scores_client
                ON anomaly_scores(client_ip, window_start);
        """)
        con.commit()
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


def save_score(client_ip, window_start, window_end, anomaly_score,
               is_anomaly, severity=None, top_features=None):
    """Insert or update an anomaly score."""
    con = _connect()
    try:
        con.execute("""
            INSERT INTO anomaly_scores
                (client_ip, scored_at, window_start, window_end,
                 anomaly_score, is_anomaly, severity, top_features)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(client_ip, window_start) DO UPDATE SET
                scored_at = excluded.scored_at,
                anomaly_score = excluded.anomaly_score,
                is_anomaly = excluded.is_anomaly,
                severity = excluded.severity,
                top_features = excluded.top_features
        """, (
            client_ip,
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


def update_model_metadata(client_ip, training_rows, status="active"):
    """Update model training metadata."""
    con = _connect()
    try:
        con.execute("""
            INSERT INTO anomaly_models (client_ip, trained_at, training_rows, model_version, status)
            VALUES (?, ?, ?, 1, ?)
            ON CONFLICT(client_ip) DO UPDATE SET
                trained_at = excluded.trained_at,
                training_rows = excluded.training_rows,
                model_version = model_version + 1,
                status = excluded.status
        """, (client_ip, datetime.now(timezone.utc).isoformat(), training_rows, status))
        con.commit()
    finally:
        con.close()


def set_model_status(client_ip, status):
    """Update just the status field for a model."""
    con = _connect()
    try:
        con.execute(
            "UPDATE anomaly_models SET status = ? WHERE client_ip = ?",
            (status, client_ip),
        )
        con.commit()
    finally:
        con.close()


def get_model_metadata(client_ip):
    """Get model metadata for a client."""
    con = _connect()
    try:
        row = con.execute(
            "SELECT * FROM anomaly_models WHERE client_ip = ?", (client_ip,)
        ).fetchone()
        return dict(row) if row else None
    finally:
        con.close()


def auto_resolve(client_ip, consecutive_normal_windows):
    """
    Auto-resolve old anomalies if the client has had N consecutive normal windows.
    Returns number of resolved anomalies.
    """
    con = _connect()
    try:
        # Check last N scores for this client
        rows = con.execute("""
            SELECT is_anomaly FROM anomaly_scores
            WHERE client_ip = ?
            ORDER BY window_start DESC
            LIMIT ?
        """, (client_ip, consecutive_normal_windows)).fetchall()

        if len(rows) < consecutive_normal_windows:
            return 0

        # All must be normal (is_anomaly = 0)
        if any(r["is_anomaly"] for r in rows):
            return 0

        # Resolve all unresolved anomalies for this client
        cursor = con.execute("""
            UPDATE anomaly_scores
            SET resolved = 1, resolved_at = ?
            WHERE client_ip = ? AND is_anomaly = 1 AND resolved = 0
        """, (datetime.now(timezone.utc).isoformat(), client_ip))
        con.commit()
        return cursor.rowcount
    finally:
        con.close()


def update_daemon_status(**kwargs):
    """Write daemon cycle status to settings as JSON. Merges non-None values."""
    con = _connect()
    try:
        row = con.execute(
            "SELECT value FROM settings WHERE key = 'anomaly_daemon_status'"
        ).fetchone()
        status = json.loads(row["value"]) if row else {}

        for key, value in kwargs.items():
            if value is not None:
                status[key] = value

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
