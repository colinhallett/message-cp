import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { PurgeError, purgeAgent } from "./agents.js";
import { dbPath, openDb } from "./db.js";

// `message-cp init`: adds the stdio server `npx -y message-cp` to one coding agent's user-level MCP configuration on
// this machine, then proves the server works by registering a test agent, sending it a message and reading it back.
// It never prints a token or key: the test agent's key is made here, stays in memory, and the agent is purged after.

export class InitError extends Error {}

export const CLIENT_IDS = ["claude-code", "codex", "cursor", "claude-desktop"] as const;
export type ClientId = (typeof CLIENT_IDS)[number];

export const CLIENT_NAMES: Record<ClientId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  "claude-desktop": "Claude Desktop",
};

const SERVER_NAME = "message-cp";
const SERVER_COMMAND = "npx";
const SERVER_ARGS = ["-y", "message-cp"];
/** What to run by hand when no client is found, or to add the server to Claude Code yourself. */
export const MANUAL_ADD = "claude mcp add message-cp -- npx -y message-cp";

/** Where `init` looks: the user's home, `PATH`, the platform, and on Windows `%APPDATA%`. */
export interface Machine {
  home: string;
  path: string;
  platform: NodeJS.Platform;
  appData?: string;
}

/** The result of running a command: its exit status (null if it could not be started) and output. */
export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
/** Runs `command` with an argument array, never through a shell string. */
export type Runner = (command: string, args: string[]) => RunResult;

/** Whether an executable named `command` is in one of `path`'s directories (with a `PATHEXT` extension on Windows). */
export function onPath(command: string, path: string, platform: NodeJS.Platform = process.platform): boolean {
  const exts = platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  return path
    .split(platform === "win32" ? ";" : delimiter)
    .filter(Boolean)
    .some((dir) =>
      exts.some((ext) => {
        try {
          const file = join(dir, command + ext);
          accessSync(file, platform === "win32" ? constants.F_OK : constants.X_OK);
          return statSync(file).isFile();
        } catch {
          return false;
        }
      }),
    );
}

/**
 * Claude Desktop's configuration directory, where its docs put `claude_desktop_config.json`: `~/Library/Application
 * Support/Claude` on macOS and `%APPDATA%\Claude` on Windows. Its docs give none for Linux, so there it is undefined.
 */
export function claudeDesktopDir(m: Machine): string | undefined {
  if (m.platform === "darwin") return join(m.home, "Library", "Application Support", "Claude");
  if (m.platform === "win32") return join(m.appData ?? join(m.home, "AppData", "Roaming"), "Claude");
  return undefined;
}

/** The JSON file `init` edits for Cursor or Claude Desktop. */
export function configFile(client: "cursor" | "claude-desktop", m: Machine): string {
  return client === "cursor" ? join(m.home, ".cursor", "mcp.json") : join(claudeDesktopDir(m)!, "claude_desktop_config.json");
}

/** The clients installed for this user, in `CLIENT_IDS` order. */
export function detectClients(m: Machine): ClientId[] {
  const desktop = claudeDesktopDir(m);
  const found: Record<ClientId, boolean> = {
    "claude-code": onPath("claude", m.path, m.platform),
    codex: onPath("codex", m.path, m.platform),
    cursor: existsSync(join(m.home, ".cursor")),
    "claude-desktop": desktop !== undefined && existsSync(desktop),
  };
  return CLIENT_IDS.filter((c) => found[c]);
}

export type SetUpState = "added" | "present" | "differs";

/**
 * Adds `message-cp` to the `mcpServers` of the JSON file `file`, keeping every other key and server, and writes it back
 * in place (a new file is created 0600). A `message-cp` entry already there is left as it is: "present" if it runs
 * `npx -y message-cp`, "differs" otherwise. Refuses, changing nothing, a file that is not a JSON object or whose
 * `mcpServers` is not one.
 */
export function mergeServer(file: string): SetUpState {
  let config: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      config = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw new InitError(`${file} is not valid JSON; it was left unchanged. Fix or move it, then run message-cp init again.`);
    }
  }
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObject(config)) throw new InitError(`${file} does not hold a JSON object; it was left unchanged.`);
  const servers = config.mcpServers ?? {};
  if (!isObject(servers)) throw new InitError(`${file} has an mcpServers that is not a JSON object; it was left unchanged.`);
  const entry = servers[SERVER_NAME];
  if (entry !== undefined) {
    const same =
      isObject(entry) && entry.command === SERVER_COMMAND && JSON.stringify(entry.args) === JSON.stringify(SERVER_ARGS);
    return same ? "present" : "differs";
  }
  config.mcpServers = { ...servers, [SERVER_NAME]: { command: SERVER_COMMAND, args: SERVER_ARGS } };
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return "added";
}

