import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { INVITE_TTL_MS } from "./login.js";
import { MAX_BODY_LENGTH } from "./messages.js";

// The page served at GET / by `message-cp serve`. It holds no data and no token: it asks for a token, or redeems the
// one-time code a `message-cp login-link` link carries in its fragment for one with POST /api/login, keeps it in
// sessionStorage (that tab only), signs the browser in to the approval page with POST oauth/signin for a full or person
// token under an https public URL (and out with DELETE on "Forget token", which also signs out its other dashboard tabs),
// and polls GET /api/agents, GET /api/channels, GET /api/messages and, while one is
// open, a channel's GET /api/channel-posts, the account's GET /api/webhook-deliveries, its GET /api/approvals or, for
// an admin person, its GET /api/people and GET /api/invites, its GET /api/webhooks or its GET /api/tokens, with it. It shows them as a chat app: channels and the pairs of agents that have
// messaged each other in a sidebar, the open one as a log in the middle, and the agents on the right. A search box asks GET /api/search once per search and
// shows the answer in the middle in place of the open conversation. The sidebar's "Webhook deliveries" entry shows
// the newest deliveries in the middle the same way, refreshed with each poll, and its "Approved clients" entry, the
// same way, the newest of the account's approvals as GET /api/approvals lists them. It asks GET /api/token once whether the token is read-only or
// agent-only, and for a person token whose person it is. With a person token it is that person: it posts as them in the
// open channel with POST /api/post and replies in an open direct conversation of theirs, or starts one with anyone in
// the account from "New message", with POST /api/send, or creates a channel from "New channel" by its first post, with
// POST /api/post; and, only when GET /api/token says the person is an admin, deletes an open direct conversation, after
// confirming, with DELETE /api/conversation, and, from the sidebar's "People" entry, which lists the account's people
// with GET /api/people and the unused invites with GET /api/invites, marks or unmarks another person an admin with PATCH
// /api/people, removes one, after confirming, with DELETE /api/people, adds a person with POST /api/people, makes a new
// invite for one with POST /api/invites and, after confirming, cancels one with DELETE /api/invites, and, from an
// agent's details in the agents panel, after confirming, removes the agent with DELETE /api/agents or gives it a new key
// with POST /api/agents/key, and, from the sidebar's "Webhooks" entry, which lists the account's webhooks with GET
// /api/webhooks, adds one with POST /api/webhooks and, after confirming, removes one with its deliveries with DELETE
// /api/webhooks, from the "Approved clients" entry, after confirming, revokes an approved client's token with DELETE
// /api/approvals, and, from the sidebar's "Tokens" entry, which lists the account's unrevoked tokens with GET
// /api/tokens, makes a read-only or agent token with POST /api/tokens and, after confirming, revokes one with DELETE
// /api/tokens; that is all it ever writes. An invite's link, an agent's new key, a new webhook's secret, or a new token,
// is shown only in a field of its view, from the answer that made it, and never kept or written anywhere else but the
// clipboard, when its Copy is pressed. A new webhook's URL, header value and body go on the page only into the form's fields, by value,
// which are emptied when the server answers that it was added (each only while it still holds what was sent), when its
// view closes and on unmarked(). With a full token, which acts as no person, it
// reads and offers Delete, but not posting or sending, which the server refuses it: in the compose box's place it says
// how to sign in as a person. With a read-only token it only reads. An agent token,
// which the server refuses on every /api path but GET /api/token, it forgets, saying that agent tokens cannot use it. It
// puts agent- and person-supplied text on the page with textContent, never as HTML.

// The faces the page's CSS uses, each served at /fonts/<file> by `message-cp serve` from the package that ships it, so the
// page loads no font from another host. Read once here, never on a request.
const FONT_FILES = [
  "instrument-sans-latin-400-normal.woff2",
  "instrument-sans-latin-400-italic.woff2",
  "instrument-sans-latin-600-normal.woff2",
  "instrument-sans-latin-700-normal.woff2",
  "jetbrains-mono-latin-600-normal.woff2",
];
const resolve = createRequire(import.meta.url).resolve;
const packageOf = (file: string) => (file.startsWith("jetbrains-mono-") ? "@fontsource/jetbrains-mono" : "@fontsource/instrument-sans");

/** The font files GET /fonts/<file> answers with, by exact path; no other path under /fonts/ is served. */
export const DASHBOARD_FONTS: ReadonlyMap<string, Buffer> = new Map(
  FONT_FILES.map((file) => [`/fonts/${file}`, readFileSync(resolve(`${packageOf(file)}/files/${file}`))]),
);

const fontFace = (file: string) => {
  const [, family, weight, style] = /^(.+)-latin-(\d+)-(normal|italic)\.woff2$/.exec(file)!;
  const name = family === "jetbrains-mono" ? "JetBrains Mono" : "Instrument Sans";
  return `@font-face { font-family: "${name}"; font-style: ${style}; font-weight: ${weight}; font-display: swap; src: url("/fonts/${file}") format("woff2"); }`;
};

