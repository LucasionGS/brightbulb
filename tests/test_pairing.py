"""Tests for parsing the bridge's pairing response.

The bridge's reply shapes are the part worth pinning down: they are quirky
(everything wrapped in a single-element list), and getting them wrong surfaces
much later as a failed DTLS handshake rather than a pairing error.
"""

from __future__ import annotations

import pytest
from aiohue.errors import AiohueException, LinkButtonNotPressed

from brightbulb.hue.pairing import _parse_response, default_device_type


def test_parses_username_and_clientkey() -> None:
    creds = _parse_response(
        [{"success": {"username": "abc123", "clientkey": "0123456789ABCDEF"}}]
    )
    assert creds.app_key == "abc123"
    assert creds.client_key == "0123456789ABCDEF"


def test_link_button_not_pressed_raises_typed_error() -> None:
    body = [{"error": {"type": 101, "address": "", "description": "link button not pressed"}}]
    with pytest.raises(LinkButtonNotPressed):
        _parse_response(body)


def test_missing_clientkey_fails_loudly() -> None:
    """Old firmware ignores generateclientkey and returns only a username.

    Accepting that would let pairing 'succeed' and leave streaming permanently
    broken with no way back except re-pairing.
    """
    with pytest.raises(AiohueException, match=r"1\.22"):
        _parse_response([{"success": {"username": "abc123"}}])


@pytest.mark.parametrize("body", [[], {}, [None], ["nope"], [{}]])
def test_malformed_responses_raise(body: object) -> None:
    with pytest.raises(AiohueException):
        _parse_response(body)


def test_device_type_respects_bridge_length_limits() -> None:
    device_type = default_device_type("averyveryverylongapplicationname")
    app, _, device = device_type.partition("#")
    assert len(app) <= 20
    assert len(device) <= 19
    assert "#" in device_type
