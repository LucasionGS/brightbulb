"""Finding Hue bridges on the network.

Three strategies, in order of preference:

1. **mDNS** (``_hue._tcp.local.``) -- works offline, needs no third party, and is
   what the bridge itself advertises. This is the primary path.
2. **Cloud discovery** via ``discovery.meethue.com`` -- a fallback for networks
   where multicast is filtered (common on guest VLANs and some Wi-Fi APs). It
   tells Philips your IP, so it is opt-in at the call site.
3. **Manual host entry** -- always available when both of the above fail.

Every candidate is confirmed by actually talking to it, so a stale mDNS cache or
a recycled DHCP lease cannot produce a bridge that is not there.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from dataclasses import dataclass
from typing import Literal

from aiohttp import ClientConnectionError, ClientError, ClientSession, ClientTimeout
from aiohue.discovery import is_v2_bridge
from aiohue.util import normalize_bridge_id
from zeroconf import ServiceStateChange, Zeroconf
from zeroconf.asyncio import AsyncServiceBrowser, AsyncServiceInfo, AsyncZeroconf

_LOGGER = logging.getLogger(__name__)

HUE_MDNS_SERVICE = "_hue._tcp.local."
URL_NUPNP = "https://discovery.meethue.com/"

_PROBE_TIMEOUT = ClientTimeout(total=10)

Source = Literal["mdns", "cloud", "manual"]


@dataclass(frozen=True)
class DiscoveredBridge:
    host: str
    bridge_id: str
    supports_v2: bool
    source: Source

    @property
    def display_name(self) -> str:
        return f"Hue Bridge {self.bridge_id[-6:].upper()}"


async def discover_mdns(timeout: float = 5.0) -> list[DiscoveredBridge]:
    """Browse for bridges advertising themselves over mDNS."""
    hosts: set[str] = set()
    loop = asyncio.get_running_loop()
    # Strong references: a task held only by the event loop can be collected
    # mid-flight, silently losing the bridge it was resolving.
    pending: set[asyncio.Task[None]] = set()

    def on_change(
        zeroconf: Zeroconf, service_type: str, name: str, state_change: ServiceStateChange
    ) -> None:
        if state_change is not ServiceStateChange.Added:
            return
        task = loop.create_task(_collect(zeroconf, service_type, name, hosts))
        pending.add(task)
        task.add_done_callback(pending.discard)

    aiozc = AsyncZeroconf()
    browser = AsyncServiceBrowser(aiozc.zeroconf, HUE_MDNS_SERVICE, handlers=[on_change])
    try:
        await asyncio.sleep(timeout)
        # Let in-flight TXT/A lookups finish; a bridge that answered late in the
        # window is still a bridge.
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
    finally:
        await browser.async_cancel()
        await aiozc.async_close()

    return await _verify_all(sorted(hosts), "mdns")


async def _collect(
    zeroconf: Zeroconf, service_type: str, name: str, hosts: set[str]
) -> None:
    info = AsyncServiceInfo(service_type, name)
    with contextlib.suppress(Exception):
        if await info.async_request(zeroconf, 3000):
            # A bridge may advertise both IPv4 and IPv6; the CLIP API is reached
            # over either, and _verify_all discards whichever does not answer.
            hosts.update(info.parsed_addresses())


async def discover_cloud() -> list[DiscoveredBridge]:
    """Ask Philips' discovery endpoint which bridges share our public IP.

    This reveals the user's IP to a third party, so only call it as a fallback
    and only with the user's knowledge.
    """
    try:
        async with ClientSession() as session, session.get(
            URL_NUPNP, timeout=ClientTimeout(total=30)
        ) as resp:
            resp.raise_for_status()
            items = await resp.json()
        hosts = sorted({str(item["internalipaddress"]) for item in items})
    except Exception:
        _LOGGER.warning("cloud discovery failed", exc_info=True)
        return []
    # The endpoint can list bridges that are not on this network (or no longer
    # exist), so each one is confirmed like any other candidate.
    return await _verify_all(hosts, "cloud")


async def discover_manual(host: str) -> DiscoveredBridge:
    """Confirm that ``host`` is a Hue bridge.

    Raises whatever aiohttp raises when nothing answers.
    """
    async with ClientSession() as session:
        return await probe_bridge(host, session, "manual")


async def discover(timeout: float = 5.0, allow_cloud: bool = False) -> list[DiscoveredBridge]:
    """Discover bridges, preferring mDNS and falling back to the cloud endpoint.

    The cloud is only consulted when mDNS found nothing, so the common case
    never leaves the local network.
    """
    bridges = await discover_mdns(timeout)
    if not bridges and allow_cloud:
        _LOGGER.info("no bridges via mDNS; falling back to cloud discovery")
        bridges = await discover_cloud()
    return bridges


async def _verify_all(hosts: list[str], source: Source) -> list[DiscoveredBridge]:
    """Contact each host, keeping only the ones that really are bridges.

    Deduplicates by bridge id: one bridge reachable at several addresses is one
    bridge, and the user should not be asked to choose between its own IPs.
    """
    if not hosts:
        return []

    async with ClientSession() as session:
        results = await asyncio.gather(
            *(probe_bridge(host, session, source) for host in hosts),
            return_exceptions=True,
        )

    by_id: dict[str, DiscoveredBridge] = {}
    for host, result in zip(hosts, results, strict=True):
        if isinstance(result, BaseException):
            _LOGGER.debug("%s did not answer as a Hue bridge: %s", host, result)
            continue
        by_id.setdefault(result.bridge_id, result)
    return list(by_id.values())


async def probe_bridge(host: str, session: ClientSession, source: Source) -> DiscoveredBridge:
    """Ask ``host`` for its unauthenticated config and return it as a bridge.

    Not ``aiohue.discovery.discover_bridge``: that only ever requests
    ``http://<host>/api/config``, and the Bridge Pro (and bridges with plain
    http turned off) refuse it outright, so they could never be discovered.
    https is tried first, with verification disabled because the bridge serves
    a self-signed certificate; plain http remains as a fallback for old firmware.
    """
    last_error: Exception | None = None
    for scheme in ("https", "http"):
        try:
            async with session.get(
                f"{scheme}://{host}/api/config", ssl=False, timeout=_PROBE_TIMEOUT
            ) as resp:
                resp.raise_for_status()
                data = await resp.json(content_type=None)
        except (ClientError, TimeoutError, ValueError) as err:  # retried on the next scheme
            last_error = err
            _LOGGER.debug("probing %s over %s failed: %s", host, scheme, err)
            continue

        if not isinstance(data, dict) or "bridgeid" not in data:
            # Some emulators answer this endpoint sloppily; they are not bridges.
            raise ClientConnectionError(f"{host} answered, but not as a Hue bridge")

        supports_v2 = await is_v2_bridge(host, session)
        return DiscoveredBridge(host, normalize_bridge_id(data["bridgeid"]), supports_v2, source)

    assert last_error is not None
    raise last_error