export const STYLE = `
${FONT_FILES.map(fontFace).join("\n")}
:root {
  color-scheme: light dark;
  --bg: #fbfcfd;
  --panel: #f1f4f8;
  --text: #0b0f17;
  --muted: #535b6e;
  --border: #d9dee7;
  --hover: #e6eaf0;
  --active: #dce4f6;
  --accent: #2f5bd3;
  --online: #2b8a3e;
  --offline: #8a929b;
  --error: #b42318;
  --error-bg: #fdecea;
  --who0: #2f5bd3;
  --who1: #0b7350;
  --who2: #b42318;
  --who3: #7a3fd1;
  --who4: #8f4a00;
  --who5: #0e6e86;
  --who6: #b3186a;
  --who7: #4d6d0f;
  --mention-bg: #e3eafb;
  --me: #1f43a8;
  --me-bg: #c9d6f6;
  --s1: 0.25rem;
  --s2: 0.5rem;
  --s3: 0.75rem;
  --s4: 1rem;
  --radius: 6px;
  --font-sans: "Instrument Sans", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  --text-xs: 0.7rem;
  --text-sm: 0.8rem;
  --text-base: 0.875rem;
  --text-lg: 1rem;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0b0f17;
    --panel: #121826;
    --text: #e7eaf0;
    --muted: #8b93a7;
    --border: #1f2737;
    --hover: #192132;
    --active: #1e2a45;
    --accent: #7aa2ff;
    --online: #3fb950;
    --offline: #80868e;
    --error: #ff8a80;
    --error-bg: #3a1a1d;
    --who0: #7aa2ff;
    --who1: #5ee6b5;
    --who2: #ff8a80;
    --who3: #c4a1ff;
    --who4: #f2b880;
    --who5: #5fd3e8;
    --who6: #f59ac8;
    --who7: #b5e06a;
    --mention-bg: #1c2a4d;
    --me: #c7d6ff;
    --me-bg: #2f4a8f;
  }
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; display: flex; flex-direction: column; font: var(--text-base)/1.45 var(--font-sans); background: var(--bg); color: var(--text); }
h1 { font-size: var(--text-lg); margin: 0; }
h2 { font-size: var(--text-sm); font-weight: 600; color: var(--muted); margin: var(--s4) var(--s3) var(--s2); }
ul, ol { list-style: none; margin: 0; padding: 0; }
button, input, select, textarea { font: inherit; color: inherit; }
button { cursor: pointer; background: none; border: 1px solid var(--border); border-radius: var(--radius); padding: var(--s1) var(--s3); }
button:hover { background: var(--hover); }
/* Only the primary actions are filled, in the accent with the page's background as their text. */
#login button, #compose-send, #channel-create, #new-open, #delete-yes, #person-add, #link-make, #cancel-yes, #agent-yes { background: var(--accent); border-color: var(--accent); color: var(--bg); font-weight: 600; }
#login button:hover:enabled, #compose-send:hover:enabled, #channel-create:hover:enabled, #new-open:hover:enabled, #delete-yes:hover:enabled, #person-add:hover:enabled, #link-make:hover:enabled, #cancel-yes:hover:enabled, #agent-yes:hover:enabled { background: color-mix(in srgb, var(--accent) 85%, var(--text)); }
button:disabled { cursor: default; opacity: 0.6; }
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
.bar h1 { flex: 1; display: flex; align-items: center; gap: var(--s2); }
/* The site's favicon mark beside the name, filled from the theme. */
.mark { flex: none; width: 1.25rem; height: 1.25rem; }
.mark .bubble { fill: var(--accent); }
.mark .lines { fill: var(--bg); }
#search { display: flex; gap: var(--s1); flex: 0 1 20rem; min-width: 0; }
#search input { flex: 1; min-width: 0; padding: var(--s1) var(--s2); background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); }
.toggle { display: none; }
/* The note on who the page posts as and the compose box share one row under the log. */
#writer { position: relative; display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--s2); padding: var(--s2) var(--s4); border-top: 1px solid var(--border); }
#as-note { margin: 0; }
#compose { flex: 1 1 20rem; min-width: 0; display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--s2); }
#compose label { flex: 1 1 100%; font-size: var(--text-sm); color: var(--muted); }
#compose textarea { flex: 1; min-width: 0; resize: none; overflow-y: auto; padding: var(--s2); background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); }
/* The note sits under the row, outside the form, so it never pushes the box out of line. */
#compose-note { flex: 1 1 100%; margin: 0; }
#compose[hidden] + #compose-note { display: none; }
/* The names offered for a mention sit over the compose row, so the log above stays where it is. */
#mentions { position: absolute; bottom: 100%; left: var(--s4); z-index: 1; min-width: 14rem; max-width: calc(100% - 2 * var(--s4)); padding: var(--s1) 0; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); }
.option { display: flex; align-items: baseline; gap: var(--s2); padding: var(--s1) var(--s3); cursor: pointer; }
.option:hover { background: var(--hover); }
.option.current { background: var(--active); box-shadow: inset 3px 0 0 var(--accent); }
.option .name { font-family: var(--font-mono); font-weight: 600; overflow-wrap: anywhere; }
/* The "New channel" and "New message" buttons sit beside the "Channels" and "Direct messages" headings, and their forms
   under them. */
.section-head { display: flex; align-items: center; gap: var(--s2); margin: var(--s4) var(--s3) var(--s2); }
.section-head h2 { flex: 1; margin: 0; }
#new-message, #new-channel { font-size: var(--text-sm); padding: 0 var(--s2); }
#new-form, #channel-form { display: flex; flex-direction: column; gap: var(--s1); margin: 0 var(--s3) var(--s2); padding: var(--s2); background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); }
#new-form select, #channel-form select, #channel-form input, #channel-form textarea { padding: var(--s1); background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); }
#channel-form textarea { resize: vertical; }
#new-fields, #channel-fields { display: flex; flex-direction: column; gap: var(--s1); }
#new-note, #channel-note { margin: 0; }
.actions { display: flex; gap: var(--s2); margin-top: var(--s1); }
#sidebar { grid-area: side; overflow-y: auto; background: var(--panel); border-right: 1px solid var(--border); }
#agents { grid-area: agents; overflow-y: auto; background: var(--panel); border-left: 1px solid var(--border); }
#chat { grid-area: chat; min-width: 0; display: flex; flex-direction: column; }
#choose { margin: auto; color: var(--muted); padding: var(--s4); text-align: center; }
#log:not([hidden]) ~ #choose, #results:not([hidden]) ~ #choose { display: none; }
#log, #results { flex: 1; min-height: 0; display: flex; flex-direction: column; }
/* The header bar of the open conversation and of the search results sits outside the rows, so it stays put while they
   scroll. */
.log-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); padding: var(--s2) var(--s4); background: var(--panel); border-bottom: 1px solid var(--border); }
.log-head h2 { flex: 1; margin: 0; font-size: var(--text-lg); color: var(--text); overflow-wrap: anywhere; }
.log-head button { flex: none; }
/* Deleting a direct conversation asks first, and says why it could not, on a line of its own under the name. */
#delete-confirm, #delete-note { flex: 1 1 100%; order: 1; margin: 0; }
#delete-confirm { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); }
#delete-text { flex: 1 1 12rem; }
/* The name and, for a channel, its members stack; a long members line is cut with an ellipsis, the full list in its title. */
.log-name { flex: 1; min-width: 0; }
#log-members, #log-status { margin: 0; font-size: var(--text-sm); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.channel::before, .item .channel-name::before { content: "# "; color: var(--muted); }
#post-rows, #result-rows { flex: 1; overflow-y: auto; padding: var(--s2) 0 var(--s4); }
/* A short log sits at the bottom, above the compose box, by an auto margin: justifying the content to the end would
   leave the top of a long log out of reach. The webhook deliveries are newest first, so they stay at the top. */
#post-rows { display: flex; flex-direction: column; }
#post-rows > :first-child { margin-top: auto; }
#post-rows.top > :first-child { margin-top: 0; }
.entry { display: grid; grid-template-columns: auto auto minmax(0, 1fr); grid-template-areas: "from tag time" "body body body"; column-gap: var(--s2); align-items: baseline; padding: var(--s2) var(--s4); }
.entry.result { grid-template-columns: auto auto auto minmax(0, 1fr); grid-template-areas: "from where tag time" "body body body body"; }
.where { grid-area: where; color: var(--muted); overflow-wrap: anywhere; }
.entry:hover { background: var(--panel); }
.from { grid-area: from; font-family: var(--font-mono); font-weight: 600; overflow-wrap: anywhere; }
.time { grid-area: time; font-size: var(--text-sm); color: var(--muted); }
.tag { grid-area: tag; font-size: var(--text-xs); color: var(--accent); border: 1px solid currentColor; border-radius: var(--radius); padding: 0 var(--s1); }
.body { grid-area: body; white-space: pre-wrap; overflow-wrap: anywhere; }
.mention { color: var(--accent); background: var(--mention-bg); border-radius: 3px; padding: 0 2px; font-weight: 600; }
.body a { color: var(--accent); }
.mention.me { color: var(--me); background: var(--me-bg); box-shadow: inset 0 -2px 0 currentColor; }
.entry.chat { grid-template-columns: 2.5rem auto auto auto auto minmax(0, 1fr); grid-template-areas: "avatar from kind tag time receipt" "avatar body body body body body"; column-gap: 0; padding-bottom: 1px; }
.entry.chat > :not(.avatar) { margin-left: var(--s2); }
.entry.chat > .from { color: var(--who); }
.entry.chat > .kind { grid-area: kind; }
.avatar { grid-area: avatar; align-self: start; display: flex; align-items: center; justify-content: center; width: 2rem; height: 2rem; margin-top: 0.15rem; border-radius: 0.4rem; background: var(--who); color: var(--bg); font-size: var(--text-sm); font-weight: 700; }
.avatar.person { border-radius: 50%; }
.entry.cont { grid-template-columns: 2.5rem minmax(0, 1fr) auto; grid-template-areas: "time body receipt"; padding-top: 1px; }
.entry.cont > .avatar, .entry.cont > .from, .entry.cont > .kind, .entry.cont > .tag { display: none; }
.entry.chat.cont > .time { margin-left: 0; font-size: var(--text-xs); line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: center; align-self: center; visibility: hidden; }
.entry.cont:hover > .time { visibility: visible; }
.receipt { grid-area: receipt; font-size: var(--text-sm); color: var(--muted); white-space: nowrap; }
.receipt.mentions { white-space: normal; overflow-wrap: anywhere; }
.c0 { --who: var(--who0); }
.c1 { --who: var(--who1); }
.c2 { --who: var(--who2); }
.c3 { --who: var(--who3); }
.c4 { --who: var(--who4); }
.c5 { --who: var(--who5); }
.c6 { --who: var(--who6); }
.c7 { --who: var(--who7); }
/* The "People" view's list and forms sit above its list of unused invites, the forms side by side when there is room. */
#invite-forms { display: flex; flex-wrap: wrap; gap: var(--s3); padding: var(--s3) var(--s4); border-bottom: 1px solid var(--border); }
#person-form, #link-form { flex: 1 1 14rem; display: flex; flex-direction: column; gap: var(--s1); }
#invite-forms h3 { margin: 0; font-size: var(--text-sm); font-weight: 600; color: var(--muted); }
#invite-forms input, #invite-forms select { padding: var(--s1); background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); }
#invite-forms .note { margin: 0; }
#invite-made, #cancel-confirm, #cancel-note { flex: 1 1 100%; }
#invite-made, #cancel-confirm { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); }
#invite-for, #cancel-text { flex: 1 1 100%; margin: 0; }
#invite-link { flex: 1 1 16rem; min-width: 0; font-family: var(--font-mono); }
/* The people list heads the view: a row per person with their role and, but for the token's own, its buttons. */
#people-list, #invites-title { flex: 1 1 100%; }
#people-list { display: flex; flex-direction: column; gap: var(--s2); }
#people-rows li { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); padding: var(--s1) 0; border-bottom: 1px solid var(--border); }
#people-rows li > .from { flex: 1 1 4rem; min-width: 0; overflow-wrap: anywhere; font-weight: 600; }
#remove-confirm { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); }
#remove-text { flex: 1 1 100%; margin: 0; }
.entry.invite { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "from cancel" "time cancel" "body cancel"; }
.entry.invite > button { grid-area: cancel; align-self: center; }
.entry.approval > .agents { grid-column: 1 / -1; overflow-wrap: anywhere; }
/* An admin's approval row has its Revoke button at the end, and its time on a line of its own, so the button never covers it. */
.entry.approval.revocable { grid-template-columns: auto auto minmax(0, 1fr) auto; grid-template-areas: "from tag . revoke" "time time time revoke" "body body body revoke"; }
.entry.approval.revocable > .agents { grid-column: 1 / 4; }
.entry.approval.revocable > button { grid-area: revoke; align-self: center; }
#approval-confirm { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); padding: var(--s2) var(--s4); border-bottom: 1px solid var(--border); }
#approval-text { flex: 1 1 100%; margin: 0; }
/* A webhook: what it fires on, its id, its origin and what it sends, with its Remove button at the end. */
.entry.webhook { grid-template-columns: auto auto minmax(0, 1fr) auto; grid-template-areas: "from tag . remove" "body body body remove"; }
.entry.webhook > button { grid-area: remove; align-self: center; }
/* A token: its kind, its id and when it was made, then who or what it is for, with its Revoke button at the end. */
.entry.token { grid-template-columns: auto auto minmax(0, 1fr) auto; grid-template-areas: "from tag time revoke" "body body body revoke"; }
.entry.token > button { grid-area: revoke; align-self: center; }
#webhook-confirm, #token-confirm { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); padding: var(--s2) var(--s4); border-bottom: 1px solid var(--border); }
#webhook-text, #token-text { flex: 1 1 100%; margin: 0; }
/* The "Webhooks" view's "Add a webhook" form heads the view, its fields wrapping two to a row where there is room. */
#webhook-forms { display: flex; flex-direction: column; gap: var(--s2); padding: var(--s3) var(--s4); border-bottom: 1px solid var(--border); }
#webhook-forms h3 { margin: 0; font-size: var(--text-sm); font-weight: 600; color: var(--muted); }
#webhook-forms .note { margin: 0; }
#webhook-add-form { display: flex; flex-wrap: wrap; gap: var(--s2) var(--s3); }
#webhook-add-form > h3, #webhook-add-form > .note, #webhook-add-form > .actions, #webhook-add-form > .wide { flex: 1 1 100%; }
#webhook-add-form > .field { flex: 1 1 14rem; min-width: 0; display: flex; flex-direction: column; gap: var(--s1); }
#webhook-add-form > .check { flex: 1 1 100%; display: flex; align-items: center; gap: var(--s2); }
#webhook-add-form input[type="text"], #webhook-add-form input[type="password"], #webhook-add-form input[type="number"], #webhook-add-form textarea { padding: var(--s1); background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); }
#webhook-add-form textarea { font-family: var(--font-mono); resize: vertical; }
#webhook-made { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); }
#webhook-for { flex: 1 1 100%; margin: 0; }
#webhook-secret { flex: 1 1 16rem; min-width: 0; font-family: var(--font-mono); }
/* The "Tokens" view's "Make a token" form, and the token it made with its Copy button, sit above the list. */
#token-forms { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); padding: var(--s3) var(--s4); border-bottom: 1px solid var(--border); }
#token-forms h3 { flex: 1 1 100%; margin: 0; font-size: var(--text-sm); font-weight: 600; color: var(--muted); }
#token-forms select { padding: var(--s1); background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); }
#token-forms .note { margin: 0; }
#token-make-note, #token-made, #token-for { flex: 1 1 100%; }
#token-made { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); }
#token-for { margin: 0; overflow-wrap: anywhere; }
#token-value { flex: 1 1 16rem; min-width: 0; padding: var(--s1); font-family: var(--font-mono); background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); }
.delivery.failed .tag { color: var(--error); background: var(--error-bg); }
.item { display: flex; align-items: center; gap: var(--s2); text-align: left; background: none; border: 0; border-radius: var(--radius); padding: var(--s1) var(--s2); margin: 1px var(--s2); width: calc(100% - 2 * var(--s2)); }
.item.current { background: var(--active); font-weight: 600; box-shadow: inset 3px 0 0 var(--accent); }
.item .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.count { font-size: var(--text-sm); color: var(--muted); }
/* A sidebar entry's unread badge: a filled pill in the accent colour, with the page's background as its text. */
.badge { min-width: 1.25rem; padding: 0 var(--s1); border-radius: 999px; background: var(--accent); color: var(--bg); font-size: var(--text-xs); font-weight: 600; line-height: 1.25rem; text-align: center; }
/* An agents panel row: one line of mark, name and unread badge, a button that shows and hides the details under it. */
.agent > button { display: flex; align-items: center; gap: var(--s2); text-align: left; background: none; border: 0; border-radius: var(--radius); padding: var(--s1) var(--s2); margin: 1px var(--s2); width: calc(100% - 2 * var(--s2)); }
.agent > button:hover { background: var(--hover); }
.kind { font-size: var(--text-xs); color: var(--accent); }
.agent .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); font-weight: 600; }
/* An agent's status line after its name: muted, cut short like the name, and given up first when the row is narrow. */
.agent > button .status { flex: 0 1 auto; min-width: 0; max-width: 50%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-sm); color: var(--muted); }
.agent .details .status { font-style: italic; }
.agent .details { display: flex; flex-direction: column; padding: 0 var(--s3) var(--s2) var(--s4); font-size: var(--text-sm); color: var(--muted); overflow-wrap: anywhere; }
.agent .details .actions button { color: var(--text); }
/* An admin person's confirmation, note and new key for an agent sit under the panel's heading, outside the rows each
   poll redraws. */
#agent-confirm, #agent-key-made { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); margin: 0 var(--s3) var(--s2); font-size: var(--text-sm); }
#agent-confirm-text, #agent-key-for { flex: 1 1 100%; margin: 0; overflow-wrap: anywhere; }
#agent-key { flex: 1 1 100%; min-width: 0; padding: var(--s1); font-family: var(--font-mono); background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); }
.dot { flex: none; width: 0.6rem; height: 0.6rem; border-radius: 50%; background: var(--offline); overflow: hidden; color: transparent; font-size: 0; }
.dot.online { background: var(--online); }
@media (max-width: 720px) {
  #view { grid-template-columns: minmax(0, 1fr); grid-template-areas: "bar" "chat"; }
  .bar { flex-wrap: wrap; }
  #search { order: 1; flex: 1 1 100%; }
  .toggle { display: inline-block; }
  /* The sidebar and the agents panel lie over the conversation, under the header bar, and slide in from the left and the
     right. Off screen they are hidden too, so Tab and screen readers do not reach them; the visibility change waits for
     the slide out to end. */
  #view { position: relative; overflow: hidden; }
  #sidebar, #agents { position: absolute; grid-area: chat; top: 0; bottom: 0; z-index: 2; width: min(20rem, 85%); visibility: hidden; transition: transform 0.2s ease, visibility 0.2s; }
  #sidebar { left: 0; transform: translateX(-100%); border-right: 1px solid var(--border); }
  #agents { right: 0; transform: translateX(100%); border-left: 1px solid var(--border); }
  #view.show-sidebar #sidebar, #view.show-agents #agents { visibility: visible; transform: none; }
  .entry { padding: var(--s2) var(--s3); }
  #writer { padding: var(--s2) var(--s3); }
}
@media (prefers-reduced-motion: reduce) {
  #sidebar, #agents { transition: none; }
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
const chat = document.getElementById("chat");
const sidebarButton = document.getElementById("show-sidebar");
const agentsButton = document.getElementById("show-agents");
const sidebarPanel = document.getElementById("sidebar");
const agentsPanel = document.getElementById("agents");
const rows = document.getElementById("rows");
const channelRows = document.getElementById("channel-rows");
const log = document.getElementById("log");
const logTitle = document.getElementById("log-title");
const logMembers = document.getElementById("log-members");
const logStatus = document.getElementById("log-status");
const logNote = document.getElementById("log-note");
const postRows = document.getElementById("post-rows");
const pairRows = document.getElementById("pair-rows");
const messagesNote = document.getElementById("messages-note");
const statusLine = document.getElementById("status-line");
const signoutRetry = document.getElementById("signout-retry");
const searchForm = document.getElementById("search");
const searchText = document.getElementById("search-text");
const results = document.getElementById("results");
const resultsTitle = document.getElementById("results-title");
const resultsNote = document.getElementById("results-note");
const resultRows = document.getElementById("result-rows");
const deliveryEntry = document.getElementById("delivery-entry");
const approvalEntry = document.getElementById("approval-entry");
const approvalConfirm = document.getElementById("approval-confirm");
const approvalText = document.getElementById("approval-text");
const approvalYes = document.getElementById("approval-yes");
const approvalNote = document.getElementById("approval-note");
const webhookEntry = document.getElementById("webhook-entry");
const webhookConfirm = document.getElementById("webhook-confirm");
const webhookText = document.getElementById("webhook-text");
const webhookYes = document.getElementById("webhook-yes");
const webhookNote = document.getElementById("webhook-note");
const webhookForms = document.getElementById("webhook-forms");
const webhookAddForm = document.getElementById("webhook-add-form");
const hookUrl = document.getElementById("hook-url");
const hookOn = document.getElementById("hook-on");
const hookIncludeText = document.getElementById("hook-text");
const hookHeaderName = document.getElementById("hook-header-name");
const hookHeaderValue = document.getElementById("hook-header-value");
const hookMax = document.getElementById("hook-max");
const hookBody = document.getElementById("hook-body");
const hookAdd = document.getElementById("hook-add");
const hookNote = document.getElementById("hook-note");
const webhookMade = document.getElementById("webhook-made");
const webhookFor = document.getElementById("webhook-for");
const webhookSecret = document.getElementById("webhook-secret");
const webhookCopyNote = document.getElementById("webhook-copy-note");
const tokenEntry = document.getElementById("token-entry");
const tokenConfirm = document.getElementById("token-confirm");
const tokenText = document.getElementById("token-text");
const tokenYes = document.getElementById("token-yes");
const tokenNote = document.getElementById("token-note");
const tokenForms = document.getElementById("token-forms");
const tokenForm = document.getElementById("token-form");
const tokenKind = document.getElementById("token-kind");
const tokenMake = document.getElementById("token-make");
const tokenMakeNote = document.getElementById("token-make-note");
const tokenMade = document.getElementById("token-made");
const tokenFor = document.getElementById("token-for");
const tokenValue = document.getElementById("token-value");
const tokenCopyNote = document.getElementById("token-copy-note");
const peopleHead = document.getElementById("people-head");
const inviteEntry = document.getElementById("invite-entry");
const inviteForms = document.getElementById("invite-forms");
const peopleRows = document.getElementById("people-rows");
const peopleRead = document.getElementById("people-read");
const peopleNote = document.getElementById("people-note");
const removeConfirm = document.getElementById("remove-confirm");
const removeText = document.getElementById("remove-text");
const removeYes = document.getElementById("remove-yes");
const personForm = document.getElementById("person-form");
const personName = document.getElementById("person-name");
const personKind = document.getElementById("person-kind");
const personAdd = document.getElementById("person-add");
const personNote = document.getElementById("person-note");
const linkForm = document.getElementById("link-form");
const linkPerson = document.getElementById("link-person");
const linkMake = document.getElementById("link-make");
const linkNote = document.getElementById("link-note");
const inviteMade = document.getElementById("invite-made");
const inviteFor = document.getElementById("invite-for");
const inviteLink = document.getElementById("invite-link");
const copyNote = document.getElementById("copy-note");
const cancelConfirm = document.getElementById("cancel-confirm");
const cancelText = document.getElementById("cancel-text");
const cancelYes = document.getElementById("cancel-yes");
const cancelNote = document.getElementById("cancel-note");
const agentsHead = document.getElementById("agents-head");
const agentNote = document.getElementById("agent-note");
const agentConfirm = document.getElementById("agent-confirm");
const agentConfirmText = document.getElementById("agent-confirm-text");
const agentYes = document.getElementById("agent-yes");
const agentKeyMade = document.getElementById("agent-key-made");
const agentKeyFor = document.getElementById("agent-key-for");
const agentKey = document.getElementById("agent-key");
const agentCopyNote = document.getElementById("agent-copy-note");
const asNote = document.getElementById("as-note");
const writer = document.getElementById("writer");
const compose = document.getElementById("compose");
const composeLabel = document.getElementById("compose-label");
const composeText = document.getElementById("compose-text");
const composeNote = document.getElementById("compose-note");
const composeSend = document.getElementById("compose-send");
const mentionList = document.getElementById("mentions");
const newButton = document.getElementById("new-message");
const newForm = document.getElementById("new-form");
const newNote = document.getElementById("new-note");
const newFields = document.getElementById("new-fields");
const newFrom = document.getElementById("new-from");
const newTo = document.getElementById("new-to");
const newOpen = document.getElementById("new-open");
const channelButton = document.getElementById("new-channel");
const channelForm = document.getElementById("channel-form");
const channelNote = document.getElementById("channel-note");
const channelFields = document.getElementById("channel-fields");
const channelFrom = document.getElementById("channel-from");
const channelName = document.getElementById("channel-name");
const channelBody = document.getElementById("channel-body");
const channelCreate = document.getElementById("channel-create");
const deleteButton = document.getElementById("delete-pair");
const deleteConfirm = document.getElementById("delete-confirm");
const deleteText = document.getElementById("delete-text");
const deleteYes = document.getElementById("delete-yes");
const deleteNote = document.getElementById("delete-note");
let timer;
let generation = 0;
let controller;
// The channel whose log is open, or undefined, and how many of its posts the log holds.
let openChannel;
let held = 0;
// How many of the account's direct messages the page holds, the messages themselves, oldest first, and the pairs of
// agents that have messaged each other, by pairKey, each with its names, its count of messages and the index in
// messages of its newest. A pair started from "New message" is among them with a count of 0 until its first message;
// ask() drops it with the rest. madePairs numbers such pairs, so the one started last is listed first among them.
let heldMessages = 0;
let messages = [];
let pairs = new Map();
let madePairs = 0;
// The pair whose messages are open in the log, by pairKey, or undefined.
let openPair;
// Whether the webhook deliveries, the approved clients, the invites, the webhooks or the tokens are open in the log. At
// most one of openChannel, openPair, openDeliveries, openApprovals, openInvites, openWebhooks and openTokens is set.
let openDeliveries = false;
let openApprovals = false;
let openInvites = false;
let openWebhooks = false;
let openTokens = false;
// What this tab has seen of each channel and pair, by sidebar key: its count of posts or messages when the tab last
// had it open, or when the first poll for this token read it. An entry's total less this is its unread badge. It lives
// only here, is never sent or stored, and marks nothing read for any agent; ask() forgets it.
let seen = new Map();
// Each entry's total as the sidebar last showed it, by sidebar key, so markOpen can count an entry seen in place.
let shownTotals = new Map();
// Whether the first poll for this token has read the channels and every message. Until it has, no badge shows.
let seenAll = false;
// The count on the sidebar's webhooks entry, once the entry is made: how many deliveries the view read when last open.
let deliveryCount;
// The count on the sidebar's approved clients entry, once the entry is made: how many the view read when last open.
let approvalCount;
// The count on the sidebar's people entry while it is made, for an admin person only: how many people the view read
// when last open.
let inviteCount;
// The count on the sidebar's webhooks entry while it is made, for an admin person only, likewise.
let webhookCount;
// The count on the sidebar's tokens entry while it is made, for an admin person only, likewise.
let tokenCount;
// The search's own counter and request, separate from generation and controller, so a newer search, leaving the
// results or ask() drops a search's answer.
let searchGeneration = 0;
let searchController;
// Whether GET /api/token said this token is a person token, which alone shows the compose box, and the name of its
// person (undefined otherwise), whom the page then posts and sends as; the server's 403 is still what keeps any other
// token from posting, and a person token from posting as anyone else. meAdmin is whether GET /api/token said that
// person is an admin, which lets them delete as a full token does. fullToken is whether it said this is a full token,
// with no person, which may delete but not post. tokenGeneration drops an answer to GET /api/token, or to a send, that
// comes after the token was forgotten.
let canPost = false;
let me;
let meAdmin = false;
let fullToken = false;
let tokenGeneration = 0;
let tokenController;
// The last request to oauth/signin, settled once the server has answered or it failed. Each waits for the one before,
// so they reach the server in the order the page sent them: a sign-out's DELETE never lands before an earlier sign-in's
// POST, which would set the cookie again, nor after a later one, which it would clear.
let signing = Promise.resolve();
// Sign-ins (POSTs) this tab has sent or queued that have not been answered yet.
let signinsPending = 0;
// Sends a request to oauth/signin with its own deadline, settling with whether the server did it: a 2xx, or a 404 from a
// server with no sign-in to change (no https public URL). It never rejects. Relative to this page, so it stays under the
// public URL's path.
function signin(init) {
  const ac = new AbortController();
  const deadline = setTimeout(() => ac.abort(), TIMEOUT_MS);
  return fetch("oauth/signin", { ...init, cache: "no-store", credentials: "same-origin", referrerPolicy: "no-referrer", signal: ac.signal }).then(
    (res) => {
      clearTimeout(deadline);
      return res.ok || res.status === 404;
    },
    () => {
      clearTimeout(deadline);
      return false;
    },
  );
}
// Clears the sign-in cookie once every request this tab sent to oauth/signin before has been answered. Its promise settles
// with whether the server confirmed it.
function signout() {
  const done = signing.then(() => signin({ method: "DELETE" }));
  signing = done;
  return done;
}
// Forgets this tab's token and, unless clear is false, clears the sign-in cookie; if the server does not confirm that,
// says so on the token form with a button to try again, while the token form is still showing and no newer token has
// been entered.
function forget(clear = true) {
  ask();
  const gen = tokenGeneration;
  signoutRetry.hidden = true;
  if (!clear) return;
  signout().then((ok) => {
    if (ok || gen !== tokenGeneration || form.hidden) return;
    say("The server did not confirm signing this browser out of the page that approves clients, so it may still approve until the browser closes.", true);
    signoutRetry.hidden = false;
  });
}
// Tells the browser's other dashboard tabs that this one signed out, so they forget their tokens too; it carries no token.
const signouts = typeof BroadcastChannel === "function" ? new BroadcastChannel("message-cp-signout") : undefined;
// The names whose details the agents panel shows open, kept across polls; a name no longer listed is dropped, and ask()
// forgets them all.
let openAgents = new Set();
// The names of the account's live people, as the last GET /api/agents gave them (undefined until it has answered),
// and the person the page posts as: the token's person while people lists them, or undefined.
let people;
let person;
// The tokenGeneration a send is in flight for, or undefined. While one is, the Send button is disabled for that token,
// so the same submit is not sent twice while it is in flight; a new token is not held by it.
let sending;
// The compose box starts at MIN_ROWS rows and grows with its text up to MAX_ROWS, then scrolls.
const MIN_ROWS = 2;
const MAX_ROWS = 10;
// The open log's last entry, as chatEntry made it: its sender in lower case, its time in ms (NaN if it could not be
// read) and its tag, or undefined in an empty log. An entry continues its group only from this one.
// chatRows holds each of the open log's rows as chatEntry made them, so a change in who is a person re-marks them and
// a poll that finds a message or a post's mention read updates its receipt in place.
// chatTimes holds [time element, sentAt, due] for each row whose time can still change, so each poll can keep "2m ago"
// current: due is the earliest ms its text can change at (see nextChange). A time that shows a date is not held.
let lastEntry;
let chatRows = [];
let chatTimes = [];
// The people the open log's rows were last marked with, in lower case and joined, or undefined before any were.
let markedPeople;
// A group ends at a gap of this much or more.
const GROUP_MS = 5 * 60 * 1000;
// A mention as the server finds one: a copy of MENTION in src/channels.ts, to be kept in step with it.
const MENTION = /(?<![A-Za-z0-9_-])@([A-Za-z0-9_-]{1,32})(?![A-Za-z0-9_-])/g;
// The mention elements of the open log and of the search results, each with its name in lower case, so a change of
// the chosen person re-marks them in place.
let logMentions = [];
let resultMentions = [];
// The account's live agents and people as the last GET /api/agents gave them, each with its name and whether it is a
// person, which the compose box offers after an "@"; ask() clears them.
let mentionable = [];
// The status line of each agent that had one in the last GET /api/agents, by name, which the header bar of an open direct
// conversation shows; ask() clears them.
let statuses = new Map();
// An "@" being typed: the text before the caret ends in one, at the start or after a character that cannot be in a
// name (MENTION's boundary), with the name characters typed after it.
const TYPING = /(?<![A-Za-z0-9_-])@([A-Za-z0-9_-]{0,32})$/;
// At most this many names are offered.
const MAX_OFFERED = 8;
// The names offered now, empty while the list is closed, which one is highlighted, and the "@" and the characters
// typed after it, as offsets in the box's text, that a pick replaces.
let offered = [];
let highlighted = 0;
let typedFrom = 0;
let typedTo = 0;
// The lists the "New message" form's From and To selects were last built from, so a poll rebuilds a select only when
// its list changes and never closes it under the reader.
let fromKey = "";
let toKey = "";
// The list the "New channel" form's From select was last built from, as fromKey is for "New message".
let channelFromKey = "";
// The names of the channels the sidebar last listed, in lower case, or undefined until GET /api/channels has answered
// for this token. Channel names are unique without case, so "New channel" refuses one of these rather than posting in it.
let channelNames;
// The names, in lower case, that "New channel" has sent a post for under this token and that got a 200 or no answer, so
// may be stored. A channel list read before the post was stored leaves these out, so they are kept apart from
// channelNames, which each list replaces, and are refused too until ask() clears them. This guards only this page while
// it holds the token: POST /api/post creates a channel or adds to it, so the server cannot refuse an existing name.
let channelsSent = new Set();
// A channel name as the server takes one: a copy of NAME_PATTERN in src/agents.ts, to be kept in step with it.
const CHANNEL_NAME = /^[A-Za-z0-9_-]{1,32}$/;
// What a full token sees where a person token's compose box would be.
const SIGN_IN_TO_SEND = "To send, sign in as a person: run message-cp login-link --url <public url> --account <account> --person <name> on the server.";
// What an empty panel says: what makes something appear there, and, for channels and direct messages, one sentence
// more naming "New channel" or "New message" that goes only with a person token, as those buttons do.
// An admin person's token always lists its own person, so only another token ever sees this, and it adds people on the
// server.
const NO_AGENTS =
  'No agents yet: one appears here once it registers with the register tool, using message-cp as an MCP server (the reference page "Add it to an MCP client", https://message-cp.vercel.app/clients.html#add-it-to-an-mcp-client, says how). ' +
  "Add a person on the server with: message-cp person add <name> --account <account>";
const NO_CHANNELS = "No channels yet: an agent creates one with its first post there, using the post tool, or by joining it with the join_channel tool.";
const NO_CHANNELS_FULL = ' You can also start one from "New channel" above.';
const NO_MESSAGES = "No direct messages yet: they appear here when an agent sends one with the send_message tool.";
const NO_MESSAGES_FULL = ' You can also start one from "New message" above.';
const NO_DELIVERIES =
  "No webhook deliveries yet: add a webhook on the server with message-cp webhook add --url <url> --on <#channel | mention:<agent> | agent:<agent>>, and its deliveries show here once it fires.";
const NO_APPROVALS =
  "No approved clients yet: a client approved as one named agent, or as one that registers its own agents, appears here " +
  "once it connects through the server's authorization flow (serve --public-url), and its token is revoked on the server " +
  "with message-cp token revoke <id> or, by an admin person, with its Revoke button here.";
// The note showChannels put in an empty channel list, or undefined, so showNewButton can make it follow canPost.
let noChannels;
// The tokenGeneration a "New channel" post is in flight for, or undefined, as sending is for the compose box.
let creating;
// How many times the "New channel" form has closed, so a create that answers after its form was closed opens nothing.
let channelClosings = 0;
// The tokenGeneration a DELETE /api/conversation is in flight for, or undefined, as sending is for the compose box.
let deleting;
// The tokenGeneration a POST /api/people, a POST /api/invites or a DELETE /api/invites is in flight for, or undefined, as
// creating is for "New channel".
let adding;
let linking;
let cancelling;
// The tokenGeneration a PATCH or a DELETE /api/people from the people list is in flight for, or undefined, likewise.
let marking;
let removing;
// The person the view asks before removing ({ name }), or undefined.
let removeTarget;
// The list the people rows were last built from, as inviteRowsKey is for the invites.
let peopleRowsKey = "";
// How many times the "People" view has closed (closeLog), so an answer that comes after it closed changes nothing and
// never puts an invite's link on the page, as channelClosings does for "New channel". unmarked() bumps it too.
let inviteClosings = 0;
// The id of the invite whose link the view shows, or undefined, so cancelling that invite takes its link away.
let shownInvite;
// The invite the "People" view asks before cancelling ({ id, person, createdAt }), or undefined.
let cancelTarget;
// The list the people view's invites and the "New link" select were last built from, so a poll rebuilds them only when it
// changes, never taking the focus from a Cancel button or closing the select under the reader.
let inviteRowsKey = "";
let linkKey = "";
// How long an invite lasts, in days: INVITE_TTL_MS in src/login.ts.
const INVITE_DAYS = ${INVITE_TTL_MS / 86400000};
const NO_INVITES = "No unused invites. One is listed here from when it is made until it is used, cancelled or expires.";
// The agent the agents panel's confirmation, note and new key are for ({ kind: "remove" or "key", name }), or undefined.
// Opening another confirmation, closing that agent's details, Cancel, Done, unmarked() and ask() end it, so an answer
// for it that comes after changes nothing in the panel. The new key lives only in its field, never in a variable.
let agentFor;
// The tokenGeneration a DELETE /api/agents or a POST /api/agents/key is in flight for, or undefined, as removing is.
let removingAgent;
let resettingKey;
// The agents as the last GET /api/agents gave them, so the panel can be drawn again when the token's admin changes.
let lastAgents;
const NOT_ADMIN_AGENTS = "The server says you are no longer an admin of this account (403), so this page no longer offers removing agents or resetting their keys.";
const NOT_ADMIN = "The server says you are no longer an admin of this account (403), so this page no longer offers changing people or invites.";
// The tokenGeneration a DELETE /api/webhooks is in flight for, or undefined, as cancelling is for an invite.
let removingWebhook;
// The tokenGeneration a POST /api/webhooks is in flight for, or undefined, likewise.
let addingWebhook;
// The webhook that DELETE is removing (the target its confirmation was for), while removingWebhook is set.
let removingHook;
// The webhook the "Webhooks" view asks before removing ({ id, on, key }, key being its entry as GET /api/webhooks gave it),
// or undefined.
let webhookTarget;
// How many times the "Webhooks" view has closed (closeLog), so an answer that comes after it closed changes nothing, as
// inviteClosings does for the people view. unmarked() bumps it too.
let webhookClosings = 0;
// The list the webhook rows were last built from, so a poll rebuilds them only when it changes, never taking the focus
// from a Remove button.
let webhookRowsKey = "";
const NO_WEBHOOKS = 'No webhooks. Add one with the "Add a webhook" form above.';
const NOT_ADMIN_WEBHOOKS = "The server says you are no longer an admin of this account (403), so this page no longer lists, adds or removes webhooks.";
// The tokenGeneration a DELETE /api/approvals is in flight for, or undefined, as removingWebhook is for a webhook.
let revokingApproval;
// The approval that DELETE is revoking (the target its confirmation was for), while revokingApproval is set.
let revokingTarget;
// The approval the "Approved clients" view asks before revoking ({ id, client, agent, key }, agent being undefined for
// one that registers its own agents and key its entry as GET /api/approvals gave it), or undefined.
let approvalTarget;
// How many times the "Approved clients" view has closed (closeLog), so an answer that comes after it closed changes
// nothing, as webhookClosings does for the webhooks view. unmarked() bumps it too.
let approvalClosings = 0;
// The approvals the view last showed, as GET /api/approvals gave them, and the key its rows were built from (the list
// and whether they had Revoke buttons), so a poll rebuilds them only when either changes, never taking the focus from a
// Revoke button, and unmarked() can draw them again without the buttons.
let shownApprovals = [];
let approvalRowsKey = "";
const NOT_ADMIN_APPROVALS = "The server says you are no longer an admin of this account (403), so this page no longer offers revoking approved clients.";
// The tokenGeneration a DELETE /api/tokens is in flight for, or undefined, as removingWebhook is for a webhook.
let revokingToken;
// The token that DELETE is revoking (the target its confirmation was for), while revokingToken is set.
let revokingTokenTarget;
// The token the "Tokens" view asks before revoking ({ id, label, mine, key }, label being its kind and who or what it is
// for, mine whether it is a person token of the page's own person, key its entry as GET /api/tokens gave it), or
// undefined.
let tokenTarget;
// How many times the "Tokens" view has closed (closeLog), so an answer that comes after it closed changes nothing, as
// webhookClosings does. unmarked() bumps it too.
let tokenClosings = 0;
// The list the token rows were last built from, so a poll rebuilds them only when it changes, never taking the focus
// from a Revoke button.
let tokenRowsKey = "";
const NOT_ADMIN_TOKENS = "The server says you are no longer an admin of this account (403), so this page no longer lists, makes or revokes tokens.";
// The tokenGeneration a POST /api/tokens is in flight for, or undefined, as revokingToken is for a DELETE. The token it
// makes lives only in its field, never in a variable.
let makingToken;

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
  // Forget whether the last token could post, its person, and who the page posted as, so the next token starts
  // read-only and with no person.
  tokenGeneration++;
  if (tokenController) tokenController.abort();
  canPost = false;
  me = undefined;
  meAdmin = false;
  showInviteEntry();
  showWebhookEntry();
  showTokenEntry();
  fullToken = false;
  people = undefined;
  person = undefined;
  asNote.textContent = "";
  composeText.value = "";
  grow();
  composeNote.textContent = "";
  composeSend.disabled = false;
  mentionable = [];
  statuses = new Map();
  // The "New message" form goes with canPost, and its selects with the names, so the next token never sees them.
  showNewButton();
  fromKey = "";
  toKey = "";
  newFrom.replaceChildren();
  newTo.replaceChildren();
  newNote.textContent = "";
  newFields.hidden = false;
  newOpen.hidden = false;
  // So do the "New channel" form, its select, its note and its text, and the channel names it compared against.
  channelFromKey = "";
  channelNames = undefined;
  channelsSent = new Set();
  channelFrom.replaceChildren();
  channelName.value = "";
  channelBody.value = "";
  channelNote.textContent = "";
  channelFields.hidden = false;
  channelCreate.hidden = false;
  channelCreate.disabled = false;
  // And the "People" view's fields and buttons; closeLog() below drops a link it showed.
  personName.value = "";
  personKind.value = "plain";
  linkKey = "";
  linkPerson.replaceChildren();
  personAdd.disabled = false;
  linkMake.disabled = false;
  cancelYes.disabled = false;
  removeYes.disabled = false;
  webhookYes.disabled = false;
  hookAdd.disabled = false;
  approvalYes.disabled = false;
  tokenYes.disabled = false;
  tokenKind.value = "read-only";
  tokenMake.disabled = false;
  // And the agents panel's confirmation, note and any new key it showed.
  closeAgentPanel();
  agentYes.disabled = false;
  lastAgents = undefined;
  // Clear every panel, so one token's agents, channels, pairs and messages never show under the next token.
  rows.replaceChildren();
  openAgents = new Set();
  channelRows.replaceChildren();
  noChannels = undefined;
  heldMessages = 0;
  messages = [];
  pairs = new Map();
  madePairs = 0;
  pairRows.replaceChildren();
  seen = new Map();
  shownTotals = new Map();
  seenAll = false;
  messagesNote.textContent = "";
  if (deliveryCount) deliveryCount.textContent = "";
  if (approvalCount) approvalCount.textContent = "";
  closeLog();
  searchText.value = "";
  view.hidden = true;
  panel("");
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

// Signing out forgets this tab's token, clears the approval page's sign-in cookie for the whole browser once any sign-in
// in flight has been answered, and has every other dashboard tab of the browser forget its token. Without a public URL
// there is no oauth/signin, and the DELETE gets 404, which changes nothing.
document.getElementById("forget").addEventListener("click", () => {
  forget();
  if (signouts) signouts.postMessage("signout");
});
signoutRetry.addEventListener("click", () => forget());
// Another tab signed out: forget this tab's token too. A sign-in this tab sent that is still unanswered could set the
// cookie again after the other tab's DELETE, so this tab clears it again once its own requests are answered, and says
// so if the server does not confirm it, as its own "Forget token" does.
if (signouts) signouts.onmessage = () => forget(signinsPending > 0);
document.getElementById("close-log").addEventListener("click", () => {
  closeLog();
  markOpen();
});
searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (searchText.value) search(searchText.value);
});
document.getElementById("close-results").addEventListener("click", () => closeResults());
deleteButton.addEventListener("click", () => openDelete());
deleteYes.addEventListener("click", () => deletePair());
document.getElementById("delete-no").addEventListener("click", () => closeDelete(true));
newButton.addEventListener("click", () => (newForm.hidden ? openNew() : closeNew(true)));
document.getElementById("new-cancel").addEventListener("click", () => closeNew(true));
// Escape closes the form from inside it or from its button.
for (const node of [newForm, newButton]) {
  node.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || newForm.hidden) return;
    event.preventDefault();
    closeNew(true);
  });
}
channelButton.addEventListener("click", () => (channelForm.hidden ? openChannelForm() : closeChannelForm(true)));
document.getElementById("channel-cancel").addEventListener("click", () => closeChannelForm(true));
for (const node of [channelForm, channelButton]) {
  node.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || channelForm.hidden) return;
    event.preventDefault();
    closeChannelForm(true);
  });
}
channelForm.addEventListener("submit", (event) => {
  event.preventDefault();
  createChannel();
});
personForm.addEventListener("submit", (event) => {
  event.preventDefault();
  addInvitedPerson();
});
linkForm.addEventListener("submit", (event) => {
  event.preventDefault();
  makeInvite();
});
document.getElementById("invite-copy").addEventListener("click", () => copyInvite());
cancelYes.addEventListener("click", () => cancelInvite());
document.getElementById("cancel-no").addEventListener("click", () => closeCancelInvite(true));
removeYes.addEventListener("click", () => removeAccountPerson());
agentYes.addEventListener("click", () => (agentFor?.kind === "key" ? resetKey() : removeAgent()));
document.getElementById("agent-no").addEventListener("click", () => closeAgentPanel(true));
document.getElementById("agent-key-done").addEventListener("click", () => closeAgentPanel(true));
document.getElementById("agent-key-copy").addEventListener("click", () => copyAgentKey());
document.getElementById("remove-no").addEventListener("click", () => closeRemovePerson(true));
webhookYes.addEventListener("click", () => removeWebhook());
webhookAddForm.addEventListener("submit", (event) => {
  event.preventDefault();
  addAccountWebhook();
});
document.getElementById("webhook-copy").addEventListener("click", () => copyWebhookSecret());
document.getElementById("webhook-no").addEventListener("click", () => closeRemoveWebhook(true));
approvalYes.addEventListener("click", () => revokeApproval());
document.getElementById("approval-no").addEventListener("click", () => closeRevokeApproval(true));
tokenYes.addEventListener("click", () => revokeToken());
document.getElementById("token-no").addEventListener("click", () => closeRevokeToken(true));
tokenForm.addEventListener("submit", (event) => {
  event.preventDefault();
  makeToken();
});
document.getElementById("token-copy").addEventListener("click", () => copyToken());
newFrom.addEventListener("change", () => fillNew());
newForm.addEventListener("submit", (event) => {
  event.preventDefault();
  startPair(newFrom.value, newTo.value);
});
compose.addEventListener("submit", (event) => {
  event.preventDefault();
  send();
});
// Enter sends and Shift+Enter adds a line, as in a chat app. An Enter that ends an input method's composition does
// neither (Safari ends it before the keydown, which then has keyCode 229), and one in a box of only whitespace sends
// nothing; send() itself ignores one while a send is in flight.
// While names are offered, the arrows move the highlight, Enter or Tab picks the highlighted name and Escape closes the
// list, each in place of what the key would do. Each first looks again at the selection and the text before the caret,
// which a key the list does not watch (Ctrl+A, say) may have changed, and does what it always does if nothing is offered
// any more. An arrow, Enter or Tab with a modifier (Shift+Arrow selects, Shift+Tab moves focus back) does what it always
// does.
composeText.addEventListener("keydown", (event) => {
  if (offered.length > 0 && !event.isComposing && event.keyCode !== 229) offer();
  if (offered.length > 0 && !event.isComposing && event.keyCode !== 229) {
    const plain = !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;
    if (plain && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      highlighted = (highlighted + (event.key === "ArrowDown" ? 1 : offered.length - 1)) % offered.length;
      showOffered();
      return;
    }
    if (plain && (event.key === "Enter" || event.key === "Tab")) {
      event.preventDefault();
      pick(highlighted);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeOffered();
      return;
    }
  }
  if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  if (composeText.value.trim() !== "") send();
});
composeText.addEventListener("input", () => {
  grow();
  offer();
});
// Moving the caret without typing looks again at what is before it; leaving the box closes the list. An open list looks
// again after every key, once the browser has done what the key does (Ctrl+A selects, Shift+ArrowUp moves the caret), so
// it never stays offered for a selection or caret it no longer matches.
composeText.addEventListener("keyup", (event) => {
  if (offered.length > 0 || ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) offer();
});
composeText.addEventListener("click", () => offer());
composeText.addEventListener("blur", () => closeOffered());
// On a narrow screen these buttons slide the sidebar or the agents over the conversation; pressing one again closes its
// panel, and pressing the other swaps them.
sidebarButton.addEventListener("click", () => panel(view.className === "show-sidebar" ? "" : "show-sidebar"));
agentsButton.addEventListener("click", () => panel(view.className === "show-agents" ? "" : "show-agents"));
// Escape closes the open panel and puts focus back on its button, unless something inside took the key first (the New
// message and New channel forms and the mention list close themselves on it). An open delete confirmation is dismissed
// first, wherever the focus is.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  if (!deleteConfirm.hidden) {
    event.preventDefault();
    closeDelete(true);
    return;
  }
  if (!covering()) return;
  event.preventDefault();
  const button = view.className === "show-sidebar" ? sidebarButton : agentsButton;
  panel("");
  button.focus();
});
// A tap on the part of the conversation an open panel leaves uncovered closes the panel, and does nothing else. Focus left
// inside the panel goes back to its button, so it is not left on a control that is now hidden. A click made from the
// keyboard (detail 0), as on a focused Close or Send button, does what it always does.
chat.addEventListener(
  "click",
  (event) => {
    if (!covering() || event.detail === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const sidebarOpen = view.className === "show-sidebar";
    const focused = (sidebarOpen ? sidebarPanel : agentsPanel).contains(document.activeElement);
    panel("");
    if (focused) (sidebarOpen ? sidebarButton : agentsButton).focus();
  },
  true,
);

// Whether a panel lies over the conversation: one is open and the screen is narrow, which is when the toggles show (a
// hidden button has no offsetParent). A panel left open when the screen widens covers nothing.
function covering() {
  return view.className !== "" && sidebarButton.offsetParent !== null;
}

// Shows the named panel ("show-sidebar" or "show-agents") over the conversation, or neither for "", and keeps the
// buttons' aria-expanded in step.
function panel(name) {
  view.className = name;
  sidebarButton.setAttribute("aria-expanded", name === "show-sidebar" ? "true" : "false");
  agentsButton.setAttribute("aria-expanded", name === "show-agents" ? "true" : "false");
}

// Closes the open conversation and the search results.
function closeLog() {
  closeResults();
  openChannel = undefined;
  openPair = undefined;
  openDeliveries = false;
  // Leaving the approved clients drops their confirmation and note, and any revocation's answer still to come.
  openApprovals = false;
  approvalClosings++;
  closeRevokeApproval();
  approvalNote.textContent = "";
  shownApprovals = [];
  approvalRowsKey = "";
  // Leaving the people view drops the link it showed, its notes and its confirmation, and any answer still to come.
  openInvites = false;
  inviteClosings++;
  inviteForms.hidden = true;
  inviteMade.hidden = true;
  inviteFor.textContent = "";
  inviteLink.value = "";
  shownInvite = undefined;
  copyNote.textContent = "";
  personNote.textContent = "";
  linkNote.textContent = "";
  cancelNote.textContent = "";
  closeCancelInvite();
  inviteRowsKey = "";
  peopleNote.textContent = "";
  peopleRead.textContent = "";
  closeRemovePerson();
  peopleRows.replaceChildren();
  peopleRowsKey = "";
  // Leaving the webhooks view drops its confirmation and note, its form's fields, the secret it showed, and any answer
  // still to come.
  openWebhooks = false;
  webhookClosings++;
  closeRemoveWebhook();
  webhookNote.textContent = "";
  webhookRowsKey = "";
  closeWebhookForms();
  // Leaving the tokens view does the same, and drops its form and any token it made.
  openTokens = false;
  tokenClosings++;
  closeRevokeToken();
  tokenNote.textContent = "";
  tokenRowsKey = "";
  tokenForms.hidden = true;
  dropMadeToken();
  tokenMakeNote.textContent = "";
  held = 0;
  postRows.replaceChildren();
  postRows.className = "";
  lastEntry = undefined;
  chatRows = [];
  chatTimes = [];
  logMentions = [];
  logTitle.textContent = "";
  logTitle.className = "";
  logMembers.textContent = "";
  logMembers.title = "";
  logMembers.hidden = true;
  showPairStatus();
  logNote.textContent = "";
  log.hidden = true;
  closeOffered();
  // The text typed stays, so leaving a conversation never loses it; only a 200 or a new token clears it.
  composeNote.textContent = "";
  compose.hidden = true;
  asNote.textContent = "";
  writer.hidden = true;
  // Opening another conversation, or none, closes the "New message" and "New channel" forms, and dismisses a delete
  // confirmation without sending anything.
  closeNew(false);
  closeChannelForm(false);
  closeDelete(false);
  deleteNote.textContent = "";
  showDelete();
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
  panel("");
  markOpen();
  showPicker();
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
  panel("");
  postRows.replaceChildren(...messages.filter((m) => pairKey(m) === key).map(messageEntry));
  postRows.scrollTop = postRows.scrollHeight;
  // Only a pair started from "New message" can have none.
  logNote.textContent = pair.count === 0 ? "No messages yet." : "";
  markOpen();
  showPicker();
  showDelete();
  showPairStatus();
  cancel();
  poll(generation);
}

// The status lines of the open direct conversation's agents, as the last GET /api/agents gave them, in the header bar
// under its names; hidden and empty when no pair is open or neither side has one. A person never has one.
function showPairStatus() {
  // The names come from the key (pairKey's sorted names), not from pairs, which a delete with no answer leaves without
  // the open pair until its messages are read again. An agent's conversation with itself names it twice, but gives its
  // line once.
  const names = new Set(openPair !== undefined ? JSON.parse(openPair) : []);
  const text = [...names].filter((n) => statuses.has(n)).map((n) => n + ": " + statuses.get(n)).join(" · ");
  logStatus.textContent = text;
  logStatus.title = text;
  logStatus.hidden = text === "";
}

// Opens the account's webhook deliveries in the log and polls again at once, as openLog does for a channel.
function openDeliveryLog() {
  closeLog();
  openDeliveries = true;
  postRows.className = "top";
  logTitle.textContent = "Webhook deliveries";
  logNote.textContent = "Loading…";
  log.hidden = false;
  panel("");
  markOpen();
  cancel();
  poll(generation);
}

// Opens the account's approved clients in the log and polls again at once, as openDeliveryLog does.
function openApprovalLog() {
  closeLog();
  openApprovals = true;
  postRows.className = "top";
  logTitle.textContent = "Approved clients";
  logNote.textContent = "Loading…";
  log.hidden = false;
  panel("");
  markOpen();
  cancel();
  poll(generation);
}

// Opens the "People" view in the log, for an admin person only, and polls again at once, as openApprovalLog does: the
// account's people, each but the token's own with buttons to mark or unmark them an admin and to remove them, its
// "Add person" and "New link" forms, then the account's unused invites, each with a Cancel button.
function openInviteLog() {
  if (!meAdmin) return;
  closeLog();
  openInvites = true;
  postRows.className = "top";
  logTitle.textContent = "People";
  logNote.textContent = "Loading…";
  peopleRead.textContent = "Loading…";
  inviteForms.hidden = false;
  personAdd.disabled = adding === tokenGeneration;
  linkMake.disabled = linking === tokenGeneration;
  fillLink();
  log.hidden = false;
  panel("");
  markOpen();
  cancel();
  poll(generation);
  personName.focus();
}

// Opens the "Webhooks" view in the log, for an admin person only, and polls again at once, as openApprovalLog does: its
// "Add a webhook" form, then the account's webhooks, oldest first, each with a Remove button that asks first.
function openWebhookLog() {
  if (!meAdmin) return;
  closeLog();
  openWebhooks = true;
  postRows.className = "top";
  logTitle.textContent = "Webhooks";
  logNote.textContent = "Loading…";
  webhookForms.hidden = false;
  hookAdd.disabled = addingWebhook === tokenGeneration;
  log.hidden = false;
  panel("");
  markOpen();
  cancel();
  poll(generation);
  hookUrl.focus();
}

// Hides the "Webhooks" view's form and the secret it showed, emptying every field, so neither a URL, a header value, a
// body nor a secret outlives the view.
function closeWebhookForms() {
  webhookForms.hidden = true;
  hookUrl.value = "";
  hookOn.value = "";
  hookIncludeText.checked = true;
  hookHeaderName.value = "";
  hookHeaderValue.value = "";
  hookMax.value = "";
  hookBody.value = "";
  hookNote.textContent = "";
  webhookMade.hidden = true;
  webhookFor.textContent = "";
  webhookSecret.value = "";
  webhookCopyNote.textContent = "";
}

// Opens the "Tokens" view in the log, for an admin person only, and polls again at once, as openWebhookLog does: its
// "Make a token" form, then the account's unrevoked tokens, oldest first, each with a Revoke button that asks first.
function openTokenLog() {
  if (!meAdmin) return;
  closeLog();
  openTokens = true;
  postRows.className = "top";
  logTitle.textContent = "Tokens";
  logNote.textContent = "Loading…";
  tokenForms.hidden = false;
  tokenMake.disabled = makingToken === tokenGeneration;
  log.hidden = false;
  panel("");
  markOpen();
  cancel();
  poll(generation);
}

// Makes the sidebar's "Webhooks" entry, under its Webhooks heading beside "Webhook deliveries", while the token is an
// admin person's, and removes it otherwise, as showInviteEntry does.
function showWebhookEntry() {
  if (!meAdmin) {
    webhookEntry.replaceChildren();
    webhookCount = undefined;
  } else if (!webhookCount) {
    webhookCount = part("span", "count", "");
    webhookEntry.append(sidebarItem("webhooks", "Webhooks", "", webhookCount, openWebhookLog));
  }
}

// Makes the sidebar's "Tokens" entry, under its Clients heading beside "Approved clients", while the token is an admin
// person's, and removes it otherwise, as showWebhookEntry does.
function showTokenEntry() {
  if (!meAdmin) {
    tokenEntry.replaceChildren();
    tokenCount = undefined;
  } else if (!tokenCount) {
    tokenCount = part("span", "count", "");
    tokenEntry.append(sidebarItem("tokens", "Tokens", "", tokenCount, openTokenLog));
  }
}

// Makes the sidebar's "People" entry, under its People heading, while the token is an admin person's, and removes both
// otherwise.
function showInviteEntry() {
  peopleHead.hidden = !meAdmin;
  if (!meAdmin) {
    inviteEntry.replaceChildren();
    inviteCount = undefined;
  } else if (!inviteCount) {
    inviteCount = part("span", "count", "");
    inviteEntry.append(sidebarItem("invites", "People", "", inviteCount, openInviteLog));
  }
}

// After the server's 403 to an admin's request, which says the person is no longer an admin: the page forgets it, so
// the "People", "Webhooks" and "Tokens" entries and Delete go, an open people, webhooks or tokens view keeps only a
// note saying why, and an open "Approved clients" view keeps its list without Revoke buttons, with a note saying why.
function unmarked() {
  meAdmin = false;
  // An Add or New link still in flight then shows no link, a webhook's addition shows no secret, and a webhook's addition
  // or removal, an approval's revocation or a token's revoking still in flight changes nothing.
  inviteClosings++;
  webhookClosings++;
  approvalClosings++;
  tokenClosings++;
  showInviteEntry();
  showWebhookEntry();
  showTokenEntry();
  showDelete();
  // The agents panel's buttons, confirmation and any new key go too.
  closeAgentPanel();
  if (lastAgents) show(lastAgents);
  if (openApprovals) {
    // The focus may be on a Revoke button or in the confirmation, which go, so it moves to the view's Close button.
    closeRevokeApproval();
    document.getElementById("close-log").focus();
    drawApprovals(shownApprovals);
    approvalNote.textContent = NOT_ADMIN_APPROVALS;
    return;
  }
  if (openWebhooks) {
    // The focus may be on a Remove button, in the form or in the confirmation, which go, so it moves to the view's Close button.
    closeRemoveWebhook();
    webhookNote.textContent = "";
    closeWebhookForms();
    document.getElementById("close-log").focus();
    postRows.replaceChildren();
    webhookRowsKey = "";
    logNote.textContent = NOT_ADMIN_WEBHOOKS;
    return;
  }
  if (openTokens) {
    // Likewise for a Revoke button, the token's confirmation, or the "Make a token" form and any token it made.
    closeRevokeToken();
    tokenNote.textContent = "";
    tokenForms.hidden = true;
    dropMadeToken();
    tokenMakeNote.textContent = "";
    document.getElementById("close-log").focus();
    postRows.replaceChildren();
    tokenRowsKey = "";
    logNote.textContent = NOT_ADMIN_TOKENS;
    return;
  }
  if (!openInvites) return;
  // The focus may be in the forms, which go, so it moves to the view's Close button.
  inviteForms.hidden = true;
  document.getElementById("close-log").focus();
  inviteMade.hidden = true;
  inviteLink.value = "";
  shownInvite = undefined;
  closeCancelInvite();
  closeRemovePerson();
  postRows.replaceChildren();
  inviteRowsKey = "";
  peopleRows.replaceChildren();
  peopleRowsKey = "";
  logNote.textContent = NOT_ADMIN;
}

// Builds the "New link" select from the account's people, as the last GET /api/agents gave them, keeping the choice
// while that name is listed; rebuilt only when the list changes.
function fillLink() {
  const known = people ?? [];
  const now = JSON.stringify(known);
  if (now === linkKey) return;
  linkKey = now;
  const chosen = linkPerson.value;
  linkPerson.replaceChildren(choose("Choose a person"), ...known.map((name) => {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    return option;
  }));
  linkPerson.value = known.includes(chosen) ? chosen : "";
}

// Sends one of the "People" view's writes: method to path, with body as JSON if given, under ac. Answers the status
// with a 200's body, or another answer's reason and whether it asked to be retried (a busy database), or { error } with
// no answer, saying whether the deadline passed.
async function inviteWrite(token, ac, method, path, body) {
  const headers = { Authorization: "Bearer " + token };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  try {
    const res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: ac.signal,
    });
    if (res.status === 200) return { status: 200, body: await res.json().catch(() => undefined) };
    return { status: res.status, reason: await reasonOf(res), retry: res.headers.get("Retry-After") !== null };
  } catch {
    return { error: ac.signal.aborted ? "The server did not answer in time" : "No answer from the server" };
  }
}

// What a form's note says for an answer that is not a 200, 401, 403 or 404: a 400's reason (a name taken or not
// allowed), a 503's (too many invites this week) unless the server was only busy.
function refusal(answer) {
  if (answer.status === 400) return answer.reason || "The server refused this (400).";
  if (answer.status === 413) return "This is too long for the server (413).";
  if (answer.status === 503) {
    return answer.retry || !answer.reason || answer.reason === "Too many requests" ? "The server is busy (503). Try again in a moment." : answer.reason;
  }
  return "The server answered " + answer.status + ".";
}

// Shows the invite a 200 from POST /api/people or /api/invites made: its link, from the answer, or else built from this
// page's own address with the code in the fragment, as loginLink builds one. It goes only into the link field, by value
// (and the clipboard, from Copy), and the field is emptied when the view closes. Answers false for an answer this page cannot read.
function showInvite(body) {
  const invite = body && typeof body === "object" ? body.invite : undefined;
  if (!invite || typeof invite !== "object" || typeof invite.code !== "string" || typeof body.name !== "string") return false;
  let link;
  if (typeof invite.link === "string") link = invite.link;
  else {
    const url = new URL(location.href);
    url.search = "";
    url.hash = "code=" + invite.code;
    link = url.href;
  }
  inviteFor.textContent =
    "Invite link for " + body.name + (body.admin === true ? " (admin)" : "") + ". Opening it signs one browser in as them. " +
    "It works once and lasts " + INVITE_DAYS + " days, until " + when(invite.expiresAt) + ". It shows only here, until you leave this view.";
  inviteLink.value = link;
  shownInvite = invite.id;
  copyNote.textContent = "";
  inviteMade.hidden = false;
  inviteLink.focus();
  return true;
}

// Reads the people and the invites again at once, after a write that may have changed them.
function refresh() {
  cancel();
  poll(generation);
}

// Adds a person, plain or admin, with POST /api/people, and shows the link of the invite it makes for them. Nothing is
// sent without a name, and Add stays disabled while the request is in flight. An answer that comes after the token was
// forgotten, or after the view closed, changes nothing; a 403 means the person is no longer an admin (unmarked).
async function addInvitedPerson() {
  const token = sessionStorage.getItem(KEY);
  if (!token) return ask();
  const tokenGen = tokenGeneration;
  if (!meAdmin || !openInvites || adding === tokenGen) return;
  const name = personName.value.trim();
  const admin = personKind.value === "admin";
  if (name === "") {
    personNote.textContent = "Enter a name.";
    return;
  }
  adding = tokenGen;
  const closings = inviteClosings;
  personAdd.disabled = true;
  personNote.textContent = "Adding…";
  const ac = new AbortController();
  const deadline = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let answer;
  try {
    answer = await inviteWrite(token, ac, "POST", "/api/people", { name, admin });
  } finally {
    clearTimeout(deadline);
  }
  if (tokenGen !== tokenGeneration) return;
  adding = undefined;
  personAdd.disabled = false;
  if (answer.status === 401) return ask("The server refused that token. Enter another.");
  if (closings !== inviteClosings) return;
  if (answer.status === 403) return unmarked();
  if (answer.status === 200) {
    // The form starts again as a plain person, so the next one is never an admin by accident.
    if (personName.value.trim() === name) personName.value = "";
    personKind.value = "plain";
    personNote.textContent = showInvite(answer.body) ? "Added " + name + "." : "Added " + name + ", but this page cannot read the invite: make a new link for them.";
    refresh();
    return;
  }
  if (answer.error) {
    personNote.textContent = answer.error + ", so " + name + " may have been added: the agents panel and the invites below show whether.";
    refresh();
    return;
  }
  personNote.textContent = refusal(answer);
}

// Makes a new invite for a person of the account with POST /api/invites and shows its link, as addInvitedPerson does.
async function makeInvite() {
  const token = sessionStorage.getItem(KEY);
  if (!token) return ask();
  const tokenGen = tokenGeneration;
  if (!meAdmin || !openInvites || linking === tokenGen) return;
  const person = linkPerson.value;
  if (person === "") {
    linkNote.textContent = "Choose a person.";
    return;
  }
  linking = tokenGen;
  const closings = inviteClosings;
  linkMake.disabled = true;
  linkNote.textContent = "Making a link…";
  const ac = new AbortController();
  const deadline = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let answer;
  try {
    answer = await inviteWrite(token, ac, "POST", "/api/invites", { person });
  } finally {
    clearTimeout(deadline);
  }
  if (tokenGen !== tokenGeneration) return;
  linking = undefined;
  linkMake.disabled = false;
  if (answer.status === 401) return ask("The server refused that token. Enter another.");
  if (closings !== inviteClosings) return;
  if (answer.status === 403) return unmarked();
  if (answer.status === 200) {
    linkNote.textContent = showInvite(answer.body) ? "" : "A link was made, but this page cannot read it: make another.";
    refresh();
    return;
  }
  if (answer.error) {
    linkNote.textContent = answer.error + ", so a link for " + person + " may have been made: the invites below show whether.";
    refresh();
    return;
  }
  linkNote.textContent = answer.status === 404 ? person + " is not a person in this account now (404)." : refusal(answer);
}

// Copies the shown link to the clipboard; where the browser refuses, selects it to copy by hand.
async function copyInvite() {
  const link = inviteLink.value;
  if (!link) return;
  const closings = inviteClosings;
  let copied = false;
  try {
    await navigator.clipboard.writeText(link);
    copied = true;
  } catch {
    copied = false;
  }
  if (closings !== inviteClosings || inviteLink.value !== link) return;
  if (!copied) {
    inviteLink.focus();
    inviteLink.select();
  }
  copyNote.textContent = copied ? "Copied." : "This browser did not copy it: the link is selected, so copy it yourself.";
}

// Asks above the list before cancelling an invite; nothing is sent until its "Cancel invite" is pressed.
function openCancelInvite(invite) {
  if (!meAdmin || !openInvites) return;
  cancelTarget = invite;
  cancelNote.textContent = "";
  cancelText.textContent = "Cancel " + invite.person + "'s invite, made " + when(invite.createdAt) + "? Its link will stop working.";
  cancelConfirm.hidden = false;
  cancelYes.disabled = cancelling === tokenGeneration;
  document.getElementById("cancel-no").focus();
}

// Dismisses the cancel confirmation; when the reader dismissed it, or it was answered, the focus goes back to the name
// field, at the top of the view, as the confirmation and its row may be gone.
function closeCancelInvite(refocus) {
  cancelConfirm.hidden = true;
  cancelText.textContent = "";
  cancelTarget = undefined;
  if (refocus) personName.focus();
}

// Cancels the invite being asked about with DELETE /api/invites and says what it ended, then reads the list again. An
// answer that comes after the token was forgotten, or after the view closed, changes nothing.
async function cancelInvite() {
  const token = sessionStorage.getItem(KEY);
  if (!token) return ask();
  const tokenGen = tokenGeneration;
  const invite = cancelTarget;
  if (!meAdmin || !openInvites || !invite || cancelling === tokenGen) return;
  cancelling = tokenGen;
  const closings = inviteClosings;
  cancelYes.disabled = true;
  const ac = new AbortController();
  const deadline = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let answer;
  try {
    answer = await inviteWrite(token, ac, "DELETE", "/api/invites?" + new URLSearchParams({ id: String(invite.id) }));
  } finally {
    clearTimeout(deadline);
  }
  if (tokenGen !== tokenGeneration) return;
  cancelling = undefined;
  cancelYes.disabled = false;
  if (answer.status === 401) return ask("The server refused that token. Enter another.");
  if (closings !== inviteClosings) return;
  if (answer.status === 403) return unmarked();
  // A confirmation opened for another invite meanwhile stays.
  if (cancelTarget === invite) closeCancelInvite(true);
  // Once the server says this invite is gone (200, or 404: used, cancelled or expired), its link, if shown, goes too.
  if ((answer.status === 200 || answer.status === 404) && shownInvite === invite.id) {
    inviteMade.hidden = true;
    inviteFor.textContent = "";
    inviteLink.value = "";
    copyNote.textContent = "";
    shownInvite = undefined;
  }
  if (answer.status === 200) cancelNote.textContent = "Cancelled " + invite.person + "'s invite.";
  else if (answer.status === 404) cancelNote.textContent = invite.person + "'s invite was already used, cancelled or expired (404).";
  else if (answer.error) cancelNote.textContent = answer.error + ", so " + invite.person + "'s invite may have been cancelled: the list below shows whether.";
  else cancelNote.textContent = refusal(answer);
  if (answer.status === 200 || answer.status === 404 || answer.error) refresh();
}

// Marks the person name an admin, or unmarks them with admin false, with PATCH /api/people, says what changed in the
// list's note and reads the list again. An answer that comes after the token was forgotten, or after the view closed,
// changes nothing; a 403 means the token's person is no longer an admin (unmarked).
async function markPerson(name, admin) {
  const token = sessionStorage.getItem(KEY);
  if (!token) return ask();
  const tokenGen = tokenGeneration;
  if (!meAdmin || !openInvites || marking === tokenGen) return;
  marking = tokenGen;
  const closings = inviteClosings;
  peopleNote.textContent = admin ? "Making " + name + " an admin…" : "Removing admin from " + name + "…";
  const ac = new AbortController();
  const deadline = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let answer;
  try {
    answer = await inviteWrite(token, ac, "PATCH", "/api/people?" + new URLSearchParams({ name }), { admin });
  } finally {
    clearTimeout(deadline);
  }
  if (tokenGen !== tokenGeneration) return;
  marking = undefined;
  if (answer.status === 401) return ask("The server refused that token. Enter another.");
  if (closings !== inviteClosings) return;
  if (answer.status === 403) return unmarked();
  if (answer.status === 200) peopleNote.textContent = admin ? name + " is now an admin." : name + " is no longer an admin.";
  else if (answer.status === 404) peopleNote.textContent = name + " is already gone (404).";
  else if (answer.error) peopleNote.textContent = answer.error + ", so " + name + " may have been changed: the list below shows whether.";
  else peopleNote.textContent = refusal(answer);
  if (answer.status === 200 || answer.status === 404 || answer.error) refresh();
}

// Asks in the people list before removing a person; nothing is sent until its Remove is pressed.
function openRemovePerson(name) {
  if (!meAdmin || !openInvites) return;
  removeTarget = { name };
  peopleNote.textContent = "";
  removeText.textContent = "Remove " + name + "? This cannot be undone: it deletes their direct messages and mentions.";
  removeConfirm.hidden = false;
  removeYes.disabled = removing === tokenGeneration;
  document.getElementById("remove-no").focus();
}

// Dismisses the remove confirmation; when the reader dismissed it, or it was answered, the focus goes to the name field,
// as the row may be gone.
function closeRemovePerson(refocus) {
  removeConfirm.hidden = true;
  removeText.textContent = "";
  removeTarget = undefined;
  if (refocus) personName.focus();
}

const counted = (n, one) => n + " " + one + (n === 1 ? "" : "s");

// Drops the messages the page holds so the next poll reads them again from the start, after a removal deleted the
// direct messages of name, as deletePair does after a delete: a pair started from "New message" with none yet is kept,
// an open pair's rows are emptied until the read refills them, and, once the server said they were deleted (gone), what
// this tab had seen of name's pairs is forgotten. It reads nothing itself; the caller's refresh() or the next poll does.
function forgetMessagesOf(name, gone) {
  const folded = name.toLowerCase();
  if (gone) {
    for (const [k, p] of pairs) {
      if (p.names.some((n) => n.toLowerCase() === folded)) {
        seen.delete("pair " + k);
        shownTotals.delete("pair " + k);
      }
    }
  }
  heldMessages = 0;
  messages = [];
  pairs = new Map([...pairs].filter(([, p]) => p.count === 0).map(([k, p]) => [k, { ...p, newest: 0 }]));
  if (openPair !== undefined) {
    closeDelete(false);
    postRows.replaceChildren();
    lastEntry = undefined;
    chatRows = [];
    chatTimes = [];
    logMentions = [];
    if (pairs.has(openPair)) logNote.textContent = "No messages yet.";
  }
  showPairs();
  showPicker();
  showDelete();
}

// Removes the person being asked about with DELETE /api/people and says what it ended from the answer's counts, then
// reads the list again, as cancelInvite does. After a 200, 404 or no answer it also reads the account's messages again
// from the start (forgetMessagesOf), even if the view has closed since; any other answer after the view closed, or any
// answer after the token was forgotten, changes nothing.
async function removeAccountPerson() {
  const token = sessionStorage.getItem(KEY);
  if (!token) return ask();
  const tokenGen = tokenGeneration;
  const target = removeTarget;
  if (!meAdmin || !openInvites || !target || removing === tokenGen) return;
  removing = tokenGen;
  const closings = inviteClosings;
  removeYes.disabled = true;
  const ac = new AbortController();
  const deadline = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let answer;
  try {
    answer = await inviteWrite(token, ac, "DELETE", "/api/people?" + new URLSearchParams({ name: target.name }));
  } finally {
    clearTimeout(deadline);
  }
  if (tokenGen !== tokenGeneration) return;
  removing = undefined;
  removeYes.disabled = false;
  if (answer.status === 401) return ask("The server refused that token. Enter another.");
  // Their direct messages are deleted (200), were deleted by whoever removed them first (404), or may be (no answer),
  // so the messages the page holds are read again from the start, as deletePair does, since GET /api/messages pages by
  // offset; this holds whichever view is open now.
  const forgot = answer.status === 200 || answer.status === 404 || Boolean(answer.error);
  if (forgot) forgetMessagesOf(target.name, answer.status === 200 || answer.status === 404);
  if (closings !== inviteClosings) {
    // The poll in flight may still read from the old offset, so a new one starts.
    if (forgot) refresh();
    return;
  }
  if (answer.status === 403) return unmarked();
  // A confirmation opened for another person meanwhile stays.
  if (removeTarget === target) closeRemovePerson(true);
  const name = target.name;
  const body = answer.body;
  if (answer.status === 200) {
    peopleNote.textContent =
      body && Number.isInteger(body.messages) && Number.isInteger(body.mentions)
        ? "Removed " + name + ": " + counted(body.messages, "message") + " and " + counted(body.mentions, "mention") + " deleted."
        : "Removed " + name + ".";
  } else if (answer.status === 404) peopleNote.textContent = name + " is already gone (404).";
  else if (answer.error) peopleNote.textContent = answer.error + ", so " + name + " may have been removed: the list below shows whether.";
  else peopleNote.textContent = refusal(answer);
  if (answer.status === 200 || answer.status === 404 || answer.error) refresh();
}

// Asks above the list before removing a webhook; nothing is sent until its "Remove webhook" is pressed.
function openRemoveWebhook(hook) {
  if (!meAdmin || !openWebhooks) return;
  webhookTarget = hook;
  webhookNote.textContent = "";
  webhookText.textContent =
    "Remove webhook " + hook.id + " (" + hook.on + ")? Its queued and past deliveries go with it. This cannot be undone.";
  webhookConfirm.hidden = false;
  webhookYes.disabled = removingWebhook === tokenGeneration;
  document.getElementById("webhook-no").focus();
}

// Dismisses the webhook's confirmation; when the reader dismissed it, or it was answered, the focus goes to the view's
// Close button, as the row may be gone.
function closeRemoveWebhook(refocus) {
  webhookConfirm.hidden = true;
  webhookText.textContent = "";
  webhookTarget = undefined;
  if (refocus) document.getElementById("close-log").focus();
}

// Removes the webhook being asked about with DELETE /api/webhooks and says what it ended from the answer, then reads the
// list again, as cancelInvite does. Unlike cancelInvite, a 403, which means the token's person is no longer an admin,
// unmarks them whatever is open now, as a 401 asks for another token; any other answer after the view closed, or any
// answer after the token was forgotten, changes nothing.
async function removeWebhook() {
  const token = sessionStorage.getItem(KEY);
  if (!token) return ask();
  const tokenGen = tokenGeneration;
  const hook = webhookTarget;
  if (!meAdmin || !openWebhooks || !hook || removingWebhook === tokenGen) return;
  removingWebhook = tokenGen;
  removingHook = hook;
  const closings = webhookClosings;
  webhookYes.disabled = true;
  const ac = new AbortController();
  const deadline = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let answer;
  try {
    answer = await inviteWrite(token, ac, "DELETE", "/api/webhooks?" + new URLSearchParams({ id: String(hook.id) }));
  } finally {
    clearTimeout(deadline);
  }
  if (tokenGen !== tokenGeneration) return;
  removingWebhook = undefined;
  removingHook = undefined;
  webhookYes.disabled = false;
  if (answer.status === 401) return ask("The server refused that token. Enter another.");
  if (answer.status === 403) return unmarked();
  if (closings !== webhookClosings) return;
  // A confirmation opened for another webhook meanwhile stays.
  if (webhookTarget === hook) closeRemoveWebhook(true);
  const body = answer.body;
  if (answer.status === 200) {
    webhookNote.textContent =
      body && Number.isInteger(body.deliveries)
        ? "Removed webhook " + hook.id + " and its " + (body.deliveries === 1 ? "1 delivery" : body.deliveries + " deliveries") + "."
        : "Removed webhook " + hook.id + ".";
  } else if (answer.status === 404) webhookNote.textContent = "Webhook " + hook.id + " was already gone (404).";
  else if (answer.error) webhookNote.textContent = answer.error + ", so webhook " + hook.id + " may have been removed: the list below shows whether.";
  else webhookNote.textContent = refusal(answer);
  if (answer.status === 200 || answer.status === 404 || answer.error) refresh();
}

// Adds a webhook to the account with POST /api/webhooks from the "Add a webhook" form, and shows the secret from the
// answer once, in the view's read-only field, with a Copy button, as resetKey shows a key. It sends url, on and
// includeText, and header, maxPerHour and body only when filled in; the URL and the event are checked by the server
// alone. Nothing is sent without a URL and an event, and Add stays disabled while the request is in flight. A 403
// unmarks the person whatever is open now, as removeWebhook's does, and a 401 asks for another token; any other answer
// after the view closed, or any answer after the token was forgotten, changes nothing and shows no secret.
async function addAccountWebhook() {
  const token = sessionStorage.getItem(KEY);
  if (!token) return ask();
  const tokenGen = tokenGeneration;
  if (!meAdmin || !openWebhooks || addingWebhook === tokenGen) return;
  const url = hookUrl.value.trim();
  const on = hookOn.value.trim();
  if (url === "" || on === "") {
    hookNote.textContent = url === "" ? "Enter the URL to deliver to." : "Enter what it fires on.";
    return;
  }
  const body = { url, on, includeText: hookIncludeText.checked };
  const headerName = hookHeaderName.value.trim();
  const headerValue = hookHeaderValue.value;
  // The server splits the header at its first colon, so a colon in the name would move part of it into the value.
  if (headerName.includes(":")) {
    hookNote.textContent = "A header name has no colon: put the name alone in Header name, and the rest in Header value.";
    return;
  }
  // Either half given sends the header, so the server refuses one left half filled in rather than it being dropped.
  if (headerName !== "" || headerValue !== "") body.header = headerName + ": " + headerValue;
  if (hookMax.value.trim() !== "") body.maxPerHour = Number(hookMax.value);
  if (hookBody.value !== "") body.body = hookBody.value;
  addingWebhook = tokenGen;
  const closings = webhookClosings;
  hookAdd.disabled = true;
  hookNote.textContent = "Adding…";
  const ac = new AbortController();
  const deadline = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let answer;
  try {
    answer = await inviteWrite(token, ac, "POST", "/api/webhooks", body);
  } finally {
    clearTimeout(deadline);
  }
  if (tokenGen !== tokenGeneration) return;
  addingWebhook = undefined;
  hookAdd.disabled = false;
  if (answer.status === 401) return ask("The server refused that token. Enter another.");
  if (answer.status === 403) return unmarked();
  if (closings !== webhookClosings) return;
  if (answer.status === 200) {
    const added = answer.body;
    // Only the fields that held what the server keeps private are emptied, and only while they still hold what was sent,
    // so text typed while the request was in flight stays; the event and the rest stay for the next one.
    if (hookUrl.value.trim() === url) hookUrl.value = "";
    if (hookHeaderValue.value === headerValue) hookHeaderValue.value = "";
    if (hookBody.value === body.body) hookBody.value = "";
    // Another webhook was added, so the secret shown before is no longer the newest, even when this one's cannot be read.
    hideWebhookSecret();
    if (added && typeof added === "object" && typeof added.secret === "string" && added.secret !== "" && Number.isInteger(added.id)) {
      hookNote.textContent = "Added webhook " + added.id + (typeof added.on === "string" ? " (" + added.on + ")" : "") + ".";
      webhookFor.textContent =
        "Webhook " + added.id + "'s secret. It signs each delivery (X-Message-CP-Signature); check it before trusting one. " +
        "It shows only here, until you leave this view or add another, and is never shown again.";
      webhookSecret.value = added.secret;
      webhookCopyNote.textContent = "";
      webhookMade.hidden = false;
      webhookSecret.focus();
    } else {
      hookNote.textContent = "A webhook was added, but this page cannot read its secret: remove it from the list below and add it again.";
    }
    refresh();
    return;
  }
  if (answer.error) {
    // Another webhook may have been added, so the secret shown before may no longer be the newest.
    hideWebhookSecret();
    hookNote.textContent =
      answer.error + ", so the webhook may or may not have been added: the list below shows whether. " +
      "No secret can be shown for it, so if it is listed, remove it and add it again.";
    refresh();
    return;
  }
  hookNote.textContent = refusal(answer);
}

// Hides the secret the "Webhooks" view showed for the webhook added before.
function hideWebhookSecret() {
  webhookMade.hidden = true;
  webhookFor.textContent = "";
  webhookSecret.value = "";
  webhookCopyNote.textContent = "";
}

// Copies the shown secret to the clipboard; where the browser refuses, selects it to copy by hand, as copyInvite does.
async function copyWebhookSecret() {
  const secret = webhookSecret.value;
  if (!secret) return;
  const closings = webhookClosings;
  let copied = false;
  try {
    await navigator.clipboard.writeText(secret);
    copied = true;
  } catch {
    copied = false;
  }
  if (closings !== webhookClosings || webhookSecret.value !== secret) return;
  if (!copied) {
    webhookSecret.focus();
    webhookSecret.select();
  }
  webhookCopyNote.textContent = copied ? "Copied." : "This browser did not copy it: the secret is selected, so copy it yourself.";
}

// Asks above the list before revoking an approved client; nothing is sent until its "Revoke client" is pressed.
function openRevokeApproval(target) {
  if (!meAdmin || !openApprovals) return;
  approvalTarget = target;
  approvalNote.textContent = "";
  approvalText.textContent =
    "Revoke token " + target.id + " (" + target.client + ")" +
    (target.agent === undefined
      ? ", which registers its own agents? Sessions of its agents that use it stop at their next request."
      : ", approved as " + target.agent + "? Sessions of " + target.agent + " that use it stop at their next request.") +
    " This cannot be undone.";
  approvalConfirm.hidden = false;
  approvalYes.disabled = revokingApproval === tokenGeneration;
  document.getElementById("approval-no").focus();
}

// Dismisses the approval's confirmation; when the reader dismissed it, or it was answered, the focus goes to the view's
// Close button, as the row may be gone.
function closeRevokeApproval(refocus) {
  approvalConfirm.hidden = true;
  approvalText.textContent = "";
  approvalTarget = undefined;
  if (refocus) document.getElementById("close-log").focus();
}

// Revokes the approval being asked about with DELETE /api/approvals and says what it ended from the answer, then, after a
// 200, a 404 or no answer, reads the list again, as removeWebhook does: a 403, which means the token's person is no longer an admin, unmarks them
// whatever is open now, as a 401 asks for another token; any other answer after the view closed, or any answer after the
// token was forgotten, changes nothing.
async function revokeApproval() {
  const token = sessionStorage.getItem(KEY);
  if (!token) return ask();
  const tokenGen = tokenGeneration;
  const target = approvalTarget;
  if (!meAdmin || !openApprovals || !target || revokingApproval === tokenGen) return;
  revokingApproval = tokenGen;
  revokingTarget = target;
  const closings = approvalClosings;
  approvalYes.disabled = true;
  const ac = new AbortController();
  const deadline = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let answer;
  try {
    answer = await inviteWrite(token, ac, "DELETE", "/api/approvals?" + new URLSearchParams({ id: String(target.id) }));
  } finally {
    clearTimeout(deadline);
  }
  if (tokenGen !== tokenGeneration) return;
  revokingApproval = undefined;
  revokingTarget = undefined;
  approvalYes.disabled = false;
  if (answer.status === 401) return ask("The server refused that token. Enter another.");
  if (answer.status === 403) return unmarked();
  if (closings !== approvalClosings) return;
  // A confirmation opened for another approval meanwhile stays.
  if (approvalTarget === target) closeRevokeApproval(true);
  const named = "token " + target.id + " (" + target.client + ")";
  if (answer.status === 200) approvalNote.textContent = "Revoked " + named + ".";
  else if (answer.status === 404) approvalNote.textContent = "Token " + target.id + " (" + target.client + ") was already revoked or gone (404).";
  else if (answer.error) approvalNote.textContent = answer.error + ", so " + named + " may have been revoked: the list below shows whether.";
  else approvalNote.textContent = refusal(answer);
  if (answer.status === 200 || answer.status === 404 || answer.error) refresh();
}

// Asks above the list before revoking a token; nothing is sent until its "Revoke token" is pressed. For a person token of
// the page's own person, it says this may be the token this browser is signed in with: the API does not say which
// token a request carries.
function openRevokeToken(target) {
  if (!meAdmin || !openTokens) return;
  tokenTarget = target;
  tokenNote.textContent = "";
  tokenText.textContent =
    "Revoke token " + target.id + " (" + target.label + ")? This cannot be undone, and a request already running with it may finish." +
    (target.mine ? " It may be the token this browser is signed in with: revoking it signs this page out at its next request." : "");
  tokenConfirm.hidden = false;
  tokenYes.disabled = revokingToken === tokenGeneration;
  document.getElementById("token-no").focus();
}

// Dismisses the token's confirmation; when the reader dismissed it, or it was answered, the focus goes to the view's
// Close button, as the row may be gone.
function closeRevokeToken(refocus) {
  tokenConfirm.hidden = true;
  tokenText.textContent = "";
  tokenTarget = undefined;
  if (refocus) document.getElementById("close-log").focus();
}

// Revokes the token being asked about with DELETE /api/tokens and says what it ended from the answer, then reads the
// list again, as removeWebhook does: a 401 asks for another token and a 403 unmarks the person whatever is open now; any
// other answer after the view closed, or any answer after the token was forgotten, changes nothing.
async function revokeToken() {
  const token = sessionStorage.getItem(KEY);
  if (!token) return ask();
  const tokenGen = tokenGeneration;
  const target = tokenTarget;
  if (!meAdmin || !openTokens || !target || revokingToken === tokenGen) return;
  revokingToken = tokenGen;
  revokingTokenTarget = target;
  const closings = tokenClosings;
  tokenYes.disabled = true;
  const ac = new AbortController();
  const deadline = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let answer;
  try {
    answer = await inviteWrite(token, ac, "DELETE", "/api/tokens?" + new URLSearchParams({ id: String(target.id) }));
  } finally {
    clearTimeout(deadline);
  }
  if (tokenGen !== tokenGeneration) return;
  revokingToken = undefined;
  revokingTokenTarget = undefined;
  tokenYes.disabled = false;
  if (answer.status === 401) return ask("The server refused that token. Enter another.");
  if (answer.status === 403) return unmarked();
  if (closings !== tokenClosings) return;
  // A confirmation opened for another token meanwhile stays.
  if (tokenTarget === target) closeRevokeToken(true);
  if (answer.status === 200) tokenNote.textContent = "Revoked token " + target.id + " (" + target.label + ").";
  else if (answer.status === 404) tokenNote.textContent = "Token " + target.id + " was already revoked or gone (404).";
  else if (answer.error) tokenNote.textContent = answer.error + ", so token " + target.id + " may or may not have been revoked: the list below shows which.";
  else tokenNote.textContent = refusal(answer);
  if (answer.status === 200 || answer.status === 404 || answer.error) refresh();
}

// What to do about a token this page may have made but cannot show. Nothing in GET /api/tokens ties an entry to the
// request that made it, and another tab, another admin or the server's shell may have made a newer one of the same kind
// for a client in use, so it never points at an entry by recency, kind or maker.
function unshownTokenAdvice(kind) {
  return " The list below cannot show which " + kind + " token this attempt made, so revoke one there only if you know it is that one, then make another.";
}

// Empties the made token's field and its line, and hides them.
function dropMadeToken() {
  tokenMade.hidden = true;
  tokenFor.textContent = "";
  tokenValue.value = "";
  tokenCopyNote.textContent = "";
}

// Makes an unbound read-only or agent token with POST /api/tokens, sending only { kind }, and shows the token from the
// answer once, in the view's read-only field, with a Copy button; Make token stays disabled while the request is in
// flight. A 401 asks for another token and a 403 unmarks the person whatever is open now. An answer after the token was
// forgotten changes nothing; one after the view closed or was unmarked shows no token, and a 200 or no answer then says
// in tokenNote, where nothing newer is shown, that a token was or may have been made.
async function makeToken() {
  const token = sessionStorage.getItem(KEY);
  if (!token) return ask();
  const tokenGen = tokenGeneration;
  if (!meAdmin || !openTokens || makingToken === tokenGen) return;
  const kind = tokenKind.value === "agent" ? "agent" : "read-only";
  makingToken = tokenGen;
  const closings = tokenClosings;
  tokenMake.disabled = true;
  // A token an earlier answer showed goes, so it is never taken for the one this request makes.
  dropMadeToken();
  tokenMakeNote.textContent = "Making a token…";
  const ac = new AbortController();
  const deadline = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let answer;
  try {
    answer = await inviteWrite(token, ac, "POST", "/api/tokens", { kind });
  } finally {
    clearTimeout(deadline);
  }
  if (tokenGen !== tokenGeneration) return;
  makingToken = undefined;
  tokenMake.disabled = false;
  if (answer.status === 401) return ask("The server refused that token. Enter another.");
  if (answer.status === 403) return unmarked();
  if (closings !== tokenClosings) {
    // The view closed or was unmarked while the server may have made the token, which this answer's token is never
    // shown for: say so in a Tokens view open again, or still open unmarked, where nothing newer is shown.
    const named = kind === "agent" ? "an agent token" : "a read-only token";
    const then = meAdmin ? unshownTokenAdvice(kind) : "";
    if (openTokens && tokenNote.textContent === "" && answer.status === 200) {
      tokenNote.textContent = "This page made " + named + ", but its answer came after the view it was made from closed or changed, so it is not shown and never will be." + then;
    } else if (openTokens && tokenNote.textContent === "" && answer.error) {
      tokenNote.textContent = answer.error + ", so " + named + " may or may not have been made, and no token can be shown for it." + then;
    }
    if (answer.status === 200 || answer.error) refresh();
    return;
  }
  if (answer.status === 200) {
    const body = answer.body;
    dropMadeToken();
    if (body && typeof body === "object" && typeof body.token === "string" && body.token !== "") {
      tokenMakeNote.textContent = "";
      tokenFor.textContent =
        "New " + kind + " token" + (Number.isInteger(body.id) ? " " + body.id : "") +
        (kind === "agent" ? ", bound to no agent, so a client using it must still name its agent." : ".") +
        " It shows only here, at most until you leave this view, and is never shown again.";
      tokenValue.value = body.token;
      tokenMade.hidden = false;
      tokenValue.focus();
    } else {
      tokenMakeNote.textContent = "A token may have been made, but this page cannot show it." + unshownTokenAdvice(kind);
    }
    refresh();
    return;
  }
  if (answer.error) {
    tokenMakeNote.textContent =
      answer.error + ", so a token may or may not have been made, and no token can be shown for it." + unshownTokenAdvice(kind);
    refresh();
    return;
  }
  tokenMakeNote.textContent = refusal(answer);
}

// Copies the made token to the clipboard; where the browser refuses, selects it to copy by hand, as copyAgentKey does.
async function copyToken() {
  const made = tokenValue.value;
  if (!made) return;
  const closings = tokenClosings;
  let copied = false;
  try {
    await navigator.clipboard.writeText(made);
    copied = true;
  } catch {
    copied = false;
  }
  if (closings !== tokenClosings || tokenValue.value !== made) return;
  if (!copied) {
    tokenValue.focus();
    tokenValue.select();
  }
  tokenCopyNote.textContent = copied ? "Copied." : "This browser did not copy it: the token is selected, so copy it yourself.";
}

// Asks under the agents panel's heading before removing the agent name or resetting its key (kind "remove" or "key");
// nothing is sent until its button is pressed. Any confirmation, note or key shown before goes.
function openAgentConfirm(kind, name) {
  if (!meAdmin) return;
  closeAgentPanel();
  agentFor = { kind, name };
  agentConfirmText.textContent =
    kind === "remove"
      ? "Remove " + name + "? This cannot be undone: it deletes " + name + "'s direct messages and mentions. Its channel posts stay."
      : "Reset " + name + "'s key? Its old key stops working at once and its sessions end. A token message-cp connect made for it keeps working until it is revoked.";
  agentYes.textContent = kind === "remove" ? "Remove" : "Reset key";
  agentYes.disabled = (kind === "remove" ? removingAgent : resettingKey) === tokenGeneration;
  agentConfirm.hidden = false;
  document.getElementById("agent-no").focus();
}

// Ends what the agents panel shows for an agent: its confirmation, its note and any new key, which is emptied from its
// field. When the reader closed it, the focus goes to the panel's heading, as the button they pressed is hidden.
function closeAgentPanel(refocus) {
  agentFor = undefined;
  agentConfirm.hidden = true;
  agentConfirmText.textContent = "";
  agentNote.textContent = "";
  agentKeyMade.hidden = true;
  agentKeyFor.textContent = "";
  agentKey.value = "";
  agentCopyNote.textContent = "";
  if (refocus) agentsHead.focus();
}

// Removes the agent being asked about with DELETE /api/agents and says what it ended from the answer's counts, then
// reads the agents again, as removeAccountPerson does for a person. After a 200, 404 or no answer it also reads the
// account's messages again from the start (forgetMessagesOf), even if the panel has moved on to another agent since;
// any other answer after that, or any answer after the token was forgotten, changes nothing.
async function removeAgent() {
  const token = sessionStorage.getItem(KEY);
  if (!token) return ask();
  const tokenGen = tokenGeneration;
  const target = agentFor;
  if (!meAdmin || target?.kind !== "remove" || removingAgent === tokenGen) return;
  removingAgent = tokenGen;
  agentYes.disabled = true;
  agentNote.textContent = "Removing " + target.name + "…";
  const ac = new AbortController();
  const deadline = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let answer;
  try {
    answer = await inviteWrite(token, ac, "DELETE", "/api/agents?" + new URLSearchParams({ name: target.name }));
  } finally {
    clearTimeout(deadline);
  }
  if (tokenGen !== tokenGeneration) return;
  removingAgent = undefined;
  agentYes.disabled = agentFor?.kind === "key" && resettingKey === tokenGen;
  if (answer.status === 401) return ask("The server refused that token. Enter another.");
  // Its direct messages are deleted (200), were deleted by whoever removed it first (404), or may be (no answer), so
  // the messages the page holds are read again from the start, as removeAccountPerson does.
  const forgot = answer.status === 200 || answer.status === 404 || Boolean(answer.error);
  if (forgot) forgetMessagesOf(target.name, answer.status === 200 || answer.status === 404);
  // A 403 says the token's person is no longer an admin, whatever the panel shows now.
  if (answer.status === 403) {
    const still = agentFor === target;
    unmarked();
    if (still) {
      agentNote.textContent = NOT_ADMIN_AGENTS;
      agentsHead.focus();
    }
    return;
  }
  if (agentFor !== target) {
    if (forgot) refresh();
    return;
  }
  agentConfirm.hidden = true;
  agentConfirmText.textContent = "";
  agentsHead.focus();
  const name = target.name;
  const body = answer.body;
  if (answer.status === 200) {
    agentNote.textContent =
      body && Number.isInteger(body.messages) && Number.isInteger(body.mentions)
        ? "Removed " + name + ": " + counted(body.messages, "message") + " and " + counted(body.mentions, "mention") + " deleted."
        : "Removed " + name + ".";
  } else if (answer.status === 404) agentNote.textContent = name + " is already gone (404).";
  else if (answer.error) agentNote.textContent = answer.error + ", so " + name + " may have been removed: the list shows whether.";
  else agentNote.textContent = refusal(answer);
  if (forgot) refresh();
}

// Gives the agent being asked about a new key with POST /api/agents/key and shows the key from the answer once, in the
// panel's read-only field, with a Copy button. An answer after the panel moved on to another agent, or was closed, or
// after the token was forgotten, shows no key; where the panel was closed and nothing newer shows, a 200 or no answer
// says the key was or may have been reset.
async function resetKey() {
  const token = sessionStorage.getItem(KEY);
  if (!token) return ask();
  const tokenGen = tokenGeneration;
  const target = agentFor;
  if (!meAdmin || target?.kind !== "key" || resettingKey === tokenGen) return;
  resettingKey = tokenGen;
  agentYes.disabled = true;
  agentNote.textContent = "Resetting " + target.name + "'s key…";
  const ac = new AbortController();
  const deadline = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let answer;
  try {
    answer = await inviteWrite(token, ac, "POST", "/api/agents/key?" + new URLSearchParams({ name: target.name }));
  } finally {
    clearTimeout(deadline);
  }
  if (tokenGen !== tokenGeneration) return;
  resettingKey = undefined;
  agentYes.disabled = agentFor?.kind === "remove" && removingAgent === tokenGen;
  if (answer.status === 401) return ask("The server refused that token. Enter another.");
  if (answer.status === 403) {
    const still = agentFor === target;
    unmarked();
    if (still) {
      agentNote.textContent = NOT_ADMIN_AGENTS;
      agentsHead.focus();
    }
    return;
  }
  const name = target.name;
  if (agentFor !== target) {
    // The panel moved on (Cancel, another agent, or the details closed) while the server may have reset the key: say so
    // where nothing newer is shown, as the key this answer carries is not shown now.
    if (answer.status === 200 && agentFor === undefined) {
      agentNote.textContent = name + "'s key was reset, but this page closed it before showing the new one: reset it again for a key you can see.";
    } else if (answer.error && agentFor === undefined) {
      agentNote.textContent = answer.error + ", so " + name + "'s key may have been reset, and this page has no new key to show: reset it again for one.";
    }
    if (answer.status === 200 || answer.error) refresh();
    return;
  }
  agentConfirm.hidden = true;
  agentConfirmText.textContent = "";
  agentsHead.focus();
  if (answer.status === 200) {
    const body = answer.body;
    if (body && typeof body.key === "string" && body.key !== "") {
      agentNote.textContent = "";
      agentKeyFor.textContent =
        name + "'s new key. Its old key no longer works. Give this one to " + name + "'s client; it shows only here, until you press Done or close " + name + "'s details.";
      agentKey.value = body.key;
      agentKeyMade.hidden = false;
      agentKey.focus();
    } else agentNote.textContent = name + "'s key was reset, but this page cannot read the new one: reset it again.";
  } else if (answer.status === 404) agentNote.textContent = name + " is already gone (404).";
  else if (answer.error) agentNote.textContent = answer.error + ", so " + name + "'s key may have been reset, and this page has no new key to show: reset it again for one.";
  else agentNote.textContent = refusal(answer);
  if (answer.status === 200 || answer.status === 404 || answer.error) refresh();
}

// Copies the shown key to the clipboard; where the browser refuses, selects it to copy by hand, as copyInvite does.
async function copyAgentKey() {
  const target = agentFor;
  if (!target || !agentKey.value) return;
  let copied = false;
  try {
    await navigator.clipboard.writeText(agentKey.value);
    copied = true;
  } catch {
    copied = false;
  }
  if (agentFor !== target || !agentKey.value) return;
  if (!copied) {
    agentKey.focus();
    agentKey.select();
  }
  agentCopyNote.textContent = copied ? "Copied." : "This browser did not copy it: the key is selected, so copy it yourself.";
}

// Drops the search in flight and empties the results.
function closeResults() {
  searchGeneration++;
  if (searchController) searchController.abort();
  resultRows.replaceChildren();
  resultMentions = [];
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
  panel("");
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
  signoutRetry.hidden = true;
  form.hidden = true;
  view.hidden = false;
  say("Loading…", false);
  checkToken();
  poll(generation);
}

// Asks GET /api/token once whether this token is read-only or agent-only, and whose person token it is. Only an answer
// of readOnly and agentOnly both false with a person in it lets the page post, as that person only; both false with no
// person is a full token, which may delete but not post. A read-only token, a failure or an answer this page cannot
// read leaves the page read-only. An agent token, which the server refuses on every other /api path, is forgotten and
// another asked for.
const AGENT_TOKEN = "That is an agent token, and agent tokens cannot use the dashboard. Enter a full, read-only or person token.";
async function checkToken() {
  const token = sessionStorage.getItem(KEY);
  if (!token) return;
  const gen = tokenGeneration;
  const ac = new AbortController();
  tokenController = ac;
  const deadline = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let full = false;
  let own;
  let admin = false;
  let refused = false;
  let agent = false;
  let readOnly = false;
  try {
    const res = await fetch("/api/token", {
      headers: { Authorization: "Bearer " + token },
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: ac.signal,
    });
    refused = res.status === 401;
    if (res.ok) {
      const answer = await res.json();
      full = answer.readOnly === false && answer.agentOnly === false;
      own = full && typeof answer.person === "string" ? answer.person : undefined;
      admin = own !== undefined && answer.admin === true;
      agent = answer.agentOnly === true;
      readOnly = answer.readOnly === true;
    }
  } catch {
    full = false;
    own = undefined;
    admin = false;
  } finally {
    clearTimeout(deadline);
  }
  if (gen !== tokenGeneration) return;
  if (refused) return ask("The server refused that token. Enter another.");
  if (agent) return ask(AGENT_TOKEN);
  // A full or person token also signs this browser in to the approval page: the server sets the sign-in cookie, which no
  // page script can read, from the token in the header. A server without an https public URL answers 404, and one reached
  // at another address than its public URL 403; the page carries on as before either way.
  // A read-only token clears any sign-in an earlier token left; a failure or an answer this page cannot read changes none.
  // A queued sign-in is not sent once this token is forgotten.
  if (full) {
    signinsPending++;
    signing = signing.then(() => (gen === tokenGeneration ? signin({ method: "POST", headers: { Authorization: "Bearer " + token } }) : true)).then((ok) => {
      signinsPending--;
      return ok;
    });
  } else if (readOnly) signout();
  canPost = own !== undefined;
  me = own;
  meAdmin = admin;
  fullToken = full && own === undefined;
  showInviteEntry();
  showWebhookEntry();
  showTokenEntry();
  // An admin person's agent and Revoke buttons show at once, not only from the next poll.
  if (lastAgents) show(lastAgents);
  if (openApprovals) drawApprovals(shownApprovals);
  showPicker();
  fillNew();
  fillChannel();
  showNewButton();
}

// Redeems a login link's code once with POST /api/login, which takes no token, for a new full or person token, kept and
// started with as a pasted one is. Any token the tab held is forgotten first, and the token form shows while the request
// is in flight; a token submitted or forgotten meanwhile wins, so the answer is dropped. A used, cancelled, expired or
// unknown code, or no answer, leaves the form with the reason.
const LINK_USED = "This link was already used. Make a new one on the server or ask an admin, or enter a token.";
const LINK_INVALID = "This link has expired or is not valid. Make a new one on the server or ask an admin, or enter a token.";
const LINK_CANCELLED = "This link was cancelled. Ask an admin for a new one, or enter a token.";
async function login(code) {
  ask();
  say("Signing in with the link…", false);
  const gen = tokenGeneration;
  // A pasted token's start() and a forgotten token's ask() both call cancel(), which bumps generation.
  const pollGen = generation;
  const ac = new AbortController();
  tokenController = ac;
  const deadline = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let answer;
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: ac.signal,
    });
    const body = await res.json().catch(() => ({}));
    answer = { status: res.status, token: body && body.token, reason: body && body.reason };
  } catch {
    answer = {};
  } finally {
    clearTimeout(deadline);
  }
  if (gen !== tokenGeneration || pollGen !== generation) return;
  if (answer.status === 200 && typeof answer.token === "string" && answer.token) {
    sessionStorage.setItem(KEY, answer.token);
    return start();
  }
  if (answer.reason === "used") return ask(LINK_USED);
  if (answer.reason === "invalid") return ask(LINK_INVALID);
  if (answer.reason === "cancelled") return ask(LINK_CANCELLED);
  if (answer.status === 503) return ask("The server is busy (503), so the link was not used. Open it again in a moment.");
  ask(answer.status === undefined ? "No answer from the server, so the link may have been used. Make a new one on the server, or enter a token." : "The server answered " + answer.status + ". Make a new link on the server, or enter a token.");
}

// The people the page may post and send as: a person token's person, while GET /api/agents lists them; else no one.
// Undefined until GET /api/agents has answered.
function senders() {
  if (people === undefined) return people;
  return people.filter((name) => name === me);
}

// What the "New message" and "New channel" forms, which only a person token opens, say when its person is gone.
function noSenders() {
  return me + " is no longer a person in this account.";
}

// Shows the "New message" and "New channel" buttons only with a token that may post, and closes their forms without one.
function showNewButton() {
  newButton.hidden = !canPost;
  channelButton.hidden = !canPost;
  if (!canPost) {
    closeNew(false);
    closeChannelForm(false);
  }
  showDelete();
  // The empty notes that name these buttons follow them at once rather than on the next poll.
  if (noChannels) noChannels.textContent = channelsEmpty();
  // Both of the direct messages' empty texts start with NO_MESSAGES; any other note is left as it is.
  if (messagesNote.textContent.startsWith(NO_MESSAGES)) messagesNote.textContent = messagesEmpty();
}

// What an empty channel list and an empty direct messages list say, naming "New channel" or "New message" only when
// that button shows.
function channelsEmpty() {
  return NO_CHANNELS + (canPost ? NO_CHANNELS_FULL : "");
}
function messagesEmpty() {
  return NO_MESSAGES + (canPost ? NO_MESSAGES_FULL : "");
}

function openNew() {
  if (!canPost) return;
  // Only one of "New message" and "New channel" is open at a time.
  closeChannelForm(false);
  newForm.hidden = false;
  newButton.setAttribute("aria-expanded", "true");
  fillNew();
  // The From select starts at the token's person while they are listed.
  if (person !== undefined && senders()?.includes(person)) {
    newFrom.value = person;
    fillNew();
  }
  if (!newFields.hidden) (person !== undefined ? newTo : newFrom).focus();
}

// Closes the "New message" form, giving the focus back to its button when the reader closed it.
function closeNew(refocus) {
  if (newForm.hidden) return;
  newForm.hidden = true;
  newButton.setAttribute("aria-expanded", "false");
  if (refocus) newButton.focus();
}

// Builds the "New message" form's selects from the last GET /api/agents, for a person token only: From lists its person,
// already chosen, while senders gives them, and To the account's agents and people, each person marked as one, without
// "all" or the From name, compared without case. Each select keeps its choice while that name is still listed, and is
// rebuilt only when its list changes. When the chosen name goes, the select falls back to its empty first option (for
// From, its form says the person is gone) rather than another name, so a refresh never retargets it.
function fillNew() {
  // Only a person token opens the form; ask() has emptied it for any other.
  if (!canPost) return;
  const listed = senders();
  const known = listed ?? [];
  const none = listed !== undefined && known.length === 0;
  newNote.textContent = none ? noSenders() : "";
  newFields.hidden = none;
  newOpen.hidden = none;
  const fromNow = JSON.stringify([me ?? null, known]);
  if (fromNow !== fromKey) {
    fromKey = fromNow;
    const chosen = newFrom.value;
    newFrom.replaceChildren(...fromOptions(known));
    newFrom.value = known.includes(chosen) ? chosen : me !== undefined && known.includes(me) ? me : "";
  }
  const from = known.includes(newFrom.value) ? newFrom.value.toLowerCase() : undefined;
  const to = mentionable.filter((n) => {
    const lower = n.name.toLowerCase();
    return lower !== "all" && lower !== from;
  });
  const toNow = JSON.stringify([from, to]);
  if (toNow !== toKey) {
    toKey = toNow;
    const chosen = newTo.value;
    newTo.replaceChildren(choose("Choose a recipient"), ...to.map((n) => {
      const option = document.createElement("option");
      option.value = n.name;
      option.textContent = n.person ? n.name + " (person)" : n.name;
      return option;
    }));
    newTo.value = to.some((n) => n.name === chosen) ? chosen : "";
  }
  newOpen.disabled = to.length === 0;
}

function openChannelForm() {
  if (!canPost) return;
  closeNew(false);
  channelForm.hidden = false;
  channelButton.setAttribute("aria-expanded", "true");
  fillChannel();
  // From starts at the token's person while they are listed, as in "New message".
  if (person !== undefined && senders()?.includes(person)) channelFrom.value = person;
  if (!channelFields.hidden) (channelFrom.value !== "" ? channelName : channelFrom).focus();
}

// Closes the "New channel" form, keeping what was typed in it, and gives the focus back to its button when the reader
// closed it.
function closeChannelForm(refocus) {
  if (channelForm.hidden) return;
  channelForm.hidden = true;
  channelClosings++;
  channelButton.setAttribute("aria-expanded", "false");
  if (refocus) channelButton.focus();
}

// Builds the "New channel" form's From select from the token's person, as fillNew builds "New message"'s, or says the
// person is gone when GET /api/agents no longer lists them. A note left by a submit stays until the next submit.
function fillChannel() {
  if (!canPost) return;
  const listed = senders();
  const known = listed ?? [];
  const none = listed !== undefined && known.length === 0;
  const empty = noSenders();
  if (none) channelNote.textContent = empty;
  else if (channelNote.textContent === empty) channelNote.textContent = "";
  channelFields.hidden = none;
  channelCreate.hidden = none;
  const fromNow = JSON.stringify([me ?? null, known]);
  if (fromNow !== channelFromKey) {
    channelFromKey = fromNow;
    const chosen = channelFrom.value;
    channelFrom.replaceChildren(...fromOptions(known));
    channelFrom.value = known.includes(chosen) ? chosen : me !== undefined && known.includes(me) ? me : "";
  }
}

// A From select's options: the token's person while they are listed, so there is nothing else to choose, else only the
// empty "Choose a person".
function fromOptions(known) {
  const options = known.map((name) => {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    return option;
  });
  return me !== undefined && known.length > 0 ? options : [choose("Choose a person"), ...options];
}

// Why the "New channel" form cannot create a channel from what it holds, or undefined if it can.
function channelProblem(from, name, body) {
  if (!CHANNEL_NAME.test(name)) return "A channel name is 1 to 32 letters, digits, - or _.";
  if (channelNames === undefined) return "The channel list has not loaded yet. Try again in a moment.";
  if (channelNames.includes(name.toLowerCase()) || channelsSent.has(name.toLowerCase())) return "#" + name + " already exists. Open it from the channel list to post in it.";
  if (!senders()?.includes(from)) return "Choose who you are under From.";
  if (body.trim() === "") return "Write a first post.";
  // The server counts characters as code points, as send() does.
  if ([...body].length > ${MAX_BODY_LENGTH}) return "The first post is longer than ${MAX_BODY_LENGTH} characters.";
  return undefined;
}

// Creates a channel by posting its first post with POST /api/post as the chosen person, then opens it as choosing it
// in the sidebar does, under the name the server stored it as, posting there as that person. Nothing is sent
// unless channelProblem finds nothing, and Create stays disabled while the request is in flight. A 200 that comes after
// the form was closed opens nothing. Any other answer keeps the text and says why in the form's note; with no answer the
// post may have been stored, so the name is refused until the token is forgotten (channelsSent). An answer that comes
// after the token was forgotten is dropped.
async function createChannel() {
  const token = sessionStorage.getItem(KEY);
  if (!token) return ask();
  const tokenGen = tokenGeneration;
  if (!canPost || channelForm.hidden || creating === tokenGen) return;
  const from = channelFrom.value;
  const name = channelName.value;
  const body = channelBody.value;
  const problem = channelProblem(from, name, body);
  if (problem !== undefined) {
    channelNote.textContent = problem;
    return;
  }
  creating = tokenGen;
  const closings = channelClosings;
  channelCreate.disabled = true;
  channelNote.textContent = "Creating…";
  const ac = new AbortController();
  const deadline = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let answer;
  try {
    const res = await fetch("/api/post", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ as: from, channel: name, body }),
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: ac.signal,
    });
    answer = res.status === 400 ? { status: 400, reason: await reasonOf(res) } : { status: res.status };
    if (res.status === 200) answer.channel = await storedName(res, name);
  } catch {
    answer = { error: "No answer from the server, so the channel may have been created: check the channel list, or use another name." };
  } finally {
    clearTimeout(deadline);
  }
  if (tokenGen !== tokenGeneration) return;
  creating = undefined;
  channelCreate.disabled = false;
  if (answer.status === 401) return ask("The server refused that token. Enter another.");
  if (answer.status === 200) {
    // The name is now taken, and text typed while the request was in flight stays.
    channelsSent.add(name.toLowerCase());
    if (channelName.value === name) channelName.value = "";
    if (channelBody.value === body) channelBody.value = "";
    // The reader closed the form, or opened something else, while it was in flight: the poll lists the channel.
    if (closings !== channelClosings) return;
    // openLog's showPicker posts as the person again, and its poll reads the first post.
    person = from;
    channelNote.textContent = "";
    closeChannelForm(false);
    openLog(answer.channel);
    if (!compose.hidden) composeText.focus();
    return;
  }
  if (answer.error) {
    channelNote.textContent = answer.error;
    // The post may yet be stored, even after a list that leaves it out, so a retry could add a second first post.
    channelsSent.add(name.toLowerCase());
    // Read again at once, so the channel list shows whether it arrived.
    cancel();
    poll(generation);
  } else if (answer.status === 400) {
    channelNote.textContent = answer.reason || "The server refused this (400).";
  } else if (answer.status === 403) {
    channelNote.textContent = "This token cannot post (403).";
  } else if (answer.status === 404) {
    // This server answers a person token's "as" that is not its live person with 403; a 404 says the same.
    channelNote.textContent = from + " is no longer a person in this account (404).";
  } else if (answer.status === 413) {
    channelNote.textContent = "This is too long for the server (413).";
  } else if (answer.status === 503) {
    channelNote.textContent = "The server is busy (503). Try again in a moment.";
  } else {
    channelNote.textContent = "The server answered " + answer.status + ".";
  }
}

// The empty first option of a "New message" select, chosen while no listed name is, so startPair opens nothing.
function choose(text) {
  const option = document.createElement("option");
  option.value = "";
  option.textContent = text;
  return option;
}

// Opens the pair of from and to as a conversation, as choosing it in the sidebar does, with from chosen as the person
// the page posts as. A pair with no messages yet is added to the sidebar first, with no badge, under the key
// pairKey gives its messages, so the first one lands in it. Only a person of the account is ever chosen, and only a
// name the form offers is ever opened with them.
function startPair(from, to) {
  if (!canPost || !senders()?.includes(from)) return;
  const offeredTo = mentionable.some((n) => n.name === to);
  if (!offeredTo || to.toLowerCase() === "all" || to.toLowerCase() === from.toLowerCase()) return;
  // openPairLog's showPicker posts as the person again.
  person = from;
  const names = [from, to].sort();
  const key = JSON.stringify(names);
  if (!pairs.has(key)) pairs.set(key, { names, count: 0, newest: messages.length, made: ++madePairs });
  showPairs();
  openPairLog(key);
  if (!compose.hidden) composeText.focus();
}

// Sets who the page posts as: a person token's person while GET /api/agents lists them, and no one otherwise. It names
// them above the compose box while that shows; with a full token and an open channel or pair, it says there instead how
// to sign in as a person to send.
function showPicker() {
  const before = person;
  person = canPost && senders()?.includes(me) ? me : undefined;
  const conversation = openChannel !== undefined || openPair !== undefined;
  const posting = person !== undefined && (openChannel !== undefined || replyTo() !== undefined);
  asNote.textContent = posting ? "Posting as " + person : fullToken && conversation ? SIGN_IN_TO_SEND : "";
  showCompose();
  if (person !== before) markMentions();
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

// Shows the compose box under an open channel, or under an open pair the chosen person is one side of, and the row
// it shares with the note on who the page posts as while either of them shows.
function showCompose() {
  const to = replyTo();
  const shown = canPost && person !== undefined && (openChannel !== undefined || to !== undefined);
  compose.hidden = !shown;
  if (!shown) closeOffered();
  if (shown) composeLabel.textContent = openChannel !== undefined ? "Post in #" + openChannel + " as " + person : "Reply to " + to + " as " + person;
  writer.hidden = compose.hidden && asNote.textContent === "";
  if (shown) grow();
}

// Sets the compose box's rows to what its text needs, from MIN_ROWS up to MAX_ROWS, so it grows and shrinks with it.
function grow() {
  composeText.rows = MIN_ROWS;
  while (composeText.rows < MAX_ROWS && composeText.scrollHeight > composeText.clientHeight) composeText.rows++;
}

// Offers the names that start with what was typed after an "@" just before the caret, ignoring case, leaving out the
// chosen person and "all", for which the server records no mention; closes the list when there is no "@" or no match,
// or text is selected.
function offer() {
  const selected = composeText.selectionStart !== composeText.selectionEnd;
  const typed = compose.hidden || selected ? null : TYPING.exec(composeText.value.slice(0, composeText.selectionStart));
  if (!typed) return closeOffered();
  const start = typed[1].toLowerCase();
  const me = person === undefined ? undefined : person.toLowerCase();
  const found = mentionable.filter((n) => {
    const lower = n.name.toLowerCase();
    return lower.startsWith(start) && lower !== "all" && lower !== me;
  }).slice(0, MAX_OFFERED);
  if (found.length === 0) return closeOffered();
  // The highlight stays on its name while it is still offered.
  const current = offered[highlighted];
  highlighted = current ? Math.max(0, found.findIndex((n) => n.name === current.name)) : 0;
  offered = found;
  typedFrom = typed.index;
  typedTo = typed.index + typed[0].length;
  showOffered();
}

// Builds the list of offered names, each with whether it is a person, and marks the highlighted one.
function showOffered() {
  mentionList.replaceChildren(...offered.map((n, i) => {
    const option = part("li", i === highlighted ? "option current" : "option", "");
    option.id = "mention-" + i;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", i === highlighted ? "true" : "false");
    option.append(part("span", "name", n.name));
    if (n.person) option.append(part("span", "kind", "person"));
    // On mousedown, with its default prevented, so the box keeps the focus and the caret. It looks again at the box
    // first, and picks only a name still offered for the selection and caret as they are now.
    option.addEventListener("mousedown", (event) => {
      event.preventDefault();
      offer();
      const now = offered.findIndex((o) => o.name === n.name);
      if (now >= 0) pick(now);
    });
    return option;
  }));
  mentionList.hidden = false;
  composeText.setAttribute("aria-expanded", "true");
  composeText.setAttribute("aria-activedescendant", "mention-" + highlighted);
}

function closeOffered() {
  if (offered.length === 0) return;
  offered = [];
  highlighted = 0;
  mentionList.replaceChildren();
  mentionList.hidden = true;
  composeText.setAttribute("aria-expanded", "false");
  composeText.removeAttribute("aria-activedescendant");
}

// Replaces the "@" and what was typed after it with "@<name> " and puts the caret after the space.
function pick(i) {
  const text = "@" + offered[i].name + " ";
  const value = composeText.value;
  composeText.value = value.slice(0, typedFrom) + text + value.slice(typedTo);
  const caret = typedFrom + text.length;
  composeText.setSelectionRange(caret, caret);
  closeOffered();
  grow();
}

// What the compose box sends to now: the path, the conversation and the person, or undefined when it is hidden.
function composeTarget() {
  if (compose.hidden) return undefined;
  return openChannel !== undefined
    ? { path: "/api/post", conversation: "#" + openChannel, fields: { as: person, channel: openChannel } }
    : { path: "/api/send", conversation: openPair, fields: { as: person, to: replyTo() } };
}

// Posts in the open channel or replies in the open pair as the chosen person, then polls at once so it shows. Send
// stays disabled while the request is in flight. One with no answer (a failed connection, or none within TIMEOUT_MS)
// may still have been stored, so the text is kept with a note to check the conversation before sending again. Its
// answer changes the box only while the box still sends to the same conversation as the same person: the text is
// cleared after a 200, if it is still what was sent, and any other answer keeps it and says why.
async function send() {
  const token = sessionStorage.getItem(KEY);
  if (!token) return ask();
  const tokenGen = tokenGeneration;
  // The box is shown only for a full or person token, a person to post as and a channel or a pair of theirs (showCompose).
  const target = composeTarget();
  if (sending === tokenGen || target === undefined) return;
  const body = composeText.value;
  // The server counts characters as code points, as validateBody does, which maxlength (UTF-16 units) does not.
  if ([...body].length > ${MAX_BODY_LENGTH}) {
    composeNote.textContent = "This is longer than ${MAX_BODY_LENGTH} characters.";
    return;
  }
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
    answer = { error: "No answer from the server, so it may have been sent: check the conversation before sending again" };
  } finally {
    clearTimeout(deadline);
  }
  if (tokenGen !== tokenGeneration) return;
  if (answer.status === 401) return ask("The server refused that token. Enter another.");
  const now = composeTarget();
  const same = now !== undefined && now.path === target.path && now.conversation === target.conversation && now.fields.as === target.fields.as;
  if (answer.status === 200 || answer.error) {
    if (same && answer.status === 200 && composeText.value === body) {
      composeText.value = "";
      closeOffered();
      grow();
    }
    if (same) composeNote.textContent = answer.status === 200 ? "" : answer.error + ".";
    // Read again at once, so the post or message shows, or, with no answer, so the reader can see whether it arrived.
    cancel();
    poll(generation);
  } else if (!same) {
    // The box now sends somewhere else: this answer is not about it.
  } else if (answer.status === 400) {
    composeNote.textContent = answer.reason || "The server refused this (400).";
  } else if (answer.status === 403) {
    composeNote.textContent = "This token cannot post or send (403).";
  } else if (answer.status === 404) {
    // This server answers a person token's "as" that is not its live person with 403; a 404 says the same.
    composeNote.textContent = target.fields.as + " is no longer a person in this account (404).";
  } else if (answer.status === 413) {
    composeNote.textContent = "This is too long for the server (413).";
  } else if (answer.status === 503) {
    composeNote.textContent = "The server is busy (503). Send again in a moment.";
  } else {
    composeNote.textContent = "The server answered " + answer.status + ".";
  }
  sending = undefined;
  composeSend.disabled = false;
}

// The open pair, while its Delete button may show: a full token with no person, or an admin person's token, and a direct
// conversation with messages in it.
function deletable() {
  const pair = openPair !== undefined ? pairs.get(openPair) : undefined;
  return (fullToken || meAdmin) && pair && pair.count > 0 ? pair : undefined;
}

// The keys of the held pairs that DELETE /api/conversation with key's two names deletes too: the server matches names
// with SQLite's NOCASE, which folds only A-Z, so Bob and bob, which the page lists apart, are one conversation to it.
function deletedWith(key) {
  const fold = (names) => JSON.stringify(names.map((n) => n.replace(/[A-Z]/g, (c) => c.toLowerCase())).sort());
  const folded = fold(pairs.get(key).names);
  return [...pairs].filter(([, p]) => p.count > 0 && fold(p.names) === folded).map(([k]) => k);
}

// Shows the Delete button in the open pair's header bar while it is deletable and not asking, and keeps the confirmation's
// count to the messages the page holds for the pair; dismisses the confirmation once the pair is not deletable.
function showDelete() {
  const pair = deletable();
  if (!pair) closeDelete(false);
  deleteButton.hidden = !pair || !deleteConfirm.hidden;
  if (pair && !deleteConfirm.hidden) {
    // Every pair the server deletes with this one is named and counted, so the confirmation covers all it removes.
    const held = deletedWith(openPair).map((k) => pairs.get(k));
    const count = held.reduce((sum, p) => sum + p.count, 0);
    const between = held.map((p) => p.names[0] + " and " + p.names[1]).join(", and between ");
    deleteText.textContent = "Delete the " + plural(count, "message") + " between " + between + "? This cannot be undone.";
  }
}

// Asks in the header bar before deleting the open pair; nothing is sent until its Delete is pressed.
function openDelete() {
  if (!deletable()) return;
  deleteNote.textContent = "";
  deleteConfirm.hidden = false;
  deleteYes.disabled = deleting === tokenGeneration;
  showDelete();
  document.getElementById("delete-no").focus();
}

// Dismisses the delete confirmation, giving the focus back to the Delete button when the reader dismissed it.
function closeDelete(refocus) {
  if (deleteConfirm.hidden) return;
  deleteConfirm.hidden = true;
  deleteButton.hidden = !deletable();
  if (refocus && !deleteButton.hidden) deleteButton.focus();
}

// Deletes the open pair's messages with DELETE /api/conversation, then reads the account's messages again from the
// start, since GET /api/messages pages by offset and the rows before heldMessages are now fewer. The confirm button stays
// disabled while the request is in flight. A 200 closes the pair if it is still open and forgets what this tab had seen
// of it; with no answer the messages may already be deleted, so they are read again too and the pair stays open with a
// note, its rows emptied until the read shows what is left. Any other answer keeps the pair open with its reason. An
// answer that comes after the token was forgotten is dropped; one that comes after another conversation opened changes
// only the messages the page holds.
async function deletePair() {
  const token = sessionStorage.getItem(KEY);
  if (!token) return ask();
  const tokenGen = tokenGeneration;
  const pair = deletable();
  if (!pair || deleteConfirm.hidden || deleting === tokenGen) return;
  const key = openPair;
  const gone = deletedWith(key);
  const [a, b] = pair.names;
  deleting = tokenGen;
  deleteYes.disabled = true;
  const ac = new AbortController();
  const deadline = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let answer;
  try {
    const res = await fetch("/api/conversation?" + new URLSearchParams({ a, b }), {
      method: "DELETE",
      headers: { Authorization: "Bearer " + token },
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: ac.signal,
    });
    answer = res.status === 400 ? { status: 400, reason: await reasonOf(res) } : { status: res.status };
  } catch {
    answer = { error: "No answer from the server, so the messages may already be deleted. Reading them again." };
  } finally {
    clearTimeout(deadline);
  }
  if (tokenGen !== tokenGeneration) return;
  deleting = undefined;
  deleteYes.disabled = false;
  if (answer.status === 401) return ask("The server refused that token. Enter another.");
  const same = openPair === key;
  if (answer.status === 200 || answer.error) {
    if (same && answer.status === 200) {
      closeLog();
      markOpen();
      // The log the focus was in is gone, so it goes to the search box, at the top of the page.
      searchText.focus();
    } else if (openPair !== undefined) {
      // The open pair's rows are read again with the rest, so they are emptied rather than shown twice.
      closeDelete(false);
      postRows.replaceChildren();
      lastEntry = undefined;
      chatRows = [];
      chatTimes = [];
      logMentions = [];
      if (same) deleteNote.textContent = answer.error;
    }
    // Once deleted, the pairs start with nothing seen if they come back; with no answer they may still be there, as seen.
    if (answer.status === 200) {
      for (const k of gone) {
        seen.delete("pair " + k);
        shownTotals.delete("pair " + k);
      }
    }
    heldMessages = 0;
    messages = [];
    // The re-read brings back every pair that still has messages. A pair started from "New message" that has none yet
    // is kept, so one open now stays open with its compose box.
    pairs = new Map([...pairs].filter(([k, p]) => k !== key && p.count === 0).map(([k, p]) => [k, { ...p, newest: 0 }]));
    if (openPair !== undefined && pairs.has(openPair)) logNote.textContent = "No messages yet.";
    showPairs();
    showPicker();
    showDelete();
    if (same && answer.error) document.getElementById("close-log").focus();
    cancel();
    poll(generation);
    return;
  }
  if (!same) return;
  closeDelete(false);
  deleteButton.focus();
  if (answer.status === 400) {
    deleteNote.textContent = answer.reason || "The server refused this (400).";
  } else if (answer.status === 403) {
    deleteNote.textContent = "This token cannot delete conversations (403).";
  } else if (answer.status === 503) {
    deleteNote.textContent = "The server is busy (503). Try again in a moment.";
  } else {
    deleteNote.textContent = "The server answered " + answer.status + ".";
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

// The channel name a 200 from POST /api/post says the post was stored under, which may differ in case from the name
// sent, or the name sent if the answer cannot be read.
async function storedName(res, sent) {
  try {
    const channel = (await res.json()).channel;
    return typeof channel === "string" && channel.toLowerCase() === sent.toLowerCase() ? channel : sent;
  } catch {
    return sent;
  }
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

// Fetches every page of path with params, PAGE at a time.
async function fetchAll(token, signal, path, items, params = {}) {
  const all = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await fetchPage(token, signal, path, params, offset, items);
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
      lastEntry = undefined;
      chatRows = [];
      chatTimes = [];
      logMentions = [];
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

// Reads every page of the account's unread direct messages, and marks each message the page holds as read once it is
// not among them, updating its receipt in the open log. read_at is only ever set, never cleared, so a message is never
// marked unread again. A message read while the pages were read moves the rest one place earlier, so the row after a
// page boundary (or after a full last page) may have been skipped: a held message there is left as it was until a later
// poll. The answer leaves out messages to a person, so it only looks at the first held messages, those the page held
// before this poll read the agents, and only at those whose recipient that answer (agents) lists as an agent: a person
// added later never counts as one, and a message sent to a person whose name is an agent's now was deleted with that
// person, so it turns to read as any deleted message does. A held message still among them with starting true (a
// webhook delivered it) is marked starting, and never unmarked. A failed read, or one answered after a newer poll or
// another token, changes nothing. When none of those is still unread there is nothing to learn, so it asks nothing. It
// marks nothing read for any agent.
async function readReceipts(token, signal, gen, held, agents) {
  const names = new Set(agents.filter((a) => a.person !== true).map((a) => String(a.name).toLowerCase()));
  const candidates = messages.slice(0, held).filter((m) => m.read !== true && names.has(String(m.to).toLowerCase()));
  if (candidates.length === 0) return { ok: true };
  const unread = await fetchAll(token, signal, "/api/messages", list, { unread: "true" });
  if (gen !== generation) return { ok: true };
  if (!unread.items) return unread;
  const items = unread.items;
  const ids = new Set(items.map((m) => m.id));
  const starting = new Set(items.filter((m) => m.starting === true).map((m) => m.id));
  const unsure = [];
  for (let i = PAGE; i <= items.length; i += PAGE) unsure.push([items[i - 1].id, i < items.length ? items[i].id : Infinity]);
  for (const m of candidates) {
    if (starting.has(m.id)) m.starting = true;
    if (ids.has(m.id) || unsure.some(([after, before]) => m.id > after && m.id < before)) continue;
    m.read = true;
  }
  for (const row of chatRows) if (row.message && row.receipt) row.receipt.textContent = receiptText(row.message);
  return { ok: true };
}

// Reads every page of the open channel's posts that still have an unread mention of an agent, and marks each mention
// the open log holds as read once its post is not among them, or is with that name read, updating the post's receipt
// in place. read_at is only ever set, never cleared, so a mention is never marked unread again. As in readReceipts, a
// mention read while the pages were read can make the post after a page boundary be skipped, so a held post there is
// left as it was until a later poll. A failed read, a channel that is gone (404), or one answered after a newer poll,
// another token or another open channel, changes nothing. When no mention the log holds is still unread there is
// nothing to learn, so it asks nothing. It marks nothing read for any agent.
async function readMentions(token, signal, gen, channel) {
  const candidates = chatRows.filter((row) => row.post && row.post.mentions.some((m) => m.read !== true));
  if (candidates.length === 0) return { ok: true };
  const unread = await fetchAll(token, signal, "/api/channel-posts", postsOf, { channel, unread: "true" });
  if (gen !== generation || channel !== openChannel || unread.status === 404) return { ok: true };
  if (!unread.items) return unread;
  const items = unread.items;
  const byId = new Map(items.map((p) => [p.id, mentionsOf(p)]));
  const unsure = [];
  for (let i = PAGE; i <= items.length; i += PAGE) unsure.push([items[i - 1].id, i < items.length ? items[i].id : Infinity]);
  for (const row of candidates) {
    const id = row.post.id;
    const now = byId.get(id);
    if (now === undefined && unsure.some(([after, before]) => id > after && id < before)) continue;
    for (const m of row.post.mentions) {
      if (now === undefined || now.some((n) => n.read && n.name.toLowerCase() === m.name.toLowerCase())) m.read = true;
    }
    row.receipt.textContent = mentionsText(row.post.mentions);
  }
  return { ok: true };
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
      messagesNote.textContent = heldMessages === 0 ? messagesEmpty() : "";
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
        ? NO_DELIVERIES
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

// Puts the approvals in the log as approvalRow draws them, with Revoke buttons only for an admin, unless the rows were
// last built from the same list for the same admin, and keeps them for unmarked(). Answers true once they are in the log;
// throws, leaving the log as it was, on a list whose entries are not approvals.
function drawApprovals(items) {
  const key = (meAdmin ? "admin " : "") + JSON.stringify(items);
  if (key === approvalRowsKey) return true;
  const rows = items.map(approvalRow);
  shownApprovals = items;
  approvalRowsKey = key;
  postRows.replaceChildren(...rows);
  postRows.scrollTop = 0;
  return true;
}

// Reads the newest PAGE approvals and replaces the ones the log holds when they changed, as readDeliveries does: they come newest first, and
// one goes when its token is revoked or, for a single-agent approval, its agent removed. Any failure but a refused token
// goes in the log's note.
async function readApprovals(token, signal, gen) {
  let page;
  try {
    page = await fetchPage(token, signal, "/api/approvals", {}, 0, list);
  } catch {
    page = { error: signal.aborted ? "The server did not answer in time" : "Cannot reach the server" };
  }
  // A newer poll, or the approvals were closed, while the page was read: leave the log to them.
  if (gen !== generation || !openApprovals) return { ok: true };
  if (page.status === 401) return page;
  // A list whose entries are not approvals is as unreadable as one that is not a list.
  let drawn = false;
  try {
    if (page.items) drawn = drawApprovals(page.items);
  } catch {
    page = { error: "The server sent an answer this page cannot read" };
  }
  if (drawn) {
    // A confirmation for an approval the list no longer gives as it was closes, so it never revokes a token it was not
    // asked about. The one whose revocation is in flight is left to that revocation's answer, which closes it; a
    // confirmation for any other approval opened meanwhile is checked like any other.
    const inFlight = revokingApproval === tokenGeneration && revokingTarget === approvalTarget;
    if (approvalTarget && !inFlight && !page.items.some((a) => JSON.stringify(a) === approvalTarget.key)) {
      approvalNote.textContent =
        "Token " + approvalTarget.id + " (" + approvalTarget.client + ") changed or went from the list, so its confirmation closed and nothing was sent.";
      // Focus inside the confirmation goes to the view's Close button, as the confirmation is hidden; focus elsewhere stays.
      closeRevokeApproval(approvalConfirm.contains(document.activeElement));
    }
    approvalCount.textContent = String(page.items.length);
    logNote.textContent =
      page.items.length === 0
        ? NO_APPROVALS
        : page.items.length === PAGE
          ? "Only the newest " + PAGE + " approvals are shown."
          : "";
  } else if (page.status === 403) {
    logNote.textContent = "This token cannot read approved clients (403). Retrying…";
  } else if (page.status === 503) {
    logNote.textContent = "The server is busy (503). Retrying…";
  } else {
    logNote.textContent = (page.error || "The server answered " + page.status) + ". Retrying…";
  }
  return { ok: true };
}

// Reads the account's people, by name, and replaces the list the view holds when it changed, as readInvites does; with
// the view closed, or no longer an admin's, it leaves the list as it is. A 403 says the person is no longer an admin
// (unmarked). Any other failure but a refused token goes in the list's note.
async function readPeople(token, signal, gen) {
  if (!meAdmin) return { ok: true };
  let page;
  try {
    page = await fetchPage(token, signal, "/api/people", {}, 0, list);
  } catch {
    page = { error: signal.aborted ? "The server did not answer in time" : "Cannot reach the server" };
  }
  if (gen !== generation || !openInvites || !meAdmin) return { ok: true };
  if (page.status === 401) return page;
  if (page.status === 403) {
    unmarked();
    return { ok: true };
  }
  let shown;
  const key = page.items ? JSON.stringify(page.items) : "";
  try {
    if (page.items && key !== peopleRowsKey) shown = page.items.map(personRow);
  } catch {
    page = { error: "The server sent an answer this page cannot read" };
  }
  if (page.items) {
    if (shown) {
      peopleRowsKey = key;
      peopleRows.replaceChildren(...shown);
    }
    inviteCount.textContent = String(page.items.length);
    peopleRead.textContent = page.items.length === PAGE ? "Only the first " + PAGE + " people are shown." : "";
  } else if (page.status === 503) {
    peopleRead.textContent = "The server is busy (503). Retrying…";
  } else {
    peopleRead.textContent = (page.error || "The server answered " + page.status) + ". Retrying…";
  }
  return { ok: true };
}

// Reads the account's people and its unused invites side by side for the open people view, answering a refused
// token's answer if either read had one.
async function readPeopleView(token, signal, gen) {
  const answers = await Promise.all([readPeople(token, signal, gen), readInvites(token, signal, gen)]);
  return answers.find((a) => a.status === 401) ?? { ok: true };
}

// Reads the account's unused invites, newest first, and replaces the ones the log holds when they changed, as
// readApprovals does; with the invites closed, or no longer an admin's, it leaves the log as it is. A 403 says the person
// is no longer an admin (unmarked). Any other failure but a refused token goes in the log's note.
async function readInvites(token, signal, gen) {
  if (!meAdmin) return { ok: true };
  let page;
  try {
    page = await fetchPage(token, signal, "/api/invites", {}, 0, list);
  } catch {
    page = { error: signal.aborted ? "The server did not answer in time" : "Cannot reach the server" };
  }
  if (gen !== generation || !openInvites || !meAdmin) return { ok: true };
  if (page.status === 401) return page;
  if (page.status === 403) {
    unmarked();
    return { ok: true };
  }
  let shown;
  const key = page.items ? JSON.stringify(page.items) : "";
  try {
    if (page.items && key !== inviteRowsKey) shown = page.items.map(inviteRow);
  } catch {
    page = { error: "The server sent an answer this page cannot read" };
  }
  if (page.items) {
    if (shown) {
      inviteRowsKey = key;
      postRows.replaceChildren(...shown);
      postRows.scrollTop = 0;
    }
    logNote.textContent = page.items.length === 0 ? NO_INVITES : "";
  } else if (page.status === 503) {
    logNote.textContent = "The server is busy (503). Retrying…";
  } else {
    logNote.textContent = (page.error || "The server answered " + page.status) + ". Retrying…";
  }
  return { ok: true };
}

// Reads the account's webhooks, oldest first, and replaces the ones the log holds when they changed, as readInvites does;
// with the view closed, or no longer an admin's, it leaves the log as it is. A 403 says the person is no longer an admin
// (unmarked). Any other failure but a refused token goes in the log's note.
async function readWebhooks(token, signal, gen) {
  if (!meAdmin) return { ok: true };
  let page;
  try {
    page = await fetchPage(token, signal, "/api/webhooks", {}, 0, list);
  } catch {
    page = { error: signal.aborted ? "The server did not answer in time" : "Cannot reach the server" };
  }
  if (gen !== generation || !openWebhooks || !meAdmin) return { ok: true };
  if (page.status === 401) return page;
  if (page.status === 403) {
    unmarked();
    return { ok: true };
  }
  let shown;
  const key = page.items ? JSON.stringify(page.items) : "";
  try {
    if (page.items && key !== webhookRowsKey) shown = page.items.map(webhookRow);
  } catch {
    page = { error: "The server sent an answer this page cannot read" };
  }
  if (page.items) {
    // A confirmation for a webhook the list no longer gives as it was closes, so it never removes a webhook added since
    // that the server gave the same id. The one whose removal is in flight is left to that removal's answer, which closes
    // it; a confirmation for any other webhook opened meanwhile is checked like any other.
    const inFlight = removingWebhook === tokenGeneration && removingHook === webhookTarget;
    if (webhookTarget && !inFlight && !page.items.some((w) => JSON.stringify(w) === webhookTarget.key)) {
      webhookNote.textContent =
        "Webhook " + webhookTarget.id + " (" + webhookTarget.on + ") changed or went from the list, so its confirmation closed and nothing was sent.";
      closeRemoveWebhook();
    }
    if (shown) {
      webhookRowsKey = key;
      postRows.replaceChildren(...shown);
      postRows.scrollTop = 0;
    }
    webhookCount.textContent = String(page.items.length);
    logNote.textContent =
      page.items.length === 0 ? NO_WEBHOOKS : page.items.length === PAGE ? "Only the first " + PAGE + " webhooks are shown." : "";
  } else if (page.status === 503) {
    logNote.textContent = "The server is busy (503). Retrying…";
  } else {
    logNote.textContent = (page.error || "The server answered " + page.status) + ". Retrying…";
  }
  return { ok: true };
}

// Reads the account's unrevoked tokens, oldest first, and replaces the ones the log holds when they changed, as
// readWebhooks does; with the view closed, or no longer an admin's, it leaves the log as it is. A 403 says the person is
// no longer an admin (unmarked). Any other failure but a refused token goes in the log's note. An admin person's own
// token is always listed, so the list is never empty for one and has no empty-view note.
async function readTokens(token, signal, gen) {
  if (!meAdmin) return { ok: true };
  let page;
  try {
    page = await fetchPage(token, signal, "/api/tokens", {}, 0, list);
  } catch {
    page = { error: signal.aborted ? "The server did not answer in time" : "Cannot reach the server" };
  }
  if (gen !== generation || !openTokens || !meAdmin) return { ok: true };
  if (page.status === 401) return page;
  if (page.status === 403) {
    unmarked();
    return { ok: true };
  }
  let shown;
  const key = page.items ? JSON.stringify(page.items) : "";
  try {
    if (page.items && key !== tokenRowsKey) shown = page.items.map(tokenRow);
  } catch {
    page = { error: "The server sent an answer this page cannot read" };
  }
  if (page.items) {
    // A confirmation for a token the list no longer gives as it was closes, so it never revokes one it no longer
    // describes. The one being revoked is left to that request's answer, which closes it.
    const inFlight = revokingToken === tokenGeneration && revokingTokenTarget === tokenTarget;
    if (tokenTarget && !inFlight && !page.items.some((t) => JSON.stringify(t) === tokenTarget.key)) {
      tokenNote.textContent =
        "Token " + tokenTarget.id + " (" + tokenTarget.label + ") changed or went from the list, so its confirmation closed and nothing was sent.";
      closeRevokeToken();
    }
    if (shown) {
      tokenRowsKey = key;
      postRows.replaceChildren(...shown);
      postRows.scrollTop = 0;
    }
    tokenCount.textContent = String(page.items.length);
    logNote.textContent = page.items.length === PAGE ? "Only the first " + PAGE + " tokens are shown." : "";
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
  const approvals = openApprovals;
  const invites = openInvites;
  const webhooks = openWebhooks;
  const tokens = openTokens;
  const held = messages.length;
  let result;
  try {
    result = await fetchView(token, ac.signal);
    // The agents and channels go up before the messages and the log are read, so a long or slow history never holds
    // them back. The messages and the log (a channel's posts, the webhook deliveries, the approvals, the people and
    // invites, the webhooks, or the tokens) are read side by side, so neither waits on the other or fails with it, and both have finished before the
    // next poll can read past what they hold.
    if (result.ok && gen === generation) {
      show(result.agents);
      refreshChat();
      showChannels(result.channels);
      showDeliveryEntry();
      showApprovalEntry();
      const [messages, posts] = await Promise.allSettled([
        readMessages(token, ac.signal, gen),
        channel !== undefined
          ? readLog(token, ac.signal, gen, channel)
          : deliveries
            ? readDeliveries(token, ac.signal, gen)
            : approvals
              ? readApprovals(token, ac.signal, gen)
              : invites
                ? readPeopleView(token, ac.signal, gen)
                : webhooks
                  ? readWebhooks(token, ac.signal, gen)
                  : tokens
                    ? readTokens(token, ac.signal, gen)
                    : { ok: true },
      ]);
      // A refused token from either read wins, so a failure of the other never leaves the page showing its data.
      const values = [messages, posts].filter((r) => r.status === "fulfilled").map((r) => r.value);
      const refused = values.find((v) => v.status === 401);
      const failed = [messages, posts].find((r) => r.status === "rejected");
      if (failed && !refused) throw failed.reason;
      // Everything the first poll for this token read counts as seen, so loading the page shows no badges. It never
      // lowers a count, so a post the open log showed after GET /api/channels answered stays seen.
      if (!seenAll && !refused && messages.status === "fulfilled" && messages.value.ok && gen === generation) {
        const atLeast = (key, n) => seen.set(key, Math.max(seen.get(key) ?? 0, n));
        for (const c of result.channels) atLeast("channel " + String(c.name), c.posts);
        for (const [key, pair] of pairs) atLeast("pair " + key, pair.count);
        seenAll = true;
      }
      // Once the messages are read, whether each one the page holds has been read since; never before, so every held
      // message is among those it asks about.
      if (!refused && messages.status === "fulfilled" && messages.value.ok && gen === generation) {
        values.push(await readReceipts(token, ac.signal, gen, held, result.agents));
      }
      // Once the open channel's posts are read, whether each mention they hold has been read since.
      if (!refused && channel !== undefined && posts.status === "fulfilled" && posts.value.ok && gen === generation) {
        values.push(await readMentions(token, ac.signal, gen, channel));
      }
      result = values.find((v) => v.status === 401) ?? values.find((v) => !v.ok) ?? posts.value;
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

// A log entry's time: "just now", "Nm ago" or "Nh ago" within the last 12 hours, else the local time today or the
// local date and time before. A time that cannot be read is shown as given, as when shows it.
function chatTime(iso) {
  const date = new Date(iso);
  const ms = Date.now() - date.getTime();
  if (!Number.isFinite(ms)) return String(iso);
  if (Math.abs(ms) < 60000) return "just now";
  if (ms > 0 && ms < 12 * 3600000) return ago(iso);
  const clock = { hour: "2-digit", minute: "2-digit" };
  if (date.toDateString() === new Date(Date.now()).toDateString()) return date.toLocaleTimeString([], clock);
  return date.toLocaleString([], { year: "numeric", month: "short", day: "numeric", ...clock });
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

// An http:// or https:// address in an entry's text, up to a space or a character that cannot be in one; addresses()
// trims the punctuation after it.
const ADDRESS = /https?:\\/\\/[^\\s<>"]+/g;
// Punctuation at the end of an address that ends the sentence around it rather than the address.
const TRAILING = ".,;:!?)]}'\\"";

// The web addresses in a text as [start, end] pairs, each without its trailing punctuation, except that a ")" stays
// when the address has a "(" to match it, so https://en.wikipedia.org/wiki/Foo_(bar) stays whole. A scheme with
// nothing after it is none.
function addresses(text) {
  const found = [];
  for (const match of text.matchAll(ADDRESS)) {
    let address = match[0];
    // How many more "(" than ")" the address has, so a ")" that closes one stays.
    let open = address.split("(").length - address.split(")").length;
    while (TRAILING.includes(address[address.length - 1])) {
      if (address.endsWith(")")) {
        if (open >= 0) break;
        open++;
      }
      address = address.slice(0, -1);
    }
    if (/^https?:\\/\\/./.test(address)) found.push([match.index, match.index + address.length]);
  }
  return found;
}

// A link to an address addresses() found, its text the address, opening in a new tab that is not told where it came
// from.
function link(address) {
  const a = part("a", "", address);
  a.href = address;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

// An entry's text as a div.body. Text with web addresses or mentions is split into spans and links: each address
// addresses() finds is its own a, and each mention outside an address its own span.mention, marked "mention me" when
// it names the person the page posts as. Mentions are found in the whole text, as the server finds them. Text with
// neither is the div's own text.
function bodyPart(text, mentions) {
  const body = part("div", "body", "");
  const links = addresses(text);
  const named = [...text.matchAll(MENTION)]
    .map((match) => [match.index, match.index + match[0].length, match])
    .filter(([start, end]) => !links.some(([from, to]) => start < to && end > from));
  const pieces = [...links, ...named].sort((a, b) => a[0] - b[0]);
  if (pieces.length === 0) {
    body.textContent = text;
    return body;
  }
  let at = 0;
  for (const [start, end, match] of pieces) {
    if (start > at) body.append(part("span", "", text.slice(at, start)));
    if (match === undefined) body.append(link(text.slice(start, end)));
    else {
      const span = part("span", mentionClass(match[1]), match[0]);
      mentions.push([span, match[1].toLowerCase()]);
      body.append(span);
    }
    at = end;
  }
  if (at < text.length) body.append(part("span", "", text.slice(at)));
  return body;
}

// A mention's classes: "mention me" for the chosen person's name, or a person token's person, without case, with a token
// that may post; else "mention".
function mentionClass(name) {
  return canPost && person !== undefined && name.toLowerCase() === person.toLowerCase() ? "mention me" : "mention";
}

// Re-marks the mentions already shown after the chosen person changed, without rebuilding the log or the results.
function markMentions() {
  for (const [span, name] of [...logMentions, ...resultMentions]) span.className = mentionClass(name);
}

// "1 message" or "2 messages".
function plural(count, noun) {
  return count + " " + noun + (count === 1 ? "" : "s");
}

function show(agents) {
  const names = new Set(agents.map((a) => String(a.name)));
  for (const name of openAgents) if (!names.has(name)) openAgents.delete(name);
  // A confirmation or new key for an agent no longer listed ends; a note saying what ended it stays.
  if (agentFor && !names.has(agentFor.name) && (!agentConfirm.hidden || !agentKeyMade.hidden)) closeAgentPanel();
  const items = agents.map((a) => {
    const name = String(a.name);
    const bio = String(a.bio);
    // The agent's status line while GET /api/agents gives one; null once it has cleared or expired, so the next poll
    // that succeeds drops it.
    const status = typeof a.status === "string" ? a.status : "";
    const li = document.createElement("li");
    li.className = "agent";
    // A person has no online state of its own, so it is marked as a person in place of the dot, before its name.
    const dot = a.person === true
      ? part("span", "kind", "person")
      : part("span", a.online ? "dot online" : "dot", a.online ? "online" : "offline");
    dot.title = a.person === true ? "a person, not an agent" : a.online ? "online" : "offline";
    // A person's lastSeen is when they were added.
    const seenText = (a.person === true ? "added " : "last seen ") + ago(a.lastSeen);
    const unreadText = "unread: " + plural(a.unreadMessages, "message") + ", " + plural(a.unreadPosts, "post") + ", " + plural(a.unreadMentions, "mention");
    // The badge is the agent's own unread mail, as GET /api/agents counts it, not what this tab has seen.
    const button = document.createElement("button");
    button.type = "button";
    // A person added without a bio has none, so the tooltip leaves it out rather than starting with a separator.
    button.title = [status, bio, seenText, unreadText].filter((t) => t !== "").join(" · ");
    button.append(dot, part("span", "name", name));
    if (status !== "") button.append(part("span", "status", status));
    button.append(badge(Number(a.unreadMessages) + Number(a.unreadPosts) + Number(a.unreadMentions)));
    const seen = part("span", "seen", seenText);
    seen.title = String(a.lastSeen);
    const details = part("div", "details", "");
    if (status !== "") details.append(part("span", "status", status));
    details.append(part("span", "bio", bio), seen, part("span", "unread", unreadText));
    // Only an admin person may remove an agent or reset its key, and a person is neither.
    if (meAdmin && a.person !== true) {
      const actions = part("div", "actions", "");
      const remove = part("button", "", "Remove");
      remove.type = "button";
      remove.addEventListener("click", () => openAgentConfirm("remove", name));
      const reset = part("button", "", "Reset key");
      reset.type = "button";
      reset.addEventListener("click", () => openAgentConfirm("key", name));
      actions.append(remove, reset);
      details.append(actions);
    }
    // Opening the details only shows what the answer already holds: it sends nothing and marks nothing read.
    const toggle = (open) => {
      details.hidden = !open;
      button.setAttribute("aria-expanded", open ? "true" : "false");
    };
    toggle(openAgents.has(name));
    button.addEventListener("click", () => {
      if (openAgents.has(name)) {
        openAgents.delete(name);
        // Closing an agent's details ends its confirmation, and drops a new key shown for it.
        if (agentFor?.name === name) closeAgentPanel();
      } else openAgents.add(name);
      toggle(openAgents.has(name));
    });
    li.append(button, details);
    return li;
  });
  if (items.length === 0) items.push(part("li", "note", NO_AGENTS));
  rows.replaceChildren(...items);
  lastAgents = agents;
  people = agents.filter((a) => a.person === true).map((a) => String(a.name));
  mentionable = agents.map((a) => ({ name: String(a.name), person: a.person === true }));
  statuses = new Map(agents.filter((a) => typeof a.status === "string").map((a) => [String(a.name), a.status]));
  showPairStatus();
  showPicker();
  fillNew();
  fillChannel();
  fillLink();
  // An open list follows the answer, so it never offers a name that has gone.
  if (offered.length > 0) offer();
}

// The sidebar key of the open conversation, as sidebarItem takes it, or undefined.
function openKey() {
  if (openChannel !== undefined) return "channel " + openChannel;
  if (openPair !== undefined) return "pair " + openPair;
  if (openDeliveries) return "deliveries";
  if (openApprovals) return "approvals";
  if (openInvites) return "invites";
  if (openWebhooks) return "webhooks";
  if (openTokens) return "tokens";
  return undefined;
}

// A sidebar entry: a button with a label and, after it, a count or an unread badge (end), that opens a conversation.
// Its value is its key, which markOpen compares with openKey().
function sidebarItem(key, label, labelClass, end, open) {
  const button = document.createElement("button");
  button.type = "button";
  button.value = key;
  button.className = key === openKey() ? "item current" : "item";
  if (key === openKey()) button.ariaCurrent = "true";
  button.append(part("span", labelClass ? "label " + labelClass : "label", label), end);
  button.addEventListener("click", open);
  const li = document.createElement("li");
  li.append(button);
  return li;
}

// How many of an entry's total posts or messages this tab has not seen. The open entry has seen them all, and one that
// first appears after the first poll has seen none.
function unread(key, total) {
  shownTotals.set(key, total);
  if (key === openKey()) seen.set(key, total);
  if (!seenAll) return 0;
  if (!seen.has(key)) seen.set(key, 0);
  return total - seen.get(key);
}

// An entry's unread badge, hidden when there is nothing unread.
function badge(count) {
  const node = part("span", "badge", String(count));
  node.hidden = !(count > 0);
  return node;
}

function showChannels(channels) {
  const items = channels.map((c) => {
    const name = String(c.name);
    const key = "channel " + name;
    const li = sidebarItem(key, name, "channel-name", badge(unread(key, c.posts)), () => openLog(name));
    const members = Array.isArray(c.members) ? c.members.map(String).join(", ") : "";
    const last = c.lastPostAt == null ? "no posts" : "last post " + ago(c.lastPostAt);
    li.children[0].title = "Members: " + (members || "–") + "; " + c.posts + " posts, " + last;
    // The open channel's members go in the header too; a channel no longer listed keeps the last ones shown.
    if (name === openChannel) {
      logMembers.textContent = members ? "Members: " + members : "No members yet";
      logMembers.title = logMembers.textContent;
      logMembers.hidden = false;
    }
    return li;
  });
  noChannels = items.length === 0 ? part("li", "note", channelsEmpty()) : undefined;
  if (noChannels) items.push(noChannels);
  channelRows.replaceChildren(...items);
  channelNames = channels.map((c) => String(c.name).toLowerCase());
}

// The two agents of a message, in name order, as one key, so alice to bob and bob to alice are the same pair.
function pairNames(m) {
  return [String(m.from), String(m.to)].sort();
}
function pairKey(m) {
  return JSON.stringify(pairNames(m));
}

// Lists the pairs started with no messages first, the one started last on top, then the rest, the one with the newest
// message first. A started pair takes its place among the rest once its first message comes.
function showPairs() {
  const empty = (pair) => (pair.count === 0 ? pair.made ?? 0 : 0);
  const items = [...pairs].sort((a, b) => empty(b[1]) - empty(a[1]) || b[1].newest - a[1].newest).map(([key, pair]) => {
    const li = sidebarItem("pair " + key, pair.names.join(" ↔ "), "", badge(unread("pair " + key, pair.count)), () =>
      openPairLog(key),
    );
    li.children[0].title = pair.count === 1 ? "1 message" : pair.count + " messages";
    return li;
  });
  pairRows.replaceChildren(...items);
}

// Marks the open channel, pair, webhook deliveries, webhooks, approved clients, tokens or invites in the sidebar, in place, so the button just chosen keeps the focus.
// The open entry's posts or messages all count as seen, so its badge goes.
function markOpen() {
  const key = openKey();
  if (shownTotals.has(key)) seen.set(key, shownTotals.get(key));
  const entries = [...channelRows.children, ...pairRows.children, ...deliveryEntry.children, ...webhookEntry.children, ...approvalEntry.children, ...tokenEntry.children, ...inviteEntry.children];
  for (const li of entries) {
    const button = li.children[0];
    if (!button) continue;
    const current = button.value === key;
    button.className = current ? "item current" : "item";
    button.ariaCurrent = current ? "true" : null;
    const end = button.children[1];
    if (current && end.className === "badge") end.hidden = true;
  }
}

// Appends to the open log and keeps it at the bottom if it was there, so a reader scrolled back up is not moved.
function appendEntries(entries) {
  const atBottom = postRows.scrollHeight - postRows.scrollTop - postRows.clientHeight < 40;
  postRows.append(...entries);
  if (atBottom) postRows.scrollTop = postRows.scrollHeight;
}

function entry(from, tag, sentAt, body, mentions) {
  const li = document.createElement("li");
  li.className = "entry";
  const time = part("time", "time", when(sentAt));
  time.title = String(sentAt);
  li.append(part("span", "from", String(from)));
  if (tag) li.append(part("span", "tag", tag));
  li.append(time, bodyPart(String(body), mentions));
  return li;
}

// Up to two initials from a name: the first letter of its first two parts ("code-reviewer" is "CR"), or of a one-part
// name its first two letters ("alice" is "AL").
function initials(name) {
  const parts = name.split(/[-_]+/).filter(Boolean);
  const letters = parts.length > 1 ? [[...parts[0]][0], [...parts[1]][0]] : [...name].slice(0, 2);
  return letters.join("").toUpperCase();
}

// One of the palette classes c0 to c7, by a hash of the name in lower case, so a name has the same colour on every load.
function colourOf(name) {
  let h = 0;
  for (const c of name.toLowerCase()) h = (Math.imul(h, 31) + c.codePointAt(0)) >>> 0;
  return "c" + (h % 8);
}

function isPerson(name) {
  const lower = name.toLowerCase();
  return people !== undefined && people.some((p) => p.toLowerCase() === lower);
}

// An entry of the open log. One from the sender of the entry before it, sent less than GROUP_MS after it, continues
// that entry's group: it shows no avatar, name or tag of its own. A tagged entry (a broadcast) never continues a group
// or is continued, so its tag always shows. The first entry of a group has an initials avatar in the sender's colour,
// round for a person GET /api/agents gave and rounded-square for anyone else, and a person is labelled as one. A direct
// message, given as message, has a receipt after its time unless its recipient is a person, who has no read_inbox. A
// channel post, given as post, has one when it mentions an agent: one part for each.
function chatEntry(from, tag, sentAt, body, message, post) {
  const name = String(from);
  const at = Date.parse(sentAt);
  const gap = lastEntry === undefined ? NaN : at - lastEntry.at;
  const cont = lastEntry !== undefined && !tag && !lastEntry.tag && lastEntry.from === name.toLowerCase() && gap >= 0 && gap < GROUP_MS;
  lastEntry = { from: name.toLowerCase(), at, tag };
  const li = document.createElement("li");
  li.className = "entry chat " + colourOf(name) + (cont ? " cont" : "");
  const time = part("time", "time", chatTime(sentAt));
  time.title = when(sentAt);
  const due = nextChange(at);
  if (due !== undefined) chatTimes.push([time, sentAt, due]);
  const row = { li, name, tag, person: isPerson(name), time, body: bodyPart(String(body), logMentions) };
  if (message) {
    row.message = message;
    row.toPerson = isPerson(String(message.to));
    row.receipt = part("span", "receipt", receiptText(message));
  }
  if (post && post.mentions.length > 0) {
    row.post = post;
    row.receipt = part("span", "receipt mentions", mentionsText(post.mentions));
  }
  chatRows.push(row);
  li.append(...chatParts(row));
  return li;
}

// A chat row's children: its avatar and name, a person's label, its tag, its time, its receipt and its text.
function chatParts(row) {
  const parts = [part("span", row.person ? "avatar person" : "avatar", initials(row.name)), part("span", "from", row.name)];
  if (row.person) parts.push(part("span", "kind", "person"));
  if (row.tag) parts.push(part("span", "tag", row.tag));
  parts.push(row.time);
  if (row.receipt && !row.toPerson) parts.push(row.receipt);
  parts.push(row.body);
  return parts;
}

// What a direct message's receipt says: whether its recipient has read it with read_inbox, and before that whether a
// webhook has started it.
function receiptText(m) {
  return m.read === true ? "read" : m.starting === true ? "starting…" : "not read yet";
}

// What a post's receipt says: for each agent it mentions, whether that agent has read the mention with read_inbox.
function mentionsText(mentions) {
  return mentions.map((m) => m.name + ": " + receiptText(m)).join(" · ");
}

// A post's mentions as GET /api/channel-posts gives them, each with its name and whether it has been read; any entry
// that is not one is left out.
function mentionsOf(p) {
  const mentions = p && typeof p === "object" && Array.isArray(p.mentions) ? p.mentions : [];
  return mentions
    .filter((m) => m && typeof m === "object" && typeof m.name === "string")
    .map((m) => ({ name: m.name, read: m.read === true }));
}

// The earliest ms chatTime of a time in ms can change at: now for one it shows as relative, a minute before it for one
// more than a minute ahead (a clock behind the server's), when it becomes "just now", the next local midnight for one
// it shows as the time today, and undefined for one it shows as a date or cannot read, which never changes.
function nextChange(at) {
  const now = Date.now();
  if (at - now > 60000) return at - 60000;
  if (now - at < 12 * 3600000) return now;
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return at >= today.getTime() ? midnight.getTime() : undefined;
}

// Once a poll, after show: re-marks the open log's rows when who is a person has changed since they were marked (a
// row's sender, and whether a message's recipient is one and so shows no receipt), and
// rewrites the times that may have changed since they were written, dropping those that never will again.
function refreshChat() {
  const marked = JSON.stringify((people ?? []).map((p) => p.toLowerCase()).sort());
  if (marked !== markedPeople) {
    markedPeople = marked;
    for (const row of chatRows) {
      const person = isPerson(row.name);
      const toPerson = row.message ? isPerson(String(row.message.to)) : undefined;
      if (person === row.person && toPerson === row.toPerson) continue;
      row.person = person;
      row.toPerson = toPerson;
      row.li.replaceChildren(...chatParts(row));
    }
  }
  const now = Date.now();
  const live = [];
  for (const entry of chatTimes) {
    const [node, sentAt, due] = entry;
    if (due <= now) {
      node.textContent = chatTime(sentAt);
      entry[2] = nextChange(Date.parse(sentAt));
    }
    if (entry[2] !== undefined) live.push(entry);
  }
  chatTimes = live;
}

function messageEntry(m) {
  return chatEntry(m.from, m.broadcast ? "broadcast" : "", m.sentAt, m.body, m);
}

// A search result: a message shows its sender and recipient and whether it was a broadcast, a post its sender and channel.
function resultEntry(r) {
  const post = r.kind === "post";
  const li = entry(r.from, r.broadcast ? "broadcast" : "", r.sentAt, r.body, resultMentions);
  li.className = "entry result";
  li.append(post ? part("span", "where channel", String(r.channel)) : part("span", "where", "→ " + String(r.to)));
  return li;
}

// Makes the sidebar's one webhooks entry the first time the channels are shown. It is never made again, so a poll
// never replaces the button and takes its focus; its count is blank until the view is first opened.
function showDeliveryEntry() {
  if (deliveryCount) return;
  deliveryEntry.append(sidebarItem("deliveries", "Webhook deliveries", "", part("span", "count", ""), openDeliveryLog));
  deliveryCount = deliveryEntry.children[0].children[0].children[1];
}

// Makes the sidebar's one approved clients entry the first time the channels are shown, as showDeliveryEntry does.
function showApprovalEntry() {
  if (approvalCount) return;
  const count = part("span", "count", "");
  approvalEntry.append(sidebarItem("approvals", "Approved clients", "", count, openApprovalLog));
  approvalCount = approvalEntry.children[0].children[0].children[1];
}

// An approval: its agent, the token's id, which message-cp token revoke takes, when it was issued, and the client (its
// name, else its metadata host, else "unnamed client"). One that registers its own agents says so in the agent's place
// and lists the agents it registered, or says it has registered none yet. The client chose its name, so it goes in with
// textContent and, as token list prints it, with control and format characters (a newline, a direction override)
// replaced, so it cannot pass for another token's id; the id has its own element. Agent names go in with textContent
// too. Never a token, hash, code or redirect URI, which GET /api/approvals does not give. For an admin person it has
// a Revoke button that asks first. Throws on an entry that is neither shape GET /api/approvals gives, so
// readApprovals shows the answer as unreadable.
function approvalRow(a) {
  const single = a && a.registers === false && typeof a.agent === "string" && a.agents === undefined;
  const registering =
    a && a.registers === true && a.agent === null && Array.isArray(a.agents) && a.agents.every((n) => typeof n === "string");
  if (
    !(single || registering) ||
    !Number.isInteger(a.id) ||
    !(a.clientName === null || typeof a.clientName === "string") ||
    !(a.clientHost === null || typeof a.clientHost === "string") ||
    typeof a.issuedAt !== "string"
  ) {
    throw new TypeError("not an approval");
  }
  const li = document.createElement("li");
  li.className = meAdmin ? "entry approval revocable" : "entry approval";
  const time = part("time", "time", "issued " + when(a.issuedAt));
  time.title = a.issuedAt;
  const client = (a.clientName || a.clientHost || "unnamed client").replace(/[\\p{Cc}\\p{Cf}]/gu, "\\uFFFD");
  const who = single ? a.agent : "registers its own agents";
  li.append(part("span", "from", who), part("span", "tag", "token " + a.id), time, part("div", "body", client));
  if (meAdmin) {
    const button = part("button", "", "Revoke");
    button.type = "button";
    button.setAttribute("aria-label", "Revoke token " + a.id);
    const target = { id: a.id, client, agent: single ? a.agent : undefined, key: JSON.stringify(a) };
    button.addEventListener("click", () => openRevokeApproval(target));
    li.append(button);
  }
  if (registering) {
    li.append(part("div", "agents", a.agents.length > 0 ? "agents: " + a.agents.join(", ") : "has registered no agents yet"));
  }
  return li;
}

// A person of the account: their name and role and, unless they are the token's own person, whom the server never lets
// it unmark or remove, a button to mark or unmark them an admin and a Remove button that asks first. Throws on an entry
// that is not a person, so readPeople shows the answer as unreadable.
function personRow(p) {
  if (!p || typeof p.name !== "string" || typeof p.admin !== "boolean") throw new TypeError("not a person");
  const li = document.createElement("li");
  li.append(part("span", "from", p.name), part("span", "tag", p.admin ? "admin" : "person"));
  if (me === undefined || p.name.toLowerCase() === me.toLowerCase()) {
    li.append(part("span", "note", "you"));
    return li;
  }
  const mark = part("button", "", p.admin ? "Remove admin" : "Make admin");
  mark.type = "button";
  mark.setAttribute("aria-label", (p.admin ? "Remove admin from " : "Make an admin: ") + p.name);
  mark.addEventListener("click", () => markPerson(p.name, !p.admin));
  const remove = part("button", "", "Remove");
  remove.type = "button";
  remove.setAttribute("aria-label", "Remove " + p.name);
  remove.addEventListener("click", () => openRemovePerson(p.name));
  li.append(mark, remove);
  return li;
}

// An unused invite: its person, when it was made and when it expires, and a Cancel button that asks first. Never its
// code, which GET /api/invites does not give. Throws on an entry that is not an invite, so readInvites shows the answer
// as unreadable.
function inviteRow(i) {
  if (!i || !Number.isInteger(i.id) || typeof i.person !== "string" || typeof i.createdAt !== "string" || typeof i.expiresAt !== "string") {
    throw new TypeError("not an invite");
  }
  const li = document.createElement("li");
  li.className = "entry invite";
  const time = part("time", "time", "made " + when(i.createdAt));
  time.title = i.createdAt;
  const button = part("button", "", "Cancel");
  button.type = "button";
  button.setAttribute("aria-label", "Cancel " + i.person + "'s invite");
  const invite = { id: i.id, person: i.person, createdAt: i.createdAt };
  button.addEventListener("click", () => openCancelInvite(invite));
  li.append(part("span", "from", i.person), time, part("div", "body", "expires " + when(i.expiresAt)), button);
  return li;
}

// A webhook: what it fires on, its id, which message-cp webhook remove takes, its URL's origin, and whether it sends the
// text, a header (by name), a per-hour limit and a fixed body, with a Remove button that asks first. Never a secret, a
// header value, a full URL or a body, which GET /api/webhooks does not give. Throws on an entry that is not a webhook, so
// readWebhooks shows the answer as unreadable.
function webhookRow(w) {
  if (
    !w ||
    !Number.isInteger(w.id) ||
    typeof w.on !== "string" ||
    typeof w.origin !== "string" ||
    typeof w.includeText !== "boolean" ||
    !(w.headerName === null || typeof w.headerName === "string") ||
    !(w.maxPerHour === null || Number.isInteger(w.maxPerHour)) ||
    typeof w.fixedBody !== "boolean"
  ) {
    throw new TypeError("not a webhook");
  }
  const li = document.createElement("li");
  li.className = "entry webhook";
  // A fixed body never carries the text.
  const facts = [w.origin, w.fixedBody ? "fixed body, no text" : w.includeText ? "with text" : "no text"];
  facts.push(w.headerName === null ? "no header" : "header " + w.headerName);
  facts.push(w.maxPerHour === null ? "no hourly limit" : "at most " + w.maxPerHour + " per hour");
  const button = part("button", "", "Remove");
  button.type = "button";
  button.setAttribute("aria-label", "Remove webhook " + w.id);
  const hook = { id: w.id, on: w.on, key: JSON.stringify(w) };
  button.addEventListener("click", () => openRemoveWebhook(hook));
  li.append(part("span", "from", w.on), part("span", "tag", "webhook " + w.id), part("div", "body", facts.join(" · ")), button);
  return li;
}

// A token of the account: its kind, its id, which message-cp token revoke takes, and when it was made, then who or what
// it is for: a person token's person, or "person removed"; an agent token's bound agent, "agent removed", "registers its
// own agents", or "bound to no agent"; and an OAuth token's client (its name, else its host, else "unnamed
// client"), with control and format characters replaced as approvalRow does. A Revoke button asks first. Never a token
// or hash, which GET /api/tokens does not give. Throws on an entry that is none of the shapes GET /api/tokens gives, so
// readTokens shows the answer as unreadable.
function tokenRow(t) {
  const nameOrNull = (v) => v === null || typeof v === "string";
  const kind = t && t.kind;
  // A person token names its person, or null once they were removed, and nothing else.
  const personShape = kind === "person" && nameOrNull(t.person) && t.agent === undefined && t.registers === undefined;
  // An agent token names its bound agent (null once removed), or registers its own agents, or is bound to none.
  const agentShape =
    kind === "agent" &&
    t.person === undefined &&
    (t.agent === undefined ? t.registers === undefined || t.registers === true : nameOrNull(t.agent) && t.registers === undefined);
  // A full or read-only token names no one.
  const plainShape = (kind === "full" || kind === "read-only") && t.person === undefined && t.agent === undefined && t.registers === undefined;
  // An OAuth token, of any kind, also has its client's name and host, each null when the client gave none.
  const client = t && t.client;
  const clientShape = client === undefined || (client !== null && typeof client === "object" && nameOrNull(client.name) && nameOrNull(client.host));
  if (!(personShape || agentShape || plainShape) || !clientShape || !Number.isInteger(t.id) || typeof t.createdAt !== "string") {
    throw new TypeError("not a token");
  }
  const facts = [];
  if (kind === "person") facts.push(t.person === null ? "person removed" : t.person);
  else if (kind === "agent") {
    facts.push(t.registers ? "registers its own agents" : t.agent === null ? "agent removed" : t.agent === undefined ? "bound to no agent" : t.agent);
  }
  if (client) facts.push("client " + (client.name || client.host || "unnamed client").replace(/[\\p{Cc}\\p{Cf}]/gu, "\\uFFFD"));
  const li = document.createElement("li");
  li.className = "entry token";
  const time = part("time", "time", "made " + when(t.createdAt));
  time.title = t.createdAt;
  const button = part("button", "", "Revoke");
  button.type = "button";
  button.setAttribute("aria-label", "Revoke token " + t.id);
  const target = {
    id: t.id,
    label: [kind, ...facts].join(", "),
    mine: kind === "person" && typeof t.person === "string" && me !== undefined && t.person.toLowerCase() === me.toLowerCase(),
    key: JSON.stringify(t),
  };
  button.addEventListener("click", () => openRevokeToken(target));
  li.append(part("span", "from", kind), part("span", "tag", "token " + t.id), time);
  if (facts.length > 0) li.append(part("div", "body", facts.join(" · ")));
  li.append(button);
  return li;
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
  // What the open log shows counts as seen, even a post that came after GET /api/channels answered.
  const key = "channel " + openChannel;
  seen.set(key, Math.max(seen.get(key) ?? 0, held));
  appendEntries(posts.map((p) => chatEntry(p.from, "", p.sentAt, p.body, undefined, { id: p.id, mentions: mentionsOf(p) })));
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
  if (openPair !== undefined) {
    const shown = page.filter((m) => pairKey(m) === openPair).map(messageEntry);
    if (shown.length > 0) logNote.textContent = "";
    appendEntries(shown);
  }
  if (page.length > 0) {
    showPairs();
    showDelete();
  }
}

function when(iso) {
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : String(iso);
}

// A link from message-cp login-link carries a one-time code in its fragment, which a browser never sends in a request.
// It leaves the address bar before anything else, so a reload never sends it again; a page opened without one starts
// as before. A link opened in a tab already showing the dashboard changes only the fragment and does not load the page
// again, so hashchange takes its code the same way, and login() forgets the token the tab held.
function takeLoginCode() {
  const code = new URLSearchParams(location.hash.slice(1)).get("code");
  if (code === null) return false;
  history.replaceState(null, "", location.pathname + location.search);
  login(code);
  return true;
}
addEventListener("hashchange", () => takeLoginCode());
if (!takeLoginCode()) {
  if (sessionStorage.getItem(KEY)) start();
  else ask();
}
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
<button id="signout-retry" type="button" hidden>Sign out again</button>
<form id="login" hidden>
<h1>message-cp</h1>
<label for="token">Token</label>
<input id="token" type="password" autocomplete="off" required>
<button type="submit">Log in</button>
</form>
<div id="view" hidden>
<header class="bar">
<button id="show-sidebar" class="toggle" type="button" aria-label="Channels and conversations" aria-expanded="false" aria-controls="sidebar">☰</button>
<h1><svg class="mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path class="bubble" d="M8 4h16a6 6 0 0 1 6 6v8a6 6 0 0 1-6 6H14l-7 5v-5.2A6 6 0 0 1 2 18v-8a6 6 0 0 1 6-6z"/><path class="lines" d="M9 12.5h14v2.5H9zm0 5h9v2.5H9z"/></svg>message-cp</h1>
<form id="search" role="search">
<input id="search-text" type="search" maxlength="400" required aria-label="Search messages and posts" placeholder="Search messages and posts" autocomplete="off">
<button type="submit">Search</button>
</form>
<button id="show-agents" class="toggle" type="button" aria-expanded="false" aria-controls="agents">Agents</button>
<button id="forget" type="button">Forget token</button>
</header>
<nav id="sidebar" aria-label="Channels and conversations">
<div class="section-head">
<h2>Channels</h2>
<button id="new-channel" type="button" aria-expanded="false" aria-controls="channel-form" hidden>New channel</button>
</div>
<form id="channel-form" aria-label="New channel" hidden>
<p id="channel-note" class="note" role="status"></p>
<div id="channel-fields">
<label for="channel-from">From</label>
<select id="channel-from"></select>
<label for="channel-name">Name</label>
<input id="channel-name" type="text" maxlength="32" autocomplete="off" spellcheck="false">
<label for="channel-body">First post</label>
<textarea id="channel-body" rows="3" autocomplete="off"></textarea>
</div>
<div class="actions">
<button id="channel-create" type="submit">Create</button>
<button id="channel-cancel" type="button">Cancel</button>
</div>
</form>
<ul id="channel-rows"></ul>
<div class="section-head">
<h2>Direct messages</h2>
<button id="new-message" type="button" aria-expanded="false" aria-controls="new-form" hidden>New message</button>
</div>
<form id="new-form" aria-label="New message" hidden>
<p id="new-note" class="note"></p>
<div id="new-fields">
<label for="new-from">From</label>
<select id="new-from"></select>
<label for="new-to">To</label>
<select id="new-to"></select>
</div>
<div class="actions">
<button id="new-open" type="submit">Open</button>
<button id="new-cancel" type="button">Cancel</button>
</div>
</form>
<p id="messages-note" class="note"></p>
<ul id="pair-rows"></ul>
<h2>Webhooks</h2>
<ul id="delivery-entry"></ul>
<ul id="webhook-entry"></ul>
<h2>Clients</h2>
<ul id="approval-entry"></ul>
<ul id="token-entry"></ul>
<h2 id="people-head" hidden>People</h2>
<ul id="invite-entry"></ul>
</nav>
<main id="chat">
<section id="log" hidden>
<div class="log-head">
<div class="log-name">
<h2 id="log-title"></h2>
<p id="log-members" class="note" hidden></p>
<p id="log-status" class="note" hidden></p>
</div>
<p id="delete-note" class="note" role="status"></p>
<div id="delete-confirm" role="group" aria-labelledby="delete-text" hidden>
<span id="delete-text"></span>
<button id="delete-yes" type="button">Delete</button>
<button id="delete-no" type="button">Cancel</button>
</div>
<button id="delete-pair" type="button" hidden>Delete</button>
<button id="close-log" type="button">Close</button>
</div>
<div id="invite-forms" hidden>
<div id="people-list" role="group" aria-labelledby="people-title">
<h3 id="people-title">People</h3>
<p id="people-read" class="note"></p>
<ul id="people-rows"></ul>
<div id="remove-confirm" role="group" aria-labelledby="remove-text" hidden>
<p id="remove-text"></p>
<button id="remove-yes" type="button">Remove</button>
<button id="remove-no" type="button">Keep them</button>
</div>
<p id="people-note" class="note" role="status"></p>
</div>
<form id="person-form" aria-labelledby="person-title">
<h3 id="person-title">Add person</h3>
<p id="person-note" class="note" role="status"></p>
<label for="person-name">Name</label>
<input id="person-name" type="text" maxlength="32" autocomplete="off" spellcheck="false">
<label for="person-kind">Role</label>
<select id="person-kind"><option value="plain">Person</option><option value="admin">Admin</option></select>
<div class="actions"><button id="person-add" type="submit">Add person</button></div>
</form>
<form id="link-form" aria-labelledby="link-title">
<h3 id="link-title">New link for a person</h3>
<p id="link-note" class="note" role="status"></p>
<label for="link-person">Person</label>
<select id="link-person"></select>
<div class="actions"><button id="link-make" type="submit">New link</button></div>
</form>
<div id="invite-made" hidden>
<p id="invite-for"></p>
<input id="invite-link" type="text" readonly aria-label="Invite link" autocomplete="off" spellcheck="false">
<button id="invite-copy" type="button">Copy</button>
<span id="copy-note" class="note" role="status"></span>
</div>
<div id="cancel-confirm" role="group" aria-labelledby="cancel-text" hidden>
<p id="cancel-text"></p>
<button id="cancel-yes" type="button">Cancel invite</button>
<button id="cancel-no" type="button">Keep it</button>
</div>
<p id="cancel-note" class="note" role="status"></p>
<h3 id="invites-title">Unused invites</h3>
</div>
<div id="webhook-forms" hidden>
<form id="webhook-add-form" aria-labelledby="hook-title">
<h3 id="hook-title">Add a webhook</h3>
<p id="hook-note" class="note" role="status"></p>
<div class="field"><label for="hook-url">URL</label>
<input id="hook-url" type="text" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://example.com/hook"></div>
<div class="field"><label for="hook-on">Fires on</label>
<input id="hook-on" type="text" autocomplete="off" spellcheck="false" placeholder="#general" aria-describedby="hook-on-hint">
<span id="hook-on-hint" class="note">#&lt;channel&gt;, mention:&lt;agent&gt; or agent:&lt;agent&gt;</span></div>
<label class="check"><input id="hook-text" type="checkbox" checked> Send the message text</label>
<div class="field"><label for="hook-header-name">Header name (optional)</label>
<input id="hook-header-name" type="text" autocomplete="off" spellcheck="false" placeholder="Authorization"></div>
<div class="field"><label for="hook-header-value">Header value (optional)</label>
<input id="hook-header-value" type="password" autocomplete="off" spellcheck="false"></div>
<div class="field"><label for="hook-max">At most … per hour (optional)</label>
<input id="hook-max" type="number" min="1" step="1" inputmode="numeric" autocomplete="off"></div>
<div class="field wide"><label for="hook-body">Fixed body (optional)</label>
<textarea id="hook-body" rows="2" autocomplete="off" spellcheck="false" placeholder='{"requestId":"{{delivery}}"}' aria-describedby="hook-body-hint"></textarea>
<span id="hook-body-hint" class="note">A JSON object sent in place of the event, with {{delivery}} once in a string value; it never carries the text.</span></div>
<div class="actions"><button id="hook-add" type="submit">Add webhook</button></div>
</form>
<div id="webhook-made" hidden>
<p id="webhook-for"></p>
<input id="webhook-secret" type="text" readonly aria-label="Webhook secret" autocomplete="off" spellcheck="false">
<button id="webhook-copy" type="button">Copy</button>
<span id="webhook-copy-note" class="note" role="status"></span>
</div>
</div>
<div id="webhook-confirm" role="group" aria-labelledby="webhook-text" hidden>
<p id="webhook-text"></p>
<button id="webhook-yes" type="button">Remove webhook</button>
<button id="webhook-no" type="button">Keep it</button>
</div>
<p id="webhook-note" class="note" role="status"></p>
<div id="approval-confirm" role="group" aria-labelledby="approval-text" hidden>
<p id="approval-text"></p>
<button id="approval-yes" type="button">Revoke client</button>
<button id="approval-no" type="button">Keep it</button>
</div>
<p id="approval-note" class="note" role="status"></p>
<div id="token-forms" hidden>
<form id="token-form" aria-labelledby="token-title">
<h3 id="token-title">Make a token</h3>
<label for="token-kind">Kind</label>
<select id="token-kind"><option value="read-only">Read-only</option><option value="agent">Agent</option></select>
<button id="token-make" type="submit">Make token</button>
</form>
<p id="token-make-note" class="note" role="status"></p>
<div id="token-made" hidden>
<p id="token-for"></p>
<input id="token-value" type="text" readonly aria-label="New token" autocomplete="off" spellcheck="false">
<button id="token-copy" type="button">Copy</button>
<span id="token-copy-note" class="note" role="status"></span>
</div>
</div>
<div id="token-confirm" role="group" aria-labelledby="token-text" hidden>
<p id="token-text"></p>
<button id="token-yes" type="button">Revoke token</button>
<button id="token-no" type="button">Keep it</button>
</div>
<p id="token-note" class="note" role="status"></p>
<p id="log-note" class="note"></p>
<ol id="post-rows" role="log"></ol>
<div id="writer" hidden>
<p id="as-note" class="note"></p>
<ul id="mentions" role="listbox" aria-label="Agents and people to mention" hidden></ul>
<form id="compose" hidden>
<label id="compose-label" for="compose-text"></label>
<textarea id="compose-text" rows="2" required autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="mentions" placeholder="Enter sends, Shift+Enter adds a line"></textarea>
<button id="compose-send" type="submit">Send</button>
</form>
<p id="compose-note" class="note" role="status"></p>
</div>
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
<h2 id="agents-head" tabindex="-1">Agents</h2>
<p id="agent-note" class="note" role="status"></p>
<div id="agent-confirm" role="group" aria-labelledby="agent-confirm-text" hidden>
<p id="agent-confirm-text"></p>
<button id="agent-yes" type="button">Remove</button>
<button id="agent-no" type="button">Cancel</button>
</div>
<div id="agent-key-made" hidden>
<p id="agent-key-for"></p>
<input id="agent-key" type="text" readonly aria-label="New agent key" autocomplete="off" spellcheck="false">
<button id="agent-key-copy" type="button">Copy</button>
<button id="agent-key-done" type="button">Done</button>
<span id="agent-copy-note" class="note" role="status"></span>
</div>
<ul id="rows"></ul>
</aside>
</div>
<script>${SCRIPT}</script>
</body>
</html>
`;

/** Headers for GET /: the inline style and script run by hash, every request and font stays on this origin, and nothing frames it. */
export const DASHBOARD_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": [
    "default-src 'none'",
    `script-src ${hash(SCRIPT)}`,
    `style-src ${hash(STYLE)}`,
    "connect-src 'self'",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};
