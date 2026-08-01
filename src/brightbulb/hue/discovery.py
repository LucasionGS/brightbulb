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

from aiohttp import ClientSession
from aiohue.discovery import discover_bridge, discover_nupnp
from zeroconf import ServiceStateChange, Zeroconf
from zeroconf.asyncio import AsyncServiceBrowser, AsyncServiceInfo, AsyncZeroconf

_LOGGER = logging.getLogger(__name__)

HUE_MDNS_SERVICE = "_hue._tcp.local."

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
        found = await discover_nupnp()
    except Exception:
        _LOGGER.warning("cloud discovery failed", exc_info=True)
        return []
    return [
        DiscoveredBridge(b.host, b.id, b.supports_v2, "cloud") for b in found
    ]


async def discover_manual(host: str) -> DiscoveredBridge:
    """Confirm that ``host`` is a Hue bridge.

    Raises whatever aiohttp raises when nothing answers.
    """
    bridge = await discover_bridge(host)
    return DiscoveredBridge(bridge.host, bridge.id, bridge.supports_v2, "manual")


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
            *(discover_bridge(host, session) for host in hosts),
            return_exceptions=True,
        )

    by_id: dict[str, DiscoveredBridge] = {}
    for host, result in zip(hosts, results, strict=True):
        if isinstance(result, BaseException):
            _LOGGER.debug("%s did not answer as a Hue bridge: %s", host, result)
            continue
        by_id.setdefault(
            result.id, DiscoveredBridge(result.host, result.id, result.supports_v2, source)
        )
    return list(by_id.values())
