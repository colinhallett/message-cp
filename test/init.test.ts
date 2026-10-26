import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { listServerAgents, registerAgent } from "../src/agents.js";
import { OWNER_ACCOUNT, openDb } from "../src/db.js";
import {
  InitError,
  claudeDesktopDir,
  detectClients,
  mergeServer,
  proveServer,
  runInit,
  setUpClient,
  type InitOptions,
  type Machine,
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

  it("with more than one client and no terminal, lists the choices and exits 1, changing nothing", () => {
    fakeCommand("claude");
    mkdirSync(join(home, ".cursor"));
    const r = cli({ PATH: `${bin}:${process.env.PATH}` });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("message-cp init --client cursor");
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
  });
});
