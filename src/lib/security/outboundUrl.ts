import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

export interface FetchGuardOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  resolve?: (hostname: string) => Promise<string[]>;
  /** Test seam; production uses a socket pinned to the validated DNS answers. */
  request?: PinnedRequest;
}

export interface PinnedResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export type PinnedRequest = (
  url: URL,
  addresses: string[],
  timeoutMs: number,
  maxBytes: number
) => Promise<PinnedResponse>;

export class OutboundUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundUrlError";
  }
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.google.internal",
  "instance-data",
]);

const BLOCKED_SUFFIXES = [".internal", ".local", ".localdomain", ".home.arpa", ".in-addr.arpa"];

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(address: string): boolean {
  const value = address.toLowerCase();
  if (value === "::1" || value === "::") return true;
  if (value.startsWith("fe80") || value.startsWith("fc") || value.startsWith("fd")) return true;
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  return false;
}

export function isPrivateAddress(address: string): boolean {
  const value = address.trim().replace(/^\[|\]$/g, "");
  if (value.includes(":")) return isPrivateIpv6(value);
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return false;
  return isPrivateIpv4(value);
}

/** Structural check: scheme, credentials, literal host and blocked names. */
export function assertAllowedUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new OutboundUrlError("Not a valid URL: " + raw.slice(0, 120));
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new OutboundUrlError("Blocked scheme: " + parsed.protocol);
  }
  if (parsed.username || parsed.password) throw new OutboundUrlError("Blocked URL with embedded credentials");
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new OutboundUrlError("Blocked host: " + host);
  }
  if (isPrivateAddress(host)) throw new OutboundUrlError("Blocked private address: " + host);
  return parsed;
}

async function resolveAddressesAndAssert(
  raw: string,
  options: FetchGuardOptions = {}
): Promise<{ url: URL; addresses: string[] }> {
  const url = assertAllowedUrl(raw);
  const resolver = options.resolve ?? (async (hostname: string) => {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    return records.map((record) => record.address);
  });
  let addresses: string[];
  try {
    addresses = await resolver(url.hostname.replace(/^\[|\]$/g, ""));
  } catch (err) {
    throw new OutboundUrlError("DNS lookup failed for " + url.hostname + ": " + (err as Error).message);
  }
  if (addresses.length === 0) throw new OutboundUrlError("DNS lookup returned nothing for " + url.hostname);
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new OutboundUrlError("Blocked private address for " + url.hostname + ": " + address);
    }
    if (net.isIP(address) === 0) throw new OutboundUrlError("DNS returned an invalid address for " + url.hostname);
  }
  return { url, addresses };
}

/** Structural check plus DNS validation; kept for callers that only need validation. */
export async function resolveAndAssert(raw: string, options: FetchGuardOptions = {}): Promise<URL> {
  return (await resolveAddressesAndAssert(raw, options)).url;
}

async function requestPinned(
  url: URL,
  addresses: string[],
  timeoutMs: number,
  maxBytes: number
): Promise<PinnedResponse> {
  const transport = url.protocol === "https:" ? https : http;
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const records = addresses.map((address) => ({ address, family: net.isIP(address) }));
  const lookup = (_hostname: string, options: { all?: boolean }, callback: (...args: any[]) => void) => {
    if (options?.all) callback(null, records);
    else callback(null, records[0].address, records[0].family);
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const req = transport.request({
      protocol: url.protocol,
      hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method: "GET",
      headers: {
        "user-agent": "Velnor/1.0 (+https://github.com/vectolith/velnor)",
        accept: "text/html,application/xhtml+xml,text/plain,application/json,application/xml",
      },
      lookup: lookup as any,
      ...(url.protocol === "https:" && net.isIP(hostname) === 0 ? { servername: hostname } : {}),
    }, (response) => {
      const statusCode = response.statusCode || 0;
      const responseHeaders = response.headers as Record<string, string | string[] | undefined>;
      const declared = Number(responseHeaders["content-length"] || "0");
      if (declared > maxBytes) {
        response.destroy();
        fail(new OutboundUrlError("Response too large (" + declared + " bytes) from " + hostname));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > maxBytes) {
          response.destroy();
          fail(new OutboundUrlError("Response exceeded " + maxBytes + " bytes from " + hostname));
          return;
        }
        chunks.push(buffer);
      });
      response.on("end", () => {
        if (settled) return;
        settled = true;
        resolve({ statusCode, headers: responseHeaders, body: Buffer.concat(chunks) });
      });
      response.on("error", fail);
      response.on("aborted", () => fail(new OutboundUrlError("Upstream response aborted from " + hostname)));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new OutboundUrlError("Request timed out for " + hostname)));
    req.on("error", fail);
    req.end();
  });
}

export interface SafeFetchResult {
  url: string;
  contentType: string;
  text: string;
}

/** Fetch with DNS pinning, redirect revalidation, timeout and response-size ceiling. */
export async function safeFetchText(
  rawUrl: string,
  options: FetchGuardOptions & { accept?: (contentType: string) => boolean } = {}
): Promise<SafeFetchResult> {
  const timeoutMs = options.timeoutMs ?? 8000;
  const maxBytes = options.maxBytes ?? 2_000_000;
  const maxRedirects = options.maxRedirects ?? 3;
  const accept = options.accept ?? ((contentType: string) => /text\/|json|xml|html/i.test(contentType));
  let currentUrl = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const resolved = await resolveAddressesAndAssert(currentUrl, options);
    const response = await (options.request ?? requestPinned)(resolved.url, resolved.addresses, timeoutMs, maxBytes);
    const locationHeader = response.headers.location;
    const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;

    if (response.statusCode >= 300 && response.statusCode < 400) {
      if (!location) throw new OutboundUrlError("Redirect without a Location header from " + resolved.url.hostname);
      currentUrl = new URL(location, resolved.url).toString();
      continue;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new OutboundUrlError("Upstream returned " + response.statusCode + " for " + resolved.url.hostname);
    }

    const rawContentType = response.headers["content-type"] || "";
    const contentType = Array.isArray(rawContentType) ? rawContentType[0] : rawContentType;
    if (!accept(contentType)) {
      throw new OutboundUrlError("Unsupported content type from " + resolved.url.hostname + ": " + (contentType || "unknown"));
    }
    if (response.body.length > maxBytes) {
      throw new OutboundUrlError("Response exceeded " + maxBytes + " bytes from " + resolved.url.hostname);
    }
    return {
      url: resolved.url.toString(),
      contentType,
      text: response.body.toString("utf8"),
    };
  }
  throw new OutboundUrlError("Too many redirects (>" + maxRedirects + ") starting at " + rawUrl);
}
