"""The HueStream v2 wire format.

One datagram carries the full state of every channel in an entertainment
configuration. Layout, all integers big-endian:

===========  ======  ==================================================
Offset       Size    Meaning
===========  ======  ==================================================
0            9       ``b"HueStream"``
9            2       protocol version, ``0x02 0x00``
11           1       sequence number (the bridge ignores it)
12           2       reserved, zero
14           1       colour space: 0 = RGB, 1 = xy + brightness
15           1       reserved, zero
16           36      entertainment configuration id, ASCII UUID
52           7*n     per channel: id byte, then three uint16
===========  ======  ==================================================

Values are 16-bit per component. In RGB mode the bridge does its own per-lamp
gamut mapping, which is why this module sends RGB and never converts to xy:
each lamp in an area may have a different gamut, and the bridge knows them all.
"""

from __future__ import annotations

import struct
from collections.abc import Iterable, Sequence

MAGIC = b"HueStream"
VERSION = (0x02, 0x00)

COLOR_SPACE_RGB = 0x00
COLOR_SPACE_XY = 0x01

HEADER_SIZE = 52
CHANNEL_RECORD_SIZE = 7

# The bridge accepts at most 20 channels in one entertainment configuration.
MAX_CHANNELS = 20

UUID_LENGTH = 36

# One channel's colour: (channel_id, c0, c1, c2) with 16-bit components.
Channel = tuple[int, int, int, int]

_HEADER = struct.Struct(">9s2BB2sB1s36s")
_CHANNEL = struct.Struct(">BHHH")


def build_frame(
    entertainment_id: str,
    channels: Sequence[Channel] | Iterable[Channel],
    sequence: int = 0,
    color_space: int = COLOR_SPACE_RGB,
) -> bytes:
    """Serialise one frame.

    ``channels`` is an iterable of ``(channel_id, c0, c1, c2)``. In RGB mode the
    components are red, green and blue; in xy mode they are x, y and brightness.
    """
    channels = list(channels)
    if len(channels) > MAX_CHANNELS:
        raise ValueError(
            f"an entertainment configuration carries at most {MAX_CHANNELS} "
            f"channels, got {len(channels)}"
        )
    if color_space not in (COLOR_SPACE_RGB, COLOR_SPACE_XY):
        raise ValueError(f"unknown colour space {color_space!r}")

    identifier = entertainment_id.encode("ascii")
    if len(identifier) != UUID_LENGTH:
        raise ValueError(
            f"entertainment configuration id must be a {UUID_LENGTH}-character "
            f"UUID, got {len(identifier)} characters"
        )

    parts = [
        _HEADER.pack(
            MAGIC,
            *VERSION,
            sequence & 0xFF,
            b"\x00\x00",
            color_space,
            b"\x00",
            identifier,
        )
    ]
    for channel_id, c0, c1, c2 in channels:
        parts.append(
            _CHANNEL.pack(channel_id & 0xFF, _u16(c0), _u16(c1), _u16(c2))
        )
    return b"".join(parts)


def rgb_channels(
    values: Iterable[tuple[int, tuple[float, float, float]]]
) -> list[Channel]:
    """Convert ``(channel_id, (r, g, b))`` with 0-1 floats into 16-bit records."""
    return [
        (channel_id, _to_u16(r), _to_u16(g), _to_u16(b))
        for channel_id, (r, g, b) in values
    ]


def _to_u16(value: float) -> int:
    """Scale a 0-1 float to the full 16-bit range."""
    if value <= 0.0:
        return 0
    if value >= 1.0:
        return 0xFFFF
    return int(value * 0xFFFF)


def _u16(value: int) -> int:
    return 0 if value < 0 else 0xFFFF if value > 0xFFFF else int(value)
