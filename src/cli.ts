#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { DEFAULT_HTTP_HOST, DEFAULT_HTTP_PORT, startHttp } from "./http.js";
import { AgentListError, KeyResetError, PersonError, PurgeError, ToolError, addPerson, listPeople, listServerAgents, purgeAgent, removePerson, resetAgentKey } from "./agents.js";
import { AccountError, addAccount, addToken, listAccounts, listTokens, revokeToken, type NewToken } from "./accounts.js";
import { ConnectError, clientSetup, connectAgent, mcpEndpoint, publicUrl as checkedPublicUrl } from "./connect.js";
import { OWNER_ACCOUNT, openDb } from "./db.js";
import { CLIENT_IDS, InitError, askOnTerminal, ownServer, proveRemote, proveServer, readConnectFile, realRunner, runInit, type ClientId, type Remote } from "./init.js";
import { hasUnread, unreadSummary } from "./messages.js";
import { setting } from "./settings.js";
import { formatUnread } from "./wait.js";
import { WebhookError, addWebhook, formatOn, listWebhooks, removeWebhook, webhookMaxPerHour } from "./webhooks.js";

// Each command's usage, printed by its own usage error and, all together, by `message-cp help`.
const USAGE = {
  serve: "message-cp serve [--host <address>] [--port <port>] [--public-url <url>]",
  wait: "message-cp wait <name>",
  account: "message-cp account add <name> | message-cp account list | message-cp token add <account> [--read-only | --agent-only] | message-cp token list | message-cp token revoke <token id>",
  webhook: "message-cp webhook add --url <url> --on <#channel | mention:<agent> | agent:<agent>> [--account <name>] [--no-text] [--header-stdin] [--max-per-hour <n>] [--body <json>] | message-cp webhook list [--account <name>] | message-cp webhook remove <webhook id>",
  person: "message-cp person add <name> [--account <name>] | message-cp person remove <name> [--account <name>] | message-cp person list [--account <name>]",
  agent: "message-cp agent list [--account <name>] | message-cp agent remove <name> [--account <name>] | message-cp agent key reset <name> [--account <name>]",
  connect: "message-cp connect <agent> --url <public url> [--account <name>] [--new-key]",
  init: `message-cp init [--client <${CLIENT_IDS.join("|")}>] [--url <public url> --agent <name> | --from <file connect wrote>] (with --url, the token from MESSAGE_CP_HTTP_TOKEN and the key from MESSAGE_CP_AGENT_KEY)`,
};

const [command, ...rest] = process.argv.slice(2);

