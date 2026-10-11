import http from "node:http";
import https from "node:https";

/**
 * A non-2xx answer from the bridge or another HTTP endpoint.
 */
export class HttpError extends Error {
  constructor(public readonly status: number, public readonly url: string, public readonly body: unknown) {
    super(`${url} answered ${status}${describeBody(body)}`);
    this.name = "HttpError";
  }
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /**
   * Agent for https URLs. Bridges need a `PinnedAgent`; public endpoints can omit it.
   */
  agent?: https.Agent;
  /**
   * Whole-request timeout in ms. Default is 10000.
   */
  timeout?: number;
  signal?: AbortSignal;
}

export interface HttpResponse<T> {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: T;
}

/**
 * Make a JSON request with Node's built-in http/https.
 * Resolves with the parsed body on 2xx; rejects with `HttpError` otherwise.
 */
export function request<T = unknown>(url: string, opts?: RequestOptions): Promise<HttpResponse<T>> {
  opts ??= {};
  const target = new URL(url);
  const isHttps = target.protocol === "https:";
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);

  return new Promise((resolve, reject) => {
    const req = (isHttps ? https : http).request(target, {
      method: opts.method ?? "GET",
      agent: isHttps ? opts.agent : undefined,
      headers: {
        accept: "application/json",
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
        ...opts.headers,
      },
      timeout: opts.timeout ?? 10000,
      signal: opts.signal,
      // Without an agent, https requests still need to accept bridge certificates.
      ...(isHttps && !opts.agent ? { rejectUnauthorized: !isPrivateHost(target.hostname) } : {}),
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body: unknown = text;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          // Not JSON; keep the text for the error message.
        }
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) {
          resolve({ status, headers: res.headers, body: body as T });
        }
        else {
          reject(new HttpError(status, url, body));
        }
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`${url} timed out`)));
    req.on("error", reject);
    req.end(payload);
  });
}

/**
 * Whether a host is on a private network, where self-signed bridge
 * certificates are expected. Public endpoints are always verified.
 */
export function isPrivateHost(host: string): boolean {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.|\[?fe80:|\[?fd|\[?fc|\[?::1)/i.test(host) || host.endsWith(".local");
}

/**
 * Wrap a raw IPv6 address in brackets for use in a URL.
 */
export function urlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function describeBody(body: unknown): string {
  if (Array.isArray((body as { errors?: unknown })?.errors)) {
    const errors = (body as { errors: { description?: string }[] }).errors;
    const text = errors.map((e) => e.description).filter(Boolean).join("; ");
    if (text) return `: ${text}`;
  }
  return "";
}
