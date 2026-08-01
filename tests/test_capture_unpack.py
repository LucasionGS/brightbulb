"""Tests for reshaping raw RGBx capture buffers.

GStreamer pads rows to an alignment boundary, so buffers are routinely larger
than width*height*4. Including those padding bytes produces a frame that still
looks like a plausible image while every colour is subtly wrong -- which is
exactly the kind of bug that survives visual inspection.
"""

from __future__ import annotations

import numpy as np
import pytest

from brightbulb.capture.pipeline import unpack_rgbx


def _packed(width: int, height: int, fill: int = 0) -> np.ndarray:
    return np.full(width * height * 4, fill, dtype=np.uint8)


def test_tightly_packed_buffer() -> None:
    raw = _packed(64, 36)
    frame = unpack_rgbx(raw, 64, 36)
    assert frame is not None
    assert frame.shape == (36, 64, 3)
    assert frame.dtype == np.uint8


def test_alpha_channel_is_dropped() -> None:
    raw = np.tile(np.array([10, 20, 30, 255], dtype=np.uint8), 64 * 36)
    frame = unpack_rgbx(raw, 64, 36)
    assert frame is not None
    assert np.all(frame[:, :, 0] == 10)
    assert np.all(frame[:, :, 1] == 20)
    assert np.all(frame[:, :, 2] == 30)


def test_padded_rows_are_excluded() -> None:
    """Padding is filled with a value that would be obvious if leaked in."""
    width, height = 5, 4
    row_bytes = width * 4
    stride = 32  # padded well beyond 20 bytes

    rows = np.full((height, stride), 255, dtype=np.uint8)
    rows[:, :row_bytes] = np.tile(
        np.array([1, 2, 3, 0], dtype=np.uint8), width
    )
    frame = unpack_rgbx(rows.reshape(-1), width, height)

    assert frame is not None
    assert frame.shape == (height, width, 3)
    assert not np.any(frame == 255), "padding bytes leaked into the image"
    assert np.all(frame[:, :, 0] == 1)


def test_padded_buffer_keeps_correct_pixel_positions() -> None:
    """A stride mistake shifts pixels sideways; check a known pattern survives."""
    width, height, stride = 3, 2, 20
    rows = np.zeros((height, stride), dtype=np.uint8)
    for y in range(height):
        for x in range(width):
            rows[y, x * 4 : x * 4 + 3] = [y * 10 + x, 0, 0]

    frame = unpack_rgbx(rows.reshape(-1), width, height)
    assert frame is not None
    assert frame[0, 0, 0] == 0
    assert frame[0, 2, 0] == 2
    assert frame[1, 0, 0] == 10
    assert frame[1, 2, 0] == 12


def test_truncated_buffer_is_rejected() -> None:
    """Better to drop a frame than to feed the lights a garbled one."""
    assert unpack_rgbx(_packed(64, 36)[:100], 64, 36) is None


@pytest.mark.parametrize(("width", "height"), [(0, 36), (64, 0), (-1, 10)])
def test_degenerate_dimensions_are_rejected(width: int, height: int) -> None:
    assert unpack_rgbx(_packed(8, 8), width, height) is None
