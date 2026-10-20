import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addAccount, addToken, listAccounts, revokeToken } from "../src/accounts.js";
import { OWNER_ACCOUNT, openDb, type Db } from "../src/db.js";
import { addPerson, identityOf, registerAgent } from "../src/agents.js";
import { joinChannel, post } from "../src/channels.js";
import { MAX_BODY_LENGTH, sendMessage, unreadSummary } from "../src/messages.js";
import { startHttp, type HttpServer } from "../src/http.js";
import { addWebhook } from "../src/webhooks.js";

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
    expect(html).toContain("/api/search");
    expect(html).toContain("/api/webhook-deliveries");
    expect(html).toMatch(/<form id="search"[^>]*>\s*<input id="search-text"[^>]*maxlength="400" required/);
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
      // GET /api/token answers at once, so only the polls' requests are left to hang.
      fetch: (url: string, init: { signal: AbortSignal }) => {
        if (url === "/api/token") return Promise.resolve(new Response(JSON.stringify({ readOnly: true })));
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
    await new Promise((resolve) => setImmediate(resolve));
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
  // globals adds to or replaces what the script sees, such as a Date with a fixed now.
  async function load(
    token: string,
    refuse: (url: string) => number | "hang" | "fail" | undefined = () => undefined,
    globals: Record<string, unknown> = {},
  ) {
    const html = await (await fetch(`${base()}/`)).text();
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
    const elements: Record<string, Stub> = {};
    const urls: string[] = [];
    const polls: (() => void)[] = [];
    const store = new Map([["message-cp-token", token]]);
    runInNewContext(script, {
      ...globals,
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
      ...globals,
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
  it("marks a person in the agents panel as a person, in place of the online dot", async () => {
    registerAgent(db, OWNER_ACCOUNT, "alice", "x");
    addPerson(db, "owner", "colin");
    const page = await load(viewer);
    const rows = page.elements["rows"];
    await page.until(() => rows.children.length === 2);
    const marks = rows.children.map((row) => [field(row, "name"), row.children[0].className, row.children[0].textContent, row.children[0].title]);
    expect(marks).toEqual([
      ["alice", "dot online", "online", "online"],
      ["colin", "kind", "person", "a person, not an agent"],
    ]);
    expect(rows.children.map((row) => field(row, "seen")?.split(" ")[0])).toEqual(["last", "added"]);
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
  describe("the log as a chat", () => {
    const MIN = 60 * 1000;
    // Sets when the messages and posts were sent, oldest first, as ms before now.
    const backdate = (table: "messages" | "channel_posts", ...ago: number[]) => {
      const ids = (db.prepare(`SELECT id FROM ${table} ORDER BY id`).all() as { id: number }[]).map((r) => r.id);
      const now = Date.now();
      ids.forEach((id, i) => db.prepare(`UPDATE ${table} SET created_at = ? WHERE id = ?`).run(now - ago[i], id));
    };
    const grouped = (log: Stub) => log.children.map((row) => [field(row, "from"), row.className.split(" ").includes("cont")]);
    const avatar = (row: Stub) => row.children.find((c) => c.className.startsWith("avatar"))!;
    const colour = (row: Stub) => row.className.split(" ").find((c) => /^c\d$/.test(c));

    it("groups entries from one sender less than 5 minutes apart, and starts a group for another sender or a gap", async () => {
      for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
      for (const [from, to] of [["alice", "bob"], ["alice", "bob"], ["bob", "alice"], ["bob", "alice"], ["bob", "alice"]]) {
        sendMessage(db, OWNER_ACCOUNT, from, to, "x");
      }
      // alice twice 1m apart; bob, then 5m later (a new group), then 4m59s later (the same group).
      backdate("messages", 20 * MIN, 19 * MIN, 18 * MIN, 13 * MIN, 13 * MIN - (5 * MIN - 1000));
      const page = await load(viewer);
      const pairs = page.elements["pair-rows"];
      await page.until(() => pairs.children.length === 1);
      open(pairs.children[0]);
      const log = page.elements["post-rows"];
      expect(grouped(log)).toEqual([
        ["alice", false],
        ["alice", true],
        ["bob", false],
        ["bob", false],
        ["bob", true],
      ]);
      // Every entry keeps its parts, and the stylesheet hides a continuation's avatar, name and tag.
      expect(log.children.map((row) => avatar(row).textContent)).toEqual(["AL", "AL", "BO", "BO", "BO"]);
      const html = await (await fetch(`${base()}/`)).text();
      expect(html).toContain(".entry.cont > .avatar, .entry.cont > .from, .entry.cont > .kind, .entry.cont > .tag { display: none; }");

      // A message appended by a later poll continues the group of the last entry the log holds.
      sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "y");
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "z");
      page.poll();
      await page.until(() => log.children.length === 7);
      expect(grouped(log).slice(-2)).toEqual([
        ["bob", false],
        ["alice", false],
      ]);
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "again");
      page.poll();
      await page.until(() => log.children.length === 8);
      expect(grouped(log).slice(-1)).toEqual([["alice", true]]);
    });

    it("groups channel posts across a poll, never continues a broadcast, and leaves search results and deliveries alone", async () => {
      for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
      const alice = { ...identityOf(db, OWNER_ACCOUNT, "alice")!, name: "alice" };
      post(db, OWNER_ACCOUNT, alice, "build", "one");
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "direct");
      sendMessage(db, OWNER_ACCOUNT, "alice", "all", "everyone");
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "after");
      const page = await load(viewer);
      const channels = page.elements["channel-rows"];
      const log = page.elements["post-rows"];
      await page.until(() => channels.children.length === 1 && page.elements["pair-rows"].children.length === 1);
      open(channels.children[0]);
      await page.until(() => log.children.length === 1);
      post(db, OWNER_ACCOUNT, alice, "build", "two");
      page.poll();
      await page.until(() => log.children.length === 2);
      expect(grouped(log)).toEqual([
        ["alice", false],
        ["alice", true],
      ]);

      // A broadcast keeps its own name and tag, and the entry after it starts a group.
      open(page.elements["pair-rows"].children[0]);
      expect(log.children.map((row) => [field(row, "tag"), row.className.split(" ").includes("cont")])).toEqual([
        [undefined, false],
        ["broadcast", false],
        [undefined, false],
      ]);

      page.elements["search-text"].value = "e";
      page.elements["search"].on.submit({ preventDefault() {} } as never);
      const found = page.elements["result-rows"];
      await page.until(() => found.children.length === 4);
      for (const row of found.children) {
        expect(row.className).toBe("entry result");
        expect(row.children.some((c) => c.className.startsWith("avatar"))).toBe(false);
      }
    });

    it("gives a name the same colour on every load, in any case, and initials of at most two characters", async () => {
      for (const name of ["alice", "code-reviewer", "Bob_the_builder", "z"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
      for (const name of ["alice", "code-reviewer", "Bob_the_builder", "z"]) {
        post(db, OWNER_ACCOUNT, { ...identityOf(db, OWNER_ACCOUNT, name)!, name }, "build", "x");
      }
      // Far enough apart that every post starts a group.
      backdate("channel_posts", 40 * MIN, 30 * MIN, 20 * MIN, 10 * MIN);
      const read = async () => {
        const page = await load(viewer);
        await page.until(() => page.elements["channel-rows"].children.length === 1);
        open(page.elements["channel-rows"].children[0]);
        const log = page.elements["post-rows"];
        await page.until(() => log.children.length === 4);
        return log.children.map((row) => [avatar(row).textContent, colour(row)]);
      };
      const first = await read();
      expect(first.map(([initials]) => initials)).toEqual(["AL", "CR", "BT", "Z"]);
      for (const [, c] of first) expect(c).toMatch(/^c[0-7]$/);
      expect(await read()).toEqual(first);
      // The hash is of the name in lower case, so ALICE gets alice's colour.
      sendMessage(db, OWNER_ACCOUNT, "ALICE", "z", "x");
      const page = await load(viewer);
      await page.until(() => page.elements["pair-rows"].children.length === 1);
      open(page.elements["pair-rows"].children[0]);
      expect(colour(page.elements["post-rows"].children[0])).toBe(first[0][1]);
      // Each palette colour is defined for the light theme and again for the dark one, and the name uses it too.
      const html = await (await fetch(`${base()}/`)).text();
      for (let i = 0; i < 8; i++) {
        expect(html.match(new RegExp(`--who${i}: #`, "g"))).toHaveLength(2);
        expect(html).toContain(`.c${i} { --who: var(--who${i}); }`);
      }
      expect(html).toContain(".entry.chat > .from { color: var(--who); }");
      expect(html).not.toMatch(/style=/);
    });

    it("gives a person GET /api/agents lists a round avatar and a person label, and anyone else a square one", async () => {
      registerAgent(db, OWNER_ACCOUNT, "alice", "x");
      addPerson(db, "owner", "colin");
      sendMessage(db, OWNER_ACCOUNT, "alice", "colin", "hi");
      sendMessage(db, OWNER_ACCOUNT, "colin", "alice", "hello");
      // A sender's name is matched to the people without case, and one GET /api/agents does not list is an agent.
      sendMessage(db, OWNER_ACCOUNT, "COLIN", "alice", "shouting");
      sendMessage(db, OWNER_ACCOUNT, "ghost", "alice", "from no one listed");
      const page = await load(viewer);
      const pairs = page.elements["pair-rows"];
      await page.until(() => pairs.children.length === 3 && page.elements["rows"].children.length === 2);
      const log = page.elements["post-rows"];
      const marks = (pair: string) => {
        open(pairs.children.find((row) => item(row)[0] === pair)!);
        return log.children.map((row) => [field(row, "from"), avatar(row).className, field(row, "kind")]);
      };
      expect(marks("alice ↔ colin")).toEqual([
        ["alice", "avatar", undefined],
        ["colin", "avatar person", "person"],
      ]);
      expect(marks("COLIN ↔ alice")).toEqual([["COLIN", "avatar person", "person"]]);
      expect(marks("alice ↔ ghost")).toEqual([["ghost", "avatar", undefined]]);
      const html = await (await fetch(`${base()}/`)).text();
      expect(html).toContain(".avatar.person { border-radius: 50%; }");
    });

    it("shows a time as just now, minutes or hours ago, the time today or the date before, with the full time on hover", async () => {
      // The page's clock is fixed at 23:30 local time, so 12 hours and more ago is still today.
      const now = new Date(2026, 9, 20, 23, 30).getTime();
      class FixedDate extends Date {
        constructor(...args: unknown[]) {
          super(...((args.length ? args : [now]) as []));
        }
        static now() {
          return now;
        }
      }
      for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
      for (let i = 0; i < 6; i++) sendMessage(db, OWNER_ACCOUNT, i % 2 ? "bob" : "alice", i % 2 ? "alice" : "bob", "x");
      const sent = [now - 30 * 1000, now - 2 * MIN, now - (3 * 60 + 5) * MIN, now - 12 * 60 * MIN, new Date(2026, 9, 19, 9, 5).getTime(), now + 10 * 1000];
      const ids = (db.prepare("SELECT id FROM messages ORDER BY id").all() as { id: number }[]).map((r) => r.id);
      ids.forEach((id, i) => db.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(sent[i], id));
      const page = await load(viewer, undefined, { Date: FixedDate });
      await page.until(() => page.elements["pair-rows"].children.length === 1);
      open(page.elements["pair-rows"].children[0]);
      const log = page.elements["post-rows"];
      const clock = { hour: "2-digit", minute: "2-digit" } as const;
      expect(log.children.map((row) => field(row, "time"))).toEqual([
        "just now",
        "2m ago",
        "3h ago",
        new Date(sent[3]).toLocaleTimeString([], clock),
        new Date(sent[4]).toLocaleString([], { year: "numeric", month: "short", day: "numeric", ...clock }),
        "just now",
      ]);
      expect(log.children.map((row) => row.children.find((c) => c.className === "time")!.title)).toEqual(
        sent.map((ms) => new Date(ms).toLocaleString()),
      );
    });

    it("shows a time it cannot read as given", async () => {
      for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "x");
      // The server always sends an ISO time, so the answer is changed on its way to the page.
      const realFetch = fetch;
      const page = await load(viewer, undefined, {
        fetch: async (url: string, init: RequestInit) => {
          const res = await realFetch(`${base()}${url}`, init);
          if (!url.startsWith("/api/messages")) return res;
          const list = (await res.json()) as { sentAt: string }[];
          return new Response(JSON.stringify(list.map((m) => ({ ...m, sentAt: "sometime" }))));
        },
      });
      await page.until(() => page.elements["pair-rows"].children.length === 1);
      open(page.elements["pair-rows"].children[0]);
      const row = page.elements["post-rows"].children[0];
      const time = row.children.find((c) => c.className === "time")!;
      expect([time.textContent, time.title]).toEqual(["sometime", "sometime"]);
    });
  });
});

