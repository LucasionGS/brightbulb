"""A single light's controls.

Collapsed, a row is a colour dot, a name and a switch. Expanded, it reveals
brightness, colour and colour-temperature controls -- but only the ones the lamp
actually has, so a smart plug shows just its switch and a white-only bulb never
offers a colour picker.

Two-way binding needs care. The bridge echoes every change back over the event
stream, so applying inbound state unconditionally makes a slider jump backwards
under the user's finger mid-drag. Rather than guessing at drag state from focus
(which persists after release), each outbound change opens a short suppression
window during which inbound updates are ignored for this row.
"""

from __future__ import annotations

import logging
import math
import time
from typing import TYPE_CHECKING, Any

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")

from gi.repository import Adw, Gdk, Gtk  # noqa: E402

from brightbulb.color.convert import gamut_for, mirek_to_rgb, rgb_to_xy, xy_to_rgb  # noqa: E402

if TYPE_CHECKING:
    from brightbulb.hue.lights import LightWriter

_LOGGER = logging.getLogger(__name__)

# Hue treats brightness as a percentage where 0 is not "dimmest" but invalid
# while the lamp is on, so the slider bottoms out just above it.
_MIN_BRIGHTNESS = 1.0

# How long after a local change to ignore echoed state for this row. Comfortably
# longer than a bridge round trip, short enough that a change made in the Hue app
# still shows up promptly.
_SUPPRESS_SECONDS = 0.8

_ARCHETYPE_ICONS = {
    "hue_lightstrip": "view-continuous-symbolic",
    "hue_go": "media-playback-start-symbolic",
    "plug": "preferences-system-symbolic",
    "spot_bulb": "display-brightness-symbolic",
    "ceiling_round": "display-brightness-symbolic",
    "wall_washer": "video-display-symbolic",
}
_DEFAULT_ICON = "weather-clear-symbolic"


class ColorDot(Gtk.DrawingArea):
    """A small filled circle showing the colour a lamp is currently showing.

    Drawn rather than styled: per-widget CSS in GTK4 means either a deprecated
    style-context provider or a global stylesheet, and neither is worth it for
    a dot whose colour changes on every event.
    """

    def __init__(self) -> None:
        super().__init__()
        self.set_content_width(16)
        self.set_content_height(16)
        self.set_valign(Gtk.Align.CENTER)
        self._rgb: tuple[float, float, float] | None = None
        self.set_draw_func(self._draw)

    def set_color(self, rgb: tuple[float, float, float] | None) -> None:
        if rgb == self._rgb:
            return
        self._rgb = rgb
        self.queue_draw()

    def _draw(self, _area: Gtk.DrawingArea, cr: Any, width: int, height: int) -> None:
        radius = min(width, height) / 2.0 - 1.0
        cr.arc(width / 2.0, height / 2.0, radius, 0, 2 * math.pi)

        if self._rgb is None:
            # Off: a hollow ring, so the row still reads as a light without
            # implying a colour.
            cr.set_source_rgba(0.5, 0.5, 0.5, 0.55)
            cr.set_line_width(1.5)
            cr.stroke()
            return

        cr.set_source_rgb(*self._rgb)
        cr.fill()


