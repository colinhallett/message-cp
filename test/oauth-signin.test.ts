import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addAccount, addToken, listTokens, revokeToken } from "../src/accounts.js";
import { addPerson, registerAgent } from "../src/agents.js";
import { OWNER_ACCOUNT, openDb, type Db } from "../src/db.js";
import { makeLoginCode, redeemLoginCode } from "../src/login.js";
import { startHttp, type HttpServer } from "../src/http.js";
import { agentNameBase, freeAgentName } from "../src/oauth.js";

// The approval page's sign-in from the dashboard: POST /oauth/signin sets an HttpOnly, SameSite=Strict cookie from a
// full or person token, GET /oauth/signin says who it signs in as, DELETE clears it, and POST /oauth/approve with no
// Authorization header, from the server's own origin, is signed in by it.
const OWNER_TOKEN = "owner-token";
const REDIRECT = "http://localhost:9999/callback";
let db: Db;
let http: HttpServer;
// The public URL, an https one as the sign-in needs, whose origin a browser on the server's pages names; the tests reach
// the server itself at `server`, as a TLS proxy in front of it would.
const origin = "https://h.example";
let server: string;

beforeEach(async () => {
  db = openDb(join(mkdtempSync(join(tmpdir(), "message-cp-signin-")), "db.sqlite"));
  addAccount(db, "friend");
  http = await startHttp(db, { token: OWNER_TOKEN, port: 0, waitHoldMs: 0, publicUrl: origin });
  server = `http://127.0.0.1:${http.port}`;
});

afterEach(async () => {
  await http.close();
  db.close();
});

/** Who a person token of maria in the owner account signs in as, as GET /oauth/signin answers. */
const MARIA = { account: "owner", person: "maria" };

const personToken = (account = "owner", name = "maria") => {
  addPerson(db, account, name);
  return addToken(db, account, false, false, undefined, name).token;
};

/** POST /oauth/signin as the dashboard sends it, from this origin unless `from` says otherwise; answers the cookie set. */
const signIn = async (token: string, from: string | null = origin) => {
  const res = await fetch(`${server}/oauth/signin`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, ...(from === null ? {} : { Origin: from }) },
  });
  return { status: res.status, cookie: res.headers.get("set-cookie") };
};

/** The `name=value` pair of a Set-Cookie header, as a browser sends it back. */
const pair = (setCookie: string) => setCookie.split(";")[0];

const whoami = (cookie: string | null, headers: Record<string, string> = { "Sec-Fetch-Site": "same-origin" }, query = "") =>
  fetch(`${server}/oauth/signin${query}`, { headers: { ...(cookie === null ? {} : { Cookie: cookie }), ...headers } });

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

