"""Application object: owns the asyncio runner and the main window."""

from __future__ import annotations

import logging

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")

from gi.repository import Adw, Gio, GLib, Gtk  # noqa: E402

from brightbulb.asyncio_bridge import AsyncRunner  # noqa: E402
from brightbulb.config import APP_ID, SecretStore, Settings  # noqa: E402
from brightbulb.hue.bridge import BridgeConnection  # noqa: E402
from brightbulb.hue.lights import LightWriter  # noqa: E402
from brightbulb.ui.window import MainWindow  # noqa: E402

_LOGGER = logging.getLogger(__name__)


class BrightBulbApplication(Adw.Application):
    def __init__(self) -> None:
        super().__init__(application_id=APP_ID, flags=Gio.ApplicationFlags.DEFAULT_FLAGS)
        self.runner = AsyncRunner()
        self.settings = Settings.load()
        self.secrets = SecretStore()
        self.bridge = BridgeConnection(self.settings, self.secrets)
        self.writer = LightWriter(self.bridge)
        self._window: MainWindow | None = None

    def do_startup(self) -> None:
        Adw.Application.do_startup(self)
        self.runner.start()
        self.writer.start(self.runner.loop)
        self._install_actions()

    def do_activate(self) -> None:
        if self._window is None:
            self._window = MainWindow(application=self)
        self._window.present()
        # Reconnect to a previously paired bridge without user interaction.
        if self.bridge.has_credentials():
            self.connect_bridge()

    def connect_bridge(self) -> None:
        """Start connecting to the configured bridge (non-blocking)."""
        self.runner.run_and_then(self.bridge.connect())

    def do_shutdown(self) -> None:
        # Closing the bridge releases the CLIP event stream cleanly instead of
        # leaving the connection for the bridge to time out.
        try:
            self.runner.submit(self.writer.stop()).result(timeout=2)
            self.runner.submit(self.bridge.disconnect()).result(timeout=3)
        except Exception:
            _LOGGER.debug("bridge did not shut down cleanly", exc_info=True)

        # Settings are saved here rather than on every change so that rapid UI
        # tweaks (sliders) do not hammer the disk.
        try:
            self.settings.save()
        except OSError:
            _LOGGER.exception("could not save settings")
        self.runner.stop()
        Adw.Application.do_shutdown(self)

    def _install_actions(self) -> None:
        quit_action = Gio.SimpleAction.new("quit", None)
        quit_action.connect("activate", lambda *_: self.quit())
        self.add_action(quit_action)
        self.set_accels_for_action("app.quit", ["<Control>q"])

        about_action = Gio.SimpleAction.new("about", None)
        about_action.connect("activate", lambda *_: self._show_about())
        self.add_action(about_action)

        pair_action = Gio.SimpleAction.new("pair", None)
        pair_action.connect("activate", lambda *_: self._show_pairing())
        self.add_action(pair_action)

        # Jump straight to a page, with the usual Ctrl+number shortcuts.
        page_action = Gio.SimpleAction.new("page", GLib.VariantType("s"))
        page_action.connect("activate", self._on_page_action)
        self.add_action(page_action)
        for index, name in enumerate(("lights", "scenes", "sync"), start=1):
            self.set_accels_for_action(f"app.page('{name}')", [f"<Control>{index}"])

    def _on_page_action(self, _action: Gio.SimpleAction, target: GLib.Variant) -> None:
        if self._window is not None:
            self._window.show_page(target.get_string())

    def _show_pairing(self) -> None:
        if self._window is not None:
            self._window.show_pairing_dialog()

    def _show_about(self) -> None:
        about = Adw.AboutDialog(
            application_name="BrightBulb",
            application_icon=APP_ID,
            developer_name="BrightBulb contributors",
            version="0.1.0",
            comments="An open source Philips Hue control center with screen mirroring.",
            license_type=Gtk.License.GPL_3_0,
        )
        if self._window is not None:
            about.present(self._window)
