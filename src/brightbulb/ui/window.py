"""Main window shell.

A ViewStack with one page per major area (Lights, Scenes, Sync), switched by a
ViewSwitcher in the header on wide layouts and a bottom bar when narrow.

The window owns the *connection* presentation: whichever page is showing, if
there is no bridge the user sees how to get one. Page content itself arrives in
later milestones.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")

from gi.repository import Adw, Gio, GObject, Gtk  # noqa: E402

from brightbulb.hue.bridge import ConnectionState  # noqa: E402
from brightbulb.ui.lights_page import LightsPage  # noqa: E402
from brightbulb.ui.pairing_dialog import PairingDialog  # noqa: E402
from brightbulb.ui.scenes_page import ScenesPage  # noqa: E402
from brightbulb.ui.sync_page import SyncPage  # noqa: E402

if TYPE_CHECKING:
    from brightbulb.app import BrightBulbApplication


class MainWindow(Adw.ApplicationWindow):
    def __init__(self, application: BrightBulbApplication) -> None:
        super().__init__(application=application, title="BrightBulb")
        self.set_default_size(1000, 700)
        self.set_size_request(360, 480)

        self.app = application
        self.toasts = Adw.ToastOverlay()
        self._torn_down = False

        self._lights_page = self._build_lights_page()

        self.stack = Adw.ViewStack()
        self.stack.add_titled_with_icon(
            self._lights_page, "lights", "Lights", "weather-clear-symbolic"
        )
        self.scenes_page = ScenesPage(self.app)
        self.stack.add_titled_with_icon(
            self.scenes_page, "scenes", "Scenes", "view-paged-symbolic"
        )
        self.sync_page = SyncPage(self.app)
        self.stack.add_titled_with_icon(
            self.sync_page, "sync", "Sync", "video-display-symbolic"
        )

        header = Adw.HeaderBar()
        switcher = Adw.ViewSwitcher(stack=self.stack, policy=Adw.ViewSwitcherPolicy.WIDE)
        header.set_title_widget(switcher)
        header.pack_end(self._menu_button())

        self._status_icon = Gtk.Image(icon_name="network-offline-symbolic",
                                      tooltip_text="Not connected")
        header.pack_start(self._status_icon)

        toolbar = Adw.ToolbarView()
        toolbar.add_top_bar(header)
        toolbar.set_content(self.stack)

        switcher_bar = Adw.ViewSwitcherBar(stack=self.stack)
        toolbar.add_bottom_bar(switcher_bar)

        # Collapse the header switcher into the bottom bar on narrow windows.
        # The title-widget setter needs an explicit NULL-valued GValue: a bare
        # Python None gives PyGObject no type to marshal and trips an assertion
        # inside adw_breakpoint_add_setter.
        no_widget = GObject.Value(Gtk.Widget)
        breakpoint_ = Adw.Breakpoint.new(Adw.BreakpointCondition.parse("max-width: 550sp"))
        breakpoint_.add_setter(switcher_bar, "reveal", True)
        breakpoint_.add_setter(header, "title-widget", no_widget)
        self.add_breakpoint(breakpoint_)

        self.toasts.set_child(toolbar)
        self.set_content(self.toasts)

        self._unsubscribe = self.app.bridge.on_state_change(self._on_connection_state)
        self._unsubscribe_changes = self.app.bridge.on_resources_changed(self._refresh_resources)
        self.connect("close-request", self._on_close)
        self._on_connection_state(self.app.bridge.state, None)

    def _refresh_resources(self) -> None:
        """Repaint from current bridge state. Always called on the GTK thread."""
        bridge = self.app.bridge.bridge
        if bridge is not None:
            self._lights_list.refresh(bridge)
            self.scenes_page.refresh(bridge)
            self.sync_page.refresh(bridge)

    # -- connection presentation ------------------------------------------

    def _build_lights_page(self) -> Gtk.Widget:
        self._disconnected_status = Adw.StatusPage(
            title="No bridge connected",
            description="Discover a Hue bridge on your network to control your lights.",
            icon_name="network-wireless-symbolic",
        )
        connect_button = Gtk.Button(label="Connect a Bridge", halign=Gtk.Align.CENTER)
        connect_button.add_css_class("pill")
        connect_button.add_css_class("suggested-action")
        connect_button.connect("clicked", lambda *_: self.show_pairing_dialog())
        self._disconnected_status.set_child(connect_button)

        self._connecting_status = Adw.StatusPage(
            title="Connecting", child=Adw.Spinner(width_request=48, height_request=48)
        )

        self._lights_list = LightsPage(self.app.writer)

        self._lights_stack = Gtk.Stack(transition_type=Gtk.StackTransitionType.CROSSFADE)
        self._lights_stack.add_named(self._disconnected_status, "disconnected")
        self._lights_stack.add_named(self._connecting_status, "connecting")
        self._lights_stack.add_named(self._lights_list, "connected")
        return self._lights_stack

    def _on_connection_state(self, state: ConnectionState, detail: str | None) -> None:
        """Reflect connection state. Always called on the GTK thread."""
        if state is ConnectionState.CONNECTED:
            # Populate immediately: the first change event may be minutes away
            # on a quiet bridge, and an empty list until then looks broken.
            self._refresh_resources()
            self._lights_stack.set_visible_child_name("connected")
            self._status_icon.set_from_icon_name("network-wireless-symbolic")
            self._status_icon.set_tooltip_text("Connected")
            return

        if state is ConnectionState.CONNECTING:
            self._lights_stack.set_visible_child_name("connecting")
            self._status_icon.set_from_icon_name("network-transmit-receive-symbolic")
            self._status_icon.set_tooltip_text("Connecting…")
            return

        self._lights_stack.set_visible_child_name("disconnected")
        self._status_icon.set_from_icon_name("network-offline-symbolic")
        self._status_icon.set_tooltip_text(detail or "Not connected")

        if state is ConnectionState.UNAUTHORIZED:
            self._disconnected_status.set_title("Bridge access was revoked")
            self._disconnected_status.set_description(
                "BrightBulb's access to this bridge is no longer valid. "
                "Pair with it again to continue."
            )
        elif state is ConnectionState.ERROR:
            self._disconnected_status.set_title("Cannot reach the bridge")
            self._disconnected_status.set_description(
                detail or "Retrying automatically in the background."
            )

    def show_page(self, name: str) -> None:
        """Switch to a page by name."""
        if self.stack.get_child_by_name(name) is not None:
            self.stack.set_visible_child_name(name)

    def show_pairing_dialog(self) -> None:
        PairingDialog(self.app, on_paired=self._on_paired).present(self)

    def _on_paired(self) -> None:
        self.toast("Bridge connected")
        self.app.connect_bridge()

    def _on_close(self, *_: object) -> bool:
        if self.app.can_hide_to_tray():
            # Hide rather than destroy: mirroring keeps running, and every
            # widget keeps its state for when the window comes back.
            self.app.hide_to_tray()
            return True

        # Release the entertainment area and the portal session before the
        # window goes away, or the area stays locked against other Hue apps.
        self.teardown()
        return False

    def teardown(self) -> None:
        """Release everything the window owns. Safe to call twice."""
        if self._torn_down:
            return
        self._torn_down = True
        self.sync_page.shutdown()
        self._unsubscribe()
        self._unsubscribe_changes()

    # -- chrome ------------------------------------------------------------

    def _menu_button(self) -> Gtk.MenuButton:
        menu = Gio.Menu()
        menu.append("Connect a Bridge…", "app.pair")

        tray = Gio.Menu()
        tray.append("Minimize to Tray", "app.hide")
        tray.append("Close to Tray", "app.close-to-tray")
        menu.append_section(None, tray)

        rest = Gio.Menu()
        rest.append("About BrightBulb", "app.about")
        rest.append("Quit", "app.quit")
        menu.append_section(None, rest)
        return Gtk.MenuButton(icon_name="open-menu-symbolic", menu_model=menu,
                              tooltip_text="Main menu")

    def toast(self, message: str) -> None:
        """Show a transient message. Must be called on the GTK main thread."""
        self.toasts.add_toast(Adw.Toast(title=message))
