"""Fork provider contracts; fixtures never invoke login, inference or live quota."""
import importlib.util
import os
import subprocess
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
NAME = "agy_plus_provider_test"
spec = importlib.util.spec_from_file_location(NAME, ROOT / "__init__.py", submodule_search_locations=[str(ROOT)])
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
sys.modules[NAME] = module
spec.loader.exec_module(module)
profile = module.antigravity_profile


def cached(**changes):
    result = {
        "observed_at": "2026-01-01T10:00:00Z", "freshness": "fresh", "stale": False,
        "health": {"status": "ok", "checked_at": "2026-01-01T10:00:00Z"},
        "meters": [
            {"id": "gemini-5h", "remaining_fraction": 0.75, "reset_time": "2026-01-01T15:00:00Z"},
            {"id": "gemini-weekly", "remaining_fraction": 0, "reset_time": None},
            {"id": "3p-5h", "remaining_fraction": None, "disabled": True, "reset_time": None},
        ],
    }
    result.update(changes)
    return result


class NativeProviderTests(unittest.TestCase):
    def usage(self, payload=None, error=None):
        transport = ModuleType(NAME + ".meter_cli")
        transport.metadata = Mock(return_value={"ok": True, "snapshot": payload if payload is not None else cached()}, side_effect=error)
        with patch.dict(sys.modules, {transport.__name__: transport}):
            result = profile.fetch_account_usage(base_url="ignored", api_key="ignored")
        transport.metadata.assert_called_once_with(action="status", credits=False, limit=20)
        return result

    def test_identity_does_not_claim_original_names(self):
        self.assertEqual(profile.name, "antigravity-oauth-plus")
        self.assertEqual(set(profile.aliases), {"agy-oauth-plus", "google-antigravity-plus"})
        self.assertFalse({"antigravity-oauth", "agy-oauth", "google-antigravity"} & set(profile.aliases))

    def test_context_is_hermes_owned_by_default(self):
        with patch.dict(os.environ, {"ANTIGRAVITY_CONTEXT_LENGTH": ""}):
            for model in ("gemini-next", "claude-next", "unknown-model"):
                self.assertIsNone(profile.get_model_context_length(model))

    def test_context_accepts_only_positive_override(self):
        with patch.dict(os.environ, {"ANTIGRAVITY_CONTEXT_LENGTH": " 250000 "}):
            self.assertEqual(profile.get_model_context_length("any-model"), 250000)
        for value in ("0", "-1", "nan", "bogus", "1.5"):
            with self.subTest(value=value), patch.dict(os.environ, {"ANTIGRAVITY_CONTEXT_LENGTH": value}):
                self.assertIsNone(profile.get_model_context_length("any-model"))

    def test_cached_mapping_preserves_time_and_unknown_vs_zero(self):
        from agent.account_usage import AccountUsageSnapshot
        result = self.usage()
        self.assertIsInstance(result, AccountUsageSnapshot)
        self.assertEqual(result.provider, "antigravity-oauth-plus")
        self.assertEqual(result.fetched_at, datetime(2026, 1, 1, 10, tzinfo=timezone.utc))
        self.assertEqual([w.used_percent for w in result.windows], [25, 100, None, None])
        self.assertEqual(result.windows[0].reset_at, datetime(2026, 1, 1, 15, tzinfo=timezone.utc))
        self.assertEqual(result.raw["observed_at"], "2026-01-01T10:00:00Z")

    def test_stale_health_retains_values_but_labels_them(self):
        result = self.usage(cached(freshness="error", stale=True, health={"status": "error", "code": "BACKEND_FAILED", "checked_at": "2026-01-01T11:00:00Z"}))
        text = " ".join(result.details)
        self.assertIn("error", text.lower())
        self.assertIn("BACKEND_FAILED", text)
        self.assertIn("stale", text.lower())
        self.assertEqual(result.windows[0].used_percent, 25)

    def test_missing_cache_is_unknown_not_zero(self):
        result = self.usage(cached(observed_at=None, freshness="missing", stale=True, meters=[]))
        self.assertIsNotNone(result.unavailable_reason)
        self.assertTrue(all(w.used_percent is None for w in result.windows))

    def test_invalid_fractions_are_unknown_not_clamped(self):
        for value in (True, float("nan"), float("inf"), -0.1, 1.1, "0"):
            with self.subTest(value=value):
                result = self.usage(cached(meters=[{"id": "gemini-5h", "remaining_fraction": value}]))
                self.assertIsNone(result.windows[0].used_percent)

    def test_invalid_observation_time_is_not_reported_as_fresh(self):
        result = self.usage(cached(observed_at="bad-date"))
        self.assertIsNotNone(result.unavailable_reason)
        self.assertTrue(all(w.used_percent is None for w in result.windows))
        self.assertIn("unverified", " ".join(result.details))

    def test_transport_failure_is_safe_and_unavailable(self):
        result = self.usage(error=subprocess.TimeoutExpired("node", 5))
        self.assertIsNotNone(result.unavailable_reason)
        self.assertNotIn("node", result.unavailable_reason)

    def test_live_models_preserve_new_families_and_reject_headers(self):
        output = "Fetching models...\nMODEL ID\nnext-family-1.2 Name\ngemini-next-high Gemini\ngemini-next-low Gemini\nError: failed\n--not-a-model\n"
        with patch(NAME + ".client.resolve_agy_command", return_value="fixture-agy"), patch.object(module.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=output)) as run:
            self.assertEqual(profile.fetch_models(), ["next-family-1.2", "gemini-next-high", "gemini-next-low"])
        self.assertEqual(run.call_args.args[0], ["fixture-agy", "models"])
        self.assertEqual(run.call_args.kwargs["stdin"], subprocess.DEVNULL)
        from models import resolve_model_and_effort
        for exact_id in ("next-family-1.2", "gemini-next-high", "gemini-next-low"):
            self.assertEqual(resolve_model_and_effort(exact_id, "low")[0], exact_id)

    def test_failed_model_listing_does_not_invent_availability(self):
        with patch(NAME + ".client.resolve_agy_command", return_value="fixture-agy"), patch.object(module.subprocess, "run", return_value=SimpleNamespace(returncode=1, stdout="next-family-1.2")):
            self.assertIsNone(profile.fetch_models())
        self.assertEqual(profile.fallback_models, ())


if __name__ == "__main__":
    unittest.main()
