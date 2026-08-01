"""Tests for the colour processing chain."""

from __future__ import annotations

import numpy as np
import pytest

from brightbulb.color.process import (
    ColorProcessor,
    ProcessingSettings,
    to_linear,
    to_srgb,
    to_uint16,
)


def test_srgb_round_trip() -> None:
    values = np.arange(256, dtype=np.uint8).reshape(-1, 1, 1).repeat(3, axis=2)
    restored = to_srgb(to_linear(values)) * 255.0
    assert np.allclose(restored.reshape(-1, 3)[:, 0], np.arange(256), atol=0.6)


def test_linear_conversion_is_not_a_straight_line() -> None:
    """Mid-grey carries far less than half the light of white.

    This is the whole reason averaging happens in linear space; if this ever
    became linear, dark scenes would come out much too bright.
    """
    mid = float(to_linear(np.array([128], dtype=np.uint8))[0])
    assert 0.2 < mid < 0.25


def test_averaging_in_linear_differs_from_averaging_encoded() -> None:
    black_and_white = np.array([[0, 0, 0], [255, 255, 255]], dtype=np.uint8)
    linear_mean = to_linear(black_and_white).mean()
    encoded_mean = black_and_white.mean() / 255.0
    # Encoded averaging would report ~0.5; the truthful answer is ~0.5 in linear
    # light, which is a *much* brighter sRGB value.
    assert to_srgb(np.array([linear_mean]))[0] > encoded_mean + 0.2


def test_first_frame_is_used_directly() -> None:
    """Easing up from black would make every session start with a fade-in."""
    processor = ColorProcessor(1)
    result = processor.process(np.array([[1.0, 1.0, 1.0]], dtype=np.float32))
    assert result[0] == pytest.approx([1.0, 1.0, 1.0], abs=1e-4)


def test_brightening_is_faster_than_fading() -> None:
    settings = ProcessingSettings(attack=0.6, decay=0.15, saturation=1.0)
    processor = ColorProcessor(1, settings)
    processor.process(np.zeros((1, 3), dtype=np.float32))

    white = np.ones((1, 3), dtype=np.float32)
    after_up = float(to_linear((processor.process(white) * 255).astype(np.uint8))[0, 0])

    processor2 = ColorProcessor(1, settings)
    processor2.process(white)
    after_down = float(
        to_linear((processor2.process(np.zeros((1, 3), dtype=np.float32)) * 255)
                  .astype(np.uint8))[0, 0]
    )
    # One step up should cover more ground than one step down.
    assert after_up > (1.0 - after_down)


def test_smoothing_converges_on_a_held_colour() -> None:
    processor = ColorProcessor(1, ProcessingSettings(saturation=1.0))
    processor.process(np.zeros((1, 3), dtype=np.float32))
    target = np.full((1, 3), 0.8, dtype=np.float32)
    for _ in range(60):
        result = processor.process(target)
    assert result[0] == pytest.approx(to_srgb(target)[0], abs=1e-3)


def test_saturation_boost_spreads_channels_apart() -> None:
    plain = ColorProcessor(1, ProcessingSettings(saturation=1.0, attack=1.0, decay=1.0))
    boosted = ColorProcessor(1, ProcessingSettings(saturation=2.0, attack=1.0, decay=1.0))
    color = np.array([[0.6, 0.3, 0.3]], dtype=np.float32)

    plain_spread = np.ptp(plain.process(color)[0])
    boosted_spread = np.ptp(boosted.process(color)[0])
    assert boosted_spread > plain_spread


def test_grey_stays_grey_under_saturation() -> None:
    processor = ColorProcessor(1, ProcessingSettings(saturation=2.5, attack=1.0))
    result = processor.process(np.array([[0.5, 0.5, 0.5]], dtype=np.float32))
    assert result[0][0] == pytest.approx(result[0][1], abs=1e-5)
    assert result[0][1] == pytest.approx(result[0][2], abs=1e-5)


def test_black_point_gates_very_dark_colours() -> None:
    settings = ProcessingSettings(black_point=0.01, attack=1.0, decay=1.0, saturation=1.0)
    processor = ColorProcessor(1, settings)
    result = processor.process(np.array([[0.002, 0.001, 0.003]], dtype=np.float32))
    assert result[0] == pytest.approx([0.0, 0.0, 0.0], abs=1e-6)


def test_black_point_keeps_dim_but_saturated_colour() -> None:
    """Gate on overall level so a dim red does not lose its hue."""
    settings = ProcessingSettings(black_point=0.01, attack=1.0, decay=1.0, saturation=1.0)
    processor = ColorProcessor(1, settings)
    result = processor.process(np.array([[0.05, 0.0, 0.0]], dtype=np.float32))
    assert result[0][0] > 0.0


def test_reset_clears_smoothing_state() -> None:
    processor = ColorProcessor(1)
    processor.process(np.ones((1, 3), dtype=np.float32))
    processor.reset()
    result = processor.process(np.zeros((1, 3), dtype=np.float32))
    assert result[0] == pytest.approx([0.0, 0.0, 0.0], abs=1e-6)


def test_uint16_covers_the_full_range() -> None:
    values = to_uint16(np.array([[0.0, 0.5, 1.0]], dtype=np.float32))
    assert values[0][0] == 0
    assert values[0][2] == 65535
    assert 32000 < values[0][1] < 33500


def test_values_never_exceed_the_protocol_range() -> None:
    values = to_uint16(np.array([[-3.0, 17.0, np.nan]], dtype=np.float32))
    assert values.max() <= 65535
