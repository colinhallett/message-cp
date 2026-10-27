import { createHash } from "node:crypto";
import { STYLE } from "./dashboard.js";
import { agentNameBase, isLoopback, isMetadataUrl, type Authorization } from "./oauth.js";

// The page a person approves an MCP client on, served at the authorization endpoint of `serve --public-url` without a
// token, in the dashboard's look. It first asks GET /oauth/signin whether this browser is signed in to the dashboard
// (the sign-in cookie, which no page script can read). Signed in, it says who approves ("Approving as maria"), hides the
// token field and offers an agent name no live agent of the account has, made from the client's name, so one click
// approves; POST /oauth/approve then carries no token and the server signs it in by the cookie. Not signed in, it links
// to the dashboard in a new tab, checks again when the page regains focus or on "Check again", and meanwhile asks for a
// full or person token of the account, sent once in the Authorization header and kept only in the form field, never in
// storage. On approval it goes to the address the server answers with, the client's redirect URI with a code; refusing
// goes to the redirect URI with error=access_denied. Client-supplied text is put on the page HTML-escaped by the server,
// never as markup, and the server's answers with textContent.

const PAGE_STYLE = `${STYLE}
main { margin: 10vh auto var(--s4); width: min(32rem, 100% - 2 * var(--s4)); display: flex; flex-direction: column; gap: var(--s3); }
main h1 { display: flex; align-items: center; gap: var(--s2); }
main h2, main p { margin: 0; }
.client { font-family: var(--font-mono); font-weight: 600; overflow-wrap: anywhere; }
.warn { padding: var(--s2) var(--s3); background: var(--error-bg); color: var(--error); border-radius: var(--radius); }
#approve { display: flex; flex-direction: column; gap: var(--s1); }
#approve input { width: 100%; padding: var(--s2); margin-bottom: var(--s2); background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); }
.actions { display: flex; gap: var(--s2); }
#approve-yes { background: var(--accent); border-color: var(--accent); color: var(--bg); font-weight: 600; }
#approve-yes:hover:enabled { background: color-mix(in srgb, var(--accent) 85%, var(--text)); }
#approve-note.error { color: var(--error); }
#signed-in { font-weight: 600; }
`;

const SCRIPT = `
"use strict";
const TIMEOUT_MS = 15000;
const form = document.getElementById("approve");
const token = document.getElementById("approve-token");
const tokenField = document.getElementById("token-field");
const signedIn = document.getElementById("signed-in");
const signedOut = document.getElementById("signed-out");
const again = document.getElementById("signin-again");
const agent = document.getElementById("approve-agent");
const yes = document.getElementById("approve-yes");
const no = document.getElementById("approve-no");
const note = document.getElementById("approve-note");
let busy = false;
// Whether the last GET /oauth/signin found a sign-in, and the agent name it offered, if any.
let cookie = false;
let suggested;
// Bumped by each check, so only the newest check's answer changes the page.
let checks = 0;
function say(text, error) {
  note.textContent = text;
  note.classList.toggle("error", error);
}
// Shows the page signed in as who, or, for undefined, signed out with the token field.
function show(who) {
  cookie = who !== undefined;
  signedIn.textContent = cookie ? who : "";
  signedIn.hidden = !cookie;
  signedOut.hidden = cookie;
  tokenField.hidden = cookie;
  token.required = !cookie;
  if (cookie) token.value = "";
}
// Asks GET /oauth/signin, relative to this page as approve is, who this browser is signed in to the dashboard as. An
// answer that comes after a newer check, or while an approval is in flight, is dropped; no answer leaves the page as it is.
async function check() {
  const n = ++checks;
  const ac = new AbortController();
  const deadline = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let res;
  let answer;
  try {
    res = await fetch("signin?" + new URLSearchParams({ base: form.dataset.base }), {
      cache: "no-store",
      credentials: "same-origin",
      referrerPolicy: "no-referrer",
      signal: ac.signal,
    });
    answer = await res.json().catch(() => undefined);
  } catch {
    res = undefined;
  } finally {
    clearTimeout(deadline);
  }
  if (n !== checks || busy || !res) return;
  if (res.ok && answer && typeof answer.account === "string") {
    show(typeof answer.person === "string" ? "Approving as " + answer.person : "Approving with a full token of account " + answer.account);
    if (typeof answer.name === "string" && (agent.value.trim() === "" || agent.value.trim() === suggested)) {
      agent.value = answer.name;
      suggested = answer.name;
    }
  } else if (res.status === 401 || res.status === 403) {
    show(undefined);
  }
}
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  checks++;
  yes.disabled = true;
  say("Approving…", false);
  const ac = new AbortController();
  const deadline = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const signed = cookie;
  const name = agent.value.trim();
  let res;
  let answer;
  try {
    // Relative to this page, /oauth/authorize under the public URL, so it stays under the public URL's path. Signed in,
    // it sends no token, and the server reads the sign-in cookie; otherwise only the typed token, and no cookie.
    res = await fetch("approve", {
      method: "POST",
      headers: signed ? { "Content-Type": "application/json" } : { Authorization: "Bearer " + token.value.trim(), "Content-Type": "application/json" },
      body: JSON.stringify({
        request: form.dataset.request,
        state: form.dataset.state === undefined ? null : form.dataset.state,
        agent: name,
        fresh: suggested !== undefined && name === suggested,
      }),
      cache: "no-store",
      credentials: signed ? "same-origin" : "omit",
      referrerPolicy: "no-referrer",
      signal: ac.signal,
    });
    answer = await res.json().catch(() => undefined);
  } catch {
    res = undefined;
  } finally {
    clearTimeout(deadline);
  }
  busy = false;
  yes.disabled = false;
  if (res && res.ok && answer && typeof answer.location === "string") {
    token.value = "";
    say("Approved. Returning to the client…", false);
    return location.assign(answer.location);
  }
  if (!res) return say("The server did not answer. Try again.", true);
  if (signed && (res.status === 401 || res.status === 403)) {
    show(undefined);
    return say("This browser is no longer signed in. Sign in on the dashboard and check again, or enter a full or person token of the account.", true);
  }
  if (res.status === 401) return say("The server refused that token. Enter a full or person token of the account.", true);
  if (res.status === 403) return say("Only a full or person token can approve a client; agent and read-only tokens cannot.", true);
  say(answer && typeof answer.message === "string" ? answer.message : "The server could not approve this (" + res.status + "). Try again.", true);
});
no.addEventListener("click", () => location.assign(no.dataset.location));
again.addEventListener("click", () => check());
// Coming back from signing in on the dashboard in another tab checks again.
addEventListener("focus", () => check());
check();
`;

