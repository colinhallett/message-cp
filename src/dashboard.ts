import { createHash } from "node:crypto";

// The page served at GET / by `message-cp serve`. It holds no data and no token: it asks for a token, keeps it in
// sessionStorage (that tab only), and polls GET /api/agents with it. It only reads, and puts agent-supplied text on the
// page with textContent, never as HTML.

const STYLE = `
body { font: 14px/1.4 system-ui, sans-serif; margin: 2em auto; max-width: 70em; padding: 0 1em; color: #222; }
h1 { font-size: 1.4em; }
form { margin: 1em 0; }
input { font: inherit; width: 30em; max-width: 100%; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 0.3em 0.6em; border-bottom: 1px solid #ddd; vertical-align: top; }
td.n { text-align: right; }
#status-line { min-height: 1.4em; }
#status-line.error { color: #a00; }
[hidden] { display: none; }
`;

const SCRIPT = `
"use strict";
const KEY = "message-cp-token";
const PAGE = 200;
const POLL_MS = 5000;
const form = document.getElementById("login");
const input = document.getElementById("token");
const view = document.getElementById("view");
const rows = document.getElementById("rows");
const statusLine = document.getElementById("status-line");
let timer;
let generation = 0;

function say(text, isError) {
  statusLine.textContent = text;
  statusLine.className = isError ? "error" : "";
}

function ask(message) {
  sessionStorage.removeItem(KEY);
  generation++;
  clearTimeout(timer);
  // Clear the table, so one token's agents never show under the next token.
  rows.replaceChildren();
  view.hidden = true;
  say(message || "", true);
  form.hidden = false;
  input.value = "";
  input.focus();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const token = input.value.trim();
  if (!token) return;
  sessionStorage.setItem(KEY, token);
  input.value = "";
  start();
});

document.getElementById("forget").addEventListener("click", () => ask());

function start() {
  generation++;
  clearTimeout(timer);
  form.hidden = true;
  view.hidden = false;
  say("Loading…", false);
  poll(generation);
}

async function fetchAll(token) {
  const agents = [];
  for (let offset = 0; ; offset += PAGE) {
    const res = await fetch("/api/agents?limit=" + PAGE + "&offset=" + offset, {
      headers: { Authorization: "Bearer " + token },
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!res.ok) return { status: res.status };
    let page;
    try {
      page = await res.json();
    } catch {
      page = undefined;
    }
    if (!Array.isArray(page)) return { error: "The server sent an answer this page cannot read" };
    agents.push(...page);
    if (page.length < PAGE) return { agents };
  }
}

async function poll(gen) {
  const token = sessionStorage.getItem(KEY);
  if (!token) return ask();
  let result;
  try {
    result = await fetchAll(token);
  } catch {
    result = { error: "Cannot reach the server" };
  }
  // A newer token or a sign-out since this poll began: drop its answer.
  if (gen !== generation) return;
  if (result.status === 401) return ask("The server refused that token. Enter another.");
  if (result.agents) {
    show(result.agents);
    say("", false);
  } else if (result.status === 403) {
    say("This token cannot read agents (403). Retrying…", true);
  } else if (result.status === 503) {
    say("The server is busy (503). Retrying…", true);
  } else {
    say((result.error || "The server answered " + result.status) + ". Retrying…", true);
  }
  timer = setTimeout(() => poll(gen), POLL_MS);
}

function ago(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return String(iso);
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

function cell(text, className) {
  const td = document.createElement("td");
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function show(agents) {
  const trs = agents.map((a) => {
    const tr = document.createElement("tr");
    const seen = cell(ago(a.lastSeen));
    seen.title = String(a.lastSeen);
    tr.append(
      cell(String(a.name)),
      cell(String(a.bio)),
      seen,
      cell(String(a.unreadMessages), "n"),
      cell(String(a.unreadPosts), "n"),
      cell(a.online ? "online" : "–"),
    );
    return tr;
  });
  if (trs.length === 0) {
    const td = cell("No agents registered in this account.");
    td.colSpan = 6;
    const tr = document.createElement("tr");
    tr.append(td);
    trs.push(tr);
  }
  rows.replaceChildren(...trs);
}

if (sessionStorage.getItem(KEY)) start();
else ask();
`;

const hash = (text: string) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>message-cp</title>
<style>${STYLE}</style>
</head>
<body>
<h1>message-cp agents</h1>
<p id="status-line" role="status"></p>
<form id="login" hidden>
<label for="token">Token for your account (read-only is enough), kept in this tab only:</label><br>
<input id="token" type="password" autocomplete="off" required>
<button type="submit">Show agents</button>
</form>
<div id="view" hidden>
<table>
<thead><tr><th>Name</th><th>Bio</th><th>Last seen</th><th>Unread messages</th><th>Unread posts</th><th>Online</th></tr></thead>
<tbody id="rows"></tbody>
</table>
<p><button id="forget" type="button">Forget token</button></p>
</div>
<script>${SCRIPT}</script>
</body>
</html>
`;

/** Headers for GET /: the inline style and script run by hash, every request stays on this origin, and nothing frames it. */
export const DASHBOARD_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": [
    "default-src 'none'",
    `script-src ${hash(SCRIPT)}`,
    `style-src ${hash(STYLE)}`,
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};
