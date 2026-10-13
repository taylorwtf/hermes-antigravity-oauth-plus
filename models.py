"""Native model IDs, CLI effort flags, and metadata-only aliases for Antigravity."""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

# Compatibility exports used by client.py; neither invents account models.
_FALLBACK_MODELS: tuple[str, ...] = ()
_MODEL_ALIASES: dict[str, str] = {}

# Official agy --effort vocabulary, not a model-generation/availability table.
_CLI_EFFORTS = ("low", "medium", "high", "xhigh", "max")


def model_effort(model: str | None) -> str | None:
    """Identify a native effort suffix without altering the inference ID."""
    suffix = (model or "").rpartition("-")[2]
    return suffix if suffix in _CLI_EFFORTS else None


def supports_effort_flag(model: str | None) -> bool:
    """Only suffixless Gemini requests accept the separate CLI effort flag."""
    return bool(model and model.startswith("gemini-") and not model_effort(model))


def _normalize_effort(effort: str | None) -> str | None:
    if not effort:
        return None
    value = str(effort).strip().lower()
    if value in ("none", "off", "minimal"):
        return "low"
    return value if value in _CLI_EFFORTS else None


def resolve_model_and_effort(
    model: str | None,
    reasoning_effort: str | None = None,
) -> tuple[str, str | None]:
    """Pass the selected ID verbatim; native suffixes own their effort.

    Manual suffixless Gemini requests may use agy's generic --effort flag.
    No aliases, implicit model/effort defaults, config reads or generated IDs.
    An omitted model lets the official CLI choose its own default.
    """
    selected = model or ""
    effort = _normalize_effort(reasoning_effort) if supports_effort_flag(selected) else None
    return selected, effort


def native_variant_context(model: str) -> int | None:
    """Metadata-only GPT-OSS effort alias, where Hermes misses the agy ID.

    Gemini/Claude already resolve natively and must defer to Hermes. For a
    GPT-OSS effort variant, use only an exact OpenRouter/OpenAI catalog entry
    in Hermes' existing models.dev cache (variant first, then the base SKU).
    This never changes --model, fetches the network, or supplies a guessed cap.
    """
    if not model.startswith("gpt-oss-") or not model_effort(model):
        return None
    try:
        from agent.models_dev import fetch_models_dev

        registry = fetch_models_dev(allow_network=False)
        entries = registry.get("openrouter", {}).get("models", {})
        base = model.rsplit("-", 1)[0]
        for canonical in (f"openai/{model}", f"openai/{base}"):
            if canonical in entries:
                # Read the actual catalog row, not get_model_info's synthetic
                # unknown-model limits or another provider's config overrides.
                entry = entries[canonical]
                limits = entry.get("limit", {}) if isinstance(entry, dict) else {}
                context = limits.get("context") if isinstance(limits, dict) else None
                return context if type(context) is int and context > 0 else None
    except Exception as exc:
        logger.debug("Antigravity native metadata alias unavailable: %s", exc)
    return None