const hash = (text: string) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

/** Headers for the approval and error pages: the inline style and script run by hash, and nothing frames them. */
export const APPROVE_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": [
    "default-src 'none'",
    `script-src ${hash(SCRIPT)}`,
    `style-src ${hash(PAGE_STYLE)}`,
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

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const MARK =
  '<svg class="mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path class="bubble" d="M8 4h16a6 6 0 0 1 6 6v8a6 6 0 0 1-6 6H14l-7 5v-5.2A6 6 0 0 1 2 18v-8a6 6 0 0 1 6-6z"/><path class="lines" d="M9 12.5h14v2.5H9zm0 5h9v2.5H9z"/></svg>';

const page = (body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect a client · message-cp</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
<h1>${MARK}message-cp</h1>
${body}
</main>
</body>
</html>
`;

/** The page shown instead of the approval page for a request that cannot be sent back to its client. */
export const errorPage = (message: string) => page(`<p role="alert">${escape(message)}</p>`);

/**
 * The approval page for `a`. `deny` is where refusing goes: the redirect URI with error=access_denied and the state.
 * It shows the client's name as it registered it, or as its metadata document gives it with the host of that document's
 * URL, and the redirect URI's host, and warns when that host is this machine.
 */
export function approvePage(a: Authorization, deny: string): string {
  const host = new URL(a.redirectUri).host;
  const loopback = isLoopback(new URL(a.redirectUri));
  const name = a.client.clientName ? escape(a.client.clientName) : "An unnamed client";
  // A client known by its metadata document's URL is named with that URL's host, which this server fetched it from.
  const from = isMetadataUrl(a.client.clientId) ? new URL(a.client.clientId).host : undefined;
  const who = `<span class="client">${name}</span>${from === undefined ? "" : `, from <span class="client">${escape(from)}</span>,`}`;
  const state = a.state === null ? "" : ` data-state="${escape(a.state)}"`;
  return page(`<h2>Connect a client</h2>
<p>${who} asks to act as an agent of your account. Once you approve, it is sent to <span class="client">${escape(host)}</span> with a code it exchanges for an agent token.</p>
${
  loopback
    ? `<p class="warn">That address is on the machine the client runs on. Approve only if you just started connecting from a client on this machine: any program running there could have asked.</p>`
    : ""
}
<p class="dim">${from === undefined ? "The name is the client's own; this server has not checked it." : `The name is the client's own; this server has checked only that its description is at ${escape(from)}.`}</p>
<form id="approve" data-request="${escape(a.request)}"${state} data-base="${escape(agentNameBase(a.client.clientName))}">
<p id="signed-in" role="status" hidden></p>
<div id="signed-out">
<p>This browser is not signed in to message-cp. <a href="../" target="_blank" rel="noopener">Sign in on the dashboard</a> in a new tab, which leaves this page open, then come back here or <button id="signin-again" type="button">Check again</button>. Or enter a token below.</p>
</div>
<div id="token-field">
<label for="approve-token">Full or person token of the account</label>
<input id="approve-token" type="password" autocomplete="off" required>
</div>
<label for="approve-agent">Agent name</label>
<input id="approve-agent" type="text" autocomplete="off" required maxlength="32" pattern="[A-Za-z0-9_\\-]{1,32}" placeholder="for example claude-desktop">
<p class="dim">A new name makes that agent; an existing agent's name, typed in, connects the client as it, leaving its key and sessions alone. A suggested name is never an existing agent's.</p>
<div class="actions">
<button id="approve-yes" type="submit">Approve</button>
<button id="approve-no" type="button" data-location="${escape(deny)}">Refuse</button>
</div>
<p id="approve-note" class="note" role="status"></p>
</form>
<script>${SCRIPT}</script>`);
}
