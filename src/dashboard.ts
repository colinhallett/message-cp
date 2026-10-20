import { createHash } from "node:crypto";

// The page served at GET / by `message-cp serve`. It holds no data and no token: it asks for a token, keeps it in
// sessionStorage (that tab only), and polls GET /api/agents, GET /api/channels, GET /api/messages and, while one is
// open, a channel's GET /api/channel-posts with it. It shows them as a chat app: channels and the pairs of agents that
// have messaged each other in a sidebar, the open one as a log in the middle, and the agents on the right. A search box
// asks GET /api/search once per search and shows the answer in the middle in place of the open conversation. It only
// reads, and puts agent-supplied text on the page with textContent, never as HTML.

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --panel: #f2f3f5;
  --text: #1f2328;
  --muted: #59616b;
  --border: #d6dae0;
  --hover: #e4e7eb;
  --active: #d9e0f7;
  --accent: #3451b2;
  --online: #2b8a3e;
  --offline: #8a929b;
  --error: #b42318;
  --error-bg: #fdecea;
  --s1: 0.25rem;
  --s2: 0.5rem;
  --s3: 0.75rem;
  --s4: 1rem;
  --radius: 6px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1e1f22;
    --panel: #2b2d31;
    --text: #e3e5e8;
    --muted: #a3a9b1;
    --border: #3a3d43;
    --hover: #35373c;
    --active: #404659;
    --accent: #9aafff;
    --online: #3fb950;
    --offline: #80868e;
    --error: #ff8a80;
    --error-bg: #3d2224;
  }
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; display: flex; flex-direction: column; font: 14px/1.45 system-ui, sans-serif; background: var(--bg); color: var(--text); }
h1 { font-size: 1.1rem; margin: 0; }
h2 { font-size: 0.75rem; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--muted); margin: var(--s4) var(--s3) var(--s2); }
ul, ol { list-style: none; margin: 0; padding: 0; }
button, input { font: inherit; color: inherit; }
button { cursor: pointer; background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: var(--s1) var(--s3); }
button:hover { background: var(--hover); }
button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.note { color: var(--muted); margin: var(--s2) var(--s3); }
.note:empty { display: none; }
.dim { color: var(--muted); }
#status-line { margin: 0; padding: var(--s2) var(--s4); background: var(--panel); border-bottom: 1px solid var(--border); }
#status-line:empty { display: none; }
#status-line.error { color: var(--error); background: var(--error-bg); }
#login { margin: 15vh auto 0; width: min(32rem, 100% - 2 * var(--s4)); display: flex; flex-direction: column; gap: var(--s3); }
#login input { width: 100%; padding: var(--s2); background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); }
#login button { align-self: flex-start; }
#view { flex: 1; min-height: 0; display: grid; grid-template-columns: 15rem minmax(0, 1fr) 16rem; grid-template-rows: auto minmax(0, 1fr); grid-template-areas: "bar bar bar" "side chat agents"; }
.bar { grid-area: bar; display: flex; align-items: center; gap: var(--s2); padding: var(--s2) var(--s3); border-bottom: 1px solid var(--border); }
.bar h1 { flex: 1; }
#search { display: flex; gap: var(--s1); flex: 0 1 20rem; min-width: 0; }
#search input { flex: 1; min-width: 0; padding: var(--s1) var(--s2); background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); }
.toggle { display: none; }
#sidebar { grid-area: side; overflow-y: auto; background: var(--panel); border-right: 1px solid var(--border); }
#agents { grid-area: agents; overflow-y: auto; background: var(--panel); border-left: 1px solid var(--border); }
#chat { grid-area: chat; min-width: 0; display: flex; flex-direction: column; }
#choose { margin: auto; color: var(--muted); padding: var(--s4); text-align: center; }
#log:not([hidden]) ~ #choose, #results:not([hidden]) ~ #choose { display: none; }
#log, #results { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.log-head { display: flex; align-items: center; gap: var(--s2); padding: var(--s2) var(--s4); border-bottom: 1px solid var(--border); }
.log-head h2 { flex: 1; margin: 0; font-size: 1rem; letter-spacing: normal; text-transform: none; color: var(--text); overflow-wrap: anywhere; }
.channel::before, .item .channel-name::before { content: "# "; color: var(--muted); }
#post-rows, #result-rows { flex: 1; overflow-y: auto; padding: var(--s2) 0 var(--s4); }
.entry { display: grid; grid-template-columns: auto auto minmax(0, 1fr); grid-template-areas: "from tag time" "body body body"; column-gap: var(--s2); align-items: baseline; padding: var(--s2) var(--s4); }
.entry.result { grid-template-columns: auto auto auto minmax(0, 1fr); grid-template-areas: "from where tag time" "body body body body"; }
.where { grid-area: where; color: var(--muted); overflow-wrap: anywhere; }
.entry:hover { background: var(--panel); }
.from { grid-area: from; font-weight: 600; overflow-wrap: anywhere; }
.time { grid-area: time; font-size: 0.8rem; color: var(--muted); }
.tag { grid-area: tag; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--accent); border: 1px solid currentColor; border-radius: var(--radius); padding: 0 var(--s1); }
.body { grid-area: body; white-space: pre-wrap; overflow-wrap: anywhere; }
.item { display: flex; align-items: center; gap: var(--s2); text-align: left; background: none; border: 0; border-radius: var(--radius); padding: var(--s1) var(--s2); margin: 1px var(--s2); width: calc(100% - 2 * var(--s2)); }
.item.current { background: var(--active); font-weight: 600; }
.item .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.count { font-size: 0.75rem; color: var(--muted); }
.agent { display: grid; grid-template-columns: auto minmax(0, 1fr); column-gap: var(--s2); padding: var(--s2) var(--s3); }
.agent > :not(.dot) { grid-column: 2; overflow-wrap: anywhere; }
.agent .name { font-weight: 600; }
.agent .bio, .agent .seen, .agent .unread { font-size: 0.8rem; color: var(--muted); }
.dot { width: 0.6rem; height: 0.6rem; margin-top: 0.35rem; border-radius: 50%; background: var(--offline); overflow: hidden; color: transparent; font-size: 0; }
.dot.online { background: var(--online); }
@media (max-width: 720px) {
  #view { grid-template-columns: minmax(0, 1fr); grid-template-areas: "bar" "chat"; }
  .bar { flex-wrap: wrap; }
  #search { order: 1; flex: 1 1 100%; }
  .toggle { display: inline-block; }
  #sidebar, #agents { display: none; border: 0; }
  #view.show-sidebar #sidebar, #view.show-agents #agents { display: block; grid-area: chat; }
  #view.show-sidebar #chat, #view.show-agents #chat { display: none; }
  .entry { padding: var(--s2) var(--s3); }
}
[hidden] { display: none !important; }
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
const pairRows = document.getElementById("pair-rows");
const messagesNote = document.getElementById("messages-note");
const statusLine = document.getElementById("status-line");
const searchForm = document.getElementById("search");
const searchText = document.getElementById("search-text");
const results = document.getElementById("results");
const resultsTitle = document.getElementById("results-title");
const resultsNote = document.getElementById("results-note");
const resultRows = document.getElementById("result-rows");
let timer;
let generation = 0;
let controller;
// The channel whose log is open, or undefined, and how many of its posts the log holds.
let openChannel;
let held = 0;
// How many of the account's direct messages the page holds, the messages themselves, oldest first, and the pairs of
// agents that have messaged each other, by pairKey, each with its names, its count of messages and the index in
// messages of its newest.
let heldMessages = 0;
let messages = [];
let pairs = new Map();
// The pair whose messages are open in the log, by pairKey, or undefined. At most one of openChannel and openPair is set.
let openPair;
// The search's own counter and request, separate from generation and controller, so a newer search, leaving the
// results or ask() drops a search's answer.
let searchGeneration = 0;
let searchController;

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
  // Clear every panel, so one token's agents, channels, pairs and messages never show under the next token.
  rows.replaceChildren();
  channelRows.replaceChildren();
  heldMessages = 0;
  messages = [];
  pairs = new Map();
  pairRows.replaceChildren();
  messagesNote.textContent = "";
  closeLog();
  searchText.value = "";
  view.hidden = true;
  view.className = "";
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
document.getElementById("close-log").addEventListener("click", () => {
  closeLog();
  markOpen();
});
searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (searchText.value) search(searchText.value);
});
document.getElementById("close-results").addEventListener("click", () => closeResults());
// On a narrow screen only one panel shows at a time: these buttons swap the conversation for the sidebar or the agents.
document.getElementById("show-sidebar").addEventListener("click", () => panel("show-sidebar"));
document.getElementById("show-agents").addEventListener("click", () => panel("show-agents"));