if (command === "serve") {
  const usage = () => {
    console.error(`usage: ${USAGE.serve}`);
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
  if (publicUrl !== undefined) {
    let url: URL;
    try {
      url = checkedPublicUrl(publicUrl);
    } catch (err) {
      if (!(err instanceof ConnectError)) throw err;
      usage();
    }
    // The address without /mcp, which httpWaitCommand builds /wait on.
    if (/\/mcp\/*$/.test(url!.pathname)) usage();
  }
  const http = await startHttp(openDb(), { token, host, port, publicUrl });
  console.error(`message-cp serve: listening on http://${host}:${http.port}/mcp`);
  const shutdown = () => void http.close().then(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} else if (command === "wait") {
  const name = rest[0];
  if (!name) {
    console.error(`usage: ${USAGE.wait}`);
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
  // hash is stored; everything else goes to stderr, except `list`, which never prints a token or a hash.
  const usage = () => {
    console.error(`usage: ${USAGE.account}`);
    process.exit(2);
  };
  const [action, arg, extra, ...more] = rest;
  // Only `token add <account>` takes a flag: --read-only, for a token that can only read, or --agent-only, for one that
  // cannot act as a person.
  const tokenAdd = command === "token" && action === "add";
  const readOnly = tokenAdd && extra === "--read-only";
  const agentOnly = tokenAdd && extra === "--agent-only";
  if ((extra !== undefined && !readOnly && !agentOnly) || more.length > 0) usage();
  const db = openDb();
  const printToken = (t: NewToken) => {
    const kind = t.readOnly ? "read-only token" : t.agentOnly ? "agent token" : "token";
    console.error(`message-cp: ${kind} ${t.id} for account '${t.account}'. It is shown only now; keep it.`);
    console.log(t.token);
  };
  try {
    if (command === "account" && action === "add" && arg) printToken(addAccount(db, arg));
    else if (command === "account" && action === "list" && arg === undefined) {
      for (const a of listAccounts(db)) {
        console.log(`${a.name}\tcreated ${a.createdAt}\ttokens: ${a.tokenIds.length ? a.tokenIds.join(", ") : "none"}`);
      }
    } else if (command === "token" && action === "add" && arg && !arg.startsWith("--")) {
      printToken(addToken(db, arg, readOnly, agentOnly));
    } else if (command === "token" && action === "list" && arg === undefined) {
      for (const t of listTokens(db)) console.log(`${t.id}\t${t.account}\t${t.kind}\tcreated ${t.createdAt}`);
    } else if (command === "token" && action === "revoke" && arg) {
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
    console.error(`usage: ${USAGE.webhook}`);
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
    console.error(`usage: ${USAGE.person}`);
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
  // prints the new key this once, to stdout, and only names to stderr; it never prints the old key or a hash. `list`
  // prints names, accounts and times, never a key or a hash.
  const usage = () => {
    console.error(`usage: ${USAGE.agent}`);
    process.exit(2);
  };
  const reset = rest[0] === "key" && rest[1] === "reset";
  const list = rest[0] === "list";
  const [action, name, ...args] = reset ? ["key reset", ...rest.slice(2)] : list ? ["list", undefined, ...rest.slice(1)] : rest;
  if (!list && ((action !== "remove" && !reset) || !name || name.startsWith("--"))) usage();
  const opts = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const option = args[i]!;
    const value = args[i + 1];
    if (option !== "--account" || opts.has(option) || !value || value.startsWith("--")) usage();
    opts.set(option, value!);
  }
  let db: ReturnType<typeof openDb> | undefined;
  try {
    db = openDb();
    if (list) {
      for (const a of listServerAgents(db, opts.get("--account"))) {
        console.log(`${a.name}\t${a.account}\tregistered ${a.registeredAt}\tlast seen ${a.lastSeen}`);
      }
    } else if (reset) {
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
    // A reset that could not take the write lock changed nothing: say so in one line, never with a stack trace.
    const code = (err as { code?: unknown } | null)?.code;
    if (reset && typeof code === "string" && code.startsWith("SQLITE_BUSY")) {
      console.error("message-cp: the database is busy; nothing was changed. Try again.");
      process.exit(1);
    }
    if (!(err instanceof PurgeError) && !(err instanceof KeyResetError) && !(err instanceof AgentListError)) throw err;
    console.error(`message-cp: ${err.message}`);
    process.exit(1);
  }
  db.close();
} else if (command === "connect") {
  // Run on the server, like `agent`. The token and the agent's key are printed this once, to stdout, inside the client
  // setup; stderr says what was made and how to revoke the token, and never carries a token, a key or a hash.
  const usage = () => {
    console.error(`usage: ${USAGE.connect}`);
    process.exit(2);
  };
  const [name, ...args] = rest;
  if (!name || name.startsWith("--")) usage();
  const opts = new Map<string, string>();
  let newKey = false;
  for (let i = 0; i < args.length; i++) {
    const option = args[i]!;
    if (option === "--new-key" && !newKey) {
      newKey = true;
      continue;
    }
    const value = args[++i];
    if ((option !== "--url" && option !== "--account") || opts.has(option) || !value || value.startsWith("--")) usage();
    opts.set(option, value!);
  }
  if (!opts.has("--url")) usage();
  let db: ReturnType<typeof openDb> | undefined;
  try {
    // The URL first, so a refused one changes nothing.
    const endpoint = mcpEndpoint(opts.get("--url")!);
    db = openDb();
    const c = connectAgent(db, opts.get("--account") ?? "owner", name!, newKey);
    console.error(
      c.reset
        ? `message-cp: new key for agent '${c.name}' of account '${c.account}'; its old key no longer works and its current sessions have ended.`
        : `message-cp: agent '${c.name}' in account '${c.account}'.`,
    );
    console.error(
      `message-cp: agent token ${c.tokenId} for account '${c.account}'. The output holds this token and the agent's key, shown only now; keep them. To revoke the token: message-cp token list, then message-cp token revoke ${c.tokenId}.`,
    );
    console.log(clientSetup(endpoint, c).replace(/\n$/, ""));
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code === "string" && code.startsWith("SQLITE_BUSY")) {
      console.error("message-cp: the database is busy; nothing was changed. Try again.");
      process.exit(1);
    }
    if (!(err instanceof ConnectError) && !(err instanceof ToolError) && !(err instanceof KeyResetError) && !(err instanceof AccountError)) throw err;
    console.error(`message-cp: ${err.message}`);
    process.exit(1);
  }
  db.close();
} else if (command === "init") {
  // Run on the machine the coding agent runs on. Adds the stdio server, or with --from or --url and --agent the team
  // server, to one client's user-level configuration and checks it with a test agent that is removed afterwards; nothing
  // it prints holds a token or key, which come only from the environment or the file `connect` wrote, never from a flag
  // that shell history would keep.
  const usage = () => {
    console.error(`usage: ${USAGE.init}`);
    process.exit(2);
  };
  const opts = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const option = rest[i]!;
    const value = rest[i + 1];
    if (!["--client", "--url", "--agent", "--from"].includes(option) || opts.has(option) || !value || value.startsWith("--")) usage();
    if (option === "--client" && !CLIENT_IDS.includes(value as ClientId)) usage();
    opts.set(option, value!);
  }
  if (opts.has("--url") !== opts.has("--agent")) usage();
  if (opts.has("--from") && opts.has("--url")) usage();
  const client = opts.get("--client") as ClientId | undefined;
  let remote: Remote | undefined;
  if (opts.has("--from")) {
    try {
      remote = readConnectFile(opts.get("--from")!);
    } catch (err) {
      if (!(err instanceof InitError)) throw err;
      console.error(`message-cp init: ${err.message}`);
      process.exit(1);
    }
  } else if (opts.has("--url")) {
    let endpoint: URL;
    try {
      endpoint = mcpEndpoint(opts.get("--url")!);
    } catch (err) {
      if (!(err instanceof ConnectError)) throw err;
      console.error(`message-cp init: ${err.message} Nothing was changed.`);
      process.exit(2);
    }
    const token = process.env.MESSAGE_CP_HTTP_TOKEN;
    const key = process.env.MESSAGE_CP_AGENT_KEY;
    if (!token || !key) {
      console.error(`message-cp init: with --url, set ${!token ? "MESSAGE_CP_HTTP_TOKEN to the agent token" : "MESSAGE_CP_AGENT_KEY to the agent's key"} (both as \`message-cp connect\` printed them). Nothing was changed.`);
      console.error(`usage: ${USAGE.init}`);
      process.exit(2);
    }
    remote = { endpoint, agent: opts.get("--agent")!, token, key };
  }
  process.exitCode = await runInit({
    client,
    remote,
    machine: { home: homedir(), path: process.env.PATH ?? "", platform: process.platform, appData: process.env.APPDATA },
    run: realRunner,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    ask: askOnTerminal,
    prove: () => (remote === undefined ? proveServer(ownServer()) : proveRemote(remote)),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
} else if (command === undefined) {
  await import("./index.js");
} else if (command === "help" || command === "--help") {
  // With no command, message-cp runs the stdio server, so help names that too.
  console.log(
    ["usage: message-cp              runs the stdio MCP server", ...Object.values(USAGE).flatMap((u) => u.split(" | message-cp ").map((line, i) => `       ${i ? "message-cp " : ""}${line}`))].join("\n"),
  );
} else {
  console.error(`message-cp: unknown command '${command}'. Commands: serve, wait, account, token, webhook, person, agent, connect, init, help`);
  process.exit(2);
}
