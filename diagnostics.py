"""Local diagnostics; explicit, bounded agy catalog refresh (never inference)."""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import stat
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from hermes_cli.config import load_config_readonly
from hermes_constants import get_hermes_home
from plugins.plugin_storage import plugin_data_dir

try:
    from .models import resolve_model_and_effort
    from .process import resolve_agy_command
except ImportError:
    from models import resolve_model_and_effort
    from process import resolve_agy_command

PROVIDER = "antigravity-oauth-plus"
ALIASES = {PROVIDER, "agy-oauth-plus", "google-antigravity-plus"}
ID = re.compile(r"[a-z0-9][a-z0-9._-]{0,127}")
CATALOG_ID = re.compile(r"[a-z0-9][a-z0-9._-]*-[a-z0-9][a-z0-9._-]*")
VERSION = re.compile(r"\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]{1,40})?")
MAX_BYTES = 1024 * 1024
CATALOG_FRESH_SECONDS = 3600


class DiagnosticError(Exception):
    pass


def positive_int(value):
    return value if type(value) is int and value > 0 else None


def native_context(model):
    """Public, cache-only subset: never invoke the network-capable full resolver.

    No exact subsource/provenance guarantee is provided by these public helpers.
    Missing context stays unknown, not an invented provider-wide fallback.
    """
    from agent.model_metadata import get_cached_context_length
    from agent.models_dev import lookup_models_dev_context
    return positive_int(get_cached_context_length(model, "agy://local")) or positive_int(
        lookup_models_dev_context(PROVIDER, model, allow_network=False)
    )


def context_info(config, requested, same_provider):
    model_config = config.get("model")
    model_config = model_config if isinstance(model_config, dict) else {}
    configured = positive_int(model_config.get("context_length")) if same_provider else None
    if configured:
        return {"tokens": configured, "source": "explicit-config-override", "mode": "local-only"}
    overrides = config.get("model_overrides", {})
    section = overrides.get(PROVIDER, {}) if isinstance(overrides, dict) else {}
    if isinstance(section, dict):
        entry = section.get(requested)
        if not isinstance(entry, dict):
            entry = next((v for k, v in section.items() if isinstance(k, str) and k != "_default" and k.lower() == requested.lower() and isinstance(v, dict)), {})
        explicit = positive_int(entry.get("context_window"))
        if explicit:
            return {"tokens": explicit, "source": "explicit-config-model-override", "mode": "local-only"}
    try:
        override = int(os.getenv("ANTIGRAVITY_CONTEXT_LENGTH", ""))
    except ValueError:
        override = 0
    if override > 0:
        return {"tokens": override, "source": "explicit-env-override", "mode": "local-only"}
    return {"tokens": native_context(requested), "source": "native-resolution/source-unspecified", "mode": "cached-only-partial-resolution"}


def catalog_path(create=False):
    root = plugin_data_dir(PROVIDER) if create else get_hermes_home() / "plugin-data" / PROVIDER
    if root.exists() or root.is_symlink():
        info = root.lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise DiagnosticError("CATALOG_STATE_INVALID")
        if create:
            root.chmod(0o700)
    return root / "model-catalog.json"


def parse_time(value):
    if not isinstance(value, str):
        raise DiagnosticError("CATALOG_STATE_INVALID")
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise DiagnosticError("CATALOG_STATE_INVALID") from None
    if result.tzinfo is None:
        raise DiagnosticError("CATALOG_STATE_INVALID")
    return result


def read_catalog():
    path = catalog_path()
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_BYTES:
        raise DiagnosticError("CATALOG_STATE_INVALID")
    # Refuse symlinks at open too; ancestors belong to the trusted active profile.
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(fd, "r", encoding="utf-8") as stream:
        opened = os.fstat(stream.fileno())
        if not stat.S_ISREG(opened.st_mode) or (info.st_dev, info.st_ino) != (opened.st_dev, opened.st_ino):
            raise DiagnosticError("CATALOG_STATE_INVALID")
        text = stream.read(MAX_BYTES + 1)
    try:
        value = json.loads(text)
    except (ValueError, UnicodeError):
        raise DiagnosticError("CATALOG_STATE_INVALID") from None
    ids = value.get("model_ids") if isinstance(value, dict) else None
    if not isinstance(ids, list) or not ids or any(not isinstance(x, str) or not CATALOG_ID.fullmatch(x) or len(x) > 128 for x in ids) or len(ids) != len(set(ids)):
        raise DiagnosticError("CATALOG_STATE_INVALID")
    parse_time(value.get("observed_at"))
    version = value.get("agy_version")
    return {"observed_at": value["observed_at"], "model_ids": sorted(ids), "agy_version": version if isinstance(version, str) and VERSION.fullmatch(version) else None}


