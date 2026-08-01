"""Writing light state to the bridge.

A colour picker or brightness slider emits changes as fast as the pointer moves.
The CLIP v2 API will not take that: the bridge starts returning 429 above a
handful of requests per second and, worse, a backlog of queued writes makes the
lamps visibly lag behind the slider.

:class:`LightWriter` sits between the UI and aiohue and enforces two rules:

* **Coalesce** -- only the newest value per light matters, so pending changes are
  merged and superseded ones dropped rather than queued.
* **Rate limit** -- at most one write per light per flush interval.

The UI can therefore call :meth:`LightWriter.queue` on every pointer motion
without thinking about it.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import threading
from typing import Any

from brightbulb.hue.bridge import BridgeConnection

_LOGGER = logging.getLogger(__name__)

# 10 Hz: fast enough that a drag feels continuous, slow enough that the bridge
# keeps up even with several lights moving at once.
DEFAULT_FLUSH_INTERVAL = 0.1


class LightWriter:
    """Coalescing, rate-limited writer for light state."""

    def __init__(
        self,
        connection: BridgeConnection,
        flush_interval: float = DEFAULT_FLUSH_INTERVAL,
    ) -> None:
        self._connection = connection
        self._interval = flush_interval
        self._lock = threading.Lock()
        self._pending: dict[str, dict[str, Any]] = {}
        self._grouped_pending: dict[str, dict[str, Any]] = {}
        self._task: asyncio.Task[None] | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        """Begin flushing. Call once, from the asyncio thread's loop owner."""
        self._loop = loop
        if self._task is None or self._task.done():
            self._task = loop.create_task(self._flush_loop())

    async def stop(self) -> None:
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    # -- queueing (safe from the GTK thread) -------------------------------

    def queue(self, light_id: str, **changes: Any) -> None:
        """Merge ``changes`` into the pending write for ``light_id``."""
        if not changes:
            return
        with self._lock:
            self._pending.setdefault(light_id, {}).update(changes)

    def queue_group(self, grouped_light_id: str, **changes: Any) -> None:
        """Merge ``changes`` into the pending write for a grouped light.

        Rooms and zones are driven through their ``grouped_light`` resource: one
        request turns on eight lamps together, and they respond in unison
        instead of visibly cascading.
        """
        if not changes:
            return
        with self._lock:
            self._grouped_pending.setdefault(grouped_light_id, {}).update(changes)

    def drop(self, light_id: str) -> None:
        """Discard queued changes for a light."""
        with self._lock:
            self._pending.pop(light_id, None)

    def has_pending(self, light_id: str) -> bool:
        with self._lock:
            return light_id in self._pending

    # -- flushing ----------------------------------------------------------

    async def _flush_loop(self) -> None:
        while True:
            await asyncio.sleep(self._interval)
            try:
                await self._flush_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                _LOGGER.exception("unexpected error flushing light state")

    async def _flush_once(self) -> None:
        bridge = self._connection.bridge
        if bridge is None:
            # Not connected: drop the backlog rather than replaying stale state
            # onto the lamps when the connection returns.
            with self._lock:
                self._pending.clear()
                self._grouped_pending.clear()
            return

        with self._lock:
            lights, self._pending = self._pending, {}
            groups, self._grouped_pending = self._grouped_pending, {}

        if not lights and not groups:
            return

        calls = [bridge.lights.set_state(light_id, **kw) for light_id, kw in lights.items()]
        calls += [
            bridge.groups.grouped_light.set_state(group_id, **kw)
            for group_id, kw in groups.items()
        ]

        results = await asyncio.gather(*calls, return_exceptions=True)
        for target, result in zip(
            list(lights) + list(groups), results, strict=True
        ):
            if isinstance(result, BaseException):
                # A failed write is not worth surfacing: the next slider move
                # supersedes it, and the event stream reports the real state.
                _LOGGER.debug("write to %s failed: %s", target, result)