class LightRow(Adw.ExpanderRow):
    """Controls for one light, kept in sync with the bridge."""

    def __init__(self, light: Any, writer: LightWriter) -> None:
        super().__init__()

        self.light_id: str = light.id
        self._writer = writer
        self._updating = False
        self._suppress_until = 0.0
        self._gamut = gamut_for(getattr(light.color, "gamut_type", None))

        # One prefix box rather than two prefixes: separate prefixes are packed
        # flush against each other and against the title.
        prefix = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10,
                         valign=Gtk.Align.CENTER, margin_end=6)
        self._dot = ColorDot()
        prefix.append(self._dot)
        prefix.append(Gtk.Image(icon_name=_icon_for(light), pixel_size=16))
        self.add_prefix(prefix)

        self._warning = Gtk.Image(
            icon_name="dialog-warning-symbolic",
            valign=Gtk.Align.CENTER,
            visible=False,
            tooltip_text="The bridge cannot reach this light. It may be switched "
            "off at the wall, or out of range.",
        )
        self.add_suffix(self._warning)

        self._switch = Gtk.Switch(valign=Gtk.Align.CENTER)
        self._switch.connect("notify::active", self._on_switch_toggled)
        self.add_suffix(self._switch)

        self._brightness_scale: Gtk.Scale | None = None
        self._color_button: Gtk.ColorDialogButton | None = None
        self._temperature_scale: Gtk.Scale | None = None

        if light.supports_dimming:
            self.add_row(self._build_brightness_row())
        if light.supports_color:
            self.add_row(self._build_color_row())
        if light.supports_color_temperature:
            self.add_row(self._build_temperature_row(light))

        self._expandable = bool(
            light.supports_dimming
            or light.supports_color
            or light.supports_color_temperature
        )
        if not self._expandable:
            # A plug has nothing to reveal; leave it as a plain switch row.
            self.set_enable_expansion(False)

        self.update(light)

    # -- construction ------------------------------------------------------

    def _build_brightness_row(self) -> Gtk.Widget:
        self._brightness_scale = Gtk.Scale.new_with_range(
            Gtk.Orientation.HORIZONTAL, _MIN_BRIGHTNESS, 100.0, 1.0
        )
        self._brightness_scale.set_hexpand(True)
        self._brightness_scale.set_draw_value(True)
        self._brightness_scale.set_value_pos(Gtk.PositionType.RIGHT)
        self._brightness_scale.set_size_request(220, -1)
        self._brightness_scale.connect("value-changed", self._on_brightness_changed)

        row = Adw.ActionRow(title="Brightness")
        row.add_prefix(Gtk.Image(icon_name="display-brightness-symbolic"))
        row.add_suffix(self._brightness_scale)
        return row

    def _build_color_row(self) -> Gtk.Widget:
        self._color_button = Gtk.ColorDialogButton(
            dialog=Gtk.ColorDialog(with_alpha=False), valign=Gtk.Align.CENTER
        )
        self._color_button.connect("notify::rgba", self._on_color_changed)

        row = Adw.ActionRow(title="Colour")
        row.add_prefix(Gtk.Image(icon_name="applications-graphics-symbolic"))
        row.add_suffix(self._color_button)
        return row

    def _build_temperature_row(self, light: Any) -> Gtk.Widget:
        # Lamps differ in how warm and how cool they can go, so use the range
        # the lamp reports rather than a hardcoded one.
        schema = getattr(light.color_temperature, "mirek_schema", None)
        minimum = getattr(schema, "mirek_minimum", None) or 153
        maximum = getattr(schema, "mirek_maximum", None) or 500

        self._temperature_scale = Gtk.Scale.new_with_range(
            Gtk.Orientation.HORIZONTAL, float(minimum), float(maximum), 1.0
        )
        self._temperature_scale.set_hexpand(True)
        self._temperature_scale.set_draw_value(False)
        self._temperature_scale.set_size_request(220, -1)
        self._temperature_scale.connect("value-changed", self._on_temperature_changed)

        row = Adw.ActionRow(title="White")
        row.add_prefix(Gtk.Image(icon_name="weather-clear-night-symbolic"))
        row.add_suffix(self._temperature_scale)
        return row

    # -- inbound: bridge -> widgets ---------------------------------------

    def update(self, light: Any, reachable: bool = True) -> None:
        """Apply the bridge's current state without triggering writes back.

        ``reachable`` comes from the lamp's Zigbee connectivity. Note that the
        bridge reports CONNECTIVITY_ISSUE for any lamp it cannot currently hear
        from, which most often means the lamp is simply switched off at the wall
        rather than faulty. Controls therefore stay enabled -- flipping the wall
        switch back on should not require the app to catch up first -- and the
        row only carries a quiet hint.
        """
        settled = time.monotonic() >= self._suppress_until

        self._updating = True
        try:
            self.set_title(_display_name(light))
            self.set_subtitle(_describe(light) + ("  ·  not responding" if not reachable else ""))
            self._warning.set_visible(not reachable)

            rgb = _current_rgb(light, self._gamut)
            self._dot.set_color(rgb if light.is_on else None)

            if not settled:
                # Mid-interaction: title/subtitle are safe to refresh, but the
                # controls belong to the user until they stop moving them.
                return

            if self._switch.get_active() != light.is_on:
                self._switch.set_active(light.is_on)

            if self._brightness_scale is not None and light.supports_dimming:
                value = max(_MIN_BRIGHTNESS, float(light.brightness))
                if abs(self._brightness_scale.get_value() - value) > 0.5:
                    self._brightness_scale.set_value(value)

            if self._color_button is not None and rgb is not None:
                self._color_button.set_rgba(_to_rgba(rgb))

            if (
                self._temperature_scale is not None
                and light.color_temperature is not None
                and light.color_temperature.mirek is not None
            ):
                mirek = float(light.color_temperature.mirek)
                if abs(self._temperature_scale.get_value() - mirek) > 1.0:
                    self._temperature_scale.set_value(mirek)
        finally:
            self._updating = False

    # -- outbound: widgets -> bridge --------------------------------------

    def _touch(self) -> None:
        self._suppress_until = time.monotonic() + _SUPPRESS_SECONDS

    def _on_switch_toggled(self, *_: object) -> None:
        if self._updating:
            return
        self._touch()
        self._writer.queue(self.light_id, on=self._switch.get_active())

    def _on_brightness_changed(self, scale: Gtk.Scale) -> None:
        if self._updating:
            return
        self._touch()
        # Dragging brightness on a lamp that is off should turn it on -- that is
        # what every other Hue client does and what the gesture implies.
        self._writer.queue(self.light_id, on=True, brightness=scale.get_value())

    def _on_color_changed(self, *_: object) -> None:
        if self._updating or self._color_button is None:
            return
        self._touch()
        rgba = self._color_button.get_rgba()
        xy = rgb_to_xy((rgba.red, rgba.green, rgba.blue), self._gamut)
        self._writer.queue(self.light_id, on=True, color_xy=xy)

    def _on_temperature_changed(self, scale: Gtk.Scale) -> None:
        if self._updating:
            return
        self._touch()
        self._writer.queue(self.light_id, on=True, color_temp=int(scale.get_value()))