describe("the page's search", () => {
  // A stub DOM element, as in the channels and messages tests above.
  interface Stub {
    on: Record<string, (event?: unknown) => void>;
    hidden: boolean;
    value: string;
    textContent: string;
    className: string;
    title: string;
    scrollTop: number;
    scrollHeight: number;
    children: Stub[];
    append(...children: Stub[]): void;
    replaceChildren(...children: Stub[]): void;
    addEventListener(type: string, fn: (event?: unknown) => void): void;
    focus(): void;
  }
  const el = (): Stub => ({
    on: {},
    hidden: true,
    value: "",
    textContent: "",
    className: "",
    title: "",
    scrollTop: 0,
    scrollHeight: 0,
    children: [],
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
  const field = (row: Stub, name: string) => row.children.find((c) => c.className === name)?.textContent;
  // A result's sender, where it went (#channel or → recipient), tag and body.
  const result = (row: Stub) => [
    field(row, "from"),
    row.children.find((c) => c.className.startsWith("where"))?.className === "where channel"
      ? "#" + field(row, "where channel")
      : field(row, "where"),
    field(row, "tag"),
    field(row, "body"),
  ];

  // Runs the served script with the given token. hold, when it returns true for a URL, keeps that request until the
  // test releases it with the returned function; refuse answers a request with a status instead of the server.
  async function load(token: string, options: { hold?: (url: string) => boolean; refuse?: (url: string) => number | "fail" | undefined } = {}) {
    const html = await (await fetch(`${base()}/`)).text();
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
    const elements: Record<string, Stub> = {};
    const urls: string[] = [];
    const held: (() => void)[] = [];
    const deadlines: (() => void)[] = [];
    const polls: (() => void)[] = [];
    const store = new Map([["message-cp-token", token]]);
    runInNewContext(script, {
      AbortController,
      URLSearchParams,
      document: { getElementById: (id: string) => (elements[id] ??= el()), createElement: el },
      sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
      setTimeout: (fn: () => void, ms: number) => (ms === 5000 ? polls.push(fn) : deadlines.push(fn), 0),
      clearTimeout: () => {},
      fetch: async (url: string, init: RequestInit) => {
        urls.push(url);
        const status = options.refuse?.(url);
        if (status === "fail") throw new TypeError("fetch failed");
        if (status !== undefined) return new Response(null, { status });
        if (options.hold?.(url)) await new Promise<void>((resolve) => held.push(resolve));
        return fetch(`${base()}${url}`, init);
      },
    });
    const until = async (done: () => boolean) => {
      for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(done()).toBe(true);
    };
    let prevented = 0;
    const search = (text: string) => {
      elements["search-text"].value = text;
      elements["search"].on.submit({ preventDefault: () => prevented++ });
    };
    return { elements, urls, store, held, polls, until, search, prevented: () => prevented };
  }

  const searches = (urls: string[]) => urls.filter((url) => url.startsWith("/api/search"));

  it("finds this account's messages and posts with their sender, recipient or channel, and never another account's", async () => {
    for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
    const alice = { ...identityOf(db, OWNER_ACCOUNT, "alice")!, name: "alice" };
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "deploy <b>plan</b>");
    post(db, OWNER_ACCOUNT, alice, "build", "deploy done");
    sendMessage(db, OWNER_ACCOUNT, "bob", "all", "deploy for all");
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "unrelated");
    // Another account with the same names and the same text.
    addAccount(db, "other");
    const other = listAccounts(db).find((a) => a.name === "other")!.id;
    for (const name of ["alice", "bob"]) registerAgent(db, other, name, "x");
    sendMessage(db, other, "alice", "bob", "deploy elsewhere");
    post(db, other, { ...identityOf(db, other, "alice")!, name: "alice" }, "build", "deploy elsewhere");

    const page = await load(viewer);
    await page.until(() => page.elements["pair-rows"].children.length === 1);
    page.urls.length = 0;
    page.search("deploy");
    expect(page.prevented()).toBe(1);
    const rows = page.elements["result-rows"];
    await page.until(() => rows.children.length > 0);
    expect(searches(page.urls)).toEqual(["/api/search?text=deploy&limit=200&offset=0"]);
    expect(page.urls.every((url) => !url.includes(viewer))).toBe(true);
    expect(page.elements["results"].hidden).toBe(false);
    expect(page.elements["results-title"].textContent).toBe("Search: deploy");
    expect(page.elements["results-note"].textContent).toBe("");
    // A broadcast is stored once for each recipient. These were sent in the same few milliseconds, so the order is
    // left to the newest-first test below.
    expect(rows.children.map(result).sort()).toEqual([
      ["alice", "#build", undefined, "deploy done"],
      ["alice", "→ bob", undefined, "deploy <b>plan</b>"],
      ["bob", "→ alice", "broadcast", "deploy for all"],
    ]);
    // Searching marked nothing read.
    expect(unreadSummary(db, OWNER_ACCOUNT, "bob")!.count).toBe(2);

    page.elements["close-results"].on.click();
    expect(page.elements["results"].hidden).toBe(true);
    expect(rows.children).toHaveLength(0);
  });

  it("says when nothing is found and when only the newest 200 are shown, and puts the text on the page as text", async () => {
    registerAgent(db, OWNER_ACCOUNT, "alice", "x");
    const alice = { ...identityOf(db, OWNER_ACCOUNT, "alice")!, name: "alice" };
    for (let i = 0; i < 201; i++) post(db, OWNER_ACCOUNT, alice, "build", `many ${i}`);
    const page = await load(viewer);
    page.search("<i>none</i>");
    await page.until(() => page.elements["results-note"].textContent === "Nothing found.");
    expect(page.elements["results-title"].textContent).toBe("Search: <i>none</i>");
    page.search("many");
    await page.until(() => page.elements["result-rows"].children.length === 200);
    expect(page.elements["results-note"].textContent).toBe("Only the newest 200 results are shown.");
    expect(field(page.elements["result-rows"].children[0], "body")).toBe("many 200");
  });

  it("drops an answer that comes after a newer search, after the results were left, or after the token was forgotten", async () => {
    registerAgent(db, OWNER_ACCOUNT, "alice", "x");
    const alice = { ...identityOf(db, OWNER_ACCOUNT, "alice")!, name: "alice" };
    post(db, OWNER_ACCOUNT, alice, "build", "old answer");
    post(db, OWNER_ACCOUNT, alice, "build", "new answer");
    let hold = true;
    const page = await load(viewer, { hold: (url) => hold && url.startsWith("/api/search") });
    const rows = page.elements["result-rows"];
    await page.until(() => page.elements["channel-rows"].children.length === 1);

    page.search("old");
    await page.until(() => page.held.length === 1);
    hold = false;
    page.search("new");
    await page.until(() => rows.children.length === 1);
    page.held.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(rows.children.map((row) => field(row, "body"))).toEqual(["new answer"]);
    expect(page.elements["results-title"].textContent).toBe("Search: new");

    // Left for a channel.
    hold = true;
    page.search("old");
    await page.until(() => page.held.length === 1);
    page.elements["channel-rows"].children[0].children[0].on.click();
    expect(page.elements["results"].hidden).toBe(true);
    page.held.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(page.elements["results"].hidden).toBe(true);
    expect(rows.children).toHaveLength(0);

    // The token forgotten, and another entered.
    page.search("old");
    await page.until(() => page.held.length === 1);
    page.elements["forget"].on.click();
    expect(page.elements["results"].hidden).toBe(true);
    expect(page.elements["search-text"].value).toBe("");
    page.store.set("message-cp-token", viewer);
    page.held.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(page.elements["results"].hidden).toBe(true);
    expect(rows.children).toHaveLength(0);
  });

  it("asks for the token again when the search is refused", async () => {
    registerAgent(db, OWNER_ACCOUNT, "alice", "x");
    sendMessage(db, OWNER_ACCOUNT, "alice", "alice", "hello");
    const ticket = addToken(db, "owner", true);
    const page = await load(ticket.token);
    await page.until(() => page.elements["pair-rows"].children.length === 1);
    revokeToken(db, ticket.id);
    page.search("hello");
    await page.until(() => page.elements["status-line"].textContent.startsWith("The server refused"));
    expect(page.store.size).toBe(0);
    expect(page.elements["results"].hidden).toBe(true);
    expect(page.elements["pair-rows"].children).toHaveLength(0);
    expect(page.elements["login"].hidden).toBe(false);
  });

  it("shows a 400's reason and other failures in the results note, and keeps polling", async () => {
    const page = await load(viewer, { refuse: (url) => (url.includes("text=busy") ? 503 : url.includes("text=gone") ? "fail" : undefined) });
    await page.until(() => page.polls.length === 1);
    page.search("x".repeat(201));
    await page.until(() => page.elements["results-note"].textContent !== "Searching…");
    expect(page.elements["results-note"].textContent).toMatch(/200/);
    page.search("busy");
    await page.until(() => page.elements["results-note"].textContent === "The server is busy (503). Search again in a moment.");
    page.search("gone");
    await page.until(() => page.elements["results-note"].textContent === "Cannot reach the server.");
    expect(page.store.size).toBe(1);
    // The poll scheduled before the searches still runs, and reads no search.
    page.urls.length = 0;
    page.polls.pop()!();
    await page.until(() => page.polls.length === 1);
    expect(searches(page.urls)).toEqual([]);
    expect(page.elements["results"].hidden).toBe(false);
  });
});