/** Registers a client named `name` and shows its approval page, answering the page and its request handle. */
const pending = async (name = "Codex", publicUrl = origin) => {
  const reg = await fetch(`${server}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT] }),
  });
  const clientId = ((await reg.json()) as { client_id: string }).client_id;
  const { verifier, challenge } = pkce();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "s1",
    resource: `${publicUrl}/mcp`,
  });
  const res = await fetch(`${server}/oauth/authorize?${query}`);
  expect(res.status).toBe(200);
  const html = await res.text();
  return { html, request: /data-request="([0-9a-f]+)"/.exec(html)![1], clientId, verifier };
};

/** POST /oauth/approve with only the given headers: no token unless they carry one. */
const approve = (headers: Record<string, string>, body: Record<string, unknown>) =>
  fetch(`${server}/oauth/approve`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("POST /oauth/signin", () => {
  it("sets an HttpOnly, SameSite=Strict cookie under the approval page's path for a person or full token", async () => {
    for (const token of [personToken(), addToken(db, "owner").token, OWNER_TOKEN]) {
      const { status, cookie } = await signIn(token);
      expect(status).toBe(204);
      expect(cookie).toBe(`message-cp-signin=${token}; Path=/oauth/; HttpOnly; SameSite=Strict; Secure`);
    }
  });

  it("scopes the cookie to the public URL's path", async () => {
    await http.close();
    http = await startHttp(db, { token: OWNER_TOKEN, port: 0, waitHoldMs: 0, publicUrl: "https://h.example/team" });
    const res = await fetch(`http://127.0.0.1:${http.port}/oauth/signin`, {
      method: "POST",
      headers: { Authorization: `Bearer ${OWNER_TOKEN}`, Origin: "https://h.example" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie")).toBe(`message-cp-signin=${OWNER_TOKEN}; Path=/team/oauth/; HttpOnly; SameSite=Strict; Secure`);
  });

  it("refuses read-only and agent tokens, a wrong or missing token, and sets nothing", async () => {
    registerAgent(db, OWNER_ACCOUNT, "desk", "x");
    const desk = db.prepare("SELECT id FROM agents WHERE name = 'desk'").pluck().get() as number;
    const readOnly = addToken(db, "owner", true).token;
    const agent = addToken(db, "owner", false, true, desk).token;
    expect(await signIn(readOnly)).toEqual({ status: 403, cookie: null });
    expect(await signIn(agent)).toEqual({ status: 403, cookie: null });
    expect(await signIn("wrong")).toEqual({ status: 401, cookie: null });
    const none = await fetch(`${server}/oauth/signin`, { method: "POST", headers: { Origin: origin } });
    expect(none.status).toBe(401);
    expect(none.headers.get("set-cookie")).toBeNull();
  });

  it("refuses a request from another origin, or naming none, so another site cannot plant a sign-in", async () => {
    expect(await signIn(OWNER_TOKEN, "https://evil.example")).toEqual({ status: 403, cookie: null });
    expect(await signIn(OWNER_TOKEN, "null")).toEqual({ status: 403, cookie: null });
    expect(await signIn(OWNER_TOKEN, null)).toEqual({ status: 403, cookie: null });
  });

  it("does not exist without a public URL, or under an http one, where the cookie would reach the host's other ports", async () => {
    for (const publicUrl of [undefined, "http://127.0.0.1:1"]) {
      await http.close();
      http = await startHttp(db, { token: OWNER_TOKEN, port: 0, waitHoldMs: 0, ...(publicUrl && { publicUrl }) });
      const self = publicUrl ?? `http://127.0.0.1:${http.port}`;
      for (const method of ["POST", "GET", "DELETE"]) {
        const res = await fetch(`http://127.0.0.1:${http.port}/oauth/signin`, {
          method,
          headers: { Authorization: `Bearer ${OWNER_TOKEN}`, Origin: self },
        });
        expect(res.status).toBe(404);
        expect(res.headers.get("set-cookie")).toBeNull();
      }
    }
  });
});

describe("GET /oauth/signin", () => {
  it("says who the cookie signs in as, and a free agent name made from the base", async () => {
    const maria = personToken();
    registerAgent(db, OWNER_ACCOUNT, "codex", "x");
    const { cookie } = await signIn(maria);
    const res = await whoami(pair(cookie!), undefined, "?base=codex");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ account: "owner", person: "maria", name: "codex-2" });
    const full = await signIn(addToken(db, "friend").token);
    expect(await (await whoami(pair(full.cookie!))).json()).toEqual({ account: "friend" });
  });

  it("answers 401 with no cookie, and 401 clearing it once its token is revoked", async () => {
    expect((await whoami(null)).status).toBe(401);
    const maria = personToken();
    const { cookie } = await signIn(maria);
    expect((await whoami(pair(cookie!))).status).toBe(200);
    revokeToken(db, listTokens(db).find((t) => t.kind === "person")!.id);
    const res = await whoami(pair(cookie!));
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBe("message-cp-signin=; Path=/oauth/; HttpOnly; SameSite=Strict; Secure; Max-Age=0");
  });

  it("refuses a request from another site, even with the cookie", async () => {
    const { cookie } = await signIn(personToken());
    expect((await whoami(pair(cookie!), { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await whoami(pair(cookie!), {})).status).toBe(403);
    expect((await whoami(pair(cookie!), { Origin: "https://evil.example" })).status).toBe(403);
  });
});

describe("DELETE /oauth/signin", () => {
  it("clears the cookie for a request from this origin only", async () => {
    const res = await fetch(`${server}/oauth/signin`, { method: "DELETE", headers: { Origin: origin } });
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie")).toBe("message-cp-signin=; Path=/oauth/; HttpOnly; SameSite=Strict; Secure; Max-Age=0");
    const other = await fetch(`${server}/oauth/signin`, { method: "DELETE", headers: { Origin: "https://evil.example" } });
    expect(other.status).toBe(403);
    expect(other.headers.get("set-cookie")).toBeNull();
  });
});

