"""models.load_model against a model from another scikit-learn version.

scikit-learn and joblib are stood in for with stubs, so `npm run
test:sidecar` still needs no venv. The stubs reproduce the one behavior under
test: joblib.load warns InconsistentVersionWarning when the pickle came from
another scikit-learn version.
"""
import os
import pathlib
import sys
import tempfile
import types
import unittest
import warnings

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class InconsistentVersionWarning(UserWarning):
    pass


LOADS = {}


def _stub_load(path):
    behavior = LOADS[pathlib.Path(path).name]
    if behavior == "stale":
        warnings.warn(InconsistentVersionWarning("from version 1.8.0 when using version 1.4.2"))
    if behavior == "other-warning":
        warnings.warn(UserWarning("unrelated"))
    return {"model": pathlib.Path(path).name}


def _install_stubs():
    sklearn = types.ModuleType("sklearn")
    ensemble = types.ModuleType("sklearn.ensemble")
    ensemble.IsolationForest = object
    exceptions = types.ModuleType("sklearn.exceptions")
    exceptions.InconsistentVersionWarning = InconsistentVersionWarning
    joblib = types.ModuleType("joblib")
    joblib.load = _stub_load
    joblib.dump = lambda model, path: None
    sys.modules.update({
        "sklearn": sklearn,
        "sklearn.ensemble": ensemble,
        "sklearn.exceptions": exceptions,
        "joblib": joblib,
    })


_install_stubs()
import models  # noqa: E402


class LoadModelTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self._dir = models.MODELS_DIR
        models.MODELS_DIR = pathlib.Path(self.tmp.name)
        self.addCleanup(setattr, models, "MODELS_DIR", self._dir)

    def save(self, key, behavior):
        path = models._model_path(key)
        path.write_bytes(b"pickle")
        LOADS[path.name] = behavior
        return path

    def test_missing_model_is_none(self):
        self.assertIsNone(models.load_model("aa:bb:cc:00:00:01"))

    def test_current_model_loads(self):
        self.save("aa:bb:cc:00:00:02", "current")
        self.assertEqual(models.load_model("aa:bb:cc:00:00:02"), {"model": "aa_bb_cc_00_00_02.joblib"})

    def test_model_from_another_version_is_stale_and_removed(self):
        path = self.save("10.0.0.5", "stale")
        with self.assertRaises(models.StaleModelError):
            models.load_model("10.0.0.5")
        self.assertFalse(path.exists())

    def test_ipv6_keyed_model_from_another_version_is_stale(self):
        path = self.save("fd00:a::5", "stale")
        with self.assertRaises(models.StaleModelError):
            models.load_model("fd00:a::5")
        self.assertFalse(path.exists())

    def test_other_warnings_do_not_discard_the_model(self):
        path = self.save("aa:bb:cc:00:00:03", "other-warning")
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            self.assertIsNotNone(models.load_model("aa:bb:cc:00:00:03"))
        self.assertTrue(path.exists())



class RemoveOrphanModelsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self._dir = models.MODELS_DIR
        models.MODELS_DIR = pathlib.Path(self.tmp.name)
        self.addCleanup(setattr, models, "MODELS_DIR", self._dir)

    def touch(self, key):
        path = models._model_path(key)
        path.write_bytes(b"pickle")
        return path

    def test_keeps_tracked_models_and_removes_the_rest(self):
        # A MAC-keyed device, and IPv4 and IPv6 clients with no known MAC.
        tracked = ["aa:bb:cc:00:00:01", "10.0.8.40", "fd00:a::40"]
        kept = [self.touch(key) for key in tracked]
        # The IP-named file migration 060 left behind, and an allowlisted
        # device's model.
        stale_v4 = self.touch("10.0.0.139")
        stale_v6 = self.touch("fd00:a::139")
        other = models.MODELS_DIR / "notes.txt"
        other.write_text("not a model")

        removed = models.remove_orphan_models(set(tracked))

        self.assertEqual(sorted(removed), sorted([stale_v4.name, stale_v6.name]))
        self.assertTrue(all(path.exists() for path in kept))
        self.assertFalse(stale_v4.exists() or stale_v6.exists())
        self.assertTrue(other.exists())

    def test_no_models_directory_removes_nothing(self):
        models.MODELS_DIR = pathlib.Path(self.tmp.name) / "missing"
        self.assertEqual(models.remove_orphan_models(set()), [])


if __name__ == "__main__":
    unittest.main()
