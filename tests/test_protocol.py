"""Tests for the HueStream v2 wire format.

Byte layout is asserted against explicit offsets rather than round-tripped
through the same struct definitions: a typo in the format string would round
trip happily while producing frames the bridge silently ignores. The failure
mode for getting this wrong is lights that simply do nothing, with no error, so
the layout is pinned down here.
"""

from __future__ import annotations

import pytest

from brightbulb.stream.protocol import (
    CHANNEL_RECORD_SIZE,
    COLOR_SPACE_RGB,
    COLOR_SPACE_XY,
    HEADER_SIZE,
    MAX_CHANNELS,
    build_frame,
    rgb_channels,
)

CONFIG_ID = "31c8d706-70b7-4b7f-aa9d-4cf4c811397f"


def test_header_layout_is_exact() -> None:
    frame = build_frame(CONFIG_ID, [])

    assert len(frame) == HEADER_SIZE
    assert frame[0:9] == b"HueStream"
    assert frame[9:11] == b"\x02\x00", "protocol version 2.0"
    assert frame[11] == 0, "sequence"
    assert frame[12:14] == b"\x00\x00", "reserved"
    assert frame[14] == COLOR_SPACE_RGB
    assert frame[15] == 0, "reserved"
    assert frame[16:52] == CONFIG_ID.encode("ascii")


def test_channel_records_are_big_endian_16_bit() -> None:
    frame = build_frame(CONFIG_ID, [(3, 0x1234, 0xABCD, 0x0001)])

    assert len(frame) == HEADER_SIZE + CHANNEL_RECORD_SIZE
    record = frame[HEADER_SIZE:]
    assert record[0] == 3, "channel id"
    assert record[1:3] == b"\x12\x34"
    assert record[3:5] == b"\xab\xcd"
    assert record[5:7] == b"\x00\x01"


def test_channels_appear_in_order() -> None:
    frame = build_frame(CONFIG_ID, [(0, 0, 0, 0), (1, 0, 0, 0), (2, 0, 0, 0)])
    ids = [frame[HEADER_SIZE + i * CHANNEL_RECORD_SIZE] for i in range(3)]
    assert ids == [0, 1, 2]


def test_sequence_and_color_space_are_carried() -> None:
    frame = build_frame(CONFIG_ID, [], sequence=200, color_space=COLOR_SPACE_XY)
    assert frame[11] == 200
    assert frame[14] == COLOR_SPACE_XY


def test_sequence_wraps_rather_than_overflowing() -> None:
    """The counter is one byte; a long-running stream must not raise at 256."""
    assert build_frame(CONFIG_ID, [], sequence=256)[11] == 0
    assert build_frame(CONFIG_ID, [], sequence=257)[11] == 1


def test_full_frame_size() -> None:
    channels = [(i, 0, 0, 0) for i in range(MAX_CHANNELS)]
    assert len(build_frame(CONFIG_ID, channels)) == 192


def test_too_many_channels_is_rejected() -> None:
    channels = [(i, 0, 0, 0) for i in range(MAX_CHANNELS + 1)]
    with pytest.raises(ValueError, match="at most 20"):
        build_frame(CONFIG_ID, channels)


@pytest.mark.parametrize("bad_id", ["", "too-short", CONFIG_ID + "x"])
def test_malformed_configuration_id_is_rejected(bad_id: str) -> None:
    """A wrong-length id would shift every channel record and go unnoticed."""
    with pytest.raises(ValueError, match="36-character"):
        build_frame(bad_id, [])


def test_unknown_color_space_is_rejected() -> None:
    with pytest.raises(ValueError, match="colour space"):
        build_frame(CONFIG_ID, [], color_space=0x07)


def test_component_values_are_clamped_not_wrapped() -> None:
    """Clamping keeps an over-bright value white; wrapping would make it black."""
    frame = build_frame(CONFIG_ID, [(0, -5, 0x10000, 0xFFFF)])
    record = frame[HEADER_SIZE:]
    assert record[1:3] == b"\x00\x00"
    assert record[3:5] == b"\xff\xff"
    assert record[5:7] == b"\xff\xff"


def test_rgb_channels_scales_floats_to_full_range() -> None:
    assert rgb_channels([(0, (0.0, 0.5, 1.0))]) == [(0, 0, 32767, 0xFFFF)]


def test_rgb_channels_clamps_out_of_range_floats() -> None:
    assert rgb_channels([(2, (-1.0, 2.0, 0.0))]) == [(2, 0, 0xFFFF, 0)]


def test_accepts_a_generator_not_just_a_sequence() -> None:
    frame = build_frame(CONFIG_ID, ((i, 0, 0, 0) for i in range(3)))
    assert len(frame) == HEADER_SIZE + 3 * CHANNEL_RECORD_SIZE
