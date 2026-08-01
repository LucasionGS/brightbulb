"""System tray icon, spoken as StatusNotifierItem over D-Bus.

GTK4 removed ``GtkStatusIcon`` and ships no replacement, and the usual stand-in
-- libayatana-appindicator -- **cannot be used here**: it links against GTK3,
and loading GTK3 and GTK4 into one process is fatal (``Gtk-ERROR: GTK 2/3
symbols detected``). So this talks the tray protocol directly, which is pure
D-Bus and drags in no toolkit at all.

Two interfaces are involved:

* ``org.kde.StatusNotifierItem`` -- the icon itself, exported at
  ``/StatusNotifierItem`` and announced to ``org.kde.StatusNotifierWatcher``.
* ``com.canonical.dbusmenu`` -- the right-click menu, exported at ``/MenuBar``.
  It is a remote model rather than a picture: the host asks for a layout of
  numbered items and reports clicks back by number.

The watcher is watched rather than merely called, because tray hosts get
restarted (a Waybar or Quickshell reload is routine) and an item that only
registers once disappears for the rest of the session.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Callable
from dataclasses import dataclass

from gi.repository import Gio, GLib

_LOGGER = logging.getLogger(__name__)

WATCHER_BUS = "org.kde.StatusNotifierWatcher"
WATCHER_PATH = "/StatusNotifierWatcher"
WATCHER_IFACE = "org.kde.StatusNotifierWatcher"

ITEM_IFACE = "org.kde.StatusNotifierItem"
ITEM_PATH = "/StatusNotifierItem"
MENU_IFACE = "com.canonical.dbusmenu"
MENU_PATH = "/MenuBar"

_ITEM_XML = f"""
<node>
  <interface name="{ITEM_IFACE}">
    <property name="Category" type="s" access="read"/>
    <property name="Id" type="s" access="read"/>
    <property name="Title" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="WindowId" type="i" access="read"/>
    <property name="IconName" type="s" access="read"/>
    <property name="IconPixmap" type="a(iiay)" access="read"/>
    <property name="OverlayIconName" type="s" access="read"/>
    <property name="AttentionIconName" type="s" access="read"/>
    <property name="ToolTip" type="(sa(iiay)ss)" access="read"/>
    <property name="ItemIsMenu" type="b" access="read"/>
    <property name="Menu" type="o" access="read"/>
    <method name="Activate">
      <arg name="x" type="i" direction="in"/>
      <arg name="y" type="i" direction="in"/>
    </method>
    <method name="SecondaryActivate">
      <arg name="x" type="i" direction="in"/>
      <arg name="y" type="i" direction="in"/>
    </method>
    <method name="ContextMenu">
      <arg name="x" type="i" direction="in"/>
      <arg name="y" type="i" direction="in"/>
    </method>
    <method name="Scroll">
      <arg name="delta" type="i" direction="in"/>
      <arg name="orientation" type="s" direction="in"/>
    </method>
    <signal name="NewIcon"/>
    <signal name="NewTitle"/>
    <signal name="NewToolTip"/>
    <signal name="NewStatus"><arg name="status" type="s"/></signal>
  </interface>
</node>
"""

_MENU_XML = f"""
<node>
  <interface name="{MENU_IFACE}">
    <property name="Version" type="u" access="read"/>
    <property name="TextDirection" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="IconThemePath" type="as" access="read"/>
    <method name="GetLayout">
      <arg name="parentId" type="i" direction="in"/>
      <arg name="recursionDepth" type="i" direction="in"/>
      <arg name="propertyNames" type="as" direction="in"/>
      <arg name="revision" type="u" direction="out"/>
      <arg name="layout" type="(ia{{sv}}av)" direction="out"/>
    </method>
    <method name="GetGroupProperties">
      <arg name="ids" type="ai" direction="in"/>
      <arg name="propertyNames" type="as" direction="in"/>
      <arg name="properties" type="a(ia{{sv}})" direction="out"/>
    </method>
    <method name="GetProperty">
      <arg name="id" type="i" direction="in"/>
      <arg name="name" type="s" direction="in"/>
      <arg name="value" type="v" direction="out"/>
    </method>
    <method name="Event">
      <arg name="id" type="i" direction="in"/>
      <arg name="eventId" type="s" direction="in"/>
      <arg name="data" type="v" direction="in"/>
      <arg name="timestamp" type="u" direction="in"/>
    </method>
    <method name="EventGroup">
      <arg name="events" type="a(isvu)" direction="in"/>
      <arg name="idErrors" type="ai" direction="out"/>
    </method>
    <method name="AboutToShow">
      <arg name="id" type="i" direction="in"/>
      <arg name="needUpdate" type="b" direction="out"/>
    </method>
    <method name="AboutToShowGroup">
      <arg name="ids" type="ai" direction="in"/>
      <arg name="updatesNeeded" type="ai" direction="out"/>
      <arg name="idErrors" type="ai" direction="out"/>
    </method>
    <signal name="ItemsPropertiesUpdated">
      <arg name="updatedProps" type="a(ia{{sv}})"/>
      <arg name="removedProps" type="a(ias)"/>
    </signal>
    <signal name="LayoutUpdated">
      <arg name="revision" type="u"/>
      <arg name="parent" type="i"/>
    </signal>
    <signal name="ItemActivationRequested">
      <arg name="id" type="i"/>
      <arg name="timestamp" type="u"/>
    </signal>
  </interface>
