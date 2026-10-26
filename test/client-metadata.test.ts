import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import type { RequestOptions } from "node:https";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_METADATA_BYTES, MetadataFetchError, fetchClientMetadata, isPublicAddress } from "../src/client-metadata.js";
import { OAuthError, checkMetadataUrl, clientFromMetadata } from "../src/oauth.js";

// The checks on a Client ID Metadata Document's URL, its fetch and its contents, apart from the server.
const URL_ID = "https://client.example/oauth/metadata.json";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

const listen = async (server: Server) => {
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as AddressInfo).port;
};

/** A loopback HTTP server answering with `answer`, which records each request's headers. */
const docServer = async (answer: (res: import("node:http").ServerResponse) => void) => {
  const seen: IncomingHttpHeaders[] = [];
  const port = await listen(
    createServer((req, res) => {
      seen.push(req.headers);
      answer(res);
    }),
  );
  // The real fetcher, sent over plain HTTP to the loopback server with the address check turned off.
  const fetchFrom = (url = URL_ID, timeoutMs?: number) =>
    fetchClientMetadata(url, { request: (o: RequestOptions) => httpRequest({ ...o, host: "127.0.0.1", port }), allowed: () => true, timeoutMs });
  return { seen, fetchFrom };
};

describe("metadata URL", () => {
  it("accepts an https URL with a path, as it is", () => {
    expect(checkMetadataUrl(URL_ID)).toBe(URL_ID);
    expect(checkMetadataUrl("https://claude.ai/oauth/mcp-oauth-client-metadata")).toBe("https://claude.ai/oauth/mcp-oauth-client-metadata");
  });

  it("refuses the bypasses, a root path, a userinfo, a query, a fragment, dot segments, a non-canonical form and an overlong URL", () => {
    for (const raw of [
      "http://localhost@evil/",
      "https://@/",
      "https://h/?x=/o/",
      "https://h/#/o/",
      "https://h/x?",
      "https://h/x#",
      "https://h/",
      "https://h",
      "http://client.example/meta",
      "https://user@client.example/meta",
      "https://user:pw@client.example/meta",
      "https://client.example/a/../meta",
      "https://client.example/./meta",
      "https://CLIENT.example/meta",
      "https://client.example:443/meta",
      "https://2130706433/x",
      "https://client.example/m eta",
      `https://client.example/${"x".repeat(2000)}`,
      "https://",
    ]) {
      expect(() => checkMetadataUrl(raw), raw).toThrow(OAuthError);
    }
  });
});

