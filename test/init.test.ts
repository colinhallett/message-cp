import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addAccount, addToken, listAccounts } from "../src/accounts.js";
import { addPerson, listServerAgents, registerAgent } from "../src/agents.js";
import { clientSetup, connectAgent, mcpEndpoint } from "../src/connect.js";
import { OWNER_ACCOUNT, openDb, type Db } from "../src/db.js";
import { startHttp, type HttpServer } from "../src/http.js";
import { sendMessage } from "../src/messages.js";
import {
  InitError,
  checkRemote,
  endSession,
  claudeDesktopDir,
  detectClients,
  mergeServer,
  proveRemote,
  proveServer,
  readConnectFile,
  redact,
  runInit,
  setUpClient,
  writeTokenFile,
  type InitOptions,
  type Machine,
  type Remote,
  type RunResult,
} from "../src/init.js";

// `message-cp init`: one coding agent on this machine gets the stdio server, and a test agent proves it works. No test
// runs the real `claude` or `codex` or touches the real home directory: both are passed in.
let home: string;
let bin: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "message-cp-init-home-"));
  bin = join(home, "bin");
  mkdirSync(bin);
});

/** Puts an executable named `name` in the temporary `bin` directory. */
const fakeCommand = (name: string) => {
  writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, name), 0o755);
};
const machine = (platform: NodeJS.Platform = "linux"): Machine => ({ home, path: bin, platform });

/** A runner that records each call and answers from `answers`, keyed by "command arg arg ...". */
function fakeRunner(answers: Record<string, Partial<RunResult>> = {}) {
  const calls: string[] = [];
  const run = (command: string, args: string[]): RunResult => {
    const line = [command, ...args].join(" ");
    calls.push(line);
    return { status: 0, stdout: "", stderr: "", ...answers[line] };
  };
  return { run, calls };
}

const CLAUDE_GET = "claude mcp get message-cp";
const CODEX_GET = "codex mcp get message-cp --json";
const MISSING = { status: 1, stderr: "No MCP server named message-cp" };

describe("detectClients", () => {
  it("finds Claude Code and Codex on PATH, Cursor by ~/.cursor and Claude Desktop by its config directory", () => {
    expect(detectClients(machine("darwin"))).toEqual([]);
    fakeCommand("claude");
    fakeCommand("codex");
    mkdirSync(join(home, ".cursor"));
    mkdirSync(join(home, "Library", "Application Support", "Claude"), { recursive: true });
    expect(detectClients(machine("darwin"))).toEqual(["claude-code", "codex", "cursor", "claude-desktop"]);
  });

  it("does not take a file that cannot be run, or a directory, for a command", () => {
    writeFileSync(join(bin, "claude"), "");
    mkdirSync(join(bin, "codex"));
    expect(detectClients(machine())).toEqual([]);
  });

  it("puts Claude Desktop's config where its docs do, and has none on Linux", () => {
    expect(claudeDesktopDir(machine("darwin"))).toBe(join(home, "Library", "Application Support", "Claude"));
    expect(claudeDesktopDir({ ...machine("win32"), appData: join(home, "Roaming") })).toBe(join(home, "Roaming", "Claude"));
    expect(claudeDesktopDir(machine("linux"))).toBeUndefined();
  });
});

