#!/usr/bin/env node
import { DEFAULT_HTTP_HOST, DEFAULT_HTTP_PORT, startHttp } from "./http.js";
import { openDb } from "./db.js";
import { loadConfig } from "./hive/config.js";
import { startHive } from "./hive/hive.js";
import { unreadSummary } from "./messages.js";

const [command, ...rest] = process.argv.slice(2);

if (command === "hive") {
  const flag = rest.indexOf("--config");
  const path = flag >= 0 ? rest[flag + 1] : undefined;
  if (!path) {
    console.error("usage: memory-cp hive --config <hive.json>");
    process.exit(2);
  }
  const hive = startHive(openDb(), loadConfig(path));
  const shutdown = () => {
    console.error("memory-cp hive: stopping, waiting for running agents");
    void hive.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} else if (command === "serve") {
  const flag = (name: string) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const token = process.env.MEMORY_CP_HTTP_TOKEN;
  if (!token) {
    console.error("memory-cp serve: set MEMORY_CP_HTTP_TOKEN to a non-empty value; every request must carry it.");
    process.exit(2);
  }
  const portText = rest.includes("--port") ? flag("--port") : undefined;
  const port = rest.includes("--port") ? Number(portText || NaN) : DEFAULT_HTTP_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535 || (rest.includes("--host") && !flag("--host"))) {
    console.error("usage: memory-cp serve [--host <address>] [--port <port>]");
    process.exit(2);
  }
  const host = flag("--host") ?? DEFAULT_HTTP_HOST;
  const http = await startHttp(openDb(), { token, host, port });
  console.error(`memory-cp serve: listening on http://${host}:${http.port}/mcp`);
  const shutdown = () => void http.close().then(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} else if (command === "wait") {
  const name = rest[0];
  if (!name) {
    console.error("usage: memory-cp wait <name>");
    process.exit(2);
  }
  const db = openDb();
  for (;;) {
    let unread;
    try {
      unread = unreadSummary(db, name);
    } catch (err) {
      // A lock held past the busy timeout is transient: try again at the next check.
      const code = (err as { code?: unknown } | null)?.code;
      if (typeof code !== "string" || !code.startsWith("SQLITE_BUSY")) throw err;
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    if (!unread) {
      console.error(`memory-cp wait: no agent named '${name}'.`);
      process.exit(1);
    }
    if (unread.count > 0) {
      // Exit from the write callback so a piped stdout is flushed before the process ends.
      const err = await new Promise<Error | null | undefined>((r) =>
        process.stdout.write(
          `${unread.count} unread ${unread.count === 1 ? "message" : "messages"} from ${unread.senders.join(", ")}\n`,
          r,
        ),
      );
      // A summary that was not delivered must not look like a successful wake-up.
      if (err) console.error(`memory-cp wait: could not write the summary: ${err.message}`);
      process.exit(err ? 1 : 0);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
} else if (command === undefined) {
  await import("./index.js");
} else {
  console.error(`memory-cp: unknown command '${command}'. Commands: hive, serve, wait`);
  process.exit(2);
}
