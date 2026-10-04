"""Read-only diagnostics and successful-catalog comparison fixtures."""
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import diagnostics as d


class DiagnosticsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.config = {"model": {"provider": "antigravity-oauth-plus", "default": "gemini-3.1-pro"}, "agent": {"reasoning_effort": "low"}, "compression": {"threshold": 0.5, "threshold_tokens": 120000}, "api_key": "DO-NOT-EXPORT", "base_url": "https://private.invalid"}
        self.patches = [patch.dict(os.environ, {"HERMES_HOME": str(self.home), "ANTIGRAVITY_CONTEXT_LENGTH": ""}), patch.object(d, "load_config_readonly", return_value=self.config), patch.object(d, "native_context", return_value=90000)]
        for p in self.patches:
            p.start()
            self.addCleanup(p.stop)

    def run_cli(self, *args):
        with redirect_stdout(io.StringIO()) as output:
            rc = d.main(list(args))
        return rc, json.loads(output.getvalue())

    def fake_run(self, text="gemini-next-high Gemini\nnext-model-1 Display\n", rc=0, error=None):
        def run(argv, **kwargs):
            if error:
                raise error
            kwargs["stdout"].write(("agy version 1.2.3" if argv[-1] == "--version" else text).encode())
            return SimpleNamespace(returncode=rc)
        return run

    def test_status_is_cached_no_subprocess_or_state_creation(self):
        with patch.object(d.subprocess, "run", side_effect=AssertionError("status must be local")):
            rc, result = self.run_cli("status", "--json")
        self.assertEqual(rc, 0)
        self.assertEqual(result["requested_model"], "gemini-3.1-pro")
        self.assertEqual(result["executable_model_id"], "gemini-3.1-pro-low")
        self.assertFalse((self.home / "plugin-data").exists())
        self.assertEqual(result["context"]["source"], "native-resolution/source-unspecified")
        self.assertNotIn("DO-NOT-EXPORT", json.dumps(result))
        self.assertNotIn("private.invalid", json.dumps(result))
        self.assertNotIn(str(self.home), json.dumps(result))

    def test_other_provider_requires_explicit_model_and_never_routes(self):
        self.config["model"]["provider"] = "other-provider"
        with patch.object(d.subprocess, "run", side_effect=AssertionError("no routing")):
            rc, result = self.run_cli("status", "--json")
            self.assertEqual(rc, 2)
            self.assertEqual(result["error"], "MODEL_REQUIRED")
            rc, result = self.run_cli("status", "--model", "next-model-1", "--json")
        self.assertEqual(rc, 0)
        self.assertEqual(result["provider"], "antigravity-oauth-plus")

    def test_environment_and_config_override_provenance(self):
        with patch.dict(os.environ, {"ANTIGRAVITY_CONTEXT_LENGTH": "150000"}):
            _, result = self.run_cli("status", "--json")
            self.assertEqual(result["context"], {"tokens": 150000, "source": "explicit-env-override", "mode": "local-only"})
        self.config["model"]["context_length"] = 180000
        _, result = self.run_cli("status", "--json")
        self.assertEqual(result["context"]["source"], "explicit-config-override")
        self.assertEqual(result["compression"]["configured_threshold_tokens"], 120000)
        self.assertIsNone(result["compression"]["effective_threshold_tokens"])

    def test_exact_per_model_override_precedes_environment(self):
        self.config["model_overrides"] = {"antigravity-oauth-plus": {"gemini-3.1-pro": {"context_window": 200000}}}
        with patch.dict(os.environ, {"ANTIGRAVITY_CONTEXT_LENGTH": "150000"}):
            _, result = self.run_cli("status", "--json")
        self.assertEqual(result["context"]["tokens"], 200000)
        self.assertEqual(result["context"]["source"], "explicit-config-model-override")

    def test_unknown_native_context_warning_no_invented_fallback(self):
        with patch.object(d, "native_context", return_value=None):
            _, result = self.run_cli("status", "--json")
        self.assertIsNone(result["context"]["tokens"])
        self.assertIn("UNKNOWN_CONTEXT", result["warnings"])
        self.assertFalse(result["discovery"]["fallback_used"])

    def test_refresh_success_deltas_and_private_sanitized_snapshot(self):
        with patch.object(d.subprocess, "run", side_effect=self.fake_run()):
            rc, first = self.run_cli("refresh-models", "--json")
        self.assertEqual(rc, 0)
        self.assertFalse(first["catalog_change"]["compared"])
        self.assertEqual(first["catalog_change"]["added"], [])
        path = self.home / "plugin-data" / "antigravity-oauth-plus" / "model-catalog.json"
        raw = json.loads(path.read_text())
        self.assertEqual(raw["model_ids"], ["gemini-next-high", "next-model-1"])
        self.assertNotIn("Display", path.read_text())
        if os.name != "nt":
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
        with patch.object(d.subprocess, "run", side_effect=self.fake_run("next-model-1 Name\nbrand-new-2 New\n")):
            rc, second = self.run_cli("refresh-models", "--json")
        self.assertEqual(second["catalog_change"], {"compared": True, "added": ["brand-new-2"], "removed": ["gemini-next-high"]})
        with patch.object(d.subprocess, "run", side_effect=AssertionError("cached")):
            _, status = self.run_cli("status", "--json")
        self.assertEqual(status["agy_version"], "1.2.3")
        self.assertEqual(status["discovery"]["model_ids"], ["brand-new-2", "next-model-1"])

    def test_failed_incomplete_and_timeout_preserve_previous_bytes(self):
        with patch.object(d.subprocess, "run", side_effect=self.fake_run()):
            self.run_cli("refresh-models", "--json")
        path = self.home / "plugin-data" / "antigravity-oauth-plus" / "model-catalog.json"
        before = path.read_bytes()
        cases = [self.fake_run("next-model-1\n", rc=1), self.fake_run("next-model-1\nWarning: partial catalog\n"), self.fake_run(""), self.fake_run(error=subprocess.TimeoutExpired("PRIVATE-PATH", 10))]
        for run in cases:
            with patch.object(d.subprocess, "run", side_effect=run):
                rc, result = self.run_cli("refresh-models", "--json")
            self.assertEqual(rc, 1)
            self.assertEqual(path.read_bytes(), before)
            self.assertFalse(result["catalog_change"]["compared"])
            self.assertEqual(result["catalog_change"]["removed"], [])
            self.assertNotIn("PRIVATE-PATH", json.dumps(result))

    def test_catalog_symlink_is_refused(self):
        root = self.home / "plugin-data" / "antigravity-oauth-plus"
        root.mkdir(parents=True)
        outside = self.home / "outside"
        outside.write_text("private")
        (root / "model-catalog.json").symlink_to(outside)
        with patch.object(d.subprocess, "run", side_effect=self.fake_run()):
            rc, result = self.run_cli("refresh-models", "--json")
        self.assertEqual(rc, 1)
        self.assertEqual(outside.read_text(), "private")

    def test_catalog_refresh_busy_is_bounded_and_preserves_state(self):
        root = self.home / "plugin-data" / "antigravity-oauth-plus"
        root.mkdir(parents=True)
        (root / ".model-catalog-refresh.lock").mkdir()
        with patch.object(d.subprocess, "run", side_effect=AssertionError("lock must refuse before child")):
            rc, result = self.run_cli("refresh-models", "--json")
        self.assertEqual(rc, 1)
        self.assertEqual(result["error"], "CATALOG_REFRESH_BUSY")
        self.assertEqual(result["catalog_change"]["removed"], [])

    def test_oversized_output_and_metadata_deadlines(self):
        calls = []
        normal = self.fake_run()
        def run(argv, **kwargs):
            calls.append((argv, kwargs))
            return normal(argv, **kwargs)
        with patch.object(d.subprocess, "run", side_effect=run):
            self.run_cli("refresh-models", "--json")
        self.assertEqual([call[1]["timeout"] for call in calls], [10, 3])
        self.assertTrue(all(call[1]["shell"] is False and call[1]["stdin"] == subprocess.DEVNULL for call in calls))
        with patch.object(d.subprocess, "run", side_effect=self.fake_run("x" * (d.MAX_BYTES + 1))):
            rc, result = self.run_cli("refresh-models", "--json")
        self.assertEqual(rc, 1)
        self.assertEqual(result["error"], "AGY_METADATA_OVERSIZED")
        self.assertEqual(result["catalog_change"]["removed"], [])

    def test_stale_catalog_and_human_unknown_view(self):
        catalog = {"observed_at": "2020-01-01T00:00:00Z", "model_ids": ["gemini-3.1-pro-low"], "agy_version": None}
        value = d.build_status(self.config, catalog=catalog)
        self.assertEqual(value["discovery"]["freshness"], "stale")
        value["context"]["tokens"] = None
        text = d.render(value)
        self.assertIn("Context: unknown", text)
        self.assertIn("effective threshold unknown", text)
        self.assertNotIn("DO-NOT-EXPORT", text)

    def test_invalid_exact_model_is_not_normalized(self):
        rc, result = self.run_cli("status", "--model", " next-model-1", "--json")
        self.assertEqual(rc, 2)
        self.assertEqual(result["error"], "INVALID_MODEL")


if __name__ == "__main__":
    unittest.main()
