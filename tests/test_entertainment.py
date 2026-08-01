"""Reading entertainment areas, and in particular who is streaming to them."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from brightbulb.hue import entertainment


def _config(status: str, streamer: str | None = None) -> SimpleNamespace:
    return SimpleNamespace(
        id="area-1",
        metadata=SimpleNamespace(name="Living room"),
        configuration_type="screen",
        status=status,
        channels=[
            SimpleNamespace(channel_id=0, position=SimpleNamespace(x=-1.0, y=0.0, z=1.0))
        ],
        active_streamer=SimpleNamespace(rid=streamer) if streamer else None,
    )


def _bridge(*configs: SimpleNamespace) -> SimpleNamespace:
    return SimpleNamespace(
        config=SimpleNamespace(entertainment_configuration=list(configs))
    )


def test_active_area_reports_its_streamer() -> None:
    (area,) = entertainment.list_areas(_bridge(_config("active", "auth-abc")))
    assert area.active is True
    assert area.active_streamer == "auth-abc"


def test_inactive_area_reports_no_streamer() -> None:
    """A released area must never look occupied.

    aiohue keeps a field's previous value when an event carries it as null, so
    the cached ``active_streamer`` outlives the release that cleared it on the
    bridge. Trusting it made mirroring refuse to restart for the rest of the
    session, claiming another app held the area.
    """
    (area,) = entertainment.list_areas(_bridge(_config("inactive", "auth-abc")))
    assert area.active is False
    assert area.active_streamer is None


def test_areas_sort_by_name() -> None:
    first = _config("inactive")
    first.metadata = SimpleNamespace(name="Zebra")
    second = _config("inactive")
    second.metadata = SimpleNamespace(name="alpha")
    names = [a.name for a in entertainment.list_areas(_bridge(first, second))]
    assert names == ["alpha", "Zebra"]


class _FakeBridge:
    """Bridge stub returning one canned CLIP payload."""

    def __init__(self, payload: object) -> None:
        self.payload = payload
        self.calls: list[tuple[str, str]] = []

    async def request(self, method: str, path: str, **_: object) -> object:
        self.calls.append((method, path))
        return self.payload


@pytest.mark.asyncio
async def test_streaming_state_reads_live_data() -> None:
    bridge = _FakeBridge(
        [{"status": "active", "active_streamer": {"rid": "auth-abc"}}]
    )
    state = await entertainment.streaming_state(bridge, "area-1")

    assert state == entertainment.StreamingState(active=True, streamer_rid="auth-abc")
    assert bridge.calls == [
        ("get", "clip/v2/resource/entertainment_configuration/area-1")
    ]


@pytest.mark.asyncio
async def test_streaming_state_handles_released_area() -> None:
    """The bridge sends an explicit null once nobody is streaming."""
    bridge = _FakeBridge([{"status": "inactive", "active_streamer": None}])
    state = await entertainment.streaming_state(bridge, "area-1")
    assert state == entertainment.StreamingState(active=False, streamer_rid=None)


@pytest.mark.asyncio
async def test_streaming_state_accepts_an_unwrapped_object() -> None:
    bridge = _FakeBridge({"status": "active", "active_streamer": {"rid": "x"}})
    state = await entertainment.streaming_state(bridge, "area-1")
    assert state == entertainment.StreamingState(active=True, streamer_rid="x")


@pytest.mark.asyncio
async def test_stop_streaming_never_raises() -> None:
    """Teardown runs on crash paths, where the original failure matters more."""

    class _Failing:
        async def request(self, *_: object, **__: object) -> object:
            raise RuntimeError("bridge unreachable")

    await entertainment.stop_streaming(_Failing(), "area-1")
