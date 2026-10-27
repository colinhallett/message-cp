import { createHash } from "node:crypto";
import { STYLE } from "./dashboard.js";
import { isLoopback, isMetadataUrl, type Authorization } from "./oauth.js";

// The page a person approves an MCP client on, served at the authorization endpoint of `serve --public-url` without a
// token, in the dashboard's look. It asks for a full or person token of the account and the agent the client should act
// as, and sends them once to POST /oauth/approve; it keeps the token only in the form field, never in storage. On
// approval it goes to the address the server answers with, the client's redirect URI with a code; refusing goes to the
// redirect URI with error=access_denied. Client-supplied text is put on the page HTML-escaped by the server, never as markup.

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
`;

const SCRIPT = `
"use strict";
const TIMEOUT_MS = 15000;
const form = document.getElementById("approve");
const token = document.getElementById("approve-token");
const agent = document.getElementById("approve-agent");
const yes = document.getElementById("approve-yes");
const no = document.getElementById("approve-no");
const note = document.getElementById("approve-note");
let busy = false;
function say(text, error) {
  note.textContent = text;
  note.classList.toggle("error", error);
}
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  yes.disabled = true;
  say("Approving…", false);
  const ac = new AbortController();
  const deadline = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let res;
  let answer;
  try {
    // Relative to this page, /oauth/authorize under the public URL, so it stays under the public URL's path.
    res = await fetch("approve", {
      method: "POST",
      headers: { Authorization: "Bearer " + token.value.trim(), "Content-Type": "application/json" },
      body: JSON.stringify({ request: form.dataset.request, state: form.dataset.state === undefined ? null : form.dataset.state, agent: agent.value.trim() }),
      cache: "no-store",
      credentials: "omit",
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
  if (res.status === 401) return say("The server refused that token. Enter a full or person token of the account.", true);
  if (res.status === 403) return say("Only a full or person token can approve a client; agent and read-only tokens cannot.", true);
  say(answer && typeof answer.message === "string" ? answer.message : "The server could not approve this (" + res.status + "). Try again.", true);
});
no.addEventListener("click", () => location.assign(no.dataset.location));
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
<form id="approve" data-request="${escape(a.request)}"${state}>
<label for="approve-token">Full or person token of the account</label>
<input id="approve-token" type="password" autocomplete="off" required>
<label for="approve-agent">Agent name</label>
<input id="approve-agent" type="text" autocomplete="off" required maxlength="32" pattern="[A-Za-z0-9_\\-]{1,32}" placeholder="for example claude-desktop">
<p class="dim">A new name makes that agent; an existing agent's name connects the client as it, leaving its key and sessions alone.</p>
<div class="actions">
<button id="approve-yes" type="submit">Approve</button>
<button id="approve-no" type="button" data-location="${escape(deny)}">Refuse</button>
</div>
<p id="approve-note" class="note" role="status"></p>
</form>
<script>${SCRIPT}</script>`);
}
