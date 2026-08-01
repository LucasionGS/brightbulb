"""The Scenes page: recall saved scenes, grouped by room.

A bridge accumulates a lot of scenes -- most of them Signify's built-in presets,
repeated once per room -- so a flat list of 34 identically-named entries is
useless. Grouping by the room a scene targets is what makes it navigable, since
"Concentrate" only means something alongside the room it applies to.

Scenes carry the colours they will apply, so each row previews them as a strip
of dots. That is far more recognisable than the name alone when several rooms
each have their own "Bright".
"""

from __future__ import annotations

import logging
import math
from typing import TYPE_CHECKING, Any

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")

from gi.repository import Adw, Gtk  # noqa: E402

from brightbulb.color.convert import mirek_to_rgb, xy_to_rgb  # noqa: E402

if TYPE_CHECKING:
    from brightbulb.app import BrightBulbApplication

_LOGGER = logging.getLogger(__name__)

# Enough dots to convey a palette without turning the row into a bar chart.
_MAX_SWATCHES = 6


class ScenePreview(Gtk.DrawingArea):
    """A row of dots showing the colours a scene will apply."""

    def __init__(self) -> None:
        super().__init__()
        self.set_content_height(16)
        self.set_valign(Gtk.Align.CENTER)
        self._colors: list[tuple[float, float, float]] = []
        self.set_draw_func(self._draw)

    def set_colors(self, colors: list[tuple[float, float, float]]) -> None:
        self._colors = colors[:_MAX_SWATCHES]
        self.set_content_width(max(1, len(self._colors)) * 18)
        self.queue_draw()

    def _draw(self, _area: Gtk.DrawingArea, cr: Any, width: int, height: int) -> None:
        if not self._colors:
            return
        radius = 6.0
        step = 18.0
        for index, (red, green, blue) in enumerate(self._colors):
            cr.arc(radius + index * step, height / 2.0, radius, 0, 2 * math.pi)
            cr.set_source_rgb(red, green, blue)
            cr.fill()


class ScenesPage(Adw.Bin):
    """Lists every scene on the bridge, grouped by the room it targets."""

    def __init__(self, app: BrightBulbApplication) -> None:
        super().__init__()
        self.app = app
        self._layout_key: tuple[tuple[str, tuple[str, ...]], ...] | None = None
        self._groups: list[Adw.PreferencesGroup] = []

        self._page = Adw.PreferencesPage()
        self._empty = Adw.StatusPage(
            title="No scenes",
            description="Scenes you create in the Hue app appear here.",
            icon_name="view-paged-symbolic",
        )
        self._stack = Gtk.Stack()
        self._stack.add_named(self._empty, "empty")
        self._stack.add_named(self._page, "scenes")
        self.set_child(self._stack)

    def refresh(self, bridge: Any) -> None:
        """Rebuild the list when the set of scenes changes. GTK thread only."""
        grouped = _group_scenes(bridge)
        key = tuple(
            (name, tuple(scene.id for scene in scenes)) for name, scenes in grouped
        )
        if key == self._layout_key:
            return
        self._layout_key = key

        for group in self._groups:
            self._page.remove(group)
        self._groups.clear()

        for room_name, scenes in grouped:
            group = Adw.PreferencesGroup(title=room_name)
            for scene in scenes:
                group.add(self._build_row(bridge, scene))
            self._page.add(group)
            self._groups.append(group)

        self._stack.set_visible_child_name("scenes" if grouped else "empty")

    def _build_row(self, bridge: Any, scene: Any) -> Gtk.Widget:
        row = Adw.ActionRow(
            title=_scene_name(scene),
            activatable=True,
            tooltip_text=f"Apply {_scene_name(scene)}",
        )

        preview = ScenePreview()
        preview.set_colors(_scene_colors(scene))
        row.add_prefix(preview)

        if _is_active(scene):
            badge = Gtk.Image(icon_name="object-select-symbolic",
                              tooltip_text="Currently applied")
            row.add_suffix(badge)

        row.connect("activated", lambda _row, s=scene: self._recall(bridge, s))
        return row

    def _recall(self, bridge: Any, scene: Any) -> None:
        name = _scene_name(scene)
        self.app.runner.run_and_then(
            bridge.scenes.recall(scene.id),
            on_done=lambda _: self._toast(f"Applied {name}"),
            on_error=lambda err: self._toast(f"Could not apply {name}: {err}"),
        )

    def _toast(self, message: str) -> None:
        window = self.get_root()
        if hasattr(window, "toast"):
            window.toast(message)


# -- helpers ---------------------------------------------------------------


def _scene_name(scene: Any) -> str:
    metadata = getattr(scene, "metadata", None)
    return str(getattr(metadata, "name", None) or "Scene")


def _is_active(scene: Any) -> bool:
    status = getattr(scene, "status", None)
    active = getattr(status, "active", None)
    return str(getattr(active, "value", active) or "").lower() not in ("", "inactive")


def _group_scenes(bridge: Any) -> list[tuple[str, list[Any]]]:
    """Scenes bucketed by the room or zone they apply to, both sorted by name."""
    buckets: dict[str, list[Any]] = {}
    for scene in bridge.scenes:
        group = bridge.scenes.get_group(scene.id)
        metadata = getattr(group, "metadata", None) if group else None
        name = str(getattr(metadata, "name", None) or "Other")
        buckets.setdefault(name, []).append(scene)

    for scenes in buckets.values():
        scenes.sort(key=lambda s: _scene_name(s).lower())
    return sorted(buckets.items(), key=lambda item: item[0].lower())


def _scene_colors(scene: Any) -> list[tuple[float, float, float]]:
    """Extract the colours a scene sets, for the preview strip."""
    colors: list[tuple[float, float, float]] = []
    for action in getattr(scene, "actions", []) or []:
        target = getattr(action, "action", None)
        if target is None:
            continue

        # Scenes store brightness separately from colour; fold it in so a dim
        # scene previews dim, but keep a floor so the dot stays visible.
        dimming = getattr(target, "dimming", None)
        brightness = float(getattr(dimming, "brightness", 100.0) or 100.0) / 100.0
        brightness = max(0.35, brightness)

        color = getattr(target, "color", None)
        xy = getattr(color, "xy", None)
        if xy is not None:
            colors.append(xy_to_rgb((xy.x, xy.y), brightness))
            continue

        temperature = getattr(target, "color_temperature", None)
        mirek = getattr(temperature, "mirek", None)
        if mirek:
            red, green, blue = mirek_to_rgb(int(mirek))
            colors.append((red * brightness, green * brightness, blue * brightness))

    return colors
