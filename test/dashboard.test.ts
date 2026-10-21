import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
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
      return { on, hidden: false, value: "", textContent: "", className: "", addEventListener: (type: string, fn: () => void) => void (on[type] = fn), focus() {}, replaceChildren() {}, setAttribute() {} };
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
  // An element's text as a browser reads it: the stub's textContent does not join its children's, so a split body's
  // pieces are joined here.
  const text = (node: Stub): string => (node.children.length > 0 ? node.children.map(text).join("") : node.textContent);
  const field = (row: Stub, name: string) => {
    const node = row.children.find((c) => c.className === name);
    return node && text(node);
  };
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
    // Whether a poll is scheduled, so none is in flight.
    const scheduled = () => polls.length > 0;
    return { elements, urls, store, until, poll, scheduled };
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

    it("starts each opened log afresh, so its first entry never continues the log open before", async () => {
      for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
      post(db, OWNER_ACCOUNT, { ...identityOf(db, OWNER_ACCOUNT, "alice")!, name: "alice" }, "build", "in the channel");
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "a minute later, directly");
      backdate("channel_posts", 10 * MIN);
      backdate("messages", 9 * MIN);
      const page = await load(viewer);
      const log = page.elements["post-rows"];
      await page.until(() => page.elements["channel-rows"].children.length === 1 && page.elements["pair-rows"].children.length === 1);
      open(page.elements["channel-rows"].children[0]);
      await page.until(() => log.children.length === 1);
      open(page.elements["pair-rows"].children[0]);
      expect(grouped(log)).toEqual([["alice", false]]);
    });

    it("groups channel posts across a poll, never continues a broadcast, and leaves search results ungrouped", async () => {
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

    it("re-marks the open log's senders when GET /api/agents changes who is a person", async () => {
      for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "hi");
      sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "hello");
      // Who GET /api/agents gives as a person is changed on its way to the page.
      let people: string[] = [];
      const realFetch = fetch;
      const page = await load(viewer, undefined, {
        fetch: async (url: string, init: RequestInit) => {
          const res = await realFetch(`${base()}${url}`, init);
          if (!url.startsWith("/api/agents")) return res;
          const list = (await res.json()) as { name: string }[];
          return new Response(JSON.stringify(list.map((a) => ({ ...a, person: people.includes(a.name) }))));
        },
      });
      await page.until(() => page.elements["pair-rows"].children.length === 1);
      open(page.elements["pair-rows"].children[0]);
      const log = page.elements["post-rows"];
      const marks = () => log.children.map((row) => [field(row, "from"), avatar(row).className, field(row, "kind"), field(row, "body")]);
      expect(marks()).toEqual([
        ["alice", "avatar", undefined, "hi"],
        ["bob", "avatar", undefined, "hello"],
      ]);
      // The rows the log already holds follow the next answer, keeping their text.
      people = ["bob"];
      await page.until(page.scheduled);
      page.poll();
      await page.until(() => avatar(log.children[1]).className === "avatar person");
      expect(marks()).toEqual([
        ["alice", "avatar", undefined, "hi"],
        ["bob", "avatar person", "person", "hello"],
      ]);
      // And a sender no longer given as a person goes back to an agent's avatar.
      people = ["alice"];
      await page.until(page.scheduled);
      page.poll();
      await page.until(() => avatar(log.children[0]).className === "avatar person");
      expect(marks()).toEqual([
        ["alice", "avatar person", "person", "hi"],
        ["bob", "avatar", undefined, "hello"],
      ]);
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

    it("keeps the open log's times current on each poll", async () => {
      let now = Date.now();
      class MovingDate extends Date {
        constructor(...args: unknown[]) {
          super(...((args.length ? args : [now]) as []));
        }
        static now() {
          return now;
        }
      }
      for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "x");
      backdate("messages", 2 * MIN);
      const page = await load(viewer, undefined, { Date: MovingDate });
      await page.until(() => page.elements["pair-rows"].children.length === 1);
      open(page.elements["pair-rows"].children[0]);
      const log = page.elements["post-rows"];
      expect(field(log.children[0], "time")).toBe("2m ago");
      now += 5 * MIN;
      sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "y");
      page.poll();
      await page.until(() => log.children.length === 2);
      expect(field(log.children[0], "time")).toBe("7m ago");
    });

    it("rewrites a time only when its text can change: relative ones each poll, today's clock at midnight, a date never", async () => {
      // 23:30 local, so a message 13 hours ago shows the time today until midnight.
      let now = new Date(2026, 9, 20, 23, 30).getTime();
      class MovingDate extends Date {
        constructor(...args: unknown[]) {
          super(...((args.length ? args : [now]) as []));
        }
        static now() {
          return now;
        }
      }
      for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
      for (const body of ["days ago", "this morning", "just sent"]) sendMessage(db, OWNER_ACCOUNT, "alice", "bob", body);
      const sent = [now - 3 * 24 * 60 * MIN, now - 13 * 60 * MIN, now - 2 * MIN];
      const ids = (db.prepare("SELECT id FROM messages ORDER BY id").all() as { id: number }[]).map((r) => r.id);
      ids.forEach((id, i) => db.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(sent[i], id));
      const page = await load(viewer, undefined, { Date: MovingDate });
      await page.until(() => page.elements["pair-rows"].children.length === 1);
      open(page.elements["pair-rows"].children[0]);
      const log = page.elements["post-rows"];
      const time = (i: number) => log.children[i].children.find((c) => c.className === "time")!;
      const clock = { hour: "2-digit", minute: "2-digit" } as const;
      expect(time(1).textContent).toBe(new Date(sent[1]).toLocaleTimeString([], clock));
      expect(time(2).textContent).toBe("2m ago");
      // A mark left on a time stays until the page writes that time again.
      time(0).textContent = "unchanged";
      time(1).textContent = "unchanged";
      now += 10 * MIN;
      await page.until(page.scheduled);
      page.poll();
      await page.until(() => time(2).textContent === "12m ago");
      expect([time(0).textContent, time(1).textContent]).toEqual(["unchanged", "unchanged"]);
      // Past midnight, this morning's time becomes a date; the one days ago is never written again.
      now += 30 * MIN;
      await page.until(page.scheduled);
      page.poll();
      await page.until(() => time(1).textContent !== "unchanged");
      expect(time(1).textContent).toBe(new Date(sent[1]).toLocaleString([], { year: "numeric", month: "short", day: "numeric", ...clock }));
      expect(time(0).textContent).toBe("unchanged");
    });

    it("leaves a time more than a minute ahead as it is until it becomes just now", async () => {
      let now = Date.now();
      class MovingDate extends Date {
        constructor(...args: unknown[]) {
          super(...((args.length ? args : [now]) as []));
        }
        static now() {
          return now;
        }
      }
      for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "from a server clock ahead of the page's");
      db.prepare("UPDATE messages SET created_at = ?").run(now + 30 * MIN);
      const page = await load(viewer, undefined, { Date: MovingDate });
      await page.until(() => page.elements["pair-rows"].children.length === 1);
      open(page.elements["pair-rows"].children[0]);
      const time = () => page.elements["post-rows"].children[0].children.find((c) => c.className === "time")!;
      expect(time().textContent).not.toBe("just now");
      time().textContent = "unchanged";
      now += 10 * MIN;
      await page.until(page.scheduled);
      page.poll();
      await page.until(page.scheduled);
      expect(time().textContent).toBe("unchanged");
      now += 20 * MIN;
      page.poll();
      await page.until(() => time().textContent === "just now");
    });

    // The mentions of a row's body: each one's text and classes.
    const mentions = (row: Stub) =>
      row.children.find((c) => c.className === "body")!.children.filter((c) => c.className.startsWith("mention")).map((c) => [c.textContent, c.className]);

    it("splits each @name out of an entry's text as a mention, as the server finds them, and keeps the rest as text", async () => {
      registerAgent(db, OWNER_ACCOUNT, "bob", "x");
      const bob = { ...identityOf(db, OWNER_ACCOUNT, "bob")!, name: "bob" };
      const long = "x".repeat(33);
      const body = `ship it @bob <b>now</b>\n@all, a@bob @${long} @${"y".repeat(32)}`;
      post(db, OWNER_ACCOUNT, bob, "build", body);
      post(db, OWNER_ACCOUNT, bob, "build", "no mention here");
      const page = await load(viewer);
      await page.until(() => page.elements["channel-rows"].children.length === 1);
      open(page.elements["channel-rows"].children[0]);
      const log = page.elements["post-rows"];
      await page.until(() => log.children.length === 2);
      // The whole text reads the same, <b> and the line break included.
      expect(entries(log)).toEqual([
        ["bob", body],
        ["bob", "no mention here"],
      ]);
      // a@bob and the 33-character name are not mentions; @all and a 32-character name are.
      expect(mentions(log.children[0])).toEqual([
        ["@bob", "mention"],
        ["@all", "mention"],
        ["@" + "y".repeat(32), "mention"],
      ]);
      const pieces = log.children[0].children.find((c) => c.className === "body")!.children;
      expect(pieces.map((c) => c.textContent)).toEqual(["ship it ", "@bob", ` <b>now</b>\n`, "@all", `, a@bob @${long} `, "@" + "y".repeat(32)]);
      expect(pieces.every((c) => c.children.length === 0)).toBe(true);
      // A body with no mention is plain text.
      const plain = log.children[1].children.find((c) => c.className === "body")!;
      expect([plain.children.length, plain.textContent]).toEqual([0, "no mention here"]);
      // Both themes define the mention colours, and the reader's own mention has its own look.
      const html = await (await fetch(`${base()}/`)).text();
      for (const name of ["--mention-bg", "--me", "--me-bg"]) expect(html.match(new RegExp(`${name}: #`, "g"))).toHaveLength(2);
      expect(html).toContain(".mention.me {");
      expect(html).not.toMatch(/style="/);
      // The page's pattern is the server's.
      const server = /^const MENTION = .*;$/m.exec(readFileSync(new URL("../src/channels.ts", import.meta.url), "utf8"))![0];
      expect(html).toContain(server);
    });

    it("marks the chosen person's own mentions, and re-marks them when the person changes or is cleared", async () => {
      registerAgent(db, OWNER_ACCOUNT, "bob", "x");
      addPerson(db, "owner", "colin");
      addPerson(db, "owner", "dana");
      const bob = { ...identityOf(db, OWNER_ACCOUNT, "bob")!, name: "bob" };
      post(db, OWNER_ACCOUNT, bob, "build", "@Colin and @dana, see @bob");
      const page = await load(OWNER_TOKEN);
      await page.until(() => page.elements["as"].children.length === 3 && page.elements["channel-rows"].children.length === 1);
      open(page.elements["channel-rows"].children[0]);
      const log = page.elements["post-rows"];
      await page.until(() => log.children.length === 1);
      const row = log.children[0];
      expect(mentions(row)).toEqual([
        ["@Colin", "mention"],
        ["@dana", "mention"],
        ["@bob", "mention"],
      ]);
      const choose = (name: string) => {
        page.elements["as"].value = name;
        page.elements["as"].on.change();
      };
      choose("colin");
      // Compared without case, and in place: the row is the same one.
      expect(log.children[0]).toBe(row);
      expect(mentions(row)).toEqual([
        ["@Colin", "mention me"],
        ["@dana", "mention"],
        ["@bob", "mention"],
      ]);
      choose("dana");
      expect(mentions(row).map(([, c]) => c)).toEqual(["mention", "mention me", "mention"]);
      // An entry that arrives later is marked as it is made.
      post(db, OWNER_ACCOUNT, bob, "build", "@dana again");
      page.poll();
      await page.until(() => log.children.length === 2);
      expect(mentions(log.children[1])).toEqual([["@dana", "mention me"]]);
      choose("");
      expect(log.children[0]).toBe(row);
      expect([...mentions(row), ...mentions(log.children[1])].map(([, c]) => c)).toEqual(["mention", "mention", "mention", "mention"]);
    });

    it("marks no mention as the reader's with a read-only token", async () => {
      registerAgent(db, OWNER_ACCOUNT, "bob", "x");
      addPerson(db, "owner", "colin");
      post(db, OWNER_ACCOUNT, { ...identityOf(db, OWNER_ACCOUNT, "bob")!, name: "bob" }, "build", "@colin");
      const page = await load(viewer);
      await page.until(() => page.elements["channel-rows"].children.length === 1);
      open(page.elements["channel-rows"].children[0]);
      const log = page.elements["post-rows"];
      await page.until(() => log.children.length === 1);
      page.elements["as"].value = "colin";
      page.elements["as"].on.change();
      expect(mentions(log.children[0])).toEqual([["@colin", "mention"]]);
    });

    it("highlights mentions in search results, and the chosen person's own there too", async () => {
      for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
      addPerson(db, "owner", "colin");
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "deploy @bob <i>now</i>");
      post(db, OWNER_ACCOUNT, { ...identityOf(db, OWNER_ACCOUNT, "alice")!, name: "alice" }, "build", "deploy, @colin");
      const page = await load(OWNER_TOKEN);
      await page.until(() => page.elements["as"].children.length === 2);
      page.elements["search-text"].value = "deploy";
      page.elements["search"].on.submit({ preventDefault() {} } as never);
      const found = page.elements["result-rows"];
      await page.until(() => found.children.length === 2);
      expect(found.children.map((r) => field(r, "body")).sort()).toEqual(["deploy @bob <i>now</i>", "deploy, @colin"]);
      expect(found.children.flatMap(mentions).sort()).toEqual([
        ["@bob", "mention"],
        ["@colin", "mention"],
      ]);
      page.elements["as"].value = "colin";
      page.elements["as"].on.change();
      expect(found.children.flatMap(mentions).sort()).toEqual([
        ["@bob", "mention"],
        ["@colin", "mention me"],
      ]);
    });

    it("sits a short log at the bottom with CSS, and keeps the webhook deliveries at the top", async () => {
      registerAgent(db, OWNER_ACCOUNT, "bob", "x");
      post(db, OWNER_ACCOUNT, { ...identityOf(db, OWNER_ACCOUNT, "bob")!, name: "bob" }, "build", "x");
      const html = await (await fetch(`${base()}/`)).text();
      expect(html).toContain("#post-rows { display: flex; flex-direction: column; }");
      expect(html).toContain("#post-rows > :first-child { margin-top: auto; }");
      expect(html).toContain("#post-rows.top > :first-child { margin-top: 0; }");
      expect(html).not.toContain("justify-content: flex-end");
      const page = await load(viewer);
      await page.until(() => page.elements["channel-rows"].children.length === 1 && page.elements["delivery-entry"].children.length === 1);
      const log = page.elements["post-rows"];
      page.elements["delivery-entry"].children[0].children[0].on.click();
      expect(log.className).toBe("top");
      open(page.elements["channel-rows"].children[0]);
      expect(log.className).toBe("");
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
  // An element's text as a browser reads it: the stub's textContent does not join its children's, so a split body's
  // pieces are joined here.
  const text = (node: Stub): string => (node.children.length > 0 ? node.children.map(text).join("") : node.textContent);
  const field = (row: Stub, name: string) => {
    const node = row.children.find((c) => c.className === name);
    return node && text(node);
  };
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
  // An element's text as a browser reads it: the stub's textContent does not join its children's, so a split body's
  // pieces are joined here.
  const text = (node: Stub): string => (node.children.length > 0 ? node.children.map(text).join("") : node.textContent);
  const field = (row: Stub, name: string) => {
    const node = row.children.find((c) => c.className === name);
    return node && text(node);
  };
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
    id?: string;
    attributes: Record<string, string>;
    selectionStart: number;
    selectionEnd: number;
    append(...children: Stub[]): void;
    replaceChildren(...children: Stub[]): void;
    addEventListener(type: string, fn: (event?: unknown) => void): void;
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
    setSelectionRange(start: number, end: number): void;
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
    attributes: {},
    selectionStart: 0,
    selectionEnd: 0,
    append(...children) {
      this.children.push(...children);
    },
    replaceChildren(...children) {
      this.children = children;
    },
    addEventListener(type, fn) {
      this.on[type] = fn;
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
    },
    focus() {},
  });
  // An element's text as a browser reads it: the stub's textContent does not join its children's, so a split body's
  // pieces are joined here.
  const text = (node: Stub): string => (node.children.length > 0 ? node.children.map(text).join("") : node.textContent);
  const field = (row: Stub, name: string) => {
    const node = row.children.find((c) => c.className === name);
    return node && text(node);
  };
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
    await page.until(() => page.picker().length === 2 && page.elements["channel-rows"].children.length === 1);
    expect(page.picker()).toEqual(["colin", "dana"]);
    // The picker sits beside the compose box, so it shows only under an open conversation.
    expect(page.elements["as-box"].hidden).toBe(true);
    await page.poll();
    await page.until(() => page.requests.filter((r) => r.url.startsWith("/api/agents")).length === 2);
    const asks = page.requests.filter((r) => r.url === "/api/token");
    expect(asks).toHaveLength(1);
    expect(asks[0].headers).toEqual({ Authorization: `Bearer ${OWNER_TOKEN}` });
    for (const r of page.requests) expect(r.url).not.toContain(OWNER_TOKEN);
    open(page.elements["channel-rows"], "build");
    expect(page.elements["as-box"].hidden).toBe(false);
    expect(page.elements["writer"].hidden).toBe(false);
    expect(page.elements["as-note"].textContent).toBe("");
    expect(page.elements["compose"].hidden).toBe(true);
  });

  it("with a full token and no people, names message-cp person add under an open conversation", async () => {
    registerAgent(db, OWNER_ACCOUNT, "bob", "x");
    joinChannel(db, OWNER_ACCOUNT, { ...identityOf(db, OWNER_ACCOUNT, "bob")!, name: "bob" }, "build");
    const page = await load(OWNER_TOKEN);
    await page.until(() => page.elements["channel-rows"].children.length === 1);
    open(page.elements["channel-rows"], "build");
    await page.until(() => page.elements["as-note"].textContent !== "");
    expect(page.elements["writer"].hidden).toBe(false);
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
      // Nor does a conversation open the picker or the row it sits in, and Enter sends nothing.
      expect(page.elements["as-box"].hidden).toBe(true);
      expect(page.elements["writer"].hidden).toBe(true);
      page.elements["compose-text"].value = "should not go";
      page.elements["compose-text"].on.keydown({ key: "Enter", shiftKey: false, isComposing: false, preventDefault() {} });
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

  describe("starting a direct conversation with New message", () => {
    // A select's names, without the empty first option that asks for a choice.
    const options = (select: Stub) => select.children.filter((o) => o.value !== "").map((o) => [o.value, o.textContent]);
    const ready = async (page: Awaited<ReturnType<typeof load>>) => {
      await page.until(() => page.picker().length > 0 && page.elements["rows"].children.length > 0 && !page.elements["new-message"].hidden);
    };
    const start = (page: Awaited<ReturnType<typeof load>>, from: string, to: string) => {
      page.elements["new-message"].on.click();
      page.elements["new-from"].value = from;
      page.elements["new-from"].on.change();
      page.elements["new-to"].value = to;
      let prevented = 0;
      page.elements["new-form"].on.submit({ preventDefault: () => prevented++ });
      return prevented;
    };

    it("sits a hidden button and form beside the Direct messages heading, submitted by script under the same strict CSP", async () => {
      const res = await fetch(`${base()}/`);
      const html = await res.text();
      expect(html).toMatch(
        /<h2>Direct messages<\/h2>\s*<button id="new-message" type="button"[^>]*hidden>New message<\/button>\s*<\/div>\s*<form id="new-form"[^>]*hidden>/,
      );
      expect(html).not.toMatch(/ style=|\.style\s*[.=[]/);
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("form-action 'none'");
      expect(csp).not.toContain("unsafe-inline");
    });

    it("shows the button only with a full token, not with a read-only token or an answer it cannot read", async () => {
      seed();
      for (const [token, answer] of [
        [viewer, () => undefined],
        [OWNER_TOKEN, (url: string) => (url === "/api/token" ? { status: 200, body: "not json" } : undefined)],
        [OWNER_TOKEN, (url: string) => (url === "/api/token" ? { status: 503 } : undefined)],
      ] as const) {
        const page = await load(token, answer);
        await page.until(() => page.elements["rows"].children.length === 2 && page.elements["pair-rows"].children.length === 1);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(page.elements["new-message"].hidden).toBe(true);
        // Even a click by hand opens no form, and a submit opens and sends nothing.
        page.elements["new-message"].on.click();
        expect(page.elements["new-form"].hidden).toBe(true);
        page.elements["new-from"].value = "colin";
        page.elements["new-to"].value = "bob";
        page.elements["new-form"].on.submit({ preventDefault() {} });
        expect(page.elements["log"].hidden).toBe(true);
        expect(page.elements["compose"].hidden).toBe(true);
        page.send("should not go");
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(page.posts()).toEqual([]);
      }
      const page = await load(OWNER_TOKEN);
      await ready(page);
      expect(page.elements["new-message"].hidden).toBe(false);
      page.elements["new-message"].on.click();
      expect(page.elements["new-form"].hidden).toBe(false);
      expect(page.elements["new-message"].attributes["aria-expanded"]).toBe("true");
    });

    it("offers the account's people as From and its agents and people as To, minus all and the From name without case", async () => {
      // The server reserves all and keeps names unique without case, so the answer is stubbed to hold them anyway.
      const agent = (name: string, person: boolean) => ({ name, bio: "x", person, online: false, lastSeen: new Date().toISOString(), unreadMessages: 0, unreadPosts: 0, unreadMentions: 0 });
      const body = JSON.stringify([agent("all", false), agent("bob", false), agent("Colin", false), agent("colin", true), agent("dana", true)]);
      const page = await load(OWNER_TOKEN, (url) => (url.startsWith("/api/agents") ? { status: 200, body } : undefined));
      await page.until(() => page.picker().length === 2 && page.elements["rows"].children.length === 5 && !page.elements["new-message"].hidden);
      // With a person chosen in Post as, From starts at them.
      page.choose("dana");
      page.elements["new-message"].on.click();
      expect(options(page.elements["new-from"])).toEqual([
        ["colin", "colin"],
        ["dana", "dana"],
      ]);
      expect(page.elements["new-from"].value).toBe("dana");
      const names = (select: Stub) => options(select).map(([value]) => value).sort();
      expect(names(page.elements["new-to"])).toEqual(["Colin", "bob", "colin"].sort());
      expect(options(page.elements["new-to"])).toContainEqual(["colin", "colin (person)"]);
      expect(options(page.elements["new-to"])).toContainEqual(["bob", "bob"]);
      page.elements["new-from"].value = "colin";
      page.elements["new-from"].on.change();
      expect(names(page.elements["new-to"])).toEqual(["bob", "dana"]);
      expect(options(page.elements["new-to"])).toContainEqual(["dana", "dana (person)"]);
      // A poll with the same names leaves the selects as they are, so an open one is not closed under the reader.
      const to = page.elements["new-to"].children;
      await page.poll();
      await page.until(() => page.requests.filter((r) => r.url.startsWith("/api/agents")).length === 2);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(page.elements["new-to"].children).toBe(to);
      for (const stub of page.made) expect(stub.html).toEqual([]);
    });

    it("names message-cp person add in the form when the account has no people", async () => {
      registerAgent(db, OWNER_ACCOUNT, "bob", "x");
      const page = await load(OWNER_TOKEN);
      await page.until(() => page.elements["rows"].children.length === 1 && !page.elements["new-message"].hidden);
      page.elements["new-message"].on.click();
      expect(page.elements["new-note"].textContent).toContain("message-cp person add");
      expect(page.elements["new-fields"].hidden).toBe(true);
      expect(options(page.elements["new-from"])).toEqual([]);
    });

    it("asks for a new choice, never another name, when the chosen From or To leaves the list while the form is open", async () => {
      // The answer to GET /api/agents is stubbed, so a name can leave it between polls.
      const agent = (name: string, person: boolean) => ({ name, bio: "x", person, online: false, lastSeen: new Date().toISOString(), unreadMessages: 0, unreadPosts: 0, unreadMentions: 0 });
      let listed = [agent("bob", false), agent("zed", false), agent("colin", true), agent("dana", true)];
      const page = await load(OWNER_TOKEN, (url) => (url.startsWith("/api/agents") ? { status: 200, body: JSON.stringify(listed) } : undefined));
      await page.until(() => page.picker().length === 2 && page.elements["rows"].children.length === 4 && !page.elements["new-message"].hidden);
      page.elements["new-message"].on.click();
      // With no "Post as" person, both selects start at their empty first option.
      expect(page.elements["new-from"].children[0].value).toBe("");
      expect(page.elements["new-from"].value).toBe("");
      expect(page.elements["new-to"].children[0].value).toBe("");
      expect(page.elements["new-to"].value).toBe("");
      page.elements["new-from"].value = "dana";
      page.elements["new-from"].on.change();
      page.elements["new-to"].value = "zed";
      // zed leaves while the form is open: To asks again rather than taking bob, and Open opens nothing.
      listed = listed.filter((a) => a.name !== "zed");
      await page.poll();
      await page.until(() => page.elements["rows"].children.length === 3);
      expect(options(page.elements["new-to"]).map(([value]) => value).sort()).toEqual(["bob", "colin"]);
      expect(page.elements["new-to"].value).toBe("");
      expect(page.elements["new-from"].value).toBe("dana");
      page.elements["new-form"].on.submit({ preventDefault() {} });
      expect(page.elements["log"].hidden).toBe(true);
      expect(page.elements["new-form"].hidden).toBe(false);
      expect(page.elements["pair-rows"].children).toEqual([]);
      // dana leaves: From asks again rather than taking colin, so even a To still listed opens nothing.
      listed = listed.filter((a) => a.name !== "dana");
      await page.poll();
      await page.until(() => page.picker().length === 1);
      expect(page.elements["new-from"].value).toBe("");
      page.elements["new-to"].value = "bob";
      page.elements["new-form"].on.submit({ preventDefault() {} });
      expect(page.elements["log"].hidden).toBe(true);
      page.send("should not go");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(page.posts()).toEqual([]);
    });

    it("keeps an empty pair first whatever messages arrive in other pairs", async () => {
      registerAgent(db, OWNER_ACCOUNT, "bob", "x");
      registerAgent(db, OWNER_ACCOUNT, "zed", "x");
      addPerson(db, "owner", "colin");
      sendMessage(db, OWNER_ACCOUNT, "bob", "zed", "one");
      const page = await load(OWNER_TOKEN);
      await ready(page);
      await page.until(() => page.elements["pair-rows"].children.length === 1);
      start(page, "colin", "zed");
      expect(page.elements["pair-rows"].children.map(label)).toEqual(["colin ↔ zed", "bob ↔ zed"]);
      sendMessage(db, OWNER_ACCOUNT, "bob", "zed", "two");
      sendMessage(db, OWNER_ACCOUNT, "zed", "bob", "three");
      await page.poll();
      await page.until(() => page.elements["pair-rows"].children[1]?.children[0].children[1].textContent === "3");
      expect(page.elements["pair-rows"].children.map(label)).toEqual(["colin ↔ zed", "bob ↔ zed"]);
      // Once it has a message, it takes its place by recency like the rest.
      page.send("hello zed");
      await page.until(() => page.elements["post-rows"].children.length === 1);
      expect(page.elements["pair-rows"].children.map(label)).toEqual(["colin ↔ zed", "bob ↔ zed"]);
      sendMessage(db, OWNER_ACCOUNT, "bob", "zed", "four");
      await page.poll();
      await page.until(() => page.elements["pair-rows"].children[0]?.children[0].children[1].textContent === "4");
      expect(page.elements["pair-rows"].children.map(label)).toEqual(["bob ↔ zed", "colin ↔ zed"]);
    });

    it("opens an empty pair with the compose box, sends { as, to, body } to /api/send, and keeps the pair one entry", async () => {
      registerAgent(db, OWNER_ACCOUNT, "bob", "x");
      registerAgent(db, OWNER_ACCOUNT, "zed", "x");
      addPerson(db, "owner", "colin");
      sendMessage(db, OWNER_ACCOUNT, "bob", "zed", "between agents");
      const page = await load(OWNER_TOKEN);
      await ready(page);
      await page.until(() => page.elements["pair-rows"].children.length === 1);
      expect(start(page, "colin", "zed")).toBe(1);
      // The pair is listed first with a count of 0, marked open, and opens as one chosen in the sidebar does.
      const pairs = page.elements["pair-rows"];
      expect(pairs.children.map(label)).toEqual(["colin ↔ zed", "bob ↔ zed"]);
      expect(pairs.children[0].children[0].children[1].textContent).toBe("0");
      expect(pairs.children[0].children[0].className).toBe("item current");
      expect(page.elements["new-form"].hidden).toBe(true);
      expect(page.elements["log"].hidden).toBe(false);
      expect(page.elements["log-title"].textContent).toBe("colin ↔ zed");
      expect(page.elements["log-note"].textContent).toBe("No messages yet.");
      expect(page.elements["post-rows"].children).toEqual([]);
      expect(page.elements["as"].value).toBe("colin");
      expect(page.elements["compose"].hidden).toBe(false);
      expect(page.elements["compose-label"].textContent).toBe("Reply to zed as colin");
      const before = unreadSummary(db, OWNER_ACCOUNT, "zed")!;
      page.send("hello zed");
      await page.until(() => page.elements["post-rows"].children.length === 1);
      expect(page.posts()).toHaveLength(1);
      expect(page.posts()[0].url).toBe("/api/send");
      expect(JSON.parse(page.posts()[0].body!)).toEqual({ as: "colin", to: "zed", body: "hello zed" });
      expect(entries(page.elements["post-rows"])).toEqual([["colin", "hello zed"]]);
      expect(page.elements["log-note"].textContent).toBe("");
      expect(unreadSummary(db, OWNER_ACCOUNT, "zed")!.count).toBe(before.count + 1);
      // The first message lands in the same entry, not a second one.
      expect(pairs.children.map(label)).toEqual(["colin ↔ zed", "bob ↔ zed"]);
      expect(pairs.children[0].children[0].children[1].textContent).toBe("1");
      for (const stub of page.made) expect(stub.html).toEqual([]);
    });

    it("opens a pair that already has messages with them, and never opens one with a name it did not offer", async () => {
      seed();
      addPerson(db, "owner", "dana");
      const page = await load(OWNER_TOKEN);
      await ready(page);
      await page.until(() => page.elements["pair-rows"].children.length === 1);
      start(page, "colin", "bob");
      expect(page.elements["log-title"].textContent).toBe("bob ↔ colin");
      expect(entries(page.elements["post-rows"])).toEqual([["bob", "hi colin"]]);
      expect(page.elements["log-note"].textContent).toBe("");
      expect(page.elements["pair-rows"].children.map(label)).toEqual(["bob ↔ colin"]);
      expect(page.elements["compose-label"].textContent).toBe("Reply to bob as colin");
      // A From that is not a person, or a To that is all, the From name or unknown, opens nothing.
      for (const [from, to] of [
        ["bob", "colin"],
        ["colin", "all"],
        ["colin", "colin"],
        ["colin", "nobody"],
      ]) {
        page.elements["close-log"].on.click();
        page.elements["new-message"].on.click();
        page.elements["new-from"].value = from;
        page.elements["new-to"].value = to;
        page.elements["new-form"].on.submit({ preventDefault() {} });
        expect(page.elements["log"].hidden).toBe(true);
      }
      expect(page.elements["pair-rows"].children.map(label)).toEqual(["bob ↔ colin"]);
    });

    it("closes on Escape, on Cancel, on opening another conversation, and on ask(), which drops an empty pair", async () => {
      seed();
      const page = await load(OWNER_TOKEN);
      await ready(page);
      await page.until(() => page.elements["channel-rows"].children.length === 1);
      const form = page.elements["new-form"];
      page.elements["new-message"].on.click();
      let prevented = 0;
      form.on.keydown({ key: "Escape", preventDefault: () => prevented++ });
      expect(form.hidden).toBe(true);
      expect(prevented).toBe(1);
      page.elements["new-message"].on.click();
      page.elements["new-cancel"].on.click();
      expect(form.hidden).toBe(true);
      page.elements["new-message"].on.click();
      open(page.elements["channel-rows"], "build");
      expect(form.hidden).toBe(true);
      // An empty pair started here goes with the token.
      registerAgent(db, OWNER_ACCOUNT, "zed", "x");
      await page.poll();
      await page.until(() => page.elements["rows"].children.length === 3);
      start(page, "colin", "zed");
      expect(page.elements["pair-rows"].children.map(label)).toEqual(["colin ↔ zed", "bob ↔ colin"]);
      // A second empty pair, started later, is listed above the first.
      registerAgent(db, OWNER_ACCOUNT, "yan", "x");
      await page.poll();
      await page.until(() => page.elements["rows"].children.length === 4);
      start(page, "colin", "yan");
      expect(page.elements["pair-rows"].children.map(label)).toEqual(["colin ↔ yan", "colin ↔ zed", "bob ↔ colin"]);
      // Escape on the button closes an open form too.
      page.elements["new-message"].on.click();
      page.elements["new-message"].on.keydown({ key: "Escape", preventDefault() {} });
      expect(form.hidden).toBe(true);
      page.elements["new-message"].on.click();
      page.elements["forget"].on.click();
      expect(form.hidden).toBe(true);
      expect(page.elements["new-message"].hidden).toBe(true);
      expect(page.elements["new-from"].children).toEqual([]);
      expect(page.elements["new-to"].children).toEqual([]);
      expect(page.elements["pair-rows"].children).toEqual([]);
      expect(page.elements["new-note"].textContent).toBe("");
      // The next token sees its own pairs only, and never the empty one.
      page.elements["token"].value = viewer;
      page.elements["login"].on.submit({ preventDefault() {} });
      await page.until(() => page.elements["pair-rows"].children.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(page.elements["pair-rows"].children.map(label)).toEqual(["bob ↔ colin"]);
      expect(page.elements["new-message"].hidden).toBe(true);
    });
  });

  describe("creating a channel with New channel", () => {
    const ready = async (page: Awaited<ReturnType<typeof load>>) => {
      await page.until(
        () => page.picker().length > 0 && page.elements["channel-rows"].children.length > 0 && !page.elements["new-channel"].hidden,
      );
    };
    // Opens the form, fills it and submits it, returning how many times the submit's default was prevented.
    const create = (page: Awaited<ReturnType<typeof load>>, from: string, name: string, body: string) => {
      if (page.elements["channel-form"].hidden) page.elements["new-channel"].on.click();
      page.elements["channel-from"].value = from;
      page.elements["channel-name"].value = name;
      page.elements["channel-body"].value = body;
      let prevented = 0;
      page.elements["channel-form"].on.submit({ preventDefault: () => prevented++ });
      return prevented;
    };

    it("sits a hidden button and form beside the Channels heading, submitted by script under the same strict CSP", async () => {
      const res = await fetch(`${base()}/`);
      const html = await res.text();
      expect(html).toMatch(
        /<div class="section-head">\s*<h2>Channels<\/h2>\s*<button id="new-channel" type="button" aria-expanded="false" aria-controls="channel-form" hidden>New channel<\/button>\s*<\/div>\s*<form id="channel-form" aria-label="New channel" hidden>[\s\S]*?<\/form>\s*<ul id="channel-rows">/,
      );
      const form = /<form id="channel-form"[\s\S]*?<\/form>/.exec(html)![0];
      expect(form).toMatch(/<select id="channel-from">/);
      expect(form).toMatch(/<input id="channel-name"[^>]*maxlength="32"/);
      expect(form).toMatch(/<textarea id="channel-body"/);
      expect(html).not.toMatch(/ style=|\.style\s*[.=[]/);
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("form-action 'none'");
      expect(csp).not.toContain("unsafe-inline");
    });

    it("shows the button and form only with a full token, not with a read-only token or an answer it cannot read", async () => {
      seed();
      for (const [token, answer] of [
        [viewer, () => undefined],
        [OWNER_TOKEN, (url: string) => (url === "/api/token" ? { status: 200, body: "not json" } : undefined)],
        [OWNER_TOKEN, (url: string) => (url === "/api/token" ? { status: 503 } : undefined)],
      ] as const) {
        const page = await load(token, answer);
        await page.until(() => page.elements["channel-rows"].children.length === 1 && page.elements["pair-rows"].children.length === 1);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(page.elements["new-channel"].hidden).toBe(true);
        // Even a click and a submit by hand open and send nothing.
        page.elements["new-channel"].on.click();
        expect(page.elements["channel-form"].hidden).toBe(true);
        page.elements["channel-from"].value = "colin";
        page.elements["channel-name"].value = "fresh";
        page.elements["channel-body"].value = "should not go";
        page.elements["channel-form"].on.submit({ preventDefault() {} });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(page.posts()).toEqual([]);
        expect(page.elements["log"].hidden).toBe(true);
      }
      const page = await load(OWNER_TOKEN);
      await ready(page);
      page.elements["new-channel"].on.click();
      expect(page.elements["channel-form"].hidden).toBe(false);
      expect(page.elements["new-channel"].attributes["aria-expanded"]).toBe("true");
      expect(page.elements["channel-from"].children.filter((o) => o.value !== "").map((o) => o.textContent)).toEqual(["colin"]);
    });

    it("starts From at the Post as person, and names message-cp person add when there are no people", async () => {
      seed();
      const page = await load(OWNER_TOKEN);
      await ready(page);
      page.choose("colin");
      page.elements["new-channel"].on.click();
      expect(page.elements["channel-from"].value).toBe("colin");
      const empty = await load(OWNER_TOKEN, (url) => (url.startsWith("/api/agents") ? { status: 200, body: "[]" } : undefined));
      await empty.until(() => empty.elements["channel-rows"].children.length === 1 && !empty.elements["new-channel"].hidden);
      empty.elements["new-channel"].on.click();
      expect(empty.elements["channel-note"].textContent).toContain("message-cp person add");
      expect(empty.elements["channel-fields"].hidden).toBe(true);
      expect(empty.elements["channel-create"].hidden).toBe(true);
    });

    it("sends nothing and says why for a bad name, an existing name in another case, a non-person and a blank post", async () => {
      seed();
      const page = await load(OWNER_TOKEN);
      await ready(page);
      const note = () => page.elements["channel-note"].textContent;
      for (const [from, name, body, says] of [
        ["colin", "has space", "hi", "1 to 32"],
        ["colin", "", "hi", "1 to 32"],
        ["colin", "x".repeat(33), "hi", "1 to 32"],
        ["colin", "BUILD", "hi", "already exists"],
        ["bob", "fresh", "hi", "From"],
        ["", "fresh", "hi", "From"],
        ["colin", "fresh", " \n\t", "first post"],
        ["colin", "fresh", "😀".repeat(MAX_BODY_LENGTH + 1), String(MAX_BODY_LENGTH)],
      ]) {
        expect(create(page, from, name, body)).toBe(1);
        expect(note()).toContain(says);
        // The text stays, so the reader can correct it.
        expect(page.elements["channel-name"].value).toBe(name);
        expect(page.elements["channel-body"].value).toBe(body);
        expect(page.elements["channel-form"].hidden).toBe(false);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(page.posts()).toEqual([]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM channels").get()).toEqual({ n: 1 });
    });

    it("posts { as, channel, body } to /api/post once, then opens the channel with the compose box for that person", async () => {
      seed();
      addPerson(db, "owner", "dana");
      let release!: () => void;
      const hold = new Promise<void>((resolve) => (release = resolve));
      const page = await load(OWNER_TOKEN, (url, method) => (url === "/api/post" && method === "POST" ? { hold } : undefined));
      await ready(page);
      page.choose("colin");
      expect(create(page, "dana", "fresh", "first <b>post</b>")).toBe(1);
      expect(page.elements["channel-create"].disabled).toBe(true);
      // A second submit while the first is in flight sends nothing.
      page.elements["channel-form"].on.submit({ preventDefault() {} });
      expect(page.posts()).toHaveLength(1);
      release();
      await page.until(() => page.elements["log"].hidden === false);
      const sent = page.posts();
      expect(sent).toHaveLength(1);
      expect(sent[0].url).toBe("/api/post");
      expect(sent[0].headers).toEqual({ Authorization: `Bearer ${OWNER_TOKEN}`, "Content-Type": "application/json" });
      expect(JSON.parse(sent[0].body!)).toEqual({ as: "dana", channel: "fresh", body: "first <b>post</b>" });
      expect(page.elements["channel-form"].hidden).toBe(true);
      expect(page.elements["channel-create"].disabled).toBe(false);
      expect(page.elements["channel-name"].value).toBe("");
      expect(page.elements["channel-body"].value).toBe("");
      expect(page.elements["log-title"].textContent).toBe("fresh");
      expect(page.elements["as"].value).toBe("dana");
      expect(page.elements["compose"].hidden).toBe(false);
      expect(page.elements["compose-label"].textContent).toBe("Post in #fresh as dana");
      // The poll openLog starts lists the channel, marks it open and shows the first post.
      await page.until(() => page.elements["post-rows"].children.length === 1 && page.elements["channel-rows"].children.length === 2);
      expect(entries(page.elements["post-rows"])).toEqual([["dana", "first <b>post</b>"]]);
      const row = page.elements["channel-rows"].children.find((r) => label(r) === "fresh")!;
      expect(row.children[0].className).toBe("item current");
      expect(db.prepare("SELECT sender, body FROM channel_posts ORDER BY id DESC LIMIT 1").get()).toEqual({ sender: "dana", body: "first <b>post</b>" });
      // The same name in another case is now refused, so nothing more is posted.
      create(page, "dana", "FRESH", "again");
      expect(page.elements["channel-note"].textContent).toContain("already exists");
      expect(page.posts()).toHaveLength(1);
      for (const stub of page.made) expect(stub.html).toEqual([]);
    });

    it("keeps the text and shows the server's reason on a 400, a note for other refusals and no answer, and asks again on a 401", async () => {
      seed();
      let answer: { status?: number; body?: string; lose?: boolean } = { status: 400, body: JSON.stringify({ error: { message: "Channel names are reserved" } }) };
      const page = await load(OWNER_TOKEN, (url, method) => (url === "/api/post" && method === "POST" ? answer : undefined));
      await ready(page);
      const note = () => page.elements["channel-note"].textContent;
      create(page, "colin", "fresh", "first");
      await page.until(() => note() === "Channel names are reserved");
      for (const [status, says] of [
        [403, "(403)"],
        [404, "colin is no longer a person"],
        [413, "(413)"],
        [503, "(503)"],
      ] as const) {
        answer = { status };
        create(page, "colin", "fresh", "first");
        await page.until(() => note().includes(says));
      }
      answer = { lose: true };
      create(page, "colin", "fresh", "first");
      await page.until(() => note().includes("check the channel list"));
      expect(page.elements["channel-name"].value).toBe("fresh");
      expect(page.elements["channel-body"].value).toBe("first");
      expect(page.elements["channel-form"].hidden).toBe(false);
      expect(page.elements["log"].hidden).toBe(true);
      answer = { status: 401 };
      // The lost post was stored, so the poll it started lists fresh: use another name.
      await page.until(() => page.elements["channel-rows"].children.length === 2);
      create(page, "colin", "other", "first");
      await page.until(() => !page.elements["login"].hidden);
      expect(page.elements["channel-form"].hidden).toBe(true);
      expect(page.elements["channel-name"].value).toBe("");
      expect(page.elements["channel-body"].value).toBe("");
    });

    it("drops an answer that arrives after the token was forgotten", async () => {
      seed();
      let release!: () => void;
      const hold = new Promise<void>((resolve) => (release = resolve));
      const page = await load(OWNER_TOKEN, (url, method) => (url === "/api/post" && method === "POST" ? { hold } : undefined));
      await ready(page);
      create(page, "colin", "fresh", "first");
      page.elements["forget"].on.click();
      release();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(page.elements["log"].hidden).toBe(true);
      expect(page.elements["channel-note"].textContent).toBe("");
      expect(page.elements["channel-create"].disabled).toBe(false);
    });

    it("closes on Escape, Cancel, another conversation and ask(), and only one of New message and New channel is open", async () => {
      seed();
      const page = await load(OWNER_TOKEN);
      await ready(page);
      const form = page.elements["channel-form"];
      page.elements["new-channel"].on.click();
      let prevented = 0;
      form.on.keydown({ key: "Escape", preventDefault: () => prevented++ });
      expect(form.hidden).toBe(true);
      expect(prevented).toBe(1);
      page.elements["new-channel"].on.click();
      page.elements["new-channel"].on.keydown({ key: "Escape", preventDefault() {} });
      expect(form.hidden).toBe(true);
      page.elements["new-channel"].on.click();
      page.elements["channel-cancel"].on.click();
      expect(form.hidden).toBe(true);
      page.elements["new-channel"].on.click();
      open(page.elements["channel-rows"], "build");
      expect(form.hidden).toBe(true);
      // Opening one form closes the other.
      page.elements["new-channel"].on.click();
      page.elements["new-message"].on.click();
      expect(form.hidden).toBe(true);
      expect(page.elements["new-form"].hidden).toBe(false);
      page.elements["new-channel"].on.click();
      expect(form.hidden).toBe(false);
      expect(page.elements["new-form"].hidden).toBe(true);
      // ask() closes the form and clears its select, note and text.
      page.elements["channel-name"].value = "typed";
      page.elements["channel-body"].value = "typed text";
      create(page, "colin", "bad name", "x");
      expect(page.elements["channel-note"].textContent).not.toBe("");
      page.elements["forget"].on.click();
      expect(form.hidden).toBe(true);
      expect(page.elements["new-channel"].hidden).toBe(true);
      expect(page.elements["channel-from"].children).toEqual([]);
      expect(page.elements["channel-note"].textContent).toBe("");
      expect(page.elements["channel-name"].value).toBe("");
      expect(page.elements["channel-body"].value).toBe("");
      // The next token, read-only, gets no button.
      page.elements["token"].value = viewer;
      page.elements["login"].on.submit({ preventDefault() {} });
      await page.until(() => page.elements["channel-rows"].children.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(page.elements["new-channel"].hidden).toBe(true);
    });
  });

  describe("writing like a chat app", () => {
    // A keydown on the compose box, counting the preventDefault calls it gets.
    const key = (page: Awaited<ReturnType<typeof load>>, text: string, init: { shiftKey?: boolean; isComposing?: boolean; keyCode?: number } = {}) => {
      let prevented = 0;
      page.elements["compose-text"].value = text;
      page.elements["compose-text"].on.keydown({ key: "Enter", shiftKey: false, isComposing: false, ...init, preventDefault: () => prevented++ });
      return prevented;
    };
    const ready = async (page: Awaited<ReturnType<typeof load>>) => {
      await page.until(() => page.picker().length === 1 && page.elements["channel-rows"].children.length === 1);
      open(page.elements["channel-rows"], "build");
      // The picker shows under the open channel before a person is chosen, so one can be chosen there.
      expect(page.elements["as-box"].hidden).toBe(false);
      expect(page.elements["writer"].hidden).toBe(false);
      expect(page.elements["compose"].hidden).toBe(true);
      page.choose("colin");
      expect(page.elements["compose"].hidden).toBe(false);
    };

    it("says in the placeholder that Enter sends and Shift+Enter adds a line", async () => {
      const html = await (await fetch(`${base()}/`)).text();
      expect(html).toMatch(/<textarea id="compose-text" rows="2"[^>]*placeholder="Enter sends, Shift\+Enter adds a line"/);
      // The picker is no longer in the top bar, but in the log beside the compose box.
      const bar = /<header class="bar">([\s\S]*?)<\/header>/.exec(html)![1];
      expect(bar).not.toContain('id="as-box"');
      const log = /<section id="log"[^>]*>([\s\S]*?)<\/section>/.exec(html)![1];
      expect(log).toMatch(/<div id="writer" hidden>\s*<span id="as-box" hidden>[\s\S]*<p id="as-note"[\s\S]*<form id="compose" hidden>[\s\S]*<\/form>\s*<p id="compose-note"/);
      expect(html).not.toMatch(/ style=|\.style\s*[.=[]/);
    });

    it("sends once on Enter and prevents its newline", async () => {
      seed();
      const page = await load(OWNER_TOKEN);
      await ready(page);
      expect(key(page, "by enter")).toBe(1);
      await page.until(() => page.elements["compose-send"].disabled === false && page.elements["compose-text"].value === "");
      expect(page.posts()).toHaveLength(1);
      expect(JSON.parse(page.posts()[0].body!)).toEqual({ as: "colin", channel: "build", body: "by enter" });
    });

    it("sends nothing on Shift+Enter, on an Enter while composing, or on an Enter in a box of only whitespace", async () => {
      seed();
      const page = await load(OWNER_TOKEN);
      await ready(page);
      // Shift+Enter and an IME's Enter keep their default, so the line is added or the composition ends.
      expect(key(page, "two\nlines", { shiftKey: true })).toBe(0);
      expect(key(page, "にほん", { isComposing: true })).toBe(0);
      // Safari ends the composition before the Enter that confirms it, which then comes with keyCode 229.
      expect(key(page, "にほん", { keyCode: 229 })).toBe(0);
      // An Enter in a blank box adds no line either.
      expect(key(page, " \n\t ")).toBe(1);
      expect(key(page, "")).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(page.posts()).toEqual([]);
      expect(page.elements["compose-text"].value).toBe("");
      expect(page.elements["compose-note"].textContent).toBe("");
    });

    it("sends nothing on a second Enter while a send is in flight", async () => {
      seed();
      let release!: () => void;
      const hold = new Promise<void>((resolve) => (release = resolve));
      const page = await load(OWNER_TOKEN, (url, method) => (method === "POST" ? { hold } : undefined));
      await ready(page);
      key(page, "only once");
      expect(page.elements["compose-send"].disabled).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(key(page, "only once")).toBe(1);
      expect(page.posts()).toHaveLength(1);
      release();
      await page.until(() => page.elements["compose-send"].disabled === false);
      expect(db.prepare("SELECT COUNT(*) AS n FROM channel_posts WHERE body = 'only once'").get()).toEqual({ n: 1 });
    });

    it("grows the box with its text up to 10 rows, shrinks it back and resets it after a 200", async () => {
      seed();
      const page = await load(OWNER_TOKEN);
      await ready(page);
      // A textarea as a browser lays it out: each line of text and each row is 20px high.
      const box = page.elements["compose-text"] as Stub & { rows: number };
      Object.defineProperty(box, "scrollHeight", { get: () => Math.max(box.rows, box.value.split("\n").length) * 20 });
      Object.defineProperty(box, "clientHeight", { get: () => box.rows * 20 });
      const type = (text: string) => {
        box.value = text;
        box.on.input();
        return box.rows;
      };
      expect(type("one")).toBe(2);
      expect(type("1\n2\n3\n4")).toBe(4);
      expect(type(Array(30).fill("x").join("\n"))).toBe(10);
      expect(type("1\n2\n3")).toBe(3);
      type("1\n2\n3\n4\n5");
      expect(box.rows).toBe(5);
      key(page, box.value);
      await page.until(() => box.value === "");
      expect(box.rows).toBe(2);
    });
  });

  describe("offering names after @", () => {
    // Types text into the compose box as a browser does: the caret at its end (or at caret), then an input event.
    const type = (page: Awaited<ReturnType<typeof load>>, text: string, caret = text.length) => {
      const box = page.elements["compose-text"];
      box.value = text;
      box.selectionStart = box.selectionEnd = caret;
      box.on.input();
    };
    // A key on the compose box, counting the preventDefault calls it gets.
    const press = (page: Awaited<ReturnType<typeof load>>, key: string) => {
      let prevented = 0;
      page.elements["compose-text"].on.keydown({ key, shiftKey: false, isComposing: false, preventDefault: () => prevented++ });
      return prevented;
    };
    const list = (page: Awaited<ReturnType<typeof load>>) => page.elements["mentions"];
    // Each offered entry's name and whether it is marked as a person.
    const offered = (page: Awaited<ReturnType<typeof load>>) =>
      list(page).hidden ? [] : list(page).children.map((o) => [o.children[0].textContent, o.children[1]?.textContent ?? ""]);
    const highlighted = (page: Awaited<ReturnType<typeof load>>) =>
      list(page).children.filter((o) => o.className === "option current").map((o) => o.children[0].textContent);
    // An account with agents bob, Bobby and alice, and people colin and dana; colin posts in #build.
    const ready = async (answer?: Parameters<typeof load>[1]) => {
      seed();
      for (const name of ["Bobby", "alice"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
      addPerson(db, "owner", "dana");
      const page = await load(OWNER_TOKEN, answer);
      await page.until(() => page.picker().length === 2 && page.elements["channel-rows"].children.length === 1);
      open(page.elements["channel-rows"], "build");
      page.choose("colin");
      expect(page.elements["compose"].hidden).toBe(false);
      return page;
    };

    it("opens on @ with the account's agents and people, minus the chosen person and all, and narrows ignoring case", async () => {
      const page = await ready();
      expect(list(page).hidden).toBe(true);
      type(page, "@");
      expect(offered(page)).toEqual([
        ["alice", ""],
        ["bob", ""],
        ["Bobby", ""],
        ["dana", "person"],
      ]);
      expect(highlighted(page)).toEqual(["alice"]);
      type(page, "hi @B");
      expect(offered(page).map(([name]) => name)).toEqual(["bob", "Bobby"]);
      type(page, "hi (@bOBB");
      expect(offered(page).map(([name]) => name)).toEqual(["Bobby"]);
      // Nothing matches, so the list closes; so does a name already ended by a space, and a caret moved before the @.
      type(page, "@bobx");
      expect(list(page).hidden).toBe(true);
      type(page, "@bob ");
      expect(list(page).hidden).toBe(true);
      type(page, "x @bo", 1);
      expect(list(page).hidden).toBe(true);
      // Nor does it open over selected text.
      page.elements["compose-text"].selectionStart = 1;
      page.elements["compose-text"].selectionEnd = 3;
      page.elements["compose-text"].value = "@bob";
      page.elements["compose-text"].on.input();
      expect(list(page).hidden).toBe(true);
      // The chosen person is never offered.
      type(page, "@c");
      expect(list(page).hidden).toBe(true);
      // The names went on the page only as text.
      for (const stub of page.made) expect(stub.html).toEqual([]);
    });

    it("never offers all, even if GET /api/agents gave it", async () => {
      // The server reserves the name, so no agent can have it; the answer is stubbed to hold one anyway.
      const agent = (name: string, person: boolean) => ({ name, bio: "x", person, online: false, lastSeen: new Date().toISOString(), unreadMessages: 0, unreadPosts: 0, unreadMentions: 0 });
      const body = JSON.stringify([agent("all", false), agent("alba", false), agent("colin", true), agent("dana", true)]);
      const page = await ready((url) => (url.startsWith("/api/agents") ? { status: 200, body } : undefined));
      type(page, "@al");
      expect(offered(page)).toEqual([["alba", ""]]);
      type(page, "@all");
      expect(list(page).hidden).toBe(true);
    });

    it("opens nothing for an @ after a name character", async () => {
      const page = await ready();
      for (const text of ["a@", "a@b", "x_@", "9@b", "-@"]) {
        type(page, text);
        expect(list(page).hidden).toBe(true);
      }
      type(page, "a @");
      expect(list(page).hidden).toBe(false);
    });

    it("offers at most 8 names", async () => {
      const page = await ready();
      for (let i = 0; i < 10; i++) registerAgent(db, OWNER_ACCOUNT, `bot${i}`, "x");
      await page.poll();
      await page.until(() => page.elements["rows"].children.length === 15);
      type(page, "@bo");
      expect(offered(page)).toHaveLength(8);
      expect(page.elements["compose-text"].attributes["aria-expanded"]).toBe("true");
      // An open list follows the next answer: a name that has gone is no longer offered.
      type(page, "@bot");
      expect(offered(page).map(([name]) => name)).toContain("bot0");
      db.prepare("UPDATE agents SET removed_at = ? WHERE name = 'bot0'").run(Date.now());
      await page.poll();
      await page.until(() => !offered(page).some(([name]) => name === "bot0"));
      expect(offered(page)).toHaveLength(8);
    });

    it("moves the highlight with the arrows and picks it with Enter, inserting @<name> and sending nothing", async () => {
      const page = await ready();
      type(page, "ask @b about the rest", 6);
      expect(highlighted(page)).toEqual(["bob"]);
      expect(press(page, "ArrowDown")).toBe(1);
      expect(highlighted(page)).toEqual(["Bobby"]);
      expect(page.elements["compose-text"].attributes["aria-activedescendant"]).toBe("mention-1");
      press(page, "ArrowDown");
      expect(highlighted(page)).toEqual(["bob"]);
      press(page, "ArrowUp");
      expect(highlighted(page)).toEqual(["Bobby"]);
      expect(press(page, "Enter")).toBe(1);
      const box = page.elements["compose-text"];
      expect(box.value).toBe("ask @Bobby  about the rest");
      expect(box.selectionStart).toBe("ask @Bobby ".length);
      expect(list(page).hidden).toBe(true);
      expect(box.attributes["aria-activedescendant"]).toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(page.posts()).toEqual([]);
    });

    it("picks with Tab and with a click on an entry", async () => {
      const page = await ready();
      type(page, "@d");
      expect(press(page, "Tab")).toBe(1);
      expect(page.elements["compose-text"].value).toBe("@dana ");
      type(page, "@dana and @a");
      let prevented = 0;
      list(page).children[0].on.mousedown({ preventDefault: () => prevented++ });
      expect(prevented).toBe(1);
      expect(page.elements["compose-text"].value).toBe("@dana and @alice ");
      expect(list(page).hidden).toBe(true);
      // With the list closed, Tab keeps its default and moves on, and Shift+Tab does even while it is open.
      expect(press(page, "Tab")).toBe(0);
      type(page, "@a");
      let back = 0;
      page.elements["compose-text"].on.keydown({ key: "Tab", shiftKey: true, isComposing: false, preventDefault: () => back++ });
      expect(back).toBe(0);
      expect(page.elements["compose-text"].value).toBe("@a");
      expect(page.posts()).toEqual([]);
    });

    it("leaves modified arrows to the box, and looks again at the selection before a key picks", async () => {
      const page = await ready();
      type(page, "hi @b");
      const box = page.elements["compose-text"];
      for (const modifier of ["shiftKey", "ctrlKey", "altKey", "metaKey"]) {
        let prevented = 0;
        box.on.keydown({ key: "ArrowDown", [modifier]: true, isComposing: false, preventDefault: () => prevented++ });
        expect(prevented).toBe(0);
        expect(highlighted(page)).toEqual(["bob"]);
      }
      // Ctrl+A selects everything without an input event; the next Enter sends the text and picks nothing.
      box.selectionStart = 0;
      box.selectionEnd = box.value.length;
      expect(press(page, "Enter")).toBe(1);
      expect(list(page).hidden).toBe(true);
      await page.until(() => page.posts().length === 1 && box.value === "");
      expect(JSON.parse(page.posts()[0].body!)).toEqual({ as: "colin", channel: "build", body: "hi @b" });
      // A key's native action that changes the selection closes an open list once it is done, at keyup.
      type(page, "hi @b");
      box.selectionStart = 0;
      box.selectionEnd = box.value.length;
      box.on.keyup({ key: "a", ctrlKey: true });
      expect(list(page).hidden).toBe(true);
      // A click on an entry looks again too: with the caret moved before the @, it changes nothing.
      type(page, "hi @b");
      const entry = list(page).children[0];
      box.value = "hi @b and more";
      box.selectionStart = box.selectionEnd = 1;
      entry.on.mousedown({ preventDefault() {} });
      expect(box.value).toBe("hi @b and more");
      expect(list(page).hidden).toBe(true);
      // While it still matches, a click picks the name it shows.
      type(page, "hi @b");
      list(page).children[1].on.mousedown({ preventDefault() {} });
      expect(box.value).toBe("hi @Bobby ");
    });

    it("closes on Escape, keeping the text, and a following Enter sends", async () => {
      const page = await ready();
      type(page, "hello @bo");
      expect(press(page, "Escape")).toBe(1);
      expect(list(page).hidden).toBe(true);
      expect(page.elements["compose-text"].value).toBe("hello @bo");
      expect(press(page, "Enter")).toBe(1);
      await page.until(() => page.posts().length === 1 && page.elements["compose-text"].value === "");
      expect(JSON.parse(page.posts()[0].body!)).toEqual({ as: "colin", channel: "build", body: "hello @bo" });
    });

    it("closes after a send clears the text, when the conversation closes and when the token is forgotten", async () => {
      const page = await ready();
      type(page, "@bob");
      // The Send button posts while the list is open; the 200 clears the text and the list.
      page.elements["compose"].on.submit({ preventDefault() {} });
      await page.until(() => page.elements["compose-text"].value === "");
      expect(list(page).hidden).toBe(true);
      type(page, "@bob");
      expect(list(page).hidden).toBe(false);
      page.elements["close-log"].on.click();
      expect(list(page).hidden).toBe(true);
      open(page.elements["channel-rows"], "build");
      type(page, "@bob");
      expect(list(page).hidden).toBe(false);
      page.elements["forget"].on.click();
      expect(list(page).hidden).toBe(true);
      // The next token starts with no names, so one token's names never show under another's.
      page.elements["compose"].hidden = false;
      type(page, "@");
      expect(list(page).hidden).toBe(true);
    });

    it("styles the highlight in both themes with classes, and has no list with a read-only token", async () => {
      const html = await (await fetch(`${base()}/`)).text();
      expect(html).toContain(".option.current { background: var(--active); box-shadow: inset 3px 0 0 var(--accent); }");
      expect(html.match(/--active: #/g)).toHaveLength(2);
      expect(html).toMatch(/<ul id="mentions" role="listbox"[^>]*hidden><\/ul>\s*<form id="compose" hidden>/);
      expect(html).not.toMatch(/ style=|\.style\s*[.=[]/);

      seed();
      const page = await load(viewer);
      await page.until(() => page.elements["channel-rows"].children.length === 1 && page.elements["rows"].children.length === 2);
      open(page.elements["channel-rows"], "build");
      expect(page.elements["compose"].hidden).toBe(true);
      type(page, "@");
      expect(list(page).hidden).toBe(true);
      expect(list(page).children).toEqual([]);
    });
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
