import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { PurgeError, purgeAgent } from "./agents.js";
import { dbPath, openDb } from "./db.js";

// `message-cp init`: adds the stdio server `npx -y message-cp` to one coding agent's user-level MCP configuration on
// this machine, then proves the server works by registering a test agent, sending it a message and reading it back.
// It never prints a token or key: the test agent's key is made here, stays in memory, and the agent is purged after.
// With `--url` and `--agent` it adds a team server over HTTP instead, carrying the token from MESSAGE_CP_HTTP_TOKEN and
// the agent's key from MESSAGE_CP_AGENT_KEY in its headers, and nothing it prints holds either of them.

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

/** Whether an executable named `command` is in one of `path`'s directories (on Windows, also with .exe, .cmd or .bat). */
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

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The `message-cp` entry `mergeServer` adds, and whether an entry already there counts as the same. */
export interface JsonServer {
  entry: Record<string, unknown>;
  same: (entry: unknown) => boolean;
}

const STDIO_SERVER: JsonServer = {
  entry: { command: SERVER_COMMAND, args: SERVER_ARGS },
  same: (e) => isObject(e) && e.command === SERVER_COMMAND && JSON.stringify(e.args) === JSON.stringify(SERVER_ARGS),
};

/**
 * Adds `server.entry` as `message-cp` to the `mcpServers` of the JSON file `file`, keeping every other key and server.
 * The new JSON is written to a temporary file beside the real one (through a symlink, beside its target) and renamed
 * over it, so a failed write leaves the old file whole; an existing file keeps its mode, and a new one is 0600. If the
 * file changed between the read and the rename, nothing is written and `init` says to run it again. A `message-cp`
 * entry already there is left as it is: "present" if `server.same` holds for it (by default, if it runs
 * `npx -y message-cp`), "differs" otherwise. Refuses, changing nothing, a file that is not a JSON object or whose
 * `mcpServers` is not one, and turns a file it cannot read or write into an InitError giving the reason.
 */
