import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { BlockList, isIP, type Socket } from "node:net";

// Fetches an OAuth Client ID Metadata Document for the authorization endpoint of `serve --public-url`. The URL is one a
// stranger chose, so the address check is the boundary against server-side request forgery: the connection may go only
// to a public address, checked on the address the connection resolves and uses, not on a separate lookup made first, and
// again on the socket once it connects. Nothing of the incoming request is sent, no redirect is followed, and the answer
// is cut off at a size and a deadline. Nothing here logs anything.

/** How long a fetch may take, from the request to the last byte, as a webhook delivery may. */
export const METADATA_TIMEOUT_MS = 5000;
/** The largest document read, the size the Client ID Metadata Document draft recommends; a larger one is refused. */
export const MAX_METADATA_BYTES = 5 * 1024;

/** A fetch refused or failed. Its message is fixed text that never quotes the URL or the answer. */
export class MetadataFetchError extends Error {}

// Every range that is not a public unicast address: in IPv4 loopback, private, link-local (169.254.169.254 among them),
// carrier-grade NAT, unspecified, documentation, benchmarking, multicast and reserved. In IPv6 only global unicast
// (2000::/3) is allowed, which leaves out loopback, unspecified, unique-local, link-local, multicast and the IPv4-mapped,
// -compatible and -translated forms; within it the ranges that embed an IPv4 address (NAT64, 6to4 and Teredo) and the
// documentation ones are refused whole rather than unpacked.
// Kept apart by family: an IPv6 rule such as ::ffff:0:0/96 would otherwise match every IPv4 address.
const blocked = { ipv4: new BlockList(), ipv6: new BlockList() };
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.ipv4.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const) {
  blocked.ipv6.addSubnet(net, prefix, "ipv6");
}

const globalUnicast = new BlockList();
globalUnicast.addSubnet("2000::", 3, "ipv6");

/** Whether `address`, an IP address as a resolver or socket reports it, is a public unicast address. */
export function isPublicAddress(address: string | undefined): boolean {
  const family = address === undefined ? 0 : isIP(address);
  if (family === 0) return false;
  try {
    if (family === 4) return !blocked.ipv4.check(address!, "ipv4");
    return globalUnicast.check(address!, "ipv6") && !blocked.ipv6.check(address!, "ipv6");
  } catch {
    return false;
  }
}

export interface MetadataFetchOptions {
  /** For tests only: what makes the request, and which addresses it may reach. */
  request?: (options: RequestOptions) => ClientRequest;
  allowed?: (address: string | undefined) => boolean;
  timeoutMs?: number;
}

const refused = () => new MetadataFetchError("The address is not a public one.");

/**
 * Fetches the document at `url`, an https URL `checkMetadataUrl` in oauth.ts accepted, and answers it parsed as JSON. It
 * sends only `Accept: application/json` (and the `Host` and `Connection` headers Node adds); it rejects with
 * `MetadataFetchError` for a host that is or resolves to an address that is not public, an answer other than 200
 * (a redirect included), one over MAX_METADATA_BYTES or not JSON, a connection that fails, or past METADATA_TIMEOUT_MS.
 * There is no cache: the authorization endpoint fetches once for each request whose `client_id` passes
 * `checkMetadataUrl`, before checking its other parameters, with at most `maxSessions` fetches at once.
 */
export function fetchClientMetadata(url: string, options: MetadataFetchOptions = {}): Promise<unknown> {
  const allowed = options.allowed ?? isPublicAddress;
  const target = new URL(url);
  const host = target.hostname.replace(/^\[(.*)\]$/, "$1");
  // A literal address is connected to without a lookup, so it is checked here.
  if (isIP(host) !== 0 && !allowed(host)) return Promise.reject(refused());
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      req.destroy();
      reject(err instanceof MetadataFetchError ? err : new MetadataFetchError("The document could not be fetched."));
    };
    // The connection's own lookup: the addresses it returns are the ones it connects to, and any that is not public
    // refuses the whole name.
    const lookup = (hostname: string, lookupOptions: object, callback: (...args: unknown[]) => void) =>
      dnsLookup(hostname, { ...lookupOptions, all: true }, (err, addresses: LookupAddress[]) => {
        if (err) return callback(err);
        if (addresses.length === 0 || !addresses.every((a) => allowed(a.address))) return callback(refused());
        if ((lookupOptions as { all?: boolean }).all) return callback(null, addresses);
        callback(null, addresses[0].address, addresses[0].family);
      });
    const req = (options.request ?? httpsRequest)({
      host,
      port: target.port || undefined,
      path: target.pathname,
      method: "GET",
      headers: { Accept: "application/json" },
      agent: false,
      lookup: lookup as RequestOptions["lookup"],
    });
    const deadline = setTimeout(() => fail(new MetadataFetchError("The document took too long.")), options.timeoutMs ?? METADATA_TIMEOUT_MS);
    // Checked again on the socket once it connects, before the HTTP request is sent (TLS has begun its handshake by then).
    req.on("socket", (socket: Socket) => {
      socket.once("connect", () => {
        if (!allowed(socket.remoteAddress)) fail(refused());
      });
    });
    req.on("error", fail);
    req.on("response", (res: IncomingMessage) => {
      if (res.statusCode !== 200) return fail(new MetadataFetchError("The document could not be fetched."));
      if (Number(res.headers["content-length"]) > MAX_METADATA_BYTES) return fail(new MetadataFetchError("The document is too large."));
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_METADATA_BYTES) return fail(new MetadataFetchError("The document is too large."));
        chunks.push(chunk);
      });
      res.on("error", fail);
      res.on("end", () => {
        if (settled) return;
        let doc: unknown;
        try {
          doc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return fail(new MetadataFetchError("The document is not JSON."));
        }
        settled = true;
        clearTimeout(deadline);
        resolve(doc);
      });
    });
    req.end();
  });
}