def metadata_output(argv, timeout):
    # Capture in a private ephemeral file: no unbounded stdout held in memory,
    # no raw stdout/stderr in bug-report exports or persistent observations.
    with tempfile.TemporaryFile() as output:
        result = subprocess.run(argv, stdout=output, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, timeout=timeout, check=False, shell=False)
        output.seek(0)
        raw = output.read(MAX_BYTES + 1)
    if result.returncode != 0:
        raise DiagnosticError("AGY_METADATA_FAILED")
    if len(raw) > MAX_BYTES:
        raise DiagnosticError("AGY_METADATA_OVERSIZED")
    try:
        return raw.decode("utf-8", errors="strict")
    except UnicodeError:
        raise DiagnosticError("AGY_METADATA_INVALID") from None


def parse_complete_catalog(text):
    ids = set()
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.lower().startswith("fetching ") or re.fullmatch(r"[-=\s]+", line):
            continue
        if re.fullmatch(r"(?i)(?:model(?:\s+id)?)(?:\s+(?:name|description|family))?", line):
            continue
        model_id = line.split()[0]
        if len(model_id) > 128 or not CATALOG_ID.fullmatch(model_id):
            # Unknown/truncated output must not masquerade as removals.
            raise DiagnosticError("CATALOG_INCOMPLETE")
        ids.add(model_id)
    if not ids:
        raise DiagnosticError("CATALOG_INCOMPLETE")
    return sorted(ids)


