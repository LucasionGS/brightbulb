"""Conversion between sRGB, CIE xy and colour temperature.

The Hue API speaks CIE xy chromaticity; GTK's colour picker speaks sRGB. Every
lamp model also has a different *gamut* -- the triangle of colours it can
physically produce -- and asking for a colour outside it produces something
visibly wrong rather than an error, so requested colours are clamped to the
lamp's own triangle first.

Matrices and gamut corners follow Signify's published conversion for Hue lamps,
which uses a Wide-RGB D65 primary set rather than plain sRGB.
"""

from __future__ import annotations

import math
from typing import NamedTuple

RGB = tuple[float, float, float]
XY = tuple[float, float]


class Point(NamedTuple):
    x: float
    y: float


class Gamut(NamedTuple):
    """The triangle of colours a lamp can reproduce."""

    red: Point
    green: Point
    blue: Point


# Gamut A: original Hue bulbs. B: later bulbs / Lightstrips. C: current colour
# lamps and Play bars, the widest of the three.
GAMUT_A = Gamut(Point(0.704, 0.296), Point(0.2151, 0.7106), Point(0.138, 0.08))
GAMUT_B = Gamut(Point(0.675, 0.322), Point(0.409, 0.518), Point(0.167, 0.04))
GAMUT_C = Gamut(Point(0.692, 0.308), Point(0.17, 0.7), Point(0.153, 0.048))

GAMUTS = {"A": GAMUT_A, "B": GAMUT_B, "C": GAMUT_C}

# Fallback for lamps that report no gamut: the widest, so nothing is clipped
# more than the lamp itself will clip it.
DEFAULT_GAMUT = GAMUT_C


def _gamma_expand(channel: float) -> float:
    """sRGB -> linear."""
    return channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4


def _gamma_compress(channel: float) -> float:
    """Linear -> sRGB."""
    return 12.92 * channel if channel <= 0.0031308 else 1.055 * channel ** (1 / 2.4) - 0.055


def rgb_to_xy(rgb: RGB, gamut: Gamut | None = None) -> XY:
    """Convert sRGB (0-1 per channel) to a CIE xy point inside ``gamut``."""
    red, green, blue = (_gamma_expand(_clamp01(c)) for c in rgb)

    x_val = red * 0.649926 + green * 0.103455 + blue * 0.197109
    y_val = red * 0.234327 + green * 0.743075 + blue * 0.022598
    z_val = red * 0.000000 + green * 0.053077 + blue * 1.035763

    total = x_val + y_val + z_val
    if total == 0:
        # Pure black has no chromaticity; report the gamut's red corner and let
        # brightness carry the "off" meaning.
        point = (gamut or DEFAULT_GAMUT).red
        return (point.x, point.y)

    return clamp_to_gamut((x_val / total, y_val / total), gamut)


def xy_to_rgb(xy: XY, brightness: float = 1.0, gamut: Gamut | None = None) -> RGB:
    """Convert a CIE xy point plus brightness (0-1) to sRGB (0-1 per channel)."""
    x, y = clamp_to_gamut(xy, gamut)
    if y == 0:
        return (0.0, 0.0, 0.0)

    luminance = _clamp01(brightness)
    x_val = (luminance / y) * x
    z_val = (luminance / y) * (1.0 - x - y)

    red = x_val * 1.4628067 - luminance * 0.1840623 - z_val * 0.2743606
    green = -x_val * 0.5217933 + luminance * 1.4472381 + z_val * 0.0677227
    blue = x_val * 0.0349342 - luminance * 0.0968930 + z_val * 1.2884099

    # The matrix can produce small negatives for in-gamut colours; clip before
    # gamma or the curve returns NaN.
    channels = [max(0.0, c) for c in (red, green, blue)]

    # Rescale rather than clip when something overflows, so hue is preserved
    # instead of drifting toward white.
    peak = max(channels)
    if peak > 1.0:
        channels = [c / peak for c in channels]

    return tuple(_clamp01(_gamma_compress(c)) for c in channels)  # type: ignore[return-value]


