"""Application object: owns the asyncio runner and the main window."""

from __future__ import annotations

import logging

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")

from gi.repository import Adw, Gdk, Gio, GLib, Gtk  # noqa: E402

from brightbulb.asyncio_bridge import AsyncRunner  # noqa: E402
from brightbulb.config import APP_ID, APP_NAME, SecretStore, Settings  # noqa: E402
from brightbulb.hue.bridge import BridgeConnection  # noqa: E402
from brightbulb.hue.lights import LightWriter  # noqa: E402
from brightbulb.ui.tray import MenuItem, TrayIcon, separator  # noqa: E402
from brightbulb.ui.window import MainWindow  # noqa: E402

_LOGGER = logging.getLogger(__name__)

# Used for the tray when the app's own icon is not installed in the icon theme,
# which is the normal case when running straight from a source checkout.
_FALLBACK_TRAY_ICON = "display-brightness-symbolic"


class BrightBulbApplication(Adw.Application):
    def __init__(self) -> None:
        super().__init__(application_id=APP_ID, flags=Gio.ApplicationFlags.DEFAULT_FLAGS)
        self.runner = AsyncRunner()
        self.settings = Settings.load()
        self.secrets = SecretStore()
        self.bridge = BridgeConnection(self.settings, self.secrets)
        self.writer = LightWriter(self.bridge)
        self._window: MainWindow | None = None
        self._tray: TrayIcon | None = None

    def do_startup(self) -> None:
        Adw.Application.do_startup(self)
        self.runner.start()
        self.writer.start(self.runner.loop)
        self._install_actions()

    def do_activate(self) -> None:
        if self._window is None:
            self._window = MainWindow(application=self)
            self._window.sync_page.on_state_change = self._refresh_tray
            self._start_tray()
        self._window.present()
        # Reconnect to a previously paired bridge without user interaction.
        if self.bridge.has_credentials():
            self.connect_bridge()

    def connect_bridge(self) -> None:
        """Start connecting to the configured bridge (non-blocking)."""
        self.runner.run_and_then(self.bridge.connect())

    # -- tray --------------------------------------------------------------

    def _start_tray(self) -> None:
        self._tray = TrayIcon(
            icon_name=self._tray_icon_name(),
            title=APP_NAME,
            build_menu=self._tray_menu,
            on_activate=self.toggle_window,
        )
        if not self._tray.start():
            self._tray = None

    def _tray_icon_name(self) -> str:
        display = Gdk.Display.get_default()
        if display is not None:
            theme = Gtk.IconTheme.get_for_display(display)
            if theme.has_icon(APP_ID):
                return APP_ID
        return _FALLBACK_TRAY_ICON

    def _tray_menu(self) -> list[MenuItem]:
        window = self._window
        sync = window.sync_page if window is not None else None
        visible = bool(window is not None and window.get_visible())
        return [
            MenuItem(
                label="Hide Window" if visible else "Show BrightBulb",
                on_click=self.toggle_window,
            ),
            separator(),
            MenuItem(
                label="Mirror My Screen",
                on_click=self._toggle_mirroring,
                enabled=bool(sync is not None and sync.can_mirror),
                checked=bool(sync is not None and sync.mirroring),
            ),
            separator(),
            MenuItem(label="Quit", on_click=self.quit),
        ]

    def _toggle_mirroring(self) -> None:
        window = self._window
        if window is not None:
            window.sync_page.set_mirroring(not window.sync_page.mirroring)

    def _refresh_tray(self) -> None:
        """Keep the tray's tooltip and menu in step with mirroring."""
        tray, window = self._tray, self._window
        if tray is None or window is None:
            return
        status = window.sync_page.status_text()
        tray.set_tooltip(f"{APP_NAME} — {status}" if status else APP_NAME)
        tray.refresh_menu()

    def can_hide_to_tray(self) -> bool:
        """Whether closing the window should hide it rather than quit."""
        return (
            self.settings.close_to_tray
            and self._tray is not None
            and self._tray.available
        )

    def hide_to_tray(self) -> None:
        if self._window is None:
            return
        self._window.set_visible(False)
        self._refresh_tray()
        # Without this the app looks like it simply vanished, and people go
        # looking for it in vain. Once is enough.
        if not self.settings.tray_hint_shown:
            self.settings.tray_hint_shown = True
            self._save_settings()
            notification = Gio.Notification.new(APP_NAME)
            notification.set_body(
                "Still running in the tray. Click the tray icon to bring it back."
            )
            self.send_notification("tray-hint", notification)

    def _on_close_to_tray(
        self, action: Gio.SimpleAction, value: GLib.Variant
    ) -> None:
        action.set_state(value)
        self.settings.close_to_tray = value.get_boolean()
        self._save_settings()

    def _hide_requested(self) -> None:
        """Explicit 'Minimize to Tray'. Refuses when there is no tray to go to."""
        if self._tray is not None and self._tray.available:
            self.hide_to_tray()
        elif self._window is not None:
            self._window.toast("No system tray is running to minimize into.")

    def toggle_window(self) -> None:
        """Show the window, or hide it if it is already up. Called from the tray."""
        window = self._window
        if window is None:
            self.activate()
            return
        if window.get_visible():
            self.hide_to_tray()
        else:
            window.present()
            self._refresh_tray()

    def _save_settings(self) -> None:
        try:
            self.settings.save()
        except OSError:
            _LOGGER.exception("could not save settings")

    def do_shutdown(self) -> None:
        if self._window is not None:
            # Releases the entertainment area and the portal session. The window
            # may never have been closed, so this cannot rely on close-request.
            self._window.teardown()
        if self._tray is not None:
            self._tray.stop()
            self._tray = None

        # Closing the bridge releases the CLIP event stream cleanly instead of
        # leaving the connection for the bridge to time out.
        try:
            self.runner.submit(self.writer.stop()).result(timeout=2)
            self.runner.submit(self.bridge.disconnect()).result(timeout=3)
        except Exception:
            _LOGGER.debug("bridge did not shut down cleanly", exc_info=True)

        # Settings are saved here rather than on every change so that rapid UI
        # tweaks (sliders) do not hammer the disk.
        self._save_settings()
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

        hide_action = Gio.SimpleAction.new("hide", None)
        hide_action.connect("activate", lambda *_: self._hide_requested())
        self.add_action(hide_action)
        self.set_accels_for_action("app.hide", ["<Control>h"])

        close_action = Gio.SimpleAction.new_stateful(
            "close-to-tray", None, GLib.Variant("b", self.settings.close_to_tray)
        )
        close_action.connect("change-state", self._on_close_to_tray)
        self.add_action(close_action)

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
