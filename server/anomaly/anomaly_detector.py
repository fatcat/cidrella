#!/usr/bin/env python3
"""
CIDRella ML Anomaly Detection Daemon

Monitors DNS query patterns per client IP using Isolation Forest.
Reads from DuckDB (analytics.duckdb), writes scores to SQLite (cidrella.db).
Managed by s6-overlay (Docker) or systemd (native).
"""

import sys
import time
import logging
import traceback
from datetime import datetime, timedelta, timezone

import numpy as np

from config import (
    SCORING_INTERVAL_SEC, TRAINING_INTERVAL_SEC, DISABLED_POLL_SEC,
    MIN_TRAINING_HOURS, FEATURE_WINDOW_HOURS, TRAINING_LOOKBACK_DAYS,
    AUTO_RESOLVE_WINDOWS, MODELS_DIR,
)
import features
import models
import storage

logging.basicConfig(
    level=logging.INFO,
    format="[anomaly] %(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    stream=sys.stdout,
)
log = logging.getLogger("anomaly")

# Cache: client_ip → median feature vector (populated during training)
_client_medians = {}


def get_sensitivity():
    """Read sensitivity setting from SQLite."""
    return storage.get_setting("anomaly_sensitivity", "medium")


def get_retention_days():
    """Read retention setting from SQLite."""
    val = storage.get_setting("anomaly_retention_days", "30")
    try:
        return max(1, int(val))
    except (ValueError, TypeError):
        return 30


def get_scoring_interval():
    """Read scoring interval from SQLite (minutes → seconds)."""
    val = storage.get_setting("anomaly_scoring_interval_min")
    try:
        return max(60, int(val) * 60)
    except (ValueError, TypeError):
        return SCORING_INTERVAL_SEC


def get_training_interval():
    """Read training interval from SQLite (hours → seconds)."""
    val = storage.get_setting("anomaly_training_interval_hours")
    try:
        return max(3600, int(val) * 3600)
    except (ValueError, TypeError):
        return TRAINING_INTERVAL_SEC


def get_min_training_hours():
    """Read minimum training hours from SQLite."""
    val = storage.get_setting("anomaly_min_training_hours")
    try:
        return max(1, int(val))
    except (ValueError, TypeError):
        return MIN_TRAINING_HOURS


def train_all_clients():
    """Train or retrain models for all active clients."""
    t0 = time.monotonic()
    sensitivity = get_sensitivity()
    min_hours = get_min_training_hours()
    active_clients = features.get_active_clients(hours=24)
    log.info("Training models for %d active clients (sensitivity=%s)", len(active_clients), sensitivity)

    trained = 0
    max_windows = 0
    for client_ip in active_clients:
        try:
            # Check if client has enough history
            hours = features.get_client_history_hours(client_ip)
            if hours < min_hours:
                meta = storage.get_model_metadata(client_ip)
                if not meta:
                    storage.update_model_metadata(client_ip, 0, status="learning")
                log.debug("Client %s has %.1fh history (need %dh), skipping", client_ip, hours, min_hours)
                continue

            # Extract training data
            training_data = features.extract_training_data(client_ip, TRAINING_LOOKBACK_DAYS)
            if training_data is None or len(training_data) < 10:
                log.debug("Client %s: insufficient training windows (%s)", client_ip,
                          len(training_data) if training_data is not None else 0)
                continue

            # Train model
            models.train_model(client_ip, training_data, sensitivity)
            storage.update_model_metadata(client_ip, len(training_data), status="active")

            # Cache median for explanation during scoring
            _client_medians[client_ip] = np.median(training_data, axis=0)

            trained += 1
            if len(training_data) > max_windows:
                max_windows = len(training_data)
            log.info("Trained model for %s (%d windows)", client_ip, len(training_data))

        except Exception:
            log.error("Failed to train model for %s: %s", client_ip, traceback.format_exc())

    elapsed = round(time.monotonic() - t0, 2)
    log.info("Training complete: %d/%d models trained in %.2fs (max %d windows)",
             trained, len(active_clients), elapsed, max_windows)

    storage.update_daemon_status(
        last_train=datetime.now(timezone.utc).isoformat(),
        clients_trained=trained,
        train_duration_sec=elapsed,
        train_max_windows=max_windows,
    )


