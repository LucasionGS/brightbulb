import type https from "node:https";
import type Clip from "@shared/hueTypes";
import { request, urlHost } from "./http";

/**
 * REST access to one bridge's CLIP v2 API.
 */
export class ClipClient {
  /**
   * @param host Bridge address.
   * @param appKey Application key issued at pairing.
   * @param agent Pinned HTTPS agent for this bridge.
   */
  constructor(public readonly host: string, private readonly appKey: string, private readonly agent: https.Agent) { }

  private _url(path: string): string {
    return `https://${urlHost(this.host)}${path}`;
  }

  private _headers(): Record<string, string> {
    return { "hue-application-key": this.appKey };
  }

  /**
   * Every resource on the bridge in one call.
   */
  public async getAll(): Promise<Clip.Resource[]> {
    const { body } = await request<Clip.Response>(this._url("/clip/v2/resource"), { agent: this.agent, headers: this._headers(), timeout: 15000 });
    return body?.data ?? [];
  }

  /**
   * One resource, read live from the bridge rather than from the local mirror.
   */
  public async get<T extends Clip.Resource>(type: string, id: string): Promise<T | null> {
    const { body } = await request<Clip.Response<T>>(this._url(`/clip/v2/resource/${type}/${id}`), { agent: this.agent, headers: this._headers() });
    return body?.data?.[0] ?? null;
  }

  /**
   * Cheap request to check the bridge still answers.
   */
  public async ping(): Promise<void> {
    await request(this._url("/clip/v2/resource/bridge"), { agent: this.agent, headers: this._headers(), timeout: 8000 });
  }

  public async put(type: string, id: string, body: unknown): Promise<void> {
    await request(this._url(`/clip/v2/resource/${type}/${id}`), { method: "PUT", body, agent: this.agent, headers: this._headers() });
  }

  /**
   * This application's own id, used to recognise our claim on an
   * entertainment area. Returns null on bridges that do not support it.
   */
  public async getApplicationId(): Promise<string | null> {
    try {
      const { headers } = await request(this._url("/auth/v1"), { agent: this.agent, headers: this._headers(), timeout: 5000 });
      const id = headers["hue-application-id"];
      return typeof id === "string" ? id : null;
    } catch {
      return null;
    }
  }
}

export default ClipClient;
