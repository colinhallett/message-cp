import { createHash } from "node:crypto";
import { MAX_BODY_LENGTH } from "./messages.js";

// The page served at GET / by `message-cp serve`. It holds no data and no token: it asks for a token, keeps it in
// sessionStorage (that tab only), and polls GET /api/agents, GET /api/channels, GET /api/messages and, while one is
// open, a channel's GET /api/channel-posts or the account's GET /api/webhook-deliveries with it. It shows them as a
// chat app: channels and the pairs of agents that have messaged each other in a sidebar, the open one as a log in the
// middle, and the agents on the right. A search box asks GET /api/search once per search and shows the answer in the
// middle in place of the open conversation. The sidebar's "Webhook deliveries" entry shows the newest deliveries in the
// middle the same way, refreshed with each poll. It asks GET /api/token once whether the token is read-only. With a full
// token it lets a person choose which of the account's people they are, post in the open channel with POST /api/post and
// reply in an open direct conversation of theirs with POST /api/send; that is all it ever writes. With a read-only token
// it only reads. It puts agent- and person-supplied text on the page with textContent, never as HTML.

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
button, input, select, textarea { font: inherit; color: inherit; }
button { cursor: pointer; background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: var(--s1) var(--s3); }
button:hover { background: var(--hover); }
button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
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
#as-box { display: flex; align-items: center; gap: var(--s1); }
#as { padding: var(--s1); background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); }
#as-note { margin: 0; }
#compose { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--s2); padding: var(--s2) var(--s4); border-top: 1px solid var(--border); }
#compose label { flex: 1 1 100%; font-size: 0.8rem; color: var(--muted); }
#compose textarea { flex: 1; min-width: 0; resize: vertical; padding: var(--s2); background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); }
#compose .note { flex: 1 1 100%; margin: 0; }
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
.delivery.failed .tag { color: var(--error); background: var(--error-bg); }
.item { display: flex; align-items: center; gap: var(--s2); text-align: left; background: none; border: 0; border-radius: var(--radius); padding: var(--s1) var(--s2); margin: 1px var(--s2); width: calc(100% - 2 * var(--s2)); }
.item.current { background: var(--active); font-weight: 600; }
.item .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.count { font-size: 0.75rem; color: var(--muted); }
.agent { display: grid; grid-template-columns: auto minmax(0, 1fr); column-gap: var(--s2); padding: var(--s2) var(--s3); }
.agent > :not(.dot) { grid-column: 2; overflow-wrap: anywhere; }
.kind { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--accent); }
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
const deliveryEntry = document.getElementById("delivery-entry");
const asBox = document.getElementById("as-box");
const asSelect = document.getElementById("as");
const asNote = document.getElementById("as-note");
const compose = document.getElementById("compose");
const composeLabel = document.getElementById("compose-label");
const composeText = document.getElementById("compose-text");
const composeNote = document.getElementById("compose-note");
const composeSend = document.getElementById("compose-send");
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
// The pair whose messages are open in the log, by pairKey, or undefined.
let openPair;
// Whether the webhook deliveries are open in the log. At most one of openChannel, openPair and openDeliveries is set.
let openDeliveries = false;
// The count on the sidebar's webhooks entry, once the entry is made: how many deliveries the view read when last open.
let deliveryCount;
// The search's own counter and request, separate from generation and controller, so a newer search, leaving the
// results or ask() drops a search's answer.
let searchGeneration = 0;
let searchController;
// Whether GET /api/token said this token is a full one, which alone shows the person picker and the compose box; the
// server's 403 is still what keeps a read-only token from posting. tokenGeneration drops an answer to GET /api/token,
// or to a send, that comes after the token was forgotten.
let canPost = false;
let tokenGeneration = 0;
let tokenController;
// The names of the account's live people, as the last GET /api/agents gave them (undefined until it has answered),
// the list the picker was last built from, and the person the page posts as: always one of people, or undefined.
let people;
let pickerKey = "";
let person;
// The tokenGeneration a send is in flight for, or undefined. While one is, the Send button is disabled for that token,
// so a write is never sent twice before the server has said whether it took the first; a new token is not held by it.
let sending;

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
  // Forget whether the last token could post, and who the page posted as, so the next token starts read-only.
  tokenGeneration++;
  if (tokenController) tokenController.abort();
  canPost = false;
  people = undefined;
  pickerKey = "";
  person = undefined;
  asSelect.replaceChildren();
  asBox.hidden = true;
  asNote.textContent = "";
  composeText.value = "";
  composeNote.textContent = "";
  composeSend.disabled = false;
  // Clear every panel, so one token's agents, channels, pairs and messages never show under the next token.
  rows.replaceChildren();
  channelRows.replaceChildren();
  heldMessages = 0;
  messages = [];
  pairs = new Map();
  pairRows.replaceChildren();
  messagesNote.textContent = "";
  if (deliveryCount) deliveryCount.textContent = "";
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
asSelect.addEventListener("change", () => {
  // Only a name GET /api/agents gave for this token is ever sent as "as".
  person = people && people.includes(asSelect.value) ? asSelect.value : undefined;
  showCompose();
});
compose.addEventListener("submit", (event) => {
  event.preventDefault();
  send();
});
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
  openDeliveries = false;
  held = 0;
  postRows.replaceChildren();
  logTitle.textContent = "";
  logTitle.className = "";
  logNote.textContent = "";
  log.hidden = true;
  // The text typed stays, so leaving a conversation never loses it; only a 200 or a new token clears it.
  composeNote.textContent = "";
  compose.hidden = true;
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
  showCompose();
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
  showCompose();
  cancel();
  poll(generation);
}

