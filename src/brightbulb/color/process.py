"""Turning captured pixels into colours worth sending to lamps.

The chain, in order, and the reason each step sits where it does:

1. **sRGB -> linear.** Screen pixels are gamma-encoded. Averaging them directly
   is the classic mistake: it makes dark scenes noticeably too bright and
   desaturates everything, because a mid-grey byte is not half the light of a
   white one. All averaging must happen in linear light.
2. **Sample regions** (done by the mapper, also in linear).
3. **Saturation and brightness.**
4. **Temporal smoothing**, asymmetric: fast to brighten, slow to fade. A cut to
   a bright scene should feel immediate, while noisy content should not make
   the lamps flicker.
5. **Linear -> sRGB** for transmission. The bridge handles per-lamp gamut
   mapping itself, so no gamut maths is needed here.

The sRGB conversions use a 256-entry lookup table rather than ``pow`` per
pixel; at 60 fps across a whole grid that difference is the bulk of the cost.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

# Rec. 709 luma weights: how much each primary contributes to perceived
# brightness. Used to keep saturation changes from shifting brightness.
_LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)


def _build_srgb_to_linear() -> np.ndarray:
    values = np.arange(256, dtype=np.float32) / 255.0
    return np.where(
        values <= 0.04045, values / 12.92, ((values + 0.055) / 1.055) ** 2.4
    ).astype(np.float32)


SRGB_TO_LINEAR = _build_srgb_to_linear()


def to_linear(frame: np.ndarray) -> np.ndarray:
    """Convert a uint8 sRGB frame to linear floats via lookup."""
    return SRGB_TO_LINEAR[frame]


def to_srgb(linear: np.ndarray) -> np.ndarray:
    """Convert linear floats back to gamma-encoded sRGB in 0..1."""
    clipped = np.clip(linear, 0.0, 1.0)
    return np.where(
        clipped <= 0.0031308,
        clipped * 12.92,
        1.055 * np.power(clipped, 1.0 / 2.4) - 0.055,
    ).astype(np.float32)


@dataclass
class ProcessingSettings:
    """Tunables exposed in the sync UI."""

    brightness: float = 1.0
    saturation: float = 1.2
    # Per-frame blend factors, 0..1. Higher reacts faster.
    attack: float = 0.6
    decay: float = 0.15
    # Colours dimmer than this are pushed to black. Without it, a dark scene
    # leaves lamps glowing a murky grey instead of going properly dark.
    black_point: float = 0.004


class ColorProcessor:
    """Applies the colour chain and remembers state between frames."""

    def __init__(self, channel_count: int, settings: ProcessingSettings | None = None) -> None:
        self.settings = settings or ProcessingSettings()
        self._state = np.zeros((channel_count, 3), dtype=np.float32)
        self._primed = False

    def reset(self) -> None:
        self._state[:] = 0.0
        self._primed = False

    def process(self, linear_colors: np.ndarray) -> np.ndarray:
        """Take ``(n, 3)`` linear colours and return ``(n, 3)`` sRGB in 0..1."""
        adjusted = self._adjust(np.asarray(linear_colors, dtype=np.float32))
        smoothed = self._smooth(adjusted)
        return to_srgb(smoothed)

    # -- steps -------------------------------------------------------------

    def _adjust(self, colors: np.ndarray) -> np.ndarray:
        settings = self.settings

        if settings.saturation != 1.0:
            # Move each colour away from its own grey. Doing this around the
            # luma-preserving grey keeps brightness roughly constant, so raising
            # saturation does not also make everything darker.
            luma = colors @ _LUMA
            grey = luma[:, None]
            colors = grey + (colors - grey) * settings.saturation

        if settings.brightness != 1.0:
            colors = colors * settings.brightness

        colors = np.clip(colors, 0.0, 1.0)

        if settings.black_point > 0.0:
            # Gate on overall level, not per channel, so a dim but saturated
            # colour keeps its hue instead of losing its weakest primary.
            level = colors.max(axis=1, keepdims=True)
            colors = np.where(level < settings.black_point, 0.0, colors)

        return colors

    def _smooth(self, target: np.ndarray) -> np.ndarray:
        if not self._primed:
            # Start from the first real frame; easing up from black would make
            # every session begin with a visible fade-in.
            self._state = target.copy()
            self._primed = True
            return self._state

        settings = self.settings
        brightening = target > self._state
        rate = np.where(brightening, settings.attack, settings.decay).astype(np.float32)
        self._state += (target - self._state) * rate
        return self._state


def to_uint16(srgb: np.ndarray) -> np.ndarray:
    """Scale 0..1 sRGB values to the 16-bit range the protocol carries.

    NaN is scrubbed first: clipping leaves it intact and casting NaN to an
    unsigned integer is undefined, which would put an arbitrary value on the
    wire. Sending black is the safe reading of "no colour".
    """
    safe = np.nan_to_num(srgb, nan=0.0, posinf=1.0, neginf=0.0)
    return (np.clip(safe, 0.0, 1.0) * 65535.0 + 0.5).astype(np.uint16)
