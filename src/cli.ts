#!/usr/bin/env node
import { DEFAULT_HTTP_HOST, DEFAULT_HTTP_PORT, startHttp } from "./http.js";
import { AccountError, addAccount, addToken, listAccounts, revokeToken } from "./accounts.js";
import { OWNER_ACCOUNT, openDb } from "./db.js";
import { hasUnread, unreadSummary } from "./messages.js";
import { setting } from "./settings.js";
import { formatUnread } from "./wait.js";

const [command, ...rest] = process.argv.slice(2);

if (command === "serve") {
  const usage = () => {
    console.error("usage: message-cp serve [--host <address>] [--port <port>] [--public-url <url>]");
    process.exit(2);
  };
  const opts = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i];
    const value = rest[i + 1];
    if ((name !== "--host" && name !== "--port" && name !== "--public-url") || opts.has(name) || !value || value.startsWith("--")) usage();
    opts.set(name, value!);
  }
  const token = setting("HTTP_TOKEN");
  if (!token) {
    console.error("message-cp serve: set MESSAGE_CP_HTTP_TOKEN to a non-empty value; every request must carry it.");
    process.exit(2);
  }
  const port = opts.has("--port") ? Number(opts.get("--port")) : DEFAULT_HTTP_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) usage();
  const host = opts.get("--host") ?? DEFAULT_HTTP_HOST;
  const publicUrl = opts.get("--public-url");
  if (publicUrl !== undefined && (!/^https?:\/\/[^\s'?#]+$/.test(publicUrl) || /\/mcp\/*$/.test(publicUrl))) usage();
  const http = await startHttp(openDb(), { token, host, port, publicUrl });
  console.error(`message-cp serve: listening on http://${host}:${http.port}/mcp`);
  const shutdown = () => void http.close().then(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} else if (command === "wait") {
  const name = rest[0];
  if (!name) {
    console.error("usage: message-cp wait <name>");
    process.exit(2);
  }
  const db = openDb();
  for (;;) {
    let unread;
    try {
      // `wait` reads the database file directly, so it is the owner's account, like stdio.
      unread = unreadSummary(db, OWNER_ACCOUNT, name);
    } catch (err) {
      // A lock held past the busy timeout is transient: try again at the next check.
      const code = (err as { code?: unknown } | null)?.code;
      if (typeof code !== "string" || !code.startsWith("SQLITE_BUSY")) throw err;
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    if (!unread) {
      console.error(`message-cp wait: no agent named '${name}'.`);
      process.exit(1);
    }
    if (hasUnread(unread)) {
      // Exit from the write callback so a piped stdout is flushed before the process ends.
      const err = await new Promise<Error | null | undefined>((r) =>
        process.stdout.write(
          `${formatUnread(unread)}\n`,
          r,
        ),
      );
      // A summary that was not delivered must not look like a successful wake-up.
      if (err) console.error(`message-cp wait: could not write the summary: ${err.message}`);
      process.exit(err ? 1 : 0);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
} else if (command === "account" || command === "token") {
  // Run on the server, against the database serve uses. A new token is printed this once, to stdout, and only its
  // hash is stored; everything else goes to stderr.
  const usage = () => {
    console.error(
      "usage: message-cp account add <name> | message-cp account list | message-cp token add <account> | message-cp token revoke <token id>",
    );
    process.exit(2);
  };
  const [action, arg, extra] = rest;
  if (extra !== undefined) usage();
  const db = openDb();
  const printToken = (t: { id: number; account: string; token: string }) => {
    console.error(`message-cp: token ${t.id} for account '${t.account}'. It is shown only now; keep it.`);
    console.log(t.token);
  };
  try {
    if (command === "account" && action === "add" && arg) printToken(addAccount(db, arg));
    else if (command === "account" && action === "list" && arg === undefined) {
      for (const a of listAccounts(db)) {
        console.log(`${a.name}\tcreated ${a.createdAt}\ttokens: ${a.tokenIds.length ? a.tokenIds.join(", ") : "none"}`);
      }
    } else if (command === "token" && action === "add" && arg) printToken(addToken(db, arg));
    else if (command === "token" && action === "revoke" && arg) {
      const id = Number(arg);
      if (!/^[0-9]+$/.test(arg) || !Number.isSafeInteger(id)) usage();
      console.error(`message-cp: revoked token ${id} of account '${revokeToken(db, id)}'.`);
    } else usage();
  } catch (err) {
    if (!(err instanceof AccountError)) throw err;
    console.error(`message-cp: ${err.message}`);
    process.exit(1);
  }
  db.close();
} else if (command === undefined) {
  await import("./index.js");
} else {
  console.error(`message-cp: unknown command '${command}'. Commands: serve, wait, account, token`);
  process.exit(2);
}
