"""Threat shape: does this window's traffic look like an attack?

The Isolation Forest answers a different question, "is this unusual for this
device", so a device that has tunneled every night since a firmware update
scores as normal. This rule score over entropy, name length, subdomain depth,
NXDOMAIN rate and block rate does not care what the device usually does.
It is computed for every scored window and stored beside the model score so
the triage map can plot the two axes against each other.

Stdlib only on purpose: the unit test runs without numpy or scikit-learn.
"""
from config import FEATURE_NAMES, THREAT_SHAPE_RULES


def _clamp01(value):
    if value < 0.0:
        return 0.0
    if value > 1.0:
        return 1.0
    return value


def threat_shape(feature_vector, rules=None):
    """Return a 0..1 rule score for one feature vector (FEATURE_NAMES order).

    Accepts any indexable of floats (list, tuple, numpy array). A missing or
    non-numeric input counts as 0 for that rule rather than failing the
    window, since a score of None would hide the device from the map.
    """
    rules = rules or THREAT_SHAPE_RULES
    total = 0.0
    weight_sum = 0.0
    for name, rule in rules.items():
        idx = FEATURE_NAMES.index(name)
        try:
            raw = float(feature_vector[idx])
        except (IndexError, TypeError, ValueError):
            raw = rule["lo"]
        span = rule["hi"] - rule["lo"]
        part = _clamp01((raw - rule["lo"]) / span) if span > 0 else 0.0
        total += part * rule["weight"]
        weight_sum += rule["weight"]
    if weight_sum <= 0:
        return 0.0
    return round(total / weight_sum, 4)


def peer_median_of(medians):
    """Median across devices of each device's own median feature vector, or
    None with fewer than two devices, since one device is not a peer group.
    The drawer prints it as "peers" beside a factor's observed and baseline
    values. Stdlib only, like the rest of this module, so the unit test runs
    without numpy."""
    vectors = [list(v) for v in medians.values()]
    if len(vectors) < 2:
        return None
    width = len(vectors[0])
    out = []
    for i in range(width):
        column = sorted(float(v[i]) for v in vectors)
        mid = len(column) // 2
        out.append(column[mid] if len(column) % 2 else (column[mid - 1] + column[mid]) / 2)
    return out
