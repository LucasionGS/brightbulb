"""Tests for sRGB <-> CIE xy conversion and gamut clamping."""

from __future__ import annotations

import pytest

from brightbulb.color.convert import (
    GAMUT_A,
    GAMUT_B,
    GAMUT_C,
    Point,
    clamp_to_gamut,
    gamut_for,
    mirek_to_rgb,
    rgb_to_xy,
    xy_to_rgb,
)


def test_white_lands_near_d65() -> None:
    x, y = rgb_to_xy((1.0, 1.0, 1.0))
    assert x == pytest.approx(0.3227, abs=0.01)
    assert y == pytest.approx(0.3290, abs=0.01)


@pytest.mark.parametrize(
    ("rgb", "dominant"),
    [((1.0, 0.0, 0.0), 0), ((0.0, 1.0, 0.0), 1), ((0.0, 0.0, 1.0), 2)],
)
def test_primaries_round_trip_keeping_their_dominant_channel(
    rgb: tuple[float, float, float], dominant: int
) -> None:
    """A primary must come back as the same primary.

    Exact values shift because the lamp gamut cannot reach sRGB's corners; what
    must survive is which channel dominates.
    """
    result = xy_to_rgb(rgb_to_xy(rgb, GAMUT_C), brightness=1.0, gamut=GAMUT_C)
    assert result[dominant] == max(result)
    assert result[dominant] > 0.5


def test_black_does_not_divide_by_zero() -> None:
    x, y = rgb_to_xy((0.0, 0.0, 0.0), GAMUT_C)
    assert 0.0 <= x <= 1.0
    assert 0.0 <= y <= 1.0


def test_zero_brightness_is_black() -> None:
    assert xy_to_rgb((0.4, 0.4), brightness=0.0) == (0.0, 0.0, 0.0)


@pytest.mark.parametrize("gamut", [GAMUT_A, GAMUT_B, GAMUT_C])
def test_out_of_gamut_point_is_pulled_onto_the_triangle(gamut) -> None:
    """A wildly out-of-range point must land on the gamut, not be passed through."""
    clamped = clamp_to_gamut((0.9, 0.05), gamut)
    assert clamped != (0.9, 0.05)
    # Re-clamping is a no-op once inside.
    assert clamp_to_gamut(clamped, gamut) == pytest.approx(clamped, abs=1e-9)


@pytest.mark.parametrize("gamut", [GAMUT_A, GAMUT_B, GAMUT_C])
def test_gamut_corners_survive_clamping(gamut) -> None:
    for corner in (gamut.red, gamut.green, gamut.blue):
        assert clamp_to_gamut((corner.x, corner.y), gamut) == pytest.approx(
            (corner.x, corner.y), abs=1e-9
        )


def test_interior_point_is_untouched() -> None:
    inside = (0.35, 0.35)
    assert clamp_to_gamut(inside, GAMUT_C) == pytest.approx(inside, abs=1e-9)


def test_gamut_lookup_is_case_insensitive_and_defaults_wide() -> None:
    assert gamut_for("b") is GAMUT_B
    assert gamut_for("C") is GAMUT_C
    assert gamut_for(None) is GAMUT_C
    assert gamut_for("nonsense") is GAMUT_C


def test_rgb_to_xy_never_escapes_the_lamp_gamut() -> None:
    """Every representable sRGB colour must map to something the lamp can show."""
    from brightbulb.color.convert import _in_triangle

    for r in (0.0, 0.5, 1.0):
        for g in (0.0, 0.5, 1.0):
            for b in (0.0, 0.5, 1.0):
                xy = rgb_to_xy((r, g, b), GAMUT_A)
                assert _in_triangle(Point(*xy), GAMUT_A), f"{(r, g, b)} escaped gamut A"


def test_warm_light_is_redder_than_cool_light() -> None:
    warm = mirek_to_rgb(500)  # 2000K
    cool = mirek_to_rgb(153)  # ~6500K
    assert warm[0] - warm[2] > cool[0] - cool[2]


@pytest.mark.parametrize("mirek", [153, 250, 370, 500])
def test_mirek_conversion_stays_in_range(mirek: int) -> None:
    assert all(0.0 <= c <= 1.0 for c in mirek_to_rgb(mirek))
