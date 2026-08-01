"""Screen capture negotiation via ``org.freedesktop.portal.ScreenCast``.

On Wayland an application cannot simply grab the screen; it asks the portal,
the compositor prompts the user, and the result is a PipeWire node reached
through a file descriptor. The exchange is four D-Bus calls, each answered
asynchronously by a ``Response`` signal on a per-request object path:

    CreateSession -> SelectSources -> Start -> OpenPipeWireRemote

Two details matter more than the rest:

* The request object path is **derived, not returned**, so the signal must be
  subscribed to *before* issuing the call or the reply can arrive first and be
  missed entirely.
* ``persist_mode=2`` plus a stored ``restore_token`` is what stops the
  compositor prompting on every single launch. Tokens are **single-use**: each
  ``Start`` returns a fresh one that must replace the old.

Everything here runs on the GTK main thread, because that is where the GLib
loop delivering these signals lives.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from gi.repository import Gio, GLib

_LOGGER = logging.getLogger(__name__)

PORTAL_BUS = "org.freedesktop.portal.Desktop"
PORTAL_PATH = "/org/freedesktop/portal/desktop"
SCREENCAST_IFACE = "org.freedesktop.portal.ScreenCast"
REQUEST_IFACE = "org.freedesktop.portal.Request"

# SourceType flags
SOURCE_MONITOR = 1
SOURCE_WINDOW = 2

# CursorMode flags
CURSOR_HIDDEN = 1

# PersistMode: 2 = persist until the user revokes it.
PERSIST_UNTIL_REVOKED = 2

# Portal version that introduced persist_mode / restore_token.
_MIN_PERSIST_VERSION = 4
# Portal version from which streams carry a reusable pipewire-serial.
_MIN_SERIAL_VERSION = 6


@dataclass(frozen=True)
class CaptureSource:
    """A negotiated PipeWire stream, ready to hand to GStreamer."""

    fd: int
    node_id: int
    # Monotonic PipeWire object serial. Preferred over node_id, which PipeWire
    # reuses after a node is destroyed and can therefore point at the wrong
    # thing. None on portals older than version 6.
    serial: int | None
    width: int
    height: int
    # Fresh single-use token; persist it to avoid prompting next launch.
    restore_token: str | None

    @property
    def target(self) -> str | None:
        """Value for pipewiresrc's ``target-object``."""
        return str(self.serial) if self.serial is not None else None


class PortalError(Exception):
    """The portal refused, failed, or the user cancelled."""


