"""Bridge discovery and pairing dialog.

Three stages in one dialog, swapped through a stack:

    searching -> choose a bridge -> press the link button -> done

The link-button stage is the fiddly one: the bridge only accepts registration
within about 30 seconds of the button being pressed, and answers with error 101
until then. Rather than making the user press the button and race to click a
button in the app, we poll on their behalf and succeed the moment it works.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import TYPE_CHECKING

import gi
from aiohue.errors import LinkButtonNotPressed

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")

from gi.repository import Adw, GLib, Gtk  # noqa: E402

from brightbulb.hue import discovery, pairing  # noqa: E402

if TYPE_CHECKING:
    from brightbulb.app import BrightBulbApplication

_LOGGER = logging.getLogger(__name__)

# How long to keep retrying registration while the user finds the button. The
# bridge itself only stays open for ~30s per press, but the user may need to
# walk to another room first, so keep polling well past that -- a press at any
# point in this window is caught by the next poll.
_LINK_TIMEOUT_SECONDS = 120
_LINK_POLL_SECONDS = 1.0


class PairingDialog(Adw.Dialog):
    """Walks the user from "no bridge" to "paired"."""

    def __init__(self, app: BrightBulbApplication, on_paired: Callable[[], None]) -> None:
        super().__init__(title="Connect a Bridge", content_width=460, content_height=420)

        self._app = app
        self._on_paired = on_paired
        self._link_deadline: float = 0.0
        self._link_timeout_id: int = 0
        self._linking = False
        self._selected: discovery.DiscoveredBridge | None = None

        self._stack = Gtk.Stack(transition_type=Gtk.StackTransitionType.CROSSFADE)
        self._stack.add_named(self._build_searching(), "searching")
        self._stack.add_named(self._build_chooser(), "choose")
        self._stack.add_named(self._build_link(), "link")

        header = Adw.HeaderBar(show_end_title_buttons=True)
        toolbar = Adw.ToolbarView()
        toolbar.add_top_bar(header)
        toolbar.set_content(self._stack)
        self.set_child(toolbar)

        self.connect("closed", lambda *_: self._cancel_link_polling())
        self._start_discovery()

    # -- stage 1: searching ------------------------------------------------

    def _build_searching(self) -> Gtk.Widget:
        spinner = Adw.Spinner(width_request=48, height_request=48)
        status = Adw.StatusPage(
            title="Looking for bridges",
            description="Searching your network for a Philips Hue bridge.",
            child=spinner,
        )
        return status

    def _start_discovery(self) -> None:
        self._stack.set_visible_child_name("searching")
        self._app.runner.run_and_then(
            discovery.discover(timeout=5.0, allow_cloud=True),
            on_done=self._show_results,
            on_error=self._show_discovery_error,
        )

    def _show_results(self, bridges: list[discovery.DiscoveredBridge]) -> None:
        for row in list(self._bridge_rows):
            self._bridge_list.remove(row)
        self._bridge_rows.clear()

        usable = [b for b in bridges if b.supports_v2]
        legacy = [b for b in bridges if not b.supports_v2]

        for bridge in usable:
            row = Adw.ActionRow(
                title=bridge.display_name,
                subtitle=f"{bridge.host} · found via {bridge.source}",
                activatable=True,
            )
            row.add_prefix(Gtk.Image(icon_name="network-wireless-symbolic"))
            row.add_suffix(Gtk.Image(icon_name="go-next-symbolic"))
            row.connect("activated", lambda _row, b=bridge: self._begin_link(b))
            self._bridge_list.append(row)
            self._bridge_rows.append(row)

        for bridge in legacy:
            # A v1 bridge cannot serve CLIP v2 or entertainment streaming, so
            # showing it as selectable would only lead to a confusing failure.
            row = Adw.ActionRow(
                title=bridge.display_name,
                subtitle=f"{bridge.host} · not supported (requires a v2 square bridge)",
                sensitive=False,
            )
            self._bridge_list.append(row)
            self._bridge_rows.append(row)

        self._chooser_status.set_visible(not usable)
        self._stack.set_visible_child_name("choose")

    def _show_discovery_error(self, error: BaseException) -> None:
        _LOGGER.warning("discovery failed", exc_info=error)
        self._show_results([])

    # -- stage 2: choosing -------------------------------------------------

    def _build_chooser(self) -> Gtk.Widget:
        self._bridge_list = Gtk.ListBox(selection_mode=Gtk.SelectionMode.NONE)
        self._bridge_list.add_css_class("boxed-list")
        self._bridge_rows: list[Gtk.Widget] = []

        self._chooser_status = Adw.StatusPage(
            title="No bridges found",
            description="Make sure the bridge is powered on and on this network.",
            icon_name="network-offline-symbolic",
            vexpand=True,
        )
        self._chooser_status.add_css_class("compact")

        self._manual_entry = Adw.EntryRow(title="Bridge IP address")
        self._manual_entry.connect("entry-activated", lambda *_: self._try_manual())
        manual_button = Gtk.Button(label="Connect", valign=Gtk.Align.CENTER)
        manual_button.add_css_class("flat")
        manual_button.connect("clicked", lambda *_: self._try_manual())
        self._manual_entry.add_suffix(manual_button)

        manual_group = Adw.PreferencesGroup(
            title="Enter an address",
            description="Use this if your network blocks discovery.",
        )
        manual_group.add(self._manual_entry)

        rescan = Gtk.Button(label="Search Again", halign=Gtk.Align.CENTER)
        rescan.connect("clicked", lambda *_: self._start_discovery())

        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=18,
                      margin_top=12, margin_bottom=18, margin_start=18, margin_end=18)
        box.append(self._chooser_status)
        box.append(self._bridge_list)
        box.append(manual_group)
        box.append(rescan)

        return Gtk.ScrolledWindow(child=box, hscrollbar_policy=Gtk.PolicyType.NEVER)

    def _try_manual(self) -> None:
        host = self._manual_entry.get_text().strip()
        if not host:
            return
        self._stack.set_visible_child_name("searching")
        self._app.runner.run_and_then(
            discovery.discover_manual(host),
            on_done=lambda bridge: self._show_results([bridge]),
            on_error=lambda err: self._manual_failed(host, err),
        )

    def _manual_failed(self, host: str, error: BaseException) -> None:
        _LOGGER.info("manual connect to %s failed: %s", host, error)
        self._stack.set_visible_child_name("choose")
        self._manual_entry.add_css_class("error")
        self._chooser_status.set_title(f"No bridge at {host}")
        self._chooser_status.set_visible(True)

    # -- stage 3: link button ---------------------------------------------

    def _build_link(self) -> Gtk.Widget:
        self._link_status = Adw.StatusPage(
            title="Press the link button",
            description="Press the round button on top of your Hue bridge.",
            icon_name="dialog-password-symbolic",
        )
        self._link_progress = Gtk.ProgressBar(show_text=False, margin_top=12)
        self._link_status.set_child(self._link_progress)
        return self._link_status

    def _begin_link(self, bridge: discovery.DiscoveredBridge) -> None:
        self._selected = bridge
        self._link_status.set_title("Press the link button")
        self._link_status.set_description(
            f"Press the round button on top of {bridge.display_name}."
        )
        self._stack.set_visible_child_name("link")

        self._linking = True
        self._link_deadline = GLib.get_monotonic_time() / 1e6 + _LINK_TIMEOUT_SECONDS
        self._link_timeout_id = GLib.timeout_add(
            int(_LINK_POLL_SECONDS * 1000), self._on_link_tick
        )
        self._attempt_pairing()

    def _on_link_tick(self) -> bool:
        remaining = self._link_deadline - GLib.get_monotonic_time() / 1e6
        if remaining <= 0:
            self._link_timeout_id = 0
            self._link_failed("Timed out waiting for the link button.")
            return GLib.SOURCE_REMOVE
        self._link_progress.set_fraction(1.0 - remaining / _LINK_TIMEOUT_SECONDS)
        self._attempt_pairing()
        return GLib.SOURCE_CONTINUE

    def _attempt_pairing(self) -> None:
        bridge = self._selected
        if bridge is None or not self._linking:
            return
        self._app.runner.run_and_then(
            pairing.create_credentials(bridge.host),
            on_done=self._pairing_succeeded,
            on_error=self._pairing_attempt_failed,
        )

    def _pairing_attempt_failed(self, error: BaseException) -> None:
        # Until the button is pressed the bridge answers 101, which is the
        # expected state for most of this stage rather than a failure.
        if isinstance(error, LinkButtonNotPressed) or not self._linking:
            return
        self._cancel_link_polling()
        self._link_failed(str(error))

    def _pairing_succeeded(self, credentials: pairing.BridgeCredentials) -> None:
        bridge = self._selected
        if bridge is None or not self._linking:
            return  # a concurrent attempt already won the race
        self._cancel_link_polling()

        self._app.bridge.store_credentials(
            bridge.bridge_id, bridge.host, credentials.app_key, credentials.client_key
        )
        self._on_paired()
        self.close()

    def _link_failed(self, message: str) -> None:
        self._link_status.set_title("Could not pair")
        self._link_status.set_description(message)
        retry = Gtk.Button(label="Try Again", halign=Gtk.Align.CENTER)
        retry.add_css_class("pill")
        retry.add_css_class("suggested-action")
        retry.connect("clicked", lambda *_: self._start_discovery())
        self._link_status.set_child(retry)

    def _cancel_link_polling(self) -> None:
        self._linking = False
        if self._link_timeout_id:
            GLib.source_remove(self._link_timeout_id)
            self._link_timeout_id = 0
