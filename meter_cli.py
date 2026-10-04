"""Bounded, read-only quota metadata API and standalone CLI.

No auth module imports, inference, collectors, or setup at import time.
State follows the active Hermes profile on every call.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import threading
import time

PLUGIN_ID = "antigravity-oauth-plus"
_BACKEND = Path(__file__).absolute().parent / "backend" / "bin" / "agy-usage.mjs"
_MAX_OUTPUT = 2 * 1024 * 1024


class OutputLimit(RuntimeError):
    pass


def state_dir() -> Path:
    """Use public call-time storage, including Hermes context-local overrides."""
    try:
        from plugins.plugin_storage import plugin_data_dir
    except ImportError:
        root = Path(os.path.expandvars(os.environ.get("HERMES_HOME") or str(Path.home() / ".hermes"))).expanduser()
        return root / "plugin-data" / PLUGIN_ID / "quota"
    return Path(plugin_data_dir(PLUGIN_ID)) / "quota"


def _run(argv: list[str], timeout: float) -> tuple[int, str]:
    """Capture bounded pipes and kill only the child group we created."""
    started = time.monotonic()
    proc = subprocess.Popen(argv, shell=False, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            start_new_session=os.name != "nt")
    outputs = [bytearray(), bytearray()]
    overflow = threading.Event()

    def read(pipe, index):
        try:
            while chunk := pipe.read(65536):
                if len(outputs[index]) + len(chunk) > _MAX_OUTPUT:
                    overflow.set()
                    return
                outputs[index].extend(chunk)
        finally:
            pipe.close()

    threads = [threading.Thread(target=read, args=(pipe, index), daemon=True)
               for index, pipe in enumerate((proc.stdout, proc.stderr))]
    for thread in threads:
        thread.start()
    try:
        while proc.poll() is None or any(thread.is_alive() for thread in threads):
            if overflow.is_set():
                raise OutputLimit("output_limit")
            if time.monotonic() - started >= timeout:
                raise TimeoutError("metadata_timeout")
            time.sleep(.01)
        if overflow.is_set():
            raise OutputLimit("output_limit")
        return proc.returncode, outputs[0].decode("utf-8")
    finally:
        if proc.poll() is None or any(thread.is_alive() for thread in threads):
            if os.name != "nt":
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            else:
                proc.kill()
        proc.wait(timeout=.25)
        for thread in threads:
            thread.join(timeout=.1)


def _error(code: str) -> dict:
    return {"ok": False, "error": {"code": code,
            "message": "Quota metadata unavailable; no observation was refreshed."}}


def metadata(action: str = "status", credits: bool = False, limit: int = 20) -> dict:
    """Return {'ok': True, 'snapshot': ...} or history rows/count.

    status/history only read cached state (4.5 s process ceiling); explicit
    refresh permits only literal /usage and optional /credits (30 s ceiling).
    Backend state errors, timeouts, and failures remain sanitized and structured.
    """
    if (action not in ("status", "refresh", "history") or type(credits) is not bool
            or (credits and action != "refresh") or type(limit) is not int
            or not 1 <= limit <= 1000):
        return _error("invalid_arguments")
    started = time.monotonic()
    try:
        node = shutil.which("node")
        if not node or not os.path.isabs(node):
            return _error("node_unavailable")
        argv = [node, str(_BACKEND), action, "--json", "--envelope", "--state-dir", str(state_dir())]
        if credits:
            argv.append("--credits")
        if action == "history":
            argv.extend(("--limit", str(limit)))
        remaining = (30 if action == "refresh" else 4.0) - (time.monotonic() - started)
        if remaining <= 0:
            return _error("metadata_timeout")
        code, output = _run(argv, remaining)
        payload = json.loads(output)
        if not isinstance(payload, dict) or type(payload.get("ok")) is not bool:
            return _error("invalid_metadata")
        if payload["ok"]:
            if code != 0:
                return _error("process_exit")
            if action == "history":
                rows = payload.get("observations")
                if not isinstance(rows, list) or payload.get("count") != len(rows):
                    return _error("invalid_metadata")
            elif not isinstance(payload.get("snapshot"), dict):
                return _error("invalid_metadata")
            return payload
        # Do not pass through raw child errors or unknown fields.
        allowed = {"BACKEND_FAILED", "INVALID_JSON", "INFERENCE_GUARD", "INVALID_SCHEMA",
                   "STATE_INVALID", "STATE_IO", "LOCK_BUSY", "CLOCK_REGRESSION", "NODE_VERSION"}
        error = _error(payload.get("error", {}).get("code") if isinstance(payload.get("error"), dict)
                       and payload["error"].get("code") in allowed else "metadata_unavailable")
        if isinstance(payload.get("snapshot"), dict):
            error["snapshot"] = payload["snapshot"]
        return error
    except TimeoutError:
        return _error("metadata_timeout")
    except OutputLimit:
        return _error("output_limit")
    except (OSError, ValueError, subprocess.SubprocessError):
        return _error("metadata_unavailable")


def format_metadata(payload: dict) -> str:
    """Concise human view; Unknown, zero, failed and stale remain distinct."""
    if not payload.get("ok"):
        return f"Quota metadata unavailable ({payload['error']['code']}); prior values are unverified."
    if "observations" in payload:
        rows = payload["observations"]
        return "\n".join(f"{row.get('observed_at', 'Unknown')} | " + " | ".join(
            f"{bucket['id']}: " + ("Unknown" if bucket.get("remaining_fraction") is None
            else f"{bucket['remaining_fraction'] * 100:.1f}% remaining")
            for bucket in row.get("buckets", [])) for row in rows) or "No collected observations."
    view = payload["snapshot"]
    age = view.get("age_seconds")
    lines = [f"Quota status: {view.get('freshness', 'Unknown').upper()} | observed: {view.get('observed_at') or 'none'} | age: {round(age) if age is not None else 'Unknown'}s"]
    if view.get("health", {}) and view["health"].get("status") == "error":
        lines.append(f"Health error: {view['health'].get('code', 'STATE_INVALID')}; last good values retained, not refreshed.")
    for meter in view.get("meters", []):
        value = meter.get("remaining_percent")
        lines.append(f"{meter['id']}: {'Unknown' if value is None else f'{value:.1f}%'} remaining | reset {meter.get('reset_time') or 'Unknown'} | {'usable' if meter.get('available') else 'blocked/unverified'}")
    if not view.get("meters"):
        lines.append("Allowances unknown: no known successful observation.")
    if view.get("credits"):
        lines.append(f"Observed credits: {view['credits']['remaining_credits']} (read-only)")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read cached quota metadata or explicitly refresh; never inference")
    parser.add_argument("action", nargs="?", default="status", choices=("status", "refresh", "history"))
    parser.add_argument("--credits", action="store_true", help="Read /credits too (refresh only)")
    parser.add_argument("--limit", type=int, default=None, help="History rows, 1..1000 (history only)")
    parser.add_argument("--json", action="store_true", help="Return structured metadata")
    args = parser.parse_args(argv)
    if args.credits and args.action != "refresh" or args.limit is not None and (args.action != "history" or not 1 <= args.limit <= 1000):
        parser.error("--credits is refresh-only; --limit 1..1000 is history-only")
    result = metadata(args.action, args.credits, args.limit or 20)
    print(json.dumps(result) if args.json else format_metadata(result))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