/** The `claude` or `codex` command that adds, shows or removes the user-level server. */
export const cliCommands = {
  "claude-code": {
    command: "claude",
    add: ["mcp", "add", "--scope", "user", SERVER_NAME, "--", SERVER_COMMAND, ...SERVER_ARGS],
    get: ["mcp", "get", SERVER_NAME],
    remove: ["mcp", "remove", "--scope", "user", SERVER_NAME],
  },
  codex: {
    command: "codex",
    add: ["mcp", "add", SERVER_NAME, "--", SERVER_COMMAND, ...SERVER_ARGS],
    get: ["mcp", "get", SERVER_NAME, "--json"],
    remove: ["mcp", "remove", SERVER_NAME],
  },
};

/** Whether `get`'s output describes a stdio server that runs `npx -y message-cp`. */
function runsPackage(client: "claude-code" | "codex", stdout: string): boolean {
  if (client === "codex") {
    try {
      const t = JSON.parse(stdout).transport;
      return t?.type === "stdio" && t.command === SERVER_COMMAND && JSON.stringify(t.args) === JSON.stringify(SERVER_ARGS);
    } catch {
      return false;
    }
  }
  const field = (name: string) => new RegExp(`^\\s*${name}: (.*)$`, "m").exec(stdout)?.[1]?.trim();
  return field("Type") === "stdio" && field("Command") === SERVER_COMMAND && field("Args") === SERVER_ARGS.join(" ");
}

const failed = (r: RunResult, what: string) => {
  const detail = (r.stderr || r.stdout).trim().split("\n").pop();
  return new InitError(`${what} failed${r.status === null ? " to start" : ` (exit ${r.status})`}${detail ? `: ${detail}` : ""}.`);
};

/** What `init` did for one client: the file or command it changed, and how to undo it. */
export interface SetUp {
  client: ClientId;
  state: SetUpState;
  /** What it changed: "in <file>" or "with `<command>`" (or would have, if the server was already there). */
  changed: string;
  undo: string;
}

/**
 * Adds the server to `client`'s user-level configuration, unless a `message-cp` entry is already there. Claude Code and
 * Codex go through their own `mcp get` (exit 1 when there is no such server) and `mcp add`; Cursor and Claude Desktop
 * through `mergeServer`.
 */
export function setUpClient(client: ClientId, m: Machine, run: Runner): SetUp {
  if (client === "cursor" || client === "claude-desktop") {
    const file = configFile(client, m);
    const state = mergeServer(file);
    return { client, state, changed: `in ${file}`, undo: `delete the "${SERVER_NAME}" entry under "mcpServers" in ${file}` };
  }
  const c = cliCommands[client];
  const undo = [c.command, ...c.remove].join(" ");
  const target = [c.command, ...c.add].join(" ");
  const got = run(c.command, c.get);
  const changed = `with \`${target}\``;
  if (got.status === 0) return { client, state: runsPackage(client, got.stdout) ? "present" : "differs", changed, undo };
  if (got.status !== 1) throw failed(got, [c.command, ...c.get].join(" "));
  const added = run(c.command, c.add);
  if (added.status !== 0) throw failed(added, target);
  return { client, state: "added", changed, undo };
}

/**
 * Runs `claude` and `codex` from an empty temporary directory, so `mcp get` sees the user-level server and not a
 * project's `.mcp.json` or local entry for the directory `init` happens to run in.
 */
export const realRunner: Runner = (command, args) => {
  const cwd = mkdtempSync(join(tmpdir(), "message-cp-init-"));
  try {
    // `claude` and `codex` are `.cmd` files on Windows, which only a shell can start; the arguments are fixed words.
    const r = spawnSync(command, args, { cwd, encoding: "utf8", shell: process.platform === "win32", timeout: 60_000 });
    return { status: r.error ? null : r.status, stdout: r.stdout ?? "", stderr: r.stderr || (r.error?.message ?? "") };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
};

/** The stdio server of the package running `init`: `npx -y message-cp` resolves only once the package is published. */
export const ownServer = (): { command: string; args: string[] } => ({
  command: process.execPath,
  args: [fileURLToPath(new URL("./index.js", import.meta.url))],
});

const CALL_TIMEOUT_MS = 15_000;

/**
 * Starts `server` over stdio with `env` and the database `dbPath(env)`, registers a test agent with a random name in the
 * owner account, sends it a message from itself and reads it back. The test agent and its messages are then purged with
 * `purgeAgent` from the same database, even when a step failed. Throws an error naming the failed step; no message
 * carries the agent's key.
 */
export async function proveServer(server: { command: string; args: string[] }, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const db = dbPath(env);
  const name = `init-check-${randomBytes(4).toString("hex")}`;
  // Made here, so register returns no key, and the agent can be removed even if register's reply was lost.
  const key = randomBytes(24).toString("hex");
  const body = `message-cp init check ${name}`;
  // The child acts only as the test agent: an agent named in the environment would be registered by the server first.
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && k !== "MESSAGE_CP_AGENT" && k !== "MESSAGE_CP_AGENT_KEY") childEnv[k] = v;
  childEnv.MESSAGE_CP_DB = db;

  const client = new Client({ name: "message-cp-init", version: "1.0.0" });
  let failure: unknown;
  try {
    await client.connect(new StdioClientTransport({ ...server, env: childEnv, stderr: "pipe" }), { timeout: CALL_TIMEOUT_MS });
    const call = async (tool: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({ name: tool, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS })) as {
        isError?: boolean;
        content?: { text?: string }[];
      };
      const text = result.content?.[0]?.text ?? "";
      if (result.isError) throw new Error(`${tool} returned an error: ${text.slice(0, 200)}`);
      return JSON.parse(text);
    };
    await call("register", { name, bio: "message-cp init check; removed when the check ends", key });
    await call("send_message", { to: name, body });
    const inbox = (await call("read_inbox", {})) as { from?: string; body?: string }[];
    if (!inbox.some((m) => m.from === name && m.body === body)) throw new Error("read_inbox did not return the message just sent");
  } catch (err) {
    failure = err;
  } finally {
    await client.close().catch(() => {});
  }
  let cleanup: unknown;
  try {
    const conn = openDb(db);
    try {
      purgeAgent(conn, "owner", name);
    } catch (err) {
      // Not registered: there is nothing to remove.
      if (!(err instanceof PurgeError)) throw err;
    } finally {
      conn.close();
    }
  } catch (err) {
    cleanup = err;
  }
  const say = (err: unknown) => (err instanceof Error ? err.message : String(err)).replaceAll(key, "<redacted>");
  if (failure !== undefined || cleanup !== undefined) {
    const parts = [];
    if (failure !== undefined) parts.push(say(failure));
    if (cleanup !== undefined) parts.push(`could not remove the test agent '${name}' (${say(cleanup)}); remove it with: message-cp agent remove ${name}`);
    throw new InitError(parts.join("; "));
  }
}