function panel(name) {
  view.className = view.className === name ? "" : name;
}

// Closes the open conversation and the search results.
function closeLog() {
  closeResults();
  openChannel = undefined;
  openPair = undefined;
  held = 0;
  postRows.replaceChildren();
  logTitle.textContent = "";
  logTitle.className = "";
  logNote.textContent = "";
  log.hidden = true;
}

// Opens a channel's log and polls again at once; the poll in flight is dropped, so a slow answer for the channel
// open before is never shown under this one.
function openLog(name) {
  closeLog();
  openChannel = name;
  logTitle.textContent = name;
  logTitle.className = "channel";
  logNote.textContent = "Loading…";
  log.hidden = false;
  view.className = "";
  markOpen();
  cancel();
  poll(generation);
}

// Opens a pair's messages, oldest first, from the ones the page holds, and polls again at once to append any new ones;
// the poll in flight is dropped, so a slow read of the channel open before never holds this pair's refresh back.
function openPairLog(key) {
  const pair = pairs.get(key);
  if (!pair) return;
  closeLog();
  openPair = key;
  logTitle.textContent = pair.names.join(" ↔ ");
  log.hidden = false;
  view.className = "";
  postRows.replaceChildren(...messages.filter((m) => pairKey(m) === key).map(messageEntry));
  postRows.scrollTop = postRows.scrollHeight;
  markOpen();
  cancel();
  poll(generation);
}

