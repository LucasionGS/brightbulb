"""Mapping entertainment channels onto regions of the screen.

Each channel has a position in the room, so the colour it should show is the
colour of the part of the screen it sits next to: a lamp on the left wall takes
the left edge, one above the monitor takes the top.

Two things make this more than a lookup:

* **A point sample is too noisy.** A single pixel from a 64x36 grid flickers
  wildly on moving content. Each channel instead takes a Gaussian-weighted
  average of a neighbourhood, so it responds to a *region*.
* **Not every light is near the screen.** A lamp behind the viewer has no
  honest screen region at all. Rather than pretending, channels blend toward
  the whole-screen average in proportion to how far back they sit.

Weights are precomputed once per configuration, so a frame costs a single small
matrix multiply: ``(channels x pixels) @ (pixels x 3)``.

**Axis convention.** Hue reports positions roughly in -1..1 with ``x`` running
left to right and ``z`` bottom to top, which map to screen u/v directly. The
``y`` (depth) axis is the ambiguous one -- which end of the room holds the
screen depends on how the user arranged the area in the Hue app -- so its sign
is configurable via :attr:`MappingConfig.screen_at_positive_y` rather than
guessed.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np

from brightbulb.hue.entertainment import ChannelPosition


@dataclass(frozen=True)
class MappingConfig:
    """How channel positions translate into screen regions."""

    # Radius of the sampled neighbourhood, in fractions of the screen. Larger
    # is calmer but less specific.
    spread: float = 0.22
    # Which end of the room the screen is at. Flipping this swaps which lights
    # track their own region and which follow the overall average.
    screen_at_positive_y: bool = False
    # How much a channel at the very back still follows its own region rather
    # than the global average. Zero would make rear lights pure average, which
    # reads as dull.
    rear_region_blend: float = 0.35
    # Pull sampling points toward the edges they sit nearest, so a lamp beside
    # the screen picks up edge content rather than drifting toward the middle.
    edge_bias: float = 0.15


@dataclass(frozen=True)
class ChannelMapping:
    """Where one channel samples from, for display and debugging."""

    channel_id: int
    u: float
    v: float
    affinity: float


class ScreenMapper:
    """Turns a captured frame into one colour per entertainment channel."""

    def __init__(
        self,
        channels: Sequence[ChannelPosition],
        grid_width: int,
        grid_height: int,
        config: MappingConfig | None = None,
    ) -> None:
        self.config = config or MappingConfig()
        self.channels = tuple(channels)
        self.grid_width = grid_width
        self.grid_height = grid_height

        self._mappings = tuple(self._map_channel(c) for c in self.channels)
        # (n_channels, n_pixels), each row summing to 1.
        self._weights = self._build_weights()
        # (n_channels, 1) blend factor between region colour and global average.
        # Reshaped explicitly: an empty configuration yields shape (0,) rather
        # than (0, 1), which then fails to broadcast against the sample result.
        self._affinity = np.array(
            [m.affinity for m in self._mappings], dtype=np.float32
        ).reshape(-1, 1)

    @property
    def mappings(self) -> tuple[ChannelMapping, ...]:
        return self._mappings

    @property
    def channel_ids(self) -> tuple[int, ...]:
        return tuple(c.channel_id for c in self.channels)

    def sample(self, frame: np.ndarray) -> np.ndarray:
        """Return an ``(n_channels, 3)`` array of linear colours.

        ``frame`` must be ``(grid_height, grid_width, 3)`` of linear floats.
        """
        pixels = frame.reshape(-1, 3)
        regions = self._weights @ pixels
        overall = pixels.mean(axis=0, keepdims=True)
        # Channels near the screen keep their own region; distant ones drift
        # toward the average, which is the honest answer for a lamp behind you.
        return self._affinity * regions + (1.0 - self._affinity) * overall

    # -- construction ------------------------------------------------------

    def _map_channel(self, channel: ChannelPosition) -> ChannelMapping:
        config = self.config

        u = _unit(channel.x)
        # z is bottom-to-top but image rows run top-to-bottom.
        v = 1.0 - _unit(channel.z)

        # Push samples outward so a light at the edge of the room reads the
        # edge of the picture rather than something closer to centre.
        u = _clamp01(0.5 + (u - 0.5) * (1.0 + config.edge_bias))
        v = _clamp01(0.5 + (v - 0.5) * (1.0 + config.edge_bias))

        depth = channel.y if config.screen_at_positive_y else -channel.y
        # depth: +1 at the screen end of the room, -1 at the far end.
        nearness = _clamp01((depth + 1.0) / 2.0)
        affinity = config.rear_region_blend + (1.0 - config.rear_region_blend) * nearness

        return ChannelMapping(channel.channel_id, u, v, affinity)

    def _build_weights(self) -> np.ndarray:
        if not self._mappings:
            return np.zeros((0, self.grid_height * self.grid_width), dtype=np.float32)

        # Pixel centres in normalised coordinates.
        xs = (np.arange(self.grid_width, dtype=np.float32) + 0.5) / self.grid_width
        ys = (np.arange(self.grid_height, dtype=np.float32) + 0.5) / self.grid_height
        grid_x, grid_y = np.meshgrid(xs, ys)

        sigma = max(self.config.spread, 1e-3)
        rows = []
        for mapping in self._mappings:
            distance_sq = (grid_x - mapping.u) ** 2 + (grid_y - mapping.v) ** 2
            weight = np.exp(-distance_sq / (2.0 * sigma * sigma))
            total = float(weight.sum())
            # Renormalise: a kernel centred on an edge is clipped by the frame,
            # and without this those channels would come out darker than the
            # ones in the middle.
            rows.append((weight / total if total > 0 else weight).reshape(-1))

        return np.asarray(rows, dtype=np.float32)


def _unit(value: float) -> float:
    """Map a -1..1 room coordinate to 0..1, tolerating out-of-range values."""
    return _clamp01((float(value) + 1.0) / 2.0)


def _clamp01(value: float) -> float:
    return 0.0 if value < 0.0 else 1.0 if value > 1.0 else value
