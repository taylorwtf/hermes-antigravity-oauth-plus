"""Network-free metadata transport contract; quota fixtures are synthetic."""
from pathlib import Path
import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).absolute().parents[1]
sys.path.insert(0, str(ROOT))
import meter_cli as meter


class MeterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / "profile"
        self.env = patch.dict(os.environ, {"HERMES_HOME": str(self.home)})
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_status_shape_real_node_and_missing_is_not_fresh(self):
        result = meter.metadata()
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["snapshot"]["freshness"], "missing")
        self.assertIsNone(result["snapshot"]["observed_at"])
        self.assertEqual(result["snapshot"]["meters"], [])
        self.assertEqual(meter.state_dir(), self.home / "plugin-data" / "antigravity-oauth-plus" / "quota")

    def test_active_profile_resolved_on_each_call(self):
        first = meter.state_dir()
        os.environ["HERMES_HOME"] = str(Path(self.temp.name) / "other")
        self.assertNotEqual(meter.state_dir(), first)
        self.assertEqual(meter.metadata("history"), {"ok": True, "observations": [], "count": 0})

    def test_public_storage_api(self):
        import types
        storage = types.ModuleType("plugins.plugin_storage")
        storage.plugin_data_dir = lambda name: self.home / "context" / name
        with patch.dict(sys.modules, {"plugins.plugin_storage": storage}):
            self.assertEqual(meter.state_dir(), self.home / "context" / "antigravity-oauth-plus" / "quota")

    def test_fail_closed_arguments_never_start_process(self):
        with patch.object(meter, "_run") as run:
            for action, kw in [("poll", {}), ("status;whoami", {}), ("status", {"credits": True}),
                               ("history", {"limit": 0}), ("history", {"limit": 1001}),
                               ("status", {"limit": True}), ("refresh", {"credits": "yes"})]:
                self.assertFalse(meter.metadata(action, **kw)["ok"])
            run.assert_not_called()

    def test_argv_and_status_refresh_budgets(self):
        def run(argv, timeout):
            self.assertLessEqual(timeout, 40)
            self.assertIn("--envelope", argv)
            self.assertIn("--state-dir", argv)
            self.assertEqual(argv[argv.index("--state-dir") + 1], str(meter.state_dir()))
            if "status" in argv:
                self.assertLessEqual(timeout, 5)
            return 0, '{"ok":true,"snapshot":{"freshness":"missing"}}'
        with patch.object(meter, "_run", side_effect=run):
            self.assertTrue(meter.metadata()["ok"])
            self.assertTrue(meter.metadata("refresh", credits=True)["ok"])

    def test_errors_do_not_expose_backend_output(self):
        for failure in [TimeoutError("private-secret"), OSError("private-secret")]:
            with patch.object(meter, "_run", side_effect=failure):
                result = meter.metadata()
                self.assertFalse(result["ok"])
                self.assertNotIn("private-secret", json.dumps(result))
        with patch.object(meter, "_run", return_value=(1, "private-secret")):
            self.assertFalse(meter.metadata()["ok"])
        with patch.object(meter, "_run", return_value=(1, '{"ok":true,"snapshot":{}}')):
            self.assertFalse(meter.metadata()["ok"])

    def test_real_timeout_and_output_cap(self):
        start = time.monotonic()
        with self.assertRaises(TimeoutError):
            meter._run([sys.executable, "-c", "import time; time.sleep(5)"], .15)
        self.assertLess(time.monotonic() - start, 2)
        with self.assertRaises(meter.OutputLimit):
            meter._run([sys.executable, "-c", "import sys; sys.stdout.write('x'*3000000)"], 3)

    def test_human_cli_and_flags(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(meter.main(["status"]), 0)
        self.assertIn("Quota status: MISSING", output.getvalue())
        self.assertNotIn('"snapshot"', output.getvalue())
        with contextlib.redirect_stderr(io.StringIO()):
            for args in [["status", "--credits"], ["status", "--limit", "3"], ["poll"], ["refresh", "-p", "danger"]]:
                with self.assertRaises(SystemExit) as caught:
                    meter.main(args)
                self.assertEqual(caught.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
