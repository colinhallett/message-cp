import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountForToken, addAccount, addToken, listAccounts, recordClient, revokeToken } from "../src/accounts.js";
import { cancelInvite, makeInvite, makeLoginCode, redeemLoginCode } from "../src/login.js";
import { OWNER_ACCOUNT, openDb, type Db } from "../src/db.js";
import { addPerson, identityOf, purgeAgent, registerAgent, registerWithIdentity, removeAgent, removePerson, setPersonAdmin, setStatus } from "../src/agents.js";
import { joinChannel, leaveChannel, post } from "../src/channels.js";
import { MAX_BODY_LENGTH, readInbox, sendMessage, unreadSummary } from "../src/messages.js";
import { startHttp, type HttpServer } from "../src/http.js";
import { addWebhook } from "../src/webhooks.js";

// The dashboard page at GET /, served before the token check, and everything else still behind it.
const OWNER_TOKEN = "owner-token";
let db: Db;
let http: HttpServer;
let viewer: string;
let agentToken: string;

beforeEach(async () => {
  db = openDb(join(mkdtempSync(join(tmpdir(), "message-cp-dashboard-")), "db.sqlite"));
  viewer = addToken(db, "owner", true).token;
  agentToken = addToken(db, "owner", false, true).token;
  http = await startHttp(db, { token: OWNER_TOKEN, port: 0 });
});

afterEach(async () => {
  await http.close();
  db.close();
});

// What the page's empty panels say, and the sentence a person token adds to the channel list and the direct messages.
const NO_AGENTS =
  'No agents yet: one appears here once it registers with the register tool, using message-cp as an MCP server (the reference page "Add it to an MCP client", https://message-cp.vercel.app/clients.html#add-it-to-an-mcp-client, says how). ' +
  "Add a person on the server with: message-cp person add <name> --account <account>";
const NO_CHANNELS = "No channels yet: an agent creates one with its first post there, using the post tool, or by joining it with the join_channel tool.";
const NEW_CHANNEL = ' You can also start one from "New channel" above.';
const NO_MESSAGES = "No direct messages yet: they appear here when an agent sends one with the send_message tool.";
const NEW_MESSAGE = ' You can also start one from "New message" above.';
const NO_DELIVERIES =
  "No webhook deliveries yet: add a webhook on the server with message-cp webhook add --url <url> --on <#channel | mention:<agent> | agent:<agent>>, and its deliveries show here once it fires.";
const NO_INVITES = "No unused invites. One is listed here from when it is made until it is used, cancelled or expires.";
const NO_APPROVALS =
  "No approved clients yet: a client approved as one named agent, or as one that registers its own agents, appears here once it connects through the server's authorization flow (serve --public-url), and its token is revoked on the server with message-cp token revoke <id> or, by an admin person, with its Revoke button here.";

const base = () => `http://127.0.0.1:${http.port}`;