describe("the page's webhook deliveries", () => {
  // A stub DOM element, as in the channels and messages tests above.
  interface Stub {
    on: Record<string, () => void>;
    hidden: boolean;
    value: string;
    textContent: string;
    className: string;
    title: string;
    scrollTop: number;
    scrollHeight: number;
    children: Stub[];
    append(...children: Stub[]): void;
    replaceChildren(...children: Stub[]): void;
    addEventListener(type: string, fn: () => void): void;
    focus(): void;
  }
  const el = (): Stub => ({
    on: {},
    hidden: true,
    value: "",
    textContent: "",
    className: "",
    title: "",
    scrollTop: 0,
    scrollHeight: 0,
    children: [],
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
  const field = (row: Stub, name: string) => row.children.find((c) => c.className === name)?.textContent;
  // A delivery row's on, status, whether it is marked failed, and its webhook, attempts and delivery time.
  const delivery = (row: Stub) => [field(row, "from"), field(row, "tag"), row.className.includes("failed"), field(row, "body")];

  // The server's own sender never runs here, so each delivery stays as the test sets it.
  beforeEach(async () => {
    await http.close();
    http = await startHttp(db, { token: OWNER_TOKEN, port: 0, webhookIntervalMs: 3_600_000 });
  });

  // Runs the served script with the given token, as the channels and messages tests do. refuse, when it returns a
  // status, answers a request with that status; "hang" answers only by failing when it is aborted, "fail" rejects,
  // "junk" answers 200 with a body this page cannot read and "nulls" a list it cannot read. "retired" answers a
  // delivery with a status the server never gives, "undated" a delivered one with no delivery time and "unnumbered"
  // one with no id.
  type Refusal = number | "hang" | "fail" | "junk" | "nulls" | "retired" | "undated" | "unnumbered";
  async function load(token: string, refuse: (url: string) => Refusal | undefined = () => undefined) {
    const html = await (await fetch(`${base()}/`)).text();
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
    const elements: Record<string, Stub> = {};
    const urls: string[] = [];
    const polls: (() => void)[] = [];
    const deadlines: (() => void)[] = [];
    const store = new Map([["message-cp-token", token]]);
    runInNewContext(script, {
      AbortController,
      URLSearchParams,
      document: { getElementById: (id: string) => (elements[id] ??= el()), createElement: el },
      sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
      setTimeout: (fn: () => void, ms: number) => (ms === 5000 ? polls.push(fn) : deadlines.push(fn), 0),
      clearTimeout: () => {},
      fetch: (url: string, init: RequestInit) => {
        urls.push(url);
        const status = refuse(url);
        if (status === "hang") return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))));
        if (status === "fail") return Promise.reject(new TypeError("fetch failed"));
        if (status === "junk") return Promise.resolve(new Response("{", { status: 200 }));
        if (status === "nulls") return Promise.resolve(Response.json([null]));
        const odd = { id: 1, webhook: 1, on: "agent:bob", queuedAt: new Date(0).toISOString(), attempts: 1, deliveredAt: null };
        if (status === "retired") return Promise.resolve(Response.json([{ ...odd, status: "retired" }]));
        if (status === "undated") return Promise.resolve(Response.json([{ ...odd, status: "delivered" }]));
        if (status === "unnumbered") return Promise.resolve(Response.json([{ ...odd, id: undefined, status: "pending" }]));
        return status === undefined ? fetch(`${base()}${url}`, init) : Promise.resolve(new Response(null, { status }));
      },
    });
    const until = async (done: () => boolean) => {
      for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(done()).toBe(true);
    };
    const poll = () => polls.splice(0).pop()!();
    const entry = () => elements["delivery-entry"].children[0]?.children[0] as Stub;
    const openDeliveries = async () => {
      await until(() => entry() !== undefined);
      entry().on.click();
    };
    return { elements, urls, store, polls, deadlines, until, poll, entry, openDeliveries };
  }

  // The sidebar entry's label and count.
  const item = (page: Awaited<ReturnType<typeof load>>) => page.entry().children.map((c) => c.textContent);
  const set = (id: number, attempts: number, deliveredAt: number | null) =>
    db.prepare("UPDATE webhook_deliveries SET attempts = ?, delivered_at = ? WHERE id = ?").run(attempts, deliveredAt, id);
  const ids = () => db.prepare("SELECT id FROM webhook_deliveries ORDER BY id").pluck().all() as number[];
  const deliveryUrls = (urls: string[]) => urls.filter((url) => url.startsWith("/api/webhook-deliveries"));

  it("shows this account's deliveries newest first with each status, marks a failure, and never another account's", async () => {
    for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
    const alice = { ...identityOf(db, OWNER_ACCOUNT, "alice")!, name: "alice" };
    const agent = addWebhook(db, "owner", "https://example.com/agent-hook", "agent:bob", true);
    const channel = addWebhook(db, "owner", "https://example.com/channel-hook", "#general", true);
    const mention = addWebhook(db, "owner", "https://example.com/mention-hook", "mention:bob", false);
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "secret plans");
    post(db, OWNER_ACCOUNT, alice, "general", "@bob more secret plans");
    // Another account with webhooks on the same names, and deliveries of its own.
    addAccount(db, "other");
    const other = listAccounts(db).find((a) => a.name === "other")!.id;
    for (const name of ["alice", "bob"]) registerAgent(db, other, name, "x");
    addWebhook(db, "other", "https://example.com/other-hook", "agent:bob", true);
    sendMessage(db, other, "alice", "bob", "other's");
    const [delivered, failed, pending] = ids();
    const deliveredAt = Date.UTC(2026, 9, 20, 12);
    set(delivered!, 2, deliveredAt);
    set(failed!, 3, null);
    set(pending!, 1, null);

    const page = await load(viewer);
    // Until the view is opened the entry has no count, and the deliveries are not read.
    await page.until(() => page.entry() !== undefined);
    expect(item(page)).toEqual(["Webhook deliveries", ""]);
    expect(deliveryUrls(page.urls)).toEqual([]);
    await page.openDeliveries();
    const rows = page.elements["post-rows"];
    await page.until(() => rows.children.length === 3);
    expect(deliveryUrls(page.urls)).toEqual(["/api/webhook-deliveries?limit=200&offset=0"]);
    for (const url of page.urls) expect(url).not.toContain(viewer);
    expect(page.elements["log"].hidden).toBe(false);
    expect(page.elements["log-title"].textContent).toBe("Webhook deliveries");
    expect(page.elements["log-note"].textContent).toBe("");
    const time = (ms: number) => new Date(ms).toLocaleString();
    expect(rows.children.map(delivery)).toEqual([
      ["mention:bob", "pending", false, `webhook ${mention.id} · attempts: 1`],
      ["#general", "failed", true, `webhook ${channel.id} · attempts: 3`],
      ["agent:bob", "delivered", false, `webhook ${agent.id} · attempts: 2 · delivered ${time(deliveredAt)}`],
    ]);
    expect(rows.children.every((row) => field(row, "time")!.startsWith("queued "))).toBe(true);
    expect(item(page)).toEqual(["Webhook deliveries", "3"]);
    expect(page.entry().className).toBe("item current");
    // Nothing private reached the page.
    const text = JSON.stringify(rows.children.map(delivery));
    for (const hidden of ["example.com", agent.secret, "secret plans", viewer]) expect(text).not.toContain(hidden);

    // The next poll replaces the rows with the page as it is now, without a reload.
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "again");
    set(pending!, 2, deliveredAt);
    page.urls.length = 0;
    page.poll();
    await page.until(() => rows.children.length === 4);
    expect(deliveryUrls(page.urls)).toEqual(["/api/webhook-deliveries?limit=200&offset=0"]);
    expect(rows.children.map((row) => field(row, "tag"))).toEqual(["pending", "delivered", "failed", "delivered"]);

    // Closing the view stops reading it.
    page.elements["close-log"].on.click();
    expect(page.elements["log"].hidden).toBe(true);
    expect(rows.children).toHaveLength(0);
    page.urls.length = 0;
    page.poll();
    await page.until(() => page.polls.length === 1);
    expect(deliveryUrls(page.urls)).toEqual([]);
  });

  it("says when there are no deliveries and when only the newest 200 are shown", async () => {
    for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
    const page = await load(viewer);
    await page.openDeliveries();
    await page.until(() => page.elements["log-note"].textContent === "No webhook deliveries yet.");
    expect(page.elements["post-rows"].children).toHaveLength(0);
    expect(item(page)).toEqual(["Webhook deliveries", "0"]);

    addWebhook(db, "owner", "https://example.com/", "agent:bob", true);
    for (let i = 0; i < 201; i++) sendMessage(db, OWNER_ACCOUNT, "alice", "bob", `m${i}`);
    page.poll();
    await page.until(() => page.elements["post-rows"].children.length === 200);
    expect(page.elements["log-note"].textContent).toBe("Only the newest 200 deliveries are shown.");
    expect(item(page)).toEqual(["Webhook deliveries", "200"]);
  });

  it.each([
    [403, "This token cannot read webhook deliveries (403). Retrying…"],
    [503, "The server is busy (503). Retrying…"],
    ["junk", "The server sent an answer this page cannot read. Retrying…"],
    ["nulls", "The server sent an answer this page cannot read. Retrying…"],
    ["retired", "The server sent an answer this page cannot read. Retrying…"],
    ["undated", "The server sent an answer this page cannot read. Retrying…"],
    ["unnumbered", "The server sent an answer this page cannot read. Retrying…"],
    ["fail", "Cannot reach the server. Retrying…"],
  ] as const)("shows a %s in the view's note and keeps the rest of the page refreshing", async (failure, note) => {
    for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
    post(db, OWNER_ACCOUNT, { ...identityOf(db, OWNER_ACCOUNT, "alice")!, name: "alice" }, "build", "hello");
    const page = await load(viewer, (url) => (url.startsWith("/api/webhook-deliveries") ? failure : undefined));
    await page.until(() => page.polls.length === 1);
    // Opening the view drops the poll scheduled before it; wait for the one it starts to schedule the next.
    page.polls.length = 0;
    await page.openDeliveries();
    await page.until(() => page.elements["log-note"].textContent === note && page.polls.length === 1);
    expect(page.elements["status-line"].textContent).toBe("");
    expect(page.store.size).toBe(1);

    // The agents, channels and messages still refresh.
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "hi");
    joinChannel(db, OWNER_ACCOUNT, { ...identityOf(db, OWNER_ACCOUNT, "alice")!, name: "alice" }, "ops");
    page.poll();
    await page.until(() => page.elements["pair-rows"].children.length === 1 && page.elements["channel-rows"].children.length === 2);
    expect(page.elements["log-note"].textContent).toBe(note);
  });

  it("keeps the rest of the page refreshing while the deliveries time out", async () => {
    for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "hi");
    const page = await load(viewer, (url) => (url.startsWith("/api/webhook-deliveries") ? "hang" : undefined));
    await page.openDeliveries();
    await page.until(() => page.elements["pair-rows"].children.length === 1 && deliveryUrls(page.urls).length === 1);
    // The poll's deadline aborts the request that never answers; the next poll is still scheduled.
    page.polls.length = 0;
    page.deadlines.splice(0).forEach((abort) => abort());
    await page.until(() => page.elements["log-note"].textContent === "The server did not answer in time. Retrying…");
    await page.until(() => page.polls.length === 1);
    expect(page.elements["pair-rows"].children).toHaveLength(1);
    expect(page.store.size).toBe(1);
  });

  it("asks for the token again and clears the view when the server refuses the token", async () => {
    for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
    addWebhook(db, "owner", "https://example.com/", "agent:bob", true);
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "hi");
    const ticket = addToken(db, "owner", true);
    let refused = false;
    // Only the deliveries are refused, so the 401 can only come from them.
    const page = await load(ticket.token, (url) => (refused && url.startsWith("/api/webhook-deliveries") ? 401 : undefined));
    await page.openDeliveries();
    await page.until(() => page.elements["post-rows"].children.length === 1);
    refused = true;
    page.poll();
    await page.until(() => page.elements["status-line"].textContent.startsWith("The server refused"));
    expect(page.elements["post-rows"].children).toHaveLength(0);
    expect(page.elements["log"].hidden).toBe(true);
    expect(page.elements["log-title"].textContent).toBe("");
    expect(item(page)).toEqual(["Webhook deliveries", ""]);
    expect(page.store.size).toBe(0);
    expect(page.elements["login"].hidden).toBe(false);
  });

  it("clears the view when the token is forgotten, and shows the next token only its own account's deliveries", async () => {
    for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
    addWebhook(db, "owner", "https://example.com/", "agent:bob", true);
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "hi");
    addAccount(db, "other");
    const otherViewer = addToken(db, "other", true).token;
    const page = await load(viewer);
    await page.openDeliveries();
    await page.until(() => page.elements["post-rows"].children.length === 1);

    page.elements["forget"].on.click();
    expect(page.elements["post-rows"].children).toHaveLength(0);
    expect(page.elements["log"].hidden).toBe(true);
    expect(item(page)).toEqual(["Webhook deliveries", ""]);
    expect(page.store.size).toBe(0);

    page.elements["token"].value = otherViewer;
    page.elements["login"].on.submit({ preventDefault() {} } as never);
    await page.openDeliveries();
    await page.until(() => page.elements["log-note"].textContent === "No webhook deliveries yet.");
    expect(page.elements["post-rows"].children).toHaveLength(0);
    expect(item(page)).toEqual(["Webhook deliveries", "0"]);
  });
});