export function mergeServer(file: string, server: JsonServer = STDIO_SERVER): SetUpState {
  const reason = (err: unknown) => (err as { code?: string }).code ?? (err instanceof Error ? err.message : String(err));
  let config: Record<string, unknown> = {};
  let text: string | undefined;
  const current = () => (existsSync(file) ? readFileSync(file, "utf8") : undefined);
  if (existsSync(file)) {
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      throw new InitError(`could not read ${file} (${reason(err)}); nothing was changed.`);
    }
    try {
      config = JSON.parse(text);
    } catch {
      throw new InitError(`${file} is not valid JSON; it was left unchanged. Fix or move it, then run message-cp init again.`);
    }
  }
  if (!isObject(config)) throw new InitError(`${file} does not hold a JSON object; it was left unchanged.`);
  const servers = config.mcpServers ?? {};
  if (!isObject(servers)) throw new InitError(`${file} has an mcpServers that is not a JSON object; it was left unchanged.`);
  const entry = servers[SERVER_NAME];
  if (entry !== undefined) {
    return server.same(entry) ? "present" : "differs";
  }
  config.mcpServers = { ...servers, [SERVER_NAME]: server.entry };
  let tmp: string | undefined;
  try {
    const target = text === undefined ? file : realpathSync(file);
    tmp = join(dirname(target), `.${SERVER_NAME}-init-${randomBytes(6).toString("hex")}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    if (text !== undefined) chmodSync(tmp, statSync(target).mode & 0o777);
    if (current() !== text) {
      throw new InitError(`${file} changed while message-cp init was running; it was left as it is. Run message-cp init again.`);
    }
    renameSync(tmp, target);
    tmp = undefined;
  } catch (err) {
    if (err instanceof InitError) throw err;
    throw new InitError(`could not write ${file} (${reason(err)}); it was left as it was.`);
  } finally {
    if (tmp !== undefined) rmSync(tmp, { force: true });
  }
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

/** A team server for `init --url`: its `/mcp` endpoint, the agent to act as, and the token and key it sends. */
export interface Remote {
  endpoint: URL;
  agent: string;
  token: string;
  key: string;
}

/** The three headers a client sends to act as the agent, the same three `clientSetup` in `src/connect.ts` prints. */
export const remoteHeaders = (r: Remote): Record<string, string> => ({
  Authorization: `Bearer ${r.token}`,
  "X-Message-CP-Agent": r.agent,
  "X-Message-CP-Agent-Key": r.key,
});

/** `text` with the token and key replaced by `<redacted>`, so no line `init` passes on holds either. */
export function redact(text: string, r: Pick<Remote, "token" | "key"> | undefined): string {
  if (r === undefined) return text;
  for (const secret of [r.token, r.key]) if (secret) text = text.replaceAll(secret, "<redacted>");
  return text;
}

/** The `claude mcp add` arguments for the team server, at user scope; the token and key are only in this array. */
export const claudeRemoteAdd = (r: Remote): string[] => [
  "mcp",
  "add",
  "--scope",
  "user",
  "--transport",
  "http",
  SERVER_NAME,
  r.endpoint.href,
  ...Object.entries(remoteHeaders(r)).flatMap(([k, v]) => ["--header", `${k}: ${v}`]),
];

/**
 * The Cursor entry for the team server: `url` and `headers`, with no `type`, as Cursor documents a remote server. An
 * entry is the same only with the same URL and all three headers, so one holding an old token or key is not.
 */
export const cursorRemote = (r: Remote): JsonServer => ({
  entry: { url: r.endpoint.href, headers: remoteHeaders(r) },
  same: (e) =>
    isObject(e) &&
    e.url === r.endpoint.href &&
    isObject(e.headers) &&
    Object.entries(remoteHeaders(r)).every(([k, v]) => (e.headers as Record<string, unknown>)[k] === v),
});

/**
 * Whether `claude mcp get`'s output describes the team server `r` acts as: `Type: http`, its `URL:` and the three
 * header lines, so an entry holding an old token or key is not the same. The output holds the token and key, so it is
 * only matched, never printed.
 */
function sameRemote(stdout: string, r: Remote): boolean {
  const field = (name: string) => new RegExp(`^\\s*${name}: (.*)$`, "m").exec(stdout)?.[1]?.trim();
  return (
    field("Type") === "http" &&
    field("URL") === r.endpoint.href &&
    Object.entries(remoteHeaders(r)).every(([k, v]) => field(k) === v)
  );
}

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

const failed = (r: RunResult, what: string, remote?: Remote) => {
  const detail = redact((r.stderr || r.stdout).trim().split("\n").pop() ?? "", remote);
  return new InitError(`${what} failed (${r.status === null ? "no exit status" : `exit ${r.status}`})${detail ? `: ${detail}` : ""}.`);
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
 * Why `client` cannot be set up for the team server at `endpoint` on this machine, with what to do by hand, or undefined
 * if it can. `codex mcp add` takes `--url` but no custom headers. Claude Desktop takes a team server only as a custom
 * connector in its app. On Windows `claude` is a `.cmd` file that only a shell can start, and the token and key must
 * not pass through a shell string. An existing Cursor file that group or others can read is refused, so the token and
 * key are never written where other users can read them; its mode is left as it is.
 */
export function remoteRefusal(client: ClientId, m: Machine, endpoint: URL): string | undefined {
  if (client === "codex") {
    return "Codex cannot be set up for a team server: `codex mcp add` takes no custom headers, so it cannot send the agent's name and key.";
  }
  if (client === "claude-desktop") {
    return `Claude Desktop takes a team server as a custom connector in its app: in Customize, Connectors, choose Add, then Add custom connector, give it a name and the URL ${endpoint.href}, choose No sign in, and add the three request headers.`;
  }
  if (client === "claude-code" && m.platform === "win32") {
    return "on Windows, message-cp init cannot run `claude mcp add` without passing the token and key through a shell; run the `claude mcp add` command `message-cp connect` printed instead, or use --client cursor.";
  }
  if (client === "cursor" && m.platform !== "win32") {
    // Checked before the token and key are written, not after: its mode is the user's to change, not init's.
    const file = configFile("cursor", m);
    let mode = 0;
    try {
      mode = statSync(file).mode;
    } catch {
      // Not there yet: mergeServer makes it 0600.
    }
    if ((mode & 0o044) !== 0) {
      return `${file} would hold the token and key, and other users of this machine can read it; to make it private, run: chmod 600 ${file}, then run message-cp init again.`;
    }
  }
  return undefined;
}

/**
 * Adds the server to `client`'s user-level configuration, unless a `message-cp` entry is already there. Claude Code and
 * Codex go through their own `mcp get` (exit 1 when there is no such server) and `mcp add`; Cursor and Claude Desktop
 * through `mergeServer`. With `remote`, the entry is the team server over HTTP instead, for Claude Code or Cursor only.
 */
export function setUpClient(client: ClientId, m: Machine, run: Runner, remote?: Remote): SetUp {
  const refused = remote === undefined ? undefined : remoteRefusal(client, m, remote.endpoint);
  if (refused !== undefined) throw new InitError(`${refused} Nothing was changed.`);
  if (client === "cursor" || client === "claude-desktop") {
    const file = configFile(client, m);
    const state = remote === undefined ? mergeServer(file) : mergeServer(file, cursorRemote(remote));
    return { client, state, changed: `in ${file}`, undo: `delete the "${SERVER_NAME}" entry under "mcpServers" in ${file}` };
  }
  const c = cliCommands[client];
  const undo = [c.command, ...c.remove].join(" ");
  // With `remote`, what is shown leaves out the headers, which hold the token and key.
  const add = remote === undefined ? c.add : claudeRemoteAdd(remote);
  const target = remote === undefined ? [c.command, ...c.add].join(" ") : `${c.command} mcp add --scope user --transport http ${SERVER_NAME} ${remote.endpoint.href}`;
  const got = run(c.command, c.get);
  const changed = remote === undefined ? `with \`${target}\`` : `with \`${target}\` and the agent's three headers`;
  if (got.status === 0) {
    const same = remote === undefined ? runsPackage(client, got.stdout) : sameRemote(got.stdout, remote);
    return { client, state: same ? "present" : "differs", changed, undo };
  }
  if (got.status !== 1) throw failed(got, [c.command, ...c.get].join(" "), remote);
  const added = run(c.command, add);
  if (added.status !== 0) throw failed(added, target, remote);
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
    // Not started, timed out or killed: no exit status, and the reason in place of empty stderr.
    const why = r.error?.message ?? (r.signal ? `killed by ${r.signal}` : "");
    return { status: r.error ? null : r.status, stdout: r.stdout ?? "", stderr: r.stderr || why };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
};

/**
 * The stdio server of the package running `init`: `npx -y message-cp` resolves only once the package is published.
 * This is the built `dist/index.js` next to `dist/init.js`; run from `src/` with tsx, there is no `src/index.js`.
 */
export const ownServer = (): { command: string; args: string[] } => ({
  command: process.execPath,
  args: [fileURLToPath(new URL("./index.js", import.meta.url))],
});

const CALL_TIMEOUT_MS = 15_000;

/**
 * Starts `server` over stdio with `env` and the database `dbPath(env)`, registers a test agent with a random name in the
 * owner account, sends it a message from itself and reads it back. The test agent and its messages are then purged with
 * `purgeAgent` from the same database, even when a step failed. Throws an InitError that names the step that failed
 * (with the last line the server wrote to stderr, if it wrote any) and any failed clean-up; no message carries the
 * agent's key.
 */
export async function proveServer(server: { command: string; args: string[] }, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const db = dbPath(env);
  const name = `init-check-${randomBytes(10).toString("hex")}`;
  // Made here, so register returns no key, and the agent can be removed even if register's reply was lost.
  const key = randomBytes(24).toString("hex");
  const body = `message-cp init check ${name}`;
  // The child acts only as the test agent: an agent named in the environment would be registered by the server first.
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && k !== "MESSAGE_CP_AGENT" && k !== "MESSAGE_CP_AGENT_KEY") childEnv[k] = v;
  childEnv.MESSAGE_CP_DB = db;

  const client = new Client({ name: "message-cp-init", version: "1.0.0" });
  let failure: unknown;
  let step = "starting the server";
  let stderr = "";
  try {
    const transport = new StdioClientTransport({ ...server, env: childEnv, stderr: "pipe" });
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4000);
    });
    await client.connect(transport, { timeout: CALL_TIMEOUT_MS });
    const call = async (tool: string, args: Record<string, unknown>) => {
      step = tool;
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
      // Only the registration this check made, the live agent holding its key: if register met an agent that already
      // had the name, or the name has since been taken over, that agent is not this check's to remove.
      const keyHash = createHash("sha256").update(key).digest("hex");
      conn
        .transaction(() => {
          const live = conn
            .prepare(
              "SELECT key_hash FROM agents WHERE account_id = (SELECT id FROM accounts WHERE name = 'owner') AND name = ? AND removed_at IS NULL",
            )
            .get(name) as { key_hash: string | null } | undefined;
          if (live?.key_hash === keyHash) purgeAgent(conn, "owner", name);
        })
        .immediate();
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
    if (failure !== undefined) {
      const last = stderr.trim().split("\n").pop()?.trim();
      parts.push(`${step}: ${say(failure)}${last ? ` (server: ${say(last).slice(0, 300)})` : ""}`);
    }
    if (cleanup !== undefined) parts.push(`could not remove the test agent '${name}' (${say(cleanup)}); remove it with: message-cp agent remove ${name}`);
    throw new InitError(parts.join("; "));
  }
}

