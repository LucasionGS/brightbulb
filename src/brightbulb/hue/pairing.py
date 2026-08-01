"""Bridge pairing -- obtaining an app key and the entertainment client key.

This is deliberately not ``aiohue.util.create_app_key``. That helper posts only
``{"devicetype": ...}`` and returns just the username, so it can never produce
the ``clientkey`` that the Entertainment API needs as its DTLS pre-shared key.
The clientkey is issued **once**, at pairing time, and cannot be recovered
afterwards -- pairing without it means re-pairing later. So we make the request
ourselves, mirroring aiohue's https-then-http fallback and error handling.
"""

from __future__ import annotations

import logging
import socket
from dataclasses import dataclass

from aiohttp import ClientSession
from aiohue.errors import AiohueException, raise_from_error

_LOGGER = logging.getLogger(__name__)

# The bridge enforces "appname#devicename" with tight length limits and rejects
# the whole request if either half is too long.
_APP_NAME_MAX = 20
_DEVICE_NAME_MAX = 19


@dataclass(frozen=True)
class BridgeCredentials:
    """Credentials issued by a bridge at pairing time.

    ``app_key`` authenticates CLIP requests and doubles as the DTLS **PSK
    identity**; ``client_key`` is the hex-encoded **PSK** itself.
    """

    app_key: str
    client_key: str


def default_device_type(app_name: str = "brightbulb") -> str:
    """Build the ``devicetype`` string identifying this install to the bridge."""
    try:
        device = socket.gethostname() or "linux"
    except OSError:
        device = "linux"
    return f"{app_name[:_APP_NAME_MAX]}#{device[:_DEVICE_NAME_MAX]}"


async def create_credentials(
    host: str,
    device_type: str | None = None,
    websession: ClientSession | None = None,
) -> BridgeCredentials:
    """Register with the bridge and return both keys.

    The physical link button must have been pressed within the last ~30 seconds,
    otherwise the bridge answers with error 101 and this raises
    :class:`aiohue.errors.LinkButtonNotPressed`.
    """
    payload = {"devicetype": device_type or default_device_type(), "generateclientkey": True}

    owned_session = websession is None
    session = websession or ClientSession()
    try:
        # The bridge serves a self-signed certificate keyed to its bridge id, so
        # verification is disabled here exactly as aiohue does. Plain http is
        # tried second for older firmware that has not enabled https yet.
        last_error: Exception | None = None
        for scheme in ("https", "http"):
            try:
                async with session.post(f"{scheme}://{host}/api", json=payload, ssl=False) as resp:
                    resp.raise_for_status()
                    body = await resp.json()
            except Exception as err:  # retried on the next scheme
                last_error = err
                _LOGGER.debug("pairing over %s failed: %s", scheme, err)
                continue

            return _parse_response(body)

        assert last_error is not None
        raise last_error
    finally:
        if owned_session:
            await session.close()


def _parse_response(body: object) -> BridgeCredentials:
    """Turn the bridge's reply into credentials, or raise the error it reports."""
    if not isinstance(body, list) or not body:
        raise AiohueException(f"unexpected pairing response: {body!r}")

    result = body[0]
    if not isinstance(result, dict):
        raise AiohueException(f"unexpected pairing response: {body!r}")

    if "error" in result:
        # Raises internally, despite its name and return annotation suggesting
        # it hands an exception back. Falls through to the guard below if that
        # ever changes upstream.
        raise_from_error(result["error"])

    success = result.get("success")
    if not isinstance(success, dict) or "username" not in success:
        raise AiohueException(f"pairing response contained no username: {body!r}")

    client_key = success.get("clientkey")
    if not client_key:
        # Pre-1.22 firmware silently ignores generateclientkey. Light control
        # would still work, but streaming never will, so fail loudly here rather
        # than at the DTLS handshake much later.
        raise AiohueException(
            "bridge issued no clientkey; entertainment streaming requires "
            "bridge firmware with API version 1.22 or newer"
        )

    return BridgeCredentials(app_key=str(success["username"]), client_key=str(client_key))