// A :root block's colours by custom property name, without the leading "--".
function themeOf(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/--([\w-]+): (#[0-9a-f]{6});/g)].map((m) => [m[1], m[2]]));
}

// The WCAG contrast ratio of two #rrggbb colours, from their relative luminance.
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// color-mix(in srgb, a p%, b) of two #rrggbb colours, rounded per channel as the browser does.
function mix(a: string, b: string, p: number): string {
  const ch = (hex: string, i: number) => parseInt(hex.slice(i, i + 2), 16);
  return "#" + [1, 3, 5].map((i) => Math.round(ch(a, i) * p + ch(b, i) * (1 - p)).toString(16).padStart(2, "0")).join("");
}
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

// The page's timers, run by hand. polls holds the 5-second poll timers the page has scheduled and not cleared, so a poll
// it has cancelled never runs; every other timer, such as a request's deadline, goes to deadlines, also until it is cleared.
function handTimers() {
  const polls = new Map<number, () => void>();
  const deadlines = new Map<number, () => void>();
  let next = 0;
  const set = (fn: () => void, ms: number) => {
    next++;
    if (ms === 5000) polls.set(next, fn);
    else deadlines.set(next, fn);
    return next;
  };
  const clear = (id: number) => void (polls.delete(id) || deadlines.delete(id));
  // Runs the poll the page has scheduled, once it has scheduled one: a poll in flight schedules the next when it ends.
  // Fails if none is scheduled within about a second, or if more than one is.
  const poll = async () => {
    for (let i = 0; i < 200 && polls.size === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(polls.size, "the page has no poll scheduled to run").toBeGreaterThan(0);
    expect(polls.size, "the page has more than one poll scheduled").toBe(1);
    const [[id, fn]] = polls;
    polls.delete(id);
    fn();
  };
  // Whether a poll is scheduled, so none is in flight.
  const scheduled = () => polls.size > 0;
  return { polls, deadlines, set, clear, poll, scheduled };
}

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
    expect(html).toMatch(/<button id="show-sidebar"[^>]*aria-expanded="false" aria-controls="sidebar"/);
    expect(html).toMatch(/<button id="show-agents"[^>]*aria-expanded="false" aria-controls="agents"/);
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

  it("shows only the name, a labelled token field and a log-in button on the token screen", async () => {
    const html = await (await fetch(`${base()}/`)).text();
    const login = /<form id="login"[^>]*>([\s\S]*?)<\/form>/.exec(html)![1];
    expect(login.trim().split("\n")).toEqual([
      "<h1>message-cp</h1>",
      '<label for="token">Token</label>',
      '<input id="token" type="password" autocomplete="off" required>',
      '<button type="submit">Log in</button>',
    ]);
    for (const words of ["token add", "--read-only", "--agent-only", "cookie", "Forget token"]) {
      expect(login).not.toContain(words);
    }
    expect(html).not.toContain("token-help");
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

  it("allows fonts from its own origin and changes nothing else in the policy", async () => {
    const csp = (await fetch(`${base()}/`)).headers.get("content-security-policy") ?? "";
    const directives = csp.split("; ");
    expect(directives.map((d) => d.split(" ")[0])).toEqual([
      "default-src",
      "script-src",
      "style-src",
      "connect-src",
      "font-src",
      "base-uri",
      "form-action",
      "frame-ancestors",
    ]);
    expect(directives).toContain("font-src 'self'");
    for (const d of ["default-src 'none'", "connect-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"]) {
      expect(directives).toContain(d);
    }
    expect(directives.find((d) => d.startsWith("script-src"))).toMatch(/^script-src 'sha256-[A-Za-z0-9+/=]+'$/);
    expect(directives.find((d) => d.startsWith("style-src"))).toMatch(/^style-src 'sha256-[A-Za-z0-9+/=]+'$/);
  });

  it("uses the site's colours in both themes, and every text colour passes WCAG AA on its background", async () => {
    const html = await (await fetch(`${base()}/`)).text();
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1];
    const roots = [...style.matchAll(/:root \{([^}]*)\}/g)].map((m) => themeOf(m[1]));
    expect(roots).toHaveLength(2);
    const [light, dark] = roots;
    expect(style).toMatch(/@media \(prefers-color-scheme: dark\) \{\s*:root \{/);
    expect(dark).toMatchObject({ bg: "#0b0f17", panel: "#121826", border: "#1f2737", text: "#e7eaf0", muted: "#8b93a7", accent: "#7aa2ff", who0: "#7aa2ff", who1: "#5ee6b5" });
    expect(light).toMatchObject({ bg: "#fbfcfd", panel: "#f1f4f8", border: "#d9dee7", text: "#0b0f17", muted: "#535b6e", accent: "#2f5bd3", who0: "#2f5bd3", who1: "#0b7350" });
    for (const theme of [light, dark]) {
      const who = Array.from({ length: 8 }, (_, i) => `who${i}`);
      // Every value the checks below use was parsed, so a missing or reformatted one is named here rather than failing later.
      const used = ["bg", "panel", "hover", "active", "text", "muted", "accent", "error", "error-bg", "mention-bg", "me", "me-bg", ...who];
      expect(used.filter((name) => !(name in theme))).toEqual([]);
      expect(new Set(who.map((w) => theme[w])).size).toBe(8);
      // The reader's own mention is accent-based, not yellow: blue outweighs red in its colour and background, and both
      // differ from a plain mention's.
      for (const name of ["me", "me-bg"]) expect(parseInt(theme[name].slice(5, 7), 16)).toBeGreaterThan(parseInt(theme[name].slice(1, 3), 16));
      expect([theme.me, theme["me-bg"]]).not.toEqual([theme.accent, theme["mention-bg"]]);
      const pairs = [
        ...["text", "muted", "accent", "error", ...who].flatMap((fg) => [[fg, "bg"], [fg, "panel"]]),
        ...["text", "muted"].flatMap((fg) => [[fg, "hover"], [fg, "active"]]),
        ["me", "me-bg"],
        ["accent", "mention-bg"],
        ["bg", "accent"],
        ["error", "error-bg"],
        ...who.map((w) => ["bg", w]),
      ];
      const failing = pairs.filter(([fg, bg]) => !(contrast(theme[fg], theme[bg]) >= 4.5));
      expect(failing).toEqual([]);
      // A primary action's text on its enabled-hover background, 85% accent mixed with 15% text.
      expect(contrast(theme.bg, mix(theme.accent, theme.text, 0.85))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("shows the site's mark beside the name, fills only the primary actions, and draws borders, not shadows", async () => {
    const html = await (await fetch(`${base()}/`)).text();
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1];
    const h1 = /<header class="bar">[\s\S]*?<h1>([\s\S]*?)<\/h1>/.exec(html)![1];
    expect(h1).toMatch(/^<svg class="mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path class="bubble" d="[^"]+"\/><path class="lines" d="[^"]+"\/><\/svg>message-cp$/);
    expect(h1).not.toMatch(/fill=|style=/);
    expect(style).toContain(".mark .bubble { fill: var(--accent); }");
    expect(style).toContain(".mark .lines { fill: var(--bg); }");
    expect(html).not.toMatch(/<img|data:/);
    expect(style).toContain(".mention.me { color: var(--me); background: var(--me-bg); box-shadow: inset 0 -2px 0 currentColor; }");
    expect(style).toMatch(/^button \{[^}]*background: none;/m);
    expect(style).toContain("#login button, #compose-send, #channel-create, #new-open, #delete-yes, #person-add, #link-make, #cancel-yes, #agent-yes { background: var(--accent); border-color: var(--accent); color: var(--bg);");
    expect(style).toContain(
      "#login button:hover:enabled, #compose-send:hover:enabled, #channel-create:hover:enabled, #new-open:hover:enabled, #delete-yes:hover:enabled, #person-add:hover:enabled, #link-make:hover:enabled, #cancel-yes:hover:enabled, #agent-yes:hover:enabled { background: color-mix(in srgb, var(--accent) 85%, var(--text)); }",
    );
    // The only shadows left are the inset accent bars on the open conversation and the highlighted mention option, and
    // the underline on the reader's own mention.
    expect(style.match(/box-shadow: [^;]*/g)).toEqual([
      "box-shadow: inset 3px 0 0 var(--accent)",
      "box-shadow: inset 0 -2px 0 currentColor",
      "box-shadow: inset 3px 0 0 var(--accent)",
    ]);
    expect(style).toMatch(/#mentions \{[^}]*border: 1px solid var\(--border\);/);
    expect(style).toContain("#sidebar { left: 0; transform: translateX(-100%); border-right: 1px solid var(--border); }");
    expect(style).toContain("#agents { right: 0; transform: translateX(100%); border-left: 1px solid var(--border); }");
  });

  it("sets Instrument Sans for the page and JetBrains Mono for names, from its own origin, in sentence case", async () => {
    const html = await (await fetch(`${base()}/`)).text();
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1];
    expect(style).toContain('--font-sans: "Instrument Sans", ui-sans-serif, system-ui, sans-serif;');
    expect(style).toContain('--font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;');
    expect(style).toMatch(/body \{[^}]*font: var\(--text-base\)\/1\.45 var\(--font-sans\);/);
    for (const rule of [".from", ".agent .name", ".option .name"]) {
      expect(style).toMatch(new RegExp(`(^|\\n)${rule.replace(/\./g, "\\.")} \\{[^}]*font-family: var\\(--font-mono\\);`));
    }
    // The only serif named is the sans-serif fallback.
    expect(style.replaceAll("sans-serif", "")).not.toContain("serif");
    expect(style).not.toContain("uppercase");
    expect(style).not.toContain("letter-spacing");
    expect(style).not.toContain("@import");
    // Every font is fetched from a path on this origin, and every font-size but the hidden dot's 0 comes from the scale.
    const urls = [...style.matchAll(/url\("([^"]*)"\)/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u).toMatch(/^\/fonts\/[a-z0-9-]+\.woff2$/);
    for (const [, size] of style.matchAll(/font-size: ([^;]+);/g)) expect(size).toMatch(/^(var\(--text-(xs|sm|base|lg)\)|0)$/);
    // Each weight and style a rule asks for has a face: sans for every rule, and mono for the name rules too.
    const faces = [...style.matchAll(/font-family: "([^"]+)"; font-style: (\w+); font-weight: (\d+);/g)].map(
      (m) => `${m[1]} ${m[2]} ${m[3]}`,
    );
    for (const [, rule] of style.matchAll(/(?:^|\n)([^@\n{][^{\n]*\{[^}]*\})/g)) {
      const weight = /font-weight: (\d+)/.exec(rule)?.[1];
      const italic = rule.includes("font-style: italic");
      if (!weight && !italic) continue;
      const family = rule.includes("var(--font-mono)") ? "JetBrains Mono" : "Instrument Sans";
      expect(faces, rule).toContain(`${family} ${italic ? "italic" : "normal"} ${weight ?? "400"}`);
    }
    expect(html).toContain("<h2>Channels</h2>");
    expect(html).toContain("<h2>Direct messages</h2>");
  });
});

describe("GET /fonts/<file>", () => {
  const FONTS = [
    "@fontsource/instrument-sans/files/instrument-sans-latin-400-normal.woff2",
    "@fontsource/instrument-sans/files/instrument-sans-latin-400-italic.woff2",
    "@fontsource/instrument-sans/files/instrument-sans-latin-600-normal.woff2",
    "@fontsource/instrument-sans/files/instrument-sans-latin-700-normal.woff2",
    "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-600-normal.woff2",
  ];
  const path = (file: string) => `/fonts/${file.split("/").pop()}`;
  // A raw request, so the path reaches the server as written, `..` included.
  const raw = (method: string, target: string) =>
    new Promise<number>((done, fail) => {
      const req = request({ host: "127.0.0.1", port: http.port, method, path: target }, (res) => {
        res.resume();
        done(res.statusCode!);
      });
      req.on("error", fail);
      req.end();
    });

  it("serves each font the page's style names, the package's bytes, with or without a token", async () => {
    const html = await (await fetch(`${base()}/`)).text();
    const named = [...html.matchAll(/url\("(\/fonts\/[^"]*)"\)/g)].map((m) => m[1]);
    expect(named.sort()).toEqual(FONTS.map(path).sort());
    const require = createRequire(import.meta.url);
    for (const file of FONTS) {
      for (const headers of [{}, auth("wrong"), auth(viewer)]) {
        const res = await fetch(`${base()}${path(file)}`, { headers });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("font/woff2");
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
        expect(Buffer.from(await res.arrayBuffer()).equals(readFileSync(require.resolve(file)))).toBe(true);
      }
    }
  });

  it("ignores a query on a font path, as on every path", async () => {
    expect((await fetch(`${base()}${path(FONTS[0])}?v=1`)).status).toBe(200);
  });

  it("serves the fonts without reading the database", async () => {
    db.close();
    expect((await fetch(`${base()}${path(FONTS[0])}`)).status).toBe(200);
    db = openDb(join(mkdtempSync(join(tmpdir(), "message-cp-dashboard-")), "db.sqlite"));
  });

  it("puts every other path, a font another way or another method behind the token", async () => {
    for (const target of [
      "/fonts/nope.woff2",
      "/fonts/",
      "/fonts",
      "/fonts/../package.json",
      "/fonts/%2e%2e/package.json",
      "/fonts/instrument-sans-latin-400-normal.woff2/",
      "/fonts/INSTRUMENT-SANS-LATIN-400-NORMAL.WOFF2",
      "/fonts/instrument-sans-latin-500-normal.woff2",
      "/fonts/jetbrains-mono-latin-400-normal.woff2",
      "//fonts/instrument-sans-latin-400-normal.woff2",
    ]) {
      expect(await raw("GET", target), target).toBe(401);
    }
    for (const method of ["POST", "DELETE", "HEAD"]) expect(await raw(method, path(FONTS[0])), method).toBe(401);
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
      location: { hash: "", pathname: "/", search: "" },
      history: { replaceState() {} },
      addEventListener() {},
      URLSearchParams,
      document: { getElementById: (id: string) => (elements[id] ??= el()), createElement: el, addEventListener() {} },
      sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
      setTimeout: (fn: () => void, ms: number) => (timers.set(++nextTimer, { fn, ms }), nextTimer),
      clearTimeout: (id: number) => timers.delete(id),
      // GET /api/token answers at once, so only the polls' requests are left to hang.
      fetch: (url: string, init: { signal: AbortSignal }) => {
        if (url === "/api/token") return Promise.resolve(new Response(JSON.stringify({ readOnly: true })));
        if (url === "oauth/signin") return Promise.resolve(new Response(null, { status: 404 }));
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
    // The tag createElement was given, in upper case as a browser gives it; "" for an element found by id.
    tagName: string;
    on: Record<string, () => void>;
    hidden: boolean;
    value: string;
    textContent: string;
    className: string;
    title: string;
    // Set by the script on the buttons it builds.
    type?: string;
    attributes: Record<string, string>;
    children: Stub[];
    top: number;
    scrollTop: number;
    readonly scrollHeight: number;
    readonly clientHeight: number;
    append(...children: Stub[]): void;
    replaceChildren(...children: Stub[]): void;
    addEventListener(type: string, fn: () => void): void;
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
    focus(): void;
    contains(node: unknown): boolean;
  }
  // Elements start hidden, as the page's form, view and log do.
  const el = (tag = ""): Stub => ({
    tagName: tag.toUpperCase(),
    on: {},
    hidden: true,
    value: "",
    textContent: "",
    className: "",
    title: "",
    children: [],
    attributes: {},
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
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
    focus() {},
    contains(node) {
      return node === this || this.children.some((c) => c.contains(node));
    },
  });
  // A sidebar item's label and its unread badge as shown ("" when hidden), and the button that opens it.
  const item = (row: Stub) => row.children[0].children.map((c) => (c.className === "badge" && c.hidden ? "" : c.textContent));
  // A sidebar item's tooltip, which holds its total.
  const tip = (row: Stub) => row.children[0].title;
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
    const timers = handTimers();
    const store = new Map([["message-cp-token", token]]);
    // The document's own listeners, such as the one for Escape.
    const documentOn: Record<string, (event: unknown) => void> = {};
    // The page's document; a test sets its activeElement to say where focus is.
    const doc: { activeElement: Stub | null } & Record<string, unknown> = {
      activeElement: null,
      getElementById: (id: string) => (elements[id] ??= el()),
      createElement: el,
      addEventListener: (type: string, fn: (event: unknown) => void) => void (documentOn[type] = fn),
    };
    runInNewContext(script, {
      AbortController,
      location: { hash: "", pathname: "/", search: "" },
      history: { replaceState() {} },
      addEventListener() {},
      URLSearchParams,
      document: doc,
      sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
      setTimeout: timers.set,
      clearTimeout: timers.clear,
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
    return { elements, urls, store, documentOn, doc, until, poll: timers.poll, scheduled: timers.scheduled };
  }

  it("with an agent token, forgets it and says agent tokens cannot use the dashboard, showing nothing of the account", async () => {
    registerAgent(db, OWNER_ACCOUNT, "bob", "x");
    sendMessage(db, OWNER_ACCOUNT, "bob", "bob", "private <b>note</b>");
    const page = await load(agentToken);
    const said = "That is an agent token, and agent tokens cannot use the dashboard. Enter a full, read-only or person token.";
    await page.until(() => page.elements["status-line"].textContent === said);
    expect(page.store.size).toBe(0);
    expect(page.elements["login"].hidden).toBe(false);
    expect(page.elements["view"].hidden).toBe(true);
    expect(page.elements["rows"].children).toHaveLength(0);
    expect(page.elements["pair-rows"].children).toHaveLength(0);
    // No poll is left to run, so the page asks the server nothing more with it.
    const asked = page.urls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(page.scheduled()).toBe(false);
    expect(page.urls.length).toBe(asked);
    expect(db.prepare("SELECT body FROM messages").all()).toEqual([{ body: "private <b>note</b>" }]);
  });

  describe("a login link", () => {
    // The page as a link from message-cp login-link opens it: no token yet, the code in the fragment, and an address bar
    // that records what replaceState leaves in it.
    async function openLink(hash: string, refuse?: (url: string) => number | "hang" | "fail" | undefined) {
      const address = { hash, pathname: "/", search: "" };
      const replaced: string[] = [];
      const history = { replaceState: (_s: unknown, _t: string, url: string) => (replaced.push(url), (address.hash = "")) };
      const page = await load("", refuse, { location: address, history });
      return { ...page, address, replaced };
    }

    it("redeems the code once for a sign-in session, clears it from the address bar first, and starts as after a paste", async () => {
      addPerson(db, "owner", "maria");
      const { code } = makeLoginCode(db, "owner", "maria");
      const page = await openLink(`#code=${code}`);
      expect(page.replaced).toEqual(["/"]);
      expect(page.address.hash).toBe("");
      await page.until(() => page.elements["view"].hidden === false);
      expect(page.urls[0]).toBe("/api/login");
      const session = page.store.get("message-cp-token")!;
      expect(accountForToken(db, session, OWNER_TOKEN)?.person?.name).toBe("maria");
      // The tab holds the session, not a token.
      expect(accountForToken(db, session, OWNER_TOKEN)?.session).toBeDefined();
      expect(page.elements["login"].hidden).toBe(true);
      await page.until(() => page.urls.includes("/api/token"));
      expect(page.urls.filter((u) => u === "/api/login")).toHaveLength(1);
    });

    it("shows the token form saying a used link was already used", async () => {
      const { code } = makeLoginCode(db, "owner");
      redeemLoginCode(db, code);
      const page = await openLink(`#code=${code}`);
      await page.until(() => page.elements["status-line"].textContent.startsWith("This link was already used."));
      expect(page.elements["login"].hidden).toBe(false);
      expect(page.elements["view"].hidden).toBe(true);
      expect(page.store.size).toBe(0);
    });

    it("shows the token form saying a cancelled invite was cancelled", async () => {
      addPerson(db, "owner", "maria");
      addPerson(db, "owner", "ana", true);
      const ana = db.prepare("SELECT id FROM agents WHERE name = 'ana'").pluck().get() as number;
      const invite = makeInvite(db, OWNER_ACCOUNT, ana, "maria")!.invite;
      cancelInvite(db, OWNER_ACCOUNT, invite.id);
      const page = await openLink(`#code=${invite.code}`);
      await page.until(() => page.elements["status-line"].textContent.startsWith("This link was cancelled."));
      expect(page.elements["login"].hidden).toBe(false);
      expect(page.elements["view"].hidden).toBe(true);
      expect(page.store.size).toBe(0);
    });

    it("shows the token form saying an unknown code has expired or is not valid", async () => {
      const page = await openLink(`#code=${"0".repeat(64)}`);
      await page.until(() => page.elements["status-line"].textContent.startsWith("This link has expired or is not valid."));
      expect(page.elements["login"].hidden).toBe(false);
      expect(page.store.size).toBe(0);
    });

    it("drops the answer when a token is entered meanwhile, so the entered token wins", async () => {
      const { code } = makeLoginCode(db, "owner");
      let release: () => void = () => {};
      const held = new Promise<void>((r) => (release = r));
      let answered = false;
      const asked: string[] = [];
      const address = { hash: `#code=${code}`, pathname: "/", search: "" };
      const page = await load("", undefined, {
        location: address,
        history: { replaceState: () => (address.hash = "") },
        // The login reaches the server and redeems the code, but its answer comes only after the paste.
        fetch: async (url: string, init: RequestInit) => {
          asked.push(url);
          const res = await fetch(`${base()}${url}`, init);
          if (url === "/api/login") {
            await held;
            answered = true;
          }
          return res;
        },
      });
      await page.until(() => asked.includes("/api/login"));
      page.elements["token"].value = viewer;
      page.elements["login"].on.submit({ preventDefault() {} } as never);
      release();
      await page.until(() => answered);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(page.store.get("message-cp-token")).toBe(viewer);
      expect(asked.filter((u) => u === "/api/token")).toHaveLength(1);
    });

    it("takes a link opened in a tab already signed in, which changes only the fragment, and replaces the tab's token", async () => {
      addPerson(db, "owner", "maria");
      const address = { hash: "", pathname: "/", search: "" };
      const windowOn: Record<string, () => void> = {};
      const page = await load(viewer, undefined, {
        location: address,
        history: { replaceState: () => (address.hash = "") },
        addEventListener: (type: string, fn: () => void) => void (windowOn[type] = fn),
      });
      await page.until(() => page.elements["view"].hidden === false);
      expect(page.urls).not.toContain("/api/login");
      const { code } = makeLoginCode(db, "owner", "maria");
      address.hash = `#code=${code}`;
      windowOn.hashchange();
      expect(address.hash).toBe("");
      await page.until(() => page.urls.includes("/api/login") && page.store.get("message-cp-token") !== viewer && page.elements["view"].hidden === false);
      expect(accountForToken(db, page.store.get("message-cp-token")!, OWNER_TOKEN)?.person?.name).toBe("maria");
      // A fragment change without a code leaves the tab as it is.
      const asked = page.urls.filter((u) => u === "/api/login").length;
      address.hash = "#other";
      windowOn.hashchange();
      expect(page.urls.filter((u) => u === "/api/login")).toHaveLength(asked);
    });

    it("takes a 200 without a session, such as a token from a server before sessions, as no answer", async () => {
      const address = { hash: `#code=${"0".repeat(64)}`, pathname: "/", search: "" };
      const page = await load("", undefined, {
        location: address,
        history: { replaceState: () => (address.hash = "") },
        fetch: async (url: string, init: RequestInit) =>
          url === "/api/login" ? new Response(JSON.stringify({ token: viewer }), { status: 200 }) : fetch(`${base()}${url}`, init),
      });
      await page.until(() => page.elements["status-line"].textContent.startsWith("The server answered 200."));
      expect(page.elements["login"].hidden).toBe(false);
      expect(page.store.size).toBe(0);
    });

    it("starts as before without a code in the fragment", async () => {
      const page = await openLink("#other");
      expect(page.replaced).toEqual([]);
      expect(page.urls).not.toContain("/api/login");
      expect(page.elements["login"].hidden).toBe(false);
    });
  });

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
      ["build", ""],
      ["ops", ""],
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

  describe("the narrow-screen panels", () => {
    // The view's class, which slides a panel in, and each toggle's aria-expanded.
    const state = (page: Awaited<ReturnType<typeof load>>) => [
      page.elements["view"].className,
      page.elements["show-sidebar"].attributes["aria-expanded"],
      page.elements["show-agents"].attributes["aria-expanded"],
    ];
    const key = (page: Awaited<ReturnType<typeof load>>, key: string, defaultPrevented = false) => {
      let prevented = 0;
      page.documentOn.keydown({ key, defaultPrevented, preventDefault: () => prevented++ });
      return prevented;
    };
    // detail is 1 for a tap or a mouse click and 0 for a click made from the keyboard.
    const tap = (page: Awaited<ReturnType<typeof load>>, detail = 1) => {
      let stopped = 0;
      page.elements["chat"].on.click({ detail, preventDefault() {}, stopPropagation: () => stopped++ });
      return stopped;
    };

    it("opens one panel at a time, and closes it on its button, Escape or a tap on the conversation", async () => {
      seed();
      const page = await load(viewer);
      await page.until(() => page.elements["channel-rows"].children.length === 1);
      const sidebar = page.elements["show-sidebar"];
      const agents = page.elements["show-agents"];
      sidebar.on.click();
      expect(state(page)).toEqual(["show-sidebar", "true", "false"]);
      sidebar.on.click();
      expect(state(page)).toEqual(["", "false", "false"]);
      // The other button swaps the panels.
      sidebar.on.click();
      agents.on.click();
      expect(state(page)).toEqual(["show-agents", "false", "true"]);
      expect(key(page, "Escape")).toBe(1);
      expect(state(page)).toEqual(["", "false", "false"]);
      // With no panel open Escape and a tap are left alone.
      expect(key(page, "Escape")).toBe(0);
      expect(tap(page)).toBe(0);
      sidebar.on.click();
      expect(key(page, "Enter")).toBe(0);
      expect(state(page)).toEqual(["show-sidebar", "true", "false"]);
      // An Escape that a form or the mention list already took leaves the panel open.
      expect(key(page, "Escape", true)).toBe(0);
      expect(state(page)).toEqual(["show-sidebar", "true", "false"]);
      // Enter or Space on a focused button in the conversation still presses it.
      expect(tap(page, 0)).toBe(0);
      expect(state(page)).toEqual(["show-sidebar", "true", "false"]);
      expect(tap(page)).toBe(1);
      expect(state(page)).toEqual(["", "false", "false"]);
      // Above 720px the toggles are hidden (no offsetParent), so a panel class left from a narrow screen covers nothing.
      sidebar.on.click();
      Object.assign(sidebar, { offsetParent: null });
      expect(key(page, "Escape")).toBe(0);
      expect(tap(page)).toBe(0);
      expect(state(page)).toEqual(["show-sidebar", "true", "false"]);
    });

    it("puts focus back on the panel's button when a tap closes the panel with focus inside it", async () => {
      seed();
      const page = await load(viewer);
      await page.until(() => page.elements["channel-rows"].children.length === 1);
      const focused: string[] = [];
      for (const id of ["show-sidebar", "show-agents"]) page.elements[id].focus = () => void focused.push(id);
      // Focus on a channel row inside the open sidebar goes back to ☰.
      page.elements["show-sidebar"].on.click();
      page.doc.activeElement = page.elements["channel-rows"].children[0].children[0];
      page.elements["sidebar"].children = [page.elements["channel-rows"]];
      expect(tap(page)).toBe(1);
      expect(focused).toEqual(["show-sidebar"]);
      // Focus inside the open agents panel goes back to Agents.
      page.elements["show-agents"].on.click();
      page.doc.activeElement = page.elements["agents"];
      expect(tap(page)).toBe(1);
      expect(focused).toEqual(["show-sidebar", "show-agents"]);
      // Focus outside the panel, such as in the compose box, stays where it is.
      page.elements["show-sidebar"].on.click();
      page.doc.activeElement = page.elements["compose-text"];
      expect(tap(page)).toBe(1);
      expect(focused).toEqual(["show-sidebar", "show-agents"]);
      expect(state(page)).toEqual(["", "false", "false"]);
    });

    it("closes when a conversation, the deliveries or a search opens, and on ask()", async () => {
      seed();
      registerAgent(db, OWNER_ACCOUNT, "bob", "x");
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "hi");
      const page = await load(viewer);
      await page.until(() => page.elements["channel-rows"].children.length === 1);
      await page.until(() => page.elements["pair-rows"].children.length === 1);
      page.elements["show-sidebar"].on.click();
      open(page.elements["channel-rows"].children[0]);
      expect(state(page)).toEqual(["", "false", "false"]);
      page.elements["show-sidebar"].on.click();
      open(page.elements["pair-rows"].children[0]);
      expect(state(page)).toEqual(["", "false", "false"]);
      page.elements["show-sidebar"].on.click();
      await page.until(() => page.elements["delivery-entry"].children.length === 1);
      open(page.elements["delivery-entry"].children[0]);
      expect(state(page)).toEqual(["", "false", "false"]);
      page.elements["show-agents"].on.click();
      page.elements["search-text"].value = "hello";
      page.elements["search"].on.submit({ preventDefault() {} });
      expect(state(page)).toEqual(["", "false", "false"]);
      page.elements["show-agents"].on.click();
      page.elements["forget"].on.click();
      expect(state(page)).toEqual(["", "false", "false"]);
    });
  });

  it("clears the channels and the open log when the server refuses the token", async () => {
    seed();
    const ticket = addToken(db, "owner", true);
    const page = await load(ticket.token);
    const channels = page.elements["channel-rows"];
    await page.until(() => channels.children.length === 1);
    open(channels.children[0]);
    await page.until(() => page.elements["post-rows"].children.length === 1);
    // Opening the channel polls at once; let that poll finish so the refusal comes from the next one.
    await page.until(page.scheduled);

    revokeToken(db, ticket.id);
    await page.poll();
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
  // An agents panel row's button, its mark, name and badge ("" when hidden), and its details part.
  const agentButton = (row: Stub) => row.children[0];
  const agentLine = (row: Stub) => agentButton(row).children.map((c) => (c.className === "badge" && c.hidden ? "" : c.textContent));
  const details = (row: Stub) => row.children[1];

  it("marks a person in the agents panel as a person, in place of the online dot", async () => {
    registerAgent(db, OWNER_ACCOUNT, "alice", "x");
    addPerson(db, "owner", "colin");
    const page = await load(viewer);
    const rows = page.elements["rows"];
    await page.until(() => rows.children.length === 2);
    const marks = rows.children.map((row) => {
      const [mark, name] = agentButton(row).children;
      return [name.textContent, mark.className, mark.textContent, mark.title];
    });
    expect(marks).toEqual([
      ["alice", "dot online", "online", "online"],
      ["colin", "kind", "person", "a person, not an agent"],
    ]);
    expect(rows.children.map((row) => field(details(row), "seen")?.split(" ")[0])).toEqual(["last", "added"]);
    expect(agentButton(rows.children[0]).title).toMatch(/^x · last seen /);
    // A person added without a bio has no empty part at the start of its tooltip.
    expect(agentButton(rows.children[1]).title).toMatch(/^added \d+s ago · unread: 0 messages, 0 posts, 0 mentions$/);
  });

  describe("the compact agents panel", () => {
    const setup = () => {
      registerAgent(db, OWNER_ACCOUNT, "alice", "writes the docs");
      registerAgent(db, OWNER_ACCOUNT, "bob", "builds the site");
      const alice = { ...identityOf(db, OWNER_ACCOUNT, "alice")!, name: "alice" };
      joinChannel(db, OWNER_ACCOUNT, alice, "build");
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "one");
      post(db, OWNER_ACCOUNT, alice, "build", "@bob look");
      post(db, OWNER_ACCOUNT, alice, "build", "@bob again");
    };

    it("shows each row's mark, name and one badge of its summed unread counts, hidden at 0", async () => {
      setup();
      const page = await load(viewer);
      const rows = page.elements["rows"];
      await page.until(() => rows.children.length === 2);
      expect(rows.children.map(agentLine)).toEqual([
        ["online", "alice", ""],
        ["online", "bob", "3"],
      ]);
      expect(rows.children.map((row) => agentButton(row).children.map((c) => c.className))).toEqual([
        ["dot online", "name", "badge"],
        ["dot online", "name", "badge"],
      ]);
      expect(agentButton(rows.children[0]).children[2].hidden).toBe(true);
    });

    it("puts the bio, last seen and unread totals in the row's tooltip, not in a visible line", async () => {
      setup();
      const page = await load(viewer);
      const rows = page.elements["rows"];
      await page.until(() => rows.children.length === 2);
      expect(agentButton(rows.children[1]).title).toMatch(/^builds the site · last seen \d+s ago · unread: 1 message, 0 posts, 2 mentions$/);
      expect(agentButton(rows.children[0]).title).toMatch(/^writes the docs · last seen \d+s ago · unread: 0 messages, 0 posts, 0 mentions$/);
      // Each total is counted in its own singular or plural.
      const bob = { ...identityOf(db, OWNER_ACCOUNT, "bob")!, name: "bob" };
      joinChannel(db, OWNER_ACCOUNT, { ...identityOf(db, OWNER_ACCOUNT, "alice")!, name: "alice" }, "ops");
      post(db, OWNER_ACCOUNT, bob, "ops", "one");
      post(db, OWNER_ACCOUNT, bob, "build", "two");
      sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "hi");
      await page.until(page.scheduled);
      await page.poll();
      await page.until(() => page.scheduled() && agentButton(rows.children[0]).title.includes("1 message, 2 posts"));
      expect(agentButton(rows.children[0]).title).toMatch(/· unread: 1 message, 2 posts, 0 mentions$/);
      expect(agentLine(rows.children[0])).toEqual(["online", "alice", "3"]);
      for (const row of rows.children) expect(details(row).hidden).toBe(true);
      const visible = rows.children.map((row) => agentButton(row).children.map((c) => c.textContent).join(" "));
      for (const line of visible) expect(line).not.toMatch(/builds|writes|seen|unread/);
    });

    it("shows and hides the details with the row's button, keeps them open across polls, and marks nothing read", async () => {
      setup();
      const page = await load(viewer);
      const rows = page.elements["rows"];
      await page.until(() => page.scheduled() && rows.children.length === 2);
      const bob = () => rows.children[1];
      expect(agentButton(bob()).type).toBe("button");
      expect(agentButton(bob()).attributes["aria-expanded"]).toBe("false");

      const before = page.urls.length;
      agentButton(bob()).on.click();
      expect(page.urls.length).toBe(before);
      expect(agentButton(bob()).attributes["aria-expanded"]).toBe("true");
      expect(details(bob()).hidden).toBe(false);
      expect(details(bob()).children.map((c) => c.className)).toEqual(["bio", "seen", "unread"]);
      expect(field(details(bob()), "bio")).toBe("builds the site");
      expect(field(details(bob()), "seen")).toMatch(/^last seen \d+s ago$/);
      expect(details(bob()).children[1].title).toMatch(/^\d{4}-\d\d-\d\dT/);
      expect(field(details(bob()), "unread")).toBe("unread: 1 message, 0 posts, 2 mentions");

      const row = bob();
      await page.poll();
      await page.until(() => page.scheduled() && bob() !== row);
      expect(agentButton(bob()).attributes["aria-expanded"]).toBe("true");
      expect(details(bob()).hidden).toBe(false);
      expect(details(rows.children[0]).hidden).toBe(true);
      // Nothing was marked read for bob.
      expect(agentLine(bob())).toEqual(["online", "bob", "3"]);

      agentButton(bob()).on.click();
      expect(agentButton(bob()).attributes["aria-expanded"]).toBe("false");
      expect(details(bob()).hidden).toBe(true);
    });

    it("shows a new token no open details from the old one", async () => {
      setup();
      const page = await load(viewer);
      const rows = page.elements["rows"];
      await page.until(() => rows.children.length === 2);
      agentButton(rows.children[1]).on.click();
      expect(details(rows.children[1]).hidden).toBe(false);

      page.elements["forget"].on.click();
      expect(rows.children).toHaveLength(0);
      page.elements["token"].value = viewer;
      page.elements["login"].on.submit({ preventDefault() {} } as never);
      await page.until(() => rows.children.length === 2);
      expect(rows.children.map((row) => details(row).hidden)).toEqual([true, true]);
      expect(rows.children.map((row) => agentButton(row).attributes["aria-expanded"])).toEqual(["false", "false"]);
    });

    it("shows an agent's status line after its name, in its tooltip and details, and drops it on the poll after it clears", async () => {
      setup();
      const line = "reading Linear for the next ticket";
      setStatus(db, OWNER_ACCOUNT, identityOf(db, OWNER_ACCOUNT, "bob")!, line);
      const page = await load(viewer);
      const rows = page.elements["rows"];
      await page.until(() => page.scheduled() && rows.children.length === 2);
      const bob = () => rows.children[1];
      expect(agentLine(bob())).toEqual(["online", "bob", line, "3"]);
      expect(agentButton(bob()).children.map((c) => c.className)).toEqual(["dot online", "name", "status", "badge"]);
      expect(agentButton(bob()).title).toMatch(/^reading Linear for the next ticket · builds the site · last seen /);
      expect(details(bob()).children.map((c) => c.className)).toEqual(["status", "bio", "seen", "unread"]);
      expect(field(details(bob()), "status")).toBe(line);
      // alice has no line, so her row has no status part.
      expect(agentLine(rows.children[0])).toEqual(["online", "alice", ""]);

      setStatus(db, OWNER_ACCOUNT, identityOf(db, OWNER_ACCOUNT, "bob")!, "");
      await page.poll();
      await page.until(() => page.scheduled() && agentButton(bob()).children.length === 3);
      expect(agentLine(bob())).toEqual(["online", "bob", "3"]);
      expect(agentButton(bob()).title).toMatch(/^builds the site · /);
      expect(details(bob()).children.map((c) => c.className)).toEqual(["bio", "seen", "unread"]);
    });

    it("still says when an account has no agents", async () => {
      const page = await load(viewer);
      const rows = page.elements["rows"];
      await page.until(() => rows.children.length === 1);
      expect(rows.children[0].textContent).toBe(NO_AGENTS);
    });
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
    await page.poll();
    await page.until(() => posts.children.length === 2);
    expect(page.urls).toContain("/api/channel-posts?channel=build&limit=200&offset=1");
    expect(page.urls).not.toContain("/api/channel-posts?channel=build&limit=200&offset=0");
    expect(posts.children.map((row) => field(row, "body"))).toEqual(["hello", "second"]);

    // A log read that has not answered yet does not hold back the agents and channels.
    joinChannel(db, OWNER_ACCOUNT, alice, "ops");
    hang = true;
    await page.poll();
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
      ["bob ↔ carol", ""],
      ["alice ↔ bob", ""],
    ]);
    expect(pairs.children.map(tip)).toEqual(["1 message", "2 messages"]);
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
    await page.poll();
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
    await page.poll();
    await page.until(() => log.children.length === 11);
    expect(log.scrollTop).toBe(120);

    log.scrollTop = 0;
    sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "scrolled up");
    await page.poll();
    await page.until(() => log.children.length === 12);
    expect(log.scrollTop).toBe(0);
  });

  it("pages through every message, then appends only the new ones for the open pair on each poll", async () => {
    for (const name of ["alice", "bob", "carol"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
    for (let i = 0; i < 201; i++) sendMessage(db, OWNER_ACCOUNT, "alice", "bob", `message ${i}`);
    const page = await load(viewer);
    const pairs = page.elements["pair-rows"];
    await page.until(() => pairs.children.length === 1 && tip(pairs.children[0]) === "201 messages");
    expect(page.urls).toContain("/api/messages?limit=200&offset=200");
    open(pairs.children[0]);
    const log = page.elements["post-rows"];
    expect(log.children).toHaveLength(201);
    expect(field(log.children[200], "body")).toBe("message 200");

    sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "reply");
    sendMessage(db, OWNER_ACCOUNT, "carol", "bob", "not this pair");
    page.urls.length = 0;
    await page.poll();
    await page.until(() => log.children.length === 202);
    expect(page.urls.filter((url) => url.startsWith("/api/messages?limit"))).toEqual(["/api/messages?limit=200&offset=201"]);
    // The receipts read every page of the unread messages, which are all 203 here.
    await page.until(() => page.urls.includes("/api/messages?unread=true&limit=200&offset=200"));
    expect(page.urls.filter((url) => url.startsWith("/api/messages?unread"))).toEqual([
      "/api/messages?unread=true&limit=200&offset=0",
      "/api/messages?unread=true&limit=200&offset=200",
    ]);
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
    // Opening the pair polls at once; let that poll finish so the refusal comes from the next one.
    await page.until(page.scheduled);
    revokeToken(db, ticket.id);
    await page.poll();
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
    await page.poll();
    await page.until(() => page.elements["status-line"].textContent.startsWith("The server refused"));
    expect(page.elements["post-rows"].children).toHaveLength(0);
    expect(page.store.size).toBe(0);
  });

  describe("the header bar", () => {
    const member = (name: string) => ({ ...identityOf(db, OWNER_ACCOUNT, name)!, name });
    const members = (page: { elements: Record<string, Stub> }) => {
      const line = page.elements["log-members"];
      return line.hidden ? undefined : [line.textContent, line.title];
    };

    it("shows an open channel's members under its name, in the server's order", async () => {
      for (const name of ["bob", "alice"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
      joinChannel(db, OWNER_ACCOUNT, member("bob"), "build");
      joinChannel(db, OWNER_ACCOUNT, member("alice"), "build");
      const page = await load(viewer);
      const channels = page.elements["channel-rows"];
      await page.until(() => channels.children.length === 1);
      expect(members(page)).toBeUndefined();
      open(channels.children[0]);
      await page.until(() => members(page) !== undefined);
      expect(page.elements["log-title"].textContent).toBe("build");
      expect(members(page)).toEqual(["Members: alice, bob", "Members: alice, bob"]);
    });

    it("says a channel nobody has joined has no members yet", async () => {
      seed();
      const page = await load(viewer);
      const channels = page.elements["channel-rows"];
      await page.until(() => channels.children.length === 1);
      open(channels.children[0]);
      await page.until(() => members(page) !== undefined);
      expect(members(page)).toEqual(["No members yet", "No members yet"]);
    });

    it("follows agents joining and leaving the open channel on the next poll, and keeps the last ones shown when the channel is no longer listed", async () => {
      for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
      joinChannel(db, OWNER_ACCOUNT, member("alice"), "build");
      const page = await load(viewer);
      const channels = page.elements["channel-rows"];
      await page.until(() => channels.children.length === 1);
      open(channels.children[0]);
      await page.until(() => members(page)?.[0] === "Members: alice" && page.scheduled());

      joinChannel(db, OWNER_ACCOUNT, member("bob"), "build");
      await page.poll();
      await page.until(() => members(page)?.[0] === "Members: alice, bob" && page.scheduled());
      leaveChannel(db, OWNER_ACCOUNT, member("alice"), "build");
      await page.poll();
      await page.until(() => members(page)?.[0] === "Members: bob" && page.scheduled());

      // A channel the answer no longer lists keeps the members last shown, and the log says it is not there.
      db.prepare("DELETE FROM channel_reads").run();
      db.prepare("DELETE FROM channels").run();
      await page.poll();
      await page.until(() => page.elements["log-note"].textContent === "There is no channel by this name now.");
      expect(channels.children.map((row) => row.textContent)).toEqual([NO_CHANNELS]);
      expect(members(page)).toEqual(["Members: bob", "Members: bob"]);
    });

    it("shows no members line for a pair or the webhook deliveries", async () => {
      for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
      joinChannel(db, OWNER_ACCOUNT, member("alice"), "build");
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "hi");
      const page = await load(viewer);
      const channels = page.elements["channel-rows"];
      const pairs = page.elements["pair-rows"];
      await page.until(() => channels.children.length === 1 && pairs.children.length === 1);
      open(channels.children[0]);
      await page.until(() => members(page) !== undefined);

      open(pairs.children[0]);
      expect(page.elements["log-title"].textContent).toBe("alice ↔ bob");
      expect(members(page)).toBeUndefined();
      expect(page.elements["log-members"].textContent).toBe("");
      // A poll while the pair is open does not bring the channel's members back.
      await page.until(() => page.scheduled());
      await page.poll();
      await page.until(() => page.scheduled());
      expect(members(page)).toBeUndefined();

      open(page.elements["delivery-entry"].children[0]);
      expect(page.elements["log-title"].textContent).toBe("Webhook deliveries");
      expect(members(page)).toBeUndefined();
    });

    it("clears the members line when the log closes or the token goes", async () => {
      registerAgent(db, OWNER_ACCOUNT, "alice", "x");
      joinChannel(db, OWNER_ACCOUNT, member("alice"), "build");
      const page = await load(viewer);
      const channels = page.elements["channel-rows"];
      await page.until(() => channels.children.length === 1);
      open(channels.children[0]);
      await page.until(() => members(page) !== undefined);
      page.elements["close-log"].on.click();
      expect(members(page)).toBeUndefined();
      expect(page.elements["log-members"].textContent).toBe("");
      expect(page.elements["log-members"].title).toBe("");

      open(channels.children[0]);
      await page.until(() => members(page) !== undefined);
      page.elements["forget"].on.click();
      expect(members(page)).toBeUndefined();
      expect(page.elements["log-members"].textContent).toBe("");
      expect(page.elements["log-members"].title).toBe("");
    });
  });

  describe("the header bar's status lines", () => {
    // The open pair's status line in the header bar, with its tooltip, or undefined while it is hidden.
    const statusLine = (page: { elements: Record<string, Stub> }) => {
      const line = page.elements["log-status"];
      return line.hidden ? undefined : [line.textContent, line.title];
    };
    const setLine = (name: string, text: string) => setStatus(db, OWNER_ACCOUNT, identityOf(db, OWNER_ACCOUNT, name)!, text);
    const pollOnce = async (page: Awaited<ReturnType<typeof load>>) => {
      await page.poll();
      await page.until(page.scheduled);
    };

    it("shows an open pair's agent's line at once, follows each poll, and drops it on the poll after it clears", async () => {
      for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "hi");
      setLine("bob", "reading Linear");
      const page = await load(viewer);
      const pairs = page.elements["pair-rows"];
      await page.until(() => page.scheduled() && pairs.children.length === 1);
      expect(statusLine(page)).toBeUndefined();

      // Opening the pair shows the last answer's line before the next poll comes back.
      open(pairs.children[0]);
      expect(statusLine(page)).toEqual(["bob: reading Linear", "bob: reading Linear"]);
      await page.until(page.scheduled);

      // A line set while the pair is open appears on the next poll, joined with the other side's.
      setLine("alice", "writing tests");
      await pollOnce(page);
      expect(statusLine(page)).toEqual(["alice: writing tests · bob: reading Linear", "alice: writing tests · bob: reading Linear"]);

      setLine("bob", "");
      await pollOnce(page);
      expect(statusLine(page)).toEqual(["alice: writing tests", "alice: writing tests"]);
      setLine("alice", "");
      await pollOnce(page);
      expect(statusLine(page)).toBeUndefined();
      expect(page.elements["log-status"].textContent).toBe("");
      expect(page.elements["log-status"].title).toBe("");
    });

    it("gives an agent's conversation with itself one line", async () => {
      registerAgent(db, OWNER_ACCOUNT, "alice", "x");
      sendMessage(db, OWNER_ACCOUNT, "alice", "alice", "note to self");
      setLine("alice", "reading Linear");
      const page = await load(viewer);
      const pairs = page.elements["pair-rows"];
      await page.until(() => page.scheduled() && pairs.children.length === 1);
      open(pairs.children[0]);
      expect(statusLine(page)).toEqual(["alice: reading Linear", "alice: reading Linear"]);
    });

    it("keeps the line through a failed poll", async () => {
      for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "hi");
      setLine("bob", "reading Linear");
      let busy = false;
      const page = await load(viewer, (url) => (busy && url.includes("/api/agents") ? 503 : undefined));
      const pairs = page.elements["pair-rows"];
      await page.until(() => page.scheduled() && pairs.children.length === 1);
      open(pairs.children[0]);
      await page.until(page.scheduled);

      busy = true;
      setLine("bob", "");
      await pollOnce(page);
      expect(page.elements["status-line"].textContent).toBe("The server is busy (503). Retrying…");
      expect(statusLine(page)?.[0]).toBe("bob: reading Linear");
    });

    it("gives a person in the pair no line, and a name no longer listed none", async () => {
      registerAgent(db, OWNER_ACCOUNT, "bob", "x");
      addPerson(db, "owner", "colin");
      sendMessage(db, OWNER_ACCOUNT, "colin", "bob", "hi");
      setLine("bob", "reading Linear");
      const page = await load(viewer);
      const pairs = page.elements["pair-rows"];
      await page.until(() => page.scheduled() && pairs.children.length === 1);
      open(pairs.children[0]);
      expect(page.elements["log-title"].textContent).toBe("bob ↔ colin");
      expect(statusLine(page)?.[0]).toBe("bob: reading Linear");
      await page.until(page.scheduled);

      // bob goes from GET /api/agents, so his line goes with him.
      removeAgent(db, OWNER_ACCOUNT, "bob", undefined, identityOf(db, OWNER_ACCOUNT, "bob")!);
      await pollOnce(page);
      expect(statusLine(page)).toBeUndefined();
    });

    it("clears the line when a channel or the webhook deliveries open, the log closes or the token goes, and leaves a channel's members line as it was", async () => {
      for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
      joinChannel(db, OWNER_ACCOUNT, { ...identityOf(db, OWNER_ACCOUNT, "alice")!, name: "alice" }, "build");
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "hi");
      setLine("alice", "reading Linear");
      const page = await load(viewer);
      const pairs = page.elements["pair-rows"];
      const channels = page.elements["channel-rows"];
      await page.until(() => page.scheduled() && pairs.children.length === 1 && channels.children.length === 1);
      const reopen = () => {
        open(pairs.children[0]);
        expect(statusLine(page)?.[0]).toBe("alice: reading Linear");
      };

      reopen();
      open(channels.children[0]);
      expect(statusLine(page)).toBeUndefined();
      await page.until(() => !page.elements["log-members"].hidden && page.scheduled());
      expect(page.elements["log-members"].textContent).toBe("Members: alice");
      // A poll with the channel open brings no status line, though alice still has one.
      await pollOnce(page);
      expect(statusLine(page)).toBeUndefined();
      expect(page.elements["log-members"].textContent).toBe("Members: alice");

      reopen();
      open(page.elements["delivery-entry"].children[0]);
      expect(statusLine(page)).toBeUndefined();

      reopen();
      page.elements["close-log"].on.click();
      expect(statusLine(page)).toBeUndefined();
      expect(page.elements["log-status"].textContent).toBe("");

      reopen();
      page.elements["forget"].on.click();
      expect(statusLine(page)).toBeUndefined();
      expect(page.elements["log-status"].textContent).toBe("");
      expect(page.elements["log-status"].title).toBe("");
    });
  });

  describe("unread badges", () => {
    // Each sidebar entry's badge, by label.
    const badges = (rows: Stub) => Object.fromEntries(rows.children.map(item));
    const setup = () => {
      for (const name of ["alice", "bob", "carol"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
      const alice = { ...identityOf(db, OWNER_ACCOUNT, "alice")!, name: "alice" };
      post(db, OWNER_ACCOUNT, alice, "build", "one");
      post(db, OWNER_ACCOUNT, alice, "ops", "one");
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "one");
      sendMessage(db, OWNER_ACCOUNT, "alice", "carol", "one");
      return alice;
    };
    // Runs a poll and waits for it to finish, so the sidebar shows what it read.
    const pollOnce = async (page: Awaited<ReturnType<typeof load>>) => {
      await page.poll();
      await page.until(page.scheduled);
    };

    it("shows none on a first load, then counts what arrives in a closed conversation", async () => {
      const alice = setup();
      const page = await load(viewer);
      const channels = page.elements["channel-rows"];
      const pairs = page.elements["pair-rows"];
      await page.until(() => page.scheduled() && pairs.children.length === 2);
      expect(badges(channels)).toEqual({ build: "", ops: "" });
      expect(badges(pairs)).toEqual({ "alice ↔ carol": "", "alice ↔ bob": "" });

      post(db, OWNER_ACCOUNT, alice, "ops", "two");
      sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "two");
      await pollOnce(page);
      expect(badges(channels)).toEqual({ build: "", ops: "1" });
      expect(badges(pairs)).toEqual({ "alice ↔ bob": "1", "alice ↔ carol": "" });
      post(db, OWNER_ACCOUNT, alice, "ops", "three");
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "three");
      await pollOnce(page);
      expect(badges(channels)).toEqual({ build: "", ops: "2" });
      expect(badges(pairs)).toEqual({ "alice ↔ bob": "2", "alice ↔ carol": "" });
      // The totals stay in the tooltips.
      expect(tip(channels.children[1])).toMatch(/; 3 posts, /);
      expect(tip(pairs.children[0])).toBe("3 messages");

      // Opening a conversation clears its badge, and what arrives while it is open shows none.
      open(channels.children[1]);
      expect(badges(channels)).toEqual({ build: "", ops: "" });
      await page.until(() => page.elements["post-rows"].children.length === 3);
      await page.until(page.scheduled);
      post(db, OWNER_ACCOUNT, alice, "ops", "four");
      await pollOnce(page);
      expect(badges(channels)).toEqual({ build: "", ops: "" });

      open(pairs.children[0]);
      expect(badges(pairs)).toEqual({ "alice ↔ bob": "", "alice ↔ carol": "" });
      await page.until(page.scheduled);
      sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "four");
      await pollOnce(page);
      expect(badges(pairs)).toEqual({ "alice ↔ bob": "", "alice ↔ carol": "" });
      // The channel left behind counts again from what it had when it was left.
      post(db, OWNER_ACCOUNT, alice, "ops", "five");
      await pollOnce(page);
      expect(badges(channels)).toEqual({ build: "", ops: "1" });
      // Nothing the page did marked anything read for an agent.
      expect(unreadSummary(db, OWNER_ACCOUNT, "bob")!.count).toBe(2);
    });

    it("counts every post of a channel and every message of a pair that first appear after the first poll", async () => {
      const alice = setup();
      const page = await load(viewer);
      const channels = page.elements["channel-rows"];
      const pairs = page.elements["pair-rows"];
      await page.until(() => page.scheduled() && pairs.children.length === 2);
      post(db, OWNER_ACCOUNT, alice, "new", "one");
      post(db, OWNER_ACCOUNT, alice, "new", "two");
      sendMessage(db, OWNER_ACCOUNT, "bob", "carol", "one");
      await pollOnce(page);
      expect(badges(channels)).toEqual({ build: "", new: "2", ops: "" });
      expect(badges(pairs)["bob ↔ carol"]).toBe("1");
    });

    it("shows none until a poll has read every message", async () => {
      const alice = setup();
      let busy = true;
      const page = await load(viewer, (url) => (busy && url.startsWith("/api/messages") ? 503 : undefined));
      const channels = page.elements["channel-rows"];
      await page.until(() => page.scheduled() && channels.children.length === 2);
      post(db, OWNER_ACCOUNT, alice, "ops", "two");
      await pollOnce(page);
      expect(badges(channels)).toEqual({ build: "", ops: "" });
      busy = false;
      post(db, OWNER_ACCOUNT, alice, "ops", "three");
      await pollOnce(page);
      // That poll was the first to read every message, so what it read counts as seen.
      expect(badges(channels)).toEqual({ build: "", ops: "" });
      post(db, OWNER_ACCOUNT, alice, "ops", "four");
      await pollOnce(page);
      expect(badges(channels)).toEqual({ build: "", ops: "1" });
    });

    it("keeps a post the open log showed as seen when the first poll that reads every message sets the baseline", async () => {
      const alice = setup();
      let busy = true;
      let late = false;
      const page = await load(viewer, (url) => {
        if (busy && url.startsWith("/api/messages")) return 503;
        // A post that lands after GET /api/channels answered and before the open log is read.
        if (late && url.startsWith("/api/channel-posts")) {
          late = false;
          post(db, OWNER_ACCOUNT, alice, "ops", "late");
        }
        return undefined;
      });
      const channels = page.elements["channel-rows"];
      await page.until(() => page.scheduled() && channels.children.length === 2);
      open(channels.children[1]);
      await page.until(() => page.elements["post-rows"].children.length === 1);
      await page.until(page.scheduled);
      busy = false;
      late = true;
      await pollOnce(page);
      expect(page.elements["post-rows"].children).toHaveLength(2);
      open(channels.children[0]);
      await page.until(page.scheduled);
      await pollOnce(page);
      expect(badges(channels)).toEqual({ build: "", ops: "" });
    });

    it("shows none on a pair started from New message", async () => {
      setup();
      addPerson(db, "owner", "colin");
      const page = await load(addToken(db, "owner", false, false, undefined, "colin").token);
      const pairs = page.elements["pair-rows"];
      await page.until(() => page.scheduled() && pairs.children.length === 2 && !page.elements["new-message"].hidden);
      page.elements["new-message"].on.click();
      page.elements["new-from"].value = "colin";
      (page.elements["new-from"].on as Record<string, () => void>).change();
      page.elements["new-to"].value = "bob";
      (page.elements["new-form"].on as Record<string, (event: unknown) => void>).submit({ preventDefault() {} });
      expect(item(pairs.children[0])).toEqual(["bob ↔ colin", ""]);
      expect(tip(pairs.children[0])).toBe("0 messages");
      // Left for another conversation, it still has nothing unread.
      open(pairs.children[1]);
      await page.until(page.scheduled);
      await pollOnce(page);
      expect(item(pairs.children[0])).toEqual(["bob ↔ colin", ""]);
    });

    it("marks the open entry with item current and aria-current, and no other", async () => {
      setup();
      const page = await load(viewer);
      const channels = page.elements["channel-rows"];
      const pairs = page.elements["pair-rows"];
      await page.until(() => page.scheduled() && pairs.children.length === 2);
      const marks = () =>
        [...channels.children, ...pairs.children].map((row) => {
          const button = row.children[0] as Stub & { ariaCurrent?: string | null };
          return [item(row)[0], button.className, button.ariaCurrent ?? null];
        });
      open(channels.children[1]);
      expect(marks()).toEqual([
        ["build", "item", null],
        ["ops", "item current", "true"],
        ["alice ↔ carol", "item", null],
        ["alice ↔ bob", "item", null],
      ]);
      open(pairs.children[1]);
      expect(marks()).toEqual([
        ["build", "item", null],
        ["ops", "item", null],
        ["alice ↔ carol", "item", null],
        ["alice ↔ bob", "item current", "true"],
      ]);
      // A poll that redraws the sidebar keeps the mark.
      await page.until(page.scheduled);
      await pollOnce(page);
      expect(marks().filter((m) => m[2] === "true").map((m) => m[0])).toEqual(["alice ↔ bob"]);
    });

    it("forgets what was seen with the token, so the next token shows no badges", async () => {
      const alice = setup();
      const page = await load(viewer);
      const channels = page.elements["channel-rows"];
      const pairs = page.elements["pair-rows"];
      await page.until(() => page.scheduled() && pairs.children.length === 2);
      post(db, OWNER_ACCOUNT, alice, "ops", "two");
      sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "two");
      await pollOnce(page);
      expect(badges(channels).ops).toBe("1");

      page.elements["forget"].on.click();
      expect(channels.children).toHaveLength(0);
      page.elements["token"].value = addToken(db, "owner", true).token;
      page.elements["login"].on.submit({ preventDefault() {} } as never);
      await page.until(() => page.scheduled() && pairs.children.length === 2);
      expect(badges(channels)).toEqual({ build: "", ops: "" });
      expect(badges(pairs)).toEqual({ "alice ↔ bob": "", "alice ↔ carol": "" });
    });
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
      await page.poll();
      await page.until(() => log.children.length === 7);
      expect(grouped(log).slice(-2)).toEqual([
        ["bob", false],
        ["alice", false],
      ]);
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "again");
      await page.poll();
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
      await page.poll();
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
      await page.poll();
      await page.until(() => avatar(log.children[1]).className === "avatar person");
      expect(marks()).toEqual([
        ["alice", "avatar", undefined, "hi"],
        ["bob", "avatar person", "person", "hello"],
      ]);
      // And a sender no longer given as a person goes back to an agent's avatar.
      people = ["alice"];
      await page.until(page.scheduled);
      await page.poll();
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
      await page.poll();
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
      await page.poll();
      await page.until(() => time(2).textContent === "12m ago");
      expect([time(0).textContent, time(1).textContent]).toEqual(["unchanged", "unchanged"]);
      // Past midnight, this morning's time becomes a date; the one days ago is never written again.
      now += 30 * MIN;
      await page.until(page.scheduled);
      await page.poll();
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
      await page.poll();
      await page.until(page.scheduled);
      expect(time().textContent).toBe("unchanged");
      now += 20 * MIN;
      await page.poll();
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

    it("marks the token's person's own mentions, without case, in the log and in entries that arrive later", async () => {
      registerAgent(db, OWNER_ACCOUNT, "bob", "x");
      addPerson(db, "owner", "colin");
      addPerson(db, "owner", "dana");
      const bob = { ...identityOf(db, OWNER_ACCOUNT, "bob")!, name: "bob" };
      post(db, OWNER_ACCOUNT, bob, "build", "@Colin and @dana, see @bob");
      const page = await load(addToken(db, "owner", false, false, undefined, "colin").token);
      await page.until(() => page.elements["channel-rows"].children.length === 1 && page.scheduled());
      open(page.elements["channel-rows"].children[0]);
      const log = page.elements["post-rows"];
      await page.until(() => log.children.length === 1 && mentions(log.children[0])[0][1] === "mention me");
      const row = log.children[0];
      // Compared without case.
      expect(mentions(row)).toEqual([
        ["@Colin", "mention me"],
        ["@dana", "mention"],
        ["@bob", "mention"],
      ]);
      // An entry that arrives later is marked as it is made.
      post(db, OWNER_ACCOUNT, bob, "build", "@colin again");
      await page.poll();
      await page.until(() => log.children.length === 2);
      expect(mentions(log.children[1])).toEqual([["@colin", "mention me"]]);
      expect(log.children[0]).toBe(row);
    });

    it("marks no mention as the reader's with a read-only or full token", async () => {
      registerAgent(db, OWNER_ACCOUNT, "bob", "x");
      addPerson(db, "owner", "colin");
      post(db, OWNER_ACCOUNT, { ...identityOf(db, OWNER_ACCOUNT, "bob")!, name: "bob" }, "build", "@colin");
      for (const token of [viewer, OWNER_TOKEN]) {
        const page = await load(token);
        await page.until(() => page.elements["channel-rows"].children.length === 1 && page.scheduled());
        open(page.elements["channel-rows"].children[0]);
        const log = page.elements["post-rows"];
        await page.until(() => log.children.length === 1);
        expect(mentions(log.children[0])).toEqual([["@colin", "mention"]]);
      }
    });

    it("highlights mentions in search results, and the token's person's own there too", async () => {
      for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
      addPerson(db, "owner", "colin");
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "deploy @bob <i>now</i>");
      post(db, OWNER_ACCOUNT, { ...identityOf(db, OWNER_ACCOUNT, "alice")!, name: "alice" }, "build", "deploy, @colin");
      const page = await load(addToken(db, "owner", false, false, undefined, "colin").token);
      await page.until(() => page.elements["channel-rows"].children.length === 1 && page.scheduled());
      page.elements["search-text"].value = "deploy";
      page.elements["search"].on.submit({ preventDefault() {} } as never);
      const found = page.elements["result-rows"];
      await page.until(() => found.children.length === 2);
      expect(found.children.map((r) => field(r, "body")).sort()).toEqual(["deploy @bob <i>now</i>", "deploy, @colin"]);
      expect(found.children.flatMap(mentions).sort()).toEqual([
        ["@bob", "mention"],
        ["@colin", "mention me"],
      ]);
    });

    // A row's body as its pieces: a link as its tag, text, href, target and rel, anything else as its tag, text and classes.
    const pieces = (row: Stub) =>
      row.children
        .find((c) => c.className === "body")!
        .children.map((c) => {
          const a = c as Stub & { href?: string; target?: string; rel?: string };
          return c.tagName === "A" ? ["A", c.textContent, a.href, a.target, a.rel] : [c.tagName, c.textContent, c.className];
        });
    const link = (address: string) => ["A", address, address, "_blank", "noopener noreferrer"];
    const plain = (text: string) => ["SPAN", text, ""];
    // Posts each body in #build as bob, opens the channel and returns its log once every body is shown.
    const postAll = async (token: string, ...bodies: string[]) => {
      registerAgent(db, OWNER_ACCOUNT, "bob", "x");
      const bob = { ...identityOf(db, OWNER_ACCOUNT, "bob")!, name: "bob" };
      for (const body of bodies) post(db, OWNER_ACCOUNT, bob, "build", body);
      const page = await load(token);
      await page.until(() => page.elements["channel-rows"].children.length === 1);
      open(page.elements["channel-rows"].children[0]);
      const log = page.elements["post-rows"];
      await page.until(() => log.children.length === bodies.length);
      return { page, log };
    };

    it("makes each http:// and https:// address in an entry's text a link that opens in a new tab, and keeps the text as it was", async () => {
      const bodies = ["see https://example.com/a.", "(https://example.com/b) and http://127.0.0.1:8787/x?y=1#z", "https://github.com/o/r/pull/85"];
      const { log } = await postAll(viewer, ...bodies);
      expect(entries(log).map(([, body]) => body)).toEqual(bodies);
      expect(pieces(log.children[0])).toEqual([plain("see "), link("https://example.com/a"), plain(".")]);
      expect(pieces(log.children[1])).toEqual([
        plain("("),
        link("https://example.com/b"),
        plain(") and "),
        link("http://127.0.0.1:8787/x?y=1#z"),
      ]);
      expect(pieces(log.children[2])).toEqual([link("https://github.com/o/r/pull/85")]);
      expect(log.children.flatMap((row) => row.children.find((c) => c.className === "body")!.children).every((c) => c.children.length === 0)).toBe(true);
    });

    it("links nothing but an http:// or https:// address with something after the scheme", async () => {
      const bodies = [
        "javascript:alert(1)",
        "data:text/html,<b>x</b>",
        "ftp://example.com/f",
        "www.example.com",
        "a bare https:// here",
        "https://.",
        'javascript:alert("https://x")',
        "mailto:bob@example.com",
      ];
      const { log } = await postAll(viewer, ...bodies);
      expect(entries(log).map(([, body]) => body)).toEqual(bodies);
      // Only the address inside the javascript: text is a link, and its href is only that address.
      expect(log.children.map((row) => pieces(row).filter(([tag]) => tag === "A"))).toEqual([[], [], [], [], [], [], [link("https://x")], []]);
      for (const row of log.children.slice(0, 6)) expect(row.children.find((c) => c.className === "body")!.children).toEqual([]);
    });

    it("leaves trailing punctuation out of a link, and keeps a ) that closes a ( in the address", async () => {
      const ends = [".", ",", ";", ":", "!", "?", ")", "]", "}", "'", '"', ".)", '!"'];
      const bodies = [...ends.map((end) => `https://example.com/a${end}`), "https://en.wikipedia.org/wiki/Foo_(bar).", "(see https://en.wikipedia.org/wiki/Foo_(bar))"];
      const { log } = await postAll(viewer, ...bodies);
      expect(entries(log).map(([, body]) => body)).toEqual(bodies);
      ends.forEach((end, i) => expect(pieces(log.children[i])).toEqual([link("https://example.com/a"), plain(end)]));
      expect(pieces(log.children[ends.length])).toEqual([link("https://en.wikipedia.org/wiki/Foo_(bar)"), plain(".")]);
      expect(pieces(log.children[ends.length + 1])).toEqual([plain("(see "), link("https://en.wikipedia.org/wiki/Foo_(bar)"), plain(")")]);
    });

    it("keeps @name outside an address a mention, marked for the token's person, and an @ inside an address part of the link", async () => {
      addPerson(db, "owner", "colin");
      const body = "@colin see https://example.com/@colin, @bob";
      const { page, log } = await postAll(addToken(db, "owner", false, false, undefined, "colin").token, body);
      await page.until(() => mentions(log.children[0])[0][1] === "mention me");
      const row = log.children[0];
      expect(entries(log)).toEqual([["bob", body]]);
      expect(pieces(row)).toEqual([
        ["SPAN", "@colin", "mention me"],
        plain(" see "),
        link("https://example.com/@colin"),
        plain(", "),
        ["SPAN", "@bob", "mention"],
      ]);
      expect(mentions(row)).toEqual([
        ["@colin", "mention me"],
        ["@bob", "mention"],
      ]);
    });

    it("links addresses in a direct conversation and in search results too", async () => {
      for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "deploy https://example.com/pr/1.");
      const page = await load(viewer);
      const pairs = page.elements["pair-rows"];
      await page.until(() => pairs.children.length === 1);
      open(pairs.children[0]);
      const log = page.elements["post-rows"];
      await page.until(() => log.children.length === 1);
      expect(pieces(log.children[0])).toEqual([plain("deploy "), link("https://example.com/pr/1"), plain(".")]);
      page.elements["search-text"].value = "deploy";
      page.elements["search"].on.submit({ preventDefault() {} } as never);
      const found = page.elements["result-rows"];
      await page.until(() => found.children.length === 1);
      expect(pieces(found.children[0])).toEqual([plain("deploy "), link("https://example.com/pr/1"), plain(".")]);
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

  describe("read receipts", () => {
    const receipt = (row: Stub) => field(row, "receipt");
    const receiptNode = (row: Stub) => row.children.find((c) => c.className === "receipt");

    it("shows under each message to an agent whether it has been read, and turns it to read on a later poll in place", async () => {
      for (const name of ["alice", "bob", "carol"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "read already");
      readInbox(db, OWNER_ACCOUNT, "bob");
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "not yet");
      sendMessage(db, OWNER_ACCOUNT, "bob", "all", "to everyone");
      const page = await load(viewer);
      const pairs = page.elements["pair-rows"];
      const log = page.elements["post-rows"];
      await page.until(() => pairs.children.length === 2);
      open(pairs.children.find((row) => item(row)[0] === "alice ↔ bob")!);
      expect(log.children.map((row) => [field(row, "body"), receipt(row)])).toEqual([
        ["read already", "read"],
        ["not yet", "not read yet"],
        ["to everyone", "not read yet"],
      ]);
      // The receipt comes after the time.
      const names = log.children[0].children.map((c) => c.className);
      expect(names.indexOf("receipt")).toBe(names.indexOf("time") + 1);
      const rows = [...log.children];
      const nodes = rows.map(receiptNode);

      // bob reads his inbox between polls: his messages turn to read, alice's copy of the broadcast stays unread, and
      // the rows are the same elements, updated in place.
      readInbox(db, OWNER_ACCOUNT, "bob");
      await page.poll();
      await page.until(() => receipt(log.children[1]) === "read");
      expect(log.children.map((row) => [field(row, "body"), receipt(row)])).toEqual([
        ["read already", "read"],
        ["not yet", "read"],
        ["to everyone", "not read yet"],
      ]);
      expect(log.children).toEqual(rows);
      expect(log.children.map(receiptNode)).toEqual(nodes);
      readInbox(db, OWNER_ACCOUNT, "alice");
      await page.poll();
      await page.until(() => receipt(log.children[2]) === "read");
      // Nothing the page did marked a message read: carol's copy of the broadcast is still unread.
      expect(unreadSummary(db, OWNER_ACCOUNT, "carol")!.count).toBe(1);

      // A reopened log shows what the page has learned, and no receipt turns back to "not read yet".
      open(pairs.children.find((row) => item(row)[0] === "bob ↔ carol")!);
      expect(log.children.map((row) => [field(row, "body"), receipt(row)])).toEqual([["to everyone", "not read yet"]]);
      open(pairs.children.find((row) => item(row)[0] === "alice ↔ bob")!);
      await page.poll();
      await page.until(() => page.scheduled());
      expect(log.children.map(receipt)).toEqual(["read", "read", "read"]);
    });

    it("leaves the row after a page boundary as it was when a message is read between the pages", async () => {
      for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
      for (let i = 0; i < 201; i++) sendMessage(db, OWNER_ACCOUNT, "alice", "bob", `message ${i}`);
      let between = false;
      // bob reads his oldest message after the first page of the unread read, so the last unread message moves onto
      // the first page's offsets and the second page, read at offset 200, misses it.
      const page = await load(viewer, (url) => {
        if (between && url === "/api/messages?unread=true&limit=200&offset=200") {
          between = false;
          readInbox(db, OWNER_ACCOUNT, "bob", true, 1);
        }
        return undefined;
      });
      const pairs = page.elements["pair-rows"];
      const log = page.elements["post-rows"];
      await page.until(() => pairs.children.length === 1 && tip(pairs.children[0]) === "201 messages" && page.scheduled());
      open(pairs.children[0]);
      expect(new Set(log.children.map(receipt))).toEqual(new Set(["not read yet"]));
      // Opening the pair polls at once; let that poll end first.
      await page.until(() => page.scheduled());
      between = true;
      await page.poll();
      await page.until(() => !between && page.scheduled());
      // The missed message is not taken for read, and the one read, asked about before it was, is not yet shown read.
      expect([receipt(log.children[0]), receipt(log.children[200])]).toEqual(["not read yet", "not read yet"]);
      await page.poll();
      await page.until(() => receipt(log.children[0]) === "read" && page.scheduled());
      expect(log.children.slice(1).filter((row) => receipt(row) === "read")).toHaveLength(0);
    });

    it("asks nothing about receipts while no message the page holds to an agent is unread", async () => {
      registerAgent(db, OWNER_ACCOUNT, "bob", "x");
      addPerson(db, "owner", "colin");
      sendMessage(db, OWNER_ACCOUNT, "bob", "colin", "to a person");
      sendMessage(db, OWNER_ACCOUNT, "colin", "bob", "to bob");
      readInbox(db, OWNER_ACCOUNT, "bob");
      const page = await load(viewer);
      await page.until(() => page.elements["pair-rows"].children.length === 1 && page.scheduled());
      await page.poll();
      await page.until(() => page.scheduled());
      expect(page.urls.filter((url) => url.includes("unread="))).toEqual([]);
      // A new message to an agent starts the asking again, from the poll after the one that brings it in.
      sendMessage(db, OWNER_ACCOUNT, "colin", "bob", "again");
      await page.poll();
      await page.until(() => page.scheduled());
      expect(page.urls.filter((url) => url.includes("unread="))).toEqual([]);
      await page.poll();
      await page.until(() => page.urls.some((url) => url.includes("unread=true")));
    });

    it("changes no receipt when the unread read fails, and asks for another token when it is refused", async () => {
      for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "one");
      let answer: number | undefined;
      const page = await load(viewer, (url) => (url.startsWith("/api/messages?unread") ? answer : undefined));
      const pairs = page.elements["pair-rows"];
      const log = page.elements["post-rows"];
      await page.until(() => pairs.children.length === 1);
      open(pairs.children[0]);
      expect(log.children.map(receipt)).toEqual(["not read yet"]);
      readInbox(db, OWNER_ACCOUNT, "bob");
      answer = 503;
      await page.poll();
      await page.until(() => page.elements["status-line"].textContent !== "" && page.scheduled());
      expect(log.children.map(receipt)).toEqual(["not read yet"]);
      answer = 401;
      await page.poll();
      await page.until(() => page.store.size === 0);
      expect(pairs.children).toHaveLength(0);
      expect(log.children).toHaveLength(0);
    });

    it("shows no receipt on a message to a person, and keeps one on a row re-marked when its sender becomes a person", async () => {
      registerAgent(db, OWNER_ACCOUNT, "bob", "x");
      addPerson(db, "owner", "colin");
      sendMessage(db, OWNER_ACCOUNT, "bob", "colin", "to a person");
      sendMessage(db, OWNER_ACCOUNT, "colin", "bob", "to an agent");
      const page = await load(viewer);
      const pairs = page.elements["pair-rows"];
      const log = page.elements["post-rows"];
      await page.until(() => pairs.children.length === 1 && page.elements["rows"].children.length === 2);
      await page.poll();
      await page.until(() => page.scheduled());
      open(pairs.children[0]);
      expect(log.children.map((row) => [field(row, "body"), receipt(row)])).toEqual([
        ["to a person", undefined],
        ["to an agent", "not read yet"],
      ]);

      // dana sent to bob before she was a person; once she is one her row is rebuilt and keeps its receipt.
      sendMessage(db, OWNER_ACCOUNT, "dana", "bob", "before dana was a person");
      await page.poll();
      await page.until(() => pairs.children.length === 2 && page.scheduled());
      open(pairs.children.find((row) => item(row)[0] === "bob ↔ dana")!);
      expect(log.children.map((row) => [field(row, "kind"), receipt(row)])).toEqual([[undefined, "not read yet"]]);
      addPerson(db, "owner", "dana");
      await page.poll();
      await page.until(() => field(log.children[0], "kind") === "person" && page.scheduled());
      expect(receipt(log.children[0])).toBe("not read yet");
    });

    it("never takes a message to a person added during a poll for read", async () => {
      for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "keeps the receipts asking");
      let during = false;
      // erin becomes a person, and is sent a message, after this poll has read the agents and before it reads the
      // messages, so the page still takes erin for no one in particular while ?unread=true already leaves her out.
      const page = await load(viewer, (url) => {
        if (during && url.startsWith("/api/channels")) {
          during = false;
          addPerson(db, "owner", "erin");
          sendMessage(db, OWNER_ACCOUNT, "bob", "erin", "to a new person");
        }
        return undefined;
      });
      const pairs = page.elements["pair-rows"];
      const log = page.elements["post-rows"];
      await page.until(() => pairs.children.length === 1 && page.scheduled());
      during = true;
      await page.poll();
      await page.until(() => !during && pairs.children.length === 2 && page.scheduled());
      expect(page.urls.some((url) => url.startsWith("/api/messages?unread=true"))).toBe(true);
      open(pairs.children.find((row) => item(row)[0] === "bob ↔ erin")!);
      expect(log.children.map((row) => [field(row, "body"), receipt(row)])).toEqual([["to a new person", "not read yet"]]);
      // The next poll lists erin as a person, so the row shows no receipt at all.
      await page.poll();
      await page.until(() => receipt(log.children[0]) === undefined && page.scheduled());
    });

    // Marks every queued webhook delivery as taken by its receiver (a 2xx); in these tests only bob has a webhook.
    const deliver = () => db.prepare("UPDATE webhook_deliveries SET attempts = 1, delivered_at = ?").run(Date.now());

    it("turns a held unread message to starting… once a webhook delivered it, and then to read, in place", async () => {
      for (const name of ["alice", "bob", "carol"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
      // Port 1 on loopback refuses at once, so the server's own pass never delivers anything.
      addWebhook(db, "owner", "http://127.0.0.1:1/hook", "agent:bob", true);
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "wakes bob");
      sendMessage(db, OWNER_ACCOUNT, "alice", "carol", "no webhook");
      const page = await load(viewer);
      const pairs = page.elements["pair-rows"];
      const log = page.elements["post-rows"];
      await page.until(() => pairs.children.length === 2);
      open(pairs.children.find((row) => item(row)[0] === "alice ↔ bob")!);
      await page.until(() => page.scheduled());
      expect(log.children.map(receipt)).toEqual(["not read yet"]);
      const node = receiptNode(log.children[0]);

      deliver();
      await page.poll();
      await page.until(() => receipt(log.children[0]) === "starting…" && page.scheduled());
      expect(receiptNode(log.children[0])).toBe(node);
      // Nothing the page did marked the message read.
      expect(unreadSummary(db, OWNER_ACCOUNT, "bob")!.count).toBe(1);

      readInbox(db, OWNER_ACCOUNT, "bob");
      await page.poll();
      await page.until(() => receipt(log.children[0]) === "read" && page.scheduled());
      expect(receiptNode(log.children[0])).toBe(node);
      // A later poll never turns it back.
      await page.poll();
      await page.until(() => page.scheduled());
      expect(log.children.map(receipt)).toEqual(["read"]);

      open(pairs.children.find((row) => item(row)[0] === "alice ↔ carol")!);
      expect(log.children.map(receipt)).toEqual(["not read yet"]);
    });

    it("shows starting… at once for a message already delivered when the page loads, and none to a person", async () => {
      registerAgent(db, OWNER_ACCOUNT, "bob", "x");
      addPerson(db, "owner", "colin");
      addWebhook(db, "owner", "http://127.0.0.1:1/hook", "agent:bob", true);
      addWebhook(db, "owner", "http://127.0.0.1:1/hook", "agent:colin", true);
      sendMessage(db, OWNER_ACCOUNT, "colin", "bob", "to bob");
      sendMessage(db, OWNER_ACCOUNT, "bob", "colin", "to colin");
      deliver();
      const page = await load(viewer);
      const pairs = page.elements["pair-rows"];
      const log = page.elements["post-rows"];
      await page.until(() => pairs.children.length === 1 && page.elements["rows"].children.length === 2);
      open(pairs.children[0]);
      expect(log.children.map((row) => [field(row, "body"), receipt(row)])).toEqual([
        ["to bob", "starting…"],
        ["to colin", undefined],
      ]);
    });

    it("shows no starting… without a delivered delivery, and keeps starting… once the server stops saying it", async () => {
      for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
      const hook = addWebhook(db, "owner", "http://127.0.0.1:1/hook", "agent:bob", true);
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "pending");
      const page = await load(viewer);
      const pairs = page.elements["pair-rows"];
      const log = page.elements["post-rows"];
      await page.until(() => pairs.children.length === 1);
      open(pairs.children[0]);
      await page.until(() => page.scheduled());
      await page.poll();
      await page.until(() => page.scheduled());
      expect(page.urls.some((url) => url.startsWith("/api/messages?unread=true"))).toBe(true);
      expect(log.children.map(receipt)).toEqual(["not read yet"]);

      deliver();
      await page.poll();
      await page.until(() => receipt(log.children[0]) === "starting…" && page.scheduled());
      // Removing the webhook takes its deliveries with it, so the server answers starting: false; the receipt stays.
      db.prepare("DELETE FROM webhooks WHERE id = ?").run(hook.id);
      const asked = page.urls.length;
      await page.poll();
      await page.until(() => page.scheduled());
      expect(page.urls.slice(asked).some((url) => url.startsWith("/api/messages?unread=true"))).toBe(true);
      expect(log.children.map(receipt)).toEqual(["starting…"]);
    });

    it("never shows a receipt on a channel post", async () => {
      registerAgent(db, OWNER_ACCOUNT, "alice", "x");
      post(db, OWNER_ACCOUNT, { ...identityOf(db, OWNER_ACCOUNT, "alice")!, name: "alice" }, "build", "hello");
      const page = await load(viewer);
      const log = page.elements["post-rows"];
      await page.until(() => page.elements["channel-rows"].children.length === 1);
      open(page.elements["channel-rows"].children[0]);
      await page.until(() => log.children.length === 1);
      expect(receipt(log.children[0])).toBeUndefined();
    });
  });

  describe("mention receipts", () => {
    const receipt = (row: Stub) => field(row, "receipt mentions");
    const receiptNode = (row: Stub) => row.children.find((c) => c.className === "receipt mentions");
    const member = (name: string) => ({ ...identityOf(db, OWNER_ACCOUNT, name)!, name });

    it("shows after a post's time whether each agent it mentions has read it, and turns a part to read on a later poll in place", async () => {
      for (const name of ["alice", "bob", "carol"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
      addPerson(db, "owner", "colin");
      post(db, OWNER_ACCOUNT, member("alice"), "build", "no mention here");
      post(db, OWNER_ACCOUNT, member("alice"), "build", "@carol @bob @colin please look");
      const page = await load(viewer);
      const log = page.elements["post-rows"];
      await page.until(() => page.elements["channel-rows"].children.length === 1);
      open(page.elements["channel-rows"].children[0]);
      await page.until(() => log.children.length === 2 && page.scheduled());
      // In name order, the person left out; no receipt on a post without a mentioned agent.
      expect(log.children.map((row) => [field(row, "body"), receipt(row)])).toEqual([
        ["no mention here", undefined],
        ["@carol @bob @colin please look", "bob: not read yet · carol: not read yet"],
      ]);
      const names = log.children[1].children.map((c) => c.className);
      expect(names.indexOf("receipt mentions")).toBe(names.indexOf("time") + 1);
      const rows = [...log.children];
      const node = receiptNode(log.children[1]);

      // bob reads his inbox between polls: only his part turns to read, on the same elements.
      readInbox(db, OWNER_ACCOUNT, "bob");
      await page.poll();
      await page.until(() => receipt(log.children[1]) === "bob: read · carol: not read yet" && page.scheduled());
      expect(log.children).toEqual(rows);
      expect(receiptNode(log.children[1])).toBe(node);
      expect(page.urls).toContain("/api/channel-posts?channel=build&unread=true&limit=200&offset=0");
      // Nothing the page did marked carol's mention read.
      expect(unreadSummary(db, OWNER_ACCOUNT, "carol")!.mentions).toBe(1);
      readInbox(db, OWNER_ACCOUNT, "carol");
      await page.poll();
      await page.until(() => receipt(log.children[1]) === "bob: read · carol: read" && page.scheduled());

      // With every mention read there is nothing to ask, and no part turns back.
      const asked = page.urls.filter((url) => url.includes("unread=true")).length;
      await page.poll();
      await page.until(() => page.scheduled());
      expect(page.urls.filter((url) => url.includes("unread=true"))).toHaveLength(asked);
      expect(receipt(log.children[1])).toBe("bob: read · carol: read");
    });

    it("changes no receipt when the unread read fails or finds the channel gone, and asks for another token on 401", async () => {
      for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
      post(db, OWNER_ACCOUNT, member("alice"), "build", "@bob one");
      post(db, OWNER_ACCOUNT, member("alice"), "ops", "elsewhere");
      let answer: number | undefined;
      const page = await load(viewer, (url) => (url.includes("unread=true") ? answer : undefined));
      const channels = page.elements["channel-rows"];
      const log = page.elements["post-rows"];
      await page.until(() => channels.children.length === 2);
      open(channels.children[0]);
      await page.until(() => log.children.length === 1 && page.scheduled());
      readInbox(db, OWNER_ACCOUNT, "bob");
      for (const status of [503, 404]) {
        answer = status;
        await page.poll();
        await page.until(() => page.scheduled());
        expect(log.children.map(receipt)).toEqual(["bob: not read yet"]);
      }
      answer = 401;
      await page.poll();
      await page.until(() => page.store.size === 0);
      expect(log.children).toHaveLength(0);
    });

    it("leaves another channel's log alone when the unread read answers after it opened", async () => {
      for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
      post(db, OWNER_ACCOUNT, member("alice"), "build", "@bob one");
      post(db, OWNER_ACCOUNT, member("alice"), "ops", "elsewhere");
      let during = false;
      let page: Awaited<ReturnType<typeof load>>;
      // ops opens while build's unread read is in flight.
      page = await load(viewer, (url) => {
        if (during && url.includes("unread=true")) {
          during = false;
          open(page.elements["channel-rows"].children[1]);
        }
        return undefined;
      });
      const channels = page.elements["channel-rows"];
      const log = page.elements["post-rows"];
      await page.until(() => channels.children.length === 2);
      open(channels.children[0]);
      await page.until(() => log.children.length === 1 && page.scheduled());
      during = true;
      await page.poll();
      await page.until(() => !during && page.elements["log-title"].textContent === "ops" && log.children.length === 1 && page.scheduled());
      expect(log.children.map((row) => [field(row, "body"), receipt(row)])).toEqual([["elsewhere", undefined]]);
    });

    it("leaves the post after a page boundary as it was when a mention is read between the pages", async () => {
      for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
      for (let i = 0; i < 201; i++) post(db, OWNER_ACCOUNT, member("alice"), "build", `@bob post ${i}`);
      let between = false;
      // bob reads his oldest mention after the first page of the unread read, so the last unread post moves onto the
      // first page's offsets and the second page, read at offset 200, misses it.
      const page = await load(viewer, (url) => {
        if (between && url === "/api/channel-posts?channel=build&unread=true&limit=200&offset=200") {
          between = false;
          readInbox(db, OWNER_ACCOUNT, "bob", true, 1);
        }
        return undefined;
      });
      const log = page.elements["post-rows"];
      await page.until(() => page.elements["channel-rows"].children.length === 1);
      open(page.elements["channel-rows"].children[0]);
      await page.until(() => log.children.length === 201 && page.scheduled());
      between = true;
      await page.poll();
      await page.until(() => !between && page.scheduled());
      // The missed post is not taken for read, and the one read, asked about before it was, is not yet shown read.
      expect([receipt(log.children[0]), receipt(log.children[200])]).toEqual(["bob: not read yet", "bob: not read yet"]);
      await page.poll();
      await page.until(() => receipt(log.children[0]) === "bob: read" && page.scheduled());
      expect(log.children.slice(1).filter((row) => receipt(row) === "bob: read")).toHaveLength(0);
    });

    it("keeps both kinds of receipt turning to read while a direct message to an agent is unread too", async () => {
      for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
      post(db, OWNER_ACCOUNT, member("alice"), "build", "@bob look");
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "direct");
      const page = await load(viewer);
      const log = page.elements["post-rows"];
      await page.until(() => page.elements["channel-rows"].children.length === 1 && page.elements["pair-rows"].children.length === 1);
      open(page.elements["channel-rows"].children[0]);
      await page.until(() => log.children.length === 1 && page.scheduled());
      readInbox(db, OWNER_ACCOUNT, "bob");
      await page.poll();
      await page.until(() => receipt(log.children[0]) === "bob: read" && page.scheduled());
      expect(page.elements["status-line"].textContent).toBe("");
      open(page.elements["pair-rows"].children[0]);
      await page.until(() => field(log.children[0], "receipt") === "read");
    });

    it("shows no receipt in search results", async () => {
      for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
      post(db, OWNER_ACCOUNT, member("alice"), "build", "@bob deploy");
      const page = await load(viewer);
      await page.until(() => page.elements["channel-rows"].children.length === 1);
      page.elements["search-text"].value = "deploy";
      page.elements["search"].on.submit({ preventDefault() {} } as never);
      const found = page.elements["result-rows"];
      await page.until(() => found.children.length === 1);
      expect(found.children[0].children.some((c) => c.className.startsWith("receipt"))).toBe(false);
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
    setAttribute(name: string, value: string): void;
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
    setAttribute() {},
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
    const timers = handTimers();
    const store = new Map([["message-cp-token", token]]);
    runInNewContext(script, {
      AbortController,
      location: { hash: "", pathname: "/", search: "" },
      history: { replaceState() {} },
      addEventListener() {},
      URLSearchParams,
      document: { getElementById: (id: string) => (elements[id] ??= el()), createElement: el, addEventListener() {} },
      sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
      setTimeout: timers.set,
      clearTimeout: timers.clear,
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
    return { elements, urls, store, held, polls: timers.polls, poll: timers.poll, until, search, prevented: () => prevented };
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

  it("shows no read receipt on a message in the results", async () => {
    for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "findable unread");
    sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "findable read");
    readInbox(db, OWNER_ACCOUNT, "alice");
    const page = await load(viewer);
    page.search("findable");
    await page.until(() => page.elements["result-rows"].children.length === 2);
    for (const row of page.elements["result-rows"].children) {
      expect(row.children.map((c) => c.className)).not.toContain("receipt");
      expect(row.children.map((c) => c.textContent)).not.toContain("not read yet");
      expect(row.children.map((c) => c.textContent)).not.toContain("read");
    }
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
    await page.until(() => page.polls.size === 1);
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
    await page.poll();
    await page.until(() => page.polls.size === 1);
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
    setAttribute(name: string, value: string): void;
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
    setAttribute() {},
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
    const timers = handTimers();
    const store = new Map([["message-cp-token", token]]);
    runInNewContext(script, {
      AbortController,
      location: { hash: "", pathname: "/", search: "" },
      history: { replaceState() {} },
      addEventListener() {},
      URLSearchParams,
      document: { getElementById: (id: string) => (elements[id] ??= el()), createElement: el, addEventListener() {} },
      sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
      setTimeout: timers.set,
      clearTimeout: timers.clear,
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
    const entry = () => elements["delivery-entry"].children[0]?.children[0] as Stub;
    const openDeliveries = async () => {
      await until(() => entry() !== undefined);
      entry().on.click();
    };
    return { elements, urls, store, polls: timers.polls, deadlines: timers.deadlines, until, poll: timers.poll, entry, openDeliveries };
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
    await page.poll();
    await page.until(() => rows.children.length === 4);
    expect(deliveryUrls(page.urls)).toEqual(["/api/webhook-deliveries?limit=200&offset=0"]);
    expect(rows.children.map((row) => field(row, "tag"))).toEqual(["pending", "delivered", "failed", "delivered"]);

    // Closing the view stops reading it.
    page.elements["close-log"].on.click();
    expect(page.elements["log"].hidden).toBe(true);
    expect(rows.children).toHaveLength(0);
    page.urls.length = 0;
    await page.poll();
    await page.until(() => page.polls.size === 1);
    expect(deliveryUrls(page.urls)).toEqual([]);
  });

  it("says when there are no deliveries and when only the newest 200 are shown", async () => {
    for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
    const page = await load(viewer);
    await page.openDeliveries();
    await page.until(() => page.elements["log-note"].textContent === NO_DELIVERIES);
    expect(page.elements["post-rows"].children).toHaveLength(0);
    expect(item(page)).toEqual(["Webhook deliveries", "0"]);

    addWebhook(db, "owner", "https://example.com/", "agent:bob", true);
    for (let i = 0; i < 201; i++) sendMessage(db, OWNER_ACCOUNT, "alice", "bob", `m${i}`);
    await page.poll();
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
    await page.until(() => page.polls.size === 1);
    // Opening the view drops the poll scheduled before it; wait for the one it starts to schedule the next.
    await page.openDeliveries();
    expect(page.polls.size).toBe(0);
    await page.until(() => page.elements["log-note"].textContent === note && page.polls.size === 1);
    expect(page.elements["status-line"].textContent).toBe("");
    expect(page.store.size).toBe(1);

    // The agents, channels and messages still refresh.
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "hi");
    joinChannel(db, OWNER_ACCOUNT, { ...identityOf(db, OWNER_ACCOUNT, "alice")!, name: "alice" }, "ops");
    await page.poll();
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
    expect(page.polls.size).toBe(0);
    // Only the hung request's deadline is left: every request that answered cleared its own.
    expect(page.deadlines.size).toBe(1);
    const deadlines = [...page.deadlines.values()];
    page.deadlines.clear();
    deadlines.forEach((abort) => abort());
    await page.until(() => page.elements["log-note"].textContent === "The server did not answer in time. Retrying…");
    await page.until(() => page.polls.size === 1);
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
    await page.poll();
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
    await page.until(() => page.elements["log-note"].textContent === NO_DELIVERIES);
    expect(page.elements["post-rows"].children).toHaveLength(0);
    expect(item(page)).toEqual(["Webhook deliveries", "0"]);
  });
});

describe("the page's approved clients", () => {
  // A stub DOM element, as in the webhook deliveries tests above.
  interface Stub {
    on: Record<string, () => void>;
    hidden: boolean;
    disabled?: boolean;
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
    setAttribute(name: string, value: string): void;
    focus(): void;
    contains(node: unknown): boolean;
  }
  // The element that last took focus, which the page reads as document.activeElement.
  let focused: Stub | null = null;
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
    setAttribute() {},
    focus() {
      focused = this;
    },
    contains(node) {
      return node === this || this.children.some((c) => c.contains(node));
    },
  });
  const text = (node: Stub): string => (node.children.length > 0 ? node.children.map(text).join("") : node.textContent);
  const field = (row: Stub, name: string) => {
    const node = row.children.find((c) => c.className === name);
    return node && text(node);
  };
  // An approval row's agent, token id, issue time and client.
  const approval = (row: Stub) => [field(row, "from"), field(row, "tag"), field(row, "time"), field(row, "body")];
  // An approval row's line of registered agents, undefined for a single-agent approval's.
  const registered = (row: Stub) => field(row, "agents");

  // An approval as the OAuth code exchange records it: an agent token bound to the agent, with its client.
  const approve = (account: string, agent: string, client: { name: string | null; host: string | null }) => {
    const id = listAccounts(db).find((a) => a.name === account)!.id;
    if (!identityOf(db, id, agent)) registerAgent(db, id, agent, "x");
    const issued = addToken(db, account, false, true, identityOf(db, id, agent)!.id);
    recordClient(db, issued.id, client);
    return issued;
  };
  // An approval of a client that registers its own agents: an agent token bound to no agent, with its client.
  const approveRegistering = (account: string, client: { name: string | null; host: string | null }) => {
    const issued = addToken(db, account, false, true, undefined, undefined, true);
    recordClient(db, issued.id, client);
    return issued;
  };
  const issued = (id: number) => new Date(db.prepare("SELECT created_at FROM tokens WHERE id = ?").pluck().get(id) as number).toLocaleString();

  // Runs the served script with the given token, as the webhook deliveries tests do. refuse, when it returns a status,
  // answers a request with that status; "hang" answers only by failing when it is aborted, "fail" rejects, "junk"
  // answers 200 with a body this page cannot read, "nulls" a list it cannot read, "unnamed" an approval whose
  // clientName is missing, "numbered" one whose agent is a number, "unflagged" a single-agent one without registers,
  // "listing" a single-agent one with agents, "bound" a registering one with an agent, "unlisted" a registering one
  // without agents, "mixed" a registering one whose agents include a number, "held" waits for release() to answer
  // as the server does, and a { status, reason, retry } answers with that error.
  type Odd = "unnamed" | "numbered" | "unflagged" | "listing" | "bound" | "unlisted" | "mixed";
  type Refusal = number | "hang" | "fail" | "junk" | "nulls" | Odd | "held" | { status: number; reason: string; retry?: boolean };
  async function load(token: string, refuse: (url: string, init: RequestInit) => Refusal | undefined = () => undefined) {
    const html = await (await fetch(`${base()}/`)).text();
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
    const elements: Record<string, Stub> = {};
    const urls: string[] = [];
    const requests: { url: string; method: string }[] = [];
    const timers = handTimers();
    const store = new Map([["message-cp-token", token]]);
    const held: (() => void)[] = [];
    runInNewContext(script, {
      AbortController,
      location: { hash: "", pathname: "/", search: "" },
      history: { replaceState() {} },
      addEventListener() {},
      URLSearchParams,
      document: {
        getElementById: (id: string) => (elements[id] ??= el()), createElement: el, addEventListener() {},
        get activeElement() {
          return focused;
        },
      },
      sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
      setTimeout: timers.set,
      clearTimeout: timers.clear,
      fetch: (url: string, init: RequestInit) => {
        urls.push(url);
        requests.push({ url, method: init.method ?? "GET" });
        const status = refuse(url, init);
        if (status === "hang") return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))));
        // The server's answer, even once the page has aborted the request, as one already on its way would arrive.
        if (status === "held") return new Promise<Response>((resolve) => held.push(() => resolve(fetch(`${base()}${url}`, { ...init, signal: undefined }))));
        if (status === "fail") return Promise.reject(new TypeError("fetch failed"));
        if (typeof status === "object") {
          const body = JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: status.reason }, id: null });
          return Promise.resolve(new Response(body, { status: status.status, headers: status.retry ? { "Retry-After": "1" } : {} }));
        }
        if (status === "junk") return Promise.resolve(new Response("{", { status: 200 }));
        if (status === "nulls") return Promise.resolve(Response.json([null]));
        const single = { id: 1, registers: false, agent: "desk", clientName: "Cursor", clientHost: null, issuedAt: new Date(0).toISOString() };
        const own = { ...single, registers: true, agent: null, agents: ["codex-1"] };
        const odd: Record<Odd, unknown> = {
          unnamed: { ...single, clientName: undefined },
          numbered: { ...single, agent: 7 },
          unflagged: { ...single, registers: undefined },
          listing: { ...single, agents: ["desk"] },
          bound: { ...own, agent: "desk" },
          unlisted: { ...own, agents: undefined },
          mixed: { ...own, agents: ["codex-1", 7] },
        };
        if (typeof status === "string" && status in odd) return Promise.resolve(Response.json([odd[status as Odd]]));
        return status === undefined ? fetch(`${base()}${url}`, init) : Promise.resolve(new Response(null, { status }));
      },
    });
    const until = async (done: () => boolean) => {
      for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(done()).toBe(true);
    };
    const entry = () => elements["approval-entry"].children[0]?.children[0] as Stub;
    const openApprovals = async () => {
      await until(() => entry() !== undefined);
      entry().on.click();
    };
    const release = () => held.splice(0).forEach((answer) => answer());
    // The page's own writes to /api, without the sign-in to the approval page that an https address also sends.
    const writes = () => requests.filter((r) => r.method !== "GET" && r.url.startsWith("/api/"));
    return { elements, urls, requests, writes, store, polls: timers.polls, deadlines: timers.deadlines, until, poll: timers.poll, entry, openApprovals, held, release };
  }

  // The sidebar entry's label and count.
  const item = (page: Awaited<ReturnType<typeof load>>) => page.entry().children.map((c) => c.textContent);
  const approvalUrls = (urls: string[]) => urls.filter((url) => url.startsWith("/api/approvals"));

  it("shows this account's approvals newest first, by name, host or neither, and never another account's", async () => {
    const cursor = approve("owner", "desk", { name: "Cursor", host: null });
    const claude = approve("owner", "claude", { name: null, host: "claude.ai" });
    const bare = approve("owner", "desk", { name: null, host: null });
    // Tokens made otherwise are not approvals, and another account's approval on the same agent name never shows.
    addToken(db, "owner", false, true);
    addAccount(db, "other");
    approve("other", "desk", { name: "Other's client", host: null });

    const page = await load(viewer);
    // Until the view is opened the entry has no count, and the approvals are not read.
    await page.until(() => page.entry() !== undefined);
    expect(item(page)).toEqual(["Approved clients", ""]);
    expect(approvalUrls(page.urls)).toEqual([]);
    await page.openApprovals();
    const rows = page.elements["post-rows"];
    await page.until(() => rows.children.length === 3);
    expect(approvalUrls(page.urls)).toEqual(["/api/approvals?limit=200&offset=0"]);
    for (const url of page.urls) expect(url).not.toContain(viewer);
    expect(page.elements["log"].hidden).toBe(false);
    expect(page.elements["log-title"].textContent).toBe("Approved clients");
    expect(page.elements["log-note"].textContent).toBe("");
    expect(rows.children.map(approval)).toEqual([
      ["desk", `token ${bare.id}`, `issued ${issued(bare.id)}`, "unnamed client"],
      ["claude", `token ${claude.id}`, `issued ${issued(claude.id)}`, "claude.ai"],
      ["desk", `token ${cursor.id}`, `issued ${issued(cursor.id)}`, "Cursor"],
    ]);
    expect(item(page)).toEqual(["Approved clients", "3"]);
    expect(page.entry().className).toBe("item current");
    // Nothing private reached the page, and nothing of the other account.
    const shown = JSON.stringify(rows.children.map(approval));
    for (const hidden of [cursor.token, claude.token, bare.token, viewer, "Other's client"]) expect(shown).not.toContain(hidden);

    // The next poll replaces the rows with the page as it is now, without a reload: a revoked token goes.
    revokeToken(db, claude.id);
    page.urls.length = 0;
    await page.poll();
    await page.until(() => rows.children.length === 2);
    expect(approvalUrls(page.urls)).toEqual(["/api/approvals?limit=200&offset=0"]);
    expect(rows.children.map((row) => field(row, "tag"))).toEqual([`token ${bare.id}`, `token ${cursor.id}`]);

    // Closing the view stops reading it.
    page.elements["close-log"].on.click();
    expect(page.elements["log"].hidden).toBe(true);
    expect(rows.children).toHaveLength(0);
    page.urls.length = 0;
    await page.poll();
    await page.until(() => page.polls.size === 1);
    expect(approvalUrls(page.urls)).toEqual([]);
  });

  it("shows a client that registers its own agents in the agent's place, with the agents it registered or none yet", async () => {
    const desk = approve("owner", "desk", { name: "Cursor", host: null });
    const codex = approveRegistering("owner", { name: "Codex", host: null });
    // Another account's agent of the same name, registered by its own registering token, never shows.
    addAccount(db, "other");
    const theirs = approveRegistering("other", { name: "Other's client", host: null });
    registerWithIdentity(db, listAccounts(db).find((a) => a.name === "other")!.id, "codex-1", "x", undefined, theirs.id);
    const page = await load(viewer);
    await page.openApprovals();
    const rows = page.elements["post-rows"];
    await page.until(() => rows.children.length === 2);
    expect(rows.children.map(approval)).toEqual([
      ["registers its own agents", `token ${codex.id}`, `issued ${issued(codex.id)}`, "Codex"],
      ["desk", `token ${desk.id}`, `issued ${issued(desk.id)}`, "Cursor"],
    ]);
    expect(rows.children.map(registered)).toEqual(["has registered no agents yet", undefined]);

    for (const name of ["codex-2", "codex-1"]) registerWithIdentity(db, OWNER_ACCOUNT, name, "x", undefined, codex.id);
    await page.poll();
    await page.until(() => registered(rows.children[0]) === "agents: codex-1, codex-2");
    expect(rows.children.map(approval)[0]).toEqual(["registers its own agents", `token ${codex.id}`, `issued ${issued(codex.id)}`, "Codex"]);
    expect(registered(rows.children[1])).toBeUndefined();
    expect(item(page)).toEqual(["Approved clients", "2"]);
    const shown = JSON.stringify(rows.children.map((row) => [...approval(row), registered(row)]));
    for (const hidden of [codex.token, desk.token, theirs.token, viewer, "Other's client"]) expect(shown).not.toContain(hidden);
  });

  it("shows the view to a full and a person token too", async () => {
    const cursor = approve("owner", "desk", { name: "Cursor", host: null });
    addPerson(db, "owner", "maria");
    for (const token of [OWNER_TOKEN, addToken(db, "owner").token, addToken(db, "owner", false, false, undefined, "maria").token]) {
      const page = await load(token);
      await page.openApprovals();
      await page.until(() => page.elements["post-rows"].children.length === 1);
      expect(page.elements["post-rows"].children.map(approval)).toEqual([["desk", `token ${cursor.id}`, `issued ${issued(cursor.id)}`, "Cursor"]]);
    }
  });

  it("says when there are no approvals and when only the newest 200 are shown", async () => {
    const page = await load(viewer);
    await page.openApprovals();
    await page.until(() => page.elements["log-note"].textContent === NO_APPROVALS);
    expect(page.elements["post-rows"].children).toHaveLength(0);
    expect(item(page)).toEqual(["Approved clients", "0"]);

    for (let i = 0; i < 201; i++) approve("owner", "desk", { name: `c${i}`, host: null });
    await page.poll();
    await page.until(() => page.elements["post-rows"].children.length === 200);
    expect(page.elements["log-note"].textContent).toBe("Only the newest 200 approvals are shown.");
    expect(field(page.elements["post-rows"].children[0], "body")).toBe("c200");
    expect(item(page)).toEqual(["Approved clients", "200"]);
  });

  it.each([
    [403, "This token cannot read approved clients (403). Retrying…"],
    [503, "The server is busy (503). Retrying…"],
    ["junk", "The server sent an answer this page cannot read. Retrying…"],
    ["nulls", "The server sent an answer this page cannot read. Retrying…"],
    ["unnamed", "The server sent an answer this page cannot read. Retrying…"],
    ["numbered", "The server sent an answer this page cannot read. Retrying…"],
    ["unflagged", "The server sent an answer this page cannot read. Retrying…"],
    ["listing", "The server sent an answer this page cannot read. Retrying…"],
    ["bound", "The server sent an answer this page cannot read. Retrying…"],
    ["unlisted", "The server sent an answer this page cannot read. Retrying…"],
    ["mixed", "The server sent an answer this page cannot read. Retrying…"],
    ["fail", "Cannot reach the server. Retrying…"],
  ] as const)("shows a %s in the view's note and keeps the rest of the page refreshing", async (failure, note) => {
    for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
    post(db, OWNER_ACCOUNT, { ...identityOf(db, OWNER_ACCOUNT, "alice")!, name: "alice" }, "build", "hello");
    const page = await load(viewer, (url) => (url.startsWith("/api/approvals") ? failure : undefined));
    await page.until(() => page.polls.size === 1);
    // Opening the view drops the poll scheduled before it; wait for the one it starts to schedule the next.
    await page.openApprovals();
    expect(page.polls.size).toBe(0);
    await page.until(() => page.elements["log-note"].textContent === note && page.polls.size === 1);
    expect(page.elements["post-rows"].children).toHaveLength(0);
    expect(page.elements["status-line"].textContent).toBe("");
    expect(page.store.size).toBe(1);

    // The agents, channels and messages still refresh.
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "hi");
    joinChannel(db, OWNER_ACCOUNT, { ...identityOf(db, OWNER_ACCOUNT, "alice")!, name: "alice" }, "ops");
    await page.poll();
    await page.until(() => page.elements["pair-rows"].children.length === 1 && page.elements["channel-rows"].children.length === 2);
    expect(page.elements["log-note"].textContent).toBe(note);
  });

  it("keeps the rest of the page refreshing while the approvals time out", async () => {
    for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "hi");
    const page = await load(viewer, (url) => (url.startsWith("/api/approvals") ? "hang" : undefined));
    await page.openApprovals();
    await page.until(() => page.elements["pair-rows"].children.length === 1 && approvalUrls(page.urls).length === 1);
    expect(page.polls.size).toBe(0);
    // Only the hung request's deadline is left: the poll's deadline aborts it, and the next poll is still scheduled.
    expect(page.deadlines.size).toBe(1);
    const deadlines = [...page.deadlines.values()];
    page.deadlines.clear();
    deadlines.forEach((abort) => abort());
    await page.until(() => page.elements["log-note"].textContent === "The server did not answer in time. Retrying…");
    await page.until(() => page.polls.size === 1);
    expect(page.elements["pair-rows"].children).toHaveLength(1);
    expect(page.store.size).toBe(1);
  });

  it("asks for the token again and clears the view when the server refuses the token", async () => {
    approve("owner", "desk", { name: "Cursor", host: null });
    const ticket = addToken(db, "owner", true);
    let refused = false;
    // Only the approvals are refused, so the 401 can only come from them.
    const page = await load(ticket.token, (url) => (refused && url.startsWith("/api/approvals") ? 401 : undefined));
    await page.openApprovals();
    await page.until(() => page.elements["post-rows"].children.length === 1);
    refused = true;
    await page.poll();
    await page.until(() => page.elements["status-line"].textContent.startsWith("The server refused"));
    expect(page.elements["post-rows"].children).toHaveLength(0);
    expect(page.elements["log"].hidden).toBe(true);
    expect(page.elements["log-title"].textContent).toBe("");
    expect(item(page)).toEqual(["Approved clients", ""]);
    expect(page.store.size).toBe(0);
    expect(page.elements["login"].hidden).toBe(false);
  });

  it("clears the view when the token is forgotten, and shows the next token only its own account's approvals", async () => {
    approve("owner", "desk", { name: "Cursor", host: null });
    addAccount(db, "other");
    const theirs = approve("other", "laptop", { name: "Other's client", host: null });
    const otherViewer = addToken(db, "other", true).token;
    const page = await load(viewer);
    await page.openApprovals();
    await page.until(() => page.elements["post-rows"].children.length === 1);

    page.elements["forget"].on.click();
    expect(page.elements["post-rows"].children).toHaveLength(0);
    expect(page.elements["log"].hidden).toBe(true);
    expect(item(page)).toEqual(["Approved clients", ""]);
    expect(page.store.size).toBe(0);

    page.elements["token"].value = otherViewer;
    page.elements["login"].on.submit({ preventDefault() {} } as never);
    await page.openApprovals();
    await page.until(() => page.elements["post-rows"].children.length === 1);
    expect(page.elements["post-rows"].children.map(approval)).toEqual([
      ["laptop", `token ${theirs.id}`, `issued ${issued(theirs.id)}`, "Other's client"],
    ]);
    expect(item(page)).toEqual(["Approved clients", "1"]);
  });

  it("shows a client's name with its control and format characters replaced, so it cannot pass for another token", async () => {
    const odd = approve("owner", "desk", { name: "Cursor · token 1\n\u202Eevil", host: null });
    const page = await load(viewer);
    await page.openApprovals();
    await page.until(() => page.elements["post-rows"].children.length === 1);
    expect(page.elements["post-rows"].children.map(approval)).toEqual([
      ["desk", `token ${odd.id}`, `issued ${issued(odd.id)}`, "Cursor · token 1\uFFFD\uFFFDevil"],
    ]);
  });

  it("drops an answer for the view that arrives after the view was closed", async () => {
    approve("owner", "desk", { name: "Cursor", host: null });
    const page = await load(viewer, (url) => (url.startsWith("/api/approvals") ? "held" : undefined));
    await page.openApprovals();
    await page.until(() => page.held.length === 1);
    // Close calls closeLog() without cancel(), so the poll's answer still comes; only openApprovals drops it.
    page.elements["close-log"].on.click();
    page.release();
    await page.until(() => page.polls.size === 1);
    expect(page.elements["log"].hidden).toBe(true);
    expect(page.elements["post-rows"].children).toHaveLength(0);
    expect(page.elements["log-note"].textContent).toBe("");
    expect(item(page)).toEqual(["Approved clients", ""]);
  });

  it("drops an answer for the view that arrives after a channel or the webhook deliveries were opened", async () => {
    approve("owner", "desk", { name: "Cursor", host: null });
    for (const name of ["alice", "bob"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
    post(db, OWNER_ACCOUNT, { ...identityOf(db, OWNER_ACCOUNT, "alice")!, name: "alice" }, "build", "hello");
    let hold = true;
    const page = await load(viewer, (url) => (hold && url.startsWith("/api/approvals") ? "held" : undefined));
    await page.until(() => page.elements["channel-rows"].children.length === 1);
    for (const other of ["channel", "deliveries"]) {
      hold = true;
      await page.openApprovals();
      await page.until(() => page.held.length === 1);
      // Another view opens while the approvals are read; their answer then comes, and is dropped.
      if (other === "channel") page.elements["channel-rows"].children[0].children[0].on.click();
      else page.elements["delivery-entry"].children[0].children[0].on.click();
      hold = false;
      page.release();
      if (other === "channel") {
        await page.until(() => page.elements["post-rows"].children.length === 1 && page.polls.size === 1);
        expect(page.elements["log-title"].textContent).toBe("build");
        expect(field(page.elements["post-rows"].children[0], "from")).toBe("alice");
      } else {
        await page.until(() => page.elements["log-note"].textContent === NO_DELIVERIES && page.polls.size === 1);
        expect(page.elements["log-title"].textContent).toBe("Webhook deliveries");
        expect(page.elements["post-rows"].children).toHaveLength(0);
      }
      // The approvals were never shown, nor counted.
      expect(item(page)).toEqual(["Approved clients", ""]);
      expect(page.entry().className).toBe("item");
    }
  });

  describe("revoking one", () => {
    let anaToken: string;
    beforeEach(() => {
      addPerson(db, "owner", "ana", true);
      anaToken = addToken(db, "owner", false, false, undefined, "ana").token;
    });
    type Page = Awaited<ReturnType<typeof load>>;
    const rows = (page: Page) => page.elements["post-rows"].children;
    const revokeButton = (page: Page, id: number) =>
      rows(page).find((r) => field(r, "tag") === `token ${id}`)!.children.find((c) => c.textContent === "Revoke");
    const revoke = (page: Page, id: number) => revokeButton(page, id)!.on.click();
    const note = (page: Page) => page.elements["approval-note"].textContent;
    const confirm = (page: Page) => page.elements["approval-confirm"];
    const live = (token: string) => accountForToken(db, token, OWNER_TOKEN) !== undefined;
    const NOT_ADMIN_APPROVALS =
      "The server says you are no longer an admin of this account (403), so this page no longer offers revoking approved clients.";
    // Opens the view and waits for the given number of rows, each with a Revoke button once the token is known as an admin's.
    const openWith = async (page: Page, count: number, buttons = true) => {
      await page.openApprovals();
      await page.until(() => rows(page).length === count && rows(page).every((r) => r.children.some((c) => c.textContent === "Revoke") === buttons));
    };

    it("offers Revoke to an admin person only, and never sends a revocation with any other token", async () => {
      const cursor = approve("owner", "desk", { name: "Cursor", host: null });
      addPerson(db, "owner", "maria");
      const plain = addToken(db, "owner", false, false, undefined, "maria").token;
      for (const token of [plain, OWNER_TOKEN, viewer]) {
        const page = await load(token);
        await page.until(() => page.requests.some((r) => r.url === "/api/token"));
        await openWith(page, 1, false);
        await page.poll();
        await page.until(() => page.polls.size === 1);
        expect(rows(page)[0].className).toBe("entry approval");
        expect(revokeButton(page, cursor.id)).toBeUndefined();
        page.elements["approval-yes"].on.click();
        expect(page.writes()).toEqual([]);
      }
      const page = await load(anaToken);
      await openWith(page, 1);
      expect(rows(page)[0].className).toBe("entry approval revocable");
      expect(approval(rows(page)[0])).toEqual(["desk", `token ${cursor.id}`, `issued ${issued(cursor.id)}`, "Cursor"]);
      expect(confirm(page).hidden).toBe(true);
      expect(page.writes()).toEqual([]);
    });

    it("revokes a client only after confirming, says what it ended, and reads the list again", async () => {
      const kept = approve("owner", "laptop", { name: "Claude", host: null });
      const cursor = approve("owner", "desk", { name: "Cursor", host: null });
      const codex = approveRegistering("owner", { name: null, host: "codex.example" });
      const page = await load(anaToken);
      await openWith(page, 3);
      // Revoke asks first, naming the client and its agent; Keep it sends nothing.
      revoke(page, cursor.id);
      expect(confirm(page).hidden).toBe(false);
      expect(page.elements["approval-text"].textContent).toBe(
        `Revoke token ${cursor.id} (Cursor), approved as desk? Sessions of desk that use it stop at their next request. This cannot be undone.`,
      );
      page.elements["approval-no"].on.click();
      expect(confirm(page).hidden).toBe(true);
      expect(page.writes()).toEqual([]);
      // One that registers its own agents says so in the agent's place.
      revoke(page, codex.id);
      expect(page.elements["approval-text"].textContent).toBe(
        `Revoke token ${codex.id} (codex.example), which registers its own agents? Sessions of its agents that use it stop at their next request. This cannot be undone.`,
      );
      page.elements["approval-no"].on.click();
      expect(page.writes()).toEqual([]);

      revoke(page, cursor.id);
      page.elements["approval-yes"].on.click();
      await page.until(() => note(page) === `Revoked token ${cursor.id} (Cursor).`);
      expect(page.writes()).toEqual([{ url: `/api/approvals?id=${cursor.id}`, method: "DELETE" }]);
      expect(confirm(page).hidden).toBe(true);
      expect(live(cursor.token)).toBe(false);
      expect(live(kept.token)).toBe(true);
      expect(live(codex.token)).toBe(true);
      await page.until(() => rows(page).length === 2);
      expect(rows(page).map((r) => field(r, "tag"))).toEqual([`token ${codex.id}`, `token ${kept.id}`]);
      expect(item(page)).toEqual(["Approved clients", "2"]);
      // Nothing private reached the page.
      const shown = JSON.stringify(page.elements, (k, v) => (k === "on" ? undefined : v));
      for (const hidden of [cursor.token, kept.token, codex.token, anaToken]) expect(shown).not.toContain(hidden);
    });

    it("says each other answer to a revocation in plain words", async () => {
      const cursor = approve("owner", "desk", { name: "Cursor", host: null });
      let next: Refusal | undefined;
      const page = await load(anaToken, (url, init) => (init.method === "DELETE" ? next : undefined));
      await openWith(page, 1);
      const revokeOne = async (answer: Refusal | undefined, said: string) => {
        next = answer;
        revoke(page, cursor.id);
        page.elements["approval-yes"].on.click();
        await page.until(() => note(page) === said);
        expect(confirm(page).hidden).toBe(true);
      };
      await revokeOne({ status: 400, reason: "Give id once" }, "Give id once");
      await revokeOne({ status: 503, reason: "Database busy", retry: true }, "The server is busy (503). Try again in a moment.");
      await revokeOne({ status: 413, reason: "Too long" }, "This is too long for the server (413).");
      await revokeOne(404, `Token ${cursor.id} (Cursor) was already revoked or gone (404).`);
      await revokeOne("fail", `No answer from the server, so token ${cursor.id} (Cursor) may have been revoked: the list below shows whether.`);
      next = "hang";
      revoke(page, cursor.id);
      page.elements["approval-yes"].on.click();
      await page.until(() => page.deadlines.size > 0);
      expect(page.elements["approval-yes"].disabled).toBe(true);
      for (const [, fn] of page.deadlines) fn();
      await page.until(() => note(page).startsWith(`The server did not answer in time, so token ${cursor.id} (Cursor) may have been revoked`));
      expect(page.elements["approval-yes"].disabled).toBe(false);
      // None of those was the server's own revocation.
      expect(live(cursor.token)).toBe(true);
      // The server's own 404, for a client revoked on the server meanwhile, before the next poll.
      next = undefined;
      revoke(page, cursor.id);
      revokeToken(db, cursor.id);
      page.elements["approval-yes"].on.click();
      await page.until(() => note(page) === `Token ${cursor.id} (Cursor) was already revoked or gone (404).`);
      await page.until(() => page.elements["log-note"].textContent === NO_APPROVALS);
    });

    it("takes the Revoke buttons away on a 403, once the person is no longer an admin, and keeps the list", async () => {
      const cursor = approve("owner", "desk", { name: "Cursor", host: null });
      const page = await load(anaToken);
      await openWith(page, 1);
      setPersonAdmin(db, "owner", "ana", false);
      revoke(page, cursor.id);
      page.elements["approval-yes"].on.click();
      await page.until(() => note(page) === NOT_ADMIN_APPROVALS);
      expect(confirm(page).hidden).toBe(true);
      expect(rows(page).map(approval)).toEqual([["desk", `token ${cursor.id}`, `issued ${issued(cursor.id)}`, "Cursor"]]);
      expect(revokeButton(page, cursor.id)).toBeUndefined();
      expect(page.elements["invite-entry"].children).toEqual([]);
      expect(live(cursor.token)).toBe(true);
      // The next poll draws the list without them too.
      await page.poll();
      await page.until(() => page.polls.size === 1);
      expect(revokeButton(page, cursor.id)).toBeUndefined();
    });

    it("asks for a token again on a revocation's 401", async () => {
      const cursor = approve("owner", "desk", { name: "Cursor", host: null });
      const page = await load(anaToken, (url, init) => (init.method === "DELETE" ? 401 : undefined));
      await openWith(page, 1);
      revoke(page, cursor.id);
      page.elements["approval-yes"].on.click();
      await page.until(() => page.elements["status-line"].textContent === "The server refused that token. Enter another.");
      expect(page.store.size).toBe(0);
      expect(rows(page)).toEqual([]);
      expect(page.elements["log"].hidden).toBe(true);
      expect(confirm(page).hidden).toBe(true);
      expect(live(cursor.token)).toBe(true);
    });

    it("drops a revocation's answer that comes after the view closed, another view opened or the token was forgotten", async () => {
      let hold = false;
      const page = await load(anaToken, (url, init) => (hold && init.method === "DELETE" ? "held" : undefined));
      for (const leave of ["close", "other", "forget"]) {
        const issuedNow = approve("owner", "desk", { name: "Cursor", host: null });
        await openWith(page, 1);
        hold = true;
        revoke(page, issuedNow.id);
        page.elements["approval-yes"].on.click();
        await page.until(() => page.held.length === 1);
        if (leave === "close") page.elements["close-log"].on.click();
        else if (leave === "other") page.elements["delivery-entry"].children[0].children[0].on.click();
        else page.elements["forget"].on.click();
        hold = false;
        page.release();
        // The server revoked it, but the page says nothing of it, once the answer has come: the DELETE's own deadline is
        // cleared when it does.
        await page.until(() => !live(issuedNow.token) && page.deadlines.size === 0);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(note(page)).toBe("");
        expect(confirm(page).hidden).toBe(true);
        expect(page.elements["approval-yes"].disabled).toBe(false);
        if (leave === "other") expect(page.elements["log-title"].textContent).toBe("Webhook deliveries");
        if (leave === "forget") {
          expect(page.elements["log"].hidden).toBe(true);
          expect(page.store.size).toBe(0);
        }
      }
    });

    it("closes a confirmation once the list no longer gives its approval as it was, and sends nothing", async () => {
      const cursor = approve("owner", "desk", { name: "Cursor", host: null });
      const codex = approveRegistering("owner", { name: "Codex", host: null });
      const page = await load(anaToken);
      await openWith(page, 2);
      // Revoked on the server: the next poll no longer lists it.
      revoke(page, cursor.id);
      expect(confirm(page).hidden).toBe(false);
      // The confirmation's Keep it has the focus, which goes to the view's Close button as the confirmation is hidden.
      confirm(page).children.push(page.elements["approval-no"], page.elements["approval-yes"]);
      page.elements["approval-no"].focus();
      revokeToken(db, cursor.id);
      await page.poll();
      await page.until(() => rows(page).length === 1);
      expect(confirm(page).hidden).toBe(true);
      expect(focused).toBe(page.elements["close-log"]);
      expect(note(page)).toBe(`Token ${cursor.id} (Cursor) changed or went from the list, so its confirmation closed and nothing was sent.`);
      page.elements["approval-yes"].on.click();
      expect(page.writes()).toEqual([]);
      // One left as it was keeps its confirmation open across polls; one listed differently closes it.
      revoke(page, codex.id);
      await page.poll();
      await page.until(() => page.polls.size === 1);
      expect(confirm(page).hidden).toBe(false);
      // Focus the reader moved out of the confirmation stays where it is.
      page.elements["log-title"].focus();
      registerWithIdentity(db, OWNER_ACCOUNT, "codex-1", "x", undefined, codex.id);
      await page.poll();
      await page.until(() => confirm(page).hidden);
      expect(focused).toBe(page.elements["log-title"]);
      expect(note(page)).toBe(`Token ${codex.id} (Codex) changed or went from the list, so its confirmation closed and nothing was sent.`);
      page.elements["approval-yes"].on.click();
      expect(page.writes()).toEqual([]);
      expect(live(codex.token)).toBe(true);
    });
  });
});

