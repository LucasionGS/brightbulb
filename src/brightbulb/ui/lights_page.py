"""The Lights page: every light, grouped by the room it belongs to.

Rows are built once and then updated in place. Rebuilding the list on every
event would be simpler, but the bridge emits a burst of events for any group
change, and rebuilding would collapse expanded rows and interrupt a drag
several times a second.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")

from gi.repository import Adw, Gtk  # noqa: E402

from brightbulb.ui.light_row import LightRow  # noqa: E402

if TYPE_CHECKING:
    from brightbulb.hue.lights import LightWriter

_LOGGER = logging.getLogger(__name__)

# Lights that belong to no room still need a home.
_UNGROUPED = "__ungrouped__"


class LightsPage(Adw.Bin):
    """Live list of all lights on the bridge."""

    def __init__(self, writer: LightWriter) -> None:
        super().__init__()
        self._writer = writer
        self._rows: dict[str, LightRow] = {}
        self._groups: dict[str, Adw.PreferencesGroup] = {}
        self._group_switches: dict[str, Gtk.Switch] = {}
        # room id -> its grouped_light resource, when it has one
        self._grouped_light_ids: dict[str, str] = {}
        # room id -> member light ids, the fallback when it does not
        self._room_lights: dict[str, list[str]] = {}
        self._layout_key: tuple[tuple[str, tuple[str, ...]], ...] | None = None
        self._updating_group_switch = False

        self._page = Adw.PreferencesPage()
        self.set_child(self._page)

    def refresh(self, bridge: Any) -> None:
        """Rebuild or update the list to match the bridge. Runs on the GTK thread."""
        layout = _layout_of(bridge)
        key = tuple((room_id, tuple(ids)) for room_id, _, ids in layout)

        if key != self._layout_key:
            self._rebuild(bridge, layout)
            self._layout_key = key

        lights = {light.id: light for light in bridge.lights}
        unreachable = _unreachable_devices(bridge)
        for light_id, row in self._rows.items():
            light = lights.get(light_id)
            if light is not None:
                row.update(light, reachable=light.owner.rid not in unreachable)

        self._update_group_switches(bridge, layout)

    # -- construction ------------------------------------------------------

    def _rebuild(self, bridge: Any, layout: list[tuple[str, str, list[str]]]) -> None:
        for group in self._groups.values():
            self._page.remove(group)
        self._groups.clear()
        self._group_switches.clear()
        self._grouped_light_ids.clear()
        self._room_lights.clear()
        self._rows.clear()

        lights = {light.id: light for light in bridge.lights}
        rooms = {room.id: room for room in bridge.groups.room}

        for room_id, room_name, light_ids in layout:
            self._room_lights[room_id] = list(light_ids)
            room = rooms.get(room_id)
            if room is not None and room.grouped_light:
                self._grouped_light_ids[room_id] = room.grouped_light

            group = Adw.PreferencesGroup(title=room_name)

            switch = Gtk.Switch(valign=Gtk.Align.CENTER, tooltip_text=f"All lights in {room_name}")
            switch.connect("notify::active", self._on_group_toggled, room_id)
            self._group_switches[room_id] = switch
            group.set_header_suffix(switch)

            for light_id in light_ids:
                light = lights.get(light_id)
                if light is None:
                    continue
                row = LightRow(light, self._writer)
                self._rows[light_id] = row
                group.add(row)

            self._page.add(group)
            self._groups[room_id] = group

    def _update_group_switches(
        self, bridge: Any, layout: list[tuple[str, str, list[str]]]
    ) -> None:
        """A room's switch is on when any light in it is on."""
        lights = {light.id: light for light in bridge.lights}
        self._updating_group_switch = True
        try:
            for room_id, _, light_ids in layout:
                switch = self._group_switches.get(room_id)
                if switch is None:
                    continue
                any_on = any(
                    lights[lid].is_on for lid in light_ids if lid in lights
                )
                if switch.get_active() != any_on:
                    switch.set_active(any_on)
        finally:
            self._updating_group_switch = False

    # -- group control -----------------------------------------------------

    def _on_group_toggled(self, switch: Gtk.Switch, _param: object, room_id: str) -> None:
        if self._updating_group_switch:
            return
        on = switch.get_active()
        grouped_light_id = self._grouped_light_ids.get(room_id)
        if grouped_light_id is not None:
            # One request for the whole room: the lamps respond together instead
            # of cascading one by one.
            self._writer.queue_group(grouped_light_id, on=on)
            return
        for light_id in self._room_lights.get(room_id, ()):
            self._writer.queue(light_id, on=on)


def _unreachable_devices(bridge: Any) -> set[str]:
    """Device ids the bridge currently cannot reach over Zigbee.

    Keyed by device rather than light because connectivity is reported per
    device, and a multi-light fixture shares one radio.
    """
    unreachable: set[str] = set()
    try:
        for service in bridge.sensors.zigbee_connectivity:
            status = getattr(service.status, "value", service.status)
            if str(status).lower() != "connected":
                unreachable.add(service.owner.rid)
    except Exception:  # a bridge without the service must not break the list
        _LOGGER.debug("could not read zigbee connectivity", exc_info=True)
    return unreachable


def _layout_of(bridge: Any) -> list[tuple[str, str, list[str]]]:
    """Rooms (and their lights) in display order, plus any ungrouped lights."""
    layout: list[tuple[str, str, list[str]]] = []
    claimed: set[str] = set()

    rooms = sorted(bridge.groups.room, key=lambda r: (r.metadata.name or "").lower())
    for room in rooms:
        light_ids = [light.id for light in bridge.groups.room.get_lights(room.id)]
        if not light_ids:
            # An empty room is configuration noise, not something to show.
            continue
        claimed.update(light_ids)
        layout.append((room.id, room.metadata.name or "Room", sorted_by_name(bridge, light_ids)))

    orphans = [light.id for light in bridge.lights if light.id not in claimed]
    if orphans:
        layout.append((_UNGROUPED, "Other lights", sorted_by_name(bridge, orphans)))

    return layout


def sorted_by_name(bridge: Any, light_ids: list[str]) -> list[str]:
    lights = {light.id: light for light in bridge.lights}

    def name_of(light_id: str) -> str:
        light = lights.get(light_id)
        if light is not None and light.metadata and light.metadata.name:
            return str(light.metadata.name).lower()
        return ""

    return sorted(light_ids, key=name_of)