def write_catalog(path, value):
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise DiagnosticError("CATALOG_STATE_INVALID")
    fd, name = tempfile.mkstemp(prefix=".model-catalog-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def refresh_catalog():
    path = catalog_path(create=True)
    lock = path.parent / ".model-catalog-refresh.lock"
    try:
        lock.mkdir(mode=0o700)
    except FileExistsError:
        raise DiagnosticError("CATALOG_REFRESH_BUSY") from None
    try:
        prior = read_catalog()
        command = resolve_agy_command()
        ids = parse_complete_catalog(metadata_output([command, "models"], 10))
        version = prior.get("agy_version") if prior else None
        try:
            version_match = VERSION.search(metadata_output([command, "--version"], 3))
            if version_match:
                version = version_match.group()
        except (DiagnosticError, OSError, subprocess.SubprocessError):
            pass  # The complete model observation remains valid without a version.
        snapshot = {"observed_at": datetime.now(timezone.utc).isoformat(), "model_ids": ids, "agy_version": version}
        before = set(prior["model_ids"]) if prior else set()
        change = {"compared": prior is not None, "added": sorted(set(ids) - before) if prior else [], "removed": sorted(before - set(ids)) if prior else []}
        write_catalog(path, snapshot)
        return snapshot, change
    finally:
        lock.rmdir()


def build_status(config, model=None, effort=None, catalog=None):
    model_config = config.get("model", {})
    model_config = model_config if isinstance(model_config, dict) else {}
    same_provider = model_config.get("provider") in ALIASES
    requested = model if model is not None else model_config.get("default", model_config.get("model"))
    if model is None and not same_provider:
        raise DiagnosticError("MODEL_REQUIRED")
    if not isinstance(requested, str) or not ID.fullmatch(requested):
        raise DiagnosticError("INVALID_MODEL")
    agent = config.get("agent", {})
    configured_effort = agent.get("reasoning_effort") if isinstance(agent, dict) else None
    selected_effort = effort or configured_effort or "medium"
    if selected_effort not in {"low", "medium", "high", "none", "off", "minimal", "xhigh", "max", "ultra"}:
        raise DiagnosticError("INVALID_EFFORT")
    executable_id, executable_effort = resolve_model_and_effort(requested, selected_effort)
    context = context_info(config, requested, same_provider)
    compression = config.get("compression", {})
    compression = compression if isinstance(compression, dict) else {}
    ratio = compression.get("threshold")
    if not isinstance(ratio, (int, float)) or isinstance(ratio, bool) or not math.isfinite(ratio) or not 0 < ratio <= 1:
        ratio = None
    cap = positive_int(compression.get("threshold_tokens"))
    age = (datetime.now(timezone.utc) - parse_time(catalog["observed_at"])).total_seconds() if catalog else None
    warnings = []
    if context["tokens"] is None:
        warnings.append("UNKNOWN_CONTEXT")
    elif context["source"].startswith("native"):
        warnings.append("NATIVE_CONTEXT_UNVERIFIED")
    if catalog is None or executable_id not in catalog["model_ids"]:
        warnings.append("MODEL_NOT_OBSERVED_IN_CACHED_CATALOG")
    return {
        "ok": True, "provider": PROVIDER, "plugin_version": "0.2.0",
        "agy_version": catalog.get("agy_version") if catalog else None,
        "agy_version_source": "cached-refresh-metadata" if catalog and catalog.get("agy_version") else "unknown",
        "requested_model": requested, "requested_effort": selected_effort,
        "executable_model_id": executable_id, "executable_effort": executable_effort,
        "configured_provider_matches": same_provider, "routing_changed": False,
        "context": context,
        "compression": {"enabled": compression.get("enabled") if isinstance(compression.get("enabled"), bool) else None, "configured_threshold_ratio": ratio, "configured_threshold_tokens": cap, "effective_threshold_tokens": None, "reason": "Active compressor output reservation, minimum/floor and auxiliary ceiling are not available to local diagnostics."},
        "discovery": {"source": "successful-agy-models-cache" if catalog else "missing", "observed_at": catalog["observed_at"] if catalog else None, "age_seconds": age, "freshness": "missing" if age is None else "stale" if age < 0 or age >= CATALOG_FRESH_SECONDS else "cached", "freshness_limit_seconds": CATALOG_FRESH_SECONDS, "fallback_used": False, "model_ids": catalog["model_ids"] if catalog else []},
        "warnings": warnings,
    }


def render(value):
    if "requested_model" not in value:
        return f"Diagnostics failed: {value.get('error', 'unavailable')}"
    context = value["context"]
    lines = [f"Provider: {PROVIDER} | plugin {value['plugin_version']} | agy {value['agy_version'] or 'unknown (cached only)'}", f"Model: requested {value['requested_model']} → executable {value['executable_model_id']} | effort {value['executable_effort'] or 'ID-owned'}", f"Context: {context['tokens'] if context['tokens'] is not None else 'unknown'} tokens | {context['source']} | {context['mode']}", f"Compression: configured ratio {value['compression']['configured_threshold_ratio']}; token cap {value['compression']['configured_threshold_tokens']}; effective threshold unknown", f"Discovery: {value['discovery']['freshness']} | observed {value['discovery']['observed_at'] or 'never'} | no fallback catalog"]
    change = value.get("catalog_change")
    if change:
        lines.append(f"Catalog comparison: {'successful snapshots' if change['compared'] else 'not compared (no new successful baseline pair)'}")
        if change["compared"]:
            lines.extend(["Added: " + (", ".join(change["added"]) or "none"), "Removed: " + (", ".join(change["removed"]) or "none")])
    if value.get("error"):
        retained = "prior successful catalog retained" if value["discovery"]["observed_at"] else "no successful catalog available"
        lines.append(f"Refresh failed: {value['error']}; {retained}.")
    lines.extend("Warning: " + warning for warning in value["warnings"])
    lines.append("No inference, auth export, routing change or network-capable context probe performed.")
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", nargs="?", choices=("status", "refresh-models"), default="status")
    parser.add_argument("--model", help="Exact model ID/shorthand; required when another provider is configured")
    parser.add_argument("--effort", choices=("low", "medium", "high"))
    parser.add_argument("--json", action="store_true", help="Sanitized bug-report export; never raw config/auth/process output")
    args = parser.parse_args(argv)
    rc = 0
    try:
        config = load_config_readonly()
        value = build_status(config, args.model, args.effort, read_catalog())
        if args.action == "refresh-models":
            value["catalog_change"] = {"compared": False, "added": [], "removed": []}
            try:
                catalog, change = refresh_catalog()
                value = build_status(config, args.model, args.effort, catalog)
                value["catalog_change"] = change
            except (DiagnosticError, OSError, subprocess.SubprocessError) as exc:
                value.update(ok=False, error=str(exc) if isinstance(exc, DiagnosticError) else "AGY_METADATA_FAILED")
                rc = 1
    except DiagnosticError as exc:
        value = {"ok": False, "error": str(exc), "provider": PROVIDER, "routing_changed": False}
        rc = 2 if str(exc) in {"MODEL_REQUIRED", "INVALID_MODEL", "INVALID_EFFORT"} else 1
    except Exception:
        value = {"ok": False, "error": "DIAGNOSTICS_UNAVAILABLE", "provider": PROVIDER, "routing_changed": False}
        rc = 1
    print(json.dumps(value, sort_keys=True, allow_nan=False) if args.json else render(value))
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
