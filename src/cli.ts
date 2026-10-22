#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { DEFAULT_HTTP_HOST, DEFAULT_HTTP_PORT, startHttp } from "./http.js";
import { KeyResetError, PersonError, PurgeError, addPerson, listPeople, purgeAgent, removePerson, resetAgentKey } from "./agents.js";
import { AccountError, addAccount, addToken, listAccounts, revokeToken } from "./accounts.js";
import { OWNER_ACCOUNT, openDb } from "./db.js";
import { hasUnread, unreadSummary } from "./messages.js";
import { setting } from "./settings.js";
import { formatUnread } from "./wait.js";
import { WebhookError, addWebhook, formatOn, listWebhooks, removeWebhook, webhookMaxPerHour } from "./webhooks.js";

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
      "usage: message-cp account add <name> | message-cp account list | message-cp token add <account> [--read-only] | message-cp token revoke <token id>",
    );
    process.exit(2);
  };
  const [action, arg, extra, ...more] = rest;
  // Only `token add <account>` takes a flag: --read-only, for a token that can only read.
  const readOnly = command === "token" && action === "add" && extra === "--read-only";
  if ((extra !== undefined && !readOnly) || more.length > 0) usage();
  const db = openDb();
  const printToken = (t: { id: number; account: string; token: string; readOnly: boolean }) => {
    const kind = t.readOnly ? "read-only token" : "token";
    console.error(`message-cp: ${kind} ${t.id} for account '${t.account}'. It is shown only now; keep it.`);
    console.log(t.token);
  };
  try {
    if (command === "account" && action === "add" && arg) printToken(addAccount(db, arg));
    else if (command === "account" && action === "list" && arg === undefined) {
      for (const a of listAccounts(db)) {
        console.log(`${a.name}\tcreated ${a.createdAt}\ttokens: ${a.tokenIds.length ? a.tokenIds.join(", ") : "none"}`);
      }
    } else if (command === "token" && action === "add" && arg && !arg.startsWith("--")) printToken(addToken(db, arg, readOnly));
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
} else if (command === "webhook") {
  // Run on the server, like `account` and `token`. A new webhook's secret is printed this once, to stdout; everything
  // else goes to stderr, except `list`, which never prints a secret. `--header-stdin` reads the header line from stdin,
  // so its value is never in an argument list, and the value is never printed. Nor is a `--body`.
  const usage = () => {
    console.error(
      "usage: message-cp webhook add --url <url> --on <#channel | mention:<agent> | agent:<agent>> [--account <name>] [--no-text] [--header-stdin] [--max-per-hour <n>] [--body <json>] | message-cp webhook list [--account <name>] | message-cp webhook remove <webhook id>",
    );
    process.exit(2);
  };
  const [action, ...args] = rest;
  const valued = action === "add" ? ["--url", "--on", "--account", "--max-per-hour", "--body"] : action === "list" ? ["--account"] : [];
  const opts = new Map<string, string>();
  let noText = false;
  let headerStdin = false;
  if (action === "add" || action === "list") {
    for (let i = 0; i < args.length; i++) {
      const name = args[i]!;
      if (action === "add" && name === "--no-text" && !noText) {
        noText = true;
        continue;
      }
      if (action === "add" && name === "--header-stdin" && !headerStdin) {
        headerStdin = true;
        continue;
      }
      const value = args[++i];
      if (!valued.includes(name) || opts.has(name) || !value || value.startsWith("--")) usage();
      opts.set(name, value!);
    }
  }
  const db = openDb();
  try {
    if (action === "add" && opts.has("--url") && opts.has("--on")) {
      const account = opts.get("--account") ?? "owner";
      const max = opts.get("--max-per-hour");
      const maxPerHour = max === undefined ? undefined : webhookMaxPerHour(max);
      let header: string | undefined;
      if (headerStdin) {
        // One line, with at most one trailing newline; checked in addWebhook, which never repeats the value.
        const lines = readFileSync(0, "utf8").replace(/\r?\n$/, "").split(/\r?\n/);
        if (lines.filter((l) => l !== "").length > 1) throw new WebhookError("--header-stdin takes one line '<Name>: <value>'.");
        header = lines.find((l) => l !== "") ?? "";
        if (header === "") throw new WebhookError("--header-stdin read nothing: give one line '<Name>: <value>' on stdin.");
      }
      const w = addWebhook(db, account, opts.get("--url")!, opts.get("--on")!, !noText, header, maxPerHour, opts.get("--body"));
      console.error(`message-cp: webhook ${w.id} for account '${w.account}'. Its secret is shown only now; keep it.`);
      console.log(w.secret);
    } else if (action === "list") {
      for (const w of listWebhooks(db, opts.get("--account"))) {
        const header = w.headerName === null ? "" : `\theader: ${w.headerName}`;
        const max = w.maxPerHour === null ? "" : `\tmax: ${w.maxPerHour}/hour`;
        const body = w.fixedBody ? "\tbody: fixed" : "";
        console.log(`${w.id}\t${w.account}\t${w.url}\t${formatOn(w)}\t${w.includeText ? "text" : "no text"}${header}${max}${body}`);
      }
    } else if (action === "remove" && args.length === 1) {
      const arg = args[0]!;
      const id = Number(arg);
      if (!/^[0-9]+$/.test(arg) || !Number.isSafeInteger(id)) usage();
      console.error(`message-cp: removed webhook ${id} of account '${removeWebhook(db, id)}'.`);
    } else usage();
  } catch (err) {
    if (!(err instanceof WebhookError)) throw err;
    console.error(`message-cp: ${err.message}`);
    process.exit(1);
  }
  db.close();
} else if (command === "person") {
  // Run on the server, like `webhook`. A person has no key or token, so nothing secret is printed.
  const usage = () => {
    console.error(
      "usage: message-cp person add <name> [--account <name>] | message-cp person remove <name> [--account <name>] | message-cp person list [--account <name>]",
    );
    process.exit(2);
  };
  const [action, ...args] = rest;
  const named = action === "add" || action === "remove";
  const name = named ? args.shift() : undefined;
  if ((!named && action !== "list") || (named && (!name || name.startsWith("--")))) usage();
  const opts = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const option = args[i]!;
    const value = args[i + 1];
    if (option !== "--account" || opts.has(option) || !value || value.startsWith("--")) usage();
    opts.set(option, value!);
  }
  const db = openDb();
  try {
    if (action === "add") {
      const p = addPerson(db, opts.get("--account") ?? "owner", name!);
      console.error(`message-cp: person '${p.name}' in account '${p.account}'. Agents there can message and @mention them.`);
    } else if (action === "remove") {
      const p = removePerson(db, opts.get("--account") ?? "owner", name!);
      console.error(
        `message-cp: removed person '${p.name}' of account '${p.account}', with ${p.messages} direct message(s) and ${p.mentions} mention(s). The name is free.`,
      );
    } else {
      for (const p of listPeople(db, opts.get("--account"))) console.log(`${p.name}\t${p.account}\tadded ${p.addedAt}`);
    }
  } catch (err) {
    if (!(err instanceof PersonError)) throw err;
    console.error(`message-cp: ${err.message}`);
    process.exit(1);
  }
  db.close();
} else if (command === "agent") {
  // Run on the server, like `person`. `remove` prints only names and counts, never a message body or a key. `key reset`
  // prints the new key this once, to stdout, and only names to stderr; it never prints the old key or a hash.
  const usage = () => {
    console.error("usage: message-cp agent remove <name> [--account <name>] | message-cp agent key reset <name> [--account <name>]");
    process.exit(2);
  };
  const reset = rest[0] === "key" && rest[1] === "reset";
  const [action, name, ...args] = reset ? ["key reset", ...rest.slice(2)] : rest;
  if ((action !== "remove" && !reset) || !name || name.startsWith("--")) usage();
  const opts = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const option = args[i]!;
    const value = args[i + 1];
    if (option !== "--account" || opts.has(option) || !value || value.startsWith("--")) usage();
    opts.set(option, value!);
  }
  const db = openDb();
  try {
    if (reset) {
      const k = resetAgentKey(db, opts.get("--account") ?? "owner", name!);
      console.error(
        `message-cp: new key for agent '${k.name}' of account '${k.account}'. It is shown only now; keep it. The old key no longer works.`,
      );
      console.log(k.key);
    } else {
      const p = purgeAgent(db, opts.get("--account") ?? "owner", name!);
      console.error(
        `message-cp: removed agent '${p.name}' of account '${p.account}', with ${p.messages} direct message(s) and ${p.mentions} mention(s). The name is free.`,
      );
    }
  } catch (err) {
    if (!(err instanceof PurgeError) && !(err instanceof KeyResetError)) throw err;
    console.error(`message-cp: ${err.message}`);
    process.exit(1);
  }
  db.close();
} else if (command === undefined) {
  await import("./index.js");
} else {
  console.error(`message-cp: unknown command '${command}'. Commands: serve, wait, account, token, webhook, person, agent`);
  process.exit(2);
}