// Drops the search in flight and empties the results.
function closeResults() {
  searchGeneration++;
  if (searchController) searchController.abort();
  resultRows.replaceChildren();
  resultsTitle.textContent = "";
  resultsNote.textContent = "";
  results.hidden = true;
}

// Asks GET /api/search for the newest PAGE results and shows them in place of the open conversation. The polls never
// refresh the results; searching again does. An answer that comes after a newer search, after the results were left or
// after the token was forgotten is dropped.
async function search(text) {
  const token = sessionStorage.getItem(KEY);
  if (!token) return ask();
  closeLog();
  markOpen();
  const gen = searchGeneration;
  const ac = new AbortController();
  searchController = ac;
  const deadline = setTimeout(() => ac.abort(), TIMEOUT_MS);
  resultsTitle.textContent = "Search: " + text;
  resultsNote.textContent = "Searching…";
  results.hidden = false;
  view.className = "";
  let answer;
  try {
    answer = await fetchPage(token, ac.signal, "/api/search", { text }, 0, list);
  } catch {
    answer = { error: ac.signal.aborted ? "The server did not answer in time" : "Cannot reach the server" };
  } finally {
    clearTimeout(deadline);
  }
  if (gen !== searchGeneration) return;
  if (answer.status === 401) return ask("The server refused that token. Enter another.");
  if (answer.items) {
    resultRows.replaceChildren(...answer.items.map(resultEntry));
    resultRows.scrollTop = 0;
    resultsNote.textContent =
      answer.items.length === 0 ? "Nothing found." : answer.items.length === PAGE ? "Only the newest " + PAGE + " results are shown." : "";
  } else if (answer.status === 400) {
    resultsNote.textContent = answer.reason || "The server could not run this search (400).";
  } else if (answer.status === 403) {
    resultsNote.textContent = "This token cannot search (403).";
  } else if (answer.status === 503) {
    resultsNote.textContent = "The server is busy (503). Search again in a moment.";
  } else {
    resultsNote.textContent = (answer.error || "The server answered " + answer.status) + ".";
  }
}