describe("POST /oauth/approve signed in by the cookie", () => {
  it("signs in and approves with a login link's session as its person, and stops once the session's token is revoked", async () => {
    addPerson(db, "owner", "maria");
    const session = redeemLoginCode(db, makeLoginCode(db, "owner", "maria").code);
    const { status, cookie } = await signIn(session);
    expect(status).toBe(204);
    expect(await (await whoami(pair(cookie!))).json()).toEqual(MARIA);
    const { request } = await pending();
    const res = await approve({ Origin: origin, Cookie: pair(cookie!) }, { request, state: "s1", agent: "codex", as: MARIA, fresh: true });
    expect(res.status).toBe(200);
    revokeToken(db, listTokens(db).find((t) => t.kind === "person")!.id);
    expect((await whoami(pair(cookie!))).status).toBe(401);
  });

  it("approves from this origin with the cookie and no token, as the cookie's person's account, and the code gives an agent token", async () => {
    const { cookie } = await signIn(personToken());
    const { request, clientId, verifier } = await pending();
    const res = await approve({ Origin: origin, Cookie: pair(cookie!) }, { request, state: "s1", agent: "codex", as: MARIA, fresh: true });
    expect(res.status).toBe(200);
    const code = new URL(((await res.json()) as { location: string }).location).searchParams.get("code")!;
    const token = await fetch(`${server}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: `${origin}/mcp` }),
    });
    expect(token.status).toBe(200);
    expect(db.prepare("SELECT account_id, person FROM agents WHERE name = 'codex'").get()).toEqual({ account_id: OWNER_ACCOUNT, person: 0 });
  });

  it("refuses a cross-site approve: another origin, or no Origin, with the cookie is not signed in", async () => {
    const { cookie } = await signIn(personToken());
    const { request } = await pending();
    for (const headers of [{ Origin: "https://evil.example", Cookie: pair(cookie!) }, { Cookie: pair(cookie!) }, { Origin: "null", Cookie: pair(cookie!) }]) {
      const res = await approve(headers, { request, state: "s1", agent: "codex" });
      expect(res.status).toBe(401);
    }
    // Nothing was approved, so the page's own request still works.
    expect(db.prepare("SELECT count(*) FROM agents WHERE name = 'codex'").pluck().get()).toBe(0);
    expect((await approve({ Origin: origin, Cookie: pair(cookie!) }, { request, state: "s1", agent: "codex", as: MARIA })).status).toBe(200);
  });

  it("refuses with 409 when the sign-in is not the one the page showed, so it never approves into another account", async () => {
    const { request } = await pending();
    // The page showed maria of owner; another tab has since signed this browser in with friend's full token.
    personToken();
    const friend = await signIn(addToken(db, "friend").token);
    const signed = { Origin: origin, Cookie: pair(friend.cookie!) };
    for (const as of [MARIA, { account: "owner" }, { account: "friend", person: "maria" }, null, undefined]) {
      const res = await approve(signed, { request, state: "s1", agent: "codex", as });
      expect(res.status).toBe(409);
    }
    expect(db.prepare("SELECT count(*) FROM agents WHERE name = 'codex'").pluck().get()).toBe(0);
    // Shown as friend's full token, it approves into friend.
    expect((await approve(signed, { request, state: "s1", agent: "codex", as: { account: "friend" } })).status).toBe(200);
    expect(db.prepare("SELECT a.name FROM agents g JOIN accounts a ON a.id = g.account_id WHERE g.name = 'codex'").pluck().get()).toBe("friend");
  });

  it("needs no as with a Bearer token, as before", async () => {
    const { request } = await pending();
    expect((await approve({ Authorization: `Bearer ${personToken()}` }, { request, state: "s1", agent: "codex" })).status).toBe(200);
  });

  it("needs the page's own request and state even when signed in", async () => {
    const { cookie } = await signIn(personToken());
    const { request } = await pending();
    const signed = { Origin: origin, Cookie: pair(cookie!) };
    expect((await approve(signed, { request: "0".repeat(64), state: "s1", agent: "codex", as: MARIA })).status).toBe(400);
    expect((await approve(signed, { request, state: "other", agent: "codex", as: MARIA })).status).toBe(400);
  });

  it("refuses a cookie whose token was revoked, or that is read-only or an agent's", async () => {
    const maria = personToken();
    const { cookie } = await signIn(maria);
    revokeToken(db, listTokens(db).find((t) => t.kind === "person")!.id);
    const { request } = await pending();
    expect((await approve({ Origin: origin, Cookie: pair(cookie!) }, { request, state: "s1", agent: "codex", as: MARIA })).status).toBe(401);
    // A cookie holding a read-only token, which POST /oauth/signin never sets, is refused all the same.
    const readOnly = addToken(db, "owner", true).token;
    expect((await approve({ Origin: origin, Cookie: `message-cp-signin=${readOnly}` }, { request, state: "s1", agent: "codex" })).status).toBe(403);
  });

  it("uses an Authorization header over the cookie, so a script's Bearer token works exactly as before", async () => {
    const { cookie } = await signIn(personToken());
    const { request } = await pending();
    // A wrong token with a good cookie is refused: the header, not the cookie, decides.
    expect((await approve({ Authorization: "Bearer wrong", Origin: origin, Cookie: pair(cookie!) }, { request, state: "s1", agent: "codex" })).status).toBe(401);
    expect((await approve({ Authorization: `Bearer ${addToken(db, "friend").token}` }, { request, state: "s1", agent: "codex" })).status).toBe(200);
    expect(db.prepare("SELECT account_id FROM agents WHERE name = 'codex'").pluck().get()).not.toBe(OWNER_ACCOUNT);
  });

  it("with fresh, refuses a suggested name an agent took meanwhile instead of connecting as that agent", async () => {
    const { cookie } = await signIn(personToken());
    const { request } = await pending();
    registerAgent(db, OWNER_ACCOUNT, "codex", "x");
    const signed = { Origin: origin, Cookie: pair(cookie!) };
    const res = await approve(signed, { request, state: "s1", agent: "codex", fresh: true, as: MARIA });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain("now exists");
    // Typed by the person, without fresh, the same name connects as that agent, as before.
    expect((await approve(signed, { request, state: "s1", agent: "codex", as: MARIA })).status).toBe(200);
  });
});

describe("the suggested agent name", () => {
  it("is the client's name in lower case, its other characters made '-', or client", () => {
    expect(agentNameBase("Codex")).toBe("codex");
    expect(agentNameBase("Claude Desktop (beta)")).toBe("claude-desktop-beta");
    expect(agentNameBase("<b>")).toBe("b");
    expect(agentNameBase("!!!")).toBe("client");
    expect(agentNameBase(null)).toBe("client");
    expect(agentNameBase("All")).toBe("client");
    expect(agentNameBase("a".repeat(40))).toBe("a".repeat(24));
  });

  it("is never a live agent's or person's name in the account, but may be another account's", () => {
    registerAgent(db, OWNER_ACCOUNT, "codex", "x");
    addPerson(db, "owner", "codex-2");
    expect(freeAgentName(db, OWNER_ACCOUNT, "codex")).toBe("codex-3");
    const friend = db.prepare("SELECT id FROM accounts WHERE name = 'friend'").pluck().get() as typeof OWNER_ACCOUNT;
    expect(freeAgentName(db, friend, "codex")).toBe("codex");
  });
});

describe("the approval page", () => {
  // Runs the page's script against stub elements and the given fetch, answering the stubs and the requests it made.
  async function load(answer: (url: string, init: RequestInit) => Response | Promise<Response>, publicUrl = origin) {
    const { html } = await pending(undefined, publicUrl);
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
    const dataset = {
      request: /data-request="([0-9a-f]+)"/.exec(html)![1],
      state: /data-state="([^"]*)"/.exec(html)![1],
      base: /data-base="([^"]*)"/.exec(html)![1],
      ...(html.includes(" data-signin>") && { signin: "" }),
    };
    const elements: Record<string, { hidden: boolean; value: string; textContent: string; required: boolean; disabled: boolean; dataset: Record<string, string>; on: Record<string, (e?: unknown) => void>; classList: { toggle(): void }; addEventListener(t: string, f: (e?: unknown) => void): void }> = {};
    const el = () => {
      const on: Record<string, (e?: unknown) => void> = {};
      return { hidden: false, value: "", textContent: "", required: true, disabled: false, dataset: {} as Record<string, string>, on, classList: { toggle() {} }, addEventListener: (t: string, f: (e?: unknown) => void) => void (on[t] = f) };
    };
    elements["approve"] = { ...el(), dataset };
    const requests: { url: string; init: RequestInit }[] = [];
    const assigned: string[] = [];
    const windowOn: Record<string, () => void> = {};
    runInNewContext(script, {
      AbortController,
      URLSearchParams,
      setTimeout,
      clearTimeout,
      location: { assign: (to: string) => assigned.push(to) },
      addEventListener: (t: string, f: () => void) => void (windowOn[t] = f),
      document: { getElementById: (id: string) => (elements[id] ??= el()) },
      fetch: (url: string, init: RequestInit) => {
        requests.push({ url, init });
        return Promise.resolve(answer(url, init));
      },
    });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
    await settle();
    return { elements, requests, assigned, windowOn, settle, submit: () => elements["approve"].on.submit({ preventDefault() {} }) };
  }

  it("signed in: says who approves, hides the token field, prefills a free name and approves with one click, sending no token", async () => {
    const page = await load((url) =>
      url.startsWith("signin")
        ? new Response(JSON.stringify({ account: "owner", person: "maria", name: "codex-2" }))
        : new Response(JSON.stringify({ location: "http://localhost:9999/callback?code=c" })),
    );
    page.windowOn.focus();
    await page.settle();
    expect(page.elements["signed-in"].textContent).toBe("Approving as maria");
    expect(page.elements["signed-in"].hidden).toBe(false);
    expect(page.elements["signed-out"].hidden).toBe(true);
    expect(page.elements["token-field"].hidden).toBe(true);
    expect(page.elements["approve-token"].required).toBe(false);
    expect(page.elements["approve-agent"].value).toBe("codex-2");
    page.submit();
    await page.settle();
    const sent = page.requests.find((r) => r.url === "approve")!;
    expect(sent.init.headers).toEqual({ "Content-Type": "application/json" });
    expect(sent.init.credentials).toBe("same-origin");
    expect(JSON.parse(sent.init.body as string)).toMatchObject({ agent: "codex-2", fresh: true, state: "s1" });
    expect(page.assigned).toEqual(["http://localhost:9999/callback?code=c"]);
  });

  it("sends who it showed, and on a 409 says so and checks again", async () => {
    let signedInAs = { account: "owner", person: "maria" };
    const page = await load((url) =>
      url.startsWith("signin")
        ? new Response(JSON.stringify({ ...signedInAs, name: "codex" }))
        : new Response(JSON.stringify({ message: "This browser is now signed in as someone else." }), { status: 409 }),
    );
    expect(page.elements["signed-in"].textContent).toBe("Approving as maria");
    signedInAs = { account: "friend" } as typeof signedInAs;
    page.submit();
    await page.settle();
    const sent = page.requests.find((r) => r.url === "approve")!;
    expect(JSON.parse(sent.init.body as string).as).toEqual({ account: "owner", person: "maria" });
    expect(page.elements["approve-note"].textContent).toContain("signed in as someone else");
    expect(page.elements["signed-in"].textContent).toBe("Approving with a full token of account friend");
    expect(page.assigned).toEqual([]);
  });

  it("treats a suggested name the person typed again as theirs, so it connects as an agent that took it", async () => {
    const page = await load((url) =>
      url.startsWith("signin")
        ? new Response(JSON.stringify({ account: "owner", person: "maria", name: "codex" }))
        : new Response(JSON.stringify({ message: "now exists" }), { status: 400 }),
    );
    expect(page.elements["approve-agent"].value).toBe("codex");
    page.submit();
    await page.settle();
    expect(JSON.parse(page.requests.filter((r) => r.url === "approve")[0].init.body as string).fresh).toBe(true);
    page.elements["approve-agent"].value = "codex";
    page.elements["approve-agent"].on.input();
    page.submit();
    await page.settle();
    expect(JSON.parse(page.requests.filter((r) => r.url === "approve")[1].init.body as string).fresh).toBe(false);
  });

  it("signed out: shows how to sign in and the token field, and sends the typed token with no cookie", async () => {
    const page = await load((url) =>
      url.startsWith("signin") ? new Response("{}", { status: 401 }) : new Response(JSON.stringify({ location: "http://localhost:9999/callback?code=c" })),
    );
    expect(page.elements["signed-in"].hidden).toBe(true);
    expect(page.elements["signed-out"].hidden).toBe(false);
    expect(page.elements["token-field"].hidden).toBe(false);
    expect(page.elements["approve-token"].required).toBe(true);
    page.elements["approve-token"].value = "typed";
    page.elements["approve-agent"].value = "desk";
    page.submit();
    await page.settle();
    const sent = page.requests.find((r) => r.url === "approve")!;
    expect(sent.init.headers).toEqual({ Authorization: "Bearer typed", "Content-Type": "application/json" });
    expect(sent.init.credentials).toBe("omit");
    expect(JSON.parse(sent.init.body as string)).toMatchObject({ agent: "desk", fresh: false });
  });

  it("asks GET signin for the client's name base, with the cookie and nothing in the URL but the base", async () => {
    const page = await load(() => new Response("{}", { status: 401 }));
    expect(page.requests[0].url).toBe("signin?base=codex");
    expect(page.requests[0].init.credentials).toBe("same-origin");
  });

  it("goes back to the token field when the sign-in ends before approving", async () => {
    let signedIn = true;
    const page = await load((url) =>
      url.startsWith("signin")
        ? new Response(JSON.stringify({ account: "owner", person: "maria" }), { status: signedIn ? 200 : 401 })
        : new Response("{}", { status: 401 }),
    );
    page.windowOn.focus();
    await page.settle();
    expect(page.elements["token-field"].hidden).toBe(true);
    signedIn = false;
    page.submit();
    await page.settle();
    expect(page.elements["token-field"].hidden).toBe(false);
    expect(page.elements["approve-note"].textContent).toContain("no longer signed in");
    // Coming back after signing out of the dashboard shows the page signed out too.
    page.windowOn.focus();
    await page.settle();
    expect(page.elements["signed-out"].hidden).toBe(false);
  });

  it("under an http public URL, never asks about a sign-in and does not offer one", async () => {
    await http.close();
    http = await startHttp(db, { token: OWNER_TOKEN, port: 0, waitHoldMs: 0, publicUrl: "http://127.0.0.1:1" });
    server = `http://127.0.0.1:${http.port}`;
    const { html } = await pending(undefined, "http://127.0.0.1:1");
    expect(html).not.toContain("data-signin");
    expect(html).toContain('<div id="signed-out" hidden>');
    const page = await load(() => new Response("{}"), "http://127.0.0.1:1");
    page.windowOn.focus?.();
    await page.settle();
    expect(page.requests).toEqual([]);
    expect(page.elements["token-field"].hidden).toBe(false);
  });

  it("links to the dashboard in a new tab, and keeps a typed agent name when a check answers", async () => {
    const { html } = await pending();
    expect(html).toContain('<a href="../" target="_blank" rel="noopener">Sign in on the dashboard</a>');
    const page = await load(() => new Response(JSON.stringify({ account: "owner", person: "maria", name: "codex" })));
    page.elements["approve-agent"].value = "mine";
    page.windowOn.focus();
    await page.settle();
    expect(page.elements["approve-agent"].value).toBe("mine");
  });
});

describe("the dashboard and the approval page together", () => {
  it("signs in with the token the dashboard confirmed and signs out with Forget token", async () => {
    const maria = personToken();
    const { cookie } = await signIn(maria);
    expect(await (await whoami(pair(cookie!))).json()).toEqual({ account: "owner", person: "maria" });
    const out = await fetch(`${server}/oauth/signin`, { method: "DELETE", headers: { Origin: origin } });
    // The browser applies Max-Age=0 and stops sending the cookie, so the page then finds no sign-in.
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await whoami(null)).status).toBe(401);
  });
});
