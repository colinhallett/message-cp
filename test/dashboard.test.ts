import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addToken, revokeToken } from "../src/accounts.js";
import { OWNER_ACCOUNT, openDb, type Db } from "../src/db.js";
import { identityOf, registerAgent } from "../src/agents.js";
import { joinChannel, post } from "../src/channels.js";
import { sendMessage, unreadSummary } from "../src/messages.js";
import { startHttp, type HttpServer } from "../src/http.js";

// The dashboard page at GET /, served before the token check, and everything else still behind it.
const OWNER_TOKEN = "owner-token";
let db: Db;
let http: HttpServer;
let viewer: string;

beforeEach(async () => {
  db = openDb(join(mkdtempSync(join(tmpdir(), "message-cp-dashboard-")), "db.sqlite"));
  viewer = addToken(db, "owner", true).token;
  http = await startHttp(db, { token: OWNER_TOKEN, port: 0 });
});

afterEach(async () => {
  await http.close();
  db.close();
});

const base = () => `http://127.0.0.1:${http.port}`;
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

describe("GET /", () => {
  it("answers 200 with the page and its security headers, without a token", async () => {
    const res = await fetch(`${base()}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const csp = res.headers.get("content-security-policy") ?? "";
    for (const directive of ["default-src 'none'", "connect-src 'self'", "frame-ancestors 'none'"]) {
      expect(csp.split("; ")).toContain(directive);
    }
    expect(csp).not.toContain("unsafe-inline");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain("/api/agents");
    expect(html).toContain("/api/channels");
    expect(html).toContain("/api/channel-posts");
    expect(html).toContain("/api/messages");
    // The query is not part of the path.
    expect((await fetch(`${base()}/?x=1`)).status).toBe(200);
  });

  it("is the same page with any token or none, and holds no data or token", async () => {
    registerAgent(db, OWNER_ACCOUNT, "secret-agent-name", "secret bio");
    const pages = await Promise.all(
      [{}, auth(OWNER_TOKEN), auth(viewer), auth("wrong")].map(async (headers) => (await fetch(`${base()}/`, { headers })).text()),
    );
    for (const page of pages) expect(page).toBe(pages[0]);
    for (const secret of ["secret-agent-name", "secret bio", OWNER_TOKEN, viewer]) expect(pages[0]).not.toContain(secret);
  });

  it("keeps the token in sessionStorage and builds no HTML from strings", async () => {
    const html = await (await fetch(`${base()}/`)).text();
    expect(html).toContain("sessionStorage");
    for (const banned of ["innerHTML", "outerHTML", "insertAdjacentHTML", "localStorage", "document.cookie", "document.write", "console."]) {
      expect(html).not.toContain(banned);
    }
  });

  it("allows the page's inline script and style by their hashes", async () => {
    const res = await fetch(`${base()}/`);
    const csp = res.headers.get("content-security-policy") ?? "";
    const html = await res.text();
    const sha = (text: string) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1];
    expect(csp).toContain(`script-src ${sha(script)}`);
    expect(csp).toContain(`style-src ${sha(style)}`);
  });
});

describe("the page's polling", () => {
  // Runs the served script against stub DOM elements, a fetch that never answers, and timers run by hand.
  async function load() {
    const html = await (await fetch(`${base()}/`)).text();
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
    const el = () => {
      const on: Record<string, () => void> = {};
      return { on, hidden: false, value: "", textContent: "", className: "", addEventListener: (type: string, fn: () => void) => void (on[type] = fn), focus() {}, replaceChildren() {} };
    };
    const elements: Record<string, ReturnType<typeof el>> = {};
    const timers = new Map<number, { fn: () => void; ms: number }>();
    let nextTimer = 0;
    const signals: AbortSignal[] = [];
    const store = new Map([["message-cp-token", "a-token"]]);
    runInNewContext(script, {
      AbortController,
      URLSearchParams,
      document: { getElementById: (id: string) => (elements[id] ??= el()), createElement: el },
      sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
      setTimeout: (fn: () => void, ms: number) => (timers.set(++nextTimer, { fn, ms }), nextTimer),
      clearTimeout: (id: number) => timers.delete(id),
      fetch: (_url: string, init: { signal: AbortSignal }) => {
        signals.push(init.signal);
        return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
      },
    });
    const fire = async (ms: number) => {
      const [id, timer] = [...timers].find(([, t]) => t.ms === ms)!;
      timers.delete(id);
      timer.fn();
      await new Promise((resolve) => setImmediate(resolve));
    };
    return { status: elements["status-line"], forget: elements["forget"], timers, signals, fire };
  }

  it("abandons a request that never answers and polls again", async () => {
    const page = await load();
    expect(page.signals).toHaveLength(1);
    await page.fire(15000);
    expect(page.signals[0].aborted).toBe(true);
    expect(page.status.textContent).toBe("The server did not answer in time. Retrying…");
    await page.fire(5000);
    expect(page.signals).toHaveLength(2);
    expect(page.signals[1].aborted).toBe(false);
  });

  it("aborts the request in flight when the token is forgotten", async () => {
    const page = await load();
    page.forget.on.click();
    expect(page.signals[0].aborted).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(page.timers.size).toBe(0);
    expect(page.signals).toHaveLength(1);
  });
});

describe("the page's channels and messages", () => {
  // A stub DOM element: enough for the script to build rows and for the test to read them and click buttons.
  interface Stub {
    on: Record<string, () => void>;
    hidden: boolean;
    value: string;
    textContent: string;
    className: string;
    title: string;
    children: Stub[];
    top: number;
    scrollTop: number;
    readonly scrollHeight: number;
    readonly clientHeight: number;
    append(...children: Stub[]): void;
    replaceChildren(...children: Stub[]): void;
    addEventListener(type: string, fn: () => void): void;
    focus(): void;
  }
  // Elements start hidden, as the page's form, view and log do.
  const el = (): Stub => ({
    on: {},
    hidden: true,
    value: "",
    textContent: "",
    className: "",
    title: "",
    children: [],
    // A box 100px high whose rows are 20px each, scrolled as a browser does: never past the last row.
    top: 0,
    get scrollHeight() {
      return this.children.length * 20;
    },
    clientHeight: 100,
    get scrollTop() {
      return this.top;
    },
    set scrollTop(value: number) {
      this.top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
    },
    append(...children) {
      this.children.push(...children);
    },
    replaceChildren(...children) {
      this.children = children;
    },
    addEventListener(type, fn) {
      this.on[type] = fn;
    },
    focus() {},
  });
  // A sidebar item's label and count, and the button that opens it.
  const item = (row: Stub) => row.children[0].children.map((c) => c.textContent);
  const open = (row: Stub) => row.children[0].on.click();
  // A chat-log entry's field by class name: from, tag, time or body.
  const field = (row: Stub, name: string) => row.children.find((c) => c.className === name)?.textContent;
  const entries = (log: Stub) => log.children.map((row) => [field(row, "from"), field(row, "body")]);

  // Runs the served script with the given token against this server, with real fetches and timers run by hand.
  // refuse, when it returns a status, answers a request with that status instead of the server; "hang" never answers,
  // and "fail" rejects as an unreachable server does.
  async function load(token: string, refuse: (url: string) => number | "hang" | "fail" | undefined = () => undefined) {
    const html = await (await fetch(`${base()}/`)).text();
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
    const elements: Record<string, Stub> = {};
    const urls: string[] = [];
    const polls: (() => void)[] = [];
    const store = new Map([["message-cp-token", token]]);
    runInNewContext(script, {
      AbortController,
      URLSearchParams,
      document: { getElementById: (id: string) => (elements[id] ??= el()), createElement: el },
      sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
      setTimeout: (fn: () => void, ms: number) => (ms === 5000 && polls.push(fn), 0),
      clearTimeout: () => {},
      fetch: (url: string, init: RequestInit) => {
        urls.push(url);
        const status = refuse(url);
        if (status === "hang") return new Promise<Response>(() => {});
        if (status === "fail") return Promise.reject(new TypeError("fetch failed"));
        return status === undefined ? fetch(`${base()}${url}`, init) : Promise.resolve(new Response(null, { status }));
      },
    });
    const until = async (done: () => boolean) => {
      for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(done()).toBe(true);
    };
    // Runs the poll the page scheduled last; earlier ones belong to polls it has since cancelled.
    const poll = () => polls.splice(0).pop()!();
    return { elements, urls, store, until, poll };
  }

  it("lists the channels with a read-only token and shows a chosen channel's posts oldest first", async () => {
    for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
    const member = (name: string) => ({ ...identityOf(db, OWNER_ACCOUNT, name)!, name });
    joinChannel(db, OWNER_ACCOUNT, member("alice"), "build");
    joinChannel(db, OWNER_ACCOUNT, member("bob"), "build");
    post(db, OWNER_ACCOUNT, member("alice"), "build", "first <b>post</b>");
    post(db, OWNER_ACCOUNT, member("bob"), "build", "second");
    post(db, OWNER_ACCOUNT, member("bob"), "ops", "elsewhere");

    const page = await load(viewer);
    const channels = page.elements["channel-rows"];
    await page.until(() => channels.children.length === 2);
    expect(channels.children.map(item)).toEqual([
      ["build", "2"],
      ["ops", "1"],
    ]);
    expect(channels.children.map((row) => row.children[0].title)).toEqual([
      expect.stringMatching(/^Members: alice, bob; 2 posts, last post /),
      expect.stringMatching(/^Members: –; 1 posts, last post /),
    ]);
    expect(page.elements["log"].hidden).toBe(true);

    const posts = page.elements["post-rows"];
    open(channels.children[1]);
    await page.until(() => posts.children.length === 1);
    expect(page.urls).toContain("/api/channel-posts?channel=ops&limit=200&offset=0");
    open(channels.children[0]);
    await page.until(() => posts.children.length === 2);
    expect(page.elements["log"].hidden).toBe(false);
    expect(page.elements["log-title"].textContent).toBe("build");
    expect(entries(posts)).toEqual([
      ["alice", "first <b>post</b>"],
      ["bob", "second"],
    ]);
    // The token went only in the header.
    for (const url of page.urls) expect(url).not.toContain(viewer);

    page.elements["forget"].on.click();
    expect(channels.children).toHaveLength(0);
    expect(posts.children).toHaveLength(0);
    expect(page.elements["log"].hidden).toBe(true);
    expect(page.store.size).toBe(0);
  });

  const seed = () => {
    registerAgent(db, OWNER_ACCOUNT, "alice", "x");
    post(db, OWNER_ACCOUNT, { ...identityOf(db, OWNER_ACCOUNT, "alice")!, name: "alice" }, "build", "hello");
  };

  it("clears the channels and the open log when the server refuses the token", async () => {
    seed();
    const ticket = addToken(db, "owner", true);
    const page = await load(ticket.token);
    const channels = page.elements["channel-rows"];
    await page.until(() => channels.children.length === 1);
    open(channels.children[0]);
    await page.until(() => page.elements["post-rows"].children.length === 1);

    revokeToken(db, ticket.id);
    page.poll();
    await page.until(() => page.elements["status-line"].textContent.startsWith("The server refused"));
    expect(channels.children).toHaveLength(0);
    expect(page.elements["post-rows"].children).toHaveLength(0);
    expect(page.elements["log"].hidden).toBe(true);
    expect(page.store.size).toBe(0);
  });

  it("says a channel that has gone is not there, and keeps the token", async () => {
    seed();
    const page = await load(viewer, (url) => (url.startsWith("/api/channel-posts") ? 404 : undefined));
    const channels = page.elements["channel-rows"];
    await page.until(() => channels.children.length === 1);
    open(channels.children[0]);
    await page.until(() => page.elements["log-note"].textContent === "There is no channel by this name now.");
    expect(page.elements["log"].hidden).toBe(false);
    expect(page.elements["login"].hidden).toBe(true);
    expect(page.store.size).toBe(1);
    expect(channels.children).toHaveLength(1);
  });

  it("pages through every channel and every post", async () => {
    registerAgent(db, OWNER_ACCOUNT, "alice", "x");
    const alice = { ...identityOf(db, OWNER_ACCOUNT, "alice")!, name: "alice" };
    for (let i = 0; i < 201; i++) joinChannel(db, OWNER_ACCOUNT, alice, `c${String(i).padStart(3, "0")}`);
    for (let i = 0; i < 201; i++) post(db, OWNER_ACCOUNT, alice, "c000", `post ${i}`);
    const page = await load(viewer);
    const channels = page.elements["channel-rows"];
    await page.until(() => channels.children.length === 201);
    expect(item(channels.children[200])[0]).toBe("c200");
    open(channels.children[0]);
    const posts = page.elements["post-rows"];
    await page.until(() => posts.children.length === 201);
    expect(field(posts.children[0], "body")).toBe("post 0");
    expect(field(posts.children[200], "body")).toBe("post 200");
    expect(page.urls).toContain("/api/channels?limit=200&offset=200");
    expect(page.urls).toContain("/api/channel-posts?channel=c000&limit=200&offset=200");
  });
  it("reads only the posts past the ones the log holds on each poll, and shows the agents and channels first", async () => {
    seed();
    const alice = { ...identityOf(db, OWNER_ACCOUNT, "alice")!, name: "alice" };
    let hang = false;
    const page = await load(viewer, (url) => (hang && url.startsWith("/api/channel-posts") ? "hang" : undefined));
    const channels = page.elements["channel-rows"];
    const posts = page.elements["post-rows"];
    await page.until(() => channels.children.length === 1);
    open(channels.children[0]);
    await page.until(() => posts.children.length === 1);

    post(db, OWNER_ACCOUNT, alice, "build", "second");
    page.urls.length = 0;
    page.poll();
    await page.until(() => posts.children.length === 2);
    expect(page.urls).toContain("/api/channel-posts?channel=build&limit=200&offset=1");
    expect(page.urls).not.toContain("/api/channel-posts?channel=build&limit=200&offset=0");
    expect(posts.children.map((row) => field(row, "body"))).toEqual(["hello", "second"]);

    // A log read that has not answered yet does not hold back the agents and channels.
    joinChannel(db, OWNER_ACCOUNT, alice, "ops");
    hang = true;
    page.poll();
    await page.until(() => channels.children.length === 2);
    expect(posts.children).toHaveLength(2);
  });

  it("lists a channel once when its page boundary moves between reads", async () => {
    registerAgent(db, OWNER_ACCOUNT, "alice", "x");
    const alice = { ...identityOf(db, OWNER_ACCOUNT, "alice")!, name: "alice" };
    for (let i = 1; i <= 200; i++) joinChannel(db, OWNER_ACCOUNT, alice, `c${String(i).padStart(3, "0")}`);
    // After the first page is read, a channel that sorts first is created, so c200 comes back on the second page too.
    const page = await load(viewer, (url) => {
      if (url === "/api/channels?limit=200&offset=200") joinChannel(db, OWNER_ACCOUNT, alice, "a000");
      return undefined;
    });
    const channels = page.elements["channel-rows"];
    await page.until(() => channels.children.length > 0);
    const names = channels.children.map((row) => item(row)[0]);
    expect(names).toHaveLength(200);
    expect(new Set(names).size).toBe(200);
  });

  it("lists the pairs that have messaged each other with a read-only token, marks a broadcast, and reads nothing as read", async () => {
    for (const name of ["alice", "bob", "carol"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "hi <b>bob</b>");
    sendMessage(db, OWNER_ACCOUNT, "bob", "all", "to everyone");
    const page = await load(viewer);
    const pairs = page.elements["pair-rows"];
    await page.until(() => pairs.children.length === 2);
    // The newest pair first; alice to bob and bob to alice are one pair.
    expect(pairs.children.map(item)).toEqual([
      ["bob ↔ carol", "1"],
      ["alice ↔ bob", "2"],
    ]);
    expect(page.urls).toContain("/api/messages?limit=200&offset=0");
    for (const url of page.urls) expect(url).not.toContain(viewer);

    const log = page.elements["post-rows"];
    open(pairs.children[1]);
    expect(page.elements["log"].hidden).toBe(false);
    expect(page.elements["log-title"].textContent).toBe("alice ↔ bob");
    expect(entries(log)).toEqual([
      ["alice", "hi <b>bob</b>"],
      ["bob", "to everyone"],
    ]);
    expect(log.children.map((row) => field(row, "tag"))).toEqual([undefined, "broadcast"]);
    // Nothing the page did marked a message read.
    expect(unreadSummary(db, OWNER_ACCOUNT, "bob")!.count).toBe(1);

    page.elements["forget"].on.click();
    expect(pairs.children).toHaveLength(0);
    expect(log.children).toHaveLength(0);
    expect(page.elements["log"].hidden).toBe(true);
    expect(page.store.size).toBe(0);
  });

  it("shows only the chosen pair's messages, oldest first, and swaps a channel for a pair", async () => {
    seed();
    for (const name of ["bob", "carol"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "one");
    sendMessage(db, OWNER_ACCOUNT, "carol", "alice", "elsewhere");
    sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "two");
    const page = await load(viewer);
    const pairs = page.elements["pair-rows"];
    const log = page.elements["post-rows"];
    await page.until(() => pairs.children.length === 2 && page.elements["channel-rows"].children.length === 1);
    open(page.elements["channel-rows"].children[0]);
    await page.until(() => log.children.length === 1);

    page.urls.length = 0;
    open(pairs.children.find((row) => item(row)[0] === "alice ↔ bob")!);
    expect(entries(log)).toEqual([
      ["alice", "one"],
      ["bob", "two"],
    ]);
    expect(page.elements["log-title"].textContent).toBe("alice ↔ bob");
    // The pair comes from the messages the page holds, and the channel's log is no longer read.
    page.poll();
    await page.until(() => page.urls.some((url) => url.startsWith("/api/messages")));
    expect(page.urls.filter((url) => url.startsWith("/api/channel-posts"))).toEqual([]);
  });

  it("reads the chosen pair at once while the channel open before has not answered", async () => {
    for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
    post(db, OWNER_ACCOUNT, { ...identityOf(db, OWNER_ACCOUNT, "alice")!, name: "alice" }, "build", "hello");
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "one");
    const page = await load(viewer, (url) => (url.startsWith("/api/channel-posts") ? "hang" : undefined));
    const pairs = page.elements["pair-rows"];
    const log = page.elements["post-rows"];
    await page.until(() => pairs.children.length === 1 && page.elements["channel-rows"].children.length === 1);
    open(page.elements["channel-rows"].children[0]);
    await page.until(() => page.urls.some((url) => url.startsWith("/api/channel-posts")));

    sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "two");
    open(pairs.children[0]);
    // No poll is run by hand: opening the pair drops the poll waiting on the channel and reads the messages again.
    await page.until(() => log.children.length === 2);
    expect(entries(log)).toEqual([
      ["alice", "one"],
      ["bob", "two"],
    ]);
  });

  it("follows new entries at the bottom of the open log, and leaves a reader scrolled up where they are", async () => {
    for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
    for (let i = 0; i < 10; i++) sendMessage(db, OWNER_ACCOUNT, "alice", "bob", `message ${i}`);
    const page = await load(viewer);
    const pairs = page.elements["pair-rows"];
    const log = page.elements["post-rows"];
    await page.until(() => pairs.children.length === 1);
    open(pairs.children[0]);
    expect(log.scrollTop).toBe(100);

    sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "at the bottom");
    page.poll();
    await page.until(() => log.children.length === 11);
    expect(log.scrollTop).toBe(120);

    log.scrollTop = 0;
    sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "scrolled up");
    page.poll();
    await page.until(() => log.children.length === 12);
    expect(log.scrollTop).toBe(0);
  });

  it("pages through every message, then appends only the new ones for the open pair on each poll", async () => {
    for (const name of ["alice", "bob", "carol"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
    for (let i = 0; i < 201; i++) sendMessage(db, OWNER_ACCOUNT, "alice", "bob", `message ${i}`);
    const page = await load(viewer);
    const pairs = page.elements["pair-rows"];
    await page.until(() => pairs.children.length === 1 && item(pairs.children[0])[1] === "201");
    expect(page.urls).toContain("/api/messages?limit=200&offset=200");
    open(pairs.children[0]);
    const log = page.elements["post-rows"];
    expect(log.children).toHaveLength(201);
    expect(field(log.children[200], "body")).toBe("message 200");

    sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "reply");
    sendMessage(db, OWNER_ACCOUNT, "carol", "bob", "not this pair");
    page.urls.length = 0;
    page.poll();
    await page.until(() => log.children.length === 202);
    expect(page.urls.filter((url) => url.startsWith("/api/messages"))).toEqual(["/api/messages?limit=200&offset=201"]);
    expect(entries(log).slice(-1)).toEqual([["bob", "reply"]]);
    await page.until(() => pairs.children.length === 2);
    expect(log.children).toHaveLength(202);
  });

  it("clears the pairs and the open conversation when the server refuses the token", async () => {
    for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "hello");
    const ticket = addToken(db, "owner", true);
    const page = await load(ticket.token);
    const pairs = page.elements["pair-rows"];
    await page.until(() => pairs.children.length === 1);
    open(pairs.children[0]);
    expect(page.elements["post-rows"].children).toHaveLength(1);
    revokeToken(db, ticket.id);
    page.poll();
    await page.until(() => page.elements["status-line"].textContent.startsWith("The server refused"));
    expect(pairs.children).toHaveLength(0);
    expect(page.elements["post-rows"].children).toHaveLength(0);
    expect(page.elements["log"].hidden).toBe(true);
    expect(page.elements["log-title"].textContent).toBe("");
    expect(page.store.size).toBe(0);
  });

  it("shows the agents and channels while the messages have not answered", async () => {
    seed();
    const page = await load(viewer, (url) => (url.startsWith("/api/messages") ? "hang" : undefined));
    await page.until(() => page.elements["channel-rows"].children.length === 1);
    expect(page.elements["rows"].children).toHaveLength(1);
    expect(page.elements["pair-rows"].children).toHaveLength(0);
    // Nor an open channel's log.
    open(page.elements["channel-rows"].children[0]);
    await page.until(() => page.elements["post-rows"].children.length === 1);
  });

  it("reads an open channel's log when the messages fail", async () => {
    seed();
    const page = await load(viewer, (url) => (url.startsWith("/api/messages") ? 503 : undefined));
    const channels = page.elements["channel-rows"];
    await page.until(() => channels.children.length === 1);
    open(channels.children[0]);
    await page.until(() => page.elements["post-rows"].children.length === 1);
    await page.until(() => page.elements["status-line"].textContent === "The server is busy (503). Retrying…");
  });

  it.each([503, "fail"] as const)("asks for another token when the log is refused while the messages %s", async (failure) => {
    seed();
    let revoked = false;
    const page = await load(viewer, (url) =>
      url.startsWith("/api/messages") ? failure : revoked && url.startsWith("/api/channel-posts") ? 401 : undefined,
    );
    const channels = page.elements["channel-rows"];
    await page.until(() => channels.children.length === 1);
    open(channels.children[0]);
    await page.until(() => page.elements["post-rows"].children.length === 1);
    revoked = true;
    page.poll();
    await page.until(() => page.elements["status-line"].textContent.startsWith("The server refused"));
    expect(page.elements["post-rows"].children).toHaveLength(0);
    expect(page.store.size).toBe(0);
  });
});

describe("everything but GET / still needs the token", () => {
  it("refuses other methods at / and other paths without a token", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await fetch(`${base()}/`, { method });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
    }
    expect((await fetch(`${base()}/mcp`)).status).toBe(401);
    expect((await fetch(`${base()}/api/agents`)).status).toBe(401);
    expect((await fetch(`${base()}/index.html`)).status).toBe(401);
  });

  it("keeps a read-only token to the read-only endpoints", async () => {
    expect((await fetch(`${base()}/elsewhere`, { headers: auth(viewer) })).status).toBe(403);
    expect((await fetch(`${base()}/`, { method: "POST", headers: auth(viewer) })).status).toBe(403);
    expect((await fetch(`${base()}/api/agents`, { headers: auth(viewer) })).status).toBe(200);
  });
});