function start() {
  cancel();
  form.hidden = true;
  view.hidden = false;
  say("Loading…", false);
  poll(generation);
}

// Fetches the page of path at offset. items picks the page's list out of the answer, or undefined if there is none.
async function fetchPage(token, signal, path, params, offset, items) {
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
  if (res.status === 400) return { status: 400, reason: await reasonOf(res) };
  if (!res.ok) return { status: res.status };
  let page;
  try {
    page = items(await res.json());
  } catch {
    page = undefined;
  }
  if (!Array.isArray(page)) return { error: "The server sent an answer this page cannot read" };
  return { items: page };
}

// The message of an error answer, or undefined if it has none this page can read.
async function reasonOf(res) {
  try {
    const message = (await res.json()).error.message;
    return typeof message === "string" ? message : undefined;
  } catch {
    return undefined;
  }
}

// Fetches every page of path, PAGE at a time.
async function fetchAll(token, signal, path, items) {
  const all = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await fetchPage(token, signal, path, {}, offset, items);
    if (!page.items) return page;
    all.push(...page.items);
    if (page.items.length < PAGE) return { items: all };
  }
}

const list = (answer) => answer;
const postsOf = (answer) => (answer && typeof answer === "object" ? answer.posts : undefined);

// Fetches the agents, then the channels, stopping at the first that fails.
async function fetchView(token, signal) {
  const agents = await fetchAll(token, signal, "/api/agents", list);
  if (!agents.items) return agents;
  const channels = await fetchAll(token, signal, "/api/channels", list);
  if (!channels.items) return channels;
  // A channel created while the pages were read can shift one already read onto the next page; list each name once.
  const names = new Set();
  const unique = channels.items.filter((c) => !names.has(String(c.name)) && names.add(String(c.name)));
  return { ok: true, agents: agents.items, channels: unique };
}

// Reads the open channel's posts past the ones the log holds and appends each page as it comes. Posts are only ever
// added, oldest first, so a poll reads only what is new, and one that runs out of time keeps the pages it read.
// A channel that is not there (404) is shown in the log, not as a failure.
async function readLog(token, signal, gen, channel) {
  for (;;) {
    const page = await fetchPage(token, signal, "/api/channel-posts", { channel }, held, postsOf);
    // A newer poll, or the log was closed, while this page was read: leave the log to them.
    if (gen !== generation || channel !== openChannel) return { ok: true };
    if (page.status === 404) {
      held = 0;
      postRows.replaceChildren();
      logNote.textContent = "There is no channel by this name now.";
      return { ok: true };
    }
    if (!page.items) return page;
    appendLog(page.items);
    if (page.items.length < PAGE) {
      logNote.textContent = held === 0 ? "No posts yet." : "";
      return { ok: true };
    }
  }
}

