import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

/**
 * A small stand-in for GitHub's OAuth web flow and `GET /user`, for tests. `/login/oauth/authorize` signs in as
 * whoever `as` names at that moment, without a page, and sends the browser straight back with a code.
 */
export interface FakeGitHub {
  url: string;
  clientId: string;
  clientSecret: string;
  /** The GitHub user the next sign-in is. */
  as: { id: number; login: string };
  /** How many GitHub access tokens were handed out, so a test can see GitHub was asked. */
  exchanges: number;
  close(): Promise<void>;
}

export async function startFakeGitHub(): Promise<FakeGitHub> {
  const codes = new Map<string, { id: number; login: string; redirectUri: string }>();
  const tokens = new Map<string, { id: number; login: string }>();
  let server: Server;
  const fake: FakeGitHub = {
    url: "",
    clientId: "fake-client-id",
    clientSecret: "fake-client-secret",
    as: { id: 1, login: "octo" },
    exchanges: 0,
    close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))),
  };
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "", "http://x");
    if (req.method === "GET" && url.pathname === "/login/oauth/authorize") {
      if (url.searchParams.get("client_id") !== fake.clientId) return void res.writeHead(400).end();
      const code = randomBytes(8).toString("hex");
      const redirectUri = url.searchParams.get("redirect_uri")!;
      codes.set(code, { ...fake.as, redirectUri });
      const back = new URL(redirectUri);
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      return void res.writeHead(302, { Location: back.href }).end();
    }
    if (req.method === "POST" && url.pathname === "/login/oauth/access_token") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const q = new URLSearchParams(body);
      const entry = codes.get(q.get("code") ?? "");
      codes.delete(q.get("code") ?? "");
      res.writeHead(200, { "Content-Type": "application/json" });
      if (!entry || q.get("client_id") !== fake.clientId || q.get("client_secret") !== fake.clientSecret || q.get("redirect_uri") !== entry.redirectUri) {
        return void res.end(JSON.stringify({ error: "bad_verification_code" }));
      }
      const token = randomBytes(8).toString("hex");
      tokens.set(token, { id: entry.id, login: entry.login });
      fake.exchanges++;
      return void res.end(JSON.stringify({ access_token: token, token_type: "bearer", scope: "" }));
    }
    if (req.method === "GET" && url.pathname === "/user") {
      const user = tokens.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
      if (!user) return void res.writeHead(401).end();
      res.writeHead(200, { "Content-Type": "application/json" });
      return void res.end(JSON.stringify(user));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const address = server.address();
  fake.url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return fake;
}