// Opens the account's webhook deliveries in the log and polls again at once, as openLog does for a channel.
function openDeliveryLog() {
  closeLog();
  openDeliveries = true;
  logTitle.textContent = "Webhook deliveries";
  logNote.textContent = "Loading…";
  log.hidden = false;
  view.className = "";
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
  checkToken();
  poll(generation);
}

// Asks GET /api/token once whether this token is read-only. Only an answer of readOnly false shows the picker; a
// read-only token, a failure or an answer this page cannot read leaves the page read-only.
async function checkToken() {
  const token = sessionStorage.getItem(KEY);
  if (!token) return;
  const gen = tokenGeneration;
  const ac = new AbortController();
  tokenController = ac;
  const deadline = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let full = false;
  let refused = false;
  try {
    const res = await fetch("/api/token", {
      headers: { Authorization: "Bearer " + token },
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: ac.signal,
    });
    refused = res.status === 401;
    if (res.ok) full = (await res.json()).readOnly === false;
  } catch {
    full = false;
  } finally {
    clearTimeout(deadline);
  }
  if (gen !== tokenGeneration) return;
  if (refused) return ask("The server refused that token. Enter another.");
  canPost = full;
  showPicker();
}

// Shows the person picker, with a full token, from the people GET /api/agents last gave, and clears the chosen person
// once they are gone. The list is rebuilt only when it changes, so a poll never closes it under the reader.
function showPicker() {
  const known = people ?? [];
  if (person !== undefined && !known.includes(person)) person = undefined;
  asBox.hidden = !canPost || known.length === 0;
  asNote.textContent = canPost && people !== undefined && known.length === 0 ? "No people to post as. Add one with: message-cp person add <name>" : "";
  const key = canPost ? JSON.stringify(known) : "";
  if (key !== pickerKey) {
    pickerKey = key;
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "Choose who you are";
    const options = known.map((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      return option;
    });
    asSelect.replaceChildren(...(canPost ? [none, ...options] : []));
  }
  asSelect.value = person ?? "";
  showCompose();
}

// The name a person replies to in the open pair, or undefined if the pair is not theirs.
function replyTo() {
  const pair = openPair !== undefined ? pairs.get(openPair) : undefined;
  if (!pair || person === undefined) return undefined;
  const [a, b] = pair.names;
  if (a.toLowerCase() === person.toLowerCase()) return b;
  if (b.toLowerCase() === person.toLowerCase()) return a;
  return undefined;
}

// Shows the compose box under an open channel, or under an open pair the chosen person is one side of.
function showCompose() {
  const to = replyTo();
  const shown = canPost && person !== undefined && (openChannel !== undefined || to !== undefined);
  compose.hidden = !shown;
  if (shown) composeLabel.textContent = openChannel !== undefined ? "Post in #" + openChannel + " as " + person : "Reply to " + to + " as " + person;
}