</node>
"""


@dataclass
class MenuItem:
    """One entry in the tray menu.

    ``checked`` set to anything but None makes it a checkmark item; the tray
    host draws the tick, so the state has to be pushed rather than toggled
    locally.
    """

    label: str
    on_click: Callable[[], None] | None = None
    enabled: bool = True
    checked: bool | None = None
    separator: bool = False

    def properties(self) -> dict[str, GLib.Variant]:
        if self.separator:
            return {"type": GLib.Variant("s", "separator")}
        props = {
            "label": GLib.Variant("s", self.label),
            "enabled": GLib.Variant("b", self.enabled),
            "visible": GLib.Variant("b", True),
        }
        if self.checked is not None:
            props["toggle-type"] = GLib.Variant("s", "checkmark")
            props["toggle-state"] = GLib.Variant("i", 1 if self.checked else 0)
        return props


def separator() -> MenuItem:
    return MenuItem(label="", separator=True)


def _identity(item: MenuItem) -> tuple[str, bool, bool | None, bool]:
    """Everything a host would see. Callbacks are ours and cannot change."""
    return (item.label, item.enabled, item.checked, item.separator)


class TrayIcon:
    """A StatusNotifierItem whose menu is rebuilt from a callback on demand."""

    def __init__(
        self,
        icon_name: str,
        title: str,
        build_menu: Callable[[], list[MenuItem]],
        on_activate: Callable[[], None],
        item_id: str = "brightbulb",
    ) -> None:
        self._icon_name = icon_name
        self._title = title
        self._tooltip = title
        self._build_menu = build_menu
        self._on_activate = on_activate
        self._item_id = item_id

        self._items: list[MenuItem] = []
        self._revision = 1
        self._connection: Gio.DBusConnection | None = None
        self._registrations: list[int] = []
        self._owner_id = 0
        self._watch_id = 0
        self._host_present = False
        # Unique per process, so several instances never collide on the bus.
        self._bus_name = f"org.kde.StatusNotifierItem-{os.getpid()}-1"

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> bool:
        """Claim a bus name and export the item. False if there is no bus."""
        try:
            self._connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        except GLib.Error:
            _LOGGER.info("no session bus; tray icon unavailable", exc_info=True)
            return False

        self._refresh_items()
        self._host_present = self._watcher_running()
        self._owner_id = Gio.bus_own_name(
            Gio.BusType.SESSION, self._bus_name,
            Gio.BusNameOwnerFlags.NONE,
            self._on_bus_acquired, None, self._on_name_lost,
        )
        # Tray hosts come and go -- reloading Waybar or Quickshell is routine --
        # so re-register whenever the watcher comes back, or the icon vanishes
        # for the rest of the session.
        self._watch_id = Gio.bus_watch_name(
            Gio.BusType.SESSION, WATCHER_BUS, Gio.BusNameWatcherFlags.NONE,
            self._on_watcher_appeared, self._on_watcher_vanished,
        )
        return True

    @property
    def available(self) -> bool:
        """Whether a tray host is currently around to show the icon.

        Hiding the window into a tray that is not there would leave the user no
        way back, so this is checked before doing so rather than assumed.
        """
        return self._host_present

    def _watcher_running(self) -> bool:
        connection = self._connection
        if connection is None:
            return False
        try:
            reply = connection.call_sync(
                "org.freedesktop.DBus", "/org/freedesktop/DBus",
                "org.freedesktop.DBus", "NameHasOwner",
                GLib.Variant("(s)", (WATCHER_BUS,)), GLib.VariantType("(b)"),
                Gio.DBusCallFlags.NONE, 1000, None,
            )
            return bool(reply.unpack()[0])
        except GLib.Error:
            return False

    def _on_watcher_appeared(
        self, _connection: Gio.DBusConnection, _name: str, _owner: str
    ) -> None:
        self._host_present = True
        self._register_with_watcher()

    def _on_watcher_vanished(
        self, _connection: Gio.DBusConnection, _name: str
    ) -> None:
        self._host_present = False

    def stop(self) -> None:
        if self._watch_id:
            Gio.bus_unwatch_name(self._watch_id)
            self._watch_id = 0
        connection = self._connection
        if connection is not None:
            for registration in self._registrations:
                connection.unregister_object(registration)
        self._registrations.clear()
        if self._owner_id:
            Gio.bus_unown_name(self._owner_id)
            self._owner_id = 0

    def _on_bus_acquired(self, connection: Gio.DBusConnection, _name: str) -> None:
        self._connection = connection
        try:
            self._export(connection, ITEM_PATH, _ITEM_XML, self._item_call,
                         self._item_property)
            self._export(connection, MENU_PATH, _MENU_XML, self._menu_call,
                         self._menu_property)
        except GLib.Error:
            _LOGGER.exception("could not export the tray item")
            return
        self._register_with_watcher()

    def _export(
        self,
        connection: Gio.DBusConnection,
        path: str,
        xml: str,
        on_call: Callable[..., None],
        on_get: Callable[..., GLib.Variant | None],
    ) -> None:
        info = Gio.DBusNodeInfo.new_for_xml(xml).interfaces[0]
        self._registrations.append(
            connection.register_object(path, info, on_call, on_get, None)
        )

    def _on_name_lost(self, _connection: Gio.DBusConnection, _name: str) -> None:
        _LOGGER.debug("lost tray bus name %s", self._bus_name)

    def _register_with_watcher(self) -> None:
        connection = self._connection
        if connection is None or not self._registrations:
            return

        def done(_source: object, result: Gio.AsyncResult) -> None:
            try:
                connection.call_finish(result)
                _LOGGER.debug("registered tray item as %s", self._bus_name)
            except GLib.Error as err:
                # A desktop with no tray is a normal configuration, not a fault.
                _LOGGER.info("no tray host accepted the icon: %s", err.message)

        connection.call(
            WATCHER_BUS, WATCHER_PATH, WATCHER_IFACE, "RegisterStatusNotifierItem",
            GLib.Variant("(s)", (self._bus_name,)), None,
            Gio.DBusCallFlags.NONE, 3000, None, done,
        )

    # -- state -------------------------------------------------------------

    def set_tooltip(self, text: str) -> None:
        if text == self._tooltip:
            return
        self._tooltip = text
        self._emit(ITEM_PATH, ITEM_IFACE, "NewToolTip", None)

    def set_icon(self, icon_name: str) -> None:
        if icon_name == self._icon_name:
            return
        self._icon_name = icon_name
        self._emit(ITEM_PATH, ITEM_IFACE, "NewIcon", None)

    def refresh_menu(self) -> None:
        """Rebuild the menu, telling the host only if anything actually changed.

        Callers refresh on every status tick, and announcing a new layout each
        second would have the host re-fetching a menu that nobody is looking at.
        """
        before = [_identity(item) for item in self._items]
        self._refresh_items()
        if [_identity(item) for item in self._items] == before:
            return
        self._revision += 1
        self._emit(
            MENU_PATH, MENU_IFACE, "LayoutUpdated",
            GLib.Variant("(ui)", (self._revision, 0)),
        )

    def _refresh_items(self) -> None:
        self._items = self._build_menu()

    def _emit(
        self, path: str, iface: str, signal: str, payload: GLib.Variant | None
    ) -> None:
        connection = self._connection
        if connection is None or not self._registrations:
            return
        try:
            connection.emit_signal(None, path, iface, signal, payload)
        except GLib.Error:
            _LOGGER.debug("could not emit %s", signal, exc_info=True)

    # -- StatusNotifierItem ------------------------------------------------

    def _item_property(
        self, _conn: object, _sender: str, _path: str, _iface: str, name: str
    ) -> GLib.Variant | None:
        if name == "Category":
            return GLib.Variant("s", "ApplicationStatus")
        if name == "Id":
            return GLib.Variant("s", self._item_id)
        if name == "Title":
            return GLib.Variant("s", self._title)
        if name == "Status":
            return GLib.Variant("s", "Active")
        if name == "WindowId":
            return GLib.Variant("i", 0)
        if name in ("IconName", "AttentionIconName"):
            return GLib.Variant("s", self._icon_name if name == "IconName" else "")
        if name == "OverlayIconName":
            return GLib.Variant("s", "")
        if name == "IconPixmap":
            return GLib.Variant("a(iiay)", [])
        if name == "ToolTip":
            return GLib.Variant(
                "(sa(iiay)ss)", (self._icon_name, [], self._title, self._tooltip)
            )
        if name == "ItemIsMenu":
            # False: a left click should reach Activate rather than only ever
            # opening the menu.
            return GLib.Variant("b", False)
        if name == "Menu":
            return GLib.Variant("o", MENU_PATH)
        return None

    def _item_call(
        self,
        _conn: object,
        _sender: str,
        _path: str,
        _iface: str,
        method: str,
        _params: GLib.Variant,
        invocation: Gio.DBusMethodInvocation,
    ) -> None:
        if method == "Activate":
            self._on_activate()
        invocation.return_value(None)

    # -- dbusmenu ----------------------------------------------------------

    def _menu_property(
        self, _conn: object, _sender: str, _path: str, _iface: str, name: str
    ) -> GLib.Variant | None:
        if name == "Version":
            return GLib.Variant("u", 3)
        if name == "TextDirection":
            return GLib.Variant("s", "ltr")
        if name == "Status":
            return GLib.Variant("s", "normal")
        if name == "IconThemePath":
            return GLib.Variant("as", [])
        return None

    def _menu_call(
        self,
        _conn: object,
        _sender: str,
        _path: str,
        _iface: str,
        method: str,
        params: GLib.Variant,
        invocation: Gio.DBusMethodInvocation,
    ) -> None:
        if method == "GetLayout":
            invocation.return_value(
                GLib.Variant.new_tuple(
                    GLib.Variant("u", self._revision), self._layout()
                )
            )
            return

        if method == "GetGroupProperties":
            wanted = set(params.unpack()[0])
            entries = [
                (index, item.properties())
                for index, item in self._numbered()
                if not wanted or index in wanted
            ]
            invocation.return_value(GLib.Variant("(a(ia{sv}))", (entries,)))
            return

        if method == "GetProperty":
            item_id, name = params.unpack()[0], params.unpack()[1]
            value = dict(self._numbered()).get(item_id)
            prop = value.properties().get(name) if value else None
            invocation.return_value(
                GLib.Variant.new_tuple(prop or GLib.Variant("s", ""))
            )
            return

        if method == "Event":
            item_id, event_id = params.unpack()[0], params.unpack()[1]
            if event_id == "clicked":
                self._click(int(item_id))
            invocation.return_value(None)
            return

        if method == "EventGroup":
            for item_id, event_id, _data, _timestamp in params.unpack()[0]:
                if event_id == "clicked":
                    self._click(int(item_id))
            invocation.return_value(GLib.Variant("(ai)", ([],)))
            return

        if method == "AboutToShow":
            # The menu is cheap to rebuild and its enabled/checked states track
            # live streaming, so refresh right before it is shown.
            self._refresh_items()
            invocation.return_value(GLib.Variant("(b)", (True,)))
            return

        if method == "AboutToShowGroup":
            self._refresh_items()
            invocation.return_value(GLib.Variant("(aiai)", ([], [])))
            return

        invocation.return_value(None)

    def _numbered(self) -> list[tuple[int, MenuItem]]:
        """Menu items paired with their dbusmenu ids. Root is 0, so start at 1."""
        return list(enumerate(self._items, start=1))

    def _layout(self) -> GLib.Variant:
        children = [
            _menu_variant(index, item.properties(), [])
            for index, item in self._numbered()
        ]
        return _menu_variant(
            0, {"children-display": GLib.Variant("s", "submenu")}, children
        )

    def _click(self, item_id: int) -> None:
        for index, item in self._numbered():
            if index == item_id and item.on_click is not None:
                item.on_click()
                return


def _menu_variant(
    item_id: int,
    properties: dict[str, GLib.Variant],
    children: list[GLib.Variant],
) -> GLib.Variant:
    """Build a dbusmenu ``(ia{sv}av)`` node.

    Assembled with the explicit constructors rather than a format string:
    passing an already-built Variant into ``GLib.Variant("...av...")`` makes
    PyGObject re-walk it as raw Python values and fail on the nested struct.
    """
    return GLib.Variant.new_tuple(
        GLib.Variant("i", item_id),
        GLib.Variant("a{sv}", properties),
        GLib.Variant.new_array(
            GLib.VariantType("v"), [GLib.Variant("v", child) for child in children]
        ),
    )
