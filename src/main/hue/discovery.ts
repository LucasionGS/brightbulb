/**
 * Finding Hue bridges on the network.
 *
 * Three strategies, in order of preference:
 *
 * 1. **mDNS** (`_hue._tcp.local`): works offline and is what the bridge itself
 *    advertises.
 * 2. **Cloud discovery** via `discovery.meethue.com`: a fallback for networks
 *    that filter multicast. It tells Philips your IP, so it only runs when mDNS
 *    found nothing.
 * 3. **Manual host entry**, always available.
 *
 * Every candidate is confirmed by talking to it, so a stale mDNS cache or a
 * recycled DHCP lease cannot produce a bridge that is not there.
 */
import mdns from "multicast-dns";
import { bridgeDisplayName, normalizeBridgeId } from "@shared/bridgeId";
import type { BridgeCandidate } from "@shared/ipc";
import PinnedAgent from "./PinnedAgent";
import { HttpError, request, urlHost } from "./http";

const HUE_SERVICE = "_hue._tcp.local";
const CLOUD_URL = "https://discovery.meethue.com/";

/**
 * An agent that accepts any certificate, used only to identify candidates.
 * It remembers what each host presented, so pairing can pin it.
 */
export const probeAgent = new PinnedAgent(() => null, { keepAlive: false });

/**
 * Ask `host` for its unauthenticated config and return it as a candidate.
 *
 * https is tried first: the Bridge Pro (and bridges with http turned off)
 * refuse plain http outright. http remains as a fallback for old firmware.
 * @throws When nothing answers like a Hue bridge.
 */
export async function probeBridge(host: string, source: BridgeCandidate["source"]): Promise<BridgeCandidate> {
  let lastError: unknown = null;
  for (const scheme of ["https", "http"]) {
    let config: unknown;
    try {
      ({ body: config } = await request(`${scheme}://${urlHost(host)}/api/config`, { agent: probeAgent, timeout: 6000 }));
    } catch (error) {
      lastError = error;
      continue;
    }
    const bridgeId = (config as { bridgeid?: unknown })?.bridgeid;
    if (typeof bridgeId !== "string") {
      // Some emulators answer this endpoint sloppily; they are not bridges.
      throw new Error(`${host} answered, but not as a Hue bridge.`);
    }
    const id = normalizeBridgeId(bridgeId);
    return { host, bridgeId: id, name: bridgeDisplayName(id), supportsV2: await isV2Bridge(host), source };
  }
  throw lastError instanceof Error ? lastError : new Error(`No bridge answered at ${host}.`);
}

/**
 * The v2 API is https only and answers 403 when no key is given.
 */
async function isV2Bridge(host: string): Promise<boolean> {
  try {
    await request(`https://${urlHost(host)}/clip/v2/resource`, { agent: probeAgent, timeout: 6000 });
    return true;
  } catch (error) {
    return error instanceof HttpError && error.status === 403;
  }
}

/**
 * Browse for bridges advertising themselves over mDNS for `timeoutMs`.
 * Returns the addresses found; they still need probing.
 */
export function browseMdns(timeoutMs = 5000): Promise<string[]> {
  return new Promise((resolve) => {
    const hosts = new Set<string>();
    let socket: mdns.MulticastDNS;
    try {
      socket = mdns({ reuseAddr: true });
    } catch (error) {
      console.warn("mDNS unavailable:", error);
      resolve([]);
      return;
    }

    socket.on("response", (response) => {
      const records = [...response.answers, ...(response.additionals ?? [])];
      const isHue = records.some((r) => r.name.toLowerCase().includes("_hue._tcp"));
      if (!isHue) return;
      for (const record of records) {
        // Link-local IPv6 needs a zone id to be usable in a URL, so skip it.
        if (record.type === "A" || (record.type === "AAAA" && !String(record.data).toLowerCase().startsWith("fe80"))) {
          hosts.add(String(record.data));
        }
      }
    });
    socket.on("error", (error) => console.warn("mDNS error:", error));

    const query = () => socket.query({ questions: [{ name: HUE_SERVICE, type: "PTR" }] });
    // Repeat the query: the first one can be lost while the socket joins the group.
    const timers = [0, 1000, 3000].map((delay) => setTimeout(query, delay));
    setTimeout(() => {
      timers.forEach(clearTimeout);
      socket.destroy();
      resolve([...hosts]);
    }, timeoutMs);
  });
}

/**
 * Ask Philips' discovery endpoint which bridges share our public IP.
 */
export async function browseCloud(): Promise<string[]> {
  try {
    const { body } = await request<{ internalipaddress?: string }[]>(CLOUD_URL, { timeout: 15000 });
    return [...new Set((body ?? []).map((b) => b.internalipaddress).filter((h): h is string => !!h))];
  } catch (error) {
    console.warn("Cloud discovery failed:", error);
    return [];
  }
}

/**
 * Discover bridges, preferring mDNS and falling back to the cloud endpoint.
 * Results are deduplicated by bridge id: one bridge reachable at several
 * addresses is one bridge.
 */
export async function discover(allowCloud = true): Promise<BridgeCandidate[]> {
  let found = await verifyAll(await browseMdns(), "mdns");
  if (found.length === 0 && allowCloud) {
    found = await verifyAll(await browseCloud(), "cloud");
  }
  return found;
}

async function verifyAll(hosts: string[], source: BridgeCandidate["source"]): Promise<BridgeCandidate[]> {
  // IPv4 first, so a bridge reachable both ways is listed by its IPv4 address.
  hosts.sort((a, b) => Number(a.includes(":")) - Number(b.includes(":")));
  const results = await Promise.allSettled(hosts.map((host) => probeBridge(host, source)));
  const byId = new Map<string, BridgeCandidate>();
  results.forEach((result) => {
    if (result.status === "fulfilled" && !byId.has(result.value.bridgeId)) {
      byId.set(result.value.bridgeId, result.value);
    }
  });
  return [...byId.values()];
}
