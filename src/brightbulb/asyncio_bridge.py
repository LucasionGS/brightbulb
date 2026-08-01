"""Bridge between the GTK/GLib main loop and an asyncio event loop.

GTK owns the main thread, but every Hue interaction (aiohue, aiohttp, the CLIP v2
SSE event stream) is asyncio. We run asyncio on a dedicated thread and marshal in
both directions rather than depending on gbulb, which is effectively unmaintained:

    GTK thread   -> asyncio : AsyncRunner.submit() / run_and_then()
    asyncio      -> GTK     : GLib.idle_add() via call_on_ui()

The rule this enforces: **no GTK call ever happens off the main thread, and no
blocking wait ever happens on it.** Callbacks passed to run_and_then() are always
invoked on the GTK thread, so they may touch widgets freely.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import logging
import threading
from collections.abc import Callable, Coroutine
from typing import Any, TypeVar

from gi.repository import GLib

_LOGGER = logging.getLogger(__name__)

T = TypeVar("T")


def call_on_ui(func: Callable[..., Any], *args: Any) -> None:
    """Schedule ``func(*args)`` to run on the GTK main thread.

    Safe to call from any thread. The callback runs once.
    """

    def _invoke() -> bool:
        try:
            func(*args)
        except Exception:
            _LOGGER.exception("unhandled error in UI callback %r", func)
        return GLib.SOURCE_REMOVE

    GLib.idle_add(_invoke)


class AsyncRunner:
    """Owns an asyncio event loop running on its own thread."""

    def __init__(self, name: str = "brightbulb-asyncio") -> None:
        self._name = name
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._ready = threading.Event()

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> None:
        if self._thread is not None:
            raise RuntimeError("AsyncRunner already started")

        self._thread = threading.Thread(target=self._run, name=self._name, daemon=True)
        self._thread.start()
        if not self._ready.wait(timeout=5.0):
            raise RuntimeError("asyncio thread failed to start")

    def _run(self) -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._loop = loop
        self._ready.set()
        try:
            loop.run_forever()
        finally:
            try:
                self._cancel_all(loop)
                loop.run_until_complete(loop.shutdown_asyncgens())
            finally:
                loop.close()
                self._loop = None

    @staticmethod
    def _cancel_all(loop: asyncio.AbstractEventLoop) -> None:
        pending = [t for t in asyncio.all_tasks(loop) if not t.done()]
        for task in pending:
            task.cancel()
        if pending:
            loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))

    def stop(self, timeout: float = 5.0) -> None:
        """Stop the loop and join its thread. Idempotent."""
        loop, thread = self._loop, self._thread
        if loop is None or thread is None:
            return
        loop.call_soon_threadsafe(loop.stop)
        thread.join(timeout=timeout)
        if thread.is_alive():
            _LOGGER.warning("asyncio thread did not exit within %.1fs", timeout)
        self._thread = None
        self._ready.clear()

    @property
    def loop(self) -> asyncio.AbstractEventLoop:
        loop = self._loop
        if loop is None:
            raise RuntimeError("AsyncRunner is not running")
        return loop

    # -- submitting work ---------------------------------------------------

    def submit(self, coro: Coroutine[Any, Any, T]) -> concurrent.futures.Future[T]:
        """Schedule a coroutine on the asyncio loop from any thread.

        Never block on the returned future from the GTK thread; use
        :meth:`run_and_then` instead.
        """
        return asyncio.run_coroutine_threadsafe(coro, self.loop)

    def run_and_then(
        self,
        coro: Coroutine[Any, Any, T],
        on_done: Callable[[T], None] | None = None,
        on_error: Callable[[BaseException], None] | None = None,
    ) -> concurrent.futures.Future[T]:
        """Run ``coro``, then deliver its outcome on the GTK main thread.

        Cancellation is not an error and invokes neither callback. If the
        coroutine raises and no ``on_error`` is given, the traceback is logged
        rather than silently dropped.
        """
        future = self.submit(coro)

        def _settled(fut: concurrent.futures.Future[T]) -> None:
            if fut.cancelled():
                return
            error = fut.exception()
            if error is not None:
                if on_error is not None:
                    call_on_ui(on_error, error)
                else:
                    _LOGGER.error("async task failed", exc_info=error)
                return
            if on_done is not None:
                call_on_ui(on_done, fut.result())

        future.add_done_callback(_settled)
        return future
