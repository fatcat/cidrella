"""threat.threat_shape: stdlib only, so `npm run test:sidecar` needs no venv."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from config import FEATURE_NAMES, THREAT_SHAPE_RULES  # noqa: E402
from threat import peer_median_of, threat_shape  # noqa: E402


def vector(**overrides):
    """A benign hour of browsing, with named features overridden."""
    base = {
        "avg_domain_entropy": 2.5,
        "max_domain_length": 28.0,
        "subdomain_depth_mean": 2.4,
        "nxdomain_ratio": 0.0,
        "block_ratio": 0.0,
    }
    base.update(overrides)
    return [float(base.get(name, 0.0)) for name in FEATURE_NAMES]


class ThreatShapeTest(unittest.TestCase):
    def test_weights_sum_to_one(self):
        self.assertAlmostEqual(sum(r["weight"] for r in THREAT_SHAPE_RULES.values()), 1.0)

    def test_benign_browsing_is_near_zero(self):
        self.assertLess(threat_shape(vector(avg_domain_entropy=2.7)), 0.05)

    def test_saturated_tunneling_is_one(self):
        fv = vector(
            avg_domain_entropy=4.4,
            max_domain_length=180.0,
            subdomain_depth_mean=7.0,
            nxdomain_ratio=0.9,
            block_ratio=0.6,
        )
        self.assertEqual(threat_shape(fv), 1.0)

    def test_each_rule_is_clamped_and_weighted(self):
        # Entropy alone at its ceiling contributes exactly its weight, and
        # overshooting the ceiling adds nothing more.
        self.assertAlmostEqual(threat_shape(vector(avg_domain_entropy=4.0)), 0.25, places=3)
        self.assertAlmostEqual(threat_shape(vector(avg_domain_entropy=9.0)), 0.25, places=3)
        # Halfway up one range is half that rule's weight.
        self.assertAlmostEqual(threat_shape(vector(nxdomain_ratio=0.25)), 0.10, places=3)

    def test_short_or_malformed_vector_counts_missing_rules_as_zero(self):
        self.assertEqual(threat_shape([]), 0.0)
        self.assertEqual(threat_shape(["x"] * len(FEATURE_NAMES)), 0.0)


class PeerMedianTest(unittest.TestCase):
    def test_none_below_two_devices(self):
        self.assertIsNone(peer_median_of({}))
        self.assertIsNone(peer_median_of({"a": [1.0, 2.0]}))

    def test_median_per_feature_odd_and_even(self):
        three = {"a": [1.0, 10.0], "b": [3.0, 20.0], "c": [2.0, 90.0]}
        self.assertEqual(peer_median_of(three), [2.0, 20.0])
        four = {"a": [1.0], "b": [2.0], "c": [3.0], "d": [10.0]}
        self.assertEqual(peer_median_of(four), [2.5])

    def test_accepts_any_sequence(self):
        # Training caches numpy rows; tuples stand in for them here.
        self.assertEqual(peer_median_of({"a": (4.0, 1.0), "b": (2.0, 3.0)}), [3.0, 2.0])


if __name__ == "__main__":
    unittest.main()