export interface InitOptions {
  /** From `--client`; without it, `init` sets up the one client found, or asks on a terminal. */
  client?: ClientId;
  machine: Machine;
  run: Runner;
  /** Whether stdin and stdout are a terminal, so `init` may ask which client. */
  interactive: boolean;
  ask: (question: string) => Promise<string>;
  prove: () => Promise<void>;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** `message-cp init`: returns the exit code, 0 only when the client is set up and the check passed. */
export async function runInit(o: InitOptions): Promise<number> {
  const found = detectClients(o.machine);
  const names = (ids: ClientId[]) => ids.map((c) => CLIENT_NAMES[c]).join(", ");
  if (found.length === 0) {
    o.err("message-cp init: found none of Claude Code, Codex, Cursor or Claude Desktop. Nothing was changed.");
    o.err(`To add message-cp to Claude Code by hand: ${MANUAL_ADD}`);
    return 1;
  }
  o.out(`message-cp init: found ${names(found)}.`);
  let client = o.client;
  if (client !== undefined) {
    if (!found.includes(client)) {
      o.err(`message-cp init: ${CLIENT_NAMES[client]} was not found on this machine. Nothing was changed.`);
      return 1;
    }
  } else if (found.length === 1) {
    client = found[0]!;
  } else if (!o.interactive) {
    o.err("message-cp init: more than one client was found, so choose one with --client:");
    for (const c of found) o.err(`  message-cp init --client ${c}`);
    o.err("Nothing was changed.");
    return 1;
  } else {
    found.forEach((c, i) => o.out(`  ${i + 1}) ${CLIENT_NAMES[c]}`));
    const answer = (await o.ask(`Set up which? [1-${found.length}] `)).trim();
    const n = Number(answer);
    if (!/^[0-9]+$/.test(answer) || n < 1 || n > found.length) {
      o.err(`message-cp init: '${answer}' is not one of 1-${found.length}. Nothing was changed.`);
      return 1;
    }
    client = found[n - 1]!;
  }

  let setUp: SetUp;
  try {
    setUp = setUpClient(client, o.machine, o.run);
  } catch (err) {
    if (!(err instanceof InitError)) throw err;
    o.err(`message-cp init: ${err.message}`);
    return 1;
  }
  const label = CLIENT_NAMES[client];
  if (setUp.state === "differs") {
    o.err(`message-cp init: ${label} already has a server named message-cp that does not run \`npx -y message-cp\`; it was left as it is.`);
    o.err(`To remove it, then run message-cp init again: ${setUp.undo}`);
    return 1;
  }
  o.out(setUp.state === "added" ? `${label}: added message-cp ${setUp.changed}.` : `${label}: already set up; nothing was changed.`);
  try {
    await o.prove();
  } catch (err) {
    o.err(`Check failed: ${err instanceof Error ? err.message : String(err)}`);
    o.err(`The ${label} configuration was kept. To undo it: ${setUp.undo}`);
    return 1;
  }
  o.out("Check passed: started the stdio server, registered a test agent, sent it a message, read it back and removed it.");
  o.out(`To undo: ${setUp.undo}`);
  return 0;
}

/** Asks one question on the terminal and returns the answer ("" at end of input). */
export async function askOnTerminal(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => {
      rl.on("close", () => resolve(""));
      rl.question(question).then(resolve, () => resolve(""));
    });
  } finally {
    rl.close();
  }
}