def score_all_clients():
    """Score the latest window for all clients with trained models."""
    t0 = time.monotonic()
    now = datetime.now(timezone.utc)
    window_end = now.replace(minute=0, second=0, microsecond=0)
    window_start = window_end - timedelta(hours=FEATURE_WINDOW_HOURS)

    active_clients = features.get_active_clients(hours=24)
    scored = 0
    anomalies = 0

    for client_ip in active_clients:
        try:
            model = models.load_model(client_ip)
            if model is None:
                continue

            # Extract features for current window
            fv = features.extract_features_with_history(
                client_ip,
                window_start.isoformat(),
                window_end.isoformat(),
                TRAINING_LOOKBACK_DAYS,
            )
            if fv is None:
                continue

            # Score
            score, is_anomaly, severity = models.score_window(model, fv)

            # Explain if anomalous using cached median from training
            top_features = None
            if is_anomaly:
                median = _client_medians.get(client_ip)
                if median is not None:
                    top_features = models.explain_anomaly(model, fv, median)

            # Save score
            storage.save_score(
                client_ip=client_ip,
                window_start=window_start.isoformat(),
                window_end=window_end.isoformat(),
                anomaly_score=score,
                is_anomaly=is_anomaly,
                severity=severity,
                top_features=top_features,
            )

            scored += 1
            if is_anomaly:
                anomalies += 1
                log.warning("Anomaly: %s score=%.4f severity=%s features=%s",
                            client_ip, score, severity, top_features)

            # Auto-resolve check
            resolved = storage.auto_resolve(client_ip, AUTO_RESOLVE_WINDOWS)
            if resolved:
                log.info("Auto-resolved %d anomalies for %s", resolved, client_ip)

        except Exception:
            log.error("Failed to score %s: %s", client_ip, traceback.format_exc())

    elapsed = round(time.monotonic() - t0, 2)
    scoring_interval = get_scoring_interval()
    overrun = elapsed > scoring_interval

    log.info("Scoring complete: %d scored, %d anomalies in %.2fs%s",
             scored, anomalies, elapsed, " [OVERRUN]" if overrun else "")

    storage.update_daemon_status(
        last_score=datetime.now(timezone.utc).isoformat(),
        clients_scored=scored,
        score_duration_sec=elapsed,
        score_overrun=overrun,
    )


def main():
    """Main daemon loop."""
    log.info("Anomaly detection daemon starting")
    log.info("Models dir: %s", MODELS_DIR)

    # Ensure SQLite tables exist
    storage.ensure_tables()
    MODELS_DIR.mkdir(parents=True, exist_ok=True)

    last_train = 0.0
    last_score = 0.0

    while True:
        try:
            # Check if enabled
            if not storage.is_enabled():
                log.debug("Anomaly detection disabled, sleeping %ds", DISABLED_POLL_SEC)
                time.sleep(DISABLED_POLL_SEC)
                continue

            now = time.time()

            # Read intervals from DB each loop iteration
            training_interval = get_training_interval()
            scoring_interval = get_scoring_interval()

            # Training cycle
            if now - last_train >= training_interval:
                log.info("Starting training cycle")
                train_all_clients()
                last_train = now

            # Scoring cycle
            if now - last_score >= scoring_interval:
                log.info("Starting scoring cycle")
                score_all_clients()
                last_score = now

                # Prune old scores
                retention = get_retention_days()
                pruned = storage.prune_old_scores(retention)
                if pruned:
                    log.info("Pruned %d old scores (retention=%dd)", pruned, retention)

            # Sleep until next cycle
            next_event = min(
                last_train + training_interval,
                last_score + scoring_interval,
            )
            sleep_time = max(1, next_event - time.time())

            next_iso = datetime.fromtimestamp(next_event, tz=timezone.utc).isoformat()
            storage.update_daemon_status(next_score=next_iso)

            time.sleep(sleep_time)

        except KeyboardInterrupt:
            log.info("Shutting down")
            break
        except Exception:
            log.error("Unexpected error: %s", traceback.format_exc())
            time.sleep(30)


if __name__ == "__main__":
    main()
