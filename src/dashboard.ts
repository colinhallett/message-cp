import { createHash } from "node:crypto";

// The page served at GET / by `message-cp serve`. It holds no data and no token: it asks for a token, keeps it in
// sessionStorage (that tab only), and polls GET /api/agents, GET /api/channels and, while one is open, a channel's
// GET /api/channel-posts with it. It only reads, and puts agent-supplied text on the page with textContent, never as HTML.

const STYLE = `
body { font: 14px/1.4 system-ui, sans-serif; margin: 2em auto; max-width: 70em; padding: 0 1em; color: #222; }
h1 { font-size: 1.4em; }
h2 { font-size: 1.15em; margin-top: 1.5em; }
form { margin: 1em 0; }
input { font: inherit; width: 30em; max-width: 100%; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 0.3em 0.6em; border-bottom: 1px solid #ddd; vertical-align: top; }
td.n { text-align: right; }
td.body { white-space: pre-wrap; overflow-wrap: anywhere; }
#status-line { min-height: 1.4em; }
#status-line.error { color: #a00; }
[hidden] { display: none; }
`;

const SCRIPT = `
"use strict";
const KEY = "message-cp-token";
const PAGE = 200;
const POLL_MS = 5000;
// A poll that has not finished by then is abandoned, so a request that never completes cannot stop the polling.
const TIMEOUT_MS = 15000;
const form = document.getElementById("login");
const input = document.getElementById("token");
const view = document.getElementById("view");
const rows = document.getElementById("rows");
const channelRows = document.getElementById("channel-rows");
const log = document.getElementById("log");
const logTitle = document.getElementById("log-title");
const logNote = document.getElementById("log-note");
const postRows = document.getElementById("post-rows");
const statusLine = document.getElementById("status-line");
let timer;
let generation = 0;
let controller;
// The channel whose log is open, or undefined.
let openChannel;

function say(text, isError) {
  statusLine.textContent = text;
  statusLine.className = isError ? "error" : "";
}

// Ends the current poll: its answer is dropped, its timer cleared and its request aborted.
function cancel() {
  generation++;
  clearTimeout(timer);
  if (controller) controller.abort();
}

function ask(message) {
  sessionStorage.removeItem(KEY);
  cancel();
  // Clear the tables, so one token's agents and channels never show under the next token.
  rows.replaceChildren();
  channelRows.replaceChildren();
  closeLog();
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
document.getElementById("close-log").addEventListener("click", () => closeLog());

function closeLog() {
  openChannel = undefined;
  postRows.replaceChildren();
  logTitle.textContent = "";
  logNote.textContent = "";
  log.hidden = true;
}

// Opens a channel's log and polls again at once; the poll in flight is dropped, so a slow answer for the channel
// open before is never shown under this one.
function openLog(name) {
  openChannel = name;
  postRows.replaceChildren();
  logTitle.textContent = name;
  logNote.textContent = "Loading…";
  log.hidden = false;
  cancel();
  poll(generation);
}

function start() {
  cancel();
  form.hidden = true;
  view.hidden = false;
  say("Loading…", false);
  poll(generation);
}

// Fetches every page of path, PAGE at a time. items picks a page's list out of its answer, or undefined if there is none.
async function fetchAll(token, signal, path, params, items) {
  const all = [];
  for (let offset = 0; ; offset += PAGE) {
    const query = new URLSearchParams(params);
    query.set("limit", String(PAGE));
    query.set("offset", String(offset));
    const res = await fetch(path + "?" + query, {
      headers: { Authorization: "Bearer " + token },
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal,
    });
    if (!res.ok) return { status: res.status };
    let page;
    try {
      page = items(await res.json());
    } catch {
      page = undefined;
    }
    if (!Array.isArray(page)) return { error: "The server sent an answer this page cannot read" };
    all.push(...page);
    if (page.length < PAGE) return { items: all };
  }
}

const list = (answer) => answer;
const postsOf = (answer) => (answer && typeof answer === "object" ? answer.posts : undefined);

// Fetches the agents, the channels and the open channel's posts in turn, stopping at the first that fails (a channel
// that has gone, 404, is not a failure).
async function fetchView(token, signal, channel) {
  const agents = await fetchAll(token, signal, "/api/agents", {}, list);
  if (!agents.items) return agents;
  const channels = await fetchAll(token, signal, "/api/channels", {}, list);
  if (!channels.items) return channels;
  if (channel === undefined) return { agents: agents.items, channels: channels.items };
  const channelPosts = await fetchAll(token, signal, "/api/channel-posts", { channel }, postsOf);
  if (!channelPosts.items && channelPosts.status !== 404) return channelPosts;
  return { agents: agents.items, channels: channels.items, posts: channelPosts.items };
}

async function poll(gen) {
  const token = sessionStorage.getItem(KEY);
  if (!token) return ask();
  const ac = new AbortController();
  controller = ac;
  const deadline = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const channel = openChannel;
  let result;
  try {
    result = await fetchView(token, ac.signal, channel);
  } catch {
    result = { error: ac.signal.aborted ? "The server did not answer in time" : "Cannot reach the server" };
  } finally {
    clearTimeout(deadline);
  }
  // A newer token or a sign-out since this poll began: drop its answer.
  if (gen !== generation) return;
  if (result.status === 401) return ask("The server refused that token. Enter another.");
  if (result.agents) {
    show(result.agents);
    showChannels(result.channels);
    // The log may have been closed while this poll ran (opening one starts a new poll).
    if (channel !== undefined && channel === openChannel) showLog(result.posts);
    say("", false);
  } else if (result.status === 403) {
    say("This token cannot read agents or channels (403). Retrying…", true);
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
  if (trs.length === 0) trs.push(emptyRow("No agents registered in this account.", 6));
  rows.replaceChildren(...trs);
}

function emptyRow(text, columns) {
  const td = cell(text);
  td.colSpan = columns;
  const tr = document.createElement("tr");
  tr.append(td);
  return tr;
}

function showChannels(channels) {
  const trs = channels.map((c) => {
    const tr = document.createElement("tr");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = String(c.name);
    button.addEventListener("click", () => openLog(String(c.name)));
    const name = document.createElement("td");
    name.append(button);
    const members = Array.isArray(c.members) ? c.members.map(String).join(", ") : "";
    const last = cell(c.lastPostAt == null ? "–" : ago(c.lastPostAt));
    if (c.lastPostAt != null) last.title = String(c.lastPostAt);
    tr.append(name, cell(members || "–"), cell(String(c.posts), "n"), last);
    return tr;
  });
  if (trs.length === 0) trs.push(emptyRow("No channels in this account.", 4));
  channelRows.replaceChildren(...trs);
}

// posts is undefined when the open channel was not found.
function showLog(posts) {
  if (!posts) {
    postRows.replaceChildren();
    logNote.textContent = "There is no channel by this name now.";
    return;
  }
  const trs = posts.map((p) => {
    const tr = document.createElement("tr");
    const time = cell(when(p.sentAt));
    time.title = String(p.sentAt);
    tr.append(cell(String(p.from)), time, cell(String(p.body), "body"));
    return tr;
  });
  logNote.textContent = trs.length === 0 ? "No posts yet." : "";
  postRows.replaceChildren(...trs);
}

function when(iso) {
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : String(iso);
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
<h1>message-cp</h1>
<p id="status-line" role="status"></p>
<form id="login" hidden>
<label for="token">Token for your account (read-only is enough), kept in this tab only:</label><br>
<input id="token" type="password" autocomplete="off" required>
<button type="submit">Show agents and channels</button>
</form>
<div id="view" hidden>
<table>
<thead><tr><th>Name</th><th>Bio</th><th>Last seen</th><th>Unread messages</th><th>Unread posts</th><th>Online</th></tr></thead>
<tbody id="rows"></tbody>
</table>
<h2>Channels</h2>
<table>
<thead><tr><th>Name</th><th>Members</th><th>Posts</th><th>Last post</th></tr></thead>
<tbody id="channel-rows"></tbody>
</table>
<div id="log" hidden>
<h2>Channel <span id="log-title"></span></h2>
<p id="log-note"></p>
<table>
<thead><tr><th>From</th><th>Sent</th><th>Post</th></tr></thead>
<tbody id="post-rows"></tbody>
</table>
<p><button id="close-log" type="button">Close channel</button></p>
</div>
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