/** A client of the team server `r`, sending `headers` on every request. */
function remoteClient(r: Remote, headers: Record<string, string>) {
  const client = new Client({ name: "message-cp-init", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(r.endpoint, { requestInit: { headers } });
  return { client, transport };
}

/**
 * Ends the session `transport` holds with DELETE /mcp, waiting at most `ms` for it, then closes the client, which
 * aborts a DELETE still pending; neither failure matters, since the server ends an idle session itself.
 */
export async function endSession(client: Client, transport: StreamableHTTPClientTransport, ms = CALL_TIMEOUT_MS): Promise<void> {
  if (transport.sessionId !== undefined) {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    });
    await Promise.race([transport.terminateSession().catch(() => {}), timeout]);
    clearTimeout(timer);
  }
  await client.close().catch(() => {});
}

/** The server's own message from a refusal: the `error.message` of the JSON body the SDK quotes, if there is one. */
function serverMessage(err: Error): string {
  const json = /\{.*\}/s.exec(err.message)?.[0];
  try {
    const message = JSON.parse(json ?? "").error?.message;
    if (typeof message === "string") return message.replace(/\.$/, "");
  } catch {}
  return err.message;
}

/** Calls `tool` and returns its parsed JSON result, throwing an Error with the tool's own text when it fails. */
async function callTool(client: Client, tool: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name: tool, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS })) as {
    isError?: boolean;
    content?: { text?: string }[];
  };
  const text = result.content?.[0]?.text ?? "";
  if (result.isError) throw new Error(`${tool} returned an error: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

/**
 * Checks the token and the agent's key before anything is written. A session that sends only the token finds the agent
 * with `get_agent`, since a session that names an agent registers it, and `init` makes no agent; then a session with
 * the three headers the client will send, which acts as the agent from its first request. Both sessions are ended.
 * Throws an InitError that says which was refused: the token (401, or 403 for a read-only one), the agent's name (not
 * on the server) or its key (403), or that the server could not be reached. No message holds the token or key.
 */
export async function checkRemote(r: Remote): Promise<void> {
  const refusal = (err: unknown, named: boolean): InitError => {
    const why = err instanceof Error ? err : new Error(String(err));
    const code = why instanceof StreamableHTTPError ? why.code : undefined;
    const message = redact(serverMessage(why), r).slice(0, 300);
    if (code === 401) return new InitError("the server refused the token in MESSAGE_CP_HTTP_TOKEN (401)");
    if (code === 403 && !named) return new InitError(`the server refused the token in MESSAGE_CP_HTTP_TOKEN (403): ${message}`);
    if (code === 403) return new InitError(`the server refused agent '${r.agent}' with the key in MESSAGE_CP_AGENT_KEY (403): ${message}`);
    return new InitError(`could not open a session at ${r.endpoint.href}: ${message}`);
  };
  const plain = remoteClient(r, { Authorization: `Bearer ${r.token}` });
  try {
    try {
      await plain.client.connect(plain.transport, { timeout: CALL_TIMEOUT_MS });
    } catch (err) {
      throw refusal(err, false);
    }
    let agent: { person?: boolean };
    try {
      agent = await callTool(plain.client, "get_agent", { name: r.agent });
    } catch (err) {
      const message = redact(err instanceof Error ? err.message : String(err), r);
      if (/No agent named/.test(message)) {
        throw new InitError(`the server has no agent named '${r.agent}'; make it on the server with: message-cp connect ${r.agent} --url <public url>`);
      }
      throw new InitError(`get_agent: ${message.slice(0, 300)}`);
    }
    if (agent.person) throw new InitError(`'${r.agent}' is a person on the server, not an agent`);
  } finally {
    await endSession(plain.client, plain.transport);
  }
  const named = remoteClient(r, remoteHeaders(r));
  try {
    await named.client.connect(named.transport, { timeout: CALL_TIMEOUT_MS });
  } catch (err) {
    throw refusal(err, true);
  } finally {
    await endSession(named.client, named.transport);
  }
}

/**
 * Proves the team server works as `proveServer` does over stdio, without touching the configured agent: on a session
 * that sends only the token, registers a test agent with a random name and a key made here, sends it a message from
 * itself, reads it back and unregisters it, then ends the session. If a step failed after `register`, it still tries to
 * remove the test agent by name and key. Throws an InitError naming the failed step and any failed clean-up; no message
 * holds the token or either key.
 */
export async function proveRemote(r: Remote): Promise<void> {
  const name = `init-check-${randomBytes(10).toString("hex")}`;
  const key = randomBytes(24).toString("hex");
  const body = `message-cp init check ${name}`;
  const { client, transport } = remoteClient(r, { Authorization: `Bearer ${r.token}` });
  const say = (err: unknown) => redact(err instanceof Error ? err.message : String(err), r).replaceAll(key, "<redacted>").slice(0, 300);
  let step = "opening a session";
  let registered = false;
  let failure: unknown;
  let cleanup: unknown;
  const call = (tool: string, args: Record<string, unknown>) => callTool(client, tool, args);
  try {
    await client.connect(transport, { timeout: CALL_TIMEOUT_MS });
    step = "register";
    // Counted as registered before the reply, which may be lost after the server has acted on it.
    registered = true;
    await call("register", { name, bio: "message-cp init check; removed when the check ends", key });
    step = "send_message";
    await call("send_message", { to: name, body });
    step = "read_inbox";
    const inbox = (await call("read_inbox", {})) as { from?: string; body?: string }[];
    if (!inbox.some((m) => m.from === name && m.body === body)) throw new Error("read_inbox did not return the message just sent");
    step = "unregister";
    await call("unregister", {});
    registered = false;
  } catch (err) {
    failure = err;
  }
  if (registered) {
    try {
      await call("unregister", { name, key });
    } catch (err) {
      // Never registered: nothing to remove.
      if (!/No agent named/i.test(err instanceof Error ? err.message : "")) cleanup = err;
    }
  }
  await endSession(client, transport);
  if (failure !== undefined || cleanup !== undefined) {
    const parts = [];
    if (failure !== undefined) parts.push(`${step}: ${say(failure)}`);
    if (cleanup !== undefined) parts.push(`could not remove the test agent '${name}' (${say(cleanup)}); remove it on the server with: message-cp agent remove ${name}`);
    throw new InitError(parts.join("; "));
  }
}

export interface InitOptions {
  /** From `--client`; without it, `init` sets up the one client found, or asks on a terminal. */
  client?: ClientId;
  /** From `--url` and `--agent`, with the token and key from the environment: set up this team server instead. */
  remote?: Remote;
  /** Checks the remote's token and key before anything is written; `checkRemote` by default. */
  check?: (r: Remote) => Promise<void>;
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
    if (answer === "") {
      o.err("message-cp init: no client was chosen. Nothing was changed.");
      return 1;
    }
    const n = Number(answer);
    if (!/^[0-9]+$/.test(answer) || n < 1 || n > found.length) {
      o.err(`message-cp init: '${answer}' is not one of 1-${found.length}. Nothing was changed.`);
      return 1;
    }
    client = found[n - 1]!;
  }

  const { remote } = o;
  if (remote !== undefined) {
    const refused = remoteRefusal(client, o.machine, remote.endpoint);
    if (refused !== undefined) {
      o.err(`message-cp init: ${refused} Nothing was changed.`);
      return 1;
    }
    try {
      await (o.check ?? checkRemote)(remote);
    } catch (err) {
      if (!(err instanceof InitError)) throw err;
      o.err(`message-cp init: ${redact(err.message, remote)}. Nothing was changed.`);
      return 1;
    }
    o.out(`Server: ${remote.endpoint.href} accepted the token, and agent '${remote.agent}' with its key.`);
  }

  let setUp: SetUp;
  try {
    setUp = setUpClient(client, o.machine, o.run, remote);
  } catch (err) {
    if (!(err instanceof InitError)) throw err;
    o.err(`message-cp init: ${redact(err.message, remote)}`);
    return 1;
  }
  const label = CLIENT_NAMES[client];
  if (setUp.state === "differs") {
    o.err(
      remote === undefined
        ? `message-cp init: ${label} already has a server named message-cp that does not run \`npx -y message-cp\`; it was left as it is.`
        : `message-cp init: ${label} already has a server named message-cp that is not ${remote.endpoint.href} as agent '${remote.agent}' with this token and key; it was left as it is.`,
    );
    o.err(`To remove it, then run message-cp init again: ${setUp.undo}`);
    return 1;
  }
  o.out(setUp.state === "added" ? `${label}: added message-cp ${setUp.changed}.` : `${label}: already set up; nothing was changed.`);
  try {
    await o.prove();
  } catch (err) {
    o.err(`Check failed: ${redact(err instanceof Error ? err.message : String(err), remote)}`);
    o.err(`The ${label} configuration was kept. To undo it: ${setUp.undo}`);
    return 1;
  }
  o.out(
    remote === undefined
      ? "Check passed: started the stdio server, registered a test agent, sent it a message, read it back and removed it."
      : "Check passed: registered a test agent on the server, sent it a message, read it back and removed it.",
  );
  o.out(`To undo: ${setUp.undo}`);
  return 0;
}

/** Asks one question on the terminal and returns the answer ("" at end of input). */
export async function askOnTerminal(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    // Ctrl-C or the end of input closes the interface without answering the question: no answer.
    return await new Promise<string>((resolve) => {
      rl.once("close", () => resolve(""));
      rl.question(question).then(resolve, () => resolve(""));
    });
  } finally {
    rl.close();
  }
}