describe("the page's posting", () => {
  // colin's own person token, the only kind of token that posts and sends, making colin a person of the account first
  // if a test has not.
  const colinToken = () => {
    if (!db.prepare("SELECT 1 FROM agents WHERE name = 'colin' AND person = 1 AND removed_at IS NULL").get()) addPerson(db, "owner", "colin");
    return addToken(db, "owner", false, false, undefined, "colin").token;
  };
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
  // globals, when given, adds to the script's globals, such as a BroadcastChannel.
  type Answer = { status?: number; body?: string; hold?: Promise<void>; lose?: boolean };
  async function load(token: string, answer: (url: string, method: string) => Answer | undefined = () => undefined, globals: Record<string, unknown> = {}) {
    const html = await (await fetch(`${base()}/`)).text();
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
    const elements: Record<string, Stub> = {};
    const made: Stub[] = [];
    const requests: { url: string; method: string; body?: string; headers: Record<string, string>; init: RequestInit }[] = [];
    const timers = handTimers();
    const store = new Map([["message-cp-token", token]]);
    // The document's own listeners, such as the one for Escape.
    const documentOn: Record<string, (event?: unknown) => void> = {};
    const make = () => {
      const stub = el();
      made.push(stub);
      return stub;
    };
    runInNewContext(script, {
      AbortController,
      location: { hash: "", pathname: "/", search: "" },
      history: { replaceState() {} },
      addEventListener() {},
      URLSearchParams,
      document: {
        getElementById: (id: string) => (elements[id] ??= make()),
        createElement: make,
        addEventListener: (type: string, fn: (event?: unknown) => void) => void (documentOn[type] = fn),
      },
      sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
      setTimeout: timers.set,
      clearTimeout: timers.clear,
      fetch: (url: string, init: RequestInit) => {
        const method = init.method ?? "GET";
        requests.push({ url, method, body: init.body as string | undefined, headers: init.headers as Record<string, string>, init });
        const given = answer(url, method);
        const reply = () =>
          given?.status !== undefined ? new Response(given.body ?? null, { status: given.status }) : fetch(`${base()}${url}`, init);
        if (given?.lose) return fetch(`${base()}${url}`, init).then(() => Promise.reject(new TypeError("connection lost")));
        if (given?.hold) return given.hold.then(reply);
        if (given) return Promise.resolve(reply());
        return fetch(`${base()}${url}`, init);
      },
      ...globals,
    });
    const until = async (done: () => boolean) => {
      for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(done()).toBe(true);
    };
    let prevented = 0;
    const send = (text: string) => {
      elements["compose-text"].value = text;
      elements["compose"].on.submit({ preventDefault: () => prevented++ });
    };
    // The sign-in POST oauth/signin is not a post; the approval page tests check it.
    const posts = () => requests.filter((r) => r.method !== "GET" && r.url !== "oauth/signin");
    // The people the page may post as, as "New message" offers them under From: a person token's person once
    // GET /api/agents lists them, and no one for any other token.
    const picker = () => (elements["new-from"]?.children ?? []).map((o) => o.value).filter((v) => v !== "");
    return { elements, made, requests, store, documentOn, until, send, posts, picker, poll: timers.poll, scheduled: timers.scheduled, prevented: () => prevented };
  }

  const seed = () => {
    registerAgent(db, OWNER_ACCOUNT, "bob", "x");
    addPerson(db, "owner", "colin");
    joinChannel(db, OWNER_ACCOUNT, { ...identityOf(db, OWNER_ACCOUNT, "bob")!, name: "bob" }, "build");
    post(db, OWNER_ACCOUNT, { ...identityOf(db, OWNER_ACCOUNT, "bob")!, name: "bob" }, "build", "hello");
    sendMessage(db, OWNER_ACCOUNT, "bob", "colin", "hi colin");
  };

  // What a full token sees where a person token's compose box would be.
  const SIGN_IN = "To send, sign in as a person: run message-cp login-link --url <public url> --account <account> --person <name> on the server.";

  it("asks GET /api/token once, with the token only in its header", async () => {
    seed();
    const page = await load(OWNER_TOKEN);
    await page.until(() => page.elements["channel-rows"].children.length === 1 && page.scheduled());
    await page.poll();
    await page.until(() => page.requests.filter((r) => r.url.startsWith("/api/agents")).length === 2);
    const asks = page.requests.filter((r) => r.url === "/api/token");
    expect(asks).toHaveLength(1);
    expect(asks[0].headers).toEqual({ Authorization: `Bearer ${OWNER_TOKEN}` });
    for (const r of page.requests) expect(r.url).not.toContain(OWNER_TOKEN);
  });

  it("with a full token, reads but offers no posting or New buttons, and says under a conversation how to sign in as a person", async () => {
    seed();
    addPerson(db, "owner", "dana");
    for (const token of [OWNER_TOKEN, addToken(db, "owner").token]) {
      const page = await load(token);
      await page.until(() => page.elements["channel-rows"].children.length === 1 && page.elements["pair-rows"].children.length === 1 && page.scheduled());
      expect(page.elements["new-message"].hidden).toBe(true);
      expect(page.elements["new-channel"].hidden).toBe(true);
      expect(page.picker()).toEqual([]);
      // Nothing is open yet, so nothing is said.
      expect(page.elements["writer"].hidden).toBe(true);
      open(page.elements["channel-rows"], "build");
      await page.until(() => page.elements["post-rows"].children.length === 1);
      expect(entries(page.elements["post-rows"])).toEqual([["bob", "hello"]]);
      expect(page.elements["compose"].hidden).toBe(true);
      expect(page.elements["writer"].hidden).toBe(false);
      expect(page.elements["as-note"].textContent).toBe(SIGN_IN);
      // In a pair too, even one with a person in it, and a submit or Enter sends nothing.
      open(page.elements["pair-rows"], "bob ↔ colin");
      expect(page.elements["compose"].hidden).toBe(true);
      expect(page.elements["as-note"].textContent).toBe(SIGN_IN);
      page.send("should not go");
      page.elements["compose-text"].value = "should not go";
      page.elements["compose-text"].on.keydown({ key: "Enter", shiftKey: false, isComposing: false, preventDefault() {} });
      page.elements["new-message"].on.click();
      expect(page.elements["new-form"].hidden).not.toBe(false);
      page.elements["new-channel"].on.click();
      expect(page.elements["channel-form"].hidden).not.toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(page.posts()).toEqual([]);
      // No mention is marked as the reader's: a full token is no one.
      expect(page.elements["post-rows"].children.flatMap((row) => row.children).filter((c) => c.className === "mention me")).toEqual([]);
      // Leaving the conversation takes the note with it.
      page.elements["close-log"].on.click();
      expect(page.elements["writer"].hidden).toBe(true);
      expect(page.elements["as-note"].textContent).toBe("");
    }
  });

  it("with a read-only token, or an answer it cannot read, shows no compose box or sign-in note and never posts", async () => {
    seed();
    for (const [token, answer] of [
      [viewer, () => undefined],
      [OWNER_TOKEN, (url: string) => (url === "/api/token" ? { status: 200, body: '{"readOnly":false}' } : undefined)],
      [OWNER_TOKEN, (url: string) => (url === "/api/token" ? { status: 200, body: "not json" } : undefined)],
      [OWNER_TOKEN, (url: string) => (url === "/api/token" ? { status: 200, body: "{}" } : undefined)],
      [OWNER_TOKEN, (url: string) => (url === "/api/token" ? { status: 503 } : undefined)],
    ] as const) {
      const page = await load(token, answer);
      await page.until(() => page.elements["channel-rows"].children.length === 1 && page.elements["pair-rows"].children.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(page.elements["as-note"].textContent).toBe("");
      // A conversation opens no compose box, and a submit sends nothing.
      open(page.elements["channel-rows"], "build");
      expect(page.elements["compose"].hidden).toBe(true);
      page.send("should not go");
      open(page.elements["pair-rows"], "bob ↔ colin");
      expect(page.elements["compose"].hidden).toBe(true);
      page.send("should not go");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(page.posts()).toEqual([]);
      // Nor does a conversation open the row the compose box sits in or say how to sign in, and Enter sends nothing.
      expect(page.elements["writer"].hidden).toBe(true);
      page.elements["compose-text"].value = "should not go";
      page.elements["compose-text"].on.keydown({ key: "Enter", shiftKey: false, isComposing: false, preventDefault() {} });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(page.posts()).toEqual([]);
    }
  });

  it("posts in the open channel as the token's person, shows the post at once, and @bob gives bob a mention", async () => {
    seed();
    const token = colinToken();
    const page = await load(token);
    await page.until(() => page.picker().length === 1 && page.elements["channel-rows"].children.length === 1);
    open(page.elements["channel-rows"], "build");
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
    expect(sent[0].headers).toEqual({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
    expect(JSON.parse(sent[0].body!)).toEqual({ as: "colin", channel: "build", body: "ship it @bob <b>now</b>" });
    expect(page.elements["compose-text"].value).toBe("");
    const stored = db.prepare("SELECT sender, body FROM channel_posts ORDER BY id DESC LIMIT 1").get();
    expect(stored).toEqual({ sender: "colin", body: "ship it @bob <b>now</b>" });
    expect(unreadSummary(db, OWNER_ACCOUNT, "bob")!.mentions).toBe(before.mentions + 1);
    // The typed text reached the page only as text.
    for (const stub of page.made) expect(stub.html).toEqual([]);
  });

  it("replies in an open conversation of the token's person's, and shows no compose box in one between two others", async () => {
    seed();
    registerAgent(db, OWNER_ACCOUNT, "alice", "x");
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "between agents");
    const page = await load(colinToken());
    await page.until(() => page.picker().length === 1 && page.elements["pair-rows"].children.length === 2);
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

  describe("empty panels", () => {
    const texts = (page: Awaited<ReturnType<typeof load>>) => [
      page.elements["rows"].children.map((row) => row.textContent),
      page.elements["channel-rows"].children.map((row) => row.textContent),
      page.elements["messages-note"].textContent,
    ];

    it("say what fills them, naming New channel and New message only with a person token", async () => {
      for (const token of [viewer, OWNER_TOKEN]) {
        const page = await load(token);
        await page.until(() => page.elements["messages-note"].textContent !== "");
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(texts(page)).toEqual([[NO_AGENTS], [NO_CHANNELS], NO_MESSAGES]);
        expect(page.elements["new-channel"].hidden).toBe(true);
      }

      const person = await load(colinToken());
      await person.until(() => person.elements["messages-note"].textContent !== "" && !person.elements["new-channel"].hidden);
      expect(texts(person).slice(1)).toEqual([[NO_CHANNELS + NEW_CHANNEL], NO_MESSAGES + NEW_MESSAGE]);
    });

    it("name neither button with an answer to GET /api/token it cannot read, or before it answers", async () => {
      const unreadable = await load(colinToken(), (url) => (url === "/api/token" ? { status: 503 } : undefined));
      await unreadable.until(() => unreadable.elements["messages-note"].textContent !== "");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(texts(unreadable).slice(1)).toEqual([[NO_CHANNELS], NO_MESSAGES]);

      // Once the held answer says the token is a person's, the notes name the buttons without waiting for a poll.
      let release!: () => void;
      const hold = new Promise<void>((resolve) => (release = resolve));
      const page = await load(colinToken(), (url) => (url === "/api/token" ? { hold } : undefined));
      await page.until(() => page.elements["messages-note"].textContent !== "");
      expect(texts(page).slice(1)).toEqual([[NO_CHANNELS], NO_MESSAGES]);
      release();
      await page.until(() => !page.elements["new-channel"].hidden);
      expect(texts(page).slice(1)).toEqual([[NO_CHANNELS + NEW_CHANNEL], NO_MESSAGES + NEW_MESSAGE]);

      // A read-only token after it starts with notes that name neither button.
      page.elements["forget"].on.click();
      expect(texts(page)).toEqual([[], [], ""]);
      page.elements["token"].value = viewer;
      page.elements["login"].on.submit({ preventDefault() {} } as never);
      await page.until(() => page.elements["messages-note"].textContent !== "");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(texts(page).slice(1)).toEqual([[NO_CHANNELS], NO_MESSAGES]);
    });

    it("are fixed texts that name no account, agent, token or server address", () => {
      for (const text of [NO_AGENTS, NO_CHANNELS, NEW_CHANNEL, NO_MESSAGES, NEW_MESSAGE, NO_DELIVERIES]) {
        // The published documentation's "Add it to an MCP client" is the one address a panel may name, in this exact phrase.
        const docs = '"Add it to an MCP client", https://message-cp.vercel.app/clients.html#add-it-to-an-mcp-client, says how)';
        expect(text.replaceAll(docs, "")).not.toMatch(/owner|127\.0\.0\.1|https?:|token/);
      }
    });
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
      const page = await load(colinToken());
      await ready(page);
      expect(page.elements["new-message"].hidden).toBe(false);
      page.elements["new-message"].on.click();
      expect(page.elements["new-form"].hidden).toBe(false);
      expect(page.elements["new-message"].attributes["aria-expanded"]).toBe("true");
    });

    it("offers the token's person as From and the account's agents and people as To, minus all and the From name without case", async () => {
      // The server reserves all and keeps names unique without case, so the answer is stubbed to hold them anyway.
      const agent = (name: string, person: boolean) => ({ name, bio: "x", person, online: false, lastSeen: new Date().toISOString(), unreadMessages: 0, unreadPosts: 0, unreadMentions: 0 });
      const body = JSON.stringify([agent("all", false), agent("bob", false), agent("Colin", false), agent("colin", true), agent("dana", true)]);
      const page = await load(colinToken(), (url) => (url.startsWith("/api/agents") ? { status: 200, body } : undefined));
      await page.until(() => page.picker().length === 1 && page.elements["rows"].children.length === 5 && !page.elements["new-message"].hidden);
      page.elements["new-message"].on.click();
      // Only the token's person, already chosen, though dana is a person too.
      expect(options(page.elements["new-from"])).toEqual([["colin", "colin"]]);
      expect(page.elements["new-from"].value).toBe("colin");
      const names = (select: Stub) => options(select).map(([value]) => value).sort();
      expect(names(page.elements["new-to"])).toEqual(["bob", "dana"]);
      expect(options(page.elements["new-to"])).toContainEqual(["dana", "dana (person)"]);
      expect(options(page.elements["new-to"])).toContainEqual(["bob", "bob"]);
      // A poll with the same names leaves the selects as they are, so an open one is not closed under the reader.
      const to = page.elements["new-to"].children;
      await page.poll();
      await page.until(() => page.requests.filter((r) => r.url.startsWith("/api/agents")).length === 2);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(page.elements["new-to"].children).toBe(to);
      for (const stub of page.made) expect(stub.html).toEqual([]);
    });

    it("asks for a new choice, never another name, when the chosen From or To leaves the list while the form is open", async () => {
      // The answer to GET /api/agents is stubbed, so a name can leave it between polls.
      const agent = (name: string, person: boolean) => ({ name, bio: "x", person, online: false, lastSeen: new Date().toISOString(), unreadMessages: 0, unreadPosts: 0, unreadMentions: 0 });
      let listed = [agent("bob", false), agent("zed", false), agent("colin", true), agent("dana", true)];
      const page = await load(colinToken(), (url) => (url.startsWith("/api/agents") ? { status: 200, body: JSON.stringify(listed) } : undefined));
      await page.until(() => page.picker().length === 1 && page.elements["rows"].children.length === 4 && !page.elements["new-message"].hidden);
      page.elements["new-message"].on.click();
      // From starts at the token's person, and To at its empty first option.
      expect(page.elements["new-from"].value).toBe("colin");
      expect(page.elements["new-to"].children[0].value).toBe("");
      expect(page.elements["new-to"].value).toBe("");
      page.elements["new-to"].value = "zed";
      // zed leaves while the form is open: To asks again rather than taking bob, and Open opens nothing.
      listed = listed.filter((a) => a.name !== "zed");
      await page.poll();
      await page.until(() => page.elements["rows"].children.length === 3);
      expect(options(page.elements["new-to"]).map(([value]) => value).sort()).toEqual(["bob", "dana"]);
      expect(page.elements["new-to"].value).toBe("");
      expect(page.elements["new-from"].value).toBe("colin");
      page.elements["new-form"].on.submit({ preventDefault() {} });
      expect(page.elements["log"].hidden).toBe(true);
      expect(page.elements["new-form"].hidden).toBe(false);
      expect(page.elements["pair-rows"].children).toEqual([]);
      // colin leaves the list: From asks again rather than taking dana, so even a To still listed opens nothing.
      listed = listed.filter((a) => a.name !== "colin");
      await page.poll();
      await page.until(() => page.picker().length === 0);
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
      const page = await load(colinToken());
      await ready(page);
      await page.until(() => page.elements["pair-rows"].children.length === 1);
      start(page, "colin", "zed");
      expect(page.elements["pair-rows"].children.map(label)).toEqual(["colin ↔ zed", "bob ↔ zed"]);
      sendMessage(db, OWNER_ACCOUNT, "bob", "zed", "two");
      sendMessage(db, OWNER_ACCOUNT, "zed", "bob", "three");
      await page.poll();
      await page.until(() => page.elements["pair-rows"].children[1]?.children[0].title === "3 messages");
      expect(page.elements["pair-rows"].children.map(label)).toEqual(["colin ↔ zed", "bob ↔ zed"]);
      // Once it has a message, it takes its place by recency like the rest.
      page.send("hello zed");
      await page.until(() => page.elements["post-rows"].children.length === 1);
      expect(page.elements["pair-rows"].children.map(label)).toEqual(["colin ↔ zed", "bob ↔ zed"]);
      sendMessage(db, OWNER_ACCOUNT, "bob", "zed", "four");
      await page.poll();
      await page.until(() => page.elements["pair-rows"].children[0]?.children[0].title === "4 messages");
      expect(page.elements["pair-rows"].children.map(label)).toEqual(["bob ↔ zed", "colin ↔ zed"]);
    });

    it("opens an empty pair with the compose box, sends { as, to, body } to /api/send, and keeps the pair one entry", async () => {
      registerAgent(db, OWNER_ACCOUNT, "bob", "x");
      registerAgent(db, OWNER_ACCOUNT, "zed", "x");
      addPerson(db, "owner", "colin");
      sendMessage(db, OWNER_ACCOUNT, "bob", "zed", "between agents");
      const page = await load(colinToken());
      await ready(page);
      await page.until(() => page.elements["pair-rows"].children.length === 1);
      expect(start(page, "colin", "zed")).toBe(1);
      // The pair is listed first with a count of 0 and no badge, marked open, and opens as one chosen in the sidebar does.
      const pairs = page.elements["pair-rows"];
      expect(pairs.children.map(label)).toEqual(["colin ↔ zed", "bob ↔ zed"]);
      expect(pairs.children[0].children[0].title).toBe("0 messages");
      expect(pairs.children[0].children[0].children[1].hidden).toBe(true);
      expect(pairs.children[0].children[0].className).toBe("item current");
      expect(page.elements["new-form"].hidden).toBe(true);
      expect(page.elements["log"].hidden).toBe(false);
      expect(page.elements["log-title"].textContent).toBe("colin ↔ zed");
      expect(page.elements["log-note"].textContent).toBe("No messages yet.");
      expect(page.elements["post-rows"].children).toEqual([]);
      expect(page.elements["as-note"].textContent).toBe("Posting as colin");
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
      expect(pairs.children[0].children[0].title).toBe("1 message");
      // What the reader sent in the open pair counts as seen.
      expect(pairs.children[0].children[0].children[1].hidden).toBe(true);
      for (const stub of page.made) expect(stub.html).toEqual([]);
    });

    it("opens a pair that already has messages with them, and never opens one with a name it did not offer", async () => {
      seed();
      addPerson(db, "owner", "dana");
      const page = await load(colinToken());
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
      const page = await load(colinToken());
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
      const page = await load(colinToken());
      await ready(page);
      page.elements["new-channel"].on.click();
      expect(page.elements["channel-form"].hidden).toBe(false);
      expect(page.elements["new-channel"].attributes["aria-expanded"]).toBe("true");
      expect(page.elements["channel-from"].children.filter((o) => o.value !== "").map((o) => o.textContent)).toEqual(["colin"]);
    });

    it("starts From at the token's person, and says they are gone when GET /api/agents no longer lists them", async () => {
      seed();
      const page = await load(colinToken());
      await ready(page);
      page.elements["new-channel"].on.click();
      expect(page.elements["channel-from"].value).toBe("colin");
      const empty = await load(colinToken(), (url) => (url.startsWith("/api/agents") ? { status: 200, body: "[]" } : undefined));
      await empty.until(() => empty.elements["channel-rows"].children.length === 1 && !empty.elements["new-channel"].hidden);
      empty.elements["new-channel"].on.click();
      expect(empty.elements["channel-note"].textContent).toBe("colin is no longer a person in this account.");
      expect(empty.elements["channel-fields"].hidden).toBe(true);
      expect(empty.elements["channel-create"].hidden).toBe(true);
    });

    it("sends nothing and says why for a bad name, an existing name in another case, a non-person, another person and a blank post", async () => {
      seed();
      addPerson(db, "owner", "dana");
      const page = await load(colinToken());
      await ready(page);
      const note = () => page.elements["channel-note"].textContent;
      for (const [from, name, body, says] of [
        ["colin", "has space", "hi", "1 to 32"],
        ["colin", "", "hi", "1 to 32"],
        ["colin", "x".repeat(33), "hi", "1 to 32"],
        ["colin", "BUILD", "hi", "already exists"],
        ["bob", "fresh", "hi", "From"],
        ["dana", "fresh", "hi", "From"],
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
      let release!: () => void;
      const hold = new Promise<void>((resolve) => (release = resolve));
      const token = colinToken();
      const page = await load(token, (url, method) => (url === "/api/post" && method === "POST" ? { hold } : undefined));
      await ready(page);
      expect(create(page, "colin", "fresh", "first <b>post</b>")).toBe(1);
      expect(page.elements["channel-create"].disabled).toBe(true);
      // A second submit while the first is in flight sends nothing.
      page.elements["channel-form"].on.submit({ preventDefault() {} });
      expect(page.posts()).toHaveLength(1);
      release();
      await page.until(() => page.elements["log"].hidden === false);
      const sent = page.posts();
      expect(sent).toHaveLength(1);
      expect(sent[0].url).toBe("/api/post");
      expect(sent[0].headers).toEqual({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
      expect(JSON.parse(sent[0].body!)).toEqual({ as: "colin", channel: "fresh", body: "first <b>post</b>" });
      expect(page.elements["channel-form"].hidden).toBe(true);
      expect(page.elements["channel-create"].disabled).toBe(false);
      expect(page.elements["channel-name"].value).toBe("");
      expect(page.elements["channel-body"].value).toBe("");
      expect(page.elements["log-title"].textContent).toBe("fresh");
      expect(page.elements["as-note"].textContent).toBe("Posting as colin");
      expect(page.elements["compose"].hidden).toBe(false);
      expect(page.elements["compose-label"].textContent).toBe("Post in #fresh as colin");
      // The poll openLog starts lists the channel, marks it open and shows the first post.
      await page.until(() => page.elements["post-rows"].children.length === 1 && page.elements["channel-rows"].children.length === 2);
      expect(entries(page.elements["post-rows"])).toEqual([["colin", "first <b>post</b>"]]);
      const row = page.elements["channel-rows"].children.find((r) => label(r) === "fresh")!;
      expect(row.children[0].className).toBe("item current");
      expect(db.prepare("SELECT sender, body FROM channel_posts ORDER BY id DESC LIMIT 1").get()).toEqual({ sender: "colin", body: "first <b>post</b>" });
      // The same name in another case is now refused, so nothing more is posted.
      create(page, "colin", "FRESH", "again");
      expect(page.elements["channel-note"].textContent).toContain("already exists");
      expect(page.posts()).toHaveLength(1);
      for (const stub of page.made) expect(stub.html).toEqual([]);
    });

    it("keeps the text and shows the server's reason on a 400, a note for other refusals and no answer, and asks again on a 401", async () => {
      seed();
      let answer: { status?: number; body?: string; lose?: boolean } = { status: 400, body: JSON.stringify({ error: { message: "Channel names are reserved" } }) };
      const page = await load(colinToken(), (url, method) => (url === "/api/post" && method === "POST" ? answer : undefined));
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
      const page = await load(colinToken(), (url, method) => (url === "/api/post" && method === "POST" ? { hold } : undefined));
      await ready(page);
      create(page, "colin", "fresh", "first");
      page.elements["forget"].on.click();
      release();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(page.elements["log"].hidden).toBe(true);
      expect(page.elements["channel-note"].textContent).toBe("");
      expect(page.elements["channel-create"].disabled).toBe(false);
    });

    it("opens the channel under the name the server stored, when one was made elsewhere since the list was read", async () => {
      seed();
      const page = await load(colinToken());
      await ready(page);
      // Another dashboard creates Fresh after this page read the channel list, so the page cannot refuse it.
      post(db, OWNER_ACCOUNT, { ...identityOf(db, OWNER_ACCOUNT, "bob")!, name: "bob" }, "Fresh", "first elsewhere");
      create(page, "colin", "fresh", "mine");
      await page.until(() => page.elements["log"].hidden === false);
      expect(page.elements["log-title"].textContent).toBe("Fresh");
      expect(page.elements["compose-label"].textContent).toBe("Post in #Fresh as colin");
    });

    it("opens nothing for a create that answers after its form was closed", async () => {
      seed();
      let release!: () => void;
      const hold = new Promise<void>((resolve) => (release = resolve));
      const page = await load(colinToken(), (url, method) => (url === "/api/post" && method === "POST" ? { hold } : undefined));
      await ready(page);
      create(page, "colin", "fresh", "first");
      page.elements["channel-cancel"].on.click();
      release();
      await page.until(() => page.elements["channel-create"].disabled === false);
      expect(page.elements["log"].hidden).toBe(true);
      expect(page.elements["channel-form"].hidden).toBe(true);
      expect(page.elements["as-note"].textContent).toBe("");
      // The post was stored, so the name is refused from now on.
      create(page, "colin", "fresh", "again");
      expect(page.elements["channel-note"].textContent).toContain("already exists");
      expect(page.posts()).toHaveLength(1);
    });

    it("refuses the name after no answer, even once a channel list that leaves it out is read, so a retry adds no second first post", async () => {
      seed();
      const page = await load(colinToken(), (url, method) => (url === "/api/post" && method === "POST" ? { lose: true } : undefined));
      await ready(page);
      create(page, "colin", "fresh", "first");
      await page.until(() => page.elements["channel-note"].textContent.includes("check the channel list"));
      create(page, "colin", "FRESH", "first");
      expect(page.elements["channel-note"].textContent).toContain("already exists");
      // A channel list read before the lost post was stored leaves fresh out, and the name is still refused.
      await page.until(() => page.elements["channel-rows"].children.length === 2);
      for (const table of ["channel_reads", "channel_posts"]) {
        db.prepare(`DELETE FROM ${table} WHERE channel_id = (SELECT id FROM channels WHERE name = 'fresh')`).run();
      }
      db.prepare("DELETE FROM channels WHERE name = 'fresh'").run();
      // Opening a channel starts a fresh poll, whatever poll or timer is left from before.
      open(page.elements["channel-rows"], "build");
      await page.until(() => page.elements["channel-rows"].children.length === 1);
      create(page, "colin", "fresh", "first");
      expect(page.elements["channel-note"].textContent).toContain("already exists");
      expect(page.posts()).toHaveLength(1);
    });

    it("closes on Escape, Cancel, another conversation and ask(), and only one of New message and New channel is open", async () => {
      seed();
      const page = await load(colinToken());
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
      expect(page.elements["writer"].hidden).toBe(false);
      expect(page.elements["compose"].hidden).toBe(false);
    };

    it("says in the placeholder that Enter sends and Shift+Enter adds a line", async () => {
      const html = await (await fetch(`${base()}/`)).text();
      expect(html).toMatch(/<textarea id="compose-text" rows="2"[^>]*placeholder="Enter sends, Shift\+Enter adds a line"/);
      // There is no person picker: the note on who the page posts as sits in the log above the compose box.
      expect(html).not.toContain('id="as-box"');
      expect(html).not.toContain("Post as");
      const log = /<section id="log"[^>]*>([\s\S]*?)<\/section>/.exec(html)![1];
      expect(log).toMatch(/<div id="writer" hidden>\s*<p id="as-note"[\s\S]*<form id="compose" hidden>[\s\S]*<\/form>\s*<p id="compose-note"/);
      expect(html).not.toMatch(/ style=|\.style\s*[.=[]/);
    });

    it("sends once on Enter and prevents its newline", async () => {
      seed();
      const page = await load(colinToken());
      await ready(page);
      expect(key(page, "by enter")).toBe(1);
      await page.until(() => page.elements["compose-send"].disabled === false && page.elements["compose-text"].value === "");
      expect(page.posts()).toHaveLength(1);
      expect(JSON.parse(page.posts()[0].body!)).toEqual({ as: "colin", channel: "build", body: "by enter" });
    });

    it("sends nothing on Shift+Enter, on an Enter while composing, or on an Enter in a box of only whitespace", async () => {
      seed();
      const page = await load(colinToken());
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
      const page = await load(colinToken(), (url, method) => (method === "POST" ? { hold } : undefined));
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
      const page = await load(colinToken());
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
      const page = await load(colinToken(), answer);
      await page.until(() => page.picker().length === 1 && page.elements["channel-rows"].children.length === 1);
      open(page.elements["channel-rows"], "build");
      expect(page.elements["compose"].hidden).toBe(false);
      return page;
    };

    it("opens on @ with the account's agents and people, minus the token's person and all, and narrows ignoring case", async () => {
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
      // The token's person is never offered.
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
    const page = await load(colinToken());
    await page.until(() => page.picker().length === 1 && page.elements["channel-rows"].children.length === 1);
    open(page.elements["channel-rows"], "build");
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
    const page = await load(colinToken(), (url, method) => (method === "POST" ? { hold } : undefined));
    await page.until(() => page.picker().length === 1 && page.elements["channel-rows"].children.length === 1);
    open(page.elements["channel-rows"], "build");
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
    const page = await load(colinToken(), (url, method) => (method === "POST" ? { lose: true } : undefined));
    await page.until(() => page.picker().length === 1 && page.elements["channel-rows"].children.length === 1);
    open(page.elements["channel-rows"], "build");
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
      const page = await load(colinToken(), (url, method) => (method === "POST" ? { status, hold } : undefined));
      await page.until(() => page.picker().length === 1 && page.elements["pair-rows"].children.length === 1);
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
    const page = await load(colinToken(), (url, method) => (method === "POST" && page.posts().length === 1 ? { hold } : undefined));
    await page.until(() => page.picker().length === 1 && page.elements["channel-rows"].children.length === 1);
    open(page.elements["channel-rows"], "build");
    page.send("slow");
    expect(page.elements["compose-send"].disabled).toBe(true);
    page.elements["forget"].on.click();
    expect(page.elements["compose-send"].disabled).toBe(false);
    page.elements["token"].value = colinToken();
    page.elements["login"].on.submit({ preventDefault() {} });
    await page.until(() => page.picker().length === 1 && page.elements["channel-rows"].children.length === 1);
    open(page.elements["channel-rows"], "build");
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
    const page = await load(colinToken(), (url, method) =>
      method === "POST" && status !== 400 ? { status } : undefined,
    );
    await page.until(() => page.picker().length === 1 && page.elements["channel-rows"].children.length === 1);
    open(page.elements["channel-rows"], "build");
    // A 400 comes from the server itself, for a body that is only whitespace.
    const text = status === 400 ? "   " : "keep me";
    page.send(text);
    await page.until(() => page.elements["compose-note"].textContent === note);
    expect(page.elements["compose-text"].value).toBe(text);
    expect(page.store.size).toBe(1);
  });

  it("keeps typed text when the conversation is left, until a 200", async () => {
    seed();
    const page = await load(colinToken());
    await page.until(() => page.picker().length === 1 && page.elements["pair-rows"].children.length === 1);
    open(page.elements["channel-rows"], "build");
    page.elements["compose-text"].value = "a draft";
    open(page.elements["channel-rows"], "build");
    open(page.elements["pair-rows"], "bob ↔ colin");
    expect(page.elements["compose-text"].value).toBe("a draft");
    expect(page.posts()).toEqual([]);
  });

  it("signs the browser in to the approval page with a person or full token, and out with Forget token after it", async () => {
    seed();
    const token = colinToken();
    const page = await load(token);
    const signins = () => page.requests.filter((r) => r.url === "oauth/signin");
    await page.until(() => signins().length === 1);
    expect(signins()[0].method).toBe("POST");
    expect(signins()[0].headers).toEqual({ Authorization: `Bearer ${token}` });
    expect(signins()[0].init).toMatchObject({ credentials: "same-origin", referrerPolicy: "no-referrer", cache: "no-store" });
    expect(signins()[0].init.signal).toBeInstanceOf(AbortSignal);
    page.elements["forget"].on.click();
    await page.until(() => signins().length === 2);
    expect(signins()[1].method).toBe("DELETE");
    expect(signins()[1].headers).toBeUndefined();
    const full = await load(OWNER_TOKEN);
    await full.until(() => full.requests.some((r) => r.url === "oauth/signin"));
    expect(full.requests.filter((r) => r.url === "oauth/signin").map((r) => r.method)).toEqual(["POST"]);
  });

  it("says when the server does not confirm a sign-out, and signs out again on the button", async () => {
    seed();
    let refuse = true;
    const page = await load(colinToken(), (url, method) =>
      url === "oauth/signin" ? (method === "DELETE" && refuse ? { status: 503 } : { status: 204 }) : undefined,
    );
    const signins = () => page.requests.filter((r) => r.url === "oauth/signin").map((r) => r.method);
    await page.until(() => signins().length === 1);
    page.elements["forget"].on.click();
    await page.until(() => page.elements["signout-retry"].hidden === false);
    expect(page.elements["status-line"].textContent).toContain("did not confirm signing this browser out");
    expect(page.elements["login"].hidden).toBe(false);
    refuse = false;
    page.elements["signout-retry"].on.click();
    expect(page.elements["signout-retry"].hidden).toBe(true);
    await page.until(() => signins().length === 3);
    expect(signins()).toEqual(["POST", "DELETE", "DELETE"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(page.elements["signout-retry"].hidden).toBe(true);
  });

  it("clears the sign-in again after its own unanswered sign-in when another tab signs out", async () => {
    seed();
    let answer!: () => void;
    const held = new Promise<void>((resolve) => (answer = resolve));
    const channels: { onmessage?: () => void }[] = [];
    class Channel {
      onmessage?: () => void;
      constructor() {
        channels.push(this);
      }
      postMessage() {}
    }
    const page = await load(colinToken(), (url, method) => (url === "oauth/signin" ? (method === "POST" ? { status: 204, hold: held } : { status: 204 }) : undefined), {
      BroadcastChannel: Channel,
    });
    const signins = () => page.requests.filter((r) => r.url === "oauth/signin").map((r) => r.method);
    await page.until(() => signins().length === 1);
    // Another tab's Forget token: this tab forgets its token, and its POST, still unanswered, could set the cookie again.
    channels[0].onmessage!();
    expect(page.store.has("message-cp-token")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(signins()).toEqual(["POST"]);
    answer();
    await page.until(() => signins().length === 2);
    expect(signins()).toEqual(["POST", "DELETE"]);
  });

  it("says so when its clean-up after another tab's sign-out is not confirmed, and signs out again on the button", async () => {
    seed();
    let answer!: () => void;
    const held = new Promise<void>((resolve) => (answer = resolve));
    let refuse = true;
    const channels: { onmessage?: () => void }[] = [];
    class Channel {
      onmessage?: () => void;
      constructor() {
        channels.push(this);
      }
      postMessage() {}
    }
    const page = await load(
      colinToken(),
      (url, method) =>
        url === "oauth/signin" ? (method === "POST" ? { status: 204, hold: held } : refuse ? { status: 503 } : { status: 204 }) : undefined,
      { BroadcastChannel: Channel },
    );
    const signins = () => page.requests.filter((r) => r.url === "oauth/signin").map((r) => r.method);
    await page.until(() => signins().length === 1);
    channels[0].onmessage!();
    answer();
    await page.until(() => page.elements["signout-retry"].hidden === false);
    expect(signins()).toEqual(["POST", "DELETE"]);
    expect(page.elements["status-line"].textContent).toContain("did not confirm signing this browser out");
    refuse = false;
    page.elements["signout-retry"].on.click();
    await page.until(() => signins().length === 3);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(page.elements["signout-retry"].hidden).toBe(true);
  });

  it("does not clear the sign-in on another tab's sign-out when it has none in flight", async () => {
    seed();
    const channels: { onmessage?: () => void }[] = [];
    class Channel {
      onmessage?: () => void;
      constructor() {
        channels.push(this);
      }
      postMessage() {}
    }
    const page = await load(colinToken(), (url) => (url === "oauth/signin" ? { status: 204 } : undefined), { BroadcastChannel: Channel });
    const signins = () => page.requests.filter((r) => r.url === "oauth/signin").map((r) => r.method);
    await page.until(() => signins().length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    channels[0].onmessage!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(signins()).toEqual(["POST"]);
  });

  it("clears the approval page's sign-in with a read-only token, and never sends it there", async () => {
    seed();
    const page = await load(viewer);
    await page.until(() => page.requests.some((r) => r.url === "oauth/signin"));
    const signins = page.requests.filter((r) => r.url === "oauth/signin");
    expect(signins.map((r) => r.method)).toEqual(["DELETE"]);
    expect(signins[0].headers).toBeUndefined();
  });

  it("clears the page and asks for a token on a 401", async () => {
    seed();
    const page = await load(colinToken(), (url, method) => (method === "POST" ? { status: 401 } : undefined));
    await page.until(() => page.picker().length === 1 && page.elements["channel-rows"].children.length === 1);
    open(page.elements["channel-rows"], "build");
    page.send("hello");
    await page.until(() => page.elements["status-line"].textContent.startsWith("The server refused"));
    expect(page.store.size).toBe(0);
    expect(page.elements["as-note"].textContent).toBe("");
    expect(page.elements["compose"].hidden).toBe(true);
    expect(page.elements["compose-text"].value).toBe("");
  });

  it("posts as no one when the token's person disappears from GET /api/agents, and re-marks their mentions in place", async () => {
    seed();
    post(db, OWNER_ACCOUNT, { ...identityOf(db, OWNER_ACCOUNT, "bob")!, name: "bob" }, "build", "@colin look");
    // The answer to GET /api/agents is stubbed, so colin can leave it while the token still works.
    let gone = false;
    const page = await load(colinToken(), (url) => (gone && url.startsWith("/api/agents") ? { status: 200, body: "[]" } : undefined));
    await page.until(() => page.picker().length === 1 && page.elements["channel-rows"].children.length === 1);
    open(page.elements["channel-rows"], "build");
    expect(page.elements["compose"].hidden).toBe(false);
    const rows = page.elements["post-rows"];
    await page.until(() => rows.children.length === 2);
    const row = rows.children[1];
    const mark = () => row.children.find((c) => c.className === "body")!.children.find((c) => c.className.startsWith("mention"))!.className;
    expect(mark()).toBe("mention me");
    gone = true;
    await page.poll();
    await page.until(() => page.elements["compose"].hidden);
    expect(page.picker()).toEqual([]);
    expect(page.elements["as-note"].textContent).toBe("");
    expect(rows.children[1]).toBe(row);
    expect(mark()).toBe("mention");
  });

  describe("deleting a direct conversation", () => {
    // bob and colin have two messages, bob and dana one, and bob has a post in #build.
    const seedPairs = () => {
      seed();
      sendMessage(db, OWNER_ACCOUNT, "colin", "bob", "hi bob");
      addPerson(db, "owner", "dana");
      sendMessage(db, OWNER_ACCOUNT, "bob", "dana", "hi dana");
    };
    const deletes = (page: Awaited<ReturnType<typeof load>>) => page.requests.filter((r) => r.method === "DELETE" && r.url !== "oauth/signin");
    const ready = async (page: Awaited<ReturnType<typeof load>>) => {
      await page.until(() => page.elements["pair-rows"].children.length === 2 && page.elements["channel-rows"].children.length === 1);
    };
    const openReady = async (page: Awaited<ReturnType<typeof load>>, name: string) => {
      await ready(page);
      open(page.elements["pair-rows"], name);
      await page.until(() => !page.elements["delete-pair"].hidden);
    };
    const confirmDelete = (page: Awaited<ReturnType<typeof load>>) => {
      page.elements["delete-pair"].on.click();
      page.elements["delete-yes"].on.click();
    };
    const stored = () => db.prepare("SELECT m.sender AS f, a.name AS t FROM messages m JOIN agents a ON a.id = m.recipient_id ORDER BY m.id").all();

    it("sits a hidden Delete button and confirmation in the log's header bar, under the same strict CSP", async () => {
      const res = await fetch(`${base()}/`);
      const html = await res.text();
      const head = /<section id="log" hidden>\s*<div class="log-head">([\s\S]*?)<button id="close-log"/.exec(html)![1];
      expect(head).toMatch(/<button id="delete-pair" type="button" hidden>Delete<\/button>\s*$/);
      expect(head).toMatch(/<div id="delete-confirm"[^>]*hidden>\s*<span id="delete-text"><\/span>\s*<button id="delete-yes" type="button">Delete<\/button>\s*<button id="delete-no" type="button">Cancel<\/button>/);
      expect(html).not.toContain("confirm(");
      expect(res.headers.get("content-security-policy") ?? "").not.toContain("unsafe-inline");
    });

    it("shows Delete only with a full or admin person's token and an open pair that has messages", async () => {
      seedPairs();
      // A read-only token and a plain person token never see it, and a click by hand sends nothing.
      for (const token of [viewer, colinToken()]) {
        const reader = await load(token);
        await ready(reader);
        open(reader.elements["pair-rows"], "bob ↔ colin");
        await reader.until(() => reader.elements["post-rows"].children.length === 2);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(reader.elements["delete-pair"].hidden).toBe(true);
        confirmDelete(reader);
        expect(reader.elements["delete-confirm"].hidden).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(deletes(reader)).toEqual([]);
      }

      const page = await load(OWNER_TOKEN);
      await openReady(page, "bob ↔ colin");
      // Not for a channel, the webhook deliveries, search results or no conversation.
      open(page.elements["channel-rows"], "build");
      expect(page.elements["delete-pair"].hidden).toBe(true);
      page.elements["delivery-entry"].children[0].children[0].on.click();
      expect(page.elements["delete-pair"].hidden).toBe(true);
      page.elements["search-text"].value = "hi";
      page.elements["search"].on.submit({ preventDefault() {} });
      expect(page.elements["delete-pair"].hidden).toBe(true);
      page.elements["close-results"].on.click();
      expect(page.elements["delete-pair"].hidden).toBe(true);
      // Nor for a pair an admin person started from New message, with no messages yet.
      setPersonAdmin(db, "owner", "colin", true);
      const admin = await load(colinToken());
      await openReady(admin, "bob ↔ colin");
      await admin.until(() => !admin.elements["new-message"].hidden && admin.elements["rows"].children.length === 3);
      admin.elements["new-message"].on.click();
      admin.elements["new-to"].value = "dana";
      admin.elements["new-form"].on.submit({ preventDefault() {} });
      expect(admin.elements["log-note"].textContent).toBe("No messages yet.");
      expect(admin.elements["delete-pair"].hidden).toBe(true);
      admin.elements["delete-pair"].on.click();
      expect(admin.elements["delete-confirm"].hidden).toBe(true);
      expect(deletes(admin)).toEqual([]);
    });

    it("asks first, naming both sides and the count, and Cancel, Escape, another conversation, Close or a new token send nothing", async () => {
      seedPairs();
      const page = await load(OWNER_TOKEN);
      await openReady(page, "bob ↔ colin");
      const ask = () => {
        page.elements["delete-pair"].on.click();
        expect(page.elements["delete-confirm"].hidden).toBe(false);
        expect(page.elements["delete-pair"].hidden).toBe(true);
      };
      ask();
      expect(page.elements["delete-text"].textContent).toBe("Delete the 2 messages between bob and colin? This cannot be undone.");
      page.elements["delete-no"].on.click();
      expect(page.elements["delete-confirm"].hidden).toBe(true);
      expect(page.elements["delete-pair"].hidden).toBe(false);
      ask();
      let prevented = 0;
      page.documentOn.keydown({ key: "Escape", defaultPrevented: false, preventDefault: () => prevented++ });
      expect(prevented).toBe(1);
      expect(page.elements["delete-confirm"].hidden).toBe(true);
      ask();
      open(page.elements["pair-rows"], "bob ↔ dana");
      expect(page.elements["delete-confirm"].hidden).toBe(true);
      page.elements["delete-pair"].on.click();
      expect(page.elements["delete-text"].textContent).toBe("Delete the 1 message between bob and dana? This cannot be undone.");
      page.elements["close-log"].on.click();
      expect(page.elements["delete-confirm"].hidden).toBe(true);
      expect(page.elements["delete-pair"].hidden).toBe(true);
      // Pressing confirm once dismissed sends nothing.
      page.elements["delete-yes"].on.click();
      open(page.elements["pair-rows"], "bob ↔ dana");
      page.elements["delete-pair"].on.click();
      page.elements["forget"].on.click();
      expect(page.elements["delete-confirm"].hidden).toBe(true);
      expect(page.elements["delete-pair"].hidden).toBe(true);
      page.elements["delete-yes"].on.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(deletes(page)).toEqual([]);
      expect(stored()).toHaveLength(3);
    });

    it("deletes the pair on the server with the token only in its header, and the sidebar rebuilds from the messages", async () => {
      seedPairs();
      let release!: () => void;
      const hold = new Promise<void>((resolve) => (release = resolve));
      const page = await load(OWNER_TOKEN, (url, method) => (method === "DELETE" ? { hold } : undefined));
      await openReady(page, "bob ↔ colin");
      confirmDelete(page);
      expect(page.elements["delete-yes"].disabled).toBe(true);
      // While it is held, a second press sends nothing.
      page.elements["delete-yes"].on.click();
      expect(deletes(page)).toHaveLength(1);
      const [request] = deletes(page);
      expect(request.url).toBe("/api/conversation?a=bob&b=colin");
      expect(request.headers).toEqual({ Authorization: `Bearer ${OWNER_TOKEN}` });
      expect(request.url).not.toContain(OWNER_TOKEN);
      expect(request.init).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
      expect(request.init.signal).toBeInstanceOf(AbortSignal);
      const reads = () => page.requests.filter((r) => r.url.startsWith("/api/messages")).map((r) => r.url);
      const before = reads().length;
      release();
      await page.until(() => page.elements["log"].hidden && page.elements["pair-rows"].children.length === 1);
      expect(page.elements["delete-yes"].disabled).toBe(false);
      expect(stored()).toEqual([{ f: "bob", t: "dana" }]);
      const res = await fetch(`${base()}/api/messages`, { headers: auth(OWNER_TOKEN) });
      expect((await res.json()).map((m: { from: string; to: string }) => [m.from, m.to])).toEqual([["bob", "dana"]]);
      // The page read the messages again from the start, and kept the other pair's.
      expect(reads().slice(before)).toContain("/api/messages?limit=200&offset=0");
      expect(label(page.elements["pair-rows"].children[0])).toBe("bob ↔ dana");
      open(page.elements["pair-rows"], "bob ↔ dana");
      expect(entries(page.elements["post-rows"])).toEqual([["bob", "hi dana"]]);
      // A new message between them starts the pair again, with only it unread.
      sendMessage(db, OWNER_ACCOUNT, "bob", "colin", "again");
      await page.poll();
      await page.until(() => page.elements["pair-rows"].children.length === 2);
      const again = page.elements["pair-rows"].children.find((row) => label(row) === "bob ↔ colin")!;
      expect(again.children[0].children[1].textContent).toBe("1");
    });

    it("names and counts the pairs that differ only in A-Z case, which the server deletes with it", async () => {
      seedPairs();
      sendMessage(db, OWNER_ACCOUNT, "Bob", "dana", "from the other Bob");
      sendMessage(db, OWNER_ACCOUNT, "Bob", "dana", "and again");
      const page = await load(OWNER_TOKEN);
      await page.until(() => page.elements["pair-rows"].children.length === 3);
      open(page.elements["pair-rows"], "bob ↔ dana");
      await page.until(() => !page.elements["delete-pair"].hidden);
      page.elements["delete-pair"].on.click();
      expect(page.elements["delete-text"].textContent).toBe(
        "Delete the 3 messages between bob and dana, and between Bob and dana? This cannot be undone.",
      );
      page.elements["delete-yes"].on.click();
      await page.until(() => page.elements["log"].hidden && page.elements["pair-rows"].children.length === 1);
      expect(deletes(page).map((r) => r.url)).toEqual(["/api/conversation?a=bob&b=dana"]);
      expect(stored()).toHaveLength(2);
      expect(page.elements["pair-rows"].children.map(label)).toEqual(["bob ↔ colin"]);
      // Both start again with nothing seen when they come back.
      sendMessage(db, OWNER_ACCOUNT, "Bob", "dana", "back");
      await page.poll();
      await page.until(() => page.elements["pair-rows"].children.length === 2);
      const back = page.elements["pair-rows"].children.find((row) => label(row) === "Bob ↔ dana")!;
      expect(back.children[0].children[1].textContent).toBe("1");
    });

    it("keeps a conversation from New message open when a delete started elsewhere answers", async () => {
      seedPairs();
      let release!: () => void;
      const hold = new Promise<void>((resolve) => (release = resolve));
      // An admin person both deletes and sends.
      setPersonAdmin(db, "owner", "colin", true);
      const page = await load(colinToken(), (url, method) => (method === "DELETE" ? { hold } : undefined));
      await openReady(page, "bob ↔ colin");
      confirmDelete(page);
      await page.until(() => !page.elements["new-message"].hidden && page.elements["rows"].children.length === 3);
      page.elements["new-message"].on.click();
      page.elements["new-to"].value = "dana";
      page.elements["new-form"].on.submit({ preventDefault() {} });
      expect(page.elements["compose"].hidden).toBe(false);
      release();
      await page.until(() => page.elements["pair-rows"].children.length === 2 && stored().length === 1);
      expect(page.elements["pair-rows"].children.map(label)).toEqual(["colin ↔ dana", "bob ↔ dana"]);
      expect(page.elements["log"].hidden).toBe(false);
      expect(page.elements["log-title"].textContent).toBe("colin ↔ dana");
      expect(page.elements["log-note"].textContent).toBe("No messages yet.");
      expect(page.elements["compose"].hidden).toBe(false);
      page.send("first");
      await page.until(() => stored().length === 2);
      expect(stored()[1]).toEqual({ f: "colin", t: "dana" });
    });

    it("asks for a token again on a 401", async () => {
      seedPairs();
      const page = await load(OWNER_TOKEN, (url, method) => (method === "DELETE" ? { status: 401 } : undefined));
      await openReady(page, "bob ↔ colin");
      confirmDelete(page);
      await page.until(() => page.elements["status-line"].textContent === "The server refused that token. Enter another.");
      expect(page.store.size).toBe(0);
      expect(page.elements["log"].hidden).toBe(true);
      expect(page.elements["delete-pair"].hidden).toBe(true);
      expect(stored()).toHaveLength(3);
    });

    it("keeps the conversation open with the reason on a refusal", async () => {
      seedPairs();
      for (const [status, note] of [
        [403, "This token cannot delete conversations (403)."],
        [400, "Give a and b once each"],
        [503, "The server is busy (503). Try again in a moment."],
        [500, "The server answered 500."],
      ] as const) {
        const body = status === 400 ? JSON.stringify({ error: { message: note } }) : undefined;
        const page = await load(OWNER_TOKEN, (url, method) => (method === "DELETE" ? { status, body } : undefined));
        await openReady(page, "bob ↔ colin");
        confirmDelete(page);
        await page.until(() => page.elements["delete-note"].textContent === note);
        expect(page.elements["log"].hidden).toBe(false);
        expect(page.elements["log-title"].textContent).toBe("bob ↔ colin");
        expect(page.elements["post-rows"].children).toHaveLength(2);
        expect(page.elements["delete-confirm"].hidden).toBe(true);
        expect(page.elements["delete-pair"].hidden).toBe(false);
        expect(page.elements["delete-yes"].disabled).toBe(false);
        // Opening another conversation clears the note.
        open(page.elements["pair-rows"], "bob ↔ dana");
        expect(page.elements["delete-note"].textContent).toBe("");
      }
      expect(stored()).toHaveLength(3);
    });

    it("with no answer, says the messages may already be deleted and reads them again from the start", async () => {
      seedPairs();
      // The DELETE is taken by the server and its connection then fails.
      const page = await load(OWNER_TOKEN, (url, method) => (method === "DELETE" ? { lose: true } : undefined));
      await openReady(page, "bob ↔ colin");
      const reads = () => page.requests.filter((r) => r.url.startsWith("/api/messages")).map((r) => r.url);
      const before = reads().length;
      confirmDelete(page);
      await page.until(() => page.elements["delete-note"].textContent.startsWith("No answer from the server"));
      expect(page.elements["delete-note"].textContent).toBe("No answer from the server, so the messages may already be deleted. Reading them again.");
      await page.until(() => page.elements["pair-rows"].children.length === 1);
      expect(reads().slice(before)).toContain("/api/messages?limit=200&offset=0");
      expect(stored()).toEqual([{ f: "bob", t: "dana" }]);
      expect(page.elements["post-rows"].children).toEqual([]);
      expect(page.elements["delete-pair"].hidden).toBe(true);
    });

    it("with no answer, keeps the open conversation's status line through the polls that read it again", async () => {
      seedPairs();
      setStatus(db, OWNER_ACCOUNT, identityOf(db, OWNER_ACCOUNT, "bob")!, "reading Linear");
      const page = await load(OWNER_TOKEN, (url, method) => (method === "DELETE" ? { lose: true } : undefined));
      await openReady(page, "bob ↔ colin");
      expect(page.elements["log-status"].textContent).toBe("bob: reading Linear");
      confirmDelete(page);
      // The messages were deleted, so the read brings none back for the open pair, and it stays out of the sidebar.
      await page.until(() => page.elements["pair-rows"].children.length === 1 && page.scheduled());
      await page.poll();
      await page.until(page.scheduled);
      expect(page.elements["log-title"].textContent).toBe("bob ↔ colin");
      expect(page.elements["log-status"].hidden).toBe(false);
      expect(page.elements["log-status"].textContent).toBe("bob: reading Linear");
    });
  });

  describe("with a person token", () => {
    // maria's own token, as `message-cp token add owner --person maria` makes it, in an account where dana is a person too.
    let maria: string;
    const seedPeople = () => {
      seed();
      addPerson(db, "owner", "maria");
      addPerson(db, "owner", "dana");
      sendMessage(db, OWNER_ACCOUNT, "bob", "maria", "hi @maria");
      maria = addToken(db, "owner", false, false, undefined, "maria").token;
    };
    const ready = async (page: Awaited<ReturnType<typeof load>>) => {
      await page.until(
        () => !page.elements["new-message"].hidden && page.elements["new-from"].children.length > 0 && page.elements["pair-rows"].children.length === 2,
      );
    };
    const names = (select: Stub) => select.children.map((o) => o.value);

    it("names the token's person above the compose box, and posts and replies only as them", async () => {
      seedPeople();
      const page = await load(maria);
      await ready(page);
      open(page.elements["channel-rows"], "build");
      expect(page.elements["writer"].hidden).toBe(false);
      expect(page.elements["as-note"].textContent).toBe("Posting as maria");
      expect(page.elements["compose"].hidden).toBe(false);
      expect(page.elements["compose-label"].textContent).toBe("Post in #build as maria");
      const rows = page.elements["post-rows"];
      await page.until(() => rows.children.length === 1);
      page.send("from maria");
      await page.until(() => rows.children.length === 2);
      // A pair that is not maria's offers no compose box, and names no one.
      open(page.elements["pair-rows"], "bob ↔ colin");
      expect(page.elements["compose"].hidden).toBe(true);
      expect(page.elements["as-note"].textContent).toBe("");
      expect(page.elements["delete-pair"].hidden).toBe(true);
      open(page.elements["pair-rows"], "bob ↔ maria");
      expect(page.elements["as-note"].textContent).toBe("Posting as maria");
      expect(page.elements["compose-label"].textContent).toBe("Reply to bob as maria");
      // A person token cannot delete a conversation, so the button never shows, even in the person's own.
      await page.poll();
      expect(page.elements["delete-pair"].hidden).toBe(true);
      // maria's name in a message is marked as hers.
      const mention = page.elements["post-rows"].children[0].children
        .find((c) => c.className === "body")!
        .children.find((c) => c.className.startsWith("mention"))!;
      expect(mention.className).toBe("mention me");
      page.send("on it");
      await page.until(() => page.posts().length === 2);
      expect(page.posts().map((r) => [r.url, JSON.parse(r.body!)])).toEqual([
        ["/api/post", { as: "maria", channel: "build", body: "from maria" }],
        ["/api/send", { as: "maria", to: "bob", body: "on it" }],
      ]);
      await page.until(() => db.prepare("SELECT COUNT(*) AS n FROM messages WHERE body = 'on it'").get()!.n === 1);
      expect(db.prepare("SELECT sender FROM channel_posts WHERE body = 'from maria'").all()).toEqual([{ sender: "maria" }]);
      expect(db.prepare("SELECT sender FROM messages WHERE body = 'on it'").all()).toEqual([{ sender: "maria" }]);
      // The name came from GET /api/token and reached the page only as text.
      for (const stub of page.made) expect(stub.html).toEqual([]);
    });

    it("offers only the token's person, already chosen, under From in New message and New channel", async () => {
      seedPeople();
      const page = await load(maria);
      await ready(page);
      page.elements["new-message"].on.click();
      expect(names(page.elements["new-from"])).toEqual(["maria"]);
      expect(page.elements["new-from"].value).toBe("maria");
      // Choosing another by hand opens nothing.
      page.elements["new-from"].value = "dana";
      page.elements["new-to"].value = "bob";
      page.elements["new-form"].on.submit({ preventDefault() {} });
      expect(page.elements["log"].hidden).toBe(true);
      page.elements["new-from"].value = "maria";
      page.elements["new-from"].on.change();
      page.elements["new-to"].value = "dana";
      page.elements["new-form"].on.submit({ preventDefault() {} });
      expect(page.elements["log-title"].textContent).toBe("dana ↔ maria");
      expect(page.elements["compose-label"].textContent).toBe("Reply to dana as maria");
      page.elements["new-channel"].on.click();
      expect(names(page.elements["channel-from"])).toEqual(["maria"]);
      expect(page.elements["channel-from"].value).toBe("maria");
      // Another person set by hand under From is refused before anything is sent.
      page.elements["channel-from"].value = "dana";
      page.elements["channel-name"].value = "launch";
      page.elements["channel-body"].value = "first";
      page.elements["channel-form"].on.submit({ preventDefault() {} });
      expect(page.elements["channel-note"].textContent).toBe("Choose who you are under From.");
      expect(page.posts()).toEqual([]);
      page.elements["channel-from"].value = "maria";
      page.elements["channel-form"].on.submit({ preventDefault() {} });
      await page.until(() => page.elements["log-title"].textContent === "launch");
      expect(page.posts().map((r) => JSON.parse(r.body!))).toEqual([{ as: "maria", channel: "launch", body: "first" }]);
      expect(page.elements["as-note"].textContent).toBe("Posting as maria");
    });

    it("posts as no one once the person is removed, and asks for another token when the server refuses this one", async () => {
      seedPeople();
      const page = await load(maria);
      await ready(page);
      open(page.elements["channel-rows"], "build");
      expect(page.elements["compose"].hidden).toBe(false);
      await page.until(() => page.elements["post-rows"].children.length === 1 && page.scheduled());
      removePerson(db, "owner", "maria");
      // A person token whose person GET /api/agents no longer lists posts as no one. (The server refuses a removed
      // person's token everywhere, so this page reads with a read-only token and is told it holds maria's.)
      const unlisted = await load(viewer, (url) =>
        url === "/api/token" ? { status: 200, body: '{"readOnly":false,"agentOnly":false,"person":"maria"}' } : undefined,
      );
      await unlisted.until(() => unlisted.elements["channel-rows"].children.length === 1 && !unlisted.elements["new-message"].hidden);
      open(unlisted.elements["channel-rows"], "build");
      expect(unlisted.elements["compose"].hidden).toBe(true);
      expect(unlisted.elements["as-note"].textContent).toBe("");
      unlisted.elements["new-message"].on.click();
      expect(unlisted.elements["new-note"].textContent).toBe("maria is no longer a person in this account.");
      expect(unlisted.elements["new-fields"].hidden).toBe(true);
      unlisted.send("should not go");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unlisted.posts()).toEqual([]);
      // The real server refuses the token of a removed person, and the page forgets it and its person.
      await page.poll();
      await page.until(() => page.elements["status-line"].textContent === "The server refused that token. Enter another.");
      expect(page.store.has("message-cp-token")).toBe(false);
      expect(page.elements["compose"].hidden).toBe(true);
      expect(page.elements["as-note"].textContent).toBe("");
      expect(page.elements["new-message"].hidden).toBe(true);
    });

    it("gives a full token no choice of person, but Delete, in a pair of any of them", async () => {
      seedPeople();
      const page = await load(OWNER_TOKEN);
      await page.until(() => page.elements["pair-rows"].children.length === 2 && page.scheduled());
      expect(page.elements["new-message"].hidden).toBe(true);
      page.elements["new-message"].on.click();
      expect(names(page.elements["new-from"])).toEqual([]);
      open(page.elements["pair-rows"], "bob ↔ maria");
      await page.until(() => !page.elements["delete-pair"].hidden);
      expect(page.elements["compose"].hidden).toBe(true);
      expect(page.elements["as-note"].textContent).toContain("message-cp login-link");
    });

    it("shows Delete to an admin person's token as to a full token, follows the mark at the next token check, and deletes", async () => {
      seedPeople();
      setPersonAdmin(db, "owner", "maria", true);
      const page = await load(maria);
      await ready(page);
      // Any open pair with messages, not only the person's own, as a full token sees it.
      open(page.elements["pair-rows"], "bob ↔ colin");
      await page.until(() => !page.elements["delete-pair"].hidden);
      page.elements["delete-pair"].on.click();
      page.elements["delete-yes"].on.click();
      await page.until(() => db.prepare("SELECT COUNT(*) AS n FROM messages WHERE body = 'hi colin'").get()!.n === 0);
      const [request] = page.requests.filter((r) => r.method === "DELETE");
      expect(request.url).toBe("/api/conversation?a=bob&b=colin");
      expect(db.prepare("SELECT sender, body FROM messages").all()).toEqual([{ sender: "bob", body: "hi @maria" }]);
      // Forgetting the admin's token and entering a plain person token on the same page shows no Delete.
      const dana = addToken(db, "owner", false, false, undefined, "dana").token;
      page.elements["forget"].on.click();
      expect(page.elements["delete-pair"].hidden).toBe(true);
      page.elements["token"].value = dana;
      page.elements["login"].on.submit({ preventDefault() {} } as never);
      await page.until(() => !page.elements["new-message"].hidden && page.elements["pair-rows"].children.length === 1);
      open(page.elements["pair-rows"], "bob ↔ maria");
      await page.poll();
      expect(page.elements["delete-pair"].hidden).toBe(true);
      // Unmarked, the same token is a plain person token once the page asks again: no Delete, even in maria's own pair.
      setPersonAdmin(db, "owner", "maria", false);
      const plain = await load(maria);
      await plain.until(() => !plain.elements["new-message"].hidden && plain.elements["pair-rows"].children.length === 1);
      open(plain.elements["pair-rows"], "bob ↔ maria");
      await plain.poll();
      expect(plain.elements["delete-pair"].hidden).toBe(true);
    });
  });

  it("never sends as a name GET /api/agents did not give as a person", async () => {
    seed();
    // GET /api/token is stubbed to name bob, an agent, as the token's person.
    const page = await load(colinToken(), (url) =>
      url === "/api/token" ? { status: 200, body: '{"readOnly":false,"agentOnly":false,"person":"bob"}' } : undefined,
    );
    await page.until(() => page.elements["channel-rows"].children.length === 1 && !page.elements["new-message"].hidden);
    open(page.elements["channel-rows"], "build");
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

describe("the page's invites", () => {
  // A stub DOM element, as in the approved clients tests above, with select() for the link field.
  interface Stub {
    on: Record<string, () => void>;
    hidden: boolean;
    disabled?: boolean;
    checked?: boolean;
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
    setAttribute(name: string, value: string): void;
    focus(): void;
    select(): void;
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
    setAttribute() {},
    focus() {},
    select() {},
  });
  const text = (node: Stub): string => (node.children.length > 0 ? node.children.map(text).join("") : node.textContent);
  const field = (row: Stub, name: string) => {
    const node = row.children.find((c) => c.className === name);
    return node && text(node);
  };
  const submit = (form: Stub) => form.on.submit({ preventDefault() {} });

  let ana: number;
  let anaToken: string;
  beforeEach(() => {
    addPerson(db, "owner", "ana", true);
    ana = db.prepare("SELECT id FROM agents WHERE name = 'ana'").pluck().get() as number;
    anaToken = addToken(db, "owner", false, false, undefined, "ana").token;
  });

  // Runs the served script with the given token, as the approved clients tests do. refuse, when it returns a status,
  // answers a request with that status; "hang" answers only by failing when it is aborted, "fail" rejects, "held" waits
  // for release() to answer as the server does, a { status, reason, retry } answers with that error, and a { rewrite }
  // answers with the server's own JSON answer passed through it.
  type Refusal = number | "hang" | "fail" | "held" | "junk" | { status: number; reason: string; retry?: boolean } | { rewrite: (body: any) => unknown };
  async function load(token: string, refuse: (url: string, init: RequestInit) => Refusal | undefined = () => undefined, server = base) {
    const html = await (await fetch(`${server()}/`)).text();
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
    const elements: Record<string, Stub> = {};
    const requests: { url: string; method: string; body: unknown }[] = [];
    const timers = handTimers();
    const store = new Map([["message-cp-token", token]]);
    const held: (() => void)[] = [];
    const copied: string[] = [];
    runInNewContext(script, {
      AbortController,
      URL,
      location: { hash: "", pathname: "/", search: "", href: "https://dash.example/team/?x=1#y" },
      history: { replaceState() {} },
      navigator: { clipboard: { writeText: async (t: string) => void copied.push(t) } },
      addEventListener() {},
      URLSearchParams,
      document: { getElementById: (id: string) => (elements[id] ??= el()), createElement: el, addEventListener() {} },
      sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
      setTimeout: timers.set,
      clearTimeout: timers.clear,
      fetch: (url: string, init: RequestInit) => {
        requests.push({ url, method: init.method ?? "GET", body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
        const status = refuse(url, init);
        if (status === "hang") return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))));
        if (status === "held") return new Promise<Response>((resolve) => held.push(() => resolve(fetch(`${server()}${url}`, { ...init, signal: undefined }))));
        if (status === "junk") return Promise.resolve(new Response("not json", { status: 200 }));
        if (status === "fail") return Promise.reject(new TypeError("fetch failed"));
        if (typeof status === "object" && "rewrite" in status) {
          return fetch(`${server()}${url}`, init).then(async (res) => new Response(JSON.stringify(status.rewrite(await res.json())), { status: res.status }));
        }
        if (typeof status === "object") {
          const body = JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: status.reason }, id: null });
          return Promise.resolve(new Response(body, { status: status.status, headers: status.retry ? { "Retry-After": "1" } : {} }));
        }
        return status === undefined ? fetch(`${server()}${url}`, init) : Promise.resolve(new Response(null, { status }));
      },
    });
    const until = async (done: () => boolean) => {
      for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(done()).toBe(true);
    };
    const entry = () => elements["invite-entry"].children[0]?.children[0] as Stub | undefined;
    const openInvites = async () => {
      await until(() => entry() !== undefined);
      entry()!.on.click();
      await until(() => elements["log-note"].textContent !== "Loading…" && timers.scheduled());
    };
    const release = () => held.splice(0).forEach((answer) => answer());
    // The page's own writes to /api, without the sign-in to the approval page that an https address also sends.
    const writes = () => requests.filter((r) => r.method !== "GET" && r.url.startsWith("/api/"));
    return { elements, requests, writes, store, until, poll: timers.poll, deadlines: timers.deadlines, entry, openInvites, held, release, copied };
  }
  type Page = Awaited<ReturnType<typeof load>>;
  const rows = (page: Page) => page.elements["post-rows"].children.map((r) => [field(r, "from"), field(r, "time"), field(r, "body")]);
  const at = (iso: string) => new Date(iso).toLocaleString();
  const codeOf = (link: string) => new URL(link).hash.slice("#code=".length);
  // Whether a string appears anywhere on the page, other than in the link field.
  const onPage = (page: Page, secret: string) =>
    Object.entries(page.elements).some(
      ([id, node]) => id !== "invite-link" && JSON.stringify(node, (k, v) => (k === "on" ? undefined : v)).includes(secret),
    );

  it("shows the People entry to an admin person only, never to a plain person, the full token or a read-only token", async () => {
    addPerson(db, "owner", "maria");
    const plain = addToken(db, "owner", false, false, undefined, "maria").token;
    for (const token of [plain, OWNER_TOKEN, viewer]) {
      const page = await load(token);
      await page.until(() => page.elements["approval-entry"].children.length === 1 && page.requests.some((r) => r.url === "/api/token"));
      await page.poll();
      expect(page.elements["people-head"].hidden).toBe(true);
      expect(page.entry()).toBeUndefined();
      expect(page.requests.filter((r) => r.url.startsWith("/api/invites") || r.url.startsWith("/api/people"))).toEqual([]);
    }
    const page = await load(anaToken);
    await page.until(() => page.entry() !== undefined);
    expect(page.elements["people-head"].hidden).toBe(false);
    expect(page.entry()!.children.map((c) => c.textContent)).toEqual(["People", ""]);
    // Until the view is opened, the people and invites are not read.
    expect(page.requests.filter((r) => r.url.startsWith("/api/invites") || r.url.startsWith("/api/people"))).toEqual([]);
  });

  it("lists this account's unused invites newest first, without codes, and never another account's", async () => {
    addPerson(db, "owner", "ben");
    const first = makeInvite(db, OWNER_ACCOUNT, ana, "ben")!.invite;
    const second = makeInvite(db, OWNER_ACCOUNT, ana, "ana")!.invite;
    const used = makeInvite(db, OWNER_ACCOUNT, ana, "ben")!.invite;
    redeemLoginCode(db, used.code);
    addAccount(db, "other");
    const otherId = listAccounts(db).find((a) => a.name === "other")!.id;
    addPerson(db, "other", "olga", true);
    const olga = db.prepare("SELECT id FROM agents WHERE name = 'olga'").pluck().get() as number;
    const theirs = makeInvite(db, otherId, olga, "olga")!.invite;

    const page = await load(anaToken);
    await page.openInvites();
    expect(page.elements["log-title"].textContent).toBe("People");
    expect(page.elements["invite-forms"].hidden).toBe(false);
    const made = (id: number) => at(new Date(db.prepare("SELECT created_at FROM login_codes WHERE id = ?").pluck().get(id) as number).toISOString());
    expect(rows(page)).toEqual([
      ["ana", `made ${made(second.id)}`, `expires ${at(new Date(second.expiresAt).toISOString())}`],
      ["ben", `made ${made(first.id)}`, `expires ${at(new Date(first.expiresAt).toISOString())}`],
    ]);
    // The entry counts the account's people, ana and ben.
    expect(page.entry()!.children.map((c) => c.textContent)).toEqual(["People", "2"]);
    for (const code of [first.code, second.code, theirs.code]) expect(onPage(page, code)).toBe(false);
    expect(onPage(page, "olga")).toBe(false);
    // The New link select offers the account's people.
    expect(page.elements["link-person"].children.map((o) => o.value)).toEqual(["", "ana", "ben"]);
  });

  it("adds a person, plain or admin, shows the server's link once with the 7 days, and drops it when the view closes", async () => {
    await http.close();
    http = await startHttp(db, { token: OWNER_TOKEN, port: 0, publicUrl: "https://chat.example" });
    const page = await load(anaToken);
    await page.openInvites();
    page.elements["person-name"].value = "ben";
    page.elements["person-kind"].value = "admin";
    submit(page.elements["person-form"]);
    await page.until(() => page.elements["person-note"].textContent === "Added ben.");
    expect(page.writes()).toEqual([{ url: "/api/people", method: "POST", body: { name: "ben", admin: true } }]);
    const ben = db.prepare("SELECT admin FROM agents WHERE name = 'ben' AND person = 1").get() as { admin: number };
    expect(ben.admin).toBe(1);
    const link = page.elements["invite-link"].value;
    expect(link).toMatch(/^https:\/\/chat\.example\/#code=/);
    expect(page.elements["invite-made"].hidden).toBe(false);
    expect(page.elements["invite-for"].textContent).toContain("Invite link for ben (admin).");
    expect(page.elements["invite-for"].textContent).toContain("It works once and lasts 7 days");
    expect(page.elements["person-name"].value).toBe("");
    expect(page.elements["person-kind"].value).toBe("plain");
    // The link is only in its field: nowhere else on the page, nor stored.
    expect(onPage(page, codeOf(link))).toBe(false);
    expect([...page.store.values()].join()).not.toContain(codeOf(link));
    // Copy puts it on the clipboard.
    page.elements["invite-copy"].on.click();
    await page.until(() => page.elements["copy-note"].textContent === "Copied.");
    expect(page.copied).toEqual([link]);
    // The list shows ben's invite with the next read, and opening the link signs in as ben.
    await page.until(() => rows(page).some((r) => r[0] === "ben"));
    // Leaving the view drops the link.
    page.elements["close-log"].on.click();
    expect(page.elements["invite-link"].value).toBe("");
    expect(page.elements["invite-made"].hidden).toBe(true);
    expect(page.elements["invite-for"].textContent).toBe("");
    const res = await fetch(`${base()}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: codeOf(link) }) });
    expect(res.status).toBe(200);
    // A plain person, by default.
    await page.openInvites();
    page.elements["person-name"].value = "cat";
    submit(page.elements["person-form"]);
    await page.until(() => page.elements["person-note"].textContent === "Added cat.");
    expect(page.writes()[1]).toEqual({ url: "/api/people", method: "POST", body: { name: "cat", admin: false } });
    expect(page.elements["invite-for"].textContent).toContain("Invite link for cat. ");
  });

  it("builds the link from the page's own address when serve has no public URL", async () => {
    const page = await load(anaToken);
    await page.openInvites();
    page.elements["person-name"].value = "ben";
    submit(page.elements["person-form"]);
    await page.until(() => page.elements["person-note"].textContent === "Added ben.");
    const link = page.elements["invite-link"].value;
    // The page's address, without its query or fragment, with the code in the fragment.
    expect(link).toMatch(/^https:\/\/dash\.example\/team\/#code=[^&?#]+$/);
    const res = await fetch(`${base()}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: codeOf(link) }) });
    expect(res.status).toBe(200);
  });

  it("makes a new link for an existing person, and cancels an invite after asking, saying whose it was", async () => {
    addPerson(db, "owner", "ben");
    const page = await load(anaToken);
    await page.openInvites();
    page.elements["link-person"].value = "ben";
    submit(page.elements["link-form"]);
    await page.until(() => page.elements["invite-link"].value !== "");
    expect(page.writes()).toEqual([{ url: "/api/invites", method: "POST", body: { person: "ben" } }]);
    expect(page.elements["invite-for"].textContent).toContain("Invite link for ben.");
    await page.until(() => rows(page).length === 1);
    const id = (db.prepare("SELECT id FROM login_codes WHERE invite = 1").pluck().get() as number);
    // Cancel asks first; nothing is sent until it is confirmed, and Keep it sends nothing.
    const cancelButton = () => page.elements["post-rows"].children[0].children.find((c) => c.textContent === "Cancel")!;
    cancelButton().on.click();
    expect(page.elements["cancel-confirm"].hidden).toBe(false);
    expect(page.elements["cancel-text"].textContent).toMatch(/^Cancel ben's invite, made .+\? Its link will stop working\.$/);
    page.elements["cancel-no"].on.click();
    expect(page.elements["cancel-confirm"].hidden).toBe(true);
    expect(page.writes()).toHaveLength(1);
    cancelButton().on.click();
    page.elements["cancel-yes"].on.click();
    await page.until(() => page.elements["cancel-note"].textContent === "Cancelled ben's invite.");
    expect(page.writes()[1]).toEqual({ url: `/api/invites?id=${id}`, method: "DELETE", body: undefined });
    await page.until(() => page.elements["log-note"].textContent === NO_INVITES);
    expect(rows(page)).toEqual([]);
    // Cancelling again: the server says no such invite.
    const res = await fetch(`${base()}/api/invites?id=${id}`, { method: "DELETE", headers: auth(anaToken) });
    expect(res.status).toBe(404);
  });

  it("says each refusal in plain words in the form's note", async () => {
    addPerson(db, "owner", "ben");
    let next: Refusal | undefined;
    const page = await load(anaToken, (url, init) => (init.method === "POST" || init.method === "DELETE" ? next : undefined));
    await page.openInvites();
    const add = async (answer: Refusal | undefined, said: string) => {
      next = answer;
      page.elements["person-name"].value = "ben";
      submit(page.elements["person-form"]);
      await page.until(() => page.elements["person-note"].textContent === said);
    };
    // The server's own 400: the name is taken.
    await add(undefined, "The name 'ben' is already used by a person in account 'owner'.");
    await add({ status: 400, reason: "'all' is reserved" }, "'all' is reserved");
    await add({ status: 503, reason: "Database busy", retry: true }, "The server is busy (503). Try again in a moment.");
    await add({ status: 503, reason: "Too many requests" }, "The server is busy (503). Try again in a moment.");
    const many = "This account has made 100 invites in the last 7 days; try again once some expire.";
    await add({ status: 503, reason: many }, many);
    await add("fail", "No answer from the server, so ben may have been added: the agents panel and the invites below show whether.");
    next = "hang";
    submit(page.elements["person-form"]);
    await page.until(() => page.deadlines.size > 0 && page.elements["person-note"].textContent === "Adding…");
    expect(page.elements["person-add"].disabled).toBe(true);
    for (const [, fn] of page.deadlines) fn();
    await page.until(() => page.elements["person-note"].textContent.startsWith("The server did not answer in time, so ben may have been added"));
    expect(page.elements["person-add"].disabled).toBe(false);

    next = 404;
    page.elements["link-person"].value = "ben";
    submit(page.elements["link-form"]);
    await page.until(() => page.elements["link-note"].textContent === "ben is not a person in this account now (404).");
    next = "fail";
    submit(page.elements["link-form"]);
    await page.until(() => page.elements["link-note"].textContent === "No answer from the server, so a link for ben may have been made: the invites below show whether.");

    // No invite is ever shown by a refusal.
    expect(page.elements["invite-made"].hidden).toBe(true);
    expect(page.elements["invite-link"].value).toBe("");
  });

  it("says a cancelled invite that is gone is gone, and a busy server is busy", async () => {
    addPerson(db, "owner", "ben");
    makeInvite(db, OWNER_ACCOUNT, ana, "ben");
    let next: Refusal | undefined;
    const page = await load(anaToken, (url, init) => (init.method === "DELETE" ? next : undefined));
    await page.openInvites();
    await page.until(() => rows(page).length === 1);
    const cancelOne = async (answer: Refusal | undefined, said: string) => {
      next = answer;
      page.elements["post-rows"].children[0].children.find((c) => c.textContent === "Cancel")!.on.click();
      page.elements["cancel-yes"].on.click();
      await page.until(() => page.elements["cancel-note"].textContent === said);
    };
    await cancelOne({ status: 503, reason: "Database busy", retry: true }, "The server is busy (503). Try again in a moment.");
    await cancelOne(404, "ben's invite was already used, cancelled or expired (404).");
    await cancelOne("fail", "No answer from the server, so ben's invite may have been cancelled: the list below shows whether.");
  });

  it("takes the shown link away once its own invite is cancelled, but not for another invite", async () => {
    addPerson(db, "owner", "ben");
    makeInvite(db, OWNER_ACCOUNT, ana, "ben");
    const page = await load(anaToken);
    await page.openInvites();
    page.elements["link-person"].value = "ben";
    submit(page.elements["link-form"]);
    await page.until(() => page.elements["invite-link"].value !== "");
    await page.until(() => rows(page).length === 2);
    const cancelRow = async (row: number) => {
      page.elements["post-rows"].children[row].children.find((c) => c.textContent === "Cancel")!.on.click();
      page.elements["cancel-yes"].on.click();
      await page.until(() => page.elements["cancel-note"].textContent === "Cancelled ben's invite.");
    };
    // The older invite, listed second, is not the one shown: its link stays.
    await cancelRow(1);
    await page.until(() => rows(page).length === 1);
    expect(page.elements["invite-made"].hidden).toBe(false);
    expect(page.elements["invite-link"].value).not.toBe("");
    page.elements["cancel-note"].textContent = "";
    await cancelRow(0);
    expect(page.elements["invite-made"].hidden).toBe(true);
    expect(page.elements["invite-link"].value).toBe("");
    expect(page.elements["invite-for"].textContent).toBe("");
  });

  it("shows no link from an answer that comes after the server said the person is no longer an admin", async () => {
    addPerson(db, "owner", "ben");
    let hold = false;
    let demoted = false;
    const page = await load(anaToken, (url, init) => {
      if (hold && init.method === "POST") return "held";
      if (demoted && url.startsWith("/api/invites") && (init.method ?? "GET") === "GET") return { status: 403, reason: "Forbidden" };
      return undefined;
    });
    await page.openInvites();
    hold = true;
    page.elements["link-person"].value = "ben";
    submit(page.elements["link-form"]);
    await page.until(() => page.held.length === 1);
    demoted = true;
    await page.poll();
    await page.until(() => page.elements["log-note"].textContent.startsWith("The server says you are no longer an admin"));
    hold = false;
    page.release();
    await page.until(() => db.prepare("SELECT 1 FROM login_codes WHERE invite = 1").get() !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(page.elements["invite-link"].value).toBe("");
    expect(page.elements["invite-made"].hidden).toBe(true);
  });

  it("hides the controls once the server says the person is no longer an admin", async () => {
    addPerson(db, "owner", "ben");
    const page = await load(anaToken);
    await page.openInvites();
    setPersonAdmin(db, "owner", "ana", false);
    page.elements["person-name"].value = "ben2";
    submit(page.elements["person-form"]);
    await page.until(() => page.elements["log-note"].textContent.startsWith("The server says you are no longer an admin"));
    expect(page.elements["invite-forms"].hidden).toBe(true);
    expect(page.elements["people-head"].hidden).toBe(true);
    expect(page.entry()).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM agents WHERE name = 'ben2'").get()).toBeUndefined();
    // The next poll does not read the invites again.
    const before = page.requests.length;
    await page.poll();
    await page.until(() => page.requests.length > before && page.requests.slice(before).some((r) => r.url.startsWith("/api/messages")));
    expect(page.requests.slice(before).filter((r) => r.url.startsWith("/api/invites"))).toEqual([]);
  });

  it("drops an answer that comes after the view closed or the token was forgotten, leaving no link on the page", async () => {
    let hold = false;
    const page = await load(anaToken, (url, init) => (hold && init.method === "POST" ? "held" : undefined));
    await page.openInvites();
    for (const leave of ["close", "forget"]) {
      hold = true;
      page.elements["person-name"].value = leave === "close" ? "ben" : "cat";
      submit(page.elements["person-form"]);
      await page.until(() => page.held.length === 1);
      if (leave === "close") page.elements["close-log"].on.click();
      else page.elements["forget"].on.click();
      hold = false;
      page.release();
      // The server added them, but the page shows nothing of it.
      await page.until(() => db.prepare("SELECT 1 FROM agents WHERE name = ?").get(leave === "close" ? "ben" : "cat") !== undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(page.elements["invite-link"].value).toBe("");
      expect(page.elements["invite-made"].hidden).toBe(true);
      expect(page.elements["person-note"].textContent).toBe("");
      if (leave === "close") {
        // Add is enabled again for the next submit.
        expect(page.elements["person-add"].disabled).toBe(false);
        await page.openInvites();
      }
    }
    expect(page.elements["person-add"].disabled).toBe(false);
    expect(page.entry()).toBeUndefined();
  });

  describe("its people list", () => {
    const personRows = (page: Page) =>
      page.elements["people-rows"].children.map((r) => r.children.map((c) => c.textContent));
    const button = (page: Page, name: string, label: string) =>
      page.elements["people-rows"].children.find((r) => r.children[0].textContent === name)!.children.find((c) => c.textContent === label)!;
    const adminOf = (name: string) => db.prepare("SELECT admin FROM agents WHERE name = ? AND removed_at IS NULL").pluck().get(name);

    it("lists the account's people by name with their role, offering no button on the token's own row and nobody from another account", async () => {
      addPerson(db, "owner", "ben");
      addPerson(db, "owner", "cy", true);
      addAccount(db, "other");
      addPerson(db, "other", "olga", true);
      const page = await load(anaToken);
      await page.openInvites();
      await page.until(() => personRows(page).length === 3);
      expect(personRows(page)).toEqual([
        ["ana", "admin", "you"],
        ["ben", "person", "Make admin", "Remove"],
        ["cy", "admin", "Remove admin", "Remove"],
      ]);
      expect(page.requests.some((r) => r.url.startsWith("/api/people?") && r.method === "GET")).toBe(true);
      expect(onPage(page, "olga")).toBe(false);
      expect(page.entry()!.children.map((c) => c.textContent)).toEqual(["People", "3"]);
    });

    it("marks and unmarks a person with PATCH /api/people, saying so and reading the list again", async () => {
      addPerson(db, "owner", "ben");
      const page = await load(anaToken);
      await page.openInvites();
      await page.until(() => personRows(page).length === 2);
      button(page, "ben", "Make admin").on.click();
      await page.until(() => page.elements["people-note"].textContent === "ben is now an admin.");
      expect(page.writes()).toEqual([{ url: "/api/people?name=ben", method: "PATCH", body: { admin: true } }]);
      expect(adminOf("ben")).toBe(1);
      await page.until(() => personRows(page)[1][1] === "admin");
      button(page, "ben", "Remove admin").on.click();
      await page.until(() => page.elements["people-note"].textContent === "ben is no longer an admin.");
      expect(page.writes()[1]).toEqual({ url: "/api/people?name=ben", method: "PATCH", body: { admin: false } });
      expect(adminOf("ben")).toBe(0);
      await page.until(() => personRows(page)[1][1] === "person");
    });

    it("removes a person only after asking, and says what it deleted from the answer's counts", async () => {
      addPerson(db, "owner", "ben");
      registerAgent(db, OWNER_ACCOUNT, "bot", "");
      for (const body of ["a", "b", "c"]) sendMessage(db, OWNER_ACCOUNT, "bot", "ben", body);
      const bot = { ...identityOf(db, OWNER_ACCOUNT, "bot")!, name: "bot" };
      joinChannel(db, OWNER_ACCOUNT, bot, "general");
      post(db, OWNER_ACCOUNT, bot, "general", "hi @ben");
      const page = await load(anaToken);
      await page.openInvites();
      await page.until(() => personRows(page).length === 2);
      button(page, "ben", "Remove").on.click();
      expect(page.elements["remove-confirm"].hidden).toBe(false);
      expect(page.elements["remove-text"].textContent).toBe(
        "Remove ben? This cannot be undone: it deletes their direct messages and mentions.",
      );
      // Keep them sends nothing.
      page.elements["remove-no"].on.click();
      expect(page.elements["remove-confirm"].hidden).toBe(true);
      expect(page.writes()).toEqual([]);
      button(page, "ben", "Remove").on.click();
      page.elements["remove-yes"].on.click();
      await page.until(() => page.elements["people-note"].textContent === "Removed ben: 3 messages and 1 mention deleted.");
      expect(page.writes()).toEqual([{ url: "/api/people?name=ben", method: "DELETE", body: undefined }]);
      expect(page.elements["remove-confirm"].hidden).toBe(true);
      expect(adminOf("ben")).toBeUndefined();
      await page.until(() => personRows(page).length === 1);
      // No message body is shown.
      expect(onPage(page, "hi @ben")).toBe(false);
    });

    it("reads the account's messages again from the start after a removal, so a later message is not skipped", async () => {
      addPerson(db, "owner", "ben");
      registerAgent(db, OWNER_ACCOUNT, "bot", "");
      registerAgent(db, OWNER_ACCOUNT, "eve", "");
      for (const body of ["a", "b", "c"]) sendMessage(db, OWNER_ACCOUNT, "bot", "ben", body);
      sendMessage(db, OWNER_ACCOUNT, "bot", "eve", "first");
      const page = await load(anaToken);
      await page.openInvites();
      await page.until(() => personRows(page).length === 2 && page.elements["pair-rows"].children.length === 2);
      button(page, "ben", "Remove").on.click();
      page.elements["remove-yes"].on.click();
      await page.until(() => page.elements["people-note"].textContent === "Removed ben: 3 messages and 0 mentions deleted.");
      // bot and eve's next message is read, though the three rows before it were deleted, and ben's pair is gone.
      sendMessage(db, OWNER_ACCOUNT, "eve", "bot", "second");
      for (let i = 0; i < 5 && !page.requests.some((r) => r.url.startsWith("/api/messages?") && r.url.includes("offset=0")); i++) await page.poll();
      await page.poll();
      await page.until(() => page.elements["pair-rows"].children.length === 1);
      expect(text(page.elements["pair-rows"])).not.toContain("ben");
      page.elements["pair-rows"].children[0].children[0].on.click();
      await page.until(() => page.elements["post-rows"].children.length === 2);
      expect(page.elements["post-rows"].children.map((r) => field(r, "body"))).toEqual(["first", "second"]);
    });

    it("reads the account's messages again from the start when another admin removed the person first (404)", async () => {
      addPerson(db, "owner", "ben");
      registerAgent(db, OWNER_ACCOUNT, "bot", "");
      registerAgent(db, OWNER_ACCOUNT, "eve", "");
      for (const body of ["a", "b", "c"]) sendMessage(db, OWNER_ACCOUNT, "bot", "ben", body);
      sendMessage(db, OWNER_ACCOUNT, "bot", "eve", "first");
      const page = await load(anaToken);
      await page.openInvites();
      await page.until(() => personRows(page).length === 2 && page.elements["pair-rows"].children.length === 2);
      button(page, "ben", "Remove").on.click();
      // Another admin removes ben, and his messages with him, before this tab's Remove is pressed.
      removePerson(db, "owner", "ben");
      page.elements["remove-yes"].on.click();
      await page.until(() => page.elements["people-note"].textContent === "ben is already gone (404).");
      sendMessage(db, OWNER_ACCOUNT, "eve", "bot", "second");
      for (let i = 0; i < 5 && !page.requests.some((r) => r.url.startsWith("/api/messages?") && r.url.includes("offset=0")); i++) await page.poll();
      await page.poll();
      await page.until(() => page.elements["pair-rows"].children.length === 1);
      expect(text(page.elements["pair-rows"])).not.toContain("ben");
      page.elements["pair-rows"].children[0].children[0].on.click();
      await page.until(() => page.elements["post-rows"].children.length === 2);
      expect(page.elements["post-rows"].children.map((r) => field(r, "body"))).toEqual(["first", "second"]);
    });

    it("says each answer in the list's note, and reads the list again after a 200, 404 or no answer", async () => {
      addPerson(db, "owner", "ben");
      let next: Refusal | undefined;
      const page = await load(anaToken, (url, init) => (init.method === "PATCH" || init.method === "DELETE" ? next : undefined));
      await page.openInvites();
      await page.until(() => personRows(page).length === 2);
      const reads = () => page.requests.filter((r) => r.url.startsWith("/api/people?") && r.method === "GET").length;
      const answer = async (act: "mark" | "remove", value: Refusal | undefined, said: string, reread: boolean) => {
        next = value;
        page.elements["people-note"].textContent = "";
        const before = reads();
        if (act === "mark") button(page, "ben", "Make admin").on.click();
        else {
          button(page, "ben", "Remove").on.click();
          page.elements["remove-yes"].on.click();
        }
        await page.until(() => page.elements["people-note"].textContent === said);
        if (reread) await page.until(() => reads() > before);
        else {
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(reads(), said).toBe(before);
        }
      };
      for (const act of ["mark", "remove"] as const) {
        const verb = act === "mark" ? "changed" : "removed";
        await answer(act, 404, "ben is already gone (404).", true);
        await answer(act, { status: 400, reason: "Give admin as true or false" }, "Give admin as true or false", false);
        await answer(act, { status: 503, reason: "Database busy", retry: true }, "The server is busy (503). Try again in a moment.", false);
        await answer(act, "fail", `No answer from the server, so ben may have been ${verb}: the list below shows whether.`, true);
      }
      // A deadline that passes says so too.
      next = "hang";
      button(page, "ben", "Make admin").on.click();
      await page.until(() => page.deadlines.size > 0 && page.elements["people-note"].textContent === "Making ben an admin…");
      for (const [, fn] of page.deadlines) fn();
      await page.until(() => page.elements["people-note"].textContent.startsWith("The server did not answer in time, so ben may have been changed"));
      expect(adminOf("ben")).toBe(0);
    });

    it("forgets the admin on a 403, and asks for a token again on a 401", async () => {
      addPerson(db, "owner", "ben");
      for (const [status, act] of [[403, "mark"], [403, "remove"], [401, "mark"], [401, "remove"]] as const) {
        let refuse = false;
        const page = await load(anaToken, (url, init) => (refuse && (init.method === "PATCH" || init.method === "DELETE") ? status : undefined));
        await page.openInvites();
        await page.until(() => personRows(page).length === 2);
        refuse = true;
        if (act === "mark") button(page, "ben", "Make admin").on.click();
        else {
          button(page, "ben", "Remove").on.click();
          page.elements["remove-yes"].on.click();
        }
        if (status === 403) {
          await page.until(() => page.elements["log-note"].textContent.startsWith("The server says you are no longer an admin"));
          expect(page.elements["invite-forms"].hidden).toBe(true);
          expect(page.elements["people-rows"].children).toEqual([]);
          expect(page.entry()).toBeUndefined();
        } else {
          await page.until(() => page.elements["status-line"].textContent === "The server refused that token. Enter another.");
          expect(page.store.size).toBe(0);
        }
      }
      // A 403 or 401 to the list's own read does the same.
      for (const status of [403, 401]) {
        let refuse = false;
        const page = await load(anaToken, (url, init) => (refuse && url.startsWith("/api/people") && (init.method ?? "GET") === "GET" ? status : undefined));
        await page.openInvites();
        refuse = true;
        await page.poll();
        if (status === 403) await page.until(() => page.elements["log-note"].textContent.startsWith("The server says you are no longer an admin"));
        else await page.until(() => page.elements["status-line"].textContent === "The server refused that token. Enter another.");
        expect(page.entry()).toBeUndefined();
      }
    });

    it("changes nothing on the page for an answer that comes after the view closed or the token was forgotten", async () => {
      addPerson(db, "owner", "ben");
      addPerson(db, "owner", "cy");
      let hold = false;
      const page = await load(anaToken, (url, init) => (hold && (init.method === "PATCH" || init.method === "DELETE") ? "held" : undefined));
      for (const [leave, act] of [["close", "mark"], ["close", "remove"], ["forget", "remove"]] as const) {
        if (leave === "forget") page.store.set("message-cp-token", anaToken);
        await page.openInvites();
        await page.until(() => personRows(page).some((r) => r[0] === (act === "mark" ? "ben" : "cy")));
        hold = true;
        if (act === "mark") button(page, "ben", "Make admin").on.click();
        else {
          button(page, "cy", "Remove").on.click();
          page.elements["remove-yes"].on.click();
        }
        await page.until(() => page.held.length === 1);
        if (leave === "close") page.elements["close-log"].on.click();
        else page.elements["forget"].on.click();
        hold = false;
        page.release();
        await new Promise((resolve) => setTimeout(resolve, 50));
        // The server did it, but the page says nothing of it and opens nothing.
        expect(page.elements["people-note"].textContent).toBe("");
        expect(page.elements["people-rows"].children).toEqual([]);
        expect(page.elements["remove-confirm"].hidden).toBe(true);
        expect(page.elements["log-title"].textContent).toBe("");
        // The buttons work again for the next view.
        expect(page.elements["remove-yes"].disabled).not.toBe(true);
        if (act === "mark") {
          expect(adminOf("ben")).toBe(1);
          setPersonAdmin(db, "owner", "ben", false);
        }
        if (leave === "forget") {
          expect(page.entry()).toBeUndefined();
          return;
        }
        if (act === "remove") addPerson(db, "owner", "cy");
      }
    });
  });

  describe("its agents panel", () => {
    // An agent's row in the agents panel, its details, and the Remove or Reset key button in them, if offered.
    const agentRow = (page: Page, name: string) => page.elements["rows"].children.find((r) => r.children[0]?.children[1]?.textContent === name);
    const actionsOf = (page: Page, name: string) => agentRow(page, name)?.children[1].children.find((c) => c.className === "actions");
    const action = (page: Page, name: string, label: string) => actionsOf(page, name)!.children.find((c) => c.textContent === label)!;
    const openDetails = (page: Page, name: string) => agentRow(page, name)!.children[0].on.click();
    const live = (name: string) => db.prepare("SELECT 1 FROM agents WHERE name = ? AND removed_at IS NULL").pluck().get(name);
    const note = (page: Page) => page.elements["agent-note"].textContent;

    it("offers Remove and Reset key on an agent's details for an admin person only, never on a person's", async () => {
      registerAgent(db, OWNER_ACCOUNT, "writer", "");
      addPerson(db, "owner", "maria");
      const plain = addToken(db, "owner", false, false, undefined, "maria").token;
      for (const token of [plain, OWNER_TOKEN, viewer]) {
        const page = await load(token);
        await page.until(() => agentRow(page, "writer") !== undefined && page.requests.some((r) => r.url === "/api/token"));
        await page.poll();
        expect(actionsOf(page, "writer")).toBeUndefined();
      }
      const page = await load(anaToken);
      await page.until(() => actionsOf(page, "writer") !== undefined);
      expect(actionsOf(page, "writer")!.children.map((c) => c.textContent)).toEqual(["Remove", "Reset key"]);
      expect(actionsOf(page, "ana")).toBeUndefined();
      expect(actionsOf(page, "maria")).toBeUndefined();
      // An agent token is forgotten, so it never sees the panel at all.
      const agentPage = await load(agentToken);
      await agentPage.until(() => agentPage.store.size === 0);
      expect(agentPage.elements["rows"].children).toEqual([]);
    });

    it("removes an agent only after asking, and says what it deleted from the answer's counts", async () => {
      registerAgent(db, OWNER_ACCOUNT, "writer", "");
      registerAgent(db, OWNER_ACCOUNT, "bot", "");
      for (const body of ["a", "b", "c"]) sendMessage(db, OWNER_ACCOUNT, "bot", "writer", body);
      const bot = { ...identityOf(db, OWNER_ACCOUNT, "bot")!, name: "bot" };
      joinChannel(db, OWNER_ACCOUNT, bot, "general");
      post(db, OWNER_ACCOUNT, bot, "general", "hi @writer");
      const page = await load(anaToken);
      await page.until(() => actionsOf(page, "writer") !== undefined && page.elements["pair-rows"].children.length === 1);
      openDetails(page, "writer");
      action(page, "writer", "Remove").on.click();
      expect(page.elements["agent-confirm"].hidden).toBe(false);
      expect(page.elements["agent-confirm-text"].textContent).toBe(
        "Remove writer? This cannot be undone: it deletes writer's direct messages and mentions. Its channel posts stay.",
      );
      expect(page.elements["agent-yes"].textContent).toBe("Remove");
      // Cancel sends nothing.
      page.elements["agent-no"].on.click();
      expect(page.elements["agent-confirm"].hidden).toBe(true);
      expect(page.writes()).toEqual([]);
      action(page, "writer", "Remove").on.click();
      page.elements["agent-yes"].on.click();
      await page.until(() => note(page) === "Removed writer: 3 messages and 1 mention deleted.");
      expect(page.writes()).toEqual([{ url: "/api/agents?name=writer", method: "DELETE", body: undefined }]);
      expect(page.elements["agent-confirm"].hidden).toBe(true);
      expect(live("writer")).toBeUndefined();
      // The messages are read again from the start, so writer's pair goes, and the list follows.
      await page.until(() => agentRow(page, "writer") === undefined && page.elements["pair-rows"].children.length === 0);
      expect(page.requests.filter((r) => r.url.startsWith("/api/messages?") && r.url.includes("offset=0")).length).toBeGreaterThan(1);
      expect(onPage(page, "hi @writer")).toBe(false);
    });

    it("resets a key only after asking, shows the new key once with Copy, and drops it when the details close", async () => {
      registerAgent(db, OWNER_ACCOUNT, "writer", "");
      const page = await load(anaToken);
      await page.until(() => actionsOf(page, "writer") !== undefined);
      openDetails(page, "writer");
      action(page, "writer", "Reset key").on.click();
      expect(page.elements["agent-confirm-text"].textContent).toBe(
        "Reset writer's key? Its old key stops working at once and its sessions end. A token message-cp connect made for it keeps working until it is revoked.",
      );
      expect(page.elements["agent-yes"].textContent).toBe("Reset key");
      page.elements["agent-yes"].on.click();
      await page.until(() => page.elements["agent-key-made"].hidden === false);
      expect(page.writes()).toEqual([{ url: "/api/agents/key?name=writer", method: "POST", body: undefined }]);
      const key = page.elements["agent-key"].value;
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      // The new key registers writer; it is nowhere on the page but its field, and never stored.
      expect(() => registerAgent(db, OWNER_ACCOUNT, "writer", "", key)).not.toThrow();
      expect(Object.entries(page.elements).some(([id, node]) => id !== "agent-key" && JSON.stringify(node, (k, v) => (k === "on" ? undefined : v)).includes(key))).toBe(false);
      expect([...page.store.values()]).not.toContain(key);
      expect(page.elements["agent-key-for"].textContent).toContain("writer's new key.");
      page.elements["agent-key-copy"].on.click();
      await page.until(() => page.elements["agent-copy-note"].textContent === "Copied.");
      expect(page.copied).toEqual([key]);
      // A poll redraws the rows but keeps the key.
      await page.poll();
      expect(page.elements["agent-key"].value).toBe(key);
      // Closing writer's details drops it.
      openDetails(page, "writer");
      expect(page.elements["agent-key"].value).toBe("");
      expect(page.elements["agent-key-made"].hidden).toBe(true);
      // So does Done, and forgetting the token.
      openDetails(page, "writer");
      action(page, "writer", "Reset key").on.click();
      page.elements["agent-yes"].on.click();
      await page.until(() => page.elements["agent-key"].value !== "");
      page.elements["agent-key-done"].on.click();
      expect(page.elements["agent-key"].value).toBe("");
      action(page, "writer", "Reset key").on.click();
      page.elements["agent-yes"].on.click();
      await page.until(() => page.elements["agent-key"].value !== "");
      page.elements["forget"].on.click();
      expect(page.elements["agent-key"].value).toBe("");
      expect(page.elements["agent-key-made"].hidden).toBe(true);
    });

    it("says each other answer plainly, and reads again after a 404 or no answer", async () => {
      registerAgent(db, OWNER_ACCOUNT, "writer", "");
      let next: Refusal | undefined;
      const page = await load(anaToken, (url, init) => (init.method === "POST" || init.method === "DELETE") && url.startsWith("/api/agents") ? next : undefined);
      await page.until(() => actionsOf(page, "writer") !== undefined);
      openDetails(page, "writer");
      const answer = async (label: string, value: Refusal, said: string) => {
        next = value;
        action(page, "writer", label).on.click();
        page.elements["agent-yes"].on.click();
        await page.until(() => note(page) === said);
        expect(page.elements["agent-confirm"].hidden).toBe(true);
        expect(page.elements["agent-key"].value).toBe("");
      };
      await answer("Remove", 404, "writer is already gone (404).");
      await answer("Reset key", 404, "writer is already gone (404).");
      await answer("Remove", { status: 503, reason: "Database busy", retry: true }, "The server is busy (503). Try again in a moment.");
      await answer("Reset key", { status: 503, reason: "Database busy", retry: true }, "The server is busy (503). Try again in a moment.");
      await answer("Remove", "fail", "No answer from the server, so writer may have been removed: the list shows whether.");
      await answer(
        "Reset key",
        "fail",
        "No answer from the server, so writer's key may have been reset, and this page has no new key to show: reset it again for one.",
      );
      // A deadline that passes says so too.
      next = "hang";
      action(page, "writer", "Remove").on.click();
      page.elements["agent-yes"].on.click();
      await page.until(() => page.deadlines.size > 0 && note(page) === "Removing writer…");
      for (const [, fn] of page.deadlines) fn();
      await page.until(() => note(page).startsWith("The server did not answer in time, so writer may have been removed"));
      expect(live("writer")).toBe(1);
    });

    it("forgets the admin on a 403, and asks for a token again on a 401", async () => {
      registerAgent(db, OWNER_ACCOUNT, "writer", "");
      for (const [status, label] of [[403, "Remove"], [403, "Reset key"], [401, "Remove"], [401, "Reset key"]] as const) {
        let refuse = false;
        const page = await load(anaToken, (url, init) => (refuse && init.method !== "GET" && url.startsWith("/api/agents") ? status : undefined));
        await page.until(() => actionsOf(page, "writer") !== undefined);
        openDetails(page, "writer");
        refuse = true;
        action(page, "writer", label).on.click();
        page.elements["agent-yes"].on.click();
        if (status === 403) {
          await page.until(() => note(page).startsWith("The server says you are no longer an admin"));
          expect(actionsOf(page, "writer")).toBeUndefined();
          expect(page.elements["agent-confirm"].hidden).toBe(true);
          expect(page.entry()).toBeUndefined();
        } else {
          await page.until(() => page.elements["status-line"].textContent === "The server refused that token. Enter another.");
          expect(page.store.size).toBe(0);
          expect(page.elements["agent-confirm"].hidden).toBe(true);
        }
      }
    });

    it("forgets the admin on a 403 that comes after the panel moved on, and ends a confirmation whose agent left the list", async () => {
      registerAgent(db, OWNER_ACCOUNT, "writer", "");
      registerAgent(db, OWNER_ACCOUNT, "eve", "");
      let hold = false;
      const page = await load(anaToken, (url, init) => (hold && init.method !== "GET" && url.startsWith("/api/agents") ? { status: 403, reason: "Not an admin" } : undefined));
      await page.until(() => actionsOf(page, "writer") !== undefined && actionsOf(page, "eve") !== undefined);
      openDetails(page, "eve");
      action(page, "eve", "Remove").on.click();
      // Someone else removes eve: the next poll ends the confirmation for her.
      purgeAgent(db, "owner", "eve");
      await page.poll();
      await page.until(() => agentRow(page, "eve") === undefined);
      expect(page.elements["agent-confirm"].hidden).toBe(true);
      openDetails(page, "writer");
      hold = true;
      action(page, "writer", "Reset key").on.click();
      page.elements["agent-yes"].on.click();
      page.elements["agent-no"].on.click();
      await page.until(() => actionsOf(page, "writer") === undefined);
      expect(note(page)).toBe("");
    });

    it("says a key may have been reset when no answer comes after the reader pressed Cancel", async () => {
      registerAgent(db, OWNER_ACCOUNT, "writer", "");
      let next: Refusal | undefined;
      const page = await load(anaToken, (url, init) => (init.method === "POST" && url.startsWith("/api/agents") ? next : undefined));
      await page.until(() => actionsOf(page, "writer") !== undefined);
      openDetails(page, "writer");
      next = "hang";
      action(page, "writer", "Reset key").on.click();
      page.elements["agent-yes"].on.click();
      await page.until(() => page.deadlines.size > 0 && note(page) === "Resetting writer's key…");
      page.elements["agent-no"].on.click();
      for (const [, fn] of page.deadlines) fn();
      await page.until(
        () => note(page) === "The server did not answer in time, so writer's key may have been reset, and this page has no new key to show: reset it again for one.",
      );
      expect(page.elements["agent-confirm"].hidden).toBe(true);
      expect(page.elements["agent-key"].value).toBe("");
      expect(page.elements["agent-key-made"].hidden).toBe(true);
    });

    it("changes nothing in the panel for an answer that comes after it moved on or the token was forgotten", async () => {
      registerAgent(db, OWNER_ACCOUNT, "writer", "");
      registerAgent(db, OWNER_ACCOUNT, "eve", "");
      let hold = false;
      const page = await load(anaToken, (url, init) => (hold && init.method !== "GET" && url.startsWith("/api/agents") ? "held" : undefined));
      for (const [leave, label] of [["other", "Reset key"], ["close", "Reset key"], ["other", "Remove"], ["forget", "Reset key"]] as const) {
        if (leave === "forget") page.store.set("message-cp-token", anaToken);
        await page.until(() => actionsOf(page, "writer") !== undefined && actionsOf(page, "eve") !== undefined);
        if (agentRow(page, "writer")!.children[1].hidden) openDetails(page, "writer");
        hold = true;
        action(page, "writer", label).on.click();
        page.elements["agent-yes"].on.click();
        await page.until(() => page.held.length === 1);
        if (leave === "other") {
          if (agentRow(page, "eve")!.children[1].hidden) openDetails(page, "eve");
          action(page, "eve", "Remove").on.click();
        } else if (leave === "close") openDetails(page, "writer");
        else page.elements["forget"].on.click();
        hold = false;
        page.release();
        await new Promise((resolve) => setTimeout(resolve, 50));
        // The server did it, but no key shows, and a confirmation for eve stays as it was.
        expect(page.elements["agent-key"].value).toBe("");
        expect(page.elements["agent-key-made"].hidden).toBe(true);
        if (leave === "other") {
          expect(page.elements["agent-confirm-text"].textContent).toMatch(/^Remove eve\?/);
          expect(page.elements["agent-yes"].disabled).toBe(false);
          page.elements["agent-no"].on.click();
        } else expect(page.elements["agent-confirm"].hidden).toBe(true);
        // A key reset after its details closed says so, as its key is not shown; nothing else leaves a note.
        expect(note(page)).toBe(
          leave === "close" ? "writer's key was reset, but this page closed it before showing the new one: reset it again for a key you can see." : "",
        );
        if (label === "Remove") {
          expect(live("writer")).toBeUndefined();
          registerAgent(db, OWNER_ACCOUNT, "writer", "");
          await page.poll();
        }
        if (leave === "forget") expect(page.elements["rows"].children).toEqual([]);
      }
    });
  });

  describe("its webhooks view", () => {
    const NO_WEBHOOKS = 'No webhooks. Add one with the "Add a webhook" form above.';
    const hookEntry = (page: Page) => page.elements["webhook-entry"].children[0]?.children[0] as Stub | undefined;
    const openWebhooks = async (page: Page) => {
      await page.until(() => hookEntry(page) !== undefined);
      hookEntry(page)!.on.click();
      await page.until(() => page.elements["log-note"].textContent !== "Loading…" && page.elements["log-title"].textContent === "Webhooks");
    };
    const hookRows = (page: Page) => page.elements["post-rows"].children.map((r) => r.children.map((c) => c.textContent));
    const removeButton = (page: Page, id: number) =>
      page.elements["post-rows"].children.find((r) => r.children[1].textContent === `webhook ${id}`)!.children.find((c) => c.textContent === "Remove")!;
    const hookUrls = (page: Page) => page.requests.filter((r) => r.url.startsWith("/api/webhooks"));
    const note = (page: Page) => page.elements["webhook-note"].textContent;
    const exists = (id: number) => db.prepare("SELECT 1 FROM webhooks WHERE id = ?").get(id) !== undefined;

    it("shows the Webhooks entry to an admin person only, and never asks for the webhooks with any other token", async () => {
      addPerson(db, "owner", "maria");
      const plain = addToken(db, "owner", false, false, undefined, "maria").token;
      for (const token of [plain, OWNER_TOKEN, viewer]) {
        const page = await load(token);
        await page.until(() => page.elements["delivery-entry"].children.length === 1 && page.requests.some((r) => r.url === "/api/token"));
        await page.poll();
        expect(page.elements["webhook-entry"].children).toEqual([]);
        expect(hookUrls(page)).toEqual([]);
      }
      // An agent token is forgotten at once, so it sees no entry either.
      const agent = await load(agentToken);
      await agent.until(() => agent.store.size === 0);
      expect(agent.elements["webhook-entry"].children).toEqual([]);
      expect(hookUrls(agent)).toEqual([]);
      const page = await load(anaToken);
      await page.until(() => hookEntry(page) !== undefined);
      expect(hookEntry(page)!.children.map((c) => c.textContent)).toEqual(["Webhooks", ""]);
      // Until the view is opened, the webhooks are not read.
      expect(hookUrls(page)).toEqual([]);
    });

    it("lists the account's webhooks oldest first by origin, never a secret, header value, full URL or body, nor another account's", async () => {
      const plainHook = addWebhook(db, "owner", "https://example.com/plain-path", "#general", false);
      const fancy = addWebhook(db, "owner", "https://hooks.example.org:8443/secret-path", "agent:bob", true, "X-Api-Key: sekret-value", 5);
      const fixed = addWebhook(db, "owner", "https://example.com/body-path", "mention:bob", true, undefined, undefined, '{"requestId":"{{delivery}}","tag":"fixed-body-text"}');
      addAccount(db, "other");
      const theirs = addWebhook(db, "other", "https://other.example/theirs", "agent:olga", true);
      const page = await load(anaToken);
      await openWebhooks(page);
      expect(hookRows(page)).toEqual([
        ["#general", `webhook ${plainHook.id}`, "https://example.com · no text · no header · no hourly limit", "Remove"],
        ["agent:bob", `webhook ${fancy.id}`, "https://hooks.example.org:8443 · with text · header X-Api-Key · at most 5 per hour", "Remove"],
        ["mention:bob", `webhook ${fixed.id}`, "https://example.com · fixed body, no text · no header · no hourly limit", "Remove"],
      ]);
      expect(hookEntry(page)!.children.map((c) => c.textContent)).toEqual(["Webhooks", "3"]);
      expect(page.elements["log-note"].textContent).toBe("");
      for (const hidden of [plainHook.secret, fancy.secret, fixed.secret, theirs.secret, "sekret-value", "path", "fixed-body-text", "olga", "other.example"]) {
        expect(onPage(page, hidden)).toBe(false);
      }
      expect(hookUrls(page).every((r) => r.method === "GET")).toBe(true);
    });

    it("says when the account has no webhooks", async () => {
      const page = await load(anaToken);
      await openWebhooks(page);
      expect(page.elements["log-note"].textContent).toBe(NO_WEBHOOKS);
      expect(hookEntry(page)!.children.map((c) => c.textContent)).toEqual(["Webhooks", "0"]);
    });

    it("removes a webhook only after confirming, saying how many deliveries went, and reads the list again", async () => {
      registerAgent(db, OWNER_ACCOUNT, "alice", "x");
      registerAgent(db, OWNER_ACCOUNT, "bob", "x");
      const kept = addWebhook(db, "owner", "https://example.com/kept", "#general", true);
      const hook = addWebhook(db, "owner", "https://example.com/hook", "agent:bob", true);
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "one");
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "two");
      const page = await load(anaToken);
      await openWebhooks(page);
      await page.until(() => hookRows(page).length === 2);
      // Remove asks first; nothing is sent until it is confirmed, and Keep it sends nothing.
      removeButton(page, hook.id).on.click();
      expect(page.elements["webhook-confirm"].hidden).toBe(false);
      expect(page.elements["webhook-text"].textContent).toBe(
        `Remove webhook ${hook.id} (agent:bob)? Its queued and past deliveries go with it. This cannot be undone.`,
      );
      page.elements["webhook-no"].on.click();
      expect(page.elements["webhook-confirm"].hidden).toBe(true);
      expect(page.writes()).toEqual([]);
      removeButton(page, hook.id).on.click();
      page.elements["webhook-yes"].on.click();
      await page.until(() => note(page) === `Removed webhook ${hook.id} and its 2 deliveries.`);
      expect(page.writes()).toEqual([{ url: `/api/webhooks?id=${hook.id}`, method: "DELETE", body: undefined }]);
      expect(page.elements["webhook-confirm"].hidden).toBe(true);
      expect(exists(hook.id)).toBe(false);
      expect(exists(kept.id)).toBe(true);
      await page.until(() => hookRows(page).length === 1);
      expect(hookRows(page)[0][1]).toBe(`webhook ${kept.id}`);
      expect(hookEntry(page)!.children.map((c) => c.textContent)).toEqual(["Webhooks", "1"]);
      // One delivery is said as one.
      sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "hi");
      const one = addWebhook(db, "owner", "https://example.com/one", "agent:alice", true);
      sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "again");
      await page.poll();
      await page.until(() => hookRows(page).length === 2);
      removeButton(page, one.id).on.click();
      page.elements["webhook-yes"].on.click();
      await page.until(() => note(page) === `Removed webhook ${one.id} and its 1 delivery.`);
    });

    it("says each other answer to a removal in plain words", async () => {
      const hook = addWebhook(db, "owner", "https://example.com/hook", "agent:bob", true);
      let next: Refusal | undefined;
      const page = await load(anaToken, (url, init) => (init.method === "DELETE" ? next : undefined));
      await openWebhooks(page);
      const removeOne = async (answer: Refusal | undefined, said: string) => {
        next = answer;
        removeButton(page, hook.id).on.click();
        page.elements["webhook-yes"].on.click();
        await page.until(() => note(page) === said);
        expect(page.elements["webhook-confirm"].hidden).toBe(true);
      };
      await removeOne({ status: 400, reason: "Give id once" }, "Give id once");
      await removeOne({ status: 503, reason: "Database busy", retry: true }, "The server is busy (503). Try again in a moment.");
      await removeOne({ status: 503, reason: "Too many requests" }, "The server is busy (503). Try again in a moment.");
      await removeOne(404, `Webhook ${hook.id} was already gone (404).`);
      await removeOne("fail", `No answer from the server, so webhook ${hook.id} may have been removed: the list below shows whether.`);
      next = "hang";
      removeButton(page, hook.id).on.click();
      page.elements["webhook-yes"].on.click();
      await page.until(() => page.deadlines.size > 0);
      expect(page.elements["webhook-yes"].disabled).toBe(true);
      for (const [, fn] of page.deadlines) fn();
      await page.until(() => note(page).startsWith(`The server did not answer in time, so webhook ${hook.id} may have been removed`));
      expect(page.elements["webhook-yes"].disabled).toBe(false);
      // None of those was the server's own removal.
      expect(exists(hook.id)).toBe(true);
      // The server's own 404, for a webhook removed on the server meanwhile.
      next = undefined;
      db.prepare("DELETE FROM webhooks WHERE id = ?").run(hook.id);
      await removeOne(undefined, `Webhook ${hook.id} was already gone (404).`);
      await page.until(() => page.elements["log-note"].textContent === NO_WEBHOOKS);
    });

    it("takes the entry and the view away on a 403 to either request, once the person is no longer an admin", async () => {
      for (const method of ["DELETE", "GET"]) {
        const hook = addWebhook(db, "owner", "https://example.com/hook", "agent:bob", true);
        setPersonAdmin(db, "owner", "ana", true);
        const page = await load(anaToken);
        await openWebhooks(page);
        await page.until(() => hookRows(page).length > 0);
        setPersonAdmin(db, "owner", "ana", false);
        if (method === "DELETE") {
          removeButton(page, hook.id).on.click();
          page.elements["webhook-yes"].on.click();
        } else {
          await page.poll();
        }
        await page.until(() => page.elements["log-note"].textContent.startsWith("The server says you are no longer an admin"));
        expect(page.elements["log-note"].textContent).toBe(
          "The server says you are no longer an admin of this account (403), so this page no longer lists, adds or removes webhooks.",
        );
        expect(hookEntry(page)).toBeUndefined();
        expect(page.entry()).toBeUndefined();
        expect(page.elements["post-rows"].children).toEqual([]);
        expect(page.elements["webhook-confirm"].hidden).toBe(true);
        expect(exists(hook.id)).toBe(true);
        // The next poll does not read the webhooks again.
        const before = page.requests.length;
        await page.poll();
        await page.until(() => page.requests.slice(before).some((r) => r.url.startsWith("/api/messages")));
        expect(page.requests.slice(before).filter((r) => r.url.startsWith("/api/webhooks"))).toEqual([]);
        db.prepare("DELETE FROM webhooks").run();
      }
    });

    it("takes the entry away on a removal's 403 that comes after the view closed, without opening anything", async () => {
      const hook = addWebhook(db, "owner", "https://example.com/hook", "agent:bob", true);
      let hold = false;
      const page = await load(anaToken, (url, init) => (hold && init.method === "DELETE" ? "held" : undefined));
      await openWebhooks(page);
      await page.until(() => hookRows(page).length === 1);
      hold = true;
      removeButton(page, hook.id).on.click();
      page.elements["webhook-yes"].on.click();
      await page.until(() => page.held.length === 1);
      page.elements["close-log"].on.click();
      setPersonAdmin(db, "owner", "ana", false);
      hold = false;
      page.release();
      await page.until(() => hookEntry(page) === undefined);
      expect(page.entry()).toBeUndefined();
      expect(page.elements["log"].hidden).toBe(true);
      expect(note(page)).toBe("");
      expect(exists(hook.id)).toBe(true);
    });

    it("closes a confirmation once the list no longer gives its webhook as it was, so it never removes one that reused the id", async () => {
      const hook = addWebhook(db, "owner", "https://example.com/hook", "#general", true);
      const page = await load(anaToken);
      await openWebhooks(page);
      removeButton(page, hook.id).on.click();
      expect(page.elements["webhook-confirm"].hidden).toBe(false);
      // Removed on the server, then another added in its place, which SQLite gives the same id.
      db.prepare("DELETE FROM webhooks WHERE id = ?").run(hook.id);
      await page.poll();
      await page.until(() => page.elements["log-note"].textContent === NO_WEBHOOKS);
      expect(page.elements["webhook-confirm"].hidden).toBe(true);
      expect(note(page)).toBe(`Webhook ${hook.id} (#general) changed or went from the list, so its confirmation closed and nothing was sent.`);
      const replacement = addWebhook(db, "owner", "https://example.org/other", "agent:bob", true);
      expect(replacement.id).toBe(hook.id);
      await page.poll();
      await page.until(() => hookRows(page).length === 1);
      page.elements["webhook-yes"].on.click();
      expect(page.writes()).toEqual([]);
      expect(exists(replacement.id)).toBe(true);
      // A webhook changed in place closes its confirmation too; one left as it was keeps it open across polls.
      removeButton(page, replacement.id).on.click();
      await page.poll();
      expect(page.elements["webhook-confirm"].hidden).toBe(false);
      db.prepare("UPDATE webhooks SET max_per_hour = 9 WHERE id = ?").run(replacement.id);
      await page.poll();
      await page.until(() => page.elements["webhook-confirm"].hidden);
      expect(page.writes()).toEqual([]);
    });

    it("closes a stale confirmation for one webhook while another's removal is still in flight", async () => {
      const a = addWebhook(db, "owner", "https://example.com/a", "#general", true);
      const b = addWebhook(db, "owner", "https://example.com/b", "agent:bob", true);
      let next: "hang" | undefined;
      const page = await load(anaToken, (url, init) => (init.method === "DELETE" ? next : undefined));
      await openWebhooks(page);
      await page.until(() => hookRows(page).length === 2);
      next = "hang";
      removeButton(page, a.id).on.click();
      page.elements["webhook-yes"].on.click();
      await page.until(() => page.deadlines.size > 0);
      // A's own confirmation is left to its answer, even once A is gone from the list.
      db.prepare("DELETE FROM webhooks WHERE id = ?").run(a.id);
      await page.poll();
      await page.until(() => hookRows(page).length === 1);
      expect(page.elements["webhook-confirm"].hidden).toBe(false);
      // B's confirmation, opened while A's removal hangs, closes once B goes, and a replacement with B's id is never removed.
      removeButton(page, b.id).on.click();
      db.prepare("DELETE FROM webhooks WHERE id = ?").run(b.id);
      await page.poll();
      await page.until(() => page.elements["webhook-confirm"].hidden);
      expect(note(page)).toBe(`Webhook ${b.id} (agent:bob) changed or went from the list, so its confirmation closed and nothing was sent.`);
      for (const [, fn] of page.deadlines) fn();
      await page.until(() => note(page).startsWith(`The server did not answer in time, so webhook ${a.id} may have been removed`));
      addWebhook(db, "owner", "https://example.org/a2", "#general", true);
      const replacement = addWebhook(db, "owner", "https://example.org/b2", "agent:bob", true);
      expect(replacement.id).toBe(b.id);
      await page.poll();
      page.elements["webhook-yes"].on.click();
      expect(page.writes().filter((w) => w.url === `/api/webhooks?id=${b.id}`)).toEqual([]);
      expect(exists(replacement.id)).toBe(true);
    });

    it("says a busy server in the view's note, keeps the rows, and keeps polling", async () => {
      addWebhook(db, "owner", "https://example.com/hook", "agent:bob", true);
      let next: "busy" | "odd" | undefined;
      const page = await load(anaToken, (url) =>
        url.startsWith("/api/webhooks") && next === "busy" ? { status: 503, reason: "Database busy", retry: true } : undefined,
      );
      await openWebhooks(page);
      await page.until(() => hookRows(page).length === 1);
      next = "busy";
      await page.poll();
      await page.until(() => page.elements["log-note"].textContent === "The server is busy (503). Retrying…");
      expect(hookRows(page)).toHaveLength(1);
      next = undefined;
      await page.poll();
      await page.until(() => page.elements["log-note"].textContent === "");
    });

    it("asks for a token again on a 401 to either request", async () => {
      for (const method of ["DELETE", "GET"]) {
        const hook = addWebhook(db, "owner", "https://example.com/hook", "agent:bob", true);
        let refuse = false;
        const page = await load(anaToken, (url, init) => (refuse && url.startsWith("/api/webhooks") && (init.method ?? "GET") === method ? 401 : undefined));
        await openWebhooks(page);
        await page.until(() => hookRows(page).length > 0);
        refuse = true;
        if (method === "DELETE") {
          removeButton(page, hook.id).on.click();
          page.elements["webhook-yes"].on.click();
        } else {
          await page.poll();
        }
        await page.until(() => page.elements["status-line"].textContent === "The server refused that token. Enter another.");
        expect(page.store.size).toBe(0);
        expect(hookEntry(page)).toBeUndefined();
        expect(page.elements["post-rows"].children).toEqual([]);
        db.prepare("DELETE FROM webhooks").run();
      }
    });

    it("drops a removal's answer that comes after the view closed, another view opened or the token was forgotten", async () => {
      let hold = false;
      const page = await load(anaToken, (url, init) => (hold && init.method === "DELETE" ? "held" : undefined));
      for (const leave of ["close", "other", "forget"]) {
        const hook = addWebhook(db, "owner", "https://example.com/hook", "agent:bob", true);
        await openWebhooks(page);
        await page.until(() => hookRows(page).length === 1);
        hold = true;
        removeButton(page, hook.id).on.click();
        page.elements["webhook-yes"].on.click();
        await page.until(() => page.held.length === 1);
        if (leave === "close") page.elements["close-log"].on.click();
        else if (leave === "other") page.elements["delivery-entry"].children[0].children[0].on.click();
        else page.elements["forget"].on.click();
        hold = false;
        page.release();
        // The server removed it, but the page says nothing of it.
        await page.until(() => !exists(hook.id));
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(note(page)).toBe("");
        expect(page.elements["webhook-confirm"].hidden).toBe(true);
        expect(page.elements["webhook-yes"].disabled).toBe(false);
        if (leave === "other") {
          expect(page.elements["log-title"].textContent).toBe("Webhook deliveries");
          expect(page.elements["post-rows"].children.every((r) => r.className.startsWith("entry delivery"))).toBe(true);
        }
        if (leave === "forget") {
          expect(page.elements["log"].hidden).toBe(true);
          expect(hookEntry(page)).toBeUndefined();
        }
      }
    });

    it("drops a read that comes after the view closed or the token was forgotten", async () => {
      addWebhook(db, "owner", "https://example.com/hook", "agent:bob", true);
      for (const leave of ["close", "forget"]) {
        let hold = false;
        const page = await load(anaToken, (url) => (hold && url.startsWith("/api/webhooks") ? "held" : undefined));
        await page.until(() => hookEntry(page) !== undefined);
        hold = true;
        hookEntry(page)!.on.click();
        await page.until(() => page.held.length === 1);
        if (leave === "close") page.elements["close-log"].on.click();
        else page.elements["forget"].on.click();
        page.release();
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(page.elements["log"].hidden).toBe(true);
        expect(page.elements["post-rows"].children).toEqual([]);
        expect(page.elements["log-note"].textContent).toBe("");
        if (leave === "close") expect(hookEntry(page)!.children.map((c) => c.textContent)).toEqual(["Webhooks", ""]);
        else expect(hookEntry(page)).toBeUndefined();
      }
    });

    // Fills the "Add a webhook" form; the checkbox starts checked, as the markup has it.
    const fillHook = (page: Page, fields: { url?: string; on?: string; text?: boolean; name?: string; value?: string; max?: string; body?: string }) => {
      const e = page.elements;
      e["hook-url"].value = fields.url ?? "";
      e["hook-on"].value = fields.on ?? "";
      e["hook-text"].checked = fields.text ?? true;
      e["hook-header-name"].value = fields.name ?? "";
      e["hook-header-value"].value = fields.value ?? "";
      e["hook-max"].value = fields.max ?? "";
      e["hook-body"].value = fields.body ?? "";
    };
    const addHook = (page: Page) => submit(page.elements["webhook-add-form"]);
    const hookNote = (page: Page) => page.elements["hook-note"].textContent;
    const hookPosts = (page: Page) => page.writes().filter((w) => w.url === "/api/webhooks" && w.method === "POST");
    const formFields = ["hook-url", "hook-on", "hook-header-name", "hook-header-value", "hook-max", "hook-body"];
    // Whether a string appears anywhere on the page but the form's fields, which hold it by value, and the secret's field.
    const shownOutsideFields = (page: Page, text: string) =>
      Object.entries(page.elements).some(
        ([id, node]) => ![...formFields, "webhook-secret"].includes(id) && JSON.stringify(node, (k, v) => (k === "on" ? undefined : v)).includes(text),
      );
    const secretOf = (id: number) => db.prepare("SELECT secret FROM webhooks WHERE id = ?").pluck().get(id) as string;
    const hookCount = () => db.prepare("SELECT count(*) FROM webhooks").pluck().get() as number;

    it("shows the Add a webhook form to an admin person only, and never sends it with any other token", async () => {
      addPerson(db, "owner", "maria");
      const plain = addToken(db, "owner", false, false, undefined, "maria").token;
      for (const token of [plain, OWNER_TOKEN, viewer]) {
        const page = await load(token);
        await page.until(() => page.elements["delivery-entry"].children.length === 1 && page.requests.some((r) => r.url === "/api/token"));
        await page.poll();
        fillHook(page, { url: "https://example.com/hook", on: "#general" });
        addHook(page);
        expect(page.elements["webhook-forms"].hidden).toBe(true);
        expect(hookPosts(page)).toEqual([]);
      }
      const agent = await load(agentToken);
      await agent.until(() => agent.store.size === 0);
      expect(agent.elements["webhook-forms"].hidden).toBe(true);
      const page = await load(anaToken);
      await page.until(() => hookEntry(page) !== undefined);
      expect(page.elements["webhook-forms"].hidden).toBe(true);
      await openWebhooks(page);
      expect(page.elements["webhook-forms"].hidden).toBe(false);
      expect(page.elements["webhook-made"].hidden).toBe(true);
      expect(page.elements["hook-add"].disabled).toBe(false);
      // Another view hides it again.
      page.elements["delivery-entry"].children[0].children[0].on.click();
      expect(page.elements["webhook-forms"].hidden).toBe(true);
    });

    it("sends only the required fields, or each optional one only when filled in, and nothing without a URL and an event", async () => {
      const page = await load(anaToken);
      await openWebhooks(page);
      fillHook(page, { on: "#general" });
      addHook(page);
      expect(hookNote(page)).toBe("Enter the URL to deliver to.");
      fillHook(page, { url: "https://example.com/hook", on: "  " });
      addHook(page);
      expect(hookNote(page)).toBe("Enter what it fires on.");
      expect(page.writes()).toEqual([]);
      const sent: unknown[] = [];
      const cases: [Parameters<typeof fillHook>[1], Record<string, unknown>][] = [
        [{ url: " https://example.com/a ", on: " #general " }, { url: "https://example.com/a", on: "#general", includeText: true }],
        [{ url: "https://example.com/b", on: "agent:bob", text: false }, { url: "https://example.com/b", on: "agent:bob", includeText: false }],
        [
          { url: "https://example.com/c", on: "mention:bob", name: "X-Api-Key", value: "sekret-value" },
          { url: "https://example.com/c", on: "mention:bob", includeText: true, header: "X-Api-Key: sekret-value" },
        ],
        [{ url: "https://example.com/d", on: "#general", max: "30" }, { url: "https://example.com/d", on: "#general", includeText: true, maxPerHour: 30 }],
        [
          { url: "https://example.com/e", on: "agent:bob", body: '{"requestId":"{{delivery}}"}' },
          { url: "https://example.com/e", on: "agent:bob", includeText: true, body: '{"requestId":"{{delivery}}"}' },
        ],
      ];
      for (const [fields, body] of cases) {
        fillHook(page, fields);
        addHook(page);
        sent.push({ url: "/api/webhooks", method: "POST", body });
        await page.until(() => hookPosts(page).length === sent.length && hookNote(page).startsWith("Added webhook "));
        page.elements["hook-note"].textContent = "";
      }
      expect(hookPosts(page)).toEqual(sent);
      expect(db.prepare("SELECT url, include_text, header_name, header_value, max_per_hour, fixed_body FROM webhooks ORDER BY id").all()).toEqual([
        { url: "https://example.com/a", include_text: 1, header_name: null, header_value: null, max_per_hour: null, fixed_body: null },
        { url: "https://example.com/b", include_text: 0, header_name: null, header_value: null, max_per_hour: null, fixed_body: null },
        { url: "https://example.com/c", include_text: 1, header_name: "X-Api-Key", header_value: "sekret-value", max_per_hour: null, fixed_body: null },
        { url: "https://example.com/d", include_text: 1, header_name: null, header_value: null, max_per_hour: 30, fixed_body: null },
        { url: "https://example.com/e", include_text: 1, header_name: null, header_value: null, max_per_hour: null, fixed_body: '{"requestId":"{{delivery}}"}' },
      ]);
    });

    it("shows the new webhook's secret once with Copy, empties the URL, header value and body, lists it, and drops the secret when the view closes", async () => {
      const page = await load(anaToken);
      await openWebhooks(page);
      fillHook(page, {
        url: "https://hooks.example.org/secret-path",
        on: "agent:bob",
        name: "X-Api-Key",
        value: "sekret-value",
        max: "5",
        body: '{"id":"{{delivery}}","tag":"fixed-body-text"}',
      });
      addHook(page);
      await page.until(() => hookNote(page).startsWith("Added webhook "));
      const id = db.prepare("SELECT id FROM webhooks").pluck().get() as number;
      const secret = secretOf(id);
      expect(hookNote(page)).toBe(`Added webhook ${id} (agent:bob).`);
      expect(page.elements["webhook-made"].hidden).toBe(false);
      expect(page.elements["webhook-secret"].value).toBe(secret);
      expect(page.elements["webhook-for"].textContent).toBe(
        `Webhook ${id}'s secret. It signs each delivery (X-Message-CP-Signature); check it before trusting one. It shows only here, until you leave this view or add another, and is never shown again.`,
      );
      expect(page.elements["hook-url"].value).toBe("");
      expect(page.elements["hook-header-value"].value).toBe("");
      expect(page.elements["hook-body"].value).toBe("");
      // The rest stay as they were.
      expect(page.elements["hook-on"].value).toBe("agent:bob");
      expect(page.elements["hook-header-name"].value).toBe("X-Api-Key");
      expect(page.elements["hook-add"].disabled).toBe(false);
      // The list is read again and shows it, by origin only.
      await page.until(() => hookRows(page).length === 1);
      expect(hookRows(page)[0]).toEqual(["agent:bob", `webhook ${id}`, "https://hooks.example.org · fixed body, no text · header X-Api-Key · at most 5 per hour", "Remove"]);
      // The secret is in its field alone, and neither it, the header value, the URL's path nor the body is anywhere else,
      // nor stored by the page.
      for (const hidden of [secret, "sekret-value", "secret-path", "fixed-body-text"]) {
        expect(shownOutsideFields(page, hidden)).toBe(false);
        expect([...page.store.values()].join()).not.toContain(hidden);
      }
      page.elements["webhook-copy"].on.click();
      await page.until(() => page.elements["webhook-copy-note"].textContent === "Copied.");
      expect(page.copied).toEqual([secret]);
      // Leaving the view drops the secret and empties every field.
      page.elements["close-log"].on.click();
      expect(page.elements["webhook-secret"].value).toBe("");
      expect(page.elements["webhook-made"].hidden).toBe(true);
      expect(page.elements["webhook-for"].textContent).toBe("");
      expect(page.elements["webhook-forms"].hidden).toBe(true);
      for (const field of formFields) expect(page.elements[field].value).toBe("");
      expect(page.elements["hook-text"].checked).toBe(true);
      await openWebhooks(page);
      expect(page.elements["webhook-made"].hidden).toBe(true);
      expect(hookNote(page)).toBe("");
    });

    it("keeps every field on a refusal and says why, and says a webhook may have been added when there is no answer", async () => {
      let next: Refusal | undefined;
      const page = await load(anaToken, (url, init) => (init.method === "POST" && url === "/api/webhooks" ? next : undefined));
      await openWebhooks(page);
      const filled = { url: "http://example.com/hook", on: "#general", text: false, name: "X-Api-Key", value: "sekret-value", max: "5" };
      const addOne = async (answer: Refusal | undefined, said: string) => {
        next = answer;
        fillHook(page, filled);
        page.elements["hook-note"].textContent = "";
        addHook(page);
        await page.until(() => hookNote(page) === said);
        expect(page.elements["hook-url"].value).toBe(filled.url);
        expect(page.elements["hook-on"].value).toBe(filled.on);
        expect(page.elements["hook-text"].checked).toBe(false);
        expect(page.elements["hook-header-name"].value).toBe(filled.name);
        expect(page.elements["hook-header-value"].value).toBe(filled.value);
        expect(page.elements["hook-max"].value).toBe(filled.max);
        expect(page.elements["webhook-made"].hidden).toBe(true);
        expect(page.elements["webhook-secret"].value).toBe("");
      };
      // The server's own 400, with addWebhook's reason.
      await addOne(undefined, "--url must be https (plain http only for 127.x.x.x or [::1]): deliveries would cross the network in the clear.");
      await addOne({ status: 400, reason: "Invalid --on" }, "Invalid --on");
      await addOne(413, "This is too long for the server (413).");
      await addOne({ status: 503, reason: "Database busy", retry: true }, "The server is busy (503). Try again in a moment.");
      await addOne(
        "fail",
        "No answer from the server, so the webhook may or may not have been added: the list below shows whether. No secret can be shown for it, so if it is listed, remove it and add it again.",
      );
      expect(hookCount()).toBe(0);
      // Add stays disabled while the request is in flight, until its deadline, and a second submit sends nothing.
      next = "hang";
      addHook(page);
      await page.until(() => page.deadlines.size > 0);
      expect(page.elements["hook-add"].disabled).toBe(true);
      addHook(page);
      expect(hookPosts(page)).toHaveLength(6);
      for (const [, fn] of page.deadlines) fn();
      await page.until(() => hookNote(page).startsWith("The server did not answer in time, so the webhook may or may not have been added"));
      expect(page.elements["hook-add"].disabled).toBe(false);
      expect(shownOutsideFields(page, "sekret-value")).toBe(false);
    });

    it("drops the secret shown before once another webhook is added, even when the page cannot read the new one's", async () => {
      let junk = false;
      const page = await load(anaToken, (url, init) => (junk && init.method === "POST" && url === "/api/webhooks" ? "junk" : undefined));
      await openWebhooks(page);
      fillHook(page, { url: "https://example.com/one", on: "#general" });
      addHook(page);
      await page.until(() => page.elements["webhook-secret"].value !== "");
      junk = true;
      fillHook(page, { url: "https://example.com/two", on: "#general" });
      addHook(page);
      await page.until(() => hookNote(page).startsWith("A webhook was added, but this page cannot read its secret"));
      expect(page.elements["webhook-made"].hidden).toBe(true);
      expect(page.elements["webhook-secret"].value).toBe("");
      expect(page.elements["webhook-for"].textContent).toBe("");
    });

    it("drops the secret shown before when another addition gets no answer", async () => {
      let fail = false;
      const page = await load(anaToken, (url, init) => (fail && init.method === "POST" && url === "/api/webhooks" ? "fail" : undefined));
      await openWebhooks(page);
      fillHook(page, { url: "https://example.com/one", on: "#general" });
      addHook(page);
      await page.until(() => page.elements["webhook-secret"].value !== "");
      fail = true;
      fillHook(page, { url: "https://example.com/two", on: "#general" });
      addHook(page);
      await page.until(() => hookNote(page).startsWith("No answer from the server, so the webhook may or may not have been added"));
      expect(page.elements["webhook-made"].hidden).toBe(true);
      expect(page.elements["webhook-secret"].value).toBe("");
      expect(page.elements["webhook-for"].textContent).toBe("");
    });

    it("sends nothing when the header name holds a colon, so no part of it becomes the value", async () => {
      const page = await load(anaToken);
      await openWebhooks(page);
      for (const [name, value] of [["Authorization: Bearer", "token"], ["X-Key: secret", ""]]) {
        fillHook(page, { url: "https://example.com/hook", on: "#general", name, value });
        addHook(page);
        expect(hookNote(page)).toBe("A header name has no colon: put the name alone in Header name, and the rest in Header value.");
        expect(page.elements["hook-header-name"].value).toBe(name);
        expect(page.elements["hook-header-value"].value).toBe(value);
      }
      expect(hookPosts(page)).toEqual([]);
      expect(hookCount()).toBe(0);
    });

    it("keeps the URL, header value and body typed while the request was in flight, and empties only those still as sent", async () => {
      let hold = false;
      const page = await load(anaToken, (url, init) => (hold && init.method === "POST" && url === "/api/webhooks" ? "held" : undefined));
      await openWebhooks(page);
      hold = true;
      fillHook(page, { url: "https://example.com/one", on: "#general", name: "X-Api-Key", value: "sekret-value", body: '{"a":"{{delivery}}"}' });
      addHook(page);
      await page.until(() => page.held.length === 1);
      page.elements["hook-url"].value = "https://example.com/next";
      page.elements["hook-body"].value = '{"b":"{{delivery}}"}';
      hold = false;
      page.release();
      await page.until(() => hookNote(page).startsWith("Added webhook "));
      expect(page.elements["hook-url"].value).toBe("https://example.com/next");
      expect(page.elements["hook-body"].value).toBe('{"b":"{{delivery}}"}');
      expect(page.elements["hook-header-value"].value).toBe("");
      expect(db.prepare("SELECT url FROM webhooks").pluck().all()).toEqual(["https://example.com/one"]);
    });

    it("takes the form and any secret away on a 403, and asks for a token again on a 401", async () => {
      const page = await load(anaToken);
      await openWebhooks(page);
      fillHook(page, { url: "https://example.com/one", on: "#general" });
      addHook(page);
      await page.until(() => page.elements["webhook-secret"].value !== "");
      setPersonAdmin(db, "owner", "ana", false);
      fillHook(page, { url: "https://example.com/two", on: "#general" });
      addHook(page);
      await page.until(() => page.elements["log-note"].textContent.startsWith("The server says you are no longer an admin"));
      expect(page.elements["webhook-forms"].hidden).toBe(true);
      expect(page.elements["webhook-secret"].value).toBe("");
      expect(page.elements["webhook-made"].hidden).toBe(true);
      for (const field of formFields) expect(page.elements[field].value).toBe("");
      expect(hookEntry(page)).toBeUndefined();
      expect(hookCount()).toBe(1);

      setPersonAdmin(db, "owner", "ana", true);
      let refuse = false;
      const other = await load(anaToken, (url, init) => (refuse && init.method === "POST" && url === "/api/webhooks" ? 401 : undefined));
      await openWebhooks(other);
      refuse = true;
      fillHook(other, { url: "https://example.com/three", on: "#general" });
      addHook(other);
      await other.until(() => other.elements["status-line"].textContent === "The server refused that token. Enter another.");
      expect(other.store.size).toBe(0);
      expect(other.elements["webhook-forms"].hidden).toBe(true);
      expect(other.elements["hook-url"].value).toBe("");
      expect(other.elements["hook-add"].disabled).toBe(false);
    });

    it("shows no secret from an answer that comes after the view closed, another view opened, the token was forgotten or the person was unmarked", async () => {
      for (const leave of ["close", "other", "forget", "unmarked"]) {
        let hold = false;
        let demoted = false;
        const page = await load(anaToken, (url, init) => {
          if (hold && init.method === "POST" && url === "/api/webhooks") return "held";
          if (demoted && url.startsWith("/api/webhooks") && (init.method ?? "GET") === "GET") return { status: 403, reason: "Forbidden" };
          return undefined;
        });
        const before = hookCount();
        await openWebhooks(page);
        hold = true;
        fillHook(page, { url: "https://example.com/" + leave, on: "#general", name: "X-Api-Key", value: "sekret-value" });
        addHook(page);
        await page.until(() => page.held.length === 1);
        if (leave === "close") page.elements["close-log"].on.click();
        else if (leave === "other") page.elements["delivery-entry"].children[0].children[0].on.click();
        else if (leave === "forget") page.elements["forget"].on.click();
        else {
          demoted = true;
          await page.poll();
          await page.until(() => page.elements["log-note"].textContent.startsWith("The server says you are no longer an admin"));
        }
        hold = false;
        page.release();
        // The server added it, but the page shows nothing of it.
        await page.until(() => hookCount() === before + 1);
        await new Promise((resolve) => setTimeout(resolve, 50));
        const id = db.prepare("SELECT max(id) FROM webhooks").pluck().get() as number;
        expect(page.elements["webhook-secret"].value).toBe("");
        expect(page.elements["webhook-made"].hidden).toBe(true);
        expect(hookNote(page)).toBe("");
        expect(shownOutsideFields(page, secretOf(id))).toBe(false);
        expect(shownOutsideFields(page, "sekret-value")).toBe(false);
        expect(page.elements["hook-add"].disabled).toBe(false);
        expect(page.elements["webhook-forms"].hidden).toBe(true);
        if (leave === "other") expect(page.elements["log-title"].textContent).toBe("Webhook deliveries");
        if (leave === "forget") expect(hookEntry(page)).toBeUndefined();
      }
    });
  });

  describe("its tokens view", () => {
    const tokEntry = (page: Page) => page.elements["token-entry"].children[0]?.children[0] as Stub | undefined;
    const openTokens = async (page: Page) => {
      await page.until(() => tokEntry(page) !== undefined);
      tokEntry(page)!.on.click();
      await page.until(() => page.elements["log-note"].textContent !== "Loading…" && page.elements["log-title"].textContent === "Tokens");
    };
    const tokRows = (page: Page) => page.elements["post-rows"].children.map((r) => r.children.map((c) => c.textContent));
    const revokeButton = (page: Page, id: number) =>
      page.elements["post-rows"].children.find((r) => r.children[1].textContent === `token ${id}`)!.children.find((c) => c.textContent === "Revoke")!;
    const tokUrls = (page: Page) => page.requests.filter((r) => r.url.startsWith("/api/tokens"));
    const note = (page: Page) => page.elements["token-note"].textContent;
    const live = (id: number) => db.prepare("SELECT 1 FROM tokens WHERE id = ? AND revoked_at IS NULL").get(id) !== undefined;
    const made = (id: number) => at(new Date(db.prepare("SELECT created_at FROM tokens WHERE id = ?").pluck().get(id) as number).toISOString());
    // When the database last recorded a use of the token, as GET /api/tokens gives it, or null.
    const usedAt = (id: number) => {
      const ms = db.prepare("SELECT last_used_at FROM tokens WHERE id = ?").pluck().get(id) as number | null;
      return ms === null ? null : new Date(ms).toISOString();
    };
    const used = (id: number) => (usedAt(id) === null ? "never used" : `last used ${at(usedAt(id)!)}`);
    // The ids of the tokens beforeEach made: the read-only viewer, the agent token bound to no agent, and ana's.
    const idOf = (token: string) => db.prepare("SELECT id FROM tokens WHERE hash = ?").pluck().get(createHash("sha256").update(token).digest("hex")) as number;

    it("shows the Tokens entry to an admin person only, and never asks for the tokens with any other token", async () => {
      addPerson(db, "owner", "maria");
      const plain = addToken(db, "owner", false, false, undefined, "maria").token;
      for (const token of [plain, OWNER_TOKEN, viewer]) {
        const page = await load(token);
        await page.until(() => page.elements["approval-entry"].children.length === 1 && page.requests.some((r) => r.url === "/api/token"));
        await page.poll();
        expect(page.elements["token-entry"].children).toEqual([]);
        expect(tokUrls(page)).toEqual([]);
      }
      // An agent token is forgotten at once, so it sees no entry either.
      const agent = await load(agentToken);
      await agent.until(() => agent.store.size === 0);
      expect(agent.elements["token-entry"].children).toEqual([]);
      expect(tokUrls(agent)).toEqual([]);
      const page = await load(anaToken);
      await page.until(() => tokEntry(page) !== undefined);
      expect(tokEntry(page)!.children.map((c) => c.textContent)).toEqual(["Tokens", ""]);
      // Until the view is opened, the tokens are not read.
      expect(tokUrls(page)).toEqual([]);
    });

    it("lists the account's tokens oldest first with what each is for, never a token or hash, nor another account's", async () => {
      registerAgent(db, OWNER_ACCOUNT, "bob", "x");
      const bobId = identityOf(db, OWNER_ACCOUNT, "bob")!.id;
      const full = addToken(db, "owner");
      const bound = addToken(db, "owner", false, true, bobId);
      const registering = addToken(db, "owner", false, true, undefined, undefined, true);
      const oauth = addToken(db, "owner", false, true, bobId);
      recordClient(db, oauth.id, { name: "Evil\u202eClient\nid 1", host: "client.example" });
      const hosted = addToken(db, "owner", false, true, undefined, undefined, true);
      recordClient(db, hosted.id, { name: null, host: "host.example" });
      addPerson(db, "owner", "gone");
      const goneToken = addToken(db, "owner", false, false, undefined, "gone");
      registerAgent(db, OWNER_ACCOUNT, "lost", "x");
      const lostToken = addToken(db, "owner", false, true, identityOf(db, OWNER_ACCOUNT, "lost")!.id);
      removePerson(db, "owner", "gone");
      purgeAgent(db, "owner", "lost");
      addAccount(db, "other");
      addPerson(db, "other", "olga", true);
      const theirs = addToken(db, "other", false, false, undefined, "olga");
      expect((await fetch(`${base()}/api/agents`, { headers: auth(full.token) })).status).toBe(200);
      const page = await load(anaToken);
      await openTokens(page);
      const [v, a, me] = [idOf(viewer), idOf(agentToken), idOf(anaToken)];
      // ana's token is the one the page reads with, so it has been used; the full token is used once before the page
      // opens, and the others never.
      expect(usedAt(me)).not.toBeNull();
      expect(usedAt(full.id)).not.toBeNull();
      expect(usedAt(bound.id)).toBeNull();
      expect(tokRows(page)).toEqual([
        ["read-only", `token ${v}`, `made ${made(v)}`, used(v), "Revoke"],
        ["agent", `token ${a}`, `made ${made(a)}`, used(a), "bound to no agent", "Revoke"],
        ["person", `token ${me}`, `made ${made(me)}`, `last used ${at(usedAt(me)!)}`, "ana", "Revoke"],
        ["full", `token ${full.id}`, `made ${made(full.id)}`, `last used ${at(usedAt(full.id)!)}`, "Revoke"],
        ["agent", `token ${bound.id}`, `made ${made(bound.id)}`, "never used", "bob", "Revoke"],
        ["agent", `token ${registering.id}`, `made ${made(registering.id)}`, "never used", "registers its own agents", "Revoke"],
        ["agent", `token ${oauth.id}`, `made ${made(oauth.id)}`, "never used", "bob · client Evil\uFFFDClient\uFFFDid 1", "Revoke"],
        ["agent", `token ${hosted.id}`, `made ${made(hosted.id)}`, "never used", "registers its own agents · client host.example", "Revoke"],
        ["person", `token ${goneToken.id}`, `made ${made(goneToken.id)}`, "never used", "person removed", "Revoke"],
        ["agent", `token ${lostToken.id}`, `made ${made(lostToken.id)}`, "never used", "agent removed", "Revoke"],
      ]);
      // Each time's title is the raw ISO string; a never-used token's has none.
      const rowOf = (id: number) => page.elements["post-rows"].children.find((r) => r.children[1].textContent === `token ${id}`)!;
      expect(rowOf(full.id).children[3].title).toBe(usedAt(full.id));
      expect(rowOf(full.id).children[2].title).toBe(new Date(db.prepare("SELECT created_at FROM tokens WHERE id = ?").pluck().get(full.id) as number).toISOString());
      expect(rowOf(bound.id).children[3].title).toBe("");
      expect(tokEntry(page)!.children.map((c) => c.textContent)).toEqual(["Tokens", "10"]);
      expect(page.elements["log-note"].textContent).toBe("");
      const hashes = db.prepare("SELECT hash FROM tokens").pluck().all() as string[];
      for (const hidden of [viewer, agentToken, anaToken, full.token, bound.token, oauth.token, theirs.token, ...hashes, "olga", `token ${theirs.id}`]) {
        expect(onPage(page, hidden)).toBe(false);
      }
      expect(tokUrls(page).every((r) => r.method === "GET")).toBe(true);
    });

    it("says when only the first page of tokens is shown", async () => {
      for (let i = 0; i < 197; i++) addToken(db, "owner", true);
      const page = await load(anaToken);
      await openTokens(page);
      expect(page.elements["log-note"].textContent).toBe("Only the first 200 tokens are shown.");
      expect(tokRows(page)).toHaveLength(200);
    });

    it("revokes a token only after confirming, saying what it ended, and reads the list again", async () => {
      const bobId = (registerAgent(db, OWNER_ACCOUNT, "bob", "x"), identityOf(db, OWNER_ACCOUNT, "bob")!.id);
      const bound = addToken(db, "owner", false, true, bobId);
      const page = await load(anaToken);
      await openTokens(page);
      await page.until(() => tokRows(page).length === 4);
      // Revoke asks first; nothing is sent until it is confirmed, and Keep it sends nothing.
      revokeButton(page, bound.id).on.click();
      expect(page.elements["token-confirm"].hidden).toBe(false);
      expect(page.elements["token-text"].textContent).toBe(
        `Revoke token ${bound.id} (agent, bob)? This cannot be undone, and a request already running with it may finish.`,
      );
      page.elements["token-no"].on.click();
      expect(page.elements["token-confirm"].hidden).toBe(true);
      expect(page.writes()).toEqual([]);
      revokeButton(page, bound.id).on.click();
      page.elements["token-yes"].on.click();
      await page.until(() => note(page) === `Revoked token ${bound.id} (agent, bob).`);
      expect(page.writes()).toEqual([{ url: `/api/tokens?id=${bound.id}`, method: "DELETE", body: undefined }]);
      expect(page.elements["token-confirm"].hidden).toBe(true);
      expect(live(bound.id)).toBe(false);
      expect(live(idOf(viewer))).toBe(true);
      await page.until(() => tokRows(page).length === 3);
      expect(tokEntry(page)!.children.map((c) => c.textContent)).toEqual(["Tokens", "3"]);
      // The revoked token is refused from its next request.
      const res = await fetch(`${base()}/api/agents`, { headers: auth(bound.token) });
      expect(res.status).toBe(401);
    });

    it("says each other answer to a revoke in plain words, with Revoke token disabled while it is in flight", async () => {
      const id = idOf(viewer);
      let next: Refusal | undefined;
      const page = await load(anaToken, (url, init) => (init.method === "DELETE" ? next : undefined));
      await openTokens(page);
      const revokeOne = async (answer: Refusal | undefined, said: string) => {
        next = answer;
        revokeButton(page, id).on.click();
        page.elements["token-yes"].on.click();
        await page.until(() => note(page) === said);
        expect(page.elements["token-confirm"].hidden).toBe(true);
      };
      await revokeOne({ status: 400, reason: "Give id once" }, "Give id once");
      await revokeOne({ status: 503, reason: "Database busy", retry: true }, "The server is busy (503). Try again in a moment.");
      await revokeOne(413, "This is too long for the server (413).");
      await revokeOne(404, `Token ${id} was already revoked or gone (404).`);
      await revokeOne("fail", `No answer from the server, so token ${id} may or may not have been revoked: the list below shows which.`);
      next = "hang";
      revokeButton(page, id).on.click();
      page.elements["token-yes"].on.click();
      await page.until(() => page.deadlines.size > 0);
      expect(page.elements["token-yes"].disabled).toBe(true);
      // A second press while it is in flight sends nothing more.
      page.elements["token-yes"].on.click();
      expect(page.writes()).toHaveLength(6);
      for (const [, fn] of page.deadlines) fn();
      await page.until(() => note(page).startsWith(`The server did not answer in time, so token ${id} may or may not have been revoked`));
      expect(page.elements["token-yes"].disabled).toBe(false);
      // None of those was the server's own revoke.
      expect(live(id)).toBe(true);
      // The server's own 404, for a token revoked on the server meanwhile.
      next = undefined;
      revokeToken(db, id);
      await revokeOne(undefined, `Token ${id} was already revoked or gone (404).`);
      await page.until(() => tokRows(page).length === 2);
    });

    it("takes the entry and the view away on a 403 to either request, once the person is no longer an admin", async () => {
      for (const method of ["DELETE", "GET"]) {
        setPersonAdmin(db, "owner", "ana", true);
        const page = await load(anaToken);
        await openTokens(page);
        await page.until(() => tokRows(page).length > 0);
        setPersonAdmin(db, "owner", "ana", false);
        if (method === "DELETE") {
          revokeButton(page, idOf(viewer)).on.click();
          page.elements["token-yes"].on.click();
        } else {
          await page.poll();
        }
        await page.until(() => page.elements["log-note"].textContent.startsWith("The server says you are no longer an admin"));
        expect(page.elements["log-note"].textContent).toBe(
          "The server says you are no longer an admin of this account (403), so this page no longer lists, makes or revokes tokens.",
        );
        expect(tokEntry(page)).toBeUndefined();
        expect(page.entry()).toBeUndefined();
        expect(page.elements["post-rows"].children).toEqual([]);
        expect(page.elements["token-confirm"].hidden).toBe(true);
        expect(live(idOf(viewer))).toBe(true);
        // The next poll does not read the tokens again.
        const before = page.requests.length;
        await page.poll();
        await page.until(() => page.requests.slice(before).some((r) => r.url.startsWith("/api/messages")));
        expect(page.requests.slice(before).filter((r) => r.url.startsWith("/api/tokens"))).toEqual([]);
      }
    });

    it("asks for a token again on a 401 to either request", async () => {
      for (const method of ["DELETE", "GET"]) {
        let refuse = false;
        const page = await load(anaToken, (url, init) => (refuse && url.startsWith("/api/tokens") && (init.method ?? "GET") === method ? 401 : undefined));
        await openTokens(page);
        await page.until(() => tokRows(page).length > 0);
        refuse = true;
        if (method === "DELETE") {
          revokeButton(page, idOf(viewer)).on.click();
          page.elements["token-yes"].on.click();
        } else {
          await page.poll();
        }
        await page.until(() => page.elements["status-line"].textContent === "The server refused that token. Enter another.");
        expect(page.store.size).toBe(0);
        expect(tokEntry(page)).toBeUndefined();
        expect(page.elements["post-rows"].children).toEqual([]);
        expect(live(idOf(viewer))).toBe(true);
      }
    });

    it("warns before revoking the page's own person's token, and asks for a token at the next poll once it is revoked", async () => {
      const me = idOf(anaToken);
      const page = await load(anaToken);
      await openTokens(page);
      revokeButton(page, me).on.click();
      expect(page.elements["token-text"].textContent).toBe(
        `Revoke token ${me} (person, ana)? This cannot be undone, and a request already running with it may finish.` +
          " It may be the token this browser is signed in with: revoking it signs this page out at its next request.",
      );
      // Another person's token, or another kind, has no such warning.
      page.elements["token-no"].on.click();
      revokeButton(page, idOf(viewer)).on.click();
      expect(page.elements["token-text"].textContent).not.toContain("signed in with");
      page.elements["token-no"].on.click();
      revokeButton(page, me).on.click();
      page.elements["token-yes"].on.click();
      // The DELETE's 200 reads the list again, whose 401 asks for another token.
      await page.until(() => page.elements["status-line"].textContent === "The server refused that token. Enter another.");
      expect(live(me)).toBe(false);
      expect(page.store.size).toBe(0);
      expect(tokEntry(page)).toBeUndefined();
      expect(page.elements["post-rows"].children).toEqual([]);
    });

    it("closes a confirmation once the list no longer gives its token as it was, sending nothing", async () => {
      const bobId = (registerAgent(db, OWNER_ACCOUNT, "bob", "x"), identityOf(db, OWNER_ACCOUNT, "bob")!.id);
      const bound = addToken(db, "owner", false, true, bobId);
      const page = await load(anaToken);
      await openTokens(page);
      revokeButton(page, bound.id).on.click();
      // A poll that lists it as it was keeps the confirmation open.
      const before = page.requests.length;
      await page.poll();
      await page.until(() => page.requests.slice(before).some((r) => r.url.startsWith("/api/tokens")));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(page.elements["token-confirm"].hidden).toBe(false);
      // Its agent removed, the token is listed differently, so the confirmation closes.
      purgeAgent(db, "owner", "bob");
      await page.poll();
      await page.until(() => page.elements["token-confirm"].hidden);
      expect(note(page)).toBe(`Token ${bound.id} (agent, bob) changed or went from the list, so its confirmation closed and nothing was sent.`);
      page.elements["token-yes"].on.click();
      expect(page.writes()).toEqual([]);
      // One revoked on the server goes from the list, which closes its confirmation too.
      revokeButton(page, bound.id).on.click();
      revokeToken(db, bound.id);
      await page.poll();
      await page.until(() => page.elements["token-confirm"].hidden);
      expect(note(page)).toBe(`Token ${bound.id} (agent, agent removed) changed or went from the list, so its confirmation closed and nothing was sent.`);
      expect(page.writes()).toEqual([]);
    });

    it("keeps a confirmation open when only its token's last use changed, and draws the new time", async () => {
      const bobId = (registerAgent(db, OWNER_ACCOUNT, "bob", "x"), identityOf(db, OWNER_ACCOUNT, "bob")!.id);
      const bound = addToken(db, "owner", false, true, bobId);
      const page = await load(anaToken);
      await openTokens(page);
      expect(revokeButton(page, bound.id)).toBeDefined();
      revokeButton(page, bound.id).on.click();
      // A newer use of the token, as a request two minutes on would record it, changes only its lastUsedAt.
      const later = Date.now() + 120_000;
      db.prepare("UPDATE tokens SET last_used_at = ? WHERE id = ?").run(later, bound.id);
      const before = page.requests.length;
      await page.poll();
      await page.until(() => page.requests.slice(before).some((r) => r.url.startsWith("/api/tokens")));
      const iso = new Date(later).toISOString();
      await page.until(() => tokRows(page).some((r) => r[1] === `token ${bound.id}` && r[3] === `last used ${at(iso)}`));
      expect(page.elements["token-confirm"].hidden).toBe(false);
      expect(note(page)).toBe("");
      // The confirmation still revokes the token it describes.
      page.elements["token-yes"].on.click();
      await page.until(() => note(page) === `Revoked token ${bound.id} (agent, bob).`);
      expect(live(bound.id)).toBe(false);
    });

    it("still closes a confirmation when its token changed in more than its last use", async () => {
      const bobId = (registerAgent(db, OWNER_ACCOUNT, "bob", "x"), identityOf(db, OWNER_ACCOUNT, "bob")!.id);
      const bound = addToken(db, "owner", false, true, bobId);
      const page = await load(anaToken);
      await openTokens(page);
      revokeButton(page, bound.id).on.click();
      db.prepare("UPDATE tokens SET last_used_at = ? WHERE id = ?").run(Date.now() + 120_000, bound.id);
      purgeAgent(db, "owner", "bob");
      await page.poll();
      await page.until(() => page.elements["token-confirm"].hidden);
      expect(note(page)).toBe(`Token ${bound.id} (agent, bob) changed or went from the list, so its confirmation closed and nothing was sent.`);
      page.elements["token-yes"].on.click();
      expect(page.writes()).toEqual([]);
    });

    it("shows a token list whose last use or made time is not as GET /api/tokens gives it as unreadable", async () => {
      for (const [field, value] of [
        ["lastUsedAt", 5],
        ["lastUsedAt", undefined],
        ["lastUsedAt", { at: "now" }],
        ["createdAt", null],
      ] as const) {
        let odd = false;
        const page = await load(anaToken, (url, init) =>
          odd && url.startsWith("/api/tokens") && (init.method ?? "GET") === "GET"
            ? { rewrite: (items: Record<string, unknown>[]) => items.map((t) => ({ ...t, [field]: value })) }
            : undefined,
        );
        await openTokens(page);
        expect(tokRows(page).length).toBeGreaterThan(0);
        odd = true;
        await page.poll();
        await page.until(() => page.elements["log-note"].textContent === "The server sent an answer this page cannot read. Retrying…");
      }
    });

    it("drops a revoke's answer that comes after the view closed, another view opened or the token was forgotten", async () => {
      let hold = false;
      const page = await load(anaToken, (url, init) => (hold && init.method === "DELETE" ? "held" : undefined));
      for (const leave of ["close", "other", "forget"]) {
        const extra = addToken(db, "owner", true);
        await openTokens(page);
        await page.until(() => tokRows(page).some((r) => r[1] === `token ${extra.id}`));
        hold = true;
        revokeButton(page, extra.id).on.click();
        page.elements["token-yes"].on.click();
        await page.until(() => page.held.length === 1);
        if (leave === "close") page.elements["close-log"].on.click();
        else if (leave === "other") page.elements["delivery-entry"].children[0].children[0].on.click();
        else page.elements["forget"].on.click();
        hold = false;
        page.release();
        // The server revoked it, but the page says nothing of it.
        await page.until(() => !live(extra.id));
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(note(page)).toBe("");
        expect(page.elements["token-confirm"].hidden).toBe(true);
        expect(page.elements["token-yes"].disabled).toBe(false);
        if (leave === "other") {
          expect(page.elements["log-title"].textContent).toBe("Webhook deliveries");
          expect(page.elements["post-rows"].children.every((r) => !r.className.startsWith("entry token"))).toBe(true);
        }
        if (leave === "forget") {
          expect(page.elements["log"].hidden).toBe(true);
          expect(tokEntry(page)).toBeUndefined();
        }
      }
    });

    it("drops a read that comes after the view closed or the token was forgotten", async () => {
      for (const leave of ["close", "forget"]) {
        let hold = false;
        const page = await load(anaToken, (url) => (hold && url.startsWith("/api/tokens") ? "held" : undefined));
        await page.until(() => tokEntry(page) !== undefined);
        hold = true;
        tokEntry(page)!.on.click();
        await page.until(() => page.held.length === 1);
        if (leave === "close") page.elements["close-log"].on.click();
        else page.elements["forget"].on.click();
        page.release();
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(page.elements["log"].hidden).toBe(true);
        expect(page.elements["post-rows"].children).toEqual([]);
        expect(page.elements["log-note"].textContent).toBe("");
        if (leave === "close") expect(tokEntry(page)!.children.map((c) => c.textContent)).toEqual(["Tokens", ""]);
        else expect(tokEntry(page)).toBeUndefined();
      }
    });

    describe("making a token", () => {
      const shown = (page: Page) => page.elements["token-value"].value;
      const makeNote = (page: Page) => page.elements["token-make-note"].textContent;
      const make = (page: Page, kind: "read-only" | "agent") => {
        page.elements["token-kind"].value = kind;
        submit(page.elements["token-form"]);
      };
      const unrevoked = (account: string) =>
        db.prepare("SELECT t.id FROM tokens t JOIN accounts a ON a.id = t.account_id WHERE a.name = ? AND t.revoked_at IS NULL ORDER BY t.id").pluck().all(account);

      it("offers the form to an admin person only, and never makes a token with any other token", async () => {
        addPerson(db, "owner", "maria");
        const plain = addToken(db, "owner", false, false, undefined, "maria").token;
        for (const token of [plain, OWNER_TOKEN, viewer, agentToken]) {
          const page = await load(token);
          await page.until(() => page.requests.some((r) => r.url === "/api/token"));
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(page.elements["token-forms"].hidden).toBe(true);
          submit(page.elements["token-form"]);
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(page.writes()).toEqual([]);
        }
        const page = await load(anaToken);
        // Not until the view is open.
        await page.until(() => tokEntry(page) !== undefined);
        expect(page.elements["token-forms"].hidden).toBe(true);
        await openTokens(page);
        expect(page.elements["token-forms"].hidden).toBe(false);
      });

      it("makes each kind with exactly its body, shows the token once in its field, and the token works", async () => {
        addAccount(db, "other");
        addToken(db, "other", true);
        const theirs = unrevoked("other");
        const page = await load(anaToken);
        await openTokens(page);
        await page.until(() => tokRows(page).length === 3);

        make(page, "read-only");
        await page.until(() => shown(page) !== "");
        expect(page.writes()).toEqual([{ url: "/api/tokens", method: "POST", body: { kind: "read-only" } }]);
        const readOnly = shown(page);
        const readOnlyId = idOf(readOnly);
        expect(page.elements["token-made"].hidden).toBe(false);
        expect(page.elements["token-for"].textContent).toBe(
          `New read-only token ${readOnlyId}. It shows only here, at most until you leave this view, and is never shown again.`,
        );
        expect(makeNote(page)).toBe("");
        // Only in its field: nowhere else on the page, nor stored.
        expect(Object.entries(page.elements).some(([id, node]) => id !== "token-value" && JSON.stringify(node, (k, v) => (k === "on" ? undefined : v)).includes(readOnly))).toBe(false);
        expect([...page.store.values()]).not.toContain(readOnly);
        // The list is read again, so it shows the new one.
        await page.until(() => tokRows(page).some((r) => r[1] === `token ${readOnlyId}`));
        expect(tokRows(page).find((r) => r[1] === `token ${readOnlyId}`)![0]).toBe("read-only");
        // Copy puts it on the clipboard.
        page.elements["token-copy"].on.click();
        await page.until(() => page.elements["token-copy-note"].textContent === "Copied.");
        expect(page.copied).toEqual([readOnly]);
        // It reads the account, and cannot write.
        const read = await fetch(`${base()}/api/agents`, { headers: auth(readOnly) });
        expect(read.status).toBe(200);
        expect(accountForToken(db, readOnly, OWNER_TOKEN)).toMatchObject({ account: OWNER_ACCOUNT, readOnly: true, agentOnly: false });

        make(page, "agent");
        await page.until(() => shown(page) !== "" && shown(page) !== readOnly);
        expect(page.writes().slice(1)).toEqual([{ url: "/api/tokens", method: "POST", body: { kind: "agent" } }]);
        const agent = shown(page);
        const agentId = idOf(agent);
        expect(page.elements["token-for"].textContent).toBe(
          `New agent token ${agentId}, bound to no agent, so a client using it must still name its agent. It shows only here, at most until you leave this view, and is never shown again.`,
        );
        expect(page.elements["token-copy-note"].textContent).toBe("");
        await page.until(() => tokRows(page).some((r) => r[1] === `token ${agentId}`));
        expect(tokRows(page).find((r) => r[1] === `token ${agentId}`)).toEqual(["agent", `token ${agentId}`, `made ${made(agentId)}`, "never used", "bound to no agent", "Revoke"]);
        // It is refused the dashboard API, as every agent token is, and reaches /mcp.
        expect((await fetch(`${base()}/api/agents`, { headers: auth(agent) })).status).toBe(403);
        const mcp = await fetch(`${base()}/mcp`, {
          method: "POST",
          headers: { ...auth(agent), "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
        });
        expect(mcp.status).toBe(200);
        await mcp.body?.cancel();
        expect(accountForToken(db, agent, OWNER_TOKEN)).toMatchObject({ account: OWNER_ACCOUNT, agentOnly: true });
        // Another account's tokens are as they were.
        expect(unrevoked("other")).toEqual(theirs);
        // Leaving the view empties the field and its line.
        page.elements["close-log"].on.click();
        expect(shown(page)).toBe("");
        expect(page.elements["token-for"].textContent).toBe("");
        expect(page.elements["token-made"].hidden).toBe(true);
        expect(page.elements["token-forms"].hidden).toBe(true);
        expect(Object.values(page.elements).some((node) => JSON.stringify(node, (k, v) => (k === "on" ? undefined : v)).includes(agent))).toBe(false);
        // Opening it again shows no token.
        await openTokens(page);
        expect(shown(page)).toBe("");
        expect(page.elements["token-made"].hidden).toBe(true);
      });

      it("says each other answer plainly, with Make token disabled while it is in flight", async () => {
        let next: Refusal | "junk" | undefined;
        const page = await load(anaToken, (url, init) => (init.method === "POST" && url === "/api/tokens" ? (next === "junk" ? 200 : next) : undefined));
        await openTokens(page);
        const answer = async (value: Refusal | "junk", said: string) => {
          next = value;
          make(page, "read-only");
          await page.until(() => makeNote(page) === said);
          expect(shown(page)).toBe("");
          expect(page.elements["token-made"].hidden).toBe(true);
          expect(page.elements["token-make"].disabled).toBe(false);
        };
        // A token an earlier 200 showed goes when the next attempt starts, so a refusal never sits beside it.
        next = undefined;
        make(page, "read-only");
        await page.until(() => shown(page) !== "");
        await answer({ status: 400, reason: 'Give only kind, as "read-only" or "agent"' }, 'Give only kind, as "read-only" or "agent"');
        expect(page.elements["token-for"].textContent).toBe("");
        await answer(413, "This is too long for the server (413).");
        await answer({ status: 503, reason: "Database busy", retry: true }, "The server is busy (503). Try again in a moment.");
        await answer(
          "junk",
          "A token may have been made, but this page cannot show it." +
            " The list below cannot show which read-only token this attempt made, so revoke one there only if you know it is that one, then make another.",
        );
        await answer(
          "fail",
          "No answer from the server, so a token may or may not have been made, and no token can be shown for it." +
            " The list below cannot show which read-only token this attempt made, so revoke one there only if you know it is that one, then make another.",
        );
        next = "hang";
        make(page, "agent");
        await page.until(() => page.deadlines.size > 0);
        expect(page.elements["token-make"].disabled).toBe(true);
        expect(makeNote(page)).toBe("Making a token…");
        // A second press while it is in flight sends nothing more.
        make(page, "agent");
        expect(page.writes()).toHaveLength(7);
        for (const [, fn] of page.deadlines) fn();
        await page.until(() => makeNote(page).startsWith("The server did not answer in time, so a token may or may not have been made"));
        expect(page.elements["token-make"].disabled).toBe(false);
        expect(page.writes().map((w) => w.body)).toEqual([
          { kind: "read-only" },
          { kind: "read-only" },
          { kind: "read-only" },
          { kind: "read-only" },
          { kind: "read-only" },
          { kind: "read-only" },
          { kind: "agent" },
        ]);
        // Only the first reached the server; it made one token.
        expect(tokRows(page)).toHaveLength(4);
      });

      it("drops the made token and the form on a 403 to it or to the list, once the person is no longer an admin", async () => {
        for (const method of ["POST", "GET"]) {
          setPersonAdmin(db, "owner", "ana", true);
          const page = await load(anaToken);
          await openTokens(page);
          make(page, "read-only");
          await page.until(() => shown(page) !== "");
          const before = unrevoked("owner").length;
          setPersonAdmin(db, "owner", "ana", false);
          if (method === "POST") make(page, "agent");
          else await page.poll();
          await page.until(() => page.elements["log-note"].textContent.startsWith("The server says you are no longer an admin"));
          expect(shown(page)).toBe("");
          expect(page.elements["token-for"].textContent).toBe("");
          expect(page.elements["token-made"].hidden).toBe(true);
          expect(page.elements["token-forms"].hidden).toBe(true);
          expect(unrevoked("owner")).toHaveLength(before);
          // The hidden form sends nothing more.
          const writes = page.writes().length;
          submit(page.elements["token-form"]);
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(page.writes()).toHaveLength(writes);
        }
      });

      it("asks for a token again on a 401", async () => {
        const page = await load(anaToken, (url, init) => (init.method === "POST" && url === "/api/tokens" ? 401 : undefined));
        await openTokens(page);
        make(page, "agent");
        await page.until(() => page.elements["status-line"].textContent === "The server refused that token. Enter another.");
        expect(page.store.size).toBe(0);
        expect(tokEntry(page)).toBeUndefined();
        expect(page.elements["token-forms"].hidden).toBe(true);
        expect(shown(page)).toBe("");
      });

      it("shows no token from an answer that comes after the view closed, another view opened or the token was forgotten", async () => {
        let hold = false;
        let fail = false;
        const page = await load(anaToken, (url, init) => (init.method === "POST" && url === "/api/tokens" ? (fail ? "fail" : hold ? "held" : undefined) : undefined));
        for (const leave of ["close", "other", "forget"]) {
          await openTokens(page);
          const before = unrevoked("owner").length;
          hold = true;
          make(page, "agent");
          await page.until(() => page.held.length === 1);
          if (leave === "close") page.elements["close-log"].on.click();
          else if (leave === "other") page.elements["delivery-entry"].children[0].children[0].on.click();
          else page.elements["forget"].on.click();
          hold = false;
          page.release();
          // The server made it, but the page shows no token.
          await page.until(() => unrevoked("owner").length === before + 1);
          await new Promise((resolve) => setTimeout(resolve, 50));
          expect(shown(page)).toBe("");
          expect(page.elements["token-made"].hidden).toBe(true);
          expect(note(page)).toBe("");
          expect(page.elements["token-make"].disabled).toBe(false);
          if (leave === "forget") {
            expect(page.elements["log"].hidden).toBe(true);
            expect(tokEntry(page)).toBeUndefined();
          }
        }
      });

      it("says in the list's note that a token was, or may have been, made when its answer comes after the view was left and opened again", async () => {
        let next: "held" | "hang" | undefined;
        const page = await load(anaToken, (url, init) => (init.method === "POST" && url === "/api/tokens" ? next : undefined));
        const reads = () => page.requests.filter((r) => r.url.startsWith("/api/tokens") && r.method === "GET").length;
        for (const outcome of ["held", "hang"] as const) {
          await openTokens(page);
          const before = unrevoked("owner").length;
          next = outcome;
          make(page, outcome === "held" ? "agent" : "read-only");
          await page.until(() => (outcome === "held" ? page.held.length === 1 : page.deadlines.size > 0));
          page.elements["close-log"].on.click();
          await openTokens(page);
          next = undefined;
          const read = reads();
          if (outcome === "held") page.release();
          else for (const [, fn] of page.deadlines) fn();
          await page.until(() => note(page) !== "");
          expect(note(page)).toBe(
            outcome === "held"
              ? "This page made an agent token, but its answer came after the view it was made from closed or changed, so it is not shown and never will be." +
                " The list below cannot show which agent token this attempt made, so revoke one there only if you know it is that one, then make another."
              : "The server did not answer in time, so a read-only token may or may not have been made, and no token can be shown for it." +
                " The list below cannot show which read-only token this attempt made, so revoke one there only if you know it is that one, then make another.",
          );
          expect(shown(page)).toBe("");
          expect(page.elements["token-made"].hidden).toBe(true);
          expect(makeNote(page)).toBe("");
          expect(unrevoked("owner")).toHaveLength(outcome === "held" ? before + 1 : before);
          await page.until(() => reads() > read);
          page.elements["close-log"].on.click();
        }
      });
    });
  });

  it("asks for a token again on a 401 to any of its requests", async () => {
    for (const method of ["POST", "GET"]) {
      let refuse = false;
      const page = await load(anaToken, (url) => (refuse && url.startsWith(method === "POST" ? "/api/people" : "/api/invites") ? 401 : undefined));
      await page.openInvites();
      refuse = true;
      if (method === "POST") {
        page.elements["person-name"].value = "ben";
        submit(page.elements["person-form"]);
      } else {
        await page.poll();
      }
      await page.until(() => page.elements["status-line"].textContent === "The server refused that token. Enter another.");
      expect(page.store.size).toBe(0);
      expect(page.entry()).toBeUndefined();
    }
  });
});
