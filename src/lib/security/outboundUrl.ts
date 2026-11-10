import dns from "node:dns/promises";

/**
 * Outbound fetch guard.
 *
 * Anything the model can influence (a URL the user texted in, a search result, a
 * redirect hop) must not be able to reach loopback, link-local, RFC1918 space or a
 * cloud metadata endpoint. Checks run on the literal URL, on the DNS answer and on
 * every redirect hop, and every read is bounded by a timeout and a byte ceiling.
 */

export interface FetchGuardOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  resolve?: (hostname: string) => Promise<string[]>;
}

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
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true; // malformed: treat as unsafe
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast and reserved
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
  // A hostname is not an address: only validate things shaped like an IPv4 literal,
  // and let the DNS stage judge names.
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return false;
  return isPrivateIpv4(value);
}

/** Synchronous structural check: scheme, credentials, literal host, blocked names. */
export function assertAllowedUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new OutboundUrlError(`Not a valid URL: ${raw.slice(0, 120)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new OutboundUrlError(`Blocked scheme: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new OutboundUrlError("Blocked URL with embedded credentials");
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new OutboundUrlError(`Blocked host: ${host}`);
  }
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new OutboundUrlError(`Blocked host: ${host}`);
  }
  if (isPrivateAddress(host)) {
    throw new OutboundUrlError(`Blocked private address: ${host}`);
  }
  return parsed;
}

/** Structural check plus a DNS answer check, so a public name cannot resolve inward. */
export async function resolveAndAssert(raw: string, options: FetchGuardOptions = {}): Promise<URL> {
  const parsed = assertAllowedUrl(raw);
  const resolver = options.resolve ?? (async (hostname: string) => {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    return records.map((record) => record.address);
  });
  let addresses: string[];
  try {
    addresses = await resolver(parsed.hostname);
  } catch (err) {
    throw new OutboundUrlError(`DNS lookup failed for ${parsed.hostname}: ${(err as Error).message}`);
  }
  if (addresses.length === 0) {
    throw new OutboundUrlError(`DNS lookup returned nothing for ${parsed.hostname}`);
  }
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new OutboundUrlError(`Blocked private address for ${parsed.hostname}: ${address}`);
    }
  }
  return parsed;
}

export interface SafeFetchResult {
  url: string;
  contentType: string;
  text: string;
}

/** Fetch with redirect revalidation, a timeout and a hard response-size ceiling. */
export async function safeFetchText(
  rawUrl: string,
  options: FetchGuardOptions & { accept?: (contentType: string) => boolean } = {}
): Promise<SafeFetchResult> {
  const timeoutMs = options.timeoutMs ?? 8000;
  const maxBytes = options.maxBytes ?? 2_000_000;
  const maxRedirects = options.maxRedirects ?? 3;
  const accept = options.accept ?? ((contentType: string) => /text\/|json|xml|html/i.test(contentType));

  let current = await resolveAndAssert(rawUrl, options);

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const response = await fetch(current.toString(), {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "Velnor/1.0 (+https://github.com/vectolith/velnor)" },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new OutboundUrlError(`Redirect without a Location header from ${current.hostname}`);
      const next = new URL(location, current);
      current = await resolveAndAssert(next.toString(), options); // every hop is revalidated
      continue;
    }

    if (!response.ok) {
      throw new OutboundUrlError(`Upstream returned ${response.status} for ${current.hostname}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (!accept(contentType)) {
      throw new OutboundUrlError(`Unsupported content type from ${current.hostname}: ${contentType || "unknown"}`);
    }

    const declared = Number(response.headers.get("content-length") || "0");
    if (declared > maxBytes) {
      throw new OutboundUrlError(`Response too large (${declared} bytes) from ${current.hostname}`);
    }

    const reader = response.body?.getReader();
    if (!reader) return { url: current.toString(), contentType, text: "" };
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new OutboundUrlError(`Response exceeded ${maxBytes} bytes from ${current.hostname}`);
      }
      chunks.push(value);
    }
    return {
      url: current.toString(),
      contentType,
      text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"),
    };
  }

  throw new OutboundUrlError(`Too many redirects (>${maxRedirects}) starting at ${rawUrl}`);
}