def clamp_to_gamut(xy: XY, gamut: Gamut | None = None) -> XY:
    """Return ``xy`` if the lamp can produce it, otherwise the nearest point it can."""
    gamut = gamut or DEFAULT_GAMUT
    point = Point(*xy)
    if _in_triangle(point, gamut):
        return (point.x, point.y)

    candidates = [
        _closest_on_segment(gamut.red, gamut.green, point),
        _closest_on_segment(gamut.green, gamut.blue, point),
        _closest_on_segment(gamut.blue, gamut.red, point),
    ]
    nearest = min(candidates, key=lambda p: _distance(p, point))
    return (nearest.x, nearest.y)


def gamut_for(gamut_type: object) -> Gamut:
    """Map a Hue ``gamut_type`` to its triangle.

    Accepts the plain string ("A"/"B"/"C") or aiohue's ``GamutType`` enum, since
    the model hands back the enum but tests and config use strings. Anything
    unrecognised falls back to the widest gamut rather than raising -- a new lamp
    family should not break the light list.
    """
    if not gamut_type:
        return DEFAULT_GAMUT
    value = getattr(gamut_type, "value", gamut_type)
    if not isinstance(value, str):
        return DEFAULT_GAMUT
    return GAMUTS.get(value.upper(), DEFAULT_GAMUT)


def mirek_to_rgb(mirek: int) -> RGB:
    """Approximate the visible colour of a white setting given in mireds.

    Used only to tint the UI so a warm white looks warm; the lamp is always
    driven by the mired value itself, never by this approximation.
    """
    kelvin = 1_000_000 / max(1, mirek)
    temp = kelvin / 100.0

    if temp <= 66:
        red = 255.0
        green = 99.4708025861 * math.log(temp) - 161.1195681661 if temp > 0 else 0.0
    else:
        red = 329.698727446 * ((temp - 60) ** -0.1332047592)
        green = 288.1221695283 * ((temp - 60) ** -0.0755148492)

    if temp >= 66:
        blue = 255.0
    elif temp <= 19:
        blue = 0.0
    else:
        blue = 138.5177312231 * math.log(temp - 10) - 305.0447927307

    return (_clamp01(red / 255), _clamp01(green / 255), _clamp01(blue / 255))


def _clamp01(value: float) -> float:
    return 0.0 if value < 0.0 else 1.0 if value > 1.0 else value


# Points landing exactly on an edge or corner -- which is precisely what
# clamp_to_gamut produces -- can fall a fraction outside in binary floating
# point. Without tolerance, clamping a colour and re-testing it would report the
# result as still out of gamut.
_TRIANGLE_EPSILON = 1e-9


def _in_triangle(point: Point, gamut: Gamut) -> bool:
    """Barycentric containment test against the gamut triangle, inclusive of its edges."""
    v1 = Point(gamut.green.x - gamut.red.x, gamut.green.y - gamut.red.y)
    v2 = Point(gamut.blue.x - gamut.red.x, gamut.blue.y - gamut.red.y)
    q = Point(point.x - gamut.red.x, point.y - gamut.red.y)

    denominator = v1.x * v2.y - v2.x * v1.y
    if denominator == 0:
        return False

    s = (q.x * v2.y - v2.x * q.y) / denominator
    t = (v1.x * q.y - q.x * v1.y) / denominator
    return (
        s >= -_TRIANGLE_EPSILON
        and t >= -_TRIANGLE_EPSILON
        and s + t <= 1.0 + _TRIANGLE_EPSILON
    )


def _closest_on_segment(start: Point, end: Point, point: Point) -> Point:
    """Project ``point`` onto the segment, clamped to its endpoints."""
    ap = Point(point.x - start.x, point.y - start.y)
    ab = Point(end.x - start.x, end.y - start.y)

    ab_squared = ab.x * ab.x + ab.y * ab.y
    if ab_squared == 0:
        return start

    t = max(0.0, min(1.0, (ap.x * ab.x + ap.y * ab.y) / ab_squared))
    return Point(start.x + ab.x * t, start.y + ab.y * t)


def _distance(a: Point, b: Point) -> float:
    return math.hypot(a.x - b.x, a.y - b.y)