class ScreenCastPortal:
    """Drives one ScreenCast negotiation."""

    def __init__(self) -> None:
        self._bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        # Unique bus name, ':1.42' -> '1_42', which is how the portal builds the
        # request path it will emit on.
        self._sender = self._bus.get_unique_name()[1:].replace(".", "_")
        self._counter = 0
        self._session: str | None = None
        self._subscriptions: list[int] = []
        # One negotiation reports exactly once. When a session ends, the portal
        # can emit Response on several of the request paths we subscribed to,
        # so without this a single failure is reported repeatedly.
        self._finished = False

    # -- public API --------------------------------------------------------

    def start(
        self,
        on_ready: Callable[[CaptureSource], None],
        on_error: Callable[[Exception], None],
        restore_token: str | None = None,
        parent_window: str = "",
    ) -> None:
        """Negotiate a monitor capture, calling back on the GTK thread."""
        self._on_ready = on_ready
        self._on_error = on_error
        self._restore_token = restore_token
        self._parent_window = parent_window
        self._finished = False

        try:
            self._create_session()
        except Exception as err:
            self._fail(err)

    def close(self) -> None:
        """Drop the session and stop listening. Ends the capture."""
        for subscription in self._subscriptions:
            self._bus.signal_unsubscribe(subscription)
        self._subscriptions.clear()

        session, self._session = self._session, None
        if session is None:
            return
        try:
            self._bus.call_sync(
                PORTAL_BUS, session, "org.freedesktop.portal.Session", "Close",
                None, None, Gio.DBusCallFlags.NONE, 1000, None,
            )
        except GLib.Error:
            # The portal closes sessions on its own when the peer disappears;
            # a failure here is not worth surfacing during teardown.
            _LOGGER.debug("closing portal session failed", exc_info=True)

    @property
    def version(self) -> int:
        try:
            result = self._bus.call_sync(
                PORTAL_BUS, PORTAL_PATH, "org.freedesktop.DBus.Properties", "Get",
                GLib.Variant("(ss)", (SCREENCAST_IFACE, "version")),
                None, Gio.DBusCallFlags.NONE, 1000, None,
            )
            return int(result.unpack()[0])
        except (GLib.Error, ValueError, IndexError):
            return 0

    # -- step 1: CreateSession --------------------------------------------

    def _create_session(self) -> None:
        options = {
            "handle_token": self._token("create"),
            "session_handle_token": self._token("session"),
        }
        self._call("CreateSession", GLib.Variant("(a{sv})", (self._pack(options),)),
                   self._on_session_created)

    def _on_session_created(self, results: dict[str, Any]) -> None:
        self._session = results.get("session_handle")
        if not self._session:
            raise PortalError("portal returned no session handle")
        self._select_sources()

    # -- step 2: SelectSources --------------------------------------------

    def _select_sources(self) -> None:
        assert self._session is not None
        options: dict[str, Any] = {
            "handle_token": self._token("select"),
            "types": GLib.Variant("u", SOURCE_MONITOR),
            "multiple": GLib.Variant("b", False),
            # The pointer would inject a bright moving blob into the colour
            # average for no benefit.
            "cursor_mode": GLib.Variant("u", CURSOR_HIDDEN),
        }
        if self.version >= _MIN_PERSIST_VERSION:
            options["persist_mode"] = GLib.Variant("u", PERSIST_UNTIL_REVOKED)
            if self._restore_token:
                options["restore_token"] = GLib.Variant("s", self._restore_token)

        self._call(
            "SelectSources",
            GLib.Variant("(oa{sv})", (self._session, self._pack(options))),
            lambda _results: self._start_session(),
        )

    # -- step 3: Start -----------------------------------------------------

    def _start_session(self) -> None:
        assert self._session is not None
        options = {"handle_token": self._token("start")}
        self._call(
            "Start",
            GLib.Variant("(osa{sv})", (self._session, self._parent_window,
                                       self._pack(options))),
            self._on_started,
        )

    def _on_started(self, results: dict[str, Any]) -> None:
        streams = results.get("streams") or []
        if not streams:
            raise PortalError("no streams were shared")

        node_id, properties = streams[0]
        width, height = properties.get("size", (0, 0))
        serial = properties.get("pipewire-serial")

        self._stream = CaptureSource(
            fd=-1,
            node_id=int(node_id),
            serial=int(serial) if serial is not None else None,
            width=int(width),
            height=int(height),
            # A fresh token only comes back when the user allowed persistence.
            restore_token=results.get("restore_token"),
        )
        _LOGGER.debug("portal shared stream %s", self._stream)
        self._open_remote()

    # -- step 4: OpenPipeWireRemote ---------------------------------------

    def _open_remote(self) -> None:
        assert self._session is not None
        try:
            reply, fd_list = self._bus.call_with_unix_fd_list_sync(
                PORTAL_BUS, PORTAL_PATH, SCREENCAST_IFACE, "OpenPipeWireRemote",
                GLib.Variant("(oa{sv})", (self._session, self._pack({}))),
                GLib.VariantType("(h)"), Gio.DBusCallFlags.NONE, -1, None, None,
            )
            handle = reply.unpack()[0]
            fd = fd_list.get(handle)
        except GLib.Error as err:
            self._fail(PortalError(f"OpenPipeWireRemote failed: {err.message}"))
            return

        self._finished = True
        source = CaptureSource(
            fd=fd,
            node_id=self._stream.node_id,
            serial=self._stream.serial,
            width=self._stream.width,
            height=self._stream.height,
            restore_token=self._stream.restore_token,
        )
        self._on_ready(source)

    # -- plumbing ----------------------------------------------------------

    def _token(self, prefix: str) -> str:
        self._counter += 1
        return f"brightbulb_{prefix}_{self._counter}"

    @staticmethod
    def _pack(options: dict[str, Any]) -> dict[str, GLib.Variant]:
        return {
            key: value if isinstance(value, GLib.Variant) else GLib.Variant("s", value)
            for key, value in options.items()
        }

    def _call(
        self,
        method: str,
        parameters: GLib.Variant,
        on_response: Callable[[dict[str, Any]], None],
    ) -> None:
        """Issue a portal call and route its Response signal to ``on_response``.

        The request path is derived from our bus name and handle_token. It must
        be subscribed to before the call is made: the portal is free to answer
        before the method reply comes back, and a late subscription silently
        misses it.
        """
        token = parameters.unpack()[-1]["handle_token"]
        request_path = f"{PORTAL_PATH}/request/{self._sender}/{token}"

        def on_signal(
            _connection: Any, _sender: Any, _path: Any, _iface: Any,
            _signal: Any, payload: GLib.Variant,
        ) -> None:
            if self._finished:
                return
            response, results = payload.unpack()
            if response == 1:
                self._fail(PortalError("cancelled"))
                return
            if response != 0:
                self._fail(PortalError(f"portal returned status {response}"))
                return
            try:
                on_response(results)
            except Exception as err:
                self._fail(err)

        self._subscriptions.append(
            self._bus.signal_subscribe(
                PORTAL_BUS, REQUEST_IFACE, "Response", request_path, None,
                Gio.DBusSignalFlags.NO_MATCH_RULE, on_signal,
            )
        )

        def on_reply(bus: Gio.DBusConnection, task: Gio.AsyncResult) -> None:
            try:
                bus.call_finish(task)
            except GLib.Error as err:
                if not self._finished:
                    self._fail(PortalError(f"{method} failed: {err.message}"))

        self._bus.call(
            PORTAL_BUS, PORTAL_PATH, SCREENCAST_IFACE, method, parameters,
            None, Gio.DBusCallFlags.NONE, -1, None, on_reply,
        )

    def _fail(self, error: Exception) -> None:
        if self._finished:
            return
        self._finished = True
        _LOGGER.debug("portal negotiation failed", exc_info=error)
        self.close()
        self._on_error(error)
