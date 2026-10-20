import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addToken } from "../src/accounts.js";
import { OWNER_ACCOUNT, openDb, type Db } from "../src/db.js";
import { registerAgent } from "../src/agents.js";
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