# -- helpers ---------------------------------------------------------------


def _icon_for(light: Any) -> str:
    archetype = getattr(light.metadata, "archetype", None) if light.metadata else None
    return _ARCHETYPE_ICONS.get(archetype or "", _DEFAULT_ICON)


def _display_name(light: Any) -> str:
    if light.metadata and light.metadata.name:
        return str(light.metadata.name)
    return "Light"


def _describe(light: Any) -> str:
    if not light.is_on:
        return "Off"
    if light.supports_dimming:
        return f"On · {round(light.brightness)}%"
    return "On"


def _current_rgb(light: Any, gamut: Any) -> tuple[float, float, float] | None:
    """Best guess at the colour the lamp is currently showing."""
    brightness = (light.brightness / 100.0) if light.supports_dimming else 1.0
    # Keep the dot readable when dimmed: it conveys hue, not output level.
    brightness = max(0.45, brightness)

    if light.color is not None and light.color.xy is not None:
        return xy_to_rgb((light.color.xy.x, light.color.xy.y), brightness, gamut)
    if light.color_temperature is not None and light.color_temperature.mirek:
        return mirek_to_rgb(light.color_temperature.mirek)
    return None


def _to_rgba(rgb: tuple[float, float, float]) -> Gdk.RGBA:
    rgba = Gdk.RGBA()
    rgba.red, rgba.green, rgba.blue, rgba.alpha = (*rgb, 1.0)
    return rgba
