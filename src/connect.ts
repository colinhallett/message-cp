import { addToken } from "./accounts.js";
import { registerWithIdentity, resetAgentKey, validateName } from "./agents.js";
import type { AccountId, Db } from "./db.js";
import { shellQuote } from "./wait.js";

// `message-cp connect`: what a client needs to act as one agent of an account over HTTP, made in one step on the
// server. The token and key are returned for the CLI to print once, to stdout; only their hashes are stored.

export class ConnectError extends Error {}

/**
 * The public URL `raw` clients reach the server at, parsed with `new URL()`: https, or http only for a literal loopback
 * address (127.x.x.x or [::1], not `localhost`), with no username, password, query or fragment, since a token is sent to
 * it. `connect --url` and `serve --public-url` both check it here.
 */
export function publicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConnectError(`--url is not a URL: give the server's public address, for example https://message-cp.example.com.`);
  }
  const loopback = /^127(\.\d{1,3}){3}$/.test(url.hostname) || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new ConnectError("--url must be https (plain http only for 127.x.x.x or [::1]): the token would cross the network in the clear.");
  }
  // `href` keeps an empty `?` or `#`, which `search` and `hash` report as "".
  if (url.username || url.password || url.href.includes("?") || url.href.includes("#")) {
    throw new ConnectError("--url must not carry a username, password, query or fragment.");
  }
  return url;
}

/** The `/mcp` endpoint for the public URL `raw`, checked by `publicUrl`. A trailing `/mcp` is the same as none. */
export function mcpEndpoint(raw: string): URL {
  const url = publicUrl(raw);
  const endpoint = new URL(url.href);
  // Set as the path, never resolved as a reference, so no path can change the host.
  endpoint.pathname = `${url.pathname.replace(/\/+$/, "").replace(/\/mcp$/, "")}/mcp`;
  return endpoint;
}

export interface Connection {
  /** The agent's name as stored. */
  name: string;
  account: string;
  /** False for a new agent, true for an existing one whose key was reset. */
  reset: boolean;
  key: string;
  tokenId: number;
  token: string;
}

/**
 * Makes the account's agent `name` with a new key, or, with `newKey`, gives its existing agent of that name (any case) a
 * new key as `resetAgentKey` does, ending its sessions; then makes an agent token for the account. One transaction:
 * `registerWithIdentity`, `resetAgentKey` and `addToken` run inside it as savepoints, so a failure leaves no agent, key
 * or token behind. Refuses, changing nothing, an unknown account, an invalid name, a person's name, and an existing
 * agent without `newKey`, since its key is stored only as a hash and cannot be shown again.
 */
export const connectAgent = (db: Db, account: string, name: string, newKey: boolean): Connection =>
  db.transaction((): Connection => {
    const acct = db.prepare("SELECT id, name FROM accounts WHERE name = ?").get(account) as { id: AccountId; name: string } | undefined;
    if (!acct) throw new ConnectError(`No account named '${account}'.`);
    validateName(name);
    const live = db
      .prepare("SELECT id, name, person FROM agents WHERE account_id = ? AND name = ? AND removed_at IS NULL")
      .get(acct.id, name) as { id: number; name: string; person: number } | undefined;
    if (live?.person === 1) throw new ConnectError(`The name '${live.name}' belongs to a person, not an agent.`);
    if (live && !newKey) {
      throw new ConnectError(
        `Agent '${live.name}' of account '${acct.name}' already exists. Its key is stored only as a hash, so it cannot be shown again; pass --new-key to give it a new one, which ends its current sessions.`,
      );
    }
    let agent: { name: string; key: string };
    if (live) agent = resetAgentKey(db, acct.name, live.name);
    else {
      const { result } = registerWithIdentity(db, acct.id, name);
      agent = { name: result.name, key: result.key! };
    }
    const token = addToken(db, acct.name, false, true);
    return { name: agent.name, account: acct.name, reset: live !== undefined, key: agent.key, tokenId: token.id, token: token.token };
  }).immediate();

/** The two things `connect` prints: a `claude mcp add` command, then the same server as a JSON `mcpServers` entry. */
export function clientSetup(endpoint: URL, c: Pick<Connection, "name" | "key" | "token">): string {
  const headers = {
    Authorization: `Bearer ${c.token}`,
    "X-Message-CP-Agent": c.name,
    "X-Message-CP-Agent-Key": c.key,
  };
  const command = [
    "claude mcp add --transport http message-cp",
    shellQuote(endpoint.href),
    ...Object.entries(headers).map(([k, v]) => `--header ${shellQuote(`${k}: ${v}`)}`),
  ].join(" ");
  const json = JSON.stringify({ mcpServers: { "message-cp": { type: "http", url: endpoint.href, headers } } }, null, 2);
  return `${command}\n\n${json}\n`;
}
