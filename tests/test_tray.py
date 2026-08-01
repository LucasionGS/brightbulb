"""The tray item's D-Bus payloads.

Wire shapes only -- the parts a tray host reads. Anything needing a session bus
belongs in manual testing.
"""

from __future__ import annotations

from gi.repository import GLib

from brightbulb.ui.tray import MenuItem, _menu_variant, separator


def test_plain_item_properties() -> None:
    props = MenuItem(label="Quit").properties()
    assert props["label"].get_string() == "Quit"
    assert props["enabled"].get_boolean() is True
    assert props["visible"].get_boolean() is True
    assert "toggle-type" not in props


def test_disabled_item() -> None:
    props = MenuItem(label="Mirror", enabled=False).properties()
    assert props["enabled"].get_boolean() is False


def test_checkmark_item_carries_its_state() -> None:
    """The host draws the tick, so the state has to be pushed to it."""
    on = MenuItem(label="Mirror", checked=True).properties()
    assert on["toggle-type"].get_string() == "checkmark"
    assert on["toggle-state"].get_int32() == 1

    off = MenuItem(label="Mirror", checked=False).properties()
    assert off["toggle-state"].get_int32() == 0


def test_separator_carries_no_label() -> None:
    props = separator().properties()
    assert props == {"type": props["type"]}
    assert props["type"].get_string() == "separator"


def test_layout_node_matches_the_dbusmenu_signature() -> None:
    """``(ia{sv}av)`` is what GetLayout must return; anything else is unreadable.

    Built with the explicit constructors because passing a ready-made Variant
    into a format string makes PyGObject re-walk it as raw Python and fail on
    the nested struct.
    """
    child = _menu_variant(1, MenuItem(label="Quit").properties(), [])
    root = _menu_variant(0, {"children-display": GLib.Variant("s", "submenu")}, [child])

    assert child.get_type_string() == "(ia{sv}av)"
    assert root.get_type_string() == "(ia{sv}av)"

    item_id, props, children = root.unpack()
    assert item_id == 0
    assert props == {"children-display": "submenu"}
    assert children[0][0] == 1
    assert children[0][1]["label"] == "Quit"


def test_layout_survives_a_full_getlayout_reply() -> None:
    reply = GLib.Variant.new_tuple(
        GLib.Variant("u", 7), _menu_variant(0, {}, [_menu_variant(1, {}, [])])
    )
    assert reply.get_type_string() == "(u(ia{sv}av))"
    assert reply.unpack()[0] == 7


def test_empty_menu_is_still_valid() -> None:
    assert _menu_variant(0, {}, []).get_type_string() == "(ia{sv}av)"