// What the compose box sends to now: the path, the conversation and the person, or undefined when it is hidden.
function composeTarget() {
  if (compose.hidden) return undefined;
  return openChannel !== undefined
    ? { path: "/api/post", conversation: "#" + openChannel, fields: { as: person, channel: openChannel } }
    : { path: "/api/send", conversation: openPair, fields: { as: person, to: replyTo() } };
}

// Posts in the open channel or replies in the open pair as the chosen person, then polls at once so it shows. A send
// with no answer (a failed connection, or none within TIMEOUT_MS) may still have been stored, so Send stays disabled
// until settle has read the conversation and found whether it was. Its answer changes the box only while the box still
// sends to the same conversation as the same person: the text is cleared after a 200, if it is still what was sent,
// and any other answer keeps it and says why.
async function send() {
  const token = sessionStorage.getItem(KEY);
  if (!token) return ask();
  const tokenGen = tokenGeneration;
  // The box is shown only for a full token, a chosen person and a channel or a pair of theirs (showCompose).
  const target = composeTarget();
  if (sending === tokenGen || target === undefined) return;
  const body = composeText.value;
  // The server counts characters as code points, as validateBody does, which maxlength (UTF-16 units) does not.
  if ([...body].length > ${MAX_BODY_LENGTH}) {
    composeNote.textContent = "This is longer than ${MAX_BODY_LENGTH} characters.";
    return;
  }
  // Only entries past what the page holds now can be this one: posts and messages are only ever appended.
  const offset = target.path === "/api/post" ? held : heldMessages;
  sending = tokenGen;
  composeSend.disabled = true;
  composeNote.textContent = "Sending…";
  const ac = new AbortController();
  const deadline = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let answer;
  try {
    const res = await fetch(target.path, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ ...target.fields, body }),
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: ac.signal,
    });
    answer = res.status === 400 ? { status: 400, reason: await reasonOf(res) } : { status: res.status };
  } catch {
    answer = undefined;
  } finally {
    clearTimeout(deadline);
  }
  if (tokenGen !== tokenGeneration) return;
  const same = () => {
    const now = composeTarget();
    return now !== undefined && now.path === target.path && now.conversation === target.conversation && now.fields.as === target.fields.as;
  };
  if (answer === undefined) {
    if (same()) composeNote.textContent = "No answer from the server: checking whether it was sent…";
    const sent = await settle(token, tokenGen, target, body, offset);
    if (sent === undefined) return;
    answer = sent ? { status: 200 } : { error: "The server did not take it. Send again" };
  }
  if (answer.status === 401) return ask("The server refused that token. Enter another.");
  if (answer.status === 200) {
    if (same() && composeText.value === body) composeText.value = "";
    if (same()) composeNote.textContent = "";
    cancel();
    poll(generation);
  } else if (!same()) {
    // The box now sends somewhere else: this answer is not about it.
  } else if (answer.status === 400) {
    composeNote.textContent = answer.reason || "The server refused this (400).";
  } else if (answer.status === 403) {
    composeNote.textContent = "This token cannot post or send (403).";
  } else if (answer.status === 404) {
    // Both endpoints answer 404 only for an "as" that is not a live person of the account.
    composeNote.textContent = target.fields.as + " is no longer a person in this account (404).";
  } else if (answer.status === 413) {
    composeNote.textContent = "This is too long for the server (413).";
  } else if (answer.status === 503) {
    composeNote.textContent = "The server is busy (503). Send again in a moment.";
  } else {
    composeNote.textContent = (answer.error || "The server answered " + answer.status) + ".";
  }
  sending = undefined;
  composeSend.disabled = false;
}

// Reads the conversation a send went to, past offset, until a read succeeds, and says whether the person's text is
// there: true or false, or undefined once the token has been forgotten or refused. Until then Send stays disabled, so
// a send with no answer is never made a second time before the page knows whether the first was stored.
async function settle(token, tokenGen, target, body, offset) {
  for (;;) {
    let found;
    try {
      found = await findSent(token, target, body, offset);
    } catch {
      found = undefined;
    }
    if (tokenGen !== tokenGeneration) return undefined;
    if (found === 401) {
      ask("The server refused that token. Enter another.");
      return undefined;
    }
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    if (tokenGen !== tokenGeneration) return undefined;
  }
}

