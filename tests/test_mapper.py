"""Tests for mapping channel positions onto screen regions.

These use synthetic frames with known structure (left half red, top half green)
so a wrong axis, a flipped sign, or a normalisation bug shows up as a concrete
wrong colour rather than a plausible-looking one.
"""

from __future__ import annotations

import numpy as np
import pytest

from brightbulb.hue.entertainment import ChannelPosition
from brightbulb.stream.mapper import MappingConfig, ScreenMapper

WIDTH, HEIGHT = 64, 36

# Screen-plane channels (y = -1, the screen end under the default convention).
LEFT = ChannelPosition(0, x=-1.0, y=-1.0, z=0.0)
RIGHT = ChannelPosition(1, x=1.0, y=-1.0, z=0.0)
TOP = ChannelPosition(2, x=0.0, y=-1.0, z=1.0)
BOTTOM = ChannelPosition(3, x=0.0, y=-1.0, z=-1.0)


def _split_horizontal() -> np.ndarray:
    """Left half red, right half blue."""
    frame = np.zeros((HEIGHT, WIDTH, 3), dtype=np.float32)
    frame[:, : WIDTH // 2] = (1.0, 0.0, 0.0)
    frame[:, WIDTH // 2 :] = (0.0, 0.0, 1.0)
    return frame


def _split_vertical() -> np.ndarray:
    """Top half green, bottom half blue."""
    frame = np.zeros((HEIGHT, WIDTH, 3), dtype=np.float32)
    frame[: HEIGHT // 2] = (0.0, 1.0, 0.0)
    frame[HEIGHT // 2 :] = (0.0, 0.0, 1.0)
    return frame


def test_left_channel_sees_the_left_of_the_screen() -> None:
    mapper = ScreenMapper([LEFT, RIGHT], WIDTH, HEIGHT)
    left, right = mapper.sample(_split_horizontal())

    assert left[0] > left[2], "left channel should be red-dominant"
    assert right[2] > right[0], "right channel should be blue-dominant"


def test_top_channel_sees_the_top_of_the_screen() -> None:
    """z is bottom-to-top while image rows run top-to-bottom; this catches a flip."""
    mapper = ScreenMapper([TOP, BOTTOM], WIDTH, HEIGHT)
    top, bottom = mapper.sample(_split_vertical())

    assert top[1] > top[2], "top channel should be green-dominant"
    assert bottom[2] > bottom[1], "bottom channel should be blue-dominant"


def test_weights_are_normalised_so_edges_are_not_darker() -> None:
    """A kernel clipped by the frame edge must not dim that channel."""
    mapper = ScreenMapper([LEFT, ChannelPosition(9, 0.0, -1.0, 0.0)], WIDTH, HEIGHT)
    white = np.ones((HEIGHT, WIDTH, 3), dtype=np.float32)
    edge, centre = mapper.sample(white)

    assert edge == pytest.approx(centre, abs=1e-4)
    assert edge[0] == pytest.approx(1.0, abs=1e-4)


def test_uniform_frame_gives_every_channel_that_colour() -> None:
    channels = [LEFT, RIGHT, TOP, BOTTOM]
    mapper = ScreenMapper(channels, WIDTH, HEIGHT)
    frame = np.full((HEIGHT, WIDTH, 3), 0.5, dtype=np.float32)

    for color in mapper.sample(frame):
        assert color == pytest.approx([0.5, 0.5, 0.5], abs=1e-4)


def test_rear_channels_drift_toward_the_overall_average() -> None:
    """A lamp behind the viewer has no honest region, so it should generalise."""
    front = ChannelPosition(0, x=-1.0, y=-1.0, z=0.0)
    rear = ChannelPosition(1, x=-1.0, y=1.0, z=0.0)
    mapper = ScreenMapper([front, rear], WIDTH, HEIGHT)

    front_color, rear_color = mapper.sample(_split_horizontal())
    # Both sit on the left, but the rear one must be less purely red.
    assert front_color[0] > rear_color[0]
    assert rear_color[2] > front_color[2]


def test_screen_end_of_the_room_is_configurable() -> None:
    """Which end holds the screen depends on the user's setup, so it must flip."""
    near = ChannelPosition(0, x=-1.0, y=-1.0, z=0.0)
    far = ChannelPosition(1, x=-1.0, y=1.0, z=0.0)
    frame = _split_horizontal()

    default = ScreenMapper([near, far], WIDTH, HEIGHT)
    flipped = ScreenMapper(
        [near, far], WIDTH, HEIGHT, MappingConfig(screen_at_positive_y=True)
    )

    assert default.mappings[0].affinity > default.mappings[1].affinity
    assert flipped.mappings[1].affinity > flipped.mappings[0].affinity
    assert default.sample(frame)[0][0] > flipped.sample(frame)[0][0]


def test_positions_outside_the_nominal_range_are_tolerated() -> None:
    """Hue positions come from user dragging; do not trust them to stay in -1..1."""
    wild = ChannelPosition(0, x=-4.0, y=9.0, z=3.0)
    mapper = ScreenMapper([wild], WIDTH, HEIGHT)
    mapping = mapper.mappings[0]

    assert 0.0 <= mapping.u <= 1.0
    assert 0.0 <= mapping.v <= 1.0
    assert np.isfinite(mapper.sample(_split_horizontal())).all()


def test_empty_configuration_does_not_crash() -> None:
    mapper = ScreenMapper([], WIDTH, HEIGHT)
    assert mapper.sample(_split_horizontal()).shape == (0, 3)


def test_channel_ids_are_preserved_in_order() -> None:
    channels = [ChannelPosition(5, 0, 0, 0), ChannelPosition(2, 0, 0, 0)]
    assert ScreenMapper(channels, WIDTH, HEIGHT).channel_ids == (5, 2)
