"""Antigravity OAuth Plus provider for Hermes, backed by the official agy CLI.

Sign-in and inference belong to agy. See README.md for the inherited token-file
link/hardlink/copy fallback and macOS keychain exposure disclosure.
"""

from __future__ import annotations

import logging
import math
import os
import re
import subprocess
from datetime import datetime, timezone
from typing import Any

from providers import register_provider
from providers.base import ProviderProfile

logger = logging.getLogger(__name__)

# Availability belongs to the installed agy CLI and the user's account, not a
# speculative static catalog. Hermes retains its generic unknown-model fallback.
_FALLBACK_MODELS: tuple[str, ...] = ()
_MODEL_ID = re.compile(r"[a-z0-9][a-z0-9._-]*-[a-z0-9][a-z0-9._-]*")
_QUOTA_WINDOWS = (
    ("gemini-5h", "Gemini — 5 hours"),
    ("gemini-weekly", "Gemini — weekly"),
    ("3p-5h", "Claude/GPT — 5 hours"),
    ("3p-weekly", "Claude/GPT — weekly"),
)


def _quota_time(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return result if result.tzinfo is not None else None
    except ValueError:
        return None


class AntigravityOAuthProfile(ProviderProfile):
    """Google Antigravity provider profile (auth owned by the agy CLI)."""

    def create_client(self, **client_kwargs: Any) -> Any:
        """Create the Antigravity client facade."""
        from .client import AntigravityClient

        return AntigravityClient(**client_kwargs)

    def setup_status(self, **kwargs: Any) -> dict[str, Any] | None:
        """Gate for `hermes model`: agy present + signed in; offers agy's own login when not."""
        try:
            from .auth import probe
        except ImportError:
            from auth import probe
        return probe()

    def supported_reasoning_efforts(
        self, model: str | None
    ) -> tuple[str, ...] | None:
        """Declared reasoning-effort vocabulary for models on this provider.
        
        Enables Hermes /model picker and /reasoning commands to offer appropriate
        thinking effort options (low, medium, high) for reasoning-capable models.
        """
        m = (model or "").lower()
        if "gemini-3.1-pro" in m:
            return ("low", "high")
        if "gemini" in m or "flash" in m or "pro" in m:
            return ("low", "medium", "high")
        if "claude" in m:
            return ("low", "medium", "high")
        if "gpt" in m:
            return ()
        return ("low", "medium", "high")

    def build_api_kwargs_extras(
        self,
        *,
        reasoning_config: dict | None = None,
        model: str | None = None,
        **context: Any,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        """Extract reasoning effort and forward as top-level api_kwargs to AntigravityClient."""
        effort = None
        if isinstance(reasoning_config, dict):
            if reasoning_config.get("enabled") is False:
                effort = "low"
            else:
                effort = reasoning_config.get("effort")
        top_level: dict[str, Any] = {}
        if effort:
            top_level["reasoning_effort"] = str(effort).strip().lower()
        return {}, top_level

    def fetch_models(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        timeout: float = 15.0,
    ) -> list[str] | None:
        """Query `agy models` and normalize to clean, deduplicated base models.
        
        Separates model families from thinking efforts (e.g. `gemini-3.8-flash-{low,medium,high}`
        becomes `gemini-3.8-flash`), allowing Hermes' native reasoning effort picker to handle
        the thinking depth cleanly.
        """
        try:
            from .client import resolve_agy_command
        except ImportError:
            # Loaded outside a package (e.g. a flat source tree under test):
            # the absolute name is the same module.
            from client import resolve_agy_command

        cmd = resolve_agy_command()
        try:
            res = subprocess.run(
                [cmd, "models"],
                capture_output=True,
                text=True,
                timeout=timeout,
                stdin=subprocess.DEVNULL,
                check=False,
            )
            if res.returncode != 0:
                return None
            raw_models: list[str] = []
            for raw_line in res.stdout.strip().splitlines():
                line = raw_line.strip()
                if not line or "fetching" in line.lower():
                    continue
                parts = line.split()
                if parts:
                    model_id = parts[0]
                    # Accept CLI-style IDs, not prose/headings/options. Keep exact
                    # spelling; unknown vendor families do not require an update.
                    if _MODEL_ID.fullmatch(model_id):
                        raw_models.append(model_id)

            if raw_models:
                clean_models: list[str] = []
                seen: set[str] = set()
                for m in raw_models:
                    base = m
                    for suffix in ("-high", "-medium", "-low"):
                        candidate = m[:-len(suffix)]
                        supported_base = candidate == "gemini-3.1-pro" or (
                            candidate.startswith("gemini-") and "flash" in candidate
                        )
                        if m.endswith(suffix) and supported_base:
                            base = candidate
                            break
                    if base not in seen:
                        seen.add(base)
                        clean_models.append(base)
                return clean_models
        except Exception as exc:
            logger.debug("Antigravity fetch_models failed: %s", exc)

        return None

    def fetch_account_usage(
        self, *, base_url: str | None = None, api_key: str | None = None
    ) -> Any:
        """Hermes /usage: read cached quota only; never refresh or infer.

        The metadata status transport has a <=5s subprocess timeout, beneath
        Hermes' shared 10s account-usage deadline. Snapshot imports stay lazy.
        """
        from agent.account_usage import AccountUsageSnapshot, AccountUsageWindow

        now = datetime.now(timezone.utc)
        try:
            from .meter_cli import metadata
        except ImportError:
            # Flat source-tree imports are supported for development.
            try:
                from meter_cli import metadata
            except ImportError:
                metadata = None
        try:
            result = metadata(action="status", credits=False, limit=20) if metadata else None
            if not isinstance(result, dict) or result.get("ok") is not True:
                raise ValueError("cached status unavailable")
            view = result.get("snapshot")
            if not isinstance(view, dict) or not isinstance(view.get("meters"), list):
                raise ValueError("invalid cached status")
        except Exception:
            # Do not echo subprocess output, filesystem paths or credentials.
            return AccountUsageSnapshot(
                provider=self.name, source="agy-quota-cache", fetched_at=now,
                title="Antigravity account quota",
                unavailable_reason="Cached quota unavailable; run meter_cli.py refresh explicitly.",
            )

        observed = _quota_time(view.get("observed_at"))
        freshness = view.get("freshness", "unknown")
        stale = view.get("stale") is not False
        details = [f"Cached quota: {freshness if observed else 'unknown'}; {'stale/unverified' if stale or not observed else 'cached observation'}."]
        details.append(f"Observed: {observed.isoformat() if observed else 'unknown'} (no refresh performed).")
        health = view.get("health")
        if isinstance(health, dict):
            details.append(f"Health: {health.get('status', 'unknown')}; checked: {health.get('checked_at') or 'unknown'}.")
            if health.get("status") == "error":
                details.append(f"Health error: {health.get('code', 'unknown')}; retained values are not refreshed.")
        windows = []
        meters = {m.get("id"): m for m in view["meters"] if isinstance(m, dict) and isinstance(m.get("id"), str)}
        for meter_id, label in _QUOTA_WINDOWS:
            meter = meters.get(meter_id, {})
            remaining = meter.get("remaining_fraction")
            known = isinstance(remaining, (int, float)) and not isinstance(remaining, bool) and math.isfinite(remaining) and 0 <= remaining <= 1
            disabled = meter.get("disabled") is True
            used = (1 - remaining) * 100 if known and not disabled and observed else None
            reset = _quota_time(meter.get("reset_time"))
            detail = "disabled/unknown" if disabled else "unknown" if not known else "cached quota"
            if meter.get("reset_due") is True:
                details.append(f"{label}: reset due, refill unverified.")
            if disabled:
                details.append(f"{label}: disabled; allowance unknown.")
            windows.append(AccountUsageWindow(label=label, used_percent=used, reset_at=reset, detail=detail))
        credits = view.get("credits")
        if isinstance(credits, dict):
            value = credits.get("remaining_credits")
            if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0:
                details.append(f"Observed credits: {value} (cached; not a billing action).")
        details.append("Five-hour and weekly windows both constrain each pool; unknown/disabled/stale data does not establish availability.")
        return AccountUsageSnapshot(
            provider=self.name, source="agy-quota-cache", fetched_at=observed or now,
            title="Antigravity account quota", windows=tuple(windows), details=tuple(details),
            unavailable_reason=None if observed else "No valid quota observation; allowances are unknown.",
            raw=view,
        )

    def get_model_context_length(self, model: str) -> int | None:
        """Defer to Hermes native model metadata unless explicitly overridden.

        There is no provider-wide context default: unknown-model fallback and
        explicit model_overrides stay Hermes-owned.
        """
        env_val = os.environ.get("ANTIGRAVITY_CONTEXT_LENGTH")
        if env_val:
            try:
                val = int(env_val.strip())
                if val > 0:
                    return val
            except ValueError:
                pass
        return None

    def classify_api_error(
        self,
        error: Exception,
        *,
        status_code: int | None = None,
        error_code: str | None = None,
        message: str = "",
        body: Any = None,
        model: str | None = None,
    ) -> dict[str, Any] | None:
        return _classify_antigravity_error(
            error,
            status_code=status_code,
            error_code=error_code,
            message=message,
            body=body,
            model=model,
        )


def _classify_antigravity_error(
    error: Exception,
    *,
    status_code: int | None = None,
    error_code: str | None = None,
    message: str = "",
    body: Any = None,
    model: str | None = None,
) -> dict[str, Any] | None:
    """Classify agy CLI specific runtime errors so Hermes' smart failover /
    recovery pipeline triggers auto-compression and retry instead of failing.
    """
    err_str = f"{error} {message}".lower()
    if any(
        pattern in err_str
        for pattern in (
            "subscriber fell behind updates",
            "stalled for 5s",
            "empty result (status='success')",
            "empty result (status=\"success\")",
            "context canceled",
            "max_trajectory_tokens",
            "max trajectory tokens",
        )
    ):
        return {
            "reason": "context_overflow",
            "retryable": True,
            "should_compress": True,
        }
    return None


try:
    from .auth import antigravity_auth_handler
except ImportError:  # flat source tree under test
    from auth import antigravity_auth_handler

antigravity_profile = AntigravityOAuthProfile(
    name="antigravity-oauth-plus",
    aliases=("agy-oauth-plus", "google-antigravity-plus"),
    display_name="Google Antigravity (OAuth Plus)",
    description="Google Antigravity via the official CLI, with live model discovery, native context detection and account quota monitoring.",
    signup_url="https://antigravity.google/cli",
    base_url="agy://local",
    api_mode="chat_completions",
    auth_type="external_process",
    process_command="agy",
    process_args=("--output-format", "stream-json", "--disable-slash-commands"),
    process_command_env_vars=("ANTIGRAVITY_COMMAND", "AGY_CLI_PATH", "ANTIGRAVITY_CLI_PATH"),
    process_args_env_var="ANTIGRAVITY_ARGS",
    fallback_models=_FALLBACK_MODELS,
    supports_vision=True,
    classify_api_error=_classify_antigravity_error,
    auth_handler=antigravity_auth_handler,
)

register_provider(antigravity_profile)