// Whether the channel's posts or the account's messages past offset hold body from the person to the send's channel
// or other side; 401 for a refused token, or undefined when a read fails.
async function findSent(token, target, body, offset) {
  const { as } = target.fields;
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const [path, params, items, match] =
    target.path === "/api/post"
      ? ["/api/channel-posts", { channel: target.fields.channel }, postsOf, (p) => same(p.from, as) && p.body === body]
      : ["/api/messages", {}, list, (m) => same(m.from, as) && same(m.to, target.fields.to) && m.body === body];
  for (;;) {
    const ac = new AbortController();
    const deadline = setTimeout(() => ac.abort(), TIMEOUT_MS);
    let page;
    try {
      page = await fetchPage(token, ac.signal, path, params, offset, items);
    } finally {
      clearTimeout(deadline);
    }
    if (page.status === 401) return 401;
    // A channel that is not there holds no post.
    if (page.status === 404) return false;
    if (!page.items) return undefined;
    if (page.items.some(match)) return true;
    if (page.items.length < PAGE) return false;
    offset += page.items.length;
  }
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

// Reads the newest PAGE webhook deliveries and replaces the ones the log holds: they come newest first, and a
// delivery's attempts and status change, so each poll reads the one page again rather than appending. Any failure but
// a refused token goes in the log's note, so it never stops the rest of the page refreshing.
async function readDeliveries(token, signal, gen) {
  let page;
  try {
    page = await fetchPage(token, signal, "/api/webhook-deliveries", {}, 0, list);
  } catch {
    page = { error: signal.aborted ? "The server did not answer in time" : "Cannot reach the server" };
  }
  // A newer poll, or the deliveries were closed, while the page was read: leave the log to them.
  if (gen !== generation || !openDeliveries) return { ok: true };
  if (page.status === 401) return page;
  // A list whose entries are not deliveries is as unreadable as one that is not a list.
  let shown;
  try {
    if (page.items) shown = page.items.map(deliveryRow);
  } catch {
    page = { error: "The server sent an answer this page cannot read" };
  }
  if (shown) {
    postRows.replaceChildren(...shown);
    postRows.scrollTop = 0;
    deliveryCount.textContent = String(shown.length);
    logNote.textContent =
      shown.length === 0
        ? "No webhook deliveries yet."
        : shown.length === PAGE
          ? "Only the newest " + PAGE + " deliveries are shown."
          : "";
  } else if (page.status === 403) {
    logNote.textContent = "This token cannot read webhook deliveries (403). Retrying…";
  } else if (page.status === 503) {
    logNote.textContent = "The server is busy (503). Retrying…";
  } else {
    logNote.textContent = (page.error || "The server answered " + page.status) + ". Retrying…";
  }
  return { ok: true };
}

async function poll(gen) {
  const token = sessionStorage.getItem(KEY);
  if (!token) return ask();
  const ac = new AbortController();
  controller = ac;
  const deadline = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const channel = openChannel;
  const deliveries = openDeliveries;
  let result;
  try {
    result = await fetchView(token, ac.signal);
    // The agents and channels go up before the messages and the log are read, so a long or slow history never holds
    // them back. The messages and the log (a channel's posts or the webhook deliveries) are read side by side, so
    // neither waits on the other or fails with it, and both have finished before the next poll can read past what they
    // hold.
    if (result.ok && gen === generation) {
      show(result.agents);
      showChannels(result.channels);
      showDeliveryEntry();
      const [messages, posts] = await Promise.allSettled([
        readMessages(token, ac.signal, gen),
        channel !== undefined
          ? readLog(token, ac.signal, gen, channel)
          : deliveries
            ? readDeliveries(token, ac.signal, gen)
            : { ok: true },
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
    // A person has no online state of its own, so it is marked as a person in place of the dot, above its name.
    const dot = a.person === true
      ? part("span", "kind", "person")
      : part("span", a.online ? "dot online" : "dot", a.online ? "online" : "offline");
    dot.title = a.person === true ? "a person, not an agent" : a.online ? "online" : "offline";
    // A person's lastSeen is when they were added.
    const seen = part("span", "seen", (a.person === true ? "added " : "last seen ") + ago(a.lastSeen));
    seen.title = String(a.lastSeen);
    const unread = part("span", "unread", "unread messages: " + a.unreadMessages + ", posts: " + a.unreadPosts + ", mentions: " + a.unreadMentions);
    li.append(dot, part("span", "name", String(a.name)), part("span", "bio", String(a.bio)), seen, unread);
    return li;
  });
  if (items.length === 0) items.push(part("li", "note", "No agents registered in this account."));
  rows.replaceChildren(...items);
  people = agents.filter((a) => a.person === true).map((a) => String(a.name));
  showPicker();
}

// The sidebar key of the open conversation, as sidebarItem takes it, or undefined.
function openKey() {
  if (openChannel !== undefined) return "channel " + openChannel;
  if (openPair !== undefined) return "pair " + openPair;
  if (openDeliveries) return "deliveries";
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

// Marks the open channel, pair or webhook deliveries in the sidebar, in place, so the button just chosen keeps the focus.
function markOpen() {
  const key = openKey();
  for (const li of [...channelRows.children, ...pairRows.children, ...deliveryEntry.children]) {
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

// Makes the sidebar's one webhooks entry the first time the channels are shown. It is never made again, so a poll
// never replaces the button and takes its focus; its count is blank until the view is first opened.
function showDeliveryEntry() {
  if (deliveryCount) return;
  deliveryEntry.append(sidebarItem("deliveries", "Webhook deliveries", "", "", openDeliveryLog));
  deliveryCount = deliveryEntry.children[0].children[0].children[1];
}

// A webhook delivery: what it was for, its status (failed marked), when it was queued, its webhook, its attempts and,
// once delivered, when. Never a URL, a secret or a message's text, which GET /api/webhook-deliveries does not give.
// Throws on an entry that is not a delivery as GET /api/webhook-deliveries gives one, so readDeliveries shows the
// answer as unreadable rather than as delivery state: only a delivered one has a delivery time.
function deliveryRow(d) {
  const status = d.status;
  const delivered = status === "delivered";
  if (
    !Number.isInteger(d.id) ||
    typeof d.on !== "string" ||
    !Number.isInteger(d.webhook) ||
    !Number.isInteger(d.attempts) ||
    typeof d.queuedAt !== "string" ||
    !(delivered || status === "pending" || status === "failed") ||
    (delivered ? typeof d.deliveredAt !== "string" : d.deliveredAt !== null)
  ) {
    throw new TypeError("not a delivery");
  }
  const li = document.createElement("li");
  li.className = status === "failed" ? "entry delivery failed" : "entry delivery";
  const time = part("time", "time", "queued " + when(d.queuedAt));
  time.title = String(d.queuedAt);
  const facts = ["webhook " + d.webhook, "attempts: " + d.attempts];
  if (d.deliveredAt != null) facts.push("delivered " + when(d.deliveredAt));
  const body = part("div", "body", facts.join(" · "));
  li.append(part("span", "from", String(d.on)), part("span", "tag", status), time, body);
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
<label for="token">Token for your account, kept in this tab only. A read-only token can watch; a full token can also post as one of the account's people:</label>
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
<span id="as-box" hidden>
<label for="as">Post as</label>
<select id="as"></select>
</span>
<p id="as-note" class="note"></p>
<button id="show-agents" class="toggle" type="button">Agents</button>
<button id="forget" type="button">Forget token</button>
</header>
<nav id="sidebar" aria-label="Channels and conversations">
<h2>Channels</h2>
<ul id="channel-rows"></ul>
<h2>Direct messages</h2>
<p id="messages-note" class="note"></p>
<ul id="pair-rows"></ul>
<h2>Webhooks</h2>
<ul id="delivery-entry"></ul>
</nav>
<main id="chat">
<section id="log" hidden>
<div class="log-head">
<h2 id="log-title"></h2>
<button id="close-log" type="button">Close</button>
</div>
<p id="log-note" class="note"></p>
<ol id="post-rows" role="log"></ol>
<form id="compose" hidden>
<label id="compose-label" for="compose-text"></label>
<textarea id="compose-text" rows="2" required autocomplete="off"></textarea>
<button id="compose-send" type="submit">Send</button>
<p id="compose-note" class="note" role="status"></p>
</form>
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