describe("the page's posting", () => {
  // A stub DOM element, as in the channels and messages tests above, that records any HTML set on it.
  interface Stub {
    on: Record<string, (event?: unknown) => void>;
    hidden: boolean;
    disabled?: boolean;
    value: string;
    textContent: string;
    className: string;
    title: string;
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    children: Stub[];
    html: string[];
    innerHTML: string;
    append(...children: Stub[]): void;
    replaceChildren(...children: Stub[]): void;
    addEventListener(type: string, fn: (event?: unknown) => void): void;
    focus(): void;
  }
  const el = (): Stub => ({
    on: {},
    hidden: true,
    value: "",
    textContent: "",
    className: "",
    title: "",
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 100,
    children: [],
    html: [],
    set innerHTML(value: string) {
      this.html.push(value);
    },
    get innerHTML() {
      return "";
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
  const field = (row: Stub, name: string) => row.children.find((c) => c.className === name)?.textContent;
  const entries = (log: Stub) => log.children.map((row) => [field(row, "from"), field(row, "body")]);
  const label = (row: Stub) => row.children[0].children[0].textContent;
  const open = (rows: Stub, name: string) => rows.children.find((row) => label(row) === name)!.children[0].on.click();

  // Runs the served script with the given token against this server. answer, when it returns a status for a request,
  // answers it with that status (and a JSON error with message, for a 400) instead of the server; with hold, it answers
  // only once hold settles (and from the server when there is no status), or fails it when hold rejects; with lose, it
  // lets the server take the request and then fails it as a dropped connection would.
  type Answer = { status?: number; body?: string; hold?: Promise<void>; lose?: boolean };
  async function load(token: string, answer: (url: string, method: string) => Answer | undefined = () => undefined) {
    const html = await (await fetch(`${base()}/`)).text();
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
    const elements: Record<string, Stub> = {};
    const made: Stub[] = [];
    const requests: { url: string; method: string; body?: string; headers: Record<string, string> }[] = [];
    const polls: (() => void)[] = [];
    const store = new Map([["message-cp-token", token]]);
    const make = () => {
      const stub = el();
      made.push(stub);
      return stub;
    };
    runInNewContext(script, {
      AbortController,
      URLSearchParams,
      document: { getElementById: (id: string) => (elements[id] ??= make()), createElement: make },
      sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
      setTimeout: (fn: () => void, ms: number) => (ms === 5000 && polls.push(fn), 0),
      clearTimeout: () => {},
      fetch: (url: string, init: RequestInit) => {
        const method = init.method ?? "GET";
        requests.push({ url, method, body: init.body as string | undefined, headers: init.headers as Record<string, string> });
        const given = answer(url, method);
        const reply = () =>
          given?.status !== undefined ? new Response(given.body ?? null, { status: given.status }) : fetch(`${base()}${url}`, init);
        if (given?.lose) return fetch(`${base()}${url}`, init).then(() => Promise.reject(new TypeError("connection lost")));
        if (given?.hold) return given.hold.then(reply);
        if (given) return Promise.resolve(reply());
        return fetch(`${base()}${url}`, init);
      },
    });
    const until = async (done: () => boolean) => {
      for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(done()).toBe(true);
    };
    const choose = (name: string) => {
      elements["as"].value = name;
      elements["as"].on.change();
    };
    let prevented = 0;
    const send = (text: string) => {
      elements["compose-text"].value = text;
      elements["compose"].on.submit({ preventDefault: () => prevented++ });
    };
    const posts = () => requests.filter((r) => r.method !== "GET");
    // The names the person picker offers, without its first "Choose who you are" entry.
    const picker = () => elements["as"].children.slice(1).map((o) => o.value);
    // Runs the poll the page scheduled last, once it has scheduled one: the picker can fill before the messages are read.
    const poll = async () => {
      await until(() => polls.length > 0);
      polls.splice(0).pop()!();
    };
    return { elements, made, requests, store, until, choose, send, posts, picker, poll, prevented: () => prevented };
  }

  const seed = () => {
    registerAgent(db, OWNER_ACCOUNT, "bob", "x");
    addPerson(db, "owner", "colin");
    joinChannel(db, OWNER_ACCOUNT, { ...identityOf(db, OWNER_ACCOUNT, "bob")!, name: "bob" }, "build");
    post(db, OWNER_ACCOUNT, { ...identityOf(db, OWNER_ACCOUNT, "bob")!, name: "bob" }, "build", "hello");
    sendMessage(db, OWNER_ACCOUNT, "bob", "colin", "hi colin");
  };

  it("asks GET /api/token once, with the token only in its header, and shows a full token the account's people", async () => {
    seed();
    addPerson(db, "owner", "dana");
    const page = await load(OWNER_TOKEN);
    await page.until(() => page.picker().length === 2);
    expect(page.picker()).toEqual(["colin", "dana"]);
    expect(page.elements["as-box"].hidden).toBe(false);
    expect(page.elements["as-note"].textContent).toBe("");
    await page.poll();
    await page.until(() => page.requests.filter((r) => r.url.startsWith("/api/agents")).length === 2);
    const asks = page.requests.filter((r) => r.url === "/api/token");
    expect(asks).toHaveLength(1);
    expect(asks[0].headers).toEqual({ Authorization: `Bearer ${OWNER_TOKEN}` });
    for (const r of page.requests) expect(r.url).not.toContain(OWNER_TOKEN);
    expect(page.elements["compose"].hidden).toBe(true);
  });

  it("with a full token and no people, names message-cp person add", async () => {
    registerAgent(db, OWNER_ACCOUNT, "bob", "x");
    const page = await load(OWNER_TOKEN);
    await page.until(() => page.elements["as-note"].textContent !== "");
    expect(page.elements["as-note"].textContent).toContain("message-cp person add");
    expect(page.elements["as-box"].hidden).toBe(true);
  });

  it("with a read-only token, or an answer it cannot read, shows no picker or compose box and never posts", async () => {
    seed();
    for (const [token, answer] of [
      [viewer, () => undefined],
      [OWNER_TOKEN, (url: string) => (url === "/api/token" ? { status: 200, body: "not json" } : undefined)],
      [OWNER_TOKEN, (url: string) => (url === "/api/token" ? { status: 200, body: "{}" } : undefined)],
      [OWNER_TOKEN, (url: string) => (url === "/api/token" ? { status: 503 } : undefined)],
    ] as const) {
      const page = await load(token, answer);
      await page.until(() => page.elements["channel-rows"].children.length === 1 && page.elements["pair-rows"].children.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(page.elements["as-box"].hidden).toBe(true);
      expect(page.elements["as"].children).toHaveLength(0);
      expect(page.elements["as-note"].textContent).toBe("");
      // Even a name chosen by hand opens no compose box, and a submit sends nothing.
      page.choose("colin");
      open(page.elements["channel-rows"], "build");
      expect(page.elements["compose"].hidden).toBe(true);
      page.send("should not go");
      open(page.elements["pair-rows"], "bob ↔ colin");
      expect(page.elements["compose"].hidden).toBe(true);
      page.send("should not go");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(page.posts()).toEqual([]);
    }
  });

  it("posts in the open channel as the chosen person, shows the post at once, and @bob gives bob a mention", async () => {
    seed();
    const page = await load(OWNER_TOKEN);
    await page.until(() => page.picker().length === 1 && page.elements["channel-rows"].children.length === 1);
    open(page.elements["channel-rows"], "build");
    // No person chosen yet: no compose box.
    expect(page.elements["compose"].hidden).toBe(true);
    page.choose("colin");
    expect(page.elements["compose"].hidden).toBe(false);
    expect(page.elements["compose-label"].textContent).toBe("Post in #build as colin");
    const rows = page.elements["post-rows"];
    await page.until(() => rows.children.length === 1);
    const before = unreadSummary(db, OWNER_ACCOUNT, "bob")!;
    page.send("ship it @bob <b>now</b>");
    expect(page.prevented()).toBe(1);
    await page.until(() => rows.children.length === 2);
    expect(entries(rows)).toEqual([
      ["bob", "hello"],
      ["colin", "ship it @bob <b>now</b>"],
    ]);
    const sent = page.posts();
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("/api/post");
    expect(sent[0].headers).toEqual({ Authorization: `Bearer ${OWNER_TOKEN}`, "Content-Type": "application/json" });
    expect(JSON.parse(sent[0].body!)).toEqual({ as: "colin", channel: "build", body: "ship it @bob <b>now</b>" });
    expect(page.elements["compose-text"].value).toBe("");
    const stored = db.prepare("SELECT sender, body FROM channel_posts ORDER BY id DESC LIMIT 1").get();
    expect(stored).toEqual({ sender: "colin", body: "ship it @bob <b>now</b>" });
    expect(unreadSummary(db, OWNER_ACCOUNT, "bob")!.mentions).toBe(before.mentions + 1);
    // The typed text reached the page only as text.
    for (const stub of page.made) expect(stub.html).toEqual([]);
  });

  it("replies in an open conversation of the chosen person's, and shows no compose box in one between two others", async () => {
    seed();
    registerAgent(db, OWNER_ACCOUNT, "alice", "x");
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "between agents");
    const page = await load(OWNER_TOKEN);
    await page.until(() => page.picker().length === 1 && page.elements["pair-rows"].children.length === 2);
    page.choose("colin");
    open(page.elements["pair-rows"], "alice ↔ bob");
    expect(page.elements["compose"].hidden).toBe(true);
    open(page.elements["pair-rows"], "bob ↔ colin");
    expect(page.elements["compose"].hidden).toBe(false);
    expect(page.elements["compose-label"].textContent).toBe("Reply to bob as colin");
    const rows = page.elements["post-rows"];
    page.send("on it");
    await page.until(() => rows.children.length === 2);
    expect(entries(rows)).toEqual([
      ["bob", "hi colin"],
      ["colin", "on it"],
    ]);
    expect(JSON.parse(page.posts()[0].body!)).toEqual({ as: "colin", to: "bob", body: "on it" });
    expect(page.posts()[0].url).toBe("/api/send");
    const inbox = db.prepare("SELECT sender, body FROM messages WHERE recipient_id = ? ORDER BY id DESC LIMIT 1").get(identityOf(db, OWNER_ACCOUNT, "bob")!.id);
    expect(inbox).toEqual({ sender: "colin", body: "on it" });
  });

  it("caps the compose box at MAX_BODY_LENGTH characters, counted as the server counts them", async () => {
    seed();
    const page = await load(OWNER_TOKEN);
    await page.until(() => page.picker().length === 1 && page.elements["channel-rows"].children.length === 1);
    open(page.elements["channel-rows"], "build");
    page.choose("colin");
    // An astral character is two UTF-16 units but one character, so this is at the limit and goes.
    const astral = "\u{1F680}".repeat(MAX_BODY_LENGTH);
    page.send(astral);
    await page.until(() => page.posts().length === 1 && page.elements["compose-send"].disabled === false);
    expect(page.elements["compose-text"].value).toBe("");
    const stored = db.prepare("SELECT body FROM channel_posts ORDER BY id DESC LIMIT 1").get() as { body: string };
    expect(stored.body).toBe(astral);
    // One more is over it, and is never sent.
    page.send(astral + "x");
    await page.until(() => page.elements["compose-note"].textContent === `This is longer than ${MAX_BODY_LENGTH} characters.`);
    expect(page.posts()).toHaveLength(1);
    expect(page.elements["compose-text"].value).toBe(astral + "x");
  });

  it("keeps Send disabled until a slow send is answered, so a write is never sent twice", async () => {
    seed();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const page = await load(OWNER_TOKEN, (url, method) => (method === "POST" ? { hold } : undefined));
    await page.until(() => page.picker().length === 1 && page.elements["channel-rows"].children.length === 1);
    open(page.elements["channel-rows"], "build");
    page.choose("colin");
    page.send("once");
    expect(page.elements["compose-send"].disabled).toBe(true);
    // While the send is held, a second submit sends nothing.
    await new Promise((resolve) => setTimeout(resolve, 30));
    page.send("once");
    expect(page.posts()).toHaveLength(1);
    expect(page.elements["compose-note"].textContent).toBe("Sending…");
    release();
    await page.until(() => page.elements["compose-send"].disabled === false);
    expect(page.posts()).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM channel_posts WHERE body = 'once'").get()).toEqual({ n: 1 });
    expect(page.elements["compose-text"].value).toBe("");
  });

  it("with no answer, keeps the text, says it may have been sent and reads the conversation again", async () => {
    seed();
    // The POST is stored and its connection then fails, so the page cannot know it went.
    const page = await load(OWNER_TOKEN, (url, method) => (method === "POST" ? { lose: true } : undefined));
    await page.until(() => page.picker().length === 1 && page.elements["channel-rows"].children.length === 1);
    open(page.elements["channel-rows"], "build");
    page.choose("colin");
    const reads = () => page.requests.filter((r) => r.url.startsWith("/api/channel-posts")).length;
    await page.until(() => reads() > 0 && page.elements["post-rows"].children.length === 1);
    const before = reads();
    page.send("maybe");
    await page.until(() => page.elements["compose-send"].disabled === false);
    expect(page.elements["compose-text"].value).toBe("maybe");
    expect(page.elements["compose-note"].textContent).toBe(
      "No answer from the server, so it may have been sent: check the conversation before sending again.",
    );
    await page.until(() => reads() > before && page.elements["post-rows"].children.length === 2);
    expect(page.posts()).toHaveLength(1);
  });

  it("leaves a conversation opened while a send was in flight alone when the send is answered", async () => {
    seed();
    for (const status of [undefined, 503]) {
      let release!: () => void;
      const hold = new Promise<void>((resolve) => (release = resolve));
      const page = await load(OWNER_TOKEN, (url, method) => (method === "POST" ? { status, hold } : undefined));
      await page.until(() => page.picker().length === 1 && page.elements["pair-rows"].children.length === 1);
      page.choose("colin");
      open(page.elements["channel-rows"], "build");
      page.send("same text");
      // The reader moves to the pair and types the same text there before the post is answered.
      open(page.elements["pair-rows"], "bob ↔ colin");
      page.elements["compose-text"].value = "same text";
      release();
      await page.until(() => page.elements["compose-send"].disabled === false);
      expect(page.elements["compose-text"].value).toBe("same text");
      expect(page.elements["compose-note"].textContent).toBe("");
      expect(page.elements["compose-label"].textContent).toBe("Reply to bob as colin");
    }
  });

  it("does not hold a new token's Send button on a send made with a forgotten one", async () => {
    seed();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const page = await load(OWNER_TOKEN, (url, method) => (method === "POST" && page.posts().length === 1 ? { hold } : undefined));
    await page.until(() => page.picker().length === 1 && page.elements["channel-rows"].children.length === 1);
    open(page.elements["channel-rows"], "build");
    page.choose("colin");
    page.send("slow");
    expect(page.elements["compose-send"].disabled).toBe(true);
    page.elements["forget"].on.click();
    expect(page.elements["compose-send"].disabled).toBe(false);
    page.elements["token"].value = OWNER_TOKEN;
    page.elements["login"].on.submit({ preventDefault() {} });
    await page.until(() => page.picker().length === 1 && page.elements["channel-rows"].children.length === 1);
    open(page.elements["channel-rows"], "build");
    page.choose("colin");
    page.send("fast");
    await page.until(() => page.posts().length === 2 && page.elements["compose-text"].value === "");
    // The old send's answer comes after, and changes nothing on the new token's box.
    page.elements["compose-text"].value = "next";
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(page.elements["compose-send"].disabled).toBe(false);
    expect(page.elements["compose-text"].value).toBe("next");
    expect(page.elements["compose-note"].textContent).toBe("");
  });

  it.each([
    [400, "Post body is empty."],
    [403, "This token cannot post or send (403)."],
    [404, "colin is no longer a person in this account (404)."],
    [413, "This is too long for the server (413)."],
    [503, "The server is busy (503). Send again in a moment."],
  ] as const)("shows a %i under the compose box and keeps the text", async (status, note) => {
    seed();
    const page = await load(OWNER_TOKEN, (url, method) =>
      method === "POST" && status !== 400 ? { status } : undefined,
    );
    await page.until(() => page.picker().length === 1 && page.elements["channel-rows"].children.length === 1);
    open(page.elements["channel-rows"], "build");
    page.choose("colin");
    // A 400 comes from the server itself, for a body that is only whitespace.
    const text = status === 400 ? "   " : "keep me";
    page.send(text);
    await page.until(() => page.elements["compose-note"].textContent === note);
    expect(page.elements["compose-text"].value).toBe(text);
    expect(page.store.size).toBe(1);
  });

  it("keeps typed text when the conversation is left, until a 200", async () => {
    seed();
    const page = await load(OWNER_TOKEN);
    await page.until(() => page.picker().length === 1 && page.elements["pair-rows"].children.length === 1);
    page.choose("colin");
    open(page.elements["channel-rows"], "build");
    page.elements["compose-text"].value = "a draft";
    open(page.elements["channel-rows"], "build");
    open(page.elements["pair-rows"], "bob ↔ colin");
    expect(page.elements["compose-text"].value).toBe("a draft");
    expect(page.posts()).toEqual([]);
  });

  it("clears the page and asks for a token on a 401", async () => {
    seed();
    const page = await load(OWNER_TOKEN, (url, method) => (method === "POST" ? { status: 401 } : undefined));
    await page.until(() => page.picker().length === 1 && page.elements["channel-rows"].children.length === 1);
    open(page.elements["channel-rows"], "build");
    page.choose("colin");
    page.send("hello");
    await page.until(() => page.elements["status-line"].textContent.startsWith("The server refused"));
    expect(page.store.size).toBe(0);
    expect(page.elements["as-box"].hidden).toBe(true);
    expect(page.elements["as"].children).toHaveLength(0);
    expect(page.elements["compose"].hidden).toBe(true);
    expect(page.elements["compose-text"].value).toBe("");
  });

  it("clears the choice when the chosen person disappears from GET /api/agents", async () => {
    seed();
    const page = await load(OWNER_TOKEN);
    await page.until(() => page.picker().length === 1 && page.elements["channel-rows"].children.length === 1);
    open(page.elements["channel-rows"], "build");
    page.choose("colin");
    expect(page.elements["compose"].hidden).toBe(false);
    // There is no person remove yet, so the person goes as a removed registration does.
    db.prepare("UPDATE agents SET removed_at = ? WHERE name = 'colin'").run(Date.now());
    await page.poll();
    await page.until(() => page.elements["compose"].hidden);
    expect(page.picker()).toEqual([]);
    expect(page.elements["as-note"].textContent).toContain("message-cp person add");
  });

  it("never sends as a name GET /api/agents did not give as a person", async () => {
    seed();
    const page = await load(OWNER_TOKEN);
    await page.until(() => page.picker().length === 1 && page.elements["channel-rows"].children.length === 1);
    open(page.elements["channel-rows"], "build");
    page.choose("bob");
    expect(page.elements["compose"].hidden).toBe(true);
    page.send("as an agent");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(page.posts()).toEqual([]);
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
