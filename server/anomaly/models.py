"""Isolation Forest model management: train, score, persist, explain."""

import warnings

import joblib
from sklearn.ensemble import IsolationForest
from sklearn.exceptions import InconsistentVersionWarning

from config import (
    MODELS_DIR, SENSITIVITY_MAP, FEATURE_NAMES, FEATURE_LABELS,
    ANOMALY_THRESHOLD_HIGH, ANOMALY_THRESHOLD_MEDIUM,
)


def _model_path(device_key):
    """Sanitized path for a device's model file (device_key is a MAC or,
    when no MAC is known for the client, its IP)."""
    safe = device_key.replace(".", "_").replace(":", "_")
    return MODELS_DIR / f"{safe}.joblib"


def train_model(device_key, training_data, sensitivity="medium"):
    """
    Train an Isolation Forest on the device's historical feature data.
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
    joblib.dump(model, _model_path(device_key))

    return model


def remove_orphan_models(known_keys):
    """Delete model files for device keys with no anomaly_models row, and
    return their names. Migration 060 moved the rows from IP to MAC keys and
    left the files under the old IP names, and allowlisting a device drops
    its row but not its file. Nothing tracks such a file, every backup
    carries it, and a later client resolving to that IP would score with a
    model trained on another device."""
    if not MODELS_DIR.exists():
        return []
    keep = {_model_path(key).name for key in known_keys}
    removed = []
    for path in sorted(MODELS_DIR.glob("*.joblib")):
        if path.name not in keep:
            path.unlink(missing_ok=True)
            removed.append(path.name)
    return removed


class StaleModelError(Exception):
    """A persisted model was saved by another scikit-learn version."""


def load_model(device_key):
    """Load a persisted model. Returns None if not found.

    A model saved by another scikit-learn version (a backup restored from
    another machine, or a package upgrade) raises StaleModelError and its
    file is removed. scikit-learn warns that such a model can score wrongly,
    and warned again on every scoring cycle, so it is retrained instead.
    """
    p = _model_path(device_key)
    if not p.exists():
        return None
    with warnings.catch_warnings():
        warnings.simplefilter("error", InconsistentVersionWarning)
        try:
            return joblib.load(p)
        except InconsistentVersionWarning as stale:
            p.unlink(missing_ok=True)
            raise StaleModelError(str(stale)) from None


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


def explain_anomaly(model, feature_vector, client_median, peer_median=None):
    """
    Identify top 3 features contributing to the anomaly.
    Uses single-feature perturbation: replace each feature with the client's
    historical median and measure score improvement.

    peer_median, when given, is the fleet's typical value per feature (the
    median of every trained device's own median). Each factor then carries
    "peers", so the drawer can say whether the device is odd for itself only
    or for the whole network: a night of high entropy that every phone shares
    is a CDN, not a tunnel.

    Returns list of {"feature", "label", "contribution", "observed",
    "baseline", "peers"}.
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
        idx = FEATURE_NAMES.index(name)
        factor = {
            "feature": name,
            "label": FEATURE_LABELS.get(name, name),
            "contribution": round(contrib, 4),
            "observed": round(float(feature_vector[idx]), 4),
            "baseline": round(float(client_median[idx]), 4),
        }
        if peer_median is not None:
            factor["peers"] = round(float(peer_median[idx]), 4)
        top3.append(factor)

    return top3
