"""Fixture-only adapter lifecycle tests; TMPDIR must be task-owned scratch."""
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).absolute().parent.parent
sys.path.insert(0, str(ROOT))
import widget_setup


class WidgetSetupTests(unittest.TestCase):
    def setUp(self):
        scratch = Path(os.environ["TMPDIR"])
        if not scratch.is_absolute() or not scratch.is_dir():
            raise RuntimeError("TMPDIR must be an existing task-owned scratch directory")
        self.tmp = tempfile.TemporaryDirectory(prefix="widget-fixture-", dir=scratch)
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.home = self.root / "profile-a"
        self.plugin = self.root / "plugin with spaces"
        self.target = self.plugin / "tui" / "agy-usage.mjs"
        self.target.parent.mkdir(parents=True)
        self.target.write_text("export default function register() {}\n")
        self.env = patch.dict(os.environ, {"HERMES_HOME": str(self.home)})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.adapter = self.home / "tui-widgets" / "agy-plus-usage.mjs"

    def enable(self):
        return widget_setup.enable(plugin_dir=self.plugin)

    def disable(self):
        return widget_setup.disable(plugin_dir=self.plugin)

    def test_import_is_inert(self):
        spec = importlib.util.spec_from_file_location("isolated_widget_setup", ROOT / "widget_setup.py")
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertFalse(self.home.exists())

    def test_enable_disable_exact_owned_private_adapter(self):
        result = self.enable()
        self.assertTrue(result["changed"])
        text = self.adapter.read_text()
        self.assertIn("antigravity-oauth-plus", text)
        self.assertIn(self.target.as_uri() + "?v=", text)
        self.assertIn("export { default } from ", text)
        self.assertEqual(stat.S_IMODE(self.adapter.stat().st_mode), 0o600)
        self.assertFalse(self.enable()["changed"])
        companion = self.adapter.parent / "agy-usage.mjs"
        companion.write_text("foreign companion\n")
        self.assertTrue(self.disable()["changed"])
        self.assertFalse(self.adapter.exists())
        self.assertEqual(companion.read_text(), "foreign companion\n")
        self.assertFalse(self.disable()["changed"])

    def test_modified_and_foreign_adapters_refused(self):
        self.enable()
        original = self.adapter.read_bytes()
        version_start = original.index(b"?v=") + 3
        changed_version = original[:version_start] + (b"1" if original[version_start:version_start + 1] == b"0" else b"0") + original[version_start + 1:]
        for content in (original + b"// user edit\n", changed_version, b"// antigravity-oauth-plus\nforeign\n"):
            self.adapter.write_bytes(content)
            for action in (self.enable, self.disable):
                with self.assertRaises(widget_setup.SetupError):
                    action()
                self.assertEqual(self.adapter.read_bytes(), content)
        self.adapter.write_bytes(original)
        self.disable()

    def test_version_changes_for_changed_target(self):
        self.enable()
        before = self.adapter.read_bytes()
        self.target.write_text("export default function different() {}\n")
        self.assertTrue(self.enable()["changed"])
        self.assertNotEqual(before, self.adapter.read_bytes())
        self.assertTrue(self.disable()["changed"])

    def test_disable_accepts_valid_old_version_without_target(self):
        self.enable()
        self.target.unlink()
        self.assertTrue(self.disable()["changed"])

    def test_call_time_profile_switch(self):
        self.enable()
        other = self.root / "profile-b"
        with patch.dict(os.environ, {"HERMES_HOME": str(other)}):
            self.enable()
            self.disable()
        self.assertTrue(self.adapter.exists())
        self.assertFalse((other / "tui-widgets" / self.adapter.name).exists())
        self.disable()

    def test_fallback_home_is_call_time(self):
        with patch.dict(os.environ, {}, clear=True), patch.dict(sys.modules, {"hermes_constants": None}), patch.object(Path, "home", return_value=self.root):
            self.enable()
        self.assertTrue((self.root / ".hermes" / "tui-widgets" / self.adapter.name).is_file())

    def test_relative_traversal_and_filesystem_root_refused(self):
        for value in ("relative-profile", str(self.root / "child" / ".." / "outside"), "/", ""):
            with patch.dict(os.environ, {"HERMES_HOME": value}):
                with self.assertRaises(widget_setup.SetupError):
                    self.enable()
        self.assertFalse(self.home.exists())

    def test_symlink_root_and_ancestry_refused(self):
        real = self.root / "real"
        real.mkdir()
        link = self.root / "alias"
        link.symlink_to(real, target_is_directory=True)
        for home in (link, link / "profile"):
            with patch.dict(os.environ, {"HERMES_HOME": str(home)}):
                for action in (self.enable, self.disable):
                    with self.assertRaises(widget_setup.SetupError):
                        action()
        self.assertEqual(list(real.iterdir()), [])

    def test_symlink_widget_directory_refused(self):
        self.home.mkdir()
        outside = self.root / "outside"
        outside.mkdir()
        (self.home / "tui-widgets").symlink_to(outside, target_is_directory=True)
        for action in (self.enable, self.disable):
            with self.assertRaises(widget_setup.SetupError):
                action()
        self.assertEqual(list(outside.iterdir()), [])

    def test_symlink_adapter_leaf_including_dangling_refused(self):
        self.home.mkdir()
        self.adapter.parent.mkdir()
        destination = self.root / "foreign.mjs"
        for existing in (False, True):
            if existing:
                destination.write_text("keep\n")
            self.adapter.symlink_to(destination)
            for action in (self.enable, self.disable):
                with self.assertRaises(widget_setup.SetupError):
                    action()
            self.assertTrue(self.adapter.is_symlink())
            self.adapter.unlink()
        self.assertEqual(destination.read_text(), "keep\n")

    def test_target_regular_file_required(self):
        self.target.unlink()
        with self.assertRaises(widget_setup.SetupError):
            self.enable()
        self.assertFalse(self.home.exists())
        self.target.mkdir()
        with self.assertRaises(widget_setup.SetupError):
            self.enable()
        self.target.rmdir()
        destination = self.root / "real.mjs"
        destination.write_text("export default () => {}\n")
        self.target.symlink_to(destination)
        with self.assertRaises(widget_setup.SetupError):
            self.enable()
        self.assertFalse(self.home.exists())

    def test_target_symlink_ancestry_refused(self):
        real = self.root / "real-plugin"
        (real / "tui").mkdir(parents=True)
        (real / "tui" / "agy-usage.mjs").write_text("export default () => {}\n")
        link = self.root / "plugin-alias"
        link.symlink_to(real, target_is_directory=True)
        with self.assertRaises(widget_setup.SetupError):
            widget_setup.enable(plugin_dir=link)
        self.assertFalse(self.home.exists())

    def test_adapter_directory_and_hardlink_refused(self):
        self.adapter.parent.mkdir(parents=True)
        self.adapter.mkdir()
        for action in (self.enable, self.disable):
            with self.assertRaises(widget_setup.SetupError):
                action()
        self.adapter.rmdir()
        self.enable()
        alias = self.root / "hardlink.mjs"
        os.link(self.adapter, alias)
        for action in (self.enable, self.disable):
            with self.assertRaises(widget_setup.SetupError):
                action()
        self.assertEqual(alias.read_bytes(), self.adapter.read_bytes())

    def test_cli_json_and_human_output_in_fixture_copy(self):
        script = self.plugin / "widget_setup.py"
        script.write_bytes((ROOT / "widget_setup.py").read_bytes())
        for action in ("enable", "disable"):
            proc = subprocess.run([sys.executable, str(script), action, "--json"], text=True, capture_output=True, timeout=10)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            data = json.loads(proc.stdout)
            self.assertTrue(data["ok"])
            self.assertEqual(data["action"], action)
            self.assertTrue(data["changed"])
        proc = subprocess.run([sys.executable, str(script), "disable"], text=True, capture_output=True, timeout=10)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("already disabled", proc.stdout.lower())

    def test_failed_private_write_cleans_temporary_file(self):
        with patch.object(widget_setup.os, "write", side_effect=OSError("fixture write failure")):
            with self.assertRaises(widget_setup.SetupError):
                self.enable()
        self.assertFalse(self.adapter.exists())
        self.assertEqual(list(self.adapter.parent.iterdir()), [])

    def test_atomic_publication_refuses_new_collision(self):
        real_link = os.link

        def collide(src, dst, **kwargs):
            self.adapter.write_text("concurrent foreign adapter\n")
            return real_link(src, dst, **kwargs)

        with patch.object(widget_setup.os, "link", side_effect=collide):
            with self.assertRaises(widget_setup.SetupError):
                self.enable()
        self.assertEqual(self.adapter.read_text(), "concurrent foreign adapter\n")
        self.assertEqual(list(self.adapter.parent.iterdir()), [self.adapter])

    def test_cli_refusal_is_structured_nonzero(self):
        script = self.plugin / "widget_setup.py"
        script.write_bytes((ROOT / "widget_setup.py").read_bytes())
        self.adapter.parent.mkdir(parents=True)
        self.adapter.write_text("foreign\n")
        proc = subprocess.run([sys.executable, str(script), "enable", "--json"], text=True, capture_output=True, timeout=10)
        self.assertNotEqual(proc.returncode, 0)
        self.assertFalse(json.loads(proc.stdout)["ok"])
        self.assertEqual(self.adapter.read_text(), "foreign\n")


if __name__ == "__main__":
    unittest.main()