describe("metadata document", () => {
  const doc = { client_id: URL_ID, client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none" };

  it("gives the client's name and redirect URIs, ignoring other fields", () => {
    expect(clientFromMetadata(URL_ID, { ...doc, grant_types: ["authorization_code", "refresh_token"], logo_uri: "https://x/y" })).toEqual({
      clientId: URL_ID,
      clientName: "Claude",
      redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
    });
    const { client_name: _n, token_endpoint_auth_method: _m, ...bare } = doc;
    expect(clientFromMetadata(URL_ID, bare).clientName).toBeNull();
  });

  it("refuses a document that is not for this URL, lists no or too many or bad redirect URIs, or is not a public client, never quoting it", () => {
    for (const bad of [
      null,
      [],
      "text",
      { ...doc, client_id: "https://client.example/other" },
      { ...doc, client_id: undefined },
      { ...doc, redirect_uris: [] },
      { ...doc, redirect_uris: "https://claude.ai/cb" },
      { ...doc, redirect_uris: Array.from({ length: 11 }, (_, i) => `https://claude.ai/cb${i}`) },
      { ...doc, redirect_uris: ["http://evil.example/cb"] },
      { ...doc, redirect_uris: ["https://claude.ai/cb?x=1"] },
      { ...doc, client_name: "x".repeat(101) },
      { ...doc, client_name: 5 },
      { ...doc, token_endpoint_auth_method: "client_secret_basic" },
      { ...doc, client_secret: "s" },
    ]) {
      let error: unknown;
      try {
        clientFromMetadata(URL_ID, bad);
      } catch (err) {
        error = err;
      }
      expect(error, JSON.stringify(bad)).toBeInstanceOf(OAuthError);
      expect((error as Error).message).not.toContain("evil");
      expect((error as Error).message).not.toContain("claude.ai");
    }
  });
});

describe("address check", () => {
  it("refuses loopback, private, link-local, carrier-grade NAT, unspecified, unique-local and IPv4-mapped addresses", () => {
    for (const address of [
      "127.0.0.1",
      "127.255.0.9",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::",
      "::1",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:169.254.169.254",
      "::ffff:10.0.0.1",
      "::ffff:8.8.8.8",
      "64:ff9b::7f00:1",
      "::7f00:1",
      "::ffff:0:7f00:1",
      "2002:7f00:1::",
      "2001::1",
      "3fff::1",
      "5f00::1",
      "ff02::1",
      "224.0.0.1",
      "255.255.255.255",
      "not an address",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    expect(isPublicAddress(undefined)).toBe(false);
    for (const address of ["8.8.8.8", "160.79.104.10", "2607:f8b0:4004:800::200e"]) expect(isPublicAddress(address), address).toBe(true);
  });

  it("refuses a literal private address in every notation new URL() accepts, without making a request", async () => {
    let requests = 0;
    const request = () => {
      requests++;
      throw new Error("no request should be made");
    };
    for (const url of [
      "https://127.0.0.1/x",
      "https://2130706433/x",
      "https://0x7f.1/x",
      "https://017700000001/x",
      "https://127.1/x",
      "https://[::1]/x",
      "https://[::ffff:127.0.0.1]/x",
      "https://[::ffff:a9fe:a9fe]/x",
      "https://169.254.169.254/latest/meta-data",
      "https://10.0.0.1/x",
      "https://[fd00::1]/x",
      "https://0.0.0.0/x",
    ]) {
      await expect(fetchClientMetadata(url, { request }), url).rejects.toBeInstanceOf(MetadataFetchError);
    }
    expect(requests).toBe(0);
  });

  it("refuses a name that resolves to a private address, without connecting", async () => {
    let connections = 0;
    const tcp = createTcpServer((socket) => {
      connections++;
      socket.destroy();
    });
    await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", r));
    const { port } = tcp.address() as AddressInfo;
    try {
      // localhost resolves through the connection's own lookup, which refuses it.
      await expect(fetchClientMetadata(`https://localhost:${port}/x`)).rejects.toBeInstanceOf(MetadataFetchError);
      expect(connections).toBe(0);
    } finally {
      await new Promise((r) => tcp.close(r));
    }
  });

  it("checks the address the connection resolves, not a lookup made first", async () => {
    let looked = 0;
    // The connection looks the name up once, through the fetcher's lookup, and that answer is the one refused.
    const request = (o: RequestOptions) =>
      httpRequest({
        ...o,
        lookup: ((hostname: string, options: object, callback: () => void) => {
          looked++;
          (o.lookup as unknown as (h: string, o: object, c: () => void) => void)(hostname, options, callback);
        }) as never,
      });
    await expect(fetchClientMetadata("https://localhost/x", { request })).rejects.toBeInstanceOf(MetadataFetchError);
    expect(looked).toBe(1);
  });

  it("refuses a socket that reached a private address all the same", async () => {
    const { fetchFrom: _f, seen } = await docServer((res) => res.end("{}"));
    const port = (servers[0].address() as AddressInfo).port;
    // A lookup that skips the check, as a name resolving differently a second time would; the socket's address is refused.
    const request = (o: RequestOptions) =>
      httpRequest({ ...o, port, lookup: ((_h: string, opts: { all?: boolean }, cb: (e: null, a: unknown, f?: number) => void) =>
          opts.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4)) as never });
    await expect(fetchClientMetadata("https://public.example/x", { request })).rejects.toThrow("The address is not a public one.");
    expect(seen).toHaveLength(0);
  });
});

describe("fetch", () => {
  it("sends no token, cookie or other header, and parses the document", async () => {
    const { seen, fetchFrom } = await docServer((res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ client_id: URL_ID }));
    });
    expect(await fetchFrom()).toEqual({ client_id: URL_ID });
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0]).sort()).toEqual(["accept", "connection", "host"]);
  });

  it("follows no redirect", async () => {
    let hits = 0;
    const { fetchFrom } = await docServer((res) => {
      hits++;
      res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data" });
      res.end();
    });
    await expect(fetchFrom()).rejects.toBeInstanceOf(MetadataFetchError);
    expect(hits).toBe(1);
  });

  it(`refuses an answer over ${MAX_METADATA_BYTES} bytes, with or without a length, and one that is not JSON or not 200`, async () => {
    const big = JSON.stringify({ client_id: URL_ID, pad: "x".repeat(MAX_METADATA_BYTES) });
    for (const answer of [
      (res: import("node:http").ServerResponse) => res.end(big),
      (res: import("node:http").ServerResponse) => {
        res.write(big.slice(0, 3000));
        res.end(big.slice(3000));
      },
      (res: import("node:http").ServerResponse) => res.end("not json"),
      (res: import("node:http").ServerResponse) => {
        res.writeHead(404);
        res.end("{}");
      },
    ]) {
      const { fetchFrom } = await docServer(answer);
      await expect(fetchFrom()).rejects.toBeInstanceOf(MetadataFetchError);
    }
    const { fetchFrom } = await docServer((res) => res.end(JSON.stringify({ pad: "x".repeat(MAX_METADATA_BYTES - 20) })));
    expect(await fetchFrom()).toHaveProperty("pad");
  });

  it("gives up at its deadline", async () => {
    const { fetchFrom } = await docServer(() => {});
    const started = Date.now();
    await expect(fetchFrom(URL_ID, 200)).rejects.toThrow("The document took too long.");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("cancels a lookup still running at its deadline, so none outlives the fetch", async () => {
    const pending: string[] = [];
    let cancelled = 0;
    // A resolver that never answers until cancelled, as a slow name server would not.
    const resolver = {
      resolve4: (name: string) => void pending.push(`4 ${name}`),
      resolve6: (name: string) => void pending.push(`6 ${name}`),
      cancel: () => void cancelled++,
    } as never;
    await expect(fetchClientMetadata("https://public.example/x", { resolver, timeoutMs: 200 })).rejects.toThrow("The document took too long.");
    expect(pending.sort()).toEqual(["4 public.example", "6 public.example"]);
    expect(cancelled).toBe(1);
  });

  it("resolves through its own resolver and refuses a name with any address that is not public", async () => {
    const resolver = {
      resolve4: (_n: string, cb: (e: Error | null, a: string[]) => void) => cb(null, ["93.184.215.14"]),
      resolve6: (_n: string, cb: (e: Error | null, a: string[]) => void) => cb(null, ["fd00::1"]),
      cancel: () => {},
    } as never;
    await expect(fetchClientMetadata("https://public.example/x", { resolver })).rejects.toThrow("The address is not a public one.");
  });
});
