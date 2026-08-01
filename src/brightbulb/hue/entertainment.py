"""Entertainment configurations: selection, activation and channel geometry.

Streaming is a two-part handshake with the bridge:

1. **Activate** the entertainment configuration over CLIP (``action: start``).
   Only then does the bridge open its DTLS listener for this application, and
   only one application may hold it at a time.
2. **Connect** over DTLS-PSK and start sending frames.

Skipping step 1 produces a DTLS handshake that fails with no useful diagnostic,
which is the single most common way to lose an afternoon here. Deactivating
matters just as much: a configuration left active blocks every other Hue app,
including the official one, until the bridge times it out.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

_LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class ChannelPosition:
    """Where a channel sits in the room, in the bridge's own coordinate space.

    Roughly -1..1 on each axis: ``x`` left to right, ``y`` back to front, ``z``
    bottom to top. Treat these as approximate -- they come from wherever the
    user dragged the light in the Hue app.
    """

    channel_id: int
    x: float
    y: float
    z: float


@dataclass(frozen=True)
class EntertainmentArea:
    """A streamable area, reduced to what the streaming code needs."""

    id: str
    name: str
    configuration_type: str
    channels: tuple[ChannelPosition, ...]
    active: bool
    # Whoever currently holds the area -- which is *us* while we stream, not
    # only other applications. Never use this to decide whether we may claim
    # the area; use `streaming_state` for that.
    active_streamer: str | None = None

    @property
    def channel_ids(self) -> tuple[int, ...]:
        return tuple(channel.channel_id for channel in self.channels)


@dataclass(frozen=True)
class StreamingState:
    """Who holds an area right now, read live from the bridge."""

    active: bool
    streamer_rid: str | None


def list_areas(bridge: Any) -> list[EntertainmentArea]:
    """All entertainment configurations on the bridge."""
    areas: list[EntertainmentArea] = []
    for config in bridge.config.entertainment_configuration:
        active = _enum_value(config.status).lower() == "active"
        areas.append(
            EntertainmentArea(
                id=config.id,
                name=_name_of(config),
                configuration_type=_enum_value(config.configuration_type),
                channels=tuple(_positions_of(config)),
                active=active,
                # Only trustworthy while the area is active. aiohue applies
                # events field by field and keeps the previous value whenever
                # one arrives as null, so a released area goes on naming
                # whoever streamed to it last for the rest of the session.
                active_streamer=_streamer_rid(config) if active else None,
            )
        )
    areas.sort(key=lambda area: area.name.lower())
    return areas


def get_area(bridge: Any, entertainment_id: str) -> EntertainmentArea | None:
    return next((a for a in list_areas(bridge) if a.id == entertainment_id), None)


def preferred_area(areas: list[EntertainmentArea]) -> EntertainmentArea | None:
    """Pick the area most likely to be wanted for screen mirroring.

    A configuration whose type is ``screen`` was set up by the user for exactly
    this, so prefer it over a music or 3D-space area.
    """
    if not areas:
        return None
    screen = [a for a in areas if a.configuration_type.lower() == "screen"]
    return (screen or areas)[0]


async def streaming_state(bridge: Any, entertainment_id: str) -> StreamingState:
    """Read who holds the area straight from CLIP, bypassing the cache.

    The cached copy cannot answer this. Because aiohue keeps a field's previous
    value when an event carries it as null, ``active_streamer`` survives the
    release that cleared it on the bridge -- so a perfectly free area still
    looks occupied. Ownership decisions therefore always re-read.
    """
    data = await bridge.request(
        "get", f"clip/v2/resource/entertainment_configuration/{entertainment_id}"
    )
    item = data[0] if isinstance(data, list) else data
    streamer = item.get("active_streamer") or {}
    return StreamingState(
        active=str(item.get("status", "")).lower() == "active",
        streamer_rid=streamer.get("rid"),
    )


async def start_streaming(bridge: Any, entertainment_id: str) -> None:
    """Hand the area over to us. Must precede the DTLS handshake."""
    _LOGGER.info("activating entertainment configuration %s", entertainment_id)
    await _set_action(bridge, entertainment_id, "start")


async def stop_streaming(bridge: Any, entertainment_id: str) -> None:
    """Release the area. Safe to call when it is not active."""
    _LOGGER.info("deactivating entertainment configuration %s", entertainment_id)
    try:
        await _set_action(bridge, entertainment_id, "stop")
    except Exception:
        # Never let cleanup raise: this runs on shutdown and crash paths, where
        # the original failure matters more and the bridge times the session out
        # by itself anyway.
        _LOGGER.warning("could not deactivate %s", entertainment_id, exc_info=True)


async def _set_action(bridge: Any, entertainment_id: str, action: str) -> None:
    await bridge.request(
        "put",
        f"clip/v2/resource/entertainment_configuration/{entertainment_id}",
        json={"action": action},
    )


def _name_of(config: Any) -> str:
    metadata = getattr(config, "metadata", None)
    return str(getattr(metadata, "name", None) or "Entertainment area")


def _streamer_rid(config: Any) -> str | None:
    rid = getattr(getattr(config, "active_streamer", None), "rid", None)
    return str(rid) if rid else None


def _enum_value(value: Any) -> str:
    """Enums from aiohue carry the wire string in ``.value``."""
    return str(getattr(value, "value", value) or "")


def _positions_of(config: Any) -> list[ChannelPosition]:
    positions: list[ChannelPosition] = []
    for channel in getattr(config, "channels", []) or []:
        position = getattr(channel, "position", None)
        positions.append(
            ChannelPosition(
                channel_id=int(channel.channel_id),
                x=float(getattr(position, "x", 0.0) or 0.0),
                y=float(getattr(position, "y", 0.0) or 0.0),
                z=float(getattr(position, "z", 0.0) or 0.0),
            )
        )
    positions.sort(key=lambda p: p.channel_id)
    return positions