// Reads the account's direct messages past the ones the page holds and appends each page as it comes, as readLog does
// for a channel. Messages are only ever added, oldest first. GET /api/messages marks nothing read.
async function readMessages(token, signal, gen) {
  for (;;) {
    const page = await fetchPage(token, signal, "/api/messages", {}, heldMessages, list);
    // A newer poll, or another token, while this page was read: leave the messages to it.
    if (gen !== generation) return { ok: true };
    if (!page.items) return page;
    appendMessages(page.items);
    if (page.items.length < PAGE) {
      messagesNote.textContent = heldMessages === 0 ? "No direct messages yet." : "";
      return { ok: true };
    }
  }
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
    result = await fetchView(token, ac.signal);
    // The agents and channels go up before the messages and the log are read, so a long or slow history never holds
    // them back. The messages and the log are read side by side, so neither waits on the other or fails with it, and
    // both have finished before the next poll can read past what they hold.
    if (result.ok && gen === generation) {
      show(result.agents);
      showChannels(result.channels);
      const [messages, posts] = await Promise.allSettled([
        readMessages(token, ac.signal, gen),
        channel === undefined ? { ok: true } : readLog(token, ac.signal, gen, channel),
      ]);
      // A refused token from either read wins, so a failure of the other never leaves the page showing its data.
      const values = [messages, posts].filter((r) => r.status === "fulfilled").map((r) => r.value);
      const refused = values.find((v) => v.status === 401);
      const failed = [messages, posts].find((r) => r.status === "rejected");
      if (failed && !refused) throw failed.reason;
      result = refused ?? values.find((v) => !v.ok) ?? posts.value;
    }
  } catch {
    result = { error: ac.signal.aborted ? "The server did not answer in time" : "Cannot reach the server" };
  } finally {
    clearTimeout(deadline);
  }
  // A newer token or a sign-out since this poll began: drop its answer.
  if (gen !== generation) return;
  if (result.status === 401) return ask("The server refused that token. Enter another.");
  if (result.ok) {
    say("", false);
  } else if (result.status === 403) {
    say("This token cannot read agents, channels or messages (403). Retrying…", true);
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

function part(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function show(agents) {
  const items = agents.map((a) => {
    const li = document.createElement("li");
    li.className = "agent";
    const dot = part("span", a.online ? "dot online" : "dot", a.online ? "online" : "offline");
    dot.title = a.online ? "online" : "offline";
    const seen = part("span", "seen", "last seen " + ago(a.lastSeen));
    seen.title = String(a.lastSeen);
    const unread = part("span", "unread", "unread messages: " + a.unreadMessages + ", posts: " + a.unreadPosts + ", mentions: " + a.unreadMentions);
    li.append(dot, part("span", "name", String(a.name)), part("span", "bio", String(a.bio)), seen, unread);
    return li;
  });
  if (items.length === 0) items.push(part("li", "note", "No agents registered in this account."));
  rows.replaceChildren(...items);
}

// The sidebar key of the open conversation, as sidebarItem takes it, or undefined.
function openKey() {
  if (openChannel !== undefined) return "channel " + openChannel;
  if (openPair !== undefined) return "pair " + openPair;
  return undefined;
}

// A sidebar entry: a button with a label and a count that opens a conversation. Its value is its key, which markOpen
// compares with openKey().
function sidebarItem(key, label, labelClass, count, open) {
  const button = document.createElement("button");
  button.type = "button";
  button.value = key;
  button.className = key === openKey() ? "item current" : "item";
  button.append(part("span", labelClass ? "label " + labelClass : "label", label), part("span", "count", String(count)));
  button.addEventListener("click", open);
  const li = document.createElement("li");
  li.append(button);
  return li;
}

function showChannels(channels) {
  const items = channels.map((c) => {
    const name = String(c.name);
    const li = sidebarItem("channel " + name, name, "channel-name", c.posts, () => openLog(name));
    const members = Array.isArray(c.members) ? c.members.map(String).join(", ") : "";
    const last = c.lastPostAt == null ? "no posts" : "last post " + ago(c.lastPostAt);
    li.children[0].title = "Members: " + (members || "–") + "; " + c.posts + " posts, " + last;
    return li;
  });
  if (items.length === 0) items.push(part("li", "note", "No channels in this account."));
  channelRows.replaceChildren(...items);
}

// The two agents of a message, in name order, as one key, so alice to bob and bob to alice are the same pair.
function pairNames(m) {
  return [String(m.from), String(m.to)].sort();
}
function pairKey(m) {
  return JSON.stringify(pairNames(m));
}

// Lists the pairs, the one with the newest message first.
function showPairs() {
  const items = [...pairs].sort((a, b) => b[1].newest - a[1].newest).map(([key, pair]) =>
    sidebarItem("pair " + key, pair.names.join(" ↔ "), "", pair.count, () => openPairLog(key)),
  );
  pairRows.replaceChildren(...items);
}

// Marks the open channel or pair in the sidebar, in place, so the button just chosen keeps the focus.
function markOpen() {
  const key = openKey();
  for (const li of [...channelRows.children, ...pairRows.children]) {
    const button = li.children[0];
    if (button) button.className = button.value === key ? "item current" : "item";
  }
}

// Appends to the open log and keeps it at the bottom if it was there, so a reader scrolled back up is not moved.
function appendEntries(entries) {
  const atBottom = postRows.scrollHeight - postRows.scrollTop - postRows.clientHeight < 40;
  postRows.append(...entries);
  if (atBottom) postRows.scrollTop = postRows.scrollHeight;
}

function entry(from, tag, sentAt, body) {
  const li = document.createElement("li");
  li.className = "entry";
  const time = part("time", "time", when(sentAt));
  time.title = String(sentAt);
  li.append(part("span", "from", String(from)));
  if (tag) li.append(part("span", "tag", tag));
  li.append(time, part("div", "body", String(body)));
  return li;
}

function messageEntry(m) {
  return entry(m.from, m.broadcast ? "broadcast" : "", m.sentAt, m.body);
}

// A search result: a message shows its sender and recipient and whether it was a broadcast, a post its sender and channel.
function resultEntry(r) {
  const post = r.kind === "post";
  const li = entry(r.from, r.broadcast ? "broadcast" : "", r.sentAt, r.body);
  li.className = "entry result";
  li.append(post ? part("span", "where channel", String(r.channel)) : part("span", "where", "→ " + String(r.to)));
  return li;
}

function appendLog(posts) {
  held += posts.length;
  appendEntries(posts.map((p) => entry(p.from, "", p.sentAt, p.body)));
}

function appendMessages(page) {
  heldMessages += page.length;
  for (const m of page) {
    const key = pairKey(m);
    const pair = pairs.get(key) ?? { names: pairNames(m), count: 0, newest: 0 };
    pair.count++;
    pair.newest = messages.length;
    pairs.set(key, pair);
    messages.push(m);
  }
  if (openPair !== undefined) appendEntries(page.filter((m) => pairKey(m) === openPair).map(messageEntry));
  if (page.length > 0) showPairs();
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
<p id="status-line" role="status"></p>
<form id="login" hidden>
<h1>message-cp</h1>
<label for="token">Token for your account (read-only is enough), kept in this tab only:</label>
<input id="token" type="password" autocomplete="off" required>
<button type="submit">Show agents, channels and messages</button>
</form>
<div id="view" hidden>
<header class="bar">
<button id="show-sidebar" class="toggle" type="button" aria-label="Channels and conversations">☰</button>
<h1>message-cp</h1>
<form id="search" role="search">
<input id="search-text" type="search" maxlength="400" required aria-label="Search messages and posts" placeholder="Search messages and posts" autocomplete="off">
<button type="submit">Search</button>
</form>
<button id="show-agents" class="toggle" type="button">Agents</button>
<button id="forget" type="button">Forget token</button>
</header>
<nav id="sidebar" aria-label="Channels and conversations">
<h2>Channels</h2>
<ul id="channel-rows"></ul>
<h2>Direct messages</h2>
<p id="messages-note" class="note"></p>
<ul id="pair-rows"></ul>
</nav>
<main id="chat">
<section id="log" hidden>
<div class="log-head">
<h2 id="log-title"></h2>
<button id="close-log" type="button">Close</button>
</div>
<p id="log-note" class="note"></p>
<ol id="post-rows" role="log"></ol>
</section>
<section id="results" hidden>
<div class="log-head">
<h2 id="results-title"></h2>
<button id="close-results" type="button">Close</button>
</div>
<p id="results-note" class="note"></p>
<ol id="result-rows"></ol>
</section>
<p id="choose">Choose a channel or a conversation.</p>
</main>
<aside id="agents" aria-label="Agents">
<h2>Agents</h2>
<ul id="rows"></ul>
</aside>
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
