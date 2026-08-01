"""Bridge connection lifecycle.

Wraps :class:`aiohue.v2.HueBridgeV2` with the things the UI needs and aiohue
does not provide: credential lookup, a connection state machine, automatic
reconnection with backoff, and delivery of resource changes onto the GTK thread.

Everything here runs on the asyncio thread. The only outward-facing calls are
the state/change callbacks, which are marshalled via
:func:`brightbulb.asyncio_bridge.call_on_ui`, so subscribers may touch widgets.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Callable
from enum import Enum
from typing import Any

from aiohue.errors import Unauthorized
from aiohue.v2 import HueBridgeV2

from brightbulb.asyncio_bridge import call_on_ui
from brightbulb.config import SecretStore, Settings

_LOGGER = logging.getLogger(__name__)

# Reconnect backoff. Capped low enough that a bridge rebooting after a firmware
# update is picked up promptly rather than after minutes of waiting.
_BACKOFF_START = 1.0
_BACKOFF_MAX = 30.0


class ConnectionState(Enum):
    DISCONNECTED = "disconnected"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    UNAUTHORIZED = "unauthorized"
    ERROR = "error"


StateCallback = Callable[[ConnectionState, str | None], None]
ChangeCallback = Callable[[], None]


class BridgeConnection:
    """Owns the connection to one bridge and keeps it alive."""

    def __init__(self, settings: Settings, secrets: SecretStore) -> None:
        self._settings = settings
        self._secrets = secrets
        self._bridge: HueBridgeV2 | None = None
        self._task: asyncio.Task[None] | None = None
        self._unsubscribe: Callable[[], None] | None = None
        self._state = ConnectionState.DISCONNECTED
        self._state_callbacks: list[StateCallback] = []
        self._change_callbacks: list[ChangeCallback] = []
        self._changes_pending = False

    # -- observation -------------------------------------------------------

    @property
    def state(self) -> ConnectionState:
        return self._state

    @property
    def bridge(self) -> HueBridgeV2 | None:
        """The live bridge, or None when not connected."""
        return self._bridge if self._state is ConnectionState.CONNECTED else None

    def on_state_change(self, callback: StateCallback) -> Callable[[], None]:
        self._state_callbacks.append(callback)
        return lambda: self._state_callbacks.remove(callback)

    def on_resources_changed(self, callback: ChangeCallback) -> Callable[[], None]:
        self._change_callbacks.append(callback)
        return lambda: self._change_callbacks.remove(callback)

    def _set_state(self, state: ConnectionState, detail: str | None = None) -> None:
        if state is self._state and detail is None:
            return
        self._state = state
        _LOGGER.info("bridge state: %s%s", state.value, f" ({detail})" if detail else "")
        for callback in list(self._state_callbacks):
            call_on_ui(callback, state, detail)

    # -- credentials -------------------------------------------------------

    def has_credentials(self, bridge_id: str | None = None) -> bool:
        bridge_id = bridge_id or self._settings.bridge_id
        if not bridge_id:
            return False
        return self._secrets.lookup(bridge_id, "app_key") is not None

    def store_credentials(
        self, bridge_id: str, host: str, app_key: str, client_key: str
    ) -> None:
        self._secrets.store(bridge_id, "app_key", app_key)
        self._secrets.store(bridge_id, "client_key", client_key)
        self._settings.bridge_id = bridge_id
        self._settings.bridge_host = host
        self._settings.save()

    def forget(self) -> None:
        if self._settings.bridge_id:
            self._secrets.clear(self._settings.bridge_id)
        self._settings.bridge_id = None
        self._settings.bridge_host = None
        self._settings.save()

    @property
    def client_key(self) -> str | None:
        """Hex PSK for entertainment streaming, if this bridge is paired."""
        if not self._settings.bridge_id:
            return None
        return self._secrets.lookup(self._settings.bridge_id, "client_key")

    # -- lifecycle ---------------------------------------------------------

    async def connect(self) -> None:
        """Start (or restart) the connection loop. Returns immediately."""
        await self.disconnect()
        self._task = asyncio.create_task(self._run())

    async def disconnect(self) -> None:
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        await self._teardown()
        self._set_state(ConnectionState.DISCONNECTED)

    async def _teardown(self) -> None:
        if self._unsubscribe is not None:
            self._unsubscribe()
            self._unsubscribe = None
        bridge, self._bridge = self._bridge, None
        if bridge is not None:
            try:
                await bridge.close()
            except Exception:
                _LOGGER.debug("error while closing bridge", exc_info=True)

    async def _run(self) -> None:
        host = self._settings.bridge_host
        bridge_id = self._settings.bridge_id
        if not host or not bridge_id:
            self._set_state(ConnectionState.DISCONNECTED, "no bridge configured")
            return

        app_key = self._secrets.lookup(bridge_id, "app_key")
        if not app_key:
            self._set_state(ConnectionState.UNAUTHORIZED, "no stored credentials")
            return

        backoff = _BACKOFF_START
        while True:
            self._set_state(ConnectionState.CONNECTING)
            try:
                await self._connect_once(host, app_key)
                backoff = _BACKOFF_START
                # initialize() returns once the event stream is running; stay
                # here until it drops so we can reconnect.
                await self._wait_for_disconnect()
            except asyncio.CancelledError:
                raise
            except Unauthorized:
                # The app key was revoked from the Hue app. Retrying cannot fix
                # this -- the user has to pair again.
                await self._teardown()
                self._set_state(ConnectionState.UNAUTHORIZED, "app key was revoked")
                return
            except Exception as err:
                await self._teardown()
                self._set_state(ConnectionState.ERROR, str(err))
                _LOGGER.warning("bridge connection failed, retrying in %.0fs", backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, _BACKOFF_MAX)

    async def _connect_once(self, host: str, app_key: str) -> None:
        bridge = HueBridgeV2(host, app_key)
        await bridge.initialize()
        self._bridge = bridge
        self._unsubscribe = bridge.subscribe(self._on_event)
        self._set_state(ConnectionState.CONNECTED)

    async def _wait_for_disconnect(self) -> None:
        """Block until the event stream stops delivering.

        aiohue reconnects its own event stream internally, so this simply parks
        until the task is cancelled; the surrounding retry loop exists for the
        cases aiohue gives up on.
        """
        while self._bridge is not None:
            await asyncio.sleep(1.0)

    def _on_event(self, event_type: Any, item: Any, **_: Any) -> None:
        """Called by aiohue for every resource change.

        A busy bridge (or a scene transition) emits many events in a burst, and
        repainting once per event would make the UI stutter. Coalesce them into
        a single notification per event-loop iteration.
        """
        if self._changes_pending:
            return
        self._changes_pending = True
        asyncio.get_running_loop().call_soon(self._flush_changes)

    def _flush_changes(self) -> None:
        self._changes_pending = False
        for callback in list(self._change_callbacks):
            call_on_ui(callback)