describe("mergeServer", () => {
  const file = () => join(home, "mcp.json");
  const entry = { command: "npx", args: ["-y", "message-cp"] };

  it("creates a missing file, private to the user", () => {
    expect(mergeServer(file())).toBe("added");
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({ mcpServers: { "message-cp": entry } });
    if (process.platform !== "win32") expect(statSync(file()).mode & 0o777).toBe(0o600);
  });

  it("keeps every other key and server, and a second run changes nothing", () => {
    writeFileSync(file(), JSON.stringify({ theme: "dark", mcpServers: { other: { command: "other", env: { A: "1" } } } }));
    expect(mergeServer(file())).toBe("added");
    const after = readFileSync(file(), "utf8");
    expect(JSON.parse(after)).toEqual({ theme: "dark", mcpServers: { other: { command: "other", env: { A: "1" } }, "message-cp": entry } });
    expect(mergeServer(file())).toBe("present");
    expect(readFileSync(file(), "utf8")).toBe(after);
  });

  it("leaves a message-cp entry with a different command as it is", () => {
    const before = JSON.stringify({ mcpServers: { "message-cp": { command: "node", args: ["/x/dist/index.js"] } } });
    writeFileSync(file(), before);
    expect(mergeServer(file())).toBe("differs");
    expect(readFileSync(file(), "utf8")).toBe(before);
  });

  it("never writes a secret entry into a file group or others can read, and leaves its mode as it is", () => {
    if (process.platform === "win32") return;
    const file = join(home, "mcp.json");
    writeFileSync(file, "{}");
    chmodSync(file, 0o644);
    const secret = { entry: { url: "https://h/mcp", headers: { Authorization: "Bearer t" } }, same: () => false, secret: true };
    expect(() => mergeServer(file, secret)).toThrow(/became readable by other users of this machine .*chmod 600/);
    expect(readFileSync(file, "utf8")).toBe("{}");
    expect(statSync(file).mode & 0o777).toBe(0o644);
    expect(readdirSync(home).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    chmodSync(file, 0o600);
    expect(mergeServer(file, secret)).toBe("added");
    expect(statSync(file).mode & 0o777).toBe(0o600);

    // The same entry already there is "present" only while the file is private.
    const same = { ...secret, same: () => true };
    expect(mergeServer(file, same)).toBe("present");
    chmodSync(file, 0o640);
    const before = readFileSync(file, "utf8");
    expect(() => mergeServer(file, same)).toThrow(/holds the token, and other users of this machine can read it; .*chmod 600/);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(statSync(file).mode & 0o777).toBe(0o640);
  });

  it("says it cannot read a path that is a directory, rather than calling it invalid JSON", () => {
    mkdirSync(file());
    expect(() => mergeServer(file())).toThrow(/could not read .*mcp\.json \(EISDIR\)/);
  });

  it("says it cannot write where the directory is missing", () => {
    expect(() => mergeServer(join(home, "missing", "mcp.json"))).toThrow(/could not write .*mcp\.json \(ENOENT\)/);
  });

  it("replaces the file by rename, keeping its mode and a symlink to it, and leaves no temporary file", () => {
    if (process.platform === "win32") return;
    const real = join(home, "real.json");
    writeFileSync(real, JSON.stringify({ mcpServers: { other: { command: "other" } } }), { mode: 0o640 });
    symlinkSync(real, file());
    expect(mergeServer(file())).toBe("added");
    expect(lstatSync(file()).isSymbolicLink()).toBe(true);
    expect(statSync(real).mode & 0o777).toBe(0o640);
    expect(Object.keys(JSON.parse(readFileSync(real, "utf8")).mcpServers)).toEqual(["other", "message-cp"]);
    expect(readdirSync(home).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("leaves the old file whole when the new one cannot be written", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const dir = join(home, "locked");
    mkdirSync(dir);
    const before = JSON.stringify({ mcpServers: { other: { command: "other" } } });
    writeFileSync(join(dir, "mcp.json"), before);
    chmodSync(dir, 0o555);
    try {
      expect(() => mergeServer(join(dir, "mcp.json"))).toThrow(/could not write .*mcp\.json \(EACCES\); it was left as it was/);
      expect(readFileSync(join(dir, "mcp.json"), "utf8")).toBe(before);
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  it("refuses invalid JSON, a non-object and a non-object mcpServers, leaving the file unchanged", () => {
    for (const before of ["{ not json", "[1, 2]", '{"mcpServers": []}']) {
      writeFileSync(file(), before);
      expect(() => mergeServer(file())).toThrow(InitError);
      expect(readFileSync(file(), "utf8")).toBe(before);
    }
  });
});

describe("setUpClient", () => {
  it("adds Claude Code at user scope when claude mcp get finds no server", () => {
    const { run, calls } = fakeRunner({ [CLAUDE_GET]: MISSING });
    const s = setUpClient("claude-code", machine(), run);
    expect(calls).toEqual([CLAUDE_GET, "claude mcp add --scope user message-cp -- npx -y message-cp"]);
    expect(s).toMatchObject({ state: "added", undo: "claude mcp remove --scope user message-cp" });
  });

  it("adds Codex when codex mcp get finds no server", () => {
    const { run, calls } = fakeRunner({ [CODEX_GET]: MISSING });
    const s = setUpClient("codex", machine(), run);
    expect(calls).toEqual([CODEX_GET, "codex mcp add message-cp -- npx -y message-cp"]);
    expect(s).toMatchObject({ state: "added", undo: "codex mcp remove message-cp" });
  });

  it("changes nothing when the server is already there, and says when it runs something else", () => {
    const claude = "message-cp:\n  Scope: User config\n  Type: stdio\n  Command: npx\n  Args: -y message-cp\n  Environment:\n";
    const codex = (command: string) => JSON.stringify({ transport: { type: "stdio", command, args: ["-y", "message-cp"] } });
    for (const [client, get, stdout, state] of [
      ["claude-code", CLAUDE_GET, claude, "present"],
      ["claude-code", CLAUDE_GET, claude.replace("Command: npx", "Command: node"), "differs"],
      ["codex", CODEX_GET, codex("npx"), "present"],
      ["codex", CODEX_GET, codex("node"), "differs"],
    ] as const) {
      const { run, calls } = fakeRunner({ [get]: { status: 0, stdout } });
      expect(setUpClient(client, machine(), run).state).toBe(state);
      expect(calls).toEqual([get]);
    }
  });

  it("stops at a get that fails other than with exit 1, or an add that fails", () => {
    expect(() => setUpClient("claude-code", machine(), fakeRunner({ [CLAUDE_GET]: { status: 2, stderr: "boom" } }).run)).toThrow(/\(exit 2\): boom/);
    expect(() => setUpClient("claude-code", machine(), fakeRunner({ [CLAUDE_GET]: { status: null, stderr: "spawnSync claude ETIMEDOUT" } }).run)).toThrow(
      /\(no exit status\): spawnSync claude ETIMEDOUT/,
    );
    const { run, calls } = fakeRunner({ [CODEX_GET]: MISSING, "codex mcp add message-cp -- npx -y message-cp": { status: 1, stderr: "nope" } });
    expect(() => setUpClient("codex", machine(), run)).toThrow(/\(exit 1\): nope/);
    expect(calls).toHaveLength(2);
  });

  it("edits ~/.cursor/mcp.json for Cursor and runs no command", () => {
    mkdirSync(join(home, ".cursor"));
    const { run, calls } = fakeRunner();
    const s = setUpClient("cursor", machine(), run);
    const file = join(home, ".cursor", "mcp.json");
    expect(s).toMatchObject({ state: "added", changed: `in ${file}` });
    expect(s.undo).toContain(file);
    expect(JSON.parse(readFileSync(file, "utf8")).mcpServers["message-cp"]).toEqual({ command: "npx", args: ["-y", "message-cp"] });
    expect(calls).toEqual([]);
  });

  it("edits claude_desktop_config.json for Claude Desktop", () => {
    const dir = join(home, "Library", "Application Support", "Claude");
    mkdirSync(dir, { recursive: true });
    setUpClient("claude-desktop", machine("darwin"), fakeRunner().run);
    expect(JSON.parse(readFileSync(join(dir, "claude_desktop_config.json"), "utf8")).mcpServers).toHaveProperty("message-cp");
  });
});

describe("runInit", () => {
  function options(over: Partial<InitOptions> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    let proved = 0;
    const runner = fakeRunner({ [CLAUDE_GET]: MISSING, [CODEX_GET]: MISSING });
    const o: InitOptions = {
      machine: machine(),
      run: runner.run,
      interactive: false,
      ask: async () => {
        throw new Error("asked");
      },
      prove: async () => {
        proved++;
      },
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      ...over,
    };
    return { o, out, err, calls: runner.calls, proved: () => proved };
  }

  it("with no client found, says so, prints the manual line and changes nothing", async () => {
    const t = options();
    expect(await runInit(t.o)).toBe(1);
    expect(t.err.join("\n")).toContain("claude mcp add message-cp -- npx -y message-cp");
    expect(t.calls).toEqual([]);
    expect(t.proved()).toBe(0);
  });

  it("sets up the one client found, then proves it and prints the undo", async () => {
    mkdirSync(join(home, ".cursor"));
    const t = options();
    expect(await runInit(t.o)).toBe(0);
    expect(t.proved()).toBe(1);
    expect(t.out[0]).toBe("message-cp init: found Cursor.");
    expect(t.out.join("\n")).toMatch(/Cursor: added message-cp in .*mcp\.json\.\nCheck passed: .*\nTo undo: delete the "message-cp" entry/);
  });

  it("with more than one client and no terminal, lists the choices and changes nothing", async () => {
    fakeCommand("claude");
    mkdirSync(join(home, ".cursor"));
    const t = options();
    expect(await runInit(t.o)).toBe(1);
    expect(t.err.join("\n")).toContain("message-cp init --client claude-code\n  message-cp init --client cursor");
    expect(t.calls).toEqual([]);
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
  });

  it("with more than one client on a terminal, asks which by number", async () => {
    fakeCommand("claude");
    fakeCommand("codex");
    const questions: string[] = [];
    const t = options({ interactive: true, ask: async (q) => (questions.push(q), "2") });
    expect(await runInit(t.o)).toBe(0);
    expect(questions).toEqual(["Set up which? [1-2] "]);
    expect(t.calls).toEqual([CODEX_GET, "codex mcp add message-cp -- npx -y message-cp"]);

    for (const answer of ["3", "x", ""]) {
      const bad = options({ interactive: true, ask: async () => answer });
      expect(await runInit(bad.o)).toBe(1);
      expect(bad.err.join("\n")).toMatch(answer ? /is not one of 1-2/ : /no client was chosen/);
      expect(bad.calls).toEqual([]);
    }
  });

  it("with --client, never asks, and refuses a client that is not installed", async () => {
    fakeCommand("claude");
    mkdirSync(join(home, ".cursor"));
    const t = options({ interactive: true, client: "claude-code" });
    expect(await runInit(t.o)).toBe(0);
    expect(t.calls).toEqual([CLAUDE_GET, "claude mcp add --scope user message-cp -- npx -y message-cp"]);

    const missing = options({ interactive: true, client: "codex" });
    expect(await runInit(missing.o)).toBe(1);
    expect(missing.err.join("\n")).toContain("Codex was not found");
    expect(missing.calls).toEqual([]);
  });

  it("run again, says already set up", async () => {
    mkdirSync(join(home, ".cursor"));
    await runInit(options().o);
    const t = options();
    expect(await runInit(t.o)).toBe(0);
    expect(t.out).toContain("Cursor: already set up; nothing was changed.");
  });

  it("leaves a differing entry, says how to remove it, and does not run the check", async () => {
    fakeCommand("claude");
    const t = options({ run: fakeRunner({ [CLAUDE_GET]: { status: 0, stdout: "  Type: http\n" } }).run });
    expect(await runInit(t.o)).toBe(1);
    expect(t.err.join("\n")).toContain("claude mcp remove --scope user message-cp");
    expect(t.proved()).toBe(0);
  });

  it("keeps the configuration when the check fails, and says how to undo it", async () => {
    mkdirSync(join(home, ".cursor"));
    const t = options({ prove: async () => Promise.reject(new InitError("read_inbox returned an error")) });
    expect(await runInit(t.o)).toBe(1);
    expect(t.err.join("\n")).toMatch(/Check failed: read_inbox returned an error\nThe Cursor configuration was kept\. To undo it: delete/);
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(true);
  });
});

describe("proveServer", () => {
  const root = resolve(import.meta.dirname, "..");
  const server = { command: process.execPath, args: [join(root, "node_modules/tsx/dist/cli.mjs"), join(root, "src/index.ts")] };

  it("registers, sends and reads back over stdio against MESSAGE_CP_DB, leaving no test agent behind", async () => {
    const dbFile = join(home, "db.sqlite");
    const db = openDb(dbFile);
    registerAgent(db, OWNER_ACCOUNT, "alice");
    db.close();
    // An agent named in the environment is not registered by the check's server.
    await proveServer(server, { ...process.env, MESSAGE_CP_DB: dbFile, MESSAGE_CP_AGENT: "bob", MESSAGE_CP_AGENT_KEY: "k".repeat(32) });
    const after = openDb(dbFile);
    expect(listServerAgents(after).map((a) => a.name)).toEqual(["alice"]);
    expect(after.prepare("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 0 });
    after.close();
  }, 30_000);

  it("fails with the step that failed when the server does not start", async () => {
    const dbFile = join(home, "db.sqlite");
    await expect(proveServer({ command: join(home, "no-such-server"), args: [] }, { ...process.env, MESSAGE_CP_DB: dbFile })).rejects.toThrow(
      /^starting the server: /,
    );
  }, 30_000);

  it("names the failed tool and what the server wrote to stderr, never the key", async () => {
    // A server that echoes each register call's arguments, key included, to stderr and as its error.
    const fake = join(home, "echo-server.mjs");
    writeFileSync(
      fake,
      `import { McpServer } from ${JSON.stringify(join(root, "node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js"))};
import { StdioServerTransport } from ${JSON.stringify(join(root, "node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js"))};
import { z } from ${JSON.stringify(join(root, "node_modules/zod/index.js"))};
const server = new McpServer({ name: "echo", version: "1" });
server.registerTool("register", { inputSchema: { name: z.string(), bio: z.string(), key: z.string() } }, async (args) => {
  process.stderr.write("got " + JSON.stringify(args) + "\\n");
  return { isError: true, content: [{ type: "text", text: "refused " + JSON.stringify(args) }] };
});
await server.connect(new StdioServerTransport());
`,
    );
    const dbFile = join(home, "db.sqlite");
    const err = await proveServer({ command: process.execPath, args: [fake] }, { ...process.env, MESSAGE_CP_DB: dbFile }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(InitError);
    const message = (err as Error).message;
    expect(message).toMatch(/^register: register returned an error: refused .*"key":"<redacted>".*\(server: got .*"key":"<redacted>"/);
    expect(message).not.toMatch(/[0-9a-f]{48}/);
  }, 30_000);

  it("does not purge an agent that already had the test agent's name", async () => {
    // A server whose register finds the name already taken: it registers the name with another key, then refuses.
    const fake = join(home, "taken-server.mts");
    writeFileSync(
      fake,
      `import { McpServer } from ${JSON.stringify(join(root, "node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js"))};
import { StdioServerTransport } from ${JSON.stringify(join(root, "node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js"))};
import { z } from ${JSON.stringify(join(root, "node_modules/zod/index.js"))};
import { registerAgent } from ${JSON.stringify(join(root, "src/agents.ts"))};
import { OWNER_ACCOUNT, openDb } from ${JSON.stringify(join(root, "src/db.ts"))};
const server = new McpServer({ name: "taken", version: "1" });
server.registerTool("register", { inputSchema: { name: z.string(), bio: z.string(), key: z.string() } }, async (args) => {
  const db = openDb(process.env.MESSAGE_CP_DB);
  registerAgent(db, OWNER_ACCOUNT, args.name);
  db.close();
  return { isError: true, content: [{ type: "text", text: "Wrong key" }] };
});
await server.connect(new StdioServerTransport());
`,
    );
    const dbFile = join(home, "db.sqlite");
    const err = await proveServer({ command: process.execPath, args: [join(root, "node_modules/tsx/dist/cli.mjs"), fake] }, { ...process.env, MESSAGE_CP_DB: dbFile }).catch(
      (e: Error) => e,
    );
    expect((err as Error).message).toMatch(/^register: /);
    const after = openDb(dbFile);
    expect(listServerAgents(after).map((a) => a.name)).toEqual([expect.stringMatching(/^init-check-[0-9a-f]{20}$/)]);
    after.close();
  }, 30_000);
});

describe("message-cp init", () => {
  const root = resolve(import.meta.dirname, "..");
  const cli = (env: Record<string, string>, ...args: string[]) =>
    spawnSync(process.execPath, [join(root, "node_modules/tsx/dist/cli.mjs"), join(root, "src/cli.ts"), "init", ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home, MESSAGE_CP_DB: join(home, "db.sqlite"), ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

  it("refuses an unknown option or client with its usage", () => {
    for (const args of [["--bogus"], ["--client", "vim"], ["--client"], ["--client", "cursor", "--client", "codex"]]) {
      const r = cli({}, ...args);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("usage: message-cp init [--client <claude-code|codex|cursor|claude-desktop>]");
    }
  });

  it("takes --url and --agent only together, and the token and key only from the environment, the token required", () => {
    const env = { MESSAGE_CP_HTTP_TOKEN: TOKEN, MESSAGE_CP_AGENT_KEY: KEY };
    for (const args of [
      ["--url", "https://h.example"],
      ["--agent", "writer"],
      ["--url", "https://h.example", "--agent"],
      ["--url", "https://h.example", "--agent", "writer", "--token", TOKEN],
      ["--url", "https://h.example", "--agent", "writer", "--key", KEY],
    ]) {
      const r = cli(env, ...args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stderr).toContain("usage: message-cp init [--client <claude-code|codex|cursor|claude-desktop>] [--url <public url> --agent <name> | --from <file connect wrote>]");
      expect(r.stdout + r.stderr).not.toContain(TOKEN);
      expect(r.stdout + r.stderr).not.toContain(KEY);
    }
    // The key is optional here: a token bound to the agent needs none, and checkRemote refuses an unbound one without it.
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const r = cli({ MESSAGE_CP_AGENT_KEY: KEY, MESSAGE_CP_HTTP_TOKEN: "" }, "--client", "cursor", "--url", "https://h.example", "--agent", "writer");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("set MESSAGE_CP_HTTP_TOKEN");
    expect(r.stderr).toContain("Nothing was changed.");
    expect(r.stderr).not.toContain(KEY);
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
  });

  it("refuses an unsafe --url before reading anything, changing nothing", () => {
    mkdirSync(join(home, ".cursor"));
    const env = { MESSAGE_CP_HTTP_TOKEN: TOKEN, MESSAGE_CP_AGENT_KEY: KEY };
    for (const url of ["http://localhost@evil/", "https://@/", "https://h/?x=/o/", "https://h/#/o/", "http://example.com", "not a url"]) {
      const r = cli(env, "--client", "cursor", "--url", url, "--agent", "writer");
      expect(r.status, url).toBe(2);
      expect(r.stderr).toMatch(/^message-cp init: --url .*Nothing was changed\.\n$/);
      expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
    }
  });

  it("with --url, a wrong token changes nothing, says so and prints neither secret", async () => {
    mkdirSync(join(home, ".cursor"));
    const db = openDb(join(home, "db.sqlite"));
    const http = await startHttp(db, { token: "owner-token", port: 0 });
    try {
      const c = connectAgent(db, "owner", "writer", false);
      const run = (token: string, key = c.key, agent = "writer") =>
        new Promise<{ status: number | null; output: string }>((done) => {
          // Asynchronous, so this process can answer the server's requests meanwhile.
          const child = spawn(process.execPath, [join(root, "node_modules/tsx/dist/cli.mjs"), join(root, "src/cli.ts"), "init", "--client", "cursor", "--url", `http://127.0.0.1:${http.port}`, "--agent", agent], {
            env: { ...process.env, HOME: home, USERPROFILE: home, MESSAGE_CP_DB: join(home, "other.sqlite"), MESSAGE_CP_HTTP_TOKEN: token, MESSAGE_CP_AGENT_KEY: key },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let output = "";
          child.stdout.on("data", (d) => (output += d));
          child.stderr.on("data", (d) => (output += d));
          child.on("close", (status) => done({ status, output }));
        });
      const wrong = await run("wrong-token");
      expect(wrong.status).toBe(1);
      expect(wrong.output).toContain("the server refused the token in MESSAGE_CP_HTTP_TOKEN (401). Nothing was changed.");
      expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);

      // The bound token connect made, with no key: Cursor gets only the Authorization header.
      const right = await run(c.token, "");
      expect(right.output).toContain("Server: http://127.0.0.1:");
      expect(right.output).toContain("accepted the token, which is agent 'writer'.");
      expect(right.output).toContain("Check passed: as agent 'writer' on the server, sent itself a message");
      expect(right.status).toBe(0);
      expect(right.output).not.toContain(c.token);
      expect(right.output).not.toContain(c.key);
      const written = readFileSync(join(home, ".cursor", "mcp.json"), "utf8");
      expect(written).not.toContain(c.key);
      expect(JSON.parse(written).mcpServers["message-cp"]).toEqual({ url: `http://127.0.0.1:${http.port}/mcp`, headers: { Authorization: `Bearer ${c.token}` } });
      // Run again, with or without the key, it is already set up.
      for (const key of ["", c.key]) {
        const again = await run(c.token, key);
        expect(again.output).toContain("Cursor: already set up; nothing was changed.");
        expect(again.status).toBe(0);
      }
      // The bound token for another agent's setup is refused, naming its agent, and changes nothing.
      connectAgent(db, "owner", "reader", false);
      const other = await run(c.token, "", "reader");
      expect(other.status).toBe(1);
      expect(other.output).toContain("the token in MESSAGE_CP_HTTP_TOKEN is bound to agent 'writer', not 'reader'. Nothing was changed.");
      expect(other.output).not.toContain(c.token);
      // An unbound agent token without the key is refused, changing nothing.
      rmSync(join(home, ".cursor", "mcp.json"));
      const unbound = addToken(db, "owner", false, true).token;
      const nokey = await run(unbound, "");
      expect(nokey.status).toBe(1);
      expect(nokey.output).toContain("is not bound to agent 'writer', so it needs the agent's key: set MESSAGE_CP_AGENT_KEY, or use the token message-cp connect printed. Nothing was changed.");
      expect(nokey.output).not.toContain(unbound);
      expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
      // With the key, the unbound token gets the three headers, as before.
      const withKey = await run(unbound, c.key);
      expect(withKey.status).toBe(0);
      expect(withKey.output).toContain("accepted the token, and agent 'writer' with its key.");
      expect(JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers["message-cp"].headers).toEqual({
        Authorization: `Bearer ${unbound}`,
        "X-Message-CP-Agent": "writer",
        "X-Message-CP-Agent-Key": c.key,
      });
      expect(listServerAgents(db).map((a) => a.name)).toEqual(["reader", "writer"]);
    } finally {
      await http.close();
      db.close();
    }
  }, 60_000);

  it("with more than one client and no terminal, lists the choices and exits 1, changing nothing", () => {
    fakeCommand("claude");
    mkdirSync(join(home, ".cursor"));
    const r = cli({ PATH: `${bin}:${process.env.PATH}` });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("message-cp init --client cursor");
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
  });
});

// `message-cp init --url --agent`: the team server over HTTP, with the token and key only in the client's configuration.
const TOKEN = "t".repeat(64);
const KEY = "k".repeat(64);
const remote = (over: Partial<Remote> = {}): Remote => ({
  endpoint: new URL("https://message-cp.example.com/mcp"),
  agent: "writer",
  token: TOKEN,
  key: KEY,
  ...over,
});
const CLAUDE_REMOTE_ADD = `claude mcp add --scope user --transport http message-cp https://message-cp.example.com/mcp --header Authorization: Bearer ${TOKEN} --header X-Message-CP-Agent: writer --header X-Message-CP-Agent-Key: ${KEY}`;
/** What `claude mcp get` prints for the HTTP entry: every header value, the token and key included. */
const claudeGetHttp = (url = "https://message-cp.example.com/mcp", agent = "writer") =>
  `message-cp:\n  Scope: User config\n  Status: ✔ Connected\n  Type: http\n  URL: ${url}\n  Headers:\n    Authorization: Bearer ${TOKEN}\n    X-Message-CP-Agent: ${agent}\n    X-Message-CP-Agent-Key: ${KEY}\n`;

describe("setUpClient with a team server", () => {
  it("adds Claude Code at user scope over HTTP with the three headers, and shows the command without them", () => {
    const { run, calls } = fakeRunner({ [CLAUDE_GET]: MISSING });
    const s = setUpClient("claude-code", machine(), run, remote());
    expect(calls).toEqual([CLAUDE_GET, CLAUDE_REMOTE_ADD]);
    expect(s).toMatchObject({ state: "added", undo: "claude mcp remove --scope user message-cp" });
    expect(s.changed).toBe("with `claude mcp add --scope user --transport http message-cp https://message-cp.example.com/mcp` and the agent's three headers");
  });

  it("compares Type, URL and agent from claude mcp get, and runs no add when there is an entry", () => {
    for (const [stdout, state] of [
      [claudeGetHttp(), "present"],
      [claudeGetHttp("https://other.example/mcp"), "differs"],
      [claudeGetHttp(undefined, "reader"), "differs"],
      [claudeGetHttp().replace(KEY, "old-key"), "differs"],
      [claudeGetHttp().replace(TOKEN, "old-token"), "differs"],
      ["message-cp:\n  Type: stdio\n  Command: npx\n  Args: -y message-cp\n", "differs"],
    ] as const) {
      const { run, calls } = fakeRunner({ [CLAUDE_GET]: { status: 0, stdout } });
      expect(setUpClient("claude-code", machine(), run, remote()).state).toBe(state);
      expect(calls).toEqual([CLAUDE_GET]);
    }
  });

  it("redacts the token and key from a failed claude command's last line", () => {
    const echo = { status: 1, stderr: `error: bad header Authorization: Bearer ${TOKEN} X-Message-CP-Agent-Key: ${KEY}` };
    for (const answers of [{ [CLAUDE_GET]: MISSING, [CLAUDE_REMOTE_ADD]: echo }, { [CLAUDE_GET]: { ...echo, status: 2 } }]) {
      const err = (() => {
        try {
          setUpClient("claude-code", machine(), fakeRunner(answers).run, remote());
        } catch (e) {
          return e as Error;
        }
      })();
      expect(err).toBeInstanceOf(InitError);
      expect(err!.message).toContain("Bearer <redacted>");
      expect(err!.message).not.toContain(TOKEN);
      expect(err!.message).not.toContain(KEY);
    }
  });

  it("writes Cursor's url and headers with no type, private to the user, and finds it again by URL and agent", () => {
    mkdirSync(join(home, ".cursor"));
    const file = join(home, ".cursor", "mcp.json");
    expect(setUpClient("cursor", machine(), fakeRunner().run, remote()).state).toBe("added");
    expect(JSON.parse(readFileSync(file, "utf8")).mcpServers["message-cp"]).toEqual({
      url: "https://message-cp.example.com/mcp",
      headers: { Authorization: `Bearer ${TOKEN}`, "X-Message-CP-Agent": "writer", "X-Message-CP-Agent-Key": KEY },
    });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    const after = readFileSync(file, "utf8");
    expect(setUpClient("cursor", machine(), fakeRunner().run, remote()).state).toBe("present");
    expect(setUpClient("cursor", machine(), fakeRunner().run, remote({ agent: "reader" })).state).toBe("differs");
    // An entry holding an old token or key is not the same, so a rotated one is not called set up.
    expect(setUpClient("cursor", machine(), fakeRunner().run, remote({ key: "new-key" })).state).toBe("differs");
    expect(setUpClient("cursor", machine(), fakeRunner().run, remote({ token: "new-token" })).state).toBe("differs");
    expect(setUpClient("cursor", machine(), fakeRunner().run).state).toBe("differs");
    expect(readFileSync(file, "utf8")).toBe(after);
  });

  it("with a bound token, adds Claude Code with only the Authorization header, and takes an earlier three-header entry as the same", () => {
    const { run, calls } = fakeRunner({ [CLAUDE_GET]: MISSING });
    const s = setUpClient("claude-code", machine(), run, remote({ bound: true, key: undefined }));
    expect(calls).toEqual([CLAUDE_GET, `claude mcp add --scope user --transport http message-cp https://message-cp.example.com/mcp --header Authorization: Bearer ${TOKEN}`]);
    expect(s.changed).toBe("with `claude mcp add --scope user --transport http message-cp https://message-cp.example.com/mcp` and the token's Authorization header");
    const oneHeader = `message-cp:\n  Scope: User config\n  Type: http\n  URL: https://message-cp.example.com/mcp\n  Headers:\n    Authorization: Bearer ${TOKEN}\n`;
    for (const [stdout, over, state] of [
      [oneHeader, {}, "present"],
      [oneHeader, { key: undefined }, "present"],
      [claudeGetHttp(), {}, "present"],
      [claudeGetHttp(), { key: undefined }, "present"],
      [claudeGetHttp(undefined, "reader"), {}, "differs"],
      [claudeGetHttp().replace(KEY, "old-key"), {}, "differs"],
      [oneHeader.replace(TOKEN, "old-token"), {}, "differs"],
      [oneHeader.replace("message-cp.example.com", "other.example"), {}, "differs"],
    ] as const) {
      const got = fakeRunner({ [CLAUDE_GET]: { status: 0, stdout } });
      expect(setUpClient("claude-code", machine(), got.run, remote({ bound: true, ...over })).state, stdout).toBe(state);
      expect(got.calls).toEqual([CLAUDE_GET]);
    }
  });

  it("with a bound token, writes Cursor's url and only the Authorization header, never the key", () => {
    mkdirSync(join(home, ".cursor"));
    const file = join(home, ".cursor", "mcp.json");
    expect(setUpClient("cursor", machine(), fakeRunner().run, remote({ bound: true })).state).toBe("added");
    expect(readFileSync(file, "utf8")).not.toContain(KEY);
    expect(JSON.parse(readFileSync(file, "utf8")).mcpServers["message-cp"]).toEqual({
      url: "https://message-cp.example.com/mcp",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    const after = readFileSync(file, "utf8");
    expect(setUpClient("cursor", machine(), fakeRunner().run, remote({ bound: true, key: undefined })).state).toBe("present");
    expect(setUpClient("cursor", machine(), fakeRunner().run, remote({ bound: true, token: "new-token" })).state).toBe("differs");
    // An unbound token's setup is not this one-header entry.
    expect(setUpClient("cursor", machine(), fakeRunner().run, remote()).state).toBe("differs");
    expect(readFileSync(file, "utf8")).toBe(after);

    // The three-header entry an earlier init wrote is still the same for the bound token, if it names this agent and key.
    const three = { url: "https://message-cp.example.com/mcp", headers: { Authorization: `Bearer ${TOKEN}`, "X-Message-CP-Agent": "writer", "X-Message-CP-Agent-Key": KEY } };
    writeFileSync(file, JSON.stringify({ mcpServers: { "message-cp": three } }), { mode: 0o600 });
    expect(setUpClient("cursor", machine(), fakeRunner().run, remote({ bound: true })).state).toBe("present");
    expect(setUpClient("cursor", machine(), fakeRunner().run, remote({ bound: true, key: undefined })).state).toBe("present");
    expect(setUpClient("cursor", machine(), fakeRunner().run, remote({ bound: true, key: "other-key" })).state).toBe("differs");
    expect(setUpClient("cursor", machine(), fakeRunner().run, remote({ bound: true, agent: "reader" })).state).toBe("differs");
  });

  it("calls the stdio entry in Cursor different from the team server", () => {
    mkdirSync(join(home, ".cursor"));
    setUpClient("cursor", machine(), fakeRunner().run);
    expect(setUpClient("cursor", machine(), fakeRunner().run, remote()).state).toBe("differs");
  });

  it("refuses Codex, Claude Desktop, and Claude Code on Windows, running nothing", () => {
    for (const [client, m] of [
      ["codex", machine()],
      ["claude-desktop", machine("darwin")],
      ["claude-code", machine("win32")],
    ] as const) {
      const { run, calls } = fakeRunner();
      expect(() => setUpClient(client, m, run, remote())).toThrow(/Nothing was changed\.$/);
      expect(calls).toEqual([]);
    }
  });
});

describe("redact", () => {
  it("replaces every copy of the token and key", () => {
    expect(redact(`a ${TOKEN} b ${KEY} ${TOKEN}`, remote())).toBe("a <redacted> b <redacted> <redacted>");
    expect(redact("plain", undefined)).toBe("plain");
  });
});

describe("runInit with a team server", () => {
  function options(over: Partial<InitOptions> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const runner = fakeRunner({ [CLAUDE_GET]: MISSING });
    let proved = 0;
    let checked = 0;
    const o: InitOptions = {
      machine: machine(),
      run: runner.run,
      interactive: false,
      ask: async () => "",
      remote: remote(),
      check: async () => {
        checked++;
      },
      prove: async () => {
        proved++;
      },
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      ...over,
    };
    return { o, out, err, calls: runner.calls, proved: () => proved, checked: () => checked };
  }
  const all = (t: { out: string[]; err: string[] }) => [...t.out, ...t.err].join("\n");

  it("checks the server first, then adds Claude Code, proves it and prints the undo, with no token or key", async () => {
    fakeCommand("claude");
    const t = options();
    expect(await runInit(t.o)).toBe(0);
    expect(t.checked()).toBe(1);
    expect(t.proved()).toBe(1);
    expect(t.calls).toEqual([CLAUDE_GET, CLAUDE_REMOTE_ADD]);
    expect(t.out).toEqual([
      "message-cp init: found Claude Code.",
      "Server: https://message-cp.example.com/mcp accepted the token, and agent 'writer' with its key.",
      "Claude Code: added message-cp with `claude mcp add --scope user --transport http message-cp https://message-cp.example.com/mcp` and the agent's three headers.",
      "Check passed: registered a test agent on the server, sent it a message, read it back and removed it.",
      "To undo: claude mcp remove --scope user message-cp",
    ]);
    expect(all(t)).not.toContain(TOKEN);
    expect(all(t)).not.toContain(KEY);
  });

  it("with a bound token, adds Claude Code with only the token, and says the server took the token as the agent", async () => {
    fakeCommand("claude");
    for (const [over, server] of [
      [{ key: undefined }, "Server: https://message-cp.example.com/mcp accepted the token, which is agent 'writer'."],
      [{}, "Server: https://message-cp.example.com/mcp accepted the token, which is agent 'writer', and its key."],
    ] as const) {
      const t = options({ remote: remote(over), check: async () => true });
      expect(await runInit(t.o)).toBe(0);
      expect(t.calls).toEqual([CLAUDE_GET, `claude mcp add --scope user --transport http message-cp https://message-cp.example.com/mcp --header Authorization: Bearer ${TOKEN}`]);
      expect(t.out[1]).toBe(server);
      expect(t.out[2]).toBe("Claude Code: added message-cp with `claude mcp add --scope user --transport http message-cp https://message-cp.example.com/mcp` and the token's Authorization header.");
      expect(all(t)).not.toContain(TOKEN);
      expect(all(t)).not.toContain(KEY);
    }
  });

  it("run again, says already set up", async () => {
    fakeCommand("claude");
    const t = options({ run: fakeRunner({ [CLAUDE_GET]: { status: 0, stdout: claudeGetHttp() } }).run });
    expect(await runInit(t.o)).toBe(0);
    expect(t.out).toContain("Claude Code: already set up; nothing was changed.");
    expect(all(t)).not.toContain(TOKEN);
    expect(all(t)).not.toContain(KEY);
  });

  it("changes nothing when the check refuses the token or key, and passes on no secret it carries", async () => {
    fakeCommand("claude");
    mkdirSync(join(home, ".cursor"));
    for (const client of ["claude-code", "cursor"] as const) {
      const t = options({ client, check: async () => Promise.reject(new InitError(`the server refused agent 'writer' with the key ${KEY} and ${TOKEN} (403)`)) });
      expect(await runInit(t.o)).toBe(1);
      expect(t.err.join("\n")).toMatch(/refused agent 'writer' with the key <redacted> and <redacted> \(403\)\. Nothing was changed\./);
      expect(t.calls).toEqual([]);
      expect(t.proved()).toBe(0);
      expect(all(t)).not.toContain(TOKEN);
      expect(all(t)).not.toContain(KEY);
    }
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
  });

  it("refuses Codex before checking the server", async () => {
    fakeCommand("codex");
    const t = options();
    expect(await runInit(t.o)).toBe(1);
    expect(t.err.join("\n")).toMatch(/Codex cannot be set up for a team server: .*Nothing was changed\./);
    expect(t.checked()).toBe(0);
    expect(t.calls).toEqual([]);
  });

  it("leaves a stdio entry in Claude Code as it is, and does not run the check", async () => {
    fakeCommand("claude");
    const t = options({ run: fakeRunner({ [CLAUDE_GET]: { status: 0, stdout: "  Type: stdio\n  Command: npx\n  Args: -y message-cp\n" } }).run });
    expect(await runInit(t.o)).toBe(1);
    expect(t.err.join("\n")).toContain("already has a server named message-cp that is not https://message-cp.example.com/mcp as agent 'writer' with this token and key");
    expect(t.err.join("\n")).toContain("claude mcp remove --scope user message-cp");
    expect(t.proved()).toBe(0);
  });

  it("refuses an existing Cursor file that others can read before checking or writing it, and does not change its mode", async () => {
    if (process.platform === "win32") return;
    mkdirSync(join(home, ".cursor"));
    const file = join(home, ".cursor", "mcp.json");
    writeFileSync(file, "{}", { mode: 0o644 });
    chmodSync(file, 0o644);
    const t = options();
    expect(await runInit(t.o)).toBe(1);
    expect(t.err.join("\n")).toContain(`other users of this machine can read it; to make it private, run: chmod 600 ${file}, then run message-cp init again. Nothing was changed.`);
    expect(t.checked()).toBe(0);
    expect(t.proved()).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("{}");
    expect(statSync(file).mode & 0o777).toBe(0o644);

    chmodSync(file, 0o600);
    const quiet = options();
    expect(await runInit(quiet.o)).toBe(0);
    expect(quiet.err).toEqual([]);
    expect(readFileSync(file, "utf8")).toContain(TOKEN);
  });

  it("keeps the configuration when the proof fails, redacting its message", async () => {
    mkdirSync(join(home, ".cursor"));
    const t = options({ prove: async () => Promise.reject(new InitError(`register: refused ${TOKEN}`)) });
    expect(await runInit(t.o)).toBe(1);
    expect(t.err.join("\n")).toMatch(/Check failed: register: refused <redacted>\nThe Cursor configuration was kept\. To undo it: delete/);
    expect(all(t)).not.toContain(TOKEN);
  });
});

describe("checkRemote and proveRemote", () => {
  const OWNER = "owner-token";
  let db: Db;
  let http: HttpServer;
  let endpoint: URL;
  let agentToken: string;
  let agentKey: string;

  beforeEach(async () => {
    db = openDb(join(home, "db.sqlite"));
    http = await startHttp(db, { token: OWNER, port: 0 });
    endpoint = mcpEndpoint(`http://127.0.0.1:${http.port}`);
    const c = connectAgent(db, "owner", "writer", false);
    agentToken = c.token;
    agentKey = c.key;
  });

  afterEach(async () => {
    await http.close();
    db.close();
  });

  const r = (over: Partial<Remote> = {}): Remote => ({ endpoint, agent: "writer", token: agentToken, key: agentKey, ...over });
  const names = () => listServerAgents(db).map((a) => `${a.account}/${a.name}`);
  const failure = (p: Promise<void>) => p.then(() => undefined, (e: Error) => e);

  it("accepts the agent's token and key, and leaves only the agent", async () => {
    expect(await checkRemote(r())).toBe(true);
    expect(names()).toEqual(["owner/writer"]);
  });

  it("finds a bound token, with or without its key, without registering, waking or marking anything read", async () => {
    registerAgent(db, OWNER_ACCOUNT, "bob", "x");
    sendMessage(db, OWNER_ACCOUNT, "bob", "writer", "waiting mail");
    const before = () => [db.prepare("SELECT * FROM messages ORDER BY id").all(), db.prepare("SELECT name, removed_at FROM agents ORDER BY id").all()];
    const was = before();
    expect(await checkRemote(r({ key: undefined }))).toBe(true);
    expect(await checkRemote(r())).toBe(true);
    expect(before()).toEqual(was);
    // A wrong key given with a bound token is still checked.
    expect((await failure(checkRemote(r({ key: "wrong-key" }))))?.message).toMatch(/^the server refused agent 'writer' with the key in MESSAGE_CP_AGENT_KEY \(403\): /);
  });

  it("refuses a token bound to another agent, naming it, and changes nothing", async () => {
    const reader = connectAgent(db, "owner", "reader", false);
    const was = db.prepare("SELECT * FROM messages ORDER BY id").all();
    for (const key of [undefined, agentKey]) {
      const err = await failure(checkRemote(r({ token: reader.token, key })));
      expect(err).toBeInstanceOf(InitError);
      expect(err!.message).toBe("the token in MESSAGE_CP_HTTP_TOKEN is bound to agent 'reader', not 'writer'");
    }
    expect(db.prepare("SELECT * FROM messages ORDER BY id").all()).toEqual(was);
    expect(names()).toEqual(["owner/reader", "owner/writer"]);
  });

  it("takes an unbound agent token as unbound: with the key it passes, without it it is refused; neither registers anything", async () => {
    registerAgent(db, OWNER_ACCOUNT, "bob", "x");
    sendMessage(db, OWNER_ACCOUNT, "bob", "writer", "waiting mail");
    const unbound = addToken(db, "owner", false, true).token;
    const was = db.prepare("SELECT * FROM messages ORDER BY id").all();
    expect(await checkRemote(r({ token: unbound }))).toBe(false);
    const err = await failure(checkRemote(r({ token: unbound, key: undefined })));
    expect(err?.message).toBe(
      "the token in MESSAGE_CP_HTTP_TOKEN is not bound to agent 'writer', so it needs the agent's key: set MESSAGE_CP_AGENT_KEY, or use the token message-cp connect printed",
    );
    expect(err?.message).not.toContain(unbound);
    expect(db.prepare("SELECT * FROM messages ORDER BY id").all()).toEqual(was);
    expect(names()).toEqual(["owner/bob", "owner/writer"]);
  });

  it("says which was refused: the token, a read-only token, the key, or an agent that is not there; and makes no agent", async () => {
    const readOnly = addToken(db, "owner", true).token;
    const unbound = addToken(db, "owner", false, true).token;
    for (const [over, pattern] of [
      [{ token: "wrong" }, /^the server refused the token in MESSAGE_CP_HTTP_TOKEN \(401\)$/],
      [{ token: unbound, key: "wrong-key" }, /^the server refused agent 'writer' with the key in MESSAGE_CP_AGENT_KEY \(403\): /],
      [{ token: readOnly }, /^the server refused the token in MESSAGE_CP_HTTP_TOKEN \(403\): This token is read-only$/],
      [{ key: "wrong-key" }, /^the server refused agent 'writer' with the key in MESSAGE_CP_AGENT_KEY \(403\): /],
      [{ agent: "nobody" }, /^the server has no agent named 'nobody'/],
    ] as const) {
      const err = await failure(checkRemote(r(over)));
      expect(err, JSON.stringify(over)).toBeInstanceOf(InitError);
      expect(err!.message).toMatch(pattern);
      expect(err!.message).not.toContain(agentToken);
      expect(err!.message).not.toContain(agentKey);
    }
    expect(names()).toEqual(["owner/writer"]);
  });

  it("refuses a person's name", async () => {
    addPerson(db, "owner", "colin");
    expect((await failure(checkRemote(r({ agent: "colin" }))))?.message).toMatch(/'colin' is a person on the server/);
  });

  it("finds only the token's own account's agent", async () => {
    addAccount(db, "friend");
    const friend = listAccounts(db).find((a) => a.name === "friend")!.id;
    registerAgent(db, friend, "other", undefined, "f".repeat(32));
    expect((await failure(checkRemote(r({ agent: "other", key: "f".repeat(32) }))))?.message).toMatch(/no agent named 'other'/);
  });

  it("says it could not reach a server that is not listening", async () => {
    const closed = mcpEndpoint("http://127.0.0.1:1");
    expect((await failure(checkRemote(r({ endpoint: closed }))))?.message).toMatch(/^could not open a session at http:\/\/127\.0\.0\.1:1\/mcp: /);
  });

  it("with a bound token, proves the server as the agent itself: it sends itself a message and reads none of its mail", async () => {
    registerAgent(db, OWNER_ACCOUNT, "bob", "x");
    sendMessage(db, OWNER_ACCOUNT, "bob", "writer", "waiting mail");
    expect(await proveRemote(r())).toBe(
      "as agent 'writer' on the server, sent itself a message and found it with read_conversation; it stays unread in the agent's inbox.",
    );
    expect(names()).toEqual(["owner/bob", "owner/writer"]);
    expect(db.prepare("SELECT sender, body, read_at FROM messages ORDER BY id").all()).toEqual([
      { sender: "bob", body: "waiting mail", read_at: null },
      { sender: "writer", body: expect.stringMatching(/^message-cp init check [0-9a-f]{20}$/), read_at: null },
    ]);
  });

  it("with a token bound to another agent, fails at register and sends nothing", async () => {
    const reader = connectAgent(db, "owner", "reader", false);
    const before = db.prepare("SELECT * FROM messages ORDER BY id").all();
    const err = await failure(proveRemote(r({ token: reader.token })));
    expect(err?.message).toBe("register: the token is agent 'reader', not 'writer'");
    expect(db.prepare("SELECT * FROM messages ORDER BY id").all()).toEqual(before);
    expect(names()).toEqual(["owner/reader", "owner/writer"]);
  });

  it("proves the server without touching the agent: a test agent sends itself a message and is removed", async () => {
    // An unbound agent token can register the test agent.
    agentToken = addToken(db, "owner", false, true).token;
    const before = db.prepare("SELECT last_seen FROM agents WHERE name = 'writer'").get();
    expect(await proveRemote(r())).toBe("registered a test agent on the server, sent it a message, read it back and removed it.");
    expect(names()).toEqual(["owner/writer"]);
    expect(db.prepare("SELECT last_seen FROM agents WHERE name = 'writer'").get()).toEqual(before);
    // The test agent's message stays in the database, addressed to the removed agent, as unregister keeps it.
    expect(db.prepare("SELECT sender FROM messages").all()).toEqual([{ sender: expect.stringMatching(/^init-check-[0-9a-f]{20}$/) }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM agents WHERE name LIKE 'init-check-%' AND removed_at IS NULL").get()).toEqual({ n: 0 });
  });

  it("stops waiting for a session's DELETE that is never answered", async () => {
    // Passes every request on to the server, but holds a DELETE open without answering it.
    const held: { destroy: () => void }[] = [];
    const proxy = createServer((req, res) => {
      if (req.method === "DELETE") {
        held.push(res.socket!);
        return;
      }
      const up = request({ host: "127.0.0.1", port: http.port, path: req.url, method: req.method, headers: req.headers }, (u) => {
        res.writeHead(u.statusCode!, u.headers);
        u.pipe(res);
      });
      req.pipe(up);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    try {
      const port = (proxy.address() as { port: number }).port;
      const client = new Client({ name: "test", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(mcpEndpoint(`http://127.0.0.1:${port}`), {
        requestInit: { headers: { Authorization: `Bearer ${agentToken}` } },
      });
      await client.connect(transport);
      expect(transport.sessionId).toBeDefined();
      const started = Date.now();
      await endSession(client, transport, 200);
      expect(held).toHaveLength(1);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      for (const s of held) s.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it("names the failed step and holds no token when the proof cannot start", async () => {
    const err = await failure(proveRemote(r({ token: "wrong" })));
    expect(err?.message).toMatch(/^opening a session: /);
    expect(names()).toEqual(["owner/writer"]);
  });
});

// `message-cp init --from`: the URL, agent, token and key from the file `connect` wrote, and the token also written to
// ~/.message-cp/http-token for the wake-up command.
describe("readConnectFile", () => {
  const setup = (url = "https://message-cp.example.com", agent = "writer") => clientSetup(mcpEndpoint(url), { name: agent, token: TOKEN, key: KEY });
  const write = (text: string, mode = 0o600) => {
    const file = join(home, "connect-writer.txt");
    writeFileSync(file, text, { mode });
    chmodSync(file, mode);
    return file;
  };
  const refusal = (file: string) => {
    try {
      readConnectFile(file, "linux");
    } catch (err) {
      expect(err).toBeInstanceOf(InitError);
      expect((err as Error).message).not.toContain(TOKEN);
      expect((err as Error).message).not.toContain(KEY);
      return (err as Error).message;
    }
    throw new Error("not refused");
  };

  it("reads the URL, agent, token and key from what connect printed", () => {
    const file = write(setup());
    expect(readConnectFile(file, "linux")).toEqual({ endpoint: new URL("https://message-cp.example.com/mcp"), agent: "writer", token: TOKEN, key: KEY, from: file });
  });

  it("refuses a file it cannot read, or one that is not a file", () => {
    expect(refusal(join(home, "missing.txt"))).toBe(`could not read ${join(home, "missing.txt")} (ENOENT). Nothing was changed.`);
    expect(refusal(home)).toBe(`${home} is not a file. Nothing was changed.`);
    if (process.platform === "win32") return;
    const fifo = join(home, "fifo");
    spawnSync("mkfifo", [fifo]);
    expect(refusal(fifo)).toBe(`${fifo} is not a file. Nothing was changed.`);
  });

  it("refuses a file whose mode is wider than 0600, except on Windows", () => {
    if (process.platform === "win32") return;
    for (const mode of [0o640, 0o604, 0o644, 0o620, 0o601, 0o700]) {
      const file = write(setup(), mode);
      expect(refusal(file)).toContain(`its mode 0${mode.toString(8)} is wider than 0600; make it private with: chmod 600 ${file}`);
    }
    expect(readConnectFile(write(setup(), 0o644), "win32").token).toBe(TOKEN);
  });

  it("refuses a file without exactly one usable URL, agent, token and key", () => {
    const json = (entry: unknown, more: Record<string, unknown> = {}) => `claude mcp add ...\n\n${JSON.stringify({ mcpServers: { "message-cp": entry, ...more } }, null, 2)}\n`;
    const good = { type: "http", url: "https://h.example/mcp", headers: { Authorization: `Bearer ${TOKEN}`, "X-Message-CP-Agent": "writer", "X-Message-CP-Agent-Key": KEY } };
    const h = (over: Record<string, unknown>) => ({ ...good, headers: { ...good.headers, ...over } });
    for (const [text, why] of [
      ["", "holds no mcpServers JSON"],
      [setup().split("\n")[0]!, "holds no mcpServers JSON"],
      [setup().slice(0, -10), "holds no mcpServers JSON"],
      [json(good, { other: good }), "names 2 servers, not one"],
      [`claude mcp add ...\n\n{\n  "mcpServers": {}\n}\n`, "names 0 servers, not one"],
      [json({ ...good, url: undefined }), "has no server URL"],
      [json(h({ Authorization: undefined })), "has no token"],
      [json(h({ Authorization: TOKEN })), "has no token"],
      [json(h({ Authorization: "Bearer " })), "has no token"],
      [json(h({ Authorization: `Bearer ${TOKEN} x` })), "has no token"],
      [json(h({ "X-Message-CP-Agent": undefined })), "has no usable agent name"],
      [json(h({ "X-Message-CP-Agent": "all" })), "has no usable agent name"],
      [json(h({ "X-Message-CP-Agent": "a b" })), "has no usable agent name"],
      [json(h({ "X-Message-CP-Agent-Key": "" })), "has no agent key"],
      [json(h({ "X-Message-CP-Agent-Key": 7 })), "has no agent key"],
    ] as const) {
      expect(refusal(write(text)), why).toMatch(new RegExp(`${why}; give the file message-cp connect wrote, unchanged\\. Nothing was changed\\.$`));
    }
  });

  it("puts the URL through init --url's check", () => {
    for (const url of ["http://localhost@evil/", "https://@/", "https://h/?x=/o/", "https://h/#/o/", "http://example.com", "not a url"]) {
      const text = setup().replaceAll("https://message-cp.example.com/mcp", url);
      expect(refusal(write(text)), url).toMatch(/has a server URL init refuses: /);
    }
  });
});

describe("writeTokenFile", () => {
  const file = () => join(home, ".message-cp", "http-token");

  it("writes a new file 0600 in a new directory 0700", () => {
    expect(writeTokenFile(home, TOKEN)).toBe("written");
    expect(readFileSync(file(), "utf8")).toBe(`${TOKEN}\n`);
    if (process.platform === "win32") return;
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".message-cp")).mode & 0o777).toBe(0o700);
  });

  it("leaves a file already there as it is: present with the same token, differs with another", () => {
    mkdirSync(join(home, ".message-cp"));
    writeFileSync(file(), `${TOKEN}\n`);
    expect(writeTokenFile(home, TOKEN)).toBe("present");
    writeFileSync(file(), "other\n");
    expect(writeTokenFile(home, TOKEN)).toBe("differs");
    writeFileSync(file(), "");
    expect(writeTokenFile(home, TOKEN)).toBe("differs");
    writeFileSync(file(), "other\n");
    expect(readFileSync(file(), "utf8")).toBe("other\n");
  });

  it("compares the token as the wake-up command reads it: only trailing newlines are dropped", () => {
    mkdirSync(join(home, ".message-cp"));
    writeFileSync(file(), `${TOKEN}\n\n`);
    expect(writeTokenFile(home, TOKEN)).toBe("present");
    for (const text of [`\t${TOKEN}\n`, ` ${TOKEN}`, `${TOKEN} \n`, `${TOKEN}\r\n`]) {
      writeFileSync(file(), text);
      expect(writeTokenFile(home, TOKEN)).toBe("differs");
    }
  });

  it("refuses a FIFO already there, or a symlink to one, instead of waiting for a writer", () => {
    if (process.platform === "win32") return;
    mkdirSync(join(home, ".message-cp"));
    const fifo = join(home, "fifo");
    spawnSync("mkfifo", [fifo]);
    for (const make of [() => spawnSync("mkfifo", [file()]), () => symlinkSync(fifo, file())]) {
      rmSync(file(), { force: true });
      make();
      expect(() => writeTokenFile(home, TOKEN)).toThrow(/is already there but is not a file; it was left as it is/);
      expect(lstatSync(file())).toBeDefined();
    }
  });

  it("does not write through a symlink left in its place", () => {
    if (process.platform === "win32") return;
    mkdirSync(join(home, ".message-cp"));
    const target = join(home, "elsewhere");
    symlinkSync(target, file());
    expect(() => writeTokenFile(home, TOKEN)).toThrow(InitError);
    expect(existsSync(target)).toBe(false);
  });
});

describe("runInit with --from", () => {
  const FROM = "/tmp/connect-writer.txt";
  function options(over: Partial<InitOptions> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const o: InitOptions = {
      machine: machine(),
      run: fakeRunner().run,
      interactive: false,
      ask: async () => "",
      remote: remote({ from: FROM }),
      check: async () => {},
      prove: async () => {},
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      ...over,
    };
    return { o, out, err };
  }
  const tokenFile = () => join(home, ".message-cp", "http-token");

  it("after the check passes, writes the wake-up token and says the file can be deleted, printing no secret", async () => {
    mkdirSync(join(home, ".cursor"));
    const t = options();
    expect(await runInit(t.o)).toBe(0);
    expect(t.out.slice(-2)).toEqual([`Wake-up token: wrote ${tokenFile()}.`, `${FROM} can now be deleted, and its copy on the server.`]);
    expect(readFileSync(tokenFile(), "utf8")).toBe(`${TOKEN}\n`);
    expect(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).toContain(KEY);
    expect([...t.out, ...t.err].join("\n")).not.toMatch(new RegExp(`${TOKEN}|${KEY}`));

    const again = options();
    expect(await runInit(again.o)).toBe(0);
    expect(again.out).toContain(`Wake-up token: ${tokenFile()} already holds this token.`);
  });

  it("leaves a different token in http-token as it is, says so and how to replace it", async () => {
    mkdirSync(join(home, ".cursor"));
    mkdirSync(join(home, ".message-cp"));
    writeFileSync(tokenFile(), "other\n");
    const t = options();
    expect(await runInit(t.o)).toBe(0);
    expect(t.err).toEqual([
      `message-cp init: ${tokenFile()} is already there and does not hold this token, so it was left as it is; the wake-up command reads the token from it when MESSAGE_CP_HTTP_TOKEN is not set.`,
      `To use this agent's token there instead, delete ${tokenFile()}, then run message-cp init --from ${FROM} again.`,
      `Once that is done, or you keep the token already there, ${FROM} can be deleted, and its copy on the server.`,
    ]);
    expect(t.out.join("\n")).not.toContain("can now be deleted");
    expect(readFileSync(tokenFile(), "utf8")).toBe("other\n");
  });

  it("writes no wake-up token when the check or the proof fails, or for init --url", async () => {
    mkdirSync(join(home, ".cursor"));
    expect(await runInit(options({ check: async () => Promise.reject(new InitError("refused")) }).o)).toBe(1);
    expect(await runInit(options({ prove: async () => Promise.reject(new InitError("failed")) }).o)).toBe(1);
    expect(existsSync(tokenFile())).toBe(false);
    const url = options({ remote: remote() });
    expect(await runInit(url.o)).toBe(0);
    expect(existsSync(tokenFile())).toBe(false);
    expect(url.out.join("\n")).not.toContain("Wake-up token");
  });
});

describe("message-cp init --from", () => {
  const root = resolve(import.meta.dirname, "..");
  const run = (args: string[], env: Record<string, string> = {}) =>
    new Promise<{ status: number | null; output: string }>((done) => {
      // Asynchronous, so this process can answer the server's requests meanwhile.
      const child = spawn(process.execPath, [join(root, "node_modules/tsx/dist/cli.mjs"), join(root, "src/cli.ts"), "init", ...args], {
        env: { ...process.env, HOME: home, USERPROFILE: home, MESSAGE_CP_DB: join(home, "other.sqlite"), MESSAGE_CP_HTTP_TOKEN: "", MESSAGE_CP_AGENT_KEY: "", ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (d) => (output += d));
      child.stderr.on("data", (d) => (output += d));
      child.on("close", (status) => done({ status, output }));
    });

  it("takes --from alone, not with --url or --agent", async () => {
    for (const args of [["--from"], ["--from", "f", "--url", "https://h.example", "--agent", "writer"], ["--from", "f", "--from", "g"]]) {
      const r = await run(args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.output).toContain("usage: message-cp init");
    }
  });

  it("refuses a file others can read, changing nothing", async () => {
    if (process.platform === "win32") return;
    mkdirSync(join(home, ".cursor"));
    const file = join(home, "connect.txt");
    writeFileSync(file, clientSetup(mcpEndpoint("https://h.example"), { name: "writer", token: TOKEN, key: KEY }), { mode: 0o644 });
    chmodSync(file, 0o644);
    const r = await run(["--client", "cursor", "--from", file]);
    expect(r.status).toBe(1);
    expect(r.output).toContain("its mode 0644 is wider than 0600");
    expect(r.output).not.toContain(TOKEN);
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
    expect(existsSync(join(home, ".message-cp"))).toBe(false);
  });

  it("sets up Cursor from the file connect wrote, writes the wake-up token, and prints neither secret", async () => {
    mkdirSync(join(home, ".cursor"));
    const db = openDb(join(home, "db.sqlite"));
    const http = await startHttp(db, { token: "owner-token", port: 0 });
    try {
      const c = connectAgent(db, "owner", "writer", false);
      const file = join(home, "connect-writer.txt");
      // As the CLI prints it: stdout is the client setup without its last newline.
      writeFileSync(file, `${clientSetup(mcpEndpoint(`http://127.0.0.1:${http.port}`), c).replace(/\n$/, "")}\n`, { mode: 0o600 });
      const r = await run(["--client", "cursor", "--from", file]);
      expect(r.output).toContain("Check passed: as agent 'writer' on the server, sent itself a message");
      expect(r.output).toContain(`${file} can now be deleted`);
      expect(r.status).toBe(0);
      expect(r.output).not.toContain(c.token);
      expect(r.output).not.toContain(c.key);
      const config = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"));
      expect(config.mcpServers["message-cp"]).toEqual({
        url: `http://127.0.0.1:${http.port}/mcp`,
        headers: { Authorization: `Bearer ${c.token}` },
      });
      expect(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).not.toContain(c.key);
      const tokenFile = join(home, ".message-cp", "http-token");
      expect(readFileSync(tokenFile, "utf8")).toBe(`${c.token}\n`);
      if (process.platform !== "win32") expect(statSync(tokenFile).mode & 0o777).toBe(0o600);

      // A wrong key in the file changes nothing and names the file, not the environment.
      rmSync(join(home, ".cursor", "mcp.json"));
      writeFileSync(file, readFileSync(file, "utf8").replaceAll(c.key, "wrong-key"));
      const wrong = await run(["--client", "cursor", "--from", file]);
      expect(wrong.status).toBe(1);
      expect(wrong.output).toContain(`the server refused agent 'writer' with the key in ${file} (403)`);
      expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
      expect(listServerAgents(db).map((a) => a.name)).toEqual(["writer"]);
    } finally {
      await http.close();
      db.close();
    }
  }, 60_000);
});
