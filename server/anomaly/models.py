"""Isolation Forest model management — train, score, persist, explain."""

import json
import numpy as np
import joblib
from sklearn.ensemble import IsolationForest

from config import (
    MODELS_DIR, SENSITIVITY_MAP, FEATURE_NAMES, FEATURE_LABELS,
    ANOMALY_THRESHOLD_HIGH, ANOMALY_THRESHOLD_MEDIUM,
)


def _model_path(client_ip):
    """Sanitized path for a client's model file."""
    safe = client_ip.replace(".", "_").replace(":", "_")
    return MODELS_DIR / f"{safe}.joblib"


def train_model(client_ip, training_data, sensitivity="medium"):
    """
    Train an Isolation Forest on the client's historical feature data.
    training_data: 2D numpy array (n_windows x n_features).
    Returns the trained model.
    """
    contamination = SENSITIVITY_MAP.get(sensitivity, 0.05)

    model = IsolationForest(
        n_estimators=100,
        contamination=contamination,
        random_state=42,
        n_jobs=1,
    )
    model.fit(training_data)

    # Save to disk
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    joblib.dump(model, _model_path(client_ip))

    return model


def load_model(client_ip):
    """Load a persisted model. Returns None if not found."""
    p = _model_path(client_ip)
    if not p.exists():
        return None
    return joblib.load(p)


def score_window(model, feature_vector):
    """
    Score a single feature vector.
    Returns (anomaly_score, is_anomaly, severity).
    anomaly_score: float (negative = more anomalous)
    """
    fv = feature_vector.reshape(1, -1)
    score = model.decision_function(fv)[0]
    prediction = model.predict(fv)[0]  # -1 = anomaly, 1 = normal

    is_anomaly = prediction == -1
    severity = None
    if is_anomaly:
        if score <= ANOMALY_THRESHOLD_HIGH:
            severity = "high"
        elif score <= ANOMALY_THRESHOLD_MEDIUM:
            severity = "medium"
        else:
            severity = "low"

    return float(score), is_anomaly, severity


def explain_anomaly(model, feature_vector, client_median):
    """
    Identify top 3 features contributing to the anomaly.
    Uses single-feature perturbation: replace each feature with the client's
    historical median and measure score improvement.

    Returns list of {"feature": name, "label": human_label, "contribution": float}.
    """
    base_score = model.decision_function(feature_vector.reshape(1, -1))[0]

    contributions = []
    for i, name in enumerate(FEATURE_NAMES):
        perturbed = feature_vector.copy()
        perturbed[i] = client_median[i]
        new_score = model.decision_function(perturbed.reshape(1, -1))[0]
        improvement = new_score - base_score  # positive = feature was making it worse
        contributions.append((name, improvement))

    # Sort by contribution (highest improvement first)
    contributions.sort(key=lambda x: x[1], reverse=True)

    top3 = []
    for name, contrib in contributions[:3]:
        if contrib <= 0:
            break  # no more positive contributors
        top3.append({
            "feature": name,
            "label": FEATURE_LABELS.get(name, name),
            "contribution": round(contrib, 4),
        })

    return top3
