"""Tests for the GTK/asyncio bridge.

These exercise the runner without a GTK main loop. ``call_on_ui`` defers to
``GLib.idle_add``, which never fires here, so tests assert on the concurrent
futures rather than on delivered callbacks.
"""

from __future__ import annotations

import asyncio

import pytest

from brightbulb.asyncio_bridge import AsyncRunner


@pytest.fixture
def runner():
    runner = AsyncRunner(name="test-asyncio")
    runner.start()
    yield runner
    runner.stop()


def test_submit_returns_result(runner: AsyncRunner) -> None:
    async def work() -> str:
        await asyncio.sleep(0)
        return "done"

    assert runner.submit(work()).result(timeout=5) == "done"


def test_submit_propagates_exception(runner: AsyncRunner) -> None:
    async def boom() -> None:
        raise ValueError("nope")

    future = runner.submit(boom())
    with pytest.raises(ValueError, match="nope"):
        future.result(timeout=5)


def test_runs_off_the_calling_thread(runner: AsyncRunner) -> None:
    import threading

    async def whoami() -> int:
        return threading.get_ident()

    assert runner.submit(whoami()).result(timeout=5) != threading.get_ident()


def test_run_and_then_reports_failure_without_callback(runner: AsyncRunner) -> None:
    """A failing coroutine must not raise into the GTK thread or vanish."""

    async def boom() -> None:
        raise RuntimeError("kaboom")

    future = runner.run_and_then(boom())
    assert isinstance(future.exception(timeout=5), RuntimeError)


def test_stop_is_idempotent() -> None:
    runner = AsyncRunner(name="test-idempotent")
    runner.start()
    runner.stop()
    runner.stop()


def test_submit_after_stop_raises() -> None:
    runner = AsyncRunner(name="test-stopped")
    runner.start()
    runner.stop()

    async def work() -> None:
        return None

    coro = work()
    with pytest.raises(RuntimeError, match="not running"):
        runner.submit(coro)
    coro.close()


def test_double_start_raises(runner: AsyncRunner) -> None:
    with pytest.raises(RuntimeError, match="already started"):
        runner.start()
